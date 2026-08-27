import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DAY_MS, customRangeToMs, rangeToFilters } from './range'

const NOW = new Date(2026, 7, 15, 12, 0, 0).getTime()

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 7, 15, 12, 0, 0))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('rangeToFilters', () => {
  it('today 以当地零点为起点、now 为终点', () => {
    expect(rangeToFilters('today')).toEqual({
      startTime: new Date(2026, 7, 15).getTime(),
      endTime: NOW
    })
  })

  it('24h 起点为 now − 24 小时', () => {
    expect(rangeToFilters('24h')).toEqual({ startTime: NOW - DAY_MS, endTime: NOW })
  })

  it('7d 起点为 now − 7 天', () => {
    expect(rangeToFilters('7d')).toEqual({ startTime: NOW - 7 * DAY_MS, endTime: NOW })
  })

  it('14d 起点为 now − 14 天', () => {
    expect(rangeToFilters('14d')).toEqual({ startTime: NOW - 14 * DAY_MS, endTime: NOW })
  })

  it('30d 起点为 now − 30 天', () => {
    expect(rangeToFilters('30d')).toEqual({ startTime: NOW - 30 * DAY_MS, endTime: NOW })
  })

  it('extra 叠加筛选并可覆盖时间字段', () => {
    expect(rangeToFilters('24h', { appTypes: ['claude'] })).toEqual({
      startTime: NOW - DAY_MS,
      endTime: NOW,
      appTypes: ['claude']
    })
    const override = { startTime: 1000, endTime: 2000 }
    expect(rangeToFilters('24h', override)).toEqual(override)
  })

  it('custom 携带 extra 时间区间时生效', () => {
    const ms = { startTime: new Date(2026, 7, 1).getTime(), endTime: new Date(2026, 7, 10).getTime() }
    expect(rangeToFilters('custom', ms)).toEqual(ms)
  })

  it('custom 无 extra 时回退最近 7 天', () => {
    expect(rangeToFilters('custom')).toEqual({ startTime: NOW - 7 * DAY_MS, endTime: NOW })
  })
})

describe('customRangeToMs', () => {
  it('解析正常区间：start 当地 00:00，end 当天 23:59:59.999', () => {
    expect(customRangeToMs({ start: '2026-08-01', end: '2026-08-03' })).toEqual({
      startTime: new Date(2026, 7, 1).getTime(),
      endTime: new Date(2026, 7, 3, 23, 59, 59, 999).getTime()
    })
  })

  it('非法输入返回 null（格式错误 / 位数不足 / 不存在日期）', () => {
    for (const bad of ['', 'abc', '2026/08/01', '2026-8-1', '2026-13-01', '2026-02-30']) {
      expect(customRangeToMs({ start: bad, end: '2026-08-03' })).toBeNull()
      expect(customRangeToMs({ start: '2026-08-01', end: bad })).toBeNull()
    }
  })
})
