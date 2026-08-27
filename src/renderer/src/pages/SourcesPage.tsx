import type { ReactElement } from 'react'
import { Power } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import type { PluginStatus } from '../../../../shared/query'
import { api } from '../api'
import { EmptyState } from '../components/EmptyState'
import { PageHeader } from '../components/PageHeader'
import { usePlugins } from '../hooks/usePlugins'
import { APP_META, formatDateTime } from '../lib/format'

export default function SourcesPage(): ReactElement {
  const { data, isLoading } = usePlugins()
  const qc = useQueryClient()
  const plugins = data ?? []

  async function toggle(p: PluginStatus): Promise<void> {
    await api.setPluginEnabled(p.id, !p.enabled)
    await qc.invalidateQueries({ queryKey: ['plugins'] })
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="监控源"
        description="各 CLI 监控插件的安装检测、同步状态与启停控制"
      />

      {isLoading && !data ? (
        <EmptyState title="加载中…" description="正在读取监控插件状态。" />
      ) : plugins.length === 0 ? (
        <EmptyState
          title="等待真实数据"
          description="暂无监控插件状态，接入真实 IPC 后端后展示。"
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {plugins.map((p) => (
            <div
              key={p.id}
              className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4"
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
                  onClick={() => void toggle(p)}
                  className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                    p.enabled
                      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
                      : 'border-neutral-700 bg-neutral-800 text-neutral-400 hover:bg-neutral-700'
                  }`}
                >
                  <Power className="h-3 w-3" />
                  {p.enabled ? '已启用' : '已停用'}
                </button>
              </div>

              <dl className="mt-3 space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <dt className="text-neutral-500">CLI 版本</dt>
                  <dd className="font-mono text-neutral-300">{p.cliVersion ?? '未知'}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-neutral-500">状态</dt>
                  <dd>
                    {p.available ? (
                      <span className="text-emerald-400">已检测</span>
                    ) : (
                      <span className="text-amber-400">未安装 / 不可用</span>
                    )}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-neutral-500">最近同步</dt>
                  <dd className="tabular-nums text-neutral-300">
                    {p.lastSyncAt ? formatDateTime(p.lastSyncAt) : '从未'}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-neutral-500">解析错误</dt>
                  <dd className={p.errorCount > 0 ? 'text-red-400' : 'tabular-nums text-neutral-300'}>
                    {p.errorCount}
                  </dd>
                </div>
                {p.sessionDir && (
                  <div className="flex justify-between">
                    <dt className="text-neutral-500">会话目录</dt>
                    <dd className="max-w-[60%] truncate font-mono text-neutral-400" title={p.sessionDir}>
                      {p.sessionDir}
                    </dd>
                  </div>
                )}
                {p.reason && (
                  <div className="flex justify-between">
                    <dt className="text-neutral-500">原因</dt>
                    <dd className="max-w-[60%] truncate text-amber-300" title={p.reason}>
                      {p.reason}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
