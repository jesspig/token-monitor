import { useMemo, useState, useTransition } from 'react'
import type { ReactElement } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend, Pie, PieChart, Cell } from 'recharts'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { PageHeader } from '../components/PageHeader'
import { RangeSelector } from '../components/RangeSelector'
import { Card } from '../components/Card'
import { EmptyState } from '../components/EmptyState'
import DimensionTable from '../components/DimensionTable'
import LeaderboardGrid from '../components/LeaderboardGrid'
import RetentionRanking from '../components/RetentionRanking'
import { RANGE_OPTIONS, rangeToFilters, type RangeKey } from '../lib/range'
import { useFilter } from '../context/FilterContext'
import { useNav } from '../context/NavContext'
import type { AppType } from '../../../../shared/app'
import { type DimensionStats, type DimensionKey } from '../hooks/useDimensionStats'
import { useDimensionStats } from '../hooks/useDimensionStats'
import type { ModelStats } from '../../../../shared/query'
import { formatTokens, formatUsd } from '../lib/format'
import { api } from '../api'

function totalTokensOf(m: ModelStats): number {
  return m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens
}

const PALETTE = ['#34d399', '#60a5fa', '#f472b6', '#fbbf24', '#a78bfa', '#22d3ee', '#fb7185', '#a3e635', '#f59e0b', '#818cf8']

