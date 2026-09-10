import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'

const DB_FILE_NAME = 'sessions.db'
const BUSY_TIMEOUT_MS = 250

export const GOOSE_REQUIRED_COLUMNS = [
  'id',
  'session_id',
  'created_timestamp',
  'model',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens'
] as const

export function sessionsDirOf(): string {
  const dir = process.env.GOOSE_DIR
  if (dir && dir.trim() !== '') return dir.trim()
  const pathRoot = process.env.GOOSE_PATH_ROOT
  if (pathRoot && pathRoot.trim() !== '') return path.join(pathRoot.trim(), 'data', 'sessions')
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (appData && appData.trim() !== '') return path.join(appData.trim(), 'Block', 'goose', 'data', 'sessions')
    return path.join(os.homedir(), 'AppData', 'Roaming', 'Block', 'goose', 'data', 'sessions')
  }
  return path.join(os.homedir(), '.local', 'share', 'goose', 'sessions')
}

export function dbPathOf(sessionsDir: string): string {
  return path.join(sessionsDir, DB_FILE_NAME)
}

function statMtimeMs(p: string): number {
  try {
    return Math.round(fs.statSync(p).mtimeMs)
  } catch {
    return 0
  }
}

function maxMtime(paths: string[]): number {
  return paths.reduce((m, p) => Math.max(m, statMtimeMs(p)), 0)
}

export function listFilesFromDir(sessionsDir: string): FileEntry[] {
  const dbPath = dbPathOf(sessionsDir)
  if (!fs.existsSync(dbPath)) return []
  return [{ path: dbPath, mtime: maxMtime([dbPath, dbPath + '-wal']) }]
}

export function readLedgerColumns(db: Database.Database): Set<string> {
  const rows = db.prepare('PRAGMA table_info(usage_ledger)').all() as Array<{ name: string }>
  return new Set(rows.map((r) => r.name))
}

export function hasRequiredColumns(columns: Set<string>): boolean {
  return GOOSE_REQUIRED_COLUMNS.every((c) => columns.has(c))
}

export function detectFromDir(sessionsDir: string): Detection {
  const dbPath = dbPathOf(sessionsDir)
  if (!fs.existsSync(dbPath)) {
    let dirExists = false
    try {
      dirExists = fs.statSync(sessionsDir).isDirectory()
    } catch {
      dirExists = false
    }
    if (dirExists) {
      return {
        available: false,
        reason: 'sessions 目录存在但未发现 sessions.db（Goose 尚未产生会话记录）',
        sessionDir: sessionsDir
      }
    }
    return {
      available: false,
      reason:
        '未找到 Goose sessions 目录（默认 %APPDATA%\\Block\\goose\\data\\sessions 或 ~/.local/share/goose/sessions，可用 $GOOSE_DIR / $GOOSE_PATH_ROOT 覆盖）',
      sessionDir: sessionsDir
    }
  }
  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true, timeout: BUSY_TIMEOUT_MS })
    readLedgerColumns(db)
    return { available: true, sessionDir: sessionsDir }
  } catch {
    return {
      available: false,
      reason: 'sessions.db 存在但无法读取（文件损坏或被其他进程锁定）',
      sessionDir: sessionsDir
    }
  } finally {
    if (db) db.close()
  }
}

interface LedgerRow {
  id: number | null
  session_id: string | null
  created_timestamp: number | null
  model: string | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
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

export function toUsageRecord(row: LedgerRow, opts: { filePath: string; line: number }): UsageRecord {
  const trimmedModel = typeof row.model === 'string' ? row.model.trim() : ''
  const model = trimmedModel !== '' ? trimmedModel : 'unknown'
  const sessionId = typeof row.session_id === 'string' && row.session_id.trim() !== '' ? row.session_id : undefined
  return {
    appType: 'goose',
    model,
    rawModel: model,
    inputTokens: toNum(row.input_tokens),
    outputTokens: toNum(row.output_tokens),
    cacheReadTokens: toNum(row.cache_read_tokens),
    cacheCreationTokens: toNum(row.cache_write_tokens),
    inputSemantics: 1,
    status: 'success',
    createdAt: parseTsMs(row.created_timestamp),
    sessionId,
    source: { filePath: opts.filePath, line: opts.line }
  }
}

const LEDGER_SELECT = `
  SELECT
    id,
    session_id,
    created_timestamp,
    model,
    input_tokens,
    output_tokens,
    cache_read_tokens,
    cache_write_tokens
  FROM usage_ledger
  WHERE id > ?
  ORDER BY id ASC`

export function parseDbFile(dbPath: string, fromLine: number): ParsedResult {
  const base = typeof fromLine === 'number' && Number.isFinite(fromLine) && fromLine > 0 ? fromLine : 0
  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true, timeout: BUSY_TIMEOUT_MS })
    if (!hasRequiredColumns(readLedgerColumns(db))) {
      return { records: [], nextLine: base, eof: true }
    }
    const rows = db.prepare(LEDGER_SELECT).all(base) as unknown as LedgerRow[]
    const records: UsageRecord[] = []
    let watermark = base
    for (const row of rows) {
      const rid = toNum(row.id)
      watermark = Math.max(watermark, rid)
      records.push(toUsageRecord(row, { filePath: dbPath, line: rid }))
    }
    return { records, nextLine: watermark, eof: true }
  } catch {
    return { records: [], nextLine: base, eof: true }
  } finally {
    if (db) db.close()
  }
}

async function detect(): Promise<Detection> {
  return detectFromDir(sessionsDirOf())
}

async function listFiles(): Promise<FileEntry[]> {
  return listFilesFromDir(sessionsDirOf())
}

async function parseFile(_ctx: PluginContext, filePath: string, fromLine: number): Promise<ParsedResult> {
  return parseDbFile(filePath, fromLine)
}

export const goosePlugin: MonitorPlugin = {
  id: 'goose',
  name: 'Goose',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles,
  parseFile
}
