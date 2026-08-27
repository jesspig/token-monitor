import { describe, it, expect } from 'vitest'
import { createDatabase, migrate, type SqliteDatabase } from './db'

function columnsOf(db: SqliteDatabase, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name)
}

/** v5 存量库的最小表结构：sync_cursors（无 byte_offset 列）+ usage_records（后续索引类迁移依赖） */
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

describe('schema 迁移', () => {
  it('全新库迁移至最新版（v9），含部分索引；重复迁移幂等', () => {
    const db = createDatabase(':memory:')
    try {
      migrate(db)
      migrate(db)
      expect(db.pragma('user_version', { simple: true })).toBe(10)
      expect(columnsOf(db, 'sync_cursors')).toContain('byte_offset')
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_usage_records_%'")
        .all() as { name: string }[]
      expect(indexes.map((r) => r.name)).toContain('idx_usage_records_zero_cost')
      expect(indexes.map((r) => r.name)).toContain('idx_usage_records_cached_input')
    } finally {
      db.close()
    }
  })

  it('v5 存量库升级：ALTER 增列后存量行 byte_offset 为 NULL（未知语义），并补齐 v7 部分索引', () => {
    const db = createDatabase(':memory:')
    try {
      db.exec(LEGACY_V5_SCHEMA)
      db.prepare(
        `INSERT INTO sync_cursors (file_path, data_source, line_offset, file_mtime, updated_at)
         VALUES ('/legacy/session.jsonl.zstd', 'dsh', 7, 42, 1)`
      ).run()
      db.pragma('user_version = 5')

      migrate(db)

      expect(db.pragma('user_version', { simple: true })).toBe(10)
      // v6 原语义为存量行 byte_offset 为 NULL，但 v9 存量回溯全量 DELETE FROM sync_cursors，
      // migrate() 到 9 后该行已被清除，故期望为 undefined；索引断言仍需保留
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
      // v10 新增：小时桶物化 + 筛选维度索引
      expect(indexNames).toContain('idx_usage_records_status')
      expect(indexNames).toContain('idx_usage_records_project')
      expect(indexNames).toContain('idx_usage_records_session_id')
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
})
