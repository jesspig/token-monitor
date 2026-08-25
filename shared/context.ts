import type { UsageRecord } from './dto'
import type { ModelPricingRow, PricingSource } from './tables'

/**
 * 数据更新事件负载：同步新增记录后触发，
 * 宿主经事件总线推送（200ms 防抖）到渲染进程。
 */
export interface UsageUpdatedEvent {
  /** 触发时间（epoch ms） */
  updatedAt: number
  /** 本次新增记录数 */
  addedRecords: number
}

/** 类型化事件表（docs/concepts/plugin-architecture.md event-bus） */
export type PluginEventMap = {
  'usage-updated': UsageUpdatedEvent
}

/** storage 服务：SQLite 读写（better-sqlite3，仅主进程使用，同步 API） */
export interface StorageService {
  /** 批量写入用量明细，返回实际入库条数（经过去重） */
  recordUsage(records: UsageRecord[]): Promise<number>
  /** 读取增量游标（未同步过返回 null） */
  getCursor(filePath: string): Promise<number | null>
  /** 读取增量游标元信息（未同步过返回 null），供采集器 mtime 短路判定 */
  getCursorMeta(filePath: string): Promise<{ lineOffset: number; fileMtime: number } | null>
  /** 推进增量游标；fileMtime 用于检测文件被 truncate/替换时重置 */
  setCursor(filePath: string, line: number, fileMtime?: number): Promise<void>
  getModelPricing(): Promise<ModelPricingRow[]>
  /**
   * upsert 单条定价；source 标记来源分级（user > seed/sync）：
   * user 行不被非 user 写入覆盖，缺省视为 'user'（向后兼容旧调用）。
   */
  updateModelPricing(entry: ModelPricingRow, source?: PricingSource): Promise<void>
  /** 单事务批量 upsert 定价（分级保护规则与 updateModelPricing 完全一致）；返回实际写入条数 */
  updateModelPricingBatch(entries: ModelPricingRow[], source: PricingSource): Promise<number>
  deleteModelPricing(modelId: string): Promise<void>
}

/** pricing 服务：模型 ID 归一化 + 费用计算（docs/concepts/pricing.md） */
export interface PricingService {
  /** 模型 ID 归一化：清洗供应商前缀/版本/日期后缀后的小写模型名 */
  normalizeModelId(rawModel: string): Promise<string>
  /** 估算费用（USD，字符串避免浮点误差）；无定价项时返回 undefined */
  calcCost(record: UsageRecord): Promise<string | undefined>
  getPrice(modelId: string): Promise<ModelPricingRow | undefined>
}

/** events 服务：类型化事件总线 */
export interface EventsService {
  emit<K extends keyof PluginEventMap>(event: K, payload: PluginEventMap[K]): void
  /** 订阅事件；返回 disposer，卸载时调用以可逆清理 */
  on<K extends keyof PluginEventMap>(
    event: K,
    listener: (payload: PluginEventMap[K]) => void
  ): () => void
}

/** scheduler 服务：定时兜底扫描（默认 5 分钟） */
export interface SchedulerService {
  /** 注册定时任务；返回 disposer，卸载时调用以可逆清理 */
  schedule(intervalMs: number, task: () => void | Promise<void>): () => void
}

/** watcher 服务：chokidar 文件监听 */
export interface WatcherService {
  /**
   * 监听文件（或文件列表）变更；返回 disposer，卸载时调用以可逆清理。
   * debounceMs 用于合并高频变更事件。
   */
  registerWatcher(
    target: string | string[],
    onChange: () => void | Promise<void>,
    options?: { debounceMs?: number }
  ): () => void
}

/**
 * 服务容器 ctx（docs/concepts/plugin-architecture.md）。
 * 插件经 ctx 访问宿主服务，不直接 import 宿主实现；
 * 各方法体由主进程实现，此处仅定义类型契约。
 */
export interface PluginContext {
  storage: StorageService
  pricing: PricingService
  events: EventsService
  scheduler: SchedulerService
  watcher: WatcherService
}
