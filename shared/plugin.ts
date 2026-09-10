import type { AppType, ServiceKey } from './app'
import type { PluginContext } from './context'
import type { Detection, FileEntry, ParsedResult } from './dto'

export interface MonitorPlugin {
  id: AppType
  name: string
  version: string
  deps?: ServiceKey[]
  detect(ctx: PluginContext): Promise<Detection>
  listFiles(ctx: PluginContext): Promise<FileEntry[]>
  parseFile(ctx: PluginContext, path: string, fromLine: number): Promise<ParsedResult>
  dispose?(ctx: PluginContext): void
}
