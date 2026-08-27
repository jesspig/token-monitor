import os from 'node:os'
import path from 'node:path'
import { join } from 'node:path'
import fs from 'node:fs'
import { Worker } from 'node:worker_threads'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'
import {
  hasZstdMagicAt,
  scanZstdFrames,
  type FrameScan,
  type FrameScanSuccess
} from '../workers/zstd-scan'


export function dataRootOf(): string {
  const override = process.env.DSH_HOME
  if (override && override.trim() !== '') return path.join(override.trim(), 'sessions')
  return path.join(os.homedir(), '.dsh', 'sessions')
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
  return name === 'session.jsonl' || name === 'session.jsonl.zstd'
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

function hasSessionFile(dir: string): boolean {
  for (const ent of safeReaddir(dir)) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (hasSessionFile(p)) return true
    } else if (ent.isFile() && isSessionFile(ent.name)) {
      return true
    }
  }
  return false
}

export function listFilesFromRoot(root: string): FileEntry[] {
  const out: FileEntry[] = []
  collectSubtree(root, out)
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

const SQLITE_BACKEND_HINT = 'SQLite 后端暂不支持，仅支持 JSONL（JSONL.zstd/raw）工件'

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
  if (!hasSessionFile(root)) {
    return {
      available: false,
      reason: `会话目录下未发现 session.jsonl / session.jsonl.zstd 工件（DeepSeek Harness 尚未产生会话；${SQLITE_BACKEND_HINT}）`,
      sessionDir: root
    }
  }
  return { available: true, sessionDir: root }
}

const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function truncateErrorMessage(text: string): string {
  return text.length > 500 ? text.slice(0, 500) : text
}

function toRetryErrorRecord(
  row: Record<string, unknown>,
  filePath: string,
  line: number,
  session: { sessionId?: string; project?: string; currentModel?: string }
): UsageRecord | null {
  if (row.type !== 'llm/retry') return null
  const data = row.data
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const failure = d.failure
  if (!failure || typeof failure !== 'object') return null
  const f = failure as Record<string, unknown>

  const codeRaw = f.code
  const code =
    typeof codeRaw === 'string' ? codeRaw.trim() : typeof codeRaw === 'number' && Number.isFinite(codeRaw) ? String(codeRaw) : ''
  const msgRaw = f.message ?? f.error ?? f.text
  const message = typeof msgRaw === 'string' ? msgRaw.trim() : ''
  let errorMessage: string | undefined
  if (code && message) errorMessage = truncateErrorMessage(`[${code}] ${message}`)
  else if (code) errorMessage = truncateErrorMessage(`[${code}]`)
  else if (message) errorMessage = truncateErrorMessage(message)
  else {
    try {
      const fallback = JSON.stringify(failure)
      if (fallback && fallback !== '{}') errorMessage = truncateErrorMessage(fallback)
    } catch {
      errorMessage = undefined
    }
  }

  const failureModel = typeof f.model === 'string' ? f.model.trim() : ''
  const dataModel = typeof d.model === 'string' ? d.model.trim() : ''
  let model = failureModel || dataModel || session.currentModel || ''
  if (!model) model = 'unknown'

  const rawSeq =
    typeof row.seq === 'number' && Number.isFinite(row.seq)
      ? String(row.seq)
      : typeof row.seq === 'string' && row.seq.trim() !== ''
        ? row.seq.trim()
        : undefined
  const requestId = session.sessionId && rawSeq ? `${session.sessionId}:${rawSeq}` : undefined

  const t = toNum(row.time)
  const createdAt = t > 0 ? t : Date.now()

  return {
    appType: 'dsh',
    model,
    rawModel: model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    inputSemantics: 2,
    status: 'error',
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    createdAt,
    project: session.project,
    sessionId: session.sessionId,
    source: { filePath, line, ...(requestId ? { requestId } : {}) }
  }
}

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
  if (msg.role !== undefined && msg.role !== 'assistant') return null

  const source =
    msg.source && typeof msg.source === 'object' ? (msg.source as Record<string, unknown>) : undefined
  const sourceModel = source && typeof source.model === 'string' ? source.model.trim() : ''
  const ownModel = typeof msg.model === 'string' ? msg.model.trim() : ''
  const model = sourceModel || ownModel || session.currentModel || ''
  if (!model) return null

  const usage = d.usage
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>

  const rawSeq =
    typeof row.seq === 'number' && Number.isFinite(row.seq)
      ? String(row.seq)
      : typeof row.seq === 'string' && row.seq.trim() !== ''
        ? row.seq.trim()
        : undefined
  const requestId = session.sessionId && rawSeq ? `${session.sessionId}:${rawSeq}` : undefined

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
    inputSemantics: 2,
    status: 'success',
    createdAt,
    project: session.project,
    sessionId: session.sessionId,
    source: { filePath, line, ...(requestId ? { requestId } : {}) }
  }
}

