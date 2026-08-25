import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../api'

/** usage-updated 到达后需失效重取的查询 key（一级前缀，与各 useXxx hook 的 queryKey 首段一致） */
const USAGE_QUERY_KEYS = [
  'usage-summary',
  'daily-trends',
  'request-logs',
  'stats-by-model',
  'stats-by-app',
  'budget-status'
] as const

const INVALIDATE_COOLDOWN_MS = 1000

/**
 * 订阅主进程 usage-updated 推送（200ms 防抖），事件到达后失效用量相关查询，
 * 由 TanStack Query 立即重取，替代仅靠 staleTime 过期的被动刷新。
 * api/onUsageUpdated 缺失（Mock 回退或旧 preload）时静默跳过。
 */
export function useUsageEvents(): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    if (typeof api.onUsageUpdated !== 'function') return undefined
    let timer: ReturnType<typeof setTimeout> | null = null
    const invalidateAll = (): void => {
      for (const key of USAGE_QUERY_KEYS) {
        void queryClient.invalidateQueries({ queryKey: [key] })
      }
    }
    const unsubscribe = api.onUsageUpdated(() => {
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        invalidateAll()
      }, INVALIDATE_COOLDOWN_MS)
    })
    return () => {
      unsubscribe()
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }
  }, [queryClient])
}
