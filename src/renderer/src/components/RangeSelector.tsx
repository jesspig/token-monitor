import { useState } from 'react'
import type { ReactElement } from 'react'
import clsx from 'clsx'
import { customRangeToMs, type CustomRange, type RangeKey, type RangeOption } from '../lib/range'

export interface RangeSelectorProps {
  value: RangeKey
  onChange: (value: RangeKey) => void
  options: RangeOption[]
  customRange?: CustomRange | null
  onCustomRangeChange?: (r: CustomRange | null) => void
}

const DATE_INPUT_CLASS =
  'min-w-0 flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-200 [color-scheme:dark] focus:border-neutral-600 focus:outline-none'

export function RangeSelector({
  value,
  onChange,
  options,
  customRange,
  onCustomRangeChange
}: RangeSelectorProps): ReactElement {
  const [panelOpen, setPanelOpen] = useState(false)
  const [draftStart, setDraftStart] = useState('')
  const [draftEnd, setDraftEnd] = useState('')
  const customEnabled = onCustomRangeChange !== undefined

  const togglePanel = (): void => {
    setDraftStart(customRange?.start ?? '')
    setDraftEnd(customRange?.end ?? '')
    setPanelOpen((v) => !v)
  }

  const draftValid =
    draftStart !== '' && draftEnd !== '' && customRangeToMs({ start: draftStart, end: draftEnd }) !== null && draftStart <= draftEnd

  const applyDraft = (): void => {
    if (!draftValid || !onCustomRangeChange) return
    onCustomRangeChange({ start: draftStart, end: draftEnd })
    onChange('custom')
    setPanelOpen(false)
  }

  const clearCustom = (): void => {
    onCustomRangeChange?.(null)
    onChange('7d')
    setPanelOpen(false)
  }

  return (
    <div className="relative inline-flex rounded-lg border border-neutral-800 bg-neutral-900 p-0.5">
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
      {customEnabled && (
        <>
          <button
            type="button"
            aria-expanded={panelOpen}
            onClick={togglePanel}
            className={clsx(
              'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              value === 'custom'
                ? 'bg-neutral-700 text-white'
                : 'text-neutral-400 hover:text-neutral-200'
            )}
          >
            自定义
          </button>
          {panelOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setPanelOpen(false)} />
              <div className="absolute left-0 top-full z-40 mt-1 w-72 rounded-lg border border-neutral-800 bg-neutral-900 p-3 shadow-xl">
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    value={draftStart}
                    max={draftEnd || undefined}
                    onChange={(e) => setDraftStart(e.target.value)}
                    aria-label="开始日期"
                    className={DATE_INPUT_CLASS}
                  />
                  <span className="shrink-0 text-xs text-neutral-500">至</span>
                  <input
                    type="date"
                    value={draftEnd}
                    min={draftStart || undefined}
                    onChange={(e) => setDraftEnd(e.target.value)}
                    aria-label="结束日期"
                    className={DATE_INPUT_CLASS}
                  />
                </div>
                <div className="mt-3 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={clearCustom}
                    className="rounded-md border border-neutral-800 px-2.5 py-1 text-xs text-neutral-400 transition-colors hover:text-neutral-200"
                  >
                    清除
                  </button>
                  <button
                    type="button"
                    disabled={!draftValid}
                    onClick={applyDraft}
                    className="rounded-md border border-neutral-600 bg-neutral-700 px-2.5 py-1 text-xs text-white transition-colors disabled:opacity-40"
                  >
                    应用
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
