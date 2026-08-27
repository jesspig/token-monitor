import { useQuery } from '@tanstack/react-query'
import { api } from '../api'

export function usePlugins() {
  return useQuery({
    queryKey: ['plugins'],
    queryFn: () => api.listPlugins()
  })
}
