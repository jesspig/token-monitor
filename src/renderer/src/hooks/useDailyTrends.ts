import { useQuery } from '@tanstack/react-query'
import type { LogFilters } from '../../../../shared/query'
import { api } from '../api'

/** 趋势页 / Dashboard 迷你趋势：按天聚合序列 */
export function useDailyTrends(filters: LogFilters) {
  return useQuery({
    queryKey: ['daily-trends', filters],
    queryFn: () => api.getDailyTrends(filters)
  })
}
