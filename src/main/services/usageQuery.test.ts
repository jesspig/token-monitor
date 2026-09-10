import { describe, it, expect } from 'vitest'
import type { UsageRecord } from '../../../shared/dto'
import type { UsageRecordRow } from '../../../shared/tables'
import { createDatabase, migrate, type SqliteDatabase } from './db'
import { cleanupOldRecords } from './retention'
import { SqliteStorage } from './storage'
import { createUsageQuery, FILTER_OPTIONS_LIMIT, type UsageQueryService } from './usageQuery'


const DAY_MS = 86_400_000

function toDateKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const MICRO_PER_USD = 1_000_000

function toMicroUsd(costUsd?: string | null): number {
  if (costUsd == null || costUsd === '') return 0
  const n = Number(costUsd)
  return Number.isFinite(n) ? Math.round(n * MICRO_PER_USD) : 0
}

function fromMicroUsd(micro: number): string {
  return (micro / MICRO_PER_USD).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0'
}

interface RollupBucket {
  date: string
  appType: string
  model: string
  requestCount: number
  successCount: number
  errorCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costMicroUsd: number
  latencyMsTotal: number
}

function refreshRollups(db: SqliteDatabase): void {
  const rows = db.prepare('SELECT * FROM usage_records').all() as UsageRecordRow[]
  const buckets = new Map<string, RollupBucket>()
  for (const r of rows) {
    const date = toDateKey(r.created_at)
    const key = `${r.app_type}\u0000${date}\u0000${r.model}`
    let b = buckets.get(key)
    if (!b) {
      b = {
        date,
        appType: r.app_type,
        model: r.model,
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costMicroUsd: 0,
        latencyMsTotal: 0
      }
      buckets.set(key, b)
    }
    b.requestCount++
    if (r.status === 'error') b.errorCount++
    else b.successCount++
    b.inputTokens += r.input_tokens
    b.outputTokens += r.output_tokens
    b.cacheReadTokens += r.cache_read_tokens
    b.cacheCreationTokens += r.cache_creation_tokens
    b.costMicroUsd += toMicroUsd(r.cost_usd)
    b.latencyMsTotal += r.latency_ms ?? 0
  }

  db.prepare('DELETE FROM usage_daily_rollups').run()
  const insert = db.prepare(`
    INSERT INTO usage_daily_rollups (
      date, app_type, model, request_count, success_count, error_count,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      cost_usd, latency_ms_total, updated_at
    ) VALUES (
      @date, @app_type, @model, @request_count, @success_count, @error_count,
      @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
      @cost_usd, @latency_ms_total, @updated_at
    )
  `)
  for (const b of buckets.values()) {
    insert.run({
      date: b.date,
      app_type: b.appType,
      model: b.model,
      request_count: b.requestCount,
      success_count: b.successCount,
      error_count: b.errorCount,
      input_tokens: b.inputTokens,
      output_tokens: b.outputTokens,
      cache_read_tokens: b.cacheReadTokens,
      cache_creation_tokens: b.cacheCreationTokens,
      cost_usd: fromMicroUsd(b.costMicroUsd),
      latency_ms_total: b.latencyMsTotal,
      updated_at: Date.now()
    })
  }
}

interface HourlyBucket {
  date: string
  hour: number
  appType: string
  model: string
  requestCount: number
  successCount: number
  errorCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costMicroUsd: number
  latencyMsTotal: number
}

function refreshHourlyRollups(db: SqliteDatabase): void {
  const rows = db.prepare('SELECT * FROM usage_records').all() as UsageRecordRow[]
  const buckets = new Map<string, HourlyBucket>()
  for (const r of rows) {
    const date = toDateKey(r.created_at)
    const hour = new Date(r.created_at).getHours()
    const key = `${r.app_type}\u0000${date}\u0000${hour}\u0000${r.model}`
    let b = buckets.get(key)
    if (!b) {
      b = {
        date,
        hour,
        appType: r.app_type,
        model: r.model,
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costMicroUsd: 0,
        latencyMsTotal: 0
      }
      buckets.set(key, b)
    }
    b.requestCount++
    if (r.status === 'error') b.errorCount++
    else b.successCount++
    b.inputTokens += r.input_tokens
    b.outputTokens += r.output_tokens
    b.cacheReadTokens += r.cache_read_tokens
    b.cacheCreationTokens += r.cache_creation_tokens
    b.costMicroUsd += toMicroUsd(r.cost_usd)
    b.latencyMsTotal += r.latency_ms ?? 0
  }

  db.prepare('DELETE FROM usage_hourly_rollups').run()
  const insertH = db.prepare(`
    INSERT INTO usage_hourly_rollups (
      date, hour, app_type, model, request_count, success_count, error_count,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, latency_ms_total, updated_at
    ) VALUES (
      @date, @hour, @app_type, @model, @request_count, @success_count, @error_count,
      @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens, @cost_usd, @latency_ms_total, @updated_at
    )
  `)
  for (const b of buckets.values()) {
    insertH.run({
      date: b.date,
      hour: b.hour,
      app_type: b.appType,
      model: b.model,
      request_count: b.requestCount,
      success_count: b.successCount,
      error_count: b.errorCount,
      input_tokens: b.inputTokens,
      output_tokens: b.outputTokens,
      cache_read_tokens: b.cacheReadTokens,
      cache_creation_tokens: b.cacheCreationTokens,
      cost_usd: fromMicroUsd(b.costMicroUsd),
      latency_ms_total: b.latencyMsTotal,
      updated_at: Date.now()
    })
  }
}