interface SessionHeadState {
  sessionId?: string
  project?: string
  currentModel?: string
  cursorLine: number
}

const SESSION_STATE_CACHE_MAX = 512


const ZSTD_WORKER_TIMEOUT_MS = 10_000

let zstdWorker: Worker | null = null
let zstdWorkerBroken = false
let nextScanId = 0
const pendingScans = new Map<
  number,
  { resolve: (scan: FrameScan) => void; reject: (err: unknown) => void }
>()

function failAllPendingScans(): void {
  for (const pending of pendingScans.values()) pending.reject(new Error('zstd worker unavailable'))
  pendingScans.clear()
}

async function destroyZstdWorker(): Promise<void> {
  const worker = zstdWorker
  zstdWorker = null
  if (!worker) return
  try {
    await worker.terminate()
  } catch {
  }
}

function ensureZstdWorker(): Worker | null {
  if (zstdWorkerBroken) return null
  if (zstdWorker) return zstdWorker
  try {
    const worker = new Worker(join(__dirname, 'zstd-worker.js'))
    worker.on('message', (res: { id?: number; scan?: FrameScan }) => {
      if (!res || typeof res.id !== 'number' || !res.scan) return
      const pending = pendingScans.get(res.id)
      if (!pending) return
      pendingScans.delete(res.id)
      pending.resolve(res.scan)
    })
    worker.on('error', () => {
      if (zstdWorker === worker) zstdWorker = null
      zstdWorkerBroken = true
      failAllPendingScans()
    })
    worker.on('exit', () => {
      if (zstdWorker === worker) zstdWorker = null
      failAllPendingScans()
    })
    zstdWorker = worker
    return worker
  } catch {
    zstdWorkerBroken = true
    return null
  }
}

async function scanZstdFramesAsync(buf: Buffer, from: number): Promise<FrameScan> {
  const worker = ensureZstdWorker()
  if (!worker) return scanZstdFrames(buf, from)
  const id = ++nextScanId
  let timer: NodeJS.Timeout | null = null
  try {
    return await new Promise<FrameScan>((resolve, reject) => {
      pendingScans.set(id, { resolve, reject })
      timer = setTimeout(() => {
        if (pendingScans.delete(id)) {
          reject(new Error(`zstd worker timeout (${ZSTD_WORKER_TIMEOUT_MS}ms)`))
        }
      }, ZSTD_WORKER_TIMEOUT_MS)
      worker.postMessage({ id, buf, from })
    })
  } catch {
    await destroyZstdWorker()
    return scanZstdFrames(buf, from)
  } finally {
    if (timer) clearTimeout(timer)
    pendingScans.delete(id)
  }
}

const sessionStateCache = new Map<string, SessionHeadState>()

