import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'


function sessionRoot(): string {
  return path.join(os.homedir(), '.codex', 'sessions')
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

export function listFilesFromRoot(root: string): FileEntry[] {
  const out: FileEntry[] = []
  collectSubtree(root, out)
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
    reason: '未找到会话目录 ~/.codex/sessions（Codex CLI 未安装或尚未产生会话）',
    sessionDir: rootDir
  }
}

const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const toStr = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined

function getPayloadObj(row: Record<string, unknown>): Record<string, unknown> | null {
  const payload = row.payload
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
}

function sessionIdFromFilename(filePath: string): string | undefined {
  const base = path.basename(filePath)
  if (!base.endsWith('.jsonl')) return undefined
  const stem = base.slice(0, -'.jsonl'.length)
  if (!stem.startsWith('rollout-')) return undefined
  const id = stem.slice('rollout-'.length)
  return id ? id : undefined
}

interface CodexState {
  model?: string
  cwd?: string
  sessionId?: string
  threadId?: string
}

function updateState(row: Record<string, unknown>, state: CodexState): void {
  const payload = getPayloadObj(row)
  if (!payload) return
  if (row.type === 'session_meta') {
    const cwd = toStr(payload.cwd)
    if (cwd) state.cwd = cwd
    const id = toStr(payload.id)
    if (id) state.sessionId = id
    const threadId = toStr(payload.thread_id)
    if (threadId) state.threadId = threadId
  } else if (row.type === 'turn_context') {
    const model = toStr(payload.model)
    if (model) state.model = model
  }
}

function toUsageRecord(
  row: Record<string, unknown>,
  state: CodexState,
  filePath: string,
  line: number
): UsageRecord | null {
  const payload = getPayloadObj(row)
  if (row.type !== 'event_msg' || !payload) return null

  if (payload.type === 'turn_aborted') return null

  if (payload.type === 'stream_error') {
    const model = state.model ?? 'unknown'
    const rawModel = model

    let createdAt = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
    if (Number.isNaN(createdAt)) {
      const payloadTs = toStr(payload.timestamp) ?? toStr(payload.time)
      if (payloadTs) {
        const p = Date.parse(payloadTs)
        if (!Number.isNaN(p)) createdAt = p
      }
    }
    if (Number.isNaN(createdAt)) {
      const info = payload.info
      if (info && typeof info === 'object') {
        const infoObj = info as Record<string, unknown>
        const infoTs = toStr(infoObj.time) ?? toStr(infoObj.timestamp)
        if (infoTs) {
          const p = Date.parse(infoTs)
          if (!Number.isNaN(p)) createdAt = p
        }
      }
    }
    if (Number.isNaN(createdAt)) createdAt = Date.now()

    let httpStatus: number | undefined
    const errInfo = payload.codex_error_info
    if (errInfo && typeof errInfo === 'object') {
      const ei = errInfo as Record<string, unknown>
      const raw =
        ei.http_status_code ?? ei.httpStatusCode ?? ei.http_status ?? ei.status_code ?? ei.statusCode
      if (typeof raw === 'number' && Number.isFinite(raw)) httpStatus = raw
      else if (typeof raw === 'string' && raw.trim() !== '') {
        const n = Number(raw)
        if (Number.isFinite(n)) httpStatus = n
      }
    }

    const errorMessage = toStr(payload.message)

    return {
      appType: 'codex',
      model,
      rawModel,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      inputSemantics: 1,
      status: 'error',
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      createdAt,
      project: state.cwd,
      sessionId: state.sessionId,
      source: { filePath, line }
    }
  }

  if (payload.type !== 'token_count') return null

  const model = state.model
  if (!model) return null

  const info = payload.info
  if (!info || typeof info !== 'object') return null
  const u = (info as Record<string, unknown>).last_token_usage
  if (!u || typeof u !== 'object') return null
  const usage = u as Record<string, unknown>

  const inputTokens = toNum(usage.input_tokens)
  const outputTokens = toNum(usage.output_tokens)
  const cacheReadTokens = toNum(usage.cached_input_tokens)
  const reasoningOutputTokens = toNum(usage.reasoning_output_tokens)
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && reasoningOutputTokens === 0) {
    return null
  }

  let createdAt = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
  if (Number.isNaN(createdAt)) {
    const infoObj = info as Record<string, unknown>
    const infoTs = toStr(infoObj.time) ?? toStr(infoObj.timestamp)
    createdAt = infoTs ? Date.parse(infoTs) : NaN
  }
  if (Number.isNaN(createdAt)) createdAt = Date.now()

  const rowTimestamp = typeof row.timestamp === 'string' && row.timestamp.trim() !== '' ? row.timestamp.trim() : undefined
  const requestId =
    state.threadId && rowTimestamp
      ? `${state.threadId}:${rowTimestamp}:${inputTokens}-${cacheReadTokens}-${outputTokens}`
      : undefined

  return {
    appType: 'codex',
    model,
    rawModel: model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens: 0,
    inputSemantics: 1,
    status: 'success',
    createdAt,
    project: state.cwd,
    sessionId: state.sessionId,
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
  const state: CodexState = { sessionId: sessionIdFromFilename(filePath) }
  let nextLine = fromLine
  let eof = false

  const startIndex = fromLine > 0 ? fromLine - 1 : 0

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1
    const raw = lines[i]
    const inRange = i >= startIndex

    if (raw.trim() === '') {
      if (inRange) nextLine = lineNumber + 1
      continue
    }

    let obj: unknown
    try {
      obj = JSON.parse(raw)
    } catch {
      const onlyEmptyAfter = lines.slice(i + 1).every((l) => l === '')
      if (onlyEmptyAfter) {
        if (inRange) nextLine = lineNumber
        eof = true
        break
      }
      if (inRange) nextLine = lineNumber + 1
      continue
    }

    const row = obj as Record<string, unknown>
    updateState(row, state)
    if (!inRange) continue

    const record = toUsageRecord(row, state, filePath, lineNumber)
    if (record) records.push(record)
    nextLine = lineNumber + 1
  }

  if (!eof) eof = true

  return { records, nextLine, eof }
}

async function detect(): Promise<Detection> {
  return detectFromRoot(sessionRoot())
}

export const codexPlugin: MonitorPlugin = {
  id: 'codex',
  name: 'Codex',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles: async () => listFilesFromRoot(sessionRoot()),
  parseFile
}
