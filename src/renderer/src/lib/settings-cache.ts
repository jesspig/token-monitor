import type { AppSettings } from '../../../../shared/query'

const DEFAULT_STATS_REFRESH_INTERVAL_MS = 30_000

let cachedSettings: Partial<AppSettings> | null = null

export function getStatsRefreshInterval(): number {
  return cachedSettings?.statsRefreshIntervalMs ?? DEFAULT_STATS_REFRESH_INTERVAL_MS
}

export function setCachedSettings(patch: Partial<AppSettings>): void {
  cachedSettings = { ...(cachedSettings ?? {}), ...patch }
}
