import { memo } from 'react'
import type { ReactElement } from 'react'
import type { ModelStats } from '../../../../shared/query'
import { formatPercent } from '../lib/format'

interface RetentionRankingProps {
  data: ModelStats[]
  metric?: 'successRate' | 'cacheHitRate'
  maxItems?: number
}

function cacheHitRateOf(m: ModelStats): number {
  const denom = m.inputTokens + m.cacheReadTokens
  return denom > 0 ? m.cacheReadTokens / denom : 0
}

function RetentionRankingImpl({ data, metric = 'successRate', maxItems = 15 }: RetentionRankingProps): ReactElement {
  const sorted = [...data]
    .map((m) => ({
      model: m.model,
      rate: metric === 'cacheHitRate' ? cacheHitRateOf(m) : m.successRate,
      eligible: m.requestCount
    }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, maxItems)

  if (sorted.length === 0) return <div className="py-6 text-center text-sm text-neutral-500">暂无数据</div>

  return (
    <div className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/60">
      <div className="grid grid-cols-12 gap-2 border-b border-neutral-800 bg-neutral-900 px-3 py-2 text-[11px] uppercase tracking-wide text-neutral-500">
        <div className="col-span-1">RANK</div>
        <div className="col-span-3 sm:col-span-3">MODEL</div>
        <div className="col-span-5 sm:col-span-5">RETENTION</div>
        <div className="col-span-2 text-right">RATE</div>
        <div className="col-span-1 hidden text-right sm:block">ELIGIBLE</div>
      </div>
      <div className="divide-y divide-neutral-800/60">
        {sorted.map((row, idx) => (
          <div key={row.model} className="grid grid-cols-12 items-center gap-2 px-3 py-2.5 text-xs">
            <div className="col-span-1 font-mono text-neutral-500">{String(idx + 1).padStart(2, '0')}</div>
            <div className="col-span-3 truncate font-mono text-neutral-200" title={row.model}>
              {row.model}
            </div>
            <div className="col-span-5 flex items-center gap-2">
              <div className="relative h-1 flex-1 rounded-full bg-neutral-800">
                <div className="absolute inset-y-0 left-0 flex items-center" style={{ left: `${row.rate * 100}%` }}>
                  <div className="h-3 w-1 -translate-x-1/2 rounded-sm bg-white shadow" />
                </div>
                <div className="absolute inset-y-0 left-0 rounded-full bg-white/20" style={{ width: `${row.rate * 100}%` }} />
                <div className="absolute inset-0 flex">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="flex-1 border-r border-dashed border-neutral-700/50 last:border-0" />
                  ))}
                </div>
              </div>
            </div>
            <div className="col-span-2 text-right font-mono text-neutral-200">{formatPercent(row.rate)}</div>
            <div className="col-span-1 hidden text-right font-mono text-neutral-500 sm:block">{row.eligible.toLocaleString()}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export const RetentionRanking = memo(RetentionRankingImpl)
export default RetentionRanking
