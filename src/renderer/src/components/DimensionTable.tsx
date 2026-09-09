import { memo, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import clsx from 'clsx'
import { EmptyState } from './EmptyState'
import { QueryState } from './QueryState'
import { useDimensionStats, type DimensionKey, type DimensionStats } from '../hooks/useDimensionStats'
import { APP_META, formatDuration, formatPercent, formatTokens, formatUsd } from '../lib/format'
import { rangeToFilters, type RangeKey } from '../lib/range'
import type { LogFilters } from '../../../../shared/query'

const TH_TEXT = 'px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-neutral-500'
const TH_NUM = 'text-xs font-medium uppercase tracking-wide text-neutral-500'
const TD_TEXT = 'px-3 py-2 text-sm text-neutral-300'
const TD_NUM = 'px-3 py-2 text-right text-sm tabular-nums text-neutral-300'
const ROW_LIMIT = 50

type SortKey =
  | 'requestCount'
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheCreationTokens'
  | 'costUsd'
  | 'successRate'
  | 'avgLatencyMs'
  | 'totalTokens'

type MetricView = 'overview' | 'tokens' | 'all'

const DIMENSION_TABS: Array<{ key: DimensionKey; label: string; colLabel: string }> = [
  { key: 'model', label: '按模型', colLabel: '模型' },
  { key: 'app', label: '按应用', colLabel: '应用' },
  { key: 'project', label: '按项目', colLabel: '项目' },
  { key: 'session', label: '按会话', colLabel: '会话' },
  { key: 'status', label: '按状态', colLabel: '状态' }
]

const METRIC_TABS: Array<{ key: MetricView; label: string }> = [
  { key: 'overview', label: '概览' },
  { key: 'tokens', label: 'Tokens 明细' },
  { key: 'all', label: '全部' }
]

function dimensionValue(row: DimensionStats, dimension: DimensionKey): string {
  switch (dimension) {
    case 'model':
      return (row as { model: string }).model
    case 'app':
      return APP_META[(row as { appType: keyof typeof APP_META }).appType].label
    case 'project':
      return (row as { project: string }).project
    case 'session':
      return (row as { sessionId: string }).sessionId
    case 'status':
      return (row as { status: string }).status
  }
}

function totalTokensOf(row: DimensionStats): number {
  return row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheCreationTokens
}

function numericValue(row: DimensionStats, key: SortKey): number {
  if (key === 'costUsd') return Number(row.costUsd) || 0
  if (key === 'avgLatencyMs') return (row as { avgLatencyMs?: number | null }).avgLatencyMs ?? 0
  if (key === 'totalTokens') return totalTokensOf(row)
  return row[key as Exclude<SortKey, 'costUsd' | 'avgLatencyMs' | 'totalTokens'>] as number
}

function ariaSortOf(key: SortKey, sortKey: SortKey, sortDir: 'asc' | 'desc'): 'ascending' | 'descending' | 'none' {
  if (key !== sortKey) return 'none'
  return sortDir === 'asc' ? 'ascending' : 'descending'
}

function visibleColumns(metricView: MetricView, dimension: DimensionKey): Array<{ key: SortKey; label: string }> {
  if (metricView === 'overview') {
    const cols: Array<{ key: SortKey; label: string }> = [
      { key: 'requestCount', label: '请求' },
      { key: 'costUsd', label: '费用' },
      { key: 'successRate', label: '成功率' }
    ]
    if (dimension === 'model') cols.push({ key: 'avgLatencyMs', label: '平均耗时' })
    return cols
  }
  if (metricView === 'tokens') {
    return [
      { key: 'inputTokens', label: '输入' },
      { key: 'outputTokens', label: '输出' },
      { key: 'cacheReadTokens', label: '缓存读' },
      { key: 'cacheCreationTokens', label: '缓存写' },
      { key: 'totalTokens', label: '总 Tokens' }
    ]
  }
  return [
    { key: 'requestCount', label: '请求' },
    { key: 'inputTokens', label: '输入' },
    { key: 'outputTokens', label: '输出' },
    { key: 'cacheReadTokens', label: '缓存读' },
    { key: 'cacheCreationTokens', label: '缓存写' },
    { key: 'costUsd', label: '费用' },
    { key: 'successRate', label: '成功率' }
  ]
}

interface DimensionTableProps {
  range: RangeKey
  filters?: LogFilters
  onRowClick?: (row: DimensionStats, dimension: DimensionKey) => void
}

function DimensionTableImpl({ range, filters, onRowClick }: DimensionTableProps): ReactElement {
  const [dimension, setDimension] = useState<DimensionKey>('model')
  const [metricView, setMetricView] = useState<MetricView>('overview')
  const [sortKey, setSortKey] = useState<SortKey>('requestCount')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [expanded, setExpanded] = useState(false)

  const effectiveFilters = useMemo<LogFilters>(
    () => filters ?? rangeToFilters(range),
    [filters, range]
  )

  const query = useDimensionStats(dimension, effectiveFilters)
  const rawData = query.data ?? []
  const data = useMemo(() => rawData.filter((r) => totalTokensOf(r) > 0 || Number(r.costUsd) > 0), [rawData])

  const sorted = useMemo(() => {
    const copy = [...data]
    copy.sort((a, b) => {
      const diff = numericValue(a, sortKey) - numericValue(b, sortKey)
      return sortDir === 'asc' ? diff : -diff
    })
    return copy
  }, [data, sortKey, sortDir])

  const totals = useMemo(() => {
    let requestCount = 0
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheCreationTokens = 0
    let costNum = 0
    let success = 0
    let latencySum = 0
    let latencyWeight = 0
    for (const r of data) {
      requestCount += r.requestCount
      inputTokens += r.inputTokens
      outputTokens += r.outputTokens
      cacheReadTokens += r.cacheReadTokens
      cacheCreationTokens += r.cacheCreationTokens
      costNum += Number(r.costUsd) || 0
      success += r.successRate * r.requestCount
      const lat = (r as { avgLatencyMs?: number | null }).avgLatencyMs
      if (typeof lat === 'number' && Number.isFinite(lat)) {
        latencySum += lat * r.requestCount
        latencyWeight += r.requestCount
      }
    }
    return {
      requestCount,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
      costNum,
      successRate: requestCount > 0 ? success / requestCount : 0,
      avgLatencyMs: latencyWeight > 0 ? latencySum / latencyWeight : null
    }
  }, [data])

  const toggleSort = (key: SortKey): void => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
    setExpanded(false)
  }

  const selectDimension = (key: DimensionKey): void => {
    setDimension(key)
    setExpanded(false)
  }

  const selectMetricView = (key: MetricView): void => {
    setMetricView(key)
    setExpanded(false)
  }

  const dimColLabel = DIMENSION_TABS.find((d) => d.key === dimension)?.colLabel ?? '维度'
  const columns = visibleColumns(metricView, dimension)
  const visibleRows = expanded ? sorted : sorted.slice(0, ROW_LIMIT)
  const isTruncated = !expanded && sorted.length > ROW_LIMIT

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-neutral-800 bg-neutral-900 p-0.5">
          {DIMENSION_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => selectDimension(t.key)}
              className={clsx(
                'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                dimension === t.key
                  ? 'bg-neutral-700 text-white'
                  : 'text-neutral-400 hover:text-neutral-200'
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="inline-flex rounded-lg border border-neutral-800 bg-neutral-900 p-0.5">
          {METRIC_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => selectMetricView(t.key)}
              className={clsx(
                'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                metricView === t.key
                  ? 'bg-neutral-800 text-white border border-neutral-700'
                  : 'text-neutral-400 hover:text-neutral-200'
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <QueryState
        isPending={query.isPending}
        error={query.error}
        refetch={query.refetch}
        hasData={data.length > 0}
        isEmpty={data.length === 0}
        skeletonVariant="table"
        dimWhenRefreshing
        empty={
          <EmptyState title="暂无数据" description="当前时间范围与筛选条件下没有统计数据。" />
        }
      >
        <div className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/60">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse">
              <thead>
                <tr className="border-b border-neutral-800 bg-neutral-900">
                  <th scope="col" className={TH_TEXT}>
                    {dimColLabel}
                  </th>
                  {columns.map((c) => (
                    <th
                      key={c.key}
                      scope="col"
                      aria-sort={ariaSortOf(c.key, sortKey, sortDir)}
                      className={TH_NUM}
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort(c.key)}
                        className="flex w-full cursor-pointer select-none items-center justify-end gap-1 px-3 py-2 transition-colors hover:text-neutral-300"
                      >
                        {c.label}
                        {sortKey === c.key && (
                          <span aria-hidden="true" className="text-neutral-400">
                            {sortDir === 'asc' ? '▲' : '▼'}
                          </span>
                        )}
                        {sortKey === c.key && (
                          <span className="sr-only">{sortDir === 'asc' ? '（升序）' : '（降序）'}</span>
                        )}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r, i) => (
                  <tr
                    key={`${dimensionValue(r, dimension)}-${i}`}
                    className={clsx(
                      'border-b border-neutral-800/70 hover:bg-neutral-800/40',
                      onRowClick &&
                        'cursor-pointer focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-neutral-500'
                    )}
                    onClick={onRowClick ? () => onRowClick(r, dimension) : undefined}
                    tabIndex={onRowClick ? 0 : undefined}
                    onKeyDown={
                      onRowClick
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              onRowClick(r, dimension)
                            }
                          }
                        : undefined
                    }
                  >
                    <td className={clsx(TD_TEXT, dimension === 'model' && 'font-mono text-xs')}>
                      {dimensionValue(r, dimension)}
                    </td>
                    {columns.map((c) => {
                      if (c.key === 'requestCount') return <td key={c.key} className={TD_NUM}>{r.requestCount}</td>
                      if (c.key === 'inputTokens') return <td key={c.key} className={TD_NUM}>{formatTokens(r.inputTokens)}</td>
                      if (c.key === 'outputTokens') return <td key={c.key} className={TD_NUM}>{formatTokens(r.outputTokens)}</td>
                      if (c.key === 'cacheReadTokens') return <td key={c.key} className={TD_NUM}>{formatTokens(r.cacheReadTokens)}</td>
                      if (c.key === 'cacheCreationTokens') return <td key={c.key} className={TD_NUM}>{formatTokens(r.cacheCreationTokens)}</td>
                      if (c.key === 'costUsd') return <td key={c.key} className={TD_NUM}>{formatUsd(r.costUsd)}</td>
                      if (c.key === 'successRate') return <td key={c.key} className={TD_NUM}>{formatPercent(r.successRate)}</td>
                      if (c.key === 'avgLatencyMs') return <td key={c.key} className={TD_NUM}>{formatDuration((r as { avgLatencyMs?: number | null }).avgLatencyMs)}</td>
                      if (c.key === 'totalTokens') return <td key={c.key} className={TD_NUM}>{formatTokens(totalTokensOf(r))}</td>
                      return null
                    })}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-neutral-800 bg-neutral-900 font-medium">
                  <td className={clsx(TD_TEXT, 'text-neutral-200')}>合计</td>
                  {columns.map((c) => {
                    if (c.key === 'requestCount') return <td key={c.key} className={clsx(TD_NUM, 'text-neutral-200')}>{totals.requestCount}</td>
                    if (c.key === 'inputTokens') return <td key={c.key} className={clsx(TD_NUM, 'text-neutral-200')}>{formatTokens(totals.inputTokens)}</td>
                    if (c.key === 'outputTokens') return <td key={c.key} className={clsx(TD_NUM, 'text-neutral-200')}>{formatTokens(totals.outputTokens)}</td>
                    if (c.key === 'cacheReadTokens') return <td key={c.key} className={clsx(TD_NUM, 'text-neutral-200')}>{formatTokens(totals.cacheReadTokens)}</td>
                    if (c.key === 'cacheCreationTokens') return <td key={c.key} className={clsx(TD_NUM, 'text-neutral-200')}>{formatTokens(totals.cacheCreationTokens)}</td>
                    if (c.key === 'costUsd') return <td key={c.key} className={clsx(TD_NUM, 'text-neutral-200')}>{formatUsd(totals.costNum)}</td>
                    if (c.key === 'successRate') return <td key={c.key} className={clsx(TD_NUM, 'text-neutral-200')}>{formatPercent(totals.successRate)}</td>
                    if (c.key === 'avgLatencyMs') return <td key={c.key} className={clsx(TD_NUM, 'text-neutral-200')}>{formatDuration(totals.avgLatencyMs)}</td>
                    if (c.key === 'totalTokens') return <td key={c.key} className={clsx(TD_NUM, 'text-neutral-200')}>{formatTokens(totals.totalTokens)}</td>
                    return null
                  })}
                </tr>
              </tfoot>
            </table>
          </div>
          {isTruncated && (
            <div className="border-t border-neutral-800 px-3 py-2">
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="w-full cursor-pointer rounded-md px-3 py-1.5 text-xs font-medium text-neutral-400 transition-colors hover:bg-neutral-800/60 hover:text-neutral-200"
              >
                显示全部 {sorted.length} 行
              </button>
            </div>
          )}
        </div>
      </QueryState>
    </div>
  )
}

export default memo(DimensionTableImpl)
