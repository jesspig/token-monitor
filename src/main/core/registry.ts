import type { AppType, ServiceKey } from '../../../shared/app'
import type { MonitorPlugin } from '../../../shared/plugin'

/** 插件元数据（registry 维护的注册信息与启用状态） */
export interface PluginMeta {
  id: AppType
  name: string
  version: string
  /** 依赖服务（去重后的 deps 快照，未声明则为空数组） */
  deps: ServiceKey[]
  /** 是否启用（内存态；持久化与否由调用方决定） */
  enabled: boolean
  /** 注册时间（epoch ms） */
  registeredAt: number
}

interface Entry {
  plugin: MonitorPlugin
  meta: PluginMeta
}

/**
 * 插件注册表（docs/concepts/plugin-architecture.md → registry）。
 * 注册/发现/启停插件，维护插件元数据与启用状态（内存态）。
 * 装载/卸载由 LifecycleManager 负责，本类不持有生命周期状态。
 */
export class PluginRegistry {
  private entries = new Map<AppType, Entry>()

  /** 注册插件；同一 id 重复注册抛错 */
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

  /** 所有已注册插件的元数据（注册顺序） */
  list(): PluginMeta[] {
    return [...this.entries.values()].map((entry) => entry.meta)
  }

  /** 按 id 取插件对象（供宿主调用 detect/listFiles/parseFile）；未注册返回 undefined */
  get(id: AppType): MonitorPlugin | undefined {
    return this.entries.get(id)?.plugin
  }

  /** 按 id 取插件元数据；未注册返回 undefined */
  getMeta(id: AppType): PluginMeta | undefined {
    return this.entries.get(id)?.meta
  }

  has(id: AppType): boolean {
    return this.entries.has(id)
  }

  /** 启用插件（默认注册即启用） */
  enable(id: AppType): void {
    this.require(id).meta.enabled = true
  }

  /** 禁用插件（仅切换状态，卸载由宿主经 lifecycle 完成） */
  disable(id: AppType): void {
    this.require(id).meta.enabled = false
  }

  isEnabled(id: AppType): boolean {
    return this.entries.get(id)?.meta.enabled ?? false
  }

  /** 移除插件；未注册返回 false */
  remove(id: AppType): boolean {
    return this.entries.delete(id)
  }

  private require(id: AppType): Entry {
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`Plugin "${id}" is not registered`)
    return entry
  }
}
