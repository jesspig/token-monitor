import { lazy, Suspense, useEffect, useRef } from 'react'
import type { ComponentType, LazyExoticComponent, ReactElement } from 'react'
import clsx from 'clsx'
import {
  Activity,
  BarChart3,
  LayoutDashboard,
  Radio,
  ScrollText,
  Settings,
  Tags
} from 'lucide-react'
import { isMock } from './api'
import { useSettings } from './hooks/useSettings'
import { useUsageEvents } from './hooks/useUsageEvents'
import { setCachedSettings } from './lib/settings-cache'
import { FilterProvider } from './context/FilterContext'
import { NavProvider, useNav, type PageKey } from './context/NavContext'
const DashboardPage = lazy(() => import('./pages/DashboardPage'))
const RequestLogsPage = lazy(() => import('./pages/RequestLogsPage'))
const StatsPage = lazy(() => import('./pages/StatsPage'))
const PricingPage = lazy(() => import('./pages/PricingPage'))
const SourcesPage = lazy(() => import('./pages/SourcesPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))

const NAV_ITEMS: Array<{ key: PageKey; label: string; icon: typeof LayoutDashboard }> = [
  { key: 'dashboard', label: '仪表盘', icon: LayoutDashboard },
  { key: 'logs', label: '请求日志', icon: ScrollText },
  { key: 'stats', label: '统计', icon: BarChart3 },
  { key: 'pricing', label: '定价', icon: Tags },
  { key: 'sources', label: '监控源', icon: Radio },
  { key: 'settings', label: '设置', icon: Settings }
]

const PAGES: Record<PageKey, LazyExoticComponent<ComponentType>> = {
  dashboard: DashboardPage,
  logs: RequestLogsPage,
  stats: StatsPage,
  pricing: PricingPage,
  sources: SourcesPage,
  settings: SettingsPage
}

function App(): ReactElement {
  return (
    <NavProvider>
      <AppShell />
    </NavProvider>
  )
}

function AppShell(): ReactElement {
  useUsageEvents()
  const { data: settings } = useSettings()
  useEffect(() => {
    if (settings) setCachedSettings(settings)
  }, [settings])
  const { page, setPage } = useNav()
  const visitedRef = useRef<Set<PageKey>>(new Set([page]))
  visitedRef.current.add(page)

  return (
    <FilterProvider>
      <div className="flex h-screen overflow-hidden bg-neutral-950 text-neutral-100">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-neutral-800 bg-neutral-900/40 lg:flex">
        <div className="flex items-center gap-2.5 border-b border-neutral-800 px-4 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400">
            <Activity className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-semibold leading-tight">Token Monitor</p>
            <p className="text-[11px] text-neutral-500">跨 CLI 用量监控</p>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 p-3">
          {NAV_ITEMS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setPage(key)}
              className={clsx(
                'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                page === key
                  ? 'bg-neutral-800 text-white'
                  : 'text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-200'
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </nav>
        {isMock && (
          <div className="m-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
            演示数据模式
          </div>
        )}
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="border-b border-neutral-800 px-4 pt-3 lg:hidden">
          <div className="mb-2 flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-400">
              <Activity className="h-3.5 w-3.5" />
            </div>
            <p className="text-sm font-semibold">Token Monitor</p>
            {isMock && (
              <span className="ml-auto rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-300">
                演示
              </span>
            )}
          </div>
          <nav className="flex gap-1 overflow-x-auto pb-2">
            {NAV_ITEMS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setPage(key)}
                className={clsx(
                  'flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors',
                  page === key
                    ? 'bg-neutral-800 text-white'
                    : 'text-neutral-400 hover:text-neutral-200'
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </nav>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-6xl p-6">
            {(Object.entries(PAGES) as Array<[PageKey, (typeof PAGES)[PageKey]]>).map(([key, Page]) => {
              if (!visitedRef.current.has(key)) return null
              return (
                <div key={key} style={{ display: page === key ? 'block' : 'none' }}>
                  <Suspense
                    fallback={
                      <div className="flex w-full items-center justify-center py-24">
                        <div className="h-32 w-full max-w-lg animate-pulse rounded-xl bg-neutral-800/70" />
                      </div>
                    }
                  >
                    <Page />
                  </Suspense>
                </div>
              )
            })}
          </div>
        </main>
      </div>
      </div>
    </FilterProvider>
  )
}

export default App
