import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { LogFilters } from '../../../../shared/query'
import { api } from '../api'
import { getStatsRefreshInterval } from '../lib/settings-cache'

export function useRequestLogs(filters: LogFilters) {
  return useQuery({
    queryKey: ['request-logs', filters],
    queryFn: () => api.getRequestLogs(filters),
    placeholderData: keepPreviousData,
    refetchInterval: getStatsRefreshInterval
  })
}
