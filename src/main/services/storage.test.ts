import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import type { UsageRecord } from '../../../shared/dto'
import type { ModelPricingRow, UsageDailyRollupRow } from '../../../shared/tables'
import type { StorageService } from '../../../shared/context'
import { createDatabase, migrate, type SqliteDatabase } from './db'
import { SqliteStorage, openStorage } from './storage'

/** 构造一条可复用的测试用量记录 */
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
    createdAt: new Date('2026-08-19T10:00:00+08:00').getTime(),
    source: { filePath: '/tmp/sessions/claude-2026-08-19.jsonl', line: 1 },
    ...overrides
  }
}

/** 内存库 + 迁移 + 存储实例，返回可直查的 db 句柄 */
function makeStorage(): { storage: StorageService; db: SqliteDatabase } {
  const db = createDatabase(':memory:')
  migrate(db)
  return { storage: new SqliteStorage(db), db }
}

describe('数据库迁移', () => {
  it('首次建 v1，重复迁移幂等，五张表齐全', () => {
    const dir = mkdtempSync(join(tmpdir(), 'token-monitor-'))
    const db = createDatabase(dir)
    try {
      migrate(db)
      migrate(db) // 第二次执行应无副作用
      expect(db.pragma('user_version', { simple: true })).toBe(1)
      const tables = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[]
      )
        .map((t) => t.name)
        .sort()
      expect(tables).toEqual([
        'dedup_ledger',
        'model_pricing',
        'sync_cursors',
        'usage_daily_rollups',
        'usage_records'
      ])
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('openStorage 对同一目录重复打开不报错（迁移幂等）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'token-monitor-'))
    try {
      const s1 = openStorage(dir) as SqliteStorage
      const s2 = openStorage(dir) as SqliteStorage
      expect(s1).toBeDefined()
      expect(s2).toBeDefined()
      s1.close()
      s2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('内存模式可直接使用', async () => {
    const storage = openStorage(':memory:')
    expect(await storage.getModelPricing()).toEqual([])
  })
})

describe('recordUsage 去重', () => {
  it('重复行只入一次，返回实际新增条数', async () => {
    const { storage, db } = makeStorage()
    expect(await storage.recordUsage([makeRecord()])).toBe(1)
    // 同 file+line 再写一次 → 0
    expect(await storage.recordUsage([makeRecord()])).toBe(0)
    // 同一批内重复也只入一次
    expect(
      await storage.recordUsage([
        makeRecord({ source: { filePath: '/a.jsonl', line: 2 } }),
        makeRecord({ source: { filePath: '/a.jsonl', line: 2 } })
      ])
    ).toBe(1)
    const count = (db.prepare('SELECT COUNT(*) AS c FROM usage_records').get() as { c: number }).c
    expect(count).toBe(2)
  })

  it('id 由 data_source + file_path + line 组成，跨 app 不冲突', async () => {
    const { storage, db } = makeStorage()
    await storage.recordUsage([
      makeRecord({ source: { filePath: '/x.jsonl', line: 1 } }),
      makeRecord({ appType: 'codex', model: 'gpt-5', source: { filePath: '/x.jsonl', line: 1 } })
    ])
    const rows = db.prepare('SELECT id, data_source FROM usage_records ORDER BY data_source').all() as {
      id: string
      data_source: string
    }[]
    expect(rows).toEqual([
      { id: 'claude:/x.jsonl:1', data_source: 'claude' },
      { id: 'codex:/x.jsonl:1', data_source: 'codex' }
    ])
  })
})

describe('usage_daily_rollups 日聚合', () => {
  it('按 (date, app_type, model) 累计计数/token/费用/耗时', async () => {
    const { storage, db } = makeStorage()
    const base = {
      appType: 'codex' as const,
      model: 'gpt-5',
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheCreationTokens: 2,
      costUsd: '0.010000',
      latencyMs: 100,
      status: 'success' as const,
      createdAt: new Date('2026-08-19T10:00:00+08:00').getTime()
    }
    await storage.recordUsage([
      makeRecord({ ...base, source: { filePath: '/codex/a.jsonl', line: 1 } }),
      makeRecord({ ...base, source: { filePath: '/codex/a.jsonl', line: 2 } }),
      makeRecord({ ...base, status: 'error', source: { filePath: '/codex/a.jsonl', line: 3 } }),
      // 不同 app_type 独立成桶
      makeRecord({
        ...base,
        appType: 'claude',
        model: 'claude-sonnet-4',
        source: { filePath: '/claude/b.jsonl', line: 1 }
      })
    ])

    const codex = db
      .prepare("SELECT * FROM usage_daily_rollups WHERE app_type = 'codex'")
      .get() as UsageDailyRollupRow
    expect(codex.date).toBe('2026-08-19')
    expect(codex.request_count).toBe(3)
    expect(codex.success_count).toBe(2)
    expect(codex.error_count).toBe(1)
    expect(codex.input_tokens).toBe(30)
    expect(codex.output_tokens).toBe(60)
    expect(codex.cache_read_tokens).toBe(15)
    expect(codex.cache_creation_tokens).toBe(6)
    expect(codex.cost_usd).toBe('0.03')
    expect(codex.latency_ms_total).toBe(300)

    const claude = db
      .prepare("SELECT * FROM usage_daily_rollups WHERE app_type = 'claude'")
      .get() as UsageDailyRollupRow
    expect(claude.request_count).toBe(1)
    expect(claude.model).toBe('claude-sonnet-4')
  })

  it('跨批次累计，重复行不重复累计', async () => {
    const { storage, db } = makeStorage()
    const r1 = makeRecord({ source: { filePath: '/a.jsonl', line: 1 } })
    const r2 = makeRecord({ source: { filePath: '/a.jsonl', line: 2 } })
    await storage.recordUsage([r1])
    await storage.recordUsage([r1, r2]) // r1 为重复 → 只累计 r2
    const row = db.prepare('SELECT * FROM usage_daily_rollups').get() as UsageDailyRollupRow
    expect(row.request_count).toBe(2)
    expect(row.success_count).toBe(2)
    expect(row.error_count).toBe(0)
    expect(row.input_tokens).toBe(200)
    expect(row.output_tokens).toBe(100)
    expect(row.cost_usd).toBe('0.002')
    expect(row.latency_ms_total).toBe(1600)
  })
})

describe('sync_cursors 游标', () => {
  it('未同步过返回 null，读写正常', async () => {
    const { storage } = makeStorage()
    expect(await storage.getCursor('/a.jsonl')).toBeNull()
    await storage.setCursor('/a.jsonl', 10, 1000)
    expect(await storage.getCursor('/a.jsonl')).toBe(10)
  })

  it('mtime 未变则正常推进，mtime 变化重置到 0', async () => {
    const { storage } = makeStorage()
    await storage.setCursor('/a.jsonl', 10, 1000)
    await storage.setCursor('/a.jsonl', 20, 1000)
    expect(await storage.getCursor('/a.jsonl')).toBe(20)
    // 文件被 truncate/替换：mtime 变化 → 游标重置 0，下轮全量重读
    await storage.setCursor('/a.jsonl', 30, 2000)
    expect(await storage.getCursor('/a.jsonl')).toBe(0)
  })

  it('未传 mtime 时沿用既有 mtime，不触发重置；不同文件互不影响', async () => {
    const { storage } = makeStorage()
    await storage.setCursor('/a.jsonl', 10, 1000)
    await storage.setCursor('/a.jsonl', 15)
    expect(await storage.getCursor('/a.jsonl')).toBe(15)
    await storage.setCursor('/b.jsonl', 3, 500)
    expect(await storage.getCursor('/b.jsonl')).toBe(3)
    expect(await storage.getCursor('/a.jsonl')).toBe(15)
  })
})

describe('model_pricing CRUD', () => {
  const entry = (overrides: Partial<ModelPricingRow> = {}): ModelPricingRow => ({
    model_id: 'claude-sonnet-4',
    provider: 'anthropic',
    input_per_million: 3,
    output_per_million: 15,
    cache_read_per_million: 0.3,
    cache_creation_per_million: 3.75,
    currency: 'USD',
    cost_multiplier: 1,
    updated_at: 111,
    ...overrides
  })

  it('upsert 新增与覆盖更新', async () => {
    const { storage } = makeStorage()
    expect(await storage.getModelPricing()).toEqual([])
    await storage.updateModelPricing(entry())
    let list = await storage.getModelPricing()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      model_id: 'claude-sonnet-4',
      provider: 'anthropic',
      input_per_million: 3,
      output_per_million: 15,
      cost_multiplier: 1
    })
    // 覆盖更新（upsert 不新增行）
    await storage.updateModelPricing(entry({ input_per_million: 3.5, output_per_million: 16, updated_at: 222 }))
    list = await storage.getModelPricing()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ input_per_million: 3.5, output_per_million: 16, updated_at: 222 })
  })

  it('删除后查询为空，删除不存在 id 不报错', async () => {
    const { storage } = makeStorage()
    await storage.updateModelPricing(entry())
    await storage.deleteModelPricing('claude-sonnet-4')
    expect(await storage.getModelPricing()).toEqual([])
    await storage.deleteModelPricing('not-exist') // 幂等
  })
})
