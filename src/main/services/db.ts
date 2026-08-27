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
  const db = new Database(join(location, DB_FILENAME))
  // 文件模式启用 WAL，支持后续只读 worker 并发读；:memory: 无意义但无害，统一跳过。
  if (location !== ':memory:') {
    db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 5000')
  }
  return db
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
 *      以当前定价重算并增量修正日聚合；
 * v5 = 清理 dsh 会话游标（模型三级来源修复前零记录但游标推满的脏状态，LIKE 精确匹配 ~/.dsh/sessions）；
 * v6 = sync_cursors 增加 byte_offset（dsh zstd 增量解压字节游标，schema 级幂等）；
 * v7 = usage_records 增部分索引（零成本/缓存口径候选查询走 index scan）；
 * v8 = usage_records 增加 http_status / error_message（失败可观测性，存量 NULL，schema 级幂等）；
 * v9 = 存量回溯：清 sync_cursors 触发失败记录全量重析（v8 + collector 全零放行前历史失败未入库，
 *      游标已推进且 mtime 短路挡住重析；DELETE 幂等、单事务仅一次 fsync，
 *      重放由 usage_records 主键 INSERT OR IGNORE + dedup_ledger 去重保证不重复计数）。
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
  },
  {
    version: 8,
    up(db) {
      // 失败可观测性扩展：usage_records 增加 http_status / error_message。
      // 仅失败记录有效，成功/中断为 NULL；存量数据保持 NULL（ADD COLUMN 默认），
      // 旧库重放安全。列已存在即跳过（schema 级幂等），与 v6 风格一致：
      // 先 PRAGMA table_info 检查再 ALTER，避免 duplicate column 报错，
      // 保证 user_version 回拨重放历史迁移安全。
      // 性能：两列均为简单列，不建索引（见 usageQuery buildWhere 索引说明）；
      //       http_status 选择性低且失败记录占比极低，查询复用已有
      //       idx_usage_records_created_at / idx_usage_records_app_created 的时间范围扫描即可，
      //       单列/部分索引会增加写入放慢且收益可忽略，故不建。
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
      // 存量回溯：失败接入前历史失败请求未入库（v8 前无 http_status/error_message 列，
      // collector 全零过滤亦未对 status=error 放行），但 sync_cursors 游标已推进到文件末尾，
      // 且 mtime 短路（collector 判定 file_mtime 一致即跳过解析）会挡住存量重析，
      // 导致历史失败记录永远无法回填。清除游标触发下一轮全量重析：
      // - 全量更稳：失败语义横跨全部 8 个内置源（claude/codex/gemini/grok/opencode/pi/zcode/dsh），
      //   且早期游标 data_source 可能为空字符串（setCursor 未显式写入），按 data_source IN 过滤会漏删，
      //   按 file_path LIKE 需枚举多套路径模式亦不完备，故直接全量 DELETE；
      // - 幂等：DELETE 重复执行无影响（无游标时 deletes 0 行）；
      // - 去重：usage_records 主键 id = data_source:file_path:line 的 INSERT OR IGNORE
      //   + dedup_ledger 主键 (data_source, request_id) 的 INSERT OR IGNORE 保证重放不重复计数、
      //   不重复累 rollup；成功记录已存在则 info.changes===0 跳过，失败记录为新增行正常入库；
      // - 单事务：由 migrate() 外层 db.transaction 包裹 m.up + PRAGMA user_version，仅一次 fsync；
      // - 性能：稳态重析一轮后游标即按 parsed.nextLine 重建，后续增量仍走 mtime 短路，开销仅首轮一次全量解析。
      db.prepare('DELETE FROM sync_cursors').run()
    }
  },
  {
    version: 10,
    up(db) {
      // 小时粒度物化表：为前端「按小时下钻 / 实时筛选」提供聚合结果缓存，
      // 避免每次查询对 usage_records 全表聚合。仅新增表、索引与一次性回填，
      // 不改既有表结构与写入路径；CREATE TABLE/INDEX IF NOT EXISTS + INSERT OR REPLACE
      // 保证 user_version 回拨重放幂等（重复执行得相同聚合值，不会翻倍）。
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

      // 一次性回填：从 usage_records 按 (date, hour, app_type, model) 聚合进小时桶。
      // 用 JS 循环以便复用 microUsdToCostString（微美元→字符串，与 storage/usageQuery 口径一致）。
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
