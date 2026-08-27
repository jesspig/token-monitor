import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelPricingRow } from '../../../shared/tables'
import type { StorageService } from '../../../shared/context'
import type { SqliteDatabase } from './db'
import { createDatabase, migrate } from './db'
import { SqliteStorage } from './storage'
import { MODELSDEV_FETCH_TIMEOUT_MS, fetchCatalog, parseCatalog, syncPricing } from './modelsdev'

const FIXTURE = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    models: {
      'claude-opus': {
        id: 'claude-opus-4-1',
        name: 'Claude Opus 4.1',
        cost: { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 }
      },
      'claude-haiku': { id: 'claude-haiku', cost: { input: 1, output: 5 } },
      'key-only-model': { cost: { input: 2, output: 4 } }
    }
  },
  broken: {
    name: 'Broken Provider',
    models: {
      'm-no-cost': { id: 'm-no-cost' },
      'm-empty-cost': { id: 'm-empty-cost', cost: {} },
      'm-partial-cost': { id: 'm-partial-cost', cost: { input: 3 } },
      'm-negative-input': { id: 'm-negative-input', cost: { input: -1, output: 2 } }
    }
  }
}

const EXPECTED_IDS = ['claude-opus-4-1', 'claude-haiku', 'key-only-model']

function stubFetch(payload: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(payload), { status }))
  )
}

function makeStorage(): { storage: SqliteStorage; db: SqliteDatabase } {
  const db = createDatabase(':memory:')
  migrate(db)
  return { storage: new SqliteStorage(db), db }
}

function userRow(modelId: string): ModelPricingRow {
  return {
    model_id: modelId,
    provider: 'manual-provider',
    input_per_million: 999,
    output_per_million: 999,
    cache_read_per_million: 999,
    cache_creation_per_million: 999,
    currency: 'USD',
    cost_multiplier: 2,
    updated_at: 111
  }
}

function withBatchWriteFailure(inner: SqliteStorage): StorageService {
  return {
    recordUsage: (records) => inner.recordUsage(records),
    getCursor: (filePath) => inner.getCursor(filePath),
    getCursorMeta: (filePath) => inner.getCursorMeta(filePath),
    setCursor: (filePath, line, fileMtime) => inner.setCursor(filePath, line, fileMtime),
    getModelPricing: () => inner.getModelPricing(),
    updateModelPricing: async (entry, source) => {
      await inner.updateModelPricing(entry, source)
    },
    updateModelPricingBatch: async () => {
      throw new Error('simulated batch write failure')
    },
    deleteModelPricing: (modelId) => inner.deleteModelPricing(modelId)
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseCatalog 展平映射', () => {
  it('完整条目正确映射 provider/id/name 与四档价格，计数自洽', () => {
    const result = parseCatalog(FIXTURE)

    expect(result.total).toBe(7)
    expect(result.skipped).toBe(4)
    expect(result.entries.map((e) => e.modelId).sort()).toEqual([...EXPECTED_IDS].sort())

    const opus = result.entries.find((e) => e.modelId === 'claude-opus-4-1')
    expect(opus).toEqual({
      provider: 'anthropic',
      modelId: 'claude-opus-4-1',
      name: 'Claude Opus 4.1',
      inputPerMillion: 15,
      outputPerMillion: 75,
      cacheReadPerMillion: 1.5,
      cacheCreationPerMillion: 18.75
    })
  })

  it('cache 档缺失补 0，entry.id 缺失退回对象 key，name 缺失为 null', () => {
    const result = parseCatalog(FIXTURE)

    const haiku = result.entries.find((e) => e.modelId === 'claude-haiku')
    expect(haiku).toMatchObject({
      provider: 'anthropic',
      name: null,
      inputPerMillion: 1,
      outputPerMillion: 5,
      cacheReadPerMillion: 0,
      cacheCreationPerMillion: 0
    })

    const keyOnly = result.entries.find((e) => e.modelId === 'key-only-model')
    expect(keyOnly).toMatchObject({ provider: 'anthropic', modelId: 'key-only-model', name: null })
  })

  it('cost 缺失或 input/output 非法的条目被丢弃且计入 skipped', () => {
    const result = parseCatalog(FIXTURE)

    const ids = result.entries.map((e) => e.modelId)
    for (const bad of ['m-no-cost', 'm-empty-cost', 'm-partial-cost', 'm-negative-input']) {
      expect(ids).not.toContain(bad)
    }
    expect(result.skipped).toBe(4)
  })

  it('provider key 为空串时回退 name；顶层非对象返回空结果不抛错', () => {
    const fallbackPayload = {
      '': { name: 'Fallback Name', models: { m: { id: 'm-1', cost: { input: 1, output: 2 } } } }
    }

    const fallback = parseCatalog(fallbackPayload)

    expect(fallback.entries[0]?.provider).toBe('Fallback Name')

    for (const bad of [null, undefined, [], 'str', 42]) {
      expect(parseCatalog(bad)).toEqual({ entries: [], total: 0, skipped: 0 })
    }
  })
})

