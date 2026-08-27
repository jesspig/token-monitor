import type {
  EventsService,
  PluginEventMap,
  UsageUpdatedEvent
} from '../../../shared/context'

const DEBOUNCE_WINDOW: Partial<Record<keyof PluginEventMap, number>> = {
  'usage-updated': 200
}

type Listener<K extends keyof PluginEventMap> = (payload: PluginEventMap[K]) => void

export class EventBus implements EventsService {
  private listeners = new Map<keyof PluginEventMap, Set<(payload: never) => void>>()
  private timers = new Map<keyof PluginEventMap, ReturnType<typeof setTimeout>>()
  private pending = new Map<keyof PluginEventMap, PluginEventMap[keyof PluginEventMap]>()

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
