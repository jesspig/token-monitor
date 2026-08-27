import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'
import { ERROR_MESSAGE_MAX_LENGTH, isIgnoredFailureReason } from '../../../shared/failure'


function grokRoot(): string {
  const env = process.env.GROK_HOME
  if (env && env.trim()) return env.trim()
  return path.join(os.homedir(), '.grok')
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

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function isTempFile(name: string): boolean {
  if (name.startsWith('.')) return true
  return /(?:\.tmp|\.swp|~)$/i.test(name)
}

function isSummaryFile(name: string): boolean {
  return name === 'summary.json' && !isTempFile(name)
}

function collectSummaries(dir: string, out: FileEntry[]): void {
  for (const ent of safeReaddir(dir)) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      collectSummaries(p, out)
    } else if (ent.isFile() && isSummaryFile(ent.name)) {
      out.push(toEntry(p))
    }
  }
}

export function listFilesFromRoot(root: string): FileEntry[] {
  const out: FileEntry[] = []
  const logFile = path.join(root, 'logs', 'unified.jsonl')
  if (!isTempFile(path.basename(logFile)) && isFile(logFile)) out.push(toEntry(logFile))
  collectSummaries(path.join(root, 'sessions'), out)
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function detectFromRoot(root: string): Detection {
  if (isFile(path.join(root, 'logs', 'unified.jsonl'))) {
    return { available: true, sessionDir: root }
  }
  try {
    if (fs.statSync(path.join(root, 'sessions')).isDirectory()) {
      return { available: true, sessionDir: root }
    }
  } catch {
  }
  return {
    available: false,
    reason: '未找到 ~/.grok（Grok Build 未安装或尚未产生会话数据）',
    sessionDir: root
  }
}

function readCurrentModel(p: string): string | undefined {
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
    const m = obj.current_model_id
    if (typeof m === 'string' && m.trim()) return m.trim()
  } catch {
  }
  return undefined
}

let modelMap = new Map<string, string>()

let lastSummarySignature: string | null = null

export async function loadModelMap(root: string): Promise<Map<string, string>> {
  const summaries: FileEntry[] = []
  collectSummaries(path.join(root, 'sessions'), summaries)
  const signature = summaries.map((e) => `${e.path}:${e.mtime}`).join('\n')
  if (signature === lastSummarySignature) return modelMap

  const map = new Map<string, string>()
  for (const e of summaries) {
    const sessionId = path.basename(path.dirname(e.path))
    if (!sessionId) continue
    const model = readCurrentModel(e.path)
    if (model) map.set(sessionId, model)
  }
  modelMap = map
  lastSummarySignature = signature
  return map
}

const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function truncateMessage(text: string): string {
  return text.length > ERROR_MESSAGE_MAX_LENGTH ? text.slice(0, ERROR_MESSAGE_MAX_LENGTH) : text
}

function extractHttpStatus(row: Record<string, unknown>, ctx: Record<string, unknown>): number | undefined {
  const candidates = [
    row.httpStatus,
    row.http_status,
    (row as Record<string, unknown>).http_status_code,
    (row as Record<string, unknown>).httpStatusCode,
    row.statusCode,
    row.status_code,
    ctx.httpStatus,
    ctx.http_status,
    (ctx as Record<string, unknown>).http_status_code,
    (ctx as Record<string, unknown>).httpStatusCode,
    ctx.statusCode,
    ctx.status_code
  ]
  for (const raw of candidates) {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
    if (typeof raw === 'string' && raw.trim() !== '') {
      const n = Number(raw.trim())
      if (Number.isFinite(n)) return n
    }
  }
  for (const holder of [row.error, ctx.error, (row as Record<string, unknown>).errorMessage, ctx.errorMessage]) {
    if (holder && typeof holder === 'object') {
      const o = holder as Record<string, unknown>
      const raw = o.httpStatus ?? o.http_status ?? o.statusCode ?? o.status_code ?? o.code
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw
      if (typeof raw === 'string' && raw.trim() !== '') {
        const n = Number(raw.trim())
        if (Number.isFinite(n)) return n
      }
    }
  }
  return undefined
}

