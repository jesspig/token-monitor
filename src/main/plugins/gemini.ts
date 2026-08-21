import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'

/**
 * gemini 监控插件（docs/concepts/monitor-plugins.md）。
 * 数据源：~/.gemini/tmp/<project_hash>/chats/session-*.json（单个 JSON 对象，非 JSONL）。
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

/** 是否候选会话文件：仅 session-*.json，过滤临时/隐藏文件（*.tmp、*.swp、.*、*~） */
function isSessionFile(name: string): boolean {
  if (!name.startsWith('session-')) return false
  if (!name.endsWith('.json')) return false
  if (name.startsWith('.')) return false
  return !/(?:\.tmp|\.swp|~)$/i.test(name)
}

/** 递归收集：仅 chats/ 目录下的 session-*.json（checkpoints 等其它 .json 天然被过滤） */
function collectDir(dir: string, out: FileEntry[]): void {
  for (const ent of safeReaddir(dir)) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      collectDir(p, out)
    } else if (
      ent.isFile() &&
      isSessionFile(ent.name) &&
      path.basename(path.dirname(p)) === 'chats'
    ) {
      out.push(toEntry(p))
    }
  }
}

/**
 * 列出会话文件（root 可注入，便于测试）。
 * 范围：~/.gemini/tmp/<project_hash>/chats/ 下（递归）的 session-*.json。
 */
export function listFilesFromRoot(root: string): FileEntry[] {
  const out: FileEntry[] = []
  collectDir(root, out)
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
    source: { filePath, line }
  }
}

/**
 * 增量解析：gemini 会话文件为单个 JSON 对象（非 JSONL），整体读入。
 * - fromLine 为「上次已处理到的消息序号」（1-based）；只处理序号 > fromLine 的消息。
 * - nextLine 返回最后处理的消息序号（无新增则保持原值，游标不倒退）。
 * - eof 恒为 true（单文件整体读）；JSON 解析失败 / messages 缺失或为空返回空结果。
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
