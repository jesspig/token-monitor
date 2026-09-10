import type { UsageRecord } from '../../../shared/dto'
import type { PricingService, StorageService } from '../../../shared/context'
import type { AppType } from '../../../shared/app'
import type { ModelPricingRow, UsageRecordRow } from '../../../shared/tables'
import type { SqliteDatabase } from './db'

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

export function normalizeModelId(raw: string): string {
  let id = (raw ?? '').trim().toLowerCase()
  if (!id) return ''

  const lastSlash = id.lastIndexOf('/')
  if (lastSlash >= 0) id = id.slice(lastSlash + 1)

  const colonIdx = id.indexOf(':')
  if (colonIdx >= 0) {
    const head = id.slice(0, colonIdx)
    id = PROVIDER_TOKENS.includes(head) ? id.slice(colonIdx + 1) : head
  }

  id = id.replace(/\[1m\]$/i, '')

  id = id.replace(/@/g, '-').replace(/^-+/, '')

  for (const p of PROVIDER_TOKENS) {
    if (id.startsWith(`${p}.`) || id.startsWith(`${p}_`)) {
      id = id.slice(p.length + 1)
      break
    }
  }

  id = id.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '')

  id = id.replace(/-(?:low|high|xhigh)$/, '')

  return id
}

const MIN_FAMILY_MODEL_LENGTH = 3

function hasBoundaryChar(ch: string | undefined): boolean {
  return ch === '-' || ch === '.' || /\d/.test(ch ?? '')
}

interface PricingIndex {
  map: Map<string, ModelPricingRow>
  keys: string[]
}

