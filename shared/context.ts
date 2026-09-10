import type { UsageRecord } from './dto'
import type { ModelPricingRow, PricingSource } from './tables'

export interface UsageUpdatedEvent {
  updatedAt: number
  addedRecords: number
}

export type PluginEventMap = {
  'usage-updated': UsageUpdatedEvent
}

export interface StorageService {
  recordUsage(records: UsageRecord[]): Promise<number>
  getCursor(filePath: string): Promise<number | null>
  getCursorMeta(filePath: string): Promise<{ lineOffset: number; fileMtime: number; byteOffset?: number | null } | null>
  setCursor(filePath: string, line: number, fileMtime?: number, byteOffset?: number | null): Promise<void>
  getModelPricing(): Promise<ModelPricingRow[]>
  updateModelPricing(entry: ModelPricingRow, source?: PricingSource): Promise<void>
  updateModelPricingBatch(entries: ModelPricingRow[], source: PricingSource): Promise<number>
  deleteModelPricing(modelId: string): Promise<void>
}

export interface PricingService {
  normalizeModelId(rawModel: string): Promise<string>
  calcCost(record: UsageRecord): Promise<string | undefined>
  calcCostBatch(records: UsageRecord[]): Promise<(string | undefined)[]>
  getPrice(modelId: string): Promise<ModelPricingRow | undefined>
}

export interface EventsService {
  emit<K extends keyof PluginEventMap>(event: K, payload: PluginEventMap[K]): void
  on<K extends keyof PluginEventMap>(
    event: K,
    listener: (payload: PluginEventMap[K]) => void
  ): () => void
}

export interface SchedulerService {
  schedule(intervalMs: number, task: () => void | Promise<void>, initialDelayMs?: number): () => void
}

export interface WatcherService {
  registerWatcher(
    target: string | string[],
    onChange: () => void | Promise<void>,
    options?: { debounceMs?: number }
  ): () => void
}

export interface PluginContext {
  storage: StorageService
  pricing: PricingService
  events: EventsService
  scheduler: SchedulerService
  watcher: WatcherService
}
