import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import type { UsageUpdatedEvent } from '../../shared/context'
import type { MonitorPlugin } from '../../shared/plugin'
import type { BudgetStatus } from '../../shared/query'
import type { ModelPricingRow } from '../../shared/tables'
import { createCollector } from './collector'
import { createHost } from './host'
import { registerIpcHandlers, type IpcMainLike } from './ipc/register'

vi.mock('./services/cli-version', () => ({
  CLI_VERSION_COMMANDS: {
    claude: 'claude',
    codex: 'codex',
    opencode: 'opencode',
    gemini: 'gemini',
    grok: 'grok',
    pi: 'pi',
    zcode: 'zcode',
    dsh: 'dsh'
  },
  detectCliVersion: vi.fn(async (command: string) => (command === 'claude' ? '9.9.9' : null))
}))


type FakeIpc = IpcMainLike & {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}
function makeFakeIpcMain(): FakeIpc {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handle(channel, listener) {
      handlers.set(channel, listener as (...args: unknown[]) => unknown)
    },
    async invoke(channel, ...args) {
      const h = handlers.get(channel)
      if (!h) throw new Error(`No handler for "${channel}"`)
      return h({ sender: {} }, ...args)
    }
  }
}

const USER_TS = '2026-08-19T10:00:00+08:00'

function claudeLine(model: string, input: number, output: number, timestamp: string = USER_TS): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: Math.random().toString(36).slice(2),
    timestamp,
    sessionId: 'sess-1',
    cwd: '/Users/a/b',
    message: {
      role: 'assistant',
      model,
      usage: { input_tokens: input, output_tokens: output }
    }
  })
}

function writeClaudeSession(project: string, file: string, lines: string[]): string {
  const dir = path.join(tempHome, '.claude', 'projects', project)
  mkdirSync(dir, { recursive: true })
  const p = path.join(dir, file)
  writeFileSync(p, lines.join('\n'), 'utf8')
  return p
}

let tempHome = ''
let homeSpy: MockInstance<() => string>

beforeEach(() => {
  tempHome = mkdtempSync(path.join(os.tmpdir(), 'token-monitor-home-'))
  homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(tempHome)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))
})

