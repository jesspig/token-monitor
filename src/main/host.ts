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
import { codexPlugin } from './plugins/codex'
import { dshPlugin } from './plugins/dsh'
import { geminiPlugin } from './plugins/gemini'
import { grokPlugin } from './plugins/grok'
import { opencodePlugin } from './plugins/opencode'
import { piPlugin } from './plugins/pi'
import { zcodePlugin } from './plugins/zcode'
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
import { createUsageQuery, type UsageQueryService } from './services/usageQuery'
import { watcherService } from './services/watcher'

/**
 * 插件宿主（docs/concepts/architecture.md → 主进程）。
 * 组装服务容器 ctx（storage/pricing/events/scheduler/watcher）、注册 8 个内置监控插件、
 * 装载插件并把各插件会话目录注册进 watcher，向外部暴露采集器与查询/设置入口。
 */

const DEFAULT_SYNC_INTERVAL_MS = 300_000
const DEFAULT_RETENTION_DAYS = 90
/** 统计自动刷新间隔默认值（ms），渲染端查询轮询兜底用；实时性由 usage-updated 推送保证 */
const DEFAULT_STATS_REFRESH_INTERVAL_MS = 30_000
/** models.dev 定价自动同步默认周期（ms）：默认权威数据源，每 5 分钟全量同步一次 */
const DEFAULT_PRICING_SYNC_INTERVAL_MS = 300_000
const SETTINGS_FILENAME = 'settings.json'
/** 启动后延迟执行的首次过期明细清理（ms） */
const RETENTION_SWEEP_DELAY_MS = 30_000
/** 启动错峰延迟（ms）：首次立即同步之外的非关键任务依次错开，避免与首轮采集争抢 IO */
const STARTUP_PRICING_SYNC_DELAY_MS = 10_000
const STARTUP_ZERO_COST_BACKFILL_DELAY_MS = 20_000
const STARTUP_RECALC_COSTS_DELAY_MS = 30_000

export interface HostOptions {
  /** 数据目录；省略则用内存库（:memory:），适合测试 */
  dataDir?: string
  /** 兜底同步间隔（ms）；省略取持久化设置，默认 300000 */
  syncIntervalMs?: number
}

export interface Host {
  ctx: PluginContext
  registry: PluginRegistry
  lifecycle: LifecycleManager
  collector: Collector
  storage: StorageService
  /** PricingServiceImpl（含 invalidateCache，IPC 更新定价后需失效缓存） */
  pricing: PricingServiceImpl
  usageQuery: UsageQueryService
  events: EventBus
  /** 读取设置（syncIntervalMs/retentionDays/dataDir/预算限额/统计刷新与定价同步间隔） */
  getSettings(): AppSettings
  /**
   * 更新设置（持久化到 dataDir/settings.json）；同步间隔变化时重启兜底扫描，
   * 定价同步间隔变化时重启 models.dev 自动同步调度。
   */
  updateSettings(patch: Partial<AppSettings>): void
  /**
   * 预算限额状态（全局维度）：今日/本月费用与上限占比，读 usage_daily_rollups
   * 与当前设置；未设置预算=不告警。失败向上抛由 IPC 层兜底。
   */
  getBudgetStatus(): Promise<BudgetStatus>
  /**
   * 清理超过保留天数的明细（同步方法，返回删除条数）。
   * 内部调 cleanupOldRecords(db, settings.get().retentionDays)，仅清理、不含预回填
   * （调度路径 runRetentionSweep 已保证每次清理前先尽力回填零成本明细）；
   * 宿主已内置调度：启动后延迟 RETENTION_SWEEP_DELAY_MS 执行一次，此后与兜底扫描同节奏周期执行
   * （均容错，失败仅记日志）；仍可手动调用，updateSettings 更新 retentionDays 时不立即触发。
   */
  cleanupRetention(): number
  /**
   * 手动触发 models.dev 全量定价同步：syncPricing(storage)（内部以 'sync' 分级
   * upsert，user 行受保护）→ 成功后失效 pricing 缓存 → 零成本回填
   * （新价可能解锁历史零成本行，回填失败仅记日志不阻塞）。
   * 同步本身的网络/HTTP/JSON 失败向上抛，由 IPC 层兜底。
   */
  syncModelsDevPricing(): Promise<SyncResult>
  /** 按当前定价重算零成本历史明细并增量修正日聚合；启动与定价变更后（IPC 层）调用 */
  runZeroCostBackfill(): Promise<BackfillResult>
  /** 退出清理：停采集 → 卸载全部插件 → 关闭数据库 */
  dispose(): void
}

