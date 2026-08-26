import type Database from 'better-sqlite3'
import type { AppType, RequestStatus } from '../../../shared/app'
import type {
  AppStats,
  DailyStats,
  FilterOptions,
  HourlyStats,
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
 * 聚合类查询优先走 usage_daily_rollups（recordUsage 实时维护的日聚合镜像，明细过期清理后历史趋势不丢）；
 * 筛选含 rollup 不支持的维度（status/project/sessionId/keyword）时回退 usage_records 明细表。
 * 费用统一转整数微美元聚合后格式化，与 storage.ts 的金额处理一致。
 * 渲染进程经 IPC 调用，DTO 契约见 shared/query.ts。
 */

/** 微美元：费用以字符串存储避免浮点误差，聚合时统一转成整数微美元累加 */
const MICRO_PER_USD = 1_000_000

/** 微美元 → 字符串（去掉尾随 0 与小数点，0 返回 '0'） */
function fromMicroUsd(micro: number): string {
  return (micro / MICRO_PER_USD).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0'
}

/** epoch ms → YYYY-MM-DD（本地时区）；与 storage.ts 的 toDateKey 同口径（日聚合按本地日归桶） */
function toDateKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 本地时区今日 00:00（epoch ms）：小时级趋势的默认范围起点 */
function startOfTodayMs(): number {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()
}

/**
 * 聚合查询能否下推到 usage_daily_rollups：rollup 只保留 (date, app_type, model) 维度，
 * status / project / sessionId / keyword 任一启用时必须回退明细表。
 */
function canUseRollups(filters: LogFilters): boolean {
  return (
    filters.status == null &&
    (filters.project == null || filters.project === '') &&
    (filters.sessionId == null || filters.sessionId === '') &&
    (filters.keyword == null || filters.keyword === '')
  )
}

/** SQL 片段：cost_usd(TEXT) → 整数微美元求和（无匹配行时 SUM 为 NULL，调用处需 COALESCE；两表列名一致可复用） */
const SUM_COST_MICRO = "SUM(CAST(ROUND(COALESCE(cost_usd, '0') * 1000000) AS INTEGER))"
/** SQL 片段：success / error 计数（仅明细表有 status 列） */
const SUM_SUCCESS = "COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0)"
const SUM_ERROR = "COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0)"
/** SQL 片段：rollup 表自带 success/error 计数列，直接求和 */
const SUM_ROLLUP_REQUESTS = 'COALESCE(SUM(request_count), 0)'
const SUM_ROLLUP_SUCCESS = 'COALESCE(SUM(success_count), 0)'
const SUM_ROLLUP_ERROR = 'COALESCE(SUM(error_count), 0)'
/** SQL 片段：各类 token 求和（无匹配行时 SUM 为 NULL，用 COALESCE 归零；两表列名一致可复用） */
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

interface HourlyRow {
  /** strftime('%H') 输出的两位字符串（'00'–'23'） */
  hour: string
  /** strftime('%Y-%m-%d') 输出的本地日期，跨天窗口区分同钟点 */
  day_key: string
  request_count: number
  success_count: number
  error_count: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  cost_micro_usd: number
}

/** 把 LogFilters 翻译成明细表 WHERE 子句与参数（page/pageSize 不参与，由分页方法单独处理） */
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

const preparedStatements = new WeakMap<SqliteDatabase, Map<string, Database.Statement>>()

function prepareCached(db: SqliteDatabase, sql: string): Database.Statement {
  let cache = preparedStatements.get(db)
  if (cache == null) {
    cache = new Map()
    preparedStatements.set(db, cache)
  }
  const cached = cache.get(sql)
  if (cached != null) return cached
  const stmt = db.prepare(sql)
  cache.set(sql, stmt)
  return stmt
}

/**
 * rollup 下推路径的 WHERE：appTypes/models 直接对应列；
 * 时间范围映射为本地日期区间（date >= start 所在日、date <= end 所在日），边界整天计入。
 */
function buildRollupWhere(filters: LogFilters): { sql: string; params: unknown[] } {
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
    clauses.push('date >= ?')
    params.push(toDateKey(filters.startTime))
  }
  if (filters.endTime != null) {
    clauses.push('date <= ?')
    params.push(toDateKey(filters.endTime))
  }

  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

/** Hero 汇总行：可下推走 rollups，否则回退明细表（行列结构一致） */
function querySummaryRow(db: SqliteDatabase, filters: LogFilters): SummaryRow {
  if (canUseRollups(filters)) {
    const { sql, params } = buildRollupWhere(filters)
    return prepareCached(
      db,
      `SELECT ${SUM_ROLLUP_REQUESTS} AS total_requests,
              ${SUM_ROLLUP_SUCCESS} AS success_count,
              ${SUM_ROLLUP_ERROR} AS error_count,
              ${SUM_TOKENS.input} AS input_tokens,
              ${SUM_TOKENS.output} AS output_tokens,
              ${SUM_TOKENS.cacheRead} AS cache_read_tokens,
              ${SUM_TOKENS.cacheCreation} AS cache_creation_tokens,
              COALESCE(${SUM_COST_MICRO}, 0) AS cost_micro_usd
       FROM usage_daily_rollups
       ${sql}`
    )
      .get(...params) as SummaryRow
  }
  const { sql, params } = buildWhere(filters)
  return prepareCached(
    db,
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
}

/** 按天趋势行：可下推时 rollup 已按本地日归桶，直接对桶求和再按 date 分组 */
function queryDailyRows(db: SqliteDatabase, filters: LogFilters): DailyRow[] {
  if (canUseRollups(filters)) {
    const { sql, params } = buildRollupWhere(filters)
    return prepareCached(
      db,
      `SELECT date,
              ${SUM_ROLLUP_REQUESTS} AS request_count,
              ${SUM_ROLLUP_SUCCESS} AS success_count,
              ${SUM_ROLLUP_ERROR} AS error_count,
              ${SUM_TOKENS.input} AS input_tokens,
              ${SUM_TOKENS.output} AS output_tokens,
              ${SUM_TOKENS.cacheRead} AS cache_read_tokens,
              ${SUM_TOKENS.cacheCreation} AS cache_creation_tokens,
              COALESCE(${SUM_COST_MICRO}, 0) AS cost_micro_usd
       FROM usage_daily_rollups
       ${sql}
       GROUP BY date
       ORDER BY date ASC`
    )
      .all(...params) as DailyRow[]
  }
  const { sql, params } = buildWhere(filters)
  return prepareCached(
    db,
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
}

/**
 * 按模型统计行：可下推时平均延迟 = Σlatency_ms_total / Σrequest_count（rollup 不存单条耗时，
 * NULL 计 0，与明细 AVG(latency_ms) 忽略 NULL 口径略有差异）；防除零返回 NULL。
 */
function queryModelRows(db: SqliteDatabase, filters: LogFilters): ModelRow[] {
  if (canUseRollups(filters)) {
    const { sql, params } = buildRollupWhere(filters)
    return prepareCached(
      db,
      `SELECT model,
              MIN(app_type) AS app_type,
              ${SUM_ROLLUP_REQUESTS} AS request_count,
              ${SUM_ROLLUP_SUCCESS} AS success_count,
              ${SUM_TOKENS.input} AS input_tokens,
              ${SUM_TOKENS.output} AS output_tokens,
              ${SUM_TOKENS.cacheRead} AS cache_read_tokens,
              ${SUM_TOKENS.cacheCreation} AS cache_creation_tokens,
              COALESCE(${SUM_COST_MICRO}, 0) AS cost_micro_usd,
              CASE WHEN COALESCE(SUM(request_count), 0) > 0
                   THEN SUM(latency_ms_total) * 1.0 / SUM(request_count)
                   ELSE NULL END AS avg_latency_ms
       FROM usage_daily_rollups
       ${sql}
       GROUP BY model
       ORDER BY request_count DESC, model ASC`
    )
      .all(...params) as ModelRow[]
  }
  const { sql, params } = buildWhere(filters)
  return prepareCached(
    db,
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
}

/** 按应用统计行：可下推走 rollups 按 app_type 分组 */
function queryAppRows(db: SqliteDatabase, filters: LogFilters): AppRow[] {
  if (canUseRollups(filters)) {
    const { sql, params } = buildRollupWhere(filters)
    return prepareCached(
      db,
      `SELECT app_type,
              ${SUM_ROLLUP_REQUESTS} AS request_count,
              ${SUM_ROLLUP_SUCCESS} AS success_count,
              ${SUM_TOKENS.input} AS input_tokens,
              ${SUM_TOKENS.output} AS output_tokens,
              ${SUM_TOKENS.cacheRead} AS cache_read_tokens,
              ${SUM_TOKENS.cacheCreation} AS cache_creation_tokens,
              COALESCE(${SUM_COST_MICRO}, 0) AS cost_micro_usd
       FROM usage_daily_rollups
       ${sql}
       GROUP BY app_type
       ORDER BY request_count DESC, app_type ASC`
    )
      .all(...params) as AppRow[]
  }
  const { sql, params } = buildWhere(filters)
  return prepareCached(
    db,
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
}

/** 按小时趋势行：rollup 表无小时粒度，恒走明细表按本地时区 (day_key, hour) 双维归桶（跨天窗口不合并同钟点） */
function queryHourlyRows(db: SqliteDatabase, filters: LogFilters): HourlyRow[] {
  const { sql, params } = buildWhere(filters)
  return prepareCached(
    db,
    `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS day_key,
            strftime('%H', created_at / 1000, 'unixepoch', 'localtime') AS hour,
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
     GROUP BY day_key, hour
     ORDER BY day_key ASC, hour ASC`
  )
    .all(...params) as HourlyRow[]
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
  /** 按小时（本地时区 0–23）趋势序列：默认限定今天，filters 显式给 startTime/endTime 时尊重之；桶含日期维度（dayKey），跨天窗口不合并同钟点 */
  getHourlyTrends(filters: LogFilters): Promise<HourlyStats[]>
  /** 按归一化模型分组统计 */
  getModelStats(filters: LogFilters): Promise<ModelStats[]>
  /** 按应用（监控对象 app_type）分组统计 */
  getAppStats(filters: LogFilters): Promise<AppStats[]>
  /** 分页明细（created_at 倒序），支持 keyword 模糊匹配 */
  getRequestLogs(filters: LogFilters): Promise<PaginatedLogs>
  /** 单条明细（无则 null） */
  getRequestLogDetail(id: string): Promise<RequestLogDetail | null>
  /** 筛选候选：模型/项目 distinct 非空值（升序，各截断至 FILTER_OPTIONS_LIMIT） */
  getFilterOptions(): Promise<FilterOptions>
}

/** 筛选候选各维度返回上限：极端日志量下防止候选列表无限膨胀，拖垮 IPC 序列化与下拉渲染 */
export const FILTER_OPTIONS_LIMIT = 500

/** usage_records 单列 distinct 非空值升序（column 仅接受白名单字面量，无注入面） */
function queryDistinctColumn(db: SqliteDatabase, column: 'model' | 'project'): string[] {
  const rows = prepareCached(
    db,
    `SELECT DISTINCT ${column} AS value
     FROM usage_records
     WHERE ${column} IS NOT NULL AND ${column} <> ''
     ORDER BY value ASC
     LIMIT ?`
  )
    .all(FILTER_OPTIONS_LIMIT) as Array<{ value: string }>
  return rows.map((r) => r.value)
}

/**
 * 建工厂：直接接收已打开的数据库实例（:memory: 或文件模式均可，须已迁移建表）。
 * 所有方法只读，不修改任何数据。
 */
export function createUsageQuery(db: SqliteDatabase): UsageQueryService {
  return {
    getUsageSummary(filters): Promise<UsageSummary> {
      const row = querySummaryRow(db, filters)

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
      const rows = queryDailyRows(db, filters)

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

    getHourlyTrends(filters): Promise<HourlyStats[]> {
      // 默认限定「今天」（本地时区 00:00 起），只补缺失的一侧；显式给了时间范围则完全尊重调用方
      const effective =
        filters.startTime != null && filters.endTime != null
          ? filters
          : {
              ...filters,
              startTime: filters.startTime ?? startOfTodayMs(),
              endTime: filters.endTime ?? Date.now()
            }
      const rows = queryHourlyRows(db, effective)

      return Promise.resolve(
        rows.map((r) => ({
          hour: Number.parseInt(r.hour, 10),
          dayKey: r.day_key,
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
      const rows = queryModelRows(db, filters)

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
      const rows = queryAppRows(db, filters)

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
      const countRow = prepareCached(db, `SELECT COUNT(*) AS total FROM usage_records ${sql}`)
        .get(...params) as { total: number }
      const total = countRow.total
      const items = prepareCached(
        db,
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
      const row = prepareCached(db, 'SELECT * FROM usage_records WHERE id = ?').get(
        id
      ) as UsageRecordRow | undefined
      return Promise.resolve(row ? toDetail(row) : null)
    },

    getFilterOptions(): Promise<FilterOptions> {
      return Promise.resolve({
        models: queryDistinctColumn(db, 'model'),
        projects: queryDistinctColumn(db, 'project')
      })
    }
  }
}
