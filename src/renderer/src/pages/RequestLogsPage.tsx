import { useEffect, useMemo, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { ChevronDown, ChevronLeft, ChevronRight, Search, X } from 'lucide-react'
import type { AppType, RequestStatus } from '../../../../shared/app'
import type { LogFilters, RequestLogDetail } from '../../../../shared/query'
import { api } from '../api'
import { useFilter } from '../context/FilterContext'
import { useNav } from '../context/NavContext'
import { EmptyState } from '../components/EmptyState'
import { PageHeader } from '../components/PageHeader'
import { RangeSelector } from '../components/RangeSelector'
import { useDebouncedValue } from '../hooks/useDebouncedValue'
import { useRequestLogs } from '../hooks/useRequestLogs'
import {
  APP_META,
  formatDateTime,
  formatDuration,
  formatTokens,
  formatUsd
} from '../lib/format'
import { RANGE_OPTIONS, customRangeToMs, rangeToFilters, type CustomRange, type RangeKey } from '../lib/range'

type StatusFilter = 'all' | 'success' | 'error'

const APP_TYPES = Object.keys(APP_META) as AppType[]

const INPUT_SEMANTICS_LABEL: Record<number, string> = {
  0: '未知',
  1: '含缓存写',
  2: '纯新输入'
}

const TH = 'px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-neutral-500'
const TD = 'px-3 py-2 text-sm text-neutral-300'

const MODEL_FILTER_RENDER_LIMIT = 200

const ERROR_PREVIEW_LEN = 64

function truncateError(msg: string, len = ERROR_PREVIEW_LEN): string {
  return msg.length > len ? `${msg.slice(0, len)}…` : msg
}

const KEYWORD_DEBOUNCE_MS = 300

export default function RequestLogsPage(): ReactElement {
  const sharedFilter = useFilter()
  const [range, setRange] = useState<RangeKey>('30d')
  const [customRange, setCustomRange] = useState<CustomRange | null>(null)
  const [appTypes, setAppTypes] = useState<AppType[]>([])
  const [models, setModels] = useState<string[]>([])
  const [project, setProject] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const debouncedKeyword = useDebouncedValue(keyword, KEYWORD_DEBOUNCE_MS)
  useEffect(() => {
    setPage(1)
  }, [debouncedKeyword])

  useEffect(() => {
    if (sharedFilter.filter.appTypes) setAppTypes(sharedFilter.filter.appTypes)
    if (sharedFilter.filter.models) setModels(sharedFilter.filter.models)
    if (sharedFilter.filter.project) setProject(sharedFilter.filter.project)
  }, [sharedFilter.filter.appTypes, sharedFilter.filter.models, sharedFilter.filter.project])

  const { data: filterOptions } = useQuery({
    queryKey: ['filter-options'],
    queryFn: () => api.getFilterOptions(),
    staleTime: 10 * 60 * 1000
  })
  const projectOptions = filterOptions?.projects ?? []
  const knownProject = projectOptions.includes(project) ? project : undefined

  const filters = useMemo<LogFilters>(
    () => ({
      ...(range === 'custom' && customRange
        ? rangeToFilters('custom', customRangeToMs(customRange) ?? {})
        : rangeToFilters(range)),
      appTypes: appTypes.length > 0 ? appTypes : undefined,
      models: models.length > 0 ? models : undefined,
      status: status === 'all' ? undefined : status,
      keyword: debouncedKeyword.trim() ? debouncedKeyword.trim() : undefined,
      project: knownProject,
      page,
      pageSize: 15
    }),
    [range, customRange, appTypes, models, status, debouncedKeyword, knownProject, page]
  )

  const { data, isLoading } = useRequestLogs(filters)
  const totalPages = Math.max(1, data?.totalPages ?? 1)
  const expanded = data?.items.find((r) => r.id === expandedId) ?? null

  const changeRange = (r: RangeKey): void => {
    setRange(r)
    setPage(1)
  }

  const changeCustomRange = (r: CustomRange | null): void => {
    setCustomRange(r)
    setPage(1)
  }

  const toggleApp = (app: AppType): void => {
    setAppTypes((prev) => (prev.includes(app) ? prev.filter((a) => a !== app) : [...prev, app]))
    setPage(1)
  }

  const clearApps = (): void => {
    setAppTypes([])
    setPage(1)
  }

  const changeStatus = (s: StatusFilter): void => {
    setStatus(s)
    setPage(1)
  }

  const toggleModel = (m: string): void => {
    setModels((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]))
    setPage(1)
  }

  const clearModels = (): void => {
    setModels([])
    setPage(1)
  }

  const changeProject = (p: string): void => {
    setProject(p)
    setPage(1)
  }

  return (
    <div className="space-y-6">
      <PageHeader title="请求日志" description="按应用 / 模型 / 项目 / 时间 / 状态筛选的用量明细" />

      {}
      <div className="flex flex-wrap items-center gap-2">
        <RangeSelector
          value={range}
          onChange={changeRange}
          options={RANGE_OPTIONS}
          customRange={customRange}
          onCustomRangeChange={changeCustomRange}
        />

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={clearApps}
            className={clsx(
              'rounded-md border px-2 py-1 text-[11px] transition-colors',
              appTypes.length === 0
                ? 'border-neutral-600 bg-neutral-700 text-white'
                : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
            )}
          >
            全部
          </button>
          {APP_TYPES.map((app) => {
            const active = appTypes.includes(app)
            return (
              <button
                key={app}
                type="button"
                onClick={() => toggleApp(app)}
                aria-pressed={active}
                className={clsx(
                  'rounded-md border px-2 py-1 text-[11px] transition-colors',
                  active
                    ? APP_META[app].badge
                    : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                )}
              >
                {APP_META[app].label}
              </button>
            )
          })}
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-600" />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索模型 / 会话 / 项目…"
            className="w-56 rounded-lg border border-neutral-800 bg-neutral-900 py-1.5 pl-8 pr-3 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
          />
        </div>

        <select
          value={status}
          onChange={(e) => changeStatus(e.target.value as StatusFilter)}
          className="rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 focus:border-neutral-600 focus:outline-none"
        >
          <option value="all">全部状态</option>
          <option value="success">成功</option>
          <option value="error">失败</option>
        </select>

        <ModelFilter
          options={filterOptions?.models ?? []}
          selected={models}
          onToggle={toggleModel}
          onClear={clearModels}
        />

        <select
          value={knownProject ?? ''}
          onChange={(e) => changeProject(e.target.value)}
          aria-label="按项目筛选"
          className="max-w-44 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 focus:border-neutral-600 focus:outline-none"
        >
          <option value="">全部项目</option>
          {projectOptions.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>

      {isLoading && !data ? (
        <EmptyState title="加载中…" description="正在获取请求日志。" />
      ) : data && data.items.length === 0 ? (
        <EmptyState
          title="等待真实数据"
          description="当前筛选条件下暂无日志，接入真实 IPC 后端后展示明细。"
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-neutral-800 bg-neutral-900/60">
          <table className="w-full min-w-[1100px] border-collapse">
            <thead>
              <tr className="border-b border-neutral-800 bg-neutral-900">
                <th className={TH}>时间</th>
                <th className={TH}>应用</th>
                <th className={TH}>模型</th>
                <th className={TH}>输入</th>
                <th className={TH}>输出</th>
                <th className={TH}>缓存读</th>
                <th className={TH}>缓存写</th>
                <th className={TH}>费用</th>
                <th className={TH}>耗时</th>
                <th className={TH}>状态</th>
                <th className={TH}>错误</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((r) => (
                <Row
                  key={r.id}
                  record={r}
                  expanded={expandedId === r.id}
                  onToggle={() => setExpandedId(expandedId === r.id ? null : r.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {expanded && <DetailDrawer record={expanded} onClose={() => setExpandedId(null)} />}

      {data && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-neutral-400">
          <span>
            共 {data.total} 条 · 第 {page} / {totalPages} 页
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="inline-flex items-center gap-1 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> 上一页
            </button>
            {pageList(page, totalPages).map((p, i) =>
              p === 'left-gap' || p === 'right-gap' ? (
                <span key={`gap-${i}`} className="px-1 text-neutral-600">
                  …
                </span>
              ) : (
                <button
                  key={p}
                  type="button"
                  disabled={p === page}
                  onClick={() => setPage(p)}
                  className={clsx(
                    'min-w-7 rounded-md border px-2 py-1 text-xs tabular-nums transition-colors',
                    p === page
                      ? 'border-neutral-600 bg-neutral-700 text-white'
                      : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
                  )}
                >
                  {p}
                </button>
              )
            )}
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="inline-flex items-center gap-1 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs disabled:opacity-40"
            >
              下一页 <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function ModelFilter({
  options,
  selected,
  onToggle,
  onClear
}: {
  options: string[]
  selected: string[]
  onToggle: (model: string) => void
  onClear: () => void
}): ReactElement {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const keyword = query.trim().toLowerCase()
  const filtered = keyword === '' ? options : options.filter((m) => m.toLowerCase().includes(keyword))
  const visible = filtered.slice(0, MODEL_FILTER_RENDER_LIMIT)
  const hiddenCount = filtered.length - visible.length

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v)
          setQuery('')
        }}
        className={clsx(
          'inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs transition-colors',
          selected.length > 0
            ? 'border-neutral-600 bg-neutral-700 text-white'
            : 'border-neutral-800 bg-neutral-900 text-neutral-400 hover:text-neutral-200'
        )}
      >
        模型{selected.length > 0 ? ` · ${selected.length}` : ''}
        <ChevronDown className="h-3 w-3" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-40 mt-1 w-64 rounded-lg border border-neutral-800 bg-neutral-950 shadow-xl">
            <header className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
              <span className="text-[11px] uppercase tracking-wide text-neutral-500">
                模型筛选
              </span>
              <button
                type="button"
                disabled={selected.length === 0}
                onClick={onClear}
                className="text-[11px] text-neutral-400 transition-colors hover:text-neutral-200 disabled:opacity-40"
              >
                清空
              </button>
            </header>
            <div className="border-b border-neutral-800 p-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="输入过滤模型…"
                className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
              />
            </div>
            <div className="max-h-64 overflow-y-auto p-1">
              {options.length === 0 ? (
                <p className="px-2 py-3 text-xs text-neutral-600">暂无模型数据</p>
              ) : filtered.length === 0 ? (
                <p className="px-2 py-3 text-xs text-neutral-600">无匹配模型</p>
              ) : (
                <>
                  {visible.map((m) => {
                    const active = selected.includes(m)
                    return (
                      <label
                        key={m}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800/60"
                      >
                        <input
                          type="checkbox"
                          checked={active}
                          onChange={() => onToggle(m)}
                          className="h-3 w-3 accent-emerald-500"
                        />
                        <span className="truncate font-mono" title={m}>
                          {m}
                        </span>
                      </label>
                    )
                  })}
                  {hiddenCount > 0 && (
                    <p className="px-2 py-2 text-[11px] text-neutral-500">
                      其余 {hiddenCount} 项，请输入过滤
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Row({
  record: r,
  expanded,
  onToggle
}: {
  record: RequestLogDetail
  expanded: boolean
  onToggle: () => void
}): ReactElement {
  return (
    <tr
      onClick={onToggle}
      className={clsx(
        'cursor-pointer border-b border-neutral-800/70 transition-colors hover:bg-neutral-800/40',
        expanded && 'bg-neutral-800/30'
      )}
    >
      <td className={TD}>{formatDateTime(r.createdAt)}</td>
      <td className={TD}>
        <AppBadge app={r.appType} />
      </td>
      <td className={`${TD} font-mono text-xs`}>{r.model}</td>
      <td className={`${TD} tabular-nums`}>{formatTokens(r.inputTokens)}</td>
      <td className={`${TD} tabular-nums`}>{formatTokens(r.outputTokens)}</td>
      <td className={`${TD} tabular-nums`}>{formatTokens(r.cacheReadTokens)}</td>
      <td className={`${TD} tabular-nums`}>{formatTokens(r.cacheCreationTokens)}</td>
      <td className={`${TD} tabular-nums`}>{formatUsd(r.costUsd)}</td>
      <td className={`${TD} tabular-nums`}>{formatDuration(r.latencyMs)}</td>
      <td className={TD}>
        <StatusBadge status={r.status} httpStatus={r.httpStatus} />
      </td>
      <td className={TD}>
        {r.status === 'error' && r.errorMessage ? (
          <span
            className="block max-w-[220px] truncate text-[11px] leading-normal text-neutral-400"
            title={r.errorMessage}
          >
            {r.httpStatus != null ? (
              <span className="mr-1 inline-flex rounded border border-red-500/30 bg-red-500/10 px-1 py-0.5 font-mono text-[10px] leading-none text-red-300">
                {r.httpStatus}
              </span>
            ) : null}
            {truncateError(r.errorMessage)}
          </span>
        ) : r.status === 'error' && r.httpStatus != null ? (
          <span className="inline-flex rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 font-mono text-[10px] leading-none text-red-300">
            {r.httpStatus}
          </span>
        ) : (
          <span className="text-neutral-600">—</span>
        )}
      </td>
    </tr>
  )
}

function AppBadge({ app }: { app: AppType }): ReactElement {
  return (
    <span
      className={`inline-block rounded border px-1.5 py-0.5 text-[11px] ${APP_META[app].badge}`}
    >
      {APP_META[app].label}
    </span>
  )
}

function StatusBadge({
  status,
  httpStatus
}: {
  status: RequestStatus
  httpStatus?: number | null
}): ReactElement {
  const isError = status === 'error'
  const label = isError && httpStatus != null ? `失败 · ${httpStatus}` : isError ? '失败' : '成功'
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium',
        status === 'success'
          ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300'
          : 'border-red-500/30 bg-red-500/15 text-red-300'
      )}
      title={isError && httpStatus != null ? `HTTP ${httpStatus}` : undefined}
    >
      {label}
    </span>
  )
}

function DetailDrawer({ record: r, onClose }: { record: RequestLogDetail; onClose: () => void }): ReactElement {
  const filter = useFilter()
  const nav = useNav()

  const viewInTrends = (): void => {
    filter.setAppTypes([r.appType])
    filter.setModels([r.model])
    nav.navigate('trends')
    onClose()
  }

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-neutral-800 bg-neutral-950 shadow-2xl">
        <header className="flex items-center justify-between gap-3 border-b border-neutral-800 px-5 py-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-neutral-200">请求详情</p>
            <p className="mt-0.5 truncate font-mono text-[11px] text-neutral-500">{r.id}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded-md border border-neutral-800 bg-neutral-900 p-1.5 text-neutral-400 transition-colors hover:text-neutral-200"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          <DetailSection title="基本信息">
            <DetailRow label="应用">
              <AppBadge app={r.appType} />
            </DetailRow>
            <DetailRow label="模型">
              <span className="font-mono">{r.model}</span>
            </DetailRow>
            <DetailRow label="原始模型名">
              <span className="font-mono">{r.rawModel ?? '—'}</span>
            </DetailRow>
            <DetailRow label="状态">
              <StatusBadge status={r.status} httpStatus={r.httpStatus} />
            </DetailRow>
            <DetailRow label="HTTP 状态">
              {r.httpStatus != null ? (
                <span className="inline-flex rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 font-mono text-[11px] text-red-300">
                  {r.httpStatus}
                </span>
              ) : (
                <span className="text-neutral-500">—</span>
              )}
            </DetailRow>
            <DetailRow label="时间">
              <span className="font-mono">{formatDateTime(r.createdAt)}</span>
            </DetailRow>
            <DetailRow label="项目">
              <span className="font-mono">{r.project ?? '—'}</span>
            </DetailRow>
            <DetailRow label="会话 ID">
              <span className="font-mono">{r.sessionId ?? '—'}</span>
            </DetailRow>
            <DetailRow label="输入语义">
              {INPUT_SEMANTICS_LABEL[r.inputSemantics] ?? String(r.inputSemantics)}
            </DetailRow>
          </DetailSection>

          <DetailSection title="错误信息">
            {r.errorMessage ? (
              <p className="break-all whitespace-pre-wrap rounded-md border border-red-500/20 bg-red-500/5 p-2 font-mono text-[11px] leading-relaxed text-red-300/90">
                {r.errorMessage}
              </p>
            ) : (
              <p className="text-xs text-neutral-500">— 暂无错误信息（成功或未记录）</p>
            )}
          </DetailSection>

          <DetailSection title="Token">
            <DetailRow label="输入">
              <span className="tabular-nums">{formatTokens(r.inputTokens)}</span>
            </DetailRow>
            <DetailRow label="输出">
              <span className="tabular-nums">{formatTokens(r.outputTokens)}</span>
            </DetailRow>
            <DetailRow label="缓存读">
              <span className="tabular-nums">{formatTokens(r.cacheReadTokens)}</span>
            </DetailRow>
            <DetailRow label="缓存写">
              <span className="tabular-nums">{formatTokens(r.cacheCreationTokens)}</span>
            </DetailRow>
          </DetailSection>

          <DetailSection title="费用与耗时">
            <DetailRow label="费用 (USD)">
              <span className="tabular-nums">{formatUsd(r.costUsd)}</span>
            </DetailRow>
            <DetailRow label="币种">{r.currency ?? '—'}</DetailRow>
            <DetailRow label="耗时">
              <span className="tabular-nums">{formatDuration(r.latencyMs)}</span>
            </DetailRow>
          </DetailSection>

          <DetailSection title="来源">
            <DetailRow label="来源文件">
              <span className="font-mono">{r.sourceFile}</span>
            </DetailRow>
            <DetailRow label="来源行号">
              <span className="tabular-nums">{r.sourceLine}</span>
            </DetailRow>
          </DetailSection>
        </div>

        <footer className="border-t border-neutral-800 px-5 py-3">
          {r.model ? (
            <button
              type="button"
              onClick={viewInTrends}
              className="w-full rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300 transition-colors hover:bg-emerald-500/20"
            >
              在趋势中查看此模型 / 应用
            </button>
          ) : null}
        </footer>
      </aside>
    </div>
  )
}

function DetailSection({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section className="mb-5">
      <h3 className="mb-1 border-b border-neutral-800 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
        {title}
      </h3>
      <dl className="space-y-0.5">{children}</dl>
    </section>
  )
}

function DetailRow({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-[11px] uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className="min-w-0 text-right text-xs text-neutral-200">{children}</dd>
    </div>
  )
}

type PageItem = number | 'left-gap' | 'right-gap'

export function pageList(current: number, total: number): PageItem[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1)
  }
  const candidates = new Set([1, 2, total - 1, total, current - 1, current, current + 1])
  const pages = [...candidates].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b)
  const out: PageItem[] = []
  let prev = 0
  for (const p of pages) {
    if (prev && p - prev > 1) out.push(prev === 1 ? 'left-gap' : 'right-gap')
    out.push(p)
    prev = p
  }
  return out
}
