import type { AppType, ServiceKey } from '../../../shared/app'
import type { MonitorPlugin } from '../../../shared/plugin'

export interface PluginMeta {
  id: AppType
  name: string
  version: string
  deps: ServiceKey[]
  enabled: boolean
  registeredAt: number
}

interface Entry {
  plugin: MonitorPlugin
  meta: PluginMeta
}

export class PluginRegistry {
  private entries = new Map<AppType, Entry>()

  register(plugin: MonitorPlugin): void {
    if (this.entries.has(plugin.id)) {
      throw new Error(`Plugin "${plugin.id}" is already registered`)
    }
    this.entries.set(plugin.id, {
      plugin,
      meta: {
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        deps: plugin.deps ?? [],
        enabled: true,
        registeredAt: Date.now()
      }
    })
  }

  list(): PluginMeta[] {
    return [...this.entries.values()].map((entry) => entry.meta)
  }

  get(id: AppType): MonitorPlugin | undefined {
    return this.entries.get(id)?.plugin
  }

  getMeta(id: AppType): PluginMeta | undefined {
    return this.entries.get(id)?.meta
  }

  has(id: AppType): boolean {
    return this.entries.has(id)
  }

  enable(id: AppType): void {
    this.require(id).meta.enabled = true
  }

  disable(id: AppType): void {
    this.require(id).meta.enabled = false
  }

  isEnabled(id: AppType): boolean {
    return this.entries.get(id)?.meta.enabled ?? false
  }

  remove(id: AppType): boolean {
    return this.entries.delete(id)
  }

  private require(id: AppType): Entry {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`Plugin "${id}" is not registered`)
    return entry
  }
}
