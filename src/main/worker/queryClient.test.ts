import { describe, it, expect } from 'vitest'
import type { UsageRecord } from '../../../shared/dto'
import { createDatabase, migrate, type SqliteDatabase } from '../services/db'
import { SqliteStorage } from '../services/storage'
import { createUsageQuery } from '../services/usageQuery'
import { createQueryClient } from './queryClient'

function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    appType: 'claude',
    model: 'claude-sonnet-4',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 20,
    cacheCreationTokens: 10,
    inputSemantics: 1,
    costUsd: '0.001',
    currency: 'USD',
    latencyMs: 800,
    status: 'success',
    createdAt: Date.now(),
    source: { filePath: '/s/record.jsonl', line: 1 },
    ...overrides
  }
}

describe('createQueryClient :memory: 进程内直查分支', () => {
  it('不 spawn worker，结果与管理进程 createUsageQuery 直查一致；terminate 为空操作不抛错', async () => {
    const db: SqliteDatabase = createDatabase(':memory:')
    migrate(db)
    const storage = new SqliteStorage(db)
    await storage.recordUsage([
      makeRecord({ source: { filePath: '/s/a.jsonl', line: 1 } }),
      makeRecord({
        status: 'error',
        costUsd: '0.002',
        latencyMs: 400,
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        source: { filePath: '/s/a.jsonl', line: 2 }
      }),
      makeRecord({
        appType: 'codex',
        model: 'gpt-5',
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheCreationTokens: 2,
        costUsd: '0.01',
        latencyMs: 100,
        source: { filePath: '/s/b.jsonl', line: 1 }
      })
    ])

    const dbQ = createUsageQuery(db)
    const client = createQueryClient(':memory:', db)

    expect(client.terminate).toBeTypeOf('function')

    const summaryFromClient = await client.getUsageSummary({})
    const summaryFromDb = await dbQ.getUsageSummary({})
    expect(summaryFromClient).toEqual(summaryFromDb)
    expect(summaryFromClient.totalRequests).toBe(3)
    expect(summaryFromClient.totalCost).toBe('0.013')

    const dailyFromClient = await client.getDailyTrends({})
    const dailyFromDb = await dbQ.getDailyTrends({})
    expect(dailyFromClient).toEqual(dailyFromDb)

    const hourlyFromClient = await client.getHourlyTrends({})
    const hourlyFromDb = await dbQ.getHourlyTrends({})
    expect(hourlyFromClient).toEqual(hourlyFromDb)

    expect(() => client.terminate()).not.toThrow()
  })
})
