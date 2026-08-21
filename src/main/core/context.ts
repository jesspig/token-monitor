import type { PluginContext } from '../../../shared/context'

/**
 * 构建注入给插件的服务容器 ctx（docs/concepts/plugin-architecture.md → context）。
 * 仅暴露已就绪的服务；未提供的服务在访问时抛错（
 * 宿主应先注册服务再装载插件，lifecycle 的 deps 校验依赖此抛错行为）。
 */
export function createPluginContext(services: Partial<PluginContext>): PluginContext {
  return new Proxy(services, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
      if (!(prop in target)) {
        throw new Error(`Service "${String(prop)}" is not provided to plugin context`)
      }
      return Reflect.get(target, prop, receiver)
    }
  }) as PluginContext
}

/** 判断服务键在 ctx 中是否就绪（访问不抛错即为就绪） */
export function isServiceReady(ctx: PluginContext, key: keyof PluginContext): boolean {
  try {
    void ctx[key]
    return true
  } catch {
    return false
  }
}
