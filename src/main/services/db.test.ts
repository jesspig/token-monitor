import { describe, it, expect } from 'vitest'
import { createDatabase, migrate, type SqliteDatabase } from './db'

function columnsOf(db: SqliteDatabase, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name)
}

const LEGACY_V5_SCHEMA = `
  CREATE TABLE sync_cursors (
    file_path   TEXT    NOT NULL PRIMARY KEY,
    data_source TEXT    NOT NULL DEFAULT '',
    line_offset INTEGER NOT NULL DEFAULT 0,
    file_mtime  INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE usage_records (
    id                    TEXT    NOT NULL PRIMARY KEY,
    data_source           TEXT    NOT NULL,
    app_type              TEXT    NOT NULL,
    model                 TEXT    NOT NULL,
    raw_model             TEXT,
    input_tokens          INTEGER NOT NULL DEFAULT 0,
    output_tokens         INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    input_semantics       INTEGER NOT NULL DEFAULT 0,
    cost_usd              TEXT,
    currency              TEXT,
    latency_ms            INTEGER,
    project               TEXT,
    session_id            TEXT,
    status                TEXT    NOT NULL DEFAULT 'success',
    file_path             TEXT    NOT NULL,
    line                  INTEGER NOT NULL,
    created_at            INTEGER NOT NULL
  )
`

function makeLegacyV13Db(): SqliteDatabase {
  const db = createDatabase(':memory:')
  db.exec(LEGACY_V5_SCHEMA)
  db.pragma('user_version = 13')
  return db
}

