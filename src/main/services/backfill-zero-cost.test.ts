import { describe, it, expect } from 'vitest'
import type { UsageRecord } from '../../../shared/dto'
import type { ModelPricingRow, UsageDailyRollupRow } from '../../../shared/tables'
import { createDatabase, migrate, type SqliteDatabase } from './db'
import { SqliteStorage } from './storage'
import { backfillZeroCost, createPricingService } from './pricing'

/** 构造一条可复用的测试用量记录（默认零成本，source 须逐条唯一以避开去重） */
function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    appType: 'claude',
    model: 'test-model-x',
    inputTokens: 1000,
    outputTokens: 2000,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    inputSemantics: 1,
    costUsd: '0',
    createdAt: new Date('2026-08-19T10:00:00').getTime(),
    source: { filePath: '/tmp/bf.jsonl', line: 1 },
    ...overrides
  }
}

/** 内存库 + 迁移 + 存储实例，返回可直查的 db 句柄 */
function makeDb(): { storage: SqliteStorage; db: SqliteDatabase } {
  const db = createDatabase(':memory:')
  migrate(db)
  return { storage: new SqliteStorage(db), db }
}

/** 测试定价项（默认 test-model-x：in 3 / out 15 USD 每百万 → 上记 token 合计 0.033 USD） */
function pricingEntry(overrides: Partial<ModelPricingRow> = {}): ModelPricingRow {
  return {
    model_id: 'test-model-x',
    provider: 'test',
    input_per_million: 3,
    output_per_million: 15,
    cache_read_per_million: 0,
    cache_creation_per_million: 0,
    currency: 'USD',
    cost_multiplier: 1,
    updated_at: 111,
    ...overrides
  }
}

