import { useQuery } from '@tanstack/react-query'
import type { LogFilters } from '../../../../shared/query'
import { api } from '../api'
import { getStatsRefreshInterval } from '../lib/settings-cache'

export function useStatsByModel(filters: LogFilters) {
  return useQuery({
    queryKey: ['stats-by-model', filters],
    queryFn: () => api.getStatsByModel(filters),
    refetchInterval: getStatsRefreshInterval
  })
}

export function useStatsByApp(filters: LogFilters) {
  return useQuery({
    queryKey: ['stats-by-app', filters],
    queryFn: () => api.getStatsByApp(filters),
    refetchInterval: getStatsRefreshInterval
  })
}
