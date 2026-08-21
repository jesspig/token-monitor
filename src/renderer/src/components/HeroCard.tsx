import type { ReactElement, ReactNode } from 'react'
import clsx from 'clsx'

export interface HeroCardProps {
  label: string
  value: ReactNode
  hint?: ReactNode
  icon?: ReactNode
  className?: string
}

/** Hero 汇总卡：主指标大字号展示（Dashboard 顶部） */
export function HeroCard({ label, value, hint, icon, className }: HeroCardProps): ReactElement {
  return (
    <div
      className={clsx(
        'relative overflow-hidden rounded-xl border border-neutral-800 bg-gradient-to-br from-neutral-800/70 to-neutral-900 p-5',
        className
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">{label}</p>
        {icon && <span className="text-neutral-500">{icon}</span>}
      </div>
      <p className="mt-3 text-3xl font-semibold tabular-nums text-white">{value}</p>
      {hint && <div className="mt-2 text-xs text-neutral-400">{hint}</div>}
    </div>
  )
}
