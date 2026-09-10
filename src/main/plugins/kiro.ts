import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'


export function dataRootOf(): string {
  const dir = process.env.KIRO_DIR
  if (dir && dir.trim() !== '') return dir.trim()
  return path.join(os.homedir(), '.kiro')
}

export function sessionRootOf(root: string): string {
  return path.join(root, 'sessions', 'cli')
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function statMtimeMs(p: string): number {
  try {
    return Math.round(fs.statSync(p).mtimeMs)
  } catch {
    return 0
  }
}

export function sidecarPathOf(jsonlPath: string): string {
  return jsonlPath.replace(/\.jsonl$/i, '.json')
}

export function isSessionFile(name: string): boolean {
  if (!name.endsWith('.jsonl')) return false
  if (name.startsWith('.')) return false
  return !/(?:\.tmp|\.swp|~)$/i.test(name)
}

export function listFilesFromRoot(sessionDir: string): FileEntry[] {
  const out: FileEntry[] = []
  for (const ent of safeReaddir(sessionDir)) {
    if (!ent.isFile() || !isSessionFile(ent.name)) continue
    const p = path.join(sessionDir, ent.name)
    out.push({ path: p, mtime: Math.max(statMtimeMs(p), statMtimeMs(sidecarPathOf(p))) })
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function detectFromRoot(root: string): Detection {
  const sessionDir = sessionRootOf(root)
  let dirOk = false
  try {
    dirOk = fs.statSync(sessionDir).isDirectory()
  } catch {
    dirOk = false
  }
  if (!dirOk) {
    return {
      available: false,
      reason: '未找到会话目录 ~/.kiro/sessions/cli（Kiro CLI 未安装或尚未产生会话，可用 $KIRO_DIR 覆盖数据根）',
      sessionDir
    }
  }
  if (listFilesFromRoot(sessionDir).length > 0) {
    return { available: true, sessionDir }
  }
  return {
    available: false,
    reason: '会话目录存在但未发现 *.jsonl 会话转录（Kiro CLI 尚未产生 CLI 会话）',
    sessionDir
  }
}

const toNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const toStr = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
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

interface TurnSource {
  index: number
  filePath: string
  model: string
  sessionId: string
  project: string | undefined
  updatedAtMs: number
}

function toUsageRecord(turn: unknown, opts: TurnSource): UsageRecord | null {
  const t = asRecord(turn)
  if (!t) return null

  return {
    appType: 'kiro',
    model: opts.model,
    rawModel: opts.model,
    inputTokens: toNum(t.input_token_count),
    outputTokens: toNum(t.output_token_count),
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    inputSemantics: 0,
    status: 'success',
    createdAt: parseTsMs(t.end_timestamp) || opts.updatedAtMs || Date.now(),
    project: opts.project,
    sessionId: opts.sessionId,
    source: {
      filePath: opts.filePath,
      line: opts.index + 1,
      requestId: `${opts.sessionId}:${opts.index}`
    }
  }
}

export function parseSessionFile(jsonlPath: string, fromLine: number): ParsedResult {
  const base =
    typeof fromLine === 'number' && Number.isFinite(fromLine) && fromLine > 0 ? Math.floor(fromLine) : 0

  let sidecar: unknown
  try {
    sidecar = JSON.parse(fs.readFileSync(sidecarPathOf(jsonlPath), 'utf8'))
  } catch {
    return { records: [], nextLine: base, eof: true }
  }

  const root = asRecord(sidecar)
  const state = asRecord(root?.session_state)
  const modelState = asRecord(state?.rts_model_state)
  const modelInfo = asRecord(modelState?.model_info)
  const model = toStr(modelInfo?.model_id)
  if (!model) {
    return { records: [], nextLine: base, eof: true }
  }

  const convMeta = asRecord(state?.conversation_metadata)
  const turnsRaw = convMeta ? convMeta.user_turn_metadatas : undefined
  const turns = Array.isArray(turnsRaw) ? (turnsRaw as unknown[]) : []

  const stem = path.basename(jsonlPath).replace(/\.jsonl$/i, '')
  const sessionId = toStr(root?.session_id) || stem
  const project = toStr(root?.cwd) || undefined
  const updatedAtMs = parseTsMs(root?.updated_at)

  const records: UsageRecord[] = []
  const startIndex = base > 0 ? base - 1 : 0
  for (let i = startIndex; i < turns.length; i++) {
    const record = toUsageRecord(turns[i], {
      index: i,
      filePath: jsonlPath,
      model,
      sessionId,
      project,
      updatedAtMs
    })
    if (record) records.push(record)
  }

  return { records, nextLine: Math.max(base, turns.length + 1), eof: true }
}

async function detect(): Promise<Detection> {
  return detectFromRoot(dataRootOf())
}

async function listFiles(): Promise<FileEntry[]> {
  return listFilesFromRoot(sessionRootOf(dataRootOf()))
}

async function parseFile(_ctx: PluginContext, filePath: string, fromLine: number): Promise<ParsedResult> {
  return parseSessionFile(filePath, fromLine)
}

export const kiroPlugin: MonitorPlugin = {
  id: 'kiro',
  name: 'Kiro CLI',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles,
  parseFile
}
