import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { MonitorPlugin } from '../../../shared/plugin'
import type { PluginContext } from '../../../shared/context'
import type { Detection, FileEntry, ParsedResult } from '../../../shared/dto'
import {
  OPENCODE_LIKE_DB_BUSY_TIMEOUT_MS,
  createOpencodeLikePluginCore,
  statMtimeMs
} from './_lib/opencode-shared'

export { statMtimeMs, maxMtime } from './_lib/opencode-shared'

export const DB_SOURCE_SUFFIX = 'opencode.db'

export const CHANNEL_DB_NAMES = ['opencode-prod.db']

export const EXTERNAL_DB_BUSY_TIMEOUT_MS = OPENCODE_LIKE_DB_BUSY_TIMEOUT_MS

const core = createOpencodeLikePluginCore({
  appType: 'opencode',
  dbName: DB_SOURCE_SUFFIX,
  channelVariants: CHANNEL_DB_NAMES,
  detectMissingRootReason: () => '未找到数据根（默认 ~/.local/share/opencode，可用 $OPENCODE_HOME 覆盖）',
  detectUnavailableReason: () => '数据根下未发现 opencode.db、opencode-prod.db 或 storage/message（OpenCode 未安装或尚未产生会话）'
})

export function dataRoot(): string {
  const home = process.env.OPENCODE_HOME
  if (home && home.trim() !== '') return home.trim()
  return path.join(os.homedir(), '.local', 'share', 'opencode')
}

export function dbPathOf(root: string): string {
  return path.join(root, DB_SOURCE_SUFFIX)
}

function messageDirOf(root: string): string {
  return path.join(root, 'storage', 'message')
}

function sessionDirOf(root: string): string {
  return path.join(root, 'storage', 'session')
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function toEntry(p: string): FileEntry {
  return { path: p, mtime: statMtimeMs(p) }
}

function isJsonFile(name: string): boolean {
  if (!name.endsWith('.json')) return false
  if (name.startsWith('.')) return false
  return !/(?:\.tmp|\.swp|~)$/i.test(name)
}

function collectMessageDir(dir: string, out: FileEntry[]): void {
  for (const ent of safeReaddir(dir)) {
    if (!ent.isFile()) continue
    if (isJsonFile(ent.name)) out.push(toEntry(path.join(dir, ent.name)))
  }
}

function collectSessionDir(dir: string, out: FileEntry[]): void {
  for (const ent of safeReaddir(dir)) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) collectSessionDir(p, out)
    else if (ent.isFile() && isJsonFile(ent.name)) out.push(toEntry(p))
  }
}

export function listFilesFromRoot(root: string): FileEntry[] {
  const dbEntries = core.listDbFiles(root)
  if (dbEntries.length > 0) return dbEntries
  const out: FileEntry[] = []
  collectMessageDir(messageDirOf(root), out)
  collectSessionDir(sessionDirOf(root), out)
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function detectFromRoot(root: string): Detection {
  return core.detectFromRoot(root, (r) => fs.existsSync(messageDirOf(r)))
}

export const parseDbFile = core.parseDbFile

export const parseJsonFile = core.parseJsonFile

async function detect(): Promise<Detection> {
  return detectFromRoot(dataRoot())
}

async function listFiles(): Promise<FileEntry[]> {
  return listFilesFromRoot(dataRoot())
}

async function parseFile(_ctx: PluginContext, filePath: string, fromLine: number): Promise<ParsedResult> {
  if (core.dbNames.includes(path.basename(filePath))) return parseDbFile(filePath, fromLine)
  return parseJsonFile(filePath, fromLine)
}

export const opencodePlugin: MonitorPlugin = {
  id: 'opencode',
  name: 'OpenCode',
  version: '1.0.0',
  deps: ['storage', 'pricing', 'events'],
  detect,
  listFiles,
  parseFile
}
