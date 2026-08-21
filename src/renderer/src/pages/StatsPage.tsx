import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import clsx from 'clsx'
import { EmptyState } from '../components/EmptyState'
import { PageHeader } from '../components/PageHeader'
import { RangeSelector } from '../components/RangeSelector'
import { useStatsByApp, useStatsByModel } from '../hooks/useStats'
import { APP_META, formatDuration, formatPercent, formatTokens, formatUsd } from '../lib/format'
import { RANGE_OPTIONS, rangeToFilters, type RangeKey } from '../lib/range'

type TabKey = 'model' | 'app'

const TH = 'px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-neutral-500'
const TD = 'px-3 py-2 text-sm text-neutral-300'

/** 统计页：按模型 / 按应用聚合表 */
export default function StatsPage(): ReactElement {
  const [range, setRange] = useState<RangeKey>('30d')
  const [tab, setTab] = useState<TabKey>('model')
  const filters = useMemo(() => rangeToFilters(range), [range])

  const modelQuery = useStatsByModel(filters)
  const appQuery = useStatsByApp(filters)

  const models = modelQuery.data ?? []
  const apps = appQuery.data ?? []
  const isEmpty = models.length === 0 && apps.length === 0
  const isLoading =
    (modelQuery.isLoading && !modelQuery.data) || (appQuery.isLoading && !appQuery.data)

  return (
    <div className="space-y-6">
      <PageHeader
        title="统计"
        description="按模型 / 按应用（监控对象）的用量聚合"
        action={<RangeSelector value={range} onChange={setRange} options={RANGE_OPTIONS} />}
      />

      <div className="inline-flex rounded-lg border border-neutral-800 bg-neutral-900 p-0.5">
        {(
          [
            { key: 'model', label: '按模型' },
            { key: 'app', label: '按应用' }
          ] as Array<{ key: TabKey; label: string }>
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={clsx(
              'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              tab === t.key
                ? 'bg-neutral-700 text-white'
                : 'text-neutral-400 hover:text-neutral-200'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <EmptyState title="加载中…" description="正在获取统计数据。" />
      ) : isEmpty ? (
        <EmptyState
          title="等待真实数据"
          description="当前时间范围内暂无统计数据，接入真实 IPC 后端后展示。"
        />
      ) : tab === 'model' ? (
        <div className="overflow-x-auto rounded-xl border border-neutral-800 bg-neutral-900/60">
          <table className="w-full min-w-[880px] border-collapse">
            <thead>
              <tr className="border-b border-neutral-800 bg-neutral-900">
                <th className={TH}>模型</th>
                <th className={TH}>应用</th>
                <th className={TH}>请求</th>
                <th className={TH}>输入</th>
                <th className={TH}>输出</th>
                <th className={TH}>缓存读</th>
                <th className={TH}>缓存创建</th>
                <th className={TH}>费用</th>
                <th className={TH}>平均耗时</th>
                <th className={TH}>成功率</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.model} className="border-b border-neutral-800/70 hover:bg-neutral-800/40">
                  <td className={`${TD} font-mono text-xs`}>{m.model}</td>
                  <td className={TD}>
                    <span
                      className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${APP_META[m.appType].badge}`}
                    >
                      {APP_META[m.appType].label}
                    </span>
                  </td>
                  <td className={`${TD} tabular-nums`}>{m.requestCount}</td>
                  <td className={`${TD} tabular-nums`}>{formatTokens(m.inputTokens)}</td>
                  <td className={`${TD} tabular-nums`}>{formatTokens(m.outputTokens)}</td>
                  <td className={`${TD} tabular-nums`}>{formatTokens(m.cacheReadTokens)}</td>
                  <td className={`${TD} tabular-nums`}>{formatTokens(m.cacheCreationTokens)}</td>
                  <td className={`${TD} tabular-nums`}>{formatUsd(m.costUsd)}</td>
                  <td className={`${TD} tabular-nums`}>{formatDuration(m.avgLatencyMs)}</td>
                  <td className={`${TD} tabular-nums`}>{formatPercent(m.successRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-neutral-800 bg-neutral-900/60">
          <table className="w-full min-w-[720px] border-collapse">
            <thead>
              <tr className="border-b border-neutral-800 bg-neutral-900">
                <th className={TH}>应用</th>
                <th className={TH}>请求</th>
                <th className={TH}>输入</th>
                <th className={TH}>输出</th>
                <th className={TH}>缓存读</th>
                <th className={TH}>缓存创建</th>
                <th className={TH}>费用</th>
                <th className={TH}>成功率</th>
              </tr>
            </thead>
            <tbody>
              {apps.map((a) => (
                <tr key={a.appType} className="border-b border-neutral-800/70 hover:bg-neutral-800/40">
                  <td className={TD}>
                    <span
                      className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${APP_META[a.appType].badge}`}
                    >
                      {APP_META[a.appType].label}
                    </span>
                  </td>
                  <td className={`${TD} tabular-nums`}>{a.requestCount}</td>
                  <td className={`${TD} tabular-nums`}>{formatTokens(a.inputTokens)}</td>
                  <td className={`${TD} tabular-nums`}>{formatTokens(a.outputTokens)}</td>
                  <td className={`${TD} tabular-nums`}>{formatTokens(a.cacheReadTokens)}</td>
                  <td className={`${TD} tabular-nums`}>{formatTokens(a.cacheCreationTokens)}</td>
                  <td className={`${TD} tabular-nums`}>{formatUsd(a.costUsd)}</td>
                  <td className={`${TD} tabular-nums`}>{formatPercent(a.successRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
