import type Database from 'better-sqlite3'
import type { UsageRecord } from '../../../shared/dto'
import type { StorageService } from '../../../shared/context'
import type {
  ModelPricingRow,
  PricingSource,
  SyncCursorRow,
  UsageDailyRollupRow,
  UsageRecordRow
} from '../../../shared/tables'
import { ERROR_MESSAGE_MAX_LENGTH } from '../../../shared/failure'
import { createDatabase, migrate, type SqliteDatabase } from './db'
import { semanticFingerprint } from './dedup'

/**
 * 打开数据库并应用迁移，返回满足 StorageService 契约的实例。
 * location 支持 `:memory:` 与目录路径（文件模式落在目录下 token-monitor.db）。
 */
export function openStorage(location: ':memory:' | string): StorageService {
  const db = createDatabase(location)
  migrate(db)
  return new SqliteStorage(db)
}

/** 微美元：费用以字符串存储避免浮点误差，聚合时统一转成整数微美元累加 */
const MICRO_PER_USD = 1_000_000

function toMicroUsd(costUsd?: string | null): number {
  if (costUsd == null || costUsd === '') return 0
  const n = Number(costUsd)
  return Number.isFinite(n) ? Math.round(n * MICRO_PER_USD) : 0
}

function fromMicroUsd(micro: number): string {
  return (micro / MICRO_PER_USD).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0'
}

/** epoch ms → YYYY-MM-DD（本地时区，日聚合按本地日归桶） */
function toDateKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 单个 (date, app_type, model) 桶的累计器 */
interface RollupBucket {
  date: string
  appType: string
  model: string
  requestCount: number
  successCount: number
  errorCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costMicroUsd: number
  latencyMsTotal: number
  updatedAt: number
}

interface HourlyRollupBucket {
  date: string
  hour: number
  appType: string
  model: string
  requestCount: number
  successCount: number
  errorCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costMicroUsd: number
  latencyMsTotal: number
  updatedAt: number
}

/**
 * UsageRecord(dto) → usage_records 行；errorMessage 按 shared/failure.ts 500 约束截断
 * 性能：http_status / error_message 为简单列直写（INTEGER/TEXT），无计算/正则/派生开销；
 *       两列不建索引（见 usageQuery buildWhere 索引说明），写入路径零放慢，查询复用
 *       已有 idx_usage_records_created_at / idx_usage_records_app_created 的时间范围扫描。
 */
function toUsageRecordRow(r: UsageRecord, dataSource: string, id: string): UsageRecordRow {
  const truncatedMessage =
    r.errorMessage != null && r.errorMessage.length > ERROR_MESSAGE_MAX_LENGTH
      ? r.errorMessage.slice(0, ERROR_MESSAGE_MAX_LENGTH)
      : (r.errorMessage ?? null)
  return {
    id,
    data_source: dataSource,
    app_type: r.appType,
    model: r.model,
    raw_model: r.rawModel ?? null,
    input_tokens: r.inputTokens,
    output_tokens: r.outputTokens,
    cache_read_tokens: r.cacheReadTokens,
    cache_creation_tokens: r.cacheCreationTokens,
    input_semantics: r.inputSemantics,
    cost_usd: r.costUsd ?? null,
    currency: r.currency ?? null,
    latency_ms: r.latencyMs ?? null,
    project: r.project ?? null,
    session_id: r.sessionId ?? null,
    status: r.status ?? 'success',
    http_status: r.httpStatus ?? null,
    error_message: truncatedMessage,
    file_path: r.source.filePath,
    line: r.source.line,
    created_at: r.createdAt
  }
}

/**
 * StorageService 的 better-sqlite3 实现（仅主进程，同步 API 内部实现 + Promise 签名）。
 * 方法签名与 shared/context.ts 的 StorageService 契约一致。
 * 性能：失败扩展列 http_status / error_message 不建独立索引，写入为 INSERT OR IGNORE 单行直写，
 *       无额外计算；查询侧由 usageQuery.buildWhere 复用已有时间索引，失败记录占比低无需单列索引。
 * 幂等（T09 存量回溯）：recordUsage 以 usage_records 主键 id=data_source:file_path:line 的
 * INSERT OR IGNORE + dedup_ledger 主键 (data_source, request_id) 的 INSERT OR IGNORE 双层去重
 * 保证重放不重复计数——v9 迁移 DELETE FROM sync_cursors 清游标触发全量重析时，已入库的成功记录
 * 因主键冲突 info.changes===0 跳过（不累 rollup），仅新增的失败记录正常入库；失败记录常零 token
 * 但 collector 已对 status=error 放行全零，语义去重仅以 (data_source, request_id) 查账本，
 * 不会因 semanticFingerprint 相同而误合并。
 */
