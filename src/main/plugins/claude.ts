import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'


function sessionRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects')
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
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

function isSessionFile(name: string): boolean {
  if (!name.endsWith('.jsonl')) return false
  if (name.startsWith('.')) return false
  return !/(?:\.tmp|\.swp|~)$/i.test(name)
}

function collectSubtree(dir: string, out: FileEntry[]): void {
  for (const ent of safeReaddir(dir)) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      collectSubtree(p, out)
    } else if (ent.isFile() && isSessionFile(ent.name)) {
      out.push(toEntry(p))
    }
  }
}

function collectSessionSubdir(sessionDir: string, out: FileEntry[]): void {
  for (const ent of safeReaddir(sessionDir)) {
    if (!ent.isDirectory()) continue
    if (ent.name === 'subagents' || ent.name === 'workflows') {
      collectSubtree(path.join(sessionDir, ent.name), out)
    }
  }
}

function collectProjectDir(projectDir: string, out: FileEntry[]): void {
  for (const ent of safeReaddir(projectDir)) {
    const p = path.join(projectDir, ent.name)
    if (ent.isFile()) {
      if (isSessionFile(ent.name)) out.push(toEntry(p))
    } else if (ent.isDirectory()) {
      collectSessionSubdir(p, out)
    }
  }
}

