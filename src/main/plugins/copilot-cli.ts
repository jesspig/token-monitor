import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'

export function sessionStateRootOf(): string {
  const dir = process.env.COPILOT_DIR
  if (dir && dir.trim() !== '') return dir.trim()
  const home = process.env.COPILOT_HOME
  if (home && home.trim() !== '') return path.join(home.trim(), 'session-state')
  const configDir = process.env.COPILOT_CONFIG_DIR
  if (configDir && configDir.trim() !== '') return path.join(configDir.trim(), 'session-state')
  return path.join(os.homedir(), '.copilot', 'session-state')
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

export function listFilesFromRoot(root: string): FileEntry[] {
  const out: FileEntry[] = []
  for (const ent of safeReaddir(root)) {
    if (!ent.isDirectory() || isTransientName(ent.name)) continue
    const p = path.join(root, ent.name, 'events.jsonl')
    let st: fs.Stats | null = null
    try {
      st = fs.statSync(p)
    } catch {
      st = null
    }
    if (st?.isFile()) out.push({ path: p, mtime: Math.round(st.mtimeMs) })
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function detectFromRoot(root: string): Detection {
  let dirExists = false
  try {
    dirExists = fs.statSync(root).isDirectory()
  } catch {
    dirExists = false
  }
  if (!dirExists) {
    return {
      available: false,
      reason:
        '未找到会话状态目录 ~/.copilot/session-state（Copilot CLI 未安装或尚未产生会话，可用 $COPILOT_DIR / $COPILOT_HOME / $COPILOT_CONFIG_DIR 覆盖）',
      sessionDir: root
    }
  }
  if (listFilesFromRoot(root).length === 0) {
    return {
      available: false,
      reason: '会话状态目录下未发现 <session-uuid>/events.jsonl（Copilot CLI 尚未产生会话）',
      sessionDir: root
    }
  }
  return { available: true, sessionDir: root }
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

interface TokenWatermark {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

interface FileDeltaState {
  cursorLine: number
  models: Map<string, TokenWatermark>
}

const DELTA_STATE_CACHE_MAX = 512

const deltaStateCache = new Map<string, FileDeltaState>()

function toShutdownRecords(
  row: Record<string, unknown>,
  filePath: string,
  lineNumber: number,
  models: Map<string, TokenWatermark>
): UsageRecord[] {
  const data = row.data
  if (!data || typeof data !== 'object') return []
  const metrics = (data as Record<string, unknown>).modelMetrics
  if (!metrics || typeof metrics !== 'object') return []

  const requestIdBase =
    typeof row.id === 'string' && row.id.trim() !== ''
      ? row.id.trim()
      : typeof row.timestamp === 'string' && row.timestamp.trim() !== ''
        ? row.timestamp.trim()
        : `line-${lineNumber}`
  const createdAt = parseTsMs(row.timestamp)

  const records: UsageRecord[] = []
  for (const [model, entry] of Object.entries(metrics as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue
    const usage = (entry as Record<string, unknown>).usage
    if (!usage || typeof usage !== 'object') continue
    const u = usage as Record<string, unknown>
    const cum: TokenWatermark = {
      input: toNum(u.inputTokens),
      output: toNum(u.outputTokens),
      cacheRead: toNum(u.cacheReadTokens),
      cacheWrite: toNum(u.cacheWriteTokens)
    }
    const prev = models.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    const delta: TokenWatermark = {
      input: Math.max(0, cum.input - prev.input),
      output: Math.max(0, cum.output - prev.output),
      cacheRead: Math.max(0, cum.cacheRead - prev.cacheRead),
      cacheWrite: Math.max(0, cum.cacheWrite - prev.cacheWrite)
    }
    if (delta.input === 0 && delta.output === 0 && delta.cacheRead === 0 && delta.cacheWrite === 0) continue
    models.set(model, cum)
    records.push({
      appType: 'copilot-cli',
      model,
      rawModel: model,
      inputTokens: delta.input,
      outputTokens: delta.output,
      cacheReadTokens: delta.cacheRead,
      cacheCreationTokens: delta.cacheWrite,
      inputSemantics: 1,
      status: 'success',
      createdAt,
      source: { filePath, line: lineNumber, requestId: `${requestIdBase}:${model}` }
    })
  }
  return records
}

export function parseEventsFile(filePath: string, fromLine: number): ParsedResult {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return { records: [], nextLine: fromLine, eof: true }
  }
  if (content.trim() === '') {
    return { records: [], nextLine: Math.max(fromLine, 1), eof: true }
  }

  const lines = content.split('\n')
  const cached = fromLine > 1 ? deltaStateCache.get(filePath) : undefined
  const models =
    cached && cached.cursorLine === fromLine ? cached.models : new Map<string, TokenWatermark>()

  const records: UsageRecord[] = []
  let nextLine = fromLine
  let eof = false
  const startIndex = fromLine > 0 ? fromLine - 1 : 0

  for (let i = startIndex; i < lines.length; i++) {
    const lineNumber = i + 1
    const raw = lines[i]
    if (raw.trim() === '') {
      nextLine = i === lines.length - 1 ? lineNumber : lineNumber + 1
      continue
    }

    let obj: unknown
    try {
      obj = JSON.parse(raw)
    } catch {
      const onlyEmptyAfter = lines.slice(i + 1).every((l) => l === '')
      if (onlyEmptyAfter) {
        nextLine = lineNumber
        eof = true
        break
      }
      nextLine = lineNumber + 1
      continue
    }

    if (!obj || typeof obj !== 'object') {
      nextLine = lineNumber + 1
      continue
    }
    const row = obj as Record<string, unknown>
    if (row.type === 'session.shutdown') {
      records.push(...toShutdownRecords(row, filePath, lineNumber, models))
    }
    nextLine = lineNumber + 1
  }

  if (!eof) eof = true

  deltaStateCache.delete(filePath)
  deltaStateCache.set(filePath, { cursorLine: nextLine, models })
  if (deltaStateCache.size > DELTA_STATE_CACHE_MAX) {
    const oldest = deltaStateCache.keys().next().value
    if (oldest !== undefined) deltaStateCache.delete(oldest)
  }

  return { records, nextLine, eof }
}

async function detect(): Promise<Detection> {
  return detectFromRoot(sessionStateRootOf())
}

async function listFiles(): Promise<FileEntry[]> {
  return listFilesFromRoot(sessionStateRootOf())
}

async function parseFile(_ctx: PluginContext, filePath: string, fromLine: number): Promise<ParsedResult> {
  return parseEventsFile(filePath, fromLine)
}

export const copilotCliPlugin: MonitorPlugin = {
  id: 'copilot-cli',
  name: 'Copilot CLI',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles,
  parseFile
}
