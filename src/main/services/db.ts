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

/**
 * 迁移表：v1 = 首次建表（5 张核心表 + 索引）；
 * v2 = model_pricing 增加 source 列（定价来源分级，存量行保守标 'user'，
 *      使既有用户可见数据不被后续 seed/sync 同步覆盖）；
 * v3 = 清理四项 token 全为 0 的异常明细，并按剩余明细重建受影响日期的日聚合
 *      （聚合口径与 storage.recordUsage 一致；sync_cursors 游标不动；
 *      幂等：重复执行时无全零行即无操作）；
 * v4 = 修正 opencode 存量行的语义标注（input_semantics 1→2：上游已核实其 input
 *      本为纯新输入）；codex/gemini/grok 的历史费用重算不在迁移内做——migrate()
 *      为同步函数拿不到活定价，由 pricing.recalcCachedInputCosts 在宿主启动时
 *      以当前定价重算并增量修正日聚合。
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
  },
  {
    version: 2,
    up(db) {
      // 定价来源分级：'seed' 内置种子价 / 'sync' models.dev 同步价 / 'user' 用户手动价。
      // NOT NULL DEFAULT 'user' 使 ALTER 时存量行一律标 'user'（保守策略，
      // 用户可见数据不被未来 seed/sync 覆盖），新插入行由写入方显式指定来源。
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
      // opencode 源经上游核实 input 本已是纯新输入（与 claude 同为 semantics=2），
      // 存量错标为 1 的行统一改为 2；条件收敛使重复执行无操作（幂等）。
      // codex/gemini/grok 的历史费用重算需要活定价，由宿主启动时的
      // pricing.recalcCachedInputCosts 完成（见 pricing.ts）。
      db.prepare(
        `UPDATE usage_records SET input_semantics = 2
         WHERE app_type = 'opencode' AND input_semantics = 1`
      ).run()
    }
  },
  {
    version: 5,
    up(db) {
      // dsh 初版适配器模型来源失效（message.model 实测全量缺失）导致「零记录
      // 但游标推满」的脏状态；三级来源修复后历史文件又被 mtime 短路挡住无法
      // 重析。清除 dsh 会话游标让下轮同步全量重析：usage_records 无 dsh 行且
      // dedup_ledger 空，INSERT OR IGNORE 主键幂等，重放无重复计数风险。
      // LIKE 模式按 Windows 路径分隔符精确匹配 ~/.dsh/sessions 子树。
      db.prepare('DELETE FROM sync_cursors WHERE file_path LIKE ?').run('%\\.dsh\\sessions%')
    }
  },
  {
    version: 6,
    up(db) {
      // dsh zstd 尾部增量解压的字节游标：记录上次已安全消费到的压缩字节偏移，
      // 续读时从该偏移起仅解压新增帧；可空（NULL=未知），存量行与非法/脏偏移
      // 一律回退整块解压，靠主键幂等去重兜底，不丢数据。
      // 列已存在即跳过（schema 级幂等）：ALTER 重放会报 duplicate column，
      // 与 v3/v4/v5 的数据级幂等一致，保证 user_version 回拨重放历史迁移安全。
      const columns = db.pragma('table_info(sync_cursors)') as { name: string }[]
      if (columns.some((c) => c.name === 'byte_offset')) return
      db.exec('ALTER TABLE sync_cursors ADD COLUMN byte_offset INTEGER')
    }
  },
  {
    version: 7,
    up(db) {
      // 防阻塞优化：零成本回填与缓存口径存量重算的候选查询此前无任何可用索引，
      // 每次执行都是 usage_records 全表过滤扫描（周期任务，成本随明细量线性上涨）。
      // 部分索引的 WHERE 与各自查询条件完全一致，使候选枚举走 index scan，
      // 成本降为 O(候选数)——稳态下候选集仅为「永久缺价/全免费定价」的滞留行，
      // 体量极小；CREATE INDEX IF NOT EXISTS 保证 user_version 回拨重放安全。
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_usage_records_zero_cost
          ON usage_records (cost_usd)
          WHERE cost_usd IS NULL OR cost_usd = '0';
        CREATE INDEX IF NOT EXISTS idx_usage_records_cached_input
          ON usage_records (input_semantics)
          WHERE input_semantics = 1 AND app_type IN ('codex', 'gemini', 'grok');
      `)
    }
  }
]

/**
 * 幂等迁移：以 PRAGMA user_version 记录已应用版本，逐版本升级至最新。
 * 首次执行建表并逐个应用后续迁移；已应用过的版本自动跳过。
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
