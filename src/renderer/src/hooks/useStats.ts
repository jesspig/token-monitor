import { useQuery } from '@tanstack/react-query'
import type { LogFilters } from '../../../../shared/query'
import { api } from '../api'

/** 统计页：按模型聚合 */
export function useStatsByModel(filters: LogFilters) {
  return useQuery({
    queryKey: ['stats-by-model', filters],
    queryFn: () => api.getStatsByModel(filters)
  })
}

/** 统计页：按应用（监控对象）聚合 */
export function useStatsByApp(filters: LogFilters) {
  return useQuery({
    queryKey: ['stats-by-app', filters],
    queryFn: () => api.getStatsByApp(filters)
  })
}
