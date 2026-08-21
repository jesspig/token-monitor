import type { UsageRecord } from '../../../shared/dto'
import type { PricingService, StorageService } from '../../../shared/context'
import type { ModelPricingRow } from '../../../shared/tables'

/**
 * 常见供应商/包装前缀（剥离 provider:model / provider.model 形式时使用）。
 * 均为已知供应商名，不会出现在模型名内部，剥离安全。
 */
const PROVIDER_TOKENS = [
  'anthropic',
  'openai',
  'google',
  'googleai',
  'gemini',
  'x-ai',
  'xai',
  'grok',
  'deepseek',
  'meta',
  'mistral',
  'qwen',
  'openrouter',
  'bedrock',
  'azure',
  'amazon',
  'vertex-ai',
  'vertex_ai',
  'vertexai'
]

/**
 * 模型 ID 归一化（docs/concepts/pricing.md，自研规则，按序执行）：
 *
 * 1. 转小写（并 trim）；
 * 2. 去掉最后一个 `/` 之前的供应商前缀（anthropic/claude… → claude…）；
 * 3. 去掉 `:` 之后的后缀：`model:suffix → model`；
 *    若冒号前为已知供应商则保留冒号后（`provider:model → model`）；
 * 4. 去掉末尾 `[1m]`；
 * 5. `@` → `-`（OpenCode 风格 `@provider/model`），并去掉由此产生的开头 `-`；
 * 6. 去掉常见包装前缀（`provider.model` / `provider_model` → model）；
 * 7. 去掉版本/日期后缀（`-YYYY-MM-DD`、`-YYYYMMDD`）。
 */
export function normalizeModelId(raw: string): string {
  let id = (raw ?? '').trim().toLowerCase()
  if (!id) return ''

  // 2. 供应商前缀：去掉最后一个 '/' 之前的部分
  const lastSlash = id.lastIndexOf('/')
  if (lastSlash >= 0) id = id.slice(lastSlash + 1)

  // 3. ':' 后缀：model:suffix → model；provider:model → model
  const colonIdx = id.indexOf(':')
  if (colonIdx >= 0) {
    const head = id.slice(0, colonIdx)
    id = PROVIDER_TOKENS.includes(head) ? id.slice(colonIdx + 1) : head
  }

  // 4. 末尾 '[1m]'
  id = id.replace(/\[1m\]$/i, '')

  // 5. '@' → '-'，并去掉开头 '-'（@model → model）
  id = id.replace(/@/g, '-').replace(/^-+/, '')

  // 6. 常见包装前缀：provider.model / provider_model → model
  for (const p of PROVIDER_TOKENS) {
    if (id.startsWith(`${p}.`) || id.startsWith(`${p}_`)) {
      id = id.slice(p.length + 1)
      break
    }
  }

  // 7. 版本/日期后缀：-YYYY-MM-DD、-YYYYMMDD
  id = id.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '')

  return id
}

/**
 * 定价匹配（docs/concepts/pricing.md）：
 * 先精确匹配归一化模型 ID；未命中时按「短 ID 匹配带版本/后缀项」兜底
 * （如 gpt-4o-latest → gpt-4o、gemini-2-5-pro-001 → gemini-2-5-pro），
 * 命中要求请求 ID 以定价项为前缀且后继为边界字符（- / . / 数字），避免家族误配。
 */
function matchPrice(map: Map<string, ModelPricingRow>, model: string): ModelPricingRow | undefined {
  const exact = map.get(model)
  if (exact || !model) return exact

  let best: ModelPricingRow | undefined
  let bestLen = -1
  for (const [key, row] of map) {
    if (model.length <= key.length || key.length <= bestLen) continue
    if (!model.startsWith(key)) continue
    const boundary = model[key.length]
    if (boundary === '-' || boundary === '.' || /\d/.test(boundary)) {
      best = row
      bestLen = key.length
    }
  }
  return best
}

