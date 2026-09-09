import { useMemo, useRef } from 'react'
import type { ReactElement } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { graphic } from 'echarts/core'
import type { LineSeriesOption } from 'echarts/charts'
import { Activity, CircleDollarSign, Database, Gauge, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { BudgetStatus, DailyStats, HourlyStats, UsageSummary } from '../../../../shared/query'
import { api, isMock } from '../api'
import {
  AXIS_LABEL_STYLE,
  AXIS_LINE_STYLE,
  AXIS_TICK_STYLE,
  buildBaseOption,
  CHART_PALETTE,
  GRID_STYLE,
  SPLIT_LINE_STYLE,
  TOOLTIP_STYLE,
  type ChartOption
} from '../components/chart-theme'
import { Card } from '../components/Card'
import { EmptyState } from '../components/EmptyState'
import { HeroCard } from '../components/HeroCard'
import { PageHeader } from '../components/PageHeader'
import { QueryState } from '../components/QueryState'
import { RangeSelector } from '../components/RangeSelector'
import { StatCard } from '../components/StatCard'
import { useDailyTrends } from '../hooks/useDailyTrends'
import { useECharts } from '../hooks/useECharts'
import { useUsageSummary } from '../hooks/useUsageSummary'
import { useFilter } from '../context/FilterContext'
import { formatCompact, formatNumber, formatPercent, formatTokens, formatUsd } from '../lib/format'
import {
  RANGE_OPTIONS,
  customRangeToMs,
  rangeToFilters
} from '../lib/range'
import { getStatsRefreshInterval } from '../lib/settings-cache'

const COST_COLOR = '#f87171'

const TOKEN_SERIES_META = [
  { key: 'inputTokens', name: '输入', color: '#60a5fa', rgb: '96,165,250' },
  { key: 'outputTokens', name: '输出', color: '#34d399', rgb: '52,211,153' },
  { key: 'cacheCreationTokens', name: '缓存创建', color: '#fbbf24', rgb: '251,191,36' },
  { key: 'cacheReadTokens', name: '缓存命中', color: '#a78bfa', rgb: '167,139,250' }
] as const

interface TrendRow {
  label: string
  requestCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  cost: number
}

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

function buildHourlyRows(data: HourlyStats[]): TrendRow[] {
  const rows = data ?? []
  const crossDay = new Set(rows.map((h) => h.dayKey)).size >= 2
  return rows.map((h) => ({
    label: crossDay && h.dayKey ? `${h.dayKey.slice(5)} ${hourLabel(h.hour)}` : hourLabel(h.hour),
    requestCount: h.requestCount,
    inputTokens: h.inputTokens,
    outputTokens: h.outputTokens,
    cacheReadTokens: h.cacheReadTokens,
    cacheCreationTokens: h.cacheCreationTokens,
    cost: Number.parseFloat(h.costUsd)
  }))
}

function buildDailyRows(data: DailyStats[]): TrendRow[] {
  return (data ?? []).map((d) => ({
    label: d.date.slice(5),
    requestCount: d.requestCount,
    inputTokens: d.inputTokens,
    outputTokens: d.outputTokens,
    cacheReadTokens: d.cacheReadTokens,
    cacheCreationTokens: d.cacheCreationTokens,
    cost: Number.parseFloat(d.costUsd)
  }))
}

function compactAxisLabel(value: number | string): string {
  return formatCompact(Number(value))
}

function costAxisLabel(value: number | string): string {
  return formatUsd(Number(value))
}

function areaGradient(rgb: string): graphic.LinearGradient {
  return new graphic.LinearGradient(0, 0, 0, 1, [
    { offset: 0, color: `rgba(${rgb},0.3)` },
    { offset: 1, color: `rgba(${rgb},0)` }
  ])
}

function categoryAxis(data: string[]): ChartOption['xAxis'] {
  return {
    type: 'category',
    boundaryGap: false,
    data,
    axisTick: AXIS_TICK_STYLE,
    axisLine: AXIS_LINE_STYLE,
    axisLabel: AXIS_LABEL_STYLE
  }
}

const EMPTY_SUMMARY: UsageSummary = {
  totalRequests: 0,
  successCount: 0,
  errorCount: 0,
  totalCost: '0',
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  realTotalTokens: 0,
  cacheHitRate: 0,
  successRate: 0
}

type BudgetBanner = { level: 'danger' | 'warning'; text: string } | null

function deriveBudgetBanner(b: BudgetStatus | undefined): BudgetBanner {
  if (!b) return null
  const parts: string[] = []
  if (b.dailyExceeded) {
    parts.push(
      `今日费用已超预算:${formatUsd(b.dailyCostUsd)} / 上限 ${formatUsd(b.dailyBudgetUsd)}`
    )
  }
  if (b.monthlyExceeded) {
    parts.push(
      `本月费用已超预算:${formatUsd(b.monthlyCostUsd)} / 上限 ${formatUsd(b.monthlyBudgetUsd)}`
    )
  }
  if (parts.length > 0) return { level: 'danger', text: parts.join('；') }

  const warnParts: string[] = []
  if (b.dailyUsageRatio != null && b.dailyUsageRatio >= 0.8) {
    warnParts.push(`今日预算已用 ${formatPercent(b.dailyUsageRatio)}`)
  }
  if (b.monthlyUsageRatio != null && b.monthlyUsageRatio >= 0.8) {
    warnParts.push(`本月预算已用 ${formatPercent(b.monthlyUsageRatio)}`)
  }
  if (warnParts.length > 0) return { level: 'warning', text: warnParts.join('；') }
  return null
}

function RequestTrendChart({ rows }: { rows: TrendRow[] }): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const option = useMemo<ChartOption>(
    () =>
      buildBaseOption({
        grid: { ...GRID_STYLE, top: 36 },
        tooltip: { ...TOOLTIP_STYLE, trigger: 'axis' },
        xAxis: categoryAxis(rows.map((row) => row.label)),
        yAxis: {
          type: 'value',
          axisTick: AXIS_TICK_STYLE,
          axisLine: { show: false },
          splitLine: SPLIT_LINE_STYLE,
          axisLabel: { ...AXIS_LABEL_STYLE, formatter: compactAxisLabel }
        },
        series: [
          {
            name: '请求数',
            type: 'line',
            smooth: true,
            symbol: 'circle',
            symbolSize: 6,
            showSymbol: false,
            itemStyle: { color: CHART_PALETTE[0] },
            lineStyle: { width: 2, color: CHART_PALETTE[0] },
            areaStyle: { color: areaGradient('52,211,153') },
            tooltip: { valueFormatter: (v) => formatNumber(Number(v)) },
            data: rows.map((row) => row.requestCount)
          }
        ]
      }),
    [rows]
  )
  useECharts(containerRef, option)
  return <div ref={containerRef} className="h-60 w-full" />
}

