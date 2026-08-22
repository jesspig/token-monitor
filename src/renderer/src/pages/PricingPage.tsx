import { useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import type {
  ModelsDevCatalogEntry,
  ModelsDevCatalogResult,
  ModelsDevSyncResult
} from '../../../../shared/query'
import type { ModelPricingRow } from '../../../../shared/tables'
import { api } from '../api'
import { EmptyState } from '../components/EmptyState'
import { PageHeader } from '../components/PageHeader'
import { useModelPricing } from '../hooks/useModelPricing'

const TH = 'px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-neutral-500'
const TD = 'px-3 py-2 text-sm text-neutral-300'
const INPUT_CLS =
  'w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none'
/** 在线目录最多直接渲染的条数，超出部分提示用搜索过滤 */
const CATALOG_RENDER_LIMIT = 200

/** 在线目录条目的唯一键（provider 可为 null，modelId 跨 provider 可能重复） */
function catalogKey(e: ModelsDevCatalogEntry): string {
  return `${e.provider ?? ''}::${e.modelId}`
}

function toErrMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 定价配置页：模型价格列表 + 新增/编辑/删除 */
export default function PricingPage(): ReactElement {
  const { data, isLoading } = useModelPricing()
  const qc = useQueryClient()

  const [modelId, setModelId] = useState('')
  const [provider, setProvider] = useState('')
  const [inputPerM, setInputPerM] = useState('')
  const [outputPerM, setOutputPerM] = useState('')
  const [cacheReadPerM, setCacheReadPerM] = useState('')
  const [cacheCreationPerM, setCacheCreationPerM] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [multiplier, setMultiplier] = useState('1')
  /** 正在编辑的模型 ID；非空时表单进入编辑模式 */
  const [editingId, setEditingId] = useState<string | null>(null)

  // models.dev 在线目录区块
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [catalog, setCatalog] = useState<ModelsDevCatalogResult | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogFilter, setCatalogFilter] = useState('')
  const [hideExisting, setHideExisting] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const rows = data ?? []
  const formTouched = modelId.trim() !== ''

  const existingIds = useMemo(() => new Set(rows.map((r) => r.model_id)), [rows])
  const catalogEntries = useMemo(
    () =>
      catalog
        ? Array.from(
            new Map(
              catalog.entries.map(
                (e): [string, ModelsDevCatalogEntry] => [catalogKey(e), e]
              )
            ).values()
          )
        : [],
    [catalog]
  )
  const filteredEntries = useMemo(
    () =>
      catalogEntries.filter((e) => {
        if (hideExisting && existingIds.has(e.modelId)) return false
        const keyword = catalogFilter.trim().toLowerCase()
        if (keyword === '') return true
        return (
          e.modelId.toLowerCase().includes(keyword) ||
          (e.provider ?? '').toLowerCase().includes(keyword) ||
          (e.name ?? '').toLowerCase().includes(keyword)
        )
      }),
    [catalogEntries, existingIds, hideExisting, catalogFilter]
  )
  const visibleEntries = filteredEntries.slice(0, CATALOG_RENDER_LIMIT)
  const selectedEntries = catalogEntries.filter((e) => selectedKeys.has(catalogKey(e)))

  function resetForm(): void {
    setEditingId(null)
    setModelId('')
    setProvider('')
    setInputPerM('')
    setOutputPerM('')
    setCacheReadPerM('')
    setCacheCreationPerM('')
    setCurrency('USD')
    setMultiplier('1')
  }

  /** 行内「编辑」：载入该行数据进入编辑模式 */
  function startEdit(p: ModelPricingRow): void {
    setEditingId(p.model_id)
    setModelId(p.model_id)
    setProvider(p.provider ?? '')
    setInputPerM(String(p.input_per_million))
    setOutputPerM(String(p.output_per_million))
    setCacheReadPerM(String(p.cache_read_per_million))
    setCacheCreationPerM(String(p.cache_creation_per_million))
    setCurrency(p.currency || 'USD')
    setMultiplier(String(p.cost_multiplier))
  }

  async function handleSave(): Promise<void> {
    if (!formTouched) return
    const entry: ModelPricingRow = {
      model_id: modelId.trim(),
      provider: provider.trim() || null,
      input_per_million: Number(inputPerM) || 0,
      output_per_million: Number(outputPerM) || 0,
      cache_read_per_million: Number(cacheReadPerM) || 0,
      cache_creation_per_million: Number(cacheCreationPerM) || 0,
      currency: currency.trim() || 'USD',
      cost_multiplier: Number(multiplier) || 1,
      updated_at: Date.now()
    }
    await api.updateModelPricing(entry)
    await qc.invalidateQueries({ queryKey: ['model-pricing'] })
    resetForm()
  }

  async function handleDelete(id: string): Promise<void> {
    await api.deleteModelPricing(id)
    await qc.invalidateQueries({ queryKey: ['model-pricing'] })
  }

  /** 展开目录区块并拉取 models.dev 在线目录（每次点击均重新拉取） */
  async function loadCatalog(): Promise<void> {
    setCatalogOpen(true)
    setNotice(null)
    setCatalogLoading(true)
    try {
      const result = await api.fetchModelsDevCatalog()
      setCatalog(result)
      setSelectedKeys(new Set())
    } catch (err) {
      setCatalog(null)
      setNotice({ kind: 'err', text: `拉取在线目录失败：${toErrMsg(err)}` })
    } finally {
      setCatalogLoading(false)
    }
  }

  function toggleSelect(key: string): void {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  async function handleImportSelected(): Promise<void> {
    if (selectedEntries.length === 0 || importing) return
    setImporting(true)
    setNotice(null)
    try {
      const result = await api.importModelsDevEntries(selectedEntries)
      await qc.invalidateQueries({ queryKey: ['model-pricing'] })
      setSelectedKeys(new Set())
      setNotice({
        kind: 'ok',
        text: `已导入 ${result.imported} 个模型定价（user 来源，不会被自动同步覆盖）。`
      })
    } catch (err) {
      setNotice({ kind: 'err', text: `导入失败：${toErrMsg(err)}` })
    } finally {
      setImporting(false)
    }
  }

  async function handleSyncAll(): Promise<void> {
    if (syncing) return
    setSyncing(true)
    setNotice(null)
    try {
      const result: ModelsDevSyncResult = await api.syncModelsDevPricing()
      await qc.invalidateQueries({ queryKey: ['model-pricing'] })
      setNotice({
        kind: 'ok',
        text: `全量同步完成：获取 ${result.fetched} 条，导入 ${result.imported} 条，跳过 ${result.skipped} 条。`
      })
    } catch (err) {
      setNotice({ kind: 'err', text: `全量同步失败：${toErrMsg(err)}` })
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="定价配置"
        description="每百万 token 价格（默认 USD），支持自定义/覆盖与 cost_multiplier"
      />

      <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
        <p className="mb-3 text-sm font-medium text-neutral-300">
          {editingId !== null ? `编辑定价：${editingId}` : '新增定价'}
        </p>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <input
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            placeholder="模型 ID（如 gpt-4o）"
            disabled={editingId !== null}
            className={`${INPUT_CLS} ${editingId !== null ? 'cursor-not-allowed opacity-60' : ''}`}
          />
          <input
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            placeholder="提供方（可选）"
            className={INPUT_CLS}
          />
          <input
            value={inputPerM}
            onChange={(e) => setInputPerM(e.target.value)}
            placeholder="输入 $/M"
            type="number"
            className={INPUT_CLS}
          />
          <input
            value={outputPerM}
            onChange={(e) => setOutputPerM(e.target.value)}
            placeholder="输出 $/M"
            type="number"
            className={INPUT_CLS}
          />
          <input
            value={cacheReadPerM}
            onChange={(e) => setCacheReadPerM(e.target.value)}
            placeholder="缓存读 $/M"
            type="number"
            className={INPUT_CLS}
          />
          <input
            value={cacheCreationPerM}
            onChange={(e) => setCacheCreationPerM(e.target.value)}
            placeholder="缓存创建 $/M"
            type="number"
            className={INPUT_CLS}
          />
          <input
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            placeholder="币种（默认 USD）"
            className={INPUT_CLS}
          />
          <input
            value={multiplier}
            onChange={(e) => setMultiplier(e.target.value)}
            placeholder="系数（默认 1）"
            type="number"
            step="0.01"
            className={INPUT_CLS}
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!formTouched}
              onClick={() => void handleSave()}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-40"
            >
              {editingId !== null ? '保存修改' : '保存'}
            </button>
            {editingId !== null && (
              <button
                type="button"
                onClick={resetForm}
                className="rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-300 transition-colors hover:bg-neutral-700"
              >
                取消
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-neutral-300">models.dev 在线目录</p>
          <div className="flex gap-2">
            {catalogOpen && (
              <button
                type="button"
                onClick={() => setCatalogOpen(false)}
                className="rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-300 transition-colors hover:bg-neutral-700"
              >
                收起
              </button>
            )}
            <button
              type="button"
              disabled={catalogLoading}
              onClick={() => void loadCatalog()}
              className="rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs font-medium text-neutral-300 transition-colors hover:bg-neutral-700 disabled:opacity-40"
            >
              {catalogLoading ? '拉取中…' : '浏览在线目录'}
            </button>
            <button
              type="button"
              disabled={syncing}
              onClick={() => void handleSyncAll()}
              className="rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-40"
            >
              {syncing ? '同步中…' : '立即全量同步'}
            </button>
          </div>
        </div>

        {catalogOpen && (
          <div className="mt-3 space-y-3">
            {notice !== null && (
              <p
                className={`text-xs ${notice.kind === 'ok' ? 'text-emerald-400' : 'text-red-400'}`}
              >
                {notice.text}
              </p>
            )}

            {catalogLoading && catalog === null ? (
              <p className="text-xs text-neutral-500">正在拉取 models.dev 目录…</p>
            ) : catalog === null ? (
              <p className="text-xs text-neutral-500">
                点击「浏览在线目录」从 models.dev 拉取模型价格，勾选后导入本地定价表。
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    value={catalogFilter}
                    onChange={(e) => setCatalogFilter(e.target.value)}
                    placeholder="搜索 provider / 模型 ID / 名称"
                    className={`${INPUT_CLS} max-w-xs flex-1`}
                  />
                  <label className="flex items-center gap-2 text-xs text-neutral-400">
                    <input
                      type="checkbox"
                      checked={hideExisting}
                      onChange={(e) => setHideExisting(e.target.checked)}
                      className="h-3.5 w-3.5 accent-emerald-600"
                    />
                    仅显示未导入的模型
                  </label>
                  <span className="text-xs text-neutral-500">
                    匹配 {filteredEntries.length} / 共 {catalog.entries.length} 条
                    {catalog.skipped > 0 ? `（解析丢弃 ${catalog.skipped} 条）` : ''}
                  </span>
                </div>

                <div className="max-h-96 overflow-y-auto rounded-lg border border-neutral-800">
                  <table className="w-full min-w-[640px] border-collapse">
                    <thead className="sticky top-0 bg-neutral-900">
                      <tr className="border-b border-neutral-800">
                        <th className={`${TH} w-8`}></th>
                        <th className={TH}>模型 ID</th>
                        <th className={TH}>提供方</th>
                        <th className={TH}>名称</th>
                        <th className={TH}>输入 $/M</th>
                        <th className={TH}>输出 $/M</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleEntries.map((e) => {
                        const key = catalogKey(e)
                        const exists = existingIds.has(e.modelId)
                        return (
                          <tr
                            key={key}
                            className="border-b border-neutral-800/70 hover:bg-neutral-800/40"
                          >
                            <td className={TD}>
                              <input
                                type="checkbox"
                                checked={selectedKeys.has(key)}
                                onChange={() => toggleSelect(key)}
                                className="h-3.5 w-3.5 accent-emerald-600"
                              />
                            </td>
                            <td className={`${TD} font-mono text-xs`}>{e.modelId}</td>
                            <td className={TD}>{e.provider ?? '—'}</td>
                            <td className={TD}>
                              <span className="inline-flex items-center gap-2">
                                {e.name ?? '—'}
                                {exists && (
                                  <span className="rounded border border-emerald-800 bg-emerald-900/40 px-1 py-0.5 text-[10px] leading-none text-emerald-400">
                                    已导入
                                  </span>
                                )}
                              </span>
                            </td>
                            <td className={`${TD} tabular-nums`}>{e.inputPerMillion}</td>
                            <td className={`${TD} tabular-nums`}>{e.outputPerMillion}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                {visibleEntries.length === 0 ? (
                  <p className="text-xs text-neutral-500">没有匹配的目录条目。</p>
                ) : filteredEntries.length > visibleEntries.length ? (
                  <p className="text-xs text-neutral-500">
                    条目较多，仅显示前 {CATALOG_RENDER_LIMIT} 条（共 {filteredEntries.length}{' '}
                    条匹配），请用搜索缩小范围。
                  </p>
                ) : null}

                <div className="flex justify-end">
                  <button
                    type="button"
                    disabled={selectedEntries.length === 0 || importing}
                    onClick={() => void handleImportSelected()}
                    className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-40"
                  >
                    {importing ? '导入中…' : `导入所选 (${selectedEntries.length})`}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {isLoading && !data ? (
        <EmptyState title="加载中…" description="正在获取定价表。" />
      ) : rows.length === 0 ? (
        <EmptyState
          title="等待真实数据"
          description="定价表为空，接入真实 IPC 后端后展示内置模型价格。"
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-neutral-800 bg-neutral-900/60">
          <table className="w-full min-w-[880px] border-collapse">
            <thead>
              <tr className="border-b border-neutral-800 bg-neutral-900">
                <th className={TH}>模型 ID</th>
                <th className={TH}>提供方</th>
                <th className={TH}>输入 $/M</th>
                <th className={TH}>输出 $/M</th>
                <th className={TH}>缓存读 $/M</th>
                <th className={TH}>缓存创建 $/M</th>
                <th className={TH}>币种</th>
                <th className={TH}>系数</th>
                <th className={TH}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.model_id} className="border-b border-neutral-800/70 hover:bg-neutral-800/40">
                  <td className={`${TD} font-mono text-xs`}>{p.model_id}</td>
                  <td className={TD}>{p.provider ?? '—'}</td>
                  <td className={`${TD} tabular-nums`}>{p.input_per_million}</td>
                  <td className={`${TD} tabular-nums`}>{p.output_per_million}</td>
                  <td className={`${TD} tabular-nums`}>{p.cache_read_per_million}</td>
                  <td className={`${TD} tabular-nums`}>{p.cache_creation_per_million}</td>
                  <td className={TD}>{p.currency}</td>
                  <td className={`${TD} tabular-nums`}>{p.cost_multiplier}</td>
                  <td className={TD}>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => startEdit(p)}
                        className="inline-flex items-center gap-1 text-xs text-neutral-400 hover:text-sky-300"
                      >
                        <Pencil className="h-3.5 w-3.5" /> 编辑
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(p.model_id)}
                        className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-red-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" /> 删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
