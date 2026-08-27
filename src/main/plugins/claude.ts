import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'

/**
 * claude 监控插件（docs/concepts/monitor-plugins.md）。
 * 数据源：~/.claude/projects/<编码项目路径>/ 下的会话 JSONL。
 */

/** 会话根目录：~/.claude/projects（home 用 os.homedir()，不硬编码用户路径） */
function sessionRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects')
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

/** 是否候选会话文件：仅 *.jsonl，过滤临时/隐藏文件（*.tmp、*.swp、.*、*~） */
function isSessionFile(name: string): boolean {
  if (!name.endsWith('.jsonl')) return false
  if (name.startsWith('.')) return false
  return !/(?:\.tmp|\.swp|~)$/i.test(name)
}

/** 在 subagents / workflows 子树内递归收集 *.jsonl（含更深层级，如 workflows/wf_* 下） */
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

/** 会话子目录（如 <session-uuid>/）：仅进入 subagents / workflows 子树收集 */
function collectSessionSubdir(sessionDir: string, out: FileEntry[]): void {
  for (const ent of safeReaddir(sessionDir)) {
    if (!ent.isDirectory()) continue
    if (ent.name === 'subagents' || ent.name === 'workflows') {
      collectSubtree(path.join(sessionDir, ent.name), out)
    }
  }
}

/** 单个项目目录：直接子层 *.jsonl + 会话子目录内 subagents/workflows 子树 */
function collectProjectDir(projectDir: string, out: FileEntry[]): void {
  for (const ent of safeReaddir(projectDir)) {
    const p = path.join(projectDir, ent.name)
    if (ent.isFile()) {
      if (isSessionFile(ent.name)) out.push(toEntry(p))
    } else if (ent.isDirectory()) {
      collectSessionSubdir(p, out)
    }
  }
}

/**
 * 列出会话文件（root 可注入，便于测试）。
 * 范围：各编码项目目录直接子层的 *.jsonl + 更深层 subagents / workflows 目录下的 *.jsonl。
 */
