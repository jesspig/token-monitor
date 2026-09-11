import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'
import {
  detectTasksFromRoots,
  editorGlobalStorageRoots,
  listTaskFilesFromRoots
} from './_lib/cline-roots'

const EXTENSION_ID = 'saoudrizwan.claude-dev'
const HISTORY_FILE = 'api_conversation_history.json'
const API_REQ_STARTED = 'api_req_started'
const HASH_OFFSET = 14695981039346656037n
const HASH_PRIME = 1099511628211n
const HASH_MASK = (1n << 53n) - 1n

export function clineGlobalStorageRoots(): string[] {
  return editorGlobalStorageRoots(process.env.CLINE_DIR)
}

export function listClineLikeTaskFiles(globalStorageDir: string, extensionId: string): FileEntry[] {
  return listTaskFilesFromRoots([globalStorageDir], extensionId)
}

export function listClineLikeTaskFilesFromRoots(
  globalStorageDirs: string[],
  extensionId: string
): FileEntry[] {
  return listTaskFilesFromRoots(globalStorageDirs, extensionId)
}

export function detectClineLikeTasks(globalStorageDir: string, extensionId: string): Detection {
  return detectTasksFromRoots([globalStorageDir], extensionId)
}

export function detectClineLikeTasksFromRoots(
  globalStorageDirs: string[],
  extensionId: string
): Detection {
  return detectTasksFromRoots(globalStorageDirs, extensionId)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function toFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function toRequestId(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed === '' ? undefined : trimmed
  }
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined
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
  const record = asRecord(info)
  if (!record) return undefined
  const modelId = record.modelId
  if (typeof modelId !== 'string') return undefined
  const trimmed = modelId.trim()
  return trimmed === '' ? undefined : trimmed
}

function stableLine(requestId: string, fallback: number): number {
  if (/^(0|[1-9]\d*)$/.test(requestId)) {
    const numeric = Number(requestId)
    if (Number.isSafeInteger(numeric)) return numeric
  }
  let hash = HASH_OFFSET
  for (let index = 0; index < requestId.length; index++) {
    hash ^= BigInt(requestId.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * HASH_PRIME)
  }
  const value = Number(hash & HASH_MASK)
  return value === 0 ? fallback + 1 : value
}

function parseUiMessageArray(raw: string): unknown[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('ui_messages.json 不是合法 JSON')
  }
  if (!Array.isArray(parsed)) throw new Error('ui_messages.json schema 不兼容：顶层必须是数组')
  return parsed
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
    throw new Error('api_conversation_history.json 不是合法 JSON')
  }
  if (!Array.isArray(parsed)) {
    throw new Error('api_conversation_history.json schema 不兼容：顶层必须是数组')
  }
  for (let index = parsed.length - 1; index >= 0; index--) {
    const message = asRecord(parsed[index])
    if (!message) continue
    const modelId = extractModelId(message.modelInfo)
    if (modelId) return modelId
  }
  return undefined
}

export function parseUiMessages(filePath: string, raw: string, fallbackModel?: string): ParsedResult {
  const parsed = parseUiMessageArray(raw)
  const records: UsageRecord[] = []
  let pendingBackfill = false

  for (let index = 0; index < parsed.length; index++) {
    const row = asRecord(parsed[index])
    if (!row || row.say !== API_REQ_STARTED) continue

    if (typeof row.text !== 'string') {
      throw new Error(`ui_messages.json 第 ${index + 1} 项 api_req_started.text 必须是字符串`)
    }
    if (row.text.trim() === '') {
      pendingBackfill = true
      continue
    }
    const info = parseTextJson(row.text)
    if (!info) throw new Error(`ui_messages.json 第 ${index + 1} 项 api_req_started.text 不是合法 JSON 对象`)
    const tokensIn = toFinite(info.tokensIn)
    const tokensOut = toFinite(info.tokensOut)
    if (tokensIn === undefined && tokensOut === undefined) {
      pendingBackfill = true
      continue
    }

    const model = extractModelId(row.modelInfo) ?? fallbackModel
    if (!model) continue

    const timestamp = toFinite(row.ts)
    const requestId = toRequestId(row.requestId) ?? toRequestId(info.requestId) ?? toRequestId(timestamp)
    records.push({
      appType: 'cline',
      model,
      rawModel: model,
      inputTokens: tokensIn ?? 0,
      outputTokens: tokensOut ?? 0,
      cacheReadTokens: toFinite(info.cacheReads) ?? 0,
      cacheCreationTokens: toFinite(info.cacheWrites) ?? 0,
      inputSemantics: 2,
      status: 'success',
      createdAt: timestamp ?? Date.now(),
      source: {
        filePath,
        line: requestId ? stableLine(requestId, index) : index,
        ...(requestId ? { requestId } : {})
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
  detect: async () => detectClineLikeTasksFromRoots(clineGlobalStorageRoots(), EXTENSION_ID),
  listFiles: async () => listClineLikeTaskFilesFromRoots(clineGlobalStorageRoots(), EXTENSION_ID),
  parseFile
}