function insert(db: SqliteDatabase, overrides: Partial<UsageRecordRow> = {}): string {
  const row: UsageRecordRow = {
    id: `t:${Math.random().toString(36).slice(2)}`,
    data_source: 'claude',
    app_type: 'claude',
    model: 'claude-sonnet-4',
    raw_model: 'claude-sonnet-4',
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 20,
    cache_creation_tokens: 10,
    input_semantics: 1,
    cost_usd: '0.001',
    currency: 'USD',
    latency_ms: 800,
    project: null,
    session_id: null,
    status: 'success',
    file_path: '/sessions/claude/a.jsonl',
    line: 1,
    created_at: new Date('2026-08-18T10:00:00+08:00').getTime(),
    ...overrides,
    http_status: overrides.http_status ?? null,
    error_message: overrides.error_message ?? null
  }
  db.prepare(
    `INSERT INTO usage_records (
        id, data_source, app_type, model, raw_model,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        input_semantics, cost_usd, currency, latency_ms, project, session_id,
        status, http_status, error_message, file_path, line, created_at
      ) VALUES (
        @id, @data_source, @app_type, @model, @raw_model,
        @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
        @input_semantics, @cost_usd, @currency, @latency_ms, @project, @session_id,
        @status, @http_status, @error_message, @file_path, @line, @created_at
      )`
  ).run(row)
  return row.id
}

function makeQuery(): { query: UsageQueryService; db: SqliteDatabase } {
  const db = createDatabase(':memory:')
  migrate(db)
  return { query: createUsageQuery(db), db }
}

function seed(db: SqliteDatabase): void {
  const d1a = new Date('2026-08-18T10:00:00+08:00').getTime()
  const d1b = new Date('2026-08-18T12:00:00+08:00').getTime()
  const d2a = new Date('2026-08-19T09:00:00+08:00').getTime()
  const d2b = new Date('2026-08-19T10:00:00+08:00').getTime()
  const d2c = new Date('2026-08-19T11:00:00+08:00').getTime()

  insert(db, {
    id: 'A',
    app_type: 'claude',
    model: 'claude-sonnet-4',
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 20,
    cache_creation_tokens: 10,
    cost_usd: '0.001',
    latency_ms: 800,
    project: 'alpha',
    session_id: 'sess-a',
    status: 'success',
    file_path: '/sessions/claude/a.jsonl',
    line: 1,
    created_at: d1a
  })
  insert(db, {
    id: 'B',
    app_type: 'claude',
    model: 'claude-sonnet-4',
    input_tokens: 200,
    output_tokens: 100,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_usd: null,
    latency_ms: null,
    status: 'error',
    file_path: '/sessions/claude/a.jsonl',
    line: 2,
    created_at: d1b
  })
  insert(db, {
    id: 'C',
    app_type: 'codex',
    model: 'gpt-5',
    raw_model: 'gpt-5',
    input_tokens: 10,
    output_tokens: 20,
    cache_read_tokens: 5,
    cache_creation_tokens: 2,
    cost_usd: '0.010000',
    latency_ms: 100,
    status: 'success',
    file_path: '/sessions/codex/b.jsonl',
    line: 1,
    created_at: d2a
  })
  insert(db, {
    id: 'D',
    app_type: 'codex',
    model: 'gpt-5',
    raw_model: 'gpt-5',
    input_tokens: 30,
    output_tokens: 40,
    cache_read_tokens: 5,
    cache_creation_tokens: 3,
    cost_usd: '0.020000',
    latency_ms: 200,
    project: 'alpha',
    session_id: 'sess-abc',
    status: 'success',
    file_path: '/sessions/codex/b.jsonl',
    line: 2,
    created_at: d2b
  })
  insert(db, {
    id: 'E',
    app_type: 'gemini',
    model: 'gemini-2.5-pro',
    raw_model: 'gemini-2.5-pro',
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_tokens: 400,
    cache_creation_tokens: 100,
    cost_usd: '0.005',
    latency_ms: 300,
    project: 'beta',
    session_id: 'sess-x',
    status: 'success',
    file_path: '/sessions/gemini/c.jsonl',
    line: 1,
    created_at: d2c
  })

  refreshRollups(db)
}

