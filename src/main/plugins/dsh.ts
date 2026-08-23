import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { decompress } from 'fzstd'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'

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
 * - 计费条目模型取两级来源：data.message.model 非空时优先（兼容上游未来恢复字段），
 *   否则取最近一条 type==='request/header' 行的 data.header.config.model（每步 dispatch
 *   前写入日志；实测 ~/.dsh/sessions 全量 120 个会话 / 6084 条 assistant/message 中
 *   message.model 0 条存在而 data.usage 100% 存在，模型仅随请求头携带），两者皆无则跳过；
 * - data.message.provider 为供应方，UsageRecord 无对应字段故丢弃。
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
  if (listFilesFromRoot(root).length === 0) {
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

/**
 * 单条 storage record envelope → UsageRecord。
 * 仅 type==='assistant/message'、message.role 无 assistant 异值（宽松：role 缺失放行）
 * 且 usage 为对象时产出。模型两级来源：data.message.model 非空时优先（兼容上游未来
 * 恢复字段），否则取 session.currentModel（此前最近一条 request/header 的
 * data.header.config.model；120 文件 / 6084 条实测 message 均无自带 model）；两者皆无
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

  // 两级模型来源：message 自带 model 优先，缺失回落当前请求头模型，皆无则跳过
  const ownModel = typeof msg.model === 'string' ? msg.model.trim() : ''
  const model = ownModel || session.currentModel || ''
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

/**
 * 增量解析：从 fromLine 行（1-based 行号，0 表示从文件开头）续读。
 * - .jsonl.zstd 结尾的工件先经 fzstd 解压（zstd 标准帧拼接可整文件解压）再逐行解析；
 *   解压失败（损坏帧）或读取失败 → 该文件本轮返回空结果且游标不推进（eof=true），不阻塞整体；
 * - 失败行宽松跳过不阻塞；仅「尾部不完整行」（JSON.parse 失败且其后仅剩空行）
 *   时游标停在该行下次重试，避免丢失正在写入的内容；
 * - 会话状态机：首条 type==='session' 行取 id（sessionId）与 cwd（project），
 *   type==='request/header' 行取 data.header.config.model（当前模型，供其后的
 *   assistant/message 计费条目回落使用）；增量续读越过 session header 或 request/header
 *   时对应状态缺失：sessionId/project 保持 undefined，无自带模型的计费条目被跳过且水位
 *   照常推进（与 pi/gemini JSONL 越过 header 的语义一致）。
 */
async function parseFile(_ctx: PluginContext, filePath: string, fromLine: number): Promise<ParsedResult> {
  let content: string
  try {
    if (filePath.endsWith('.jsonl.zstd')) {
      // zstd 物理编码为标准 Zstandard 帧拼接（header 一帧 + 每 batch 一帧），整文件解压
      const compressed = await fs.promises.readFile(filePath)
      const bytes = decompress(new Uint8Array(compressed))
      content = new TextDecoder('utf-8').decode(bytes)
    } else {
      content = await fs.promises.readFile(filePath, 'utf8')
    }
  } catch {
    // 读取失败/损坏 zstd 帧：空结果、游标不动、按 EOF 处理
    return { records: [], nextLine: fromLine, eof: true }
  }

  const lines = content.split('\n')
  const records: UsageRecord[] = []
  // 当前会话状态：sessionId/project 来自首条 header 行，currentModel 来自最近的请求头行
  let sessionId: string | undefined
  let project: string | undefined
  let currentModel: string | undefined
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
      const record = toUsageRecord(row, filePath, lineNumber, { sessionId, project, currentModel })
      if (record) records.push(record)
    }
    nextLine = lineNumber + 1
  }

  // 读到文件结尾即 EOF（尾部不完整行分支已置 eof）
  if (!eof) eof = true

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
  parseFile
}
