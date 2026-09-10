import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginContext, StorageService } from '../../shared/context'
import type { Detection } from '../../shared/dto'
import type { MonitorPlugin } from '../../shared/plugin'
import type { AppSettings, BudgetStatus } from '../../shared/query'
import { getBudgetStatus as computeBudgetStatus } from './services/budget'
import { createCollector, type Collector } from './collector'
import { createPluginContext } from './core/context'
import { EventBus } from './core/event-bus'
import { LifecycleManager, type LifecyclePlugin } from './core/lifecycle'
import { PluginRegistry } from './core/registry'
import { claudePlugin } from './plugins/claude'
import { clinePlugin } from './plugins/cline'
import { codebuddyPlugin } from './plugins/codebuddy'
import { codexPlugin } from './plugins/codex'
import { commandCodePlugin } from './plugins/command-code'
import { copilotChatPlugin } from './plugins/copilot-chat'
import { dshPlugin } from './plugins/dsh'
import { geminiPlugin } from './plugins/gemini'
import { grokPlugin } from './plugins/grok'
import { kiloCodePlugin } from './plugins/kilo-code'
import { kimiPlugin } from './plugins/kimi'
import { kiroPlugin } from './plugins/kiro'
import { opencodePlugin } from './plugins/opencode'
import { piPlugin } from './plugins/pi'
import { qoderPlugin } from './plugins/qoder'
import { qoderCnPlugin } from './plugins/qoder-cn'
import { qwenPlugin } from './plugins/qwen'
import { reasonixPlugin } from './plugins/reasonix'
import { rooCodePlugin } from './plugins/roo-code'
import { workbuddyPlugin } from './plugins/workbuddy'
import { zcodePlugin } from './plugins/zcode'
import { zedPlugin } from './plugins/zed'
import { createDatabase, migrate } from './services/db'
import { syncPricing, type SyncResult } from './services/modelsdev'
import {
  backfillZeroCost,
  PricingServiceImpl,
  recalcCachedInputCosts,
  seedPricing,
  type BackfillResult
} from './services/pricing'
import { cleanupOldRecords } from './services/retention'
import { schedulerService } from './services/scheduler'
import { SqliteStorage } from './services/storage'
import { createQueryClient, type QueryClientService } from './worker/queryClient'
import { watcherService } from './services/watcher'


const DEFAULT_SYNC_INTERVAL_MS = 300_000
const DEFAULT_RETENTION_DAYS = 90
const DEFAULT_STATS_REFRESH_INTERVAL_MS = 30_000
const DEFAULT_PRICING_SYNC_INTERVAL_MS = 300_000
const SETTINGS_FILENAME = 'settings.json'
const RETENTION_SWEEP_DELAY_MS = 45_000
const RETENTION_SWEEP_PHASE_OFFSET_RATIO = 0.5
const STARTUP_PRICING_SYNC_DELAY_MS = 10_000
const STARTUP_ZERO_COST_BACKFILL_DELAY_MS = 20_000
const STARTUP_RECALC_COSTS_DELAY_MS = 30_000

export interface HostOptions {
  dataDir?: string
  syncIntervalMs?: number
}

export interface Host {
  ctx: PluginContext
  registry: PluginRegistry
  lifecycle: LifecycleManager
  collector: Collector
  storage: StorageService
  pricing: PricingServiceImpl
  usageQuery: QueryClientService
  events: EventBus
  ready: Promise<void>
  getSettings(): AppSettings
  updateSettings(patch: Partial<AppSettings>): void
  getBudgetStatus(): Promise<BudgetStatus>
  cleanupRetention(): number
  syncModelsDevPricing(): Promise<SyncResult>
  runZeroCostBackfill(): Promise<BackfillResult>
  dispose(): void
}

function createSettingsStore(
  dataDir: string,
  syncIntervalMs?: number
): { get(): AppSettings; update(patch: Partial<AppSettings>): void } {
  const isMemory = dataDir === ':memory:'
  const file = isMemory ? null : join(dataDir, SETTINGS_FILENAME)
  const dir = isMemory ? '' : dataDir

  let current: AppSettings = {
    syncIntervalMs: syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS,
    retentionDays: DEFAULT_RETENTION_DAYS,
    dataDir: dir,
    statsRefreshIntervalMs: DEFAULT_STATS_REFRESH_INTERVAL_MS,
    pricingSyncIntervalMs: DEFAULT_PRICING_SYNC_INTERVAL_MS,
    closeToTray: true
  }
  if (file) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppSettings>
      current = { ...current, ...saved, dataDir: dir }
    } catch {
    }
  }

  return {
    get: () => ({ ...current }),
    update(patch) {
      current = { ...current, ...patch, dataDir: dir }
      if (file) {
        try {
          mkdirSync(dataDir, { recursive: true })
          writeFileSync(file, JSON.stringify(current, null, 2), 'utf8')
        } catch (err) {
          console.error('[host] 设置持久化失败:', err)
        }
      }
    }
  }
}

