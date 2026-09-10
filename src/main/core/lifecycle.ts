import type { AppType } from '../../../shared/app'
import type { PluginContext } from '../../../shared/context'
import type { MonitorPlugin } from '../../../shared/plugin'
import { isServiceReady } from './context'

type Disposer = () => void

export interface LifecyclePlugin extends MonitorPlugin {
  onMount?(ctx: PluginContext): void | Disposer | Promise<void | Disposer>
}

export type MountStatus = 'mounted' | 'deferred'

export class LifecycleManager {
  private scopes = new Map<AppType, Set<Disposer>>()
  private deferred: LifecyclePlugin[] = []

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
