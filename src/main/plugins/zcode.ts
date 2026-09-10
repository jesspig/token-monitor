import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'


export function dataRootOf(): string {
  const dir = process.env.ZCODE_STORAGE_DIR
  if (dir && dir.trim() !== '') return dir.trim()
  return path.join(os.homedir(), '.zcode')
}

export function dbPathOf(root: string): string {
  return path.join(root, 'cli', 'db', 'db.sqlite')
}

export const EXTERNAL_DB_BUSY_TIMEOUT_MS = 250

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

export function listFilesFromRoot(root: string): FileEntry[] {
  const dbPath = dbPathOf(root)
  if (!fs.existsSync(dbPath)) return []
  return [{ path: dbPath, mtime: maxMtime([dbPath, dbPath + '-wal']) }]
}

export function detectFromRoot(root: string): Detection {
  let rootOk = false
  try {
    rootOk = fs.statSync(root).isDirectory()
  } catch {
    rootOk = false
  }
  if (!rootOk) {
    return {
      available: false,
      reason: '未找到数据根（默认 ~/.zcode，可用 $ZCODE_STORAGE_DIR 覆盖）',
      sessionDir: root
    }
  }
  if (fs.existsSync(dbPathOf(root))) {
    return { available: true, sessionDir: root }
  }
  return {
    available: false,
    reason: '数据根下未发现 cli/db/db.sqlite（ZCode 未安装或尚未产生会话）',
    sessionDir: root
  }
}

interface ModelUsageRow {
  rid: number
  id: string | null
  session_id: string | null
  model_id: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_creation_input_tokens: number | null
  cache_read_input_tokens: number | null
  started_at: number | null
  completed_at: number | null
  project_dir: string | null
  status?: string | null
  error_type?: string | null
  error_code?: string | number | null
  error_message?: string | null
}

const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const ERROR_MESSAGE_MAX_LENGTH = 500

function truncateMessage(text: string): string {
  return text.length > ERROR_MESSAGE_MAX_LENGTH ? text.slice(0, ERROR_MESSAGE_MAX_LENGTH) : text
}

function toUsageRecord(row: ModelUsageRow, opts: { filePath: string; line: number }): UsageRecord | null {
  const model = typeof row.model_id === 'string' ? row.model_id.trim() : ''
  if (!model) return null

  let createdAt = toNum(row.completed_at)
  if (createdAt <= 0) createdAt = toNum(row.started_at)
  if (createdAt <= 0) createdAt = Date.now()

  const statusRaw = (row as unknown as Record<string, unknown>).status
  const statusVal = typeof statusRaw === 'string' ? statusRaw.trim() : (statusRaw as unknown as string | null | undefined)
  const errorTypeRaw = (row as unknown as Record<string, unknown>).error_type
  const errorTypeVal =
    typeof errorTypeRaw === 'string' ? errorTypeRaw.trim() : (errorTypeRaw as unknown as string | null | undefined)
  const isError =
    statusVal !== 'completed' &&
    errorTypeVal != null &&
    errorTypeVal !== '' &&
    errorTypeVal !== 'cancelled'

  let status: 'success' | 'error' = 'success'
  let httpStatus: number | undefined
  let errorMessage: string | undefined
  if (isError) {
    status = 'error'
    const rawCode = (row as unknown as Record<string, unknown>).error_code
    if (typeof rawCode === 'number' && Number.isFinite(rawCode)) {
      httpStatus = rawCode
    } else if (typeof rawCode === 'string' && rawCode.trim() !== '') {
      const n = Number(rawCode.trim())
      if (Number.isFinite(n)) httpStatus = n
    } else if (rawCode != null && typeof rawCode !== 'string' && typeof rawCode !== 'number') {
      const n = Number(String(rawCode).trim())
      if (Number.isFinite(n)) httpStatus = n
    }
    const rawMsg = (row as unknown as Record<string, unknown>).error_message
    if (typeof rawMsg === 'string' && rawMsg.trim() !== '') {
      errorMessage = truncateMessage(rawMsg.trim())
    }
  }

  return {
    appType: 'zcode',
    model,
    rawModel: model,
    inputTokens: toNum(row.input_tokens),
    outputTokens: toNum(row.output_tokens),
    cacheReadTokens: toNum(row.cache_read_input_tokens),
    cacheCreationTokens: toNum(row.cache_creation_input_tokens),
    inputSemantics: 1,
    status,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    createdAt,
    project: row.project_dir ?? undefined,
    sessionId: row.session_id ?? undefined,
    source: {
      filePath: opts.filePath,
      line: opts.line,
      requestId: row.id && row.id.trim() !== '' ? row.id : undefined
    }
  }
}

export function parseDbFile(dbPath: string, fromLine: number): ParsedResult {
  const base = typeof fromLine === 'number' && Number.isFinite(fromLine) && fromLine > 0 ? fromLine : 0
  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true, timeout: EXTERNAL_DB_BUSY_TIMEOUT_MS })
    const rows = db
      .prepare(
        `SELECT m.rowid AS rid, m.*, s.directory AS project_dir
         FROM model_usage m
         LEFT JOIN session s ON s.id = m.session_id
         WHERE m.rowid > ?
         ORDER BY m.rowid ASC`
      )
      .all(base) as unknown as ModelUsageRow[]

    const records: UsageRecord[] = []
    let watermark = base
    for (const row of rows) {
      watermark = Math.max(watermark, row.rid)
      const record = toUsageRecord(row, { filePath: dbPath, line: row.rid })
      if (record) records.push(record)
    }
    return { records, nextLine: watermark, eof: true }
  } catch {
    return { records: [], nextLine: base, eof: true }
  } finally {
    if (db) db.close()
  }
}

async function detect(): Promise<Detection> {
  return detectFromRoot(dataRootOf())
}

async function listFiles(): Promise<FileEntry[]> {
  return listFilesFromRoot(dataRootOf())
}

async function parseFile(_ctx: PluginContext, filePath: string, fromLine: number): Promise<ParsedResult> {
  return parseDbFile(filePath, fromLine)
}

export const zcodePlugin: MonitorPlugin = {
  id: 'zcode',
  name: 'ZCode',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles,
  parseFile
}
