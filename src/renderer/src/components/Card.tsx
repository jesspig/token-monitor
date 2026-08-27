import type { ReactElement, ReactNode } from 'react'
import clsx from 'clsx'

export interface CardProps {
  title?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}

export function Card({ title, action, children, className }: CardProps): ReactElement {
  return (
    <section className={clsx('rounded-xl border border-neutral-800 bg-neutral-900/60', className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-3">
          {title ? <h2 className="text-sm font-medium text-neutral-300">{title}</h2> : <span />}
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}