describe('getUsageSummary', () => {
  it('无筛选聚合全部记录：计数/各 token/费用/比率', async () => {
    const { query, db } = makeQuery()
    seed(db)
    const s = await query.getUsageSummary({})
    expect(s.totalRequests).toBe(5)
    expect(s.successCount).toBe(4)
    expect(s.errorCount).toBe(1)
    expect(s.totalCost).toBe('0.036')
    expect(s.inputTokens).toBe(1340)
    expect(s.outputTokens).toBe(710)
    expect(s.cacheReadTokens).toBe(430)
    expect(s.cacheCreationTokens).toBe(115)
    expect(s.realTotalTokens).toBe(2595)
    expect(s.cacheHitRate).toBeCloseTo(430 / (1340 + 430), 10)
    expect(s.successRate).toBe(0.8)
  })

  it('按 appTypes 筛选聚合', async () => {
    const { query, db } = makeQuery()
    seed(db)
    const s = await query.getUsageSummary({ appTypes: ['codex'] })
    expect(s.totalRequests).toBe(2)
    expect(s.successCount).toBe(2)
    expect(s.errorCount).toBe(0)
    expect(s.totalCost).toBe('0.03')
    expect(s.realTotalTokens).toBe(40 + 60 + 10 + 5)
    expect(s.cacheHitRate).toBeCloseTo(10 / (40 + 10), 10)
    expect(s.successRate).toBe(1)
  })

  it('按 status 筛选：error 只聚合失败记录', async () => {
    const { query, db } = makeQuery()
    seed(db)
    const s = await query.getUsageSummary({ status: 'error' })
    expect(s.totalRequests).toBe(1)
    expect(s.successCount).toBe(0)
    expect(s.errorCount).toBe(1)
    expect(s.totalCost).toBe('0')
    expect(s.inputTokens).toBe(200)
    expect(s.realTotalTokens).toBe(300)
    expect(s.cacheHitRate).toBe(0)
    expect(s.successRate).toBe(0)
  })

  it('按时间范围筛选聚合（边界下推为本地日，整天计入）', async () => {
    const { query, db } = makeQuery()
    seed(db)
    const start = new Date('2026-08-19T09:30:00+08:00').getTime()
    const s = await query.getUsageSummary({ startTime: start })
    expect(s.totalRequests).toBe(3)
    expect(s.totalCost).toBe('0.035')
    expect(s.inputTokens).toBe(1040)
  })

  it('空库返回零值（无记录不分母为 0）', async () => {
    const { query } = makeQuery()
    const s = await query.getUsageSummary({})
    expect(s).toEqual({
      totalRequests: 0,
      successCount: 0,
      errorCount: 0,
      totalCost: '0',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      realTotalTokens: 0,
      cacheHitRate: 0,
      successRate: 0
    })
  })
})

describe('getDailyTrends', () => {
  it('按本地时区按天分组，产出两天趋势', async () => {
    const { query, db } = makeQuery()
    seed(db)
    const daily = await query.getDailyTrends({})
    expect(daily.map((d) => d.date)).toEqual(['2026-08-18', '2026-08-19'])

    expect(daily[0]).toMatchObject({
      requestCount: 2,
      successCount: 1,
      errorCount: 1,
      inputTokens: 300,
      outputTokens: 150,
      cacheReadTokens: 20,
      cacheCreationTokens: 10,
      costUsd: '0.001'
    })
    expect(daily[1]).toMatchObject({
      requestCount: 3,
      successCount: 3,
      errorCount: 0,
      inputTokens: 1040,
      outputTokens: 560,
      cacheReadTokens: 410,
      cacheCreationTokens: 105,
      costUsd: '0.035'
    })
  })

  it('按时间范围/应用筛选后只返回命中天数', async () => {
    const { query, db } = makeQuery()
    seed(db)
    const start = new Date('2026-08-19T09:00:00+08:00').getTime()
    const daily = await query.getDailyTrends({ startTime: start, appTypes: ['codex'] })
    expect(daily.map((d) => d.date)).toEqual(['2026-08-19'])
    expect(daily[0].requestCount).toBe(2)
    expect(daily[0].costUsd).toBe('0.03')
  })
})

