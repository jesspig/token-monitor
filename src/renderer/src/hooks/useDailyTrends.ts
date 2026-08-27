import { useQuery } from '@tanstack/react-query'
import type { LogFilters } from '../../../../shared/query'
import { api } from '../api'
import { getStatsRefreshInterval } from '../lib/settings-cache'

export function useDailyTrends(filters: LogFilters) {
  return useQuery({
    queryKey: ['daily-trends', filters],
    queryFn: () => api.getDailyTrends(filters),
    refetchInterval: getStatsRefreshInterval
  })
}
