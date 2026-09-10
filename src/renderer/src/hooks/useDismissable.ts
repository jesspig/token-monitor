import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

export interface UseDismissableOptions {
  open: boolean
  onClose: () => void
  containerRef: RefObject<HTMLElement | null>
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.offsetWidth > 0 || element.offsetHeight > 0
  )
}

export function useDismissable({ open, onClose, containerRef }: UseDismissableOptions): void {
  const onCloseRef = useRef(onClose)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    onCloseRef.current = onClose
  })

  useEffect(() => {
    if (!open) {
      return
    }

    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null

    const container = containerRef.current
    if (container) {
      ;(getFocusableElements(container)[0] ?? container).focus()
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') {
        return
      }
      const current = containerRef.current
      if (!current) {
        return
      }
      const focusables = getFocusableElements(current)
      const first = focusables[0] ?? current
      const last = focusables[focusables.length - 1] ?? current
      const active = document.activeElement
      const inside = active instanceof Node && current.contains(active)
      if (event.shiftKey) {
        if (!inside || active === first || active === current) {
          event.preventDefault()
          last.focus()
        }
        return
      }
      if (!inside || active === last || active === current) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      const toRestore = restoreFocusRef.current
      restoreFocusRef.current = null
      if (toRestore && toRestore.isConnected) {
        toRestore.focus()
      }
    }
  }, [open, containerRef])
}
