import type { AppType, RequestStatus } from '../../../shared/app'
import type {
  AppStats,
  DailyStats,
  LogFilters,
  ModelStats,
  PaginatedLogs,
  RequestLogDetail,
  UsageSummary
} from '../../../shared/query'
import type { UsageRecordRow } from '../../../shared/tables'
import type { SqliteDatabase } from './db'

/**
 * 用量查询服务：只读聚合/明细查询（better-sqlite3，仅主进程，同步 API 内部实现 + Promise 签名）。
 * 数据源为 usage_records 明细表；费用统一转整数微美元聚合后格式化，与 storage.ts 的金额处理一致。
 * 渲染进程经 IPC 调用，DTO 契约见 shared/query.ts。
 */

/** 微美元：费用以字符串存储避免浮点误差，聚合时统一转成整数微美元累加 */
const MICRO_PER_USD = 1_000_000

/** 微美元 → 字符串（去掉尾随 0 与小数点，0 返回 '0'） */
function fromMicroUsd(micro: number): string {
  return (micro / MICRO_PER_USD).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0'
}

/** SQL 片段：cost_usd(TEXT) → 整数微美元求和（无匹配行时 SUM 为 NULL，调用处需 COALESCE） */
const SUM_COST_MICRO = "SUM(CAST(ROUND(COALESCE(cost_usd, '0') * 1000000) AS INTEGER))"
/** SQL 片段：success / error 计数 */
const SUM_SUCCESS = "COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0)"
const SUM_ERROR = "COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0)"
/** SQL 片段：各类 token 求和（无匹配行时 SUM 为 NULL，用 COALESCE 归零） */
const SUM_TOKENS = {
  input: 'COALESCE(SUM(input_tokens), 0)',
  output: 'COALESCE(SUM(output_tokens), 0)',
  cacheRead: 'COALESCE(SUM(cache_read_tokens), 0)',
  cacheCreation: 'COALESCE(SUM(cache_creation_tokens), 0)'
} as const

/** 聚合查询的公共行列接口 */
interface SummaryRow {
  total_requests: number
  success_count: number
  error_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  cost_micro_usd: number
}

interface DailyRow {
  date: string
  request_count: number
  success_count: number
  error_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  cost_micro_usd: number
}

interface GroupRow {
  request_count: number
  success_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  cost_micro_usd: number
}

interface ModelRow extends GroupRow {
  model: string
  app_type: string
  avg_latency_ms: number | null
}

interface AppRow extends GroupRow {
  app_type: string
}

