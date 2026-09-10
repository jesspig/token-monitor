import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatNumber, formatTokens } from './format'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('formatNumber 完整数字（不缩写）', () => {
  it('缺省 zh 环境走 zh-CN 千分位', () => {
    expect(formatNumber(1234)).toBe('1,234')
    expect(formatNumber(9999)).toBe('9,999')
    expect(formatNumber(15000)).toBe('15,000')
    expect(formatNumber(12345)).toBe('12,345')
    expect(formatNumber(99999999)).toBe('99,999,999')
    expect(formatNumber(123456789)).toBe('123,456,789')
    expect(formatNumber(0)).toBe('0')
  })

  it('显式 en locale 走 en-US 千分位', () => {
    expect(formatNumber(1234, 'en')).toBe('1,234')
    expect(formatNumber(1500000, 'en-US')).toBe('1,500,000')
    expect(formatNumber(123456789, 'en')).toBe('123,456,789')
  })
})

describe('locale 来源优先级', () => {
  it('显式 locale 参数优先于 navigator.language', () => {
    vi.stubGlobal('navigator', { language: 'zh-CN' })
    expect(formatNumber(15000)).toBe('15,000')
    expect(formatNumber(15000, 'en')).toBe('15,000')
    expect(formatTokens(15000, 'en')).toBe('15,000')
  })

  it('navigator 为 zh 时 formatTokens 缺省走中文千分位', () => {
    vi.stubGlobal('navigator', { language: 'zh' })
    expect(formatTokens(123456789)).toBe('123,456,789')
  })
})
