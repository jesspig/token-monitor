import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'

export function dataRootOf(): string {
  const override = process.env.DROID_DIR
  if (override && override.trim() !== '') return override.trim()
  return path.join(os.homedir(), '.factory')
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
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

export function listFilesFromRoot(root: string): FileEntry[] {
  const out: FileEntry[] = []
  collectSubtree(path.join(root, 'sessions'), out)
  collectSubtree(path.join(root, 'projects'), out)
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function detectFromRoot(root: string): Detection {
  if (!isDirectory(root)) {
    return {
      available: false,
      reason: '未找到数据目录 ~/.factory（Factory Droid 未安装或尚未产生会话，可用 $DROID_DIR 覆盖数据根）',
      sessionDir: root
    }
  }
  if (isDirectory(path.join(root, 'sessions')) || isDirectory(path.join(root, 'projects'))) {
    return { available: true, sessionDir: root }
  }
  return {
    available: false,
    reason: '数据目录存在但未发现 sessions/ 或 projects/ 会话子目录（Droid 尚未产生会话）',
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

function extractCwd(obj: unknown): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const row = obj as Record<string, unknown>
  if (row.type !== 'session_start') return undefined
  if (typeof row.cwd !== 'string' || row.cwd.trim() === '') return undefined
  return row.cwd
}

function toUsageRecord(
  obj: unknown,
  filePath: string,
  line: number,
  project: string | undefined
): UsageRecord | null {
  if (!obj || typeof obj !== 'object') return null
  const row = obj as Record<string, unknown>
  if (row.type !== 'message') return null

  const message = row.message
  if (!message || typeof message !== 'object') return null
  const msg = message as Record<string, unknown>

  if (msg.role !== 'assistant') return null

  const model = typeof msg.model === 'string' ? msg.model.trim() : ''
  if (!model) return null

  const usage = msg.usage
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>

  const requestId = typeof msg.id === 'string' && msg.id.trim() !== '' ? msg.id.trim() : undefined

  return {
    appType: 'droid',
    model,
    rawModel: model,
    inputTokens: toNum(u.inputTokens),
    outputTokens: toNum(u.outputTokens),
    cacheReadTokens: toNum(u.cacheReadInputTokens),
    cacheCreationTokens: toNum(u.cacheCreationInputTokens),
    inputSemantics: 2,
    status: 'success',
    createdAt: parseTsMs(row.timestamp),
    ...(project !== undefined ? { project } : {}),
    source: { filePath, line, ...(requestId ? { requestId } : {}) }
  }
}

export function foldById(records: UsageRecord[]): UsageRecord[] {
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
    } else if (rec.outputTokens >= out[existing].outputTokens) {
      out[existing] = rec
    }
  }
  return out
}

export async function parseSessionFile(
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
  const buffered: UsageRecord[] = []
  let nextLine = fromLine
  let project: string | undefined

  const startIndex = fromLine > 0 ? fromLine - 1 : 0
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1
    const raw = lines[i]
    if (raw.trim() === '') {
      if (i >= startIndex) {
        nextLine = i === lines.length - 1 ? lineNumber : lineNumber + 1
      }
      continue
    }

    let obj: unknown
    let broken = false
    try {
      obj = JSON.parse(raw)
    } catch {
      broken = true
    }

    if (broken) {
      if (i < startIndex) continue
      const onlyEmptyAfter = lines.slice(i + 1).every((l) => l === '')
      if (onlyEmptyAfter) {
        nextLine = lineNumber
        break
      }
      nextLine = lineNumber + 1
      continue
    }

    if (project === undefined) {
      const cwd = extractCwd(obj)
      if (cwd !== undefined) project = cwd
    }

    if (i < startIndex) continue

    const record = toUsageRecord(obj, filePath, lineNumber, project)
    if (record) buffered.push(record)
    nextLine = lineNumber + 1
  }

  return { records: foldById(buffered), nextLine, eof: true }
}

async function detect(): Promise<Detection> {
  return detectFromRoot(dataRootOf())
}

async function listFiles(): Promise<FileEntry[]> {
  return listFilesFromRoot(dataRootOf())
}

async function parseFile(
  _ctx: PluginContext,
  filePath: string,
  fromLine: number
): Promise<ParsedResult> {
  return parseSessionFile(filePath, fromLine)
}

export const droidPlugin: MonitorPlugin = {
  id: 'droid',
  name: 'Droid',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles,
  parseFile
}
