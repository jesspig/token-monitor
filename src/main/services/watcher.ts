import { watch, type FSWatcher } from 'chokidar'
import type { WatcherService } from '../../../shared/context'

/**
 * 基于 chokidar 的文件监听服务（docs/concepts/sync-mechanism.md「增量」）。
 *
 * 监听目标（文件或目录，忽略初始扫描）的增/改/删事件并触发 onChange；
 * options.debounceMs 用于合并高频变更（窗口内重置定时器，仅最后一次到期后触发）。
 * registerWatcher 返回 disposer，卸载时关闭 watcher 并清理，保证生命周期可逆。
 */
export class WatcherServiceImpl implements WatcherService {
  /** 记录活跃 watcher，便于 dispose 时统一清理 */
  private readonly watchers = new Set<FSWatcher>()

  registerWatcher(
    target: string | string[],
    onChange: () => void | Promise<void>,
    options?: { debounceMs?: number }
  ): () => void {
    const debounceMs = options?.debounceMs ?? 0
    let debounceTimer: NodeJS.Timeout | undefined
    let closed = false

    const fire = (): void => {
      if (closed) return
      // onChange 可能同步抛错或返回 rejected promise，均兜底为日志
      void Promise.resolve()
        .then(() => onChange())
        .catch((err) => {
          console.error('[watcher] 变更回调执行失败:', err)
        })
    }

    const onEvent = (): void => {
      if (closed) return
      if (debounceMs > 0) {
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(fire, debounceMs)
      } else {
        fire()
      }
    }

    const watcher = watch(target, { ignoreInitial: true })
    watcher.on('add', onEvent)
    watcher.on('change', onEvent)
    watcher.on('unlink', onEvent)
    watcher.on('error', (err) => {
      console.error('[watcher] 文件监听出错:', err)
    })

    this.watchers.add(watcher)

    return () => {
      if (closed) return
      closed = true
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = undefined
      }
      this.watchers.delete(watcher)
      void watcher.close()
    }
  }
}

/** 单例：宿主作为 ctx.watcher 注入插件 */
export const watcherService: WatcherService = new WatcherServiceImpl()
