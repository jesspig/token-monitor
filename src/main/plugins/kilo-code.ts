import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult, UsageRecord } from '../../../shared/dto'
import {
  detectClineLikeTasks,
  listClineLikeTaskFiles,
  parseUiMessages,
  loadHistoryModel
} from './cline'
import {
  currentDatabaseEntry,
  currentDatabasePath,
  inspectKiloDatabase,
  parseCurrentDatabase
} from './_lib/kilo-storage'

const EXTENSION_ID = 'kilocode.kilo-code'
const HISTORY_FILE = 'api_conversation_history.json'
const UI_MESSAGES_FILE = 'ui_messages.json'

export function legacyGlobalStorageRoot(): string {
  const override = process.env.KILO_CODE_DIR
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

function legacyDetection(): Detection {
  return detectClineLikeTasks(legacyGlobalStorageRoot(), EXTENSION_ID)
}

export function detectKiloCode(): Detection {
  const dbPath = currentDatabasePath()
  const database = inspectKiloDatabase(dbPath)
  if (database.compatible) return { available: true, sessionDir: path.dirname(dbPath) }

  const legacy = legacyDetection()
  if (legacy.available) return legacy
  if (database.exists) {
    return {
      available: false,
      reason: database.reason,
      sessionDir: path.dirname(dbPath)
    }
  }
  return {
    available: false,
    reason: `未找到 Kilo Code 当前存储 kilo.db，也未找到旧版扩展 ${EXTENSION_ID} 的任务数据`,
    sessionDir: path.dirname(dbPath)
  }
}

export function listKiloCodeFiles(): FileEntry[] {
  const dbPath = currentDatabasePath()
  const database = inspectKiloDatabase(dbPath)
  if (database.compatible) {
    const entry = currentDatabaseEntry(dbPath)
    return entry ? [entry] : []
  }

  const legacyFiles = listClineLikeTaskFiles(legacyGlobalStorageRoot(), EXTENSION_ID)
  const databaseEntry = database.exists ? currentDatabaseEntry(dbPath) : null
  return databaseEntry ? [databaseEntry, ...legacyFiles] : legacyFiles
}

function parseLegacyFile(filePath: string, raw: string, fallbackModel?: string): ParsedResult {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error(`Kilo Code 旧版存储损坏：${UI_MESSAGES_FILE} 不是合法 JSON`)
  }
  if (!Array.isArray(value)) {
    throw new Error(`Kilo Code 旧版存储 schema 不兼容：${UI_MESSAGES_FILE} 顶层必须是数组`)
  }
  const parsed = parseUiMessages(filePath, raw, fallbackModel)
  const records: UsageRecord[] = parsed.records.map((record) => ({ ...record, appType: 'kilo-code' }))
  return { records, nextLine: parsed.nextLine, eof: parsed.eof }
}

async function parseFile(
  _ctx: PluginContext,
  filePath: string,
  fromLine: number
): Promise<ParsedResult> {
  if (path.basename(filePath) === 'kilo.db') return parseCurrentDatabase(filePath, fromLine)

  let raw: string
  try {
    raw = await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return { records: [], nextLine: fromLine, eof: true }
  }
  const fallbackModel = await loadHistoryModel(path.join(path.dirname(filePath), HISTORY_FILE))
  return parseLegacyFile(filePath, raw, fallbackModel)
}

export const kiloCodePlugin: MonitorPlugin = {
  id: 'kilo-code',
  name: 'Kilo Code',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect: async () => detectKiloCode(),
  listFiles: async () => listKiloCodeFiles(),
  parseFile
}