export class SqliteStorage implements StorageService {
  private readonly insertRecordStmt: Database.Statement
  private readonly getDedupStmt: Database.Statement
  private readonly insertDedupStmt: Database.Statement
  private readonly getRollupStmt: Database.Statement
  private readonly upsertRollupStmt: Database.Statement
  private readonly getHourlyRollupStmt: Database.Statement
  private readonly upsertHourlyRollupStmt: Database.Statement
  private readonly getCursorStmt: Database.Statement
  private readonly getCursorRowStmt: Database.Statement
  private readonly upsertCursorStmt: Database.Statement
  private readonly listPricingStmt: Database.Statement
  private readonly upsertPricingStmt: Database.Statement
  private readonly deletePricingStmt: Database.Statement

  constructor(private readonly db: SqliteDatabase) {
    this.insertRecordStmt = db.prepare(`
      INSERT OR IGNORE INTO usage_records (
        id, data_source, app_type, model, raw_model,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        input_semantics, cost_usd, currency, latency_ms, project, session_id,
        status, http_status, error_message, file_path, line, created_at
      ) VALUES (
        @id, @data_source, @app_type, @model, @raw_model,
        @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
        @input_semantics, @cost_usd, @currency, @latency_ms, @project, @session_id,
        @status, @http_status, @error_message, @file_path, @line, @created_at
      )
    `)

    this.getDedupStmt = db.prepare(
      'SELECT semantic_id FROM dedup_ledger WHERE data_source = ? AND request_id = ?'
    )

    this.insertDedupStmt = db.prepare(
      `INSERT OR IGNORE INTO dedup_ledger (data_source, request_id, semantic_id, created_at)
       VALUES (?, ?, ?, ?)`
    )

    this.getRollupStmt = db.prepare(`
      SELECT * FROM usage_daily_rollups
      WHERE date = ? AND app_type = ? AND model = ?
    `)

    this.upsertRollupStmt = db.prepare(`
      INSERT INTO usage_daily_rollups (
        date, app_type, model, request_count, success_count, error_count,
        input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
        cost_usd, latency_ms_total, updated_at
      ) VALUES (
        @date, @app_type, @model, @request_count, @success_count, @error_count,
        @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
        @cost_usd, @latency_ms_total, @updated_at
      )
      ON CONFLICT(date, app_type, model) DO UPDATE SET
        request_count         = excluded.request_count,
        success_count         = excluded.success_count,
        error_count           = excluded.error_count,
        input_tokens          = excluded.input_tokens,
        output_tokens         = excluded.output_tokens,
        cache_read_tokens     = excluded.cache_read_tokens,
        cache_creation_tokens = excluded.cache_creation_tokens,
        cost_usd              = excluded.cost_usd,
        latency_ms_total      = excluded.latency_ms_total,
        updated_at            = excluded.updated_at
    `)

    this.getHourlyRollupStmt = db.prepare(
      `SELECT request_count, success_count, error_count, input_tokens, output_tokens,
              cache_read_tokens, cache_creation_tokens, cost_usd, latency_ms_total
       FROM usage_hourly_rollups
       WHERE date = ? AND hour = ? AND app_type = ? AND model = ?`
    )
    this.upsertHourlyRollupStmt = db.prepare(
      `INSERT INTO usage_hourly_rollups
         (date, hour, app_type, model, request_count, success_count, error_count,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, latency_ms_total, updated_at)
       VALUES (@date, @hour, @app_type, @model, @request_count, @success_count, @error_count,
          @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens, @cost_usd, @latency_ms_total, @updated_at)
       ON CONFLICT(date, hour, app_type, model) DO UPDATE SET
         request_count = @request_count, success_count = @success_count, error_count = @error_count,
         input_tokens = @input_tokens, output_tokens = @output_tokens,
         cache_read_tokens = @cache_read_tokens, cache_creation_tokens = @cache_creation_tokens,
         cost_usd = @cost_usd, latency_ms_total = @latency_ms_total, updated_at = @updated_at`
    )

    this.getCursorStmt = db.prepare(`
      SELECT line_offset FROM sync_cursors WHERE file_path = ?
    `)

    this.getCursorRowStmt = db.prepare(`
      SELECT * FROM sync_cursors WHERE file_path = ?
    `)

    this.upsertCursorStmt = db.prepare(`
      INSERT INTO sync_cursors (file_path, data_source, line_offset, file_mtime, byte_offset, updated_at)
      VALUES (@file_path, @data_source, @line_offset, @file_mtime, @byte_offset, @updated_at)
      ON CONFLICT(file_path) DO UPDATE SET
        data_source = excluded.data_source,
        line_offset = CASE WHEN @reset_cursor THEN 0 ELSE excluded.line_offset END,
        file_mtime  = excluded.file_mtime,
        byte_offset = CASE
          WHEN @reset_cursor THEN NULL
          WHEN @keep_byte_offset THEN sync_cursors.byte_offset
          ELSE excluded.byte_offset
        END,
        updated_at  = excluded.updated_at
    `)

    this.listPricingStmt = db.prepare(`
      SELECT * FROM model_pricing ORDER BY model_id
    `)

    this.upsertPricingStmt = db.prepare(`
      INSERT INTO model_pricing (
        model_id, provider, input_per_million, output_per_million,
        cache_read_per_million, cache_creation_per_million, currency, cost_multiplier, updated_at, source
      ) VALUES (
        @model_id, @provider, @input_per_million, @output_per_million,
        @cache_read_per_million, @cache_creation_per_million, @currency, @cost_multiplier, @updated_at, @source
      )
      ON CONFLICT(model_id) DO UPDATE SET
        provider                   = excluded.provider,
        input_per_million          = excluded.input_per_million,
        output_per_million         = excluded.output_per_million,
        cache_read_per_million     = excluded.cache_read_per_million,
        cache_creation_per_million = excluded.cache_creation_per_million,
        currency                   = excluded.currency,
        cost_multiplier            = excluded.cost_multiplier,
        updated_at                 = excluded.updated_at,
        source                     = excluded.source
      WHERE model_pricing.source != 'user' OR excluded.source = 'user'
    `)

    this.deletePricingStmt = db.prepare(`
      DELETE FROM model_pricing WHERE model_id = ?
    `)
  }

