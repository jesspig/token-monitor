import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'

const WIRE_FILE_NAME = 'wire.jsonl'
const TURN_SCOPE = 'turn'

function isTempName(name: string): boolean {
  if (name.startsWith('.')) return true
  return /(?:\.tmp|\.swp|~)$/i.test(name)
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

function collectWireFiles(dir: string, out: string[]): void {
  for (const ent of safeReaddir(dir)) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (!isTempName(ent.name)) collectWireFiles(p, out)
    } else if (ent.isFile() && ent.name === WIRE_FILE_NAME) {
      out.push(p)
    }
  }
}

function kimiRoot(): string {
  const env = process.env.KIMI_CODE_HOME
  if (env && env.trim()) return env.trim()
  return path.join(os.homedir(), '.kimi-code')
}

export function listFilesFromRoot(root: string): FileEntry[] {
  const files: string[] = []
  collectWireFiles(path.join(root, 'sessions'), files)
  return files.map(toEntry).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function detectFromRoot(root: string): Detection {
  const files: string[] = []
  collectWireFiles(path.join(root, 'sessions'), files)
  if (files.length > 0) return { available: true, sessionDir: root }
  return {
    available: false,
    reason: '未找到 ~/.kimi-code/sessions 下的 wire.jsonl 会话文件（Kimi Code 未安装或尚未产生会话）',
    sessionDir: root
  }
}

const lenientNum = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim())
    if (Number.isFinite(n)) return n
  }
  return undefined
}

function pickUsageField(u: Record<string, unknown>, snake: string, camel: string): number {
  const a = lenientNum(u[snake])
  if (a !== undefined) return a
  const b = lenientNum(u[camel])
  if (b !== undefined) return b
  return 0
}

function extractSessionId(filePath: string): string | undefined {
  const agentsDir = path.dirname(path.dirname(filePath))
  if (path.basename(agentsDir) !== 'agents') return undefined
  const id = path.basename(path.dirname(agentsDir))
  return id === '' ? undefined : id
}

function extractTime(row: Record<string, unknown>): number {
  const t = lenientNum(row.time)
  if (t === undefined) return Date.now()
  return t < 1e12 ? t * 1000 : t
}

function toUsageRecord(obj: unknown, filePath: string, line: number): UsageRecord | null {
  if (!obj || typeof obj !== 'object') return null
  const row = obj as Record<string, unknown>

  const lineType =
    typeof row.type === 'string' ? row.type : typeof row.line_type === 'string' ? row.line_type : ''
  if (lineType !== 'usage.record') return null

  const scope =
    typeof row.usageScope === 'string'
      ? row.usageScope
      : typeof row.usage_scope === 'string'
        ? row.usage_scope
        : ''
  if (scope !== TURN_SCOPE) return null

  const usage = row.usage
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>

  const model = typeof row.model === 'string' ? row.model.trim() : ''
  if (!model) return null

  const sessionId = extractSessionId(filePath)

  return {
    appType: 'kimi',
    model,
    rawModel: model,
    inputTokens: pickUsageField(u, 'input_other', 'inputOther'),
    outputTokens: pickUsageField(u, 'output', 'output'),
    cacheReadTokens: pickUsageField(u, 'input_cache_read', 'inputCacheRead'),
    cacheCreationTokens: pickUsageField(u, 'input_cache_creation', 'inputCacheCreation'),
    inputSemantics: 2,
    status: 'success',
    createdAt: extractTime(row),
    ...(sessionId ? { sessionId } : {}),
    source: { filePath, line }
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

export const kimiPlugin: MonitorPlugin = {
  id: 'kimi',
  name: 'Kimi Code',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect: async () => detectFromRoot(kimiRoot()),
  listFiles: async () => listFilesFromRoot(kimiRoot()),
  parseFile
}
