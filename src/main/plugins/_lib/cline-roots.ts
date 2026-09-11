import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import type { Detection, FileEntry } from '../../../../shared/dto'

const CLIENT_DATA_DIRS = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor'] as const
const UI_MESSAGES_FILE = 'ui_messages.json'

export interface EditorRootOptions {
  platform?: NodeJS.Platform
  homeDir?: string
  appData?: string
  xdgConfigHome?: string
}

function pathKey(value: string, platform: NodeJS.Platform): string {
  const resolved = path.resolve(value)
  let canonical = resolved
  try {
    canonical = fs.realpathSync.native(resolved)
  } catch {
    canonical = resolved
  }
  return platform === 'win32' ? canonical.toLowerCase() : canonical
}

export function dedupePaths(values: string[], platform: NodeJS.Platform = process.platform): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (trimmed === '') continue
    const resolved = path.resolve(trimmed)
    const key = pathKey(resolved, platform)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(resolved)
  }
  return result
}

export function editorGlobalStorageRoots(
  override: string | undefined,
  options: EditorRootOptions = {}
): string[] {
  const platform = options.platform ?? process.platform
  if (override && override.trim() !== '') return dedupePaths([override], platform)

  const homeDir = options.homeDir ?? os.homedir()
  let configRoot: string
  if (platform === 'win32') {
    configRoot = options.appData ?? process.env.APPDATA ?? path.join(homeDir, 'AppData', 'Roaming')
  } else if (platform === 'darwin') {
    configRoot = path.join(homeDir, 'Library', 'Application Support')
  } else {
    configRoot = options.xdgConfigHome ?? process.env.XDG_CONFIG_HOME ?? path.join(homeDir, '.config')
  }

  return dedupePaths(
    CLIENT_DATA_DIRS.map((client) => path.join(configRoot, client, 'User', 'globalStorage')),
    platform
  )
}

function safeReaddir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function toEntry(filePath: string): FileEntry | null {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return null
    const mtime = Math.round(stat.mtimeMs)
    if (!Number.isFinite(mtime) || mtime <= 0) return null
    return { path: filePath, mtime }
  } catch {
    return null
  }
}

function taskKey(taskName: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? taskName.toLowerCase() : taskName
}

export function listTaskFilesFromRoots(
  globalStorageRoots: string[],
  extensionId: string,
  platform: NodeJS.Platform = process.platform
): FileEntry[] {
  const byPhysicalFile = new Set<string>()
  const byTask = new Map<string, FileEntry>()

  for (const root of dedupePaths(globalStorageRoots, platform)) {
    const tasksDir = path.join(root, extensionId, 'tasks')
    for (const entry of safeReaddir(tasksDir)) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.endsWith('~')) continue
      const file = toEntry(path.join(tasksDir, entry.name, UI_MESSAGES_FILE))
      if (!file) continue
      const physicalKey = pathKey(file.path, platform)
      if (byPhysicalFile.has(physicalKey)) continue
      byPhysicalFile.add(physicalKey)

      const key = taskKey(entry.name, platform)
      const current = byTask.get(key)
      if (!current || file.mtime > current.mtime) byTask.set(key, file)
    }
  }

  return [...byTask.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function detectTasksFromRoots(
  globalStorageRoots: string[],
  extensionId: string,
  platform: NodeJS.Platform = process.platform
): Detection {
  const roots = dedupePaths(globalStorageRoots, platform)
  const files = listTaskFilesFromRoots(roots, extensionId, platform)
  if (files.length > 0) {
    return { available: true, sessionDir: path.dirname(path.dirname(files[0].path)) }
  }
  const sessionDir = path.join(roots[0] ?? '', extensionId, 'tasks')
  return {
    available: false,
    reason: `未在已支持的编辑器中找到扩展 ${extensionId} 的任务数据（扩展未安装或尚未产生任务）`,
    sessionDir
  }
}
