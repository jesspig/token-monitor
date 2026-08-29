import type { BrowserWindow } from 'electron'
import type { AppType } from '../../../shared/app'
import type { UsageUpdatedEvent } from '../../../shared/context'
import type {
  AppSettings,
  LogFilters
} from '../../../shared/query'
import type { LifecyclePlugin } from '../core/lifecycle'
import type { Host } from '../host'


type IpcHandler = (...args: any[]) => unknown
export interface IpcMainLike {
  handle(channel: string, listener: IpcHandler): void
}

export const IPC_CHANNELS = {
  ping: 'app:ping',
  usageSummary: 'usage:summary',
  dailyTrends: 'usage:daily-trends',
  hourlyTrends: 'usage:hourly-trends',
  requestLogs: 'usage:request-logs',
  requestLogDetail: 'usage:request-log-detail',
  statsByModel: 'usage:stats-by-model',
  statsByApp: 'usage:stats-by-app',
  statsByProject: 'usage:stats-by-project',
  statsBySession: 'usage:stats-by-session',
  statsByStatus: 'usage:stats-by-status',
  filterOptions: 'usage:filter-options',
  pricingList: 'pricing:list',
  pricingModelsdevSync: 'pricing:modelsdev-sync',
  pluginsList: 'plugins:list',
  pluginsSetEnabled: 'plugins:set-enabled',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  budgetStatus: 'budget:status',
  dailyModelBreakdown: 'usage:daily-model-breakdown',
  usageUpdated: 'usage-updated'
} as const

export function registerIpcHandlers(
  ipcMain: IpcMainLike,
  host: Host,
  getMainWindow: () => BrowserWindow | null
): void {
  const on = (channel: string, fn: IpcHandler): void =>
    ipcMain.handle(channel, async (...args: any[]) => {
      await host.ready
      return fn(...args)
    })

  on(IPC_CHANNELS.ping, () => 'pong')

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
  on(IPC_CHANNELS.statsByProject, (_e: unknown, filters: LogFilters) =>
    host.usageQuery.getStatsByProject(filters)
  )
  on(IPC_CHANNELS.statsBySession, (_e: unknown, filters: LogFilters) =>
    host.usageQuery.getStatsBySession(filters)
  )
  on(IPC_CHANNELS.statsByStatus, (_e: unknown, filters: LogFilters) =>
    host.usageQuery.getStatsByStatus(filters)
  )
  on(IPC_CHANNELS.filterOptions, () => host.usageQuery.getFilterOptions())

  on(IPC_CHANNELS.dailyModelBreakdown, (_e: unknown, filters: LogFilters) =>
    host.usageQuery.getDailyModelBreakdown(filters)
  )

  on(IPC_CHANNELS.pricingList, () => host.storage.getModelPricing())
  on(IPC_CHANNELS.pricingModelsdevSync, () => host.syncModelsDevPricing())

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
    host.collector.invalidateStatusCache()
  })

  on(IPC_CHANNELS.settingsGet, () => host.getSettings())
  on(IPC_CHANNELS.settingsUpdate, (_e: unknown, patch: Partial<AppSettings>) =>
    host.updateSettings(patch)
  )

  on(IPC_CHANNELS.budgetStatus, () => host.getBudgetStatus())

  host.events.on('usage-updated', (e: UsageUpdatedEvent) => {
    getMainWindow()?.webContents.send(IPC_CHANNELS.usageUpdated, e)
  })
}
