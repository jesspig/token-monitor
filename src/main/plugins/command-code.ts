import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'


export function dataRootOf(): string {
  const dir = process.env.COMMANDCODE_DIR
  if (dir && dir.trim() !== '') return dir.trim()
  return path.join(os.homedir(), '.commandcode')
}

export function projectsRootOf(): string {
  return path.join(dataRootOf(), 'projects')
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

export function isTranscriptFile(name: string): boolean {
  if (!name.endsWith('.jsonl')) return false
  if (name.endsWith('.checkpoints.jsonl')) return false
  if (name.startsWith('.')) return false
  return !/(?:\.tmp|\.swp|~)$/i.test(name)
}

export function listFilesFromRoot(root: string): FileEntry[] {
  const out: FileEntry[] = []
  const walk = (dir: string): void => {
    for (const ent of safeReaddir(dir)) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        walk(p)
      } else if (ent.isFile() && isTranscriptFile(ent.name)) {
        out.push(toEntry(p))
      }
    }
  }
  walk(root)
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function hasTranscriptFile(root: string): boolean {
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    if (!dir) break
    for (const ent of safeReaddir(dir)) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        stack.push(p)
      } else if (ent.isFile() && isTranscriptFile(ent.name)) {
        return true
      }
    }
  }
  return false
}

export function detectFromRoot(projectsDir: string): Detection {
  let dirExists = false
  try {
    dirExists = fs.statSync(projectsDir).isDirectory()
  } catch {
    dirExists = false
  }
  if (dirExists && hasTranscriptFile(projectsDir)) {
    return { available: true, sessionDir: projectsDir }
  }
  if (dirExists) {
    return {
      available: false,
      reason: 'projects 目录存在但未发现 *.jsonl 会话文件（Command Code 尚未产生会话）',
      sessionDir: projectsDir
    }
  }
  return {
    available: false,
    reason: '未找到会话目录 ~/.commandcode/projects（Command Code 未安装或尚未产生会话，可用 $COMMANDCODE_DIR 覆盖）',
    sessionDir: projectsDir
  }
}

const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const UNKNOWN_MODEL = 'unknown'
const MISSING_TS_SENTINEL = -1

function parseTsMs(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? null : parsed
}

function activeBranchIds(
  parentMap: Map<string, string | null>,
  lastEntryId: string | null
): Set<string> | null {
  if (!lastEntryId) return null
  const branch = new Set<string>()
  let current: string | null = lastEntryId
  while (current !== null) {
    if (branch.has(current)) return branch
    branch.add(current)
    const parent = parentMap.get(current)
    if (parent === undefined) return null
    current = parent
  }
  return branch
}

function toUsageRecord(
  row: Record<string, unknown>,
  opts: { filePath: string; line: number; sessionId?: string; project?: string; model: string }
): { record: UsageRecord; entryId: string | null } | null {
  const message = row.message
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null
  const msg = message as Record<string, unknown>
  if (msg.role !== 'assistant') return null

  const usage = row.usage
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null
  const u = usage as Record<string, unknown>
  const anyBucket =
    'inputTokens' in u || 'outputTokens' in u || 'cacheReadTokens' in u || 'cacheWriteTokens' in u
  if (!anyBucket) return null

  const entryId = typeof row.id === 'string' && row.id.trim() !== '' ? row.id.trim() : null
  const tsMs = parseTsMs(row.timestamp)

  const record: UsageRecord = {
    appType: 'command-code',
    model: opts.model,
    rawModel: opts.model,
    inputTokens: toNum(u.inputTokens),
    outputTokens: toNum(u.outputTokens),
    cacheReadTokens: toNum(u.cacheReadTokens),
    cacheCreationTokens: toNum(u.cacheWriteTokens),
    inputSemantics: 2,
    status: 'success',
    createdAt: tsMs ?? Date.now(),
    ...(opts.project !== undefined ? { project: opts.project } : {}),
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    source: {
      filePath: opts.filePath,
      line: opts.line,
      ...(entryId !== null ? { requestId: `${entryId}:${tsMs ?? MISSING_TS_SENTINEL}` } : {})
    }
  }
  return { record, entryId }
}

export function parseTranscriptFile(filePath: string, fromLine: number): ParsedResult {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    return { records: [], nextLine: fromLine, eof: true }
  }

  const lines = content.split('\n')
  const buffered: { record: UsageRecord; entryId: string | null }[] = []
  const parentMap = new Map<string, string | null>()
  let lastEntryId: string | null = null
  let sessionId: string | undefined
  let project: string | undefined
  let modelId: string | null = null
  let nextLine = fromLine
  let eof = false

  const startIndex = fromLine > 0 ? fromLine - 1 : 0
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1
    const raw = lines[i]
    const shouldProduce = i >= startIndex
    if (raw.trim() === '') {
      if (shouldProduce) nextLine = i === lines.length - 1 ? lineNumber : lineNumber + 1
      continue
    }

    let obj: unknown
    try {
      obj = JSON.parse(raw)
    } catch {
      const onlyEmptyAfter = lines.slice(i + 1).every((l) => l === '')
      if (onlyEmptyAfter) {
        if (shouldProduce) nextLine = lineNumber
        eof = true
        break
      }
      if (shouldProduce) nextLine = lineNumber + 1
      continue
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      if (shouldProduce) nextLine = lineNumber + 1
      continue
    }
    const row = obj as Record<string, unknown>

    const type = typeof row.type === 'string' ? row.type : null
    const entryId = typeof row.id === 'string' && row.id.trim() !== '' ? row.id.trim() : null

    if (type === 'session') {
      if (entryId) sessionId = entryId
      if (typeof row.cwd === 'string' && row.cwd.trim() !== '') project = row.cwd
    } else {
      if (sessionId === undefined) {
        if (typeof row.sessionId === 'string' && row.sessionId.trim() !== '') {
          sessionId = row.sessionId.trim()
        }
      }
      if (project === undefined && typeof row.cwd === 'string' && row.cwd.trim() !== '') {
        project = row.cwd
      }
    }

    if (typeof row.model === 'string' && row.model.trim() !== '') modelId = row.model.trim()

    if (entryId) {
      const parent =
        typeof row.parentId === 'string' && row.parentId.trim() !== '' ? row.parentId.trim() : null
      parentMap.set(entryId, parent)
      lastEntryId = entryId
    }

    if (shouldProduce && type !== 'model_change') {
      const produced = toUsageRecord(row, {
        filePath,
        line: lineNumber,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(project !== undefined ? { project } : {}),
        model: modelId ?? UNKNOWN_MODEL
      })
      if (produced) buffered.push(produced)
    }
    if (shouldProduce) nextLine = lineNumber + 1
  }

  if (!eof) eof = true

  const branch = activeBranchIds(parentMap, lastEntryId)
  const records = buffered
    .filter((b) => branch === null || b.entryId === null || branch.has(b.entryId))
    .map((b) => b.record)
  return { records, nextLine, eof }
}

async function detect(): Promise<Detection> {
  return detectFromRoot(projectsRootOf())
}

async function listFiles(): Promise<FileEntry[]> {
  return listFilesFromRoot(projectsRootOf())
}

async function parseFile(
  _ctx: PluginContext,
  filePath: string,
  fromLine: number
): Promise<ParsedResult> {
  return parseTranscriptFile(filePath, fromLine)
}

export const commandCodePlugin: MonitorPlugin = {
  id: 'command-code',
  name: 'Command Code',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles,
  parseFile
}
