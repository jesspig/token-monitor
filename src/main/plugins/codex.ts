import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'

/**
 * codex 监控插件（docs/concepts/monitor-plugins.md）。
 * 数据源：~/.codex/sessions/ 下按日期分区（YYYY/MM/DD/）的 rollout-*.jsonl，
 * 含 archived_sessions/ 旧归档。
 * 每行 JSON：{ type, timestamp, payload }；token 用量在
 * type==='event_msg' 且 payload.type==='token_count' 的 payload.info.last_token_usage。
 */

/** 会话根目录：~/.codex/sessions（home 用 os.homedir()，不硬编码用户路径） */
function sessionRoot(): string {
  return path.join(os.homedir(), '.codex', 'sessions')
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

/** 递归收集目录下全部候选 *.jsonl（日期分区 YYYY/MM/DD 与 archived_sessions/ 任意深度） */
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
 * 列出会话文件（root 可注入，便于测试）。
 * 递归扫描 sessions 下全部 *.jsonl（日期分区 + archived_sessions/）。
 */
export function listFilesFromRoot(root: string): FileEntry[] {
  const out: FileEntry[] = []
  collectSubtree(root, out)
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
    reason: '未找到会话目录 ~/.codex/sessions（Codex CLI 未安装或尚未产生会话）',
    sessionDir: rootDir
  }
}

/** 宽松取数字：缺失/非有限数 → 0 */
const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** 宽松取字符串：缺失/空/非字符串 → undefined */
const toStr = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined

/** 取行的 payload 对象（缺失/非对象 → null） */
function getPayloadObj(row: Record<string, unknown>): Record<string, unknown> | null {
  const payload = row.payload
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
}

/** 从 rollout 文件名提取 sessionId（rollout-<id>.jsonl → <id>）；无则 undefined */
function sessionIdFromFilename(filePath: string): string | undefined {
  const base = path.basename(filePath)
  if (!base.endsWith('.jsonl')) return undefined
  const stem = base.slice(0, -'.jsonl'.length)
  if (!stem.startsWith('rollout-')) return undefined
  const id = stem.slice('rollout-'.length)
  return id ? id : undefined
}

/**
 * 解析状态：随行推进维护「当前模型」「会话 cwd」「sessionId」。
 * 每次 parseFile 全文件扫描维护状态，保证增量续读（fromLine>0）时上下文不丢失。
 */
interface CodexState {
  model?: string
  cwd?: string
  sessionId?: string
}

/** 一行更新状态：session_meta→cwd/id；turn_context→model（最近一次生效） */
function updateState(row: Record<string, unknown>, state: CodexState): void {
  const payload = getPayloadObj(row)
  if (!payload) return
  if (row.type === 'session_meta') {
    const cwd = toStr(payload.cwd)
    if (cwd) state.cwd = cwd
    const id = toStr(payload.id)
    if (id) state.sessionId = id
  } else if (row.type === 'turn_context') {
    const model = toStr(payload.model)
    if (model) state.model = model
  }
}

/**
 * event_msg(token_count) 行 → UsageRecord（用 info.last_token_usage 本轮增量）。
 * 非 token_count 行、无当前模型、last_token_usage 缺失或全 0 → null（跳过该条，不阻塞）。
 */
function toUsageRecord(
  row: Record<string, unknown>,
  state: CodexState,
  filePath: string,
  line: number
): UsageRecord | null {
  const payload = getPayloadObj(row)
  if (row.type !== 'event_msg' || !payload || payload.type !== 'token_count') return null

  const model = state.model
  if (!model) return null // 无当前模型（尚未出现 turn_context）→ 跳过

  const info = payload.info
  if (!info || typeof info !== 'object') return null
  const u = (info as Record<string, unknown>).last_token_usage
  if (!u || typeof u !== 'object') return null
  const usage = u as Record<string, unknown>

  const inputTokens = toNum(usage.input_tokens)
  const outputTokens = toNum(usage.output_tokens)
  const cacheReadTokens = toNum(usage.cached_input_tokens)
  const reasoningOutputTokens = toNum(usage.reasoning_output_tokens)
  if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && reasoningOutputTokens === 0) {
    return null // last_token_usage 全 0（无有效增量）→ 跳过
  }

  // createdAt：本行 timestamp → payload.info 时间 → Date.now() 兜底
  let createdAt = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
  if (Number.isNaN(createdAt)) {
    const infoObj = info as Record<string, unknown>
    const infoTs = toStr(infoObj.time) ?? toStr(infoObj.timestamp)
    createdAt = infoTs ? Date.parse(infoTs) : NaN
  }
  if (Number.isNaN(createdAt)) createdAt = Date.now()

  return {
    appType: 'codex',
    model,
    rawModel: model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens: 0,
    inputSemantics: 1, // 含缓存写
    status: 'success',
    createdAt,
    project: state.cwd,
    sessionId: state.sessionId,
    source: { filePath, line }
  }
}

/**
 * 增量解析：从 fromLine 行（1-based 行号，0 表示从文件开头）续读。
 * - 全文件扫描维护状态（模型/cwd/sessionId），仅对 fromLine 起的行产出记录与推进游标，
 *   保证增量续读（fromLine>0）时上下文完整。
 * - 失败行宽松跳过不阻塞；仅「尾部不完整行」时游标停在最后成功解析行，下次从该行重试。
 * - eof：读到文件结尾即 true（含尾部不完整行也算 EOF）。
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
  const state: CodexState = { sessionId: sessionIdFromFilename(filePath) }
  let nextLine = fromLine
  let eof = false

  // fromLine/nextLine 均为 1-based 行号（0 = 从开头）；换算为 0-based 数组索引
  const startIndex = fromLine > 0 ? fromLine - 1 : 0

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1 // 1-based，绝对行号（去重键）
    const raw = lines[i]
    const inRange = i >= startIndex // 是否处于待产出记录/推进游标的范围

    if (raw.trim() === '') {
      if (inRange) nextLine = lineNumber + 1
      continue
    }

    let obj: unknown
    try {
      obj = JSON.parse(raw)
    } catch {
      // 其后仅剩空行（文件以 \n 结尾时 split 的尾随空串）→ 视为尾部不完整行
      const onlyEmptyAfter = lines.slice(i + 1).every((l) => l === '')
      if (onlyEmptyAfter) {
        if (inRange) nextLine = lineNumber // 停在最后成功解析行（= 该失败行）
        eof = true
        break
      }
      // 中间损坏行：宽松跳过，不阻塞（推进游标，避免重复解析）
      if (inRange) nextLine = lineNumber + 1
      continue
    }

    const row = obj as Record<string, unknown>
    updateState(row, state) // 全程维护状态
    if (!inRange) continue

    const record = toUsageRecord(row, state, filePath, lineNumber)
    if (record) records.push(record)
    nextLine = lineNumber + 1
  }

  // 读到文件结尾即 EOF（尾部不完整行分支已置 eof）
  if (!eof) eof = true

  return { records, nextLine, eof }
}

/** 探测：~/.codex/sessions 目录是否存在 */
async function detect(): Promise<Detection> {
  return detectFromRoot(sessionRoot())
}

/** codex 监控插件（docs/concepts/monitor-plugins.md，T9） */
export const codexPlugin: MonitorPlugin = {
  id: 'codex',
  name: 'Codex',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles: async () => listFilesFromRoot(sessionRoot()),
  parseFile
}
