import type { AppType, ServiceKey } from './app'
import type { PluginContext } from './context'
import type { Detection, FileEntry, ParsedResult } from './dto'

/**
 * 监控插件统一接口（docs/concepts/monitor-plugins.md）。
 * 新增监控对象 = 新增一个实现本接口的插件目录，零改动宿主。
 */
export interface MonitorPlugin {
  /** 插件 id = 监控对象标识 */
  id: AppType
  /** 显示名 */
  name: string
  version: string
  /** 依赖服务（如 ['storage','pricing']），宿主按依赖解析装载顺序 */
  deps?: ServiceKey[]
  /** 探测 CLI 是否安装、会话目录是否存在 */
  detect(ctx: PluginContext): Promise<Detection>
  /** 列出待解析的会话文件 */
  listFiles(ctx: PluginContext): Promise<FileEntry[]>
  /**
   * 增量解析：从 fromLine 行续读，
   * 返回新记录 + 游标推进（nextLine）+ 是否到文件尾（eof）。
   * 单文件解析失败不得阻塞整体同步。
   */
  parseFile(ctx: PluginContext, path: string, fromLine: number): Promise<ParsedResult>
  /** 卸载时清理监听/游标等注册（可逆生命周期） */
  dispose?(ctx: PluginContext): void
}
