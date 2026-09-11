import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'

export function dataRootOf(): string {
  const override = process.env.DROID_DIR
  if (override && override.trim() !== '') return override.trim()
  return path.join(os.homedir(), '.factory')
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
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

function isTemporaryOrHidden(name: string): boolean {
  return name.startsWith('.') || /(?:\.tmp|\.swp|~)$/i.test(name)
}

function isSessionFile(name: string): boolean {
  return name.endsWith('.jsonl') && !isTemporaryOrHidden(name)
}

function isSettingsFile(name: string): boolean {
  return name.endsWith('.settings.json') && !isTemporaryOrHidden(name)
}

function collectSubtree(dir: string, out: FileEntry[]): void {
  for (const ent of safeReaddir(dir)) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      collectSubtree(p, out)
    } else if (ent.isFile() && (isSessionFile(ent.name) || isSettingsFile(ent.name))) {
      out.push(toEntry(p))
    }
  }
}

function physicalPathKey(filePath: string): string {
  let resolved = path.resolve(filePath)
  try {
    resolved = fs.realpathSync.native(resolved)
  } catch {
    resolved = path.resolve(filePath)
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export function listFilesFromRoot(root: string): FileEntry[] {
  const collected: FileEntry[] = []
  collectSubtree(path.join(root, 'sessions'), collected)
  collectSubtree(path.join(root, 'projects'), collected)

  const unique = new Map<string, FileEntry>()
  for (const entry of collected) {
    const key = physicalPathKey(entry.path)
    const current = unique.get(key)
    if (!current || entry.mtime > current.mtime) unique.set(key, entry)
  }

  return [...unique.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function detectFromRoot(root: string): Detection {
  if (!isDirectory(root)) {
    return {
      available: false,
      reason: '未找到数据目录 ~/.factory（Factory Droid 未安装或尚未产生会话，可用 $DROID_DIR 覆盖数据根）',
      sessionDir: root
    }
  }
  if (isDirectory(path.join(root, 'sessions')) || isDirectory(path.join(root, 'projects'))) {
    return { available: true, sessionDir: root }
  }
  return {
    available: false,
    reason: '数据目录存在但未发现 sessions/ 或 projects/ 会话子目录（Droid 尚未产生会话）',
    sessionDir: root
  }
}

const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function parseTsMs(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    return v >= 1_000_000_000_000 ? v : v * 1000
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const parsed = Date.parse(v)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Date.now()
}

function extractCwd(obj: unknown): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const row = obj as Record<string, unknown>
  if (row.type !== 'session_start') return undefined
  if (typeof row.cwd !== 'string' || row.cwd.trim() === '') return undefined
  return row.cwd
}

function toUsageRecord(
  obj: unknown,
  filePath: string,
  line: number,
  project: string | undefined
): UsageRecord | null {
  if (!obj || typeof obj !== 'object') return null
  const row = obj as Record<string, unknown>
  if (row.type !== 'message') return null

  const message = row.message
  if (!message || typeof message !== 'object') return null
  const msg = message as Record<string, unknown>

  if (msg.role !== 'assistant') return null

  const model = typeof msg.model === 'string' ? msg.model.trim() : ''
  if (!model) return null

  const usage = msg.usage
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>

  const requestId = typeof msg.id === 'string' && msg.id.trim() !== '' ? msg.id.trim() : undefined

  return {
    appType: 'droid',
    model,
    rawModel: model,
    inputTokens: toNum(u.inputTokens),
    outputTokens: toNum(u.outputTokens),
    cacheReadTokens: toNum(u.cacheReadInputTokens),
    cacheCreationTokens: toNum(u.cacheCreationInputTokens),
    inputSemantics: 2,
    status: 'success',
    ...(requestId ? { isReplaceableSnapshot: true } : {}),
    createdAt: parseTsMs(row.timestamp),
    ...(project !== undefined ? { project } : {}),
    source: { filePath, line, ...(requestId ? { requestId } : {}) }
  }
}

function snapshotWins(candidate: UsageRecord, current: UsageRecord): boolean {
  return candidate.outputTokens >= current.outputTokens
}

export function foldById(records: UsageRecord[]): UsageRecord[] {
  const out: UsageRecord[] = []
  const slots = new Map<string, number>()
  for (const rec of records) {
    const rid = rec.source.requestId
    if (!rid) {
      out.push(rec)
      continue
    }
    const existing = slots.get(rid)
    if (existing === undefined) {
      slots.set(rid, out.length)
      out.push(rec)
    } else if (snapshotWins(rec, out[existing])) {
      out[existing] = rec
    }
  }
  return out
}

export async function parseSettingsSummaryFile(
  filePath: string,
  fromLine: number
): Promise<ParsedResult> {
  let content: string
  try {
    content = await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return { records: [], nextLine: fromLine, eof: true }
  }

  let summary: unknown
  try {
    summary = JSON.parse(content)
  } catch {
    throw new Error('Droid 会话摘要不是合法 JSON')
  }

  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    throw new Error('Droid 会话摘要顶层必须是对象')
  }

  return { records: [], nextLine: 1, eof: true }
}

export async function parseSessionFile(
  filePath: string,
  fromLine: number
): Promise<ParsedResult> {
  let content: string
  try {
    content = await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return { records: [], nextLine: fromLine, eof: true }
  }

  const lines = content.split('\n')
  const buffered: UsageRecord[] = []
  const slots = new Map<string, number>()
  const bestById = new Map<string, UsageRecord>()
  let nextLine = fromLine
  let project: string | undefined

  const startIndex = fromLine > 0 ? fromLine - 1 : 0
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1
    const raw = lines[i]
    if (raw.trim() === '') {
      if (i >= startIndex) {
        nextLine = i === lines.length - 1 ? lineNumber : lineNumber + 1
      }
      continue
    }

    let obj: unknown
    let broken = false
    try {
      obj = JSON.parse(raw)
    } catch {
      broken = true
    }

    if (broken) {
      if (i < startIndex) continue
      const onlyEmptyAfter = lines.slice(i + 1).every((line) => line === '')
      if (onlyEmptyAfter) {
        nextLine = lineNumber
        break
      }
      nextLine = lineNumber + 1
      continue
    }

    if (project === undefined) {
      const cwd = extractCwd(obj)
      if (cwd !== undefined) project = cwd
    }

    const record = toUsageRecord(obj, filePath, lineNumber, project)
    if (record) {
      const requestId = record.source.requestId
      if (!requestId) {
        if (i >= startIndex) buffered.push(record)
      } else {
        const currentBest = bestById.get(requestId)
        if (!currentBest || snapshotWins(record, currentBest)) {
          bestById.set(requestId, record)
          if (i >= startIndex) {
            const slot = slots.get(requestId)
            if (slot === undefined) {
              slots.set(requestId, buffered.length)
              buffered.push(record)
            } else {
              buffered[slot] = record
            }
          }
        }
      }
    }

    if (i >= startIndex) nextLine = lineNumber + 1
  }

  return { records: buffered, nextLine, eof: true }
}

async function detect(): Promise<Detection> {
  return detectFromRoot(dataRootOf())
}

async function listFiles(): Promise<FileEntry[]> {
  return listFilesFromRoot(dataRootOf())
}

async function parseFile(
  _ctx: PluginContext,
  filePath: string,
  fromLine: number
): Promise<ParsedResult> {
  if (isSettingsFile(path.basename(filePath))) {
    return parseSettingsSummaryFile(filePath, fromLine)
  }
  return parseSessionFile(filePath, fromLine)
}

export const droidPlugin: MonitorPlugin = {
  id: 'droid',
  name: 'Droid',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles,
  parseFile
}
