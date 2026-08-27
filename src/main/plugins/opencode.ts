import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'
import { ERROR_MESSAGE_MAX_LENGTH, isIgnoredFailureReason } from '../../../shared/failure'

/**
 * opencode 监控插件（docs/concepts/monitor-plugins.md，T10）。
 * 双数据源：
 *  - 新版（1.2+）：SQLite 数据根/opencode.db（message/session 表）
 *  - 旧版：数据根/storage/message/*.json（每文件一条消息 JSON）
 * 数据根可用 $OPENCODE_HOME 覆盖，默认 ~/.local/share/opencode。
 * WAL 感知：SQLite WAL 模式下新写入先落 -wal 文件，db 源条目 mtime 取主库与 -wal 的较大值，
 * 避免 watcher 因主库 mtime 长期不变而漏检（实时性退化为兜底扫描）。
 */

/** db 源标识：parseFile 按 path 末尾分派；db 行 source.filePath 恒为该常量（去重键稳定） */
export const DB_SOURCE_SUFFIX = 'opencode.db'

/**
 * 外部库只读连接的 busy 超时(ms)：better-sqlite3 撞锁时在主线程同步忙等，
 * 默认 5000ms 会冻结整个应用，故压到 250ms——撞锁即放弃本轮，由下轮同步重试。
 */
export const EXTERNAL_DB_BUSY_TIMEOUT_MS = 250

/** 数据根：$OPENCODE_HOME 覆盖，默认 ~/.local/share/opencode（调用时读取，便于测试注入） */
export function dataRoot(): string {
  const home = process.env.OPENCODE_HOME
  if (home && home.trim() !== '') return home.trim()
  return path.join(os.homedir(), '.local', 'share', 'opencode')
}

/** db 文件绝对路径 */
export function dbPathOf(root: string): string {
  return path.join(root, DB_SOURCE_SUFFIX)
}

/** 旧版 JSON 消息目录：storage/message */
function messageDirOf(root: string): string {
  return path.join(root, 'storage', 'message')
}

/** 旧版 session 目录：storage/session（递归收集其下 *.json） */
function sessionDirOf(root: string): string {
  return path.join(root, 'storage', 'session')
}

/** 宽松读取目录（不存在/无权限 → 空），单目录失败不阻塞整体收集 */
function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** stat 文件 mtime（epoch ms；stat 失败按 0 兜底） */
export function statMtimeMs(p: string): number {
  try {
    return Math.round(fs.statSync(p).mtimeMs)
  } catch {
    return 0
  }
}

/** 多路径 mtime 最大值（WAL 感知用）；全失败 → 0 */
export function maxMtime(paths: string[]): number {
  return paths.reduce((m, p) => Math.max(m, statMtimeMs(p)), 0)
}

/** 文件条目：path + mtime（epoch ms） */
function toEntry(p: string): FileEntry {
  return { path: p, mtime: statMtimeMs(p) }
}

/** 是否候选 JSON 消息文件：仅 *.json，过滤临时/隐藏文件（*.tmp、*.swp、.*、*~） */
function isJsonFile(name: string): boolean {
  if (!name.endsWith('.json')) return false
  if (name.startsWith('.')) return false
  return !/(?:\.tmp|\.swp|~)$/i.test(name)
}

/** storage/message 直接子层 *.json */
function collectMessageDir(dir: string, out: FileEntry[]): void {
  for (const ent of safeReaddir(dir)) {
    if (!ent.isFile()) continue
    if (isJsonFile(ent.name)) out.push(toEntry(path.join(dir, ent.name)))
  }
}

/** storage/session 子树递归 *.json */
function collectSessionDir(dir: string, out: FileEntry[]): void {
  for (const ent of safeReaddir(dir)) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) collectSessionDir(p, out)
    else if (ent.isFile() && isJsonFile(ent.name)) out.push(toEntry(p))
  }
}

/**
 * 列出待解析文件（root 可注入，便于测试）：
 *  - opencode.db 存在 → 仅返回该 db 单条目（源由 path 末尾标识）
 *  - 否则收集 storage/message/*.json + storage/session/任意层级/*.json
 */
