import type { RendererApi } from '../../../shared/ipc'

/**
 * 渲染层唯一的数据访问入口（docs/concepts/architecture.md）：
 * 渲染进程只能经 window.api（preload contextBridge 白名单）与主进程通信。
 *
 * 后端（src/main + preload）尚未实现完整 RendererApi 时，
 * 自动回退到内置 Mock 实现（src/renderer/src/mock.ts），保证 dev 阶段可渲染；
 * Mock 数据模块仅在开发模式下按需动态加载，生产构建整体剔除。
 */
function detectBridge(): RendererApi | null {
  const w = typeof window !== 'undefined' ? window : undefined
  if (!w || !w.api) return null
  if (typeof w.api.getUsageSummary !== 'function') return null
  if (typeof w.api.getDailyTrends !== 'function') return null
  return w.api
}

const bridge = detectBridge()

/** 当前是否处于 Mock 模式（界面可据此提示「等待真实数据」） */
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

/** 统一调用的 API 门面（真实 IPC 或 Mock，由运行时自动选择） */
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
  getModelPricing: () => loadMock().then((m) => m.getModelPricing()),
  syncModelsDevPricing: () => loadMock().then((m) => m.syncModelsDevPricing()),
  listPlugins: () => loadMock().then((m) => m.listPlugins()),
  setPluginEnabled: (id, enabled) => loadMock().then((m) => m.setPluginEnabled(id, enabled)),
  getSettings: () => loadMock().then((m) => m.getSettings()),
  updateSettings: (patch) => loadMock().then((m) => m.updateSettings(patch)),
  getBudgetStatus: () => loadMock().then((m) => m.getBudgetStatus()),
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
