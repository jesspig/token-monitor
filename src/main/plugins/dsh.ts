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

const VERSIONED_SESSION_FILE = /^session\.v([12])\.jsonl(?:\.zstd)?$/
const LEGACY_SESSION_FILES = new Set(['session.jsonl', 'session.jsonl.zstd'])
const SESSION_LIKE_FILE = /^session(?:\.v\d+)?\.jsonl(?:\.[^.]+)?$/
const VERIFIED_FORMAT_DATE = '2026-09-10'

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

async function safeReaddirAsync(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function toEntryAsync(p: string): Promise<FileEntry> {
  let mtime = 0
  try {
    const st = await fs.promises.stat(p)
    mtime = Math.round(st.mtimeMs)
  } catch {
    mtime = 0
  }
  return { path: p, mtime }
}

function isIgnoredEntryName(name: string): boolean {
  return name.startsWith('.') || name.endsWith('~') || name.endsWith('.tmp') || name.endsWith('.swp')
}

function isSessionFile(name: string): boolean {
  return LEGACY_SESSION_FILES.has(name) || VERSIONED_SESSION_FILE.test(name)
}

function isParseableSessionFile(name: string): boolean {
  if (isIgnoredEntryName(name) || name.endsWith('.dsh')) return false
  const versioned = /^session\.v(\d+)\.jsonl(?:\.zstd)?$/.exec(name)
  if (versioned) return versioned[1] === '1' || versioned[1] === '2'
  return name.endsWith('.jsonl') || name.endsWith('.jsonl.zstd')
}

function isUnsupportedSessionArtifact(name: string): boolean {
  return name.endsWith('.dsh') || (SESSION_LIKE_FILE.test(name) && !isSessionFile(name))
}

async function collectSubtree(dir: string, out: FileEntry[]): Promise<void> {
  for (const ent of await safeReaddirAsync(dir)) {
    if (isIgnoredEntryName(ent.name)) continue
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      await collectSubtree(p, out)
    } else if (ent.isFile() && isSessionFile(ent.name)) {
      out.push(await toEntryAsync(p))
    }
  }
}

interface ArtifactScan {
  supported: boolean
  unsupported: Set<string>
}

function scanArtifacts(dir: string, scan: ArtifactScan): void {
  for (const ent of safeReaddir(dir)) {
    if (isIgnoredEntryName(ent.name)) continue
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      scanArtifacts(p, scan)
    } else if (ent.isFile()) {
      if (isSessionFile(ent.name)) scan.supported = true
      else if (isUnsupportedSessionArtifact(ent.name)) scan.unsupported.add(ent.name)
    }
  }
}

export async function listFilesFromRoot(root: string): Promise<FileEntry[]> {
  const out: FileEntry[] = []
  await collectSubtree(root, out)
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

const SUPPORTED_FORMAT_HINT = '支持 session.jsonl、session.jsonl.zstd、session.v1/v2.jsonl 及其 .zstd 形式'
const SQLITE_BACKEND_HINT = 'SQLite 后端不在当前插件支持范围'
const DSH_CONTAINER_FACT = `截至 ${VERIFIED_FORMAT_DATE} 的官方持久化定义未提供 .dsh 会话容器`

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

  const scan: ArtifactScan = { supported: false, unsupported: new Set<string>() }
  scanArtifacts(root, scan)
  const unsupported = [...scan.unsupported].sort()
  const incompatibility = unsupported.length > 0
    ? `检测到不兼容的 DSH 会话工件：${unsupported.join('、')}（${SUPPORTED_FORMAT_HINT}；${DSH_CONTAINER_FACT}）`
    : undefined

  if (!scan.supported) {
    return {
      available: false,
      reason: incompatibility ?? `会话目录下未发现受支持的 DSH 会话工件（${SUPPORTED_FORMAT_HINT}；${SQLITE_BACKEND_HINT}）`,
      sessionDir: root
    }
  }

  return { available: true, ...(incompatibility ? { reason: incompatibility } : {}), sessionDir: root }
}

const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function truncateErrorMessage(text: string): string {
  return text.length > 500 ? text.slice(0, 500) : text
}

interface SessionState {
  sessionId?: string
  project?: string
  currentModel?: string
}