  /**
   * 幂等写入：INSERT OR IGNORE（主键 id 去重）+ dedup_ledger（request_id 去重）双层保证
   * T09 回放安全——v9 清游标后全量重析，已入库行因主键冲突 changes===0 跳过，不重复累 rollup。
   */
  recordUsage(records: UsageRecord[]): Promise<number> {
    const runTx = this.db.transaction((items: UsageRecord[]): number => {
      const buckets = new Map<string, RollupBucket>()
      const hourlyBuckets = new Map<string, HourlyRollupBucket>()
      const now = Date.now()
      let added = 0

      for (const r of items) {
        // 首版无 provider 维度，data_source 与插件 id（app_type）一致
        const dataSource = r.appType
        // 主键/去重 key = data_source + file_path + line（':' 分隔避免拼接歧义）
        // 幂等：INSERT OR IGNORE，主键冲突时 changes===0，不入明细亦不累 rollup/事件，重复回放无影响
        const id = `${dataSource}:${r.source.filePath}:${r.source.line}`
        // 语义去重：同 requestId 已入账即跳过（fork/rewrite 场景，明细行号不同但为同一逻辑请求）。
        // 失败记录常零 token，其 semanticFingerprint 可能相同但不参与判定；
        // 主路径仅以 (data_source, request_id) 查 ledger，零 token 不会误合并——semantic_id 仅辅助写入。
        // dedup_ledger 亦为 INSERT OR IGNORE，主键 (data_source, request_id)，与明细主键共同保证幂等。
        const reqId = r.source.requestId
        if (reqId != null && this.getDedupStmt.get(dataSource, reqId) != null) {
          continue
        }
        const info = this.insertRecordStmt.run(toUsageRecordRow(r, dataSource, id))
        if (info.changes === 0) continue // 主键去重命中，跳过（不累计 rollup）——回放幂等
        if (reqId != null) {
          this.insertDedupStmt.run(dataSource, reqId, semanticFingerprint(r), now)
        }

        added++
        const date = toDateKey(r.createdAt)
        const hour = new Date(r.createdAt).getHours()
        const key = `${r.appType}\u0000${date}\u0000${r.model}`
        let b = buckets.get(key)
        if (!b) {
          b = {
            date,
            appType: r.appType,
            model: r.model,
            requestCount: 0,
            successCount: 0,
            errorCount: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costMicroUsd: 0,
            latencyMsTotal: 0,
            updatedAt: now
          }
          buckets.set(key, b)
        }
        b.requestCount++
        if (r.status === 'error') b.errorCount++
        else b.successCount++
        b.inputTokens += r.inputTokens
        b.outputTokens += r.outputTokens
        b.cacheReadTokens += r.cacheReadTokens
        b.cacheCreationTokens += r.cacheCreationTokens
        b.costMicroUsd += toMicroUsd(r.costUsd)
        b.latencyMsTotal += r.latencyMs ?? 0

        // 小时粒度聚合：与日桶口径一致，按 (appType, date, hour, model) 累桶
        const hKey = `${r.appType}\u0000${date}\u0000${hour}\u0000${r.model}`
        let hb = hourlyBuckets.get(hKey)
        if (!hb) {
          hb = {
            date, hour, appType: r.appType, model: r.model,
            requestCount: 0, successCount: 0, errorCount: 0,
            inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
            cacheCreationTokens: 0, costMicroUsd: 0, latencyMsTotal: 0, updatedAt: now
          }
          hourlyBuckets.set(hKey, hb)
        }
        hb.requestCount++
        if (r.status === 'error') hb.errorCount++
        else hb.successCount++
        hb.inputTokens += r.inputTokens
        hb.outputTokens += r.outputTokens
        hb.cacheReadTokens += r.cacheReadTokens
        hb.cacheCreationTokens += r.cacheCreationTokens
        hb.costMicroUsd += toMicroUsd(r.costUsd)
        hb.latencyMsTotal += r.latencyMs ?? 0
      }

      for (const b of buckets.values()) {
        const existing = this.getRollupStmt.get(b.date, b.appType, b.model) as
          | Pick<
              UsageDailyRollupRow,
              | 'cost_usd'
              | 'request_count'
              | 'success_count'
              | 'error_count'
              | 'input_tokens'
              | 'output_tokens'
              | 'cache_read_tokens'
              | 'cache_creation_tokens'
              | 'latency_ms_total'
            >
          | undefined
        this.upsertRollupStmt.run({
          date: b.date,
          app_type: b.appType,
          model: b.model,
          request_count: b.requestCount + (existing?.request_count ?? 0),
          success_count: b.successCount + (existing?.success_count ?? 0),
          error_count: b.errorCount + (existing?.error_count ?? 0),
          input_tokens: b.inputTokens + (existing?.input_tokens ?? 0),
          output_tokens: b.outputTokens + (existing?.output_tokens ?? 0),
          cache_read_tokens: b.cacheReadTokens + (existing?.cache_read_tokens ?? 0),
          cache_creation_tokens: b.cacheCreationTokens + (existing?.cache_creation_tokens ?? 0),
          cost_usd: fromMicroUsd(b.costMicroUsd + toMicroUsd(existing?.cost_usd)),
          latency_ms_total: b.latencyMsTotal + (existing?.latency_ms_total ?? 0),
          updated_at: b.updatedAt
        })
      }

      for (const hb of hourlyBuckets.values()) {
        const existing = this.getHourlyRollupStmt.get(hb.date, hb.hour, hb.appType, hb.model) as
          | Pick<
              UsageDailyRollupRow,
              | 'cost_usd'
              | 'request_count'
              | 'success_count'
              | 'error_count'
              | 'input_tokens'
              | 'output_tokens'
              | 'cache_read_tokens'
              | 'cache_creation_tokens'
              | 'latency_ms_total'
            >
          | undefined
        this.upsertHourlyRollupStmt.run({
          date: hb.date, hour: hb.hour, app_type: hb.appType, model: hb.model,
          request_count: hb.requestCount + (existing?.request_count ?? 0),
          success_count: hb.successCount + (existing?.success_count ?? 0),
          error_count: hb.errorCount + (existing?.error_count ?? 0),
          input_tokens: hb.inputTokens + (existing?.input_tokens ?? 0),
          output_tokens: hb.outputTokens + (existing?.output_tokens ?? 0),
          cache_read_tokens: hb.cacheReadTokens + (existing?.cache_read_tokens ?? 0),
          cache_creation_tokens: hb.cacheCreationTokens + (existing?.cache_creation_tokens ?? 0),
          cost_usd: fromMicroUsd(hb.costMicroUsd + toMicroUsd(existing?.cost_usd)),
          latency_ms_total: hb.latencyMsTotal + (existing?.latency_ms_total ?? 0),
          updated_at: hb.updatedAt
        })
      }

      return added
    })

    return Promise.resolve(runTx(records))
  }

