import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'

const STATS_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/

export function statsRootOf(): string {
  const stateHome = process.env.REASONIX_STATE_HOME
  if (stateHome && stateHome.trim() !== '') return path.join(stateHome.trim(), 'stats')
  const home = process.env.REASONIX_HOME
  if (home && home.trim() !== '') return path.join(home.trim(), 'stats')
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (appData && appData.trim() !== '') return path.join(appData.trim(), 'reasonix', 'stats')
    return path.join(os.homedir(), 'AppData', 'Roaming', 'reasonix', 'stats')
  }
  return path.join(os.homedir(), '.reasonix', 'stats')
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

export function listFilesFromRoot(root: string): FileEntry[] {
  const out: FileEntry[] = []
  for (const ent of safeReaddir(root)) {
    if (ent.isFile() && STATS_FILE_PATTERN.test(ent.name)) {
      out.push(toEntry(path.join(root, ent.name)))
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function detectFromRoot(root: string): Detection {
  if (listFilesFromRoot(root).length > 0) return { available: true, sessionDir: root }
  let dirExists = false
  try {
    dirExists = fs.statSync(root).isDirectory()
  } catch {
    dirExists = false
  }
  if (dirExists) {
    return {
      available: false,
      reason: '统计数据目录存在但未发现 YYYY-MM-DD.jsonl（Reasonix 尚未产生统计）',
      sessionDir: root
    }
  }
  return {
    available: false,
    reason: '未找到统计数据目录 ~/.reasonix/stats（Reasonix 未安装或尚未产生统计，可用 $REASONIX_HOME / $REASONIX_STATE_HOME 覆盖）',
    sessionDir: root
  }
}

const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function parseTsMs(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    return v >= 1_000_000_000_000 ? v : v * 1000
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const parsed = Date.parse(v)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Date.now()
}

function toUsageRecord(obj: unknown, filePath: string, line: number): UsageRecord | null {
  if (!obj || typeof obj !== 'object') return null
  const row = obj as Record<string, unknown>
  if (row.turn === true) return null
  const model = typeof row.model === 'string' ? row.model.trim() : ''
  if (!model) return null
  return {
    appType: 'reasonix',
    model,
    rawModel: model,
    inputTokens: toNum(row.prompt),
    outputTokens: toNum(row.completion),
    cacheReadTokens: toNum(row.cache_hit),
    cacheCreationTokens: toNum(row.cache_miss),
    inputSemantics: 1,
    status: 'success',
    createdAt: parseTsMs(row.ts),
    source: { filePath, line }
  }
}

export function parseStatsFile(filePath: string, fromLine: number): ParsedResult {
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
  return detectFromRoot(statsRootOf())
}

async function listFiles(): Promise<FileEntry[]> {
  return listFilesFromRoot(statsRootOf())
}

async function parseFile(_ctx: PluginContext, filePath: string, fromLine: number): Promise<ParsedResult> {
  return parseStatsFile(filePath, fromLine)
}

export const reasonixPlugin: MonitorPlugin = {
  id: 'reasonix',
  name: 'Reasonix',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles,
  parseFile
}
