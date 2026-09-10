import type { PluginContext } from '../../../shared/context'

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

export function isServiceReady(ctx: PluginContext, key: keyof PluginContext): boolean {
  try {
    void ctx[key]
    return true
  } catch {
    return false
  }
}
