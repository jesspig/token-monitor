import type { ReactElement } from 'react'
import { Inbox } from 'lucide-react'

export interface EmptyStateProps {
  title?: string
  description?: string
}

/** 空态 / Mock 等待提示（Mock 模式下展示「等待真实数据」） */
export function EmptyState({
  title = '等待真实数据',
  description
}: EmptyStateProps): ReactElement {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-neutral-800 bg-neutral-900/40 px-6 py-12 text-center">
      <Inbox className="mb-3 h-8 w-8 text-neutral-600" />
      <p className="text-sm font-medium text-neutral-300">{title}</p>
      {description && <p className="mt-1 max-w-md text-xs text-neutral-500">{description}</p>}
    </div>
  )
}