export function listFilesFromRoot(root: string): FileEntry[] {
  const dbPath = dbPathOf(root)
  if (fs.existsSync(dbPath)) {
    // WAL 感知：mtime 取主库与 -wal 较大值；path 保持 dbPath（去重键稳定）
    return [{ path: dbPath, mtime: maxMtime([dbPath, dbPath + '-wal']) }]
  }
  const out: FileEntry[] = []
  collectMessageDir(messageDirOf(root), out)
  collectSessionDir(sessionDirOf(root), out)
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** 探测逻辑（root 可注入，便于测试）：数据根存在且 db 或 storage/message 任一见即可 */
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
      reason: '未找到数据根（默认 ~/.local/share/opencode，可用 $OPENCODE_HOME 覆盖）',
      sessionDir: root
    }
  }
  if (fs.existsSync(dbPathOf(root)) || fs.existsSync(messageDirOf(root))) {
    return { available: true, sessionDir: root }
  }
  return {
    available: false,
    reason: '数据根下未发现 opencode.db 或 storage/message（OpenCode 未安装或尚未产生会话）',
    sessionDir: root
  }
}

/** 宽松取数字：缺失/非有限数 → 0 */
const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** 宽松取时间戳：number(ms) 或可解析字符串；不可用 → NaN */
function toTs(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const p = Date.parse(v)
    if (!Number.isNaN(p)) return p
  }
  return NaN
}

/** 截断错误文案至 500（存储层 SSOT 为 shared/failure.ts ERROR_MESSAGE_MAX_LENGTH） */
function truncateMessage(text: string): string {
  return text.length > ERROR_MESSAGE_MAX_LENGTH ? text.slice(0, ERROR_MESSAGE_MAX_LENGTH) : text
}

/** 宽松提取 httpStatus：遍历候选 key，取首个有限数字（字符串数字亦兼容） */
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

/** 宽松提取 httpStatus（opencode）：从 data/error 对象及 db 附加字段中取 */
function extractHttpStatus(data: Record<string, unknown>, dbExtra?: Record<string, unknown>): number | undefined {
  const pools: unknown[] = []
  // data 内常见位置
  pools.push(
    data.httpStatus,
    data.http_status,
    (data as Record<string, unknown>).httpStatusCode,
    (data as Record<string, unknown>).http_status_code,
    data.statusCode,
    data.status_code,
    (data as Record<string, unknown>).code
  )
  // error 对象内
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

/** 宽松提取错误文案（opencode）：优先 error 字段，其次 db 附加字段，兜底 status 文案 */
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
        // ignore
      }
    }
  }
  // status 异常时以 status 文案兜底
  const statusRaw = data.status ?? data.state ?? dbExtra?.status ?? dbExtra?.state
  if (typeof statusRaw === 'string' && statusRaw.trim() !== '' && statusRaw.trim().toLowerCase() !== 'completed' && statusRaw.trim().toLowerCase() !== 'success') {
    return truncateMessage(statusRaw.trim())
  }
  return undefined
}

/** 判断是否为中断忽略（cancelled/interrupted）— 宽松包含匹配，兼容 shared/failure 的精确匹配 */
function isIgnoredText(text: string): boolean {
  const lower = text.trim().toLowerCase()
  if (isIgnoredFailureReason(lower)) return true
  return lower.includes('cancelled') || lower.includes('canceled') || lower.includes('interrupted')
}

/**
 * 检测 opencode 消息是否属失败：存在 error 字段或 status 异常（非 success/completed）
 * 性能：追加的宽松 if 分支，线性遍历少量候选 key（≤12 项）+ 字符串比较，无正则/全表扫描；
 *       中断忽略仅 includes 轻量包含匹配，失败/成功路径均为 O(1) 单行判定。
 */