  getCursor(filePath: string): Promise<number | null> {
    const row = this.getCursorStmt.get(filePath) as { line_offset: number } | undefined
    return Promise.resolve(row ? row.line_offset : null)
  }

  getCursorMeta(
    filePath: string
  ): Promise<{ lineOffset: number; fileMtime: number; byteOffset?: number | null } | null> {
    const row = this.getCursorRowStmt.get(filePath) as SyncCursorRow | undefined
    return Promise.resolve(
      row
        ? { lineOffset: row.line_offset, fileMtime: row.file_mtime, byteOffset: row.byte_offset ?? null }
        : null
    )
  }

  setCursor(filePath: string, line: number, fileMtime?: number, byteOffset?: number | null): Promise<void> {
    const runTx = this.db.transaction(
      (fp: string, ln: number, mtime?: number, byte?: number | null) => {
        const existing = this.getCursorRowStmt.get(fp) as SyncCursorRow | undefined
        // 文件被 truncate/替换（mtime 变化）：游标重置到 0，下一轮从头部全量重读；
        // 既有 mtime 为 0（未知占位）时不参与判定，避免正常推进被误判为 truncate。
        // byteOffset：缺省保留现值，显式传入（含 null）覆盖；truncate 重置时一并清空。
        const reset =
          existing != null && mtime != null && existing.file_mtime !== 0 && existing.file_mtime !== mtime
        const finalMtime = mtime ?? existing?.file_mtime ?? 0
        this.upsertCursorStmt.run({
          file_path: fp,
          data_source: existing?.data_source ?? '',
          line_offset: ln,
          file_mtime: finalMtime,
          byte_offset: byte ?? null,
          keep_byte_offset: byte === undefined ? 1 : 0,
          reset_cursor: reset ? 1 : 0,
          updated_at: Date.now()
        })
      }
    )
    runTx(filePath, line, fileMtime, byteOffset)
    return Promise.resolve()
  }

