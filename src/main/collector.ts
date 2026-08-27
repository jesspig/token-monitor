import type { AppType } from '../../shared/app'
import type { PluginContext } from '../../shared/context'
import type { Detection, FileEntry, UsageRecord } from '../../shared/dto'
import type { MonitorPlugin } from '../../shared/plugin'
import type { PluginStatus } from '../../shared/query'
import { ERROR_MESSAGE_MAX_LENGTH } from '../../shared/failure'
import { CLI_VERSION_COMMANDS, detectCliVersion } from './services/cli-version'

/**
 * 全零过滤谓词：四项 token 全 0 视为无效空转，拦截不入库（游标仍推进）。
 * 失败语义例外（T01 矩阵 / shared/failure.ts）：status === 'error' 的记录即使全零也放行，
 * 确保失败请求可观测入库；成功记录仍保持全零跳过。
 * cancelled / interrupted 属用户中断忽略，由插件层决定不产 error，本层不特殊处理。
 * 性能：失败放行仅增加一次 `status === 'error'` 字符串比较，O(1) 无分支预测开销，
 *       不引入额外索引/查询/正则，过滤仍为单次四字段数值比较，热点路径零回退。
 */
function isAllZeroUsage(record: UsageRecord): boolean {
  if (record.status === 'error') return false
  return (
    record.inputTokens === 0 &&
    record.outputTokens === 0 &&
    record.cacheReadTokens === 0 &&
    record.cacheCreationTokens === 0
  )
}

/**
 * 失败文案截断至 shared/failure.ts 约束长度（500），DTO 层不限长，入库前收敛
 * 性能：单次 `String.slice(0, 500)`，O(1) 截断，无正则/循环/分配放大；
 *       仅对含 errorMessage 的失败记录执行，成功记录零开销。
 */
function truncateErrorMessage(message: string | undefined): string | undefined {
  if (message == null) return undefined
  return message.length > ERROR_MESSAGE_MAX_LENGTH
    ? message.slice(0, ERROR_MESSAGE_MAX_LENGTH)
    : message
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

/** 插件状态缓存 TTL：监控源页的周期轮询经此挡住高频 detect（pi/dsh 为目录树遍历） */
const STATUS_CACHE_TTL_MS = 5_000

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
  /** 各插件状态（shared/query.ts PluginStatus）；TTL 缓存内直接复用上次结果 */
  getPluginStatus(): Promise<PluginStatus[]>
  /** 使插件状态缓存失效（启停插件等状态变更路径调用，保证下一次查询即时反映） */
  invalidateStatusCache(): void
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
  let statusCache: { at: number; data: PluginStatus[] } | null = null

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
        // mtime 短路（性能核心）：文件未变更（游标与文件 mtime 一致且均非 0）则跳过解析与入库，
        // 避免对未变更大文件（如 dsh zstd/大 JSONL）做全量读取与 JSON.parse；失败接入未改动此短路，游标仍为唯一增量依据
        if (
          meta !== null &&
          file.mtime > 0 &&
          meta.fileMtime === file.mtime &&
          meta.lineOffset > 0
        ) {
          continue
        }
        const parsed = await plugin.parseFile(ctx, file.path, meta?.lineOffset ?? 0)
        // 性能：isAllZeroUsage 失败放行仅多一次 status 比较，O(1)，不过滤逻辑仍为四字段数值比较，无索引依赖
        const records = parsed.records.filter((record) => !isAllZeroUsage(record))
        // 失败文案入库前截断至 ERROR_MESSAGE_MAX_LENGTH（500，shared/failure.ts SSOT），DTO 层不限长
        // 性能：单次 slice 截断，无正则/全表扫描，仅失败记录命中
        for (const r of records) {
          if (r.errorMessage != null) r.errorMessage = truncateErrorMessage(r.errorMessage)
        }

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