describe('schema 迁移', () => {
  it('全新库迁移至最新版（v14），含部分索引；重复迁移幂等', () => {
    const db = createDatabase(':memory:')
    try {
      migrate(db)
      migrate(db)
      expect(db.pragma('user_version', { simple: true })).toBe(14)
      expect(columnsOf(db, 'sync_cursors')).toContain('byte_offset')
      expect(columnsOf(db, 'usage_records')).toContain('request_id')
      expect(columnsOf(db, 'usage_records')).toContain('is_replaceable_snapshot')
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_usage_records_%'")
        .all() as { name: string }[]
      expect(indexes.map((r) => r.name)).toContain('idx_usage_records_zero_cost')
      expect(indexes.map((r) => r.name)).toContain('idx_usage_records_cached_input')
      expect(indexes.map((r) => r.name)).toContain('idx_usage_records_model_created')
      expect(indexes.map((r) => r.name)).toContain('idx_usage_records_data_source_request_id')
      const cachedInputSql = (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_usage_records_cached_input'")
          .get() as { sql: string }
      ).sql
      expect(cachedInputSql).toContain(
        "app_type IN ('codex', 'gemini', 'grok', 'workbuddy', 'codebuddy', 'qwen', 'reasonix', 'goose', 'copilot-cli', 'trae-agent')"
      )
    } finally {
      db.close()
    }
  })

  it('v5 存量库升级：ALTER 增列后存量行 byte_offset 为 NULL（未知语义），并补齐 v7 部分索引（v13 按新十源条件重建）', () => {
    const db = createDatabase(':memory:')
    try {
      db.exec(LEGACY_V5_SCHEMA)
      db.prepare(
        `INSERT INTO sync_cursors (file_path, data_source, line_offset, file_mtime, updated_at)
         VALUES ('/legacy/session.jsonl.zstd', 'dsh', 7, 42, 1)`
      ).run()
      db.pragma('user_version = 5')

      migrate(db)

      expect(db.pragma('user_version', { simple: true })).toBe(14)
      const row = db.prepare('SELECT * FROM sync_cursors').get() as
        | {
            file_path: string
            line_offset: number
            byte_offset: number | null
          }
        | undefined
      expect(row).toBeUndefined()
      const indexNames = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_records'")
        .all()
        .map((r) => (r as { name: string }).name)
      expect(indexNames).toContain('idx_usage_records_zero_cost')
      expect(indexNames).toContain('idx_usage_records_cached_input')
      expect(indexNames).toContain('idx_usage_records_status')
      expect(indexNames).toContain('idx_usage_records_project')
      expect(indexNames).toContain('idx_usage_records_session_id')
      expect(indexNames).toContain('idx_usage_records_model_created')
      expect(indexNames).toContain('idx_usage_records_data_source_request_id')
      const cachedInputSql = (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_usage_records_cached_input'")
          .get() as { sql: string }
      ).sql
      expect(cachedInputSql).toContain(
        "app_type IN ('codex', 'gemini', 'grok', 'workbuddy', 'codebuddy', 'qwen', 'reasonix', 'goose', 'copilot-cli', 'trae-agent')"
      )
      const hourlyIndexes = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_hourly_rollups'")
          .all() as { name: string }[]
      ).map((r) => r.name)
      expect(hourlyIndexes).toContain('idx_usage_hourly_rollups_date')
    } finally {
      db.close()
    }
  })

  it('v13 存量库升级至 v14：旧行保持 request_id 为 NULL 且不可替换', () => {
    const db = makeLegacyV13Db()
    try {
      db.prepare(
        `INSERT INTO usage_records (
           id, data_source, app_type, model, file_path, line, created_at
         ) VALUES ('legacy-1', 'claude', 'claude', 'claude-sonnet-4', '/legacy.jsonl', 1, 1)`
      ).run()

      migrate(db)

      expect(db.pragma('user_version', { simple: true })).toBe(14)
      const columns = db.pragma('table_info(usage_records)') as {
        name: string
        notnull: number
        dflt_value: string | null
      }[]
      expect(columns.find((column) => column.name === 'request_id')).toMatchObject({
        notnull: 0,
        dflt_value: null
      })
      expect(columns.find((column) => column.name === 'is_replaceable_snapshot')).toMatchObject({
        notnull: 1,
        dflt_value: '0'
      })
      expect(
        db.prepare('SELECT request_id, is_replaceable_snapshot FROM usage_records').get()
      ).toEqual({ request_id: null, is_replaceable_snapshot: 0 })
    } finally {
      db.close()
    }
  })

  it('v14 创建 data_source + request_id 唯一部分索引，仅约束非 NULL request_id', () => {
    const db = makeLegacyV13Db()
    try {
      migrate(db)

      const index = (
        db.pragma('index_list(usage_records)') as {
          name: string
          unique: number
          partial: number
        }[]
      ).find((entry) => entry.name === 'idx_usage_records_data_source_request_id')
      expect(index).toMatchObject({ unique: 1, partial: 1 })
      expect(
        (db.pragma('index_info(idx_usage_records_data_source_request_id)') as { name: string }[]).map(
          (column) => column.name
        )
      ).toEqual(['data_source', 'request_id'])
      const indexSql = (
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_usage_records_data_source_request_id'"
          )
          .get() as { sql: string }
      ).sql
      expect(indexSql).toContain('WHERE request_id IS NOT NULL')

      const insert = db.prepare(
        `INSERT INTO usage_records (
           id, data_source, app_type, model, file_path, line, created_at, request_id
         ) VALUES (?, ?, 'claude', 'claude-sonnet-4', ?, ?, 1, ?)`
      )
      insert.run('null-1', 'claude', '/null-1.jsonl', 1, null)
      insert.run('null-2', 'claude', '/null-2.jsonl', 2, null)
      insert.run('request-1', 'claude', '/request-1.jsonl', 3, 'req-1')
      expect(() =>
        insert.run('request-2', 'claude', '/request-2.jsonl', 4, 'req-1')
      ).toThrow()
      expect(() =>
        insert.run('request-3', 'codex', '/request-3.jsonl', 5, 'req-1')
      ).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('v14 回拨至 v13 后重放迁移幂等，不重复增列或改写存量行', () => {
    const db = makeLegacyV13Db()
    try {
      db.prepare(
        `INSERT INTO usage_records (
           id, data_source, app_type, model, file_path, line, created_at
         ) VALUES ('legacy-1', 'claude', 'claude', 'claude-sonnet-4', '/legacy.jsonl', 1, 1)`
      ).run()
      migrate(db)
      db.prepare(
        `UPDATE usage_records
         SET request_id = 'req-1', is_replaceable_snapshot = 1
         WHERE id = 'legacy-1'`
      ).run()
      const before = db.prepare('SELECT * FROM usage_records').get()

      db.pragma('user_version = 13')
      migrate(db)

      expect(db.pragma('user_version', { simple: true })).toBe(14)
      expect(columnsOf(db, 'usage_records').filter((name) => name === 'request_id')).toHaveLength(1)
      expect(
        columnsOf(db, 'usage_records').filter((name) => name === 'is_replaceable_snapshot')
      ).toHaveLength(1)
      expect(db.prepare('SELECT * FROM usage_records').get()).toEqual(before)
      expect(
        (
          db.pragma('index_list(usage_records)') as {
            name: string
          }[]
        ).filter((entry) => entry.name === 'idx_usage_records_data_source_request_id')
      ).toHaveLength(1)
    } finally {
      db.close()
    }
  })
})
