import os from 'node:os'
import path from 'node:path'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult } from '../../../shared/dto'
import { detectFromDbPaths, listFilesFromDbPaths, parseQoderDbFile } from './_lib/qoder-shared'

export function appSupportRootOf(): string {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support')
  if (process.platform === 'win32') {
    return process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
  }
  return path.join(os.homedir(), '.config')
}

export function qoderCandidatesFromRoots(appSupportRoot: string, homeRoot: string): string[] {
  return [
    path.join(appSupportRoot, 'Qoder', 'SharedClientCache', 'cache', 'db', 'local.db'),
    path.join(homeRoot, '.qoder', 'shared_client', 'cache', 'db', 'local.db')
  ]
}

export function qoderCandidatesFromOverrideRoot(root: string): string[] {
  return [
    path.join(root, 'SharedClientCache', 'cache', 'db', 'local.db'),
    path.join(root, 'shared_client', 'cache', 'db', 'local.db')
  ]
}

export function qoderDbCandidates(): string[] {
  const override = process.env.QODER_DIR
  if (override && override.trim() !== '') return qoderCandidatesFromOverrideRoot(override.trim())
  return qoderCandidatesFromRoots(appSupportRootOf(), os.homedir())
}

export const QODER_DETECT_MISSING_REASON =
  '未找到 Qoder 数据库（默认 %APPDATA%\\Qoder\\SharedClientCache\\cache\\db\\local.db 或 ~/.qoder/shared_client/cache/db/local.db，可用 $QODER_DIR 覆盖）'

async function detect(): Promise<Detection> {
  return detectFromDbPaths(qoderDbCandidates(), QODER_DETECT_MISSING_REASON)
}

async function listFiles(): Promise<FileEntry[]> {
  return listFilesFromDbPaths(qoderDbCandidates())
}

async function parseFile(_ctx: PluginContext, filePath: string, fromLine: number): Promise<ParsedResult> {
  return parseQoderDbFile('qoder', filePath, fromLine)
}

export const qoderPlugin: MonitorPlugin = {
  id: 'qoder',
  name: 'Qoder',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles,
  parseFile
}
