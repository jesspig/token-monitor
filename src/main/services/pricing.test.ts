import { describe, it, expect } from 'vitest'
import type { UsageRecord } from '../../../shared/dto'
import type { ModelPricingRow } from '../../../shared/tables'
import {
  normalizeModelId,
  seedPricing,
  SEED_MODELS,
  createPricingService,
  PricingServiceImpl
} from './pricing'
import { openStorage } from './storage'

/** 构造一条可复用的测试用量记录 */
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
    // 数字版本不应被误伤
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

    // 用户以 'user' 来源手改 sonnet 行
    const sonnet = (await storage.getModelPricing()).find(
      (r) => r.model_id === 'claude-sonnet-4-5'
    ) as ModelPricingRow
    await storage.updateModelPricing(
      { ...sonnet, input_per_million: 99, updated_at: 123 },
      'user'
    )
    // grok 行被 models.dev 式 'sync' 写入干扰价（非 user 行可被覆盖）
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
    // 1000×3 + 2000×15 + 3000×0.3 = 33900 微美元 = 0.0339 USD
    const cost = await svc.calcCost(
      makeRecord({ model: 'claude-sonnet-4-5', inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 3000 })
    )
    expect(cost).toBe('0.0339')
  })

  it('calcCost 含 cache_creation 定价', async () => {
    const storage = openStorage(':memory:')
    await seedPricing(storage)
    const svc = createPricingService(storage)
    // 1000×3.75 = 3750 微美元 = 0.00375 USD
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
    // 1000×3×2 = 6000 微美元 = 0.006 USD
    expect(await svc.calcCost(makeRecord({ inputTokens: 1000 }))).toBe('0.006')
  })

  it('写入定价后需 invalidateCache 使内存索引失效', async () => {
    const storage = openStorage(':memory:')
    await seedPricing(storage)
    const svc = createPricingService(storage) as PricingServiceImpl
    expect((await svc.getPrice('claude-sonnet-4-5'))?.input_per_million).toBe(3)

    const row = (await svc.getPrice('claude-sonnet-4-5')) as ModelPricingRow
    await storage.updateModelPricing({ ...row, input_per_million: 4, updated_at: Date.now() })
    // 未失效前命中缓存旧值
    expect((await svc.getPrice('claude-sonnet-4-5'))?.input_per_million).toBe(3)
    svc.invalidateCache()
    expect((await svc.getPrice('claude-sonnet-4-5'))?.input_per_million).toBe(4)
  })
})
