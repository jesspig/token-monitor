import { useMemo, useRef } from 'react'
import type { ReactElement } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type {
  DefaultLabelFormatterCallbackParams,
  TooltipComponentFormatterCallbackParams
} from 'echarts'
import type { BarSeriesOption } from 'echarts/charts'
import { PageHeader } from '../components/PageHeader'
import { RangeSelector } from '../components/RangeSelector'
import { Card } from '../components/Card'
import { EmptyState } from '../components/EmptyState'
import { QueryState } from '../components/QueryState'
import {
  AXIS_LABEL_STYLE,
  AXIS_LINE_STYLE,
  AXIS_TICK_STYLE,
  buildBaseOption,
  CHART_PALETTE,
  GRID_STYLE,
  LEGEND_STYLE,
  SPLIT_LINE_STYLE,
  TOOLTIP_STYLE,
  type ChartOption
} from '../components/chart-theme'
import DimensionTable from '../components/DimensionTable'
import LeaderboardGrid from '../components/LeaderboardGrid'
import RetentionRanking from '../components/RetentionRanking'
import { RANGE_OPTIONS, customRangeToMs, rangeToFilters } from '../lib/range'
import { useFilter } from '../context/FilterContext'
import { useNav } from '../context/NavContext'
import type { AppType } from '../../../../shared/app'
import { type DimensionStats, type DimensionKey, useDimensionStats } from '../hooks/useDimensionStats'
import type { ModelStats } from '../../../../shared/query'
import { formatCompact, formatTokens, formatUsd } from '../lib/format'
import { api } from '../api'
import { useECharts } from '../hooks/useECharts'

function totalTokensOf(m: ModelStats): number {
  return m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens
}

function markerOf(p: DefaultLabelFormatterCallbackParams): string {
  return typeof p.marker === 'string' ? p.marker : ''
}

function tokensAxisTooltipFormatter(params: TooltipComponentFormatterCallbackParams): string {
  const list = Array.isArray(params) ? params : [params]
  if (list.length === 0) return ''
  const lines = list.map((p) => `${markerOf(p)} ${p.seriesName ?? ''}  ${formatTokens(Number(p.value))}`)
  return [list[0].name, ...lines].join('<br/>')
}

function costAxisTooltipFormatter(params: TooltipComponentFormatterCallbackParams): string {
  const list = Array.isArray(params) ? params : [params]
  if (list.length === 0) return ''
  const lines = list.map((p) => `${markerOf(p)} ${p.seriesName ?? ''}  ${formatUsd(Number(p.value))}`)
  return [list[0].name, ...lines].join('<br/>')
}

function pieTooltipFormatter(params: TooltipComponentFormatterCallbackParams): string {
  const p = Array.isArray(params) ? params[0] : params
  if (!p) return ''
  return `${markerOf(p)} ${p.name}  ${formatUsd(Number(p.value))}`
}

function pieLabelFormatter(p: DefaultLabelFormatterCallbackParams): string {
  if (p.percent == null) return ''
  return p.percent > 8 ? `${p.percent.toFixed(0)}%` : ''
}

interface StackChartProps {
  chartData: Array<Record<string, any>>
  models: string[]
}

function categoryAxisOf(chartData: Array<Record<string, any>>): ChartOption['xAxis'] {
  return {
    type: 'category',
    data: chartData.map((row) => String(row.label)),
    axisTick: AXIS_TICK_STYLE,
    axisLine: AXIS_LINE_STYLE,
    axisLabel: AXIS_LABEL_STYLE
  }
}

function TokenStackChart({ chartData, models }: StackChartProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const option = useMemo<ChartOption>(
    () =>
      buildBaseOption({
        grid: GRID_STYLE,
        xAxis: categoryAxisOf(chartData),
        yAxis: {
          type: 'value',
          axisTick: AXIS_TICK_STYLE,
          axisLine: { show: false },
          splitLine: SPLIT_LINE_STYLE,
          axisLabel: { ...AXIS_LABEL_STYLE, formatter: (value: number) => formatCompact(value) }
        },
        tooltip: { ...TOOLTIP_STYLE, trigger: 'axis', formatter: tokensAxisTooltipFormatter },
        legend: { ...LEGEND_STYLE, type: 'scroll' },
        series: models.map<BarSeriesOption>((m, i) => ({
          name: m,
          type: 'bar',
          stack: 'tokens',
          data: chartData.map((row) => Number(row[m] ?? 0)),
          ...(i === models.length - 1 ? { itemStyle: { borderRadius: [4, 4, 0, 0] } } : {})
        }))
      }),
    [chartData, models]
  )
  useECharts(containerRef, option)
  return <div ref={containerRef} className="h-80 w-full" />
}