describe('getHourlyTrends', () => {
  function toHour(ms: number): number {
    return new Date(ms).getHours()
  }

  it('跨小时多条记录分桶正确，费用微美元聚合并格式化', async () => {
    const { query, db } = makeQuery()
    const t9 = new Date('2026-08-19T09:00:00+08:00').getTime()
    const t10 = new Date('2026-08-19T10:00:00+08:00').getTime()
    const t23 = new Date('2026-08-19T23:30:00+08:00').getTime()
    insert(db, { id: 'H9', created_at: t9 })
    insert(db, {
      id: 'H10a',
      created_at: t10,
      input_tokens: 30,
      output_tokens: 40,
      cache_read_tokens: 5,
      cache_creation_tokens: 3,
      cost_usd: '0.02',
      status: 'success'
    })
    insert(db, {
      id: 'H10b',
      created_at: t10,
      input_tokens: 200,
      output_tokens: 100,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_usd: null,
      status: 'error',
      latency_ms: null
    })
    insert(db, {
      id: 'H23',
      app_type: 'gemini',
      model: 'gemini-2.5-pro',
      raw_model: 'gemini-2.5-pro',
      created_at: t23,
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_tokens: 400,
      cache_creation_tokens: 100,
      cost_usd: '0.005',
      latency_ms: 300,
      status: 'success',
      file_path: '/sessions/gemini/h.jsonl'
    })

    refreshHourlyRollups(db)
    const hourly = await query.getHourlyTrends({
      startTime: new Date('2026-08-19T00:00:00+08:00').getTime(),
      endTime: new Date('2026-08-19T23:59:59+08:00').getTime()
    })

    const expectedHours = [toHour(t9), toHour(t10), toHour(t23)].sort((a, b) => a - b)
    expect(hourly.map((h) => h.hour)).toEqual(expectedHours)

    const byHour = new Map(hourly.map((h) => [h.hour, h]))
    expect(byHour.get(toHour(t9))).toMatchObject({
      requestCount: 1,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheCreationTokens: 10,
      costUsd: '0.001',
      successCount: 1,
      errorCount: 0
    })
    expect(byHour.get(toHour(t10))).toMatchObject({
      requestCount: 2,
      inputTokens: 230,
      outputTokens: 140,
      cacheReadTokens: 5,
      cacheCreationTokens: 3,
      costUsd: '0.02',
      successCount: 1,
      errorCount: 1
    })
    expect(byHour.get(toHour(t23))).toMatchObject({
      requestCount: 1,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 400,
      cacheCreationTokens: 100,
      costUsd: '0.005',
      successCount: 1,
      errorCount: 0
    })
  })

  it('本地时区边界：23 点的记录归入 23 桶', async () => {
    const { query, db } = makeQuery()
    const day = new Date(2026, 7, 19)
    insert(db, { id: 'LATE', created_at: day.getTime() + 23 * 3_600_000 + 59 * 60_000 })

    refreshHourlyRollups(db)
    const hourly = await query.getHourlyTrends({
      startTime: day.getTime(),
      endTime: day.getTime() + 24 * 3_600_000 - 1
    })
    expect(hourly).toHaveLength(1)
    expect(hourly[0]).toMatchObject({ hour: 23, requestCount: 1, successCount: 1, errorCount: 0 })
  })

  it('跨天滚动窗口：不同日期同钟点分属两个独立桶（dayKey 区分）', async () => {
    const { query, db } = makeQuery()
    const yesterday = new Date(2026, 7, 18, 9, 8).getTime()
    const today = new Date(2026, 7, 19, 9, 8).getTime()
    insert(db, { id: 'D1H9', created_at: yesterday })
    insert(db, { id: 'D2H9', created_at: today })

    refreshHourlyRollups(db)
    const hourly = await query.getHourlyTrends({ startTime: yesterday, endTime: today })

    expect(hourly).toHaveLength(2)
    expect(hourly.map((h) => h.dayKey)).toEqual([toDateKey(yesterday), toDateKey(today)])
    const hour = new Date(yesterday).getHours()
    expect(hourly.map((h) => h.hour)).toEqual([hour, hour])
    expect(hourly.map((h) => h.requestCount)).toEqual([1, 1])
  })

  it('filters 时间范围生效：范围外记录不入桶', async () => {
    const { query, db } = makeQuery()
    seed(db)
    const start = new Date('2026-08-18T00:00:00+08:00').getTime()
    const end = new Date('2026-08-18T23:59:59+08:00').getTime()
    refreshHourlyRollups(db)
    const hourly = await query.getHourlyTrends({ startTime: start, endTime: end })

    const d1a = new Date('2026-08-18T10:00:00+08:00').getTime()
    const d1b = new Date('2026-08-18T12:00:00+08:00').getTime()
    expect(hourly.map((h) => h.hour)).toEqual([toHour(d1a), toHour(d1b)].sort((a, b) => a - b))
    expect(hourly.reduce((n, h) => n + h.requestCount, 0)).toBe(2)
    expect(hourly.reduce((n, h) => n + h.errorCount, 0)).toBe(1)
  })

  it('默认限定今天：历史记录被过滤，当日记录可见', async () => {
    const { query, db } = makeQuery()
    seed(db)
    expect(await query.getHourlyTrends({})).toEqual([])

    insert(db, { id: 'NOW', created_at: Date.now(), file_path: '/s/now.jsonl', line: 9 })
    refreshHourlyRollups(db)
    const hourly = await query.getHourlyTrends({})
    expect(hourly).toHaveLength(1)
    expect(hourly[0]).toMatchObject({ hour: toHour(Date.now()), requestCount: 1 })
  })

  it('物化路径：经 recordUsage 写入后读 usage_hourly_rollups，按 (dayKey,hour) 桶与手工聚合一致', async () => {
    const { storage, query, db } = makeStorageAndQuery()
    const startOfToday = new Date()
    startOfToday.setHours(0, 0, 0, 0)
    const startTime = startOfToday.getTime()
    const endTime = startOfToday.getTime() + DAY_MS - 1
    const atHour = (h: number, o: Partial<UsageRecord> = {}): UsageRecord =>
      makeRecord({ createdAt: startOfToday.getTime() + h * 3_600_000 + 30 * 60_000, ...o })

    await storage.recordUsage([
      atHour(8, { source: { filePath: '/s/a.jsonl', line: 1 } }),
      atHour(8, {
        inputTokens: 30,
        outputTokens: 40,
        cacheReadTokens: 5,
        cacheCreationTokens: 3,
        costUsd: '0.02',
        source: { filePath: '/s/a.jsonl', line: 2 }
      }),
      atHour(15, {
        status: 'error',
        inputTokens: 5,
        outputTokens: 5,
        costUsd: '0.003',
        source: { filePath: '/s/b.jsonl', line: 1 }
      })
    ])

    const hourly = await query.getHourlyTrends({ startTime, endTime })
    const byHour = new Map(hourly.map((h) => [h.hour, h]))

    expect(byHour.get(8)).toMatchObject({
      requestCount: 2,
      successCount: 2,
      errorCount: 0,
      inputTokens: 130,
      outputTokens: 90,
      cacheReadTokens: 25,
      cacheCreationTokens: 13,
      costUsd: '0.021'
    })
    expect(byHour.get(15)).toMatchObject({
      requestCount: 1,
      successCount: 0,
      errorCount: 1,
      inputTokens: 5,
      outputTokens: 5,
      costUsd: '0.003'
    })
    expect(hourly.reduce((n, h) => n + h.requestCount, 0)).toBe(3)

    const rollupRows = db
      .prepare('SELECT COUNT(*) AS c FROM usage_hourly_rollups')
      .get() as { c: number }
    expect(rollupRows.c).toBeGreaterThanOrEqual(2)
  })

  it('回退路径：带 status 维度筛选时回退 usage_records 全扫，error 桶计数正确且不混入 success', async () => {
    const { storage, query } = makeStorageAndQuery()
    const startOfToday = new Date()
    startOfToday.setHours(0, 0, 0, 0)
    const startTime = startOfToday.getTime()
    const endTime = startOfToday.getTime() + DAY_MS - 1
    const atHour = (h: number, o: Partial<UsageRecord> = {}): UsageRecord =>
      makeRecord({ createdAt: startOfToday.getTime() + h * 3_600_000 + 30 * 60_000, ...o })

    await storage.recordUsage([
      atHour(8, {
        status: 'error',
        inputTokens: 1,
        outputTokens: 1,
        costUsd: '0.001',
        source: { filePath: '/s/e.jsonl', line: 1 }
      }),
      atHour(8, {
        status: 'success',
        inputTokens: 10,
        outputTokens: 10,
        costUsd: '0.002',
        source: { filePath: '/s/s.jsonl', line: 1 }
      }),
      atHour(9, {
        status: 'error',
        inputTokens: 2,
        outputTokens: 2,
        costUsd: '0.001',
        source: { filePath: '/s/e.jsonl', line: 2 }
      })
    ])

    const errorOnly = await query.getHourlyTrends({ status: 'error', startTime, endTime })
    const eByHour = new Map(errorOnly.map((h) => [h.hour, h]))
    expect(eByHour.get(8)).toMatchObject({
      requestCount: 1,
      successCount: 0,
      errorCount: 1,
      inputTokens: 1,
      outputTokens: 1
    })
    expect(eByHour.get(9)).toMatchObject({
      requestCount: 1,
      successCount: 0,
      errorCount: 1,
      inputTokens: 2,
      outputTokens: 2
    })

    const all = await query.getHourlyTrends({ startTime, endTime })
    const aByHour = new Map(all.map((h) => [h.hour, h]))
    expect(aByHour.get(8)).toMatchObject({ requestCount: 2, successCount: 1, errorCount: 1 })
  })
})

