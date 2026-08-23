import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'

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

/**
 * opencode 消息 data JSON → UsageRecord（db 的 data 列 / 旧版单文件 JSON 共用）。
 * 宽松解析：非 assistant / 缺 modelID / 缺 tokens → null（跳过该条，不阻塞整体）。
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
  }
): UsageRecord | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.role !== 'assistant') return null

  const model = typeof d.modelID === 'string' ? d.modelID.trim() : ''
  if (!model) return null

  const tokens = d.tokens
  if (!tokens || typeof tokens !== 'object') return null
  const t = tokens as Record<string, unknown>
  const cache = (t.cache && typeof t.cache === 'object' ? t.cache : {}) as Record<string, unknown>

  // createdAt 优先取 data.time.created，其次取外部回退（db 行的 time_created 列）
  const timeObj = d.time && typeof d.time === 'object' ? (d.time as Record<string, unknown>) : {}
  let createdAt = toTs(timeObj.created)
  if (!Number.isFinite(createdAt) || createdAt <= 0) createdAt = toTs(opts.createdAt)
  if (!Number.isFinite(createdAt) || createdAt <= 0) createdAt = Date.now()

  // 语义 ID:优先 db 行主键(opts.requestId),其次旧版 JSON 消息自带 d.id;
  // fork/rewrite 语义去重依赖该字段,string 非空才设,缺失退回 (file,line) 主键去重
  const hasId = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
  const requestId = hasId(opts.requestId) ? opts.requestId : hasId(d.id) ? d.id : undefined

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
 * db 打开失败 / message 表不存在 → 空结果；连接在 finally 关闭。
 */
export function parseDbFile(dbPath: string, fromLine: number): ParsedResult {
  const base = typeof fromLine === 'number' && Number.isFinite(fromLine) && fromLine > 0 ? fromLine : 0
  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    const rows = db
      .prepare(
        `SELECT m.id, m.session_id, m.time_created, m.data, s.directory AS project_dir
         FROM message m
         LEFT JOIN session s ON s.id = m.session_id
         WHERE m.time_created > ?
         ORDER BY m.time_created ASC, m.id ASC`
      )
      .all(base) as Array<{
      id: string
      session_id: string | null
      time_created: number
      data: unknown
      project_dir: string | null
    }>

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
      const record = toUsageRecordFromData(parsed, {
        filePath: DB_SOURCE_SUFFIX,
        line,
        project: row.project_dir ?? undefined,
        sessionId: row.session_id ?? undefined,
        createdAt: row.time_created,
        requestId: row.id
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
