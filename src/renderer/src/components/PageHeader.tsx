import type { ReactElement, ReactNode } from 'react'

export interface PageHeaderProps {
  title: string
  description?: ReactNode
  action?: ReactNode
}

export function PageHeader({ title, description, action }: PageHeaderProps): ReactElement {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-neutral-100">{title}</h1>
        {description && <p className="mt-1 text-sm text-neutral-500">{description}</p>}
      </div>
      {action}
    </div>
  )
}
