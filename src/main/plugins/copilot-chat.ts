import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'

const CHAT_EXTENSION = '.jsonl'

function userDataRoot(): string {
  const override = process.env.COPILOT_CHAT_DIR
  if (override && override.trim() !== '') return override.trim()
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (appData) return path.join(appData, 'Code', 'User')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User')
  }
  return path.join(os.homedir(), '.config', 'Code', 'User')
}

function globalSessionsDir(root = userDataRoot()): string {
  return path.join(root, 'globalStorage', 'emptyWindowChatSessions')
}

function workspaceStorageRoot(root = userDataRoot()): string {
  return path.join(root, 'workspaceStorage')
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function toEntry(p: string): FileEntry | null {
  try {
    const mtime = Math.round(fs.statSync(p).mtimeMs)
    if (!Number.isFinite(mtime) || mtime <= 0) return null
    return { path: p, mtime }
  } catch {
    return null
  }
}

function isSessionFile(name: string): boolean {
  if (!name.endsWith(CHAT_EXTENSION)) return false
  if (name.startsWith('.')) return false
  return !/(?:\.tmp|\.swp|~)$/i.test(name)
}

export function listFilesFromRoots(globalDir: string, wsRoot: string): FileEntry[] {
  const out: FileEntry[] = []
  for (const ent of safeReaddir(globalDir)) {
    if (!ent.isFile() || !isSessionFile(ent.name)) continue
    const entry = toEntry(path.join(globalDir, ent.name))
    if (entry) out.push(entry)
  }
  for (const ws of safeReaddir(wsRoot)) {
    if (!ws.isDirectory()) continue
    const chatDir = path.join(wsRoot, ws.name, 'chatSessions')
    for (const ent of safeReaddir(chatDir)) {
      if (!ent.isFile() || !isSessionFile(ent.name)) continue
      const entry = toEntry(path.join(chatDir, ent.name))
      if (entry) out.push(entry)
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

function hasAnySessionFile(globalDir: string, wsRoot: string): boolean {
  for (const ent of safeReaddir(globalDir)) {
    if (ent.isFile() && isSessionFile(ent.name)) return true
  }
  for (const ws of safeReaddir(wsRoot)) {
    if (!ws.isDirectory()) continue
    const chatDir = path.join(wsRoot, ws.name, 'chatSessions')
    for (const ent of safeReaddir(chatDir)) {
      if (ent.isFile() && isSessionFile(ent.name)) return true
    }
  }
  return false
}

export function detectFromRoots(globalDir: string, wsRoot: string): Detection {
  if (hasAnySessionFile(globalDir, wsRoot)) {
    return { available: true, sessionDir: globalDir }
  }
  return {
    available: false,
    reason:
      '未找到 VS Code Copilot Chat 会话数据（globalStorage/emptyWindowChatSessions 与 workspaceStorage/*/chatSessions 均无会话文件）',
    sessionDir: globalDir
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  return v as Record<string, unknown>
}

function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null
}

function toFinite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function toTrimmedString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const trimmed = v.trim()
  return trimmed === '' ? undefined : trimmed
}

interface RequestEntry {
  requestId?: string
  modelId?: string
  timestamp?: number
  responseTimestamp?: number
  elapsedMs?: number
  promptTokens?: number
  completionTokens?: number
  appendLine: number
  usageLine?: number
}

function toRequestEntry(v: unknown, appendLine: number): RequestEntry {
  const rec = asRecord(v)
  if (!rec) return { appendLine }
  return {
    requestId: toTrimmedString(rec.requestId),
    modelId: toTrimmedString(rec.modelId),
    timestamp: toFinite(rec.timestamp),
    responseTimestamp: toFinite(rec.responseTimestamp),
    elapsedMs: toFinite(rec.elapsedMs),
    promptTokens: toFinite(rec.promptTokens),
    completionTokens: toFinite(rec.completionTokens),
    appendLine
  }
}

const DEEP_USAGE_FIELDS = new Set(['promptTokens', 'completionTokens'])

function applyDeepUsagePatch(
  row: Record<string, unknown>,
  entries: RequestEntry[],
  lineNumber: number
): boolean {
  if (row.kind !== 1) return false
  const k = asArray(row.k)
  if (!k || k.length < 3) return false
  if (k[0] !== 'requests') return false
  if (!DEEP_USAGE_FIELDS.has(k[2] as string)) return false
  const value = toFinite(row.v)
  if (value === undefined) return false
  const idx = Number(k[1])
  if (!Number.isInteger(idx) || idx < 0 || idx >= entries.length) return false
  const entry = entries[idx]
  if (k[2] === 'promptTokens') entry.promptTokens = value
  else entry.completionTokens = value
  entry.usageLine = lineNumber
  return true
}

function toUsageRecord(
  entry: RequestEntry,
  filePath: string,
  fallbackSessionId: string | undefined
): UsageRecord | null {
  const inputTokens = entry.promptTokens
  const outputTokens = entry.completionTokens
  if (inputTokens === undefined && outputTokens === undefined) return null

  const model = entry.modelId ?? 'unknown'
  const createdAt = entry.responseTimestamp ?? entry.timestamp ?? Date.now()
  const sessionId = fallbackSessionId
  const line = entry.usageLine ?? entry.appendLine

  return {
    appType: 'copilot-chat',
    model,
    rawModel: model,
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    inputSemantics: 2,
    status: 'success',
    ...(entry.elapsedMs !== undefined ? { latencyMs: entry.elapsedMs } : {}),
    createdAt,
    ...(sessionId !== undefined ? { sessionId } : {}),
    source: {
      filePath,
      line,
      ...(entry.requestId !== undefined ? { requestId: entry.requestId } : {})
    }
  }
}

export function parseChatJsonl(filePath: string, raw: string): ParsedResult {
  const lines = raw.split('\n')
  const entries: RequestEntry[] = []
  let sessionId: string | undefined

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1
    const text = lines[i]
    if (text.trim() === '') continue

    let row: Record<string, unknown> | null
    try {
      row = asRecord(JSON.parse(text))
    } catch {
      continue
    }
    if (!row) continue

    if (row.kind === 0) {
      const v = asRecord(row.v)
      if (!v) continue
      const sid = toTrimmedString(v.sessionId)
      if (sid !== undefined) sessionId = sid
      const initial = asArray(v.requests)
      if (initial) {
        for (const req of initial) entries.push(toRequestEntry(req, lineNumber))
      }
      continue
    }

    if (row.kind === 2) {
      const k = asArray(row.k)
      if (!k || k.length !== 1 || k[0] !== 'requests') continue
      const appended = asArray(row.v)
      if (!appended) continue
      for (const req of appended) entries.push(toRequestEntry(req, lineNumber))
      continue
    }

    applyDeepUsagePatch(row, entries, lineNumber)
  }

  const baseName = path.basename(filePath)
  const fallbackSessionId = sessionId ?? (baseName.endsWith(CHAT_EXTENSION) ? baseName.slice(0, -CHAT_EXTENSION.length) : baseName)
  const records: UsageRecord[] = []
  for (const entry of entries) {
    const record = toUsageRecord(entry, filePath, fallbackSessionId)
    if (record) records.push(record)
  }
  return { records, nextLine: lines.length + 1, eof: true }
}

async function parseFile(
  _ctx: PluginContext,
  filePath: string,
  fromLine: number
): Promise<ParsedResult> {
  let raw: string
  try {
    raw = await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return { records: [], nextLine: fromLine, eof: true }
  }
  return parseChatJsonl(filePath, raw)
}

export const copilotChatPlugin: MonitorPlugin = {
  id: 'copilot-chat',
  name: 'VS Code Copilot Chat',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect: async () => detectFromRoots(globalSessionsDir(), workspaceStorageRoot()),
  listFiles: async () => listFilesFromRoots(globalSessionsDir(), workspaceStorageRoot()),
  parseFile
}
