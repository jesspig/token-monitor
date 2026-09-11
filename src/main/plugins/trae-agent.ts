import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'

const TRAJECTORY_FILE_PATTERN = /^trajectory_.*\.json$/

export type TrajectoryRootsSource = 'settings' | 'env' | 'default'

export interface TrajectoryRootsResolution {
  roots: string[]
  source: TrajectoryRootsSource
}

type TrajectoryRootsProvider = () => readonly string[] | undefined

function pathKey(value: string): string {
  const normalized = path.resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function canonicalPathKey(value: string): string {
  let resolved = path.resolve(value)
  try {
    resolved = fs.realpathSync.native(resolved)
  } catch {
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function normalizeTrajectoryRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const value of roots) {
    const trimmed = value.trim()
    if (trimmed === '') continue
    const resolved = path.resolve(trimmed)
    const key = pathKey(resolved)
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push(resolved)
  }
  return normalized
}

export function trajectoryRootsOf(configuredRoots: readonly string[] = []): TrajectoryRootsResolution {
  const configured = normalizeTrajectoryRoots(configuredRoots)
  if (configured.length > 0) return { roots: configured, source: 'settings' }

  const envRoot = process.env.TRAE_TRAJECTORY_DIR?.trim()
  if (envRoot) return { roots: normalizeTrajectoryRoots([envRoot]), source: 'env' }

  return {
    roots: [path.join(os.homedir(), '.local', 'share', 'trae-agent', 'trajectories')],
    source: 'default'
  }
}

export function trajectoriesRootOf(): string {
  return trajectoryRootsOf().roots[0]
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function isTransientName(name: string): boolean {
  return name.startsWith('.') || name.endsWith('.tmp') || name.endsWith('.swp') || name.endsWith('~')
}

function toEntry(p: string): FileEntry {
  let mtime = 0
  try {
    mtime = Math.round(fs.statSync(p).mtimeMs)
  } catch {
    mtime = 0
  }
  return { path: p, mtime }
}

function rootKind(root: string): 'directory' | 'missing' | 'file' {
  try {
    return fs.statSync(root).isDirectory() ? 'directory' : 'file'
  } catch {
    return 'missing'
  }
}

export function listFilesFromRoot(root: string): FileEntry[] {
  const out: FileEntry[] = []
  for (const ent of safeReaddir(root)) {
    if (ent.isFile() && !isTransientName(ent.name) && TRAJECTORY_FILE_PATTERN.test(ent.name)) {
      out.push(toEntry(path.join(root, ent.name)))
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function listFilesFromRoots(roots: readonly string[]): FileEntry[] {
  const files = new Map<string, FileEntry>()
  for (const root of normalizeTrajectoryRoots(roots)) {
    for (const entry of listFilesFromRoot(root)) {
      const key = canonicalPathKey(entry.path)
      const existing = files.get(key)
      if (!existing || entry.mtime > existing.mtime) files.set(key, entry)
    }
  }
  return [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

function rootIssueSummary(missingCount: number, fileCount: number, emptyCount: number): string {
  const issues: string[] = []
  if (missingCount > 0) issues.push(String(missingCount) + ' 个路径不存在')
  if (fileCount > 0) issues.push(String(fileCount) + ' 个路径不是目录')
  if (emptyCount > 0) issues.push(String(emptyCount) + ' 个目录没有 trajectory_*.json')
  return issues.join('，')
}

export function detectFromRoots(resolution: TrajectoryRootsResolution): Detection {
  const roots = normalizeTrajectoryRoots(resolution.roots)
  const files = listFilesFromRoots(roots)
  let missingCount = 0
  let fileCount = 0
  let emptyCount = 0
  let firstDirectory: string | undefined

  for (const root of roots) {
    const kind = rootKind(root)
    if (kind === 'missing') {
      missingCount += 1
      continue
    }
    if (kind === 'file') {
      fileCount += 1
      continue
    }
    firstDirectory ??= root
    if (listFilesFromRoot(root).length === 0) emptyCount += 1
  }

  const issues = rootIssueSummary(missingCount, fileCount, emptyCount)
  if (files.length > 0) {
    return {
      available: true,
      reason: issues === '' ? undefined : `已发现 ${files.length} 个 Trae Agent 轨迹文件；${issues}`,
      sessionDir: firstDirectory ?? roots[0]
    }
  }

  if (resolution.source === 'default') {
    return {
      available: false,
      reason: missingCount > 0
        ? '未配置 Trae Agent trajectory 根目录，旧默认候选目录也不存在；请在设置页配置，或使用 $TRAE_TRAJECTORY_DIR'
        : '未配置 Trae Agent trajectory 根目录；旧默认候选目录存在，但未发现 trajectory_*.json',
      sessionDir: firstDirectory ?? roots[0]
    }
  }

  const sourceLabel = resolution.source === 'env'
    ? '$TRAE_TRAJECTORY_DIR trajectories 根目录'
    : '已配置的 trajectory 根目录'
  return {
    available: false,
    reason: issues === '' ? `${sourceLabel} 中未发现 trajectory_*.json` : `${sourceLabel} 不可用：${issues}`,
    sessionDir: firstDirectory ?? roots[0]
  }
}

export function detectFromRoot(root: string): Detection {
  return detectFromRoots({ roots: [root], source: 'env' })
}

const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function tryParseIsoMs(v: unknown): number | null {
  if (typeof v === 'string' && v.trim() !== '') {
    const parsed = Date.parse(v)
    if (!Number.isNaN(parsed)) return parsed
  }
  return null
}

function resolveCreatedAt(...candidates: unknown[]): number {
  for (const c of candidates) {
    const t = tryParseIsoMs(c)
    if (t !== null) return t
  }
  return Date.now()
}

function semanticsOf(provider: string): number {
  return provider === 'anthropic' ? 2 : 1
}

interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

const EMPTY_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }

function extractUsage(row: Record<string, unknown>): TokenUsage {
  const response = row.response
  if (!response || typeof response !== 'object') return EMPTY_USAGE
  const usage = (response as Record<string, unknown>).usage
  if (!usage || typeof usage !== 'object') return EMPTY_USAGE
  const u = usage as Record<string, unknown>
  return {
    input: toNum(u.input_tokens),
    output: toNum(u.output_tokens),
    cacheRead: toNum(u.cache_read_input_tokens),
    cacheCreation: toNum(u.cache_creation_input_tokens)
  }
}

function toUsageRecord(
  item: unknown,
  filePath: string,
  entryNo: number,
  fileModel: string,
  fileProvider: string,
  fileStartTime: unknown
): UsageRecord | null {
  if (!item || typeof item !== 'object') return null
  const row = item as Record<string, unknown>
  const entryModel = typeof row.model === 'string' ? row.model.trim() : ''
  const model = entryModel !== '' ? entryModel : fileModel
  if (!model) return null
  const entryProvider = typeof row.provider === 'string' ? row.provider.trim() : ''
  const provider = entryProvider !== '' ? entryProvider : fileProvider
  const usage = extractUsage(row)
  return {
    appType: 'trae-agent',
    model,
    rawModel: model,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheCreationTokens: usage.cacheCreation,
    inputSemantics: semanticsOf(provider),
    status: 'success',
    createdAt: resolveCreatedAt(row.timestamp, fileStartTime),
    source: { filePath, line: entryNo }
  }
}

export function parseTrajectoryFile(filePath: string, fromLine: number): ParsedResult {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return { records: [], nextLine: fromLine, eof: true }
  }
  let root: unknown
  try {
    root = JSON.parse(content)
  } catch {
    return { records: [], nextLine: fromLine, eof: true }
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    return { records: [], nextLine: fromLine, eof: true }
  }
  const obj = root as Record<string, unknown>
  const interactions = Array.isArray(obj.llm_interactions) ? obj.llm_interactions : []
  let base = fromLine > 0 ? fromLine : 0
  if (base > interactions.length) base = 0
  const fileModel = typeof obj.model === 'string' ? obj.model.trim() : ''
  const fileProvider = typeof obj.provider === 'string' ? obj.provider.trim() : ''
  const records: UsageRecord[] = []
  for (let i = base; i < interactions.length; i++) {
    const record = toUsageRecord(interactions[i], filePath, i + 1, fileModel, fileProvider, obj.start_time)
    if (record) records.push(record)
  }
  return { records, nextLine: interactions.length, eof: true }
}

export function createTraeAgentPlugin(getConfiguredRoots: TrajectoryRootsProvider = () => undefined): MonitorPlugin {
  return {
    id: 'trae-agent',
    name: 'Trae Agent',
    version: '1.0.0',
    deps: ['storage', 'pricing', 'events'],
    async detect(): Promise<Detection> {
      return detectFromRoots(trajectoryRootsOf(getConfiguredRoots() ?? []))
    },
    async listFiles(): Promise<FileEntry[]> {
      return listFilesFromRoots(trajectoryRootsOf(getConfiguredRoots() ?? []).roots)
    },
    async parseFile(_ctx: PluginContext, filePath: string, fromLine: number): Promise<ParsedResult> {
      return parseTrajectoryFile(filePath, fromLine)
    }
  }
}

export const traeAgentPlugin = createTraeAgentPlugin()
