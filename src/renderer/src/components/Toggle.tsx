import clsx from 'clsx'
import type { ReactElement } from 'react'

export interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  id?: string
  label?: string
}

export function Toggle({
  checked,
  onChange,
  disabled = false,
  id,
  label
}: ToggleProps): ReactElement {
  const switchButton = (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'inline-flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success-bright/60 disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-success-bright' : 'bg-line-strong'
      )}
    >
      <span
        className={clsx(
          'h-4 w-4 rounded-full bg-white shadow transition-transform duration-200',
          checked ? 'translate-x-4' : 'translate-x-0'
        )}
      />
    </button>
  )
  if (label == null) return switchButton
  return (
    <span className="inline-flex items-center gap-2">
      {switchButton}
      <label htmlFor={id} className="cursor-pointer select-none text-sm text-content-secondary">
        {label}
      </label>
    </span>
  )
}
