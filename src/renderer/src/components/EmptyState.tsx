import type { ReactElement, ReactNode } from 'react'
import { Inbox } from 'lucide-react'

export interface EmptyStateProps {
  title?: string
  description?: string
  action?: ReactNode
}

export function EmptyState({
  title = '暂无数据',
  description,
  action
}: EmptyStateProps): ReactElement {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-neutral-800 bg-neutral-900/40 px-6 py-12 text-center">
      <Inbox className="mb-3 h-8 w-8 text-neutral-600" />
      <p className="text-sm font-medium text-neutral-300">{title}</p>
      {description && <p className="mt-1 max-w-md text-xs text-neutral-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