function lowerBound(sortedKeys: string[], target: string): number {
  let lo = 0
  let hi = sortedKeys.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sortedKeys[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

function shortIdPrefix(index: PricingIndex, id: string): ModelPricingRow | undefined {
  const { map, keys } = index
  for (let len = id.length - 1; len >= 1; len--) {
    const key = id.slice(0, len)
    const idx = lowerBound(keys, key)
    if (idx >= keys.length || keys[idx] !== key) continue
    if (!hasBoundaryChar(id[len])) continue
    return map.get(key)
  }
  return undefined
}

function matchPrice(index: PricingIndex, model: string): ModelPricingRow | undefined {
  const { map, keys } = index

  const exact = map.get(model)
  if (exact) return exact

  const dotted = model.replace(/\./g, '-')
  const viaDotsExact = dotted !== model ? map.get(dotted) : undefined
  if (viaDotsExact) return viaDotsExact

  const prefixed =
    shortIdPrefix(index, model) ?? (dotted !== model ? shortIdPrefix(index, dotted) : undefined)
  if (prefixed) return prefixed

  if (model.length < MIN_FAMILY_MODEL_LENGTH) return undefined
  let fallback: ModelPricingRow | undefined
  let fallbackKey = ''
  for (let i = lowerBound(keys, model); i < keys.length; i++) {
    const key = keys[i]
    if (!key.startsWith(model)) break
    if (model.length >= key.length) continue
    if (!hasBoundaryChar(key[model.length])) continue
    if (
      !fallback ||
      key.length < fallbackKey.length ||
      (key.length === fallbackKey.length && key < fallbackKey)
    ) {
      fallback = map.get(key)
      fallbackKey = key
    }
  }
  return fallback
}

function toCostString(micro: number): string {
  return (micro / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0'
}

function computeCost(index: PricingIndex, record: UsageRecord): string | undefined {
  const pricing = matchPrice(index, normalizeModelId(record.model))
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

interface SeedModelDef {
  model_id: string
  provider: string
  input_per_million: number
  output_per_million: number
  cache_read_per_million: number
  cache_creation_per_million: number
}

export const SEED_MODELS: SeedModelDef[] = [
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

export class PricingServiceImpl implements PricingService {
  private priceIndex: PricingIndex | null = null

  constructor(private readonly storage: StorageService) {}

  async normalizeModelId(rawModel: string): Promise<string> {
    return normalizeModelId(rawModel)
  }

  async getPrice(modelId: string): Promise<ModelPricingRow | undefined> {
    const index = await this.getPriceIndex()
    return matchPrice(index, normalizeModelId(modelId))
  }

  async calcCost(record: UsageRecord): Promise<string | undefined> {
    const index = await this.getPriceIndex()
    return computeCost(index, record)
  }

  async calcCostBatch(records: UsageRecord[]): Promise<(string | undefined)[]> {
    if (records.length === 0) return []
    const index = await this.getPriceIndex()
    return records.map((record) => computeCost(index, record))
  }

  invalidateCache(): void {
    this.priceIndex = null
  }

  private async getPriceIndex(): Promise<PricingIndex> {
    if (this.priceIndex) return this.priceIndex
    const rows = await this.storage.getModelPricing()
    const map = new Map<string, ModelPricingRow>()
    for (const row of rows) {
      map.set(normalizeModelId(row.model_id), row)
    }
    const index: PricingIndex = { map, keys: Array.from(map.keys()).sort() }
    this.priceIndex = index
    return index
  }
}

export function createPricingService(storage: StorageService): PricingService {
  return new PricingServiceImpl(storage)
}

const MICRO_PER_USD = 1_000_000

function toMicroUsd(costUsd?: string | null): number {
  if (costUsd == null || costUsd === '') return 0
  const n = Number(costUsd)
  return Number.isFinite(n) ? Math.round(n * MICRO_PER_USD) : 0
}

function toDateKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export interface BackfillResult {
  scanned: number
  updated: number
}

export interface RecalcResult {
  scanned: number
  updated: number
}

const REPRICE_BATCH_SIZE = 500

type RepriceCandidateRow = Pick<
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
> & { rid: number }

interface PendingCostUpdate {
  id: string
  newCost: string
  deltaMicro: number
  dateKey: string
  appType: AppType
  model: string
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export async function backfillZeroCost(
  db: SqliteDatabase,
  pricing: PricingService
): Promise<BackfillResult> {
  const selectBatchStmt = db
    .prepare(
      `
      SELECT id, app_type, model, input_tokens, output_tokens,
             cache_read_tokens, cache_creation_tokens, input_semantics,
             cost_usd, created_at, file_path, line, rowid AS rid
      FROM usage_records
      WHERE (cost_usd IS NULL OR cost_usd = '0') AND rowid > ?
      ORDER BY rowid
      LIMIT ?
      `
    )
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
  let updated = 0
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

  let scanned = 0
  let lastRid = 0
  for (;;) {
    const batch = selectBatchStmt.all(lastRid, REPRICE_BATCH_SIZE) as RepriceCandidateRow[]
    if (batch.length === 0) break
    scanned += batch.length

    const pending: PendingCostUpdate[] = []
    for (const row of batch) {
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

    runTx(pending, Date.now())

    lastRid = batch[batch.length - 1].rid
    await yieldToEventLoop()
  }

  return { scanned, updated }
}

interface PendingRecalcUpdate extends PendingCostUpdate {
  oldCostUsd: string | null
}

export async function recalcCachedInputCosts(
  db: SqliteDatabase,
  pricing: PricingService
): Promise<RecalcResult> {
  const selectBatchStmt = db.prepare(
    `
    SELECT id, app_type, model, input_tokens, output_tokens,
           cache_read_tokens, cache_creation_tokens, input_semantics,
           cost_usd, created_at, file_path, line, rowid AS rid
    FROM usage_records
    WHERE app_type IN ('codex', 'gemini', 'grok', 'workbuddy', 'codebuddy', 'qwen', 'reasonix') AND input_semantics = 1 AND rowid > ?
    ORDER BY rowid
    LIMIT ?
    `
  )
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
  let updated = 0
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

  let scanned = 0
  let lastRid = 0
  for (;;) {
    const batch = selectBatchStmt.all(lastRid, REPRICE_BATCH_SIZE) as RepriceCandidateRow[]
    if (batch.length === 0) break
    scanned += batch.length

    const pending: PendingRecalcUpdate[] = []
    for (const row of batch) {
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

    runTx(pending, Date.now())

    lastRid = batch[batch.length - 1].rid
    await yieldToEventLoop()
  }

  return { scanned, updated }
}
