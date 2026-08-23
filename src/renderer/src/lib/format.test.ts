import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatNumber, formatTokens } from './format'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('formatNumber en 分支（维持既有输出）', () => {
  it('千分位与 M/k 缩写不变', () => {
    expect(formatNumber(1234)).toBe('1,234')
    expect(formatNumber(9999)).toBe('9,999')
    expect(formatNumber(1500000)).toBe('1.50M')
    expect(formatNumber(12345)).toBe('12.3k')
  })

  it('显式 en locale 与缺省一致', () => {
    expect(formatNumber(1234, 'en')).toBe('1,234')
    expect(formatNumber(1500000, 'en-US')).toBe('1.50M')
  })
})

describe('formatNumber zh 分支（数量级本地化）', () => {
  it('≥1e8 用亿，保留 2 位去尾零', () => {
    expect(formatNumber(123456789, 'zh-CN')).toBe('1.23亿')
    expect(formatNumber(100000000, 'zh-CN')).toBe('1亿')
    expect(formatNumber(250000000, 'zh-CN')).toBe('2.5亿')
  })

  it('≥1e4 用万，保留 1 位去尾零', () => {
    expect(formatNumber(15000, 'zh-CN')).toBe('1.5万')
    expect(formatNumber(20000, 'zh-CN')).toBe('2万')
    // 9999.9999 万经 toFixed(1) 四舍五入进位为 10000.0
    expect(formatNumber(99999999, 'zh-CN')).toBe('10000万')
  })

  it('<1e4 走 zh-CN 千分位', () => {
    expect(formatNumber(9999, 'zh-CN')).toBe('9,999')
    expect(formatNumber(0, 'zh-CN')).toBe('0')
  })
})

describe('locale 来源优先级', () => {
  it('显式 locale 参数优先于 navigator.language', () => {
    vi.stubGlobal('navigator', { language: 'zh-CN' })
    expect(formatNumber(15000)).toBe('1.5万')
    expect(formatNumber(15000, 'en')).toBe('15.0k')
    expect(formatTokens(15000, 'en')).toBe('15.0k')
  })

  it('navigator 为 zh 时 formatTokens 缺省走中文分支', () => {
    vi.stubGlobal('navigator', { language: 'zh' })
    expect(formatTokens(123456789)).toBe('1.23亿')
  })
})