/** 把 LogFilters 翻译成 WHERE 子句与参数（page/pageSize 不参与，由分页方法单独处理） */
function buildWhere(filters: LogFilters): { sql: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []

  if (filters.appTypes && filters.appTypes.length > 0) {
    clauses.push(`app_type IN (${filters.appTypes.map(() => '?').join(', ')})`)
    params.push(...filters.appTypes)
  }
  if (filters.models && filters.models.length > 0) {
    clauses.push(`model IN (${filters.models.map(() => '?').join(', ')})`)
    params.push(...filters.models)
  }
  if (filters.startTime != null) {
    clauses.push('created_at >= ?')
    params.push(filters.startTime)
  }
  if (filters.endTime != null) {
    clauses.push('created_at <= ?')
    params.push(filters.endTime)
  }
  if (filters.status != null) {
    clauses.push('status = ?')
    params.push(filters.status)
  }
  if (filters.project != null && filters.project !== '') {
    clauses.push('project = ?')
    params.push(filters.project)
  }
  if (filters.sessionId != null && filters.sessionId !== '') {
    clauses.push('session_id = ?')
    params.push(filters.sessionId)
  }
  if (filters.keyword != null && filters.keyword !== '') {
    clauses.push('(model LIKE ? OR raw_model LIKE ? OR project LIKE ? OR session_id LIKE ?)')
    const kw = `%${filters.keyword}%`
    params.push(kw, kw, kw, kw)
  }

  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

/** usage_records 行 → RequestLogDetail（snake_case → camelCase） */
function toDetail(row: UsageRecordRow): RequestLogDetail {
  return {
    id: row.id,
    appType: row.app_type,
    model: row.model,
    rawModel: row.raw_model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    inputSemantics: row.input_semantics,
    costUsd: row.cost_usd,
    currency: row.currency,
    latencyMs: row.latency_ms,
    project: row.project,
    sessionId: row.session_id,
    status: row.status as RequestStatus,
    createdAt: row.created_at,
    sourceFile: row.file_path,
    sourceLine: row.line
  }
}

/** 用量查询服务契约（只读） */
export interface UsageQueryService {
  /** Hero 汇总：请求数/成功失败/费用/各 token/实际总 token/缓存命中率/成功率 */
  getUsageSummary(filters: LogFilters): Promise<UsageSummary>
  /** 按天（本地时区 YYYY-MM-DD）趋势序列 */
  getDailyTrends(filters: LogFilters): Promise<DailyStats[]>
  /** 按归一化模型分组统计 */
  getModelStats(filters: LogFilters): Promise<ModelStats[]>
  /** 按应用（监控对象 app_type）分组统计 */
  getAppStats(filters: LogFilters): Promise<AppStats[]>
  /** 分页明细（created_at 倒序），支持 keyword 模糊匹配 */
  getRequestLogs(filters: LogFilters): Promise<PaginatedLogs>
  /** 单条明细（无则 null） */
  getRequestLogDetail(id: string): Promise<RequestLogDetail | null>
}

/**
 * 建工厂：直接接收已打开的数据库实例（:memory: 或文件模式均可，须已迁移建表）。
 * 所有方法只读，不修改任何数据。
 */
export function createUsageQuery(db: SqliteDatabase): UsageQueryService {
  return {
    getUsageSummary(filters): Promise<UsageSummary> {
      const { sql, params } = buildWhere(filters)
      const row = db
        .prepare(
          `SELECT COUNT(*) AS total_requests,
                  ${SUM_SUCCESS} AS success_count,
                  ${SUM_ERROR} AS error_count,
                  ${SUM_TOKENS.input} AS input_tokens,
                  ${SUM_TOKENS.output} AS output_tokens,
                  ${SUM_TOKENS.cacheRead} AS cache_read_tokens,
                  ${SUM_TOKENS.cacheCreation} AS cache_creation_tokens,
                  COALESCE(${SUM_COST_MICRO}, 0) AS cost_micro_usd
           FROM usage_records
           ${sql}`
        )
        .get(...params) as SummaryRow

      const input = row.input_tokens
      const cacheRead = row.cache_read_tokens
      const cacheDenom = input + cacheRead
      return Promise.resolve({
        totalRequests: row.total_requests,
        successCount: row.success_count,
        errorCount: row.error_count,
        totalCost: fromMicroUsd(row.cost_micro_usd),
        inputTokens: input,
        outputTokens: row.output_tokens,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: row.cache_creation_tokens,
        realTotalTokens: input + row.output_tokens + cacheRead + row.cache_creation_tokens,
        cacheHitRate: cacheDenom > 0 ? cacheRead / cacheDenom : 0,
        successRate: row.total_requests > 0 ? row.success_count / row.total_requests : 0
      })
    },

    getDailyTrends(filters): Promise<DailyStats[]> {
      const { sql, params } = buildWhere(filters)
      const rows = db
        .prepare(
          `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS date,
                  COUNT(*) AS request_count,
                  ${SUM_SUCCESS} AS success_count,
                  ${SUM_ERROR} AS error_count,
                  ${SUM_TOKENS.input} AS input_tokens,
                  ${SUM_TOKENS.output} AS output_tokens,
                  ${SUM_TOKENS.cacheRead} AS cache_read_tokens,
                  ${SUM_TOKENS.cacheCreation} AS cache_creation_tokens,
                  COALESCE(${SUM_COST_MICRO}, 0) AS cost_micro_usd
           FROM usage_records
           ${sql}
           GROUP BY date
           ORDER BY date ASC`
        )
        .all(...params) as DailyRow[]

      return Promise.resolve(
        rows.map((r) => ({
          date: r.date,
          requestCount: r.request_count,
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
          cacheReadTokens: r.cache_read_tokens,
          cacheCreationTokens: r.cache_creation_tokens,
          costUsd: fromMicroUsd(r.cost_micro_usd),
          successCount: r.success_count,
          errorCount: r.error_count
        }))
      )
    },

    getModelStats(filters): Promise<ModelStats[]> {
      const { sql, params } = buildWhere(filters)
      const rows = db
        .prepare(
          `SELECT model,
                  MIN(app_type) AS app_type,
                  COUNT(*) AS request_count,
                  ${SUM_SUCCESS} AS success_count,
                  ${SUM_TOKENS.input} AS input_tokens,
                  ${SUM_TOKENS.output} AS output_tokens,
                  ${SUM_TOKENS.cacheRead} AS cache_read_tokens,
                  ${SUM_TOKENS.cacheCreation} AS cache_creation_tokens,
                  COALESCE(${SUM_COST_MICRO}, 0) AS cost_micro_usd,
                  AVG(latency_ms) AS avg_latency_ms
           FROM usage_records
           ${sql}
           GROUP BY model
           ORDER BY request_count DESC, model ASC`
        )
        .all(...params) as ModelRow[]

      return Promise.resolve(
        rows.map((r) => ({
          model: r.model,
          appType: r.app_type as AppType,
          requestCount: r.request_count,
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
          cacheReadTokens: r.cache_read_tokens,
          cacheCreationTokens: r.cache_creation_tokens,
          costUsd: fromMicroUsd(r.cost_micro_usd),
          avgLatencyMs: r.avg_latency_ms != null ? Math.round(r.avg_latency_ms) : null,
          successRate: r.request_count > 0 ? r.success_count / r.request_count : 0
        }))
      )
    },

    getAppStats(filters): Promise<AppStats[]> {
      const { sql, params } = buildWhere(filters)
      const rows = db
        .prepare(
          `SELECT app_type,
                  COUNT(*) AS request_count,
                  ${SUM_SUCCESS} AS success_count,
                  ${SUM_TOKENS.input} AS input_tokens,
                  ${SUM_TOKENS.output} AS output_tokens,
                  ${SUM_TOKENS.cacheRead} AS cache_read_tokens,
                  ${SUM_TOKENS.cacheCreation} AS cache_creation_tokens,
                  COALESCE(${SUM_COST_MICRO}, 0) AS cost_micro_usd
           FROM usage_records
           ${sql}
           GROUP BY app_type
           ORDER BY request_count DESC, app_type ASC`
        )
        .all(...params) as AppRow[]

      return Promise.resolve(
        rows.map((r) => ({
          appType: r.app_type as AppType,
          requestCount: r.request_count,
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
          cacheReadTokens: r.cache_read_tokens,
          cacheCreationTokens: r.cache_creation_tokens,
          costUsd: fromMicroUsd(r.cost_micro_usd),
          successRate: r.request_count > 0 ? r.success_count / r.request_count : 0
        }))
      )
    },

    getRequestLogs(filters): Promise<PaginatedLogs> {
      const { sql, params } = buildWhere(filters)
      const page = Math.max(1, filters.page ?? 1)
      const pageSize = Math.max(1, filters.pageSize ?? 50)
      const countRow = db
        .prepare(`SELECT COUNT(*) AS total FROM usage_records ${sql}`)
        .get(...params) as { total: number }
      const total = countRow.total
      const items = db
        .prepare(
          `SELECT * FROM usage_records
           ${sql}
           ORDER BY created_at DESC
           LIMIT ? OFFSET ?`
        )
        .all(...params, pageSize, (page - 1) * pageSize) as UsageRecordRow[]

      return Promise.resolve({
        items: items.map(toDetail),
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize))
      })
    },

    getRequestLogDetail(id): Promise<RequestLogDetail | null> {
      const row = db
        .prepare('SELECT * FROM usage_records WHERE id = ?')
        .get(id) as UsageRecordRow | undefined
      return Promise.resolve(row ? toDetail(row) : null)
    }
  }
}
