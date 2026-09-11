import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'

const CURSOR_MARKER = 2 ** 52
const CURSOR_TOTAL_BASE = 2 ** 32
const CURSOR_FINGERPRINT_MASK = 2 ** 20 - 1
const MAX_SNAPSHOT_TOTAL = CURSOR_TOTAL_BASE - 1
const SNAPSHOT_CACHE_LIMIT = 512

type SnapshotState = {
  sessionId: string
  total: number
}

const snapshotCache = new Map<string, SnapshotState>()

export function clearCodeWhaleSnapshotCache(): void {
  snapshotCache.clear()
}

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

export function parseTsMs(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    return v >= 1_000_000_000_000 ? v : v * 1000
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const parsed = Date.parse(v)
    if (!Number.isNaN(parsed)) return parsed
  }
  return 0
}

function nonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s === '' ? null : s
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`CodeWhale 会话格式不兼容：${label} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function requireSnapshotTotal(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_SNAPSHOT_TOTAL) {
    throw new Error(`CodeWhale 会话格式不兼容：metadata.total_tokens 必须是 0-${MAX_SNAPSHOT_TOTAL} 的整数`)
  }
  return value
}

function hash32(value: string, seed: number): number {
  let hash = seed >>> 0
  for (let i = 0; i < value.length; i++) {
    hash = Math.imul(hash ^ value.charCodeAt(i), 16_777_619) >>> 0
  }
  return hash
}

function sessionFingerprint(sessionId: string): number {
  return hash32(sessionId, 2_166_136_261) & CURSOR_FINGERPRINT_MASK
}

function encodeCursor(sessionId: string, total: number): number {
  return CURSOR_MARKER + sessionFingerprint(sessionId) * CURSOR_TOTAL_BASE + total
}

function decodeCursor(fromLine: number, sessionId: string): number | null {
  if (!Number.isSafeInteger(fromLine) || fromLine < 0) {
    throw new Error('CodeWhale 同步游标无效')
  }
  if (fromLine === 0) return null
  if (fromLine < CURSOR_MARKER) {
    if (fromLine > MAX_SNAPSHOT_TOTAL) throw new Error('CodeWhale 旧版同步游标超出支持范围')
    return fromLine
  }
  const payload = fromLine - CURSOR_MARKER
  const fingerprint = Math.floor(payload / CURSOR_TOTAL_BASE)
  const total = payload - fingerprint * CURSOR_TOTAL_BASE
  if (fingerprint !== sessionFingerprint(sessionId)) return null
  return total
}

function stableLine(requestId: string): number {
  const high = hash32(requestId, 2_166_136_261) & 0x1fffff
  const low = hash32(requestId, 3_335_557_771)
  return high * CURSOR_TOTAL_BASE + low || 1
}

function getCachedBaseline(filePath: string, sessionId: string): number | null {
  const state = snapshotCache.get(filePath)
  if (!state || state.sessionId !== sessionId) return null
  snapshotCache.delete(filePath)
  snapshotCache.set(filePath, state)
  return state.total
}

function cacheBaseline(filePath: string, state: SnapshotState): void {
  snapshotCache.delete(filePath)
  snapshotCache.set(filePath, state)
  while (snapshotCache.size > SNAPSHOT_CACHE_LIMIT) {
    const oldest = snapshotCache.keys().next().value as string | undefined
    if (oldest === undefined) break
    snapshotCache.delete(oldest)
  }
}

export function parseSessionFile(filePath: string, fromLine: number): ParsedResult {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch {
    throw new Error('无法读取 CodeWhale 会话文件')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (error) {
    throw new Error(`CodeWhale 会话 JSON 损坏：${error instanceof Error ? error.message : String(error)}`)
  }

  const root = requireObject(parsed, '根节点')
  if (root.schema_version !== 1) {
    throw new Error(`CodeWhale 会话格式不兼容：不支持 schema_version=${String(root.schema_version)}`)
  }
  const meta = requireObject(root.metadata, 'metadata')
  const sessionId = nonEmptyString(meta.id)
  if (!sessionId) throw new Error('CodeWhale 会话格式不兼容：metadata.id 缺失')
  const total = requireSnapshotTotal(meta.total_tokens)
  const createdAt = parseTsMs(meta.updated_at)
  if (createdAt === 0) throw new Error('CodeWhale 会话格式不兼容：metadata.updated_at 无效')

  const cursorBaseline = decodeCursor(fromLine, sessionId)
  const baseline = fromLine === 0 ? getCachedBaseline(filePath, sessionId) : cursorBaseline
  const nextLine = encodeCursor(sessionId, total)
  cacheBaseline(filePath, { sessionId, total })

  if (baseline === null || total <= baseline) {
    return { records: [], nextLine, eof: true }
  }

  const delta = total - baseline
  const model = nonEmptyString(meta.model) ?? 'unknown'
  const project = nonEmptyString(meta.workspace)
  const requestId = `${sessionId}:snapshot:${baseline}:${total}:${createdAt}`
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
    createdAt,
    sessionId,
    ...(project ? { project } : {}),
    source: { filePath, line: stableLine(requestId), requestId }
  }
  return { records: [record], nextLine, eof: true }
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
  parseFile,
  dispose: clearCodeWhaleSnapshotCache
}
