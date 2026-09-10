import { useEffect, useState } from 'react'
import { AlertCircle, CheckCircle2 } from 'lucide-react'
import clsx from 'clsx'
import type { ReactElement } from 'react'

export type ToastType = 'success' | 'error'

export interface ToastItem {
  id: number
  type: ToastType
  message: string
}

interface ToastViewportProps {
  toasts: ToastItem[]
  durationMs: number
  onDismiss: (id: number) => void
}

export function ToastViewport({ toasts, durationMs, onDismiss }: ToastViewportProps): ReactElement | null {
  if (toasts.length === 0) {
    return null
  }

  return (
    <div
      aria-label="通知"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2"
    >
      {toasts.map((toast) => (
        <ToastEntry key={toast.id} toast={toast} durationMs={durationMs} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

interface ToastEntryProps {
  toast: ToastItem
  durationMs: number
  onDismiss: (id: number) => void
}

function ToastEntry({ toast, durationMs, onDismiss }: ToastEntryProps): ReactElement {
  const [entered, setEntered] = useState(false)
  const isError = toast.type === 'error'
  const Icon = isError ? AlertCircle : CheckCircle2

  useEffect(() => {
    const raf = requestAnimationFrame(() => setEntered(true))
    const timer = setTimeout(() => onDismiss(toast.id), durationMs)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(timer)
    }
  }, [durationMs, onDismiss, toast.id])

  return (
    <div
      role={isError ? 'alert' : 'status'}
      className={clsx(
        'pointer-events-auto flex items-start gap-2 rounded-lg border px-3.5 py-2.5 text-sm shadow-xl transition-all duration-150 ease-out',
        isError
          ? 'border-red-500/30 bg-neutral-900/95 text-red-300'
          : 'border-emerald-500/30 bg-neutral-900/95 text-emerald-300',
        entered ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="leading-5">{toast.message}</span>
    </div>
  )
}