function extractErrorMessage(row: Record<string, unknown>, ctx: Record<string, unknown>): string | undefined {
  const candidates: unknown[] = [
    row.error,
    (row as Record<string, unknown>).errorMessage,
    (row as Record<string, unknown>).error_message,
    ctx.error,
    (ctx as Record<string, unknown>).errorMessage,
    (ctx as Record<string, unknown>).error_message,
    (row as Record<string, unknown>).message,
    ctx.message
  ]
  for (const raw of candidates) {
    if (typeof raw === 'string' && raw.trim() !== '') return truncateMessage(raw.trim())
    if (raw && typeof raw === 'object') {
      const o = raw as Record<string, unknown>
      const inner = o.message ?? o.error ?? o.text ?? o.content
      if (typeof inner === 'string' && inner.trim() !== '') return truncateMessage(inner.trim())
      try {
        const s = JSON.stringify(raw)
        if (s && s !== '{}' && s.trim() !== '') return truncateMessage(s)
      } catch {
      }
    }
  }
  const statusRaw = (row.status ?? ctx.status) as unknown
  if (typeof statusRaw === 'string' && statusRaw.trim() !== '' && statusRaw.trim().toLowerCase() !== 'success') {
    return truncateMessage(statusRaw.trim())
  }
  return undefined
}

function isIgnoredText(text: string): boolean {
  const lower = text.trim().toLowerCase()
  if (isIgnoredFailureReason(lower)) return true
  return lower.includes('cancelled') || lower.includes('canceled') || lower.includes('interrupted')
}

function detectGrokFailure(row: Record<string, unknown>, ctx: Record<string, unknown>): {
  isFailure: boolean
  errorMessage?: string
  httpStatus?: number
  isIgnored: boolean
} {
  const isNonEmpty = (v: unknown): boolean => {
    if (v === undefined || v === null) return false
    if (typeof v === 'string' && v.trim() === '') return false
    return true
  }
  const hasErrorField =
    isNonEmpty(row.error) ||
    isNonEmpty((row as Record<string, unknown>).errorMessage) ||
    isNonEmpty((row as Record<string, unknown>).error_message) ||
    isNonEmpty(ctx.error) ||
    isNonEmpty((ctx as Record<string, unknown>).errorMessage) ||
    isNonEmpty((ctx as Record<string, unknown>).error_message)

  let statusIsFailure = false
  const statusCandidates = [row.status, ctx.status]
  for (const s of statusCandidates) {
    if (typeof s === 'string' && s.trim() !== '' && s.trim().toLowerCase() !== 'success') {
      statusIsFailure = true
      break
    }
    if (typeof s === 'number' && Number.isFinite(s) && s >= 400) {
      statusIsFailure = true
      break
    }
  }

  const isFailure = Boolean(hasErrorField || statusIsFailure)
  if (!isFailure) return { isFailure: false, isIgnored: false }

  const errorMessage = extractErrorMessage(row, ctx)
  const httpStatus = extractHttpStatus(row, ctx)

  const checkTexts: string[] = []
  if (errorMessage) checkTexts.push(errorMessage)
  for (const s of statusCandidates) if (typeof s === 'string') checkTexts.push(s)
  for (const e of [row.error, ctx.error, (row as Record<string, unknown>).errorMessage, (ctx as Record<string, unknown>).errorMessage]) {
    if (typeof e === 'string') checkTexts.push(e)
    else if (e && typeof e === 'object') {
      const o = e as Record<string, unknown>
      const inner = o.message ?? o.error ?? o.type ?? o.code
      if (typeof inner === 'string') checkTexts.push(inner)
    }
  }
  const isIgnored = checkTexts.some((t) => isIgnoredText(t))

  return { isFailure, errorMessage, httpStatus, isIgnored }
}

