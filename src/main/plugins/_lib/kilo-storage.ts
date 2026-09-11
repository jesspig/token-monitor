import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import type { FileEntry, ParsedResult, UsageRecord } from '../../../../shared/dto'

export const KILO_DATABASE_FILE = 'kilo.db'
export const KILO_DATABASE_BUSY_TIMEOUT_MS = 250

const REQUIRED_MESSAGE_COLUMNS = ['id', 'session_id', 'time_created', 'data'] as const
const REQUIRED_SESSION_COLUMNS = ['id', 'directory'] as const

interface DatabaseInspection {
  exists: boolean
  compatible: boolean
  reason?: string
}

interface MessageRow {
  rid: number
  id: string
  session_id: string
  time_created: number
  data: string
  directory: string | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function requiredNumber(record: Record<string, unknown>, key: string, context: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new KiloSchemaError(`${context}.${key} 必须是非负有限数字`)
  }
  return value
}

function requiredString(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new KiloSchemaError(`${context}.${key} 必须是非空字符串`)
  }
  return value.trim()
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  const rows = db.pragma(`table_info('${table}')`) as Array<{ name?: unknown }>
  return new Set(rows.flatMap((row) => (typeof row.name === 'string' ? [row.name] : [])))
}

function missingColumns(actual: Set<string>, required: readonly string[]): string[] {
  return required.filter((column) => !actual.has(column))
}

function openReadOnly(dbPath: string): Database.Database {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  db.pragma(`busy_timeout = ${KILO_DATABASE_BUSY_TIMEOUT_MS}`)
  return db
}

function schemaProblem(db: Database.Database): string | undefined {
  const messageMissing = missingColumns(tableColumns(db, 'message'), REQUIRED_MESSAGE_COLUMNS)
  if (messageMissing.length > 0) return `message 表缺少列：${messageMissing.join(', ')}`
  const sessionMissing = missingColumns(tableColumns(db, 'session'), REQUIRED_SESSION_COLUMNS)
  if (sessionMissing.length > 0) return `session 表缺少列：${sessionMissing.join(', ')}`
  return undefined
}

export class KiloSchemaError extends Error {
  constructor(message: string) {
    super(`Kilo Code 当前存储 schema 不兼容：${message}`)
    this.name = 'KiloSchemaError'
  }
}

export function currentDataRoot(): string {
  const override = process.env.KILO_DATA_HOME
  if (override && override.trim() !== '') return path.resolve(override.trim())
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) return path.join(localAppData, 'kilo', 'Data')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'kilo')
  }
  const xdgDataHome = process.env.XDG_DATA_HOME
  if (xdgDataHome && xdgDataHome.trim() !== '') return path.join(xdgDataHome.trim(), 'kilo')
  return path.join(os.homedir(), '.local', 'share', 'kilo')
}

export function currentDatabasePath(root = currentDataRoot()): string {
  return path.join(root, KILO_DATABASE_FILE)
}

export function databaseMtime(dbPath: string): number {
  let mtime = 0
  for (const candidate of [dbPath, `${dbPath}-wal`]) {
    try {
      mtime = Math.max(mtime, Math.round(fs.statSync(candidate).mtimeMs))
    } catch {
      continue
    }
  }
  return mtime
}

export function inspectKiloDatabase(dbPath: string): DatabaseInspection {
  if (!fs.existsSync(dbPath)) return { exists: false, compatible: false }
  let db: Database.Database | undefined
  try {
    db = openReadOnly(dbPath)
    const problem = schemaProblem(db)
    return problem
      ? { exists: true, compatible: false, reason: `Kilo Code 当前存储 schema 不兼容：${problem}` }
      : { exists: true, compatible: true }
  } catch {
    return {
      exists: true,
      compatible: false,
      reason: 'Kilo Code 当前存储无法只读打开：数据库损坏、被占用或不是受支持的 SQLite 文件'
    }
  } finally {
    db?.close()
  }
}

export function currentDatabaseEntry(dbPath = currentDatabasePath()): FileEntry | null {
  if (!fs.existsSync(dbPath)) return null
  return { path: dbPath, mtime: databaseMtime(dbPath) }
}

function rowToUsageRecord(row: MessageRow, dbPath: string): UsageRecord | null {
  let data: unknown
  try {
    data = JSON.parse(row.data)
  } catch {
    throw new KiloSchemaError(`message.id=${row.id} 的 data 不是合法 JSON`)
  }
  const message = asRecord(data)
  if (!message) throw new KiloSchemaError(`message.id=${row.id} 的 data 不是对象`)
  if (message.role !== 'assistant') return null

  const model = requiredString(message, 'modelID', `message.id=${row.id}`)
  const tokens = asRecord(message.tokens)
  if (!tokens) throw new KiloSchemaError(`message.id=${row.id}.tokens 不是对象`)
  const cache = asRecord(tokens.cache)
  if (!cache) throw new KiloSchemaError(`message.id=${row.id}.tokens.cache 不是对象`)
  const time = asRecord(message.time)
  const completedAt = time?.completed
  const createdAt = time?.created
  const timestamp =
    typeof completedAt === 'number' && Number.isFinite(completedAt) && completedAt > 0
      ? completedAt
      : typeof createdAt === 'number' && Number.isFinite(createdAt) && createdAt > 0
        ? createdAt
        : row.time_created

  return {
    appType: 'kilo-code',
    model,
    rawModel: model,
    inputTokens: requiredNumber(tokens, 'input', `message.id=${row.id}.tokens`),
    outputTokens: requiredNumber(tokens, 'output', `message.id=${row.id}.tokens`),
    cacheReadTokens: requiredNumber(cache, 'read', `message.id=${row.id}.tokens.cache`),
    cacheCreationTokens: requiredNumber(cache, 'write', `message.id=${row.id}.tokens.cache`),
    inputSemantics: 0,
    status: 'success',
    createdAt: timestamp,
    project: row.directory ?? undefined,
    sessionId: row.session_id,
    source: {
      filePath: dbPath,
      line: row.rid,
      requestId: row.id
    }
  }
}

export function parseCurrentDatabase(dbPath: string, fromLine: number): ParsedResult {
  const base = Number.isFinite(fromLine) && fromLine > 0 ? Math.floor(fromLine) : 0
  let db: Database.Database | undefined
  try {
    db = openReadOnly(dbPath)
    const problem = schemaProblem(db)
    if (problem) throw new KiloSchemaError(problem)
    const rows = db
      .prepare(
        `SELECT m.rowid AS rid, m.id, m.session_id, m.time_created, m.data, s.directory
         FROM message m
         LEFT JOIN session s ON s.id = m.session_id
         WHERE m.rowid > ?
         ORDER BY m.rowid ASC`
      )
      .all(base) as MessageRow[]
    const records: UsageRecord[] = []
    let nextLine = base
    for (const row of rows) {
      if (!Number.isSafeInteger(row.rid) || row.rid <= 0) {
        throw new KiloSchemaError('message.rowid 必须是正安全整数')
      }
      nextLine = row.rid
      const record = rowToUsageRecord(row, dbPath)
      if (record) records.push(record)
    }
    return { records, nextLine, eof: true }
  } finally {
    db?.close()
  }
}
