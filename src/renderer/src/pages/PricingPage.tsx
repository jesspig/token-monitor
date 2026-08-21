import { useState } from 'react'
import type { ReactElement } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import type { ModelPricingRow } from '../../../../shared/tables'
import { api } from '../api'
import { EmptyState } from '../components/EmptyState'
import { PageHeader } from '../components/PageHeader'
import { useModelPricing } from '../hooks/useModelPricing'

const TH = 'px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-neutral-500'
const TD = 'px-3 py-2 text-sm text-neutral-300'
const INPUT_CLS =
  'w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none'

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

  const rows = data ?? []
  const formTouched = modelId.trim() !== ''

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
