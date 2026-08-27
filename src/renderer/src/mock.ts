import type { AppType, RequestStatus } from '../../../shared/app'
import type { RendererApi } from '../../../shared/ipc'
import type {
  AppSettings,
  AppStats,
  BudgetStatus,
  DailyStats,
  HourlyStats,
  LogFilters,
  ModelStats,
  ModelsDevCatalogEntry,
  PaginatedLogs,
  PluginStatus,
  RequestLogDetail,
  UsageSummary
} from '../../../shared/query'
import type { ModelPricingRow } from '../../../shared/tables'
import { DAY_MS, startOfToday } from './lib/range'


function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function toDateStr(ms: number): string {
  const d = new Date(ms)
  const pad = (v: number): string => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

interface ModelDef {
  modelId: string
  provider: string
  inputPerM: number
  outputPerM: number
  cacheReadPerM: number
  cacheCreationPerM: number
}

const MODEL_DEFS: ModelDef[] = [
  { modelId: 'claude-sonnet-4-5', provider: 'Anthropic', inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheCreationPerM: 3.75 },
  { modelId: 'claude-opus-4-1', provider: 'Anthropic', inputPerM: 15, outputPerM: 75, cacheReadPerM: 1.5, cacheCreationPerM: 18.75 },
  { modelId: 'gpt-4o', provider: 'OpenAI', inputPerM: 2.5, outputPerM: 10, cacheReadPerM: 1.25, cacheCreationPerM: 2.5 },
  { modelId: 'gpt-4o-mini', provider: 'OpenAI', inputPerM: 0.15, outputPerM: 0.6, cacheReadPerM: 0.075, cacheCreationPerM: 0.15 },
  { modelId: 'gemini-2-5-pro', provider: 'Google', inputPerM: 1.25, outputPerM: 10, cacheReadPerM: 0.3125, cacheCreationPerM: 1.25 },
  { modelId: 'gemini-2-5-flash', provider: 'Google', inputPerM: 0.3, outputPerM: 2.5, cacheReadPerM: 0.075, cacheCreationPerM: 0.3 },
  { modelId: 'deepseek-chat', provider: 'DeepSeek', inputPerM: 0.27, outputPerM: 1.1, cacheReadPerM: 0.07, cacheCreationPerM: 0.27 },
  { modelId: 'grok-4', provider: 'xAI', inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheCreationPerM: 3 }
]

const APP_MODELS: Record<AppType, string[]> = {
  claude: ['claude-sonnet-4-5', 'claude-opus-4-1'],
  codex: ['gpt-4o', 'gpt-4o-mini'],
  opencode: ['gpt-4o', 'deepseek-chat'],
  gemini: ['gemini-2-5-pro', 'gemini-2-5-flash'],
  grok: ['grok-4'],
  pi: [],
  zcode: [],
  dsh: []
}

const APP_WEIGHTS: Array<[AppType, number]> = [
  ['claude', 0.3],
  ['codex', 0.24],
  ['opencode', 0.2],
  ['gemini', 0.16],
  ['grok', 0.1]
]

const NOW = Date.now()

function buildRecords(): RequestLogDetail[] {
  const rnd = mulberry32(20260819)
  const records: RequestLogDetail[] = []
  const todayStart = startOfToday()
  const projects = ['website', 'api-server', 'token-monitor', 'data-pipeline', 'docs']

  const pickApp = (): AppType => {
    let t = rnd()
    for (const [app, w] of APP_WEIGHTS) {
      t -= w
      if (t <= 0) return app
    }
    return 'claude'
  }

  for (let offset = 29; offset >= 0; offset--) {
    const dayStart = todayStart - offset * DAY_MS
    const dateStr = toDateStr(dayStart)
    const span = offset === 0 ? Math.max(1, NOW - dayStart) : DAY_MS - 1
    const count = 6 + Math.floor(rnd() * 28)

    for (let i = 0; i < count; i++) {
      const app = pickApp()
      const models = APP_MODELS[app]
      const model = models[Math.floor(rnd() * models.length)]
      const def = MODEL_DEFS.find((m) => m.modelId === model) as ModelDef
      const input = 200 + Math.floor(rnd() * 8000)
      const output = 100 + Math.floor(rnd() * 4000)
      const cacheRead = rnd() < 0.6 ? Math.floor(rnd() * 22000) : 0
      const cacheCreation = rnd() < 0.35 ? Math.floor(rnd() * 5000) : 0
      const status: RequestStatus = rnd() < 0.95 ? 'success' : 'error'
      const createdAt = dayStart + Math.floor(rnd() * span)
      const cost =
        status === 'success'
          ? (input * def.inputPerM +
              output * def.outputPerM +
              cacheRead * def.cacheReadPerM +
              cacheCreation * def.cacheCreationPerM) /
            1_000_000
          : null
      const HTTP_ERROR_CODES = [400, 401, 403, 404, 429, 500, 502, 503] as const
      const ERROR_TEMPLATES = [
        'API Error 429: rate limit exceeded, retry after 60s',
        'API Error 500: internal server error, model overloaded',
        'API Error 403: permission denied, check api key scope',
        'API Error 400: invalid request, prompt too long exceeding context window limit',
        'API Error 502: bad gateway, upstream provider unavailable transient failure'
      ] as const
      const httpStatus =
        status === 'error' ? HTTP_ERROR_CODES[Math.floor(rnd() * HTTP_ERROR_CODES.length)] : null
      const errorMessage =
        status === 'error'
          ? ERROR_TEMPLATES[Math.floor(rnd() * ERROR_TEMPLATES.length)]
          : null

      records.push({
        id: `${app}-${dateStr}-${i}-${offset}`,
        appType: app,
        model,
        rawModel: model,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreation,
        inputSemantics: Math.floor(rnd() * 3),
        costUsd: cost != null ? cost.toFixed(6) : null,
        currency: 'USD',
        latencyMs:
          status === 'success' ? 500 + Math.floor(rnd() * 30000) : 200 + Math.floor(rnd() * 5000),
        project: rnd() < 0.6 ? projects[Math.floor(rnd() * projects.length)] : null,
        sessionId: `sess-${Math.floor(rnd() * 0xffffffff).toString(16)}`,
        status,
        httpStatus,
        errorMessage,
        createdAt,
        sourceFile: `.config/${app}/sessions/${dateStr}.jsonl`,
        sourceLine: 2 + Math.floor(rnd() * 800)
      })
    }
  }
  return records
}

const ALL_RECORDS = buildRecords()

function buildDaily(): DailyStats[] {
  const map = new Map<string, DailyStats>()
  for (const r of ALL_RECORDS) {
    const key = toDateStr(r.createdAt)
    let d = map.get(key)
    if (!d) {
      d = {
        date: key,
        requestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: '0',
        successCount: 0,
        errorCount: 0
      }
      map.set(key, d)
    }
    d.requestCount += 1
    d.inputTokens += r.inputTokens
    d.outputTokens += r.outputTokens
    d.cacheReadTokens += r.cacheReadTokens
    d.cacheCreationTokens += r.cacheCreationTokens
    d.costUsd = (
      Number.parseFloat(d.costUsd) + (r.costUsd ? Number.parseFloat(r.costUsd) : 0)
    ).toFixed(6)
    if (r.status === 'success') d.successCount += 1
    else d.errorCount += 1
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date))
}

