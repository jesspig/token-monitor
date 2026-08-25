import type { UsageRecord } from '../../../shared/dto'
import type { PricingService, StorageService } from '../../../shared/context'
import type { AppType } from '../../../shared/app'
import type { ModelPricingRow, UsageRecordRow } from '../../../shared/tables'
import type { SqliteDatabase } from './db'

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
 * 7. 去掉版本/日期后缀（`-YYYY-MM-DD`、`-YYYYMMDD`）；
 * 8. 去掉 reasoning effort 后缀（`-low` / `-high` / `-xhigh`，单次）。
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

  // 8. reasoning effort 后缀：-low / -high / -xhigh（单次，$ 锚定防误伤 -highish 等）
  id = id.replace(/-(?:low|high|xhigh)$/, '')

  return id
}

/**
 * 家族兜底启用的最短请求 ID 长度：过短前缀（如单双字符）误配面太大，不回退。
 */
const MIN_FAMILY_MODEL_LENGTH = 3

/** 前缀后继边界判定：紧随前缀的字符须为分隔符（- / .）或数字，避免家族误配 */
function hasBoundaryChar(ch: string | undefined): boolean {
  return ch === '-' || ch === '.' || /\d/.test(ch ?? '')
}

/** 短 ID 前缀匹配：取最长前缀 key（如 gpt-4o-latest → gpt-4o），要求边界后继 */
function shortIdPrefix(map: Map<string, ModelPricingRow>, id: string): ModelPricingRow | undefined {
  let best: ModelPricingRow | undefined
  let bestLen = -1
  for (const [key, row] of map) {
    if (id.length <= key.length || key.length <= bestLen) continue
    if (!id.startsWith(key)) continue
    if (!hasBoundaryChar(id[key.length])) continue
    best = row
    bestLen = key.length
  }
  return best
}

/**
 * 定价匹配（docs/concepts/pricing.md），五级兜底链：
 * 1. 精确匹配归一化模型 ID；
 * 2. 点转横线变体的精确匹配（claude-sonnet-4.5 → claude-sonnet-4-5）：仅作查价尝试，
 *    不进入 normalizeModelId（Gemini 等官方 id 自带点号，无条件转换会破坏精确命中）；
 * 3. 短 ID 匹配带版本/后缀项（gpt-4o-latest → gpt-4o、gemini-2-5-pro-001 → gemini-2-5-pro）；
 * 4. 点转横线变体的短 ID 匹配（同规则作用于 dotted 变体）；
 * 5. 家族兜底：请求 ID 为某定价项的前缀时取最短 key（避免过专分档误配，同长取字典序），
 *    同样要求边界后继，且 model 长度 ≥ MIN_FAMILY_MODEL_LENGTH 才启用。
 *
 * 关键排序约束：点号变体的【精确】命中（级 2）必须先于一切前缀模糊匹配（级 3+），
 * 否则 claude-sonnet-4.5 会被短 ID 'claude-sonnet-4' 截胡（边界字符 '.' 通过判定），
 * 错配到上一代模型价格（如 opus-4.5 → opus-4，单价差 3 倍）。
 */
