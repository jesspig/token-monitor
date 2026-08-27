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

  recordUsage(records: UsageRecord[]): Promise<number> {
    const runTx = this.db.transaction((items: UsageRecord[]): number => {
      const buckets = new Map<string, RollupBucket>()
      const hourlyBuckets = new Map<string, HourlyRollupBucket>()
      const now = Date.now()
      let added = 0

      for (const r of items) {
        const dataSource = r.appType
        const id = `${dataSource}:${r.source.filePath}:${r.source.line}`
        const reqId = r.source.requestId
        if (reqId != null && this.getDedupStmt.get(dataSource, reqId) != null) {
          continue
        }
        const info = this.insertRecordStmt.run(toUsageRecordRow(r, dataSource, id))
        if (info.changes === 0) continue
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
