import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { Card } from '../components/Card'
import { EmptyState } from '../components/EmptyState'
import { PageHeader } from '../components/PageHeader'
import { useSettings } from '../hooks/useSettings'

const INPUT_CLS =
  'w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none'
const LABEL_CLS = 'mb-1 block text-xs font-medium text-neutral-400'

/** 设置页：同步间隔 / 数据保留策略 / 数据目录 */
export default function SettingsPage(): ReactElement {
  const { data, isLoading } = useSettings()
  const qc = useQueryClient()

  const [syncMin, setSyncMin] = useState('')
  const [retentionDays, setRetentionDays] = useState('')
  const [dataDir, setDataDir] = useState('')

  useEffect(() => {
    if (!data) return
    setSyncMin(String(data.syncIntervalMs / 60_000))
    setRetentionDays(String(data.retentionDays))
    setDataDir(data.dataDir)
  }, [data])

  async function handleSave(): Promise<void> {
    await api.updateSettings({
      syncIntervalMs: (Math.max(1, Number(syncMin) || 5) * 60_000),
      retentionDays: Math.max(1, Number(retentionDays) || 30),
      dataDir: dataDir.trim() || data?.dataDir || ''
    })
    await qc.invalidateQueries({ queryKey: ['settings'] })
  }

  return (
    <div className="space-y-6">
      <PageHeader title="设置" description="同步间隔、数据保留策略与数据目录" />

      {isLoading && !data ? (
        <EmptyState title="加载中…" description="正在读取设置。" />
      ) : (
        <Card title="常规设置">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className={LABEL_CLS} htmlFor="sync-interval">
                兜底扫描间隔（分钟）
              </label>
              <input
                id="sync-interval"
                type="number"
                min={1}
                value={syncMin}
                onChange={(e) => setSyncMin(e.target.value)}
                className={INPUT_CLS}
              />
            </div>
            <div>
              <label className={LABEL_CLS} htmlFor="retention">
                明细保留天数
              </label>
              <input
                id="retention"
                type="number"
                min={1}
                value={retentionDays}
                onChange={(e) => setRetentionDays(e.target.value)}
                className={INPUT_CLS}
              />
            </div>
            <div className="md:col-span-2">
              <label className={LABEL_CLS} htmlFor="data-dir">
                数据目录
              </label>
              <input
                id="data-dir"
                value={dataDir}
                onChange={(e) => setDataDir(e.target.value)}
                placeholder="~/.config/token-monitor"
                className={INPUT_CLS}
              />
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => void handleSave()}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
            >
              保存设置
            </button>
          </div>
        </Card>
      )}
    </div>
  )
}
