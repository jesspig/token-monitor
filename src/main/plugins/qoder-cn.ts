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

export function qoderCnCandidatesFromRoots(homeRoot: string, appSupportRoot: string): string[] {
  return [
    path.join(homeRoot, '.qoder-cn', 'shared_client', 'cache', 'db', 'local.db'),
    path.join(appSupportRoot, 'QoderCN', 'SharedClientCache', 'cache', 'db', 'local.db'),
    path.join(appSupportRoot, 'Qoder CN', 'SharedClientCache', 'cache', 'db', 'local.db')
  ]
}

export function qoderCnCandidatesFromOverrideRoot(root: string): string[] {
  return [
    path.join(root, 'shared_client', 'cache', 'db', 'local.db'),
    path.join(root, 'QoderCN', 'SharedClientCache', 'cache', 'db', 'local.db'),
    path.join(root, 'Qoder CN', 'SharedClientCache', 'cache', 'db', 'local.db')
  ]
}

export function qoderCnDbCandidates(): string[] {
  const override = process.env.QODER_CN_DIR
  if (override && override.trim() !== '') return qoderCnCandidatesFromOverrideRoot(override.trim())
  return qoderCnCandidatesFromRoots(os.homedir(), appSupportRootOf())
}

export const QODER_CN_DETECT_MISSING_REASON =
  '未找到 Qoder CN 数据库（默认 ~/.qoder-cn/shared_client/cache/db/local.db 或 %APPDATA%\\QoderCN\\SharedClientCache\\cache\\db\\local.db，可用 $QODER_CN_DIR 覆盖）'

async function detect(): Promise<Detection> {
  return detectFromDbPaths(qoderCnDbCandidates(), QODER_CN_DETECT_MISSING_REASON)
}

async function listFiles(): Promise<FileEntry[]> {
  return listFilesFromDbPaths(qoderCnDbCandidates())
}

async function parseFile(_ctx: PluginContext, filePath: string, fromLine: number): Promise<ParsedResult> {
  return parseQoderDbFile('qoder-cn', filePath, fromLine)
}

export const qoderCnPlugin: MonitorPlugin = {
  id: 'qoder-cn',
  name: 'Qoder CN',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles,
  parseFile
}
