import type { ReactElement } from 'react'
import clsx from 'clsx'
import type { RangeKey, RangeOption } from '../lib/range'

export interface RangeSelectorProps {
  value: RangeKey
  onChange: (value: RangeKey) => void
  options: RangeOption[]
}

/** 时间范围筛选（今日 / 7 天 / 30 天） */
export function RangeSelector({ value, onChange, options }: RangeSelectorProps): ReactElement {
  return (
    <div className="inline-flex rounded-lg border border-neutral-800 bg-neutral-900 p-0.5">
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => onChange(o.key)}
          className={clsx(
            'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
            value === o.key
              ? 'bg-neutral-700 text-white'
              : 'text-neutral-400 hover:text-neutral-200'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
