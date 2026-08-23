import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'

/**
 * gemini 监控插件（docs/concepts/monitor-plugins.md）。
 * 数据源：~/.gemini/tmp/<project_hash>/chats/ 下双格式会话文件：
 * - 新版（Gemini CLI 2026-03 起，PR #23749/#15309）：append-only JSONL，首行为会话
 *   metadata（含 sessionId，无 type 字段），之后每行一条消息或 $set 元数据更新行；
 *   subagent 会话位于 chats/<parentSessionId>/<safeSessionId>.jsonl 嵌套子目录（无 session- 前缀）；
 * - legacy：chats 直接子层的 session-*.json（单个 JSON 对象，messages 数组），仅作兼容读取。
 */

/** 会话根目录：~/.gemini/tmp（home 用 os.homedir()，不硬编码用户路径） */
function sessionRoot(): string {
  return path.join(os.homedir(), '.gemini', 'tmp')
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

/** 临时/隐藏文件一律排除（*.tmp、*.swp、.*、*~），避免读到写入器中间态 */
function isTempOrHidden(name: string): boolean {
  if (name.startsWith('.')) return true
  return /(?:\.tmp|\.swp|~)$/i.test(name)
}

/** 新版 append-only JSONL 会话：chats 子树内任意层级均收集（subagent 嵌套目录覆盖） */
function isJsonlSessionFile(name: string): boolean {
  return name.endsWith('.jsonl')
}

/** legacy 单 JSON 会话：仅 session- 前缀命名，且限 chats 直接子层 */
function isLegacySessionFile(name: string): boolean {
  return name.startsWith('session-') && name.endsWith('.json')
}

/**
 * 在单个 chats/ 子树内收集会话文件：
 * - *.jsonl：任意层级（含 subagent 嵌套目录）；
 * - legacy session-*.json：仅 depth 0（chats 直接子层，checkpoints 等其它 .json 天然被过滤）。
 */
function collectChats(dir: string, depth: number, out: FileEntry[]): void {
  for (const ent of safeReaddir(dir)) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      collectChats(p, depth + 1, out)
    } else if (ent.isFile() && !isTempOrHidden(ent.name)) {
      if (isJsonlSessionFile(ent.name) || (depth === 0 && isLegacySessionFile(ent.name))) {
        out.push(toEntry(p))
      }
    }
  }
}

/**
 * 列出会话文件（root 可注入，便于测试）。
 * 范围：~/.gemini/tmp/<project_hash>/chats/ 子树内的 *.jsonl（任意层级）
 * + chats 直接子层的 legacy session-*.json。
 */
export function listFilesFromRoot(root: string): FileEntry[] {
  const out: FileEntry[] = []
  // 布局固定为 tmp/<project_hash>/chats/：逐 hash 目录定位 chats 后在其子树内收集
  for (const hashDir of safeReaddir(root)) {
    if (!hashDir.isDirectory()) continue
    const projectDir = path.join(root, hashDir.name)
    for (const ent of safeReaddir(projectDir)) {
      if (ent.isDirectory() && ent.name === 'chats') {
        collectChats(path.join(projectDir, ent.name), 0, out)
      }
    }
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
    reason: '未找到会话目录 ~/.gemini/tmp（Gemini CLI 未安装或尚未产生会话）',
    sessionDir: rootDir
  }
}

/** 从 tokens 对象按候选 key 顺序取第一个有限数字，缺失按 0（宽松兼容多组命名） */
function tokenOf(t: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    if (typeof t[k] === 'number' && Number.isFinite(t[k] as number)) return t[k] as number
  }
  return 0
}

/** tokens 各计数的候选 key（顺序即优先级：优先 input/output/cached 短 key） */
const INPUT_KEYS = ['input', 'input_tokens', 'inputTokens']
const OUTPUT_KEYS = ['output', 'output_tokens', 'outputTokens']
const CACHE_READ_KEYS = [
  'cached',
  'cached_input_tokens',
  'cacheReadTokens',
  'cacheReadInputTokens',
  'cache_read_input_tokens'
]
const CACHE_CREATION_KEYS = [
  'cache_creation_tokens',
  'cacheCreationTokens',
  'cacheCreationInputTokens',
  'cache_creation_input_tokens'
]

/**
 * 单个 gemini 消息（type==='gemini' 且含 model 与 tokens）→ UsageRecord。
 * 其余消息（user 等）或无 model / 无 tokens 的消息返回 null（跳过，不阻塞整体）。
 * line 为消息在数组中的 1-based 序号（天然唯一键，供去重与游标回溯）。
 */
