import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../api'

const USAGE_QUERY_KEYS = [
  'usage-summary',
  'daily-trends',
  'request-logs',
  'stats-by-model',
  'stats-by-app',
  'budget-status'
] as const

const INVALIDATE_DEBOUNCE_MS = 1500

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
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        invalidateAll()
      }, INVALIDATE_DEBOUNCE_MS)
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
