import type { AppType } from '../../shared/app'
import type { PluginContext } from '../../shared/context'
import type { Detection, FileEntry, UsageRecord } from '../../shared/dto'
import type { MonitorPlugin } from '../../shared/plugin'
import type { PluginStatus } from '../../shared/query'
import { ERROR_MESSAGE_MAX_LENGTH } from '../../shared/failure'
import { CLI_VERSION_COMMANDS, detectCliVersion } from './services/cli-version'

function isAllZeroUsage(record: UsageRecord): boolean {
  if (record.status === 'error') return false
  return (
    record.inputTokens === 0 &&
    record.outputTokens === 0 &&
    record.cacheReadTokens === 0 &&
    record.cacheCreationTokens === 0
  )
}

function truncateErrorMessage(message: string | undefined): string | undefined {
  if (message == null) return undefined
  return message.length > ERROR_MESSAGE_MAX_LENGTH
    ? message.slice(0, ERROR_MESSAGE_MAX_LENGTH)
    : message
}

export interface CollectorOptions {
  isEnabled?: (id: AppType) => boolean
  onError?: (id: AppType, err: unknown) => void
}

export interface CollectorStartOptions {
  initialSyncDelayMs?: number
}

interface PluginRuntime {
  lastSyncAt: number | null
  errorCount: number
}

export interface SyncResult {
  imported: number
  errors: number
  addedRecords: number
}

const STATUS_CACHE_TTL_MS = 5_000

export interface Collector {
  syncAll(): Promise<SyncResult>
  syncPlugin(id: AppType): Promise<SyncResult>
  start(intervalMs: number, options?: CollectorStartOptions): void
  stop(): void
  getPluginStatus(): Promise<PluginStatus[]>
  invalidateStatusCache(): void
  getErrorCount(): number
}

export function createCollector(
  ctx: PluginContext,
  plugins: MonitorPlugin[],
  options: CollectorOptions = {}
): Collector {
  const isEnabled = options.isEnabled ?? (() => true)
  const onError =
    options.onError ??
    ((_id: AppType, err: unknown) => {
      console.error('[collector] 同步失败:', err)
    })

  const runtime = new Map<AppType, PluginRuntime>()
  let disposer: (() => void) | null = null
  let initialSyncTimer: NodeJS.Timeout | null = null
  let statusCache: { at: number; data: PluginStatus[] } | null = null

  function getRuntime(id: AppType): PluginRuntime {
    let r = runtime.get(id)
    if (!r) {
      r = { lastSyncAt: null, errorCount: 0 }
      runtime.set(id, r)
    }
    return r
  }

  async function syncOne(plugin: MonitorPlugin): Promise<SyncResult> {
    let imported = 0
    let errors = 0
    let addedRecords = 0

    if (!isEnabled(plugin.id)) return { imported, errors, addedRecords }

    let det: Detection
    try {
      det = await plugin.detect(ctx)
    } catch (err) {
      getRuntime(plugin.id).errorCount++
      errors++
      onError(plugin.id, err)
      return { imported, errors, addedRecords }
    }
    if (!det.available) return { imported, errors, addedRecords }

    let files: FileEntry[]
    try {
      files = await plugin.listFiles(ctx)
    } catch (err) {
      getRuntime(plugin.id).errorCount++
      errors++
      onError(plugin.id, err)
      return { imported, errors, addedRecords }
    }

    for (const file of files) {
      try {
        const meta = await ctx.storage.getCursorMeta(file.path)
        if (
          meta !== null &&
          file.mtime > 0 &&
          meta.fileMtime === file.mtime &&
          meta.lineOffset > 0
        ) {
          continue
        }
        const parsed = await plugin.parseFile(ctx, file.path, meta?.lineOffset ?? 0)
        const records = parsed.records.filter((record) => !isAllZeroUsage(record))
        for (const r of records) {
          if (r.errorMessage != null) r.errorMessage = truncateErrorMessage(r.errorMessage)
        }

        const costs = await ctx.pricing.calcCostBatch(records)
        for (let i = 0; i < records.length; i++) {
          const cost = costs[i]
          if (cost !== undefined) records[i].costUsd = cost
        }

        const added = await ctx.storage.recordUsage(records)
        await ctx.storage.setCursor(file.path, parsed.nextLine, file.mtime)

        imported += records.length
        addedRecords += added
      } catch (err) {
        getRuntime(plugin.id).errorCount++
        errors++
        onError(plugin.id, err)
      }
    }

    getRuntime(plugin.id).lastSyncAt = Date.now()

    return { imported, errors, addedRecords }
  }

  async function syncAll(): Promise<SyncResult> {
    let imported = 0
    let errors = 0
    let addedRecords = 0

    for (const plugin of plugins) {
      const r = await syncOne(plugin)
      imported += r.imported
      errors += r.errors
      addedRecords += r.addedRecords
    }

    if (addedRecords > 0) {
      ctx.events.emit('usage-updated', { updatedAt: Date.now(), addedRecords })
    }
    return { imported, errors, addedRecords }
  }

  async function syncPlugin(id: AppType): Promise<SyncResult> {
    const plugin = plugins.find((p) => p.id === id)
    if (!plugin) return { imported: 0, errors: 0, addedRecords: 0 }

    const result = await syncOne(plugin)
    if (result.addedRecords > 0) {
      ctx.events.emit('usage-updated', { updatedAt: Date.now(), addedRecords: result.addedRecords })
    }
    return result
  }

  function start(intervalMs: number, options?: CollectorStartOptions): void {
    if (disposer) return
    const initialSyncDelayMs = options?.initialSyncDelayMs ?? 0
    if (initialSyncDelayMs > 0) {
      initialSyncTimer = setTimeout(() => {
        initialSyncTimer = null
        void syncAll()
      }, initialSyncDelayMs)
    } else {
      void syncAll()
    }
    disposer = ctx.scheduler.schedule(intervalMs, () => void syncAll())
  }

  function stop(): void {
    if (initialSyncTimer) {
      clearTimeout(initialSyncTimer)
      initialSyncTimer = null
    }
    if (disposer) {
      disposer()
      disposer = null
    }
  }

  async function getPluginStatus(): Promise<PluginStatus[]> {
    if (statusCache !== null && Date.now() - statusCache.at < STATUS_CACHE_TTL_MS) {
      return statusCache.data
    }
    const versions = await Promise.all(
      plugins.map((plugin) => detectCliVersion(CLI_VERSION_COMMANDS[plugin.id]))
    )
    const out: PluginStatus[] = []
    for (let i = 0; i < plugins.length; i++) {
      const plugin = plugins[i]
      let det: Detection
      try {
        det = await plugin.detect(ctx)
      } catch {
        det = { available: false, reason: '检测异常' }
      }
      const r = getRuntime(plugin.id)
      const v = versions[i]
      out.push({
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        ...(v ? { cliVersion: v } : {}),
        enabled: isEnabled(plugin.id),
        available: det.available,
        ...(det.reason ? { reason: det.reason } : {}),
        ...(det.sessionDir ? { sessionDir: det.sessionDir } : {}),
        lastSyncAt: r.lastSyncAt,
        errorCount: r.errorCount
      })
    }
    statusCache = { at: Date.now(), data: out }
    return out
  }

  function invalidateStatusCache(): void {
    statusCache = null
  }

  function getErrorCount(): number {
    let total = 0
    for (const r of runtime.values()) total += r.errorCount
    return total
  }

  return { syncAll, syncPlugin, start, stop, getPluginStatus, invalidateStatusCache, getErrorCount }
}
