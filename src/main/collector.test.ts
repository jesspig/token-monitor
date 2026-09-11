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
      getCursorMeta: vi.fn(async () => null),
      setCursor: vi.fn(async () => undefined),
      getModelPricing: vi.fn(async () => []),
      updateModelPricing: vi.fn(async () => undefined),
      updateModelPricingBatch: vi.fn(async (entries: unknown[]) => entries.length),
      deleteModelPricing: vi.fn(async () => undefined)
    },
    pricing: {
      normalizeModelId: vi.fn(async (rawModel: string) => rawModel),
      calcCost: vi.fn(async () => '0.006'),
      calcCostBatch: vi.fn(async (records: UsageRecord[]) =>
        Promise.all(records.map((record) => ctx.pricing.calcCost(record)))
      ),
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

describe('syncAll mtime 短路', () => {
  it('游标 mtime 与文件一致且均非 0 时跳过：不解析、不入库、不推游标', async () => {
    const { ctx } = makeCtx()
    vi.mocked(ctx.storage.getCursorMeta).mockResolvedValue({
      lineOffset: 5,
      fileMtime: 1000
    })
    const parseSpy = vi.fn(async () => ({ records: [], nextLine: 5, eof: true }))
    const collector = createCollector(ctx, [
      makePlugin([], {
        listFiles: async () => [{ path: FAKE_FILE, mtime: 1000 }],
        parseFile: parseSpy
      })
    ])

    const result = await collector.syncAll()

    expect(parseSpy).toHaveBeenCalledTimes(0)
    expect(ctx.storage.recordUsage).toHaveBeenCalledTimes(0)
    expect(ctx.storage.setCursor).toHaveBeenCalledTimes(0)
    expect(result.imported).toBe(0)
    expect(result.addedRecords).toBe(0)
  })

  it('mtime 变化后照常解析，parseFile 以游标 lineOffset 续读', async () => {
    const { ctx, recorded } = makeCtx()
    vi.mocked(ctx.storage.getCursorMeta).mockResolvedValue({
      lineOffset: 7,
      fileMtime: 1000
    })
    const record = makeRecord({ source: { filePath: FAKE_FILE, line: 8 } })
    const parseSpy = vi.fn(async () => ({ records: [record], nextLine: 8, eof: true }))
    const collector = createCollector(ctx, [
      makePlugin([], {
        listFiles: async () => [{ path: FAKE_FILE, mtime: 2000 }],
        parseFile: parseSpy
      })
    ])

    const result = await collector.syncAll()

    expect(parseSpy).toHaveBeenCalledTimes(1)
    expect(parseSpy).toHaveBeenCalledWith(ctx, FAKE_FILE, 7)
    expect(recorded).toEqual([record])
    expect(ctx.storage.setCursor).toHaveBeenCalledWith(FAKE_FILE, 8, 2000)
    expect(result.addedRecords).toBe(1)
  })

  it('file.mtime 与游标 fileMtime 均为 0 时不短路，照常解析', async () => {
    const { ctx } = makeCtx()
    vi.mocked(ctx.storage.getCursorMeta).mockResolvedValue({ lineOffset: 5, fileMtime: 0 })
    const record = makeRecord({ source: { filePath: FAKE_FILE, line: 6 } })
    const parseSpy = vi.fn(async () => ({ records: [record], nextLine: 6, eof: true }))
    const collector = createCollector(ctx, [
      makePlugin([], {
        listFiles: async () => [{ path: FAKE_FILE, mtime: 0 }],
        parseFile: parseSpy
      })
    ])

    await collector.syncAll()

    expect(parseSpy).toHaveBeenCalledTimes(1)
    expect(parseSpy).toHaveBeenCalledWith(ctx, FAKE_FILE, 5)
    expect(ctx.storage.setCursor).toHaveBeenCalledWith(FAKE_FILE, 6, 0)
  })

  it('游标不存在（getCursorMeta 返回 null）时从第 0 行全量解析', async () => {
    const { ctx } = makeCtx()
    const record = makeRecord({ source: { filePath: FAKE_FILE, line: 1 } })
    const parseSpy = vi.fn(async () => ({ records: [record], nextLine: 1, eof: true }))
    const collector = createCollector(ctx, [makePlugin([], { parseFile: parseSpy })])

    await collector.syncAll()

    expect(parseSpy).toHaveBeenCalledWith(ctx, FAKE_FILE, 0)
  })
})

describe('syncPlugin 定向同步', () => {
  it('只同步目标插件：另一插件的 detect/listFiles/parseFile 完全不被触碰', async () => {
    const { ctx, recorded } = makeCtx()
    const recordA = makeRecord({ source: { filePath: FAKE_FILE, line: 1 } })
    const untouchedFns = {
      detect: vi.fn(async () => ({ available: true, sessionDir: '/tmp/other' })),
      listFiles: vi.fn(async () => [{ path: '/tmp/other/session.jsonl', mtime: 1 }]),
      parseFile: vi.fn(async () => ({ records: [], nextLine: 0, eof: true }))
    }
    const collector = createCollector(ctx, [
      makePlugin([recordA]),
      makePlugin([], { id: 'grok', ...untouchedFns })
    ])

    const result = await collector.syncPlugin('opencode')

    expect(result.imported).toBe(1)
    expect(result.addedRecords).toBe(1)
    expect(recorded).toEqual([recordA])
    expect(untouchedFns.detect).toHaveBeenCalledTimes(0)
    expect(untouchedFns.listFiles).toHaveBeenCalledTimes(0)
    expect(untouchedFns.parseFile).toHaveBeenCalledTimes(0)
  })

  it('对不存在的插件 id 返回零值结果且不抛错', async () => {
    const { ctx } = makeCtx()
    const collector = createCollector(ctx, [makePlugin([])])

    const result = await collector.syncPlugin('codex')

    expect(result).toEqual({ imported: 0, errors: 0, addedRecords: 0 })
    expect(ctx.storage.recordUsage).toHaveBeenCalledTimes(0)
  })

  it('有新增记录时推 usage-updated；无新增时不推', async () => {
    const { ctx } = makeCtx()
    const record = makeRecord({ source: { filePath: FAKE_FILE, line: 1 } })
    const collector = createCollector(ctx, [makePlugin([record])])

    const first = await collector.syncPlugin('opencode')

    expect(first.addedRecords).toBe(1)
    expect(ctx.events.emit).toHaveBeenCalledWith(
      'usage-updated',
      expect.objectContaining({ addedRecords: 1 })
    )

    vi.mocked(ctx.storage.getCursorMeta).mockResolvedValue({ lineOffset: 1, fileMtime: 1 })

    const second = await collector.syncPlugin('opencode')

    expect(second.addedRecords).toBe(0)
    expect(ctx.events.emit).toHaveBeenCalledTimes(1)
  })

  it('存储返回有效快照更新 1 时继续推送事件，相同快照返回 0 时不推送', async () => {
    const { ctx } = makeCtx()
    const record = makeRecord({
      isReplaceableSnapshot: true,
      source: { filePath: FAKE_FILE, line: 1, requestId: 'snapshot-1' }
    })
    vi.mocked(ctx.storage.recordUsage)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
    const collector = createCollector(ctx, [makePlugin([record])])

    const inserted = await collector.syncPlugin('opencode')
    const updated = await collector.syncPlugin('opencode')
    const replayed = await collector.syncPlugin('opencode')

    expect(inserted.addedRecords).toBe(1)
    expect(updated.addedRecords).toBe(1)
    expect(replayed.addedRecords).toBe(0)
    expect(ctx.events.emit).toHaveBeenCalledTimes(2)
    expect(ctx.events.emit).toHaveBeenNthCalledWith(
      2,
      'usage-updated',
      expect.objectContaining({ addedRecords: 1 })
    )
  })
})
