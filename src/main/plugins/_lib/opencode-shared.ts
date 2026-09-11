import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { AppType } from '../../../../shared/app'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../../shared/dto'
import { ERROR_MESSAGE_MAX_LENGTH, isIgnoredFailureReason } from '../../../../shared/failure'

export const OPENCODE_LIKE_DB_BUSY_TIMEOUT_MS = 250

export const OPENCODE_LIKE_MESSAGE_SELECT_SQL = `
  SELECT m.rowid AS token_monitor_rowid, m.*, s.directory AS project_dir
  FROM message m
  LEFT JOIN session s ON s.id = m.session_id
  WHERE m.rowid > ?
  ORDER BY m.rowid ASC`

const OPENCODE_LIKE_CURSOR_MARKER = 2 ** 52
const OPENCODE_LIKE_CURSOR_ROWID_BASE = 2 ** 32
const OPENCODE_LIKE_CURSOR_FINGERPRINT_MOD = 2 ** 20
const OPENCODE_LIKE_CURSOR_MAX_ROWID = OPENCODE_LIKE_CURSOR_ROWID_BASE - 1
const OPENCODE_LIKE_CURSOR_ANCHOR_LIMIT = 1

interface OpencodeLikeCursor {
  fingerprint: number
  rowid: number
}

function hashCursorIdentity(value: string): number {
  let hash = 2_166_136_261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0) % OPENCODE_LIKE_CURSOR_FINGERPRINT_MOD
}

function encodeDbCursor(cursor: OpencodeLikeCursor): number {
  if (!Number.isSafeInteger(cursor.rowid) || cursor.rowid < 0 || cursor.rowid > OPENCODE_LIKE_CURSOR_MAX_ROWID) {
    throw new Error(`OpenCode-like 数据库 rowid 超出支持范围：${cursor.rowid}`)
  }
  return OPENCODE_LIKE_CURSOR_MARKER + cursor.fingerprint * OPENCODE_LIKE_CURSOR_ROWID_BASE + cursor.rowid
}

function decodeDbCursor(value: number): OpencodeLikeCursor | null {
  if (!Number.isSafeInteger(value) || value < OPENCODE_LIKE_CURSOR_MARKER) return null
  const payload = value - OPENCODE_LIKE_CURSOR_MARKER
  const fingerprint = Math.floor(payload / OPENCODE_LIKE_CURSOR_ROWID_BASE)
  const rowid = payload % OPENCODE_LIKE_CURSOR_ROWID_BASE
  if (fingerprint < 0 || fingerprint >= OPENCODE_LIKE_CURSOR_FINGERPRINT_MOD) return null
  if (!Number.isSafeInteger(rowid) || rowid < 0 || rowid > OPENCODE_LIKE_CURSOR_MAX_ROWID) return null
  return { fingerprint, rowid }
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>
  return new Set(rows.map((row) => row.name).filter((name): name is string => typeof name === 'string'))
}

function assertRequiredColumns(db: Database.Database, table: string, required: string[]): void {
  const columns = tableColumns(db, table)
  if (columns.size === 0) throw new Error(`OpenCode-like 数据库缺少 ${table} 表`)
  const missing = required.filter((column) => !columns.has(column))
  if (missing.length > 0) {
    throw new Error(`OpenCode-like 数据库 ${table} 表缺少必要列：${missing.join(', ')}`)
  }
}

function readDbFingerprint(db: Database.Database): number {
  const schemaVersion = db.pragma('schema_version', { simple: true })
  const schemaRows = db
    .prepare(`SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name IN ('message', 'session') ORDER BY name`)
    .all() as Array<{ name: unknown; sql: unknown }>
  const anchors = db
    .prepare(`SELECT rowid, id, time_created FROM message ORDER BY rowid ASC LIMIT ?`)
    .all(OPENCODE_LIKE_CURSOR_ANCHOR_LIMIT) as Array<Record<string, unknown>>
  return hashCursorIdentity(JSON.stringify({ schemaVersion, schemaRows, anchors }))
}

