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

/** 趋势页：按天聚合数据点（今日按小时粒度由前端/后端按时间范围细化） */
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
  /** 输入语义：0=未知 / 1=含缓存写 / 2=纯新输入 */
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
}

/** 设置页：同步间隔、数据保留策略、数据目录 */
export interface AppSettings {
  /** 兜底扫描间隔（ms，默认 5 分钟） */
  syncIntervalMs: number
  /** 明细保留天数 */
  retentionDays: number
  /** 数据目录 */
  dataDir: string
}
