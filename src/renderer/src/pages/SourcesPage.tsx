import { useState } from 'react'
import type { ReactElement } from 'react'
import { Power } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import type { PluginStatus } from '../../../../shared/query'
import { api } from '../api'
import { EmptyState } from '../components/EmptyState'
import { PageHeader } from '../components/PageHeader'
import { QueryState } from '../components/QueryState'
import { useToast } from '../context/ToastContext'
import { usePlugins } from '../hooks/usePlugins'
import { APP_META, formatDateTime } from '../lib/format'

export default function SourcesPage(): ReactElement {
  const { data, isPending, isFetching, error, refetch } = usePlugins()
  const toast = useToast()
  const qc = useQueryClient()
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const plugins = data ?? []

  async function toggle(p: PluginStatus): Promise<void> {
    if (togglingId != null) return
    setTogglingId(p.id)
    try {
      await api.setPluginEnabled(p.id, !p.enabled)
      await qc.invalidateQueries({ queryKey: ['plugins'] })
      toast.success(`${p.enabled ? '已停用' : '已启用'}：${p.name}`)
    } catch {
      toast.error('操作失败，请重试')
    } finally {
      setTogglingId(null)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="监控源"
        description="各 CLI 监控插件的安装检测、同步状态与启停控制"
      />

      <QueryState
        isPending={isPending}
        error={error}
        refetch={refetch}
        hasData={data != null}
        isEmpty={plugins.length === 0}
        isFetching={isFetching}
        skeletonVariant="cards"
        empty={
          <EmptyState
            title="未检测到监控源"
            description="未检测到任何监控源，请确认已安装对应 AI CLI 并产生过会话记录；安装完成后重启应用即可自动识别。"
          />
        }
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {plugins.map((p) => {
            const isToggling = togglingId === p.id
            return (
              <div
                key={p.id}
                className="rounded-xl border border-line bg-surface-card/60 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${APP_META[p.id].badge}`}
                    >
                      {APP_META[p.id].label}
                    </span>
                    <p className="text-sm font-medium text-neutral-200">{p.name}</p>
                  </div>
                  <button
                    type="button"
                    disabled={togglingId != null}
                    onClick={() => void toggle(p)}
                    className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                      p.enabled
                        ? 'border-success-bright/40 bg-success-bright/10 text-emerald-300 hover:bg-success-bright/20'
                        : 'border-line-strong bg-surface-raised text-neutral-400 hover:bg-line-strong'
                    }`}
                  >
                    <Power className="h-3 w-3" />
                    {isToggling ? '处理中…' : p.enabled ? '已启用' : '已停用'}
                  </button>
                </div>

                <dl className="mt-3 space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <dt className="text-content-muted">CLI 版本</dt>
                    <dd className="font-mono text-content-secondary">{p.cliVersion ?? '未知'}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-content-muted">状态</dt>
                    <dd>
                      {p.available ? (
                        <span className="text-success">已检测</span>
                      ) : (
                        <span className="text-warning">未安装 / 不可用</span>
                      )}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-content-muted">最近同步</dt>
                    <dd className="tabular-nums text-content-secondary">
                      {p.lastSyncAt ? formatDateTime(p.lastSyncAt) : '从未'}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-content-muted">解析错误</dt>
                    <dd className={p.errorCount > 0 ? 'text-danger' : 'tabular-nums text-content-secondary'}>
                      {p.errorCount}
                    </dd>
                  </div>
                  {p.sessionDir && (
                    <div className="flex justify-between">
                      <dt className="text-content-muted">会话目录</dt>
                      <dd className="max-w-[60%] truncate font-mono text-neutral-400" title={p.sessionDir}>
                        {p.sessionDir}
                      </dd>
                    </div>
                  )}
                  {p.reason && (
                    <div className="flex justify-between">
                      <dt className="text-content-muted">原因</dt>
                      <dd className="max-w-[60%] truncate text-amber-300" title={p.reason}>
                        {p.reason}
                      </dd>
                    </div>
                  )}
                </dl>
              </div>
            )
          })}
        </div>
      </QueryState>
    </div>
  )
}