function TokenTrendChart({ rows }: { rows: TrendRow[] }): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const option = useMemo<ChartOption>(() => {
    const tokenSeries: LineSeriesOption[] = TOKEN_SERIES_META.map((meta) => ({
      name: meta.name,
      type: 'line',
      stack: 'tokens',
      smooth: true,
      symbol: 'circle',
      symbolSize: 6,
      showSymbol: false,
      itemStyle: { color: meta.color },
      lineStyle: { width: 1.5, color: meta.color },
      areaStyle: { color: areaGradient(meta.rgb) },
      tooltip: { valueFormatter: (v) => formatTokens(Number(v)) },
      data: rows.map((row) => row[meta.key])
    }))
    const costSeries: LineSeriesOption = {
      name: '成本',
      type: 'line',
      yAxisIndex: 1,
      smooth: true,
      symbol: 'circle',
      symbolSize: 6,
      showSymbol: false,
      itemStyle: { color: COST_COLOR },
      lineStyle: { width: 2, color: COST_COLOR, type: 'dashed' },
      tooltip: { valueFormatter: (v) => formatUsd(Number(v)) },
      data: rows.map((row) => row.cost)
    }
    return buildBaseOption({
      grid: { ...GRID_STYLE, top: 36 },
      tooltip: { ...TOOLTIP_STYLE, trigger: 'axis' },
      xAxis: categoryAxis(rows.map((row) => row.label)),
      yAxis: [
        {
          type: 'value',
          axisTick: AXIS_TICK_STYLE,
          axisLine: { show: false },
          splitLine: SPLIT_LINE_STYLE,
          axisLabel: { ...AXIS_LABEL_STYLE, formatter: compactAxisLabel }
        },
        {
          type: 'value',
          axisTick: AXIS_TICK_STYLE,
          axisLine: { show: false },
          splitLine: { show: false },
          axisLabel: { ...AXIS_LABEL_STYLE, formatter: costAxisLabel }
        }
      ],
      series: [...tokenSeries, costSeries]
    })
  }, [rows])
  useECharts(containerRef, option)
  return <div ref={containerRef} className="h-72 w-full" />
}

