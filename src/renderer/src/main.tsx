import './index.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { getStatsRefreshInterval } from './lib/settings-cache'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchInterval: () => getStatsRefreshInterval(),
      refetchOnWindowFocus: false,
      staleTime: 30_000,
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
