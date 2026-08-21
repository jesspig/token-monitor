import { useQuery } from '@tanstack/react-query'
import { api } from '../api'

/** 监控源页：各 CLI 适配器状态 */
export function usePlugins() {
  return useQuery({
    queryKey: ['plugins'],
    queryFn: () => api.listPlugins()
  })
}