describe('getModelStats', () => {
  it('按归一化模型分组，含平均耗时与成功率', async () => {
    const { query, db } = makeQuery()
    seed(db)
    const stats = await query.getModelStats({})
    expect(stats.map((s) => s.model)).toEqual(['claude-sonnet-4', 'gpt-5', 'gemini-2.5-pro'])

    const claude = stats[0]
    expect(claude).toMatchObject({
      appType: 'claude',
      requestCount: 2,
      inputTokens: 300,
      outputTokens: 150,
      cacheReadTokens: 20,
      cacheCreationTokens: 10,
      costUsd: '0.001',
      avgLatencyMs: 400,
      successRate: 0.5
    })
    const gpt5 = stats[1]
    expect(gpt5).toMatchObject({
      appType: 'codex',
      requestCount: 2,
      costUsd: '0.03',
      avgLatencyMs: 150,
      successRate: 1
    })
    const gemini = stats[2]
    expect(gemini).toMatchObject({
      appType: 'gemini',
      requestCount: 1,
      costUsd: '0.005',
      avgLatencyMs: 300,
      successRate: 1
    })
  })

  it('支持 models 筛选', async () => {
    const { query, db } = makeQuery()
    seed(db)
    const stats = await query.getModelStats({ models: ['gpt-5'] })
    expect(stats).toHaveLength(1)
    expect(stats[0].model).toBe('gpt-5')
    expect(stats[0].requestCount).toBe(2)
  })
})

