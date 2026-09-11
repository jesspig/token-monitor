import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { AppSettings } from '../../../../shared/query'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { Card } from '../components/Card'
import { QueryState } from '../components/QueryState'
import { Toggle } from '../components/Toggle'
import { PageHeader } from '../components/PageHeader'
import { useToast } from '../context/ToastContext'
import { useSettings } from '../hooks/useSettings'
import { setCachedSettings } from '../lib/settings-cache'

const INPUT_CLS =
  'w-full rounded-lg border border-line bg-surface-card px-3 py-2 text-sm text-content-secondary placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none'
const LABEL_CLS = 'mb-1 block text-xs font-medium text-neutral-400'

function parseBudgetInput(raw: string): { value: number | null; error: string | null } {
  const text = raw.trim()
  if (text === '') return { value: null, error: null }
  const n = Number(text)
  if (!Number.isFinite(n) || n < 0) return { value: null, error: '需为非负数值' }
  return { value: n, error: null }
}

export function parseTraeTrajectoryRootsInput(raw: string): string[] {
  const roots: string[] = []
  const seen = new Set<string>()
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    roots.push(trimmed)
  }
  return roots
}

interface SettingsPayloadInput {
  syncMin: string
  statsRefreshSec: string
  retentionDays: string
  pricingSyncMin: string
  dataDir: string
  currentDataDir: string
  traeTrajectoryRoots: string
  dailyBudgetUsd: number | null
  monthlyBudgetUsd: number | null
  closeToTray: boolean
}

export function buildSettingsPayload(input: SettingsPayloadInput): AppSettings {
  return {
    syncIntervalMs: Math.max(1, Number(input.syncMin) || 5) * 60_000,
    statsRefreshIntervalMs: Math.max(1, Number(input.statsRefreshSec) || 30) * 1000,
    retentionDays: Math.max(1, Number(input.retentionDays) || 30),
    pricingSyncIntervalMs: Math.max(1, Number(input.pricingSyncMin) || 5) * 60_000,
    dataDir: input.dataDir.trim() || input.currentDataDir,
    traeTrajectoryRoots: parseTraeTrajectoryRootsInput(input.traeTrajectoryRoots),
    dailyBudgetUsd: input.dailyBudgetUsd,
    monthlyBudgetUsd: input.monthlyBudgetUsd,
    closeToTray: input.closeToTray
  }
}

