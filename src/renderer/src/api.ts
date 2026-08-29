import type { RendererApi } from '../../../shared/ipc'

function detectBridge(): RendererApi | null {
  const w = typeof window !== 'undefined' ? window : undefined
  if (!w || !w.api) return null
  if (typeof w.api.getUsageSummary !== 'function') return null
  if (typeof w.api.getDailyTrends !== 'function') return null
  return w.api
}

const bridge = detectBridge()

export const isMock: boolean = bridge === null

let mockPromise: Promise<RendererApi> | null = null

function loadMock(): Promise<RendererApi> {
  if (mockPromise === null) {
    if (import.meta.env.DEV) {
      mockPromise = import('./mock').then((m) => m.createMockApi())
    } else {
      mockPromise = Promise.reject(new Error('Mock 仅在开发模式可用'))
    }
  }
  return mockPromise
}

export const api: RendererApi = bridge ?? {
  ping: () => loadMock().then((m) => m.ping()),
  getUsageSummary: (filters) => loadMock().then((m) => m.getUsageSummary(filters)),
  getDailyTrends: (filters) => loadMock().then((m) => m.getDailyTrends(filters)),
  getHourlyTrends: (filters) => loadMock().then((m) => m.getHourlyTrends(filters)),
  getRequestLogs: (filters) => loadMock().then((m) => m.getRequestLogs(filters)),
  getRequestLogDetail: (id) => loadMock().then((m) => m.getRequestLogDetail(id)),
  getFilterOptions: () => loadMock().then((m) => m.getFilterOptions()),
  getStatsByModel: (filters) => loadMock().then((m) => m.getStatsByModel(filters)),
  getStatsByApp: (filters) => loadMock().then((m) => m.getStatsByApp(filters)),
  getStatsByProject: (filters) => loadMock().then((m) => m.getStatsByProject(filters)),
  getStatsBySession: (filters) => loadMock().then((m) => m.getStatsBySession(filters)),
  getStatsByStatus: (filters) => loadMock().then((m) => m.getStatsByStatus(filters)),
  getModelPricing: () => loadMock().then((m) => m.getModelPricing()),
  syncModelsDevPricing: () => loadMock().then((m) => m.syncModelsDevPricing()),
  listPlugins: () => loadMock().then((m) => m.listPlugins()),
  setPluginEnabled: (id, enabled) => loadMock().then((m) => m.setPluginEnabled(id, enabled)),
  getSettings: () => loadMock().then((m) => m.getSettings()),
  updateSettings: (patch) => loadMock().then((m) => m.updateSettings(patch)),
  getBudgetStatus: () => loadMock().then((m) => m.getBudgetStatus()),
  getDailyModelBreakdown: (filters) => loadMock().then((m) => m.getDailyModelBreakdown(filters)),
  onUsageUpdated: (callback) => {
    let disposed = false
    let dispose: (() => void) | undefined
    void loadMock().then((m) => {
      if (disposed) return
      dispose = m.onUsageUpdated(callback)
    })
    return () => {
      disposed = true
      dispose?.()
    }
  }
}
