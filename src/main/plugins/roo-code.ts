import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { ParsedResult, UsageRecord } from '../../../shared/dto'
import {
  detectClineLikeTasksFromRoots,
  listClineLikeTaskFilesFromRoots,
  parseUiMessages,
  loadHistoryModel
} from './cline'
import { editorGlobalStorageRoots } from './_lib/cline-roots'

const EXTENSION_ID = 'rooveterinaryinc.roo-cline'
const HISTORY_FILE = 'api_conversation_history.json'

export function rooCodeGlobalStorageRoots(): string[] {
  return editorGlobalStorageRoots(process.env.ROO_CODE_DIR)
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
  const records: UsageRecord[] = parsed.records.map((record) => ({ ...record, appType: 'roo-code' }))
  return { records, nextLine: parsed.nextLine, eof: parsed.eof }
}

export const rooCodePlugin: MonitorPlugin = {
  id: 'roo-code',
  name: 'Roo Code',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect: async () => detectClineLikeTasksFromRoots(rooCodeGlobalStorageRoots(), EXTENSION_ID),
  listFiles: async () => listClineLikeTaskFilesFromRoots(rooCodeGlobalStorageRoots(), EXTENSION_ID),
  parseFile
}
