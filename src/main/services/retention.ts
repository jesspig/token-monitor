import type { SqliteDatabase } from './db'

export function cleanupOldRecords(db: SqliteDatabase, retentionDays: number): number {
  if (retentionDays <= 0) return 0
  const cutoff = Date.now() - retentionDays * 86_400_000
  const result = db.prepare('DELETE FROM usage_records WHERE created_at < ?').run(cutoff)
  return result.changes
}