function readMaxRowid(db: Database.Database): number {
  const row = db.prepare('SELECT MAX(rowid) AS max_rowid FROM message').get() as { max_rowid?: unknown } | undefined
  if (row?.max_rowid === null || row?.max_rowid === undefined) return 0
  const value = row.max_rowid
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > OPENCODE_LIKE_CURSOR_MAX_ROWID) {
    throw new Error(`OpenCode-like 数据库 rowid 超出支持范围：${String(value)}`)
  }
  return value as number
}

function resolveDbRowidCursor(fromLine: number, fingerprint: number, maxRowid: number): number {
  const decoded = decodeDbCursor(fromLine)
  if (!decoded) return 0
  if (decoded.fingerprint !== fingerprint) return 0
  if (decoded.rowid > maxRowid) return 0
  return decoded.rowid
}

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

export const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function toTs(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const p = Date.parse(v)
    if (!Number.isNaN(p)) return p
  }
  return NaN
}

function truncateMessage(text: string): string {
  return text.length > ERROR_MESSAGE_MAX_LENGTH ? text.slice(0, ERROR_MESSAGE_MAX_LENGTH) : text
}

function extractHttpStatusFrom(candidates: unknown[]): number | undefined {
  for (const raw of candidates) {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
    if (typeof raw === 'string' && raw.trim() !== '') {
      const n = Number(raw.trim())
      if (Number.isFinite(n)) return n
    }
  }
  return undefined
}

function extractHttpStatus(data: Record<string, unknown>, dbExtra?: Record<string, unknown>): number | undefined {
  const pools: unknown[] = []
  pools.push(
    data.httpStatus,
    data.http_status,
    (data as Record<string, unknown>).httpStatusCode,
    (data as Record<string, unknown>).http_status_code,
    data.statusCode,
    data.status_code,
    (data as Record<string, unknown>).code
  )
  const err = data.error
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>
    pools.push(o.httpStatus, o.http_status, o.statusCode, o.status_code, o.code, o.status)
  }
  const errAlt = (data as Record<string, unknown>).errorMessage
  if (errAlt && typeof errAlt === 'object') {
    const o = errAlt as Record<string, unknown>
    pools.push(o.httpStatus, o.statusCode)
  }
  if (dbExtra) {
    pools.push(
      dbExtra.error_status,
      dbExtra.http_status,
      dbExtra.status_code,
      dbExtra.httpStatus,
      dbExtra.statusCode,
      dbExtra.status,
      dbExtra.code
    )
  }
  return extractHttpStatusFrom(pools)
}

