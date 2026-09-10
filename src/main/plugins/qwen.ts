import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'

const TOKEN_USAGE_PREFIX = 'token-usage-'
const TOKEN_USAGE_SUFFIX = '.jsonl'
const UNKNOWN_MODEL = 'unknown'

export function dataRootOf(): string {
  const runtimeDir = process.env.QWEN_RUNTIME_DIR
  if (runtimeDir && runtimeDir.trim() !== '') return runtimeDir.trim()
  const home = process.env.QWEN_HOME
  if (home && home.trim() !== '') return home.trim()
  return path.join(os.homedir(), '.qwen')
}

export function usageDirOf(root: string): string {
  return path.join(root, 'usage')
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

export function isTokenUsageFileName(name: string): boolean {
  if (!name.startsWith(TOKEN_USAGE_PREFIX)) return false
  if (!name.endsWith(TOKEN_USAGE_SUFFIX)) return false
  if (name.startsWith('.')) return false
  return !/(?:\.tmp|\.swp|~)$/i.test(name)
}

export function listFilesFromRoot(root: string): FileEntry[] {
  const usageDir = usageDirOf(root)
  const out: FileEntry[] = []
  for (const ent of safeReaddir(usageDir)) {
    if (!ent.isFile()) continue
    if (!isTokenUsageFileName(ent.name)) continue
    out.push(toEntry(path.join(usageDir, ent.name)))
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function detectFromRoot(root: string): Detection {
  const usageDir = usageDirOf(root)
  let dirOk = false
  try {
    dirOk = fs.statSync(usageDir).isDirectory()
  } catch {
    dirOk = false
  }
  if (!dirOk) {
    return {
      available: false,
      reason: `未找到用量目录 ${usageDir}（可能因 Qwen Code 未安装、尚未产生用量，或设置中 usageStatisticsEnabled 已关闭）`,
      sessionDir: usageDir
    }
  }
  if (listFilesFromRoot(root).length === 0) {
    return {
      available: false,
      reason: '用量目录下未发现 token-usage-*.jsonl（可能因 Qwen Code 尚未产生用量，或设置中 usageStatisticsEnabled 已关闭）',
      sessionDir: usageDir
    }
  }
  return { available: true, sessionDir: usageDir }
}

const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function toUsageRecord(obj: unknown, filePath: string, line: number): UsageRecord | null {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const row = obj as Record<string, unknown>

  const modelRaw = typeof row.model === 'string' ? row.model.trim() : ''
  const model = modelRaw !== '' ? modelRaw : UNKNOWN_MODEL

  const requestId = typeof row.id === 'string' && row.id.trim() !== '' ? row.id.trim() : undefined

  const ts = typeof row.timestamp === 'string' ? row.timestamp : ''
  const parsed = ts ? Date.parse(ts) : NaN

  const sessionId = typeof row.sessionId === 'string' && row.sessionId.trim() !== '' ? row.sessionId.trim() : undefined

  return {
    appType: 'qwen',
    model,
    rawModel: modelRaw !== '' ? modelRaw : undefined,
    inputTokens: toNum(row.inputTokens),
    outputTokens: toNum(row.outputTokens),
    cacheReadTokens: toNum(row.cachedTokens),
    cacheCreationTokens: 0,
    inputSemantics: 1,
    status: 'success',
    latencyMs: toNum(row.apiDurationMs),
    createdAt: Number.isNaN(parsed) ? Date.now() : parsed,
    ...(sessionId !== undefined ? { sessionId } : {}),
    source: { filePath, line, ...(requestId ? { requestId } : {}) }
  }
}

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

    const record = toUsageRecord(obj, filePath, lineNumber)
    if (record) records.push(record)
    nextLine = lineNumber + 1
  }

  if (!eof) eof = true

  return { records, nextLine, eof }
}

async function detect(): Promise<Detection> {
  return detectFromRoot(dataRootOf())
}

async function listFiles(): Promise<FileEntry[]> {
  return listFilesFromRoot(dataRootOf())
}

export const qwenPlugin: MonitorPlugin = {
  id: 'qwen',
  name: 'Qwen Code',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles,
  parseFile
}
