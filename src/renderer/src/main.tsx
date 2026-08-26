import './index.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'

const QUERY_CACHE_GC_TIME = 30 * 60 * 1000

// 全局不设 refetchInterval：周期轮询仅由用量类查询显式启用
// （getStatsRefreshInterval），settings/plugins/pricing 等静态数据依赖
// 挂载刷新与操作后 invalidate，避免穿透 staleTime 的无差别轮询。
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      gcTime: QUERY_CACHE_GC_TIME,
      retry: 1
    }
  }
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
)
