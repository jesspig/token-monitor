import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { ToastViewport } from '../components/Toast'
import type { ToastItem, ToastType } from '../components/Toast'

interface ToastContextValue {
  success: (message: string) => void
  error: (message: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const TOAST_DURATION_MS = 2800
const MAX_TOASTS = 4

export function ToastProvider({ children }: { children: ReactNode }): ReactElement {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextIdRef = useRef(0)

  const dismiss = useCallback((id: number): void => {
    setToasts((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const push = useCallback((type: ToastType, message: string): void => {
    nextIdRef.current += 1
    const item: ToastItem = { id: nextIdRef.current, type, message }
    setToasts((prev) => [...prev, item].slice(-MAX_TOASTS))
  }, [])

  const value = useMemo<ToastContextValue>(
    () => ({
      success: (message) => push('success', message),
      error: (message) => push('error', message)
    }),
    [push]
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} durationMs={TOAST_DURATION_MS} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    throw new Error('useToast 必须在 <ToastProvider> 内使用')
  }
  return ctx
}
