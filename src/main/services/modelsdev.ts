import type { StorageService } from '../../../shared/context'
import type { ModelPricingRow } from '../../../shared/tables'

/**
 * models.dev 定价目录同步：拉取公开目录并展平为候选条目，
 * 经 storage.updateModelPricing 以 'sync' 来源分级 upsert（user 行受保护）。
 * 本模块不做定时调度、不接线 IPC；网络/HTTP/JSON 解析失败直接抛出由调用方兜底。
 */

/** 在线目录请求超时（ms）；提为导出常量便于调整与测试 */
export const MODELSDEV_FETCH_TIMEOUT_MS = 15_000

/** models.dev 公开目录地址；顶层为 provider 映射，cost 单位即 USD/百万 token */
const MODELSDEV_API_URL = 'https://models.dev/api.json'

/**
 * 展平后的候选定价条目（对齐 ModelPricingRow 四档字段），
 * 价格单位 USD/百万 token，currency 固定 USD、cost_multiplier 固定 1。
 */
export interface ModelsDevCatalogEntry {
  /** 供应商标识：provider key 优先，name 回退，均缺失为 null */
  provider: string | null
  /** 模型 ID：entry.id 优先，退回所在对象的 key */
  modelId: string
  /** 模型显示名（entry.name），缺失为 null */
  name: string | null
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion: number
  cacheCreationPerMillion: number
}

/** 目录解析结果；恒有 total === entries.length + skipped */
export interface CatalogParseResult {
  entries: ModelsDevCatalogEntry[]
  /** 发现的模型条目总数（含被丢弃者） */
  total: number
  /** 解析阶段丢弃数（cost 整体缺失、input/output 非有限非负数等） */
  skipped: number
}

/** 单次同步结果；恒有 fetched === imported + skipped */
export interface SyncResult {
  fetched: number
  imported: number
  skipped: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 仅接受有限非负数值；其余视为缺档 */
function asFiniteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** 单个模型条目解析；不合格返回 null 由上层计数丢弃 */
function parseModelEntry(
  modelKey: string,
  value: unknown,
  provider: string | null
): ModelsDevCatalogEntry | null {
  if (!isRecord(value)) return null
  const cost = isRecord(value.cost) ? value.cost : null
  if (!cost) return null
  // input/output 是有效定价的底线，任一缺失或非法即整条丢弃；
  // cache 两档允许缺档（补 0），出现脏值同样兜底为 0，不废掉整条有效定价。
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

/**
 * 宽松解析 api.json 载荷：遍历 provider → models 两级映射展平为候选条目；
 * 任何形状不符只影响当条计数，不抛错。
 */
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

/** 拉取并解析在线目录；HTTP 非 2xx 或 JSON 非法时直接抛出 */
export async function fetchCatalog(): Promise<CatalogParseResult> {
  const response = await fetch(MODELSDEV_API_URL, {
    signal: AbortSignal.timeout(MODELSDEV_FETCH_TIMEOUT_MS)
  })
  if (!response.ok) {
    throw new Error(`models.dev 请求失败：HTTP ${response.status}`)
  }
  return parseCatalog(await response.json())
}

/**
 * 全量同步：fetchCatalog → 逐条以 'sync' 来源分级 upsert。
 * - fetched = 发现的模型条目总数；imported = upsert 执行成功数；
 *   skipped = 解析丢弃 + 单条写入异常（单条失败不中断整体同步）；
 * - 被 user 分级行挡住的写入不会抛错，仍计入 imported（是否生效由存储层裁决）；
 * - 网络/HTTP/JSON 失败直接抛出，由调用方兜底。
 */
export async function syncPricing(storage: StorageService): Promise<SyncResult> {
  const catalog = await fetchCatalog()
  const updatedAt = Date.now()
  let imported = 0
  let writeFailed = 0
  for (const item of catalog.entries) {
    const row: ModelPricingRow = {
      model_id: item.modelId,
      provider: item.provider,
      input_per_million: item.inputPerMillion,
      output_per_million: item.outputPerMillion,
      cache_read_per_million: item.cacheReadPerMillion,
      cache_creation_per_million: item.cacheCreationPerMillion,
      currency: 'USD',
      cost_multiplier: 1,
      updated_at: updatedAt
    }
    try {
      await storage.updateModelPricing(row, 'sync')
      imported += 1
    } catch {
      writeFailed += 1
    }
  }
  return { fetched: catalog.total, imported, skipped: catalog.skipped + writeFailed }
}
