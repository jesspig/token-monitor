import os from 'node:os'
import path from 'node:path'
import { join } from 'node:path'
import fs from 'node:fs'
import { Worker } from 'node:worker_threads'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'
import {
  hasZstdMagicAt,
  scanZstdFrames,
  type FrameScan,
  type FrameScanSuccess
} from '../workers/zstd-scan'

/**
 * dsh 监控插件（DeepSeek Harness，DeepSeek AI 开源 agent harness，developer preview）。
 * 数据源：~/.dsh/sessions/（$DSH_HOME 覆盖 dsh home，sessions 位于其下），按工作目录
 * 组织为 --<normalized-cwd>--/<encoded-id>/session.jsonl.zstd（默认 zstd 压缩；
 * compression:'none' 时为裸 session.jsonl）。
 * 格式来源：上游 packages/session/session-persistence-jsonl README + SessionEventMap
 * （@deepseek-ai/dsh-session / @deepseek-ai/dsh-llm 类型定义）：
 * - 首逻辑行为 header { type:'session', version, id, cwd?, createdAt, ... }，
 *   SESSION_FORMAT_VERSION=0 为 pre-release 格式无兼容承诺，上游破坏性变更时
 *   按宽松解析兜底 + 联网复核维护本插件；
 * - 之后每行一条 storage record envelope { type, seq, time(epoch ms), data:{...} }，
 *   计费条目为 type==='assistant/message' 且 data.message.role==='assistant' 且
 *   data.usage 为对象；usage 四桶 inputTokens/outputTokens/cacheReadTokens/
 *   cacheWriteTokens 按 TokenUsage disjoint 约定互不重叠 → input 即纯新输入，
 *   inputSemantics=2（与 pi/opencode 同模式）；reasoningTokens 为 outputTokens 子集，
 *   不加速率（与 token-meter 同口径）；
 * - packed chunk rows 仅出现在 assistant/chunk 流水，按 type 白名单过滤天然跳过；
 * - 计费条目模型取三级来源：data.message.source.model 非空时优先（AssistantProvenance
 *   per-message 自带，实测 473/473 全部携带，增量续读永不丢），其次 data.message.model
 *   （兼容上游未来恢复顶层字段；120 文件 / 6084 条实测 0 条携带），最后回落最近一条
 *   type==='request/header' 行的 data.header.config.model 兜底（header 仅在路由/配置变化
 *   时写入，reason ∈ initial/resume/change，远稀疏于计费条目），三者皆无则跳过；
 * - request/header 稀疏造成的增量续读状态盲区由模块级会话头状态缓存（sessionStateCache）
 *   消除：每轮结束时把 sessionId/project/currentModel 连同游标写回（key=filePath，
 *   上限 512 条淘汰最早插入），下轮起点与缓存游标精确衔接时恢复，不衔接则弃用重建；
 * - data.message.provider / source.provider 为供应方标注，UsageRecord 无对应字段故丢弃。
 */

/** 数据根下 sessions 目录：$DSH_HOME 覆盖 dsh home（trim 非空才用），默认 ~/.dsh/sessions */
export function dataRootOf(): string {
  const override = process.env.DSH_HOME
  if (override && override.trim() !== '') return path.join(override.trim(), 'sessions')
  return path.join(os.homedir(), '.dsh', 'sessions')
}

/** 宽松读取目录（不存在/无权限 → 空），单目录失败不阻塞整体收集 */
function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/** 文件条目：path + mtime（epoch ms；stat 失败按 0 兜底） */
function toEntry(p: string): FileEntry {
  let mtime = 0
  try {
    mtime = Math.round(fs.statSync(p).mtimeMs)
  } catch {
    mtime = 0
  }
  return { path: p, mtime }
}

/**
 * 是否候选会话工件：固定文件名 session.jsonl / session.jsonl.zstd。
 * 其余 .jsonl/.json 及临时/隐藏文件（*.tmp、*.swp、.*、*~）天然被精确匹配排除。
 */
function isSessionFile(name: string): boolean {
  return name === 'session.jsonl' || name === 'session.jsonl.zstd'
}

/** sessions 子树递归收集固定名会话工件（目录编码层与更深层级均收集） */
function collectSubtree(dir: string, out: FileEntry[]): void {
  for (const ent of safeReaddir(dir)) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      collectSubtree(p, out)
    } else if (ent.isFile() && isSessionFile(ent.name)) {
      out.push(toEntry(p))
    }
  }
}