function detectOpencodeFailure(
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

/**
 * opencode 消息 data JSON → UsageRecord（db 的 data 列 / 旧版单文件 JSON 共用）。
 * 宽松解析：非 assistant / 缺 modelID → null（跳过该条，不阻塞整体）。
 * 成功路径要求 tokens 存在；失败路径（error/status 异常）宽松产出 error 记录，tokens 保留原值或全 0。
 */
function toUsageRecordFromData(
  data: unknown,
  opts: {
    filePath: string
    line: number
    project?: string
    sessionId?: string
    createdAt?: number
    requestId?: string
    dbExtra?: Record<string, unknown>
  }
): UsageRecord | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.role !== 'assistant') return null

  const model = typeof d.modelID === 'string' ? d.modelID.trim() : ''
  if (!model) return null

  // createdAt 优先取 data.time.created，其次取外部回退（db 行的 time_created 列）
  const timeObj = d.time && typeof d.time === 'object' ? (d.time as Record<string, unknown>) : {}
  let createdAt = toTs(timeObj.created)
  if (!Number.isFinite(createdAt) || createdAt <= 0) createdAt = toTs(opts.createdAt)
  if (!Number.isFinite(createdAt) || createdAt <= 0) createdAt = Date.now()

  // 语义 ID 三级回退（参考 zcode）：opts.requestId > d.id > d.message.id
  // 失败分支必须保留真实 message id，避免因 error early-return 分支覆盖导致 requestId 丢失
  // fork/rewrite 语义去重依赖该字段，string 非空才设，缺失退回 (file,line) 主键去重
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

  // 宽松失败分支（T01 opencode 宽松探测）：message 含 error 字段或异常状态，或 SQLite 附加列含 error
  const failure = detectOpencodeFailure(d, opts.dbExtra)
  if (failure.isFailure) {
    if (failure.isIgnored) return null
    // 失败时 tokens 保留原值（如有），缺失则全 0
    const tokens = d.tokens && typeof d.tokens === 'object' ? (d.tokens as Record<string, unknown>) : null
    const t = tokens ?? {}
    const cache = (t.cache && typeof t.cache === 'object' ? t.cache : {}) as Record<string, unknown>
    return {
      appType: 'opencode',
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
    appType: 'opencode',
    model,
    rawModel: model,
    inputTokens: toNum(t.input),
    outputTokens: toNum(t.output),
    cacheReadTokens: toNum(cache.read),
    cacheCreationTokens: toNum(cache.write),
    // 上游 getUsage 已执行 adjustedInputTokens = input − cacheRead − cacheWrite,
    // tokens.input 即纯新输入,四项互不重叠 → semantics=2(pricing 不再扣减)
    inputSemantics: 2,
    status: 'success',
    createdAt,
    project: opts.project ?? (typeof d.directory === 'string' ? d.directory : undefined),
    sessionId: opts.sessionId ?? (typeof d.sessionID === 'string' ? d.sessionID : undefined),
    source: { filePath: opts.filePath, line: opts.line, requestId }
  }
}

/**
 * 解析 db 源（better-sqlite3 只读）。
 * 增量游标：fromLine 语义为「上次已同步的最大 time_created(ms) 水位」——
 * 只处理 time_created > fromLine 的行，nextLine 返回本次最大 time_created（无新增则原样返回）。
 * source.line 采用 time_created（与水位同源）并保证单调递增，跨轮去重唯一。
 * db 打开失败 / message 表不存在 / 撞锁超时（EXTERNAL_DB_BUSY_TIMEOUT_MS）→ 空结果；连接在 finally 关闭。
 */
