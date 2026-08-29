import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type {
  AppStats,
  LogFilters,
  ModelStats,
  ProjectStats,
  SessionStats,
  StatusStats
} from '../../../../shared/query'
import { api } from '../api'
import { getStatsRefreshInterval } from '../lib/settings-cache'

export type DimensionKey = 'model' | 'app' | 'project' | 'session' | 'status'

export type DimensionStats =
  | ModelStats
  | AppStats
  | ProjectStats
  | SessionStats
  | StatusStats

export function useDimensionStats(dimension: DimensionKey, filters: LogFilters) {
  return useQuery({
    queryKey: ['stats-by', dimension, filters],
    queryFn: (): Promise<DimensionStats[]> => {
      switch (dimension) {
        case 'model':
          return api.getStatsByModel(filters)
        case 'app':
          return api.getStatsByApp(filters)
        case 'project':
          return api.getStatsByProject(filters)
        case 'session':
          return api.getStatsBySession(filters)
        case 'status':
          return api.getStatsByStatus(filters)
      }
    },
    refetchInterval: getStatsRefreshInterval,
    staleTime: 2 * 60 * 1000,
    placeholderData: keepPreviousData,
    gcTime: 30 * 60 * 1000
  })
}