function extractErrorMessage(data: Record<string, unknown>, dbExtra?: Record<string, unknown>): string | undefined {
  const candidates: unknown[] = [
    data.error,
    (data as Record<string, unknown>).errorMessage,
    (data as Record<string, unknown>).error_message,
    (data as Record<string, unknown>).message,
    dbExtra?.error,
    dbExtra?.error_message,
    dbExtra?.errorMessage,
    dbExtra?.message
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
  const statusRaw = data.status ?? data.state ?? dbExtra?.status ?? dbExtra?.state
  if (typeof statusRaw === 'string' && statusRaw.trim() !== '' && statusRaw.trim().toLowerCase() !== 'completed' && statusRaw.trim().toLowerCase() !== 'success') {
    return truncateMessage(statusRaw.trim())
  }
  return undefined
}

function isIgnoredText(text: string): boolean {
  const lower = text.trim().toLowerCase()
  if (isIgnoredFailureReason(lower)) return true
  return lower.includes('cancelled') || lower.includes('canceled') || lower.includes('interrupted')
}

export function detectOpencodeFailure(
  data: Record<string, unknown>,
  dbExtra?: Record<string, unknown>
): { isFailure: boolean; errorMessage?: string; httpStatus?: number; isIgnored: boolean } {
  const isNonEmpty = (v: unknown): boolean => {
    if (v === undefined || v === null) return false
    if (typeof v === 'string' && v.trim() === '') return false
    return true
  }
  const hasErrorField =
    isNonEmpty(data.error) ||
    isNonEmpty((data as Record<string, unknown>).errorMessage) ||
    isNonEmpty((data as Record<string, unknown>).error_message) ||
    isNonEmpty(dbExtra?.error) ||
    isNonEmpty(dbExtra?.error_message) ||
    isNonEmpty(dbExtra?.errorMessage)

  let statusIsFailure = false
  const statusCandidates = [data.status, data.state, dbExtra?.status, dbExtra?.state]
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

  const isFailure = Boolean(hasErrorField || statusIsFailure)
  if (!isFailure) return { isFailure: false, isIgnored: false }

  const errorMessage = extractErrorMessage(data, dbExtra)
  const httpStatus = extractHttpStatus(data, dbExtra)

  const checkTexts: string[] = []
  if (errorMessage) checkTexts.push(errorMessage)
  for (const s of statusCandidates) if (typeof s === 'string') checkTexts.push(s)
  for (const e of [data.error, (data as Record<string, unknown>).errorMessage, dbExtra?.error]) {
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

export interface OpencodeLikeRecordOptions {
  filePath: string
  line: number
  project?: string
  sessionId?: string
  createdAt?: number
  requestId?: string
  dbExtra?: Record<string, unknown>
}

export type OpencodeLikeRecordMapper = (
  data: unknown,
  opts: OpencodeLikeRecordOptions
) => UsageRecord | null

export interface OpencodeLikeParserCore {
  appType: AppType
}

export interface OpencodeLikeDbParserCore extends OpencodeLikeParserCore {
  dbName: string
}

export function createOpencodeLikeRecordMapper(core: OpencodeLikeParserCore): OpencodeLikeRecordMapper {
  return (data, opts) => {
    if (!data || typeof data !== 'object') return null
    const d = data as Record<string, unknown>
    if (d.role !== 'assistant') return null

    const model = typeof d.modelID === 'string' ? d.modelID.trim() : ''
    if (!model) return null

    const timeObj = d.time && typeof d.time === 'object' ? (d.time as Record<string, unknown>) : {}
    let createdAt = toTs(timeObj.created)
    if (!Number.isFinite(createdAt) || createdAt <= 0) createdAt = toTs(opts.createdAt)
    if (!Number.isFinite(createdAt) || createdAt <= 0) createdAt = Date.now()

    const hasId = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
    const resolveRequestId = (): string | undefined => {
      if (hasId(opts.requestId)) return (opts.requestId as string).trim()
      if (hasId(d.id)) return (d.id as string).trim()
      const msg = d.message
      if (msg && typeof msg === 'object') {
        const mid = (msg as Record<string, unknown>).id
        if (hasId(mid)) return (mid as string).trim()
      }
      return undefined
    }
    const requestId = resolveRequestId()

    const failure = detectOpencodeFailure(d, opts.dbExtra)
    if (failure.isFailure) {
      if (failure.isIgnored) return null
      const tokens = d.tokens && typeof d.tokens === 'object' ? (d.tokens as Record<string, unknown>) : null
      const t = tokens ?? {}
      const cache = (t.cache && typeof t.cache === 'object' ? t.cache : {}) as Record<string, unknown>
      return {
        appType: core.appType,
        model,
        rawModel: model,
        inputTokens: toNum(t.input),
        outputTokens: toNum(t.output),
        cacheReadTokens: toNum(cache.read),
        cacheCreationTokens: toNum(cache.write),
        inputSemantics: 2,
        status: 'error',
        ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
        ...(failure.errorMessage !== undefined ? { errorMessage: failure.errorMessage } : {}),
        createdAt,
        project: opts.project ?? (typeof d.directory === 'string' ? d.directory : undefined),
        sessionId: opts.sessionId ?? (typeof d.sessionID === 'string' ? d.sessionID : undefined),
        source: { filePath: opts.filePath, line: opts.line, requestId }
      }
    }

    const tokens = d.tokens
    if (!tokens || typeof tokens !== 'object') return null
    const t = tokens as Record<string, unknown>
    const cache = (t.cache && typeof t.cache === 'object' ? t.cache : {}) as Record<string, unknown>

    return {
      appType: core.appType,
      model,
      rawModel: model,
      inputTokens: toNum(t.input),
      outputTokens: toNum(t.output),
      cacheReadTokens: toNum(cache.read),
      cacheCreationTokens: toNum(cache.write),
      inputSemantics: 2,
      status: 'success',
      createdAt,
      project: opts.project ?? (typeof d.directory === 'string' ? d.directory : undefined),
      sessionId: opts.sessionId ?? (typeof d.sessionID === 'string' ? d.sessionID : undefined),
      source: { filePath: opts.filePath, line: opts.line, requestId }
    }
  }
}

export function createOpencodeLikeDbFileParser(
  core: OpencodeLikeDbParserCore
): (dbPath: string, fromLine: number) => ParsedResult {
  const toRecord = createOpencodeLikeRecordMapper(core)
  return (dbPath, fromLine) => {
    let db: Database.Database
    try {
      db = new Database(dbPath, { readonly: true, timeout: OPENCODE_LIKE_DB_BUSY_TIMEOUT_MS })
    } catch {
      throw new Error(`无法以只读模式打开 OpenCode-like 数据库 ${core.dbName}`)
    }

    try {
      assertRequiredColumns(db, 'message', ['id', 'session_id', 'time_created', 'data'])
      assertRequiredColumns(db, 'session', ['id', 'directory'])

      const fingerprint = readDbFingerprint(db)
      const maxRowid = readMaxRowid(db)
      const baseRowid = resolveDbRowidCursor(fromLine, fingerprint, maxRowid)
      const rows = db.prepare(OPENCODE_LIKE_MESSAGE_SELECT_SQL).all(baseRowid) as Array<
        Record<string, unknown> & {
          token_monitor_rowid: number
          id: string
          session_id: string | null
          time_created: number
          data: unknown
          project_dir: string | null
        }
      >

      const records: UsageRecord[] = []
      for (const row of rows) {
        const rowid = row.token_monitor_rowid
        if (!Number.isSafeInteger(rowid) || rowid <= 0 || rowid > OPENCODE_LIKE_CURSOR_MAX_ROWID) {
          throw new Error(`OpenCode-like 数据库包含不受支持的 rowid：${String(rowid)}`)
        }
        if (typeof row.data !== 'string') {
          throw new Error(`OpenCode-like 数据库 message.data 不是文本（rowid=${rowid}）`)
        }

        let parsed: unknown
        try {
          parsed = JSON.parse(row.data)
        } catch {
          throw new Error(`OpenCode-like 数据库 message.data 不是合法 JSON（rowid=${rowid}）`)
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error(`OpenCode-like 数据库 message.data 不是消息对象（rowid=${rowid}）`)
        }

        const dbExtra: Record<string, unknown> = {}
        for (const key of [
          'error',
          'error_message',
          'errorMessage',
          'status',
          'state',
          'http_status',
          'httpStatus',
          'status_code',
          'statusCode',
          'code'
        ]) {
          if (key in row && row[key] !== undefined) dbExtra[key] = row[key]
        }
        const hasDbExtra = Object.keys(dbExtra).length > 0 ? dbExtra : undefined
        const record = toRecord(parsed, {
          filePath: core.dbName,
          line: encodeDbCursor({ fingerprint, rowid }),
          project: row.project_dir ?? undefined,
          sessionId: row.session_id ?? undefined,
          createdAt: row.time_created,
          requestId: row.id,
          ...(hasDbExtra ? { dbExtra: hasDbExtra } : {})
        })
        if (record) records.push(record)
      }

      return { records, nextLine: encodeDbCursor({ fingerprint, rowid: maxRowid }), eof: true }
    } finally {
      db.close()
    }
  }
}

export function createOpencodeLikeJsonFileParser(
  core: OpencodeLikeParserCore
): (filePath: string, fromLine: number) => ParsedResult {
  const toRecord = createOpencodeLikeRecordMapper(core)
  return (filePath, fromLine) => {
    const base = typeof fromLine === 'number' && Number.isFinite(fromLine) && fromLine > 0 ? fromLine : 0
    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf8')
    } catch {
      return { records: [], nextLine: base, eof: true }
    }

    if (content.trim() === '') return { records: [], nextLine: base, eof: true }

    let obj: unknown
    try {
      obj = JSON.parse(content)
    } catch {
      return { records: [], nextLine: base, eof: true }
    }

    const items = Array.isArray(obj) ? obj : [obj]
    const records: UsageRecord[] = []
    let nextLine = base
    for (let i = 0; i < items.length; i++) {
      const line = i + 1
      if (base > 0 && line <= base) continue
      const record = toRecord(items[i], { filePath, line })
      if (record) records.push(record)
      nextLine = Math.max(nextLine, line)
    }
    return { records, nextLine, eof: true }
  }
}

export function listOpencodeLikeDbFiles(root: string, dbNames: string[]): FileEntry[] {
  const entries: FileEntry[] = []
  for (const name of dbNames) {
    const dbPath = path.join(root, name)
    if (fs.existsSync(dbPath)) {
      entries.push({ path: dbPath, mtime: maxMtime([dbPath, dbPath + '-wal']) })
    }
  }
  return entries
}

export interface OpencodeLikeDetectTexts {
  missingRoot: (root: string) => string
  noData: (root: string) => string
}

export function detectOpencodeLikeRoot(
  root: string,
  dbNames: string[],
  texts: OpencodeLikeDetectTexts,
  isExtraDataPresent?: (root: string) => boolean
): Detection {
  let rootOk = false
  try {
    rootOk = fs.statSync(root).isDirectory()
  } catch {
    rootOk = false
  }
  if (!rootOk) {
    return {
      available: false,
      reason: texts.missingRoot(root),
      sessionDir: root
    }
  }
  const hasDb = dbNames.some((name) => fs.existsSync(path.join(root, name)))
  if (hasDb || (isExtraDataPresent?.(root) ?? false)) {
    return { available: true, sessionDir: root }
  }
  return {
    available: false,
    reason: texts.noData(root),
    sessionDir: root
  }
}

export interface OpencodeLikePluginCoreOptions {
  appType: AppType
  dbName: string
  channelVariants?: string[]
  detectUnavailableReason: (root: string) => string
  detectMissingRootReason: (root: string) => string
}

export interface OpencodeLikePluginCore {
  readonly appType: AppType
  readonly dbName: string
  readonly dbNames: string[]
  readonly statMtimeMs: typeof statMtimeMs
  readonly maxMtime: typeof maxMtime
  readonly toNum: typeof toNum
  readonly toTs: typeof toTs
  readonly detectFailure: typeof detectOpencodeFailure
  readonly toUsageRecordFromData: OpencodeLikeRecordMapper
  readonly parseDbFile: (dbPath: string, fromLine: number) => ParsedResult
  readonly parseJsonFile: (filePath: string, fromLine: number) => ParsedResult
  readonly listDbFiles: (root: string) => FileEntry[]
  readonly detectFromRoot: (root: string, isExtraDataPresent?: (root: string) => boolean) => Detection
}

export function createOpencodeLikePluginCore(options: OpencodeLikePluginCoreOptions): OpencodeLikePluginCore {
  const dbNames = [options.dbName, ...(options.channelVariants ?? [])]
  return {
    appType: options.appType,
    dbName: options.dbName,
    dbNames,
    statMtimeMs,
    maxMtime,
    toNum,
    toTs,
    detectFailure: detectOpencodeFailure,
    toUsageRecordFromData: createOpencodeLikeRecordMapper(options),
    parseDbFile: createOpencodeLikeDbFileParser(options),
    parseJsonFile: createOpencodeLikeJsonFileParser(options),
    listDbFiles: (root) => listOpencodeLikeDbFiles(root, dbNames),
    detectFromRoot: (root, isExtraDataPresent) =>
      detectOpencodeLikeRoot(
        root,
        dbNames,
        { missingRoot: options.detectMissingRootReason, noData: options.detectUnavailableReason },
        isExtraDataPresent
      )
  }
}
