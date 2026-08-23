import { describe, it, expect, vi } from 'vitest'
import type { PluginContext } from '../../shared/context'
import type { UsageRecord } from '../../shared/dto'
import type { MonitorPlugin } from '../../shared/plugin'
import { createCollector } from './collector'
import { detectCliVersion } from './services/cli-version'

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
  detectCliVersion: vi.fn(async (command: string) => (command === 'opencode' ? '9.9.9' : null))
}))

/** 构造一条可复用的测试用量记录 */
function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    appType: 'opencode',
    model: 'gpt-5',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 20,
    cacheCreationTokens: 10,
    inputSemantics: 1,
    status: 'success',
    createdAt: new Date('2026-08-22T10:00:00+08:00').getTime(),
    source: { filePath: '/tmp/sessions/opencode-2026-08-22.jsonl', line: 1 },
    ...overrides
  }
}

const FAKE_FILE = '/tmp/fake/session.jsonl'

function makeCtx(): { ctx: PluginContext; recorded: UsageRecord[] } {
  const recorded: UsageRecord[] = []
  const ctx: PluginContext = {
    storage: {
      recordUsage: vi.fn(async (records: UsageRecord[]) => {
        recorded.push(...records)
        return records.length
      }),
      getCursor: vi.fn(async () => null),
      setCursor: vi.fn(async () => undefined),
      getModelPricing: vi.fn(async () => []),
      updateModelPricing: vi.fn(async () => undefined),
      deleteModelPricing: vi.fn(async () => undefined)
    },
    pricing: {
      normalizeModelId: vi.fn(async (rawModel: string) => rawModel),
      calcCost: vi.fn(async () => '0.006'),
      getPrice: vi.fn(async () => undefined)
    },
    events: {
      emit: vi.fn(),
      on: vi.fn(() => () => undefined)
    },
    scheduler: {
      schedule: vi.fn(() => () => undefined)
    },
    watcher: {
      registerWatcher: vi.fn(() => () => undefined)
    }
  }
  return { ctx, recorded }
}

function makePlugin(records: UsageRecord[], overrides: Partial<MonitorPlugin> = {}): MonitorPlugin {
  return {
    id: 'opencode',
    name: 'Fake OpenCode',
    version: '0.0.1',
    deps: ['storage', 'pricing'],
    detect: async () => ({ available: true, sessionDir: '/tmp/fake' }),
    listFiles: async () => [{ path: FAKE_FILE, mtime: 1 }],
    parseFile: async () => ({
      records,
      nextLine: records.length,
      eof: true
    }),
    ...overrides
  }
}

describe('createCollector 全 0 token 记录拦截', () => {
  it('全 0 记录被跳过：不写入 storage、不计费，游标仍按 nextLine 推进', async () => {
    const zeroRecord = makeRecord({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      source: { filePath: FAKE_FILE, line: 1 }
    })
    const validRecord = makeRecord({
      source: { filePath: FAKE_FILE, line: 2 }
    })
    const { ctx, recorded } = makeCtx()
    const collector = createCollector(ctx, [makePlugin([zeroRecord, validRecord])])

    const result = await collector.syncAll()

    expect(recorded).toEqual([validRecord])
    expect(result.imported).toBe(1)
    expect(result.addedRecords).toBe(1)
    expect(ctx.pricing.calcCost).toHaveBeenCalledTimes(1)
    expect(ctx.pricing.calcCost).toHaveBeenCalledWith(validRecord)
    expect(ctx.storage.setCursor).toHaveBeenCalledWith(FAKE_FILE, 2, 1)
  })

  it('含非 0 token 的记录正常入库并完成费用回填', async () => {
    const record = makeRecord({
      inputTokens: 500,
      outputTokens: 200,
      cacheReadTokens: 30,
      cacheCreationTokens: 40
    })
    const { ctx, recorded } = makeCtx()
    const collector = createCollector(ctx, [makePlugin([record])])

    const result = await collector.syncAll()

    expect(result.errors).toBe(0)
    expect(result.addedRecords).toBe(1)
    expect(ctx.storage.recordUsage).toHaveBeenCalledTimes(1)
    expect(recorded[0].costUsd).toBe('0.006')
  })
})

describe('getPluginStatus CLI 版本接线', () => {
  it('探测成功时 cliVersion 并入状态', async () => {
    const { ctx } = makeCtx()
    const collector = createCollector(ctx, [makePlugin([])])

    const statuses = await collector.getPluginStatus()

    expect(detectCliVersion).toHaveBeenCalledWith('opencode')
    expect(statuses[0].id).toBe('opencode')
    expect(statuses[0].cliVersion).toBe('9.9.9')
  })

  it('探测失败时不携带 cliVersion 字段', async () => {
    const { ctx } = makeCtx()
    const collector = createCollector(ctx, [makePlugin([], { id: 'grok' })])

    const statuses = await collector.getPluginStatus()

    expect(statuses[0].id).toBe('grok')
    expect('cliVersion' in statuses[0]).toBe(false)
  })
})
