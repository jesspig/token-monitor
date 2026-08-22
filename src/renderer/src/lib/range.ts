import type { LogFilters } from '../../../../shared/query'

/** 时间范围标识：Dashboard 与各页面的筛选选项（docs/concepts/ui-pages.md） */
export type RangeKey = 'today' | '24h' | '7d' | '14d' | '30d'

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

/** 当天 00:00（epoch ms） */
export function startOfToday(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

/**
 * RangeKey → LogFilters 时间范围；extra 可叠加应用/模型/状态等筛选。
 * 对齐 shared/query.ts 的 LogFilters 契约。
 */
export function rangeToFilters(range: RangeKey, extra: Partial<LogFilters> = {}): LogFilters {
  const now = Date.now()
  const startTime =
    range === 'today'
      ? startOfToday()
      : range === '24h'
        ? now - DAY_MS
        : range === '7d'
          ? now - 7 * DAY_MS
          : range === '14d'
            ? now - 14 * DAY_MS
            : now - 30 * DAY_MS
  return { startTime, endTime: now, ...extra }
}
