import type { AppType } from '../../../shared/app'
import type { PluginContext } from '../../../shared/context'
import type { MonitorPlugin } from '../../../shared/plugin'
import { isServiceReady } from './context'

type Disposer = () => void

/**
 * 内核为插件提供的可选装载钩子（生命周期扩展，非采集入口）：
 * 装载时做一次性初始化，可返回一个 disposer 交由宿主在卸载时统一清理。
 * 不影响 shared/plugin.ts 的 MonitorPlugin 契约。
 */
export interface LifecyclePlugin extends MonitorPlugin {
  onMount?(ctx: PluginContext): void | Disposer | Promise<void | Disposer>
}

export type MountStatus = 'mounted' | 'deferred'

/**
 * 插件装载/卸载调度（docs/concepts/plugin-architecture.md → lifecycle）。
 *  - mount：按 plugin.deps 校验服务已就绪；就绪则调用可选 onMount 并登记其 disposer，
 *    未就绪则进入延迟装载队列；
 *  - unmount：先调用 plugin.dispose?.()，再清理该插件登记的所有 disposer，可逆；
 *  - retryDeferred：服务就绪后重试延迟队列（简单可靠的延迟装载方案）。
 */
export class LifecycleManager {
  /** 已装载插件的 disposer 集合（scope），卸载时统一清理 */
  private scopes = new Map<AppType, Set<Disposer>>()
  /** 依赖未就绪、待重试装载的插件 */
  private deferred: LifecyclePlugin[] = []

  /** 装载插件；deps 全部就绪则装载，否则进入延迟队列并返回 'deferred' */
  async mount(ctx: PluginContext, plugin: LifecyclePlugin): Promise<MountStatus> {
    if (this.scopes.has(plugin.id)) {
      throw new Error(`Plugin "${plugin.id}" is already mounted`)
    }
    if (!this.depsReady(ctx, plugin)) {
      if (!this.deferred.some((p) => p.id === plugin.id)) this.deferred.push(plugin)
      return 'deferred'
    }
    await this.doMount(ctx, plugin)
    return 'mounted'
  }

  /** 服务就绪后重试延迟装载队列；仍未就绪的插件保留在队列中 */
  async retryDeferred(ctx: PluginContext): Promise<void> {
    const pending = this.deferred
    this.deferred = []
    for (const plugin of pending) {
      if (this.depsReady(ctx, plugin)) {
        await this.doMount(ctx, plugin)
      } else {
        this.deferred.push(plugin)
      }
    }
  }

  /** 卸载插件：先调 plugin.dispose?.()，再清理该插件登记的所有 disposer */
  unmount(ctx: PluginContext, plugin: LifecyclePlugin): void {
    try {
      plugin.dispose?.(ctx)
    } finally {
      const scope = this.scopes.get(plugin.id)
      if (scope) {
        for (const dispose of scope) {
          try {
            dispose()
          } catch {
            // 单条清理失败不阻塞其余 disposer 的清理
          }
        }
        this.scopes.delete(plugin.id)
      }
      const index = this.deferred.findIndex((p) => p.id === plugin.id)
      if (index >= 0) this.deferred.splice(index, 1)
    }
  }

  isMounted(id: AppType): boolean {
    return this.scopes.has(id)
  }

  hasDeferred(id: AppType): boolean {
    return this.deferred.some((p) => p.id === id)
  }

  private depsReady(ctx: PluginContext, plugin: LifecyclePlugin): boolean {
    return (plugin.deps ?? []).every((key) => isServiceReady(ctx, key))
  }

  private async doMount(ctx: PluginContext, plugin: LifecyclePlugin): Promise<void> {
    const scope = new Set<Disposer>()
    if (plugin.onMount) {
      const result = await plugin.onMount(ctx)
      if (typeof result === 'function') scope.add(result)
    }
    this.scopes.set(plugin.id, scope)
  }
}
