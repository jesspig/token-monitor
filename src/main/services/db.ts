import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

export const DB_FILENAME = 'token-monitor.db'

export type SqliteDatabase = Database.Database

export function createDatabase(location: ':memory:' | string): SqliteDatabase {
  if (location === ':memory:') {
    return new Database(':memory:')
  }
  mkdirSync(location, { recursive: true })
  const db = new Database(join(location, DB_FILENAME))
  if (location !== ':memory:') {
    db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 5000')
  }
  return db
}

interface Migration {
  version: number
  up: (db: SqliteDatabase) => void
}

const ZERO_TOKEN_CONDITION =
  'input_tokens = 0 AND output_tokens = 0 AND cache_read_tokens = 0 AND cache_creation_tokens = 0'

const MICRO_PER_USD = 1_000_000

function epochMsToDateKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function dateKeyToLocalRangeMs(dateKey: string): { startMs: number; endMs: number } {
  const [y, m, d] = dateKey.split('-').map(Number)
  const startMs = new Date(y, m - 1, d).getTime()
  return { startMs, endMs: new Date(y, m - 1, d + 1).getTime() }
}

function microUsdToCostString(micro: number): string {
  return (micro / MICRO_PER_USD).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0'
}

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
  },
  {
    version: 2,
    up(db) {
      db.exec(`ALTER TABLE model_pricing ADD COLUMN source TEXT NOT NULL DEFAULT 'user'`)
    }
  },
  {
    version: 3,
    up(db) {
      const staleRows = db
        .prepare(`SELECT created_at FROM usage_records WHERE ${ZERO_TOKEN_CONDITION}`)
        .all() as { created_at: number }[]
      if (staleRows.length === 0) return

      const affectedDates = new Set<string>()
      for (const row of staleRows) affectedDates.add(epochMsToDateKey(row.created_at))
      db.prepare(`DELETE FROM usage_records WHERE ${ZERO_TOKEN_CONDITION}`).run()

      interface DayBucket {
        app_type: string
        model: string
        request_count: number
        success_count: number
        error_count: number
        input_tokens: number
        output_tokens: number
        cache_read_tokens: number
        cache_creation_tokens: number
        cost_micro_usd: number
        latency_ms_total: number
      }

      const selectDayBuckets = db.prepare(`
        SELECT app_type,
               model,
               COUNT(*) AS request_count,
               COUNT(*) - SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS success_count,
               SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
               SUM(input_tokens) AS input_tokens,
               SUM(output_tokens) AS output_tokens,
               SUM(cache_read_tokens) AS cache_read_tokens,
               SUM(cache_creation_tokens) AS cache_creation_tokens,
               SUM(CAST(ROUND(COALESCE(cost_usd, '0') * ${MICRO_PER_USD}.0) AS INTEGER)) AS cost_micro_usd,
               SUM(COALESCE(latency_ms, 0)) AS latency_ms_total
        FROM usage_records
        WHERE created_at >= ? AND created_at < ?
        GROUP BY app_type, model
      `)
      const deleteRollupsByDate = db.prepare('DELETE FROM usage_daily_rollups WHERE date = ?')
      const insertRollup = db.prepare(`
        INSERT INTO usage_daily_rollups (
          date, app_type, model, request_count, success_count, error_count,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          cost_usd, latency_ms_total, updated_at
        ) VALUES (
          @date, @app_type, @model, @request_count, @success_count, @error_count,
          @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
          @cost_usd, @latency_ms_total, @updated_at
        )
      `)
      const updatedAt = Date.now()
      for (const date of affectedDates) {
        deleteRollupsByDate.run(date)
        const { startMs, endMs } = dateKeyToLocalRangeMs(date)
        const buckets = selectDayBuckets.all(startMs, endMs) as DayBucket[]
        for (const b of buckets) {
          insertRollup.run({
            date,
            app_type: b.app_type,
            model: b.model,
            request_count: b.request_count,
            success_count: b.success_count,
            error_count: b.error_count,
            input_tokens: b.input_tokens,
            output_tokens: b.output_tokens,
            cache_read_tokens: b.cache_read_tokens,
            cache_creation_tokens: b.cache_creation_tokens,
            cost_usd: microUsdToCostString(b.cost_micro_usd),
            latency_ms_total: b.latency_ms_total,
            updated_at: updatedAt
          })
        }
      }
    }
  },
  {
    version: 4,
    up(db) {
      db.prepare(
        `UPDATE usage_records SET input_semantics = 2
         WHERE app_type = 'opencode' AND input_semantics = 1`
      ).run()
    }
  },
  {
    version: 5,
    up(db) {
      db.prepare('DELETE FROM sync_cursors WHERE file_path LIKE ?').run('%\\.dsh\\sessions%')
    }
  },
  {
    version: 6,
    up(db) {
      const columns = db.pragma('table_info(sync_cursors)') as { name: string }[]
      if (columns.some((c) => c.name === 'byte_offset')) return
      db.exec('ALTER TABLE sync_cursors ADD COLUMN byte_offset INTEGER')
    }
  },
  {
    version: 7,
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_usage_records_zero_cost
          ON usage_records (cost_usd)
          WHERE cost_usd IS NULL OR cost_usd = '0';
        CREATE INDEX IF NOT EXISTS idx_usage_records_cached_input
          ON usage_records (input_semantics)
          WHERE input_semantics = 1 AND app_type IN ('codex', 'gemini', 'grok');
      `)
    }
  },
  {
    version: 8,
    up(db) {
      const columns = db.pragma('table_info(usage_records)') as { name: string }[]
      const hasHttpStatus = columns.some((c) => c.name === 'http_status')
      const hasErrorMessage = columns.some((c) => c.name === 'error_message')
      if (!hasHttpStatus) db.exec('ALTER TABLE usage_records ADD COLUMN http_status INTEGER')
      if (!hasErrorMessage) db.exec('ALTER TABLE usage_records ADD COLUMN error_message TEXT')
    }
  },
  {
    version: 9,
    up(db) {
      db.prepare('DELETE FROM sync_cursors').run()
    }
  },
  {
    version: 10,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS usage_hourly_rollups (
          date                TEXT    NOT NULL,
          hour                INTEGER NOT NULL,
          app_type            TEXT    NOT NULL,
          model               TEXT    NOT NULL,
          request_count       INTEGER NOT NULL DEFAULT 0,
          success_count       INTEGER NOT NULL DEFAULT 0,
          error_count         INTEGER NOT NULL DEFAULT 0,
          input_tokens        INTEGER NOT NULL DEFAULT 0,
          output_tokens       INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
          cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd            TEXT    NOT NULL DEFAULT '0',
          latency_ms_total    INTEGER NOT NULL DEFAULT 0,
          updated_at          INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (date, hour, app_type, model)
        );

        CREATE INDEX IF NOT EXISTS idx_usage_hourly_rollups_date
          ON usage_hourly_rollups(date, app_type);
        CREATE INDEX IF NOT EXISTS idx_usage_records_status ON usage_records(status);
        CREATE INDEX IF NOT EXISTS idx_usage_records_project ON usage_records(project);
        CREATE INDEX IF NOT EXISTS idx_usage_records_session_id ON usage_records(session_id);
      `)

      const rows = db.prepare(`
        SELECT
          strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') AS date,
          CAST(strftime('%H', created_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hour,
          app_type, model,
          COUNT(*) AS request_count,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
          SUM(input_tokens) AS input_tokens,
          SUM(output_tokens) AS output_tokens,
          SUM(cache_read_tokens) AS cache_read_tokens,
          SUM(cache_creation_tokens) AS cache_creation_tokens,
          SUM(CAST(ROUND(COALESCE(cost_usd, '0') * 1000000) AS INTEGER)) AS cost_micro,
          SUM(COALESCE(latency_ms, 0)) AS latency_ms_total
        FROM usage_records
        GROUP BY date, hour, app_type, model
      `).all() as Array<{
        date: string; hour: number; app_type: string; model: string
        request_count: number; success_count: number; error_count: number
        input_tokens: number; output_tokens: number; cache_read_tokens: number
        cache_creation_tokens: number; cost_micro: number | null; latency_ms_total: number | null
      }>

      const ins = db.prepare(`
        INSERT OR REPLACE INTO usage_hourly_rollups
          (date, hour, app_type, model, request_count, success_count, error_count,
           input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, latency_ms_total, updated_at)
        VALUES
          (@date, @hour, @app_type, @model, @request_count, @success_count, @error_count,
           @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens, @cost_usd, @latency_ms_total, @updated_at)
      `)

      const tx = db.transaction(() => {
        for (const r of rows) {
          ins.run({
            date: r.date, hour: r.hour, app_type: r.app_type, model: r.model,
            request_count: r.request_count, success_count: r.success_count, error_count: r.error_count,
            input_tokens: r.input_tokens, output_tokens: r.output_tokens,
            cache_read_tokens: r.cache_read_tokens, cache_creation_tokens: r.cache_creation_tokens,
            cost_usd: microUsdToCostString(r.cost_micro ?? 0),
            latency_ms_total: r.latency_ms_total ?? 0, updated_at: 0
          })
        }
      })
      tx()
    }
  },
  {
    version: 11,
    up(db) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_usage_records_model_created ON usage_records(model, created_at);
      `)
    }
  },
  {
    version: 12,
    up(db) {
      db.exec(`
        -- 扩展 cached_input 部分索引：覆盖新增 semantics=1 数据源（workbuddy / codebuddy / qwen / reasonix）
        DROP INDEX IF EXISTS idx_usage_records_cached_input;
        CREATE INDEX IF NOT EXISTS idx_usage_records_cached_input
          ON usage_records (input_semantics)
          WHERE input_semantics = 1 AND app_type IN ('codex', 'gemini', 'grok', 'workbuddy', 'codebuddy', 'qwen', 'reasonix');
      `)
    }
  },
  {
    version: 13,
    up(db) {
      db.exec(`
        -- 扩展 cached_input 部分索引：覆盖新增 semantics=1 数据源（goose / copilot-cli / trae-agent）
        DROP INDEX IF EXISTS idx_usage_records_cached_input;
        CREATE INDEX IF NOT EXISTS idx_usage_records_cached_input
          ON usage_records (input_semantics)
          WHERE input_semantics = 1 AND app_type IN ('codex', 'gemini', 'grok', 'workbuddy', 'codebuddy', 'qwen', 'reasonix', 'goose', 'copilot-cli', 'trae-agent');
      `)
    }
  }
]

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
