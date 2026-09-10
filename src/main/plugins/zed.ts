import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import { scanZstdFrames } from '../workers/zstd-scan'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'

const ZED_HOSTED_PROVIDER = 'zed.dev'
const EXTERNAL_DB_BUSY_TIMEOUT_MS = 250
const MAX_THREAD_JSON_BYTES = 32 * 1024 * 1024
const LINE_STRIDE = 1000
const CUMULATIVE_KEY = 'cumulative'

export function dataDirOf(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  const override = env.ZED_DIR
  if (override && override.trim() !== '') return override.trim()
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Zed')
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Zed')
  }
  const xdg = env.XDG_DATA_HOME
  if (xdg && xdg.trim() !== '') return path.join(xdg.trim(), 'zed')
  return path.join(os.homedir(), '.local', 'share', 'zed')
}

export function dbPathOf(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  return path.join(dataDirOf(platform, env), 'threads', 'threads.db')
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

export function listFilesFromDb(dbPath: string): FileEntry[] {
  if (!fs.existsSync(dbPath)) return []
  return [{ path: dbPath, mtime: maxMtime([dbPath, dbPath + '-wal']) }]
}

export function detectFromDb(dbPath: string): Detection {
  const sessionDir = path.dirname(dbPath)
  if (fs.existsSync(dbPath)) {
    return { available: true, sessionDir }
  }
  return {
    available: false,
    reason: '未找到 threads.db（Zed 未安装或尚未产生 Agent 会话，可用 $ZED_DIR 覆盖数据目录）',
    sessionDir
  }
}

interface ThreadMetaRow {
  rid: number
  id: string | null
  updated_at: string | null
  created_at: string | null
  folder_paths: string | null
  folder_paths_order: string | null
  data_type: string | null
}

interface UsageEntry {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  total: number
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export function projectFromFolders(paths: unknown, order: unknown): string | undefined {
  if (typeof paths !== 'string') return undefined
  const candidates = paths
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p !== '')
  if (candidates.length === 0) return undefined
  let selected = candidates[0]
  if (typeof order === 'string' && order.trim() !== '') {
    let best: { index: number; rank: number } | null = null
    for (const [index, token] of order.split(',').entries()) {
      const rank = Number.parseInt(token.trim(), 10)
      if (Number.isFinite(rank) && index < candidates.length && (best === null || rank < best.rank)) {
        best = { index, rank }
      }
    }
    if (best) selected = candidates[best.index]
  }
  return selected
}

function usageField(entry: Record<string, unknown>, key: string): number {
  const raw = entry[key]
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.max(0, raw)
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw.trim())
    if (Number.isFinite(parsed)) return Math.max(0, parsed)
  }
  return 0
}

function usageEntryOf(value: unknown): UsageEntry | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const entry = value as Record<string, unknown>
  const inputTokens = usageField(entry, 'input_tokens')
  const outputTokens = usageField(entry, 'output_tokens')
  const cacheReadTokens = usageField(entry, 'cache_read_input_tokens')
  const cacheCreationTokens = usageField(entry, 'cache_creation_input_tokens')
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    total: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens
  }
}

function decodeThreadJson(dataType: unknown, data: Buffer): string | null {
  const kind = typeof dataType === 'string' ? dataType.trim().toLowerCase() : ''
  if (kind === 'json') return data.toString('utf8')
  if (kind === 'zstd') {
    const scan = scanZstdFrames(data, 0)
    if (!scan.ok) return null
    if (Buffer.byteLength(scan.text, 'utf8') > MAX_THREAD_JSON_BYTES) return null
    return scan.text
  }
  return null
}