const BUILTIN_PLUGINS: MonitorPlugin[] = [
  claudePlugin,
  codexPlugin,
  opencodePlugin,
  geminiPlugin,
  grokPlugin,
  piPlugin,
  zcodePlugin,
  dshPlugin,
  workbuddyPlugin,
  codebuddyPlugin,
  clinePlugin,
  rooCodePlugin,
  kiloCodePlugin,
  qwenPlugin,
  qoderPlugin,
  qoderCnPlugin,
  kimiPlugin,
  zedPlugin,
  kiroPlugin,
  reasonixPlugin,
  commandCodePlugin,
  copilotChatPlugin
]

export interface HostBootstrap {
  host: Host
  ready: Promise<void>
  startServices(): Promise<void>
}

export async function bootstrapHost(options: HostOptions = {}): Promise<HostBootstrap> {
  const dataDir = options.dataDir ?? ':memory:'

  const db = createDatabase(dataDir)
  migrate(db)
  const storage = new SqliteStorage(db)

  await seedPricing(storage)
  const pricing = new PricingServiceImpl(storage)

  const events = new EventBus()
  const scheduler = schedulerService
  const watcher = watcherService
  const ctx = createPluginContext({ storage, pricing, events, scheduler, watcher })

  const settings = createSettingsStore(dataDir, options.syncIntervalMs)

  const registry = new PluginRegistry()
  const lifecycle = new LifecycleManager()

  const collector = createCollector(ctx, BUILTIN_PLUGINS, {
    isEnabled: (id) => registry.isEnabled(id)
  })

  const plugins: LifecyclePlugin[] = BUILTIN_PLUGINS.map((p) => ({
    ...p,
    onMount: async (pctx): Promise<(() => void) | undefined> => {
      let det: Detection
      try {
        det = await p.detect(pctx)
      } catch {
        return undefined
      }
      if (!det.available || !det.sessionDir) return undefined
      return pctx.watcher.registerWatcher(det.sessionDir, () => void collector.syncPlugin(p.id), {
        debounceMs: 500
      })
    }
  }))

  const usageQuery = createQueryClient(dataDir, db)
  let currentSyncIntervalMs = settings.get().syncIntervalMs
  let currentPricingSyncIntervalMs = settings.get().pricingSyncIntervalMs

  async function runRetentionSweep(): Promise<void> {
    try {
      const result = await backfillZeroCost(db, pricing)
      if (result.updated > 0) {
        console.log(
          `[host] 清理前零成本回填完成: scanned=${result.scanned} updated=${result.updated}`
        )
      }
    } catch (err) {
      console.error('[host] 清理前零成本回填失败:', err)
    }
    try {
      cleanupOldRecords(db, settings.get().retentionDays)
    } catch (err) {
      console.error('[host] 过期明细清理失败:', err)
    }
  }

  let stopRetentionSweep: (() => void) | null = null

  function startRetentionSweepLoop(intervalMs: number): void {
    stopRetentionSweep?.()
    stopRetentionSweep = scheduler.schedule(
      intervalMs,
      runRetentionSweep,
      Math.floor(intervalMs * RETENTION_SWEEP_PHASE_OFFSET_RATIO)
    )
  }

  async function runZeroCostBackfill(): Promise<BackfillResult> {
    const result = await backfillZeroCost(db, pricing)
    if (result.updated > 0) {
      console.log(
        `[host] 零成本回填完成: scanned=${result.scanned} updated=${result.updated}`
      )
    }
    return result
  }

  async function syncModelsDevPricing(): Promise<SyncResult> {
    const result = await syncPricing(storage)
    pricing.invalidateCache()
    try {
      await runZeroCostBackfill()
    } catch (err) {
      console.error('[host] 同步后零成本回填失败:', err)
    }
    return result
  }

  let stopPricingAutoSync: (() => void) | null = null

  function startPricingAutoSync(): void {
    stopPricingAutoSync?.()
    const intervalMs = settings.get().pricingSyncIntervalMs ?? DEFAULT_PRICING_SYNC_INTERVAL_MS
    stopPricingAutoSync = scheduler.schedule(intervalMs, () => {
      syncModelsDevPricing().catch((err) => {
        console.error('[host] models.dev 定价自动同步失败:', err)
      })
    })
  }

  let startupSweepTimer: NodeJS.Timeout | null = null
  let startupPricingSyncTimer: NodeJS.Timeout | null = null
  let startupZeroCostBackfillTimer: NodeJS.Timeout | null = null
  let startupRecalcCostsTimer: NodeJS.Timeout | null = null

  let resolveReady!: () => void
  let rejectReady!: (err: unknown) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  let servicesPromise: Promise<void> | null = null

  function startServices(): Promise<void> {
    if (!servicesPromise) {
      servicesPromise = runServicesStartup()
    }
    return servicesPromise
  }

  async function runServicesStartup(): Promise<void> {
    try {
      for (const p of plugins) registry.register(p)
      await Promise.all(plugins.map((p) => lifecycle.mount(ctx, p)))

      startRetentionSweepLoop(currentSyncIntervalMs)
      startupSweepTimer = setTimeout(runRetentionSweep, RETENTION_SWEEP_DELAY_MS)

      startPricingAutoSync()
      startupPricingSyncTimer = setTimeout(() => {
        void syncModelsDevPricing().catch((err) => {
          console.error('[host] 启动 models.dev 定价同步失败:', err)
        })
      }, STARTUP_PRICING_SYNC_DELAY_MS)
      startupZeroCostBackfillTimer = setTimeout(() => {
        void runZeroCostBackfill().catch((err) => {
          console.error('[host] 启动零成本回填失败:', err)
        })
      }, STARTUP_ZERO_COST_BACKFILL_DELAY_MS)
      startupRecalcCostsTimer = setTimeout(() => {
        void recalcCachedInputCosts(db, pricing)
          .then((result) => {
            if (result.updated > 0) {
              console.log(
                `[host] 存量缓存口径费用重算完成: scanned=${result.scanned} updated=${result.updated}`
              )
            }
          })
          .catch((err) => {
            console.error('[host] 启动存量费用重算失败:', err)
          })
      }, STARTUP_RECALC_COSTS_DELAY_MS)

      resolveReady()
    } catch (err) {
      rejectReady(err)
      throw err
    }
  }

  const host: Host = {
    ctx,
    registry,
    lifecycle,
    collector,
    storage,
    pricing,
    usageQuery,
    events,
    ready,
    getSettings: settings.get,
    updateSettings(patch) {
      settings.update(patch)
      const next = settings.get()
      const nextSyncIntervalMs = next.syncIntervalMs
      if (nextSyncIntervalMs !== currentSyncIntervalMs) {
        currentSyncIntervalMs = nextSyncIntervalMs
        collector.stop()
        collector.start(nextSyncIntervalMs)
        startRetentionSweepLoop(nextSyncIntervalMs)
      }
      const nextPricingSyncIntervalMs = next.pricingSyncIntervalMs
      if (nextPricingSyncIntervalMs !== currentPricingSyncIntervalMs) {
        currentPricingSyncIntervalMs = nextPricingSyncIntervalMs
        startPricingAutoSync()
      }
    },
    getBudgetStatus() {
      return Promise.resolve(computeBudgetStatus(db, settings.get()))
    },
    cleanupRetention() {
      return cleanupOldRecords(db, settings.get().retentionDays)
    },
    syncModelsDevPricing,
    runZeroCostBackfill,
    dispose() {
      if (startupSweepTimer) {
        clearTimeout(startupSweepTimer)
        startupSweepTimer = null
      }
      if (startupPricingSyncTimer) {
        clearTimeout(startupPricingSyncTimer)
        startupPricingSyncTimer = null
      }
      if (startupZeroCostBackfillTimer) {
        clearTimeout(startupZeroCostBackfillTimer)
        startupZeroCostBackfillTimer = null
      }
      if (startupRecalcCostsTimer) {
        clearTimeout(startupRecalcCostsTimer)
        startupRecalcCostsTimer = null
      }
      stopRetentionSweep?.()
      stopRetentionSweep = null
      stopPricingAutoSync?.()
      stopPricingAutoSync = null
      collector.stop()
      for (const p of plugins) {
        if (lifecycle.isMounted(p.id)) lifecycle.unmount(ctx, p)
      }
      storage.close()
      usageQuery.terminate()
    }
  }

  return { host, ready, startServices }
}

export async function createHost(options: HostOptions = {}): Promise<Host> {
  const boot = await bootstrapHost(options)
  await boot.startServices()
  return boot.host
}
