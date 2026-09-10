import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { LogFilters } from '../../../../shared/query'
import { api } from '../api'
import { getStatsRefreshInterval } from '../lib/settings-cache'

export function useDailyTrends(filters: LogFilters) {
  return useQuery({
    queryKey: ['daily-trends', filters],
    queryFn: () => api.getDailyTrends(filters),
    staleTime: 2 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    placeholderData: keepPreviousData,
    refetchInterval: getStatsRefreshInterval
  })
}
