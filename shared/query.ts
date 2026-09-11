import type { AppType, RequestStatus } from './app'

export interface LogFilters {
  appTypes?: AppType[]
  models?: string[]
  startTime?: number
  endTime?: number
  status?: RequestStatus
  statusCode?: number
  httpStatus?: number
  project?: string
  sessionId?: string
  keyword?: string
  page?: number
  pageSize?: number
}

export interface UsageSummary {
  totalRequests: number
  successCount: number
  errorCount: number
  totalCost: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  realTotalTokens: number
  cacheHitRate: number
  successRate: number
}

export interface DailyStats {
  date: string
  requestCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: string
  successCount: number
  errorCount: number
}

export interface DailyModelBreakdown {
  date: string
  model: string
  tokens: number
  cost: string
  requestCount: number
}

export interface HourlyStats {
  hour: number
  dayKey?: string
  requestCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: string
  successCount: number
  errorCount: number
}

export interface ModelStats {
  model: string
  appType: AppType
  requestCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: string
  avgLatencyMs: number | null
  successRate: number
}

export interface AppStats {
  appType: AppType
  requestCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: string
  successRate: number
}

export interface RequestLogDetail {
  id: string
  appType: AppType
  model: string
  rawModel: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  inputSemantics: number
  costUsd: string | null
  currency: string | null
  latencyMs: number | null
  project: string | null
  sessionId: string | null
  status: RequestStatus
  httpStatus: number | null
  errorMessage: string | null
  createdAt: number
  sourceFile: string
  sourceLine: number
}

export interface PaginatedLogs {
  items: RequestLogDetail[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export interface PluginStatus {
  id: AppType
  name: string
  version: string
  enabled: boolean
  available: boolean
  reason?: string
  sessionDir?: string
  lastSyncAt: number | null
  errorCount: number
  cliVersion?: string | null
}

export interface AppSettings {
  syncIntervalMs: number
  retentionDays: number
  dataDir: string
  traeTrajectoryRoots?: string[]
  dailyBudgetUsd?: number | null
  monthlyBudgetUsd?: number | null
  statsRefreshIntervalMs?: number
  pricingSyncIntervalMs?: number
  closeToTray?: boolean
}

export interface BudgetStatus {
  dailyCostUsd: string
  monthlyCostUsd: string
  dailyBudgetUsd: number | null
  monthlyBudgetUsd: number | null
  dailyUsageRatio: number | null
  monthlyUsageRatio: number | null
  dailyExceeded: boolean
  monthlyExceeded: boolean
}

export interface ModelsDevCatalogEntry {
  provider: string | null
  modelId: string
  name: string | null
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion: number
  cacheCreationPerMillion: number
}

export interface ModelsDevSyncResult {
  fetched: number
  imported: number
  skipped: number
}

export interface ProjectStats {
  project: string
  requestCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: string
  successRate: number
}

export interface SessionStats {
  sessionId: string
  requestCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: string
  successRate: number
}

export interface StatusStats {
  status: string
  requestCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: string
  successRate: number
}

export interface FilterOptions {
  models: string[]
  projects: string[]
}
