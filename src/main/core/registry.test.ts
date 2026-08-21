import { describe, expect, it } from 'vitest'
import { PluginRegistry } from './registry'
import type { MonitorPlugin } from '../../../shared/plugin'

const makePlugin = (
  id: MonitorPlugin['id'],
  deps?: MonitorPlugin['deps']
): MonitorPlugin => ({
  id,
  name: id,
  version: '1.0.0',
  ...(deps ? { deps } : {}),
  detect: async () => ({ available: true }),
  listFiles: async () => [],
  parseFile: async () => ({ records: [], nextLine: 0, eof: true })
})

describe('PluginRegistry', () => {
  it('register 后可通过 list/get 发现，默认启用', () => {
    const reg = new PluginRegistry()
    reg.register(makePlugin('claude', ['storage']))

    expect(reg.has('claude')).toBe(true)
    expect(reg.get('claude')?.id).toBe('claude')
    expect(reg.isEnabled('claude')).toBe(true)
    expect(reg.list()).toEqual([
      expect.objectContaining({
        id: 'claude',
        name: 'claude',
        version: '1.0.0',
        deps: ['storage'],
        enabled: true
      })
    ])
  })

  it('重复注册同一 id 抛错', () => {
    const reg = new PluginRegistry()
    reg.register(makePlugin('codex'))
    expect(() => reg.register(makePlugin('codex'))).toThrow(/already registered/)
  })

  it('enable/disable 切换启用状态', () => {
    const reg = new PluginRegistry()
    reg.register(makePlugin('gemini'))
    reg.disable('gemini')
    expect(reg.isEnabled('gemini')).toBe(false)
    reg.enable('gemini')
    expect(reg.isEnabled('gemini')).toBe(true)
  })

  it('对未注册 id 执行 enable/disable 抛错', () => {
    const reg = new PluginRegistry()
    expect(() => reg.enable('grok')).toThrow(/not registered/)
    expect(() => reg.disable('grok')).toThrow(/not registered/)
  })

  it('remove 删除插件，未注册 id 返回 false', () => {
    const reg = new PluginRegistry()
    reg.register(makePlugin('opencode'))
    expect(reg.remove('opencode')).toBe(true)
    expect(reg.has('opencode')).toBe(false)
    expect(reg.remove('opencode')).toBe(false)
  })

  it('getMeta 返回元数据快照', () => {
    const reg = new PluginRegistry()
    reg.register(makePlugin('claude', ['storage', 'pricing']))
    const meta = reg.getMeta('claude')
    expect(meta).toMatchObject({
      id: 'claude',
      deps: ['storage', 'pricing'],
      enabled: true
    })
  })
})
