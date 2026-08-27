import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'
import { ERROR_MESSAGE_MAX_LENGTH, isIgnoredFailureReason } from '../../../shared/failure'

/**
 * grok 监控插件（docs/concepts/monitor-plugins.md）。
 * 数据源：
 * - ~/.grok/logs/unified.jsonl        事件日志（JSONL），产出用量记录
 * - ~/.grok/sessions/任意层级/summary.json  会话摘要，建「sessionId→模型」映射
 * 根目录可用 GROK_HOME 覆盖，默认 ~/.grok（home 用 os.homedir()，不硬编码用户路径）。
 */

/** 根目录：GROK_HOME 覆盖，默认 ~/.grok */
function grokRoot(): string {
  const env = process.env.GROK_HOME
  if (env && env.trim()) return env.trim()
  return path.join(os.homedir(), '.grok')
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

/** 文件是否为常规文件（不存在/无权限 → false） */
function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** 临时文件过滤：*.tmp、*.swp、.*、*~（过滤正在写入/编辑器残留） */
function isTempFile(name: string): boolean {
  if (name.startsWith('.')) return true
  return /(?:\.tmp|\.swp|~)$/i.test(name)
}

/** 是否候选 summary 文件：名为 summary.json 且非临时 */
function isSummaryFile(name: string): boolean {
  return name === 'summary.json' && !isTempFile(name)
}

/** 在 sessions 子树内递归收集 summary.json（含更深层级，如 sessions/2026/08/abc） */
function collectSummaries(dir: string, out: FileEntry[]): void {
  for (const ent of safeReaddir(dir)) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      collectSummaries(p, out)
    } else if (ent.isFile() && isSummaryFile(ent.name)) {
      out.push(toEntry(p))
    }
  }
}

/**
 * 列出待解析文件（root 可注入，便于测试）。
 * 范围：~/.grok/logs/unified.jsonl（若存在）+ sessions 子树全部 summary.json。
 */
export function listFilesFromRoot(root: string): FileEntry[] {
  const out: FileEntry[] = []
  const logFile = path.join(root, 'logs', 'unified.jsonl')
  if (!isTempFile(path.basename(logFile)) && isFile(logFile)) out.push(toEntry(logFile))
  collectSummaries(path.join(root, 'sessions'), out)
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * 探测逻辑（root 可注入，便于测试）：仅当 root 存在且
 * （logs/unified.jsonl 存在 或 sessions 目录存在）时可用；否则不可用（reason 保留）。
 */
export function detectFromRoot(root: string): Detection {
  if (isFile(path.join(root, 'logs', 'unified.jsonl'))) {
    return { available: true, sessionDir: root }
  }
  try {
    if (fs.statSync(path.join(root, 'sessions')).isDirectory()) {
      return { available: true, sessionDir: root }
    }
  } catch {
    // ignore
  }
  return {
    available: false,
    reason: '未找到 ~/.grok（Grok Build 未安装或尚未产生会话数据）',
    sessionDir: root
  }
}

/** 读取 summary.json 的 current_model_id（解析失败/缺失 → undefined） */
function readCurrentModel(p: string): string | undefined {
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
    const m = obj.current_model_id
    if (typeof m === 'string' && m.trim()) return m.trim()
  } catch {
    // ignore
  }
  return undefined
}

/** sessionId → 模型 映射缓存（loadModelMap 重建，parseFile 消费；每轮同步经 listFiles 刷新） */
let modelMap = new Map<string, string>()

/** 上次映射构建时的 summary.json 清单签名（path:mtime 拼接）；一致则跳过重读重建 */
let lastSummarySignature: string | null = null

/**
 * 建立 sessionId → 模型 映射（root 可注入，便于测试）。
 * 递归收集 ~/.grok/sessions/任意层级/summary.json，取 current_model_id；会话目录名即 sessionId。
 * 以「清单 path+mtime 签名」做增量短路：清单未变化时直接复用上次映射，
 * 避免每轮同步对全部 summary.json 重读重析（listFiles 每轮调用，会话数多时为主进程热点）。
 * 由本插件在每轮同步 listFiles 开始处刷新；导出仅供测试直接调用。
 */
