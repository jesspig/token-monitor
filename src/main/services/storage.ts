import type Database from 'better-sqlite3'
import type { UsageRecord } from '../../../shared/dto'
import type { StorageService } from '../../../shared/context'
import type {
  ModelPricingRow,
  PricingSource,
  SyncCursorRow,
  UsageRecordRow
} from '../../../shared/tables'
import { ERROR_MESSAGE_MAX_LENGTH } from '../../../shared/failure'
import { createDatabase, migrate, type SqliteDatabase } from './db'
import { semanticFingerprint } from './dedup'

export function openStorage(location: ':memory:' | string): StorageService {
  const db = createDatabase(location)
  migrate(db)
  return new SqliteStorage(db)
}

const MICRO_PER_USD = 1_000_000

function toMicroUsd(costUsd?: string | null): number {
  if (costUsd == null || costUsd === '') return 0
  const n = Number(costUsd)
  return Number.isFinite(n) ? Math.round(n * MICRO_PER_USD) : 0
}

function fromMicroUsd(micro: number): string {
  return (micro / MICRO_PER_USD).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0'
}

function toDateKey(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

interface RollupSummary {
  requestCount: number
  successCount: number
  errorCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costMicroUsd: number
  latencyMsTotal: number
}

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
    request_id: r.source.requestId ?? null,
    is_replaceable_snapshot: r.isReplaceableSnapshot === true ? 1 : 0,
    file_path: r.source.filePath,
    line: r.source.line,
    created_at: r.createdAt
  }
}

function storedRecordEquals(a: UsageRecordRow, b: UsageRecordRow): boolean {
  return (
    a.data_source === b.data_source &&
    a.app_type === b.app_type &&
    a.model === b.model &&
    a.raw_model === b.raw_model &&
    a.input_tokens === b.input_tokens &&
    a.output_tokens === b.output_tokens &&
    a.cache_read_tokens === b.cache_read_tokens &&
    a.cache_creation_tokens === b.cache_creation_tokens &&
    a.input_semantics === b.input_semantics &&
    a.cost_usd === b.cost_usd &&
    a.currency === b.currency &&
    a.latency_ms === b.latency_ms &&
    a.project === b.project &&
    a.session_id === b.session_id &&
    a.status === b.status &&
    a.http_status === b.http_status &&
    a.error_message === b.error_message &&
    a.request_id === b.request_id &&
    a.is_replaceable_snapshot === b.is_replaceable_snapshot &&
    a.file_path === b.file_path &&
    a.line === b.line &&
    a.created_at === b.created_at
  )
}

interface DailyBucketRef {
  date: string
  appType: string
  model: string
  startMs: number
  endMs: number
}

interface HourlyBucketRef extends DailyBucketRef {
  hour: number
}

function dailyBucketRef(row: UsageRecordRow): DailyBucketRef {
  const createdAt = new Date(row.created_at)
  const startMs = new Date(createdAt.getFullYear(), createdAt.getMonth(), createdAt.getDate()).getTime()
  return {
    date: toDateKey(row.created_at),
    appType: row.app_type,
    model: row.model,
    startMs,
    endMs: new Date(createdAt.getFullYear(), createdAt.getMonth(), createdAt.getDate() + 1).getTime()
  }
}

function hourlyBucketRef(row: UsageRecordRow): HourlyBucketRef {
  const createdAt = new Date(row.created_at)
  const startMs = new Date(
    createdAt.getFullYear(),
    createdAt.getMonth(),
    createdAt.getDate(),
    createdAt.getHours()
  ).getTime()
  return {
    date: toDateKey(row.created_at),
    hour: createdAt.getHours(),
    appType: row.app_type,
    model: row.model,
    startMs,
    endMs: new Date(
      createdAt.getFullYear(),
      createdAt.getMonth(),
      createdAt.getDate(),
      createdAt.getHours() + 1
    ).getTime()
  }
}

function dailyBucketKey(ref: DailyBucketRef): string {
  return [ref.appType, ref.date, ref.model].join(String.fromCharCode(0))
}

