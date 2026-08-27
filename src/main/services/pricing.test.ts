import { describe, it, expect } from 'vitest'
import type { StorageService } from '../../../shared/context'
import type { UsageRecord } from '../../../shared/dto'
import type { ModelPricingRow } from '../../../shared/tables'
import type { SqliteDatabase } from './db'
import { createDatabase, migrate } from './db'
import {
  normalizeModelId,
  seedPricing,
  SEED_MODELS,
  createPricingService,
  PricingServiceImpl,
  recalcCachedInputCosts
} from './pricing'
import { openStorage, SqliteStorage } from './storage'

function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    appType: 'claude',
    model: 'claude-sonnet-4-5',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    inputSemantics: 1,
    createdAt: new Date('2026-08-19T10:00:00+08:00').getTime(),
    source: { filePath: '/tmp/a.jsonl', line: 1 },
    ...overrides
  }
}

describe('normalizeModelId', () => {
  it('转小写并 trim', () => {
    expect(normalizeModelId('  Claude-Sonnet-4-5 ')).toBe('claude-sonnet-4-5')
    expect(normalizeModelId('')).toBe('')
  })

  it('去掉最后一个 / 之前的供应商前缀', () => {
    expect(normalizeModelId('anthropic/claude-sonnet-4-5')).toBe('claude-sonnet-4-5')
    expect(normalizeModelId('google/gemini-2-5-pro')).toBe('gemini-2-5-pro')
    expect(normalizeModelId('x-ai/grok-4')).toBe('grok-4')
  })

  it('去掉 : 之后的后缀（model:suffix → model）', () => {
    expect(normalizeModelId('claude-sonnet-4-5:beta')).toBe('claude-sonnet-4-5')
  })

  it('保留 provider:model 中的模型部分', () => {
    expect(normalizeModelId('openai:gpt-4o')).toBe('gpt-4o')
    expect(normalizeModelId('anthropic:claude-sonnet-4-5')).toBe('claude-sonnet-4-5')
  })

  it('去掉末尾 [1m]', () => {
    expect(normalizeModelId('claude-sonnet-4[1m]')).toBe('claude-sonnet-4')
    expect(normalizeModelId('claude-sonnet-4-20250514[1m]')).toBe('claude-sonnet-4')
  })

  it('@ → -，并处理开头 @', () => {
    expect(normalizeModelId('gpt-4@latest')).toBe('gpt-4-latest')
    expect(normalizeModelId('@openai/gpt-4o')).toBe('gpt-4o')
    expect(normalizeModelId('@gpt-4o')).toBe('gpt-4o')
  })

  it('去掉常见包装前缀（provider.model / provider_model）', () => {
    expect(normalizeModelId('anthropic.claude-sonnet-4-5')).toBe('claude-sonnet-4-5')
    expect(normalizeModelId('openai_gpt-4o')).toBe('gpt-4o')
  })

  it('去掉版本/日期后缀（-YYYY-MM-DD、-YYYYMMDD）', () => {
    expect(normalizeModelId('claude-sonnet-4-5-2025-09-29')).toBe('claude-sonnet-4-5')
    expect(normalizeModelId('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5')
    expect(normalizeModelId('gpt-4o-mini')).toBe('gpt-4o-mini')
    expect(normalizeModelId('claude-sonnet-4-5')).toBe('claude-sonnet-4-5')
  })

  it('组合场景', () => {
    expect(normalizeModelId('Anthropic/CLAUDE-SONNET-4-5-20250929[1m]')).toBe('claude-sonnet-4-5')
  })
})

describe('seedPricing', () => {
  it('seed 后可查到全部内置模型，价格与来源均为 seed/USD', async () => {
    const storage = openStorage(':memory:')
    await seedPricing(storage)
    const rows = await storage.getModelPricing()
    expect(rows.length).toBe(SEED_MODELS.length)
    expect(rows.every((r) => r.currency === 'USD')).toBe(true)
    expect(rows.every((r) => r.source === 'seed')).toBe(true)

    const sonnet = rows.find((r) => r.model_id === 'claude-sonnet-4-5')
    expect(sonnet).toMatchObject({
      provider: 'anthropic',
      input_per_million: 3,
      output_per_million: 15,
      cache_read_per_million: 0.3,
      cache_creation_per_million: 3.75,
      cost_multiplier: 1
    })
  })

  it('重复 seed 为 upsert 覆盖，不产生重复行', async () => {
    const storage = openStorage(':memory:')
    await seedPricing(storage)
    await seedPricing(storage)
    expect(await storage.getModelPricing()).toHaveLength(SEED_MODELS.length)
  })

  it('再次播种：user 手改行保持用户值不被覆盖，其余行照常刷新回 seed 价', async () => {
    const storage = openStorage(':memory:')
    await seedPricing(storage)

    const sonnet = (await storage.getModelPricing()).find(
      (r) => r.model_id === 'claude-sonnet-4-5'
    ) as ModelPricingRow
    await storage.updateModelPricing(
      { ...sonnet, input_per_million: 99, updated_at: 123 },
      'user'
    )
    const grok = (await storage.getModelPricing()).find(
      (r) => r.model_id === 'grok-4'
    ) as ModelPricingRow
    await storage.updateModelPricing({ ...grok, input_per_million: 77 }, 'sync')

    await seedPricing(storage)

    const rows = await storage.getModelPricing()
    expect(rows).toHaveLength(SEED_MODELS.length)
    expect(rows.find((r) => r.model_id === 'claude-sonnet-4-5')).toMatchObject({
      input_per_million: 99,
      updated_at: 123,
      source: 'user'
    })
    expect(rows.find((r) => r.model_id === 'grok-4')).toMatchObject({
      input_per_million: 1.25,
      source: 'seed'
    })
  })
})

describe('PricingService', () => {
  it('seed 后可经 getPrice 查到价格', async () => {
    const storage = openStorage(':memory:')
    await seedPricing(storage)
    const svc = createPricingService(storage)
    expect((await svc.getPrice('claude-sonnet-4-5'))?.input_per_million).toBe(3)
    expect(await svc.getPrice('grok-4')).toBeDefined()
    expect(await svc.getPrice('not-exist-model')).toBeUndefined()
  })

  it('getPrice 对 raw 模型 ID 归一化后匹配', async () => {
    const storage = openStorage(':memory:')
    await seedPricing(storage)
    const svc = createPricingService(storage)
    expect((await svc.getPrice('Anthropic/CLAUDE-SONNET-4-5-20250929'))?.model_id).toBe(
      'claude-sonnet-4-5'
    )
  })

  it('calcCost 按各类 token × 每百万价格求和（字符串精度）', async () => {
    const storage = openStorage(':memory:')
    await seedPricing(storage)
    const svc = createPricingService(storage)
    const cost = await svc.calcCost(
      makeRecord({
        model: 'claude-sonnet-4-5',
        inputTokens: 1000,
        outputTokens: 2000,
        cacheReadTokens: 3000,
        inputSemantics: 2
      })
    )
    expect(cost).toBe('0.0339')
  })

  it('calcCost 含 cache_creation 定价', async () => {
    const storage = openStorage(':memory:')
    await seedPricing(storage)
    const svc = createPricingService(storage)
    const cost = await svc.calcCost(makeRecord({ model: 'claude-sonnet-4-5', cacheCreationTokens: 1000 }))
    expect(cost).toBe('0.00375')
  })

  it('calcCost 归一化后命中（raw 带供应商前缀/版本）', async () => {
    const storage = openStorage(':memory:')
    await seedPricing(storage)
    const svc = createPricingService(storage)
    const cost = await svc.calcCost(
      makeRecord({ model: 'anthropic/claude-sonnet-4-5-20250929', inputTokens: 1000 })
    )
    expect(cost).toBe('0.003')
  })

  it('calcCost 未定价模型返回 undefined', async () => {
    const storage = openStorage(':memory:')
    await seedPricing(storage)
    const svc = createPricingService(storage)
    expect(await svc.calcCost(makeRecord({ model: 'unknown-model-xyz', inputTokens: 100 }))).toBeUndefined()
  })

  it('calcCost 应用 cost_multiplier', async () => {
    const storage = openStorage(':memory:')
    await seedPricing(storage)
    const svc = createPricingService(storage)
    const row = (await svc.getPrice('claude-sonnet-4-5')) as ModelPricingRow
    await storage.updateModelPricing({ ...row, cost_multiplier: 2, updated_at: Date.now() })
    ;(svc as PricingServiceImpl).invalidateCache()
    expect(await svc.calcCost(makeRecord({ inputTokens: 1000 }))).toBe('0.006')
  })

  it('写入定价后需 invalidateCache 使内存索引失效', async () => {
    const storage = openStorage(':memory:')
    await seedPricing(storage)
    const svc = createPricingService(storage) as PricingServiceImpl
    expect((await svc.getPrice('claude-sonnet-4-5'))?.input_per_million).toBe(3)

    const row = (await svc.getPrice('claude-sonnet-4-5')) as ModelPricingRow
    await storage.updateModelPricing({ ...row, input_per_million: 4, updated_at: Date.now() })
    expect((await svc.getPrice('claude-sonnet-4-5'))?.input_per_million).toBe(3)
    svc.invalidateCache()
    expect((await svc.getPrice('claude-sonnet-4-5'))?.input_per_million).toBe(4)
  })
})

describe('calcCost 输入语义', () => {
  async function makeSvc() {
    const storage = openStorage(':memory:')
    await seedPricing(storage)
    return { storage, svc: createPricingService(storage) }
  }

  it('semantics=2（claude 形态）：input 全额计价，不扣缓存', async () => {
    const { svc } = await makeSvc()
    const cost = await svc.calcCost(
      makeRecord({
        inputTokens: 1000,
        cacheReadTokens: 800,
        cacheCreationTokens: 100,
        inputSemantics: 2
      })
    )
    expect(cost).toBe('0.003615')
  })

  it('semantics=1（codex 形态）：input 先扣 cacheRead 再计价', async () => {
    const { svc } = await makeSvc()
    const cost = await svc.calcCost(
      makeRecord({
        inputTokens: 100000,
        outputTokens: 0,
        cacheReadTokens: 80000,
        cacheCreationTokens: 0,
        inputSemantics: 1
      })
    )
    expect(cost).toBe('0.084')
  })

  it('semantics=1 且 cacheCreation>0：read 与 write 一并扣减', async () => {
    const { svc } = await makeSvc()
    const cost = await svc.calcCost(
      makeRecord({
        inputTokens: 100000,
        outputTokens: 0,
        cacheReadTokens: 80000,
        cacheCreationTokens: 5000,
        inputSemantics: 1
      })
    )
    expect(cost).toBe('0.08775')
  })

  it('semantics=1 扣穿防御：cache 总量超过 input 时 freshInput 钳为 0，费用仅剩 output/cache 项', async () => {
    const { svc } = await makeSvc()
    const cost = await svc.calcCost(
      makeRecord({
        inputTokens: 1000,
        outputTokens: 2000,
        cacheReadTokens: 3000,
        cacheCreationTokens: 2000,
        inputSemantics: 1
      })
    )
    expect(cost).toBe('0.0384')
  })

  it('semantics=0（未知口径）：input 全额计价，与旧行为一致', async () => {
    const { svc } = await makeSvc()
    const cost = await svc.calcCost(
      makeRecord({
        inputTokens: 1000,
        cacheReadTokens: 800,
        inputSemantics: 0
      })
    )
    expect(cost).toBe('0.00324')
  })

  it('cost_multiplier 非 1 时逐项生效（semantics=1 扣减后各项同乘）', async () => {
    const { storage, svc } = await makeSvc()
    const row = (await svc.getPrice('claude-sonnet-4-5')) as ModelPricingRow
    await storage.updateModelPricing({ ...row, cost_multiplier: 2, updated_at: Date.now() })
    ;(svc as PricingServiceImpl).invalidateCache()
    const cost = await svc.calcCost(
      makeRecord({
        inputTokens: 100000,
        outputTokens: 1000,
        cacheReadTokens: 80000,
        inputSemantics: 1
      })
    )
    expect(cost).toBe('0.198')
  })
})

describe('定价匹配增强', () => {
  function makeRow(modelId: string, inputPerMillion: number): ModelPricingRow {
    return {
      model_id: modelId,
      provider: 'test',
      input_per_million: inputPerMillion,
      output_per_million: inputPerMillion * 2,
      cache_read_per_million: 0,
      cache_creation_per_million: 0,
      currency: 'USD',
      cost_multiplier: 1,
      updated_at: 1
    }
  }

  it('剥离 reasoning effort 后缀（-high/-low/-xhigh，单次）', () => {
    expect(normalizeModelId('gpt-5-high')).toBe('gpt-5')
    expect(normalizeModelId('gpt-5.1-xhigh')).toBe('gpt-5.1')
    expect(normalizeModelId('model-low')).toBe('model')
    expect(normalizeModelId('a-high')).toBe('a')
    expect(normalizeModelId('a-xhigh')).toBe('a')
  })

  it('非边界情形不误剥 effort 后缀', () => {
    expect(normalizeModelId('abc-highish')).toBe('abc-highish')
    expect(normalizeModelId('xhighy')).toBe('xhighy')
    expect(normalizeModelId('-highish')).toBe('highish')
    expect(normalizeModelId('kimi-k2-turbo')).toBe('kimi-k2-turbo')
    expect(normalizeModelId('gemini-2.5-flash-lite')).toBe('gemini-2.5-flash-lite')
  })

  it('请求侧点号变体经二次转换命中横线式定价', async () => {
    const storage = openStorage(':memory:')
    await seedPricing(storage)
    const svc = createPricingService(storage)
    const row = await svc.getPrice('claude-sonnet-4.5')
    expect(row?.model_id).toBe('claude-sonnet-4-5')
    expect(row?.input_per_million).toBe(3)
  })

  it('点号精确变体优先于短 ID 前缀：opus-4.5 不被上一代 opus-4 截胡', async () => {
    const storage = openStorage(':memory:')
    await seedPricing(storage)
    const svc = createPricingService(storage)
    const row = await svc.getPrice('claude-opus-4.5')
    expect(row?.model_id).toBe('claude-opus-4-5')
    expect(row?.input_per_million).toBe(5)
  })

  it('官方自带点号 id 精确命中优先，不受点转横线影响', async () => {
    const storage = openStorage(':memory:')
    await seedPricing(storage)
    const svc = createPricingService(storage)
    const row = await svc.getPrice('gemini-2.5-pro')
    expect(row?.model_id).toBe('gemini-2.5-pro')
    expect(row?.input_per_million).toBe(1.25)
  })

  it('四级全未命中时家族兜底取最短 key', async () => {
    const storage = openStorage(':memory:')
    await storage.updateModelPricing(makeRow('key-b-extra', 2), 'user')
    await storage.updateModelPricing(makeRow('key-a', 1), 'user')
    const svc = createPricingService(storage)
    const row = await svc.getPrice('key')
    expect(row?.model_id).toBe('key-a')
    expect(row?.input_per_million).toBe(1)
  })

  it('model 长度 <3 不触发家族兜底', async () => {
    const storage = openStorage(':memory:')
    await storage.updateModelPricing(makeRow('key-a', 1), 'user')
    await storage.updateModelPricing(makeRow('key-b-extra', 2), 'user')
    const svc = createPricingService(storage)
    expect(await svc.getPrice('ke')).toBeUndefined()
  })
})

describe('recalcCachedInputCosts', () => {
  const CREATED_AT = new Date('2026-08-19T10:00:00Z').getTime()

  function makeDb(): { storage: SqliteStorage; db: SqliteDatabase } {
    const db = createDatabase(':memory:')
    migrate(db)
    return { storage: new SqliteStorage(db), db }
  }

  function insertLegacyRow(
    db: SqliteDatabase,
    seed: {
      id: string
      app_type: string
      model: string
      input_semantics: number
      input_tokens?: number
      output_tokens?: number
      cache_read_tokens?: number
      cache_creation_tokens?: number
      cost_usd?: string | null
      created_at?: number
    }
  ): void {
    db.prepare(
      `INSERT INTO usage_records (
        id, data_source, app_type, model, raw_model,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        input_semantics, cost_usd, currency, latency_ms, project, session_id,
        status, file_path, line, created_at
      ) VALUES (
        @id, @data_source, @app_type, @model, NULL,
        @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
        @input_semantics, @cost_usd, NULL, NULL, NULL, NULL,
        'success', '/legacy/session.jsonl', @line, @created_at
      )`
    ).run({
      id: seed.id,
      data_source: seed.app_type,
      app_type: seed.app_type,
      model: seed.model,
      input_tokens: seed.input_tokens ?? 0,
      output_tokens: seed.output_tokens ?? 0,
      cache_read_tokens: seed.cache_read_tokens ?? 0,
      cache_creation_tokens: seed.cache_creation_tokens ?? 0,
      input_semantics: seed.input_semantics,
      cost_usd: seed.cost_usd ?? null,
      created_at: seed.created_at ?? CREATED_AT,
      line: Number(seed.id.split(':').pop())
    })
  }

  async function makeSeededSvc(storage: SqliteStorage) {
    await seedPricing(storage)
    return createPricingService(storage)
  }

  it('codex 形态存量行重算：明细精确等于新公式值，rollup 按差额同步修正', async () => {
    const { storage, db } = makeDb()
    const svc = await makeSeededSvc(storage)
    await storage.recordUsage([
      makeRecord({
        appType: 'codex',
        model: 'gpt-5',
        inputTokens: 100_000,
        outputTokens: 1_000,
        cacheReadTokens: 80_000,
        cacheCreationTokens: 0,
        inputSemantics: 1,
        costUsd: '0.145',
        createdAt: CREATED_AT,
        source: { filePath: '/tmp/rc.jsonl', line: 1 }
      })
    ])

    const result = await recalcCachedInputCosts(db, svc)

    expect(result).toEqual({ scanned: 1, updated: 1 })
    const expected = await svc.calcCost(
      makeRecord({
        appType: 'codex',
        model: 'gpt-5',
        inputTokens: 100_000,
        outputTokens: 1_000,
        cacheReadTokens: 80_000,
        cacheCreationTokens: 0,
        inputSemantics: 1,
        createdAt: CREATED_AT,
        source: { filePath: '/tmp/rc.jsonl', line: 99 }
      })
    )
    const detail = db.prepare('SELECT cost_usd FROM usage_records').get() as { cost_usd: string | null }
    expect(detail.cost_usd).toBe(expected)
    expect(detail.cost_usd).toBe('0.045')

    const rollup = db.prepare('SELECT cost_usd FROM usage_daily_rollups').get() as { cost_usd: string }
    expect(rollup.cost_usd).toBe('0.045')
  })

  it('幂等：重算一致后二次调用 updated=0，明细与聚合不再变化', async () => {
    const { storage, db } = makeDb()
    const svc = await makeSeededSvc(storage)
    await storage.recordUsage([
      makeRecord({
        appType: 'codex',
        model: 'gpt-5',
        inputTokens: 100_000,
        outputTokens: 1_000,
        cacheReadTokens: 80_000,
        inputSemantics: 1,
        costUsd: '0.145',
        createdAt: CREATED_AT,
        source: { filePath: '/tmp/rc.jsonl', line: 1 }
      })
    ])
    await recalcCachedInputCosts(db, svc)
    const snapshot = () => ({
      details: db.prepare('SELECT * FROM usage_records ORDER BY id').all(),
      rollups: db.prepare('SELECT * FROM usage_daily_rollups ORDER BY date, app_type, model').all()
    })
    const before = snapshot()

    const second = await recalcCachedInputCosts(db, svc)

    expect(second).toEqual({ scanned: 1, updated: 0 })
    expect(snapshot()).toEqual(before)
  })

  it('扫描范围仅限 codex/gemini/grok：opencode/claude 行不计入 scanned 且不改动', async () => {
    const { storage, db } = makeDb()
    const svc = await makeSeededSvc(storage)
    insertLegacyRow(db, {
      id: 'opencode:/o.jsonl:1',
      app_type: 'opencode',
      model: 'qwen3-coder-plus',
      input_semantics: 1,
      input_tokens: 5000,
      cost_usd: '0.5'
    })
    insertLegacyRow(db, {
      id: 'claude:/c.jsonl:1',
      app_type: 'claude',
      model: 'claude-sonnet-4-5',
      input_semantics: 1,
      input_tokens: 5000,
      cost_usd: '0.5'
    })
    insertLegacyRow(db, {
      id: 'grok:/g.jsonl:1',
      app_type: 'grok',
      model: 'grok-4',
      input_semantics: 1,
      input_tokens: 50_000,
      output_tokens: 500,
      cache_read_tokens: 40_000,
      cost_usd: '0.07175'
    })

    const result = await recalcCachedInputCosts(db, svc)

    expect(result.scanned).toBe(1)
    expect(result.updated).toBe(1)
    const byId = new Map(
      (db.prepare('SELECT id, cost_usd FROM usage_records').all() as { id: string; cost_usd: string | null }[]).map(
        (r) => [r.id, r.cost_usd]
      )
    )
    expect(byId.get('grok:/g.jsonl:1')).toBe('0.02175')
    expect(byId.get('opencode:/o.jsonl:1')).toBe('0.5')
    expect(byId.get('claude:/c.jsonl:1')).toBe('0.5')
  })

  it('无价模型行跳过：计入 scanned 但不更新', async () => {
    const { storage, db } = makeDb()
    const svc = await makeSeededSvc(storage)
    insertLegacyRow(db, {
      id: 'codex:/x.jsonl:1',
      app_type: 'codex',
      model: 'no-such-model-xyz',
      input_semantics: 1,
      input_tokens: 5000,
      cost_usd: '0.123'
    })

    const result = await recalcCachedInputCosts(db, svc)

    expect(result).toEqual({ scanned: 1, updated: 0 })
    const detail = db.prepare('SELECT cost_usd FROM usage_records').get() as { cost_usd: string | null }
    expect(detail.cost_usd).toBe('0.123')
  })

  it('四档全零定价跳过：视为免费模型不回写', async () => {
    const { storage, db } = makeDb()
    await storage.updateModelPricing({
      model_id: 'free-model',
      provider: 'test',
      input_per_million: 0,
      output_per_million: 0,
      cache_read_per_million: 0,
      cache_creation_per_million: 0,
      currency: 'USD',
      cost_multiplier: 1,
      updated_at: 111
    }, 'user')
    const svc = await makeSeededSvc(storage)
    insertLegacyRow(db, {
      id: 'gemini:/f.jsonl:1',
      app_type: 'gemini',
      model: 'free-model',
      input_semantics: 1,
      input_tokens: 5000,
      cost_usd: '0.2'
    })

    const result = await recalcCachedInputCosts(db, svc)

    expect(result).toEqual({ scanned: 1, updated: 0 })
    const detail = db.prepare('SELECT cost_usd FROM usage_records').get() as { cost_usd: string | null }
    expect(detail.cost_usd).toBe('0.2')
  })

  it('rollup 行缺失时不创建：明细仍更新且不崩', async () => {
    const { storage, db } = makeDb()
    const svc = await makeSeededSvc(storage)
    insertLegacyRow(db, {
      id: 'codex:/y.jsonl:1',
      app_type: 'codex',
      model: 'gpt-5',
      input_semantics: 1,
      input_tokens: 100_000,
      output_tokens: 1_000,
      cache_read_tokens: 80_000,
      cost_usd: '0.145'
    })
    expect(db.prepare('SELECT COUNT(*) AS c FROM usage_daily_rollups').get() as { c: number }).toMatchObject({ c: 0 })

    const result = await recalcCachedInputCosts(db, svc)

    expect(result).toEqual({ scanned: 1, updated: 1 })
    const detail = db.prepare('SELECT cost_usd FROM usage_records').get() as { cost_usd: string | null }
    expect(detail.cost_usd).toBe('0.045')
    expect(db.prepare('SELECT COUNT(*) AS c FROM usage_daily_rollups').get() as { c: number }).toMatchObject({ c: 0 })
  })
})

describe('匹配索引降复杂度一致性', () => {
  function oracleHasBoundaryChar(ch: string | undefined): boolean {
    return ch === '-' || ch === '.' || /\d/.test(ch ?? '')
  }

  function oracleShortIdPrefix(
    map: Map<string, ModelPricingRow>,
    id: string
  ): ModelPricingRow | undefined {
    let best: ModelPricingRow | undefined
    let bestLen = -1
    for (const [key, row] of map) {
      if (id.length <= key.length || key.length <= bestLen) continue
      if (!id.startsWith(key)) continue
      if (!oracleHasBoundaryChar(id[key.length])) continue
      best = row
      bestLen = key.length
    }
    return best
  }

  function oracleMatchPrice(
    map: Map<string, ModelPricingRow>,
    model: string
  ): ModelPricingRow | undefined {
    const exact = map.get(model)
    if (exact) return exact
    const dotted = model.replace(/\./g, '-')
    const viaDotsExact = dotted !== model ? map.get(dotted) : undefined
    if (viaDotsExact) return viaDotsExact
    const prefixed =
      oracleShortIdPrefix(map, model) ??
      (dotted !== model ? oracleShortIdPrefix(map, dotted) : undefined)
    if (prefixed) return prefixed
    if (model.length < 3) return undefined
    let fallback: ModelPricingRow | undefined
    let fallbackKey = ''
    for (const [key, row] of map) {
      if (model.length >= key.length || !key.startsWith(model)) continue
      if (!oracleHasBoundaryChar(key[model.length])) continue
      if (
        !fallback ||
        key.length < fallbackKey.length ||
        (key.length === fallbackKey.length && key < fallbackKey)
      ) {
        fallback = row
        fallbackKey = key
      }
    }
    return fallback
  }

  async function expectOracleAgreement(storage: StorageService, queries: string[]): Promise<void> {
    const svc = createPricingService(storage)
    const rows = await storage.getModelPricing()
    const map = new Map<string, ModelPricingRow>()
    for (const row of rows) map.set(normalizeModelId(row.model_id), row)
    for (const query of queries) {
      expect(await svc.getPrice(query)).toEqual(oracleMatchPrice(map, normalizeModelId(query)))
    }
  }

  it('seed 全表：各级匹配（精确/dotted 精确/短 ID/家族兜底）与 O(n) 原实现逐条一致', async () => {
    const storage = openStorage(':memory:')
    await seedPricing(storage)
    await expectOracleAgreement(storage, [
      'claude-sonnet-4-5',
      'Anthropic/CLAUDE-SONNET-4-5-20250929',
      'claude-opus-4.5',
      'gemini-2.5-pro',
      'claude-sonnet-4[1m]',
      'gpt-4o-latest',
      'gemini-2.5-flash-001',
      'gemini-2-5-pro-001',
      'grok-4-fast-reasoning-xhigh',
      'kimi-k2-thinking-turbo-high',
      'glm-5-xhigh',
      'minimax-m2.7-extra',
      'deepseek-chat-v3',
      'qwen-plus-latest',
      'o4-mini-fast',
      'gpt',
      'codex',
      'claude',
      'ab',
      'unknown-model-xyz'
    ])
  })

  it('seed 全表关键语义锚定：家族最短同长取字典序、横线式查询点号表不误配', async () => {
    const storage = openStorage(':memory:')
    await seedPricing(storage)
    const svc = createPricingService(storage)
    expect((await svc.getPrice('claude'))?.model_id).toBe('claude-opus-4')
    expect((await svc.getPrice('gpt'))?.model_id).toBe('gpt-5')
    expect((await svc.getPrice('codex'))?.model_id).toBe('codex-mini-latest')
    expect(await svc.getPrice('gemini-2-5-pro-001')).toBeUndefined()
  })

  it('合成表：短 ID 最长优先、数字/点边界、家族同长字典序与 O(n) 原实现一致', async () => {
    const storage = openStorage(':memory:')
    const makeRow = (modelId: string, inputPerMillion: number): ModelPricingRow => ({
      model_id: modelId,
      provider: 'test',
      input_per_million: inputPerMillion,
      output_per_million: inputPerMillion * 2,
      cache_read_per_million: 0,
      cache_creation_per_million: 0,
      currency: 'USD',
      cost_multiplier: 1,
      updated_at: 1
    })
    await storage.updateModelPricing(makeRow('key-b-extra', 2), 'user')
    await storage.updateModelPricing(makeRow('key-a', 1), 'user')
    await storage.updateModelPricing(makeRow('fam-m', 3), 'user')
    await storage.updateModelPricing(makeRow('fam-z', 4), 'user')
    await storage.updateModelPricing(makeRow('fam-zz', 5), 'user')
    await storage.updateModelPricing(makeRow('alpha.beta', 6), 'user')
    await storage.updateModelPricing(makeRow('alpha-beta', 7), 'user')
    await storage.updateModelPricing(makeRow('m1', 8), 'user')
    await storage.updateModelPricing(makeRow('m1-sub', 9), 'user')
    await storage.updateModelPricing(makeRow('v2', 10), 'user')
    await storage.updateModelPricing(makeRow('v25', 11), 'user')

    await expectOracleAgreement(storage, [
      'key',
      'key-b',
      'fam',
      'fam-m2',
      'alpha.beta.x',
      'alpha-beta.x',
      'alpha-betax',
      'm1-long',
      'm1-sub2',
      'v25x',
      'v25-1',
      'ke',
      'KEY-A',
      'zzz'
    ])

    const svc = createPricingService(storage)
    expect((await svc.getPrice('m1-sub2'))?.input_per_million).toBe(9)
    expect((await svc.getPrice('v25x'))?.input_per_million).toBe(10)
    expect((await svc.getPrice('fam'))?.input_per_million).toBe(3)
    expect((await svc.getPrice('alpha.beta.x'))?.input_per_million).toBe(6)
  })

  it('invalidateCache 重建排序索引后新增/删除定价即时生效（短 ID 与家族路径）', async () => {
    const storage = openStorage(':memory:')
    const makeRow = (modelId: string, inputPerMillion: number): ModelPricingRow => ({
      model_id: modelId,
      provider: 'test',
      input_per_million: inputPerMillion,
      output_per_million: inputPerMillion * 2,
      cache_read_per_million: 0,
      cache_creation_per_million: 0,
      currency: 'USD',
      cost_multiplier: 1,
      updated_at: 1
    })
    const svc = createPricingService(storage) as PricingServiceImpl
    expect(await svc.getPrice('bnm-1')).toBeUndefined()

    await storage.updateModelPricing(makeRow('bnm', 42), 'user')
    svc.invalidateCache()
    expect((await svc.getPrice('bnm-1'))?.input_per_million).toBe(42)
    expect(await svc.getPrice('bnmx')).toBeUndefined()

    await storage.deleteModelPricing('bnm')
    svc.invalidateCache()
    expect(await svc.getPrice('bnm-1')).toBeUndefined()
  })
})

describe('calcCostBatch', () => {
  async function makeSeededSvc() {
    const storage = openStorage(':memory:')
    await seedPricing(storage)
    return { storage, svc: createPricingService(storage) as PricingServiceImpl }
  }

  it('混合用例（semantics=0/1/2、扣穿、无价、raw 归一化、dotted、effort）与逐条 calcCost 深度相等', async () => {
    const { svc } = await makeSeededSvc()
    const records = [
      makeRecord({
        model: 'claude-sonnet-4-5',
        inputTokens: 1000,
        outputTokens: 2000,
        cacheReadTokens: 3000,
        inputSemantics: 2
      }),
      makeRecord({
        appType: 'codex',
        model: 'gpt-5',
        inputTokens: 100_000,
        outputTokens: 1000,
        cacheReadTokens: 80_000,
        inputSemantics: 1
      }),
      makeRecord({
        model: 'claude-sonnet-4-5',
        inputTokens: 1000,
        outputTokens: 2000,
        cacheReadTokens: 3000,
        cacheCreationTokens: 2000,
        inputSemantics: 1
      }),
      makeRecord({
        model: 'claude-sonnet-4-5',
        inputTokens: 1000,
        cacheReadTokens: 800,
        inputSemantics: 0
      }),
      makeRecord({ model: 'unknown-model-xyz', inputTokens: 100, inputSemantics: 1 }),
      makeRecord({
        model: 'anthropic/claude-sonnet-4-5-20250929',
        inputTokens: 1000,
        inputSemantics: 2
      }),
      makeRecord({ model: 'claude-opus-4.5', inputTokens: 1000, inputSemantics: 2 }),
      makeRecord({ model: 'gpt-5-high', inputTokens: 1000, inputSemantics: 2 }),
      makeRecord({ model: 'gemini-2.5-pro', inputTokens: 1_000_000, inputSemantics: 2 })
    ]

    const batched = await svc.calcCostBatch(records)
    const sequential = await Promise.all(records.map((r) => svc.calcCost(r)))

    expect(batched).toEqual(sequential)
    expect(batched[0]).toBe('0.0339')
    expect(batched[1]).toBe('0.045')
    expect(batched[2]).toBe('0.0384')
    expect(batched[3]).toBe('0.00324')
    expect(batched[4]).toBeUndefined()
    expect(batched[5]).toBe('0.003')
    expect(batched[6]).toBe('0.005')
    expect(batched[7]).toBe('0.00125')
    expect(batched[8]).toBe('1.25')
  })

  it('cost_multiplier 行为与逐条一致', async () => {
    const { storage, svc } = await makeSeededSvc()
    const row = (await svc.getPrice('claude-sonnet-4-5')) as ModelPricingRow
    await storage.updateModelPricing({ ...row, cost_multiplier: 2, updated_at: Date.now() })
    svc.invalidateCache()
    const records = [makeRecord({ inputTokens: 1000 }), makeRecord({ inputTokens: 2000 })]

    const batched = await svc.calcCostBatch(records)

    expect(batched).toEqual(['0.006', '0.012'])
  })

  it('确定性批量循环（120 条混合模型/语义）与逐条结果一致', async () => {
    const { svc } = await makeSeededSvc()
    const models = [
      'claude-sonnet-4-5',
      'gpt-5.1-xhigh',
      'grok-4-fast-reasoning',
      'gemini-2.5-flash-lite',
      'no-such-model'
    ]
    const bulk = Array.from({ length: 120 }, (_, i) =>
      makeRecord({
        model: models[i % models.length],
        inputTokens: i * 137,
        outputTokens: i * 31,
        cacheReadTokens: (i % 7) * 900,
        cacheCreationTokens: (i % 3) * 400,
        inputSemantics: i % 3,
        source: { filePath: '/tmp/bulk.jsonl', line: i + 1 }
      })
    )

    const batched = await svc.calcCostBatch(bulk)
    const sequential: (string | undefined)[] = []
    for (const record of bulk) sequential.push(await svc.calcCost(record))

    expect(batched).toEqual(sequential)
  })

  it('空数组返回空数组，且不触发索引构建外的额外查询', async () => {
    const { svc } = await makeSeededSvc()
    expect(await svc.calcCostBatch([])).toEqual([])
  })
})
