import type { BrowserWindow } from 'electron'
import type { AppType } from '../../../shared/app'
import type { UsageUpdatedEvent } from '../../../shared/context'
import type {
  AppSettings,
  LogFilters,
  ModelsDevCatalogEntry,
  ModelsDevImportResult
} from '../../../shared/query'
import type { ModelPricingRow } from '../../../shared/tables'
import type { LifecyclePlugin } from '../core/lifecycle'
import type { Host } from '../host'
import { fetchCatalog } from '../services/modelsdev'

/**
 * IPC handler 注册（docs/concepts/architecture.md → ipc/）。
 * 实现 shared/ipc.ts 的 RendererApi 全部 21 个方法，参数用 shared 类型；
 * 内部委托 host 的服务（usageQuery / storage / pricing / collector / settings / budget）。
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
  hourlyTrends: 'usage:hourly-trends',
  requestLogs: 'usage:request-logs',
  requestLogDetail: 'usage:request-log-detail',
  statsByModel: 'usage:stats-by-model',
  statsByApp: 'usage:stats-by-app',
  filterOptions: 'usage:filter-options',
  pricingList: 'pricing:list',
  pricingUpdate: 'pricing:update',
  pricingDelete: 'pricing:delete',
  pricingModelsdevSync: 'pricing:modelsdev-sync',
  pricingModelsdevCatalog: 'pricing:modelsdev-catalog',
  pricingModelsdevImport: 'pricing:modelsdev-import',
  pluginsList: 'plugins:list',
  pluginsSetEnabled: 'plugins:set-enabled',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  budgetStatus: 'budget:status',
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

  // 2-8. 用量查询（只读，委托 usageQuery）
  on(IPC_CHANNELS.usageSummary, (_e: unknown, filters: LogFilters) =>
    host.usageQuery.getUsageSummary(filters)
  )
  on(IPC_CHANNELS.dailyTrends, (_e: unknown, filters: LogFilters) =>
    host.usageQuery.getDailyTrends(filters)
  )
  on(IPC_CHANNELS.hourlyTrends, (_e: unknown, filters: LogFilters) =>
    host.usageQuery.getHourlyTrends(filters)
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
  on(IPC_CHANNELS.filterOptions, () => host.usageQuery.getFilterOptions())

  // 8-10. 定价配置（更新/删除后失效 pricing 缓存，并触发一次零成本回填；
  // 回填失败兜底不阻塞响应）
  on(IPC_CHANNELS.pricingList, () => host.storage.getModelPricing())
  on(IPC_CHANNELS.pricingUpdate, async (_e: unknown, entry: ModelPricingRow) => {
    await host.storage.updateModelPricing(entry)
    host.pricing.invalidateCache()
    try {
      await host.runZeroCostBackfill()
    } catch (err) {
      console.error('[ipc] 定价更新后零成本回填失败:', err)
    }
  })
  on(IPC_CHANNELS.pricingDelete, async (_e: unknown, modelId: string) => {
    await host.storage.deleteModelPricing(modelId)
    host.pricing.invalidateCache()
    try {
      await host.runZeroCostBackfill()
    } catch (err) {
      console.error('[ipc] 定价删除后零成本回填失败:', err)
    }
  })

  // 10a-c. models.dev 目录：手动全量同步 / 拉取在线目录 / 导入勾选条目。
  // 导入以 'user' 来源逐条 upsert（用户显式勾选视为锁定，不可被 seed/sync 覆盖），
  // 单条异常计数跳过；全部完成后失效缓存并回填零成本。
  on(IPC_CHANNELS.pricingModelsdevSync, () => host.syncModelsDevPricing())
  on(IPC_CHANNELS.pricingModelsdevCatalog, () => fetchCatalog())
  on(
    IPC_CHANNELS.pricingModelsdevImport,
    async (_e: unknown, rawEntries: unknown): Promise<ModelsDevImportResult> => {
      if (!Array.isArray(rawEntries)) {
        throw new Error('pricing:modelsdev-import 入参必须为条目数组')
      }
      let imported = 0
      for (const raw of rawEntries) {
        const entry = raw as ModelsDevCatalogEntry
        if (typeof entry?.modelId !== 'string' || entry.modelId.trim().length === 0) continue
        try {
          await host.storage.updateModelPricing(
            {
              model_id: entry.modelId,
              provider: entry.provider ?? null,
              input_per_million: entry.inputPerMillion,
              output_per_million: entry.outputPerMillion,
              cache_read_per_million: entry.cacheReadPerMillion,
              cache_creation_per_million: entry.cacheCreationPerMillion,
              currency: 'USD',
              cost_multiplier: 1,
              updated_at: Date.now()
            },
            'user'
          )
          imported += 1
        } catch {
          // 单条写入异常：计数跳过，不中断整体导入
        }
      }
      host.pricing.invalidateCache()
      try {
        await host.runZeroCostBackfill()
      } catch (err) {
        console.error('[ipc] 导入后零成本回填失败:', err)
      }
      return { imported }
    }
  )

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

  // 15. 预算限额状态（全局日/月费用与上限占比；只读，失败向上抛转 rejection）
  on(IPC_CHANNELS.budgetStatus, () => host.getBudgetStatus())

  // 16. usage-updated 事件推送（200ms 防抖由 EventBus 处理）
  host.events.on('usage-updated', (e: UsageUpdatedEvent) => {
    getMainWindow()?.webContents.send(IPC_CHANNELS.usageUpdated, e)
  })
}
