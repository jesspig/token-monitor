import { describe, it, expect } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import type { UsageRecord } from '../../../shared/dto'
import type {
  ModelPricingRow,
  SyncCursorRow,
  UsageDailyRollupRow
} from '../../../shared/tables'
import type { StorageService } from '../../../shared/context'
import { createDatabase, migrate, type SqliteDatabase } from './db'
import { SqliteStorage, openStorage } from './storage'
import { semanticFingerprint } from './dedup'

/** 构造一条可复用的测试用量记录 */
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
    createdAt: new Date('2026-08-19T10:00:00+08:00').getTime(),
    source: { filePath: '/tmp/sessions/claude-2026-08-19.jsonl', line: 1 },
    ...overrides
  }
}

/** 内存库 + 迁移 + 存储实例，返回可直查的 db 句柄 */
function makeStorage(): { storage: StorageService; db: SqliteDatabase } {
  const db = createDatabase(':memory:')
  migrate(db)
  return { storage: new SqliteStorage(db), db }
}

describe('数据库迁移', () => {
  it('首次建库升至最新版，重复迁移幂等，五张表齐全', () => {
    const dir = mkdtempSync(join(tmpdir(), 'token-monitor-'))
    const db = createDatabase(dir)
    try {
      migrate(db)
      migrate(db) // 第二次执行应无副作用
      expect(db.pragma('user_version', { simple: true })).toBe(4)
      const tables = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[]
      )
        .map((t) => t.name)
        .sort()
      expect(tables).toEqual([
        'dedup_ledger',
        'model_pricing',
        'sync_cursors',
        'usage_daily_rollups',
        'usage_records'
      ])
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('openStorage 对同一目录重复打开不报错（迁移幂等）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'token-monitor-'))
    try {
      const s1 = openStorage(dir) as SqliteStorage
      const s2 = openStorage(dir) as SqliteStorage
      expect(s1).toBeDefined()
      expect(s2).toBeDefined()
      s1.close()
      s2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('内存模式可直接使用', async () => {
    const storage = openStorage(':memory:')
    expect(await storage.getModelPricing()).toEqual([])
  })
})

describe('v3 迁移：清理零 token 明细并重建日聚合', () => {
  const DAY_19 = new Date(2026, 7, 19).getTime()
  const DAY_20 = new Date(2026, 7, 20).getTime()
  const dateKeyOf = (ms: number): string => {
    const d = new Date(ms)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  const DAY_19_KEY = dateKeyOf(DAY_19)
  const DAY_20_KEY = dateKeyOf(DAY_20)
  const ZERO_COND =
    'input_tokens = 0 AND output_tokens = 0 AND cache_read_tokens = 0 AND cache_creation_tokens = 0'

  interface LegacySeed {
    id: string
    app_type: string
    model: string
    input_tokens?: number
    output_tokens?: number
    cache_read_tokens?: number
    cache_creation_tokens?: number
    status?: string
    cost_usd?: string | null
    latency_ms?: number | null
    created_at: number
  }

  function insertLegacyRecord(db: SqliteDatabase, seed: LegacySeed): void {
    db.prepare(
      `INSERT INTO usage_records (
        id, data_source, app_type, model, raw_model,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        input_semantics, cost_usd, currency, latency_ms, project, session_id,
        status, file_path, line, created_at
      ) VALUES (
        @id, @data_source, @app_type, @model, NULL,
        @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
        0, @cost_usd, NULL, @latency_ms, NULL, NULL,
        @status, '/legacy/sessions.jsonl', @line, @created_at
      )`
    ).run({
      data_source: seed.app_type,
      input_tokens: seed.input_tokens ?? 0,
      output_tokens: seed.output_tokens ?? 0,
      cache_read_tokens: seed.cache_read_tokens ?? 0,
      cache_creation_tokens: seed.cache_creation_tokens ?? 0,
      cost_usd: seed.cost_usd ?? null,
      latency_ms: seed.latency_ms ?? null,
      status: seed.status ?? 'success',
      line: Number(seed.id.split(':').pop()),
      ...seed
    })
  }

  function insertLegacyRollup(
    db: SqliteDatabase,
    row: {
      date: string
      app_type: string
      model: string
      request_count?: number
      success_count?: number
      error_count?: number
      input_tokens?: number
      output_tokens?: number
      cache_read_tokens?: number
      cache_creation_tokens?: number
      cost_usd?: string
      latency_ms_total?: number
    }
  ): void {
    db.prepare(
      `INSERT INTO usage_daily_rollups (
        date, app_type, model, request_count, success_count, error_count,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        cost_usd, latency_ms_total, updated_at
      ) VALUES (
        @date, @app_type, @model, @request_count, @success_count, @error_count,
        @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
        @cost_usd, @latency_ms_total, 111
      )`
    ).run({
      request_count: 1,
      success_count: 1,
      error_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost_usd: '0',
      latency_ms_total: 0,
      ...row
    })
  }

  /** 已应用 v2 的库（回拨 user_version），插入存量数据后 migrate 即触发 v3 */
  function makeDirtyV2Db(): SqliteDatabase {
    const db = createDatabase(':memory:')
    migrate(db)
    db.pragma('user_version = 2')
    return db
  }

  function seedDirtyData(db: SqliteDatabase): void {
    insertLegacyRecord(db, {
      id: 'claude:/legacy/sessions.jsonl:1',
      app_type: 'claude',
      model: 'claude-sonnet-4',
      cost_usd: '0.001',
      latency_ms: 500,
      created_at: DAY_19 + 3_600_000
    })
    insertLegacyRecord(db, {
      id: 'claude:/legacy/sessions.jsonl:2',
      app_type: 'claude',
      model: 'claude-sonnet-4',
      status: 'error',
      created_at: DAY_19 + 7_200_000
    })
    insertLegacyRecord(db, {
      id: 'claude:/legacy/sessions.jsonl:3',
      app_type: 'claude',
      model: 'claude-sonnet-4',
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 20,
      cache_creation_tokens: 10,
      cost_usd: '0.002',
      latency_ms: 800,
      created_at: DAY_19 + 10_800_000
    })
    insertLegacyRecord(db, {
      id: 'codex:/legacy/sessions.jsonl:1',
      app_type: 'codex',
      model: 'gpt-5',
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 5,
      cache_creation_tokens: 2,
      cost_usd: '0.01',
      latency_ms: 100,
      created_at: DAY_19 + 14_400_000
    })
    insertLegacyRecord(db, {
      id: 'claude:/legacy/sessions.jsonl:4',
      app_type: 'claude',
      model: 'claude-sonnet-4',
      input_tokens: 7,
      output_tokens: 8,
      cache_read_tokens: 9,
      cache_creation_tokens: 1,
      status: 'error',
      cost_usd: '0.004',
      latency_ms: 200,
      created_at: DAY_20 + 3_600_000
    })
    // 污染的日聚合：request_count 含脏行、gemini 为纯脏桶
    insertLegacyRollup(db, {
      date: DAY_19_KEY,
      app_type: 'claude',
      model: 'claude-sonnet-4',
      request_count: 3,
      success_count: 1,
      error_count: 2,
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 20,
      cache_creation_tokens: 10,
      cost_usd: '0.003',
      latency_ms_total: 1300
    })
    insertLegacyRollup(db, {
      date: DAY_19_KEY,
      app_type: 'codex',
      model: 'gpt-5',
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 5,
      cache_creation_tokens: 2,
      cost_usd: '0.01',
      latency_ms_total: 100
    })
    insertLegacyRollup(db, {
      date: DAY_19_KEY,
      app_type: 'gemini',
      model: 'gemini-pro',
      request_count: 2,
      success_count: 2
    })
    insertLegacyRollup(db, {
      date: DAY_20_KEY,
      app_type: 'claude',
      model: 'claude-sonnet-4',
      success_count: 0,
      error_count: 1,
      input_tokens: 7,
      output_tokens: 8,
      cache_read_tokens: 9,
      cache_creation_tokens: 1,
      cost_usd: '0.004',
      latency_ms_total: 200
    })
    db.prepare(
      `INSERT INTO sync_cursors (file_path, data_source, line_offset, file_mtime, updated_at)
       VALUES ('/legacy/sessions.jsonl', 'claude', 5, 1000, 111)`
    ).run()
  }

  it('迁移后不存在四项全 0 明细，正常明细与游标不受影响', () => {
    const db = makeDirtyV2Db()
    seedDirtyData(db)

    expect(db.pragma('user_version', { simple: true })).toBe(2)
    migrate(db)
    expect(db.pragma('user_version', { simple: true })).toBe(4)

    const zeroCount = db.prepare(`SELECT COUNT(*) AS c FROM usage_records WHERE ${ZERO_COND}`).get() as { c: number }
    expect(zeroCount.c).toBe(0)
    const remaining = db.prepare('SELECT id FROM usage_records ORDER BY id').all() as { id: string }[]
    expect(remaining.map((r) => r.id)).toEqual([
      'claude:/legacy/sessions.jsonl:3',
      'claude:/legacy/sessions.jsonl:4',
      'codex:/legacy/sessions.jsonl:1'
    ])
    const cursor = db.prepare('SELECT * FROM sync_cursors WHERE file_path = ?').get('/legacy/sessions.jsonl') as
      | SyncCursorRow
      | undefined
    expect(cursor).toMatchObject({ data_source: 'claude', line_offset: 5 })
  })

  it('受影响日期的日聚合重建为剩余明细的真实聚合，纯脏桶移除，其他日期不动', () => {
    const db = makeDirtyV2Db()
    seedDirtyData(db)
    migrate(db)

    const claudeD19 = db
      .prepare("SELECT * FROM usage_daily_rollups WHERE date = ? AND app_type = 'claude' AND model = 'claude-sonnet-4'")
      .get(DAY_19_KEY) as UsageDailyRollupRow | undefined
    expect(claudeD19).toBeDefined()
    expect(claudeD19!.request_count).toBe(1)
    expect(claudeD19!.success_count).toBe(1)
    expect(claudeD19!.error_count).toBe(0)
    expect(claudeD19!.input_tokens).toBe(100)
    expect(claudeD19!.output_tokens).toBe(50)
    expect(claudeD19!.cache_read_tokens).toBe(20)
    expect(claudeD19!.cache_creation_tokens).toBe(10)
    expect(claudeD19!.cost_usd).toBe('0.002')
    expect(claudeD19!.latency_ms_total).toBe(800)

    const codexD19 = db
      .prepare("SELECT * FROM usage_daily_rollups WHERE date = ? AND app_type = 'codex'")
      .get(DAY_19_KEY) as UsageDailyRollupRow | undefined
    expect(codexD19).toMatchObject({
      request_count: 1,
      success_count: 1,
      input_tokens: 10,
      output_tokens: 20,
      cost_usd: '0.01',
      latency_ms_total: 100
    })

    const geminiD19 = db
      .prepare("SELECT * FROM usage_daily_rollups WHERE date = ? AND app_type = 'gemini'")
      .get(DAY_19_KEY)
    expect(geminiD19).toBeUndefined()

    const day20 = db
      .prepare("SELECT * FROM usage_daily_rollups WHERE date = ?")
      .all(DAY_20_KEY) as UsageDailyRollupRow[]
    expect(day20).toHaveLength(1)
    expect(day20[0].app_type).toBe('claude')
    expect(day20[0].request_count).toBe(1)
    expect(day20[0].error_count).toBe(1)
    expect(day20[0].input_tokens).toBe(7)
    expect(day20[0].updated_at).toBe(111)
  })

  it('幂等：回拨版本重跑 v3 后数据不变', () => {
    const db = makeDirtyV2Db()
    seedDirtyData(db)
    migrate(db)
    const snapshot = () => ({
      records: db.prepare('SELECT * FROM usage_records ORDER BY id').all(),
      rollups: db.prepare('SELECT * FROM usage_daily_rollups ORDER BY date, app_type, model').all()
    })
    const before = snapshot()

    db.pragma('user_version = 2')
    migrate(db)
    expect(db.pragma('user_version', { simple: true })).toBe(4)
    expect(snapshot()).toEqual(before)
  })
})

describe('v4 迁移：修正 opencode 存量语义标注', () => {
  const CREATED_AT = new Date('2026-08-19T10:00:00Z').getTime()

  function insertLegacyRecord(
    db: SqliteDatabase,
    seed: {
      id: string
      app_type: string
      model: string
      input_semantics: number
      cost_usd?: string | null
      created_at?: number
    }
  ): void {
    db.prepare(
      `INSERT INTO usage_records (
        id, data_source, app_type, model, raw_model,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        input_semantics, cost_usd, currency, latency_ms, project, session_id,
        status, file_path, line, created_at
      ) VALUES (
        @id, @data_source, @app_type, @model, NULL,
        100, 50, 20, 10,
        @input_semantics, @cost_usd, NULL, NULL, NULL, NULL,
        'success', '/legacy/sessions.jsonl', @line, @created_at
      )`
    ).run({
      id: seed.id,
      data_source: seed.app_type,
      app_type: seed.app_type,
      model: seed.model,
      input_semantics: seed.input_semantics,
      cost_usd: seed.cost_usd ?? null,
      created_at: seed.created_at ?? CREATED_AT,
      line: Number(seed.id.split(':').pop())
    })
  }

  /** 已应用 v3 的库（回拨 user_version），插入存量数据后 migrate 即触发 v4 */
  function makeDirtyV3Db(): SqliteDatabase {
    const db = createDatabase(':memory:')
    migrate(db)
    db.pragma('user_version = 3')
    return db
  }

  it('v3 库升级到 v4：opencode 行 semantics 1→2，claude/codex 行不受影响', () => {
    const db = makeDirtyV3Db()
    try {
      insertLegacyRecord(db, {
        id: 'opencode:/a.jsonl:1',
        app_type: 'opencode',
        model: 'qwen3-coder-plus',
        input_semantics: 1
      })
      // 已是 2 的 opencode 行与未知口径 0 行均不在修正范围
      insertLegacyRecord(db, {
        id: 'opencode:/a.jsonl:2',
        app_type: 'opencode',
        model: 'kimi-k2',
        input_semantics: 2
      })
      insertLegacyRecord(db, {
        id: 'claude:/b.jsonl:1',
        app_type: 'claude',
        model: 'claude-sonnet-4',
        input_semantics: 1
      })
      insertLegacyRecord(db, {
        id: 'codex:/c.jsonl:1',
        app_type: 'codex',
        model: 'gpt-5',
        input_semantics: 1
      })

      migrate(db)

      expect(db.pragma('user_version', { simple: true })).toBe(4)
      const rows = db
        .prepare('SELECT id, input_semantics FROM usage_records ORDER BY id')
        .all() as { id: string; input_semantics: number }[]
      expect(rows).toEqual([
        { id: 'claude:/b.jsonl:1', input_semantics: 1 },
        { id: 'codex:/c.jsonl:1', input_semantics: 1 },
        { id: 'opencode:/a.jsonl:1', input_semantics: 2 },
        { id: 'opencode:/a.jsonl:2', input_semantics: 2 }
      ])
    } finally {
      db.close()
    }
  })

  it('全新库直接建至 v4，重复迁移幂等', () => {
    const db = createDatabase(':memory:')
    try {
      migrate(db)
      migrate(db) // 第二次执行应无副作用
      expect(db.pragma('user_version', { simple: true })).toBe(4)
    } finally {
      db.close()
    }
  })

  it('幂等：回拨版本重跑 v4，已修正数据不变', () => {
    const db = makeDirtyV3Db()
    try {
      insertLegacyRecord(db, {
        id: 'opencode:/a.jsonl:1',
        app_type: 'opencode',
        model: 'qwen3-coder-plus',
        input_semantics: 1,
        cost_usd: '0.01'
      })
      migrate(db)
      const snapshot = () => db.prepare('SELECT * FROM usage_records ORDER BY id').all()
      const before = snapshot()

      db.pragma('user_version = 3')
      migrate(db)
      expect(db.pragma('user_version', { simple: true })).toBe(4)
      expect(snapshot()).toEqual(before)
    } finally {
      db.close()
    }
  })
})

describe('recordUsage 去重', () => {
  it('重复行只入一次，返回实际新增条数', async () => {
    const { storage, db } = makeStorage()
    expect(await storage.recordUsage([makeRecord()])).toBe(1)
    // 同 file+line 再写一次 → 0
    expect(await storage.recordUsage([makeRecord()])).toBe(0)
    // 同一批内重复也只入一次
    expect(
      await storage.recordUsage([
        makeRecord({ source: { filePath: '/a.jsonl', line: 2 } }),
        makeRecord({ source: { filePath: '/a.jsonl', line: 2 } })
      ])
    ).toBe(1)
    const count = (db.prepare('SELECT COUNT(*) AS c FROM usage_records').get() as { c: number }).c
    expect(count).toBe(2)
  })

  it('id 由 data_source + file_path + line 组成，跨 app 不冲突', async () => {
    const { storage, db } = makeStorage()
    await storage.recordUsage([
      makeRecord({ source: { filePath: '/x.jsonl', line: 1 } }),
      makeRecord({ appType: 'codex', model: 'gpt-5', source: { filePath: '/x.jsonl', line: 1 } })
    ])
    const rows = db.prepare('SELECT id, data_source FROM usage_records ORDER BY data_source').all() as {
      id: string
      data_source: string
    }[]
    expect(rows).toEqual([
      { id: 'claude:/x.jsonl:1', data_source: 'claude' },
      { id: 'codex:/x.jsonl:1', data_source: 'codex' }
    ])
  })

  it('同 requestId 不同 (file_path, line)：第二次被语义去重拒绝，明细与 rollup 只计一次', async () => {
    const { storage, db } = makeStorage()
    const first = makeRecord({ source: { filePath: '/main/a.jsonl', line: 1, requestId: 'msg_001' } })
    // fork 场景：同一逻辑请求出现在 subagents 文件的不同行
    const forked = makeRecord({ source: { filePath: '/main/subagents/b.jsonl', line: 42, requestId: 'msg_001' } })

    expect(await storage.recordUsage([first])).toBe(1)
    expect(await storage.recordUsage([forked])).toBe(0)

    const recordCount = (db.prepare('SELECT COUNT(*) AS c FROM usage_records').get() as { c: number }).c
    expect(recordCount).toBe(1)
    const rollup = db.prepare('SELECT * FROM usage_daily_rollups').get() as UsageDailyRollupRow
    expect(rollup.request_count).toBe(1)
    expect(rollup.input_tokens).toBe(first.inputTokens)
    expect(rollup.cost_usd).toBe('0.001')
  })

  it('同批次内两条同 requestId 记录：仅首条入库', async () => {
    const { storage, db } = makeStorage()
    const added = await storage.recordUsage([
      makeRecord({ source: { filePath: '/a.jsonl', line: 1, requestId: 'msg_002' } }),
      makeRecord({ source: { filePath: '/a.jsonl', line: 2, requestId: 'msg_002' } })
    ])
    expect(added).toBe(1)
    const recordCount = (db.prepare('SELECT COUNT(*) AS c FROM usage_records').get() as { c: number }).c
    expect(recordCount).toBe(1)
    const ledgerCount = (db.prepare('SELECT COUNT(*) AS c FROM dedup_ledger').get() as { c: number }).c
    expect(ledgerCount).toBe(1)
  })

  it('无 requestId 记录走旧主键去重，ledger 无行', async () => {
    const { storage, db } = makeStorage()
    expect(await storage.recordUsage([makeRecord()])).toBe(1)
    expect(await storage.recordUsage([makeRecord({ source: { filePath: '/other.jsonl', line: 9 } })])).toBe(1)
    expect(await storage.recordUsage([makeRecord({ source: { filePath: '/other.jsonl', line: 9 } })])).toBe(0)
    const ledgerCount = (db.prepare('SELECT COUNT(*) AS c FROM dedup_ledger').get() as { c: number }).c
    expect(ledgerCount).toBe(0)
  })

  it('ledger 按 request_id 判定而非指纹：重复 requestId 即使 token 字段不同仍被拒', async () => {
    const { storage, db } = makeStorage()
    const first = makeRecord({ source: { filePath: '/a.jsonl', line: 1, requestId: 'msg_003' }, inputTokens: 100 })
    // 同 requestId 但 token/费用字段不同（如 rewrite 后数值变化）→ 指纹不同仍须按 request_id 拒绝
    const rewritten = makeRecord({
      source: { filePath: '/b.jsonl', line: 7, requestId: 'msg_003' },
      inputTokens: 999,
      outputTokens: 888,
      costUsd: '9.99'
    })
    expect(await storage.recordUsage([first])).toBe(1)
    expect(await storage.recordUsage([rewritten])).toBe(0)

    const row = db
      .prepare('SELECT data_source, request_id, semantic_id FROM dedup_ledger')
      .get() as { data_source: string; request_id: string; semantic_id: string }
    expect(row.data_source).toBe('claude')
    expect(row.request_id).toBe('msg_003')
    expect(row.semantic_id).toBe(semanticFingerprint(first))
  })
})

describe('usage_daily_rollups 日聚合', () => {
  it('按 (date, app_type, model) 累计计数/token/费用/耗时', async () => {
    const { storage, db } = makeStorage()
    const base = {
      appType: 'codex' as const,
      model: 'gpt-5',
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheCreationTokens: 2,
      costUsd: '0.010000',
      latencyMs: 100,
      status: 'success' as const,
      createdAt: new Date('2026-08-19T10:00:00+08:00').getTime()
    }
    await storage.recordUsage([
      makeRecord({ ...base, source: { filePath: '/codex/a.jsonl', line: 1 } }),
      makeRecord({ ...base, source: { filePath: '/codex/a.jsonl', line: 2 } }),
      makeRecord({ ...base, status: 'error', source: { filePath: '/codex/a.jsonl', line: 3 } }),
      // 不同 app_type 独立成桶
      makeRecord({
        ...base,
        appType: 'claude',
        model: 'claude-sonnet-4',
        source: { filePath: '/claude/b.jsonl', line: 1 }
      })
    ])

    const codex = db
      .prepare("SELECT * FROM usage_daily_rollups WHERE app_type = 'codex'")
      .get() as UsageDailyRollupRow
    expect(codex.date).toBe('2026-08-19')
    expect(codex.request_count).toBe(3)
    expect(codex.success_count).toBe(2)
    expect(codex.error_count).toBe(1)
    expect(codex.input_tokens).toBe(30)
    expect(codex.output_tokens).toBe(60)
    expect(codex.cache_read_tokens).toBe(15)
    expect(codex.cache_creation_tokens).toBe(6)
    expect(codex.cost_usd).toBe('0.03')
    expect(codex.latency_ms_total).toBe(300)

    const claude = db
      .prepare("SELECT * FROM usage_daily_rollups WHERE app_type = 'claude'")
      .get() as UsageDailyRollupRow
    expect(claude.request_count).toBe(1)
    expect(claude.model).toBe('claude-sonnet-4')
  })

  it('跨批次累计，重复行不重复累计', async () => {
    const { storage, db } = makeStorage()
    const r1 = makeRecord({ source: { filePath: '/a.jsonl', line: 1 } })
    const r2 = makeRecord({ source: { filePath: '/a.jsonl', line: 2 } })
    await storage.recordUsage([r1])
    await storage.recordUsage([r1, r2]) // r1 为重复 → 只累计 r2
    const row = db.prepare('SELECT * FROM usage_daily_rollups').get() as UsageDailyRollupRow
    expect(row.request_count).toBe(2)
    expect(row.success_count).toBe(2)
    expect(row.error_count).toBe(0)
    expect(row.input_tokens).toBe(200)
    expect(row.output_tokens).toBe(100)
    expect(row.cost_usd).toBe('0.002')
    expect(row.latency_ms_total).toBe(1600)
  })
})

describe('sync_cursors 游标', () => {
  it('未同步过返回 null，读写正常', async () => {
    const { storage } = makeStorage()
    expect(await storage.getCursor('/a.jsonl')).toBeNull()
    await storage.setCursor('/a.jsonl', 10, 1000)
    expect(await storage.getCursor('/a.jsonl')).toBe(10)
  })

  it('mtime 未变则正常推进，mtime 变化重置到 0', async () => {
    const { storage } = makeStorage()
    await storage.setCursor('/a.jsonl', 10, 1000)
    await storage.setCursor('/a.jsonl', 20, 1000)
    expect(await storage.getCursor('/a.jsonl')).toBe(20)
    // 文件被 truncate/替换：mtime 变化 → 游标重置 0，下轮全量重读
    await storage.setCursor('/a.jsonl', 30, 2000)
    expect(await storage.getCursor('/a.jsonl')).toBe(0)
  })

  it('未传 mtime 时沿用既有 mtime，不触发重置；不同文件互不影响', async () => {
    const { storage } = makeStorage()
    await storage.setCursor('/a.jsonl', 10, 1000)
    await storage.setCursor('/a.jsonl', 15)
    expect(await storage.getCursor('/a.jsonl')).toBe(15)
    await storage.setCursor('/b.jsonl', 3, 500)
    expect(await storage.getCursor('/b.jsonl')).toBe(3)
    expect(await storage.getCursor('/a.jsonl')).toBe(15)
  })
})

describe('model_pricing CRUD', () => {
  const entry = (overrides: Partial<ModelPricingRow> = {}): ModelPricingRow => ({
    model_id: 'claude-sonnet-4',
    provider: 'anthropic',
    input_per_million: 3,
    output_per_million: 15,
    cache_read_per_million: 0.3,
    cache_creation_per_million: 3.75,
    currency: 'USD',
    cost_multiplier: 1,
    updated_at: 111,
    ...overrides
  })

  it('upsert 新增与覆盖更新', async () => {
    const { storage } = makeStorage()
    expect(await storage.getModelPricing()).toEqual([])
    await storage.updateModelPricing(entry())
    let list = await storage.getModelPricing()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      model_id: 'claude-sonnet-4',
      provider: 'anthropic',
      input_per_million: 3,
      output_per_million: 15,
      cost_multiplier: 1
    })
    // 覆盖更新（upsert 不新增行）
    await storage.updateModelPricing(entry({ input_per_million: 3.5, output_per_million: 16, updated_at: 222 }))
    list = await storage.getModelPricing()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ input_per_million: 3.5, output_per_million: 16, updated_at: 222 })
  })

  it('删除后查询为空，删除不存在 id 不报错', async () => {
    const { storage } = makeStorage()
    await storage.updateModelPricing(entry())
    await storage.deleteModelPricing('claude-sonnet-4')
    expect(await storage.getModelPricing()).toEqual([])
    await storage.deleteModelPricing('not-exist') // 幂等
  })

  it('批量插入 N 条返回 N 且全表可查', async () => {
    const { storage } = makeStorage()
    const rows: ModelPricingRow[] = [
      entry({ model_id: 'model-a', updated_at: 111 }),
      entry({ model_id: 'model-b', updated_at: 222 }),
      entry({ model_id: 'model-c', updated_at: 333 })
    ]
    expect(await storage.updateModelPricingBatch(rows, 'sync')).toBe(3)
    const list = await storage.getModelPricing()
    expect(list).toHaveLength(3)
    expect(list.map((r) => r.model_id).sort()).toEqual(['model-a', 'model-b', 'model-c'])
    expect(list.every((r) => r.source === 'sync')).toBe(true)
  })

  it('批量写入时 user 分级行不被 sync 行覆盖，其余行照常写入', async () => {
    const { storage } = makeStorage()
    // 预置 user 行（手动编辑缺省即 user）
    await storage.updateModelPricing(entry({ input_per_million: 99, updated_at: 123 }), 'user')

    const imported = await storage.updateModelPricingBatch(
      [
        entry({ model_id: 'claude-sonnet-4', input_per_million: 5, updated_at: 456 }),
        entry({ model_id: 'other-model', updated_at: 456 })
      ],
      'sync'
    )
    expect(imported).toBe(2)

    const list = await storage.getModelPricing()
    expect(list).toHaveLength(2)
    expect(list.find((r) => r.model_id === 'claude-sonnet-4')).toMatchObject({
      source: 'user',
      input_per_million: 99,
      updated_at: 123
    })
    expect(list.find((r) => r.model_id === 'other-model')).toMatchObject({
      source: 'sync',
      updated_at: 456
    })
  })

  it('批量空数组返回 0 且不产生任何行', async () => {
    const { storage } = makeStorage()
    expect(await storage.updateModelPricingBatch([], 'seed')).toBe(0)
    expect(await storage.getModelPricing()).toEqual([])
  })
})
