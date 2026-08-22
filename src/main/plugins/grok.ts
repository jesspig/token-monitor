import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'

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

/**
 * 建立 sessionId → 模型 映射（root 可注入，便于测试）。
 * 递归读 ~/.grok/sessions/任意层级/summary.json，取 current_model_id；会话目录名即 sessionId。
 * 由本插件在每轮同步 listFiles 开始处重建；导出仅供测试直接调用。
 */
export async function loadModelMap(root: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const summaries: FileEntry[] = []
  collectSummaries(path.join(root, 'sessions'), summaries)
  for (const e of summaries) {
    const sessionId = path.basename(path.dirname(e.path))
    if (!sessionId) continue
    const model = readCurrentModel(e.path)
    if (model) map.set(sessionId, model)
  }
  modelMap = map
  return map
}

/** 宽松取数字：缺失/非有限数 → 0 */
const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

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
    source: { filePath, line }
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
