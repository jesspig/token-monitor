import type { LogFilters } from '../../../../shared/query'

/** 时间范围标识：Dashboard 与各页面的筛选选项（docs/concepts/ui-pages.md）；custom 由 RangeSelector 内联面板驱动 */
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

/** 自定义日期区间（YYYY-MM-DD，本地时区语义） */
export interface CustomRange {
  /** 起始日期 YYYY-MM-DD */
  start: string
  /** 结束日期 YYYY-MM-DD */
  end: string
}

/** 当天 00:00（epoch ms） */
export function startOfToday(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

/**
 * RangeKey → LogFilters 时间范围；extra 可叠加应用/模型/状态等筛选。
 * custom 档从 extra 取 startTime/endTime，未携带时回退最近 7 天。
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
            : range === '30d'
              ? now - 30 * DAY_MS
              : (extra.startTime ?? now - 7 * DAY_MS)
  return { startTime, endTime: now, ...extra }
}

/** 解析 YYYY-MM-DD 为当地当天 00:00；格式不符或日期不存在（如 02-31）返回 null */
function parseLocalDate(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(y, mo - 1, d)
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null
  return date.getTime()
}

/**
 * CustomRange → 毫秒区间：start 当地 00:00，end 当天 23:59:59.999。
 * 任一端解析非法返回 null（调用方应回退既有档位而非产出空查询）。
 */
export function customRangeToMs(r: CustomRange): { startTime: number; endTime: number } | null {
  const start = parseLocalDate(r.start)
  const end = parseLocalDate(r.end)
  if (start == null || end == null) return null
  return { startTime: start, endTime: end + DAY_MS - 1 }
}
