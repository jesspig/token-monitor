import type { AppType } from './app'
import type { UsageUpdatedEvent } from './context'
import type {
  AppSettings,
  AppStats,
  BudgetStatus,
  DailyModelBreakdown,
  DailyStats,
  FilterOptions,
  HourlyStats,
  LogFilters,
  ModelStats,
  ModelsDevSyncResult,
  ProjectStats,
  SessionStats,
  StatusStats,
  PaginatedLogs,
  PluginStatus,
  RequestLogDetail,
  UsageSummary
} from './query'
import type { ModelPricingRow } from './tables'

export interface RendererApi {
  ping(): Promise<string>

  getUsageSummary(filters: LogFilters): Promise<UsageSummary>

  getDailyTrends(filters: LogFilters): Promise<DailyStats[]>

  getHourlyTrends(filters: LogFilters): Promise<HourlyStats[]>

  getRequestLogs(filters: LogFilters): Promise<PaginatedLogs>

  getRequestLogDetail(id: string): Promise<RequestLogDetail | null>

  getFilterOptions(): Promise<FilterOptions>

  getStatsByModel(filters: LogFilters): Promise<ModelStats[]>

  getStatsByApp(filters: LogFilters): Promise<AppStats[]>

  getStatsByProject(filters: LogFilters): Promise<ProjectStats[]>

  getStatsBySession(filters: LogFilters): Promise<SessionStats[]>

  getStatsByStatus(filters: LogFilters): Promise<StatusStats[]>

  getModelPricing(): Promise<ModelPricingRow[]>

  syncModelsDevPricing(): Promise<ModelsDevSyncResult>

  listPlugins(): Promise<PluginStatus[]>

  setPluginEnabled(id: AppType, enabled: boolean): Promise<void>

  getSettings(): Promise<AppSettings>

  updateSettings(patch: Partial<AppSettings>): Promise<void>

  getBudgetStatus(): Promise<BudgetStatus>

  getDailyModelBreakdown(filters: LogFilters): Promise<DailyModelBreakdown[]>

  onUsageUpdated(callback: (payload: UsageUpdatedEvent) => void): () => void
}
