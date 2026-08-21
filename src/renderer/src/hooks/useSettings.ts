import { useQuery } from '@tanstack/react-query'
import { api } from '../api'

/** 设置页：读取同步间隔/保留策略/数据目录 */
export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings()
  })
}
