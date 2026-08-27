import { watch, type FSWatcher } from 'chokidar'
import type { WatcherService } from '../../../shared/context'

export class WatcherServiceImpl implements WatcherService {
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

export const watcherService: WatcherService = new WatcherServiceImpl()