/** 微美元 → USD 字符串（与 storage 聚合口径一致：toFixed(6) 后去尾零） */
function toCostString(micro: number): string {
  return (micro / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0'
}

/** 内置模型定价 seed 项（价格为每百万 token USD 通用公开参考价） */
interface SeedModelDef {
  model_id: string
  provider: string
  input_per_million: number
  output_per_million: number
  cache_read_per_million: number
  cache_creation_per_million: number
}

/** 内置常见模型定价清单（docs/concepts/pricing.md「内置价格来源」；约 10 个，价格为公开参考价） */
const SEED_MODELS: SeedModelDef[] = [
  // Claude（Anthropic）
  {
    model_id: 'claude-opus-4-1',
    provider: 'anthropic',
    input_per_million: 15,
    output_per_million: 75,
    cache_read_per_million: 1.5,
    cache_creation_per_million: 18.75
  },
  {
    model_id: 'claude-sonnet-4-5',
    provider: 'anthropic',
    input_per_million: 3,
    output_per_million: 15,
    cache_read_per_million: 0.3,
    cache_creation_per_million: 3.75
  },
  {
    model_id: 'claude-3-5-haiku',
    provider: 'anthropic',
    input_per_million: 0.8,
    output_per_million: 4,
    cache_read_per_million: 0.08,
    cache_creation_per_million: 1
  },
  // OpenAI GPT
  {
    model_id: 'gpt-4.1',
    provider: 'openai',
    input_per_million: 2,
    output_per_million: 8,
    cache_read_per_million: 0.5,
    cache_creation_per_million: 2
  },
  {
    model_id: 'gpt-4o',
    provider: 'openai',
    input_per_million: 2.5,
    output_per_million: 10,
    cache_read_per_million: 1.25,
    cache_creation_per_million: 2.5
  },
  {
    model_id: 'gpt-4o-mini',
    provider: 'openai',
    input_per_million: 0.15,
    output_per_million: 0.6,
    cache_read_per_million: 0.075,
    cache_creation_per_million: 0.15
  },
  // Gemini（Google）
  {
    model_id: 'gemini-2-5-pro',
    provider: 'google',
    input_per_million: 1.25,
    output_per_million: 10,
    cache_read_per_million: 0.3125,
    cache_creation_per_million: 1.25
  },
  {
    model_id: 'gemini-2-5-flash',
    provider: 'google',
    input_per_million: 0.3,
    output_per_million: 2.5,
    cache_read_per_million: 0.075,
    cache_creation_per_million: 0.3
  },
  // Grok（xAI）
  {
    model_id: 'grok-4',
    provider: 'x-ai',
    input_per_million: 3,
    output_per_million: 15,
    cache_read_per_million: 0.3,
    cache_creation_per_million: 3
  },
  // DeepSeek
  {
    model_id: 'deepseek-chat',
    provider: 'deepseek',
    input_per_million: 0.27,
    output_per_million: 1.1,
    cache_read_per_million: 0.07,
    cache_creation_per_million: 0.27
  }
]

/**
 * 向 storage 写入内置模型定价（docs/concepts/pricing.md）。
 * 经 storage.updateModelPricing 逐条 upsert：已存在的 model_id 会被覆盖更新，
 * 不会产生重复行；未存在的则插入。
 */
export async function seedPricing(storage: StorageService): Promise<void> {
  const now = Date.now()
  for (const m of SEED_MODELS) {
    await storage.updateModelPricing({
      model_id: m.model_id,
      provider: m.provider,
      input_per_million: m.input_per_million,
      output_per_million: m.output_per_million,
      cache_read_per_million: m.cache_read_per_million,
      cache_creation_per_million: m.cache_creation_per_million,
      currency: 'USD',
      cost_multiplier: 1,
      updated_at: now
    })
  }
}

/**
 * 定价服务实现（对齐 shared/context.ts 的 PricingService 契约）。
 * 内存索引在首次查询时构建（模型→定价 Map，key 为归一化模型 ID），
 * 写入/删除定价后调用 invalidateCache() 使其失效。
 */
export class PricingServiceImpl implements PricingService {
  private priceMap: Map<string, ModelPricingRow> | null = null

  constructor(private readonly storage: StorageService) {}

  async normalizeModelId(rawModel: string): Promise<string> {
    return normalizeModelId(rawModel)
  }

  async getPrice(modelId: string): Promise<ModelPricingRow | undefined> {
    const map = await this.getPriceMap()
    return matchPrice(map, normalizeModelId(modelId))
  }

  /**
   * 估算费用（USD 字符串）：按归一化模型查价后，
   * 各 token 数 × 对应每百万价格求和（微美元整数精度，避免浮点误差）。
   * 未找到定价项返回 undefined。
   */
  async calcCost(record: UsageRecord): Promise<string | undefined> {
    const map = await this.getPriceMap()
    const pricing = matchPrice(map, normalizeModelId(record.model))
    if (!pricing) return undefined

    const mult = pricing.cost_multiplier ?? 1
    const micro = Math.round(
      record.inputTokens * pricing.input_per_million * mult +
        record.outputTokens * pricing.output_per_million * mult +
        record.cacheReadTokens * pricing.cache_read_per_million * mult +
        record.cacheCreationTokens * pricing.cache_creation_per_million * mult
    )
    return toCostString(micro)
  }

  /** 使内存索引失效（storage 定价写入/删除后调用，getModelPricing 变化后缓存即失效） */
  invalidateCache(): void {
    this.priceMap = null
  }

  private async getPriceMap(): Promise<Map<string, ModelPricingRow>> {
    if (this.priceMap) return this.priceMap
    const rows = await this.storage.getModelPricing()
    const map = new Map<string, ModelPricingRow>()
    for (const row of rows) {
      map.set(normalizeModelId(row.model_id), row)
    }
    this.priceMap = map
    return map
  }
}

/** 创建定价服务（返回实现 PricingService 接口的对象；如需刷新缓存可转 PricingServiceImpl 调 invalidateCache） */
export function createPricingService(storage: StorageService): PricingService {
  return new PricingServiceImpl(storage)
}