function toUsageRecord(
  doc: Record<string, unknown>,
  msg: unknown,
  filePath: string,
  line: number
): UsageRecord | null {
  if (!msg || typeof msg !== 'object') return null
  const m = msg as Record<string, unknown>
  if (m.type !== 'gemini') return null

  const model = typeof m.model === 'string' ? m.model.trim() : ''
  if (!model) return null

  const tokens = m.tokens
  if (!tokens || typeof tokens !== 'object') return null
  const t = tokens as Record<string, unknown>

  const ts = typeof m.timestamp === 'string' ? m.timestamp : ''
  const parsed = ts ? Date.parse(ts) : NaN

  // 消息 id(randomUUID)作为语义 ID,fork/rewrite 语义去重依赖;缺失不设
  const requestId = typeof m.id === 'string' && m.id.trim() !== '' ? m.id : undefined

  return {
    appType: 'gemini',
    model,
    rawModel: model,
    inputTokens: tokenOf(t, INPUT_KEYS),
    outputTokens: tokenOf(t, OUTPUT_KEYS),
    cacheReadTokens: tokenOf(t, CACHE_READ_KEYS),
    cacheCreationTokens: tokenOf(t, CACHE_CREATION_KEYS),
    inputSemantics: 1, // 含缓存写
    status: 'success',
    createdAt: Number.isNaN(parsed) ? Date.now() : parsed,
    sessionId: typeof doc.sessionId === 'string' ? doc.sessionId : undefined,
    source: { filePath, line, requestId }
  }
}

/**
 * 增量解析（legacy 单 JSON 格式）：gemini 会话文件为单个 JSON 对象（非 JSONL），整体读入。
 * - fromLine 为「上次已处理到的消息序号」（1-based）；只处理序号 > fromLine 的消息。
 * - nextLine 返回最后处理的消息序号（无新增则保持原值，游标不倒退）。
 * - eof 恒为 true（单文件整体读）；JSON 解析失败 / messages 缺失或为空返回空结果。
 */
async function parseLegacyJsonFile(filePath: string, fromLine: number): Promise<ParsedResult> {
  let content: string
  try {
    content = await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return { records: [], nextLine: fromLine, eof: true }
  }

  let obj: unknown
  try {
    obj = JSON.parse(content)
  } catch {
    // 解析失败：返回空结果，游标不推进不倒退
    return { records: [], nextLine: fromLine, eof: true }
  }

  if (!obj || typeof obj !== 'object') return { records: [], nextLine: fromLine, eof: true }
  const doc = obj as Record<string, unknown>
  const messages = Array.isArray(doc.messages) ? doc.messages : []
  if (messages.length === 0) return { records: [], nextLine: fromLine, eof: true }

  const records: UsageRecord[] = []
  let nextLine = fromLine
  for (let i = 0; i < messages.length; i++) {
    const ordinal = i + 1 // 1-based 消息序号（去重键 = source.line）
    if (ordinal <= fromLine) continue
    const record = toUsageRecord(doc, messages[i], filePath, ordinal)
    if (record) records.push(record)
    nextLine = ordinal
  }

  return { records, nextLine, eof: true }
}

/**
 * 增量解析（新版 append-only JSONL，PR #23749）：逐行解析，参照 claude 插件模式。
 * - 行号 1-based；fromLine 为「下一条待处理物理行」，支持增量续读；
 * - 会话状态机：metadata 行（含字符串 sessionId 且无 type 字段）建立当前 sessionId，
 *   `$set` 更新行若携带 sessionId 则刷新；消息行自身无 sessionId，统一取当前状态；
 * - 非 gemini 消息 / metadata / $set / 损坏行不产出但游标照常推进；
 * - 仅「尾部不完整行」（JSON.parse 失败且其后仅剩空行）游标停在该行下次重试，
 *   中间损坏行宽松跳过不阻塞整体同步。
 */
async function parseJsonlFile(filePath: string, fromLine: number): Promise<ParsedResult> {
  let content: string
  try {
    content = await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return { records: [], nextLine: fromLine, eof: true }
  }

  const lines = content.split('\n')
  const records: UsageRecord[] = []
  // 当前会话状态：来自 metadata 行 / $set 行，供消息行合成 doc 复用 toUsageRecord
  let sessionId: string | undefined
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

    // 元数据行两类：$set 更新行（可能携带 sessionId 增量）/ 会话 metadata 行
    const patch = row.$set
    if (patch && typeof patch === 'object') {
      const s = (patch as Record<string, unknown>).sessionId
      if (typeof s === 'string' && s.trim() !== '') sessionId = s
    } else if (typeof row.sessionId === 'string' && row.type === undefined) {
      sessionId = row.sessionId
    } else {
      // 消息行自身无 sessionId，统一取当前会话状态
      const record = toUsageRecord({ sessionId }, row, filePath, lineNumber)
      if (record) records.push(record)
    }
    nextLine = lineNumber + 1
  }

  if (!eof) eof = true

  return { records, nextLine, eof }
}

/**
 * 增量解析入口：按扩展名分派。
 * .jsonl 走新版逐行解析；.json（非 .jsonl 结尾）走 legacy 单对象解析。
 */
async function parseFile(
  _ctx: PluginContext,
  filePath: string,
  fromLine: number
): Promise<ParsedResult> {
  return filePath.toLowerCase().endsWith('.jsonl')
    ? parseJsonlFile(filePath, fromLine)
    : parseLegacyJsonFile(filePath, fromLine)
}

/** 探测：~/.gemini/tmp 目录是否存在 */
async function detect(): Promise<Detection> {
  return detectFromRoot(sessionRoot())
}

/** gemini 监控插件（docs/concepts/monitor-plugins.md，T11） */
export const geminiPlugin: MonitorPlugin = {
  id: 'gemini',
  name: 'Gemini CLI',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles: async () => listFilesFromRoot(sessionRoot()),
  parseFile
}
