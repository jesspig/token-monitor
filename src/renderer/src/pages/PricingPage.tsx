import { useState } from 'react'
import type { ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ModelsDevSyncResult } from '../../../../shared/query'
import { api } from '../api'
import { EmptyState } from '../components/EmptyState'
import { PageHeader } from '../components/PageHeader'
import { useModelPricing } from '../hooks/useModelPricing'

const TH = 'px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-neutral-500'
const TD = 'px-3 py-2 text-sm text-neutral-300'

function toErrMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 定价页：模型价格列表（只读，数据由 models.dev 自动同步维护）+ 手动全量同步 */
export default function PricingPage(): ReactElement {
  const { data, isLoading } = useModelPricing()
  const qc = useQueryClient()

  const [syncing, setSyncing] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const rows = data ?? []

  async function handleSyncAll(): Promise<void> {
    if (syncing) return
    setSyncing(true)
    setNotice(null)
    try {
      const result: ModelsDevSyncResult = await api.syncModelsDevPricing()
      await qc.invalidateQueries({ queryKey: ['model-pricing'] })
      setNotice({
        kind: 'ok',
        text: `全量同步完成：获取 ${result.fetched} 条，导入 ${result.imported} 条，跳过 ${result.skipped} 条。`
      })
    } catch (err) {
      setNotice({ kind: 'err', text: `全量同步失败：${toErrMsg(err)}` })
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="定价配置"
        description="每百万 token 价格（默认 USD），定价数据以 models.dev 自动同步为准"
      />

      <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-neutral-300">models.dev 定价同步</p>
          <button
            type="button"
            disabled={syncing}
            onClick={() => void handleSyncAll()}
            className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-40"
          >
            {syncing ? '同步中…' : '立即全量同步'}
          </button>
        </div>
        {notice !== null && (
          <p
            className={`mt-2 text-xs ${notice.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}
          >
            {notice.text}
          </p>
        )}
      </div>

      {isLoading && !data ? (
        <EmptyState title="加载中…" description="正在获取定价表。" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="暂无定价数据"
          description="定价表为空，点击「立即全量同步」从 models.dev 拉取模型价格。"
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-neutral-800 bg-neutral-900/60">
          <table className="w-full min-w-[880px] border-collapse">
            <thead>
              <tr className="border-b border-neutral-800 bg-neutral-900">
                <th className={TH}>模型 ID</th>
                <th className={TH}>提供方</th>
                <th className={TH}>输入 $/M</th>
                <th className={TH}>输出 $/M</th>
                <th className={TH}>缓存读 $/M</th>
                <th className={TH}>缓存创建 $/M</th>
                <th className={TH}>币种</th>
                <th className={TH}>系数</th>
                <th className={TH}>来源</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.model_id} className="border-b border-neutral-800/70 hover:bg-neutral-800/40">
                  <td className={`${TD} font-mono text-xs`}>{p.model_id}</td>
                  <td className={TD}>{p.provider ?? '—'}</td>
                  <td className={`${TD} tabular-nums`}>{p.input_per_million}</td>
                  <td className={`${TD} tabular-nums`}>{p.output_per_million}</td>
                  <td className={`${TD} tabular-nums`}>{p.cache_read_per_million}</td>
                  <td className={`${TD} tabular-nums`}>{p.cache_creation_per_million}</td>
                  <td className={TD}>{p.currency}</td>
                  <td className={`${TD} tabular-nums`}>{p.cost_multiplier}</td>
                  <td className={TD}>
                    <span className="rounded border border-neutral-700 bg-neutral-800 px-1.5 py-0.5 text-[10px] leading-none text-neutral-300">
                      {p.source ?? 'user'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
