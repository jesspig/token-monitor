import { createContext, useContext, useMemo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

export type PageKey = 'dashboard' | 'logs' | 'stats' | 'pricing' | 'sources' | 'settings'

interface NavContextValue {
  page: PageKey
  setPage: (page: PageKey) => void
  navigate: (page: PageKey) => void
}

const NavContext = createContext<NavContextValue | null>(null)

export function NavProvider({ children }: { children: ReactNode }): ReactElement {
  const [page, setPage] = useState<PageKey>('dashboard')

  const value = useMemo<NavContextValue>(
    () => ({
      page,
      setPage,
      navigate: (p) => setPage(p)
    }),
    [page]
  )

  return <NavContext.Provider value={value}>{children}</NavContext.Provider>
}

export function useNav(): NavContextValue {
  const ctx = useContext(NavContext)
  if (!ctx) {
    throw new Error('useNav 必须在 <NavProvider> 内使用')
  }
  return ctx
}
