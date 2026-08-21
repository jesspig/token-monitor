import { describe, it, expect } from 'vitest'
import type { UsageRecord } from '../../../shared/dto'
import { createDatabase, migrate, type SqliteDatabase } from './db'
import { cleanupOldRecords } from './retention'
import { SqliteStorage } from './storage'

const DAY_MS = 86_400_000

/** 构造一条可复用的测试用量记录（默认 1 天前） */
function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    appType: 'claude',
    model: 'claude-sonnet-4',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 20,
    cacheCreationTokens: 10,
    inputSemantics: 1,
    costUsd: '0.001',
    currency: 'USD',
    latencyMs: 800,
    status: 'success',
    createdAt: Date.now() - DAY_MS,
    source: { filePath: '/sessions/claude.jsonl', line: 1 },
    ...overrides
  }
}

function count(db: SqliteDatabase, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
}

describe('数据保留清理（retention）', () => {
  it('cleanupOldRecords 只删除超过保留天数的明细，日聚合不受影响', async () => {
    const db = createDatabase(':memory:')
    migrate(db)
    const storage = new SqliteStorage(db)

    const now = Date.now()
    await storage.recordUsage([
      makeRecord({ createdAt: now - DAY_MS, source: { filePath: '/s/recent-1.jsonl', line: 1 } }),
      makeRecord({ createdAt: now - DAY_MS, source: { filePath: '/s/recent-2.jsonl', line: 1 } }),
      makeRecord({ createdAt: now - 100 * DAY_MS, source: { filePath: '/s/old-1.jsonl', line: 1 } }),
      makeRecord({ createdAt: now - 100 * DAY_MS, source: { filePath: '/s/old-2.jsonl', line: 1 } })
    ])
    // 4 条明细 + 2 个日聚合桶（1 天前 / 100 天前）
    expect(count(db, 'usage_records')).toBe(4)
    expect(count(db, 'usage_daily_rollups')).toBe(2)

    // 90 天保留：仅删除 100 天前那批（2 条），1 天前的保留
    expect(cleanupOldRecords(db, 90)).toBe(2)
    expect(count(db, 'usage_records')).toBe(2)
    const remaining = db
      .prepare('SELECT created_at FROM usage_records ORDER BY created_at')
      .all() as { created_at: number }[]
    expect(remaining.every((r) => r.created_at > now - 2 * DAY_MS)).toBe(true)

    // usage_daily_rollups 为历史趋势数据，不随明细清理
    expect(count(db, 'usage_daily_rollups')).toBe(2)
  })

  it('保留天数非正数时不删除任何数据', async () => {
    const db = createDatabase(':memory:')
    migrate(db)
    const storage = new SqliteStorage(db)
    await storage.recordUsage([
      makeRecord({ source: { filePath: '/s/r.jsonl', line: 1 } }),
      makeRecord({ createdAt: Date.now() - 100 * DAY_MS, source: { filePath: '/s/o.jsonl', line: 1 } })
    ])
    expect(cleanupOldRecords(db, 0)).toBe(0)
    expect(count(db, 'usage_records')).toBe(2)
  })
})
