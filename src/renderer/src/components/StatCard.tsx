import type { ReactElement, ReactNode } from 'react'
import clsx from 'clsx'

export interface StatCardProps {
  label: string
  value: ReactNode
  sub?: ReactNode
  icon?: ReactNode
  className?: string
}

export function StatCard({ label, value, sub, icon, className }: StatCardProps): ReactElement {
  return (
    <div className={clsx('rounded-xl border border-line bg-surface-card/60 p-5', className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium tracking-wide text-content-muted">{label}</p>
        {icon && <span className="text-content-muted">{icon}</span>}
      </div>
      <p className="mt-3 text-2xl font-semibold tabular-nums text-content">{value}</p>
      {sub && <p className="mt-2 text-xs text-content-muted">{sub}</p>}
    </div>
  )
}
