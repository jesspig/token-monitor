import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../../shared/plugin'
import type { PluginContext } from '../../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../../shared/dto'

export type BuddyAppType = 'workbuddy' | 'codebuddy'

export interface BuddyPluginOptions {
  appType: BuddyAppType
  name: string
  envKey: string
  defaultRoot: string
  tildeRoot: string
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function toEntry(p: string): FileEntry {
  let mtime = 0
  try {
    mtime = Math.round(fs.statSync(p).mtimeMs)
  } catch {
    mtime = 0
  }
  return { path: p, mtime }
}

function isSessionFile(name: string): boolean {
  if (!name.endsWith('.jsonl')) return false
  if (name.startsWith('.')) return false
  return !/(?:\.tmp|\.swp|~)$/i.test(name)
}

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

function collectSessionSubdir(sessionDir: string, out: FileEntry[]): void {
  for (const ent of safeReaddir(sessionDir)) {
    if (!ent.isDirectory()) continue
    if (ent.name === 'subagents') {
      collectSubtree(path.join(sessionDir, ent.name), out)
    }
  }
}

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

export function listFilesFromRoot(root: string): FileEntry[] {
  const out: FileEntry[] = []
  for (const ent of safeReaddir(root)) {
    if (!ent.isDirectory()) continue
    collectProjectDir(path.join(root, ent.name), out)
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function detectFromRoot(
  root: string,
  options: { name: string; envKey: string; tildeRoot: string }
): Detection {
  let ok = false
  try {
    ok = fs.statSync(root).isDirectory()
  } catch {
    ok = false
  }
  if (ok && listFilesFromRoot(root).length > 0) {
    return { available: true, sessionDir: root }
  }
  return {
    available: false,
    reason: `未找到 ${options.name} 会话数据（默认 ${options.tildeRoot}，可用 $${options.envKey} 覆盖；${options.name} 未安装或尚未产生会话）`,
    sessionDir: root
  }
}

const toFinite = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

function firstPresent(values: unknown[]): number {
  for (const v of values) {
    const n = toFinite(v)
    if (n !== null) return Math.max(0, n)
  }
  return 0
}

function firstPositive(values: unknown[]): number {
  let fallback: number | null = null
  for (const v of values) {
    const n = toFinite(v)
    if (n === null) continue
    if (n > 0) return n
    if (fallback === null) fallback = Math.max(0, n)
  }
  return fallback ?? 0
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function extractUsage(row: Record<string, unknown>): Record<string, unknown> | null {
  const message = asObject(row.message)
  const provider = asObject(row.providerData)
  const candidates = [
    message ? asObject(message.usage) : null,
    provider ? asObject(provider.rawUsage) : null,
    provider ? asObject(provider.usage) : null
  ]
  for (const u of candidates) {
    if (u) return u
  }
  return null
}

function extractModel(row: Record<string, unknown>): string {
  const provider = asObject(row.providerData)
  const message = asObject(row.message)
  const candidates = [
    provider ? provider.model : undefined,
    provider ? provider.requestModelId : undefined,
    message ? message.model : undefined
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c.trim()
  }
  return ''
}

function extractRequestId(row: Record<string, unknown>): string {
  const provider = asObject(row.providerData)
  const candidates = [
    provider ? provider.messageId : undefined,
    provider ? provider.traceId : undefined,
    row.id
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c.trim()
  }
  return ''
}

function statMtimeMs(p: string): number {
  try {
    return Math.round(fs.statSync(p).mtimeMs)
  } catch {
    return 0
  }
}

function toUsageRecord(
  obj: unknown,
  appType: BuddyAppType,
  filePath: string,
  line: number,
  fallbackCreatedAt: number
): UsageRecord | null {
  const row = asObject(obj)
  if (!row) return null

  const isAssistantMessage = row.type === 'message' && row.role === 'assistant'
  const isFunctionCall = row.type === 'function_call'
  if (!isAssistantMessage && !isFunctionCall) return null

  if (typeof row.status === 'string' && row.status !== 'completed') return null

  const usage = extractUsage(row)
  if (!usage) return null

  const model = extractModel(row)
  if (!model) return null

  const outputTokens = firstPresent([usage.output_tokens, usage.outputTokens, usage.completion_tokens])
  const cacheReadTokens = firstPositive([
    usage.cache_read_input_tokens,
    usage.cacheReadInputTokens,
    usage.cacheTokens,
    usage.prompt_cache_hit_tokens,
    usage.cached_tokens
  ])
  const cacheCreationTokens = firstPositive([
    usage.cache_creation_input_tokens,
    usage.cacheCreationInputTokens,
    usage.cachedWriteTokens,
    usage.prompt_cache_write_tokens
  ])
  const inputTokens = firstPresent([usage.input_tokens, usage.inputTokens, usage.prompt_tokens])

  const ts = toFinite(row.timestamp)
  const createdAt =
    ts !== null && ts > 0 ? ts : fallbackCreatedAt > 0 ? fallbackCreatedAt : Date.now()

  const requestId = extractRequestId(row)

  return {
    appType,
    model,
    rawModel: model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    inputSemantics: 1,
    status: 'success',
    createdAt,
    project: typeof row.cwd === 'string' ? row.cwd : undefined,
    sessionId: typeof row.sessionId === 'string' ? row.sessionId : undefined,
    source: { filePath, line, ...(requestId ? { requestId } : {}) }
  }
}

function totalTokensOf(r: UsageRecord): number {
  return r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreationTokens
}

export function foldByRequestId(records: UsageRecord[]): UsageRecord[] {
  const out: UsageRecord[] = []
  const slots = new Map<string, number>()
  for (const rec of records) {
    const rid = rec.source.requestId
    if (!rid) {
      out.push(rec)
      continue
    }
    const existing = slots.get(rid)
    if (existing === undefined) {
      slots.set(rid, out.length)
      out.push(rec)
    } else if (totalTokensOf(rec) >= totalTokensOf(out[existing])) {
      out[existing] = rec
    }
  }
  return out
}

export async function parseJsonlFile(
  appType: BuddyAppType,
  filePath: string,
  fromLine: number
): Promise<ParsedResult> {
  let content: string
  try {
    content = await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return { records: [], nextLine: fromLine, eof: true }
  }

  const fallbackCreatedAt = statMtimeMs(filePath)
  const lines = content.split('\n')
  const buffered: UsageRecord[] = []
  let nextLine = fromLine
  let eof = false

  const startIndex = fromLine > 0 ? fromLine - 1 : 0
  for (let i = startIndex; i < lines.length; i++) {
    const lineNumber = i + 1
    const raw = lines[i]
    if (raw.trim() === '') {
      nextLine = i === lines.length - 1 ? lineNumber : lineNumber + 1
      continue
    }

    let obj: unknown
    try {
      obj = JSON.parse(raw)
    } catch {
      const onlyEmptyAfter = lines.slice(i + 1).every((l) => l === '')
      if (onlyEmptyAfter) {
        nextLine = lineNumber
        eof = true
        break
      }
      nextLine = lineNumber + 1
      continue
    }

    const record = toUsageRecord(obj, appType, filePath, lineNumber, fallbackCreatedAt)
    if (record) buffered.push(record)
    nextLine = lineNumber + 1
  }

  if (!eof) eof = true

  const records = foldByRequestId(buffered)
  return { records, nextLine, eof }
}

export function createBuddyPlugin(options: BuddyPluginOptions): MonitorPlugin {
  const rootOf = (): string => {
    const dir = process.env[options.envKey]
    if (dir && dir.trim() !== '') return dir.trim()
    return options.defaultRoot
  }

  return {
    id: options.appType,
    name: options.name,
    version: '1.0.0',
    deps: ['storage', 'pricing', 'events'],
    detect: async () => detectFromRoot(rootOf(), options),
    listFiles: async () => listFilesFromRoot(rootOf()),
    parseFile: (_ctx: PluginContext, filePath: string, fromLine: number) =>
      parseJsonlFile(options.appType, filePath, fromLine)
  }
}
