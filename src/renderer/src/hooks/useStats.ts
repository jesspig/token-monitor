import { useQuery } from '@tanstack/react-query'
import type { LogFilters } from '../../../../shared/query'
import { api } from '../api'
import { getStatsRefreshInterval } from '../lib/settings-cache'

/** 统计页：按模型聚合；用量类查询按设置间隔轮询兜底 */
export function useStatsByModel(filters: LogFilters) {
  return useQuery({
    queryKey: ['stats-by-model', filters],
    queryFn: () => api.getStatsByModel(filters),
    refetchInterval: getStatsRefreshInterval
  })
}

/** 统计页：按应用（监控对象）聚合；用量类查询按设置间隔轮询兜底 */
export function useStatsByApp(filters: LogFilters) {
  return useQuery({
    queryKey: ['stats-by-app', filters],
    queryFn: () => api.getStatsByApp(filters),
    refetchInterval: getStatsRefreshInterval
  })
}
