import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult } from '../../../shared/dto'
import { createOpencodeLikePluginCore, maxMtime } from './_lib/opencode-shared'

export { statMtimeMs, maxMtime } from './_lib/opencode-shared'

export const DB_SOURCE_SUFFIX = 'mimocode.db'

export const CHANNEL_DB_NAMES = ['mimocode-beta.db', 'mimocode-prod.db']

export const MIMOCODE_DB_ENV = 'MIMOCODE_DB'
export const MIMOCODE_HOME_ENV = 'MIMOCODE_HOME'
export const MIMO_DIR_ENV = 'MIMO_DIR'

export const HOME_LAYOUT_DATA_SUBDIR = 'data'

const core = createOpencodeLikePluginCore({
  appType: 'mimo',
  dbName: DB_SOURCE_SUFFIX,
  channelVariants: CHANNEL_DB_NAMES,
  detectMissingRootReason: (root) => `未找到数据根 ${root}（默认 ~/.local/share/mimocode，可用 $MIMO_DIR 覆盖）`,
  detectUnavailableReason: () => '数据根下未发现 mimocode.db（MiMo Code 未安装或尚未产生会话）'
})

function envValue(name: string): string | undefined {
  const raw = process.env[name]
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

export function defaultDataRoot(): string {
  const override = envValue(MIMO_DIR_ENV)
  if (override) return override
  return path.join(os.homedir(), '.local', 'share', 'mimocode')
}

export function homeLayoutRoot(home: string): string {
  return path.join(home, HOME_LAYOUT_DATA_SUBDIR)
}

export function dbCandidates(): string[] {
  const dbOverride = envValue(MIMOCODE_DB_ENV)
  if (dbOverride) return [dbOverride]
  const out: string[] = []
  for (const name of core.dbNames) out.push(path.join(defaultDataRoot(), name))
  const home = envValue(MIMOCODE_HOME_ENV)
  if (home) {
    const layoutRoot = homeLayoutRoot(home)
    for (const name of core.dbNames) out.push(path.join(layoutRoot, name))
  }
  return out
}

export function detectFromLayouts(): Detection {
  const dbOverride = envValue(MIMOCODE_DB_ENV)
  if (dbOverride) {
    if (fs.existsSync(dbOverride)) {
      return { available: true, sessionDir: path.dirname(dbOverride) }
    }
    return {
      available: false,
      reason: '$MIMOCODE_DB 指向的库文件不存在，请检查该环境变量指向的路径',
      sessionDir: path.dirname(dbOverride)
    }
  }
  const root = defaultDataRoot()
  if (dbCandidates().some((p) => fs.existsSync(p))) {
    return { available: true, sessionDir: root }
  }
  return {
    available: false,
    reason: '未发现 mimocode.db（默认 ~/.local/share/mimocode，可用 $MIMOCODE_DB 指定库文件、$MIMOCODE_HOME 指定数据根；MiMo Code 未安装或尚未产生会话）',
    sessionDir: root
  }
}

export function listFilesFromLayouts(): FileEntry[] {
  const out: FileEntry[] = []
  for (const p of dbCandidates()) {
    if (fs.existsSync(p)) out.push({ path: p, mtime: maxMtime([p, p + '-wal']) })
  }
  return out
}

export const parseDbFile = core.parseDbFile

async function detect(): Promise<Detection> {
  return detectFromLayouts()
}

async function listFiles(): Promise<FileEntry[]> {
  return listFilesFromLayouts()
}

async function parseFile(_ctx: PluginContext, filePath: string, fromLine: number): Promise<ParsedResult> {
  return parseDbFile(filePath, fromLine)
}

export const mimoPlugin: MonitorPlugin = {
  id: 'mimo',
  name: 'MiMo Code',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles,
  parseFile
}
