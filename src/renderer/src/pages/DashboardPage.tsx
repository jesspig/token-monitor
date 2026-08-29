import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { Activity, CircleDollarSign, Database, Gauge, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { BudgetStatus, DailyStats, HourlyStats, UsageSummary } from '../../../../shared/query'
import { api, isMock } from '../api'
import { Card } from '../components/Card'
import { EmptyState } from '../components/EmptyState'
import { HeroCard } from '../components/HeroCard'
import { PageHeader } from '../components/PageHeader'
import { RangeSelector } from '../components/RangeSelector'
import { StatCard } from '../components/StatCard'
import { useDailyTrends } from '../hooks/useDailyTrends'
import { useUsageSummary } from '../hooks/useUsageSummary'
import { formatNumber, formatPercent, formatTokens, formatUsd } from '../lib/format'
import {
  RANGE_OPTIONS,
  customRangeToMs,
  rangeToFilters,
  type CustomRange,
  type RangeKey
} from '../lib/range'
import { getStatsRefreshInterval } from '../lib/settings-cache'

const tooltipStyle = {
  background: '#171717',
  border: '1px solid #262626',
  borderRadius: 8,
  fontSize: 12
}
const tickStyle = { fill: '#737373', fontSize: 11 }
const axisLineStyle = { stroke: '#262626' }

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

export default function DashboardPage(): ReactElement {
  const [range, setRange] = useState<RangeKey>('7d')
  const [customRange, setCustomRange] = useState<CustomRange | null>(null)
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

  const rows = useMemo(() => {
    if (range === 'today' || range === '24h') return buildHourlyRows(hourlyQuery.data ?? [])
    return buildDailyRows(dailyQuery.data ?? [])
  }, [range, dailyQuery.data, hourlyQuery.data])

  const granularity = range === 'today' || range === '24h' ? '按小时' : '按天'
  const loading = rows.length === 0 && (dailyQuery.isLoading || hourlyQuery.isLoading)

  return (
    <div className="space-y-6">
      <PageHeader
        title="仪表盘"
        description={
          summaryQuery.isLoading
            ? '加载中…'
            : isMock
              ? '当前展示 Mock 数据，后端 IPC 就绪后自动切换真实数据'
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
              ? 'border-red-500/40 bg-red-500/10 text-red-300'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
          }`}
        >
          <TriangleAlert className="h-4 w-4 shrink-0" />
          <span>{banner.text}</span>
        </div>
      )}

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

      {loading ? (
        <Card title="请求趋势">
          <EmptyState title="加载中…" description="正在获取趋势数据。" />
        </Card>
      ) : rows.length === 0 ? (
        <EmptyState
          title="等待真实数据"
          description="当前时间范围内暂无趋势数据，接入真实 IPC 后端后展示。"
        />
      ) : (
        <>
          <Card title={`请求趋势（${granularity}）`}>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#262626" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={tickStyle}
                  tickLine={false}
                  axisLine={axisLineStyle}
                  minTickGap={24}
                />
                <YAxis tick={tickStyle} tickLine={false} axisLine={false} width={40} />
                <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: '#d4d4d4' }} />
                <Line
                  type="monotone"
                  dataKey="requestCount"
                  name="请求数"
                  stroke="#34d399"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </Card>

          <Card title={`Token 趋势（${granularity}）：输入 / 输出 / 缓存创建 / 缓存命中 / 成本`}>
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="dash-trend-input" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#60a5fa" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#60a5fa" stopOpacity={0.03} />
                  </linearGradient>
                  <linearGradient id="dash-trend-output" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#34d399" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#34d399" stopOpacity={0.03} />
                  </linearGradient>
                  <linearGradient id="dash-trend-cache-create" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#fbbf24" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#fbbf24" stopOpacity={0.03} />
                  </linearGradient>
                  <linearGradient id="dash-trend-cache-read" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#a78bfa" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#a78bfa" stopOpacity={0.03} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#262626" vertical={false} />
                <XAxis
                  dataKey="label"
                  tick={tickStyle}
                  tickLine={false}
                  axisLine={axisLineStyle}
                  minTickGap={24}
                />
                <YAxis yAxisId="tokens" tick={tickStyle} tickLine={false} axisLine={false} width={46} />
                <YAxis
                  yAxisId="cost"
                  orientation="right"
                  tick={tickStyle}
                  tickLine={false}
                  axisLine={false}
                  width={58}
                  tickFormatter={(v: number) => formatUsd(v)}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  labelStyle={{ color: '#d4d4d4' }}
                  formatter={(value, name) =>
                    name === '成本' ? formatUsd(Number(value)) : Number(value).toLocaleString('en-US')
                  }
                />
                <Area
                  yAxisId="tokens"
                  type="monotone"
                  dataKey="inputTokens"
                  name="输入"
                  stackId="tokens"
                  stroke="#60a5fa"
                  fill="url(#dash-trend-input)"
                  isAnimationActive={false}
                />
                <Area
                  yAxisId="tokens"
                  type="monotone"
                  dataKey="outputTokens"
                  name="输出"
                  stackId="tokens"
                  stroke="#34d399"
                  fill="url(#dash-trend-output)"
                  isAnimationActive={false}
                />
                <Area
                  yAxisId="tokens"
                  type="monotone"
                  dataKey="cacheCreationTokens"
                  name="缓存创建"
                  stackId="tokens"
                  stroke="#fbbf24"
                  fill="url(#dash-trend-cache-create)"
                  isAnimationActive={false}
                />
                <Area
                  yAxisId="tokens"
                  type="monotone"
                  dataKey="cacheReadTokens"
                  name="缓存命中"
                  stackId="tokens"
                  stroke="#a78bfa"
                  fill="url(#dash-trend-cache-read)"
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="cost"
                  type="monotone"
                  dataKey="cost"
                  name="成本"
                  stroke="#f87171"
                  strokeWidth={2}
                  strokeDasharray="4 4"
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </Card>
        </>
      )}
    </div>
  )
}
