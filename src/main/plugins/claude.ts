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

/**
 * 单行 JSON → UsageRecord。
 * 仅 type==='assistant' 且 message.usage 存在时产出；
 * 无 model 或 usage 缺失的行返回 null（跳过，不阻塞整体）。
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
    source: { filePath, line }
  }
}

/**
 * 增量解析：从 fromLine 行（1-based 行号，0 表示从文件开头）续读。
 * - 失败行宽松跳过不阻塞；仅「尾部不完整行」（JSON.parse 失败且其后仅剩空行）
 *   时游标停在最后一个成功解析行之后（= 该失败行），下次从该行重试，避免丢失正在写入的内容。
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
