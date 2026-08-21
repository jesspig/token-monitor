import type { BrowserWindow } from 'electron'
import type { AppType } from '../../../shared/app'
import type { UsageUpdatedEvent } from '../../../shared/context'
import type { AppSettings, LogFilters } from '../../../shared/query'
import type { ModelPricingRow } from '../../../shared/tables'
import type { LifecyclePlugin } from '../core/lifecycle'
import type { Host } from '../host'

/**
 * IPC handler 注册（docs/concepts/architecture.md → ipc/）。
 * 实现 shared/ipc.ts 的 RendererApi 全部 15 个方法，参数用 shared 类型；
 * 内部委托 host 的服务（usageQuery / storage / pricing / collector / settings）。
 * 事件推送（usage-updated）经 EventBus 订阅，防抖已由 EventBus 处理。
 */

/** ipcMain 的最小抽象（测试可注入 fake 实现） */
type IpcHandler = (...args: any[]) => unknown
export interface IpcMainLike {
  handle(channel: string, listener: IpcHandler): void
}

/** 各 IPC 通道名（preload 侧以相同字符串 invoke） */
export const IPC_CHANNELS = {
  ping: 'app:ping',
  usageSummary: 'usage:summary',
  dailyTrends: 'usage:daily-trends',
  requestLogs: 'usage:request-logs',
  requestLogDetail: 'usage:request-log-detail',
  statsByModel: 'usage:stats-by-model',
  statsByApp: 'usage:stats-by-app',
  pricingList: 'pricing:list',
  pricingUpdate: 'pricing:update',
  pricingDelete: 'pricing:delete',
  pluginsList: 'plugins:list',
  pluginsSetEnabled: 'plugins:set-enabled',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  usageUpdated: 'usage-updated'
} as const

export function registerIpcHandlers(
  ipcMain: IpcMainLike,
  host: Host,
  getMainWindow: () => BrowserWindow | null
): void {
  const on = (channel: string, fn: IpcHandler): void => ipcMain.handle(channel, fn)

  // 1. 连通性检查（示例 IPC，返回 'pong'）
  on(IPC_CHANNELS.ping, () => 'pong')

  // 2-7. 用量查询（只读，委托 usageQuery）
  on(IPC_CHANNELS.usageSummary, (_e: unknown, filters: LogFilters) =>
    host.usageQuery.getUsageSummary(filters)
  )
  on(IPC_CHANNELS.dailyTrends, (_e: unknown, filters: LogFilters) =>
    host.usageQuery.getDailyTrends(filters)
  )
  on(IPC_CHANNELS.requestLogs, (_e: unknown, filters: LogFilters) =>
    host.usageQuery.getRequestLogs(filters)
  )
  on(IPC_CHANNELS.requestLogDetail, (_e: unknown, id: string) =>
    host.usageQuery.getRequestLogDetail(id)
  )
  on(IPC_CHANNELS.statsByModel, (_e: unknown, filters: LogFilters) =>
    host.usageQuery.getModelStats(filters)
  )
  on(IPC_CHANNELS.statsByApp, (_e: unknown, filters: LogFilters) =>
    host.usageQuery.getAppStats(filters)
  )

  // 8-10. 定价配置（更新/删除后失效 pricing 缓存）
  on(IPC_CHANNELS.pricingList, () => host.storage.getModelPricing())
  on(IPC_CHANNELS.pricingUpdate, async (_e: unknown, entry: ModelPricingRow) => {
    await host.storage.updateModelPricing(entry)
    host.pricing.invalidateCache()
  })
  on(IPC_CHANNELS.pricingDelete, async (_e: unknown, modelId: string) => {
    await host.storage.deleteModelPricing(modelId)
    host.pricing.invalidateCache()
  })

  // 11-12. 监控插件状态与启停（启用=装载，停用=卸载，可逆）
  on(IPC_CHANNELS.pluginsList, () => host.collector.getPluginStatus())
  on(IPC_CHANNELS.pluginsSetEnabled, async (_e: unknown, id: AppType, enabled: boolean) => {
    const plugin = host.registry.get(id)
    if (!plugin) throw new Error(`Plugin "${id}" is not registered`)
    if (enabled) {
      host.registry.enable(id)
      if (!host.lifecycle.isMounted(id)) {
        await host.lifecycle.mount(host.ctx, plugin as LifecyclePlugin)
      }
    } else {
      host.registry.disable(id)
      if (host.lifecycle.isMounted(id)) {
        host.lifecycle.unmount(host.ctx, plugin as LifecyclePlugin)
      }
    }
  })

  // 13-14. 设置读取与更新（部分字段）
  on(IPC_CHANNELS.settingsGet, () => host.getSettings())
  on(IPC_CHANNELS.settingsUpdate, (_e: unknown, patch: Partial<AppSettings>) =>
    host.updateSettings(patch)
  )

  // 15. usage-updated 事件推送（200ms 防抖由 EventBus 处理）
  host.events.on('usage-updated', (e: UsageUpdatedEvent) => {
    getMainWindow()?.webContents.send(IPC_CHANNELS.usageUpdated, e)
  })
}
