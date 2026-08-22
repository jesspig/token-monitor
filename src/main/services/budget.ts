import type { BudgetStatus } from '../../../shared/query'
import type { SqliteDatabase } from './db'

/**
 * 预算限额告警（docs/concepts/architecture.md → 主进程服务）：
 * 全局维度（所有 CLI 合计）计算今日/本月费用与预算上限占比，只读 usage_daily_rollups。
 * 费用口径与 usageQuery.ts 一致：cost_usd(TEXT) 统一转整数微美元累加后格式化，
 * 避免浮点误差；日期按本地时区归桶（与日聚合写入方 storage.recordUsage 同口径）。
 */

/** 微美元：费用以字符串存储避免浮点误差，聚合时统一转成整数微美元累加 */
const MICRO_PER_USD = 1_000_000

/** 微美元 → 字符串（去掉尾随 0 与小数点，0 返回 '0'），与 usageQuery.fromMicroUsd 同款 */
function fromMicroUsd(micro: number): string {
  return (micro / MICRO_PER_USD).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0'
}

/** epoch ms → YYYY-MM-DD（本地时区）；与 usageQuery.toDateKey 同口径（rollup 按本地日归桶） */
function toDateKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** SQL 片段：cost_usd(TEXT) → 整数微美元求和（与 usageQuery.SUM_COST_MICRO 同款，外层 COALESCE 归零） */
const SUM_COST_MICRO =
  "COALESCE(SUM(CAST(ROUND(COALESCE(cost_usd, '0') * 1000000) AS INTEGER)), 0)"

/** getBudgetStatus 的预算入参（AppSettings 中与本服务相关的子集） */
export interface BudgetSettingsInput {
  dailyBudgetUsd?: number | null
  monthlyBudgetUsd?: number | null
}

/** 对 usage_daily_rollups 按给定 WHERE 条件求费用微美元合计 */
function sumRollupCostMicro(db: SqliteDatabase, whereSql: string, params: unknown[]): number {
  const row = db
    .prepare(`SELECT ${SUM_COST_MICRO} AS cost_micro FROM usage_daily_rollups ${whereSql}`)
    .get(...params) as { cost_micro: number }
  return row.cost_micro
}

/** 预算归一：null/undefined/<=0 一律视为「未设置」，DTO 与判定共用此口径 */
function normalizeBudget(budget: number | null | undefined): number | null {
  return budget != null && budget > 0 ? budget : null
}

/**
 * 占比与超限判定：budget 为 null/undefined 或 <=0 视为未设置 → ratio=null、exceeded=false
 * （未设置=不告警）；否则 ratio = cost / budget，费用严格大于上限才判超限。
 */
function evaluateBudget(
  costMicro: number,
  budget: number | null | undefined
): { ratio: number | null; exceeded: boolean } {
  const effective = normalizeBudget(budget)
  if (effective == null) return { ratio: null, exceeded: false }
  const ratio = costMicro / (effective * MICRO_PER_USD)
  return { ratio, exceeded: ratio > 1 }
}

/**
 * 计算全局预算状态：今日 = 本地时区当天 rollup 行 cost 求和；
 * 本月 = 本地当月自然月 rollup 行求和（date 前缀 YYYY-MM 匹配）。
 * 只读查询，不修改任何数据；失败向上抛由调用方（host → IPC）兜底。
 */
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
