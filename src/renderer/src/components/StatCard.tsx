import type { ReactElement, ReactNode } from 'react'
import clsx from 'clsx'

export interface StatCardProps {
  label: string
  value: ReactNode
  sub?: ReactNode
  icon?: ReactNode
  className?: string
}

/** 指标卡：次级指标展示 */
export function StatCard({ label, value, sub, icon, className }: StatCardProps): ReactElement {
  return (
    <div className={clsx('rounded-xl border border-neutral-800 bg-neutral-900/60 p-4', className)}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-neutral-400">{label}</p>
        {icon && <span className="text-neutral-600">{icon}</span>}
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-neutral-100">{value}</p>
      {sub && <p className="mt-1 text-[11px] text-neutral-500">{sub}</p>}
    </div>
  )
}
