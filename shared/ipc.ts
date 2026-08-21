import type { AppType } from './app'
import type { UsageUpdatedEvent } from './context'
import type {
  AppSettings,
  AppStats,
  DailyStats,
  LogFilters,
  ModelStats,
  PaginatedLogs,
  PluginStatus,
  RequestLogDetail,
  UsageSummary
} from './query'
import type { ModelPricingRow } from './tables'

/**
 * 渲染进程可见的白名单 API（docs/concepts/architecture.md）。
 * 经 preload contextBridge 暴露，禁止直接暴露 Node 能力；
 * 各方法与 ui-pages.md 页面功能对应。
 */
export interface RendererApi {
  /** 连通性检查（示例 IPC，返回 'pong'） */
  ping(): Promise<string>

  /** Dashboard：Hero 汇总卡 */
  getUsageSummary(filters: LogFilters): Promise<UsageSummary>

  /** 趋势页：按天聚合序列 */
  getDailyTrends(filters: LogFilters): Promise<DailyStats[]>

  /** 请求日志页：分页查询 */
  getRequestLogs(filters: LogFilters): Promise<PaginatedLogs>

  /** 请求日志页：行详情 */
  getRequestLogDetail(id: string): Promise<RequestLogDetail | null>

  /** 统计页：按模型聚合 */
  getStatsByModel(filters: LogFilters): Promise<ModelStats[]>

  /** 统计页：按应用聚合 */
  getStatsByApp(filters: LogFilters): Promise<AppStats[]>

  /** 定价配置页：价格列表 */
  getModelPricing(): Promise<ModelPricingRow[]>

  /** 定价配置页：新增/更新 */
  updateModelPricing(entry: ModelPricingRow): Promise<void>

  /** 定价配置页：删除 */
  deleteModelPricing(modelId: string): Promise<void>

  /** 监控源页：插件状态列表 */
  listPlugins(): Promise<PluginStatus[]>

  /** 监控源页：启停插件 */
  setPluginEnabled(id: AppType, enabled: boolean): Promise<void>

  /** 设置页：读取 */
  getSettings(): Promise<AppSettings>

  /** 设置页：更新（部分字段） */
  updateSettings(patch: Partial<AppSettings>): Promise<void>

  /** 数据更新推送（usage-updated，200ms 防抖）；返回取消订阅函数 */
  onUsageUpdated(callback: (payload: UsageUpdatedEvent) => void): () => void
}
