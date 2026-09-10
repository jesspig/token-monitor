import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { ParsedResult, UsageRecord } from '../../../shared/dto'
import {
  detectClineLikeTasks,
  listClineLikeTaskFiles,
  parseUiMessages,
  loadHistoryModel
} from './cline'

const EXTENSION_ID = 'kilocode.kilo-code'
const HISTORY_FILE = 'api_conversation_history.json'

function globalStorageRoot(): string {
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
  const parsed = parseUiMessages(filePath, raw, fallbackModel)
  const records: UsageRecord[] = parsed.records.map((r) => ({ ...r, appType: 'kilo-code' }))
  return { records, nextLine: parsed.nextLine, eof: parsed.eof }
}

export const kiloCodePlugin: MonitorPlugin = {
  id: 'kilo-code',
  name: 'Kilo Code',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect: async () => detectClineLikeTasks(globalStorageRoot(), EXTENSION_ID),
  listFiles: async () => listClineLikeTaskFiles(globalStorageRoot(), EXTENSION_ID),
  parseFile
}