const DAILY = buildDaily()

function filterRecords(filters: LogFilters): RequestLogDetail[] {
  const { startTime, endTime, appTypes, models, status, keyword, project, sessionId } = filters
  const httpStatus = filters.httpStatus ?? filters.statusCode
  return ALL_RECORDS.filter((r) => {
    if (startTime != null && r.createdAt < startTime) return false
    if (endTime != null && r.createdAt > endTime) return false
    if (appTypes && appTypes.length > 0 && !appTypes.includes(r.appType)) return false
    if (models && models.length > 0 && !models.includes(r.model)) return false
    if (status && r.status !== status) return false
    if (httpStatus != null && r.httpStatus !== httpStatus) return false
    if (project && r.project !== project) return false
    if (sessionId && r.sessionId !== sessionId) return false
    if (keyword) {
      const kw = keyword.toLowerCase()
      const hay = `${r.model} ${r.sessionId} ${r.project ?? ''} ${r.appType} ${r.errorMessage ?? ''} ${r.httpStatus ?? ''}`.toLowerCase()
      if (!hay.includes(kw)) return false
    }
    return true
  })
}

function filterDaily(filters: LogFilters): DailyStats[] {
  const start = filters.startTime != null ? toDateStr(filters.startTime) : null
  const end = filters.endTime != null ? toDateStr(filters.endTime) : null
  return DAILY.filter((d) => {
    if (start && d.date < start) return false
    if (end && d.date > end) return false
    return true
  })
}