describe('getAppStats', () => {
  it('按 app_type 分组聚合', async () => {
    const { query, db } = makeQuery()
    seed(db)
    const stats = await query.getAppStats({})
    expect(stats.map((s) => s.appType)).toEqual(['claude', 'codex', 'gemini'])
    expect(stats[0]).toMatchObject({
      requestCount: 2,
      inputTokens: 300,
      outputTokens: 150,
      cacheReadTokens: 20,
      cacheCreationTokens: 10,
      costUsd: '0.001',
      successRate: 0.5
    })
    expect(stats[1]).toMatchObject({ requestCount: 2, costUsd: '0.03', successRate: 1 })
    expect(stats[2]).toMatchObject({ requestCount: 1, costUsd: '0.005', successRate: 1 })
  })

  it('支持 appTypes 筛选', async () => {
    const { query, db } = makeQuery()
    seed(db)
    const stats = await query.getAppStats({ appTypes: ['claude', 'gemini'] })
    expect(stats.map((s) => s.appType)).toEqual(['claude', 'gemini'])
  })
})

describe('getRequestLogs', () => {
  it('默认分页返回全部，按 created_at 倒序', async () => {
    const { query, db } = makeQuery()
    seed(db)
    const page = await query.getRequestLogs({})
    expect(page.total).toBe(5)
    expect(page.page).toBe(1)
    expect(page.pageSize).toBe(50)
    expect(page.totalPages).toBe(1)
    expect(page.items.map((r) => r.id)).toEqual(['E', 'D', 'C', 'B', 'A'])
  })

  it('分页取页并计算 totalPages', async () => {
    const { query, db } = makeQuery()
    seed(db)
    const page = await query.getRequestLogs({ page: 2, pageSize: 2 })
    expect(page.items.map((r) => r.id)).toEqual(['C', 'B'])
    expect(page.total).toBe(5)
    expect(page.totalPages).toBe(3)
    expect(page.page).toBe(2)
  })

  it('keyword 模糊匹配 project / session_id / model', async () => {
    const { query, db } = makeQuery()
    seed(db)

    const byProject = await query.getRequestLogs({ keyword: 'alpha' })
    expect(byProject.total).toBe(2)
    expect(byProject.items.map((r) => r.id)).toEqual(['D', 'A'])

    const bySession = await query.getRequestLogs({ keyword: 'sess-abc' })
    expect(bySession.items.map((r) => r.id)).toEqual(['D'])

    const byModel = await query.getRequestLogs({ keyword: 'gpt-5' })
    expect(byModel.items.map((r) => r.id)).toEqual(['D', 'C'])
  })

  it('status / appTypes 筛选', async () => {
    const { query, db } = makeQuery()
    seed(db)

    const errors = await query.getRequestLogs({ status: 'error' })
    expect(errors.items.map((r) => r.id)).toEqual(['B'])

    const claude = await query.getRequestLogs({ appTypes: ['claude'] })
    expect(claude.items.map((r) => r.id)).toEqual(['B', 'A'])
  })
})

