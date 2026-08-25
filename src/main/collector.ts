import type { AppType } from '../../shared/app'
import type { PluginContext } from '../../shared/context'
import type { Detection, FileEntry, UsageRecord } from '../../shared/dto'
import type { MonitorPlugin } from '../../shared/plugin'
import type { PluginStatus } from '../../shared/query'
import { CLI_VERSION_COMMANDS, detectCliVersion } from './services/cli-version'

function isAllZeroUsage(record: UsageRecord): boolean {
  return (
    record.inputTokens === 0 &&
    record.outputTokens === 0 &&
    record.cacheReadTokens === 0 &&
    record.cacheCreationTokens === 0
  )
}

/**
 * 采集器（docs/concepts/sync-mechanism.md + data-flow.md）。
 * 对传入的插件列表执行「探测 → 列文件 → 增量解析 → 计费 → 入库 → 推进游标」，
 * 并维护每个插件的运行态（最近同步时间 / 累计错误数）。
 * 单文件/单插件失败宽松兜底：只累计 errorCount，不阻塞其它插件与文件。
 */
export interface CollectorOptions {
  /** 是否启用的判定（宿主注入 registry.isEnabled；省略则恒启用） */
  isEnabled?: (id: AppType) => boolean
  /** 单插件/单文件失败时的兜底日志（默认 console.error） */
  onError?: (id: AppType, err: unknown) => void
}

export interface CollectorStartOptions {
  /** 首次同步的延迟（ms）；省略或 0 = 立即同步，用于启动错峰（窗口 show 后再触发） */
  initialSyncDelayMs?: number
}

/** 单插件运行态（宿主侧维护） */
interface PluginRuntime {
  lastSyncAt: number | null
  errorCount: number
}

/** 一次 syncAll 的统计结果 */
export interface SyncResult {
  /** 解析出的记录总数（含去重前） */
  imported: number
  /** 出错文件/插件数 */
  errors: number
  /** 实际入库条数（经过去重） */
  addedRecords: number
}

/** 采集器公开接口 */
export interface Collector {
  /** 全量/增量同步一遍所有已启用且可用的插件 */
  syncAll(): Promise<SyncResult>
  /** 定向同步单个插件（watcher 回调用）；未注册或已禁用时静默返回零值结果 */
  syncPlugin(id: AppType): Promise<SyncResult>
  /** 定时兜底扫描（scheduler）+ 首次同步（默认立即；initialSyncDelayMs 用于启动错峰） */
  start(intervalMs: number, options?: CollectorStartOptions): void
  /** 停止定时兜底扫描（可逆清理 disposer） */
  stop(): void
  /** 各插件状态（shared/query.ts PluginStatus） */
  getPluginStatus(): Promise<PluginStatus[]>
  /** 全部插件的累计错误数 */
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

  function getRuntime(id: AppType): PluginRuntime {
    let r = runtime.get(id)
    if (!r) {
      r = { lastSyncAt: null, errorCount: 0 }
      runtime.set(id, r)
    }
    return r
  }

  /** 单插件一轮同步：探测 → 列文件 → 增量解析 → 计费入库 → 推游标 */
  async function syncOne(plugin: MonitorPlugin): Promise<SyncResult> {
    let imported = 0
    let errors = 0
    let addedRecords = 0

    if (!isEnabled(plugin.id)) return { imported, errors, addedRecords }

    // 探测：CLI 未安装/无会话目录 → 跳过该插件（available 以 detect 为准）
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
        // 增量：读游标元信息（未同步过为 null）
        const meta = await ctx.storage.getCursorMeta(file.path)
        // mtime 短路：文件未变更（游标与文件 mtime 一致且均非 0）则跳过解析与入库
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

        // 费用计算回填 costUsd（无定价项则保持 undefined）
        const costs = await ctx.pricing.calcCostBatch(records)
        for (let i = 0; i < records.length; i++) {
          const cost = costs[i]
          if (cost !== undefined) records[i].costUsd = cost
        }

        const added = await ctx.storage.recordUsage(records)
        // 游标始终按 parseFile 的 nextLine 推进，避免丢行；去重由 storage 处理
        await ctx.storage.setCursor(file.path, parsed.nextLine, file.mtime)

        imported += records.length
        addedRecords += added
      } catch (err) {
        // 单文件解析抛错：宽松兜底，不阻塞其它文件/插件
        getRuntime(plugin.id).errorCount++
        errors++
        onError(plugin.id, err)
      }
    }

    // 该插件一轮处理结束：刷新最近同步时间
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

    // 有新增才推事件（200ms 防抖由 EventBus 处理）
    if (addedRecords > 0) {
      ctx.events.emit('usage-updated', { updatedAt: Date.now(), addedRecords })
    }
    return { imported, errors, addedRecords }
  }

  async function syncPlugin(id: AppType): Promise<SyncResult> {
    const plugin = plugins.find((p) => p.id === id)
    if (!plugin) return { imported: 0, errors: 0, addedRecords: 0 }

    const result = await syncOne(plugin)
    // 有新增才推事件（200ms 防抖由 EventBus 处理）
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
    return out
  }

  function getErrorCount(): number {
    let total = 0
    for (const r of runtime.values()) total += r.errorCount
    return total
  }

  return { syncAll, syncPlugin, start, stop, getPluginStatus, getErrorCount }
}
