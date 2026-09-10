import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'

export function sessionsRootOf(): string {
  const dir = process.env.CODEWHALE_DIR
  if (dir && dir.trim() !== '') return dir.trim()
  const home = process.env.CODEWHALE_HOME
  if (home && home.trim() !== '') return path.join(home.trim(), 'sessions')
  return path.join(os.homedir(), '.codewhale', 'sessions')
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function isTransientName(name: string): boolean {
  return name.startsWith('.') || name.endsWith('.tmp') || name.endsWith('.swp') || name.endsWith('~')
}

export function listFilesFromRoot(root: string): FileEntry[] {
  const out: FileEntry[] = []
  for (const ent of safeReaddir(root)) {
    if (!ent.isFile() || !ent.name.endsWith('.json') || isTransientName(ent.name)) continue
    const p = path.join(root, ent.name)
    let mtime = 0
    try {
      mtime = Math.round(fs.statSync(p).mtimeMs)
    } catch {
      mtime = 0
    }
    out.push({ path: p, mtime })
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
  if (!dirExists) {
    return {
      available: false,
      reason:
        '未找到会话目录 ~/.codewhale/sessions（CodeWhale 未安装或尚未产生会话，可用 $CODEWHALE_DIR / $CODEWHALE_HOME 覆盖）',
      sessionDir: root
    }
  }
  return { available: true, sessionDir: root }
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

function nonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s === '' ? null : s
}

export function parseSessionFile(filePath: string, fromLine: number): ParsedResult {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return { records: [], nextLine: fromLine, eof: true }
  }

  let obj: unknown
  try {
    obj = JSON.parse(content)
  } catch {
    return { records: [], nextLine: fromLine, eof: true }
  }
  if (!obj || typeof obj !== 'object') {
    return { records: [], nextLine: fromLine, eof: true }
  }

  const metaRaw = (obj as Record<string, unknown>).metadata
  if (!metaRaw || typeof metaRaw !== 'object') {
    return { records: [], nextLine: fromLine, eof: true }
  }
  const meta = metaRaw as Record<string, unknown>
  const sessionId = nonEmptyString(meta.id)
  if (!sessionId) {
    return { records: [], nextLine: fromLine, eof: true }
  }

  const total = toNum(meta.total_tokens)
  const base = fromLine
  const delta = total < base ? total : total - base
  if (delta <= 0) {
    return { records: [], nextLine: total, eof: true }
  }

  const model = nonEmptyString(meta.model) ?? 'unknown'
  const project = nonEmptyString(meta.workspace)
  const record: UsageRecord = {
    appType: 'codewhale',
    model,
    rawModel: model,
    inputTokens: delta,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    inputSemantics: 0,
    status: 'success',
    createdAt: parseTsMs(meta.updated_at),
    sessionId,
    ...(project ? { project } : {}),
    source: { filePath, line: total, requestId: `${sessionId}:${total}` }
  }
  return { records: [record], nextLine: total, eof: true }
}

async function detect(): Promise<Detection> {
  return detectFromRoot(sessionsRootOf())
}

async function listFiles(): Promise<FileEntry[]> {
  return listFilesFromRoot(sessionsRootOf())
}

async function parseFile(_ctx: PluginContext, filePath: string, fromLine: number): Promise<ParsedResult> {
  return parseSessionFile(filePath, fromLine)
}

export const codewhalePlugin: MonitorPlugin = {
  id: 'codewhale',
  name: 'CodeWhale',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles,
  parseFile
}