function updateSessionState(row: Record<string, unknown>, session: SessionState): boolean {
  if (row.type === 'session') {
    if (typeof row.id === 'string' && row.id.trim() !== '') session.sessionId = row.id.trim()
    if (typeof row.cwd === 'string' && row.cwd.trim() !== '') session.project = row.cwd
    return true
  }

  if (row.type !== 'request/header') return false
  const data = row.data
  if (!data || typeof data !== 'object') return true
  const header = (data as Record<string, unknown>).header
  if (!header || typeof header !== 'object') return true
  const config = (header as Record<string, unknown>).config
  if (!config || typeof config !== 'object') return true
  const model = (config as Record<string, unknown>).model
  if (typeof model === 'string' && model.trim() !== '') session.currentModel = model.trim()
  return true
}

function toRetryErrorRecord(
  row: Record<string, unknown>,
  filePath: string,
  line: number,
  session: SessionState
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
    typeof codeRaw === 'string'
      ? codeRaw.trim()
      : typeof codeRaw === 'number' && Number.isFinite(codeRaw)
        ? String(codeRaw)
        : ''
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
  session: SessionState
): UsageRecord | null {
  if (row.type !== 'assistant/message') return null

  const data = row.data
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>

  const message = d.message
  if (!message || typeof message !== 'object') return null
  const msg = message as Record<string, unknown>
  if (msg.role !== undefined && msg.role !== 'assistant') return null

  const source = msg.source && typeof msg.source === 'object' ? (msg.source as Record<string, unknown>) : undefined
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

interface SessionHeadState extends SessionState {
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
        if (pendingScans.delete(id)) reject(new Error(`zstd worker timeout (${ZSTD_WORKER_TIMEOUT_MS}ms)`))
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

function parseStatePrefix(lines: string[], endIndex: number, session: SessionState): void {
  const limit = Math.min(endIndex, lines.length)
  for (let i = 0; i < limit; i++) {
    const raw = lines[i]
    if (raw.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') updateSessionState(parsed as Record<string, unknown>, session)
    } catch {
    }
  }
}

async function parseFile(ctx: PluginContext, filePath: string, fromLine: number): Promise<ParsedResult> {
  if (!isParseableSessionFile(path.basename(filePath))) return { records: [], nextLine: fromLine, eof: true }

  let content = ''
  let startIndex = fromLine > 0 ? fromLine - 1 : 0
  let firstLineNumber = 1
  let incremental = false
  let consumedByteOffset: number | null = null
  const cached = sessionStateCache.get(filePath)
  const hasCachedState = fromLine > 1 && cached?.cursorLine === fromLine
  let recoveredStateContent: string | null = null

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
          if (!hasCachedState) {
            const prefix = await scanZstdFramesAsync(compressed.subarray(0, saved), 0)
            if (!prefix.ok) return { records: [], nextLine: fromLine, eof: true }
            recoveredStateContent = prefix.text
          }
        }
      }
    }
    if (scan === null) {
      const full = await scanZstdFramesAsync(compressed, 0)
      if (!full.ok) return { records: [], nextLine: fromLine, eof: true }
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
  const session: SessionState = {}
  if (incremental && hasCachedState && cached) {
    session.sessionId = cached.sessionId
    session.project = cached.project
    session.currentModel = cached.currentModel
  } else if (incremental && recoveredStateContent !== null) {
    const stateLines = recoveredStateContent.split('\n')
    parseStatePrefix(stateLines, stateLines.length, session)
  } else {
    parseStatePrefix(lines, startIndex, session)
  }

  if (incremental && content.trim() === '') {
    await ctx.storage.setCursor(filePath, fromLine, undefined, consumedByteOffset)
    sessionStateCache.set(filePath, { ...session, cursorLine: fromLine })
    return { records: [], nextLine: fromLine, eof: true }
  }

  let nextLine = fromLine
  let eof = false

  for (let i = startIndex; i < lines.length; i++) {
    const lineNumber = firstLineNumber + i
    const raw = lines[i]
    if (raw.trim() === '') {
      nextLine = lineNumber + 1
      continue
    }

    let obj: unknown
    try {
      obj = JSON.parse(raw)
    } catch {
      const onlyEmptyAfter = lines.slice(i + 1).every((line) => line === '')
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

    if (!updateSessionState(row, session)) {
      const errorRecord = toRetryErrorRecord(row, filePath, lineNumber, session)
      if (errorRecord) records.push(errorRecord)
      else {
        const record = toUsageRecord(row, filePath, lineNumber, session)
        if (record) records.push(record)
      }
    }
    nextLine = lineNumber + 1
  }

  if (!eof) eof = true

  if (consumedByteOffset !== null) {
    await ctx.storage.setCursor(filePath, nextLine, undefined, consumedByteOffset)
  }

  sessionStateCache.set(filePath, { ...session, cursorLine: nextLine })
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
    sessionStateCache.clear()
    zstdWorkerBroken = false
    void destroyZstdWorker()
  }
}
