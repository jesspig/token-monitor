import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'


function sessionRoot(): string {
  return path.join(os.homedir(), '.gemini', 'tmp')
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

function isTempOrHidden(name: string): boolean {
  if (name.startsWith('.')) return true
  return /(?:\.tmp|\.swp|~)$/i.test(name)
}

function isJsonlSessionFile(name: string): boolean {
  return name.endsWith('.jsonl')
}

function isLegacySessionFile(name: string): boolean {
  return name.startsWith('session-') && name.endsWith('.json')
}

function collectChats(dir: string, depth: number, out: FileEntry[]): void {
  for (const ent of safeReaddir(dir)) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      collectChats(p, depth + 1, out)
    } else if (ent.isFile() && !isTempOrHidden(ent.name)) {
      if (isJsonlSessionFile(ent.name) || (depth === 0 && isLegacySessionFile(ent.name))) {
        out.push(toEntry(p))
      }
    }
  }
}

export function listFilesFromRoot(root: string): FileEntry[] {
  const out: FileEntry[] = []
  for (const hashDir of safeReaddir(root)) {
    if (!hashDir.isDirectory()) continue
    const projectDir = path.join(root, hashDir.name)
    for (const ent of safeReaddir(projectDir)) {
      if (ent.isDirectory() && ent.name === 'chats') {
        collectChats(path.join(projectDir, ent.name), 0, out)
      }
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function detectFromRoot(rootDir: string): Detection {
  let ok = false
  try {
    ok = fs.statSync(rootDir).isDirectory()
  } catch {
    ok = false
  }
  if (ok) return { available: true, sessionDir: rootDir }
  return {
    available: false,
    reason: '未找到会话目录 ~/.gemini/tmp（Gemini CLI 未安装或尚未产生会话）',
    sessionDir: rootDir
  }
}

function tokenOf(t: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    if (typeof t[k] === 'number' && Number.isFinite(t[k] as number)) return t[k] as number
  }
  return 0
}

const INPUT_KEYS = ['input', 'input_tokens', 'inputTokens']
const OUTPUT_KEYS = ['output', 'output_tokens', 'outputTokens']
const CACHE_READ_KEYS = [
  'cached',
  'cached_input_tokens',
  'cacheReadTokens',
  'cacheReadInputTokens',
  'cache_read_input_tokens'
]
const CACHE_CREATION_KEYS = [
  'cache_creation_tokens',
  'cacheCreationTokens',
  'cacheCreationInputTokens',
  'cache_creation_input_tokens'
]

function toSuccessRecord(
  doc: Record<string, unknown>,
  msg: unknown,
  filePath: string,
  line: number
): UsageRecord | null {
  if (!msg || typeof msg !== 'object') return null
  const m = msg as Record<string, unknown>
  if (m.type !== 'gemini') return null

  const model = typeof m.model === 'string' ? m.model.trim() : ''
  if (!model) return null

  const tokens = m.tokens
  if (!tokens || typeof tokens !== 'object') return null
  const t = tokens as Record<string, unknown>

  const ts = typeof m.timestamp === 'string' ? m.timestamp : ''
  const parsed = ts ? Date.parse(ts) : NaN

  const requestId = typeof m.id === 'string' && m.id.trim() !== '' ? m.id : undefined

  return {
    appType: 'gemini',
    model,
    rawModel: model,
    inputTokens: tokenOf(t, INPUT_KEYS),
    outputTokens: tokenOf(t, OUTPUT_KEYS),
    cacheReadTokens: tokenOf(t, CACHE_READ_KEYS),
    cacheCreationTokens: tokenOf(t, CACHE_CREATION_KEYS),
    inputSemantics: 1,
    status: 'success',
    createdAt: Number.isNaN(parsed) ? Date.now() : parsed,
    sessionId: typeof doc.sessionId === 'string' ? doc.sessionId : undefined,
    source: { filePath, line, requestId }
  }
}

function extractErrorContent(m: Record<string, unknown>): string | undefined {
  let raw: unknown = m.content
  if (raw === undefined) raw = m.text
  if (raw === undefined) raw = (m as Record<string, unknown>).message
  if (raw === undefined) raw = m.error
  if (raw === undefined) raw = m.errorMessage

  let str: string | undefined
  if (typeof raw === 'string') {
    str = raw
  } else if (Array.isArray(raw)) {
    str = raw
      .map((v) => {
        if (typeof v === 'string') return v
        if (v && typeof v === 'object') {
          const o = v as Record<string, unknown>
          if (typeof o.text === 'string') return o.text
          if (typeof o.content === 'string') return o.content
          try {
            return JSON.stringify(v)
          } catch {
            return String(v)
          }
        }
        return String(v)
      })
      .join('')
  } else if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    if (typeof o.text === 'string') str = o.text
    else if (typeof o.content === 'string') str = o.content
    else {
      try {
        str = JSON.stringify(raw)
      } catch {
        str = String(raw)
      }
    }
  }
  if (typeof str === 'string') {
    const trimmed = str.trim()
    if (trimmed) return trimmed.slice(0, 500)
  }
  return undefined
}

function toErrorRecord(
  msg: unknown,
  filePath: string,
  line: number,
  sessionId: string | undefined,
  lastModel: string | undefined
): UsageRecord | null {
  if (!msg || typeof msg !== 'object') return null
  const m = msg as Record<string, unknown>
  if (m.type !== 'error') return null

  const errorMessage = extractErrorContent(m)

  let createdAt: number = NaN
  const ts = m.timestamp
  if (typeof ts === 'string' && ts.trim() !== '') {
    createdAt = Date.parse(ts)
  } else if (typeof ts === 'number' && Number.isFinite(ts)) {
    createdAt = ts < 1e12 ? ts * 1000 : ts
  } else if (typeof m.time === 'string' && (m.time as string).trim() !== '') {
    createdAt = Date.parse(m.time as string)
  } else if (typeof m.time === 'number' && Number.isFinite(m.time as number)) {
    const n = m.time as number
    createdAt = n < 1e12 ? n * 1000 : n
  }
  if (Number.isNaN(createdAt)) createdAt = Date.now()

  const model = lastModel && lastModel.trim() !== '' ? lastModel.trim() : 'unknown'
  const requestId = typeof m.id === 'string' && m.id.trim() !== '' ? m.id.trim() : undefined

  return {
    appType: 'gemini',
    model,
    rawModel: model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    inputSemantics: 1,
    status: 'error',
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    createdAt,
    sessionId,
    source: { filePath, line, ...(requestId ? { requestId } : {}) }
  }
}

async function parseLegacyJsonFile(filePath: string, fromLine: number): Promise<ParsedResult> {
  let content: string
  try {
    content = await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return { records: [], nextLine: fromLine, eof: true }
  }

  let obj: unknown
  try {
    obj = JSON.parse(content)
  } catch {
    return { records: [], nextLine: fromLine, eof: true }
  }

  if (!obj || typeof obj !== 'object') return { records: [], nextLine: fromLine, eof: true }
  const doc = obj as Record<string, unknown>
  const messages = Array.isArray(doc.messages) ? doc.messages : []
  if (messages.length === 0) return { records: [], nextLine: fromLine, eof: true }

  const records: UsageRecord[] = []
  let nextLine = fromLine
  let lastModel: string | undefined

  for (let i = 0; i < messages.length; i++) {
    const ordinal = i + 1
    const msg = messages[i]

    const isGemini = !!msg && typeof msg === 'object' && (msg as Record<string, unknown>).type === 'gemini'
    const isError = !!msg && typeof msg === 'object' && (msg as Record<string, unknown>).type === 'error'
    let successCandidate: UsageRecord | null = null
    if (isGemini) {
      successCandidate = toSuccessRecord(doc, msg, filePath, ordinal)
      if (successCandidate) lastModel = successCandidate.model
    }

    if (ordinal <= fromLine) {
      nextLine = ordinal
      continue
    }

    if (isError) {
      const err = toErrorRecord(
        msg,
        filePath,
        ordinal,
        typeof doc.sessionId === 'string' ? doc.sessionId : undefined,
        lastModel
      )
      if (err) records.push(err)
      nextLine = ordinal
    } else if (isGemini) {
      if (successCandidate) records.push(successCandidate)
      nextLine = ordinal
    } else {
      nextLine = ordinal
    }
  }

  return { records, nextLine, eof: true }
}

async function parseJsonlFile(filePath: string, fromLine: number): Promise<ParsedResult> {
  let content: string
  try {
    content = await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return { records: [], nextLine: fromLine, eof: true }
  }

  const lines = content.split('\n')
  const records: UsageRecord[] = []
  let sessionId: string | undefined
  let lastModel: string | undefined
  let nextLine = fromLine
  let eof = false

  const startIndex = fromLine > 0 ? fromLine - 1 : 0
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1
    const raw = lines[i]
    const inRange = i >= startIndex

    if (raw.trim() === '') {
      if (inRange) nextLine = lineNumber + 1
      continue
    }

    let obj: unknown
    try {
      obj = JSON.parse(raw)
    } catch {
      const onlyEmptyAfter = lines.slice(i + 1).every((l) => l === '')
      if (onlyEmptyAfter) {
        if (inRange) nextLine = lineNumber
        eof = true
        break
      }
      if (inRange) nextLine = lineNumber + 1
      continue
    }

    if (!obj || typeof obj !== 'object') {
      if (inRange) nextLine = lineNumber + 1
      continue
    }
    const row = obj as Record<string, unknown>

    const patch = row.$set
    if (patch && typeof patch === 'object') {
      const s = (patch as Record<string, unknown>).sessionId
      if (typeof s === 'string' && s.trim() !== '') sessionId = s
      if (inRange) nextLine = lineNumber + 1
      continue
    } else if (typeof row.sessionId === 'string' && row.type === undefined) {
      sessionId = row.sessionId
      if (inRange) nextLine = lineNumber + 1
      continue
    } else {
      const isGemini = row.type === 'gemini'
      const isError = row.type === 'error'

      let successCandidate: UsageRecord | null = null
      if (isGemini) {
        successCandidate = toSuccessRecord({ sessionId }, row, filePath, lineNumber)
        if (successCandidate) lastModel = successCandidate.model
      }

      if (!inRange) continue

      if (isError) {
        const err = toErrorRecord(row, filePath, lineNumber, sessionId, lastModel)
        if (err) records.push(err)
        nextLine = lineNumber + 1
      } else if (isGemini) {
        if (successCandidate) records.push(successCandidate)
        nextLine = lineNumber + 1
      } else {
        nextLine = lineNumber + 1
      }
    }
  }

  if (!eof) eof = true

  return { records, nextLine, eof }
}

async function parseFile(
  _ctx: PluginContext,
  filePath: string,
  fromLine: number
): Promise<ParsedResult> {
  return filePath.toLowerCase().endsWith('.jsonl')
    ? parseJsonlFile(filePath, fromLine)
    : parseLegacyJsonFile(filePath, fromLine)
}

async function detect(): Promise<Detection> {
  return detectFromRoot(sessionRoot())
}

export const geminiPlugin: MonitorPlugin = {
  id: 'gemini',
  name: 'Gemini CLI',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles: async () => listFilesFromRoot(sessionRoot()),
  parseFile
}