function aggregateHourly(records: RequestLogDetail[]): HourlyStats[] {
  const map = new Map<string, HourlyStats>()
  for (const r of records) {
    const hour = new Date(r.createdAt).getHours()
    const dayKey = toDateStr(r.createdAt)
    const key = `${dayKey}T${String(hour).padStart(2, '0')}`
    let h = map.get(key)
    if (!h) {
      h = {
        hour,
        dayKey,
        requestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: '0',
        successCount: 0,
        errorCount: 0
      }
      map.set(key, h)
    }
    h.requestCount += 1
    h.inputTokens += r.inputTokens
    h.outputTokens += r.outputTokens
    h.cacheReadTokens += r.cacheReadTokens
    h.cacheCreationTokens += r.cacheCreationTokens
    if (r.costUsd) {
      h.costUsd = (Number.parseFloat(h.costUsd) + Number.parseFloat(r.costUsd)).toFixed(6)
    }
    if (r.status === 'success') h.successCount += 1
    else h.errorCount += 1
  }
  return [...map.values()].sort(
    (a, b) => (a.dayKey ?? '').localeCompare(b.dayKey ?? '') || a.hour - b.hour
  )
}

function aggregateSummary(records: RequestLogDetail[]): UsageSummary {
  let totalRequests = 0
  let successCount = 0
  let errorCount = 0
  let totalCost = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0
  for (const r of records) {
    totalRequests += 1
    if (r.status === 'success') successCount += 1
    else errorCount += 1
    if (r.costUsd) totalCost += Number.parseFloat(r.costUsd)
    inputTokens += r.inputTokens
    outputTokens += r.outputTokens
    cacheReadTokens += r.cacheReadTokens
    cacheCreationTokens += r.cacheCreationTokens
  }
  const realTotalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens
  const cacheHitRate =
    inputTokens + cacheReadTokens > 0 ? cacheReadTokens / (inputTokens + cacheReadTokens) : 0
  const successRate = totalRequests > 0 ? successCount / totalRequests : 0
  return {
    totalRequests,
    successCount,
    errorCount,
    totalCost: totalCost.toFixed(6),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    realTotalTokens,
    cacheHitRate,
    successRate
  }
}

function buildPricing(): ModelPricingRow[] {
  return MODEL_DEFS.map((m) => ({
    model_id: m.modelId,
    provider: m.provider,
    input_per_million: m.inputPerM,
    output_per_million: m.outputPerM,
    cache_read_per_million: m.cacheReadPerM,
    cache_creation_per_million: m.cacheCreationPerM,
    currency: 'USD',
    cost_multiplier: 1,
    updated_at: NOW
  }))
}

let PRICING: ModelPricingRow[] = buildPricing()

const PLUGIN_DEFS: Array<{
  id: AppType
  name: string
  available: boolean
  reason?: string
  lastSyncAt: number | null
  errorCount: number
  cliVersion?: string | null
}> = [
  {
    id: 'claude',
    name: 'Claude Code',
    available: true,
    lastSyncAt: NOW - 2 * 60 * 1000,
    errorCount: 0,
    cliVersion: '2.1.14'
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    available: true,
    lastSyncAt: NOW - 9 * 60 * 1000,
    errorCount: 1,
    cliVersion: '0.52.0'
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    available: true,
    lastSyncAt: NOW - 31 * 60 * 1000,
    errorCount: 0,
    cliVersion: '0.6.3'
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    available: false,
    reason: '未检测到 CLI / 会话目录',
    lastSyncAt: null,
    errorCount: 0,
    cliVersion: null
  },
  {
    id: 'grok',
    name: 'Grok CLI',
    available: false,
    reason: '未检测到 CLI / 会话目录',
    lastSyncAt: null,
    errorCount: 0,
    cliVersion: null
  }
]

