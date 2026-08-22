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

/**
 * 预算输入解析：空串 → null（不启用）；非法（非数值/负数）返回错误信息；合法返回数值。
 * 0 视为合法值，语义与 null 一致（不启用告警）。
 */
function parseBudgetInput(raw: string): { value: number | null; error: string | null } {
  const text = raw.trim()
  if (text === '') return { value: null, error: null }
  const n = Number(text)
  if (!Number.isFinite(n) || n < 0) return { value: null, error: '需为非负数值' }
  return { value: n, error: null }
}

/** 设置页：同步间隔 / 数据保留策略 / 数据目录 / 预算上限 */
export default function SettingsPage(): ReactElement {
  const { data, isLoading } = useSettings()
  const qc = useQueryClient()

  const [syncMin, setSyncMin] = useState('')
  const [retentionDays, setRetentionDays] = useState('')
  const [dataDir, setDataDir] = useState('')
  const [autoSyncPricing, setAutoSyncPricing] = useState(false)
  const [dailyBudget, setDailyBudget] = useState('')
  const [monthlyBudget, setMonthlyBudget] = useState('')
  const [budgetError, setBudgetError] = useState('')

  useEffect(() => {
    if (!data) return
    setSyncMin(String(data.syncIntervalMs / 60_000))
    setRetentionDays(String(data.retentionDays))
    setDataDir(data.dataDir)
    setAutoSyncPricing(data.autoSyncPricing === true)
    setDailyBudget(data.dailyBudgetUsd != null ? String(data.dailyBudgetUsd) : '')
    setMonthlyBudget(data.monthlyBudgetUsd != null ? String(data.monthlyBudgetUsd) : '')
  }, [data])

  async function handleSave(): Promise<void> {
    const daily = parseBudgetInput(dailyBudget)
    const monthly = parseBudgetInput(monthlyBudget)
    const error = daily.error ?? monthly.error
    if (error) {
      setBudgetError(`预算上限${error}`)
      return
    }
    setBudgetError('')
    await api.updateSettings({
      syncIntervalMs: (Math.max(1, Number(syncMin) || 5) * 60_000),
      retentionDays: Math.max(1, Number(retentionDays) || 30),
      dataDir: dataDir.trim() || data?.dataDir || '',
      autoSyncPricing,
      dailyBudgetUsd: daily.value,
      monthlyBudgetUsd: monthly.value
    })
    await qc.invalidateQueries({ queryKey: ['settings'] })
  }

  return (
    <div className="space-y-6">
      <PageHeader title="设置" description="同步间隔、数据保留策略、数据目录与预算上限" />

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
            <div>
              <label className={LABEL_CLS} htmlFor="daily-budget">
                日预算上限（USD）
              </label>
              <input
                id="daily-budget"
                type="number"
                min={0}
                step="any"
                value={dailyBudget}
                onChange={(e) => {
                  setDailyBudget(e.target.value)
                  setBudgetError('')
                }}
                placeholder="留空表示不启用"
                className={INPUT_CLS}
              />
            </div>
            <div>
              <label className={LABEL_CLS} htmlFor="monthly-budget">
                月预算上限（USD）
              </label>
              <input
                id="monthly-budget"
                type="number"
                min={0}
                step="any"
                value={monthlyBudget}
                onChange={(e) => {
                  setMonthlyBudget(e.target.value)
                  setBudgetError('')
                }}
                placeholder="留空表示不启用"
                className={INPUT_CLS}
              />
            </div>
            <div className="md:col-span-2">
              <label className={LABEL_CLS} htmlFor="auto-sync-pricing">
                自动同步定价（models.dev）
              </label>
              <label
                htmlFor="auto-sync-pricing"
                className="flex items-center gap-2 text-sm text-neutral-300"
              >
                <input
                  id="auto-sync-pricing"
                  type="checkbox"
                  checked={autoSyncPricing}
                  onChange={(e) => setAutoSyncPricing(e.target.checked)}
                  className="h-4 w-4 rounded border-neutral-700 bg-neutral-900 accent-emerald-600"
                />
                启用
              </label>
              <p className="mt-1 text-xs text-neutral-500">
                每日自动从 models.dev 同步缺失与更新的定价；手动修改过的价格不会被覆盖。
              </p>
            </div>
          </div>
          <div className="mt-4 flex items-center justify-end gap-3">
            {budgetError && <p className="text-sm text-red-400">{budgetError}</p>}
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
