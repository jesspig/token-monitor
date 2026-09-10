import { memo } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { EmptyState } from './EmptyState'

export type QuerySkeletonVariant = 'cards' | 'chart' | 'table'

export interface QueryStateProps {
  isPending: boolean
  error: unknown
  refetch: () => void
  hasData: boolean
  isEmpty?: boolean
  isFetching?: boolean
  skeletonVariant?: QuerySkeletonVariant
  loadingFallback?: ReactNode
  empty?: ReactNode
  refreshingIndicator?: ReactNode
  dimWhenRefreshing?: boolean
  children: ReactNode
}

function SkeletonCards(): ReactElement {
  return (
    <div className="grid animate-pulse grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
          <div className="h-3 w-1/3 rounded bg-neutral-800" />
          <div className="mt-3 h-6 w-2/3 rounded bg-neutral-800" />
          <div className="mt-3 h-3 w-1/2 rounded bg-neutral-800/70" />
        </div>
      ))}
    </div>
  )
}

function SkeletonChart(): ReactElement {
  return (
    <div className="animate-pulse rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
      <div className="h-4 w-28 rounded bg-neutral-800" />
      <div className="mt-4 h-56 w-full rounded bg-neutral-800/60" />
    </div>
  )
}

function SkeletonTable(): ReactElement {
  return (
    <div className="animate-pulse space-y-2">
      <div className="h-8 rounded-md bg-neutral-800/70" />
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="h-10 rounded-md bg-neutral-900/70" />
      ))}
    </div>
  )
}

function Skeleton({ variant }: { variant: QuerySkeletonVariant }): ReactElement {
  if (variant === 'chart') return <SkeletonChart />
  if (variant === 'table') return <SkeletonTable />
  return <SkeletonCards />
}

function QueryErrorCard({ onRetry }: { onRetry: () => void }): ReactElement {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-red-500/30 bg-red-500/5 px-6 py-12 text-center">
      <TriangleAlert className="mb-3 h-8 w-8 text-red-400" />
      <p className="text-sm font-medium text-neutral-200">数据加载失败</p>
      <p className="mt-1 max-w-md text-xs text-neutral-500">暂时无法读取统计数据，请稍后重试。</p>
      <button type="button" onClick={onRetry} className="mt-4 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-200 transition-colors hover:bg-neutral-700">
        重试
      </button>
    </div>
  )
}

function StaleDataBanner({ onRetry }: { onRetry: () => void }): ReactElement {
  return (
    <div
      role="alert"
      className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-300"
    >
      <TriangleAlert className="h-4 w-4 shrink-0" />
      <span>数据刷新失败，显示的是上次结果</span>
      <button
        type="button"
        onClick={onRetry}
        className="ml-auto shrink-0 rounded-md border border-amber-500/40 px-2.5 py-1 text-xs font-medium text-amber-200 transition-colors hover:bg-amber-500/20"
      >
        重试
      </button>
    </div>
  )
}

export const QueryState = memo(function QueryState({
  isPending,
  error,
  refetch,
  hasData,
  isEmpty = false,
  isFetching = false,
  skeletonVariant = 'cards',
  loadingFallback,
  empty,
  refreshingIndicator,
  dimWhenRefreshing = false,
  children
}: QueryStateProps): ReactElement {
  const hasError = error != null

  if (hasError && !hasData) {
    return <QueryErrorCard onRetry={refetch} />
  }

  if (isPending && !hasData) {
    if (loadingFallback != null) {
      return <>{loadingFallback}</>
    }
    return <Skeleton variant={skeletonVariant} />
  }

  let body: ReactNode
  if (isEmpty) {
    body = empty ?? <EmptyState />
  } else if (dimWhenRefreshing && isFetching && !isPending) {
    body = <div className="opacity-60 transition-opacity duration-300">{children}</div>
  } else {
    body = children
  }

  const showStaleBanner = hasError && hasData
  const showRefreshing =
    !showStaleBanner && isFetching && !isPending && refreshingIndicator != null

  if (!showStaleBanner && !showRefreshing) {
    return <>{body}</>
  }

  return (
    <div className="space-y-3">
      {showStaleBanner && <StaleDataBanner onRetry={refetch} />}
      {showRefreshing && refreshingIndicator}
      {body}
    </div>
  )
})