/**
 * 设置存储：dataDir 为真实目录时持久化为 settings.json，否则仅内存态（:memory:）。
 * dataDir 由宿主持有，不允许运行时改写（db 已打开）。
 */
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
    pricingSyncIntervalMs: DEFAULT_PRICING_SYNC_INTERVAL_MS
  }
  if (file) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppSettings>
      current = { ...current, ...saved, dataDir: dir }
    } catch {
      // 无设置文件或解析失败：使用默认值
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

/** 8 个内置监控插件（docs/concepts/monitor-plugins.md） */
const BUILTIN_PLUGINS: MonitorPlugin[] = [
  claudePlugin,
  codexPlugin,
  opencodePlugin,
  geminiPlugin,
  grokPlugin,
  piPlugin,
  zcodePlugin,
  dshPlugin
]

export async function createHost(options: HostOptions = {}): Promise<Host> {
  const dataDir = options.dataDir ?? ':memory:'

  // 建库：等价 openStorage，但保留 db 句柄供 usageQuery 使用
  const db = createDatabase(dataDir)
  migrate(db)
  const storage = new SqliteStorage(db)

  // 先 seed 定价再创建 pricing（其缓存惰性构建，必含 seed 项，避免缓存失效问题）
  await seedPricing(storage)
  const pricing = new PricingServiceImpl(storage)

  const events = new EventBus()
  // 复用单例调度/监听服务（每个注册都会返回独立 disposer，生命周期可逆）
  const scheduler = schedulerService
  const watcher = watcherService
  const ctx = createPluginContext({ storage, pricing, events, scheduler, watcher })

  const settings = createSettingsStore(dataDir, options.syncIntervalMs)

  const registry = new PluginRegistry()
  const lifecycle = new LifecycleManager()

  // 先创建采集器（装载时 watcher 回调依赖它）
  const collector = createCollector(ctx, BUILTIN_PLUGINS, {
    isEnabled: (id) => registry.isEnabled(id)
  })

  // 以 LifecyclePlugin 包装内置插件：装载时把该插件探测到的会话目录注册进 watcher，
  // 目录内文件变更即触发该插件的定向同步（debounce 500ms 合并高频事件）
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

  for (const p of plugins) registry.register(p)
  for (const p of plugins) await lifecycle.mount(ctx, p)

  const usageQuery = createUsageQuery(db)
  let currentSyncIntervalMs = settings.get().syncIntervalMs
  let currentPricingSyncIntervalMs = settings.get().pricingSyncIntervalMs

  // —— 过期明细清理调度（docs/concepts/data-model.md → 保留策略）——
  // collector 内部定时回调无法从外部挂钩，宿主经同一 scheduler 以相同间隔独立触发，
  // 与兜底扫描同节奏；启动后延迟 RETENTION_SWEEP_DELAY_MS 先行一次。
  // 每次清理前先尽力回填零成本明细：缺价行（cost 为空/'0'）一旦被删除，费用将永久无法回补
  // （日聚合为镜像，明细没了便再也算不出）；回填失败仅记日志，不阻塞清理。
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
    stopRetentionSweep = scheduler.schedule(intervalMs, runRetentionSweep)
  }

  startRetentionSweepLoop(currentSyncIntervalMs)
  const startupSweepTimer = setTimeout(runRetentionSweep, RETENTION_SWEEP_DELAY_MS)

  // —— models.dev 定价目录（docs/concepts/pricing.md）——
  // 零成本回填：按当前定价重算 cost 为零/空的历史明细；启动时异步执行一次（不阻塞），
  // 定价变更后由 IPC 层再次触发。结果数打日志，失败兜底不中断。
  async function runZeroCostBackfill(): Promise<BackfillResult> {
    const result = await backfillZeroCost(db, pricing)
    if (result.updated > 0) {
      console.log(
        `[host] 零成本回填完成: scanned=${result.scanned} updated=${result.updated}`
      )
    }
    return result
  }

  // 手动/定时共用的全量同步：syncPricing 内部分级 upsert → 失效缓存 → 回填；
  // 同步失败向上抛，回填失败仅记日志。
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

  startPricingAutoSync()
  // 启动错峰：定价同步/零成本回填/存量费用重算延迟触发，不与首轮采集同一时刻点火
  const startupPricingSyncTimer = setTimeout(() => {
    void syncModelsDevPricing().catch((err) => {
      console.error('[host] 启动 models.dev 定价同步失败:', err)
    })
  }, STARTUP_PRICING_SYNC_DELAY_MS)
  const startupZeroCostBackfillTimer = setTimeout(() => {
    void runZeroCostBackfill().catch((err) => {
      console.error('[host] 启动零成本回填失败:', err)
    })
  }, STARTUP_ZERO_COST_BACKFILL_DELAY_MS)

  // 计费语义修复的一次性存量修正：codex/gemini/grok 历史高估费用按活定价重算
  // （重算一致零写入，天然幂等，故只随启动执行、不挂进 models.dev 同步链路）；
  // opencode 的语义错标已由 v4 迁移直接修正。失败仅记日志，不阻塞启动。
  const startupRecalcCostsTimer = setTimeout(() => {
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

  return {
    ctx,
    registry,
    lifecycle,
    collector,
    storage,
    pricing,
    usageQuery,
    events,
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
      clearTimeout(startupSweepTimer)
      clearTimeout(startupPricingSyncTimer)
      clearTimeout(startupZeroCostBackfillTimer)
      clearTimeout(startupRecalcCostsTimer)
      stopRetentionSweep?.()
      stopRetentionSweep = null
      stopPricingAutoSync?.()
      stopPricingAutoSync = null
      collector.stop()
      for (const p of plugins) lifecycle.unmount(ctx, p)
      storage.close()
    }
  }
}
