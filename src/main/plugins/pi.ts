import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'
import { ERROR_MESSAGE_MAX_LENGTH, isIgnoredFailureReason } from '../../../shared/failure'

/**
 * pi 监控插件（Pi Coding Agent，earendil-works 开源 TUI agent harness）。
 * 数据源：~/.pi/agent/sessions/（$PI_CODING_AGENT_DIR 覆盖的是根目录，sessions 位于其下），
 * 按工作目录组织为 --<路径编码>--/<timestamp>_<uuid>.jsonl，子树任意层级均可有 .jsonl。
 * 格式来源：pi 官方文档 + earendil-works/pi session.md：
 * - 首行 header { type:'session', id, cwd?, ... }（无 id/parentId），后续每行一条树形条目
 *   { type, id, parentId, ... }，类型含 message / compaction / branch_summary / custom 等；
 * - 计费条目：type==='message' 且 message.role==='assistant' 且 message.usage 为对象，
 *   usage 四桶 input/output/cacheRead/cacheWrite 互不重叠（disjoint）；
 * - 上游自带 usage.cost 不采用：统一走本地定价计算，保证各 CLI 口径一致。
 */

/** 数据根下 sessions 目录：$PI_CODING_AGENT_DIR 覆盖根目录（trim 非空才用），默认 ~/.pi/agent/sessions */
export function dataRootOf(): string {
  const override = process.env.PI_CODING_AGENT_DIR
  if (override && override.trim() !== '') return path.join(override.trim(), 'sessions')
  return path.join(os.homedir(), '.pi', 'agent', 'sessions')
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

/** sessions 子树递归收集 *.jsonl（目录编码层与更深层级均收集） */
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
 * 探测用存在性短路检查：找到首个会话文件即返回 true。
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
 * 列出会话文件（root 可注入，便于测试）：sessions 子树内任意层级的 *.jsonl。
 * fork 提取分支会创建新文件 → 同一逻辑条目可跨文件出现，
 * 由条目 id 作 requestId 经语义去重收敛（见 toUsageRecord）。
 */
export function listFilesFromRoot(root: string): FileEntry[] {
  const out: FileEntry[] = []
  collectSubtree(root, out)
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * 探测逻辑（root 可注入，便于测试）：数据根存在且至少列出一个会话文件即 available。
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
      reason:
        '未找到会话目录 ~/.pi/agent/sessions（可用 $PI_CODING_AGENT_DIR 覆盖根目录；Pi 未安装或尚未产生会话）',
      sessionDir: root
    }
  }
  if (!hasSessionFile(root)) {
    return {
      available: false,
      reason: '会话目录下未发现 *.jsonl 会话文件（Pi 尚未产生会话）',
      sessionDir: root
    }
  }
  return { available: true, sessionDir: root }
}

/** 宽松取数字：缺失/非有限数 → 0 */
const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** 截断错误文案至 500（存储层 SSOT 为 shared/failure.ts ERROR_MESSAGE_MAX_LENGTH） */
function truncateMessage(text: string): string {
  return text.length > ERROR_MESSAGE_MAX_LENGTH ? text.slice(0, ERROR_MESSAGE_MAX_LENGTH) : text
}

/** 宽松提取 httpStatus：遍历候选 key，取首个有限数字（字符串数字亦兼容） */
function extractHttpStatus(entry: Record<string, unknown>, msg: Record<string, unknown>): number | undefined {
  const pools: unknown[] = [
    entry.httpStatus,
    entry.http_status,
    (entry as Record<string, unknown>).httpStatusCode,
    (entry as Record<string, unknown>).http_status_code,
    entry.statusCode,
    entry.status_code,
    entry.code,
    msg.httpStatus,
    msg.http_status,
    (msg as Record<string, unknown>).httpStatusCode,
    (msg as Record<string, unknown>).http_status_code,
    msg.statusCode,
    msg.status_code,
    msg.code
  ]
  // 嵌套 error 对象内亦尝试
  for (const holder of [entry.error, msg.error, (entry as Record<string, unknown>).errorMessage, (msg as Record<string, unknown>).errorMessage]) {
    if (holder && typeof holder === 'object') {
      const o = holder as Record<string, unknown>
      const raw = o.httpStatus ?? o.http_status ?? o.statusCode ?? o.status_code ?? o.code ?? o.status
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw
      if (typeof raw === 'string' && raw.trim() !== '') {
        const n = Number(raw.trim())
        if (Number.isFinite(n)) return n
      }
    }
  }
  for (const raw of pools) {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
    if (typeof raw === 'string' && raw.trim() !== '') {
      const n = Number(raw.trim())
      if (Number.isFinite(n)) return n
    }
  }
  return undefined
}

