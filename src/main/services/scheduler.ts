import type { SchedulerService } from '../../../shared/context'

export class SchedulerServiceImpl implements SchedulerService {
  private readonly timers = new Set<NodeJS.Timeout>()

  schedule(intervalMs: number, task: () => void | Promise<void>, initialDelayMs?: number): () => void {
    const owned = new Set<NodeJS.Timeout>()
    const run = (): void => {
      void Promise.resolve()
        .then(() => task())
        .catch((err) => {
          console.error('[scheduler] 定时任务执行失败:', err)
        })
    }
    let intervalTimer: NodeJS.Timeout | null = null
    const initialTimer = setTimeout(
      () => {
        run()
        intervalTimer = setInterval(run, intervalMs)
        owned.add(intervalTimer)
        this.timers.add(intervalTimer)
      },
      Math.max(0, initialDelayMs ?? intervalMs)
    )
    owned.add(initialTimer)
    this.timers.add(initialTimer)

    return () => {
      clearTimeout(initialTimer)
      if (intervalTimer) clearInterval(intervalTimer)
      for (const t of owned) this.timers.delete(t)
    }
  }
}

export const schedulerService: SchedulerService = new SchedulerServiceImpl()
