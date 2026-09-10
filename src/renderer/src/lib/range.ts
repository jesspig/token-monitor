import type { LogFilters } from '../../../../shared/query'

export type RangeKey = 'today' | '24h' | '7d' | '14d' | '30d' | 'custom'

export interface RangeOption {
  key: RangeKey
  label: string
}

export const RANGE_OPTIONS: RangeOption[] = [
  { key: 'today', label: '今日' },
  { key: '24h', label: '24 小时' },
  { key: '7d', label: '7 天' },
  { key: '14d', label: '14 天' },
  { key: '30d', label: '30 天' }
]

export const DAY_MS = 24 * 60 * 60 * 1000

export interface CustomRange {
  start: string
  end: string
}

export function startOfToday(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

export function rangeToFilters(range: RangeKey, extra: Partial<LogFilters> = {}): LogFilters {
  const now = Math.floor(Date.now() / 60_000) * 60_000
  const startTime =
    range === 'today'
      ? startOfToday()
      : range === '24h'
        ? Math.floor((now - DAY_MS) / 60_000) * 60_000
        : range === '7d'
          ? Math.floor((now - 7 * DAY_MS) / 60_000) * 60_000
          : range === '14d'
            ? Math.floor((now - 14 * DAY_MS) / 60_000) * 60_000
            : range === '30d'
              ? Math.floor((now - 30 * DAY_MS) / 60_000) * 60_000
              : (extra.startTime ?? Math.floor((now - 7 * DAY_MS) / 60_000) * 60_000)
  return { startTime, endTime: now, ...extra }
}

function parseLocalDate(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(y, mo - 1, d)
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null
  return date.getTime()
}

export function customRangeToMs(r: CustomRange): { startTime: number; endTime: number } | null {
  const start = parseLocalDate(r.start)
  const end = parseLocalDate(r.end)
  if (start == null || end == null) return null
  return { startTime: start, endTime: end + DAY_MS - 1 }
}
