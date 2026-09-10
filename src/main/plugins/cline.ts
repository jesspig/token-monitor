import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'

const EXTENSION_ID = 'saoudrizwan.claude-dev'
const UI_MESSAGES_FILE = 'ui_messages.json'
const HISTORY_FILE = 'api_conversation_history.json'
const API_REQ_STARTED = 'api_req_started'

function globalStorageRoot(): string {
  const override = process.env.CLINE_DIR
  if (override && override.trim() !== '') return override.trim()
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (appData) return path.join(appData, 'Code', 'User', 'globalStorage')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage')
  }
  return path.join(os.homedir(), '.config', 'Code', 'User', 'globalStorage')
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function toEntry(p: string): FileEntry | null {
  try {
    const mtime = Math.round(fs.statSync(p).mtimeMs)
    if (!Number.isFinite(mtime) || mtime <= 0) return null
    return { path: p, mtime }
  } catch {
    return null
  }
}

export function listClineLikeTaskFiles(globalStorageDir: string, extensionId: string): FileEntry[] {
  const tasksDir = path.join(globalStorageDir, extensionId, 'tasks')
  const out: FileEntry[] = []
  for (const ent of safeReaddir(tasksDir)) {
    if (!ent.isDirectory()) continue
    const entry = toEntry(path.join(tasksDir, ent.name, UI_MESSAGES_FILE))
    if (entry) out.push(entry)
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

function hasAnyTaskFile(tasksDir: string): boolean {
  for (const ent of safeReaddir(tasksDir)) {
    if (!ent.isDirectory()) continue
    try {
      if (fs.statSync(path.join(tasksDir, ent.name, UI_MESSAGES_FILE)).isFile()) return true
    } catch {
      continue
    }
  }
  return false
}

export function detectClineLikeTasks(globalStorageDir: string, extensionId: string): Detection {
  const tasksDir = path.join(globalStorageDir, extensionId, 'tasks')
  if (hasAnyTaskFile(tasksDir)) return { available: true, sessionDir: tasksDir }
  return {
    available: false,
    reason: `未找到扩展 ${extensionId} 的任务数据（扩展未安装或尚未产生任务）`,
    sessionDir: tasksDir
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  return v as Record<string, unknown>
}

function toFinite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function parseTextJson(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string' || text.trim() === '') return null
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return null
  }
}

function extractModelId(info: unknown): string | undefined {
  const rec = asRecord(info)
  if (!rec) return undefined
  const modelId = rec.modelId
  if (typeof modelId !== 'string') return undefined
  const trimmed = modelId.trim()
  return trimmed === '' ? undefined : trimmed
}

export async function loadHistoryModel(historyPath: string): Promise<string | undefined> {
  let raw: string
  try {
    raw = await fs.promises.readFile(historyPath, 'utf8')
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  for (let i = parsed.length - 1; i >= 0; i--) {
    const msg = asRecord(parsed[i])
    if (!msg) continue
    const modelId = extractModelId(msg.modelInfo)
    if (modelId) return modelId
  }
  return undefined
}

export function parseUiMessages(filePath: string, raw: string, fallbackModel?: string): ParsedResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { records: [], nextLine: 0, eof: true }
  }
  if (!Array.isArray(parsed)) return { records: [], nextLine: 0, eof: true }

  const records: UsageRecord[] = []
  let pendingBackfill = false

  for (let i = 0; i < parsed.length; i++) {
    const row = asRecord(parsed[i])
    if (!row) continue
    if (row.say !== API_REQ_STARTED) continue

    const info = parseTextJson(row.text)
    const tokensIn = info ? toFinite(info.tokensIn) : undefined
    const tokensOut = info ? toFinite(info.tokensOut) : undefined
    if (tokensIn === undefined && tokensOut === undefined) {
      pendingBackfill = true
      continue
    }

    const model = extractModelId(row.modelInfo) ?? fallbackModel
    if (!model) continue

    const ts = toFinite(row.ts)
    records.push({
      appType: 'cline',
      model,
      rawModel: model,
      inputTokens: tokensIn ?? 0,
      outputTokens: tokensOut ?? 0,
      cacheReadTokens: toFinite(info?.cacheReads) ?? 0,
      cacheCreationTokens: toFinite(info?.cacheWrites) ?? 0,
      inputSemantics: 2,
      status: 'success',
      createdAt: ts ?? Date.now(),
      source: {
        filePath,
        line: i,
        ...(ts !== undefined ? { requestId: String(ts) } : {})
      }
    })
  }

  return { records, nextLine: pendingBackfill ? 0 : parsed.length, eof: true }
}

async function parseFile(
  _ctx: PluginContext,
  filePath: string,
  fromLine: number
): Promise<ParsedResult> {
  let raw: string
  try {
    raw = await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return { records: [], nextLine: fromLine, eof: true }
  }
  const fallbackModel = await loadHistoryModel(path.join(path.dirname(filePath), HISTORY_FILE))
  return parseUiMessages(filePath, raw, fallbackModel)
}

export const clinePlugin: MonitorPlugin = {
  id: 'cline',
  name: 'Cline',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect: async () => detectClineLikeTasks(globalStorageRoot(), EXTENSION_ID),
  listFiles: async () => listClineLikeTaskFiles(globalStorageRoot(), EXTENSION_ID),
  parseFile
}
