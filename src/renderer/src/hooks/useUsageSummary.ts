import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { LogFilters } from '../../../../shared/query'
import { api } from '../api'
import { getStatsRefreshInterval } from '../lib/settings-cache'

export function useUsageSummary(filters: LogFilters) {
  return useQuery({
    queryKey: ['usage-summary', filters],
    queryFn: () => api.getUsageSummary(filters),
    staleTime: 2 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    placeholderData: keepPreviousData,
    refetchInterval: getStatsRefreshInterval
  })
}
