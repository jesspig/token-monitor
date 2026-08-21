import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginContext, StorageService } from '../../shared/context'
import type { Detection } from '../../shared/dto'
import type { MonitorPlugin } from '../../shared/plugin'
import type { AppSettings } from '../../shared/query'
import { createCollector, type Collector } from './collector'
import { createPluginContext } from './core/context'
import { EventBus } from './core/event-bus'
import { LifecycleManager, type LifecyclePlugin } from './core/lifecycle'
import { PluginRegistry } from './core/registry'
import { claudePlugin } from './plugins/claude'
import { codexPlugin } from './plugins/codex'
import { geminiPlugin } from './plugins/gemini'
import { grokPlugin } from './plugins/grok'
import { opencodePlugin } from './plugins/opencode'
import { createDatabase, migrate } from './services/db'
import { PricingServiceImpl, seedPricing } from './services/pricing'
import { cleanupOldRecords } from './services/retention'
import { schedulerService } from './services/scheduler'
import { SqliteStorage } from './services/storage'
import { createUsageQuery, type UsageQueryService } from './services/usageQuery'
import { watcherService } from './services/watcher'

/**
 * 插件宿主（docs/concepts/architecture.md → 主进程）。
 * 组装服务容器 ctx（storage/pricing/events/scheduler/watcher）、注册 5 个内置监控插件、
 * 装载插件并把各插件会话目录注册进 watcher，向外部暴露采集器与查询/设置入口。
 */

const DEFAULT_SYNC_INTERVAL_MS = 300_000
const DEFAULT_RETENTION_DAYS = 90
const SETTINGS_FILENAME = 'settings.json'

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
  /** 读取设置（syncIntervalMs/retentionDays/dataDir） */
  getSettings(): AppSettings
  /** 更新设置（持久化到 dataDir/settings.json）；同步间隔变化时重启兜底扫描 */
  updateSettings(patch: Partial<AppSettings>): void
  /**
   * 清理超过保留天数的明细（同步方法，返回删除条数）。
   * 内部调 cleanupOldRecords(db, settings.get().retentionDays)；由调用方（定时/手动）触发，
   * updateSettings 更新 retentionDays 时不自动触发清理。
   */
  cleanupRetention(): number
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
    dataDir: dir
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

/** 第一阶段 5 个内置监控插件（docs/concepts/monitor-plugins.md） */
const BUILTIN_PLUGINS: MonitorPlugin[] = [
  claudePlugin,
  codexPlugin,
  opencodePlugin,
  geminiPlugin,
  grokPlugin
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
  // 目录内文件变更即触发全量同步（debounce 500ms 合并高频事件）
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
      return pctx.watcher.registerWatcher(det.sessionDir, () => void collector.syncAll(), {
        debounceMs: 500
      })
    }
  }))

  for (const p of plugins) registry.register(p)
  for (const p of plugins) await lifecycle.mount(ctx, p)

  const usageQuery = createUsageQuery(db)
  let currentSyncIntervalMs = settings.get().syncIntervalMs

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
      const next = settings.get().syncIntervalMs
      if (next !== currentSyncIntervalMs) {
        currentSyncIntervalMs = next
        collector.stop()
        collector.start(next)
      }
    },
    cleanupRetention() {
      return cleanupOldRecords(db, settings.get().retentionDays)
    },
    dispose() {
      collector.stop()
      for (const p of plugins) lifecycle.unmount(ctx, p)
      storage.close()
    }
  }
}
