import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ChevronLeft, ChevronRight, Search } from 'lucide-react'
import type { ModelsDevSyncResult } from '../../../../shared/query'
import { api } from '../api'
import { EmptyState } from '../components/EmptyState'
import { PageHeader } from '../components/PageHeader'
import { QueryState } from '../components/QueryState'
import { useToast } from '../context/ToastContext'
import { useModelPricing } from '../hooks/useModelPricing'
import { pageList } from './RequestLogsPage'

const TH = 'px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-content-muted'
const TD = 'px-3 py-2 text-sm text-content-secondary'

const PRICING_PAGE_SIZE = 15

function toErrMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export default function PricingPage(): ReactElement {
  const { data, isPending, isFetching, error, refetch } = useModelPricing()
  const qc = useQueryClient()
  const toast = useToast()

  const [syncing, setSyncing] = useState(false)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  const rows = data ?? []
  const keyword = search.trim().toLowerCase()
  const filteredRows =
    keyword === '' ? rows : rows.filter((p) => p.model_id.toLowerCase().includes(keyword))
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PRICING_PAGE_SIZE))

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages)
    }
  }, [page, totalPages])

  const pageRows = filteredRows.slice((page - 1) * PRICING_PAGE_SIZE, page * PRICING_PAGE_SIZE)

  async function handleSyncAll(): Promise<void> {
    if (syncing) return
    setSyncing(true)
    try {
      const result: ModelsDevSyncResult = await api.syncModelsDevPricing()
      await qc.invalidateQueries({ queryKey: ['model-pricing'] })
      toast.success(`价格目录已同步：获取 ${result.fetched} 条，导入 ${result.imported} 条`)
    } catch (err) {
      toast.error(`同步失败：${toErrMsg(err)}`)
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

      <div className="rounded-xl border border-line bg-surface-card/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-content-secondary">models.dev 定价同步</p>
          <button
            type="button"
            disabled={syncing}
            onClick={() => void handleSyncAll()}
            className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-40"
          >
            {syncing ? '同步中…' : '立即全量同步'}
          </button>
        </div>
      </div>

      {rows.length > 0 && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-content-muted" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
            placeholder="搜索模型名称"
            className="w-56 rounded-lg border border-line bg-surface-card py-1.5 pl-8 pr-3 text-xs text-content placeholder:text-content-muted focus:border-line-strong focus:outline-none"
          />
        </div>
      )}

      <QueryState
        isPending={isPending}
        error={error}
        refetch={refetch}
        hasData={data !== undefined}
        isEmpty={filteredRows.length === 0}
        isFetching={isFetching}
        skeletonVariant="table"
        dimWhenRefreshing
        empty={
          rows.length === 0 ? (
            <EmptyState
              title="暂无定价数据"
              description="定价表为空，点击「立即全量同步」从 models.dev 拉取模型价格。"
            />
          ) : (
            <EmptyState title="无匹配模型" description="尝试其他关键词或清除搜索。" />
          )
        }
      >
        <div className="overflow-x-auto rounded-xl border border-line bg-surface-card/60">
          <table className="w-full min-w-[880px] border-collapse">
            <thead>
              <tr className="border-b border-line bg-surface-card">
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
              {pageRows.map((p) => (
                <tr key={p.model_id} className="border-b border-line/70 hover:bg-surface-raised/40">
                  <td className={`${TD} font-mono text-xs`}>{p.model_id}</td>
                  <td className={TD}>{p.provider ?? '—'}</td>
                  <td className={`${TD} tabular-nums`}>{p.input_per_million}</td>
                  <td className={`${TD} tabular-nums`}>{p.output_per_million}</td>
                  <td className={`${TD} tabular-nums`}>{p.cache_read_per_million}</td>
                  <td className={`${TD} tabular-nums`}>{p.cache_creation_per_million}</td>
                  <td className={TD}>{p.currency}</td>
                  <td className={`${TD} tabular-nums`}>{p.cost_multiplier}</td>
                  <td className={TD}>
                    <span className="rounded border border-line-strong bg-surface-raised px-1.5 py-0.5 text-[10px] leading-none text-content-secondary">
                      {p.source ?? 'user'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-content-muted">
          <span>
            共 {filteredRows.length} 条 · 第 {page} / {totalPages} 页
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface-card px-3 py-1.5 text-xs disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> 上一页
            </button>
            {pageList(page, totalPages).map((p, i) =>
              p === 'left-gap' || p === 'right-gap' ? (
                <span key={`gap-${i}`} className="px-1 text-content-muted">
                  …
                </span>
              ) : (
                <button
                  key={p}
                  type="button"
                  disabled={p === page}
                  onClick={() => setPage(p)}
                  className={clsx(
                    'min-w-7 rounded-md border px-2 py-1 text-xs tabular-nums transition-colors',
                    p === page
                      ? 'border-line-strong bg-surface-raised text-content'
                      : 'border-line bg-surface-card text-content-muted hover:text-content'
                  )}
                >
                  {p}
                </button>
              )
            )}
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface-card px-3 py-1.5 text-xs disabled:opacity-40"
            >
              下一页 <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </QueryState>
    </div>
  )
}