export default function SettingsPage(): ReactElement {
  const { data, isPending, isFetching, error, refetch } = useSettings()
  const toast = useToast()
  const qc = useQueryClient()

  const [syncMin, setSyncMin] = useState('')
  const [statsRefreshSec, setStatsRefreshSec] = useState('')
  const [retentionDays, setRetentionDays] = useState('')
  const [pricingSyncMin, setPricingSyncMin] = useState('')
  const [dataDir, setDataDir] = useState('')
  const [traeTrajectoryRoots, setTraeTrajectoryRoots] = useState('')
  const [dailyBudget, setDailyBudget] = useState('')
  const [monthlyBudget, setMonthlyBudget] = useState('')
  const [budgetError, setBudgetError] = useState('')
  const [traeRootsError, setTraeRootsError] = useState('')
  const [closeToTray, setCloseToTray] = useState(false)
  const [saving, setSaving] = useState(false)

  const hydratedRef = useRef(false)
  useEffect(() => {
    if (!data || hydratedRef.current) return
    hydratedRef.current = true
    setSyncMin(String(data.syncIntervalMs / 60_000))
    setStatsRefreshSec(String((data.statsRefreshIntervalMs ?? 30_000) / 1000))
    setRetentionDays(String(data.retentionDays))
    setPricingSyncMin(String((data.pricingSyncIntervalMs ?? 300_000) / 60_000))
    setDataDir(data.dataDir)
    setTraeTrajectoryRoots((data.traeTrajectoryRoots ?? []).join('\n'))
    setDailyBudget(data.dailyBudgetUsd != null ? String(data.dailyBudgetUsd) : '')
    setMonthlyBudget(data.monthlyBudgetUsd != null ? String(data.monthlyBudgetUsd) : '')
    setCloseToTray(data.closeToTray ?? true)
  }, [data])

  async function handleSave(): Promise<void> {
    const daily = parseBudgetInput(dailyBudget)
    const monthly = parseBudgetInput(monthlyBudget)
    const budgetIssue = daily.error ?? monthly.error
    if (budgetIssue) {
      setBudgetError(`预算上限${budgetIssue}`)
      return
    }
    setBudgetError('')
    const payload = buildSettingsPayload({
      syncMin,
      statsRefreshSec,
      retentionDays,
      pricingSyncMin,
      dataDir,
      currentDataDir: data?.dataDir ?? '',
      traeTrajectoryRoots,
      dailyBudgetUsd: daily.value,
      monthlyBudgetUsd: monthly.value,
      closeToTray
    })
    setTraeRootsError('')
    setSaving(true)
    try {
      await api.updateSettings(payload)
      setCachedSettings(payload)
      await qc.invalidateQueries({ queryKey: ['settings'] })
      toast.success('设置已保存')
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : '保存失败，请重试'
      setTraeRootsError(message)
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="设置" description="同步间隔、数据保留策略、监控目录与预算上限" />

      <QueryState
        isPending={isPending}
        error={error}
        refetch={refetch}
        hasData={data != null}
        isFetching={isFetching}
        loadingFallback={
          <Card title="常规设置">
            <div className="animate-pulse">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="h-14 rounded-lg bg-line" />
                <div className="h-14 rounded-lg bg-line" />
                <div className="h-14 rounded-lg bg-line" />
                <div className="h-14 rounded-lg bg-line" />
                <div className="h-14 rounded-lg bg-line" />
                <div className="h-14 rounded-lg bg-line" />
              </div>
              <div className="mt-4 flex justify-end">
                <div className="h-9 w-24 rounded-lg bg-line" />
              </div>
            </div>
          </Card>
        }
      >
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
              <label className={LABEL_CLS} htmlFor="stats-refresh-interval">
                统计自动刷新间隔（秒）
              </label>
              <input
                id="stats-refresh-interval"
                type="number"
                min={1}
                value={statsRefreshSec}
                onChange={(e) => setStatsRefreshSec(e.target.value)}
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
            <div>
              <label className={LABEL_CLS} htmlFor="pricing-sync-interval">
                价格同步间隔（分钟）
              </label>
              <input
                id="pricing-sync-interval"
                type="number"
                min={1}
                value={pricingSyncMin}
                onChange={(e) => setPricingSyncMin(e.target.value)}
                className={INPUT_CLS}
              />
            </div>
            <div>
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
            <div className="md:col-span-2">
              <label className={LABEL_CLS} htmlFor="trae-trajectory-roots">
                Trae Agent trajectory 根目录
              </label>
              <textarea
                id="trae-trajectory-roots"
                rows={4}
                value={traeTrajectoryRoots}
                onChange={(e) => {
                  setTraeTrajectoryRoots(e.target.value)
                  setTraeRootsError('')
                }}
                placeholder="每行一个 trajectories 目录的绝对路径；留空时兼容 TRAE_TRAJECTORY_DIR 和旧默认候选"
                aria-describedby="trae-trajectory-roots-help"
                aria-invalid={traeRootsError !== ''}
                className={INPUT_CLS}
              />
              <p id="trae-trajectory-roots-help" className="mt-1 text-xs text-neutral-500">
                保存时会去除空行和重复项；路径必须存在且必须是目录。
              </p>
              {traeRootsError && <p className="mt-1 text-sm text-red-400">{traeRootsError}</p>}
            </div>
            <div className="md:col-span-2 flex items-center">
              <Toggle
                id="close-to-tray"
                checked={closeToTray}
                onChange={setCloseToTray}
                label="关闭窗口时最小化到系统托盘（后台常驻）"
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
          </div>
          <div className="mt-4 flex items-center justify-end gap-3">
            {budgetError && <p className="text-sm text-red-400">{budgetError}</p>}
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSave()}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-success-bright disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? '保存中…' : '保存设置'}
            </button>
          </div>
        </Card>
      </QueryState>
    </div>
  )
}