function extractTime(row: Record<string, unknown>, ctx: Record<string, unknown>): number {
  for (const key of ['timestamp', 'ts', 'time']) {
    const v = row[key] ?? ctx[key]
    if (typeof v === 'number' && Number.isFinite(v)) {
      return v < 1e12 ? v * 1000 : v
    }
    if (typeof v === 'string') {
      const t = Date.parse(v)
      if (!Number.isNaN(t)) return t
    }
  }
  return Date.now()
}

function toUsageRecord(obj: unknown, filePath: string, line: number): UsageRecord | null {
  if (!obj || typeof obj !== 'object') return null
  const row = obj as Record<string, unknown>
  if (row.msg !== 'shell.turn.inference_done') return null

  const ctx = row.ctx
  if (!ctx || typeof ctx !== 'object') return null
  const c = ctx as Record<string, unknown>

  const sessionId = typeof row.sessionId === 'string' && row.sessionId ? row.sessionId : undefined
  const model = sessionId ? modelMap.get(sessionId) : undefined
  if (!model) return null

  const rawSid = typeof row.sid === 'string' ? row.sid.trim() : ''
  const loop = c.loop_index
  const loopIndex = typeof loop === 'number' && Number.isFinite(loop) ? loop : undefined
  const requestId = rawSid && loopIndex !== undefined ? `${rawSid}:${loopIndex}` : undefined

  const failure = detectGrokFailure(row, c)
  if (failure.isFailure) {
    if (failure.isIgnored) return null
    return {
      appType: 'grok',
      model,
      rawModel: model,
      inputTokens: toNum(c.prompt_tokens),
      outputTokens: toNum(c.completion_tokens),
      cacheReadTokens: toNum(c.cached_prompt_tokens),
      cacheCreationTokens: 0,
      inputSemantics: 1,
      status: 'error',
      ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
      ...(failure.errorMessage !== undefined ? { errorMessage: failure.errorMessage } : {}),
      createdAt: extractTime(row, c),
      project: typeof row.project === 'string' ? row.project : typeof row.cwd === 'string' ? row.cwd : undefined,
      sessionId,
      source: requestId ? { filePath, line, requestId } : { filePath, line }
    }
  }

  return {
    appType: 'grok',
    model,
    rawModel: model,
    inputTokens: toNum(c.prompt_tokens),
    outputTokens: toNum(c.completion_tokens),
    cacheReadTokens: toNum(c.cached_prompt_tokens),
    cacheCreationTokens: 0,
    inputSemantics: 1,
    status: 'success',
    createdAt: extractTime(row, c),
    project: typeof row.project === 'string' ? row.project : typeof row.cwd === 'string' ? row.cwd : undefined,
    sessionId,
    source: requestId ? { filePath, line, requestId } : { filePath, line }
  }
}

async function parseFile(
  _ctx: PluginContext,
  filePath: string,
  fromLine: number
): Promise<ParsedResult> {
  if (filePath.endsWith('summary.json')) {
    return { records: [], nextLine: fromLine, eof: true }
  }
  if (!filePath.endsWith('unified.jsonl')) {
    return { records: [], nextLine: fromLine, eof: true }
  }

  let content: string
  try {
    content = await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return { records: [], nextLine: fromLine, eof: true }
  }

  const lines = content.split('\n')
  const records: UsageRecord[] = []
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

    const record = toUsageRecord(obj, filePath, lineNumber)
    if (record) records.push(record)
    nextLine = lineNumber + 1
  }

  if (!eof) eof = true

  return { records, nextLine, eof }
}

async function detect(): Promise<Detection> {
  return detectFromRoot(grokRoot())
}

export const grokPlugin: MonitorPlugin = {
  id: 'grok',
  name: 'Grok Build',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles: async () => {
    const root = grokRoot()
    await loadModelMap(root)
    return listFilesFromRoot(root)
  },
  parseFile
}
