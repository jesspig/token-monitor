import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult } from '../../../shared/dto'
import { createOpencodeLikePluginCore, maxMtime } from './_lib/opencode-shared'

export { statMtimeMs, maxMtime } from './_lib/opencode-shared'

export const DB_SOURCE_SUFFIX = 'deveco.db'

const core = createOpencodeLikePluginCore({
  appType: 'dev-eco',
  dbName: DB_SOURCE_SUFFIX,
  channelVariants: ['deveco-beta.db', 'deveco-prod.db'],
  detectMissingRootReason: () =>
    '未找到数据根（默认 ~/.local/share/deveco，可用 $DEVECO_DIR、$XDG_DATA_HOME 或 $DEVECO_DB 覆盖）',
  detectUnavailableReason: () => '数据根下未发现 deveco.db（DevEco Code 未安装或尚未产生会话）'
})

export function dataRoot(): string {
  const dir = process.env.DEVECO_DIR
  if (dir && dir.trim() !== '') return dir.trim()
  const xdg = process.env.XDG_DATA_HOME
  if (xdg && xdg.trim() !== '') return path.join(xdg.trim(), 'deveco')
  return path.join(os.homedir(), '.local', 'share', 'deveco')
}

export function dbOverridePath(): string | undefined {
  const db = process.env.DEVECO_DB
  if (db && db.trim() !== '') return db.trim()
  return undefined
}

export function detectFromRoot(root: string): Detection {
  const override = dbOverridePath()
  if (override) {
    const dir = path.dirname(override)
    if (fs.existsSync(override)) return { available: true, sessionDir: dir }
    return {
      available: false,
      reason: '未发现 $DEVECO_DB 指定的数据库文件（DevEco Code 未安装或尚未产生会话）',
      sessionDir: dir
    }
  }
  return core.detectFromRoot(root)
}

export function listFilesFromRoot(root: string): FileEntry[] {
  const override = dbOverridePath()
  if (override) {
    if (!fs.existsSync(override)) return []
    return [{ path: override, mtime: maxMtime([override, override + '-wal']) }]
  }
  return core.listDbFiles(root)
}

export const parseDbFile = core.parseDbFile

async function detect(): Promise<Detection> {
  return detectFromRoot(dataRoot())
}

async function listFiles(): Promise<FileEntry[]> {
  return listFilesFromRoot(dataRoot())
}

async function parseFile(_ctx: PluginContext, filePath: string, fromLine: number): Promise<ParsedResult> {
  return parseDbFile(filePath, fromLine)
}

export const devEcoPlugin: MonitorPlugin = {
  id: 'dev-eco',
  name: 'DevEco Code',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles,
  parseFile
}
