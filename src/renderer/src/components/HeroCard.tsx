import type { ReactElement, ReactNode } from 'react'
import clsx from 'clsx'

export interface HeroCardProps {
  label: string
  value: ReactNode
  hint?: ReactNode
  icon?: ReactNode
  className?: string
}

export function HeroCard({ label, value, hint, icon, className }: HeroCardProps): ReactElement {
  return (
    <div
      className={clsx(
        'relative overflow-hidden rounded-xl border border-line bg-gradient-to-br from-surface-raised/70 to-surface-card p-5',
        className
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium tracking-wide text-content-muted">{label}</p>
        {icon && <span className="text-content-muted">{icon}</span>}
      </div>
      <p className="mt-3 text-3xl font-semibold tabular-nums text-content">{value}</p>
      {hint && <div className="mt-2 text-xs text-content-muted">{hint}</div>}
    </div>
  )
}
