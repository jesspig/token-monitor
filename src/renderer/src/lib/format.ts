import type { AppType } from '../../../../shared/app'

export const APP_META: Record<AppType, { label: string; badge: string }> = {
  claude: { label: 'Claude', badge: 'bg-orange-500/15 text-orange-300 border-orange-500/30' },
  codex: { label: 'Codex', badge: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  opencode: { label: 'OpenCode', badge: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
  gemini: { label: 'Gemini', badge: 'bg-blue-500/15 text-blue-300 border-blue-500/30' },
  grok: { label: 'Grok', badge: 'bg-violet-500/15 text-violet-300 border-violet-500/30' },
  pi: { label: 'Pi', badge: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  zcode: { label: 'ZCode', badge: 'bg-rose-500/15 text-rose-300 border-rose-500/30' },
  dsh: { label: 'DSH', badge: 'bg-teal-500/15 text-teal-300 border-teal-500/30' },
  workbuddy: { label: 'WorkBuddy', badge: 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30' },
  codebuddy: { label: 'CodeBuddy', badge: 'bg-purple-500/15 text-purple-300 border-purple-500/30' },
  cline: { label: 'Cline', badge: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30' },
  'roo-code': { label: 'Roo Code', badge: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' },
  'kilo-code': { label: 'Kilo Code', badge: 'bg-lime-500/15 text-lime-300 border-lime-500/30' },
  qwen: { label: 'Qwen Code', badge: 'bg-green-500/15 text-green-300 border-green-500/30' },
  qoder: { label: 'Qoder', badge: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/30' },
  'qoder-cn': { label: 'Qoder CN', badge: 'bg-pink-500/15 text-pink-300 border-pink-500/30' },
  kimi: { label: 'Kimi Code', badge: 'bg-red-500/15 text-red-300 border-red-500/30' },
  zed: { label: 'Zed', badge: 'bg-slate-500/15 text-slate-300 border-slate-500/30' },
  kiro: { label: 'Kiro CLI', badge: 'bg-stone-500/15 text-stone-300 border-stone-500/30' },
  reasonix: { label: 'Reasonix', badge: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30' },
  'command-code': { label: 'Command Code', badge: 'bg-gray-500/15 text-gray-300 border-gray-500/30' },
  'copilot-chat': { label: 'Copilot Chat', badge: 'bg-neutral-500/15 text-neutral-300 border-neutral-500/30' }
}

export function formatNumber(n: number, locale?: string): string {
  const lang = locale ?? (typeof navigator !== 'undefined' ? navigator.language : 'en')
  return n.toLocaleString(lang.startsWith('zh') ? 'zh-CN' : 'en-US')
}

export function formatTokens(n: number, locale?: string): string {
  return formatNumber(n, locale)
}

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

export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${(n / 1_000).toFixed(0)}k`
  return String(n)
}

export function formatDateTime(ms: number): string {
  const d = new Date(ms)
  const pad = (v: number): string => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function formatHour(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:00`
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