describe('fetchCatalog 网络层', () => {
  it('mock global.fetch 返回 fixture 时完成拉取与展平', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(FIXTURE), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchCatalog()

    expect(result.entries.map((e) => e.modelId).sort()).toEqual([...EXPECTED_IDS].sort())
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://models.dev/api.json',
      expect.objectContaining({ signal: expect.anything() })
    )
  })

  it('HTTP 非 2xx 直接抛错', async () => {
    stubFetch({ error: 'boom' }, 503)

    await expect(fetchCatalog()).rejects.toThrow('HTTP 503')
  })

  it('fetch 拒绝（网络失败/超时中止形态）向上抛出', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      })
    )

    await expect(fetchCatalog()).rejects.toThrow('The operation was aborted due to timeout')
  })

  it('请求超时常量为 15 秒', () => {
    expect(MODELSDEV_FETCH_TIMEOUT_MS).toBe(15_000)
  })
})

describe('syncPricing 经真实 SqliteStorage（:memory:）', () => {
  it('全量导入：source=sync、四档价格入库、计数自洽', async () => {
    const { storage, db } = makeStorage()
    try {
      stubFetch(FIXTURE)

      const result = await syncPricing(storage)

      expect(result).toEqual({ fetched: 7, imported: 3, skipped: 4 })
      const rows = await storage.getModelPricing()
      expect(rows).toHaveLength(3)
      const opus = rows.find((r) => r.model_id === 'claude-opus-4-1')
      expect(opus).toMatchObject({
        source: 'sync',
        provider: 'anthropic',
        input_per_million: 15,
        output_per_million: 75,
        cache_read_per_million: 1.5,
        cache_creation_per_million: 18.75,
        currency: 'USD',
        cost_multiplier: 1
      })
      expect(opus?.updated_at).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  it('预置 user 行不被 sync 覆盖（分级保护由存储层静默裁决，不产生 skipped）', async () => {
    const { storage, db } = makeStorage()
    try {
      await storage.updateModelPricing(userRow('claude-opus-4-1'), 'user')
      stubFetch(FIXTURE)

      const result = await syncPricing(storage)

      expect(result).toEqual({ fetched: 7, imported: 3, skipped: 4 })
      const rows = await storage.getModelPricing()
      expect(rows.find((r) => r.model_id === 'claude-opus-4-1')).toMatchObject({
        source: 'user',
        provider: 'manual-provider',
        input_per_million: 999,
        updated_at: 111
      })
      expect(rows.find((r) => r.model_id === 'claude-haiku')).toMatchObject({
        source: 'sync',
        input_per_million: 1,
        cache_read_per_million: 0
      })
    } finally {
      db.close()
    }
  })

  it('批量写入异常向上抛出且不落库', async () => {
    const { storage, db } = makeStorage()
    try {
      const flaky = withBatchWriteFailure(storage)
      stubFetch(FIXTURE)

      await expect(syncPricing(flaky)).rejects.toThrow('simulated batch write failure')
      expect(await flaky.getModelPricing()).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it('fetch 失败直接抛出且不落库', async () => {
    const { storage, db } = makeStorage()
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError('fetch failed')
        })
      )

      await expect(syncPricing(storage)).rejects.toThrow('fetch failed')
      expect(await storage.getModelPricing()).toHaveLength(0)
    } finally {
      db.close()
    }
  })
})