describe('getRequestLogDetail', () => {
  it('按 id 返回完整明细', async () => {
    const { query, db } = makeQuery()
    seed(db)
    const d = await query.getRequestLogDetail('D')
    expect(d).not.toBeNull()
    expect(d).toMatchObject({
      id: 'D',
      appType: 'codex',
      model: 'gpt-5',
      rawModel: 'gpt-5',
      inputTokens: 30,
      outputTokens: 40,
      cacheReadTokens: 5,
      cacheCreationTokens: 3,
      inputSemantics: 1,
      costUsd: '0.020000',
      currency: 'USD',
      latencyMs: 200,
      project: 'alpha',
      sessionId: 'sess-abc',
      status: 'success',
      createdAt: new Date('2026-08-19T10:00:00+08:00').getTime(),
      sourceFile: '/sessions/codex/b.jsonl',
      sourceLine: 2
    })
  })

  it('不存在返回 null', async () => {
    const { query, db } = makeQuery()
    seed(db)
    expect(await query.getRequestLogDetail('not-exist')).toBeNull()
  })
})

function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    appType: 'claude',
    model: 'claude-sonnet-4',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 20,
    cacheCreationTokens: 10,
    inputSemantics: 1,
    costUsd: '0.001',
    currency: 'USD',
    latencyMs: 800,
    status: 'success',
    createdAt: Date.now() - DAY_MS,
    source: { filePath: '/s/record.jsonl', line: 1 },
    ...overrides
  }
}

function countRows(db: SqliteDatabase, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
}

function makeStorageAndQuery(): {
  storage: SqliteStorage
  query: UsageQueryService
  db: SqliteDatabase
} {
  const db = createDatabase(':memory:')
  migrate(db)
  const storage = new SqliteStorage(db)
  return { storage, query: createUsageQuery(db), db }
}