export function listFilesFromRoot(root: string): FileEntry[] {
  const out: FileEntry[] = []
  for (const ent of safeReaddir(root)) {
    if (!ent.isDirectory()) continue
    collectProjectDir(path.join(root, ent.name), out)
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * 探测逻辑（root 可注入，便于测试）：会话目录是否存在。
 */
export function detectFromRoot(rootDir: string): Detection {
  let ok = false
  try {
    ok = fs.statSync(rootDir).isDirectory()
  } catch {
    ok = false
  }
  if (ok) return { available: true, sessionDir: rootDir }
  return {
    available: false,
    reason: '未找到会话目录 ~/.claude/projects（Claude Code 未安装或尚未产生会话）',
    sessionDir: rootDir
  }
}

/** 宽松取数字：缺失/非有限数 → 0 */
const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** 失败合成模型（T01 矩阵固化）：claude 失败统一归为 <synthetic>，无上游模型时兜底 */
const SYNTHETIC_MODEL = '<synthetic>'

/** 截断错误文案至 500（存储层 SSOT 为 shared/failure.ts ERROR_MESSAGE_MAX_LENGTH） */
function truncateMessage(text: string): string {
  return text.length > 500 ? text.slice(0, 500) : text
}

/** 宽松提取错误文案：优先顶层 content[0].text，其次 message.content（数组首块 text 或字符串） */
function extractErrorMessage(
  row: Record<string, unknown>,
  msg: Record<string, unknown> | null
): string | undefined {
  // 顶层 content 数组首块
  if (Array.isArray(row.content) && row.content.length > 0) {
    const first = row.content[0] as Record<string, unknown> | null
    if (first && typeof first.text === 'string' && first.text.trim() !== '') {
      return truncateMessage(first.text)
    }
  }
  if (typeof row.content === 'string' && row.content.trim() !== '') {
    return truncateMessage(row.content as string)
  }
  if (msg) {
    const mc = msg.content
    if (Array.isArray(mc) && mc.length > 0) {
      const first = mc[0] as Record<string, unknown> | null
      if (first && typeof first.text === 'string' && first.text.trim() !== '') {
        return truncateMessage(first.text)
      }
    }
    if (typeof mc === 'string' && (mc as string).trim() !== '') {
      return truncateMessage(mc as string)
    }
  }
  return undefined
}

/**
 * 失败行 → UsageRecord（T01 矩阵固化）。
 * 触发条件：顶层 isApiErrorMessage === true（严格相等）。
 * 产出：status='error'，httpStatus=apiErrorStatus（有限数字才写入），errorMessage 取
 *       顶层 content[0].text 或 message.content 文本（截断 500），tokens 四项为 0，
 *       model 取 message.model 或 <synthetic>，createdAt 取 timestamp，requestId 取
 *       message.id 或 uuid（两者皆为 string 非空才采用）。
 * 与 success 路径互斥：本函数在 parseFile 中优先于 toUsageRecord 调用；isApiErrorMessage
 * 行无论是否同时满足 success 条件均按 error 产出，不进入 success 折叠语义。
 * 性能：追加的 if 分支（isApiErrorMessage 严格相等 + 宽松取字段），无正则/全表扫描；
 *       失败行仍按单行 O(1) 解析，成功路径零额外开销。
 */
function toErrorRecord(obj: unknown, filePath: string, line: number): UsageRecord | null {
  if (!obj || typeof obj !== 'object') return null
  const row = obj as Record<string, unknown>
  if (row.isApiErrorMessage !== true) return null

  const message = row.message
  const msg = message && typeof message === 'object' ? (message as Record<string, unknown>) : null

  const httpStatusRaw = row.apiErrorStatus
  const httpStatus =
    typeof httpStatusRaw === 'number' && Number.isFinite(httpStatusRaw) ? httpStatusRaw : undefined

  const errorMessage = extractErrorMessage(row, msg)

  let model: string
  if (msg && typeof msg.model === 'string' && msg.model.trim() !== '') {
    model = msg.model.trim()
  } else {
    model = SYNTHETIC_MODEL
  }

  let requestId: string | undefined
  if (msg && typeof msg.id === 'string' && msg.id.trim() !== '') {
    requestId = msg.id.trim()
  } else if (typeof row.uuid === 'string' && row.uuid.trim() !== '') {
    requestId = row.uuid.trim()
  } else if (typeof row.id === 'string' && (row.id as string).trim() !== '') {
    requestId = (row.id as string).trim()
  }

  const ts = typeof row.timestamp === 'string' ? row.timestamp : ''
  const parsed = ts ? Date.parse(ts) : NaN

  return {
    appType: 'claude',
    model,
    rawModel: model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    inputSemantics: 2,
    status: 'error',
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    createdAt: Number.isNaN(parsed) ? Date.now() : parsed,
    project: typeof row.cwd === 'string' ? row.cwd : undefined,
    sessionId: typeof row.sessionId === 'string' ? row.sessionId : undefined,
    source: { filePath, line, ...(requestId ? { requestId } : {}) }
  }
}

/**
 * 单行 JSON → UsageRecord。
 * 仅 type==='assistant' 且 message.usage 存在时产出；
 * 无 model 或 usage 缺失的行返回 null（跳过，不阻塞整体）。
 * message.id（上游消息 UUID）作为稳定语义请求 ID 写入 source.requestId：
 * fork/compact 后同一逻辑消息会同时存在于主会话与 subagents/workflows 子树文件，
 * (file,line) 主键去重无法识别，storage 按 (data_source, request_id) 语义判重；
 * id 缺失/非字符串时不设置，退回旧 (file,line) 主键去重。
 */
function toUsageRecord(obj: unknown, filePath: string, line: number): UsageRecord | null {
  if (!obj || typeof obj !== 'object') return null
  const row = obj as Record<string, unknown>
  if (row.type !== 'assistant') return null

  const message = row.message
  if (!message || typeof message !== 'object') return null
  const msg = message as Record<string, unknown>

  const model = typeof msg.model === 'string' ? msg.model.trim() : ''
  if (!model) return null // 无 model 行跳过

  const usage = msg.usage
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>

  // 宽松取语义请求 ID：string 且非空才采用
  const requestId = typeof msg.id === 'string' && msg.id.trim() !== '' ? msg.id.trim() : undefined

  const ts = typeof row.timestamp === 'string' ? row.timestamp : ''
  const parsed = ts ? Date.parse(ts) : NaN

  return {
    appType: 'claude',
    model,
    rawModel: model,
    inputTokens: toNum(u.input_tokens),
    outputTokens: toNum(u.output_tokens),
    cacheReadTokens: toNum(u.cache_read_input_tokens),
    cacheCreationTokens: toNum(u.cache_creation_input_tokens),
    inputSemantics: 2, // 纯新输入
    status: 'success',
    createdAt: Number.isNaN(parsed) ? Date.now() : parsed,
    project: typeof row.cwd === 'string' ? row.cwd : undefined,
    sessionId: typeof row.sessionId === 'string' ? row.sessionId : undefined,
    source: { filePath, line, ...(requestId ? { requestId } : {}) }
  }
}

/**
 * 按 message.id 折叠同一 API 调用的流式分片（纯函数，导出便于测试）。
 * 依据（Claude Code 2.1.x 社区多源实测）：一条 assistant 消息按 content block 逐行写入 JSONL，
 * 同一调用的各行共享相同 message.id 与顶层 requestId，message.usage 中 input/cache_read/cache_creation
 * 各行一致，而 output_tokens 随流式单调增长（最终值在最后一行）；逐行直录会把同一请求的 output
 * 重复累计（约 2.4 倍高估）。
 * 规则：
 * - 无 requestId 的记录不折叠，直接产出（旧行为）；
 * - 有 requestId 的按首次出现顺序占位，后续行 outputTokens ≥ 已存值时整体替换该占位
 *   （取 ≥ 保证同值后到也覆盖，时间戳/source 行号随最新行更新；流式单调增长 → 最终保留 final 行）；
 * - 后续行 outputTokens 更小视为乱序残留，直接丢弃；
 * - 不同 requestId 互不影响。
 * 边界：一轮 API 的各行被拆进两次解析批次（极罕见：watcher 500ms 防抖 + 一轮写完才触发）时，
 * 首批 partial 已入库、后续 final 会被 storage 按 requestId 判重拦截，残留 partial 误差可接受，
 * 不做跨批修复（YAGNI）。
 */
export function foldById(records: UsageRecord[]): UsageRecord[] {
  const out: UsageRecord[] = []
  // requestId → 该请求在 out 中占位的下标（替换时位置不变）
  const slots = new Map<string, number>()
  for (const rec of records) {
    // 失败记录按 message.id 独立，不参与 success 流式折叠（避免吞并）
    if (rec.status === 'error') {
      out.push(rec)
      continue
    }
    const rid = rec.source.requestId
    if (!rid) {
      out.push(rec)
      continue
    }
    const existing = slots.get(rid)
    if (existing === undefined) {
      slots.set(rid, out.length)
      out.push(rec)
    } else if (rec.outputTokens >= out[existing].outputTokens) {
      out[existing] = rec
    }
  }
  return out
}

/**
 * 增量解析：从 fromLine 行（1-based 行号，0 表示从文件开头）续读。
 * - 失败行宽松跳过不阻塞；仅「尾部不完整行」（JSON.parse 失败且其后仅剩空行）
 *   时游标停在最后一个成功解析行之后（= 该失败行），下次从该行重试，避免丢失正在写入的内容。
 * - eof：读到文件结尾即 true（含尾部不完整行也算 EOF）。
 * - 本批解析出的记录先经 foldById 折叠流式分片再产出（见 foldById 说明）。
 */
async function parseFile(
  _ctx: PluginContext,
  filePath: string,
  fromLine: number
): Promise<ParsedResult> {
  let content: string
  try {
    content = await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return { records: [], nextLine: fromLine, eof: true }
  }

  const lines = content.split('\n')
  // 折叠缓冲：同批解析的记录先收集，循环结束后按 message.id 折叠再产出
  const buffered: UsageRecord[] = []
  let nextLine = fromLine
  let eof = false

  // fromLine/nextLine 均为 1-based 行号（0 = 从开头）；换算为 0-based 数组索引
  const startIndex = fromLine > 0 ? fromLine - 1 : 0
  for (let i = startIndex; i < lines.length; i++) {
    const lineNumber = i + 1 // 1-based，绝对行号（去重键）
    const raw = lines[i]
    if (raw.trim() === '') {
      nextLine = lineNumber + 1
      continue
    }

    let obj: unknown
    try {
      obj = JSON.parse(raw)
    } catch {
      // 其后仅剩空行（文件以 \n 结尾时 split 的尾随空串）→ 视为尾部不完整行
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

    // 失败路径优先（T01 矩阵）：isApiErrorMessage === true 产出 error 记录，与 success 互斥
    const errorRecord = toErrorRecord(obj, filePath, lineNumber)
    if (errorRecord) {
      buffered.push(errorRecord)
      nextLine = lineNumber + 1
      continue
    }
    const record = toUsageRecord(obj, filePath, lineNumber)
    if (record) buffered.push(record)
    nextLine = lineNumber + 1
  }

  // 读到文件结尾即 EOF（尾部不完整行分支已置 eof）
  if (!eof) eof = true

  const records = foldById(buffered)
  return { records, nextLine, eof }
}

/** 探测：~/.claude/projects 目录是否存在 */
async function detect(): Promise<Detection> {
  return detectFromRoot(sessionRoot())
}

/** claude 监控插件（docs/concepts/monitor-plugins.md，T8） */
export const claudePlugin: MonitorPlugin = {
  id: 'claude',
  name: 'Claude Code',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles: async () => listFilesFromRoot(sessionRoot()),
  parseFile
}
