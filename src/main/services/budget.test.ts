import { describe, it, expect } from 'vitest'
import type { BudgetStatus } from '../../../shared/query'
import { createDatabase, migrate, type SqliteDatabase } from './db'
import { getBudgetStatus } from './budget'

/**
 * 预算限额状态单测：直接向 :memory: 库的 usage_daily_rollups 写入聚合行
 * （budget 只读该表，不经明细写入路径），验证今日/本月费用求和口径、
 * 跨月边界排除、未设置预算不告警与超限分档。
 *
 * 日期构造不绑定运行时区/具体日期：
 * - todayKey = 本地今天
 * - monthFirstDay = 本月 1 号（恒在本月；今天恰为 1 号时与 todayKey 同值，
 *   借助不同 app_type 规避主键冲突，期望值不受影响）
 * - prevMonthLastDay = 上月最后一天（new Date(y, m, 0)，恒不在本月）
 */

/** epoch ms → YYYY-MM-DD（本地时区），与被测实现同口径 */
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

/** 向 usage_daily_rollups 插一行聚合桶（未给字段走表默认值） */
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
    // Arrange：今天的 3 个不同 (app_type, model) 桶
    const db = makeDb()
    insertRollup(db, { date: toDateKey(Date.now()), app_type: 'claude', model: 'm1', cost_usd: '0.5' })
    insertRollup(db, { date: toDateKey(Date.now()), app_type: 'codex', model: 'm2', cost_usd: '1.25' })
    insertRollup(db, { date: toDateKey(Date.now()), app_type: 'gemini', model: 'm3', cost_usd: '0.25' })

    // Act
    const status = getBudgetStatus(db, {})

    // Assert：0.5 + 1.25 + 0.25 = 2；微美元整数聚合后格式化去尾零
    expect(status.dailyCostUsd).toBe('2')
    expect(status.dailyExceeded).toBe(false)
  })

  it('本月费用按自然月前缀求和，上月数据不计入', () => {
    // Arrange：今天 + 本月 1 号计入，上月最后一天不计入
    const db = makeDb()
    const now = new Date()
    const todayKey = toDateKey(now.getTime())
    const monthFirstDay = `${todayKey.slice(0, 7)}-01`
    const prevMonthLastDay = toDateKey(new Date(now.getFullYear(), now.getMonth(), 0).getTime())
    insertRollup(db, { date: todayKey, app_type: 'claude', model: 'm1', cost_usd: '0.5' })
    insertRollup(db, { date: monthFirstDay, app_type: 'codex', model: 'm2', cost_usd: '1.25' })
    insertRollup(db, { date: prevMonthLastDay, app_type: 'gemini', model: 'm3', cost_usd: '10' })

    // Act
    const status = getBudgetStatus(db, {})

    // Assert：月度 = 0.5 + 1.25（上月 10 排除）；今日只含当天行
    expect(status.monthlyCostUsd).toBe('1.75')
    expect(status.dailyCostUsd).toBe('0.5')
  })

  it('空库返回零费用字符串', () => {
    // Arrange：仅建库迁移，无任何 rollup 行
    const db = makeDb()

    // Act
    const status = getBudgetStatus(db, {})

    // Assert：与仓库 fromMicroUsd 规则一致，零返回 '0'
    expect(status.dailyCostUsd).toBe('0')
    expect(status.monthlyCostUsd).toBe('0')
  })

  it('费用字符串格式与仓库规则一致（去尾随 0）', () => {
    // Arrange：三种典型存储值
    const db = makeDb()
    const todayKey = toDateKey(Date.now())
    insertRollup(db, { date: todayKey, app_type: 'claude', model: 'm1', cost_usd: '0.500000' })
    insertRollup(db, { date: todayKey, app_type: 'codex', model: 'm2', cost_usd: '1.234567' })

    // Act
    const status = getBudgetStatus(db, {})

    // Assert：尾随 0 去除、6 位精度保留
    expect(status.dailyCostUsd).toBe('1.734567')
  })
})

describe('getBudgetStatus 预算判定', () => {
  /** 断言某维度的占比/超限状态 */
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
    // Arrange：有今日/本月费用，但不设或设置无效预算
    const db = makeDb()
    const todayKey = toDateKey(Date.now())
    insertRollup(db, { date: todayKey, cost_usd: '5' })

    // Act + Assert：缺省
    expectDimension(getBudgetStatus(db, {}), 'daily', null, false)
    expectDimension(getBudgetStatus(db, {}), 'monthly', null, false)
    // 显式 null
    expectDimension(getBudgetStatus(db, { dailyBudgetUsd: null, monthlyBudgetUsd: null }), 'daily', null, false)
    // 0 与负数视同未设置（未设置=不告警），DTO 归一为 null
    const zero = getBudgetStatus(db, { dailyBudgetUsd: 0, monthlyBudgetUsd: 0 })
    expectDimension(zero, 'daily', null, false)
    expectDimension(zero, 'monthly', null, false)
    expect(zero.dailyBudgetUsd).toBeNull()
    const negative = getBudgetStatus(db, { dailyBudgetUsd: -5 })
    expectDimension(negative, 'daily', null, false)
    expect(negative.dailyBudgetUsd).toBeNull()
  })

  it('分档：ratio 0.79 未超限、0.80 未超限、1.01 判超限', () => {
    // Arrange + Act + Assert：三档各建一次库，今日费用固定，仅预算变化
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
    // Arrange：本月费用 3（今天 1 + 本月早些时候 2），日预算 5 未超、月预算 2 已超
    const db = makeDb()
    const now = new Date()
    const monthFirstDay = `${toDateKey(now.getTime()).slice(0, 7)}-01`
    insertRollup(db, { date: toDateKey(now.getTime()), app_type: 'claude', model: 'm1', cost_usd: '1' })
    insertRollup(db, { date: monthFirstDay, app_type: 'codex', model: 'm2', cost_usd: '2' })

    // Act
    const status = getBudgetStatus(db, { dailyBudgetUsd: 5, monthlyBudgetUsd: 2 })

    // Assert
    expectDimension(status, 'daily', 1 / 5, false)
    expectDimension(status, 'monthly', 1.5, true)
    expect(status.dailyBudgetUsd).toBe(5)
    expect(status.monthlyBudgetUsd).toBe(2)
  })
})
