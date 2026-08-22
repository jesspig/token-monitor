import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import type { ModelPricingRow } from '../../../shared/tables'
import type { SqliteDatabase } from './db'
import { createDatabase, migrate } from './db'
import { SqliteStorage } from './storage'

/** 构造一条可复用的定价条目 */
function entry(overrides: Partial<ModelPricingRow> = {}): ModelPricingRow {
  return {
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
  }
}

/** 内存库 + 迁移 + 存储实例，返回可直查的 db 句柄 */
function makeStorage(): { storage: SqliteStorage; db: SqliteDatabase } {
  const db = createDatabase(':memory:')
  migrate(db)
  return { storage: new SqliteStorage(db), db }
}

/** 直查某 model_id 行（含 source 列） */
function rawRow(db: SqliteDatabase, modelId: string): ModelPricingRow {
  return db.prepare('SELECT * FROM model_pricing WHERE model_id = ?').get(modelId) as ModelPricingRow
}

describe('model_pricing source 列迁移', () => {
  it('全新建库经 v1→v2 迁移后表含 source 列（NOT NULL）且新行默认 user', () => {
    const { db } = makeStorage()
    try {
      expect(db.pragma('user_version', { simple: true })).toBe(3)
      const columns = db.pragma('table_info(model_pricing)') as {
        name: string
        notnull: number
        dflt_value: string | null
      }[]
      const sourceCol = columns.find((c) => c.name === 'source')
      expect(sourceCol).toBeDefined()
      expect(sourceCol?.notnull).toBe(1)

      // 不指定 source 插入 → 落库为列默认值 'user'
      db.prepare(
        `INSERT INTO model_pricing (
           model_id, provider, input_per_million, output_per_million,
           cache_read_per_million, cache_creation_per_million, currency, cost_multiplier, updated_at
         ) VALUES ('m-1', null, 1, 2, 0.1, 0.2, 'USD', 1, 100)`
      ).run()
      expect(rawRow(db, 'm-1').source).toBe('user')
    } finally {
      db.close()
    }
  })

  it('模拟 v1 旧库重开自动升 v2，存量行 source 一律标 user', () => {
    const dir = mkdtempSync(join(tmpdir(), 'token-monitor-'))
    let old: SqliteDatabase | undefined
    let db: SqliteDatabase | undefined
    try {
      // 手工搭建完整 v1 结构（逐字取自 db.ts version 1 迁移 DDL，无 source 列）
      // + 插一行存量数据 + 版本号钉在 1；SqliteStorage 重开依赖全部 v1 表
      old = createDatabase(dir)
      old.exec(`
        CREATE TABLE IF NOT EXISTS usage_records (
          id                    TEXT    NOT NULL PRIMARY KEY,
          data_source           TEXT    NOT NULL,
          app_type              TEXT    NOT NULL,
          model                 TEXT    NOT NULL,
          raw_model             TEXT,
          input_tokens          INTEGER NOT NULL DEFAULT 0,
          output_tokens         INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
          cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
          input_semantics       INTEGER NOT NULL DEFAULT 0,
          cost_usd              TEXT,
          currency              TEXT,
          latency_ms            INTEGER,
          project               TEXT,
          session_id            TEXT,
          status                TEXT    NOT NULL DEFAULT 'success',
          file_path             TEXT    NOT NULL,
          line                  INTEGER NOT NULL,
          created_at            INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_usage_records_created_at ON usage_records (created_at);
        CREATE INDEX IF NOT EXISTS idx_usage_records_app_created ON usage_records (app_type, created_at);

        CREATE TABLE IF NOT EXISTS usage_daily_rollups (
          date                  TEXT    NOT NULL,
          app_type              TEXT    NOT NULL,
          model                 TEXT    NOT NULL,
          request_count         INTEGER NOT NULL DEFAULT 0,
          success_count         INTEGER NOT NULL DEFAULT 0,
          error_count           INTEGER NOT NULL DEFAULT 0,
          input_tokens          INTEGER NOT NULL DEFAULT 0,
          output_tokens         INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
          cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd              TEXT    NOT NULL DEFAULT '0',
          latency_ms_total      INTEGER NOT NULL DEFAULT 0,
          updated_at            INTEGER NOT NULL,
          PRIMARY KEY (date, app_type, model)
        );

        CREATE TABLE IF NOT EXISTS model_pricing (
          model_id                   TEXT   NOT NULL PRIMARY KEY,
          provider                   TEXT,
          input_per_million          REAL   NOT NULL DEFAULT 0,
          output_per_million         REAL   NOT NULL DEFAULT 0,
          cache_read_per_million     REAL   NOT NULL DEFAULT 0,
          cache_creation_per_million REAL   NOT NULL DEFAULT 0,
          currency                   TEXT   NOT NULL DEFAULT 'USD',
          cost_multiplier            REAL   NOT NULL DEFAULT 1,
          updated_at                 INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sync_cursors (
          file_path   TEXT    NOT NULL PRIMARY KEY,
          data_source TEXT    NOT NULL DEFAULT '',
          line_offset INTEGER NOT NULL DEFAULT 0,
          file_mtime  INTEGER NOT NULL DEFAULT 0,
          updated_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sync_cursors_data_source ON sync_cursors (data_source);

        CREATE TABLE IF NOT EXISTS dedup_ledger (
          data_source TEXT    NOT NULL,
          request_id  TEXT    NOT NULL,
          semantic_id TEXT    NOT NULL,
          created_at  INTEGER NOT NULL,
          PRIMARY KEY (data_source, request_id)
        );
        CREATE INDEX IF NOT EXISTS idx_dedup_ledger_semantic_id ON dedup_ledger (semantic_id);
      `)
      old.prepare(
        `INSERT INTO model_pricing (
           model_id, provider, input_per_million, output_per_million,
           cache_read_per_million, cache_creation_per_million, currency, cost_multiplier, updated_at
         ) VALUES ('legacy-model', 'anthropic', 5, 25, 0.5, 6.25, 'USD', 1.5, 999)`
      ).run()
      old.pragma('user_version = 1')
      old.close()

      // 重开同一数据库文件 → 自动应用 v2 迁移
      db = createDatabase(dir)
      migrate(db)
      const reopened = new SqliteStorage(db)
      try {
        expect(db.pragma('user_version', { simple: true })).toBe(3)
        // 存量行标 'user'：用户可见数据不被未来 seed/sync 同步覆盖
        expect(rawRow(db, 'legacy-model')).toMatchObject({
          input_per_million: 5,
          cost_multiplier: 1.5,
          source: 'user'
        })
        // 升级后的库可继续按分级语义写入：seed 无法覆盖这条存量 user 行
        reopened.updateModelPricing(entry({ model_id: 'legacy-model', updated_at: 1234 }), 'seed')
        expect(rawRow(db, 'legacy-model')).toMatchObject({
          input_per_million: 5,
          cost_multiplier: 1.5,
          source: 'user'
        })
      } finally {
        reopened.close()
      }
    } finally {
      if (old?.open) old.close()
      if (db?.open) db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('model_pricing 分级 upsert（user > seed/sync）', () => {
  it('seed 写入不覆盖 user 行（user→seed 降级尝试被挡），值与 updated_at 保持不变', async () => {
    const { storage, db } = makeStorage()
    await storage.updateModelPricing(entry({ updated_at: 111 }), 'user')

    await storage.updateModelPricing(
      entry({ input_per_million: 99, updated_at: 222 }),
      'seed'
    )

    const row = rawRow(db, 'claude-sonnet-4')
    expect(row).toMatchObject({ input_per_million: 3, updated_at: 111, source: 'user' })
    // 未产生新行
    const rows = await storage.getModelPricing()
    expect(rows).toHaveLength(1)
  })

  it('sync 写入同样不覆盖 user 行', async () => {
    const { storage, db } = makeStorage()
    await storage.updateModelPricing(entry({ updated_at: 111 }), 'user')

    await storage.updateModelPricing(entry({ input_per_million: 88, updated_at: 333 }), 'sync')

    const row = rawRow(db, 'claude-sonnet-4')
    expect(row).toMatchObject({ input_per_million: 3, updated_at: 111, source: 'user' })
  })

  it('user 写入覆盖 sync 行，并把行升级为 source=user', async () => {
    const { storage, db } = makeStorage()
    await storage.updateModelPricing(entry({ input_per_million: 1, updated_at: 10 }), 'sync')

    await storage.updateModelPricing(entry({ input_per_million: 7, updated_at: 20 })) // 缺省 = user

    const row = rawRow(db, 'claude-sonnet-4')
    expect(row).toMatchObject({ input_per_million: 7, updated_at: 20, source: 'user' })
  })

  it('seed 重复播种幂等覆盖 seed 行（同 source 重复写正常更新）', async () => {
    const { storage } = makeStorage()
    await storage.updateModelPricing(entry({ input_per_million: 3, updated_at: 10 }), 'seed')
    await storage.updateModelPricing(entry({ input_per_million: 4, updated_at: 20 }), 'seed')

    const rows = await storage.getModelPricing()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ input_per_million: 4, updated_at: 20, source: 'seed' })
  })

  it('非 user 行之间正常互写（seed 覆盖 sync 行）', async () => {
    const { storage, db } = makeStorage()
    await storage.updateModelPricing(entry({ input_per_million: 1, updated_at: 10 }), 'sync')
    await storage.updateModelPricing(entry({ input_per_million: 2, updated_at: 20 }), 'seed')

    const row = rawRow(db, 'claude-sonnet-4')
    expect(row).toMatchObject({ input_per_million: 2, updated_at: 20, source: 'seed' })
  })

  it('新行插入直接携带传入来源；查询结果自然带出 source 字段', async () => {
    const { storage } = makeStorage()
    await storage.updateModelPricing(entry(), 'sync')
    await storage.updateModelPricing(entry({ model_id: 'gpt-x', updated_at: 9 }), 'seed')
    await storage.updateModelPricing(entry({ model_id: 'my-model', updated_at: 8 })) // 缺省 = user

    const rows = await storage.getModelPricing()
    const byId = new Map(rows.map((r) => [r.model_id, r.source]))
    expect(byId.get('claude-sonnet-4')).toBe('sync')
    expect(byId.get('gpt-x')).toBe('seed')
    expect(byId.get('my-model')).toBe('user')
  })

  it('旧调用方式向后兼容：单参写入视为 user，对既有 user 行照常覆盖更新', async () => {
    const { storage, db } = makeStorage()
    await storage.updateModelPricing(entry({ updated_at: 111 }))
    await storage.updateModelPricing(
      entry({ output_per_million: 16, updated_at: 222 }) // 与既有调用完全一致的单参形式
    )
    const row = rawRow(db, 'claude-sonnet-4')
    expect(row).toMatchObject({
      output_per_million: 16,
      updated_at: 222,
      source: 'user'
    })
  })
})
