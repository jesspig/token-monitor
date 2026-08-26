import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { LogFilters } from '../../../../shared/query'
import { api } from '../api'
import { getStatsRefreshInterval } from '../lib/settings-cache'

/**
 * 请求日志页：分页查询。
 * keepPreviousData 保证筛选/翻页切换时保留旧数据避免表格闪空；
 * 用量类查询按设置间隔轮询兜底。
 */
export function useRequestLogs(filters: LogFilters) {
  return useQuery({
    queryKey: ['request-logs', filters],
    queryFn: () => api.getRequestLogs(filters),
    placeholderData: keepPreviousData,
    refetchInterval: getStatsRefreshInterval
  })
}
