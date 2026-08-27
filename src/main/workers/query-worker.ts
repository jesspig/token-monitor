import { parentPort, workerData } from 'node:worker_threads'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { createUsageQuery, type UsageQueryService } from '../services/usageQuery'
import { DB_FILENAME } from '../services/db'

interface QueryRequest {
  id: number
  method: string
  args: unknown[]
}

if (!parentPort) {
  throw new Error('query-worker 必须经 worker_threads 作为入口运行')
}

const dataDir = (workerData as { dataDir: string }).dataDir
let query: UsageQueryService | null = null

function ensureQuery(): UsageQueryService {
  if (query) return query
  const dbPath = join(dataDir, DB_FILENAME)
  // 只读连接：WAL 下可读已提交快照且不阻塞主线程写者（见 db.ts 启用 WAL）
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  query = createUsageQuery(db)
  return query
}

parentPort.on('message', async (req: QueryRequest) => {
  try {
    const q = ensureQuery()
    const result = await (q as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[
      req.method
    ](...req.args)
    parentPort!.postMessage({ id: req.id, ok: true, result })
  } catch (e) {
    parentPort!.postMessage({
      id: req.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e)
    })
  }
})