async function parseFile(ctx: PluginContext, filePath: string, fromLine: number): Promise<ParsedResult> {
  let content = ''
  let startIndex = fromLine > 0 ? fromLine - 1 : 0
  let firstLineNumber = startIndex + 1
  let incremental = false
  let consumedByteOffset: number | null = null

  if (filePath.endsWith('.jsonl.zstd')) {
    let compressed: Buffer
    try {
      compressed = await fs.promises.readFile(filePath)
    } catch {
      return { records: [], nextLine: fromLine, eof: true }
    }

    let scan: FrameScanSuccess | null = null
    if (fromLine > 1) {
      const meta = await ctx.storage.getCursorMeta(filePath)
      const saved = meta?.byteOffset
      if (typeof saved === 'number' && Number.isFinite(saved) && hasZstdMagicAt(compressed, saved)) {
        const partial = await scanZstdFramesAsync(compressed, saved)
        if (partial.ok) {
          scan = partial
          incremental = true
        }
      }
    }
    if (scan === null) {
      const full = await scanZstdFramesAsync(compressed, 0)
      if (!full.ok) {
        return { records: [], nextLine: fromLine, eof: true }
      }
      scan = full
    }
    content = scan.text
    consumedByteOffset = scan.consumedEnd
    if (incremental) {
      firstLineNumber = fromLine
      startIndex = 0
    }
  } else {
    try {
      content = await fs.promises.readFile(filePath, 'utf8')
    } catch {
      return { records: [], nextLine: fromLine, eof: true }
    }
  }

  const lines = content.split('\n')
  const records: UsageRecord[] = []
  let sessionId: string | undefined
  let project: string | undefined
  let currentModel: string | undefined
  const cached = sessionStateCache.get(filePath)
  if (fromLine <= 1) {
    sessionStateCache.delete(filePath)
  } else if (cached && cached.cursorLine === fromLine) {
    sessionStateCache.delete(filePath)
    sessionId = cached.sessionId
    project = cached.project
    currentModel = cached.currentModel
  }
  if (incremental && content.trim() === '') {
    await ctx.storage.setCursor(filePath, fromLine, undefined, consumedByteOffset)
    sessionStateCache.set(filePath, { sessionId, project, currentModel, cursorLine: fromLine })
    return { records: [], nextLine: fromLine, eof: true }
  }
  let headerSeen = false
  let nextLine = fromLine
  let eof = false

  for (let i = startIndex; i < lines.length; i++) {
    const lineNumber = firstLineNumber + (i - startIndex)
    const raw = lines[i]
    if (raw.trim() === '') {
      nextLine = lineNumber + 1
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

    if (!obj || typeof obj !== 'object') {
      nextLine = lineNumber + 1
      continue
    }
    const row = obj as Record<string, unknown>

    if (!headerSeen && row.type === 'session') {
      if (typeof row.id === 'string' && row.id.trim() !== '') sessionId = row.id
      if (typeof row.cwd === 'string' && row.cwd.trim() !== '') project = row.cwd
      headerSeen = true
    } else if (row.type === 'request/header') {
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
      const errorRecord = toRetryErrorRecord(row, filePath, lineNumber, { sessionId, project, currentModel })
      if (errorRecord) {
        records.push(errorRecord)
      } else {
        const record = toUsageRecord(row, filePath, lineNumber, { sessionId, project, currentModel })
        if (record) records.push(record)
      }
    }
    nextLine = lineNumber + 1
  }

  if (!eof) eof = true

  if (consumedByteOffset !== null) {
    await ctx.storage.setCursor(filePath, nextLine, undefined, consumedByteOffset)
  }

  sessionStateCache.set(filePath, { sessionId, project, currentModel, cursorLine: nextLine })
  if (sessionStateCache.size > SESSION_STATE_CACHE_MAX) {
    const oldest = sessionStateCache.keys().next().value
    if (oldest !== undefined) sessionStateCache.delete(oldest)
  }

  return { records, nextLine, eof }
}

async function detect(): Promise<Detection> {
  return detectFromRoot(dataRootOf())
}

async function listFiles(): Promise<FileEntry[]> {
  return listFilesFromRoot(dataRootOf())
}

export const dshPlugin: MonitorPlugin = {
  id: 'dsh',
  name: 'DeepSeek Harness',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles,
  parseFile,
  dispose() {
    void destroyZstdWorker()
  }
}
