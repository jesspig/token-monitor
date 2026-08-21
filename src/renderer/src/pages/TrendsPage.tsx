import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
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
import type { DailyStats, RequestLogDetail } from '../../../../shared/query'
import { Card } from '../components/Card'
import { EmptyState } from '../components/EmptyState'
import { PageHeader } from '../components/PageHeader'
import { RangeSelector } from '../components/RangeSelector'
import { useDailyTrends } from '../hooks/useDailyTrends'
import { useRequestLogs } from '../hooks/useRequestLogs'
import { formatHour, formatUsd } from '../lib/format'
import { RANGE_OPTIONS, rangeToFilters, type RangeKey } from '../lib/range'

const tooltipStyle = {
  background: '#171717',
  border: '1px solid #262626',
  borderRadius: 8,
  fontSize: 12
}
const tickStyle = { fill: '#737373', fontSize: 11 }
const axisLineStyle = { stroke: '#262626' }

/** 趋势数据点：请求 / 各类 Token / 成本（成本单位 USD） */
interface TrendRow {
  label: string
  requestCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  cost: number
}

/** 今日：从请求日志明细按小时分桶聚合 */
function buildHourlyRows(logs: RequestLogDetail[]): TrendRow[] {
  const buckets = new Map<string, TrendRow>()
  for (const r of logs) {
    const label = formatHour(r.createdAt)
    const b = buckets.get(label)
    if (b) {
      b.requestCount += 1
      b.inputTokens += r.inputTokens
      b.outputTokens += r.outputTokens
      b.cacheReadTokens += r.cacheReadTokens
      b.cacheCreationTokens += r.cacheCreationTokens
      b.cost += r.costUsd ? Number.parseFloat(r.costUsd) : 0
    } else {
      buckets.set(label, {
        label,
        requestCount: 1,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
        cacheCreationTokens: r.cacheCreationTokens,
        cost: r.costUsd ? Number.parseFloat(r.costUsd) : 0
      })
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.label.localeCompare(b.label))
}

/** 7 / 30 天：映射按天聚合序列 */
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

/** 趋势页：请求 / Token / 成本 时间趋势（今日按小时，7/30 天按天） */
export default function TrendsPage(): ReactElement {
  const [range, setRange] = useState<RangeKey>('7d')
  const filters = useMemo(() => rangeToFilters(range), [range])
  const dailyQuery = useDailyTrends(filters)
  // 今日请求趋势需按小时分桶，取请求日志明细（与 Dashboard 一致的取数方式）
  const logsFilters = useMemo(() => rangeToFilters(range, { page: 1, pageSize: 500 }), [range])
  const logsQuery = useRequestLogs(logsFilters)

  const rows = useMemo(() => {
    if (range === 'today') return buildHourlyRows(logsQuery.data?.items ?? [])
    return buildDailyRows(dailyQuery.data ?? [])
  }, [range, dailyQuery.data, logsQuery.data])

  const granularity = range === 'today' ? '按小时' : '按天'
  const loading = rows.length === 0 && (dailyQuery.isLoading || logsQuery.isLoading)

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="趋势" description="加载中…" />
        <Card title="请求趋势">
          <EmptyState title="加载中…" description="正在获取趋势数据。" />
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="趋势"
        description="请求量、Token 消耗与成本的时间趋势"
        action={<RangeSelector value={range} onChange={setRange} options={RANGE_OPTIONS} />}
      />

      {rows.length === 0 ? (
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
                />
              </LineChart>
            </ResponsiveContainer>
          </Card>

          <Card title={`Token 趋势（${granularity}）：输入 / 输出 / 缓存创建 / 缓存命中 / 成本`}>
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
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
                  fill="#60a5fa"
                  fillOpacity={0.4}
                />
                <Area
                  yAxisId="tokens"
                  type="monotone"
                  dataKey="outputTokens"
                  name="输出"
                  stackId="tokens"
                  stroke="#34d399"
                  fill="#34d399"
                  fillOpacity={0.4}
                />
                <Area
                  yAxisId="tokens"
                  type="monotone"
                  dataKey="cacheCreationTokens"
                  name="缓存创建"
                  stackId="tokens"
                  stroke="#fbbf24"
                  fill="#fbbf24"
                  fillOpacity={0.4}
                />
                <Area
                  yAxisId="tokens"
                  type="monotone"
                  dataKey="cacheReadTokens"
                  name="缓存命中"
                  stackId="tokens"
                  stroke="#a78bfa"
                  fill="#a78bfa"
                  fillOpacity={0.4}
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
                />
              </AreaChart>
            </ResponsiveContainer>
          </Card>
        </>
      )}
    </div>
  )
}
