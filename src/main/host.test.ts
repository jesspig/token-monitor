import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import type { UsageUpdatedEvent } from '../../shared/context'
import type { MonitorPlugin } from '../../shared/plugin'
import type { BudgetStatus } from '../../shared/query'
import { createCollector } from './collector'
import { createHost } from './host'
import { registerIpcHandlers, type IpcMainLike } from './ipc/register'

/**
 * 集成测试：宿主装配（createHost）+ 采集（collector.syncAll）+ IPC（registerIpcHandlers）。
 * 不依赖真实 ~/.claude：beforeEach 用 vi.spyOn 把 os.homedir 指向临时目录，
 * claude 插件即扫描临时目录下的 .claude/projects 会话 JSONL。
 */

/** 可注入的 fake ipcMain（记录 handler 并支持 invoke；handler 同步抛错转为 rejection，对齐 ipcRenderer.invoke 语义） */
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

/** claude 会话 JSONL 单行（assistant + message.usage） */
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

/** 在临时 homedir 下写一个 claude 会话文件，返回绝对路径（不带尾随 \n，游标语义与插件测试一致） */
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
})

afterEach(() => {
  homeSpy.mockRestore()
  rmSync(tempHome, { recursive: true, force: true })
})

describe('createHost 装配', () => {
  it('listPlugins 返回 5 个内置插件，默认全启用；claude 检测可用', async () => {
    mkdirSync(path.join(tempHome, '.claude', 'projects'), { recursive: true })
    const host = await createHost({ dataDir: ':memory:' })
    try {
      const statuses = await host.collector.getPluginStatus()
      expect(statuses).toHaveLength(5)
      expect(statuses.map((s) => s.id).sort()).toEqual(['claude', 'codex', 'gemini', 'grok', 'opencode'])
      for (const s of statuses) expect(s.enabled).toBe(true)

      const claude = statuses.find((s) => s.id === 'claude')
      expect(claude?.available).toBe(true)
      expect(claude?.lastSyncAt).toBeNull()
      expect(claude?.errorCount).toBe(0)
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
    // 时间戳取「现在」，保证 rollup 归桶落在本地今天（预算口径为当日/当月）
    writeClaudeSession('proj-a', 'session-1.jsonl', [
      claudeLine('claude-sonnet-4-5', 1_000_000, 0, new Date().toISOString())
    ])
    const host = await createHost({ dataDir: ':memory:' })
    const ipc = makeFakeIpcMain()
    registerIpcHandlers(ipc, host, () => null)
    try {
      await host.collector.syncAll()

      // 未设置预算：不告警，但今日费用可见（seed 价 input $3/M → 3 USD）
      const unset = (await ipc.invoke('budget:status')) as BudgetStatus
      expect(unset.dailyBudgetUsd).toBeNull()
      expect(unset.monthlyBudgetUsd).toBeNull()
      expect(unset.dailyUsageRatio).toBeNull()
      expect(unset.dailyExceeded).toBe(false)
      expect(unset.monthlyExceeded).toBe(false)
      expect(unset.dailyCostUsd).toBe('3')

      // 设置日预算 2 < 今日费用 3 → 日超限；月上限未设 → 月维度不告警
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

      // 覆盖为 3 行（保留原第 1 行 + 新增 2 行）
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
      expect(result.addedRecords).toBe(2) // 去重后仅新增 2 行

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
      // seed 价格 input 3/M → 1M token = 3 USD
      expect((await host.usageQuery.getRequestLogDetail(`claude:${file}:1`))?.costUsd).toBe('3')

      // 更新定价（input 3 → 6）并失效 pricing 缓存
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

      // 追加一行 → 新记录按新价计算 = 6 USD
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
      // 等待 EventBus 200ms 防抖窗口结束
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(received).toHaveLength(1)
      expect(received[0].addedRecords).toBe(1)
      expect(received[0].updatedAt).toBeGreaterThan(0)

      // 无新增时不触发
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

      // 停用 claude：注册表置为禁用 + 卸载（watcher 一并清理）
      await ipc.invoke('plugins:set-enabled', 'claude', false)
      expect((await host.collector.getPluginStatus()).find((s) => s.id === 'claude')?.enabled).toBe(false)

      // 追加行后同步：claude 被跳过，不新增
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

      // 重新启用后可再次同步
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

      // 连续 5 轮启停：每轮 mount/unmount（watcher 注册/清理）都应可逆、无异常
      for (let i = 0; i < 5; i++) {
        await ipc.invoke('plugins:set-enabled', 'claude', false)
        expect((await host.collector.getPluginStatus()).find((s) => s.id === 'claude')?.enabled).toBe(false)
        expect(host.lifecycle.isMounted('claude')).toBe(false)

        await ipc.invoke('plugins:set-enabled', 'claude', true)
        expect((await host.collector.getPluginStatus()).find((s) => s.id === 'claude')?.enabled).toBe(true)
        expect(host.lifecycle.isMounted('claude')).toBe(true)
      }

      // 最终处于启用状态，追加行可正常同步
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

/** models.dev api.json 最小载荷：1 有效 + 1 解析丢弃 + 1 无 models 的 provider */
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

const HOUR_MS = 60 * 60 * 1000

describe('models.dev 定价目录（T8 主进程侧）', () => {
  it('autoSyncPricing 开关切换每日自动同步调度；dispose 清理', async () => {
    vi.useFakeTimers()
    const fetchMock = stubModelsDevFetch()
    const host = await createHost({ dataDir: ':memory:' })
    try {
      // 默认关闭（undefined）：推进 25h 不触发同步
      await vi.advanceTimersByTimeAsync(25 * HOUR_MS)
      expect(fetchMock).not.toHaveBeenCalled()

      // 开启：注册调度，推进满一个周期（24h）触发一次并入库（sync 来源）
      host.updateSettings({ autoSyncPricing: true })
      expect(host.getSettings().autoSyncPricing).toBe(true)
      await vi.advanceTimersByTimeAsync(24 * HOUR_MS)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(
        (await host.storage.getModelPricing()).find((r) => r.model_id === 'claude-test-model')
      ).toMatchObject({ source: 'sync' })

      // 关闭：再推进 48h 无新调用
      host.updateSettings({ autoSyncPricing: false })
      expect(host.getSettings().autoSyncPricing).toBe(false)
      await vi.advanceTimersByTimeAsync(48 * HOUR_MS)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      host.dispose()
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('IPC 冒烟：modelsdev-sync/catalog/import 三通道贯通', async () => {
    stubModelsDevFetch()
    const host = await createHost({ dataDir: ':memory:' })
    const ipc = makeFakeIpcMain()
    registerIpcHandlers(ipc, host, () => null)
    try {
      // 手动全量同步：fetched = imported + skipped
      await expect(ipc.invoke('pricing:modelsdev-sync')).resolves.toEqual({
        fetched: 2,
        imported: 1,
        skipped: 1
      })

      // 在线目录：供前端勾选的条目数组
      const catalog = (await ipc.invoke('pricing:modelsdev-catalog')) as {
        entries: Array<{ modelId: string; inputPerMillion: number }>
        total: number
        skipped: number
      }
      expect(catalog.total).toBe(2)
      expect(catalog.skipped).toBe(1)
      const picked = catalog.entries.find((e) => e.modelId === 'claude-test-model')
      expect(picked).toMatchObject({ inputPerMillion: 3 })

      // 导入勾选子集：user 来源写入；非法条目跳过；非数组抛错
      await expect(ipc.invoke('pricing:modelsdev-import', [picked, { nope: true }])).resolves.toEqual({
        imported: 1
      })
      expect(
        (await host.storage.getModelPricing()).find((r) => r.model_id === 'claude-test-model')
      ).toMatchObject({ source: 'user' })
      await expect(ipc.invoke('pricing:modelsdev-import', 'nope')).rejects.toThrow(
        /必须为条目数组/
      )
    } finally {
      host.dispose()
      vi.unstubAllGlobals()
    }
  })
})