export function listFilesFromRoot(root: string): FileEntry[] {
  const out: FileEntry[] = []
  for (const ent of safeReaddir(root)) {
    if (!ent.isDirectory()) continue
    collectProjectDir(path.join(root, ent.name), out)
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function detectFromRoot(rootDir: string): Detection {
  let ok = false
  try {
    ok = fs.statSync(rootDir).isDirectory()
  } catch {
    ok = false
  }
  if (ok) return { available: true, sessionDir: rootDir }
  return {
    available: false,
    reason: '未找到会话目录 ~/.claude/projects（Claude Code 未安装或尚未产生会话）',
    sessionDir: rootDir
  }
}

const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const SYNTHETIC_MODEL = '<synthetic>'

function truncateMessage(text: string): string {
  return text.length > 500 ? text.slice(0, 500) : text
}

function extractErrorMessage(
  row: Record<string, unknown>,
  msg: Record<string, unknown> | null
): string | undefined {
  if (Array.isArray(row.content) && row.content.length > 0) {
    const first = row.content[0] as Record<string, unknown> | null
    if (first && typeof first.text === 'string' && first.text.trim() !== '') {
      return truncateMessage(first.text)
    }
  }
  if (typeof row.content === 'string' && row.content.trim() !== '') {
    return truncateMessage(row.content as string)
  }
  if (msg) {
    const mc = msg.content
    if (Array.isArray(mc) && mc.length > 0) {
      const first = mc[0] as Record<string, unknown> | null
      if (first && typeof first.text === 'string' && first.text.trim() !== '') {
        return truncateMessage(first.text)
      }
    }
    if (typeof mc === 'string' && (mc as string).trim() !== '') {
      return truncateMessage(mc as string)
    }
  }
  return undefined
}

function toErrorRecord(obj: unknown, filePath: string, line: number): UsageRecord | null {
  if (!obj || typeof obj !== 'object') return null
  const row = obj as Record<string, unknown>
  if (row.isApiErrorMessage !== true) return null

  const message = row.message
  const msg = message && typeof message === 'object' ? (message as Record<string, unknown>) : null

  const httpStatusRaw = row.apiErrorStatus
  const httpStatus =
    typeof httpStatusRaw === 'number' && Number.isFinite(httpStatusRaw) ? httpStatusRaw : undefined

  const errorMessage = extractErrorMessage(row, msg)

  let model: string
  if (msg && typeof msg.model === 'string' && msg.model.trim() !== '') {
    model = msg.model.trim()
  } else {
    model = SYNTHETIC_MODEL
  }

  let requestId: string | undefined
  if (msg && typeof msg.id === 'string' && msg.id.trim() !== '') {
    requestId = msg.id.trim()
  } else if (typeof row.uuid === 'string' && row.uuid.trim() !== '') {
    requestId = row.uuid.trim()
  } else if (typeof row.id === 'string' && (row.id as string).trim() !== '') {
    requestId = (row.id as string).trim()
  }

  const ts = typeof row.timestamp === 'string' ? row.timestamp : ''
  const parsed = ts ? Date.parse(ts) : NaN

  return {
    appType: 'claude',
    model,
    rawModel: model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    inputSemantics: 2,
    status: 'error',
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    createdAt: Number.isNaN(parsed) ? Date.now() : parsed,
    project: typeof row.cwd === 'string' ? row.cwd : undefined,
    sessionId: typeof row.sessionId === 'string' ? row.sessionId : undefined,
    source: { filePath, line, ...(requestId ? { requestId } : {}) }
  }
}

function toUsageRecord(obj: unknown, filePath: string, line: number): UsageRecord | null {
  if (!obj || typeof obj !== 'object') return null
  const row = obj as Record<string, unknown>
  if (row.type !== 'assistant') return null

  const message = row.message
  if (!message || typeof message !== 'object') return null
  const msg = message as Record<string, unknown>

  const model = typeof msg.model === 'string' ? msg.model.trim() : ''
  if (!model) return null

  const usage = msg.usage
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>

  const requestId = typeof msg.id === 'string' && msg.id.trim() !== '' ? msg.id.trim() : undefined

  const ts = typeof row.timestamp === 'string' ? row.timestamp : ''
  const parsed = ts ? Date.parse(ts) : NaN

  return {
    appType: 'claude',
    model,
    rawModel: model,
    inputTokens: toNum(u.input_tokens),
    outputTokens: toNum(u.output_tokens),
    cacheReadTokens: toNum(u.cache_read_input_tokens),
    cacheCreationTokens: toNum(u.cache_creation_input_tokens),
    inputSemantics: 2,
    status: 'success',
    createdAt: Number.isNaN(parsed) ? Date.now() : parsed,
    project: typeof row.cwd === 'string' ? row.cwd : undefined,
    sessionId: typeof row.sessionId === 'string' ? row.sessionId : undefined,
    source: { filePath, line, ...(requestId ? { requestId } : {}) }
  }
}

export function foldById(records: UsageRecord[]): UsageRecord[] {
  const out: UsageRecord[] = []
  const slots = new Map<string, number>()
  for (const rec of records) {
    if (rec.status === 'error') {
      out.push(rec)
      continue
    }
    const rid = rec.source.requestId
    if (!rid) {
      out.push(rec)
      continue
    }
    const existing = slots.get(rid)
    if (existing === undefined) {
      slots.set(rid, out.length)
      out.push(rec)
    } else if (rec.outputTokens >= out[existing].outputTokens) {
      out[existing] = rec
    }
  }
  return out
}

async function parseFile(
  _ctx: PluginContext,
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
  let nextLine = fromLine
  let eof = false

  const startIndex = fromLine > 0 ? fromLine - 1 : 0
  for (let i = startIndex; i < lines.length; i++) {
    const lineNumber = i + 1
    const raw = lines[i]
    if (raw.trim() === '') {
      nextLine = lineNumber + 1
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

    const errorRecord = toErrorRecord(obj, filePath, lineNumber)
    if (errorRecord) {
      buffered.push(errorRecord)
      nextLine = lineNumber + 1
      continue
    }
    const record = toUsageRecord(obj, filePath, lineNumber)
    if (record) buffered.push(record)
    nextLine = lineNumber + 1
  }

  if (!eof) eof = true

  const records = foldById(buffered)
  return { records, nextLine, eof }
}

async function detect(): Promise<Detection> {
  return detectFromRoot(sessionRoot())
}

export const claudePlugin: MonitorPlugin = {
  id: 'claude',
  name: 'Claude Code',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles: async () => listFilesFromRoot(sessionRoot()),
  parseFile
}
