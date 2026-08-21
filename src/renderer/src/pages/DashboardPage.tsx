import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { Activity, CircleDollarSign, Database, Gauge, ShieldCheck } from 'lucide-react'
import type { UsageSummary } from '../../../../shared/query'
import { isMock } from '../api'
import { Card } from '../components/Card'
import { EmptyState } from '../components/EmptyState'
import { HeroCard } from '../components/HeroCard'
import { PageHeader } from '../components/PageHeader'
import { RangeSelector } from '../components/RangeSelector'
import { StatCard } from '../components/StatCard'
import { TrendChart } from '../components/TrendChart'
import { useDailyTrends } from '../hooks/useDailyTrends'
import { useRequestLogs } from '../hooks/useRequestLogs'
import { useUsageSummary } from '../hooks/useUsageSummary'
import { formatHour, formatNumber, formatPercent, formatTokens, formatUsd } from '../lib/format'
import { RANGE_OPTIONS, rangeToFilters, type RangeKey } from '../lib/range'

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

/** Dashboard：Hero 汇总卡 + 时间范围筛选 + 请求/Token 迷你趋势 */
export default function DashboardPage(): ReactElement {
  const [range, setRange] = useState<RangeKey>('today')
  const filters = useMemo(() => rangeToFilters(range), [range])
  // 今日迷你趋势需要按小时分桶，取请求日志明细
  const logsFilters = useMemo(() => rangeToFilters(range, { page: 1, pageSize: 500 }), [range])

  const summaryQuery = useUsageSummary(filters)
  const dailyQuery = useDailyTrends(filters)
  const logsQuery = useRequestLogs(logsFilters)

  const s = summaryQuery.data ?? EMPTY_SUMMARY
  const rangeLabel = RANGE_OPTIONS.find((o) => o.key === range)?.label ?? ''

  const trend = useMemo(() => {
    if (range === 'today') {
      const buckets = new Map<string, { requests: number; tokens: number }>()
      for (const r of logsQuery.data?.items ?? []) {
        const label = formatHour(r.createdAt)
        const b = buckets.get(label) ?? { requests: 0, tokens: 0 }
        b.requests += 1
        b.tokens += r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreationTokens
        buckets.set(label, b)
      }
      return Array.from(buckets, ([label, v]) => ({ label, ...v })).sort((a, b) =>
        a.label.localeCompare(b.label)
      )
    }
    return (dailyQuery.data ?? []).map((d) => ({
      label: d.date.slice(5),
      requests: d.requestCount,
      tokens: d.inputTokens + d.outputTokens + d.cacheReadTokens + d.cacheCreationTokens
    }))
  }, [range, dailyQuery.data, logsQuery.data])

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
        action={<RangeSelector value={range} onChange={setRange} options={RANGE_OPTIONS} />}
      />

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
        title={`${rangeLabel} 请求 / Token 趋势（${range === 'today' ? '按小时' : '按天'}）`}
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
