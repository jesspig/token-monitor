import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'

const CURRENT_DB_FILE = 'data.sqlite3'
const CURRENT_TABLE = 'conversations_v2'
const CURRENT_REQUIRED_COLUMNS = ['key', 'value', 'created_at', 'updated_at'] as const
const DB_BUSY_TIMEOUT_MS = 250

interface CurrentRootOptions {
  platform?: NodeJS.Platform
  homeDir?: string
  env?: NodeJS.ProcessEnv
}

interface ConversationRow {
  key: string
  value: string
  created_at: number | null
  updated_at: number | null
}

interface TurnSource {
  index: number
  filePath: string
  model: string
  sessionId: string
  project: string | undefined
  updatedAtMs: number
  stableSourceLine: boolean
  isReplaceableSnapshot: boolean
}

interface ConversationParseOptions {
  filePath: string
  fallbackSessionId: string
  updatedAtMs: number
  isReplaceableSnapshot: boolean
}

interface DbInspection {
  compatible: boolean
  reason?: string
}

export function dataRootOf(): string {
  const dir = process.env.KIRO_DIR
  if (dir && dir.trim() !== '') return dir.trim()
  return path.join(os.homedir(), '.kiro')
}

export function currentDataRootsOf(options: CurrentRootOptions = {}): string[] {
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? os.homedir()
  const env = options.env ?? process.env
  const override = env.KIRO_DATA_DIR?.trim()
  if (override) return [override]

  const roots = [path.join(homeDir, '.kiro')]
  if (platform === 'darwin') {
    roots.unshift(path.join(homeDir, 'Library', 'Application Support', 'kiro-cli'))
  } else if (platform === 'linux') {
    roots.unshift(path.join(env.XDG_DATA_HOME?.trim() || path.join(homeDir, '.local', 'share'), 'kiro-cli'))
  } else if (platform === 'win32') {
    roots.unshift(path.join(env.LOCALAPPDATA?.trim() || path.join(homeDir, 'AppData', 'Local'), 'kiro-cli'))
  }
  return [...new Set(roots.map((root) => path.resolve(root)))]
}

export function currentDbPathOf(root: string): string {
  return path.join(root, CURRENT_DB_FILE)
}

export function sessionRootOf(root: string): string {
  return path.join(root, 'sessions', 'cli')
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function statMtimeMs(filePath: string): number {
  try {
    return Math.round(fs.statSync(filePath).mtimeMs)
  } catch {
    return 0
  }
}

function maxMtime(paths: string[]): number {
  return paths.reduce((max, candidate) => Math.max(max, statMtimeMs(candidate)), 0)
}

export function sidecarPathOf(jsonlPath: string): string {
  return jsonlPath.replace(/\.jsonl$/i, '.json')
}

export function isSessionFile(name: string): boolean {
  if (!name.endsWith('.jsonl')) return false
  if (name.startsWith('.')) return false
  return !/(?:\.tmp|\.swp|~)$/i.test(name)
}

export function listFilesFromRoot(sessionDir: string): FileEntry[] {
  const out: FileEntry[] = []
  for (const ent of safeReaddir(sessionDir)) {
    if (!ent.isFile() || !isSessionFile(ent.name)) continue
    const filePath = path.join(sessionDir, ent.name)
    out.push({ path: filePath, mtime: maxMtime([filePath, sidecarPathOf(filePath)]) })
  }
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

export function listCurrentDbFiles(roots: string[]): FileEntry[] {
  const files = new Map<string, FileEntry>()
  for (const root of roots) {
    const dbPath = currentDbPathOf(root)
    if (!fs.existsSync(dbPath)) continue
    const resolved = path.resolve(dbPath)
    files.set(resolved, { path: resolved, mtime: maxMtime([resolved, `${resolved}-wal`]) })
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path))
}

export function listFilesFromRoots(legacyRoot: string, currentRoots: string[]): FileEntry[] {
  const files = new Map<string, FileEntry>()
  for (const entry of listCurrentDbFiles(currentRoots)) {
    if (inspectCurrentDb(entry.path).compatible) files.set(path.resolve(entry.path), entry)
  }
  for (const entry of listFilesFromRoot(sessionRootOf(legacyRoot))) {
    files.set(path.resolve(entry.path), entry)
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path))
}

