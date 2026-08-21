import type {
  EventsService,
  PluginEventMap,
  UsageUpdatedEvent
} from '../../../shared/context'

/**
 * 需要防抖合并的事件与其窗口（ms）。
 * usage-updated 窗口内多次 emit 合并为一次派发，用于通知前端刷新。
 */
const DEBOUNCE_WINDOW: Partial<Record<keyof PluginEventMap, number>> = {
  'usage-updated': 200
}

type Listener<K extends keyof PluginEventMap> = (payload: PluginEventMap[K]) => void

/**
 * 类型化事件总线（docs/concepts/plugin-architecture.md → event-bus）。
 * 实现 shared/context.ts 的 EventsService 契约：
 *  - on(event, listener) 返回 disposer，可逆清理；
 *  - emit(event, payload) 同步派发；usage-updated 走 200ms 防抖合并
 *    （窗口内多次 emit 合并为一次，addedRecords 累加、updatedAt 取最后一次）。
 */
export class EventBus implements EventsService {
  /** 内部以 never 参数位置的函数存储，可安全容纳任意事件类型的订阅者（参数逆变） */
  private listeners = new Map<keyof PluginEventMap, Set<(payload: never) => void>>()
  private timers = new Map<keyof PluginEventMap, ReturnType<typeof setTimeout>>()
  private pending = new Map<keyof PluginEventMap, PluginEventMap[keyof PluginEventMap]>()

  /** 订阅事件；返回 disposer，调用后不再接收该事件 */
  on<K extends keyof PluginEventMap>(event: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    const handlers = set
    handlers.add(listener)
    return () => {
      handlers.delete(listener)
      if (handlers.size === 0) this.listeners.delete(event)
    }
  }

  /** 派发事件；usage-updated 在 200ms 防抖窗口结束后合并派发一次 */
  emit<K extends keyof PluginEventMap>(event: K, payload: PluginEventMap[K]): void {
    const window = DEBOUNCE_WINDOW[event]
    if (window === undefined) {
      this.dispatch(event, payload)
      return
    }

    this.pending.set(
      event,
      this.mergePayload(event, this.pending.get(event) as PluginEventMap[K] | undefined, payload)
    )

    const existing = this.timers.get(event)
    if (existing !== undefined) clearTimeout(existing)
    this.timers.set(
      event,
      setTimeout(() => {
        this.timers.delete(event)
        const final = this.pending.get(event)
        this.pending.delete(event)
        if (final !== undefined) this.dispatch(event, final as PluginEventMap[K])
      }, window)
    )
  }

  private dispatch<K extends keyof PluginEventMap>(event: K, payload: PluginEventMap[K]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const listener of set) (listener as Listener<K>)(payload)
  }

  /** 窗口内多次 emit 的合并规则 */
  private mergePayload<K extends keyof PluginEventMap>(
    event: K,
    prev: PluginEventMap[K] | undefined,
    next: PluginEventMap[K]
  ): PluginEventMap[K] {
    if (event === 'usage-updated') {
      const p = prev as UsageUpdatedEvent | undefined
      const n = next as UsageUpdatedEvent
      return {
        updatedAt: n.updatedAt,
        addedRecords: (p?.addedRecords ?? 0) + n.addedRecords
      } as PluginEventMap[K]
    }
    return next
  }
}