  getModelPricing(): Promise<ModelPricingRow[]> {
    const rows = this.listPricingStmt.all() as ModelPricingRow[]
    return Promise.resolve(rows)
  }

  /**
   * 分级 upsert 定价（docs/concepts/pricing.md）：
   * - source 缺省为 'user'（旧调用向后兼容；手动 IPC 编辑即走此默认值）；
   * - 新行直接以传入 source 插入；
   * - 冲突时仅当「现行为非 user 或本次写入为 user」才更新：
   *   user 行挡住 seed/sync 写入（含 updated_at 在内全不动），user 写入覆盖一切并把行升级为 'user'。
   * 来源只取调用点显式传入的 source（不信任 entry 载荷携带的 source 字段），
   * 避免渲染进程回传数据时伪造/遗漏来源导致分级失效。
   */
  updateModelPricing(entry: ModelPricingRow, source?: PricingSource): Promise<void> {
    const resolvedSource = source ?? 'user'
    this.upsertPricingStmt.run({
      model_id: entry.model_id,
      provider: entry.provider,
      input_per_million: entry.input_per_million,
      output_per_million: entry.output_per_million,
      cache_read_per_million: entry.cache_read_per_million,
      cache_creation_per_million: entry.cache_creation_per_million,
      currency: entry.currency,
      cost_multiplier: entry.cost_multiplier,
      updated_at: entry.updated_at ?? Date.now(),
      source: resolvedSource
    })
    return Promise.resolve()
  }

  /**
   * 单事务批量 upsert 定价：分级保护 WHERE（user 行不被非 user 写入覆盖）
   * 复用与单条 upsert 相同的预编译语句，天然生效；
   * 全部条目在一个事务内提交，仅一次 fsync。空数组不开事务直接返回 0。
   */
  updateModelPricingBatch(entries: ModelPricingRow[], source: PricingSource): Promise<number> {
    if (entries.length === 0) return Promise.resolve(0)
    const runTx = this.db.transaction((items: ModelPricingRow[], src: PricingSource): number => {
      let count = 0
      for (const entry of items) {
        this.upsertPricingStmt.run({
          model_id: entry.model_id,
          provider: entry.provider,
          input_per_million: entry.input_per_million,
          output_per_million: entry.output_per_million,
          cache_read_per_million: entry.cache_read_per_million,
          cache_creation_per_million: entry.cache_creation_per_million,
          currency: entry.currency,
          cost_multiplier: entry.cost_multiplier,
          updated_at: entry.updated_at ?? Date.now(),
          source: src
        })
        count++
      }
      return count
    })
    return Promise.resolve(runTx(entries, source))
  }

  deleteModelPricing(modelId: string): Promise<void> {
    this.deletePricingStmt.run(modelId)
    return Promise.resolve()
  }

  /** 关闭数据库连接（宿主退出时调用；不在 StorageService 契约内） */
  close(): void {
    this.db.close()
  }
}
