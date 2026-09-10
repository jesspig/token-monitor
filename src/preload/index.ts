import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AppType } from '../../shared/app'
import type { UsageUpdatedEvent } from '../../shared/context'
import type { RendererApi } from '../../shared/ipc'
import type { AppSettings, LogFilters } from '../../shared/query'

const api: RendererApi = {
  ping: () => ipcRenderer.invoke('app:ping'),

  getUsageSummary: (filters: LogFilters) => ipcRenderer.invoke('usage:summary', filters),
  getDailyTrends: (filters: LogFilters) => ipcRenderer.invoke('usage:daily-trends', filters),
  getHourlyTrends: (filters: LogFilters) => ipcRenderer.invoke('usage:hourly-trends', filters),
  getRequestLogs: (filters: LogFilters) => ipcRenderer.invoke('usage:request-logs', filters),
  getRequestLogDetail: (id: string) => ipcRenderer.invoke('usage:request-log-detail', id),
  getStatsByModel: (filters: LogFilters) => ipcRenderer.invoke('usage:stats-by-model', filters),
  getStatsByApp: (filters: LogFilters) => ipcRenderer.invoke('usage:stats-by-app', filters),
  getStatsByProject: (filters: LogFilters) => ipcRenderer.invoke('usage:stats-by-project', filters),
  getStatsBySession: (filters: LogFilters) => ipcRenderer.invoke('usage:stats-by-session', filters),
  getStatsByStatus: (filters: LogFilters) => ipcRenderer.invoke('usage:stats-by-status', filters),
  getFilterOptions: () => ipcRenderer.invoke('usage:filter-options'),
  getDailyModelBreakdown: (filters: LogFilters) =>
    ipcRenderer.invoke('usage:daily-model-breakdown', filters),

  getModelPricing: () => ipcRenderer.invoke('pricing:list'),
  syncModelsDevPricing: () => ipcRenderer.invoke('pricing:modelsdev-sync'),

  listPlugins: () => ipcRenderer.invoke('plugins:list'),
  setPluginEnabled: (id: AppType, enabled: boolean) =>
    ipcRenderer.invoke('plugins:set-enabled', id, enabled),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke('settings:update', patch),

  getBudgetStatus: () => ipcRenderer.invoke('budget:status'),

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