let PLUGINS: PluginStatus[] = PLUGIN_DEFS.map((p, i) => ({
  ...p,
  version: `0.${i + 1}.0`,
  enabled: p.available
}))

let SETTINGS: AppSettings = {
  syncIntervalMs: 5 * 60 * 1000,
  retentionDays: 30,
  dataDir: '~/.config/token-monitor',
  dailyBudgetUsd: 10,
  monthlyBudgetUsd: 200,
  statsRefreshIntervalMs: 30_000,
  pricingSyncIntervalMs: 300_000
}

function evaluateBudget(costMicro: number, budget: number | null | undefined) {
  const effective = budget != null && budget > 0 ? budget : null
  if (effective == null) return { ratio: null as number | null, exceeded: false, normalized: null }
  const ratio = costMicro / (effective * 1_000_000)
  return { ratio, exceeded: ratio > 1, normalized: effective }
}

function buildBudgetStatus(): BudgetStatus {
  const todayKey = toDateStr(NOW)
  const monthPrefix = todayKey.slice(0, 7)
  let dailyMicro = 0
  let monthlyMicro = 0
  for (const r of ALL_RECORDS) {
    if (!r.costUsd) continue
    const micro = Math.round(Number.parseFloat(r.costUsd) * 1_000_000)
    const key = toDateStr(r.createdAt)
    if (key === todayKey) dailyMicro += micro
    if (key.startsWith(monthPrefix)) monthlyMicro += micro
  }
  const daily = evaluateBudget(dailyMicro, SETTINGS.dailyBudgetUsd)
  const monthly = evaluateBudget(monthlyMicro, SETTINGS.monthlyBudgetUsd)
  return {
    dailyCostUsd: (dailyMicro / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0',
    monthlyCostUsd:
      (monthlyMicro / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0',
    dailyBudgetUsd: daily.normalized,
    monthlyBudgetUsd: monthly.normalized,
    dailyUsageRatio: daily.ratio,
    monthlyUsageRatio: monthly.ratio,
    dailyExceeded: daily.exceeded,
    monthlyExceeded: monthly.exceeded
  }
}

const MODELSDEV_MOCK_CATALOG: ModelsDevCatalogEntry[] = [
  {
    provider: 'anthropic',
    modelId: 'claude-fable-5',
    name: 'Claude Fable 5',
    inputPerMillion: 10,
    outputPerMillion: 50,
    cacheReadPerMillion: 1,
    cacheCreationPerMillion: 12.5
  },
  {
    provider: 'openai',
    modelId: 'gpt-5.6-sol',
    name: 'GPT-5.6 Sol',
    inputPerMillion: 4,
    outputPerMillion: 20,
    cacheReadPerMillion: 0.4,
    cacheCreationPerMillion: 5
  },
  {
    provider: 'google',
    modelId: 'gemini-3.6-flash',
    name: 'Gemini 3.6 Flash',
    inputPerMillion: 1.5,
    outputPerMillion: 7.5,
    cacheReadPerMillion: 0.15,
    cacheCreationPerMillion: 1.5
  },
  {
    provider: 'deepseek',
    modelId: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    inputPerMillion: 1.32,
    outputPerMillion: 3.96,
    cacheReadPerMillion: 0.044,
    cacheCreationPerMillion: 1.32
  }
]

function upsertCatalogEntry(entry: ModelsDevCatalogEntry): void {
  const row: ModelPricingRow = {
    model_id: entry.modelId,
    provider: entry.provider,
    input_per_million: entry.inputPerMillion,
    output_per_million: entry.outputPerMillion,
    cache_read_per_million: entry.cacheReadPerMillion,
    cache_creation_per_million: entry.cacheCreationPerMillion,
    currency: 'USD',
    cost_multiplier: 1,
    updated_at: Date.now()
  }
  const idx = PRICING.findIndex((p) => p.model_id === row.model_id)
  PRICING = idx >= 0 ? PRICING.map((p, i) => (i === idx ? row : p)) : [...PRICING, row]
}

export function createMockApi(): RendererApi {
  return {
    ping: async () => 'pong',

    getUsageSummary: async (filters) => aggregateSummary(filterRecords(filters)),

    getDailyTrends: async (filters) => filterDaily(filters),

    getHourlyTrends: async (filters) => aggregateHourly(filterRecords(filters)),

    getRequestLogs: async (filters): Promise<PaginatedLogs> => {
      const page = filters.page ?? 1
      const pageSize = filters.pageSize ?? 50
      const all = filterRecords(filters)
      const start = (page - 1) * pageSize
      return {
        items: all.slice(start, start + pageSize),
        total: all.length,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(all.length / pageSize))
      }
    },

    getRequestLogDetail: async (id) => ALL_RECORDS.find((r) => r.id === id) ?? null,

    getStatsByModel: async (filters): Promise<ModelStats[]> => {
      const map = new Map<string, ModelStats>()
      for (const r of filterRecords(filters)) {
        let s = map.get(r.model)
        if (!s) {
          s = {
            model: r.model,
            appType: r.appType,
            requestCount: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: '0',
            avgLatencyMs: 0,
            successRate: 0
          }
          map.set(r.model, s)
        }
        s.requestCount += 1
        s.inputTokens += r.inputTokens
        s.outputTokens += r.outputTokens
        s.cacheReadTokens += r.cacheReadTokens
        s.cacheCreationTokens += r.cacheCreationTokens
        if (r.costUsd) {
          s.costUsd = (Number.parseFloat(s.costUsd) + Number.parseFloat(r.costUsd)).toFixed(6)
        }
        if (r.latencyMs != null) s.avgLatencyMs = (s.avgLatencyMs ?? 0) + r.latencyMs
        if (r.status === 'success') s.successRate += 1
      }
      return [...map.values()]
        .map((s) => ({
          ...s,
          avgLatencyMs:
            s.requestCount > 0 ? Math.round((s.avgLatencyMs ?? 0) / s.requestCount) : null,
          successRate: s.requestCount > 0 ? s.successRate / s.requestCount : 0
        }))
        .sort((a, b) => b.requestCount - a.requestCount)
    },

    getStatsByApp: async (filters): Promise<AppStats[]> => {
      const map = new Map<AppType, AppStats>()
      for (const r of filterRecords(filters)) {
        let s = map.get(r.appType)
        if (!s) {
          s = {
            appType: r.appType,
            requestCount: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: '0',
            successRate: 0
          }
          map.set(r.appType, s)
        }
        s.requestCount += 1
        s.inputTokens += r.inputTokens
        s.outputTokens += r.outputTokens
        s.cacheReadTokens += r.cacheReadTokens
        s.cacheCreationTokens += r.cacheCreationTokens
        if (r.costUsd) {
          s.costUsd = (Number.parseFloat(s.costUsd) + Number.parseFloat(r.costUsd)).toFixed(6)
        }
        if (r.status === 'success') s.successRate += 1
      }
      return [...map.values()]
        .map((s) => ({
          ...s,
          successRate: s.requestCount > 0 ? s.successRate / s.requestCount : 0
        }))
        .sort((a, b) => b.requestCount - a.requestCount)
    },

    getFilterOptions: async () => {
      const models = new Set<string>()
      const projects = new Set<string>()
      for (const r of ALL_RECORDS) {
        if (r.model) models.add(r.model)
        if (r.project) projects.add(r.project)
      }
      return {
        models: [...models].sort((a, b) => a.localeCompare(b)),
        projects: [...projects].sort((a, b) => a.localeCompare(b))
      }
    },

    getModelPricing: async () => PRICING,

    syncModelsDevPricing: async () => {
      for (const entry of MODELSDEV_MOCK_CATALOG) upsertCatalogEntry(entry)
      return { fetched: 5, imported: MODELSDEV_MOCK_CATALOG.length, skipped: 1 }
    },

    listPlugins: async () => PLUGINS,

    setPluginEnabled: async (id, enabled) => {
      PLUGINS = PLUGINS.map((p) => (p.id === id ? { ...p, enabled } : p))
    },

    getSettings: async () => SETTINGS,

    updateSettings: async (patch) => {
      SETTINGS = { ...SETTINGS, ...patch }
    },

    getBudgetStatus: async () => buildBudgetStatus(),

    onUsageUpdated: () => () => {}
  }
}
