import type { SchedulerService } from '../../../shared/context'

/**
 * 定时兜底扫描服务（docs/concepts/sync-mechanism.md「兜底」）。
 *
 * 基于 Node setTimeout/setInterval 实现：首次延迟 initialDelayMs（省略 = intervalMs，
 * 语义与裸 setInterval 一致）后进入周期触发；注册返回 disposer，卸载时停止定时器
 * 并清理引用，保证插件生命周期可逆。兜底间隔（默认 5 分钟）由调用方传入，
 * 实现不硬编码默认值。
 */
export class SchedulerServiceImpl implements SchedulerService {
  /** 记录活跃定时器引用，便于 dispose 时统一清理 */
  private readonly timers = new Set<NodeJS.Timeout>()

  schedule(intervalMs: number, task: () => void | Promise<void>, initialDelayMs?: number): () => void {
    const owned = new Set<NodeJS.Timeout>()
    const run = (): void => {
      // 任务可能同步抛错或返回 rejected promise，均兜底为日志，不影响后续调度
      void Promise.resolve()
        .then(() => task())
        .catch((err) => {
          console.error('[scheduler] 定时任务执行失败:', err)
        })
    }
    let intervalTimer: NodeJS.Timeout | null = null
    const initialTimer = setTimeout(
      () => {
        // 首次到点立即执行一次，随后进入周期：默认（initialDelayMs 缺省 = intervalMs）
        // 时间线与裸 setInterval 完全一致；传入偏移时首触提前、后续仍按整周期
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

/** 单例：宿主作为 ctx.scheduler 注入插件 */
export const schedulerService: SchedulerService = new SchedulerServiceImpl()
