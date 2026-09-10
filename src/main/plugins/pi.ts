import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'
import { ERROR_MESSAGE_MAX_LENGTH, isIgnoredFailureReason } from '../../../shared/failure'


export function dataRootOf(): string {
  const override = process.env.PI_CODING_AGENT_DIR
  if (override && override.trim() !== '') return path.join(override.trim(), 'sessions')
  return path.join(os.homedir(), '.pi', 'agent', 'sessions')
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

function hasSessionFile(dir: string): boolean {
  for (const ent of safeReaddir(dir)) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (hasSessionFile(p)) return true
    } else if (ent.isFile() && isSessionFile(ent.name)) {
      return true
    }
  }
  return false
}

export function listFilesFromRoot(root: string): FileEntry[] {
  const out: FileEntry[] = []
  collectSubtree(root, out)
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function detectFromRoot(root: string): Detection {
  let ok = false
  try {
    ok = fs.statSync(root).isDirectory()
  } catch {
    ok = false
  }
  if (!ok) {
    return {
      available: false,
      reason:
        '未找到会话目录 ~/.pi/agent/sessions（可用 $PI_CODING_AGENT_DIR 覆盖根目录；Pi 未安装或尚未产生会话）',
      sessionDir: root
    }
  }
  if (!hasSessionFile(root)) {
    return {
      available: false,
      reason: '会话目录下未发现 *.jsonl 会话文件（Pi 尚未产生会话）',
      sessionDir: root
    }
  }
  return { available: true, sessionDir: root }
}

const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function truncateMessage(text: string): string {
  return text.length > ERROR_MESSAGE_MAX_LENGTH ? text.slice(0, ERROR_MESSAGE_MAX_LENGTH) : text
}

function extractHttpStatus(entry: Record<string, unknown>, msg: Record<string, unknown>): number | undefined {
  const pools: unknown[] = [
    entry.httpStatus,
    entry.http_status,
    (entry as Record<string, unknown>).httpStatusCode,
    (entry as Record<string, unknown>).http_status_code,
    entry.statusCode,
    entry.status_code,
    entry.code,
    msg.httpStatus,
    msg.http_status,
    (msg as Record<string, unknown>).httpStatusCode,
    (msg as Record<string, unknown>).http_status_code,
    msg.statusCode,
    msg.status_code,
    msg.code
  ]
  for (const holder of [entry.error, msg.error, (entry as Record<string, unknown>).errorMessage, (msg as Record<string, unknown>).errorMessage]) {
    if (holder && typeof holder === 'object') {
      const o = holder as Record<string, unknown>
      const raw = o.httpStatus ?? o.http_status ?? o.statusCode ?? o.status_code ?? o.code ?? o.status
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw
      if (typeof raw === 'string' && raw.trim() !== '') {
        const n = Number(raw.trim())
        if (Number.isFinite(n)) return n
      }
    }
  }
  for (const raw of pools) {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
    if (typeof raw === 'string' && raw.trim() !== '') {
      const n = Number(raw.trim())
      if (Number.isFinite(n)) return n
    }
  }
  return undefined
}

function extractErrorMessage(entry: Record<string, unknown>, msg: Record<string, unknown>): string | undefined {
  const candidates: unknown[] = [
    entry.error,
    (entry as Record<string, unknown>).errorMessage,
    (entry as Record<string, unknown>).error_message,
    msg.error,
    (msg as Record<string, unknown>).errorMessage,
    (msg as Record<string, unknown>).error_message
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
  const statusCandidates = [
    entry.status,
    (entry as Record<string, unknown>).state,
    msg.status,
    (msg as Record<string, unknown>).state
  ]
  for (const s of statusCandidates) {
    if (typeof s === 'string' && s.trim() !== '' && !['success', 'completed', 'ok'].includes(s.trim().toLowerCase())) {
      return truncateMessage(s.trim())
    }
  }
  return undefined
}

function isIgnoredText(text: string): boolean {
  const lower = text.trim().toLowerCase()
  if (isIgnoredFailureReason(lower)) return true
  return lower.includes('cancelled') || lower.includes('canceled') || lower.includes('interrupted')
}

function detectPiFailure(
  entry: Record<string, unknown>,
  msg: Record<string, unknown>
): { isFailure: boolean; errorMessage?: string; httpStatus?: number; isIgnored: boolean } {
  const isNonEmpty = (v: unknown): boolean => {
    if (v === undefined || v === null) return false
    if (typeof v === 'string' && v.trim() === '') return false
    return true
  }
  const hasErrorField =
    isNonEmpty(entry.error) ||
    isNonEmpty((entry as Record<string, unknown>).errorMessage) ||
    isNonEmpty((entry as Record<string, unknown>).error_message) ||
    isNonEmpty(msg.error) ||
    isNonEmpty((msg as Record<string, unknown>).errorMessage) ||
    isNonEmpty((msg as Record<string, unknown>).error_message)

  const isErrorFlag = entry.isError === true || (entry as Record<string, unknown>).is_error === true || msg.isError === true || (msg as Record<string, unknown>).is_error === true

  let statusIsFailure = false
  const statusCandidates = [entry.status, (entry as Record<string, unknown>).state, msg.status, (msg as Record<string, unknown>).state]
  for (const s of statusCandidates) {
    if (typeof s === 'string' && s.trim() !== '' && !['success', 'completed', 'ok'].includes(s.trim().toLowerCase())) {
      statusIsFailure = true
      break
    }
    if (typeof s === 'number' && Number.isFinite(s) && s >= 400) {
      statusIsFailure = true
      break
    }
  }

  const isFailure = Boolean(hasErrorField || isErrorFlag || statusIsFailure)
  if (!isFailure) return { isFailure: false, isIgnored: false }

  const errorMessage = extractErrorMessage(entry, msg)
  const httpStatus = extractHttpStatus(entry, msg)

  const checkTexts: string[] = []
  if (errorMessage) checkTexts.push(errorMessage)
  for (const s of statusCandidates) if (typeof s === 'string') checkTexts.push(s)
  for (const e of [entry.error, msg.error, (entry as Record<string, unknown>).errorMessage, (msg as Record<string, unknown>).errorMessage]) {
    if (typeof e === 'string') checkTexts.push(e)
    else if (e && typeof e === 'object') {
      const o = e as Record<string, unknown>
      const inner = o.message ?? o.error ?? o.type ?? o.code ?? o.status
      if (typeof inner === 'string') checkTexts.push(inner)
    }
  }
  const isIgnored = checkTexts.some((t) => isIgnoredText(t))

  return { isFailure, errorMessage, httpStatus, isIgnored }
}

function toUsageRecord(
  entry: Record<string, unknown>,
  filePath: string,
  line: number,
  session: { sessionId?: string; project?: string }
): UsageRecord | null {
  if (entry.type !== 'message') return null

  const message = entry.message
  if (!message || typeof message !== 'object') return null
  const msg = message as Record<string, unknown>
  if (msg.role !== 'assistant') return null

  const rawModel = typeof msg.model === 'string' ? msg.model.trim() : ''
  const requestId = typeof entry.id === 'string' && entry.id.trim() !== '' ? entry.id.trim() : undefined

  let createdAt = toNum(entry.timestamp)
  if (createdAt <= 0) createdAt = toNum(msg.timestamp)
  if (createdAt <= 0) createdAt = Date.now()

  const failure = detectPiFailure(entry, msg)
  if (failure.isFailure) {
    if (failure.isIgnored) return null
    const model = rawModel || 'unknown'
    const usage = msg.usage && typeof msg.usage === 'object' ? (msg.usage as Record<string, unknown>) : null
    const u = usage ?? {}
    return {
      appType: 'pi',
      model,
      rawModel: model,
      inputTokens: toNum(u.input),
      outputTokens: toNum(u.output),
      cacheReadTokens: toNum(u.cacheRead),
      cacheCreationTokens: toNum(u.cacheWrite),
      inputSemantics: 2,
      status: 'error',
      ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
      ...(failure.errorMessage !== undefined ? { errorMessage: failure.errorMessage } : {}),
      createdAt,
      project: session.project,
      sessionId: session.sessionId,
      source: { filePath, line, ...(requestId ? { requestId } : {}) }
    }
  }

  if (!rawModel) return null

  const usage = msg.usage
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>

  return {
    appType: 'pi',
    model: rawModel,
    rawModel: rawModel,
    inputTokens: toNum(u.input),
    outputTokens: toNum(u.output),
    cacheReadTokens: toNum(u.cacheRead),
    cacheCreationTokens: toNum(u.cacheWrite),
    inputSemantics: 2,
    status: 'success',
    createdAt,
    project: session.project,
    sessionId: session.sessionId,
    source: { filePath, line, ...(requestId ? { requestId } : {}) }
  }
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
  const records: UsageRecord[] = []
  let sessionId: string | undefined
  let project: string | undefined
  let headerSeen = false
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

    if (!obj || typeof obj !== 'object') {
      nextLine = lineNumber + 1
      continue
    }
    const row = obj as Record<string, unknown>

    if (!headerSeen && row.type === 'session') {
      if (typeof row.id === 'string' && row.id.trim() !== '') sessionId = row.id
      if (typeof row.cwd === 'string' && row.cwd.trim() !== '') project = row.cwd
      headerSeen = true
    } else {
      const record = toUsageRecord(row, filePath, lineNumber, { sessionId, project })
      if (record) records.push(record)
    }
    nextLine = lineNumber + 1
  }

  if (!eof) eof = true

  return { records, nextLine, eof }
}

async function detect(): Promise<Detection> {
  return detectFromRoot(dataRootOf())
}

async function listFiles(): Promise<FileEntry[]> {
  return listFilesFromRoot(dataRootOf())
}

export const piPlugin: MonitorPlugin = {
  id: 'pi',
  name: 'Pi Coding Agent',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles,
  parseFile
}
