import { describe, it, expect } from 'vitest'
import type { UsageRecordRow } from '../../../shared/tables'
import { createDatabase, migrate, type SqliteDatabase } from './db'
import { createUsageQuery, type UsageQueryService } from './usageQuery'

/**
 * 用量查询服务单测：直接向 :memory: 库写入 usage_records 构造数据（不经过 recordUsage，
 * 隔离 query 层自身逻辑）；覆盖汇总聚合、按天趋势、按模型/应用分组、分页与 keyword 筛选、明细查询。
 */

/** 构造一条 usage_records 行并直接写入，返回行 id */
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
    ...overrides
  }
  db.prepare(
    `INSERT INTO usage_records (
       id, data_source, app_type, model, raw_model,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       input_semantics, cost_usd, currency, latency_ms, project, session_id,
       status, file_path, line, created_at
     ) VALUES (
       @id, @data_source, @app_type, @model, @raw_model,
       @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
       @input_semantics, @cost_usd, @currency, @latency_ms, @project, @session_id,
       @status, @file_path, @line, @created_at
     )`
  ).run(row)
  return row.id
}

/** 内存库 + 迁移 + 查询服务实例，返回可直查的 db 句柄 */
function makeQuery(): { query: UsageQueryService; db: SqliteDatabase } {
  const db = createDatabase(':memory:')
  migrate(db)
  return { query: createUsageQuery(db), db }
}

/**
 * 标准数据集（5 条，跨 2 天 / 3 app / 3 模型）：
 * A   claude  claude-sonnet-4  success 08-18 10:00  in100  out50  cr20  cc10  $0.001  lat800  proj=alpha  sess-a
 * B   claude  claude-sonnet-4  error   08-18 12:00  in200  out100 cr0   cc0   cost=null lat=null
 * C   codex   gpt-5            success 08-19 09:00  in10   out20  cr5   cc2   $0.010000 lat100
 * D   codex   gpt-5            success 08-19 10:00  in30   out40  cr5   cc3   $0.020000 lat200 proj=alpha sess-abc
 * E   gemini  gemini-2.5-pro   success 08-19 11:00  in1000 out500 cr400 cc100 $0.005    lat300 proj=beta  sess-x
 */
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

  it('按时间范围筛选聚合', async () => {
    const { query, db } = makeQuery()
    seed(db)
    const start = new Date('2026-08-19T09:30:00+08:00').getTime()
    const s = await query.getUsageSummary({ startTime: start })
    expect(s.totalRequests).toBe(2) // D、E
    expect(s.totalCost).toBe('0.025')
    expect(s.inputTokens).toBe(1030)
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
      avgLatencyMs: 800, // 只对非空 latency 求均值（B 为 null）
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
    expect(byProject.total).toBe(2) // A、D
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
