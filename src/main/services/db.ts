import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

/** 文件模式下数据库文件名（落在传入目录内） */
export const DB_FILENAME = 'token-monitor.db'

/** better-sqlite3 实例类型（类型再导出，供调用方标注） */
export type SqliteDatabase = Database.Database

/**
 * 建库工厂：支持 `:memory:`（内存库）与目录路径两种模式。
 * 目录模式在指定目录下创建 `token-monitor.db`（目录不存在时自动创建）。
 */
export function createDatabase(location: ':memory:' | string): SqliteDatabase {
  if (location === ':memory:') {
    return new Database(':memory:')
  }
  mkdirSync(location, { recursive: true })
  return new Database(join(location, DB_FILENAME))
}

/** 单条迁移：version 单调递增，up 由调用方以事务包裹执行 */
interface Migration {
  version: number
  up: (db: SqliteDatabase) => void
}

/**
 * 迁移表：v1 = 首次建表（5 张核心表 + 索引）。
 * 字段/主键/索引与 shared/tables.ts 及 docs/concepts/data-model.md 一致。
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        -- 用量明细：主键/去重 key = data_source + file_path + line
        CREATE TABLE IF NOT EXISTS usage_records (
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
        );
        CREATE INDEX IF NOT EXISTS idx_usage_records_created_at ON usage_records (created_at);
        CREATE INDEX IF NOT EXISTS idx_usage_records_app_created ON usage_records (app_type, created_at);

        -- 日聚合（趋势主数据源）：主键 (date, app_type, model)
        CREATE TABLE IF NOT EXISTS usage_daily_rollups (
          date                  TEXT    NOT NULL,
          app_type              TEXT    NOT NULL,
          model                 TEXT    NOT NULL,
          request_count         INTEGER NOT NULL DEFAULT 0,
          success_count         INTEGER NOT NULL DEFAULT 0,
          error_count           INTEGER NOT NULL DEFAULT 0,
          input_tokens          INTEGER NOT NULL DEFAULT 0,
          output_tokens         INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
          cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd              TEXT    NOT NULL DEFAULT '0',
          latency_ms_total      INTEGER NOT NULL DEFAULT 0,
          updated_at            INTEGER NOT NULL,
          PRIMARY KEY (date, app_type, model)
        );

        -- 模型定价：主键 model_id
        CREATE TABLE IF NOT EXISTS model_pricing (
          model_id                   TEXT   NOT NULL PRIMARY KEY,
          provider                   TEXT,
          input_per_million          REAL   NOT NULL DEFAULT 0,
          output_per_million         REAL   NOT NULL DEFAULT 0,
          cache_read_per_million     REAL   NOT NULL DEFAULT 0,
          cache_creation_per_million REAL   NOT NULL DEFAULT 0,
          currency                   TEXT   NOT NULL DEFAULT 'USD',
          cost_multiplier            REAL   NOT NULL DEFAULT 1,
          updated_at                 INTEGER NOT NULL
        );

        -- 增量同步游标：主键 file_path
        CREATE TABLE IF NOT EXISTS sync_cursors (
          file_path   TEXT    NOT NULL PRIMARY KEY,
          data_source TEXT    NOT NULL DEFAULT '',
          line_offset INTEGER NOT NULL DEFAULT 0,
          file_mtime  INTEGER NOT NULL DEFAULT 0,
          updated_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sync_cursors_data_source ON sync_cursors (data_source);

        -- 去重账本（fork/rewrite）：主键 (data_source, request_id)
        CREATE TABLE IF NOT EXISTS dedup_ledger (
          data_source TEXT    NOT NULL,
          request_id  TEXT    NOT NULL,
          semantic_id TEXT    NOT NULL,
          created_at  INTEGER NOT NULL,
          PRIMARY KEY (data_source, request_id)
        );
        CREATE INDEX IF NOT EXISTS idx_dedup_ledger_semantic_id ON dedup_ledger (semantic_id);
      `)
    }
  }
]

/**
 * 幂等迁移：以 PRAGMA user_version 记录已应用版本，逐版本升级。
 * 首次执行建表并置 user_version = 1；再次打开时跳过。
 */
export function migrate(db: SqliteDatabase): void {
  const current = db.pragma('user_version', { simple: true }) as number
  for (const m of MIGRATIONS) {
    if (m.version > current) {
      db.transaction(() => {
        m.up(db)
        db.pragma(`user_version = ${m.version}`)
      })()
    }
  }
}