/** epoch ms → YYYY-MM-DD（本地时区，与 storage 归桶规则一致；使断言与运行时区无关） */
function localDateKey(ms: number): string {
  const d = new Date(ms)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 指定 (date, app_type, model) 组内当日明细费用之和（微美元累加后按仓库规则转 USD 字符串），用于不变量断言 */
function detailSumCost(db: SqliteDatabase, date: string, appType: string, model: string): string {
  const rows = db
    .prepare('SELECT created_at, cost_usd FROM usage_records WHERE app_type = ? AND model = ?')
    .all(appType, model) as { created_at: number; cost_usd: string | null }[]
  const micro = rows.reduce(
    (sum, r) =>
      localDateKey(r.created_at) === date
        ? sum + (r.cost_usd == null || r.cost_usd === '' ? 0 : Math.round(Number(r.cost_usd) * 1_000_000))
        : sum,
    0
  )
  return (micro / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0'
}

function getRollups(db: SqliteDatabase): UsageDailyRollupRow[] {
  return db.prepare('SELECT * FROM usage_daily_rollups').all() as UsageDailyRollupRow[]
}

describe('backfillZeroCost', () => {
  it('零成本明细回填：cost 为 0 与 NULL 均命中，明细更新且 rollup 等于组内明细总和', async () => {
    const { storage, db } = makeDb()
    await storage.recordUsage([
      makeRecord({ costUsd: '0', source: { filePath: '/tmp/bf.jsonl', line: 1 } }),
      makeRecord({ costUsd: undefined, source: { filePath: '/tmp/bf.jsonl', line: 2 } })
    ])
    await storage.updateModelPricing(pricingEntry())
    const svc = createPricingService(storage)

    // Act
    const result = await backfillZeroCost(db, svc)

    // Assert：1000×3 + 2000×15 = 33000 微美元/条 = '0.033'
    expect(result).toEqual({ scanned: 2, updated: 2 })
    const details = db
      .prepare('SELECT cost_usd FROM usage_records ORDER BY line')
      .all() as { cost_usd: string | null }[]
    expect(details.map((r) => r.cost_usd)).toEqual(['0.033', '0.033'])

    const rollups = getRollups(db)
    expect(rollups).toHaveLength(1)
    expect(rollups[0].cost_usd).toBe('0.066')
    // 不变量：rollup.cost ≡ 组内当日明细之和
    expect(rollups[0].cost_usd).toBe(detailSumCost(db, rollups[0].date, 'claude', 'test-model-x'))
  })

  it('同组部分有价部分零 + 跨日多桶：rollup 增量调整后各组均与明细 SUM 一致', async () => {
    const { storage, db } = makeDb()
    const day1 = new Date('2026-08-19T10:00:00').getTime()
    const day2 = new Date('2026-08-20T10:00:00').getTime()
    await storage.recordUsage([
      // 已有价行不参与回填，验证 rollup 是增量累加而非覆盖
      makeRecord({ costUsd: '0.01', createdAt: day1, source: { filePath: '/tmp/bf.jsonl', line: 1 } }),
      makeRecord({ costUsd: '0', createdAt: day1, source: { filePath: '/tmp/bf.jsonl', line: 2 } }),
      makeRecord({ costUsd: '0', createdAt: day2, source: { filePath: '/tmp/bf.jsonl', line: 3 } })
    ])
    await storage.updateModelPricing(pricingEntry())
    const svc = createPricingService(storage)

    // Act
    const result = await backfillZeroCost(db, svc)

    // Assert
    expect(result).toEqual({ scanned: 2, updated: 2 })
    const rollups = getRollups(db)
    expect(rollups).toHaveLength(2)
    const byDate = new Map(rollups.map((r) => [r.date, r]))
    const d1 = byDate.get(localDateKey(day1))
    const d2 = byDate.get(localDateKey(day2))
    // day1：原 0.01 + 回填 0.033；day2：仅回填 0.033
    expect(d1?.cost_usd).toBe('0.043')
    expect(d2?.cost_usd).toBe('0.033')
    for (const r of rollups) {
      expect(r.cost_usd).toBe(detailSumCost(db, r.date, r.app_type, r.model))
    }
  })

  it('无定价模型跳过：updated=0，明细与 rollup 保持原值', async () => {
    const { storage, db } = makeDb()
    await storage.recordUsage([makeRecord()])
    const svc = createPricingService(storage)

    // Act
    const result = await backfillZeroCost(db, svc)

    // Assert
    expect(result).toEqual({ scanned: 1, updated: 0 })
    const detail = db.prepare('SELECT cost_usd FROM usage_records').get() as { cost_usd: string | null }
    expect(detail.cost_usd).toBe('0')
    const rollup = getRollups(db)[0]
    expect(rollup.cost_usd).toBe('0')
  })

  it('四档全零定价跳过：视为免费模型，不回填', async () => {
    const { storage, db } = makeDb()
    await storage.recordUsage([
      makeRecord({
        model: 'free-model',
        inputTokens: 5000,
        outputTokens: 5000,
        source: { filePath: '/tmp/bf.jsonl', line: 7 }
      })
    ])
    await storage.updateModelPricing(
      pricingEntry({ model_id: 'free-model', input_per_million: 0, output_per_million: 0 })
    )
    const svc = createPricingService(storage)

    // Act
    const result = await backfillZeroCost(db, svc)

    // Assert
    expect(result).toEqual({ scanned: 1, updated: 0 })
    const detail = db.prepare('SELECT cost_usd FROM usage_records').get() as { cost_usd: string | null }
    expect(detail.cost_usd).toBe('0')
  })

  it('幂等：首次回填后二次调用 scanned=0 / updated=0，rollup 不再变化', async () => {
    const { storage, db } = makeDb()
    await storage.recordUsage([
      makeRecord({ source: { filePath: '/tmp/bf.jsonl', line: 1 } }),
      makeRecord({ source: { filePath: '/tmp/bf.jsonl', line: 2 } })
    ])
    await storage.updateModelPricing(pricingEntry())
    const svc = createPricingService(storage)

    const first = await backfillZeroCost(db, svc)
    expect(first).toEqual({ scanned: 2, updated: 2 })

    // Act
    const second = await backfillZeroCost(db, svc)

    // Assert
    expect(second).toEqual({ scanned: 0, updated: 0 })
    expect(getRollups(db)[0].cost_usd).toBe('0.066')
  })

  it('rollup 行缺失时不重建：仅回填明细，聚合表保持为空', async () => {
    const { storage, db } = makeDb()
    await storage.recordUsage([makeRecord()])
    await storage.updateModelPricing(pricingEntry())
    db.prepare('DELETE FROM usage_daily_rollups').run()
    const svc = createPricingService(storage)

    // Act
    const result = await backfillZeroCost(db, svc)

    // Assert
    expect(result).toEqual({ scanned: 1, updated: 1 })
    const detail = db.prepare('SELECT cost_usd FROM usage_records').get() as { cost_usd: string | null }
    expect(detail.cost_usd).toBe('0.033')
    expect(getRollups(db)).toHaveLength(0)
  })
})