function recordsFromThreadRow(row: ThreadMetaRow, data: Buffer, filePath: string): UsageRecord[] {
  if (typeof row.id !== 'string' || row.id.trim() === '') return []
  const text = decodeThreadJson(row.data_type, data)
  if (text === null) return []
  let thread: unknown
  try {
    thread = JSON.parse(text)
  } catch {
    return []
  }
  if (thread === null || typeof thread !== 'object' || Array.isArray(thread)) return []
  const obj = thread as Record<string, unknown>
  if (obj.imported === true) return []
  const model = obj.model
  if (model === null || typeof model !== 'object' || Array.isArray(model)) return []
  const modelObj = model as Record<string, unknown>
  const provider = typeof modelObj.provider === 'string' ? modelObj.provider.trim() : ''
  if (provider.toLowerCase() !== ZED_HOSTED_PROVIDER) return []
  const modelId = typeof modelObj.model === 'string' ? modelObj.model.trim() : ''
  if (modelId === '') return []

  const sessionId = row.id
  const project = projectFromFolders(row.folder_paths, row.folder_paths_order)
  const createdAt =
    parseTimestampMs(row.created_at) ??
    parseTimestampMs(row.updated_at) ??
    parseTimestampMs(obj.updated_at) ??
    Date.now()

  const records: UsageRecord[] = []
  const push = (entry: UsageEntry, key: string, idx: number) => {
    if (idx >= LINE_STRIDE) return
    records.push({
      appType: 'zed',
      model: modelId,
      rawModel: modelId,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      cacheCreationTokens: entry.cacheCreationTokens,
      inputSemantics: 2,
      status: 'success',
      ...(project !== undefined ? { project } : {}),
      sessionId,
      createdAt,
      source: {
        filePath,
        line: row.rid * LINE_STRIDE + idx,
        requestId: `${sessionId}:${key}`
      }
    })
  }

  const cumulative = usageEntryOf(obj.cumulative_token_usage)
  const pushCumulative = () => {
    if (cumulative && cumulative.total > 0) push(cumulative, CUMULATIVE_KEY, 0)
  }

  const usage = obj.request_token_usage
  if (Array.isArray(usage)) {
    usage.forEach((item, idx) => {
      const entry = usageEntryOf(item)
      if (entry && entry.total > 0) push(entry, String(idx), idx)
    })
    if (records.length === 0) pushCumulative()
  } else if (usage !== null && typeof usage === 'object') {
    let idx = 0
    for (const [key, item] of Object.entries(usage as Record<string, unknown>)) {
      const entry = usageEntryOf(item)
      if (entry && entry.total > 0) push(entry, key, idx)
      idx++
    }
    if (records.length === 0) pushCumulative()
  } else {
    pushCumulative()
  }
  return records
}

export async function parseDbFile(
  ctx: PluginContext,
  dbPath: string,
  fromLine: number
): Promise<ParsedResult> {
  const base = typeof fromLine === 'number' && Number.isFinite(fromLine) && fromLine > 0 ? Math.floor(fromLine) : 0
  let watermark = 0
  try {
    const meta = await ctx.storage.getCursorMeta(dbPath)
    if (meta && typeof meta.byteOffset === 'number' && Number.isFinite(meta.byteOffset) && meta.byteOffset > 0) {
      watermark = meta.byteOffset
    }
  } catch {
    watermark = 0
  }

  let db: Database.Database | null = null
  const records: UsageRecord[] = []
  let nextLine = base
  let maxUpdatedAtMs = watermark
  try {
    db = new Database(dbPath, { readonly: true, timeout: EXTERNAL_DB_BUSY_TIMEOUT_MS })
    const columns = new Set<string>(
      (db.prepare('PRAGMA table_info(threads)').all() as Array<{ name: unknown }>).map((c) =>
        String(c.name)
      )
    )
    if (columns.size === 0) {
      return { records: [], nextLine: base, eof: true }
    }
    const createdAtCol = columns.has('created_at') ? 'created_at' : 'NULL'
    const folderPathsCol = columns.has('folder_paths') ? 'folder_paths' : 'NULL'
    const folderOrderCol = columns.has('folder_paths_order') ? 'folder_paths_order' : 'NULL'
    const metaRows = db
      .prepare(
        `SELECT rowid AS rid, id, updated_at, ${createdAtCol} AS created_at,
                ${folderPathsCol} AS folder_paths, ${folderOrderCol} AS folder_paths_order, data_type
         FROM threads ORDER BY rowid ASC`
      )
      .all() as unknown as ThreadMetaRow[]
    const dataStmt = db.prepare('SELECT data FROM threads WHERE rowid = ?')
    for (const row of metaRows) {
      const rid = typeof row.rid === 'number' && Number.isFinite(row.rid) ? row.rid : 0
      if (rid <= 0) continue
      const updatedAtMs = parseTimestampMs(row.updated_at)
      if (updatedAtMs !== null && updatedAtMs > maxUpdatedAtMs) maxUpdatedAtMs = updatedAtMs
      if (rid > nextLine) nextLine = rid
      const selected = rid > base || (updatedAtMs !== null && updatedAtMs > watermark)
      if (!selected) continue
      const dataRow = dataStmt.get(rid) as { data: unknown } | undefined
      if (!dataRow || !Buffer.isBuffer(dataRow.data)) continue
      records.push(...recordsFromThreadRow(row, dataRow.data, dbPath))
    }
    return { records, nextLine, eof: true }
  } catch {
    nextLine = base
    maxUpdatedAtMs = watermark
    return { records: [], nextLine: base, eof: true }
  } finally {
    if (db) db.close()
    try {
      await ctx.storage.setCursor(dbPath, nextLine, undefined, maxUpdatedAtMs)
    } catch {}
  }
}

async function detect(): Promise<Detection> {
  return detectFromDb(dbPathOf())
}

async function listFiles(): Promise<FileEntry[]> {
  return listFilesFromDb(dbPathOf())
}

async function parseFile(ctx: PluginContext, filePath: string, fromLine: number): Promise<ParsedResult> {
  return parseDbFile(ctx, filePath, fromLine)
}

export const zedPlugin: MonitorPlugin = {
  id: 'zed',
  name: 'Zed',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles,
  parseFile
}
