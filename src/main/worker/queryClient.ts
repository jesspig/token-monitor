import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import type { SqliteDatabase } from '../services/db'
import { createUsageQuery, type UsageQueryService } from '../services/usageQuery'

export interface QueryClientService extends UsageQueryService {
  terminate(): void
}

const WORKER_POOL_SIZE = 2

const HEAVY_METHODS = new Set<string>([
  'getStatsByProject',
  'getStatsBySession',
  'getStatsByStatus',
  'getRequestLogs',
  'getUsageSummary'
])

interface PendingEntry {
  worker: Worker
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
}

export function createQueryClient(dataDir: string, fallbackDb?: SqliteDatabase): QueryClientService {
  if (dataDir === ':memory:' || fallbackDb == null) {
    const inProc = createUsageQuery(fallbackDb as SqliteDatabase)
    return { ...inProc, terminate() {} }
  }

  let pool: Worker[] = []
  try {
    const size = Math.max(1, WORKER_POOL_SIZE)
    for (let i = 0; i < size; i++) {
      pool.push(new Worker(join(__dirname, 'query-worker.js'), { workerData: { dataDir } }))
    }
  } catch (err) {
    console.error('[queryClient] worker 启动失败，回退主进程直查:', err)
    const inProc = createUsageQuery(fallbackDb)
    return { ...inProc, terminate() {} }
  }

  const pending = new Map<number, PendingEntry>()
  const inflight = new Map<string, Promise<unknown>>()
  let nextId = 1

  for (const w of pool) {
    w.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error ?? 'unknown worker error'))
    })
    w.on('error', (err) => {
      for (const [id, p] of pending) {
        if (p.worker === w) {
          pending.delete(id)
          p.reject(err)
        }
      }
    })
  }

  function call(method: string, args: unknown[]): Promise<unknown> {
    const key = method + ':' + JSON.stringify(args)
    const existing = inflight.get(key)
    if (existing) return existing
    const promise = new Promise<unknown>((resolve, reject) => {
      const id = nextId++
      const worker = pool.length >= 2 && HEAVY_METHODS.has(method) ? pool[0] : pool[pool.length - 1]
      pending.set(id, { worker, resolve, reject })
      worker.postMessage({ id, method, args })
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
    getStatsByProject: (f) =>
      call('getStatsByProject', [f]) as Promise<
        Awaited<ReturnType<UsageQueryService['getStatsByProject']>>
      >,
    getStatsBySession: (f) =>
      call('getStatsBySession', [f]) as Promise<
        Awaited<ReturnType<UsageQueryService['getStatsBySession']>>
      >,
    getStatsByStatus: (f) =>
      call('getStatsByStatus', [f]) as Promise<
        Awaited<ReturnType<UsageQueryService['getStatsByStatus']>>
      >,
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
    getDailyModelBreakdown: (f) =>
      call('getDailyModelBreakdown', [f]) as Promise<
        Awaited<ReturnType<UsageQueryService['getDailyModelBreakdown']>>
      >,
    terminate() {
      for (const w of pool) w.terminate()
      pool = []
    }
  }
  return facade
}
