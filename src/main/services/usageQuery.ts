import type Database from 'better-sqlite3'
import type { AppType, RequestStatus } from '../../../shared/app'
import type {
  AppStats,
  DailyModelBreakdown,
  DailyStats,
  FilterOptions,
  HourlyStats,
  LogFilters,
  ModelStats,
  PaginatedLogs,
  ProjectStats,
  RequestLogDetail,
  SessionStats,
  StatusStats,
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

interface DailyModelRow {
  date: string
  model: string
  tokens: number
  cost_micro: number
  request_count: number
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

interface PathSpec {
  table: string
  where: { sql: string; params: unknown[] }
  groupSelect: string
  groupBy: string
  requestExpr: string
  successExpr: string
  errorExpr: string | null
  requestAlias: string
  leadingExtra: string[]
  trailingExtra: string[]
  postFilter?: (rows: any[]) => any[]
}

interface GroupBySpec {
  detail: PathSpec
  rollup?: PathSpec
  orderBy: string
}

const MODEL_AVG_LATENCY_ROLLUP = `CASE WHEN COALESCE(SUM(request_count), 0) > 0
         THEN SUM(latency_ms_total) * 1.0 / SUM(request_count)
         ELSE NULL END AS avg_latency_ms`
const MODEL_AVG_LATENCY_DETAIL = `AVG(latency_ms) AS avg_latency_ms`

function buildMetricsExpr(path: PathSpec): string {
  const parts: string[] = [
    `${path.requestExpr} AS ${path.requestAlias}`,
    `${path.successExpr} AS success_count`
  ]
  if (path.errorExpr != null) {
    parts.push(`${path.errorExpr} AS error_count`)
  }
  parts.push(
    `${SUM_TOKENS.input} AS input_tokens`,
    `${SUM_TOKENS.output} AS output_tokens`,
    `${SUM_TOKENS.cacheRead} AS cache_read_tokens`,
    `${SUM_TOKENS.cacheCreation} AS cache_creation_tokens`,
    `COALESCE(${SUM_COST_MICRO}, 0) AS cost_micro_usd`
  )
  return parts.join(',\n              ')
}

function queryGroupBy<T>(db: SqliteDatabase, filters: LogFilters, spec: GroupBySpec): T[] {
  const useRollup = spec.rollup != null && canUseRollups(filters)
  const path = useRollup ? spec.rollup! : spec.detail
  const selectParts: string[] = []
  if (path.groupSelect) selectParts.push(path.groupSelect)
  selectParts.push(...path.leadingExtra)
  selectParts.push(buildMetricsExpr(path))
  selectParts.push(...path.trailingExtra)

  const clauses = [`SELECT ${selectParts.join(',\n              ')}`, `FROM ${path.table}`]
  if (path.where.sql) clauses.push(path.where.sql)
  if (path.groupBy) clauses.push(`GROUP BY ${path.groupBy}`)
  if (spec.orderBy) clauses.push(`ORDER BY ${spec.orderBy}`)
  const sql = clauses.join('\n       ')

  let rows = prepareCached(db, sql).all(...path.where.params) as T[]
  if (useRollup && path.postFilter != null) {
    rows = path.postFilter(rows) as T[]
  }
  return rows
}

function querySummaryRow(db: SqliteDatabase, filters: LogFilters): SummaryRow {
  return queryGroupBy<SummaryRow>(db, filters, {
    orderBy: '',
    detail: {
      table: 'usage_records',
      where: buildWhere(filters),
      groupSelect: '',
      groupBy: '',
      requestExpr: 'COUNT(*)',
      successExpr: SUM_SUCCESS,
      errorExpr: SUM_ERROR,
      requestAlias: 'total_requests',
      leadingExtra: [],
      trailingExtra: []
    },
    rollup: {
      table: 'usage_daily_rollups',
      where: buildRollupWhere(filters),
      groupSelect: '',
      groupBy: '',
      requestExpr: SUM_ROLLUP_REQUESTS,
      successExpr: SUM_ROLLUP_SUCCESS,
      errorExpr: SUM_ROLLUP_ERROR,
      requestAlias: 'total_requests',
      leadingExtra: [],
      trailingExtra: []
    }
  })[0]
}

function queryDailyRows(db: SqliteDatabase, filters: LogFilters): DailyRow[] {
  const dateExpr = `strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime')`
  return queryGroupBy<DailyRow>(db, filters, {
    orderBy: 'date ASC',
    detail: {
      table: 'usage_records',
      where: buildWhere(filters),
      groupSelect: `${dateExpr} AS date`,
      groupBy: 'date',
      requestExpr: 'COUNT(*)',
      successExpr: SUM_SUCCESS,
      errorExpr: SUM_ERROR,
      requestAlias: 'request_count',
      leadingExtra: [],
      trailingExtra: []
    },
    rollup: {
      table: 'usage_daily_rollups',
      where: buildRollupWhere(filters),
      groupSelect: 'date',
      groupBy: 'date',
      requestExpr: SUM_ROLLUP_REQUESTS,
      successExpr: SUM_ROLLUP_SUCCESS,
      errorExpr: SUM_ROLLUP_ERROR,
      requestAlias: 'request_count',
      leadingExtra: [],
      trailingExtra: []
    }
  })
}

function queryModelRows(db: SqliteDatabase, filters: LogFilters): ModelRow[] {
  return queryGroupBy<ModelRow>(db, filters, {
    orderBy: 'request_count DESC, model ASC',
    detail: {
      table: 'usage_records',
      where: buildWhere(filters),
      groupSelect: 'model',
      groupBy: 'model',
      requestExpr: 'COUNT(*)',
      successExpr: SUM_SUCCESS,
      errorExpr: null,
      requestAlias: 'request_count',
      leadingExtra: ['MIN(app_type) AS app_type'],
      trailingExtra: [MODEL_AVG_LATENCY_DETAIL]
    },
    rollup: {
      table: 'usage_daily_rollups',
      where: buildRollupWhere(filters),
      groupSelect: 'model',
      groupBy: 'model',
      requestExpr: SUM_ROLLUP_REQUESTS,
      successExpr: SUM_ROLLUP_SUCCESS,
      errorExpr: null,
      requestAlias: 'request_count',
      leadingExtra: ['MIN(app_type) AS app_type'],
      trailingExtra: [MODEL_AVG_LATENCY_ROLLUP]
    }
  })
}

function queryAppRows(db: SqliteDatabase, filters: LogFilters): AppRow[] {
  return queryGroupBy<AppRow>(db, filters, {
    orderBy: 'request_count DESC, app_type ASC',
    detail: {
      table: 'usage_records',
      where: buildWhere(filters),
      groupSelect: 'app_type',
      groupBy: 'app_type',
      requestExpr: 'COUNT(*)',
      successExpr: SUM_SUCCESS,
      errorExpr: null,
      requestAlias: 'request_count',
      leadingExtra: [],
      trailingExtra: []
    },
    rollup: {
      table: 'usage_daily_rollups',
      where: buildRollupWhere(filters),
      groupSelect: 'app_type',
      groupBy: 'app_type',
      requestExpr: SUM_ROLLUP_REQUESTS,
      successExpr: SUM_ROLLUP_SUCCESS,
      errorExpr: null,
      requestAlias: 'request_count',
      leadingExtra: [],
      trailingExtra: []
    }
  })
}

interface ProjectRow extends GroupRow {
  project: string
}

interface SessionRow extends GroupRow {
  session_id: string
}

interface StatusRow extends GroupRow {
  status: string
}

function detailWhereExcludingNull(
  filters: LogFilters,
  column: string
): { sql: string; params: unknown[] } {
  const base = buildWhere(filters)
  const filter = `${column} IS NOT NULL AND ${column} <> ''`
  if (base.sql) {
    return { sql: `${base.sql} AND ${filter}`, params: base.params }
  }
  return { sql: `WHERE ${filter}`, params: [] }
}

function queryProjectRows(db: SqliteDatabase, filters: LogFilters): ProjectRow[] {
  return queryGroupBy<ProjectRow>(db, filters, {
    orderBy: 'request_count DESC',
    detail: {
      table: 'usage_records',
      where: detailWhereExcludingNull(filters, 'project'),
      groupSelect: 'project',
      groupBy: 'project',
      requestExpr: 'COUNT(*)',
      successExpr: SUM_SUCCESS,
      errorExpr: null,
      requestAlias: 'request_count',
      leadingExtra: [],
      trailingExtra: []
    }
  })
}

function querySessionRows(db: SqliteDatabase, filters: LogFilters): SessionRow[] {
  return queryGroupBy<SessionRow>(db, filters, {
    orderBy: 'request_count DESC',
    detail: {
      table: 'usage_records',
      where: detailWhereExcludingNull(filters, 'session_id'),
      groupSelect: 'session_id',
      groupBy: 'session_id',
      requestExpr: 'COUNT(*)',
      successExpr: SUM_SUCCESS,
      errorExpr: null,
      requestAlias: 'request_count',
      leadingExtra: [],
      trailingExtra: []
    }
  })
}

function queryStatusRows(db: SqliteDatabase, filters: LogFilters): StatusRow[] {
  return queryGroupBy<StatusRow>(db, filters, {
    orderBy: 'request_count DESC',
    detail: {
      table: 'usage_records',
      where: detailWhereExcludingNull(filters, 'status'),
      groupSelect: 'status',
      groupBy: 'status',
      requestExpr: 'COUNT(*)',
      successExpr: SUM_SUCCESS,
      errorExpr: null,
      requestAlias: 'request_count',
      leadingExtra: [],
      trailingExtra: []
    }
  })
}

function queryHourlyRows(db: SqliteDatabase, filters: LogFilters): HourlyRow[] {
  const startTime = filters.startTime ?? startOfTodayMs()
  const endTime = filters.endTime ?? Date.now()
  const startDay = toDateKey(startTime)
  const endDay = toDateKey(endTime)

  const dayKeyExpr = `strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime')`
  const hourExpr = `strftime('%H', created_at / 1000, 'unixepoch', 'localtime')`
  const detail: PathSpec = {
    table: 'usage_records',
    where: buildWhere(filters),
    groupSelect: `${dayKeyExpr} AS day_key,\n              ${hourExpr} AS hour`,
    groupBy: 'day_key, hour',
    requestExpr: 'COUNT(*)',
    successExpr: SUM_SUCCESS,
    errorExpr: SUM_ERROR,
    requestAlias: 'request_count',
    leadingExtra: [],
    trailingExtra: []
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
  const rollupWhere = {
    sql: `WHERE date BETWEEN ? AND ?${extra.length ? ' AND ' + extra.join(' AND ') : ''}`,
    params
  }
  const rollup: PathSpec = {
    table: 'usage_hourly_rollups',
    where: rollupWhere,
    groupSelect: `date AS day_key,\n              printf('%02d', hour) AS hour`,
    groupBy: 'day_key, hour',
    requestExpr: 'SUM(request_count)',
    successExpr: 'SUM(success_count)',
    errorExpr: 'SUM(error_count)',
    requestAlias: 'request_count',
    leadingExtra: [],
    trailingExtra: [],
    postFilter: (rows) =>
      rows.filter((r) => {
        const bucketMs = new Date(`${r.day_key}T${r.hour}:00`).getTime()
        const bucketEnd = bucketMs + 3_600_000 - 1
        return bucketEnd >= startTime && bucketMs <= endTime
      })
  }

  return queryGroupBy<HourlyRow>(db, filters, {
    orderBy: 'day_key ASC, hour ASC',
    detail,
    rollup
  })
}

function queryDailyModelRows(db: SqliteDatabase, filters: LogFilters): DailyModelRow[] {
  const { sql, params } = buildWhere(filters)
  const dateExpr = `strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime')`
  const sqlText = `SELECT ${dateExpr} AS date, model, COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens), 0) AS tokens, COALESCE(${SUM_COST_MICRO}, 0) AS cost_micro, COUNT(*) AS request_count FROM usage_records ${sql} GROUP BY date, model ORDER BY date ASC, tokens DESC`
  return prepareCached(db, sqlText).all(...params) as DailyModelRow[]
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
  getStatsByProject(filters: LogFilters): Promise<ProjectStats[]>
  getStatsBySession(filters: LogFilters): Promise<SessionStats[]>
  getStatsByStatus(filters: LogFilters): Promise<StatusStats[]>
  getRequestLogs(filters: LogFilters): Promise<PaginatedLogs>
  getRequestLogDetail(id: string): Promise<RequestLogDetail | null>
  getFilterOptions(): Promise<FilterOptions>
  getDailyModelBreakdown(filters: LogFilters): Promise<DailyModelBreakdown[]>
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

    getStatsByProject(filters): Promise<ProjectStats[]> {
      const rows = queryProjectRows(db, filters)

      return Promise.resolve(
        rows
          .map((r) => ({
            project: r.project,
            requestCount: r.request_count,
            inputTokens: r.input_tokens,
            outputTokens: r.output_tokens,
            cacheReadTokens: r.cache_read_tokens,
            cacheCreationTokens: r.cache_creation_tokens,
            costUsd: fromMicroUsd(r.cost_micro_usd),
            successRate: r.request_count > 0 ? r.success_count / r.request_count : 0
          }))
          .slice(0, 200)
      )
    },

    getStatsBySession(filters): Promise<SessionStats[]> {
      const rows = querySessionRows(db, filters)

      return Promise.resolve(
        rows
          .map((r) => ({
            sessionId: r.session_id,
            requestCount: r.request_count,
            inputTokens: r.input_tokens,
            outputTokens: r.output_tokens,
            cacheReadTokens: r.cache_read_tokens,
            cacheCreationTokens: r.cache_creation_tokens,
            costUsd: fromMicroUsd(r.cost_micro_usd),
            successRate: r.request_count > 0 ? r.success_count / r.request_count : 0
          }))
          .slice(0, 200)
      )
    },

    getStatsByStatus(filters): Promise<StatusStats[]> {
      const rows = queryStatusRows(db, filters)

      return Promise.resolve(
        rows
          .map((r) => ({
            status: r.status,
            requestCount: r.request_count,
            inputTokens: r.input_tokens,
            outputTokens: r.output_tokens,
            cacheReadTokens: r.cache_read_tokens,
            cacheCreationTokens: r.cache_creation_tokens,
            costUsd: fromMicroUsd(r.cost_micro_usd),
            successRate: r.request_count > 0 ? r.success_count / r.request_count : 0
          }))
          .slice(0, 200)
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
    },

    getDailyModelBreakdown(filters): Promise<DailyModelBreakdown[]> {
      const rows = queryDailyModelRows(db, filters)
      return Promise.resolve(
        rows.map((r) => ({
          date: r.date,
          model: r.model,
          tokens: r.tokens,
          cost: fromMicroUsd(r.cost_micro),
          requestCount: r.request_count
        }))
      )
    }
  }
}
