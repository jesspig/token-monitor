import { createContext, useContext, useMemo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import type { AppType, RequestStatus } from '../../../../shared/app'
import type { RangeKey } from '../lib/range'

export interface FilterState {
  range: RangeKey
  appTypes?: AppType[]
  models?: string[]
  project?: string
  status?: RequestStatus
}

export interface FilterContextValue {
  filter: FilterState
  setRange: (range: RangeKey) => void
  setAppTypes: (appTypes?: AppType[]) => void
  setModels: (models?: string[]) => void
  setProject: (project?: string) => void
  setStatus: (status?: RequestStatus) => void
  reset: () => void
}

const DEFAULT_FILTER: FilterState = {
  range: '7d'
}

const FilterContext = createContext<FilterContextValue | null>(null)

export function FilterProvider({ children }: { children: ReactNode }): ReactElement {
  const [filter, setFilter] = useState<FilterState>(DEFAULT_FILTER)

  const value = useMemo<FilterContextValue>(
    () => ({
      filter,
      setRange: (range) => setFilter((prev) => ({ ...prev, range })),
      setAppTypes: (appTypes) => setFilter((prev) => ({ ...prev, appTypes })),
      setModels: (models) => setFilter((prev) => ({ ...prev, models })),
      setProject: (project) => setFilter((prev) => ({ ...prev, project })),
      setStatus: (status) => setFilter((prev) => ({ ...prev, status })),
      reset: () => setFilter(DEFAULT_FILTER)
    }),
    [filter]
  )

  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>
}

export function useFilter(): FilterContextValue {
  const ctx = useContext(FilterContext)
  if (!ctx) {
    throw new Error('useFilter 必须在 <FilterProvider> 内使用')
  }
  return ctx
}
