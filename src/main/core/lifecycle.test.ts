import { describe, expect, it, vi } from 'vitest'
import { EventBus } from './event-bus'
import { createPluginContext } from './context'
import { LifecycleManager } from './lifecycle'
import type { PluginContext } from '../../../shared/context'
import type { MonitorPlugin } from '../../../shared/plugin'

interface MockPlugin extends MonitorPlugin {
  onMount?: ReturnType<typeof vi.fn>
  dispose?: ReturnType<typeof vi.fn>
}

const makePlugin = (
  id: MonitorPlugin['id'],
  deps?: MonitorPlugin['deps'],
  withHooks = false
): MockPlugin => {
  const plugin: MockPlugin = {
    id,
    name: id,
    version: '1.0.0',
    ...(deps ? { deps } : {}),
    detect: vi.fn(async () => ({ available: true })),
    listFiles: vi.fn(async () => []),
    parseFile: vi.fn(async () => ({ records: [], nextLine: 0, eof: true }))
  }
  if (withHooks) {
    plugin.onMount = vi.fn(() => undefined)
    plugin.dispose = vi.fn()
  }
  return plugin
}

describe('LifecycleManager', () => {
  it('deps 未就绪时 mount 返回 deferred 并进入延迟队列，不调用 onMount', async () => {
    const ctx = createPluginContext({ events: new EventBus() })
    const plugin = makePlugin('claude', ['storage'], true)
    const mgr = new LifecycleManager()

    const status = await mgr.mount(ctx, plugin)
    expect(status).toBe('deferred')
    expect(mgr.isMounted('claude')).toBe(false)
    expect(mgr.hasDeferred('claude')).toBe(true)
    expect(plugin.onMount).not.toHaveBeenCalled()
  })

  it('deps 全部就绪时 mount 调用 onMount 并标记已装载', async () => {
    const ctx = createPluginContext({
      events: new EventBus(),
      storage: {} as PluginContext['storage']
    })
    const plugin = makePlugin('claude', ['storage'], true)
    const mgr = new LifecycleManager()

    const status = await mgr.mount(ctx, plugin)
    expect(status).toBe('mounted')
    expect(mgr.isMounted('claude')).toBe(true)
    expect(plugin.onMount).toHaveBeenCalledTimes(1)
    expect(plugin.onMount).toHaveBeenCalledWith(ctx)
  })

  it('无 deps 声明时直接装载', async () => {
    const ctx = createPluginContext({ events: new EventBus() })
    const plugin = makePlugin('codex')
    const mgr = new LifecycleManager()

    const status = await mgr.mount(ctx, plugin)
    expect(status).toBe('mounted')
    expect(mgr.isMounted('codex')).toBe(true)
  })

  it('重复装载同一插件抛错', async () => {
    const ctx = createPluginContext({ events: new EventBus() })
    const plugin = makePlugin('codex')
    const mgr = new LifecycleManager()

    await mgr.mount(ctx, plugin)
    await expect(mgr.mount(ctx, plugin)).rejects.toThrow(/already mounted/)
  })

  it('unmount 调用 plugin.dispose 并清理 onMount 返回的 disposer', async () => {
    const scopeDispose = vi.fn()
    const ctx = createPluginContext({ events: new EventBus() })
    const plugin = makePlugin('claude', [], true)
    plugin.onMount = vi.fn(() => scopeDispose)
    const mgr = new LifecycleManager()

    await mgr.mount(ctx, plugin)
    mgr.unmount(ctx, plugin)

    expect(plugin.dispose).toHaveBeenCalledTimes(1)
    expect(plugin.dispose).toHaveBeenCalledWith(ctx)
    expect(scopeDispose).toHaveBeenCalledTimes(1)
    expect(mgr.isMounted('claude')).toBe(false)
  })

  it('unmount 后插件可重新装载（可逆）', async () => {
    const ctx = createPluginContext({ events: new EventBus() })
    const plugin = makePlugin('gemini', [], true)
    const mgr = new LifecycleManager()

    await mgr.mount(ctx, plugin)
    mgr.unmount(ctx, plugin)
    const status = await mgr.mount(ctx, plugin)
    expect(status).toBe('mounted')
  })

  it('retryDeferred 在服务就绪后装载延迟插件', async () => {
    const bus = new EventBus()
    const ctx = createPluginContext({ events: bus })
    const plugin = makePlugin('opencode', ['pricing', 'storage'], true)
    const mgr = new LifecycleManager()

    await mgr.mount(ctx, plugin)
    expect(mgr.hasDeferred('opencode')).toBe(true)

    const fullCtx = createPluginContext({
      events: bus,
      pricing: {} as PluginContext['pricing'],
      storage: {} as PluginContext['storage']
    })
    await mgr.retryDeferred(fullCtx)

    expect(mgr.isMounted('opencode')).toBe(true)
    expect(mgr.hasDeferred('opencode')).toBe(false)
    expect(plugin.onMount).toHaveBeenCalledTimes(1)
    expect(plugin.onMount).toHaveBeenCalledWith(fullCtx)
  })

  it('retryDeferred 后仍未就绪的插件保留在队列', async () => {
    const ctx = createPluginContext({ events: new EventBus() })
    const plugin = makePlugin('grok', ['storage'], true)
    const mgr = new LifecycleManager()

    await mgr.mount(ctx, plugin)
    await mgr.retryDeferred(createPluginContext({ events: new EventBus() }))

    expect(mgr.hasDeferred('grok')).toBe(true)
    expect(mgr.isMounted('grok')).toBe(false)
    expect(plugin.onMount).not.toHaveBeenCalled()
  })
})