function matchPrice(map: Map<string, ModelPricingRow>, model: string): ModelPricingRow | undefined {
  // 级 1：原样精确
  const exact = map.get(model)
  if (exact) return exact

  // 级 2：点转横线变体的精确（必须先于短 ID 前缀，防 x.y 被 x 截胡）
  const dotted = model.replace(/\./g, '-')
  const viaDotsExact = dotted !== model ? map.get(dotted) : undefined
  if (viaDotsExact) return viaDotsExact

  // 级 3/4：短 ID 前缀（原样优先于 dotted 变体）
  const prefixed =
    shortIdPrefix(map, model) ?? (dotted !== model ? shortIdPrefix(map, dotted) : undefined)
  if (prefixed) return prefixed

  // 级 5 家族兜底：key 以 model 为前缀且后继为边界字符，取最短 key
  if (model.length < MIN_FAMILY_MODEL_LENGTH) return undefined
  let fallback: ModelPricingRow | undefined
  let fallbackKey = ''
  for (const [key, row] of map) {
    if (model.length >= key.length || !key.startsWith(model)) continue
    if (!hasBoundaryChar(key[model.length])) continue
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

/**
 * 内置常见模型定价清单（docs/concepts/pricing.md「内置价格来源」；价格为 USD 每百万 token）。
 *
 * - model_id 必须与各插件产出的归一化 id 原生形态一致：normalizeModelId 不做点→划转换，
 *   故 Gemini / OpenAI(5.x) / GLM / MiniMax 等官方 id 自带点号的按原样收录；
 *   Claude / xAI 别名系官方即横线式，照录。
 * - 价格来源：各厂商官方定价页（2026-08 核实）；分档价（OpenAI short/long context、
 *   Gemini/DeepSeek/Qwen/Grok 分段计价）取编程请求主力档。
 * - 缓存四档中无官方写入费的平台（Google 按存储时长计费、DeepSeek 自动缓存免费写入、
 *   Moonshot/Z.ai/Qwen 未列写入档）cache_creation 取 = input 的口径映射；
 *   OpenAI/xAI/Mistral 未列 write 档者按 1.25×input 公开惯例推算，
 *   少量无官方 cached 价的条目按平台惯例比例推算（明细见 T6 报告）。
 */
export const SEED_MODELS: SeedModelDef[] = [
  // Claude（Anthropic，platform.claude.com/docs/en/about-claude/pricing）
  {
    model_id: 'claude-fable-5',
    provider: 'anthropic',
    input_per_million: 10,
    output_per_million: 50,
    cache_read_per_million: 1,
    cache_creation_per_million: 12.5
  },
  {
    model_id: 'claude-opus-5',
    provider: 'anthropic',
    input_per_million: 5,
    output_per_million: 25,
    cache_read_per_million: 0.5,
    cache_creation_per_million: 6.25
  },
  {
    model_id: 'claude-opus-4-8',
    provider: 'anthropic',
    input_per_million: 5,
    output_per_million: 25,
    cache_read_per_million: 0.5,
    cache_creation_per_million: 6.25
  },
  {
    model_id: 'claude-opus-4-7',
    provider: 'anthropic',
    input_per_million: 5,
    output_per_million: 25,
    cache_read_per_million: 0.5,
    cache_creation_per_million: 6.25
  },
  {
    model_id: 'claude-opus-4-6',
    provider: 'anthropic',
    input_per_million: 5,
    output_per_million: 25,
    cache_read_per_million: 0.5,
    cache_creation_per_million: 6.25
  },
  {
    model_id: 'claude-opus-4-5',
    provider: 'anthropic',
    input_per_million: 5,
    output_per_million: 25,
    cache_read_per_million: 0.5,
    cache_creation_per_million: 6.25
  },
  {
    model_id: 'claude-opus-4-1',
    provider: 'anthropic',
    input_per_million: 15,
    output_per_million: 75,
    cache_read_per_million: 1.5,
    cache_creation_per_million: 18.75
  },
  {
    model_id: 'claude-opus-4',
    provider: 'anthropic',
    input_per_million: 15,
    output_per_million: 75,
    cache_read_per_million: 1.5,
    cache_creation_per_million: 18.75
  },
  {
    model_id: 'claude-sonnet-5',
    provider: 'anthropic',
    input_per_million: 2,
    output_per_million: 10,
    cache_read_per_million: 0.2,
    cache_creation_per_million: 2.5
  },
  {
    model_id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    input_per_million: 3,
    output_per_million: 15,
    cache_read_per_million: 0.3,
    cache_creation_per_million: 3.75
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
    model_id: 'claude-sonnet-4',
    provider: 'anthropic',
    input_per_million: 3,
    output_per_million: 15,
    cache_read_per_million: 0.3,
    cache_creation_per_million: 3.75
  },
  {
    model_id: 'claude-haiku-4-5',
    provider: 'anthropic',
    input_per_million: 1,
    output_per_million: 5,
    cache_read_per_million: 0.1,
    cache_creation_per_million: 1.25
  },
  {
    model_id: 'claude-haiku-3-5',
    provider: 'anthropic',
    input_per_million: 0.8,
    output_per_million: 4,
    cache_read_per_million: 0.08,
    cache_creation_per_million: 1
  },
  // 3.x 退役代际（官方定价页已除名，价格为退役前长期公开价，兼容历史日志）
  {
    model_id: 'claude-3-7-sonnet',
    provider: 'anthropic',
    input_per_million: 3,
    output_per_million: 15,
    cache_read_per_million: 0.3,
    cache_creation_per_million: 3.75
  },
  {
    model_id: 'claude-3-5-sonnet',
    provider: 'anthropic',
    input_per_million: 3,
    output_per_million: 15,
    cache_read_per_million: 0.3,
    cache_creation_per_million: 3.75
  },
  // OpenAI GPT（developers.openai.com/api/docs/pricing；gpt-5.6 系含官方 cache writes 档，
  // 其余模型 write 按 1.25×input 公开惯例推算；read 为官方 cached input 价）
  {
    model_id: 'gpt-5.6-sol',
    provider: 'openai',
    input_per_million: 4,
    output_per_million: 20,
    cache_read_per_million: 0.4,
    cache_creation_per_million: 5
  },
  {
    model_id: 'gpt-5.6-terra',
    provider: 'openai',
    input_per_million: 2,
    output_per_million: 12,
    cache_read_per_million: 0.2,
    cache_creation_per_million: 2.5
  },
  {
    model_id: 'gpt-5.6-luna',
    provider: 'openai',
    input_per_million: 0.2,
    output_per_million: 1.2,
    cache_read_per_million: 0.02,
    cache_creation_per_million: 0.25
  },
  {
    model_id: 'gpt-5.3-codex',
    provider: 'openai',
    input_per_million: 1.75,
    output_per_million: 14,
    cache_read_per_million: 0.175,
    cache_creation_per_million: 2.1875
  },
  {
    model_id: 'gpt-5.1',
    provider: 'openai',
    input_per_million: 1.25,
    output_per_million: 10,
    cache_read_per_million: 0.125,
    cache_creation_per_million: 1.5625
  },
  {
    model_id: 'gpt-5',
    provider: 'openai',
    input_per_million: 1.25,
    output_per_million: 10,
    cache_read_per_million: 0.125,
    cache_creation_per_million: 1.5625
  },
  {
    model_id: 'gpt-5-mini',
    provider: 'openai',
    input_per_million: 0.25,
    output_per_million: 2,
    cache_read_per_million: 0.025,
    cache_creation_per_million: 0.3125
  },
  {
    model_id: 'gpt-5-nano',
    provider: 'openai',
    input_per_million: 0.05,
    output_per_million: 0.4,
    cache_read_per_million: 0.005,
    cache_creation_per_million: 0.0625
  },
  {
    model_id: 'gpt-5-codex',
    provider: 'openai',
    input_per_million: 1.25,
    output_per_million: 10,
    cache_read_per_million: 0.125,
    cache_creation_per_million: 1.5625
  },
  {
    model_id: 'codex-mini-latest',
    provider: 'openai',
    input_per_million: 1.5,
    output_per_million: 6,
    cache_read_per_million: 0.375,
    cache_creation_per_million: 1.875
  },
  {
    model_id: 'gpt-4o',
    provider: 'openai',
    input_per_million: 2.5,
    output_per_million: 10,
    cache_read_per_million: 1.25,
    cache_creation_per_million: 3.125
  },
  {
    model_id: 'gpt-4o-mini',
    provider: 'openai',
    input_per_million: 0.15,
    output_per_million: 0.6,
    cache_read_per_million: 0.075,
    cache_creation_per_million: 0.1875
  },
  {
    model_id: 'gpt-4.1',
    provider: 'openai',
    input_per_million: 2,
    output_per_million: 8,
    cache_read_per_million: 0.5,
    cache_creation_per_million: 2.5
  },
  {
    model_id: 'gpt-4.1-mini',
    provider: 'openai',
    input_per_million: 0.4,
    output_per_million: 1.6,
    cache_read_per_million: 0.1,
    cache_creation_per_million: 0.5
  },
  {
    model_id: 'gpt-4.1-nano',
    provider: 'openai',
    input_per_million: 0.1,
    output_per_million: 0.4,
    cache_read_per_million: 0.025,
    cache_creation_per_million: 0.125
  },
  {
    model_id: 'o3',
    provider: 'openai',
    input_per_million: 2,
    output_per_million: 8,
    cache_read_per_million: 0.5,
    cache_creation_per_million: 2.5
  },
  {
    model_id: 'o3-mini',
    provider: 'openai',
    input_per_million: 1.1,
    output_per_million: 4.4,
    cache_read_per_million: 0.55,
    cache_creation_per_million: 1.375
  },
  {
    model_id: 'o4-mini',
    provider: 'openai',
    input_per_million: 1.1,
    output_per_million: 4.4,
    cache_read_per_million: 0.275,
    cache_creation_per_million: 1.375
  },
  {
    model_id: 'o1',
    provider: 'openai',
    input_per_million: 15,
    output_per_million: 60,
    cache_read_per_million: 7.5,
    cache_creation_per_million: 18.75
  },
  // Gemini（Google，ai.google.dev/gemini-api/docs/pricing；Standard 档；
  // Google 无一次性写入费（按存储时长另计），write 取 = input 口径；
  // 带 * 推算项见报告。id 保留官方点号形态以命中插件产出）
  {
    model_id: 'gemini-3.6-flash',
    provider: 'google',
    input_per_million: 1.5,
    output_per_million: 7.5,
    cache_read_per_million: 0.15,
    cache_creation_per_million: 1.5
  },
  {
    model_id: 'gemini-3.5-flash',
    provider: 'google',
    input_per_million: 1.5,
    output_per_million: 9,
    cache_read_per_million: 0.15,
    cache_creation_per_million: 1.5
  },
  {
    model_id: 'gemini-3.5-flash-lite',
    provider: 'google',
    input_per_million: 0.3,
    output_per_million: 2.5,
    cache_read_per_million: 0.03,
    cache_creation_per_million: 0.3
  },
  {
    model_id: 'gemini-3.1-pro-preview',
    provider: 'google',
    input_per_million: 2,
    output_per_million: 12,
    cache_read_per_million: 0.2,
    cache_creation_per_million: 2
  },
  {
    model_id: 'gemini-3-flash-preview',
    provider: 'google',
    input_per_million: 0.5,
    output_per_million: 3,
    cache_read_per_million: 0.05,
    cache_creation_per_million: 0.5
  },
  {
    model_id: 'gemini-2.5-pro',
    provider: 'google',
    input_per_million: 1.25,
    output_per_million: 10,
    cache_read_per_million: 0.3125,
    cache_creation_per_million: 1.25
  },
  {
    model_id: 'gemini-2.5-flash',
    provider: 'google',
    input_per_million: 0.3,
    output_per_million: 2.5,
    cache_read_per_million: 0.075,
    cache_creation_per_million: 0.3
  },
  {
    model_id: 'gemini-2.5-flash-lite',
    provider: 'google',
    input_per_million: 0.1,
    output_per_million: 0.4,
    cache_read_per_million: 0.025,
    cache_creation_per_million: 0.1
  },
  {
    model_id: 'gemini-2.0-flash',
    provider: 'google',
    input_per_million: 0.1,
    output_per_million: 0.4,
    cache_read_per_million: 0.025,
    cache_creation_per_million: 0.1
  },
  {
    model_id: 'gemini-2.0-flash-lite',
    provider: 'google',
    input_per_million: 0.075,
    output_per_million: 0.3,
    cache_read_per_million: 0.0075,
    cache_creation_per_million: 0.075
  },
  // Grok（xAI，docs.x.ai/developers/pricing，<200k prompt 档；
  // grok-3/grok-4/fast/code 各旧名为官方 alias，当前统一按所指向模型计费；
  // write 按 1.25×input 推算）
  {
    model_id: 'grok-4.6',
    provider: 'x-ai',
    input_per_million: 2,
    output_per_million: 6,
    cache_read_per_million: 0.5,
    cache_creation_per_million: 2.5
  },
  {
    model_id: 'grok-4.5',
    provider: 'x-ai',
    input_per_million: 2,
    output_per_million: 6,
    cache_read_per_million: 0.3,
    cache_creation_per_million: 2.5
  },
  {
    model_id: 'grok-4.3',
    provider: 'x-ai',
    input_per_million: 1.25,
    output_per_million: 2.5,
    cache_read_per_million: 0.2,
    cache_creation_per_million: 1.5625
  },
  {
    model_id: 'grok-4',
    provider: 'x-ai',
    input_per_million: 1.25,
    output_per_million: 2.5,
    cache_read_per_million: 0.2,
    cache_creation_per_million: 1.5625
  },
  {
    model_id: 'grok-4-fast-reasoning',
    provider: 'x-ai',
    input_per_million: 1.25,
    output_per_million: 2.5,
    cache_read_per_million: 0.2,
    cache_creation_per_million: 1.5625
  },
  {
    model_id: 'grok-4-fast-non-reasoning',
    provider: 'x-ai',
    input_per_million: 1.25,
    output_per_million: 2.5,
    cache_read_per_million: 0.2,
    cache_creation_per_million: 1.5625
  },
  {
    model_id: 'grok-4-1-fast-reasoning',
    provider: 'x-ai',
    input_per_million: 1.25,
    output_per_million: 2.5,
    cache_read_per_million: 0.2,
    cache_creation_per_million: 1.5625
  },
  {
    model_id: 'grok-4-1-fast-non-reasoning',
    provider: 'x-ai',
    input_per_million: 1.25,
    output_per_million: 2.5,
    cache_read_per_million: 0.2,
    cache_creation_per_million: 1.5625
  },
  {
    model_id: 'grok-3',
    provider: 'x-ai',
    input_per_million: 1.25,
    output_per_million: 2.5,
    cache_read_per_million: 0.2,
    cache_creation_per_million: 1.5625
  },
  {
    model_id: 'grok-3-mini',
    provider: 'x-ai',
    input_per_million: 1.25,
    output_per_million: 2.5,
    cache_read_per_million: 0.2,
    cache_creation_per_million: 1.5625
  },
  {
    model_id: 'grok-build-0.1',
    provider: 'x-ai',
    input_per_million: 1,
    output_per_million: 2,
    cache_read_per_million: 0.2,
    cache_creation_per_million: 1.25
  },
  {
    model_id: 'grok-code-fast-1',
    provider: 'x-ai',
    input_per_million: 1,
    output_per_million: 2,
    cache_read_per_million: 0.2,
    cache_creation_per_million: 1.25
  },
  {
    model_id: 'grok-code-fast',
    provider: 'x-ai',
    input_per_million: 1,
    output_per_million: 2,
    cache_read_per_million: 0.2,
    cache_creation_per_million: 1.25
  },
  // DeepSeek（api-docs.deepseek.com/quick_start/pricing；peak 档，off-peak 减半；
  // 自动磁盘缓存无写入费，write 取 = input 口径）
  {
    model_id: 'deepseek-v4-flash',
    provider: 'deepseek',
    input_per_million: 0.44,
    output_per_million: 1.32,
    cache_read_per_million: 0.014,
    cache_creation_per_million: 0.44
  },
  {
    model_id: 'deepseek-v4-pro',
    provider: 'deepseek',
    input_per_million: 1.32,
    output_per_million: 3.96,
    cache_read_per_million: 0.044,
    cache_creation_per_million: 1.32
  },
  // chat/reasoner 旧别名（V3.1-Terminus 期最后公开存档价，2025-09）
  {
    model_id: 'deepseek-chat',
    provider: 'deepseek',
    input_per_million: 0.56,
    output_per_million: 1.68,
    cache_read_per_million: 0.07,
    cache_creation_per_million: 0.56
  },
  {
    model_id: 'deepseek-reasoner',
    provider: 'deepseek',
    input_per_million: 0.56,
    output_per_million: 1.68,
    cache_read_per_million: 0.07,
    cache_creation_per_million: 0.56
  },
  // Qwen（阿里云百炼国际站 USD 价，alibabacloud.com/help/en/model-studio/model-pricing；
  // 分段计价取最低档；write 取 = input 口径；cached 价除 coder 外按 implicit-cache
  // 20% input 惯例推算，qwen3-coder-plus 为官方 cached 价）
  {
    model_id: 'qwen3-coder-plus',
    provider: 'qwen',
    input_per_million: 1,
    output_per_million: 5,
    cache_read_per_million: 0.1,
    cache_creation_per_million: 1
  },
  {
    model_id: 'qwen3.7-max',
    provider: 'qwen',
    input_per_million: 2.5,
    output_per_million: 7.5,
    cache_read_per_million: 0.5,
    cache_creation_per_million: 2.5
  },
  {
    model_id: 'qwen3-max',
    provider: 'qwen',
    input_per_million: 1.2,
    output_per_million: 6,
    cache_read_per_million: 0.24,
    cache_creation_per_million: 1.2
  },
  {
    model_id: 'qwen3.7-plus',
    provider: 'qwen',
    input_per_million: 0.4,
    output_per_million: 1.6,
    cache_read_per_million: 0.08,
    cache_creation_per_million: 0.4
  },
  {
    model_id: 'qwen-plus',
    provider: 'qwen',
    input_per_million: 0.4,
    output_per_million: 1.2,
    cache_read_per_million: 0.08,
    cache_creation_per_million: 0.4
  },
  // Kimi / Moonshot（platform.kimi.ai；未列写入档，write 取 = input 口径）
  {
    model_id: 'kimi-k3',
    provider: 'moonshot',
    input_per_million: 3,
    output_per_million: 15,
    cache_read_per_million: 0.3,
    cache_creation_per_million: 3
  },
  {
    model_id: 'kimi-k2.7-code',
    provider: 'moonshot',
    input_per_million: 0.95,
    output_per_million: 4,
    cache_read_per_million: 0.19,
    cache_creation_per_million: 0.95
  },
  {
    model_id: 'kimi-k2.6',
    provider: 'moonshot',
    input_per_million: 0.95,
    output_per_million: 4,
    cache_read_per_million: 0.16,
    cache_creation_per_million: 0.95
  },
  {
    model_id: 'kimi-k2-thinking-turbo',
    provider: 'moonshot',
    input_per_million: 1.15,
    output_per_million: 8,
    cache_read_per_million: 0.15,
    cache_creation_per_million: 1.15
  },
  {
    model_id: 'kimi-k2-thinking',
    provider: 'moonshot',
    input_per_million: 0.6,
    output_per_million: 2.5,
    cache_read_per_million: 0.15,
    cache_creation_per_million: 0.6
  },
  {
    model_id: 'kimi-k2-turbo',
    provider: 'moonshot',
    input_per_million: 1.15,
    output_per_million: 8,
    cache_read_per_million: 0.15,
    cache_creation_per_million: 1.15
  },
  {
    model_id: 'kimi-k2',
    provider: 'moonshot',
    input_per_million: 0.6,
    output_per_million: 2.5,
    cache_read_per_million: 0.15,
    cache_creation_per_million: 0.6
  },
  // GLM（Z.AI，docs.z.ai/guides/overview/pricing，USD；未列写入档，write 取 = input 口径）
  {
    model_id: 'glm-5.3',
    provider: 'z-ai',
    input_per_million: 1.4,
    output_per_million: 4.4,
    cache_read_per_million: 0.26,
    cache_creation_per_million: 1.4
  },
  {
    model_id: 'glm-5.2',
    provider: 'z-ai',
    input_per_million: 1.4,
    output_per_million: 4.4,
    cache_read_per_million: 0.26,
    cache_creation_per_million: 1.4
  },
  {
    model_id: 'glm-5.1',
    provider: 'z-ai',
    input_per_million: 1.4,
    output_per_million: 4.4,
    cache_read_per_million: 0.26,
    cache_creation_per_million: 1.4
  },
  {
    model_id: 'glm-5-turbo',
    provider: 'z-ai',
    input_per_million: 1.2,
    output_per_million: 4,
    cache_read_per_million: 0.24,
    cache_creation_per_million: 1.2
  },
  {
    model_id: 'glm-5',
    provider: 'z-ai',
    input_per_million: 1,
    output_per_million: 3.2,
    cache_read_per_million: 0.2,
    cache_creation_per_million: 1
  },
  {
    model_id: 'glm-4.7',
    provider: 'z-ai',
    input_per_million: 0.6,
    output_per_million: 2.2,
    cache_read_per_million: 0.11,
    cache_creation_per_million: 0.6
  },
  {
    model_id: 'glm-4.7-flashx',
    provider: 'z-ai',
    input_per_million: 0.07,
    output_per_million: 0.4,
    cache_read_per_million: 0.01,
    cache_creation_per_million: 0.07
  },
  {
    model_id: 'glm-4.7-flash',
    provider: 'z-ai',
    input_per_million: 0,
    output_per_million: 0,
    cache_read_per_million: 0,
    cache_creation_per_million: 0
  },
  {
    model_id: 'glm-4.6',
    provider: 'z-ai',
    input_per_million: 0.6,
    output_per_million: 2.2,
    cache_read_per_million: 0.11,
    cache_creation_per_million: 0.6
  },
  {
    model_id: 'glm-4.5',
    provider: 'z-ai',
    input_per_million: 0.6,
    output_per_million: 2.2,
    cache_read_per_million: 0.11,
    cache_creation_per_million: 0.6
  },
  {
    model_id: 'glm-4.5-x',
    provider: 'z-ai',
    input_per_million: 2.2,
    output_per_million: 8.9,
    cache_read_per_million: 0.45,
    cache_creation_per_million: 2.2
  },
  {
    model_id: 'glm-4.5-air',
    provider: 'z-ai',
    input_per_million: 0.2,
    output_per_million: 1.1,
    cache_read_per_million: 0.03,
    cache_creation_per_million: 0.2
  },
  {
    model_id: 'glm-4.5-airx',
    provider: 'z-ai',
    input_per_million: 1.1,
    output_per_million: 4.5,
    cache_read_per_million: 0.22,
    cache_creation_per_million: 1.1
  },
  {
    model_id: 'glm-4.5-flash',
    provider: 'z-ai',
    input_per_million: 0,
    output_per_million: 0,
    cache_read_per_million: 0,
    cache_creation_per_million: 0
  },
  // MiniMax（platform.minimax.io/docs/guides/pricing-paygo；M2.x 含官方 write 档，
  // M3 无 write 列取 = input；分段计价取 ≤512k 档）
  {
    model_id: 'minimax-m3',
    provider: 'minimax',
    input_per_million: 0.3,
    output_per_million: 1.2,
    cache_read_per_million: 0.06,
    cache_creation_per_million: 0.3
  },
  {
    model_id: 'minimax-m2.7',
    provider: 'minimax',
    input_per_million: 0.3,
    output_per_million: 1.2,
    cache_read_per_million: 0.06,
    cache_creation_per_million: 0.375
  },
  {
    model_id: 'minimax-m2.7-highspeed',
    provider: 'minimax',
    input_per_million: 0.6,
    output_per_million: 2.4,
    cache_read_per_million: 0.06,
    cache_creation_per_million: 0.375
  },
  {
    model_id: 'minimax-m2.5',
    provider: 'minimax',
    input_per_million: 0.3,
    output_per_million: 1.2,
    cache_read_per_million: 0.03,
    cache_creation_per_million: 0.375
  },
  {
    model_id: 'minimax-m2.5-highspeed',
    provider: 'minimax',
    input_per_million: 0.6,
    output_per_million: 2.4,
    cache_read_per_million: 0.03,
    cache_creation_per_million: 0.375
  },
  {
    model_id: 'minimax-m2.1',
    provider: 'minimax',
    input_per_million: 0.3,
    output_per_million: 1.2,
    cache_read_per_million: 0.03,
    cache_creation_per_million: 0.375
  },
  {
    model_id: 'minimax-m2.1-highspeed',
    provider: 'minimax',
    input_per_million: 0.6,
    output_per_million: 2.4,
    cache_read_per_million: 0.03,
    cache_creation_per_million: 0.375
  },
  {
    model_id: 'minimax-m2',
    provider: 'minimax',
    input_per_million: 0.3,
    output_per_million: 1.2,
    cache_read_per_million: 0.03,
    cache_creation_per_million: 0.375
  },
  // Mistral（mistral.ai/pricing；官方仅给输入/输出价，cached 与 write 均按
  // read=0.1×input、write=1.25×input 公开惯例推算）
  {
    model_id: 'mistral-medium-3.5',
    provider: 'mistral',
    input_per_million: 1.5,
    output_per_million: 7.5,
    cache_read_per_million: 0.15,
    cache_creation_per_million: 1.875
  },
  {
    model_id: 'mistral-large',
    provider: 'mistral',
    input_per_million: 0.5,
    output_per_million: 1.5,
    cache_read_per_million: 0.05,
    cache_creation_per_million: 0.625
  },
  {
    model_id: 'codestral',
    provider: 'mistral',
    input_per_million: 0.3,
    output_per_million: 0.9,
    cache_read_per_million: 0.03,
    cache_creation_per_million: 0.375
  }
]

/**
 * 向 storage 写入内置模型定价（docs/concepts/pricing.md）。
 * 构造全部行后经 storage.updateModelPricingBatch 单事务批量 upsert，来源标记为 'seed'：
 * 已存在的 seed/sync 行会被覆盖刷新（重启重播幂等），不会产生重复行；
 * 'user' 行受分级保护不被覆盖；未存在的则插入。
 */
export async function seedPricing(storage: StorageService): Promise<void> {
  const now = Date.now()
  const rows: ModelPricingRow[] = SEED_MODELS.map((m) => ({
    model_id: m.model_id,
    provider: m.provider,
    input_per_million: m.input_per_million,
    output_per_million: m.output_per_million,
    cache_read_per_million: m.cache_read_per_million,
    cache_creation_per_million: m.cache_creation_per_million,
    currency: 'USD',
    cost_multiplier: 1,
    updated_at: now
  }))
  await storage.updateModelPricingBatch(rows, 'seed')
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
   * 估算费用（USD 字符串）：按归一化模型查价后，各 token 数 × 对应每百万价格
   * 求和（微美元整数精度，避免浮点误差）。未找到定价项返回 undefined。
   *
   * 输入项按 record.inputSemantics 三态区分口径：
   * - 0（未知）：inputTokens 视为纯新输入，全额按 input 价计费；
   * - 1（含缓存总量）：inputTokens 为含缓存的 prompt 总量，先扣除
   *   cacheReadTokens + cacheCreationTokens 得到纯新输入再计费；
   * - 2（纯新输入）：同 0，全额计费。
   *
   * 五源实际口径：claude / opencode 上游已扣减缓存（=2，不扣）；
   * codex / gemini / grok 的 input_tokens 为含缓存总量（=1，扣 read+write，
   * 三源的 write 桶实际恒为 0）。Math.max(0, …) 防御上游异常导致的负数。
   * cost_multiplier 保持逐项相乘。
   */
  async calcCost(record: UsageRecord): Promise<string | undefined> {
    const map = await this.getPriceMap()
    const pricing = matchPrice(map, normalizeModelId(record.model))
    if (!pricing) return undefined

    const mult = pricing.cost_multiplier ?? 1
    const freshInput =
      record.inputSemantics === 1
        ? Math.max(0, record.inputTokens - record.cacheReadTokens - record.cacheCreationTokens)
        : record.inputTokens
    const micro = Math.round(
      freshInput * pricing.input_per_million * mult +
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

const MICRO_PER_USD = 1_000_000

/** USD 字符串 → 整数微美元（与 storage.ts 聚合口径一致：round(n × 1e6)，空/非法视 0） */
function toMicroUsd(costUsd?: string | null): number {
  if (costUsd == null || costUsd === '') return 0
  const n = Number(costUsd)
  return Number.isFinite(n) ? Math.round(n * MICRO_PER_USD) : 0
}

/** epoch ms → YYYY-MM-DD（本地时区，与 storage.ts 日聚合归桶规则一致） */
function toDateKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 零成本回填结果统计 */
export interface BackfillResult {
  /** 扫描到的候选明细行数（cost 为空或 '0'，含因无价被跳过的行） */
  scanned: number
  /** 实际重算并更新费用的明细行数 */
  updated: number
}

/** 阶段一产出的待应用更新（阶段二在事务内消费） */
interface PendingCostUpdate {
  id: string
  newCost: string
  deltaMicro: number
  dateKey: string
  appType: AppType
  model: string
}

/**
 * 零成本回填（docs/concepts/pricing.md）：扫描 cost_usd 为空或 '0' 的历史明细，
 * 按当前定价重算费用并回写；同时把费用差额增量累加到对应 (date, app_type, model)
 * 日聚合行，维持不变量「rollup.cost_usd ≡ 组内全部明细 cost 之和」。
 * rollup 行不存在时不创建（该组明细已被保留策略清理，无需维护聚合）。
 *
 * 参数取 SqliteDatabase + PricingService 最小组合：SqliteStorage 不暴露 db 句柄，
 * 由持有两者的调用方注入，避免反向耦合存储实现。
 *
 * 分两阶段执行：PricingService 为异步签名而 better-sqlite3 事务回调必须同步，
 * 故在事务外完成取价与费用计算，全部写操作在单个同步事务内原子提交；
 * UPDATE 附带「仍为零成本」守卫，防止覆盖并发写入的真实费用。
 *
 * 幂等：更新后明细不再命中候选条件，重复调用 updated = 0。
 */
export async function backfillZeroCost(
  db: SqliteDatabase,
  pricing: PricingService
): Promise<BackfillResult> {
  const candidates = db
    .prepare(
      `
      SELECT id, app_type, model, input_tokens, output_tokens,
             cache_read_tokens, cache_creation_tokens, input_semantics,
             cost_usd, created_at, file_path, line
      FROM usage_records
      WHERE cost_usd IS NULL OR cost_usd = '0'
      `
    )
    .all() as Pick<
    UsageRecordRow,
    | 'id'
    | 'app_type'
    | 'model'
    | 'input_tokens'
    | 'output_tokens'
    | 'cache_read_tokens'
    | 'cache_creation_tokens'
    | 'input_semantics'
    | 'cost_usd'
    | 'created_at'
    | 'file_path'
    | 'line'
  >[]

  // 阶段一（事务外）：逐行查价并重算费用。rollup 归桶用 model 原值（与 recordUsage 一致），计费才归一化。
  const pending: PendingCostUpdate[] = []
  for (const row of candidates) {
    const priced = await pricing.getPrice(normalizeModelId(row.model))
    if (!priced) continue
    const allFree =
      priced.input_per_million === 0 &&
      priced.output_per_million === 0 &&
      priced.cache_read_per_million === 0 &&
      priced.cache_creation_per_million === 0
    if (allFree) continue

    const newCost = await pricing.calcCost({
      appType: row.app_type,
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheCreationTokens: row.cache_creation_tokens,
      inputSemantics: row.input_semantics,
      createdAt: row.created_at,
      source: { filePath: row.file_path, line: row.line }
    })
    const newMicro = toMicroUsd(newCost)
    if (newCost == null || newMicro === 0) continue

    pending.push({
      id: row.id,
      newCost,
      deltaMicro: newMicro - toMicroUsd(row.cost_usd),
      dateKey: toDateKey(row.created_at),
      appType: row.app_type,
      model: row.model
    })
  }

  // 阶段二：单同步事务内原子更新明细与日聚合
  let updated = 0
  if (pending.length > 0) {
    const updateRecordStmt = db.prepare(
      `
      UPDATE usage_records SET cost_usd = ?
      WHERE id = ? AND (cost_usd IS NULL OR cost_usd = '0')
      `
    )
    const getRollupStmt = db.prepare(
      `
      SELECT cost_usd FROM usage_daily_rollups
      WHERE date = ? AND app_type = ? AND model = ?
      `
    )
    const updateRollupStmt = db.prepare(
      `
      UPDATE usage_daily_rollups SET cost_usd = ?, updated_at = ?
      WHERE date = ? AND app_type = ? AND model = ?
      `
    )
    const runTx = db.transaction((items: PendingCostUpdate[], now: number) => {
      for (const p of items) {
        const info = updateRecordStmt.run(p.newCost, p.id)
        if (info.changes === 0) continue
        updated++
        const rollup = getRollupStmt.get(p.dateKey, p.appType, p.model) as
          | { cost_usd: string }
          | undefined
        if (!rollup) continue
        updateRollupStmt.run(
          toCostString(toMicroUsd(rollup.cost_usd) + p.deltaMicro),
          now,
          p.dateKey,
          p.appType,
          p.model
        )
      }
    })
    runTx(pending, Date.now())
  }

  return { scanned: candidates.length, updated }
}

/** 缓存口径存量重算结果统计 */
export interface RecalcResult {
  /** 扫描到的候选明细行数（codex/gemini/grok 且 semantics=1，含因无价或重算一致被跳过的行） */
  scanned: number
  /** 实际更新费用的明细行数 */
  updated: number
}

/** 重算产出的待应用更新：在通用字段上追加旧费用原值，供阶段二乐观守卫 NULL 安全比对 */
interface PendingRecalcUpdate extends PendingCostUpdate {
  oldCostUsd: string | null
}

/**
 * 存量缓存口径费用重算：计费语义修复前，codex/gemini/grok 三源历史明细
 * （input 为含缓存总量，semantics=1）按「input 全额计价」被系统性高估；
 * 本函数扫描这三源的 semantics=1 行，以新公式（calcCost 内先扣减
 * cacheRead+cacheCreation 再计价）按当前活定价重算并回写，同时把差额增量
 * 累加到对应 (date, app_type, model) 日聚合，维持不变量
 * 「rollup.cost_usd ≡ 组内全部明细 cost 之和」。rollup 行不存在时不创建。
 *
 * 触发时机：宿主启动序列异步调用一次。定价随 models.dev 同步持续漂移，
 * 而迁移函数为同步纯 SQL 拿不到活定价，故不在 v4 迁移内做（opencode 的
 * semantics 错标则由 v4 迁移直接修正）；公式级修复执行一次即可，
 * 不挂进 models.dev 同步链路。
 *
 * 幂等：重算值与现值一致（delta = 0）即跳过，不产生任何写入，
 * 后续重复调用 updated = 0。候选行 semantics 不改写，重复扫描无害。
 *
 * 两阶段结构与守卫同 backfillZeroCost：阶段一在事务外逐行取价与计算，
 * 阶段二单同步事务原子提交；UPDATE 附带 cost_usd 原值的 IS 守卫
 * （NULL 与非 NULL 统一判定），防止覆盖并发写入的真实费用。
 */
export async function recalcCachedInputCosts(
  db: SqliteDatabase,
  pricing: PricingService
): Promise<RecalcResult> {
  const candidates = db
    .prepare(
      `
      SELECT id, app_type, model, input_tokens, output_tokens,
             cache_read_tokens, cache_creation_tokens, input_semantics,
             cost_usd, created_at, file_path, line
      FROM usage_records
      WHERE app_type IN ('codex', 'gemini', 'grok') AND input_semantics = 1
      `
    )
    .all() as Pick<
    UsageRecordRow,
    | 'id'
    | 'app_type'
    | 'model'
    | 'input_tokens'
    | 'output_tokens'
    | 'cache_read_tokens'
    | 'cache_creation_tokens'
    | 'input_semantics'
    | 'cost_usd'
    | 'created_at'
    | 'file_path'
    | 'line'
  >[]

  // 阶段一（事务外）：逐行查价并按新公式重算费用。rollup 归桶用 model 原值（与 recordUsage 一致），计费才归一化。
  const pending: PendingRecalcUpdate[] = []
  for (const row of candidates) {
    const priced = await pricing.getPrice(normalizeModelId(row.model))
    if (!priced) continue
    const allFree =
      priced.input_per_million === 0 &&
      priced.output_per_million === 0 &&
      priced.cache_read_per_million === 0 &&
      priced.cache_creation_per_million === 0
    if (allFree) continue

    const newCost = await pricing.calcCost({
      appType: row.app_type,
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheCreationTokens: row.cache_creation_tokens,
      inputSemantics: row.input_semantics,
      createdAt: row.created_at,
      source: { filePath: row.file_path, line: row.line }
    })
    if (newCost == null) continue

    const newMicro = toMicroUsd(newCost)
    const oldMicro = toMicroUsd(row.cost_usd)
    // 重算一致即跳过：幂等关键，不产生任何写入
    if (newMicro === oldMicro) continue

    pending.push({
      id: row.id,
      newCost,
      deltaMicro: newMicro - oldMicro,
      dateKey: toDateKey(row.created_at),
      appType: row.app_type,
      model: row.model,
      oldCostUsd: row.cost_usd
    })
  }

  // 阶段二：单同步事务内原子更新明细与日聚合；IS 守卫对旧值 NULL/非 NULL 统一成立
  let updated = 0
  if (pending.length > 0) {
    const updateRecordStmt = db.prepare(
      `
      UPDATE usage_records SET cost_usd = ?
      WHERE id = ? AND cost_usd IS ?
      `
    )
    const getRollupStmt = db.prepare(
      `
      SELECT cost_usd FROM usage_daily_rollups
      WHERE date = ? AND app_type = ? AND model = ?
      `
    )
    const updateRollupStmt = db.prepare(
      `
      UPDATE usage_daily_rollups SET cost_usd = ?, updated_at = ?
      WHERE date = ? AND app_type = ? AND model = ?
      `
    )
    const runTx = db.transaction((items: PendingRecalcUpdate[], now: number) => {
      for (const p of items) {
        const info = updateRecordStmt.run(p.newCost, p.id, p.oldCostUsd)
        if (info.changes === 0) continue
        updated++
        const rollup = getRollupStmt.get(p.dateKey, p.appType, p.model) as
          | { cost_usd: string }
          | undefined
        if (!rollup) continue
        updateRollupStmt.run(
          toCostString(toMicroUsd(rollup.cost_usd) + p.deltaMicro),
          now,
          p.dateKey,
          p.appType,
          p.model
        )
      }
    })
    runTx(pending, Date.now())
  }

  return { scanned: candidates.length, updated }
}
