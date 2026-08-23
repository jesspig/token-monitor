import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'

/**
 * zcode 监控插件（docs/concepts/monitor-plugins.md）。
 * 单数据源：SQLite 库 <数据根>/cli/db/db.sqlite；数据根可用 $ZCODE_STORAGE_DIR 重定位整个根，
 * 默认 ~/.zcode。schema 核实自 CLI db v0.14.8（社区工具 codeburn 实测）：
 *  - model_usage.id 每请求唯一 → 直接作为稳定语义请求 ID（requestId）；
 *  - input_tokens 已包含缓存读写 token（上游未扣减，直接计费约 8 倍高估）
 *    → inputSemantics=1，由 pricing 计费前本地扣减缓存；
 *  - reasoning_tokens 为独立列、不折入 output（codeburn 同口径）→ outputTokens 原样不加；
 *  - started_at / completed_at 均为 epoch 毫秒，createdAt = completed_at ?? started_at。
 * WAL 感知：条目 mtime 取主库与 -wal 较大值，避免 watcher 因主库 mtime 长期不变而漏检
 * （实时性退化为兜底扫描）。
 */

/** 数据根：$ZCODE_STORAGE_DIR 覆盖整个根，默认 ~/.zcode（调用时读取，便于测试注入） */
export function dataRootOf(): string {
  const dir = process.env.ZCODE_STORAGE_DIR
  if (dir && dir.trim() !== '') return dir.trim()
  return path.join(os.homedir(), '.zcode')
}

/** db 文件绝对路径：<root>/cli/db/db.sqlite */
export function dbPathOf(root: string): string {
  return path.join(root, 'cli', 'db', 'db.sqlite')
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

/**
 * 列出待解析文件（root 可注入，便于测试）：
 * db 存在 → 单条目（WAL 感知 mtime，path 保持真实 db 绝对路径）；不存在 → 空数组。
 */
export function listFilesFromRoot(root: string): FileEntry[] {
  const dbPath = dbPathOf(root)
  if (!fs.existsSync(dbPath)) return []
  return [{ path: dbPath, mtime: maxMtime([dbPath, dbPath + '-wal']) }]
}

/** 探测逻辑（root 可注入，便于测试）：数据根存在且 db 存在即可用 */
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

/** model_usage 行（LEFT JOIN session 后的扁平形态；宽松取列均按 unknown 兜底） */
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
}

/** 宽松取数字：缺失/非有限数 → 0 */
const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * model_usage 行 → UsageRecord。字段映射：
 * model=model_id（trim 非空）/ input=input_tokens / output=output_tokens /
 * cacheRead=cache_read_input_tokens / cacheCreation=cache_creation_input_tokens；
 * inputSemantics=1：上游 input_tokens 已含缓存读写（实测依据见文件头），计费前需扣减；
 * outputTokens 不加 reasoning_tokens（独立列不计入速率，codeburn 同口径）；
 * 全零四桶行照常产出，由 collector 的 isAllZeroUsage 统一拦截。
 * 宽松解析：model_id 缺失/空白 → null（跳过该条，不阻塞整体）。
 */
function toUsageRecord(row: ModelUsageRow, opts: { filePath: string; line: number }): UsageRecord | null {
  const model = typeof row.model_id === 'string' ? row.model_id.trim() : ''
  if (!model) return null

  // createdAt = completed_at ?? started_at（codeburn 口径）；均无效时 Date.now() 兜底
  let createdAt = toNum(row.completed_at)
  if (createdAt <= 0) createdAt = toNum(row.started_at)
  if (createdAt <= 0) createdAt = Date.now()

  return {
    appType: 'zcode',
    model,
    rawModel: model,
    inputTokens: toNum(row.input_tokens),
    outputTokens: toNum(row.output_tokens),
    cacheReadTokens: toNum(row.cache_read_input_tokens),
    cacheCreationTokens: toNum(row.cache_creation_input_tokens),
    inputSemantics: 1,
    status: 'success',
    createdAt,
    project: row.project_dir ?? undefined,
    sessionId: row.session_id ?? undefined,
    source: {
      filePath: opts.filePath,
      line: opts.line,
      // 稳定语义请求 ID = model_usage.id（每请求唯一）；空串/缺失退回 (file,line) 主键去重
      requestId: row.id && row.id.trim() !== '' ? row.id : undefined
    }
  }
}

/**
 * 解析 db 源（better-sqlite3 只读）。
 * 增量游标：fromLine 语义为「上次已处理的最大 rowid 水位」——只处理 rowid > fromLine 的行，
 * nextLine 返回本次最大 rowid（无新行则原样返回）。
 * source.line 采用 rowid：TEXT PK 表仍是 rowid 表，rowid 按 INSERT 单调递增且不回退，
 * 以此为去重键跨轮唯一（同轮多请求各占一行）。
 * db 打开失败 / model_usage 表不存在 → 空结果；连接在 finally 关闭。
 */
export function parseDbFile(dbPath: string, fromLine: number): ParsedResult {
  const base = typeof fromLine === 'number' && Number.isFinite(fromLine) && fromLine > 0 ? fromLine : 0
  let db: Database.Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
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
      // 水位覆盖本次扫描的所有新行（无论是否产出记录），避免反复重扫
      watermark = Math.max(watermark, row.rid)
      const record = toUsageRecord(row, { filePath: dbPath, line: row.rid })
      if (record) records.push(record)
    }
    return { records, nextLine: watermark, eof: true }
  } catch {
    // db 打开失败 / model_usage 表不存在 / 读取异常：宽松返回空，不阻塞整体同步
    return { records: [], nextLine: base, eof: true }
  } finally {
    if (db) db.close()
  }
}

/** 探测：数据根 + db */
async function detect(): Promise<Detection> {
  return detectFromRoot(dataRootOf())
}

/** 列出待解析文件 */
async function listFiles(): Promise<FileEntry[]> {
  return listFilesFromRoot(dataRootOf())
}

/** 增量解析：单数据源直接按 rowid 水位续读（path 即 db 绝对路径，无需分派） */
async function parseFile(_ctx: PluginContext, filePath: string, fromLine: number): Promise<ParsedResult> {
  return parseDbFile(filePath, fromLine)
}

/** zcode 监控插件（docs/concepts/monitor-plugins.md） */
export const zcodePlugin: MonitorPlugin = {
  id: 'zcode',
  name: 'ZCode',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles,
  parseFile
}
