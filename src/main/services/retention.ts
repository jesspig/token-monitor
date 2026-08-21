import type { SqliteDatabase } from './db'

/**
 * 数据保留清理（docs/concepts/roadmap.md → 待研究点 4「数据保留」）。
 * 删除超过保留天数的 usage_records 明细，返回删除条数；
 * usage_daily_rollups 不清理 —— 历史趋势数据（日聚合）需要长期保留。
 * 由宿主（后续定时/手动）触发，更新 retentionDays 本身不自动清理。
 */
export function cleanupOldRecords(db: SqliteDatabase, retentionDays: number): number {
  // 保留天数非正数视为不清理，避免误删全部明细
  if (retentionDays <= 0) return 0
  const cutoff = Date.now() - retentionDays * 86_400_000
  const result = db.prepare('DELETE FROM usage_records WHERE created_at < ?').run(cutoff)
  return result.changes
}
