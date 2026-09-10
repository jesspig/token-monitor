import type { StorageService } from '../../../shared/context'
import type { ModelPricingRow } from '../../../shared/tables'


export const MODELSDEV_FETCH_TIMEOUT_MS = 15_000

const MODELSDEV_API_URL = 'https://models.dev/api.json'

export interface ModelsDevCatalogEntry {
  provider: string | null
  modelId: string
  name: string | null
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion: number
  cacheCreationPerMillion: number
}

export interface CatalogParseResult {
  entries: ModelsDevCatalogEntry[]
  total: number
  skipped: number
}

export interface SyncResult {
  fetched: number
  imported: number
  skipped: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asFiniteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function parseModelEntry(
  modelKey: string,
  value: unknown,
  provider: string | null
): ModelsDevCatalogEntry | null {
  if (!isRecord(value)) return null
  const cost = isRecord(value.cost) ? value.cost : null
  if (!cost) return null
  const input = asFiniteNonNegative(cost.input)
  const output = asFiniteNonNegative(cost.output)
  if (input === null || output === null) return null
  const modelId = asNonEmptyString(value.id) ?? asNonEmptyString(modelKey)
  if (modelId === null) return null
  return {
    provider,
    modelId,
    name: asNonEmptyString(value.name),
    inputPerMillion: input,
    outputPerMillion: output,
    cacheReadPerMillion: asFiniteNonNegative(cost.cache_read) ?? 0,
    cacheCreationPerMillion: asFiniteNonNegative(cost.cache_write) ?? 0
  }
}

export function parseCatalog(payload: unknown): CatalogParseResult {
  const entries: ModelsDevCatalogEntry[] = []
  let total = 0
  let skipped = 0
  if (!isRecord(payload)) return { entries, total, skipped }
  for (const [providerKey, providerValue] of Object.entries(payload)) {
    if (!isRecord(providerValue)) continue
    const models = providerValue.models
    if (!isRecord(models)) continue
    const provider = asNonEmptyString(providerKey) ?? asNonEmptyString(providerValue.name)
    for (const [modelKey, modelValue] of Object.entries(models)) {
      total += 1
      const entry = parseModelEntry(modelKey, modelValue, provider)
      if (entry === null) {
        skipped += 1
      } else {
        entries.push(entry)
      }
    }
  }
  return { entries, total, skipped }
}

export async function fetchCatalog(): Promise<CatalogParseResult> {
  const response = await fetch(MODELSDEV_API_URL, {
    signal: AbortSignal.timeout(MODELSDEV_FETCH_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new Error(`models.dev 请求失败：HTTP ${response.status}`)
  }
  return parseCatalog(await response.json())
}

export async function syncPricing(storage: StorageService): Promise<SyncResult> {
  const catalog = await fetchCatalog()
  const updatedAt = Date.now()
  const rows: ModelPricingRow[] = catalog.entries.map((item) => ({
    model_id: item.modelId,
    provider: item.provider,
    input_per_million: item.inputPerMillion,
    output_per_million: item.outputPerMillion,
    cache_read_per_million: item.cacheReadPerMillion,
    cache_creation_per_million: item.cacheCreationPerMillion,
    currency: 'USD',
    cost_multiplier: 1,
    updated_at: updatedAt
  }))
  const imported = await storage.updateModelPricingBatch(rows, 'sync')
  return { fetched: catalog.total, imported, skipped: catalog.skipped }
}
