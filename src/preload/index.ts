import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AppType } from '../../shared/app'
import type { UsageUpdatedEvent } from '../../shared/context'
import type { RendererApi } from '../../shared/ipc'
import type { AppSettings, LogFilters, ModelsDevCatalogEntry } from '../../shared/query'
import type { ModelPricingRow } from '../../shared/tables'

/**
 * preload 白名单 API：仅暴露主进程允许的能力（RendererApi 契约），
 * 禁止直接暴露 Node 能力。各方法经 ipcRenderer.invoke 调用主进程
 * src/main/ipc/register.ts 注册的对应通道（通道名必须与之一致）。
 */
const api: RendererApi = {
  // 连通性检查（示例 IPC，返回 'pong'）
  ping: () => ipcRenderer.invoke('app:ping'),

  // 用量查询
  getUsageSummary: (filters: LogFilters) => ipcRenderer.invoke('usage:summary', filters),
  getDailyTrends: (filters: LogFilters) => ipcRenderer.invoke('usage:daily-trends', filters),
  getHourlyTrends: (filters: LogFilters) => ipcRenderer.invoke('usage:hourly-trends', filters),
  getRequestLogs: (filters: LogFilters) => ipcRenderer.invoke('usage:request-logs', filters),
  getRequestLogDetail: (id: string) => ipcRenderer.invoke('usage:request-log-detail', id),
  getStatsByModel: (filters: LogFilters) => ipcRenderer.invoke('usage:stats-by-model', filters),
  getStatsByApp: (filters: LogFilters) => ipcRenderer.invoke('usage:stats-by-app', filters),
  getFilterOptions: () => ipcRenderer.invoke('usage:filter-options'),

  // 定价配置
  getModelPricing: () => ipcRenderer.invoke('pricing:list'),
  updateModelPricing: (entry: ModelPricingRow) => ipcRenderer.invoke('pricing:update', entry),
  deleteModelPricing: (modelId: string) => ipcRenderer.invoke('pricing:delete', modelId),
  syncModelsDevPricing: () => ipcRenderer.invoke('pricing:modelsdev-sync'),
  fetchModelsDevCatalog: () => ipcRenderer.invoke('pricing:modelsdev-catalog'),
  importModelsDevEntries: (entries: ModelsDevCatalogEntry[]) =>
    ipcRenderer.invoke('pricing:modelsdev-import', entries),

  // 监控插件状态与启停
  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  setPluginEnabled: (id: AppType, enabled: boolean) =>
    ipcRenderer.invoke('plugins:set-enabled', id, enabled),

  // 设置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:update', patch),

  // 预算限额告警
  getBudgetStatus: () => ipcRenderer.invoke('budget:status'),

  // 数据更新推送（usage-updated，200ms 防抖由主进程处理）；返回取消订阅函数
  onUsageUpdated(callback) {
    const listener = (_event: IpcRendererEvent, payload: UsageUpdatedEvent): void =>
      callback(payload)
    ipcRenderer.on('usage-updated', listener)
    return () => {
      ipcRenderer.removeListener('usage-updated', listener)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in index.d.ts)
  window.api = api
}
