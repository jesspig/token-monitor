import { useQuery } from '@tanstack/react-query'
import { api } from '../api'

/** 定价配置页：模型价格列表 */
export function useModelPricing() {
  return useQuery({
    queryKey: ['model-pricing'],
    queryFn: () => api.getModelPricing()
  })
}
