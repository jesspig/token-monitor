import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import type { AppType } from '../../../../shared/app'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../../shared/dto'

export const QODER_DB_BUSY_TIMEOUT_MS = 250

export interface QoderTokenInfo {
  promptTokens: number
  completionTokens: number
  cachedTokens: number
}

export interface QoderMessageRow {
  rid: number | null
  message_id?: string | null
  session_id?: string | null
  request_id?: string | null
  role?: string | null
  gmt_create?: number | null
  token_info?: string | null
  model_info?: string | null
  record_extra?: string | null
}

const TABLE_PROBE_SQL =
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('chat_message', 'chat_record')"

const ROW_SELECT_JOIN = `
  SELECT
    cm.rowid AS rid,
    cm.id AS message_id,
    cm.session_id AS session_id,
    cm.request_id AS request_id,
    cm.role AS role,
    cm.gmt_create AS gmt_create,
    cm.token_info AS token_info,
    cm.model_info AS model_info,
    cr.extra AS record_extra
  FROM chat_message cm
  LEFT JOIN chat_record cr ON cr.request_id = cm.request_id
  WHERE cm.rowid > ?
  ORDER BY cm.rowid ASC`

const ROW_SELECT_PLAIN = `
  SELECT
    cm.rowid AS rid,
    cm.id AS message_id,
    cm.session_id AS session_id,
    cm.request_id AS request_id,
    cm.role AS role,
    cm.gmt_create AS gmt_create,
    cm.token_info AS token_info,
    cm.model_info AS model_info
  FROM chat_message cm
  WHERE cm.rowid > ?
  ORDER BY cm.rowid ASC`

export function statMtimeMs(p: string): number {
  try {
    return Math.round(fs.statSync(p).mtimeMs)
  } catch {
    return 0
  }
}

export function maxMtime(paths: string[]): number {
  return paths.reduce((m, p) => Math.max(m, statMtimeMs(p)), 0)
}

export function listFilesFromDbPaths(paths: string[]): FileEntry[] {
  const entries: FileEntry[] = []
  for (const dbPath of paths) {
    if (!fs.existsSync(dbPath)) continue
    entries.push({ path: dbPath, mtime: maxMtime([dbPath, dbPath + '-wal']) })
  }
  return entries
}

export function detectFromDbPaths(paths: string[], missingReason: string): Detection {
  const found = paths.find((p) => fs.existsSync(p))
  if (found) {
    return { available: true, sessionDir: path.dirname(found) }
  }
  const fallbackDir = paths.length > 0 ? path.dirname(paths[0]) : undefined
  return {
    available: false,
    reason: missingReason,
    ...(fallbackDir !== undefined ? { sessionDir: fallbackDir } : {})
  }
}

export function parseTokenInfo(raw: unknown): QoderTokenInfo | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const pt = typeof obj.prompt_tokens === 'number' ? obj.prompt_tokens : 0
    const ct = typeof obj.completion_tokens === 'number' ? obj.completion_tokens : 0
    const cached = typeof obj.cached_tokens === 'number' ? obj.cached_tokens : 0
    if (pt === 0 && ct === 0) return null
    return { promptTokens: pt, completionTokens: ct, cachedTokens: cached }
  } catch {
    return null
  }
}

export function parseModelKey(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    return typeof obj.model_key === 'string' && obj.model_key.length > 0 ? obj.model_key : undefined
  } catch {
    return undefined
  }
}

export function parseRecordModelKey(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const config = obj.modelConfig
    if (config === null || typeof config !== 'object') return undefined
    const key = (config as Record<string, unknown>).key
    return typeof key === 'string' && key.length > 0 ? key : undefined
  } catch {
    return undefined
  }
}

export function toQoderUsageRecord(
  appType: AppType,
  row: QoderMessageRow,
  opts: { filePath: string; line: number }
): UsageRecord | null {
  if ((row.role ?? '').trim() !== 'assistant') return null
  const info = parseTokenInfo(row.token_info)
  if (!info) return null
  const model = parseModelKey(row.model_info) ?? parseRecordModelKey(row.record_extra)
  if (!model) return null

  let createdAt = typeof row.gmt_create === 'number' && Number.isFinite(row.gmt_create) ? row.gmt_create : 0
  if (createdAt <= 0) createdAt = Date.now()

  const sessionId = typeof row.session_id === 'string' && row.session_id.trim() !== '' ? row.session_id : undefined
  const requestId = typeof row.request_id === 'string' && row.request_id.trim() !== '' ? row.request_id : undefined

  return {
    appType,
    model,
    rawModel: model,
    inputTokens: info.promptTokens,
    outputTokens: info.completionTokens,
    cacheReadTokens: info.cachedTokens,
    cacheCreationTokens: 0,
    inputSemantics: 0,
    status: 'success',
    createdAt,
    sessionId,
    source: {
      filePath: opts.filePath,
      line: opts.line,
      requestId
    }
  }
}

export function parseQoderDbFile(appType: AppType, dbPath: string, fromLine: number): ParsedResult {
  const base = typeof fromLine === 'number' && Number.isFinite(fromLine) && fromLine > 0 ? fromLine : 0
  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true, timeout: QODER_DB_BUSY_TIMEOUT_MS })
    const tables = new Set((db.prepare(TABLE_PROBE_SQL).all() as Array<{ name: string }>).map((r) => r.name))
    if (!tables.has('chat_message')) {
      return { records: [], nextLine: base, eof: true }
    }
    const rows = (
      tables.has('chat_record') ? db.prepare(ROW_SELECT_JOIN).all(base) : db.prepare(ROW_SELECT_PLAIN).all(base)
    ) as unknown as QoderMessageRow[]

    const records: UsageRecord[] = []
    let watermark = base
    for (const row of rows) {
      const rid = typeof row.rid === 'number' && Number.isFinite(row.rid) ? row.rid : 0
      watermark = Math.max(watermark, rid)
      const record = toQoderUsageRecord(appType, row, { filePath: dbPath, line: rid })
      if (record) records.push(record)
    }
    return { records, nextLine: watermark, eof: true }
  } catch {
    return { records: [], nextLine: base, eof: true }
  } finally {
    if (db) db.close()
  }
}