/**
 * 探测用存在性短路检查：找到首个会话工件即返回 true。
 * detect 被 getPluginStatus 周期调用（监控源页轮询），不做全树枚举与逐文件 stat，
 * 避免大会话树下的主进程同步 IO 阻塞；listFilesFromRoot 仅供同步链路使用。
 */
function hasSessionFile(dir: string): boolean {
  for (const ent of safeReaddir(dir)) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (hasSessionFile(p)) return true
    } else if (ent.isFile() && isSessionFile(ent.name)) {
      return true
    }
  }
  return false
}

/**
 * 列出会话文件（root 可注入，便于测试）：sessions 子树内任意层级的固定名会话工件。
 * fork 提取分支（seed 继承）会产生新文件但 seq 跨 fork 稳定，
 * 由 `<sessionId>:<seq>` 作 requestId 经语义去重收敛（见 toUsageRecord）。
 */
export function listFilesFromRoot(root: string): FileEntry[] {
  const out: FileEntry[] = []
  collectSubtree(root, out)
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

const SQLITE_BACKEND_HINT = 'SQLite 后端暂不支持，仅支持 JSONL（JSONL.zstd/raw）工件'

/**
 * 探测逻辑（root 可注入，便于测试）：数据根存在且至少列出一个会话工件即 available。
 */
export function detectFromRoot(root: string): Detection {
  let ok = false
  try {
    ok = fs.statSync(root).isDirectory()
  } catch {
    ok = false
  }
  if (!ok) {
    return {
      available: false,
      reason: `未找到会话目录 ~/.dsh/sessions（可用 $DSH_HOME 覆盖 dsh home；DeepSeek Harness 未安装或尚未产生会话；${SQLITE_BACKEND_HINT}）`,
      sessionDir: root
    }
  }
  if (!hasSessionFile(root)) {
    return {
      available: false,
      reason: `会话目录下未发现 session.jsonl / session.jsonl.zstd 工件（DeepSeek Harness 尚未产生会话；${SQLITE_BACKEND_HINT}）`,
      sessionDir: root
    }
  }
  return { available: true, sessionDir: root }
}

/** 宽松取数字：缺失/非有限数 → 0 */
const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** 错误文案截断至 500（SSOT 为 shared/failure.ts ERROR_MESSAGE_MAX_LENGTH） */
function truncateErrorMessage(text: string): string {
  return text.length > 500 ? text.slice(0, 500) : text
}

/**
 * llm/retry 失败行 → UsageRecord（T01 矩阵 dsh 分支）。
 * 触发条件：type==='llm/retry' 且 data.failure 为对象存在时。
 * 产出：status='error'，errorMessage 为 `[code] message`（code/message 均取 failure 字段，缺失时宽松回落，截断 500），
 *       httpStatus 不设（无精确码），tokens 四项为 0，inputSemantics=2，
 *       model 取 failure.model（若为非空字符串）或缓存 currentModel，皆无则回落 'unknown' 以保证可观测，
 *       createdAt 取 envelope time，requestId 与成功路径一致为 `<sessionId>:<seq>`。
 * llm/retry-started（无 failure）天然不命中，属忽略。
 * 性能：追加的 type 严格相等 + failure 对象存在性分支，无正则/全表扫描；
 *       单次字符串拼接 + slice 截断，单行 O(1)，zstd 解压/帧扫描热点不受影响。
 */
function toRetryErrorRecord(
  row: Record<string, unknown>,
  filePath: string,
  line: number,
  session: { sessionId?: string; project?: string; currentModel?: string }
): UsageRecord | null {
  if (row.type !== 'llm/retry') return null
  const data = row.data
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const failure = d.failure
  if (!failure || typeof failure !== 'object') return null
  const f = failure as Record<string, unknown>

  const codeRaw = f.code
  const code =
    typeof codeRaw === 'string' ? codeRaw.trim() : typeof codeRaw === 'number' && Number.isFinite(codeRaw) ? String(codeRaw) : ''
  const msgRaw = f.message ?? f.error ?? f.text
  const message = typeof msgRaw === 'string' ? msgRaw.trim() : ''
  let errorMessage: string | undefined
  if (code && message) errorMessage = truncateErrorMessage(`[${code}] ${message}`)
  else if (code) errorMessage = truncateErrorMessage(`[${code}]`)
  else if (message) errorMessage = truncateErrorMessage(message)
  else {
    try {
      const fallback = JSON.stringify(failure)
      if (fallback && fallback !== '{}') errorMessage = truncateErrorMessage(fallback)
    } catch {
      errorMessage = undefined
    }
  }

  const failureModel = typeof f.model === 'string' ? f.model.trim() : ''
  const dataModel = typeof d.model === 'string' ? d.model.trim() : ''
  let model = failureModel || dataModel || session.currentModel || ''
  if (!model) model = 'unknown'

  const rawSeq =
    typeof row.seq === 'number' && Number.isFinite(row.seq)
      ? String(row.seq)
      : typeof row.seq === 'string' && row.seq.trim() !== ''
        ? row.seq.trim()
        : undefined
  const requestId = session.sessionId && rawSeq ? `${session.sessionId}:${rawSeq}` : undefined

  const t = toNum(row.time)
  const createdAt = t > 0 ? t : Date.now()

  return {
    appType: 'dsh',
    model,
    rawModel: model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    inputSemantics: 2,
    status: 'error',
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    createdAt,
    project: session.project,
    sessionId: session.sessionId,
    source: { filePath, line, ...(requestId ? { requestId } : {}) }
  }
}

/**
 * 单条 storage record envelope → UsageRecord。
 * 仅 type==='assistant/message'、message.role 无 assistant 异值（宽松：role 缺失放行）
 * 且 usage 为对象时产出。模型三级来源：data.message.source.model 非空时优先（宽松判对象
 * 取字符串 trim 非空才用；per-message 自带，473/473 实测全部携带，续读永不丢），其次
 * data.message.model（兼容上游未来恢复顶层字段），最后回落 session.currentModel（此前
 * 最近一条 request/header 的 data.header.config.model）；三者皆无
 * 返回 null（跳过该条，不阻塞整体）。
 * requestId 取 `<sessionId>:<seq>`：seq 为会话内单调序号，跨 fork 文件（seed 继承）稳定，
 * 同一逻辑请求复制进新文件时由 storage 按 (data_source, request_id) 语义判重收敛；
 * sessionId 缺失时不设置（裸 seq 跨会话不唯一），退回旧 (file,line) 主键去重。
 * reasoningTokens 不加速率（output 子集）；provider 字段丢弃（UsageRecord 无该字段）。
 */
function toUsageRecord(
  row: Record<string, unknown>,
  filePath: string,
  line: number,
  session: { sessionId?: string; project?: string; currentModel?: string }
): UsageRecord | null {
  if (row.type !== 'assistant/message') return null

  const data = row.data
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>

  const message = d.message
  if (!message || typeof message !== 'object') return null
  const msg = message as Record<string, unknown>
  // 宽松 role 校验：上游 AssistantMessage role 恒为 'assistant'，仅显式异值才拒收
  if (msg.role !== undefined && msg.role !== 'assistant') return null

  // 三级模型来源：message.source.model → message.model → 当前请求头模型，任一非空即用
  const source =
    msg.source && typeof msg.source === 'object' ? (msg.source as Record<string, unknown>) : undefined
  const sourceModel = source && typeof source.model === 'string' ? source.model.trim() : ''
  const ownModel = typeof msg.model === 'string' ? msg.model.trim() : ''
  const model = sourceModel || ownModel || session.currentModel || ''
  if (!model) return null

  const usage = d.usage
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>

  // 宽松取 seq（number/string 均可）：与 sessionId 组合为语义请求 ID
  const rawSeq =
    typeof row.seq === 'number' && Number.isFinite(row.seq)
      ? String(row.seq)
      : typeof row.seq === 'string' && row.seq.trim() !== ''
        ? row.seq.trim()
        : undefined
  const requestId = session.sessionId && rawSeq ? `${session.sessionId}:${rawSeq}` : undefined

  // createdAt：envelope 顶层 time（epoch ms），number 有效才用，无效兜底当前时间
  const t = toNum(row.time)
  const createdAt = t > 0 ? t : Date.now()

  return {
    appType: 'dsh',
    model,
    rawModel: model,
    inputTokens: toNum(u.inputTokens),
    outputTokens: toNum(u.outputTokens),
    cacheReadTokens: toNum(u.cacheReadTokens),
    cacheCreationTokens: toNum(u.cacheWriteTokens),
    // TokenUsage disjoint 约定：inputTokens 不含缓存读写，四桶互不重叠 → semantics=2
    // （pricing 不再扣减）；reasoningTokens 属 output 子集，不加速率（token-meter 同口径）
    inputSemantics: 2,
    status: 'success',
    createdAt,
    project: session.project,
    sessionId: session.sessionId,
    source: { filePath, line, ...(requestId ? { requestId } : {}) }
  }
}

/** 会话头状态：sessionId/project 来自 header 行，currentModel 来自最近的 request/header 行 */
interface SessionHeadState {
  sessionId?: string
  project?: string
  currentModel?: string
  cursorLine: number
}

/** 会话头状态缓存上限：超限淘汰最早插入条目（Map 保持插入序） */
const SESSION_STATE_CACHE_MAX = 512

/**
 * zstd 解压执行线程管理：解压挪到 worker 线程（out/main/zstd-worker.js），
 * 主线程只做 await，大会话文件解压不再冻结 Electron 事件循环。
 * worker 懒创建；创建失败（如单测/异常环境无产物文件）或超时/故障时
 * 回退主线程同步 scanZstdFrames——宁可阻塞也要产出正确结果，行为与
 * 线程化之前完全一致。collector 对单插件串行解析，但 watcher 定向同步
 * 与兜底扫描可能并发进入，故响应按请求 id 关联分发而非按序假设。
 */

/** 单次解压超时：超过视为 worker 卡死，销毁后本次回退主线程同步解压 */
const ZSTD_WORKER_TIMEOUT_MS = 10_000

let zstdWorker: Worker | null = null
let zstdWorkerBroken = false
let nextScanId = 0
const pendingScans = new Map<
  number,
  { resolve: (scan: FrameScan) => void; reject: (err: unknown) => void }
>()

function failAllPendingScans(): void {
  for (const pending of pendingScans.values()) pending.reject(new Error('zstd worker unavailable'))
  pendingScans.clear()
}

async function destroyZstdWorker(): Promise<void> {
  const worker = zstdWorker
  zstdWorker = null
  if (!worker) return
  try {
    await worker.terminate()
  } catch {
    // terminate 失败忽略：引用已弃置
  }
}

function ensureZstdWorker(): Worker | null {
  if (zstdWorkerBroken) return null
  if (zstdWorker) return zstdWorker
  try {
    // 运行时路径 = 构建产物目录（electron-vite 多入口输出 out/main/zstd-worker.js）
    const worker = new Worker(join(__dirname, 'zstd-worker.js'))
    worker.on('message', (res: { id?: number; scan?: FrameScan }) => {
      if (!res || typeof res.id !== 'number' || !res.scan) return
      const pending = pendingScans.get(res.id)
      if (!pending) return
      pendingScans.delete(res.id)
      pending.resolve(res.scan)
    })
    worker.on('error', () => {
      if (zstdWorker === worker) zstdWorker = null
      // 启动失败（产物缺失）/运行故障：标记不可用并 reject 在途请求，
      // 调用方 catch 后回退主线程同步解压，本进程内不再尝试 worker
      zstdWorkerBroken = true
      failAllPendingScans()
    })
    worker.on('exit', () => {
      if (zstdWorker === worker) zstdWorker = null
      failAllPendingScans()
    })
    zstdWorker = worker
    return worker
  } catch {
    // 线程创建同步抛错：本进程内不再重试，恒走主线程回退
    zstdWorkerBroken = true
    return null
  }
}

/**
 * 经 worker 执行帧扫描解压；创建失败/超时/worker 故障时回退主线程同步
 * scanZstdFrames——宁可阻塞也要产出正确结果，行为与线程化之前完全一致。
 * 超时视为 worker 卡死，销毁重建（下次调用重新拉起）。
 */
async function scanZstdFramesAsync(buf: Buffer, from: number): Promise<FrameScan> {
  const worker = ensureZstdWorker()
  if (!worker) return scanZstdFrames(buf, from)
  const id = ++nextScanId
  let timer: NodeJS.Timeout | null = null
  try {
    return await new Promise<FrameScan>((resolve, reject) => {
      pendingScans.set(id, { resolve, reject })
      timer = setTimeout(() => {
        if (pendingScans.delete(id)) {
          reject(new Error(`zstd worker timeout (${ZSTD_WORKER_TIMEOUT_MS}ms)`))
        }
      }, ZSTD_WORKER_TIMEOUT_MS)
      worker.postMessage({ id, buf, from })
    })
  } catch {
    await destroyZstdWorker()
    return scanZstdFrames(buf, from)
  } finally {
    if (timer) clearTimeout(timer)
    pendingScans.delete(id)
  }
}

/**
 * per-file 会话头状态缓存（key=filePath）：request/header 稀疏（仅路由/配置变化时写入），
 * 增量续读窗口常不含任何 header 行，靠上轮写回的状态消除续读盲区。
 * Node 单线程串行解析，无需锁。
 */
const sessionStateCache = new Map<string, SessionHeadState>()

/**
 * 增量解析：从 fromLine 行（1-based 行号，0 表示从文件开头）续读。
 * - .jsonl.zstd 结尾的工件按 zstd 帧增量解压：首读从 0 起整流逐帧解压；续读
 *   （fromLine>1 且游标 byteOffset 为合法帧边界）仅从该压缩字节偏移起解压新增帧，
 *   与既有行游标接续（片段首行全局行号 = fromLine）；偏移非法/中途坏帧时回退
 *   整块重析，宁可重复解析靠幂等去重兜底，不丢数据；EOF 尾部半帧（正在写入）
 *   不消费，byteOffset 只推进到最后一个完整帧末尾，其文本随补全后下轮产出；
 *   解压彻底失败 → 该文件本轮返回空结果且游标不推进（eof=true），不阻塞整体；
 * - 本轮成功解析后把安全消费到的压缩字节偏移经 storage.setCursor 写回游标
 *   （byte_offset 列，mtime 缺省保留现值、由采集器的写回负责 mtime/truncate 语义）；
 *   裸 .jsonl 工件无字节游标概念，不写回；
 * - 失败行宽松跳过不阻塞；仅「尾部不完整行」（JSON.parse 失败且其后仅剩空行，
 *   仅裸 JSONL 场景可能出现）时游标停在该行下次重试，避免丢失正在写入的内容；
 * - 会话状态机：首条 type==='session' 行取 id（sessionId）与 cwd（project），
 *   type==='request/header' 行取 data.header.config.model（当前模型，供其后的
 *   assistant/message 计费条目回落使用）；fromLine ≤ 1 全量重读时重置缓存，
 *   fromLine > 1 且与缓存的 cursorLine 精确衔接时恢复上轮状态，不衔接（如文件被
 *   truncate 游标重置）则弃用缓存按现状从头重建；本轮结束把最终状态连同 nextLine
 *   写回缓存，供下轮续读使用。
 */
async function parseFile(ctx: PluginContext, filePath: string, fromLine: number): Promise<ParsedResult> {
  let content = ''
  // lines[startIndex] 的全局物理行号：整块路径 = startIndex+1；增量片段路径 = fromLine
  let startIndex = fromLine > 0 ? fromLine - 1 : 0
  let firstLineNumber = startIndex + 1
  let incremental = false
  let consumedByteOffset: number | null = null

  if (filePath.endsWith('.jsonl.zstd')) {
    let compressed: Buffer
    try {
      compressed = await fs.promises.readFile(filePath)
    } catch {
      return { records: [], nextLine: fromLine, eof: true }
    }

    let scan: FrameScanSuccess | null = null
    if (fromLine > 1) {
      const meta = await ctx.storage.getCursorMeta(filePath)
      const saved = meta?.byteOffset
      if (typeof saved === 'number' && Number.isFinite(saved) && hasZstdMagicAt(compressed, saved)) {
        const partial = await scanZstdFramesAsync(compressed, saved)
        if (partial.ok) {
          scan = partial
          incremental = true
        }
      }
    }
    if (scan === null) {
      const full = await scanZstdFramesAsync(compressed, 0)
      if (!full.ok) {
        return { records: [], nextLine: fromLine, eof: true }
      }
      scan = full
    }
    content = scan.text
    consumedByteOffset = scan.consumedEnd
    if (incremental) {
      firstLineNumber = fromLine
      startIndex = 0
    }
  } else {
    try {
      content = await fs.promises.readFile(filePath, 'utf8')
    } catch {
      return { records: [], nextLine: fromLine, eof: true }
    }
  }

  const lines = content.split('\n')
  const records: UsageRecord[] = []
  // 当前会话状态：sessionId/project 来自首条 header 行，currentModel 来自最近的请求头行
  let sessionId: string | undefined
  let project: string | undefined
  let currentModel: string | undefined
  // fromLine ≤ 1 视为全量重读重置缓存；fromLine > 1 且与缓存游标精确衔接时恢复上轮状态，
  // 不衔接（如文件被 truncate 游标重置）则弃用缓存按现状从头重建
  const cached = sessionStateCache.get(filePath)
  if (fromLine <= 1) {
    sessionStateCache.delete(filePath)
  } else if (cached && cached.cursorLine === fromLine) {
    // 命中后先删除再于轮末重写回：活跃文件的插入位刷新到最新，近似 LRU 淘汰
    sessionStateCache.delete(filePath)
    sessionId = cached.sessionId
    project = cached.project
    currentModel = cached.currentModel
  }
  if (incremental && content.trim() === '') {
    await ctx.storage.setCursor(filePath, fromLine, undefined, consumedByteOffset)
    sessionStateCache.set(filePath, { sessionId, project, currentModel, cursorLine: fromLine })
    return { records: [], nextLine: fromLine, eof: true }
  }
  let headerSeen = false
  let nextLine = fromLine
  let eof = false

  for (let i = startIndex; i < lines.length; i++) {
    const lineNumber = firstLineNumber + (i - startIndex) // 1-based 物理行号（去重键）
    const raw = lines[i]
    if (raw.trim() === '') {
      nextLine = lineNumber + 1
      continue
    }

    let obj: unknown
    try {
      obj = JSON.parse(raw)
    } catch {
      // 其后仅剩空行（含文件以 \n 结尾时 split 的尾随空串）→ 视为尾部不完整行
      const onlyEmptyAfter = lines.slice(i + 1).every((l) => l === '')
      if (onlyEmptyAfter) {
        nextLine = lineNumber
        eof = true
        break
      }
      // 中间损坏行：宽松跳过，不阻塞
      nextLine = lineNumber + 1
      continue
    }

    if (!obj || typeof obj !== 'object') {
      nextLine = lineNumber + 1
      continue
    }
    const row = obj as Record<string, unknown>

    if (!headerSeen && row.type === 'session') {
      // header 行的 id 字段是会话 ID；cwd 为项目工作目录
      if (typeof row.id === 'string' && row.id.trim() !== '') sessionId = row.id
      if (typeof row.cwd === 'string' && row.cwd.trim() !== '') project = row.cwd
      headerSeen = true
    } else if (row.type === 'request/header') {
      // 每步 dispatch 前写入的请求头：data.header.config.model 为该步模型（宽松逐层判对象），
      // 持续生效直到下一个请求头覆盖；本行不产出计费记录，仅推进状态与游标
      const data = row.data
      if (data && typeof data === 'object') {
        const header = (data as Record<string, unknown>).header
        if (header && typeof header === 'object') {
          const config = (header as Record<string, unknown>).config
          if (config && typeof config === 'object') {
            const m = (config as Record<string, unknown>).model
            if (typeof m === 'string' && m.trim() !== '') currentModel = m.trim()
          }
        }
      }
    } else {
      const errorRecord = toRetryErrorRecord(row, filePath, lineNumber, { sessionId, project, currentModel })
      if (errorRecord) {
        records.push(errorRecord)
      } else {
        const record = toUsageRecord(row, filePath, lineNumber, { sessionId, project, currentModel })
        if (record) records.push(record)
      }
    }
    nextLine = lineNumber + 1
  }

  // 读到文件结尾即 EOF（尾部不完整行分支已置 eof）
  if (!eof) eof = true

  // 安全消费到的压缩字节偏移随游标写回（mtime 缺省保留现值，truncate/推进语义
  // 由采集器随后的 setCursor 负责）；裸 JSONL 无字节游标概念，不写回
  if (consumedByteOffset !== null) {
    await ctx.storage.setCursor(filePath, nextLine, undefined, consumedByteOffset)
  }

  // 最终会话头状态连同游标写回缓存，供下轮续读衔接；超限淘汰最早插入条目
  sessionStateCache.set(filePath, { sessionId, project, currentModel, cursorLine: nextLine })
  if (sessionStateCache.size > SESSION_STATE_CACHE_MAX) {
    const oldest = sessionStateCache.keys().next().value
    if (oldest !== undefined) sessionStateCache.delete(oldest)
  }

  return { records, nextLine, eof }
}

/** 探测：数据根存在且有会话工件 */
async function detect(): Promise<Detection> {
  return detectFromRoot(dataRootOf())
}

/** 列出待解析文件 */
async function listFiles(): Promise<FileEntry[]> {
  return listFilesFromRoot(dataRootOf())
}

/** dsh 监控插件（DeepSeek Harness） */
export const dshPlugin: MonitorPlugin = {
  id: 'dsh',
  name: 'DeepSeek Harness',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles,
  parseFile,
  dispose() {
    // 卸载即销毁解压 worker（可逆生命周期）；在途请求由 exit 分支按失败兜底
    void destroyZstdWorker()
  }
}