export default function StatsPage(): ReactElement {
  const [range, setRange] = useState<RangeKey>('7d')
  const [isPending, startTransition] = useTransition()
  const filter = useFilter()
  const nav = useNav()

  const handleRangeChange = (r: RangeKey) => startTransition(() => setRange(r))

  const filters = useMemo(() => rangeToFilters(range), [range])
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
    const dates = [...new Set(data.map((d) => d.date))].sort()
    const chartData = dates.map((date) => {
      const row: Record<string, any> = { label: date.slice(5) }
      for (const m of top) row[m] = 0
      if (hasOthers) row['Others'] = 0
      for (const e of data.filter((d) => d.date === date)) {
        if (topSet.has(e.model)) row[e.model] = (row[e.model] ?? 0) + e.tokens
        else if (hasOthers) row['Others'] = (row['Others'] ?? 0) + e.tokens
      }
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
    const dates = [...new Set(data.map((d) => d.date))].sort()
    const dailyData = dates.map((date) => {
      const row: Record<string, any> = { label: date.slice(5) }
      for (const m of top) row[m] = 0
      if (hasOthers) row['Others'] = 0
      for (const e of data.filter((d) => d.date === date)) {
        const v = Number(e.cost) || 0
        if (topSet.has(e.model)) row[e.model] = (row[e.model] ?? 0) + v
        else if (hasOthers) row['Others'] = (row['Others'] ?? 0) + v
      }
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
    if (dimension === 'model') filter.setModels([(row as { model: string }).model])
    else if (dimension === 'app') filter.setAppTypes([(row as { appType: AppType }).appType])
    else if (dimension === 'project') filter.setProject((row as { project: string }).project)
    nav.navigate('logs')
  }

  return (
    <div className="space-y-6">
      <PageHeader title="统计" description="按维度拆分的用量聚合 — 垂直排布，图表与表格上下分层" />

      <RangeSelector value={range} onChange={handleRangeChange} options={RANGE_OPTIONS} />

      <div className={`space-y-6 ${isPending ? 'opacity-60' : ''}`}>
        <Card title="使用量 Top 10">
          <p className="mb-3 text-xs text-neutral-500">按 Token 总量排序，取使用量前十模型（已过滤全 0 模型）</p>
          {modelQuery.isLoading && !modelQuery.data ? (
            <EmptyState title="加载中…" description="正在获取模型排行。" />
          ) : (
            <LeaderboardGrid data={filteredModels} maxItems={10} />
          )}
        </Card>

        <Card title="每日 Token 消耗量">
          <p className="mb-3 text-xs text-neutral-500">按模型堆叠的 30 天柱状，悬停查看各模型当日 Token 消耗（多柱拼合，固定最近 30 天）</p>
          {dailyModelQ.isLoading && !dailyModelQ.data ? (
            <EmptyState title="加载中…" description="正在获取每日模型分解。" />
          ) : tokenStack.chartData.length === 0 ? (
            <EmptyState title="等待真实数据" description="当前时间范围内暂无趋势。" />
          ) : (
            <div className="h-[340px] w-full min-h-[320px]">
              <ResponsiveContainer width="100%" height={340}>
                <BarChart data={tokenStack.chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#262626" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: '#737373', fontSize: 11 }} tickLine={false} axisLine={{ stroke: '#262626' }} />
                  <YAxis tick={{ fill: '#737373', fontSize: 11 }} tickLine={false} axisLine={false} width={50} tickFormatter={(v: number) => (v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v))} />
                  <Tooltip
                    contentStyle={{ background: '#171717', border: '1px solid #262626', borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: '#d4d4d4' }}
                    formatter={(value: number, name: string) => [formatTokens(value as number), name]}
                  />
                  <Legend wrapperStyle={{ fontSize: 11, color: '#d4d4d4' }} />
                  {tokenStack.models.map((m, i) => (
                    <Bar key={m} dataKey={m} stackId="tokens" fill={PALETTE[i % PALETTE.length]} radius={i === tokenStack.models.length - 1 ? [4, 4, 0, 0] : undefined} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card title="详细维度表">
          <p className="mb-3 text-xs text-neutral-500">支持五维切换与三视图（概览 / Tokens 明细 / 全部），行点击下钻至请求日志（已过滤全 0 行）</p>
          <DimensionTable range={range} onRowClick={handleDrill} />
        </Card>

        <Card title="费用占比（最近 30 天总占比）">
          <p className="mb-3 text-xs text-neutral-500">Top 5 + Others 固定 30 天，按模型聚合，饼图展示总费用占比</p>
          {dailyModelQ.isLoading && !dailyModelQ.data ? (
            <EmptyState title="加载中…" description="正在获取费用占比。" />
          ) : costStack.pieData.length === 0 ? (
            <EmptyState title="暂无占比数据" description="当前 30 天内没有可展示的费用记录。" />
          ) : (
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={costStack.pieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius="45%"
                    outerRadius="70%"
                    paddingAngle={2}
                    isAnimationActive={false}
                    labelLine={false}
                    label={({ percent }: { percent: number }) => (percent > 0.08 ? `${(percent * 100).toFixed(0)}%` : '')}
                  >
                    {costStack.pieData.map((d, i) => (
                      <Cell key={d.name} fill={PALETTE[i % PALETTE.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={{ background: '#171717', border: '1px solid #262626', borderRadius: 8, fontSize: 12 }} labelStyle={{ color: '#d4d4d4' }} formatter={(v: number) => formatUsd(String(v))} />
                  <Legend wrapperStyle={{ fontSize: 12, color: '#d4d4d4' }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card title="费用占比（每日堆叠）">
          <p className="mb-3 text-xs text-neutral-500">按日堆叠，对标市场份额 30 天（Top 5 + Others，固定 30 天，按模型费用堆叠）</p>
          {dailyModelQ.isLoading && !dailyModelQ.data ? (
            <EmptyState title="加载中…" description="正在获取每日费用堆叠。" />
          ) : costStack.dailyData.length === 0 ? (
            <EmptyState title="暂无数据" description="当前 30 天内无费用趋势。" />
          ) : (
            <div className="h-[340px] w-full min-h-[320px]">
              <ResponsiveContainer width="100%" height={340}>
                <BarChart data={costStack.dailyData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#262626" vertical={false} />
                  <XAxis dataKey="label" tick={{ fill: '#737373', fontSize: 11 }} tickLine={false} axisLine={{ stroke: '#262626' }} />
                  <YAxis tick={{ fill: '#737373', fontSize: 11 }} tickLine={false} axisLine={false} width={60} tickFormatter={(v: number) => formatUsd(String(v))} />
                  <Tooltip
                    contentStyle={{ background: '#171717', border: '1px solid #262626', borderRadius: 8, fontSize: 12 }}
                    labelStyle={{ color: '#d4d4d4' }}
                    formatter={(value: number, name: string) => [formatUsd(String(value as number)), name]}
                  />
                  <Legend wrapperStyle={{ fontSize: 11, color: '#d4d4d4' }} />
                  {costStack.models.map((m, i) => (
                    <Bar key={m} dataKey={m} stackId="cost" fill={PALETTE[i % PALETTE.length]} radius={i === costStack.models.length - 1 ? [4, 4, 0, 0] : undefined} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>

        <Card title="模型成功率排行">
          <p className="mb-3 text-xs text-neutral-500">横向点状条按成功率排序</p>
          {modelQuery.isLoading && !modelQuery.data ? (
            <EmptyState title="加载中…" description="正在获取成功率排行。" />
          ) : (
            <RetentionRanking data={filteredModels} metric="successRate" maxItems={15} />
          )}
        </Card>

        <Card title="缓存命中率排行">
          <p className="mb-3 text-xs text-neutral-500">横向点状条按缓存命中率排序（缓存读 / (输入+缓存读)）</p>
          {modelQuery.isLoading && !modelQuery.data ? (
            <EmptyState title="加载中…" description="正在获取缓存排行。" />
          ) : (
            <RetentionRanking data={filteredModels} metric="cacheHitRate" maxItems={15} />
          )}
        </Card>

        <Card title="会话成本排行榜">
          <p className="mb-3 text-xs text-neutral-500">每次会话的平均成本，对标会话成本（成本 / 会话 与 Token / 会话）</p>
          {sessionCostData.length === 0 ? (
            <EmptyState title="暂无数据" description="当前无会话成本数据。" />
          ) : (
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
                      <span className="w-16 text-right font-mono text-[11px] text-neutral-400">{formatUsd(String(row.costPerSession))}</span>
                    </div>
                    <div className="col-span-4 flex items-center gap-2">
                      <div className="relative h-1.5 flex-1 rounded-full bg-neutral-800">
                        <div className="absolute inset-y-0 left-0 rounded-full bg-white" style={{ width: `${(row.tokensPerSession / maxTokens) * 100}%` }} />
                      </div>
                      <span className="w-16 text-right font-mono text-[11px] text-neutral-400">{formatTokens(Math.round(row.tokensPerSession))}</span>
                    </div>
                  </div>
                ))
              })()}
            </div>
          )}
        </Card>

        <Card title="每百万 Token 成本">
          <p className="mb-3 text-xs text-neutral-500">每 100 万 Token 的价格，对标 Token 成本（输入 / 输出 / 已缓存分段）</p>
          {perMillionData.length === 0 ? (
            <EmptyState title="暂无数据" description="当前无 Token 数据。" />
          ) : (
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
                      <div className="col-span-2 text-right font-mono text-xs text-white">${totalPerM.toFixed(2)}</div>
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
          )}
        </Card>
      </div>
    </div>
  )
}
