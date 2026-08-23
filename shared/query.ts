import type { AppType, RequestStatus } from './app'

/**
 * 日志/统计查询筛选（时间范围 + 应用/模型 + 状态 + 分页）。
 * 与 ui-pages.md 各页面的筛选交互对应。
 */
export interface LogFilters {
  appTypes?: AppType[]
  models?: string[]
  /** 起始时间（epoch ms） */
  startTime?: number
  /** 结束时间（epoch ms） */
  endTime?: number
  status?: RequestStatus
  project?: string
  sessionId?: string
  /** 关键字（模糊匹配模型/会话/项目等） */
  keyword?: string
  page?: number
  pageSize?: number
}

/** Dashboard：Hero 汇总卡（受时间范围/应用/模型筛选驱动） */
export interface UsageSummary {
  totalRequests: number
  successCount: number
  errorCount: number
  /** 费用合计（USD，字符串） */
  totalCost: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** 实际总 token = input + output + cacheRead + cacheCreation */
  realTotalTokens: number
  /** 缓存命中率 = cacheReadTokens / (inputTokens + cacheReadTokens) */
  cacheHitRate: number
  /** 成功率 = successCount / totalRequests */
  successRate: number
}

/** 趋势页：按天聚合数据点（小时粒度见 HourlyStats） */
export interface DailyStats {
  /** YYYY-MM-DD */
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

/** 趋势页/Dashboard：按小时聚合数据点（字段与 DailyStats 对齐，粒度换为小时，由后端分桶） */
export interface HourlyStats {
  /** 0–23（本地时区小时） */
  hour: number
  /**
   * 本地日期 YYYY-MM-DD：小时桶的日期维度。
   * 跨天窗口（如 24h 滚动窗口）用其区分同钟点的不同日桶，避免「昨天 9 点」与「今天 9 点」被误合并。
   */
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

/** 统计页：按模型聚合 */
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

/** 统计页：按应用（监控对象）聚合 */
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

/** 请求日志页：行详情（覆盖时间/模型/各类 token/费用/状态/耗时） */
export interface RequestLogDetail {
  id: string
  appType: AppType
  /** 归一化模型 ID */
  model: string
  /** 日志原始模型名 */
  rawModel: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** 输入语义：0=未知 / 1=input 为含缓存读写的总量(计费前需扣减缓存) / 2=input 已为纯新输入 */
  inputSemantics: number
  costUsd: string | null
  currency: string | null
  latencyMs: number | null
  project: string | null
  sessionId: string | null
  status: RequestStatus
  /** 发生时间（epoch ms） */
  createdAt: number
  /** 来源文件 */
  sourceFile: string
  /** 来源行号 */
  sourceLine: number
}

/** 请求日志页：分页结果 */
export interface PaginatedLogs {
  items: RequestLogDetail[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

/** 监控源页：各 CLI 适配器状态（已检测/未安装/最近同步时间/错误数） */
export interface PluginStatus {
  id: AppType
  name: string
  version: string
  enabled: boolean
  /** 是否检测到（CLI 已安装且会话目录存在） */
  available: boolean
  reason?: string
  sessionDir?: string
  /** 最近一次同步时间（epoch ms）；从未同步为 null */
  lastSyncAt: number | null
  /** 累计解析错误数 */
  errorCount: number
  /** 被监控 CLI 的实际版本；null/缺省表示探测失败 */
  cliVersion?: string | null
}

/** 设置页：同步间隔、数据保留策略、数据目录 */
export interface AppSettings {
  /** 兜底扫描间隔（ms，默认 5 分钟） */
  syncIntervalMs: number
  /** 明细保留天数 */
  retentionDays: number
  /** 数据目录 */
  dataDir: string
  /** 日预算上限（USD，全局所有 CLI 合计）；null/缺省=不启用告警 */
  dailyBudgetUsd?: number | null
  /** 月预算上限（USD，自然月）；null/缺省=不启用告警 */
  monthlyBudgetUsd?: number | null
  /** 统计自动刷新间隔（ms，默认 5000），渲染端查询轮询用 */
  statsRefreshIntervalMs?: number
  /** models.dev 价格自动同步间隔（ms，默认 300000） */
  pricingSyncIntervalMs?: number
}

/**
 * Dashboard 预算横幅：全局维度（所有 CLI 合计）的今日/本月费用与上限占比。
 * 口径与 usageQuery 一致：费用从 usage_daily_rollups 以整数微美元聚合后格式化；
 * 未设置预算（null 或 <=0）时 ratio=null、exceeded=false，即不告警。
 */
export interface BudgetStatus {
  /** 今日费用（USD，字符串） */
  dailyCostUsd: string
  /** 本自然月费用（USD，字符串） */
  monthlyCostUsd: string
  dailyBudgetUsd: number | null
  monthlyBudgetUsd: number | null
  /** 费用 / 上限；未设置预算为 null */
  dailyUsageRatio: number | null
  monthlyUsageRatio: number | null
  /** 费用 > 上限；未设置预算恒为 false */
  dailyExceeded: boolean
  monthlyExceeded: boolean
}

/**
 * models.dev 目录候选条目（定价配置页手动导入用）。
 * 与主进程 src/main/services/modelsdev.ts 的内部类型形状一致（IPC 传输 DTO）。
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

/** models.dev 全量同步结果；恒有 fetched === imported + skipped */
export interface ModelsDevSyncResult {
  fetched: number
  imported: number
  skipped: number
}

/** 请求日志页：筛选维度候选（模型/项目 distinct 非空值，升序），供筛选控件生成选项 */
export interface FilterOptions {
  models: string[]
  projects: string[]
}