export function parseDbFile(dbPath: string, fromLine: number): ParsedResult {
  const base = typeof fromLine === 'number' && Number.isFinite(fromLine) && fromLine > 0 ? fromLine : 0
  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true, timeout: EXTERNAL_DB_BUSY_TIMEOUT_MS })
    // 宽松查询：m.* 覆盖所有列（含未来 error 列），兼容旧 schema 无 error 列的库
    const rows = db
      .prepare(
        `SELECT m.*, s.directory AS project_dir
         FROM message m
         LEFT JOIN session s ON s.id = m.session_id
         WHERE m.time_created > ?
         ORDER BY m.time_created ASC, m.id ASC`
      )
      .all(base) as Array<
      Record<string, unknown> & {
        id: string
        session_id: string | null
        time_created: number
        data: unknown
        project_dir: string | null
      }
    >

    const records: UsageRecord[] = []
    let watermark = base
    let seq = base
    for (const row of rows) {
      // 水位覆盖本次扫描的所有新行（无论是否产出记录），避免反复重扫
      watermark = Math.max(watermark, row.time_created)
      // line 与水位同源并严格递增：跨轮去重唯一（(file_path, line) 为去重键）
      const line = Math.max(seq + 1, row.time_created)
      seq = line

      let parsed: unknown = null
      try {
        parsed = JSON.parse(String(row.data))
      } catch {
        parsed = null // 单条 data 损坏：跳过该条，不阻塞整体
      }
      // 收集 SQLite 附加 error 字段（若表含 error 列则取之，保持宽松兼容）
      const dbExtra: Record<string, unknown> = {}
      for (const k of ['error', 'error_message', 'errorMessage', 'status', 'state', 'http_status', 'httpStatus', 'status_code', 'statusCode', 'code']) {
        if (k in row && (row as Record<string, unknown>)[k] !== undefined) {
          dbExtra[k] = (row as Record<string, unknown>)[k]
        }
      }
      const hasDbExtra = Object.keys(dbExtra).length > 0 ? dbExtra : undefined
      const record = toUsageRecordFromData(parsed, {
        filePath: DB_SOURCE_SUFFIX,
        line,
        project: row.project_dir ?? undefined,
        sessionId: row.session_id ?? undefined,
        createdAt: row.time_created,
        requestId: row.id,
        ...(hasDbExtra ? { dbExtra: hasDbExtra } : {})
      })
      if (record) records.push(record)
    }
    return { records, nextLine: watermark, eof: true }
  } catch {
    // db 打开失败 / message 表不存在 / 读取异常：宽松返回空，不阻塞整体同步
    return { records: [], nextLine: base, eof: true }
  } finally {
    if (db) db.close()
  }
}

/**
 * 解析 JSON 源（旧版 storage/message/*.json，每文件一条消息，亦兼容数组多消息）。
 * 游标 = 行号（1-based，0=从头）：单 JSON 对象视为单条记录（line 1），数组按元素逐条计行；
 * fromLine>0 且已读到文件尾时跳过。损坏/半写文件不阻塞：eof=true 且游标停在原处，下次重试。
 */
export function parseJsonFile(filePath: string, fromLine: number): ParsedResult {
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
    // 损坏/半写（含尾部不完整行）：eof=true 且游标不推进，下次同步重试（与 claude.ts 尾部半行语义一致）
    return { records: [], nextLine: base, eof: true }
  }

  const items = Array.isArray(obj) ? obj : [obj]
  const records: UsageRecord[] = []
  let nextLine = base
  for (let i = 0; i < items.length; i++) {
    const line = i + 1 // 1-based 行号（去重键）
    if (base > 0 && line <= base) continue // 已同步行跳过
    const record = toUsageRecordFromData(items[i], { filePath, line })
    if (record) records.push(record)
    nextLine = Math.max(nextLine, line)
  }
  return { records, nextLine, eof: true }
}

/** 探测：数据根 + 双源任一 */
async function detect(): Promise<Detection> {
  return detectFromRoot(dataRoot())
}

/** 列出待解析文件 */
async function listFiles(): Promise<FileEntry[]> {
  return listFilesFromRoot(dataRoot())
}

/** 增量解析：按 path 末尾分派 db / JSON 源 */
async function parseFile(_ctx: PluginContext, filePath: string, fromLine: number): Promise<ParsedResult> {
  if (filePath.endsWith(DB_SOURCE_SUFFIX)) return parseDbFile(filePath, fromLine)
  return parseJsonFile(filePath, fromLine)
}

/** opencode 监控插件（docs/concepts/monitor-plugins.md，T10） */
export const opencodePlugin: MonitorPlugin = {
  id: 'opencode',
  name: 'OpenCode',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles,
  parseFile
}