afterEach(() => {
  homeSpy.mockRestore()
  rmSync(tempHome, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe('createHost 装配', () => {
  it('listPlugins 返回 8 个内置插件，默认全启用；claude 检测可用', async () => {
    mkdirSync(path.join(tempHome, '.claude', 'projects'), { recursive: true })
    const host = await createHost({ dataDir: ':memory:' })
    try {
      const statuses = await host.collector.getPluginStatus()
      expect(statuses).toHaveLength(8)
      expect(statuses.map((s) => s.id).sort()).toEqual([
        'claude',
        'codex',
        'dsh',
        'gemini',
        'grok',
        'opencode',
        'pi',
        'zcode'
      ])
      for (const s of statuses) expect(s.enabled).toBe(true)

      const claude = statuses.find((s) => s.id === 'claude')
      expect(claude?.available).toBe(true)
      expect(claude?.lastSyncAt).toBeNull()
      expect(claude?.errorCount).toBe(0)
      expect(claude?.cliVersion).toBe('9.9.9')
      expect(statuses.find((s) => s.id === 'codex')?.cliVersion).toBeUndefined()
    } finally {
      host.dispose()
    }
  })

  it('IPC 冒烟：ping 返回 pong，getSettings 返回默认值', async () => {
    const host = await createHost({ dataDir: ':memory:' })
    const ipc = makeFakeIpcMain()
    registerIpcHandlers(ipc, host, () => null)
    try {
      expect(await ipc.invoke('app:ping')).toBe('pong')
      const settings = (await ipc.invoke('settings:get')) as { syncIntervalMs: number; retentionDays: number }
      expect(settings.syncIntervalMs).toBe(300_000)
      expect(settings.retentionDays).toBe(90)
    } finally {
      host.dispose()
    }
  })

  it('IPC 冒烟：budget:status 贯通——今日费用可见，设置预算后超限告警', async () => {
    writeClaudeSession('proj-a', 'session-1.jsonl', [
      claudeLine('claude-sonnet-4-5', 1_000_000, 0, new Date().toISOString())
    ])
    const host = await createHost({ dataDir: ':memory:' })
    const ipc = makeFakeIpcMain()
    registerIpcHandlers(ipc, host, () => null)
    try {
      await host.collector.syncAll()

      const unset = (await ipc.invoke('budget:status')) as BudgetStatus
      expect(unset.dailyBudgetUsd).toBeNull()
      expect(unset.monthlyBudgetUsd).toBeNull()
      expect(unset.dailyUsageRatio).toBeNull()
      expect(unset.dailyExceeded).toBe(false)
      expect(unset.monthlyExceeded).toBe(false)
      expect(unset.dailyCostUsd).toBe('3')

      host.updateSettings({ dailyBudgetUsd: 2 })
      const over = await host.getBudgetStatus()
      expect(over.dailyBudgetUsd).toBe(2)
      expect(over.dailyExceeded).toBe(true)
      expect(over.dailyUsageRatio).toBeCloseTo(1.5, 10)
      expect(over.monthlyExceeded).toBe(false)
    } finally {
      host.dispose()
    }
  })
})

describe('collector.syncAll 采集链路', () => {
  it('会话 JSONL 入库：usageQuery 可见，claude available=true', async () => {
    const file = writeClaudeSession('proj-a', 'session-1.jsonl', [
      claudeLine('claude-sonnet-4-5', 1000, 2000),
      claudeLine('claude-sonnet-4-5', 500, 100)
    ])
    const host = await createHost({ dataDir: ':memory:' })
    try {
      const result = await host.collector.syncAll()
      expect(result.errors).toBe(0)
      expect(result.addedRecords).toBe(2)

      const summary = await host.usageQuery.getUsageSummary({})
      expect(summary.totalRequests).toBe(2)
      expect(summary.inputTokens).toBe(1500)
      expect(summary.outputTokens).toBe(2100)

      const detail = await host.usageQuery.getRequestLogDetail(`claude:${file}:1`)
      expect(detail?.appType).toBe('claude')
      expect(detail?.model).toBe('claude-sonnet-4-5')

      const claude = (await host.collector.getPluginStatus()).find((s) => s.id === 'claude')
      expect(claude?.available).toBe(true)
      expect(claude?.lastSyncAt).not.toBeNull()
      expect(claude?.errorCount).toBe(0)
    } finally {
      host.dispose()
    }
  })

  it('二次 syncAll 增量正确：只入库新增行', async () => {
    const file = writeClaudeSession('proj-a', 'session-1.jsonl', [
      claudeLine('claude-sonnet-4-5', 1000, 0, '2026-08-19T10:00:00+08:00')
    ])
    const host = await createHost({ dataDir: ':memory:' })
    try {
      await host.collector.syncAll()
      expect((await host.usageQuery.getUsageSummary({})).totalRequests).toBe(1)

      writeFileSync(
        file,
        [
          claudeLine('claude-sonnet-4-5', 1000, 0, '2026-08-19T10:00:00+08:00'),
          claudeLine('claude-sonnet-4-5', 2000, 0, '2026-08-19T10:05:00+08:00'),
          claudeLine('claude-sonnet-4-5', 3000, 0, '2026-08-19T10:06:00+08:00')
        ].join('\n'),
        'utf8'
      )
      const result = await host.collector.syncAll()
      expect(result.addedRecords).toBe(2)

      const summary = await host.usageQuery.getUsageSummary({})
      expect(summary.totalRequests).toBe(3)
      expect(summary.inputTokens).toBe(6000)
    } finally {
      host.dispose()
    }
  })

  it('calcCost 回填 costUsd；更新定价并失效缓存后影响新记录', async () => {
    const file = writeClaudeSession('proj-a', 'session-1.jsonl', [
      claudeLine('claude-sonnet-4-5', 1_000_000, 0)
    ])
    const host = await createHost({ dataDir: ':memory:' })
    try {
      await host.collector.syncAll()
      expect((await host.usageQuery.getRequestLogDetail(`claude:${file}:1`))?.costUsd).toBe('3')

      const row = (await host.storage.getModelPricing()).find(
        (r) => r.model_id === 'claude-sonnet-4-5'
      )
      expect(row).toBeDefined()
      await host.storage.updateModelPricing({
        ...(row as NonNullable<typeof row>),
        input_per_million: 6,
        updated_at: Date.now()
      })
      host.pricing.invalidateCache()

      writeFileSync(
        file,
        [
          claudeLine('claude-sonnet-4-5', 1_000_000, 0),
          claudeLine('claude-sonnet-4-5', 1_000_000, 0, '2026-08-19T10:05:00+08:00')
        ].join('\n'),
        'utf8'
      )
      await host.collector.syncAll()
      expect((await host.usageQuery.getRequestLogDetail(`claude:${file}:2`))?.costUsd).toBe('6')
    } finally {
      host.dispose()
    }
  })

  it('syncAll 有新增时 emit usage-updated 事件（200ms 防抖后派发）', async () => {
    const host = await createHost({ dataDir: ':memory:' })
    const received: UsageUpdatedEvent[] = []
    host.events.on('usage-updated', (e) => received.push(e))
    try {
      writeClaudeSession('proj-a', 'session-1.jsonl', [claudeLine('claude-sonnet-4-5', 100, 0)])
      await host.collector.syncAll()
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(received).toHaveLength(1)
      expect(received[0].addedRecords).toBe(1)
      expect(received[0].updatedAt).toBeGreaterThan(0)

      await host.collector.syncAll()
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(received).toHaveLength(1)
    } finally {
      host.dispose()
    }
  })
})

describe('插件启停（经 IPC）', () => {
  it('setPluginEnabled 禁用后 syncAll 不处理该插件，重新启用后恢复', async () => {
    const file = writeClaudeSession('proj-a', 'session-1.jsonl', [
      claudeLine('claude-sonnet-4-5', 100, 0)
    ])
    const host = await createHost({ dataDir: ':memory:' })
    const ipc = makeFakeIpcMain()
    registerIpcHandlers(ipc, host, () => null)
    try {
      await host.collector.syncAll()
      expect((await host.usageQuery.getUsageSummary({})).totalRequests).toBe(1)

      await ipc.invoke('plugins:set-enabled', 'claude', false)
      expect((await host.collector.getPluginStatus()).find((s) => s.id === 'claude')?.enabled).toBe(false)

      writeFileSync(
        file,
        [
          claudeLine('claude-sonnet-4-5', 100, 0),
          claudeLine('claude-sonnet-4-5', 200, 0, '2026-08-19T10:05:00+08:00')
        ].join('\n'),
        'utf8'
      )
      await host.collector.syncAll()
      expect((await host.usageQuery.getUsageSummary({})).totalRequests).toBe(1)

      await ipc.invoke('plugins:set-enabled', 'claude', true)
      await host.collector.syncAll()
      expect((await host.usageQuery.getUsageSummary({})).totalRequests).toBe(2)
    } finally {
      host.dispose()
    }
  })

  it('反复 setPluginEnabled 5 次：无异常、启停状态正确、无资源泄漏', async () => {
    const file = writeClaudeSession('proj-a', 'session-1.jsonl', [
      claudeLine('claude-sonnet-4-5', 100, 0)
    ])
    const host = await createHost({ dataDir: ':memory:' })
    const ipc = makeFakeIpcMain()
    registerIpcHandlers(ipc, host, () => null)
    try {
      await host.collector.syncAll()
      expect((await host.usageQuery.getUsageSummary({})).totalRequests).toBe(1)

      for (let i = 0; i < 5; i++) {
        await ipc.invoke('plugins:set-enabled', 'claude', false)
        expect((await host.collector.getPluginStatus()).find((s) => s.id === 'claude')?.enabled).toBe(false)
        expect(host.lifecycle.isMounted('claude')).toBe(false)

        await ipc.invoke('plugins:set-enabled', 'claude', true)
        expect((await host.collector.getPluginStatus()).find((s) => s.id === 'claude')?.enabled).toBe(true)
        expect(host.lifecycle.isMounted('claude')).toBe(true)
      }

      writeFileSync(
        file,
        [
          claudeLine('claude-sonnet-4-5', 100, 0),
          claudeLine('claude-sonnet-4-5', 200, 0, '2026-08-19T10:05:00+08:00')
        ].join('\n'),
        'utf8'
      )
      await host.collector.syncAll()
      expect((await host.usageQuery.getUsageSummary({})).totalRequests).toBe(2)
    } finally {
      host.dispose()
    }
  })
})

describe('createCollector 插件注入', () => {
  it('支持传入自定义插件列表（注入临时会话目录，不依赖真实 CLI）', async () => {
    const sessionDir = mkdtempSync(path.join(os.tmpdir(), 'token-monitor-custom-'))
    try {
      const dataFile = path.join(sessionDir, 'custom.jsonl')
      writeFileSync(
        dataFile,
        JSON.stringify({
          type: 'assistant',
          message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 100, output_tokens: 0 } },
          timestamp: USER_TS
        }) + '\n',
        'utf8'
      )

      const customPlugin: MonitorPlugin = {
        id: 'claude',
        name: 'Custom',
        version: '0.0.1',
        deps: ['storage', 'pricing', 'events'],
        detect: async () => ({ available: true, sessionDir }),
        listFiles: async () => [{ path: dataFile, mtime: 0 }],
        parseFile: async () => {
          const obj = JSON.parse(readFileSync(dataFile, 'utf8')) as Record<string, unknown>
          const message = obj.message as Record<string, unknown>
          const usage = message.usage as Record<string, unknown>
          return {
            records: [
              {
                appType: 'claude' as const,
                model: String(message.model),
                inputTokens: Number(usage.input_tokens),
                outputTokens: Number(usage.output_tokens),
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
                inputSemantics: 1,
                createdAt: Date.parse(String(obj.timestamp)),
                source: { filePath: dataFile, line: 1 }
              }
            ],
            nextLine: 1,
            eof: true
          }
        }
      }

      const host = await createHost({ dataDir: ':memory:' })
      try {
        const collector = createCollector(host.ctx, [customPlugin])
        await collector.syncAll()
        const summary = await host.usageQuery.getUsageSummary({})
        expect(summary.totalRequests).toBe(1)
        expect(summary.inputTokens).toBe(100)
      } finally {
        host.dispose()
      }
    } finally {
      rmSync(sessionDir, { recursive: true, force: true })
    }
  })
})

const MODELSDEV_PAYLOAD = {
  anthropic: {
    name: 'Anthropic',
    models: {
      'claude-test-model': {
        id: 'claude-test-model',
        name: 'Claude Test',
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 }
      },
      broken: { cost: {} }
    }
  },
  empty: { name: 'Empty' }
}

function stubModelsDevFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => MODELSDEV_PAYLOAD
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const MINUTE_MS = 60 * 1000

function testPricing(modelId: string, overrides: Partial<ModelPricingRow> = {}): ModelPricingRow {
  return {
    model_id: modelId,
    provider: 'test',
    input_per_million: 3,
    output_per_million: 15,
    cache_read_per_million: 0,
    cache_creation_per_million: 0,
    currency: 'USD',
    cost_multiplier: 1,
    updated_at: 111,
    ...overrides
  }
}

describe('models.dev 定价目录（T8 主进程侧）', () => {
  it('默认无条件自动同步：启动即触发一次并入库；retentionDays/syncIntervalMs 不影响调度，pricingSyncIntervalMs 变化以新间隔重启', async () => {
    vi.useFakeTimers()
    const fetchMock = stubModelsDevFetch()
    const host = await createHost({ dataDir: ':memory:' })
    try {
      await vi.advanceTimersByTimeAsync(10_000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(
        (await host.storage.getModelPricing()).find((r) => r.model_id === 'claude-test-model')
      ).toMatchObject({ source: 'sync' })

      await vi.advanceTimersByTimeAsync(MINUTE_MS)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      host.updateSettings({ retentionDays: 30 })
      host.updateSettings({ syncIntervalMs: 60_000 })

      await vi.advanceTimersByTimeAsync(MINUTE_MS * 4)
      expect(fetchMock).toHaveBeenCalledTimes(2)

      host.updateSettings({ pricingSyncIntervalMs: MINUTE_MS })
      await vi.advanceTimersByTimeAsync(MINUTE_MS)
      expect(fetchMock).toHaveBeenCalledTimes(3)

      await vi.advanceTimersByTimeAsync(MINUTE_MS)
      expect(fetchMock).toHaveBeenCalledTimes(4)
    } finally {
      host.dispose()
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('IPC 冒烟：modelsdev-sync 手动全量同步入库且 pricing:list 可见', async () => {
    stubModelsDevFetch()
    const host = await createHost({ dataDir: ':memory:' })
    const ipc = makeFakeIpcMain()
    registerIpcHandlers(ipc, host, () => null)
    try {
      await expect(ipc.invoke('pricing:modelsdev-sync')).resolves.toEqual({
        fetched: 2,
        imported: 1,
        skipped: 1
      })

      const list = (await ipc.invoke('pricing:list')) as Array<{ model_id: string; source: string }>
      expect(list.find((r) => r.model_id === 'claude-test-model')).toMatchObject({ source: 'sync' })
    } finally {
      host.dispose()
      vi.unstubAllGlobals()
    }
  })
})

describe('过期明细清理调度（清理前尽力回填）', () => {
  it('启动 sweep 先回填再清理：超期零成本明细已删除，其费用保留在日聚合中', async () => {
    vi.useFakeTimers()
    const oldTs = new Date(Date.now() - 400 * 86_400_000).toISOString()
    const file = writeClaudeSession('proj-a', 'session-old.jsonl', [
      claudeLine('unknown-model-x', 1_000_000, 0, oldTs)
    ])
    const host = await createHost({ dataDir: ':memory:' })
    try {
      await vi.advanceTimersByTimeAsync(0)
      await host.collector.syncAll()
      expect(await host.usageQuery.getRequestLogDetail(`claude:${file}:1`)).toMatchObject({
        costUsd: null
      })
      expect((await host.usageQuery.getUsageSummary({})).totalCost).toBe('0')

      await host.storage.updateModelPricing(testPricing('unknown-model-x'))
      host.pricing.invalidateCache()

      await vi.advanceTimersByTimeAsync(45_000)

      expect(await host.usageQuery.getRequestLogDetail(`claude:${file}:1`)).toBeNull()
      const summary = await host.usageQuery.getUsageSummary({})
      expect(summary.totalCost).toBe('3')
      expect(summary.totalRequests).toBe(1)
    } finally {
      host.dispose()
      vi.useRealTimers()
    }
  })

  it('回填抛错不阻塞清理：sweep 后旧行仍被删除且宿主保持可用', async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const oldTs = new Date(Date.now() - 400 * 86_400_000).toISOString()
    const file = writeClaudeSession('proj-a', 'session-old.jsonl', [
      claudeLine('unknown-model-x', 100, 0, oldTs)
    ])
    const host = await createHost({ dataDir: ':memory:' })
    try {
      await vi.advanceTimersByTimeAsync(0)
      await host.collector.syncAll()
      expect(await host.usageQuery.getRequestLogDetail(`claude:${file}:1`)).not.toBeNull()

      vi.spyOn(host.pricing, 'getPrice').mockRejectedValue(new Error('pricing unavailable'))

      await vi.advanceTimersByTimeAsync(45_000)

      expect(await host.usageQuery.getRequestLogDetail(`claude:${file}:1`)).toBeNull()
      expect(errorSpy).toHaveBeenCalledWith('[host] 清理前零成本回填失败:', expect.any(Error))
      expect((await host.usageQuery.getUsageSummary({})).totalRequests).toBe(1)
    } finally {
      errorSpy.mockRestore()
      host.dispose()
      vi.useRealTimers()
    }
  })
})
