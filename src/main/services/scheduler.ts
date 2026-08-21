import type { SchedulerService } from '../../../shared/context'

/**
 * 定时兜底扫描服务（docs/concepts/sync-mechanism.md「兜底」）。
 *
 * 基于 Node setInterval 实现：注册定时任务并返回 disposer，
 * 卸载时停止定时器并清理引用，保证插件生命周期可逆。
 * 兜底间隔（默认 5 分钟）由调用方传入，实现不硬编码默认值。
 */
export class SchedulerServiceImpl implements SchedulerService {
  /** 记录活跃定时器引用，便于 dispose 时统一清理 */
  private readonly timers = new Set<NodeJS.Timeout>()

  schedule(intervalMs: number, task: () => void | Promise<void>): () => void {
    const timer = setInterval(() => {
      // 任务可能同步抛错或返回 rejected promise，均兜底为日志，不影响后续调度
      void Promise.resolve()
        .then(() => task())
        .catch((err) => {
          console.error('[scheduler] 定时任务执行失败:', err)
        })
    }, intervalMs)

    this.timers.add(timer)

    return () => {
      clearInterval(timer)
      this.timers.delete(timer)
    }
  }
}

/** 单例：宿主作为 ctx.scheduler 注入插件 */
export const schedulerService: SchedulerService = new SchedulerServiceImpl()
