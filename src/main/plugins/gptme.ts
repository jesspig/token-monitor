import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'

const CONVERSATION_FILE = 'conversation.jsonl'

export function logsRootOf(): string {
  const gptmeDir = process.env.GPTME_DIR
  if (gptmeDir && gptmeDir.trim() !== '') return gptmeDir.trim()
  const logsHome = process.env.GPTME_LOGS_HOME
  if (logsHome && logsHome.trim() !== '') return logsHome.trim()
  return path.join(os.homedir(), '.local', 'share', 'gptme', 'logs')
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function isJunkName(name: string): boolean {
  return name.startsWith('.') || name.endsWith('~') || name.endsWith('.tmp') || name.endsWith('.swp')
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

export function listFilesFromRoot(root: string): FileEntry[] {
  const out: FileEntry[] = []
  for (const ent of safeReaddir(root)) {
    if (!ent.isDirectory() || isJunkName(ent.name)) continue
    const convFile = path.join(root, ent.name, CONVERSATION_FILE)
    let isFile = false
    try {
      isFile = fs.statSync(convFile).isFile()
    } catch {
      isFile = false
    }
    if (isFile) out.push(toEntry(convFile))
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function detectFromRoot(root: string): Detection {
  let dirExists = false
  try {
    dirExists = fs.statSync(root).isDirectory()
  } catch {
    dirExists = false
  }
  if (dirExists) return { available: true, sessionDir: root }
  return {
    available: false,
    reason: '未找到 gptme 日志目录 ~/.local/share/gptme/logs（gptme 未安装或尚未产生会话，可用 $GPTME_DIR / $GPTME_LOGS_HOME 覆盖）',
    sessionDir: root
  }
}

const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function parseTsMs(v: unknown): number {
  if (typeof v === 'string' && v.trim() !== '') {
    const parsed = Date.parse(v)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Date.now()
}

function toUsageRecord(obj: unknown, filePath: string, line: number): UsageRecord | null {
  if (!obj || typeof obj !== 'object') return null
  const row = obj as Record<string, unknown>
  if (row.role !== 'assistant') return null
  const meta = row.metadata
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
  const metaObj = meta as Record<string, unknown>
  const nested = metaObj.usage
  const src =
    nested && typeof nested === 'object' && !Array.isArray(nested) && Object.keys(nested).length > 0
      ? (nested as Record<string, unknown>)
      : metaObj
  const model = typeof src.model === 'string' ? src.model.trim() : ''
  if (!model) return null
  return {
    appType: 'gptme',
    model,
    rawModel: model,
    inputTokens: toNum(src.input_tokens),
    outputTokens: toNum(src.output_tokens),
    cacheReadTokens: toNum(src.cache_read_tokens),
    cacheCreationTokens: toNum(src.cache_creation_tokens),
    inputSemantics: 2,
    status: 'success',
    createdAt: parseTsMs(row.timestamp),
    source: { filePath, line }
  }
}

export function parseConversationFile(filePath: string, fromLine: number): ParsedResult {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return { records: [], nextLine: fromLine, eof: true }
  }
  if (content.trim() === '') {
    return { records: [], nextLine: Math.max(fromLine, 1), eof: true }
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
  return detectFromRoot(logsRootOf())
}

async function listFiles(): Promise<FileEntry[]> {
  return listFilesFromRoot(logsRootOf())
}

async function parseFile(_ctx: PluginContext, filePath: string, fromLine: number): Promise<ParsedResult> {
  return parseConversationFile(filePath, fromLine)
}

export const gptmePlugin: MonitorPlugin = {
  id: 'gptme',
  name: 'gptme',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles,
  parseFile
}
