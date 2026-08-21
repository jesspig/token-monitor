import type { AppType, RequestStatus } from './app'

/**
 * usage_records 行（docs/concepts/data-model.md）。
 * 用量明细表；字段为 snake_case 以对应 SQLite 列名。
 */
export interface UsageRecordRow {
  /** 主键/去重 key = data_source + file_path + line */
  id: string
  /** 数据来源插件 id */
  data_source: string
  /** 监控对象（插件 id），首版无 provider 维度 */
  app_type: AppType
  /** 归一化模型 ID（计费用） */
  model: string
  /** 日志原始模型名 */
  raw_model: string | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  /** 输入语义：0=未知 / 1=含缓存写 / 2=纯新输入 */
  input_semantics: number
  /** 费用（字符串避免浮点误差） */
  cost_usd: string | null
  currency: string | null
  latency_ms: number | null
  project: string | null
  session_id: string | null
  status: RequestStatus
  /** 来源文件（去重 key 组成之一） */
  file_path: string
  /** 来源行号（去重 key 组成之一） */
  line: number
  /** 发生时间（epoch ms） */
  created_at: number
}

/**
 * usage_daily_rollups 行：日聚合（趋势主数据源），主键 (date, app_type, model)。
 */
export interface UsageDailyRollupRow {
  /** YYYY-MM-DD */
  date: string
  app_type: AppType
  model: string
  request_count: number
  success_count: number
  error_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  /** 当日费用（USD，字符串） */
  cost_usd: string
  /** 当日累计耗时（ms，用于均值展示） */
  latency_ms_total: number
  updated_at: number
}

/**
 * model_pricing 行：内置模型定价（docs/concepts/pricing.md）。
 * 价格为每百万 token（默认 USD），支持自定义/覆盖与 cost_multiplier。
 */
export interface ModelPricingRow {
  /** 归一化后的模型 ID */
  model_id: string
  provider: string | null
  input_per_million: number
  output_per_million: number
  cache_read_per_million: number
  cache_creation_per_million: number
  currency: string
  /** 费用叠加系数（默认 1） */
  cost_multiplier: number
  updated_at: number
}

/**
 * sync_cursors 行：增量同步游标（docs/concepts/sync-mechanism.md），主键 file_path。
 */
export interface SyncCursorRow {
  file_path: string
  /** 来源插件 id（文件天然按插件隔离，辅助排查/清理） */
  data_source: string
  /** 已同步到的行号（下一轮 fromLine） */
  line_offset: number
  /** 文件 mtime；文件被 truncate/替换时据此重置游标 */
  file_mtime: number
  updated_at: number
}

/**
 * dedup_ledger 行：去重账本（fork/rewrite 场景），主键 (data_source, request_id)。
 */
export interface DedupLedgerRow {
  data_source: string
  request_id: string
  /** 归一化指纹（如 app_type+model+tokens+time），用于识别重复请求 */
  semantic_id: string
  created_at: number
}
