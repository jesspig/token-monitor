import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from './event-bus'
import type { UsageUpdatedEvent } from '../../../shared/context'

const updated = (updatedAt: number, addedRecords: number): UsageUpdatedEvent => ({
  updatedAt,
  addedRecords
})

describe('EventBus', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('usage-updated 200ms 防抖合并', () => {
    it('窗口内多次 emit 合并为一次派发：addedRecords 累加、updatedAt 取最后', () => {
      const bus = new EventBus()
      const listener = vi.fn()
      bus.on('usage-updated', listener)

      bus.emit('usage-updated', updated(1, 1))
      bus.emit('usage-updated', updated(2, 3))
      bus.emit('usage-updated', updated(3, 2))

      expect(listener).not.toHaveBeenCalled()
      vi.advanceTimersByTime(199)
      expect(listener).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith({ updatedAt: 3, addedRecords: 6 })
    })

    it('窗口内再次 emit 会重置窗口，仅派发一次', () => {
      const bus = new EventBus()
      const listener = vi.fn()
      bus.on('usage-updated', listener)

      bus.emit('usage-updated', updated(1, 1))
      vi.advanceTimersByTime(100)
      bus.emit('usage-updated', updated(2, 2))
      vi.advanceTimersByTime(150)
      expect(listener).not.toHaveBeenCalled()

      vi.advanceTimersByTime(50)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith({ updatedAt: 2, addedRecords: 3 })
    })

    it('窗口结束后再次 emit 触发新一轮派发', () => {
      const bus = new EventBus()
      const listener = vi.fn()
      bus.on('usage-updated', listener)

      bus.emit('usage-updated', updated(1, 1))
      vi.advanceTimersByTime(200)
      bus.emit('usage-updated', updated(2, 4))
      vi.advanceTimersByTime(200)

      expect(listener).toHaveBeenCalledTimes(2)
      expect(listener).toHaveBeenNthCalledWith(1, { updatedAt: 1, addedRecords: 1 })
      expect(listener).toHaveBeenNthCalledWith(2, { updatedAt: 2, addedRecords: 4 })
    })
  })

  describe('on 返回的 disposer', () => {
    it('disposer 调用后不再接收事件', () => {
      const bus = new EventBus()
      const listener = vi.fn()
      const dispose = bus.on('usage-updated', listener)

      dispose()
      bus.emit('usage-updated', updated(1, 1))
      vi.advanceTimersByTime(200)
      expect(listener).not.toHaveBeenCalled()
    })

    it('多个订阅者各自收到合并后的派发', () => {
      const bus = new EventBus()
      const a = vi.fn()
      const b = vi.fn()
      bus.on('usage-updated', a)
      bus.on('usage-updated', b)

      bus.emit('usage-updated', updated(1, 2))
      vi.advanceTimersByTime(200)
      expect(a).toHaveBeenCalledTimes(1)
      expect(b).toHaveBeenCalledTimes(1)
      expect(a).toHaveBeenCalledWith({ updatedAt: 1, addedRecords: 2 })
      expect(b).toHaveBeenCalledWith({ updatedAt: 1, addedRecords: 2 })
    })
  })
})
