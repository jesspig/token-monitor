import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import type { UsageUpdatedEvent } from '../../shared/context'
import type { MonitorPlugin } from '../../shared/plugin'
import { createCollector } from './collector'
import { createHost } from './host'
import { registerIpcHandlers, type IpcMainLike } from './ipc/register'

/**
 * 集成测试：宿主装配（createHost）+ 采集（collector.syncAll）+ IPC（registerIpcHandlers）。
 * 不依赖真实 ~/.claude：beforeEach 用 vi.spyOn 把 os.homedir 指向临时目录，
 * claude 插件即扫描临时目录下的 .claude/projects 会话 JSONL。
 */

/** 可注入的 fake ipcMain（记录 handler 并支持同步 invoke） */
type FakeIpc = IpcMainLike & {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
}
function makeFakeIpcMain(): FakeIpc {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handle(channel, listener) {
      handlers.set(channel, listener as (...args: unknown[]) => unknown)
    },
    invoke(channel, ...args) {
      const h = handlers.get(channel)
      if (!h) return Promise.reject(new Error(`No handler for "${channel}"`))
      return Promise.resolve(h({ sender: {} }, ...args))
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
