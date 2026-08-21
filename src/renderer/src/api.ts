import type { RendererApi } from '../../../shared/ipc'
import { createMockApi } from './mock'

/**
 * 渲染层唯一的数据访问入口（docs/concepts/architecture.md）：
 * 渲染进程只能经 window.api（preload contextBridge 白名单）与主进程通信。
 *
 * 后端（src/main + preload）尚未实现完整 RendererApi 时，
 * 自动回退到内置 Mock 实现（src/renderer/src/mock.ts），保证 dev 阶段可渲染。
 */
function resolveApi(): { api: RendererApi; isMock: boolean } {
  const w = typeof window !== 'undefined' ? window : undefined
  const real =
    w &&
    w.api &&
    typeof w.api.getUsageSummary === 'function' &&
    typeof w.api.getDailyTrends === 'function'
      ? w.api
      : null
  return real ? { api: real, isMock: false } : { api: createMockApi(), isMock: true }
}

const resolved = resolveApi()

/** 统一调用的 API 门面（真实 IPC 或 Mock，由运行时自动选择） */
export const api: RendererApi = resolved.api

/** 当前是否处于 Mock 模式（界面可据此提示「等待真实数据」） */
export const isMock: boolean = resolved.isMock
