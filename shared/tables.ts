import type { AppType, RequestStatus } from './app'

export interface UsageRecordRow {
  id: string
  data_source: string
  app_type: AppType
  model: string
  raw_model: string | null
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  input_semantics: number
  cost_usd: string | null
  currency: string | null
  latency_ms: number | null
  project: string | null
  session_id: string | null
  status: RequestStatus
  http_status: number | null
  error_message: string | null
  request_id: string | null
  is_replaceable_snapshot: number
  file_path: string
  line: number
  created_at: number
}

export interface UsageDailyRollupRow {
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
  cost_usd: string
  latency_ms_total: number
  updated_at: number
}

export type PricingSource = 'seed' | 'sync' | 'user'

export interface ModelPricingRow {
  model_id: string
  provider: string | null
  input_per_million: number
  output_per_million: number
  cache_read_per_million: number
  cache_creation_per_million: number
  currency: string
  cost_multiplier: number
  updated_at: number
  source?: PricingSource
}

export interface SyncCursorRow {
  file_path: string
  data_source: string
  line_offset: number
  file_mtime: number
  byte_offset?: number | null
  updated_at: number
}

export interface DedupLedgerRow {
  data_source: string
  request_id: string
  semantic_id: string
  created_at: number
}