describe('聚合查询数据源切换（rollups 镜像与明细回退）', () => {
  it('清理后历史趋势仍可查：91 天前明细被删，日聚合保留且聚合查询可见', async () => {
    const { storage, query, db } = makeStorageAndQuery()
    const oldCreatedAt = Date.now() - 91 * DAY_MS
    await storage.recordUsage([
      makeRecord({ createdAt: oldCreatedAt, source: { filePath: '/s/old.jsonl', line: 1 } })
    ])
    expect(countRows(db, 'usage_records')).toBe(1)

    expect(cleanupOldRecords(db, 90)).toBe(1)

    expect(countRows(db, 'usage_records')).toBe(0)
    expect(countRows(db, 'usage_daily_rollups')).toBe(1)
    const daily = await query.getDailyTrends({})
    expect(daily).toHaveLength(1)
    expect(daily[0].date).toBe(toDateKey(oldCreatedAt))
    expect(daily[0].requestCount).toBe(1)
    expect(daily[0].costUsd).toBe('0.001')
    const summary = await query.getUsageSummary({})
    expect(summary.totalRequests).toBe(1)
    expect(summary.totalCost).toBe('0.001')
  })

  it('经 recordUsage 写入后，rollup 路径聚合结果正确（计数/token/费用/成功率/均延迟）', async () => {
    const { storage, query } = makeStorageAndQuery()
    const t1 = Date.now() - DAY_MS
    await storage.recordUsage([
      makeRecord({ createdAt: t1, source: { filePath: '/s/a.jsonl', line: 1 } }),
      makeRecord({
        status: 'error',
        costUsd: undefined,
        latencyMs: 400,
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        createdAt: t1,
        source: { filePath: '/s/a.jsonl', line: 2 }
      }),
      makeRecord({
        appType: 'codex',
        model: 'gpt-5',
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheCreationTokens: 2,
        costUsd: '0.01',
        latencyMs: 100,
        createdAt: t1,
        source: { filePath: '/s/b.jsonl', line: 1 }
      })
    ])

    const s = await query.getUsageSummary({})
    expect(s.totalRequests).toBe(3)
    expect(s.successCount).toBe(2)
    expect(s.errorCount).toBe(1)
    expect(s.totalCost).toBe('0.011')
    expect(s.inputTokens).toBe(310)
    expect(s.outputTokens).toBe(170)
    expect(s.cacheReadTokens).toBe(25)
    expect(s.cacheCreationTokens).toBe(12)
    expect(s.realTotalTokens).toBe(310 + 170 + 25 + 12)
    expect(s.cacheHitRate).toBeCloseTo(25 / (310 + 25), 10)
    expect(s.successRate).toBeCloseTo(2 / 3, 10)

    const daily = await query.getDailyTrends({})
    expect(daily).toHaveLength(1)
    expect(daily[0]).toMatchObject({
      date: toDateKey(t1),
      requestCount: 3,
      successCount: 2,
      errorCount: 1,
      inputTokens: 310,
      outputTokens: 170,
      cacheReadTokens: 25,
      cacheCreationTokens: 12,
      costUsd: '0.011'
    })

    const stats = await query.getModelStats({})
    expect(stats.map((m) => m.model)).toEqual(['claude-sonnet-4', 'gpt-5'])
    expect(stats[0]).toMatchObject({
      appType: 'claude',
      requestCount: 2,
      inputTokens: 300,
      outputTokens: 150,
      cacheReadTokens: 20,
      cacheCreationTokens: 10,
      costUsd: '0.001',
      avgLatencyMs: 600,
      successRate: 0.5
    })
    expect(stats[1]).toMatchObject({
      appType: 'codex',
      requestCount: 1,
      costUsd: '0.01',
      avgLatencyMs: 100,
      successRate: 1
    })

    const apps = await query.getAppStats({})
    expect(apps.map((a) => a.appType)).toEqual(['claude', 'codex'])
    expect(apps[0].requestCount).toBe(2)
    expect(apps[0].successRate).toBe(0.5)
    expect(apps[1].requestCount).toBe(1)
    expect(apps[1].successRate).toBe(1)
  })

  it('project/status/sessionId/keyword 过滤时回退明细表：清空 rollups 后仍能查出正确结果', async () => {
    const { storage, query, db } = makeStorageAndQuery()
    const t1 = Date.now() - DAY_MS
    await storage.recordUsage([
      makeRecord({
        project: 'alpha',
        sessionId: 'sess-a',
        createdAt: t1,
        source: { filePath: '/s/p.jsonl', line: 1 }
      }),
      makeRecord({
        status: 'error',
        latencyMs: undefined,
        createdAt: t1,
        source: { filePath: '/s/p.jsonl', line: 2 }
      })
    ])
    db.prepare('DELETE FROM usage_daily_rollups').run()

    expect((await query.getUsageSummary({})).totalRequests).toBe(0)

    expect((await query.getUsageSummary({ project: 'alpha' })).totalRequests).toBe(1)
    expect((await query.getUsageSummary({ status: 'error' })).totalRequests).toBe(1)
    const models = await query.getModelStats({ sessionId: 'sess-a' })
    expect(models).toHaveLength(1)
    expect(models[0].model).toBe('claude-sonnet-4')
    const apps = await query.getAppStats({ keyword: 'alpha' })
    expect(apps).toHaveLength(1)
    const daily = await query.getDailyTrends({ project: 'alpha' })
    expect(daily).toHaveLength(1)
    expect(daily[0].date).toBe(toDateKey(t1))
  })
})

describe('getFilterOptions', () => {
  it('distinct 去重、排除 null 与空串、升序返回', async () => {
    const { query, db } = makeQuery()
    seed(db)
    insert(db, { id: 'F', model: 'claude-sonnet-4', project: '', file_path: '/s/f.jsonl', line: 3 })

    const opts = await query.getFilterOptions()
    expect(opts.models).toEqual(['claude-sonnet-4', 'gemini-2.5-pro', 'gpt-5'])
    expect(opts.projects).toEqual(['alpha', 'beta'])
  })

  it('各维度超过上限时截断为前 FILTER_OPTIONS_LIMIT 个（升序）', async () => {
    const { query, db } = makeQuery()
    for (let i = 0; i < FILTER_OPTIONS_LIMIT + 5; i++) {
      const tag = String(i).padStart(4, '0')
      insert(db, {
        id: `X${tag}`,
        model: `m-${tag}`,
        project: `p-${tag}`,
        file_path: '/s/x.jsonl',
        line: i + 1
      })
    }

    const opts = await query.getFilterOptions()
    expect(opts.models).toHaveLength(FILTER_OPTIONS_LIMIT)
    expect(opts.models[0]).toBe('m-0000')
    expect(opts.models[FILTER_OPTIONS_LIMIT - 1]).toBe(
      `m-${String(FILTER_OPTIONS_LIMIT - 1).padStart(4, '0')}`
    )
    expect(opts.projects).toHaveLength(FILTER_OPTIONS_LIMIT)
    expect(opts.projects[0]).toBe('p-0000')
  })

  it('空库返回两个空数组', async () => {
    const { query } = makeQuery()
    expect(await query.getFilterOptions()).toEqual({ models: [], projects: [] })
  })
})
