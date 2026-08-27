import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { SqliteDatabase } from '../services/db'
import { createUsageQuery, type UsageQueryService } from '../services/usageQuery'

export interface QueryClientService extends UsageQueryService {
  /** 退出时终止 worker 线程（主进程直查回退时为空操作） */
  terminate(): void
}

/**
 * 统计查询客户端：文件库模式下把查询 offload 到只读 worker 线程，主线程不再被 better-sqlite3 阻塞；
 * :memory: 或 worker 启动失败时回退为主进程直查（仍走同一 createUsageQuery，仅失去线程隔离）。
 * workerData 传入 dataDir 供 worker 拼出 DB 文件路径；相同 (method+args) 的并发请求做 in-flight 去重，
 * 收敛 usage-updated 事件触发的批量失效重取风暴。
 */
export function createQueryClient(dataDir: string, fallbackDb?: SqliteDatabase): QueryClientService {
  if (dataDir === ':memory:' || fallbackDb == null) {
    const inProc = createUsageQuery(fallbackDb as SqliteDatabase)
    return { ...inProc, terminate() {} }
  }

  let worker: Worker | null = null
  try {
    worker = new Worker(join(__dirname, 'query-worker.js'), { workerData: { dataDir } })
  } catch (err) {
    console.error('[queryClient] worker 启动失败，回退主进程直查:', err)
    const inProc = createUsageQuery(fallbackDb)
    return { ...inProc, terminate() {} }
  }

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  const inflight = new Map<string, Promise<unknown>>()
  let nextId = 1

  worker.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new Error(msg.error ?? 'unknown worker error'))
  })
  worker.on('error', (err) => {
    for (const p of pending.values()) p.reject(err)
    pending.clear()
  })

  function call(method: string, args: unknown[]): Promise<unknown> {
    const key = method + ':' + JSON.stringify(args)
    const existing = inflight.get(key)
    if (existing) return existing
    const promise = new Promise<unknown>((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      worker!.postMessage({ id, method, args })
    })
    inflight.set(key, promise)
    void promise.finally(() => inflight.delete(key))
    return promise
  }

  const facade: QueryClientService = {
    getUsageSummary: (f) =>
      call('getUsageSummary', [f]) as Promise<
        Awaited<ReturnType<UsageQueryService['getUsageSummary']>>
      >,
    getDailyTrends: (f) =>
      call('getDailyTrends', [f]) as Promise<
        Awaited<ReturnType<UsageQueryService['getDailyTrends']>>
      >,
    getHourlyTrends: (f) =>
      call('getHourlyTrends', [f]) as Promise<
        Awaited<ReturnType<UsageQueryService['getHourlyTrends']>>
      >,
    getModelStats: (f) =>
      call('getModelStats', [f]) as Promise<
        Awaited<ReturnType<UsageQueryService['getModelStats']>>
      >,
    getAppStats: (f) =>
      call('getAppStats', [f]) as Promise<Awaited<ReturnType<UsageQueryService['getAppStats']>>>,
    getRequestLogs: (f) =>
      call('getRequestLogs', [f]) as Promise<
        Awaited<ReturnType<UsageQueryService['getRequestLogs']>>
      >,
    getRequestLogDetail: (id) =>
      call('getRequestLogDetail', [id]) as Promise<
        Awaited<ReturnType<UsageQueryService['getRequestLogDetail']>>
      >,
    getFilterOptions: () =>
      call('getFilterOptions', []) as Promise<
        Awaited<ReturnType<UsageQueryService['getFilterOptions']>>
      >,
    terminate() {
      worker?.terminate()
      worker = null
    }
  }
  return facade
}
