import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'

const LEGACY_DB_FILE = 'sqlite.db'
const LEGACY_TABLE = 'token_usage'
const RUNTIME_DB_BASE = 'runtime-state.sqlite'
const RUNTIME_TABLE = 'local_runtime_token_usage'
const DEFAULT_ROOT_DIR = '.minimax'
const BUSY_TIMEOUT_MS = 250

export const MINIMAX_REQUIRED_COLUMNS = [
  'id',
  'session_id',
  'turn_id',
  'model',
  'ts',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens'
] as const

export interface MiniMaxDbCandidate {
  kind: 'legacy' | 'runtime'
  filePath: string
  table: string
}

export function dataRootOf(): string {
  const direct = process.env.MINIMAX_DIR
  if (direct && direct.trim() !== '') return direct.trim()
  const dataDir = process.env.MINIMAX_DATA_DIR
  if (dataDir && dataDir.trim() !== '') return dataDir.trim()
  const mavis = process.env.MAVIS_DATA_DIR
  if (mavis && mavis.trim() !== '') return mavis.trim()
  return path.join(os.homedir(), DEFAULT_ROOT_DIR)
}

export function dbCandidatesOf(root: string): MiniMaxDbCandidate[] {
  return [
    { kind: 'legacy', filePath: path.join(root, LEGACY_DB_FILE), table: LEGACY_TABLE },
    {
      kind: 'runtime',
      filePath: path.join(root, 'v2', 'sqlite', RUNTIME_DB_BASE),
      table: RUNTIME_TABLE
    }
  ]
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

export function listFilesAtRoot(root: string): FileEntry[] {
  if (!fs.existsSync(root)) return []
  const entries: FileEntry[] = []
  for (const candidate of dbCandidatesOf(root)) {
    if (!fs.existsSync(candidate.filePath)) continue
    entries.push({ path: candidate.filePath, mtime: maxMtime([candidate.filePath, candidate.filePath + '-wal']) })
  }
  return entries
}

export function readTableColumns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map((r) => r.name))
}

export function hasRequiredColumns(columns: Set<string>): boolean {
  return MINIMAX_REQUIRED_COLUMNS.every((c) => columns.has(c))
}

export function detectAtRoot(root: string): Detection {
  if (!fs.existsSync(root)) {
    return {
      available: false,
      reason:
        '未找到 MiniMax Code 数据目录（默认 ~/.minimax，可用 $MINIMAX_DIR / $MINIMAX_DATA_DIR / $MAVIS_DATA_DIR 覆盖）',
      sessionDir: root
    }
  }
  const existing = dbCandidatesOf(root).filter((c) => fs.existsSync(c.filePath))
  if (existing.length === 0) {
    return {
      available: false,
      reason: 'MiniMax Code 数据目录存在但未发现用量数据库（sqlite.db 或 v2/sqlite/runtime-state.sqlite，尚未产生用量）',
      sessionDir: root
    }
  }
  return { available: true, sessionDir: root }
}

interface UsageRow {
  id: number | null
  session_id: string | null
  turn_id: string | null
  model: string | null
  ts: number | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_write_tokens: number | null
}

const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const toTrimmedString = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  const trimmed = v.trim()
  return trimmed !== '' ? trimmed : undefined
}

function requestIdOf(
  sessionId: string | undefined,
  turnId: string | undefined,
  rowId: number | null
): string | undefined {
  if (!sessionId || !turnId || rowId === null || !Number.isSafeInteger(rowId) || rowId <= 0) return undefined
  return `minimax:${JSON.stringify([sessionId, turnId, rowId])}`
}

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

export function toUsageRecord(row: UsageRow, opts: { filePath: string; line: number }): UsageRecord {
  const trimmedModel = typeof row.model === 'string' ? row.model.trim() : ''
  const model = trimmedModel !== '' ? trimmedModel : 'unknown'
  const sessionId = toTrimmedString(row.session_id)
  const turnId = toTrimmedString(row.turn_id)
  const requestId = requestIdOf(sessionId, turnId, row.id)
  return {
    appType: 'minimax',
    model,
    rawModel: model,
    inputTokens: toNum(row.input_tokens),
    outputTokens: toNum(row.output_tokens),
    cacheReadTokens: toNum(row.cache_read_tokens),
    cacheCreationTokens: toNum(row.cache_write_tokens),
    inputSemantics: 2,
    status: 'success',
    createdAt: parseTsMs(row.ts),
    sessionId,
    source: { filePath: opts.filePath, line: opts.line, ...(requestId ? { requestId } : {}) }
  }
}

function tableOf(dbPath: string): string {
  return path.basename(dbPath) === RUNTIME_DB_BASE ? RUNTIME_TABLE : LEGACY_TABLE
}

function buildSelect(table: string): string {
  return `
  SELECT
    id,
    session_id,
    turn_id,
    model,
    ts,
    input_tokens,
    output_tokens,
    cache_read_tokens,
    cache_write_tokens
  FROM ${table}
  WHERE id > ?
  ORDER BY id ASC`
}

export function parseDbFile(dbPath: string, fromLine: number): ParsedResult {
  const base = typeof fromLine === 'number' && Number.isFinite(fromLine) && fromLine > 0 ? fromLine : 0
  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true, timeout: BUSY_TIMEOUT_MS })
    const table = tableOf(dbPath)
    if (!hasRequiredColumns(readTableColumns(db, table))) {
      return { records: [], nextLine: base, eof: true }
    }
    const rows = db.prepare(buildSelect(table)).all(base) as unknown as UsageRow[]
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
  return detectAtRoot(dataRootOf())
}

async function listFiles(): Promise<FileEntry[]> {
  return listFilesAtRoot(dataRootOf())
}

async function parseFile(_ctx: PluginContext, filePath: string, fromLine: number): Promise<ParsedResult> {
  return parseDbFile(filePath, fromLine)
}

export const minimaxPlugin: MonitorPlugin = {
  id: 'minimax',
  name: 'MiniMax Code',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles,
  parseFile
}
