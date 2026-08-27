import type { AppType } from '../../../../shared/app'

/** 应用徽标样式（完整类名，确保 Tailwind JIT 可收集） */
export const APP_META: Record<AppType, { label: string; badge: string }> = {
  claude: { label: 'Claude', badge: 'bg-orange-500/15 text-orange-300 border-orange-500/30' },
  codex: { label: 'Codex', badge: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  opencode: { label: 'OpenCode', badge: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
  gemini: { label: 'Gemini', badge: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
  grok: { label: 'Grok', badge: 'bg-violet-500/15 text-violet-300 border-violet-500/30' },
  pi: { label: 'Pi', badge: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  zcode: { label: 'ZCode', badge: 'bg-rose-500/15 text-rose-300 border-rose-500/30' },
  dsh: { label: 'DSH', badge: 'bg-teal-500/15 text-teal-300 border-teal-500/30' }
}

/**
 * 完整数字展示（千分位，不缩写）：用量统计一律显示原始数值，
 * 不折叠为万/亿/k/M，避免阅读者换算；zh 用 zh-CN 千分位、其余用 en-US。
 */
export function formatNumber(n: number, locale?: string): string {
  const lang = locale ?? (typeof navigator !== 'undefined' ? navigator.language : 'en')
  return n.toLocaleString(lang.startsWith('zh') ? 'zh-CN' : 'en-US')
}

export function formatTokens(n: number, locale?: string): string {
  return formatNumber(n, locale)
}

/** 金额：字符串（避免浮点误差，见 docs/concepts/pricing.md）或数字 → $ 展示 */
export function formatUsd(cost: string | number | null | undefined): string {
  if (cost == null || cost === '') return '—'
  const num = typeof cost === 'string' ? Number.parseFloat(cost) : cost
  if (!Number.isFinite(num)) return '—'
  if (num === 0) return '$0.00'
  if (num < 0.01) return `$${num.toFixed(4)}`
  if (num < 100) return `$${num.toFixed(2)}`
  return `$${num.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

export function formatPercent(rate: number): string {
  if (!Number.isFinite(rate)) return '—'
  return `${(rate * 100).toFixed(1)}%`
}

export function formatDateTime(ms: number): string {
  const d = new Date(ms)
  const pad = (v: number): string => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 小时标签（趋势横轴用）：HH:00 */
export function formatHour(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:00`
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
