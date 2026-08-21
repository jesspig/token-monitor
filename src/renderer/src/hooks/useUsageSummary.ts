import { useQuery } from '@tanstack/react-query'
import type { LogFilters } from '../../../../shared/query'
import { api } from '../api'

/** Dashboard：Hero 汇总卡数据（受时间范围/应用/模型筛选驱动） */
export function useUsageSummary(filters: LogFilters) {
  return useQuery({
    queryKey: ['usage-summary', filters],
    queryFn: () => api.getUsageSummary(filters)
  })
}
