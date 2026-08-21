import { useQuery } from '@tanstack/react-query'
import type { LogFilters } from '../../../../shared/query'
import { api } from '../api'

/** 请求日志页：分页查询 */
export function useRequestLogs(filters: LogFilters) {
  return useQuery({
    queryKey: ['request-logs', filters],
    queryFn: () => api.getRequestLogs(filters)
  })
}
