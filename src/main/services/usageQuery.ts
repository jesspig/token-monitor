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


const MICRO_PER_USD = 1_000_000

function fromMicroUsd(micro: number): string {
  return (micro / MICRO_PER_USD).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0'
}

function toDateKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function startOfTodayMs(): number {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()
}

function canUseRollups(filters: LogFilters): boolean {
  const httpStatus = filters.httpStatus ?? filters.statusCode
  return (
    filters.status == null &&
    httpStatus == null &&
    (filters.project == null || filters.project === '') &&
    (filters.sessionId == null || filters.sessionId === '') &&
    (filters.keyword == null || filters.keyword === '')
  )
}

const SUM_COST_MICRO = "SUM(CAST(ROUND(COALESCE(cost_usd, '0') * 1000000) AS INTEGER))"
const SUM_SUCCESS = "COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0)"
const SUM_ERROR = "COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0)"
const SUM_ROLLUP_REQUESTS = 'COALESCE(SUM(request_count), 0)'
const SUM_ROLLUP_SUCCESS = 'COALESCE(SUM(success_count), 0)'
const SUM_ROLLUP_ERROR = 'COALESCE(SUM(error_count), 0)'
const SUM_TOKENS = {
  input: 'COALESCE(SUM(input_tokens), 0)',
  output: 'COALESCE(SUM(output_tokens), 0)',
  cacheRead: 'COALESCE(SUM(cache_read_tokens), 0)',
  cacheCreation: 'COALESCE(SUM(cache_creation_tokens), 0)'
} as const

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
  hour: string
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
  const httpStatus = filters.httpStatus ?? filters.statusCode
  if (httpStatus != null) {
    clauses.push('http_status = ?')
    params.push(httpStatus)
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

function queryHourlyRows(db: SqliteDatabase, filters: LogFilters): HourlyRow[] {
  const startTime = filters.startTime ?? startOfTodayMs()
  const endTime = filters.endTime ?? Date.now()
  const startDay = toDateKey(startTime)
  const endDay = toDateKey(endTime)

  if (!canUseRollups(filters)) {
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

  const extra: string[] = []
  const params: unknown[] = [startDay, endDay]
  if (filters.appTypes && filters.appTypes.length > 0) {
    extra.push(`app_type IN (${filters.appTypes.map(() => '?').join(', ')})`)
    params.push(...filters.appTypes)
  }
  if (filters.models && filters.models.length > 0) {
    extra.push(`model IN (${filters.models.map(() => '?').join(', ')})`)
    params.push(...filters.models)
  }
  const where = `WHERE date BETWEEN ? AND ?${extra.length ? ' AND ' + extra.join(' AND ') : ''}`
  const rows = prepareCached(
    db,
    `SELECT date AS day_key,
            printf('%02d', hour) AS hour,
            SUM(request_count) AS request_count,
            SUM(success_count) AS success_count,
            SUM(error_count) AS error_count,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens,
            SUM(cache_read_tokens) AS cache_read_tokens,
            SUM(cache_creation_tokens) AS cache_creation_tokens,
            COALESCE(SUM(CAST(ROUND(COALESCE(cost_usd, '0') * 1000000) AS INTEGER)), 0) AS cost_micro_usd
     FROM usage_hourly_rollups
     ${where}
     GROUP BY day_key, hour
     ORDER BY day_key ASC, hour ASC`
  ).all(...params) as HourlyRow[]

  return rows.filter((r) => {
    const bucketMs = new Date(`${r.day_key}T${r.hour}:00`).getTime()
    const bucketEnd = bucketMs + 3_600_000 - 1
    return bucketEnd >= startTime && bucketMs <= endTime
  })
}

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
    httpStatus: row.http_status ?? null,
    errorMessage: row.error_message ?? null,
    createdAt: row.created_at,
    sourceFile: row.file_path,
    sourceLine: row.line
  }
}

export interface UsageQueryService {
  getUsageSummary(filters: LogFilters): Promise<UsageSummary>
  getDailyTrends(filters: LogFilters): Promise<DailyStats[]>
  getHourlyTrends(filters: LogFilters): Promise<HourlyStats[]>
  getModelStats(filters: LogFilters): Promise<ModelStats[]>
  getAppStats(filters: LogFilters): Promise<AppStats[]>
  getRequestLogs(filters: LogFilters): Promise<PaginatedLogs>
  getRequestLogDetail(id: string): Promise<RequestLogDetail | null>
  getFilterOptions(): Promise<FilterOptions>
}

export const FILTER_OPTIONS_LIMIT = 500

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