export async function loadModelMap(root: string): Promise<Map<string, string>> {
  const summaries: FileEntry[] = []
  collectSummaries(path.join(root, 'sessions'), summaries)
  const signature = summaries.map((e) => `${e.path}:${e.mtime}`).join('\n')
  if (signature === lastSummarySignature) return modelMap

  const map = new Map<string, string>()
  for (const e of summaries) {
    const sessionId = path.basename(path.dirname(e.path))
    if (!sessionId) continue
    const model = readCurrentModel(e.path)
    if (model) map.set(sessionId, model)
  }
  modelMap = map
  lastSummarySignature = signature
  return map
}

/** 宽松取数字：缺失/非有限数 → 0 */
const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** 截断错误文案至 500（存储层 SSOT 为 shared/failure.ts ERROR_MESSAGE_MAX_LENGTH） */
function truncateMessage(text: string): string {
  return text.length > ERROR_MESSAGE_MAX_LENGTH ? text.slice(0, ERROR_MESSAGE_MAX_LENGTH) : text
}

/** 宽松提取 httpStatus：遍历候选 key，取首个有限数字（字符串数字亦兼容） */
function extractHttpStatus(row: Record<string, unknown>, ctx: Record<string, unknown>): number | undefined {
  const candidates = [
    row.httpStatus,
    row.http_status,
    (row as Record<string, unknown>).http_status_code,
    (row as Record<string, unknown>).httpStatusCode,
    row.statusCode,
    row.status_code,
    ctx.httpStatus,
    ctx.http_status,
    (ctx as Record<string, unknown>).http_status_code,
    (ctx as Record<string, unknown>).httpStatusCode,
    ctx.statusCode,
    ctx.status_code
  ]
  for (const raw of candidates) {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
    if (typeof raw === 'string' && raw.trim() !== '') {
      const n = Number(raw.trim())
      if (Number.isFinite(n)) return n
    }
  }
  // 嵌套 error 对象内亦尝试
  for (const holder of [row.error, ctx.error, (row as Record<string, unknown>).errorMessage, ctx.errorMessage]) {
    if (holder && typeof holder === 'object') {
      const o = holder as Record<string, unknown>
      const raw = o.httpStatus ?? o.http_status ?? o.statusCode ?? o.status_code ?? o.code
      if (typeof raw === 'number' && Number.isFinite(raw)) return raw
      if (typeof raw === 'string' && raw.trim() !== '') {
        const n = Number(raw.trim())
        if (Number.isFinite(n)) return n
      }
    }
  }
  return undefined
}