function hourlyBucketKey(ref: HourlyBucketRef): string {
  return [ref.appType, ref.date, ref.hour, ref.model].join(String.fromCharCode(0))
}

export class SqliteStorage implements StorageService {
  private readonly insertRecordStmt: Database.Statement
  private readonly getRecordByRequestStmt: Database.Statement
  private readonly updateRecordStmt: Database.Statement
  private readonly getDedupStmt: Database.Statement
  private readonly upsertDedupStmt: Database.Statement
  private readonly listBucketRecordsStmt: Database.Statement
  private readonly upsertRollupStmt: Database.Statement
  private readonly deleteRollupStmt: Database.Statement
  private readonly upsertHourlyRollupStmt: Database.Statement
  private readonly deleteHourlyRollupStmt: Database.Statement
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
        status, http_status, error_message, request_id, is_replaceable_snapshot,
        file_path, line, created_at
      ) VALUES (
        @id, @data_source, @app_type, @model, @raw_model,
        @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
        @input_semantics, @cost_usd, @currency, @latency_ms, @project, @session_id,
        @status, @http_status, @error_message, @request_id, @is_replaceable_snapshot,
        @file_path, @line, @created_at
      )
    `)

    this.getRecordByRequestStmt = db.prepare(
      'SELECT * FROM usage_records WHERE data_source = ? AND request_id = ?'
    )

    this.updateRecordStmt = db.prepare(`
      UPDATE usage_records SET
        app_type = @app_type,
        model = @model,
        raw_model = @raw_model,
        input_tokens = @input_tokens,
        output_tokens = @output_tokens,
        cache_read_tokens = @cache_read_tokens,
        cache_creation_tokens = @cache_creation_tokens,
        input_semantics = @input_semantics,
        cost_usd = @cost_usd,
        currency = @currency,
        latency_ms = @latency_ms,
        project = @project,
        session_id = @session_id,
        status = @status,
        http_status = @http_status,
        error_message = @error_message,
        request_id = @request_id,
        is_replaceable_snapshot = @is_replaceable_snapshot,
        file_path = @file_path,
        line = @line,
        created_at = @created_at
      WHERE id = @id
    `)

    this.getDedupStmt = db.prepare(
      'SELECT semantic_id FROM dedup_ledger WHERE data_source = ? AND request_id = ?'
    )

    this.upsertDedupStmt = db.prepare(`
      INSERT INTO dedup_ledger (data_source, request_id, semantic_id, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(data_source, request_id) DO UPDATE SET
        semantic_id = excluded.semantic_id
    `)

    this.listBucketRecordsStmt = db.prepare(`
      SELECT * FROM usage_records
      WHERE app_type = ? AND model = ? AND created_at >= ? AND created_at < ?
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

    this.deleteRollupStmt = db.prepare(`
      DELETE FROM usage_daily_rollups
      WHERE date = ? AND app_type = ? AND model = ?
    `)

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

    this.deleteHourlyRollupStmt = db.prepare(`
      DELETE FROM usage_hourly_rollups
      WHERE date = ? AND hour = ? AND app_type = ? AND model = ?
    `)

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

  recordUsage(records: UsageRecord[]): Promise<number> {
    const runTx = this.db.transaction((items: UsageRecord[]): number => {
      const dailyBuckets = new Map<string, DailyBucketRef>()
      const hourlyBuckets = new Map<string, HourlyBucketRef>()
      const now = Date.now()
      let changed = 0

      const markAffectedBuckets = (row: UsageRecordRow): void => {
        const daily = dailyBucketRef(row)
        const hourly = hourlyBucketRef(row)
        dailyBuckets.set(dailyBucketKey(daily), daily)
        hourlyBuckets.set(hourlyBucketKey(hourly), hourly)
      }

      for (const record of items) {
        const dataSource = record.appType
        const id = `${dataSource}:${record.source.filePath}:${record.source.line}`
        const incoming = toUsageRecordRow(record, dataSource, id)
        const requestId = incoming.request_id

        if (requestId != null) {
          const ledger = this.getDedupStmt.get(dataSource, requestId) as { semantic_id: string } | undefined
          const existing = this.getRecordByRequestStmt.get(dataSource, requestId) as UsageRecordRow | undefined
          if (ledger != null && existing == null) continue
          if (existing != null) {
            if (
              existing.is_replaceable_snapshot !== 1 ||
              incoming.is_replaceable_snapshot !== 1 ||
              existing.status !== 'success' ||
              incoming.status !== 'success'
            ) {
              continue
            }
            incoming.id = existing.id
            if (storedRecordEquals(existing, incoming)) continue
            const info = this.updateRecordStmt.run(incoming)
            if (info.changes !== 1) throw new Error('可替换快照更新失败')
            this.upsertDedupStmt.run(dataSource, requestId, semanticFingerprint(record), now)
            markAffectedBuckets(existing)
            markAffectedBuckets(incoming)
            changed++
            continue
          }
        }

        const info = this.insertRecordStmt.run(incoming)
        if (info.changes === 0) continue
        if (requestId != null) {
          this.upsertDedupStmt.run(dataSource, requestId, semanticFingerprint(record), now)
        }
        markAffectedBuckets(incoming)
        changed++
      }

      const summarize = (rows: UsageRecordRow[]): RollupSummary => {
        const summary: RollupSummary = {
          requestCount: rows.length,
          successCount: 0,
          errorCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costMicroUsd: 0,
          latencyMsTotal: 0
        }
        for (const row of rows) {
          if (row.status === 'error') summary.errorCount++
          else summary.successCount++
          summary.inputTokens += row.input_tokens
          summary.outputTokens += row.output_tokens
          summary.cacheReadTokens += row.cache_read_tokens
          summary.cacheCreationTokens += row.cache_creation_tokens
          summary.costMicroUsd += toMicroUsd(row.cost_usd)
          summary.latencyMsTotal += row.latency_ms ?? 0
        }
        return summary
      }

      for (const bucket of dailyBuckets.values()) {
        const rows = this.listBucketRecordsStmt.all(
          bucket.appType,
          bucket.model,
          bucket.startMs,
          bucket.endMs
        ) as UsageRecordRow[]
        if (rows.length === 0) {
          this.deleteRollupStmt.run(bucket.date, bucket.appType, bucket.model)
          continue
        }
        const summary = summarize(rows)
        this.upsertRollupStmt.run({
          date: bucket.date,
          app_type: bucket.appType,
          model: bucket.model,
          request_count: summary.requestCount,
          success_count: summary.successCount,
          error_count: summary.errorCount,
          input_tokens: summary.inputTokens,
          output_tokens: summary.outputTokens,
          cache_read_tokens: summary.cacheReadTokens,
          cache_creation_tokens: summary.cacheCreationTokens,
          cost_usd: fromMicroUsd(summary.costMicroUsd),
          latency_ms_total: summary.latencyMsTotal,
          updated_at: now
        })
      }

      for (const bucket of hourlyBuckets.values()) {
        const rows = this.listBucketRecordsStmt.all(
          bucket.appType,
          bucket.model,
          bucket.startMs,
          bucket.endMs
        ) as UsageRecordRow[]
        if (rows.length === 0) {
          this.deleteHourlyRollupStmt.run(bucket.date, bucket.hour, bucket.appType, bucket.model)
          continue
        }
        const summary = summarize(rows)
        this.upsertHourlyRollupStmt.run({
          date: bucket.date,
          hour: bucket.hour,
          app_type: bucket.appType,
          model: bucket.model,
          request_count: summary.requestCount,
          success_count: summary.successCount,
          error_count: summary.errorCount,
          input_tokens: summary.inputTokens,
          output_tokens: summary.outputTokens,
          cache_read_tokens: summary.cacheReadTokens,
          cache_creation_tokens: summary.cacheCreationTokens,
          cost_usd: fromMicroUsd(summary.costMicroUsd),
          latency_ms_total: summary.latencyMsTotal,
          updated_at: now
        })
      }

      return changed
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

  close(): void {
    this.db.close()
  }
}
