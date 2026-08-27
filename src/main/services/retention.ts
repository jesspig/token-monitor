import type { SqliteDatabase } from './db'

/**
 * 数据保留清理（docs/concepts/roadmap.md → 待研究点 4「数据保留」）。
 * 删除超过保留天数的 usage_records 明细，返回删除条数；
 * usage_daily_rollups 不清理 —— 历史趋势数据（日聚合）需要长期保留。
 * 由宿主（后续定时/手动）触发，更新 retentionDays 本身不自动清理。
 * 性能：`DELETE WHERE created_at < ?` 复用已有索引 idx_usage_records_created_at
 *       的范围扫描，无全表扫描；保留期 90 天稳态下单次删除量可控。
 */
export function cleanupOldRecords(db: SqliteDatabase, retentionDays: number): number {
  // 保留天数非正数视为不清理，避免误删全部明细
  if (retentionDays <= 0) return 0
  const cutoff = Date.now() - retentionDays * 86_400_000
  // 复用 idx_usage_records_created_at 索引的范围删除，避免全表扫描
  const result = db.prepare('DELETE FROM usage_records WHERE created_at < ?').run(cutoff)
  return result.changes
}
