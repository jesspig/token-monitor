import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, CircleDollarSign, Database, Gauge, ShieldCheck, TriangleAlert } from 'lucide-react'
import type { BudgetStatus, UsageSummary } from '../../../../shared/query'
import { api, isMock } from '../api'
import { Card } from '../components/Card'
import { EmptyState } from '../components/EmptyState'
import { HeroCard } from '../components/HeroCard'
import { PageHeader } from '../components/PageHeader'
import { RangeSelector } from '../components/RangeSelector'
import { StatCard } from '../components/StatCard'
import { TrendChart } from '../components/TrendChart'
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

/** HourlyStats.hour（0–23）→ 'HH:00' 横轴标签，与原 formatHour 视觉一致 */
function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
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

/** 预算横幅状态：danger（已超限）/ warning（占比 ≥ 80%）/ 无（未设置预算或占比低） */
type BudgetBanner = { level: 'danger' | 'warning'; text: string } | null

/**
 * 预算横幅派生：monthlyExceeded 或 dailyExceeded → danger「费用已超预算:$X / 上限 $Y」；
 * 未超但任一占比 ≥ 80% → warning 显示占比百分比；未设置预算或占比 < 80% → 不渲染。
 */
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

/** Dashboard：Hero 汇总卡 + 时间范围筛选 + 请求/Token 迷你趋势 */
export default function DashboardPage(): ReactElement {
  const [range, setRange] = useState<RangeKey>('today')
  const [customRange, setCustomRange] = useState<CustomRange | null>(null)
  // custom 且区间合法时按自定义毫秒区间查询，否则回退既有五档（custom 无区间时 rangeToFilters 内部回退 7 天）
  const filters = useMemo(() => {
    if (range === 'custom' && customRange) {
      return rangeToFilters('custom', customRangeToMs(customRange) ?? {})
    }
    return rangeToFilters(range)
  }, [range, customRange])

  const summaryQuery = useUsageSummary(filters)
  const dailyQuery = useDailyTrends(filters)
  // 今日 / 24 小时迷你趋势改由后端按小时分桶（不再取明细在前端分桶，避免大流量日截断）；
  // queryKey 复用 daily-trends 一级前缀，纳入既有 usage-updated 失效清单
  const hourlyQuery = useQuery({
    queryKey: ['daily-trends', 'hourly', filters],
    queryFn: () => api.getHourlyTrends(filters),
    enabled: range === 'today' || range === '24h'
  })
  // 预算限额状态（全局维度，staleTime 与页面其他查询一致走全局默认）
  const budgetQuery = useQuery({
    queryKey: ['budget-status'],
    queryFn: () => api.getBudgetStatus()
  })

  const banner = useMemo(() => deriveBudgetBanner(budgetQuery.data), [budgetQuery.data])

  const s = summaryQuery.data ?? EMPTY_SUMMARY
  const rangeLabel = RANGE_OPTIONS.find((o) => o.key === range)?.label ?? (range === 'custom' ? '自定义' : '')

  const trend = useMemo(() => {
    if (range === 'today' || range === '24h') {
      const hourly = hourlyQuery.data ?? []
      const crossDay = new Set(hourly.map((h) => h.dayKey)).size >= 2
      return hourly.map((h) => ({
        label:
          crossDay && h.dayKey
            ? `${h.dayKey.slice(5)} ${hourLabel(h.hour)}`
            : hourLabel(h.hour),
        requests: h.requestCount,
        tokens:
          h.inputTokens + h.outputTokens + h.cacheReadTokens + h.cacheCreationTokens
      }))
    }
    return (dailyQuery.data ?? []).map((d) => ({
      label: d.date.slice(5),
      requests: d.requestCount,
      tokens: d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheCreationTokens
    }))
  }, [range, dailyQuery.data, hourlyQuery.data])

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

      <Card
        title={`${rangeLabel} 请求 / Token 趋势（${range === 'today' || range === '24h' ? '按小时' : '按天'}）`}
      >
        {trend.length > 0 ? (
          <TrendChart data={trend} />
        ) : (
          <EmptyState
            title="等待真实数据"
            description="当前时间范围内暂无用量记录，接入真实 IPC 后端后将在此展示趋势。"
          />
        )}
      </Card>
    </div>
  )
}
