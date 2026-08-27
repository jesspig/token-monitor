import type { BudgetStatus } from '../../../shared/query'
import type { SqliteDatabase } from './db'


const MICRO_PER_USD = 1_000_000

function fromMicroUsd(micro: number): string {
  return (micro / MICRO_PER_USD).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0'
}

function toDateKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const SUM_COST_MICRO =
  "COALESCE(SUM(CAST(ROUND(COALESCE(cost_usd, '0') * 1000000) AS INTEGER)), 0)"

export interface BudgetSettingsInput {
  dailyBudgetUsd?: number | null
  monthlyBudgetUsd?: number | null
}

function sumRollupCostMicro(db: SqliteDatabase, whereSql: string, params: unknown[]): number {
  const row = db
    .prepare(`SELECT ${SUM_COST_MICRO} AS cost_micro FROM usage_daily_rollups ${whereSql}`)
    .get(...params) as { cost_micro: number }
  return row.cost_micro
}

function normalizeBudget(budget: number | null | undefined): number | null {
  return budget != null && budget > 0 ? budget : null
}

function evaluateBudget(
  costMicro: number,
  budget: number | null | undefined
): { ratio: number | null; exceeded: boolean } {
  const effective = normalizeBudget(budget)
  if (effective == null) return { ratio: null, exceeded: false }
  const ratio = costMicro / (effective * MICRO_PER_USD)
  return { ratio, exceeded: ratio > 1 }
}

export function getBudgetStatus(
  db: SqliteDatabase,
  settings: BudgetSettingsInput
): BudgetStatus {
  const todayKey = toDateKey(Date.now())
  const monthPrefix = todayKey.slice(0, 7)

  const dailyCostMicro = sumRollupCostMicro(db, 'WHERE date = ?', [todayKey])
  const monthlyCostMicro = sumRollupCostMicro(db, 'WHERE date LIKE ?', [`${monthPrefix}%`])

  const dailyBudget = normalizeBudget(settings.dailyBudgetUsd)
  const monthlyBudget = normalizeBudget(settings.monthlyBudgetUsd)
  const daily = evaluateBudget(dailyCostMicro, dailyBudget)
  const monthly = evaluateBudget(monthlyCostMicro, monthlyBudget)

  return {
    dailyCostUsd: fromMicroUsd(dailyCostMicro),
    monthlyCostUsd: fromMicroUsd(monthlyCostMicro),
    dailyBudgetUsd: dailyBudget,
    monthlyBudgetUsd: monthlyBudget,
    dailyUsageRatio: daily.ratio,
    monthlyUsageRatio: monthly.ratio,
    dailyExceeded: daily.exceeded,
    monthlyExceeded: monthly.exceeded
  }
}
