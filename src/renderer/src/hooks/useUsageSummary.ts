import { useQuery } from '@tanstack/react-query'
import type { LogFilters } from '../../../../shared/query'
import { api } from '../api'
import { getStatsRefreshInterval } from '../lib/settings-cache'

export function useUsageSummary(filters: LogFilters) {
  return useQuery({
    queryKey: ['usage-summary', filters],
    queryFn: () => api.getUsageSummary(filters),
    refetchInterval: getStatsRefreshInterval
  })
}