function CostStackChart({ chartData, models }: StackChartProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const option = useMemo<ChartOption>(
    () =>
      buildBaseOption({
        grid: GRID_STYLE,
        xAxis: categoryAxisOf(chartData),
        yAxis: {
          type: 'value',
          axisTick: AXIS_TICK_STYLE,
          axisLine: { show: false },
          splitLine: SPLIT_LINE_STYLE,
          axisLabel: { ...AXIS_LABEL_STYLE, formatter: (value: number) => formatUsd(value) }
        },
        tooltip: { ...TOOLTIP_STYLE, trigger: 'axis', formatter: costAxisTooltipFormatter },
        legend: { ...LEGEND_STYLE, type: 'scroll' },
        series: models.map<BarSeriesOption>((m, i) => ({
          name: m,
          type: 'bar',
          stack: 'cost',
          data: chartData.map((row) => Number(row[m] ?? 0)),
          ...(i === models.length - 1 ? { itemStyle: { borderRadius: [4, 4, 0, 0] } } : {})
        }))
      }),
    [chartData, models]
  )
  useECharts(containerRef, option)
  return <div ref={containerRef} className="h-80 w-full" />
}

function CostDonutChart({ pieData }: { pieData: Array<{ name: string; value: number }> }): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const totalCost = pieData.reduce((sum, item) => sum + item.value, 0)
  const option = useMemo<ChartOption>(() => {
    const base = buildBaseOption({
      tooltip: { ...TOOLTIP_STYLE, trigger: 'item', formatter: pieTooltipFormatter },
      legend: { ...LEGEND_STYLE, top: 'auto', bottom: 0 },
      series: [
        {
          type: 'pie',
          name: '费用占比',
          radius: ['45%', '70%'],
          center: ['50%', '50%'],
          padAngle: 2,
          label: {
            position: 'outside',
            color: '#d4d4d4',
            fontSize: 11,
            formatter: pieLabelFormatter
          },
          labelLine: { show: false },
          data: pieData.map((item, i) => ({
            name: item.name,
            value: item.value,
            itemStyle: { color: CHART_PALETTE[i % CHART_PALETTE.length] }
          }))
        }
      ]
    })
    return {
      ...base,
      title: {
        text: formatUsd(totalCost),
        subtext: '区间总费用',
        left: 'center',
        top: 'middle',
        textStyle: { color: '#fafafa', fontSize: 20, fontWeight: 600 },
        subtextStyle: { color: '#737373', fontSize: 11 }
      }
    }
  }, [pieData, totalCost])
  useECharts(containerRef, option)
  return <div ref={containerRef} className="h-72 w-full" />
}

