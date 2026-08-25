import type { AppSettings } from '../../../../shared/query'

const DEFAULT_STATS_REFRESH_INTERVAL_MS = 30_000

let cachedSettings: Partial<AppSettings> | null = null

/** 读取统计自动刷新间隔（ms）：优先取最近一次已知设置，缺省兜底 30000。实时性由 usage-updated 推送保证，轮询仅作兜底 */
export function getStatsRefreshInterval(): number {
  return cachedSettings?.statsRefreshIntervalMs ?? DEFAULT_STATS_REFRESH_INTERVAL_MS
}

/** 保存最近一次已知设置（浅合并 patch），供刷新间隔等运行时行为动态读取 */
export function setCachedSettings(patch: Partial<AppSettings>): void {
  cachedSettings = { ...(cachedSettings ?? {}), ...patch }
}
