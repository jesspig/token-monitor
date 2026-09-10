import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'

const TRAJECTORY_FILE_PATTERN = /^trajectory_.*\.json$/

export function trajectoriesRootOf(): string {
  const dir = process.env.TRAE_TRAJECTORY_DIR
  if (dir && dir.trim() !== '') return dir.trim()
  return path.join(os.homedir(), '.local', 'share', 'trae-agent', 'trajectories')
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

export function listFilesFromRoot(root: string): FileEntry[] {
  const out: FileEntry[] = []
  for (const ent of safeReaddir(root)) {
    if (ent.isFile() && !isTransientName(ent.name) && TRAJECTORY_FILE_PATTERN.test(ent.name)) {
      out.push(toEntry(path.join(root, ent.name)))
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function detectFromRoot(root: string): Detection {
  if (listFilesFromRoot(root).length > 0) return { available: true, sessionDir: root }
  let dirExists = false
  try {
    dirExists = fs.statSync(root).isDirectory()
  } catch {
    dirExists = false
  }
  if (dirExists) {
    return {
      available: false,
      reason: '轨迹目录存在但未发现 trajectory_*.json（trae-agent 尚未产生轨迹）',
      sessionDir: root
    }
  }
  return {
    available: false,
    reason:
      '未找到轨迹目录 ~/.local/share/trae-agent/trajectories（trae-agent 默认把轨迹写到运行时工作目录 trajectories/，无全局会话目录，可用 $TRAE_TRAJECTORY_DIR 指定监控目录）',
    sessionDir: root
  }
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

async function detect(): Promise<Detection> {
  return detectFromRoot(trajectoriesRootOf())
}

async function listFiles(): Promise<FileEntry[]> {
  return listFilesFromRoot(trajectoriesRootOf())
}

async function parseFile(_ctx: PluginContext, filePath: string, fromLine: number): Promise<ParsedResult> {
  return parseTrajectoryFile(filePath, fromLine)
}

export const traeAgentPlugin: MonitorPlugin = {
  id: 'trae-agent',
  name: 'Trae Agent',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles,
  parseFile
}