/** 宽松提取错误文案：优先 error 字段，其次 errorMessage/error_message/message */
function extractErrorMessage(row: Record<string, unknown>, ctx: Record<string, unknown>): string | undefined {
  const candidates: unknown[] = [
    row.error,
    (row as Record<string, unknown>).errorMessage,
    (row as Record<string, unknown>).error_message,
    ctx.error,
    (ctx as Record<string, unknown>).errorMessage,
    (ctx as Record<string, unknown>).error_message,
    (row as Record<string, unknown>).message,
    ctx.message
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
  // status 非 success 时以 status 文案作为错误文案兜底
  const statusRaw = (row.status ?? ctx.status) as unknown
  if (typeof statusRaw === 'string' && statusRaw.trim() !== '' && statusRaw.trim().toLowerCase() !== 'success') {
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
 * 检测 inference_done 行是否属失败：存在 error 字段或 status 非 success
 * 性能：追加的宽松 if 分支，线性遍历少量候选 key + 字符串比较，无正则/全表扫描；
 *       失败文案截断为单次 slice，单行 O(1) 判定，成功路径仅多一次非空检查。
 */
function detectGrokFailure(row: Record<string, unknown>, ctx: Record<string, unknown>): {
  isFailure: boolean
  errorMessage?: string
  httpStatus?: number
  isIgnored: boolean
} {
  const isNonEmpty = (v: unknown): boolean => {
    if (v === undefined || v === null) return false
    if (typeof v === 'string' && v.trim() === '') return false
    return true
  }
  const hasErrorField =
    isNonEmpty(row.error) ||
    isNonEmpty((row as Record<string, unknown>).errorMessage) ||
    isNonEmpty((row as Record<string, unknown>).error_message) ||
    isNonEmpty(ctx.error) ||
    isNonEmpty((ctx as Record<string, unknown>).errorMessage) ||
    isNonEmpty((ctx as Record<string, unknown>).error_message)

  let statusIsFailure = false
  const statusCandidates = [row.status, ctx.status]
  for (const s of statusCandidates) {
    if (typeof s === 'string' && s.trim() !== '' && s.trim().toLowerCase() !== 'success') {
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

  const errorMessage = extractErrorMessage(row, ctx)
  const httpStatus = extractHttpStatus(row, ctx)

  // 中断忽略：error 文案或 status 文案包含 cancelled/interrupted 时忽略
  const checkTexts: string[] = []
  if (errorMessage) checkTexts.push(errorMessage)
  for (const s of statusCandidates) if (typeof s === 'string') checkTexts.push(s)
  for (const e of [row.error, ctx.error, (row as Record<string, unknown>).errorMessage, (ctx as Record<string, unknown>).errorMessage]) {
    if (typeof e === 'string') checkTexts.push(e)
    else if (e && typeof e === 'object') {
      const o = e as Record<string, unknown>
      const inner = o.message ?? o.error ?? o.type ?? o.code
      if (typeof inner === 'string') checkTexts.push(inner)
    }
  }
  const isIgnored = checkTexts.some((t) => isIgnoredText(t))

  return { isFailure, errorMessage, httpStatus, isIgnored }
}

/** 宽松取行时间：timestamp/ts/time（行或 ctx），全部失败 → Date.now() */
function extractTime(row: Record<string, unknown>, ctx: Record<string, unknown>): number {
  for (const key of ['timestamp', 'ts', 'time']) {
    const v = row[key] ?? ctx[key]
    if (typeof v === 'number' && Number.isFinite(v)) {
      return v < 1e12 ? v * 1000 : v // 秒 → 毫秒兜底
    }
    if (typeof v === 'string') {
      const t = Date.parse(v)
      if (!Number.isNaN(t)) return t
    }
  }
  return Date.now()
}

/**
 * 单行 JSON → UsageRecord。
 * 仅 msg==='shell.turn.inference_done' 且 ctx 存在、且 sessionId 有模型映射时产出；
 * 无映射 / 缺字段 / 非目标事件返回 null（宽松跳过，不阻塞整体）。
 */
function toUsageRecord(obj: unknown, filePath: string, line: number): UsageRecord | null {
  if (!obj || typeof obj !== 'object') return null
  const row = obj as Record<string, unknown>
  if (row.msg !== 'shell.turn.inference_done') return null

  const ctx = row.ctx
  if (!ctx || typeof ctx !== 'object') return null
  const c = ctx as Record<string, unknown>

  const sessionId = typeof row.sessionId === 'string' && row.sessionId ? row.sessionId : undefined
  const model = sessionId ? modelMap.get(sessionId) : undefined
  if (!model) return null // 无模型映射 → 跳过（下一轮同步重建映射后即可匹配）

  // 语义请求 ID："<sid>:<loop_index>"。unified.jsonl 为 append-only 日志，同一次推理调用
  // 只会出现一行相同 (sid, ctx.loop_index)，组合键跨轮稳定、可唯一标识该次调用；
  // 任一成分缺失（sid 空白 / loop_index 非有限数）则不设置，退回 (file_path, line) 主键去重
  const rawSid = typeof row.sid === 'string' ? row.sid.trim() : ''
  const loop = c.loop_index
  const loopIndex = typeof loop === 'number' && Number.isFinite(loop) ? loop : undefined
  const requestId = rawSid && loopIndex !== undefined ? `${rawSid}:${loopIndex}` : undefined

  // 宽松失败分支（T01 grok 宽松探测）：含 error 字段或 status 非 success 的 inference_done 行判 error
  const failure = detectGrokFailure(row, c)
  if (failure.isFailure) {
    if (failure.isIgnored) return null
    return {
      appType: 'grok',
      model,
      rawModel: model,
      // 失败时保留原 tokens（如有），缺失则 0（满足“全 0 或保留原 tokens”契约）
      inputTokens: toNum(c.prompt_tokens),
      outputTokens: toNum(c.completion_tokens),
      cacheReadTokens: toNum(c.cached_prompt_tokens),
      cacheCreationTokens: 0,
      inputSemantics: 1, // TOTAL：prompt_tokens 含缓存读
      status: 'error',
      ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
      ...(failure.errorMessage !== undefined ? { errorMessage: failure.errorMessage } : {}),
      createdAt: extractTime(row, c),
      project: typeof row.project === 'string' ? row.project : typeof row.cwd === 'string' ? row.cwd : undefined,
      sessionId,
      source: requestId ? { filePath, line, requestId } : { filePath, line }
    }
  }

  return {
    appType: 'grok',
    model,
    rawModel: model,
    inputTokens: toNum(c.prompt_tokens),
    outputTokens: toNum(c.completion_tokens),
    cacheReadTokens: toNum(c.cached_prompt_tokens),
    cacheCreationTokens: 0,
    inputSemantics: 1, // TOTAL：prompt_tokens 含缓存读
    status: 'success',
    createdAt: extractTime(row, c),
    project: typeof row.project === 'string' ? row.project : typeof row.cwd === 'string' ? row.cwd : undefined,
    sessionId,
    source: requestId ? { filePath, line, requestId } : { filePath, line }
  }
}

/**
 * 增量解析：从 fromLine 行（1-based 行号，0 表示从文件开头）续读。
 * - unified.jsonl：逐行 JSON.parse，遇 msg==='shell.turn.inference_done' 且 ctx 存在时产出记录
 *   （模型取自 sessionId→模型 映射，无映射跳过）；失败行宽松跳过不阻塞；
 *   「尾部不完整行」（JSON.parse 失败且其后仅剩空行）时游标停在该行，下次从该行重试。
 * - summary.json：不产出记录，仅推进到文件尾（映射由每轮同步 listFiles 时的 loadModelMap 重建）。
 * - eof：读到文件结尾即 true（含尾部不完整行也算 EOF）。
 */
async function parseFile(
  _ctx: PluginContext,
  filePath: string,
  fromLine: number
): Promise<ParsedResult> {
  if (filePath.endsWith('summary.json')) {
    return { records: [], nextLine: fromLine, eof: true }
  }
  if (!filePath.endsWith('unified.jsonl')) {
    return { records: [], nextLine: fromLine, eof: true }
  }

  let content: string
  try {
    content = await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return { records: [], nextLine: fromLine, eof: true }
  }

  const lines = content.split('\n')
  const records: UsageRecord[] = []
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

    const record = toUsageRecord(obj, filePath, lineNumber)
    if (record) records.push(record)
    nextLine = lineNumber + 1
  }

  // 读到文件结尾即 EOF（尾部不完整行分支已置 eof）
  if (!eof) eof = true

  return { records, nextLine, eof }
}

/** 探测：unified.jsonl 或 sessions 目录存在 */
async function detect(): Promise<Detection> {
  return detectFromRoot(grokRoot())
}

/** grok 监控插件（docs/concepts/monitor-plugins.md，T12） */
export const grokPlugin: MonitorPlugin = {
  id: 'grok',
  name: 'Grok Build',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles: async () => {
    // 每轮同步开始处无条件重建 sessionId→模型 映射：summary.json 的新增/变更在本轮即生效
    const root = grokRoot()
    await loadModelMap(root)
    return listFilesFromRoot(root)
  },
  parseFile
}
