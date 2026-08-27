import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { SqliteDatabase } from '../services/db'
import { createUsageQuery, type UsageQueryService } from '../services/usageQuery'

export interface QueryClientService extends UsageQueryService {
  terminate(): void
}

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
