import { useQuery } from '@tanstack/react-query'
import { api } from '../api'

export function useModelPricing() {
  return useQuery({
    queryKey: ['model-pricing'],
    queryFn: () => api.getModelPricing()
  })
}