export default function DashboardPage(): ReactElement {
  const { filter, setRange, setCustomRange } = useFilter()
  const range = filter.range
  const customRange = filter.customRange
  const filters = useMemo(() => {
    if (range === 'custom' && customRange) {
      return rangeToFilters('custom', customRangeToMs(customRange) ?? {})
    }
    return rangeToFilters(range)
  }, [range, customRange])

  const summaryQuery = useUsageSummary(filters)
  const dailyQuery = useDailyTrends(filters)
  const hourlyQuery = useQuery({
    queryKey: ['daily-trends', 'hourly', filters],
    queryFn: () => api.getHourlyTrends(filters),
    enabled: range === 'today' || range === '24h',
    staleTime: 2 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    placeholderData: keepPreviousData,
    refetchInterval: getStatsRefreshInterval
  })
  const budgetQuery = useQuery({
    queryKey: ['budget-status'],
    queryFn: () => api.getBudgetStatus(),
    staleTime: 2 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    placeholderData: keepPreviousData,
    refetchInterval: getStatsRefreshInterval
  })

  const banner = useMemo(() => deriveBudgetBanner(budgetQuery.data), [budgetQuery.data])

  const s = summaryQuery.data ?? EMPTY_SUMMARY

  const hourlyMode = range === 'today' || range === '24h'
  const activeTrendQuery = hourlyMode ? hourlyQuery : dailyQuery

  const rows = useMemo(() => {
    if (hourlyMode) return buildHourlyRows(hourlyQuery.data ?? [])
    return buildDailyRows(dailyQuery.data ?? [])
  }, [hourlyMode, dailyQuery.data, hourlyQuery.data])

  const granularity = hourlyMode ? '按小时' : '按天'

  return (
    <div className="space-y-6">
      <PageHeader
        title="仪表盘"
        description={
          isMock
            ? '当前展示演示数据，接入真实数据源后自动切换'
            : 'Token 用量汇总'
        }
        action={
          <RangeSelector
            value={range}
            onChange={setRange}
            options={RANGE_OPTIONS}
            customRange={customRange}
            onCustomRangeChange={setCustomRange}
          />
        }
      />

      {banner && (
        <div
          role="alert"
          className={`flex items-center gap-2 rounded-lg border px-4 py-3 text-sm ${
            banner.level === 'danger'
              ? 'border-danger/40 bg-danger/10 text-danger'
              : 'border-warning/40 bg-warning/10 text-warning'
          }`}
        >
          <TriangleAlert className="h-4 w-4 shrink-0" />
          <span>{banner.text}</span>
        </div>
      )}

      <QueryState
        isPending={summaryQuery.isPending}
        error={summaryQuery.error}
        refetch={summaryQuery.refetch}
        hasData={summaryQuery.data != null}
        isFetching={summaryQuery.isFetching}
        skeletonVariant="cards"
        dimWhenRefreshing
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <HeroCard
            label="总请求"
            value={formatNumber(s.totalRequests)}
            hint={`成功 ${formatNumber(s.successCount)} · 失败 ${formatNumber(s.errorCount)}`}
            icon={<Activity className="h-4 w-4" />}
          />
          <StatCard
            label="真实消耗 Tokens"
            value={formatTokens(s.realTotalTokens)}
            sub={`输入 ${formatTokens(s.inputTokens)} · 输出 ${formatTokens(s.outputTokens)}`}
            icon={<Database className="h-4 w-4" />}
          />
          <StatCard
            label="缓存命中率"
            value={formatPercent(s.cacheHitRate)}
            sub={`缓存读 ${formatTokens(s.cacheReadTokens)}`}
            icon={<Gauge className="h-4 w-4" />}
          />
          <StatCard
            label="估算费用"
            value={formatUsd(s.totalCost)}
            sub="USD · 按定价表估算"
            icon={<CircleDollarSign className="h-4 w-4" />}
          />
          <StatCard
            label="成功率"
            value={formatPercent(s.successRate)}
            sub={`${formatNumber(s.errorCount)} 条失败`}
            icon={<ShieldCheck className="h-4 w-4" />}
          />
        </div>
      </QueryState>

      <QueryState
        isPending={activeTrendQuery.isPending}
        error={activeTrendQuery.error}
        refetch={activeTrendQuery.refetch}
        hasData={activeTrendQuery.data != null}
        isEmpty={rows.length === 0}
        isFetching={activeTrendQuery.isFetching}
        skeletonVariant="chart"
        dimWhenRefreshing
        empty={
          <EmptyState title="暂无趋势数据" description="当前时间范围内没有用量记录。" />
        }
      >
        <div className="space-y-6">
          <Card title={`请求趋势（${granularity}）`}>
            <RequestTrendChart rows={rows} />
          </Card>
          <Card title={`Token 趋势（${granularity}）：输入 / 输出 / 缓存创建 / 缓存命中 / 成本`}>
            <TokenTrendChart rows={rows} />
          </Card>
        </div>
      </QueryState>
    </div>
  )
}
