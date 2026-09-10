import { memo } from 'react'
import type { ReactElement } from 'react'
import clsx from 'clsx'
import type { ModelStats } from '../../../../shared/query'
import { formatTokens, formatUsd } from '../lib/format'

interface LeaderboardGridProps {
  data: ModelStats[]
  maxItems?: number
}

function totalTokensOf(m: ModelStats): number {
  return m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens
}

function RankCard({ rank, model, large }: { rank: number; model: ModelStats; large?: boolean }): ReactElement {
  const total = totalTokensOf(model)
  const rankStr = String(rank).padStart(2, '0')
  return (
    <div
      className={clsx(
        'relative overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900/60 p-3',
        large && 'p-4'
      )}
    >
      <div className="absolute right-2 top-2 select-none tabular-nums text-6xl font-bold leading-none text-neutral-800/40">
        {rankStr}
      </div>
      <div className="relative">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] text-neutral-500">
          <span className="tabular-nums">{rankStr}</span>
          <span className="inline-flex h-4 w-4 items-center justify-center rounded bg-neutral-800 text-[10px]">{model.appType.slice(0, 1).toUpperCase()}</span>
        </div>
        <div className={clsx('truncate font-mono font-medium text-white', large ? 'text-sm' : 'text-xs')} title={model.model}>
          {model.model}
        </div>
        <div className="truncate text-[11px] text-neutral-500">{model.appType}</div>
        <div className="mt-2 flex items-end justify-between">
          <div>
            <div className={clsx('tabular-nums font-semibold text-white', large ? 'text-base' : 'text-sm')}>{formatTokens(total)}</div>
            <div className="text-[11px] text-neutral-500">{model.requestCount.toLocaleString()} 请求 · {formatUsd(model.costUsd)}</div>
          </div>
          <div className={clsx('rounded px-1.5 py-0.5 text-[11px] font-medium', model.successRate >= 0.95 ? 'bg-emerald-500/15 text-emerald-300' : model.successRate >= 0.8 ? 'bg-amber-500/15 text-amber-300' : 'bg-red-500/15 text-red-300')}>
            {(model.successRate * 100).toFixed(1)}%
          </div>
        </div>
      </div>
    </div>
  )
}

function LeaderboardGridImpl({ data, maxItems = 10 }: LeaderboardGridProps): ReactElement {
  const filtered = [...data].filter((m) => totalTokensOf(m) > 0)
  const top = filtered.sort((a, b) => totalTokensOf(b) - totalTokensOf(a)).slice(0, maxItems)
  if (top.length === 0) return <div className="py-6 text-center text-sm text-neutral-500">暂无模型数据</div>
  const firstRow = top.slice(0, 3)
  const rest = top.slice(3)
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {firstRow.map((m, i) => (
          <RankCard key={m.model} rank={i + 1} model={m} large />
        ))}
      </div>
      {rest.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {rest.map((m, i) => (
            <RankCard key={m.model} rank={i + 4} model={m} />
          ))}
        </div>
      )}
    </div>
  )
}

export const LeaderboardGrid = memo(LeaderboardGridImpl)
export default LeaderboardGrid