function tableColumns(db: Database.Database): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${CURRENT_TABLE})`).all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

function hasCurrentSchema(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(CURRENT_TABLE) as { name?: string } | undefined
  if (row?.name !== CURRENT_TABLE) return false
  const columns = tableColumns(db)
  return CURRENT_REQUIRED_COLUMNS.every((column) => columns.has(column))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

const toStr = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

function explicitToken(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function parseTsMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value >= 1_000_000_000_000 ? value : value * 1000
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return 0
}

function conversationParts(value: unknown): {
  root: Record<string, unknown>
  turns: unknown[]
  model: string
} | null {
  const root = asRecord(value)
  const state = asRecord(root?.session_state)
  const metadata = asRecord(state?.conversation_metadata)
  const modelState = asRecord(state?.rts_model_state)
  const modelInfo = asRecord(modelState?.model_info)
  const turns = metadata?.user_turn_metadatas
  const model = toStr(modelInfo?.model_id)
  if (!root || !state || !Array.isArray(turns) || !model) return null
  return { root, turns, model }
}

function turnIdentity(turn: Record<string, unknown>, index: number): string {
  const messageIds = Array.isArray(turn.message_ids)
    ? turn.message_ids.map(toStr).filter((value) => value !== '')
    : []
  if (messageIds.length > 0) return `turn:${index}:messages:${messageIds.join(',')}`
  return `turn:${index}`
}

function stableLineOf(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) + 1
}

function toUsageRecord(turn: unknown, opts: TurnSource): UsageRecord {
  const value = asRecord(turn)
  if (!value) throw new Error(`Kiro 会话 ${opts.sessionId} 的第 ${opts.index + 1} 个 turn 不是对象`)
  const inputTokens = explicitToken(value.input_token_count)
  const outputTokens = explicitToken(value.output_token_count)
  if (inputTokens === null || outputTokens === null) {
    throw new Error(
      `Kiro 会话 ${opts.sessionId} 的第 ${opts.index + 1} 个 turn 缺少可验证的 input_token_count/output_token_count`
    )
  }
  const requestId = `${opts.sessionId}:${turnIdentity(value, opts.index)}`
  return {
    appType: 'kiro',
    model: opts.model,
    rawModel: opts.model,
    inputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    inputSemantics: 0,
    status: 'success',
    ...(opts.isReplaceableSnapshot ? { isReplaceableSnapshot: true } : {}),
    createdAt: parseTsMs(value.end_timestamp) || opts.updatedAtMs || Date.now(),
    project: opts.project,
    sessionId: opts.sessionId,
    source: {
      filePath: opts.filePath,
      line: opts.stableSourceLine ? stableLineOf(requestId) : opts.index + 1,
      requestId
    }
  }
}

function parseConversation(value: unknown, options: ConversationParseOptions, startIndex = 0): UsageRecord[] {
  const parts = conversationParts(value)
  if (!parts) {
    throw new Error(
      `Kiro 会话 ${options.fallbackSessionId} 不符合已验证的 session_state/conversation_metadata/rts_model_state schema`
    )
  }
  const sessionId = toStr(parts.root.session_id) || options.fallbackSessionId
  const project = toStr(parts.root.cwd) || undefined
  const updatedAtMs = parseTsMs(parts.root.updated_at) || options.updatedAtMs
  return parts.turns.slice(startIndex).map((turn, offset) => {
    const index = startIndex + offset
    return toUsageRecord(turn, {
      index,
      filePath: options.filePath,
      model: parts.model,
      sessionId,
      project,
      updatedAtMs,
      stableSourceLine: path.basename(options.filePath) === CURRENT_DB_FILE,
      isReplaceableSnapshot: options.isReplaceableSnapshot
    })
  })
}

export function inspectCurrentDb(dbPath: string): DbInspection {
  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true, timeout: DB_BUSY_TIMEOUT_MS })
    if (!hasCurrentSchema(db)) {
      return {
        compatible: false,
        reason: `数据库缺少 ${CURRENT_TABLE} 或必需列 ${CURRENT_REQUIRED_COLUMNS.join('/')}`
      }
    }
    const rows = db
      .prepare(`SELECT key, value, created_at, updated_at FROM ${CURRENT_TABLE} ORDER BY updated_at DESC, key ASC LIMIT 20`)
      .all() as ConversationRow[]
    if (rows.length === 0) return { compatible: true }
    for (const row of rows) {
      try {
        const value = JSON.parse(row.value)
        const parts = conversationParts(value)
        if (!parts) continue
        if (
          parts.turns.every((turn) => {
            const item = asRecord(turn)
            return item && explicitToken(item.input_token_count) !== null && explicitToken(item.output_token_count) !== null
          })
        ) {
          return { compatible: true }
        }
      } catch {
        continue
      }
    }
    return {
      compatible: false,
      reason: 'conversations_v2 中没有符合已验证结构且包含显式 Token 字段的会话，拒绝估算 Token'
    }
  } catch (error) {
    return {
      compatible: false,
      reason: `数据库无法只读打开：${error instanceof Error ? error.message : String(error)}`
    }
  } finally {
    db?.close()
  }
}

function directoryExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

export function detectFromRoots(legacyRoot: string, currentRoots: string[]): Detection {
  const dbFiles = listCurrentDbFiles(currentRoots)
  const compatibleDbs: string[] = []
  const incompatibleReasons: string[] = []
  for (const entry of dbFiles) {
    const inspection = inspectCurrentDb(entry.path)
    if (inspection.compatible) compatibleDbs.push(entry.path)
    else incompatibleReasons.push(inspection.reason || '未知 schema')
  }

  const legacyDir = sessionRootOf(legacyRoot)
  const legacyFiles = listFilesFromRoot(legacyDir)
  if (compatibleDbs.length > 0 || legacyFiles.length > 0) {
    return {
      available: true,
      ...(incompatibleReasons.length > 0
        ? { reason: `部分 Kiro 数据库不兼容：${incompatibleReasons.join('；')}，已继续使用其他兼容存储` }
        : {}),
      sessionDir: compatibleDbs[0] ? path.dirname(compatibleDbs[0]) : legacyDir
    }
  }

  if (incompatibleReasons.length > 0) {
    return {
      available: false,
      reason: `发现 Kiro 数据库但 schema 不兼容：${incompatibleReasons.join('；')}`,
      sessionDir: path.dirname(dbFiles[0].path)
    }
  }

  if (directoryExists(legacyDir) || currentRoots.some(directoryExists)) {
    return {
      available: false,
      reason: 'Kiro 数据目录存在，但未发现 data.sqlite3 或旧版 sessions/cli/*.jsonl 会话',
      sessionDir: legacyDir
    }
  }

  return {
    available: false,
    reason: '未找到 Kiro 当前 data.sqlite3 或旧版 sessions/cli 会话；可用 $KIRO_DATA_DIR / $KIRO_DIR 覆盖数据根',
    sessionDir: legacyDir
  }
}

export function detectFromRoot(root: string): Detection {
  return detectFromRoots(root, [root])
}

export function parseSessionFile(jsonlPath: string, fromLine: number): ParsedResult {
  const base = Number.isFinite(fromLine) && fromLine > 0 ? Math.floor(fromLine) : 0
  let value: unknown
  try {
    value = JSON.parse(fs.readFileSync(sidecarPathOf(jsonlPath), 'utf8'))
  } catch (error) {
    throw new Error(
      `无法读取 Kiro 旧版 sidecar ${path.basename(sidecarPathOf(jsonlPath))}：${error instanceof Error ? error.message : String(error)}`
    )
  }
  const parts = conversationParts(value)
  if (!parts) {
    throw new Error('Kiro 旧版 sidecar schema 不兼容，缺少已验证的会话、模型或 turn 字段')
  }
  const startIndex = base > 0 ? base - 1 : 0
  const records = parseConversation(
    value,
    {
      filePath: jsonlPath,
      fallbackSessionId: path.basename(jsonlPath).replace(/\.jsonl$/i, ''),
      updatedAtMs: 0,
      isReplaceableSnapshot: false
    },
    startIndex
  )
  return {
    records,
    nextLine: Math.max(base, parts.turns.length + 1),
    eof: true
  }
}

export function parseCurrentDbFile(dbPath: string, _fromLine: number): ParsedResult {
  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true, timeout: DB_BUSY_TIMEOUT_MS })
    if (!hasCurrentSchema(db)) {
      throw new Error(`Kiro 数据库 schema 不兼容，缺少 ${CURRENT_TABLE} 或必需列`)
    }
    const rows = db
      .prepare(`SELECT key, value, created_at, updated_at FROM ${CURRENT_TABLE} ORDER BY key ASC`)
      .all() as ConversationRow[]
    const records: UsageRecord[] = []
    for (const row of rows) {
      let value: unknown
      try {
        value = JSON.parse(row.value)
      } catch (error) {
        throw new Error(
          `Kiro conversations_v2 会话 ${row.key} 的 value 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`
        )
      }
      records.push(
        ...parseConversation(value, {
          filePath: dbPath,
          fallbackSessionId: row.key,
          updatedAtMs: parseTsMs(row.updated_at) || parseTsMs(row.created_at),
          isReplaceableSnapshot: true
        })
      )
    }
    return { records, nextLine: 1, eof: true }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Kiro ')) throw error
    throw new Error(`无法只读解析 Kiro 数据库：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    db?.close()
  }
}

async function detect(): Promise<Detection> {
  return detectFromRoots(dataRootOf(), currentDataRootsOf())
}

async function listFiles(): Promise<FileEntry[]> {
  return listFilesFromRoots(dataRootOf(), currentDataRootsOf())
}

async function parseFile(_ctx: PluginContext, filePath: string, fromLine: number): Promise<ParsedResult> {
  return path.basename(filePath) === CURRENT_DB_FILE
    ? parseCurrentDbFile(filePath, fromLine)
    : parseSessionFile(filePath, fromLine)
}

export const kiroPlugin: MonitorPlugin = {
  id: 'kiro',
  name: 'Kiro CLI',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles,
  parseFile
}
