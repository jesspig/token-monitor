import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SchedulerServiceImpl } from './scheduler'

describe('SchedulerServiceImpl', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('按固定间隔重复执行任务', async () => {
    const scheduler = new SchedulerServiceImpl()
    const calls: number[] = []
    scheduler.schedule(1000, () => { calls.push(1) })

    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(3000)
    expect(calls).toHaveLength(4)
  })

  it('dispose 后不再执行任务', async () => {
    const scheduler = new SchedulerServiceImpl()
    const calls: number[] = []
    const dispose = scheduler.schedule(1000, () => { calls.push(1) })

    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toHaveLength(1)

    dispose()
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toHaveLength(1)
  })

  it('任务同步抛错不影响后续调度（错误兜底）', async () => {
    const scheduler = new SchedulerServiceImpl()
    const calls: number[] = []
    let shouldThrow = true
    scheduler.schedule(1000, () => {
      if (shouldThrow) {
        shouldThrow = false
        throw new Error('boom')
      }
      calls.push(1)
    })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toHaveLength(1)
  })

  it('任务返回 rejected promise 不影响后续调度（错误兜底）', async () => {
    const scheduler = new SchedulerServiceImpl()
    const calls: number[] = []
    let shouldReject = true
    scheduler.schedule(1000, () => {
      if (shouldReject) {
        shouldReject = false
        return Promise.reject(new Error('rejected'))
      }
      calls.push(1)
      return Promise.resolve()
    })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toHaveLength(1)
  })
})