/** 宽松提取错误文案（pi）：优先 entry/msg 的 error 字段，无显式错误时以 status 文案兜底 */
function extractErrorMessage(entry: Record<string, unknown>, msg: Record<string, unknown>): string | undefined {
  const candidates: unknown[] = [
    entry.error,
    (entry as Record<string, unknown>).errorMessage,
    (entry as Record<string, unknown>).error_message,
    msg.error,
    (msg as Record<string, unknown>).errorMessage,
    (msg as Record<string, unknown>).error_message
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
  // status 非 success/completed/ok 时以 status 文案作为错误文案兜底（参考 grok/opencode 宽松探测）
  const statusCandidates = [
    entry.status,
    (entry as Record<string, unknown>).state,
    msg.status,
    (msg as Record<string, unknown>).state
  ]
  for (const s of statusCandidates) {
    if (typeof s === 'string' && s.trim() !== '' && !['success', 'completed', 'ok'].includes(s.trim().toLowerCase())) {
      return truncateMessage(s.trim())
    }
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
 * 检测 pi 条目是否属失败：含 error/isError/失败状态的 assistant 消息
 * 性能：追加的宽松 if 分支，线性遍历少量候选 key + 字符串比较，无正则/全表扫描；
 *       中断忽略为轻量 includes，单行 O(1) 判定，成功路径零额外开销。
 */
function detectPiFailure(
  entry: Record<string, unknown>,
  msg: Record<string, unknown>
): { isFailure: boolean; errorMessage?: string; httpStatus?: number; isIgnored: boolean } {
  const isNonEmpty = (v: unknown): boolean => {
    if (v === undefined || v === null) return false
    if (typeof v === 'string' && v.trim() === '') return false
    return true
  }
  const hasErrorField =
    isNonEmpty(entry.error) ||
    isNonEmpty((entry as Record<string, unknown>).errorMessage) ||
    isNonEmpty((entry as Record<string, unknown>).error_message) ||
    isNonEmpty(msg.error) ||
    isNonEmpty((msg as Record<string, unknown>).errorMessage) ||
    isNonEmpty((msg as Record<string, unknown>).error_message)

  const isErrorFlag = entry.isError === true || (entry as Record<string, unknown>).is_error === true || msg.isError === true || (msg as Record<string, unknown>).is_error === true

  let statusIsFailure = false
  const statusCandidates = [entry.status, (entry as Record<string, unknown>).state, msg.status, (msg as Record<string, unknown>).state]
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

  const isFailure = Boolean(hasErrorField || isErrorFlag || statusIsFailure)
  if (!isFailure) return { isFailure: false, isIgnored: false }

  const errorMessage = extractErrorMessage(entry, msg)
  const httpStatus = extractHttpStatus(entry, msg)

  const checkTexts: string[] = []
  if (errorMessage) checkTexts.push(errorMessage)
  for (const s of statusCandidates) if (typeof s === 'string') checkTexts.push(s)
  for (const e of [entry.error, msg.error, (entry as Record<string, unknown>).errorMessage, (msg as Record<string, unknown>).errorMessage]) {
    if (typeof e === 'string') checkTexts.push(e)
    else if (e && typeof e === 'object') {
      const o = e as Record<string, unknown>
      const inner = o.message ?? o.error ?? o.type ?? o.code ?? o.status
      if (typeof inner === 'string') checkTexts.push(inner)
    }
  }
  // isError 标记本身不含文本，仍需检查相邻文案
  const isIgnored = checkTexts.some((t) => isIgnoredText(t))

  return { isFailure, errorMessage, httpStatus, isIgnored }
}

/**
 * 单个 message 条目 → UsageRecord。
 * 成功路径：仅 message.role==='assistant' 且 message.usage 为对象时产出；
 * 失败路径：含 error/isError/失败状态的 assistant 消息宽松产出 error 记录（tokens 保留原值或全 0，model 缺失时兜底 unknown）。
 * 无 model 且非失败的条目返回 null（跳过该条，不阻塞整体）。
 * 条目 id（上游 UUID）作为稳定语义请求 ID 写入 source.requestId：
 * fork 提取分支会把同一逻辑条目复制进新文件，(file,line) 主键去重无法识别，
 * storage 按 (data_source, request_id) 语义判重；id 缺失时不设置，退回旧主键去重。
 */
function toUsageRecord(
  entry: Record<string, unknown>,
  filePath: string,
  line: number,
  session: { sessionId?: string; project?: string }
): UsageRecord | null {
  if (entry.type !== 'message') return null

  const message = entry.message
  if (!message || typeof message !== 'object') return null
  const msg = message as Record<string, unknown>
  if (msg.role !== 'assistant') return null

  const rawModel = typeof msg.model === 'string' ? msg.model.trim() : ''
  // 宽松取语义请求 ID：string 且非空才采用
  const requestId = typeof entry.id === 'string' && entry.id.trim() !== '' ? entry.id.trim() : undefined

  // createdAt：条目级或 message 内 epoch ms，number 有效优先（条目级优先）；均无效兜底当前时间
  let createdAt = toNum(entry.timestamp)
  if (createdAt <= 0) createdAt = toNum(msg.timestamp)
  if (createdAt <= 0) createdAt = Date.now()

  // 宽松失败分支（T01 pi 宽松探测）：条目含 error/isError/失败状态的 assistant 消息判 error
  const failure = detectPiFailure(entry, msg)
  if (failure.isFailure) {
    if (failure.isIgnored) return null
    const model = rawModel || 'unknown'
    // 失败时保留原 tokens（如有），缺失则全 0
    const usage = msg.usage && typeof msg.usage === 'object' ? (msg.usage as Record<string, unknown>) : null
    const u = usage ?? {}
    return {
      appType: 'pi',
      model,
      rawModel: model,
      inputTokens: toNum(u.input),
      outputTokens: toNum(u.output),
      cacheReadTokens: toNum(u.cacheRead),
      cacheCreationTokens: toNum(u.cacheWrite),
      inputSemantics: 2,
      status: 'error',
      ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
      ...(failure.errorMessage !== undefined ? { errorMessage: failure.errorMessage } : {}),
      createdAt,
      project: session.project,
      sessionId: session.sessionId,
      source: { filePath, line, ...(requestId ? { requestId } : {}) }
    }
  }

  if (!rawModel) return null // 无 model 的成功条目跳过

  const usage = msg.usage
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>

  return {
    appType: 'pi',
    model: rawModel,
    rawModel: rawModel,
    inputTokens: toNum(u.input),
    outputTokens: toNum(u.output),
    cacheReadTokens: toNum(u.cacheRead),
    cacheCreationTokens: toNum(u.cacheWrite),
    // pi 的 usage 四桶互不重叠(disjoint),input 即纯新输入 → semantics=2(pricing 不再扣减);
    // 自带 usage.cost 不预填,费用统一由本地 pricing 计算
    inputSemantics: 2,
    status: 'success',
    createdAt,
    project: session.project,
    sessionId: session.sessionId,
    source: { filePath, line, ...(requestId ? { requestId } : {}) }
  }
}

/**
 * 增量解析：从 fromLine 行（1-based 行号，0 表示从文件开头）续读。
 * - 失败行宽松跳过不阻塞；仅「尾部不完整行」（JSON.parse 失败且其后仅剩空行）
 *   时游标停在该行下次重试，避免丢失正在写入的内容；
 * - 会话状态机：首条 type==='session' 行取 id（sessionId）与 cwd（project），
 *   后续 message 条目统一取当前状态；增量续读越过 header 时状态缺失，
 *   sessionId/project 保持 undefined（与 gemini JSONL 同语义）。
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
  const records: UsageRecord[] = []
  // 当前会话状态：来自首条 header 行，供后续 message 条目取用
  let sessionId: string | undefined
  let project: string | undefined
  let headerSeen = false
  let nextLine = fromLine
  let eof = false

  // fromLine/nextLine 均为 1-based 行号（0 = 从开头）；换算为 0-based 数组索引
  const startIndex = fromLine > 0 ? fromLine - 1 : 0
  for (let i = startIndex; i < lines.length; i++) {
    const lineNumber = i + 1 // 1-based 物理行号（去重键）
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
      // header 行的 id 字段是会话 ID（非条目 ID）；cwd 为项目工作目录
      if (typeof row.id === 'string' && row.id.trim() !== '') sessionId = row.id
      if (typeof row.cwd === 'string' && row.cwd.trim() !== '') project = row.cwd
      headerSeen = true
    } else {
      const record = toUsageRecord(row, filePath, lineNumber, { sessionId, project })
      if (record) records.push(record)
    }
    nextLine = lineNumber + 1
  }

  // 读到文件结尾即 EOF（尾部不完整行分支已置 eof）
  if (!eof) eof = true

  return { records, nextLine, eof }
}

/** 探测：数据根存在且有会话文件 */
async function detect(): Promise<Detection> {
  return detectFromRoot(dataRootOf())
}

/** 列出待解析文件 */
async function listFiles(): Promise<FileEntry[]> {
  return listFilesFromRoot(dataRootOf())
}

/** pi 监控插件（Pi Coding Agent） */
export const piPlugin: MonitorPlugin = {
  id: 'pi',
  name: 'Pi Coding Agent',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles,
  parseFile
}
