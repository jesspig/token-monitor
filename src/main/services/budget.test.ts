import { describe, it, expect } from 'vitest'
import type { BudgetStatus } from '../../../shared/query'
import { createDatabase, migrate, type SqliteDatabase } from './db'
import { getBudgetStatus } from './budget'


function toDateKey(ms: number): string {
  const d = new Date(ms)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function makeDb(): SqliteDatabase {
  const db = createDatabase(':memory:')
  migrate(db)
  return db
}

function insertRollup(
  db: SqliteDatabase,
  overrides: Partial<{
    date: string
    app_type: string
    model: string
    request_count: number
    success_count: number
    error_count: number
    input_tokens: number
    output_tokens: number
    cache_read_tokens: number
    cache_creation_tokens: number
    cost_usd: string
    latency_ms_total: number
  }> = {}
): void {
  const row = {
    date: toDateKey(Date.now()),
    app_type: 'claude',
    model: 'claude-sonnet-4',
    request_count: 1,
    success_count: 1,
    error_count: 0,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    cost_usd: '0',
    latency_ms_total: 0,
    updated_at: Date.now(),
    ...overrides
  }
  db.prepare(
    `INSERT INTO usage_daily_rollups (
       date, app_type, model, request_count, success_count, error_count,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       cost_usd, latency_ms_total, updated_at
     ) VALUES (
       @date, @app_type, @model, @request_count, @success_count, @error_count,
       @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
       @cost_usd, @latency_ms_total, @updated_at
     )`
  ).run(row)
}

describe('getBudgetStatus 费用口径', () => {
  it('今日费用跨多 app/model rollup 行求和正确', () => {
    const db = makeDb()
    insertRollup(db, { date: toDateKey(Date.now()), app_type: 'claude', model: 'm1', cost_usd: '0.5' })
    insertRollup(db, { date: toDateKey(Date.now()), app_type: 'codex', model: 'm2', cost_usd: '1.25' })
    insertRollup(db, { date: toDateKey(Date.now()), app_type: 'gemini', model: 'm3', cost_usd: '0.25' })

    const status = getBudgetStatus(db, {})

    expect(status.dailyCostUsd).toBe('2')
    expect(status.dailyExceeded).toBe(false)
  })

  it('本月费用按自然月前缀求和，上月数据不计入', () => {
    const db = makeDb()
    const now = new Date()
    const todayKey = toDateKey(now.getTime())
    const monthFirstDay = `${todayKey.slice(0, 7)}-01`
    const prevMonthLastDay = toDateKey(new Date(now.getFullYear(), now.getMonth(), 0).getTime())
    insertRollup(db, { date: todayKey, app_type: 'claude', model: 'm1', cost_usd: '0.5' })
    insertRollup(db, { date: monthFirstDay, app_type: 'codex', model: 'm2', cost_usd: '1.25' })
    insertRollup(db, { date: prevMonthLastDay, app_type: 'gemini', model: 'm3', cost_usd: '10' })

    const status = getBudgetStatus(db, {})

    expect(status.monthlyCostUsd).toBe('1.75')
    expect(status.dailyCostUsd).toBe('0.5')
  })

  it('空库返回零费用字符串', () => {
    const db = makeDb()

    const status = getBudgetStatus(db, {})

    expect(status.dailyCostUsd).toBe('0')
    expect(status.monthlyCostUsd).toBe('0')
  })

  it('费用字符串格式与仓库规则一致（去尾随 0）', () => {
    const db = makeDb()
    const todayKey = toDateKey(Date.now())
    insertRollup(db, { date: todayKey, app_type: 'claude', model: 'm1', cost_usd: '0.500000' })
    insertRollup(db, { date: todayKey, app_type: 'codex', model: 'm2', cost_usd: '1.234567' })

    const status = getBudgetStatus(db, {})

    expect(status.dailyCostUsd).toBe('1.734567')
  })
})

describe('getBudgetStatus 预算判定', () => {
  function expectDimension(
    s: BudgetStatus,
    dim: 'daily' | 'monthly',
    ratio: number | null,
    exceeded: boolean
  ): void {
    expect(s[`${dim}UsageRatio`]).toBe(ratio)
    expect(s[`${dim}Exceeded`]).toBe(exceeded)
  }

  it('预算未设置（缺省/null/0/负数）：ratio=null 且 exceeded=false', () => {
    const db = makeDb()
    const todayKey = toDateKey(Date.now())
    insertRollup(db, { date: todayKey, cost_usd: '5' })

    expectDimension(getBudgetStatus(db, {}), 'daily', null, false)
    expectDimension(getBudgetStatus(db, {}), 'monthly', null, false)
    expectDimension(getBudgetStatus(db, { dailyBudgetUsd: null, monthlyBudgetUsd: null }), 'daily', null, false)
    const zero = getBudgetStatus(db, { dailyBudgetUsd: 0, monthlyBudgetUsd: 0 })
    expectDimension(zero, 'daily', null, false)
    expectDimension(zero, 'monthly', null, false)
    expect(zero.dailyBudgetUsd).toBeNull()
    const negative = getBudgetStatus(db, { dailyBudgetUsd: -5 })
    expectDimension(negative, 'daily', null, false)
    expect(negative.dailyBudgetUsd).toBeNull()
  })

  it('分档：ratio 0.79 未超限、0.80 未超限、1.01 判超限', () => {
    const buildWithCost = (cost: string): SqliteDatabase => {
      const db = makeDb()
      insertRollup(db, { date: toDateKey(Date.now()), cost_usd: cost })
      return db
    }

    const below = getBudgetStatus(buildWithCost('0.79'), { dailyBudgetUsd: 1 })
    expect(below.dailyUsageRatio).toBeCloseTo(0.79, 10)
    expect(below.dailyExceeded).toBe(false)

    const atWarn = getBudgetStatus(buildWithCost('0.8'), { dailyBudgetUsd: 1 })
    expect(atWarn.dailyUsageRatio).toBeCloseTo(0.8, 10)
    expect(atWarn.dailyExceeded).toBe(false)

    const over = getBudgetStatus(buildWithCost('1.01'), { dailyBudgetUsd: 1 })
    expect(over.dailyUsageRatio).toBeCloseTo(1.01, 10)
    expect(over.dailyExceeded).toBe(true)
  })

  it('月预算维度同样生效：月费用超过月上限判超限，且互不影响日维度', () => {
    const db = makeDb()
    const now = new Date()
    const monthFirstDay = `${toDateKey(now.getTime()).slice(0, 7)}-01`
    insertRollup(db, { date: toDateKey(now.getTime()), app_type: 'claude', model: 'm1', cost_usd: '1' })
    insertRollup(db, { date: monthFirstDay, app_type: 'codex', model: 'm2', cost_usd: '2' })

    const status = getBudgetStatus(db, { dailyBudgetUsd: 5, monthlyBudgetUsd: 2 })

    expectDimension(status, 'daily', 1 / 5, false)
    expectDimension(status, 'monthly', 1.5, true)
    expect(status.dailyBudgetUsd).toBe(5)
    expect(status.monthlyBudgetUsd).toBe(2)
  })
})