export default function StatsPage(): ReactElement {
  const { filter, setRange, setCustomRange, setModels, setAppTypes, setProject } = useFilter()
  const range = filter.range
  const customRange = filter.customRange
  const nav = useNav()

  const filters = useMemo(() => {
    if (range === 'custom' && customRange) {
      return rangeToFilters('custom', customRangeToMs(customRange) ?? {})
    }
    return rangeToFilters(range)
  }, [range, customRange])
  const fixed30d = useMemo(() => rangeToFilters('30d'), [])
  const modelQuery = useDimensionStats('model', filters)
  const models = (modelQuery.data ?? []) as ModelStats[]
  const filteredModels = useMemo(() => models.filter((m) => totalTokensOf(m) > 0 || Number(m.costUsd) > 0), [models])

  const dailyModelQ = useQuery({
    queryKey: ['daily-model-breakdown', fixed30d],
    queryFn: () => api.getDailyModelBreakdown(fixed30d),
    staleTime: 2 * 60 * 1000,
    placeholderData: keepPreviousData
  })

  const tokenStack = useMemo(() => {
    const data = dailyModelQ.data ?? []
    if (data.length === 0) return { chartData: [] as Array<Record<string, any>>, models: [] as string[] }
    const totals = new Map<string, number>()
    for (const r of data) totals.set(r.model, (totals.get(r.model) ?? 0) + r.tokens)
    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1])
    const top = sorted.slice(0, 5).map(([k]) => k)
    const hasOthers = sorted.length > 5
    const topSet = new Set(top)
    const grouped = new Map<string, Map<string, number>>()
    for (const e of data) {
      let byModel = grouped.get(e.date)
      if (!byModel) {
        byModel = new Map<string, number>()
        grouped.set(e.date, byModel)
      }
      const key = topSet.has(e.model) ? e.model : hasOthers ? 'Others' : null
      if (key === null) continue
      byModel.set(key, (byModel.get(key) ?? 0) + e.tokens)
    }
    const dates = [...grouped.keys()].sort()
    const chartData = dates.map((date) => {
      const row: Record<string, any> = { label: date.slice(5) }
      for (const m of top) row[m] = 0
      if (hasOthers) row['Others'] = 0
      const byModel = grouped.get(date)
      if (byModel) for (const [k, v] of byModel) row[k] = v
      return row
    })
    const orderedModels = hasOthers ? [...top, 'Others'] : top
    return { chartData, models: orderedModels }
  }, [dailyModelQ.data])

  const costStack = useMemo(() => {
    const data = dailyModelQ.data ?? []
    if (data.length === 0) return { dailyData: [] as Array<Record<string, any>>, pieData: [] as Array<{ name: string; value: number }>, models: [] as string[] }
    const totals = new Map<string, number>()
    for (const r of data) totals.set(r.model, (totals.get(r.model) ?? 0) + Number(r.cost))
    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1])
    const top = sorted.slice(0, 5).map(([k]) => k)
    const hasOthers = sorted.length > 5
    const topSet = new Set(top)
    const grouped = new Map<string, Map<string, number>>()
    for (const e of data) {
      let byModel = grouped.get(e.date)
      if (!byModel) {
        byModel = new Map<string, number>()
        grouped.set(e.date, byModel)
      }
      const v = Number(e.cost) || 0
      const key = topSet.has(e.model) ? e.model : hasOthers ? 'Others' : null
      if (key === null) continue
      byModel.set(key, (byModel.get(key) ?? 0) + v)
    }
    const dates = [...grouped.keys()].sort()
    const dailyData = dates.map((date) => {
      const row: Record<string, any> = { label: date.slice(5) }
      for (const m of top) row[m] = 0
      if (hasOthers) row['Others'] = 0
      const byModel = grouped.get(date)
      if (byModel) for (const [k, v] of byModel) row[k] = v
      return row
    })
    const pieData: Array<{ name: string; value: number }> = top.map((m) => ({ name: m, value: totals.get(m) ?? 0 }))
    if (hasOthers) {
      const othersValue = sorted.slice(5).reduce((sum, [, v]) => sum + v, 0)
      pieData.push({ name: 'Others', value: othersValue })
    }
    const orderedModels = hasOthers ? [...top, 'Others'] : top
    return { dailyData, pieData, models: orderedModels }
  }, [dailyModelQ.data])

  const sessionCostData = useMemo(() => {
    return [...filteredModels]
      .map((m) => ({
        name: m.model,
        shortName: m.model.length > 24 ? `${m.model.slice(0, 12)}…${m.model.slice(-10)}` : m.model,
        fullName: m.model,
        costPerSession: m.requestCount > 0 ? Number(m.costUsd) / m.requestCount : 0,
        tokensPerSession: m.requestCount > 0 ? totalTokensOf(m) / m.requestCount : 0,
        requestCount: m.requestCount
      }))
      .sort((a, b) => b.costPerSession - a.costPerSession)
      .slice(0, 10)
  }, [filteredModels])

  const perMillionData = useMemo(() => {
    return [...filteredModels]
      .sort((a, b) => totalTokensOf(b) - totalTokensOf(a))
      .slice(0, 8)
      .map((m) => {
        const total = totalTokensOf(m) || 1
        const costPerM = Number(m.costUsd) / total * 1_000_000
        return {
          name: m.model,
          shortName: m.model.length > 20 ? `${m.model.slice(0, 10)}…${m.model.slice(-8)}` : m.model,
          fullName: m.model,
          costPerM,
          inputCostPerM: (m.inputTokens / total) * costPerM,
          outputCostPerM: (m.outputTokens / total) * costPerM,
          cacheCostPerM: ((m.cacheReadTokens + m.cacheCreationTokens) / total) * costPerM
        }
      })
  }, [filteredModels])

  const handleDrill = (row: DimensionStats, dimension: DimensionKey): void => {
    if (dimension === 'model') setModels([(row as { model: string }).model])
    else if (dimension === 'app') setAppTypes([(row as { appType: AppType }).appType])
    else if (dimension === 'project') setProject((row as { project: string }).project)
    nav.navigate('logs')
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="统计"
        description="按模型、项目等维度拆分的用量与费用聚合"
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

      <Card title="使用量 Top 10">
        <p className="mb-3 text-xs text-neutral-500">按 Token 总量排序，取使用量前十模型（已过滤全 0 模型）</p>
        <QueryState
          isPending={modelQuery.isPending}
          error={modelQuery.error}
          refetch={modelQuery.refetch}
          hasData={modelQuery.data != null}
          isFetching={modelQuery.isFetching}
          skeletonVariant="cards"
          dimWhenRefreshing
        >
          <LeaderboardGrid data={filteredModels} maxItems={10} />
        </QueryState>
      </Card>

      <Card title="费用占比（最近 30 天总占比）">
        <p className="mb-3 text-xs text-neutral-500">近 30 天 Top 5 + Others 按模型聚合的费用占比，中心为区间总费用</p>
        <QueryState
          isPending={dailyModelQ.isPending}
          error={dailyModelQ.error}
          refetch={dailyModelQ.refetch}
          hasData={dailyModelQ.data != null}
          isEmpty={costStack.pieData.length === 0}
          isFetching={dailyModelQ.isFetching}
          skeletonVariant="chart"
          dimWhenRefreshing
          empty={<EmptyState title="暂无费用数据" description="当前时间范围内没有费用记录。" />}
        >
          <CostDonutChart pieData={costStack.pieData} />
        </QueryState>
      </Card>

      <Card title="每日 Token 消耗量">
        <p className="mb-3 text-xs text-neutral-500">按模型堆叠的近 30 天柱状图，悬停查看各模型当日 Token 消耗</p>
        <QueryState
          isPending={dailyModelQ.isPending}
          error={dailyModelQ.error}
          refetch={dailyModelQ.refetch}
          hasData={dailyModelQ.data != null}
          isEmpty={tokenStack.chartData.length === 0}
          isFetching={dailyModelQ.isFetching}
          skeletonVariant="chart"
          dimWhenRefreshing
          empty={<EmptyState title="暂无 Token 数据" description="当前时间范围内没有 Token 消耗记录。" />}
        >
          <TokenStackChart chartData={tokenStack.chartData} models={tokenStack.models} />
        </QueryState>
      </Card>

      <Card title="详细维度表">
        <p className="mb-3 text-xs text-neutral-500">支持五维切换与三视图（概览 / Tokens 明细 / 全部），行点击下钻至请求日志（已过滤全 0 行）</p>
        <DimensionTable range={range} onRowClick={handleDrill} />
      </Card>

      <Card title="费用占比（每日堆叠）">
        <p className="mb-3 text-xs text-neutral-500">近 30 天按日堆叠的各模型费用（Top 5 + Others）</p>
        <QueryState
          isPending={dailyModelQ.isPending}
          error={dailyModelQ.error}
          refetch={dailyModelQ.refetch}
          hasData={dailyModelQ.data != null}
          isEmpty={costStack.dailyData.length === 0}
          isFetching={dailyModelQ.isFetching}
          skeletonVariant="chart"
          dimWhenRefreshing
          empty={<EmptyState title="暂无费用数据" description="当前时间范围内没有费用记录。" />}
        >
          <CostStackChart chartData={costStack.dailyData} models={costStack.models} />
        </QueryState>
      </Card>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2 xl:items-start">
      <Card title="模型成功率排行">
        <p className="mb-3 text-xs text-neutral-500">横向点状条按成功率排序</p>
        <QueryState
          isPending={modelQuery.isPending}
          error={modelQuery.error}
          refetch={modelQuery.refetch}
          hasData={modelQuery.data != null}
          isFetching={modelQuery.isFetching}
          skeletonVariant="table"
          dimWhenRefreshing
        >
          <RetentionRanking data={filteredModels} metric="successRate" maxItems={15} />
        </QueryState>
      </Card>

      <Card title="缓存命中率排行">
        <p className="mb-3 text-xs text-neutral-500">横向点状条按缓存命中率排序（缓存读 / (输入+缓存读)）</p>
        <QueryState
          isPending={modelQuery.isPending}
          error={modelQuery.error}
          refetch={modelQuery.refetch}
          hasData={modelQuery.data != null}
          isFetching={modelQuery.isFetching}
          skeletonVariant="table"
          dimWhenRefreshing
        >
          <RetentionRanking data={filteredModels} metric="cacheHitRate" maxItems={15} />
        </QueryState>
      </Card>

      <Card title="会话成本排行榜">
        <p className="mb-3 text-xs text-neutral-500">每次会话的平均成本，对标会话成本（成本 / 会话 与 Token / 会话）</p>
        <QueryState
          isPending={modelQuery.isPending}
          error={modelQuery.error}
          refetch={modelQuery.refetch}
          hasData={modelQuery.data != null}
          isEmpty={sessionCostData.length === 0}
          isFetching={modelQuery.isFetching}
          skeletonVariant="table"
          dimWhenRefreshing
          empty={<EmptyState title="暂无数据" description="当前无会话成本数据。" />}
        >
          <div className="space-y-3">
            <div className="grid grid-cols-12 gap-2 px-2 py-1 text-[11px] uppercase tracking-wide text-neutral-500">
              <div className="col-span-3">MODEL</div>
              <div className="col-span-4">成本 / 会话</div>
              <div className="col-span-4">Token / 会话</div>
            </div>
            {(() => {
              const maxCost = Math.max(...sessionCostData.map((d) => d.costPerSession), 1)
              const maxTokens = Math.max(...sessionCostData.map((d) => d.tokensPerSession), 1)
              return sessionCostData.slice(0, 10).map((row) => (
                <div key={row.name} className="grid grid-cols-12 items-center gap-2 px-2 py-2 text-xs hover:bg-neutral-800/30">
                  <div className="col-span-3 truncate font-mono text-neutral-200" title={row.fullName}>
                    {row.shortName}
                  </div>
                  <div className="col-span-4 flex items-center gap-2">
                    <div className="relative h-1.5 flex-1 rounded-full bg-neutral-800">
                      <div className="absolute inset-y-0 left-0 rounded-full bg-white" style={{ width: `${(row.costPerSession / maxCost) * 100}%` }} />
                    </div>
                    <span className="w-16 text-right tabular-nums text-[11px] text-neutral-400">{formatUsd(String(row.costPerSession))}</span>
                  </div>
                  <div className="col-span-4 flex items-center gap-2">
                    <div className="relative h-1.5 flex-1 rounded-full bg-neutral-800">
                      <div className="absolute inset-y-0 left-0 rounded-full bg-white" style={{ width: `${(row.tokensPerSession / maxTokens) * 100}%` }} />
                    </div>
                    <span className="w-16 text-right tabular-nums text-[11px] text-neutral-400">{formatTokens(Math.round(row.tokensPerSession))}</span>
                  </div>
                </div>
              ))
            })()}
          </div>
        </QueryState>
      </Card>

      <Card title="每百万 Token 成本">
        <p className="mb-3 text-xs text-neutral-500">每 100 万 Token 的价格，对标 Token 成本（输入 / 输出 / 已缓存分段）</p>
        <QueryState
          isPending={modelQuery.isPending}
          error={modelQuery.error}
          refetch={modelQuery.refetch}
          hasData={modelQuery.data != null}
          isEmpty={perMillionData.length === 0}
          isFetching={modelQuery.isFetching}
          skeletonVariant="table"
          dimWhenRefreshing
          empty={<EmptyState title="暂无数据" description="当前无 Token 数据。" />}
        >
          <div className="space-y-2">
            <div className="grid grid-cols-12 gap-2 px-2 py-1 text-[11px] uppercase tracking-wide text-neutral-500">
              <div className="col-span-4">MODEL</div>
              <div className="col-span-6">价格 / 百万 Token</div>
              <div className="col-span-2 text-right">总价</div>
            </div>
            {(() => {
              return perMillionData.map((row) => {
                const totalPerM = row.costPerM ?? 0
                return (
                  <div key={row.name} className="grid grid-cols-12 items-center gap-2 px-2 py-2 hover:bg-neutral-800/30">
                    <div className="col-span-4 truncate font-mono text-xs text-neutral-200" title={row.fullName}>
                      {row.shortName}
                    </div>
                    <div className="col-span-6">
                      <div className="flex h-2 w-full overflow-hidden rounded-full bg-neutral-800">
                        <div className="h-full bg-[#60a5fa]" style={{ width: `${(row.inputCostPerM / totalPerM) * 100}%` }} title={`输入 $${row.inputCostPerM.toFixed(2)}`} />
                        <div className="h-full bg-[#a78bfa]" style={{ width: `${(row.outputCostPerM / totalPerM) * 100}%` }} title={`输出 $${row.outputCostPerM.toFixed(2)}`} />
                        <div className="h-full bg-[#2dd4bf]" style={{ width: `${(row.cacheCostPerM / totalPerM) * 100}%` }} title={`已缓存 $${row.cacheCostPerM.toFixed(2)}`} />
                      </div>
                    </div>
                    <div className="col-span-2 text-right tabular-nums text-xs text-white">${totalPerM.toFixed(2)}</div>
                  </div>
                )
              })
            })()}
            <div className="mt-2 flex gap-3 text-[11px] text-neutral-500">
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 bg-[#60a5fa]" /> 输入</span>
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 bg-[#a78bfa]" /> 输出</span>
              <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 bg-[#2dd4bf]" /> 已缓存</span>
            </div>
          </div>
        </QueryState>
      </Card>
      </div>
    </div>
  )
}
