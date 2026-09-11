import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import {
  clearCopilotCliDeltaStateCache,
  copilotCliPlugin,
  detectFromRoot,
  listFilesFromRoot,
  parseTsMs,
  sessionStateRootOf
} from './copilot-cli'
import type { PluginContext } from '../../../shared/context'

const ctx = {} as PluginContext

interface Buckets {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

const B = (input: number, output = 0, cacheRead = 0, cacheWrite = 0): Buckets => ({
  input,
  output,
  cacheRead,
  cacheWrite
})

const shutdownOf = (
  models: Record<string, Buckets>,
  o: { id?: unknown; timestamp?: unknown } = {}
): string =>
  JSON.stringify({
    type: 'session.shutdown',
    ...('id' in o ? { id: o.id } : { id: 'evt-1' }),
    ...('timestamp' in o ? { timestamp: o.timestamp } : { timestamp: '2026-05-07T10:57:19.746Z' }),
    data: {
      modelMetrics: Object.fromEntries(
        Object.entries(models).map(([model, u]) => [
          model,
          {
            usage: {
              inputTokens: u.input,
              outputTokens: u.output,
              cacheReadTokens: u.cacheRead,
              cacheWriteTokens: u.cacheWrite,
              reasoningTokens: 0
            },
            requests: { count: 1, cost: 15 }
          }
        ])
      )
    }
  })

let tmpDir = ''

const envKeys = ['COPILOT_DIR', 'COPILOT_HOME', 'COPILOT_CONFIG_DIR'] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  clearCopilotCliDeltaStateCache()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-cli-plugin-'))
  for (const k of envKeys) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  for (const k of envKeys) {
    const v = savedEnv[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const writeEvents = (relDir: string, lines: string[]): string => {
  const dir = path.join(tmpDir, relDir)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'events.jsonl')
  fs.writeFileSync(file, lines.join('\n'), 'utf8')
  return file
}

describe('copilotCliPlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(copilotCliPlugin.id).toBe('copilot-cli')
    expect(copilotCliPlugin.name).toBe('Copilot CLI')
    expect(copilotCliPlugin.version).toBe('1.0.0')
    expect(copilotCliPlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('sessionStateRootOf 路径解析', () => {
  it('COPILOT_DIR 最高优先且语义为 session-state 目录本身', () => {
    const dir = path.join(tmpDir, 'state')
    process.env.COPILOT_DIR = dir
    process.env.COPILOT_HOME = path.join(tmpDir, 'home')
    process.env.COPILOT_CONFIG_DIR = path.join(tmpDir, 'config')
    expect(sessionStateRootOf()).toBe(dir)
  })

  it('COPILOT_HOME 优先于 COPILOT_CONFIG_DIR，均拼接 session-state', () => {
    process.env.COPILOT_HOME = path.join(tmpDir, 'home')
    process.env.COPILOT_CONFIG_DIR = path.join(tmpDir, 'config')
    expect(sessionStateRootOf()).toBe(path.join(tmpDir, 'home', 'session-state'))
  })

  it('仅 COPILOT_CONFIG_DIR 时生效', () => {
    process.env.COPILOT_CONFIG_DIR = path.join(tmpDir, 'config')
    expect(sessionStateRootOf()).toBe(path.join(tmpDir, 'config', 'session-state'))
  })

  it('空白值视为未设置：逐级回退，全空走 ~/.copilot/session-state', () => {
    process.env.COPILOT_HOME = '   '
    process.env.COPILOT_CONFIG_DIR = path.join(tmpDir, 'config')
    expect(sessionStateRootOf()).toBe(path.join(tmpDir, 'config', 'session-state'))

    process.env.COPILOT_CONFIG_DIR = '  '
    expect(sessionStateRootOf()).toBe(path.join(os.homedir(), '.copilot', 'session-state'))
  })
})

describe('detect 三态', () => {
  it('session-state 根缺失时不可用，reason 说明默认路径与覆盖变量', () => {
    const root = path.join(tmpDir, 'session-state')
    const res = detectFromRoot(root)
    expect(res.available).toBe(false)
    expect(res.reason).toContain('~/.copilot/session-state')
    expect(res.reason).toContain('COPILOT_DIR')
    expect(res.sessionDir).toBe(root)
  })

  it('根存在但无 <uuid>/events.jsonl 时不可用', () => {
    const root = path.join(tmpDir, 'session-state')
    fs.mkdirSync(path.join(root, 'empty-session'), { recursive: true })
    const res = detectFromRoot(root)
    expect(res.available).toBe(false)
    expect(res.reason).toContain('events.jsonl')
    expect(res.sessionDir).toBe(root)
  })

  it('根存在且含会话 events.jsonl 时可用', () => {
    const root = path.join(tmpDir, 'session-state')
    fs.mkdirSync(path.join(root, 'sess-1'), { recursive: true })
    fs.writeFileSync(path.join(root, 'sess-1', 'events.jsonl'), shutdownOf({ m: B(1) }), 'utf8')
    const res = detectFromRoot(root)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(root)
  })

  it('环境变量覆盖下 detect 与 listFiles 走覆盖目录', async () => {
    const root = path.join(tmpDir, 'override', 'session-state')
    fs.mkdirSync(path.join(root, 's1'), { recursive: true })
    fs.writeFileSync(path.join(root, 's1', 'events.jsonl'), shutdownOf({ m: B(1) }), 'utf8')
    process.env.COPILOT_DIR = root

    const det = await copilotCliPlugin.detect(ctx)
    expect(det.available).toBe(true)
    expect(det.sessionDir).toBe(root)

    const files = await copilotCliPlugin.listFiles(ctx)
    expect(files.map((f) => f.path)).toEqual([path.join(root, 's1', 'events.jsonl')])
  })
})

describe('listFilesFromRoot', () => {
  it('只收集一级子目录的 events.jsonl：平铺 jsonl 不收，临时/隐藏目录与嵌套布局过滤', () => {
    const root = path.join(tmpDir, 'session-state')
    const mk = (rel: string, asDir = false): void => {
      const p = path.join(root, rel)
      if (asDir) {
        fs.mkdirSync(p, { recursive: true })
        return
      }
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, shutdownOf({ m: B(1) }), 'utf8')
    }
    mk(path.join('uuid-b', 'events.jsonl'))
    mk(path.join('uuid-a', 'events.jsonl'))
    mk('flat.jsonl')
    mk(path.join('.hidden', 'events.jsonl'))
    mk(path.join('sess.tmp', 'events.jsonl'))
    mk(path.join('sess~', 'events.jsonl'))
    mk(path.join('sess.swp', 'events.jsonl'))
    mk(path.join('uuid-c', 'other.jsonl'))
    mk(path.join('uuid-c', 'nested', 'events.jsonl'))
    mk(path.join('uuid-d', 'events.jsonl'), true)

    const entries = listFilesFromRoot(root)
    expect(entries.map((e) => e.path)).toEqual([
      path.join(root, 'uuid-a', 'events.jsonl'),
      path.join(root, 'uuid-b', 'events.jsonl')
    ])
    for (const e of entries) {
      expect(e.mtime).toBeGreaterThan(0)
    }
  })
})

describe('parseEventsFile shutdown 事件映射', () => {
  it('单 shutdown 多模型产出多条：四桶映射、semantics=1、requestId 含 model、-1m 后缀原样', async () => {
    const file = writeEvents('sess-1', [
      shutdownOf(
        {
          'claude-opus-4.7': B(23399, 2994, 10069, 13324),
          'gpt-5.1-1m': B(100, 20, 30, 40)
        },
        { id: 'evt-1', timestamp: '2026-05-07T10:57:19.746Z' }
      )
    ])

    const res = await copilotCliPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.nextLine).toBe(2)
    expect(res.eof).toBe(true)

    const [r1, r2] = res.records
    expect(r1).toMatchObject({
      appType: 'copilot-cli',
      model: 'claude-opus-4.7',
      rawModel: 'claude-opus-4.7',
      inputTokens: 23399,
      outputTokens: 2994,
      cacheReadTokens: 10069,
      cacheCreationTokens: 13324,
      inputSemantics: 1,
      status: 'success'
    })
    expect(r1.createdAt).toBe(Date.parse('2026-05-07T10:57:19.746Z'))
    expect(r1.source).toEqual({
      filePath: file,
      line: 1,
      requestId: 'evt-1:claude-opus-4.7'
    })

    expect(r2).toMatchObject({
      model: 'gpt-5.1-1m',
      rawModel: 'gpt-5.1-1m',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
      inputSemantics: 1
    })
    expect(r2.source.requestId).toBe('evt-1:gpt-5.1-1m')
  })

  it('非 shutdown 行、缺 modelMetrics 的 shutdown 行与中间坏 JSON 行均跳过且游标推进', async () => {
    const file = writeEvents('sess-2', [
      JSON.stringify({ type: 'session.start', id: 'evt-0', timestamp: '2026-05-07T10:00:00Z', data: {} }),
      '{this is broken json',
      shutdownOf({ m: B(10, 5) }, { id: 'evt-1', timestamp: '2026-05-07T10:01:00Z' }),
      JSON.stringify({ type: 'session.shutdown', id: 'evt-2', timestamp: '2026-05-07T10:02:00Z' })
    ])

    const res = await copilotCliPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.line).toBe(3)
    expect(res.records[0].model).toBe('m')
    expect(res.records[0].inputTokens).toBe(10)
    expect(res.nextLine).toBe(5)
    expect(res.eof).toBe(true)
  })

  it('timestamp 缺失时 createdAt 兜底非 NaN；id 缺失时 requestId 用 timestamp；均缺失时用行号', async () => {
    const file = writeEvents('sess-3', [
      JSON.stringify({
        type: 'session.shutdown',
        id: 'evt-9',
        data: { modelMetrics: { m1: { usage: { inputTokens: 5, outputTokens: 1 } } } }
      }),
      JSON.stringify({
        type: 'session.shutdown',
        timestamp: '2026-05-07T12:00:00.000Z',
        data: { modelMetrics: { m2: { usage: { inputTokens: 6, outputTokens: 2 } } } }
      }),
      JSON.stringify({
        type: 'session.shutdown',
        data: { modelMetrics: { m3: { usage: { inputTokens: 7, outputTokens: 3 } } } }
      })
    ])

    const res = await copilotCliPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(3)

    const [r1, r2, r3] = res.records
    expect(r1.source.requestId).toBe('evt-9:m1')
    expect(Number.isNaN(r1.createdAt)).toBe(false)
    expect(Math.abs(r1.createdAt - Date.now())).toBeLessThan(60_000)
    expect(r1.inputTokens).toBe(5)
    expect(r1.cacheReadTokens).toBe(0)
    expect(r1.cacheCreationTokens).toBe(0)

    expect(r2.source.requestId).toBe('2026-05-07T12:00:00.000Z:m2')
    expect(r2.createdAt).toBe(Date.parse('2026-05-07T12:00:00.000Z'))

    expect(r3.source.requestId).toBe('line-3:m3')
  })
})

describe('delta 增量状态机', () => {
  it('resume 双 shutdown：第二次 shutdown 只产出相对首次的增量', async () => {
    const first = shutdownOf(
      { 'claude-opus-4.7': B(1000, 200, 300, 400) },
      { id: 'evt-1', timestamp: '2026-05-07T10:00:00Z' }
    )
    const file = writeEvents('sess-4', [first])

    const r1 = await copilotCliPlugin.parseFile(ctx, file, 0)
    expect(r1.records).toHaveLength(1)
    expect(r1.records[0]).toMatchObject({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 300,
      cacheCreationTokens: 400
    })

    const second = shutdownOf(
      { 'claude-opus-4.7': B(1500, 350, 300, 900) },
      { id: 'evt-2', timestamp: '2026-05-07T11:00:00Z' }
    )
    fs.writeFileSync(file, [first, second].join('\n'), 'utf8')

    const r2 = await copilotCliPlugin.parseFile(ctx, file, r1.nextLine)
    expect(r2.records).toHaveLength(1)
    expect(r2.records[0]).toMatchObject({
      inputTokens: 500,
      outputTokens: 150,
      cacheReadTokens: 0,
      cacheCreationTokens: 500,
      inputSemantics: 1
    })
    expect(r2.records[0].source).toEqual({
      filePath: file,
      line: 2,
      requestId: 'evt-2:claude-opus-4.7'
    })
    expect(r2.eof).toBe(true)
  })

  it('缓存清空后从文件前缀重建多模型基线，仅产出游标后的真实增量', async () => {
    const l1 = shutdownOf(
      { a: B(100, 20, 30, 40), b: B(50, 10, 5, 0) },
      { id: 'evt-1', timestamp: '2026-05-07T10:00:00Z' }
    )
    const file = writeEvents('sess-restart', [l1])
    const r1 = await copilotCliPlugin.parseFile(ctx, file, 0)

    const l2 = shutdownOf(
      { a: B(160, 25, 50, 40), b: B(80, 18, 5, 7) },
      { id: 'evt-2', timestamp: '2026-05-07T11:00:00Z' }
    )
    fs.writeFileSync(file, [l1, l2].join('\n'), 'utf8')
    clearCopilotCliDeltaStateCache()

    const r2 = await copilotCliPlugin.parseFile(ctx, file, r1.nextLine)
    expect(r2.records.map((record) => [
      record.model,
      record.inputTokens,
      record.outputTokens,
      record.cacheReadTokens,
      record.cacheCreationTokens
    ])).toEqual([
      ['a', 60, 5, 20, 0],
      ['b', 30, 8, 0, 7]
    ])
    expect(r2.records.map((record) => record.source.line)).toEqual([2, 2])

    const r3 = await copilotCliPlugin.parseFile(ctx, file, r2.nextLine)
    expect(r3.records).toHaveLength(0)
    expect(r3.nextLine).toBe(r2.nextLine)
  })

  it('缓存条目被容量淘汰后仍从前缀恢复基线', async () => {
    const l1 = shutdownOf({ m: B(100, 20) }, { id: 'evt-1', timestamp: '2026-05-07T10:00:00Z' })
    const file = writeEvents('sess-evicted', [l1])
    const r1 = await copilotCliPlugin.parseFile(ctx, file, 0)

    for (let i = 0; i < 512; i++) {
      const filler = writeEvents(`filler-${i}`, [shutdownOf({ m: B(i + 1) }, { id: `filler-${i}` })])
      await copilotCliPlugin.parseFile(ctx, filler, 0)
    }

    const l2 = shutdownOf({ m: B(145, 32) }, { id: 'evt-2', timestamp: '2026-05-07T11:00:00Z' })
    fs.writeFileSync(file, [l1, l2].join('\n'), 'utf8')
    const r2 = await copilotCliPlugin.parseFile(ctx, file, r1.nextLine)

    expect(r2.records).toHaveLength(1)
    expect(r2.records[0]).toMatchObject({ inputTokens: 45, outputTokens: 12 })
    expect(r2.records[0].source.requestId).toBe('evt-2:m')
  })

  it('累计值变小（异常）不产出负数：缩水与恢复至旧水位以下均不产出，超过旧水位按旧水位算增量', async () => {
    const l1 = shutdownOf({ m: B(1000, 100) }, { id: 'evt-1', timestamp: '2026-05-07T10:00:00Z' })
    const l2 = shutdownOf({ m: B(500, 50) }, { id: 'evt-2', timestamp: '2026-05-07T11:00:00Z' })
    const l3 = shutdownOf({ m: B(800, 80) }, { id: 'evt-3', timestamp: '2026-05-07T12:00:00Z' })
    const l4 = shutdownOf({ m: B(1200, 120) }, { id: 'evt-4', timestamp: '2026-05-07T13:00:00Z' })
    const file = writeEvents('sess-5', [l1])

    const r1 = await copilotCliPlugin.parseFile(ctx, file, 0)
    expect(r1.records.map((r) => r.inputTokens)).toEqual([1000])

    fs.writeFileSync(file, [l1, l2].join('\n'), 'utf8')
    clearCopilotCliDeltaStateCache()
    const r2 = await copilotCliPlugin.parseFile(ctx, file, r1.nextLine)
    expect(r2.records).toHaveLength(0)
    expect(r2.nextLine).toBe(3)

    fs.writeFileSync(file, [l1, l2, l3].join('\n'), 'utf8')
    clearCopilotCliDeltaStateCache()
    const r3 = await copilotCliPlugin.parseFile(ctx, file, r2.nextLine)
    expect(r3.records).toHaveLength(0)
    expect(r3.nextLine).toBe(4)

    fs.writeFileSync(file, [l1, l2, l3, l4].join('\n'), 'utf8')
    clearCopilotCliDeltaStateCache()
    const r4 = await copilotCliPlugin.parseFile(ctx, file, r3.nextLine)
    expect(r4.records.map((r) => r.inputTokens)).toEqual([200])
  })

  it('单个桶回退时保留该桶历史高水位，其他增长桶仍正常产出', async () => {
    const l1 = shutdownOf({ m: B(100, 100, 30, 40) }, { id: 'evt-1' })
    const l2 = shutdownOf({ m: B(80, 150, 20, 60) }, { id: 'evt-2' })
    const l3 = shutdownOf({ m: B(110, 160, 35, 65) }, { id: 'evt-3' })
    const file = writeEvents('sess-mixed-rollback', [l1, l2])

    const r1 = await copilotCliPlugin.parseFile(ctx, file, 0)
    expect(r1.records.map((record) => [
      record.inputTokens,
      record.outputTokens,
      record.cacheReadTokens,
      record.cacheCreationTokens
    ])).toEqual([
      [100, 100, 30, 40],
      [0, 50, 0, 20]
    ])

    fs.writeFileSync(file, [l1, l2, l3].join('\n'), 'utf8')
    clearCopilotCliDeltaStateCache()
    const r2 = await copilotCliPlugin.parseFile(ctx, file, r1.nextLine)
    expect(r2.records).toHaveLength(1)
    expect(r2.records[0]).toMatchObject({
      inputTokens: 10,
      outputTokens: 10,
      cacheReadTokens: 5,
      cacheCreationTokens: 5
    })
  })

  it('同事件内四桶 delta 全 0 的模型不产出，其余模型照常', async () => {
    const l1 = shutdownOf({ a: B(100, 50) }, { id: 'evt-1', timestamp: '2026-05-07T10:00:00Z' })
    const l2 = shutdownOf({ a: B(100, 50), b: B(10, 5) }, { id: 'evt-2', timestamp: '2026-05-07T11:00:00Z' })
    const file = writeEvents('sess-6', [l1])

    const r1 = await copilotCliPlugin.parseFile(ctx, file, 0)
    expect(r1.records.map((r) => r.model)).toEqual(['a'])

    fs.writeFileSync(file, [l1, l2].join('\n'), 'utf8')
    const r2 = await copilotCliPlugin.parseFile(ctx, file, r1.nextLine)
    expect(r2.records.map((r) => r.model)).toEqual(['b'])
    expect(r2.records[0].inputTokens).toBe(10)
  })

  it('从头重读（fromLine<=1）重置水位并全量重产出，重复由 requestId 幂等兜底', async () => {
    const l1 = shutdownOf({ m: B(100, 10) }, { id: 'evt-1', timestamp: '2026-05-07T10:00:00Z' })
    const l2 = shutdownOf({ m: B(250, 30) }, { id: 'evt-2', timestamp: '2026-05-07T11:00:00Z' })
    const file = writeEvents('sess-7', [l1, l2])

    const r1 = await copilotCliPlugin.parseFile(ctx, file, 0)
    expect(r1.records.map((r) => r.inputTokens)).toEqual([100, 150])

    const r2 = await copilotCliPlugin.parseFile(ctx, file, 1)
    expect(r2.records.map((r) => [r.source.requestId, r.inputTokens])).toEqual([
      ['evt-1:m', 100],
      ['evt-2:m', 150]
    ])
  })
})

describe('parseEventsFile 游标增量与容错', () => {
  it('完整读取后续读 0 条，append 新 shutdown 后从游标续读产出增量', async () => {
    const l1 = shutdownOf({ m: B(1000, 200) }, { id: 'evt-1', timestamp: '2026-05-07T10:00:00Z' })
    const file = writeEvents('sess-8', [`${l1}\n`])

    const r1 = await copilotCliPlugin.parseFile(ctx, file, 0)
    expect(r1.records).toHaveLength(1)
    expect(r1.nextLine).toBe(2)
    expect(r1.eof).toBe(true)

    const r2 = await copilotCliPlugin.parseFile(ctx, file, r1.nextLine)
    expect(r2.records).toHaveLength(0)
    expect(r2.eof).toBe(true)

    const l2 = shutdownOf({ m: B(1100, 210) }, { id: 'evt-2', timestamp: '2026-05-07T10:30:00Z' })
    fs.writeFileSync(file, `${l1}\n${l2}\n`, 'utf8')
    const r3 = await copilotCliPlugin.parseFile(ctx, file, r1.nextLine)
    expect(r3.records).toHaveLength(1)
    expect(r3.records[0].source).toEqual({ filePath: file, line: 2, requestId: 'evt-2:m' })
    expect(r3.records[0].inputTokens).toBe(100)
    expect(r3.records[0].outputTokens).toBe(10)
    expect(r3.nextLine).toBe(3)
    expect(r3.eof).toBe(true)
  })

  it('尾部半行游标停驻，补全后续读产出且 delta 接续此前水位', async () => {
    const l1 = shutdownOf({ m: B(100, 20) }, { id: 'evt-1', timestamp: '2026-05-07T10:00:00Z' })
    const half = '{"type":"session.shutdown","id":"evt-2","timestamp":"2026-05-07T11:00:00Z","data":{"modelMetrics":{"m":{"usage":{"inputTokens":'
    const file = writeEvents('sess-9', [l1, half])

    const r1 = await copilotCliPlugin.parseFile(ctx, file, 0)
    expect(r1.records).toHaveLength(1)
    expect(r1.records[0].source.line).toBe(1)
    expect(r1.nextLine).toBe(2)
    expect(r1.eof).toBe(true)

    const l2 = shutdownOf({ m: B(250, 30) }, { id: 'evt-2', timestamp: '2026-05-07T11:00:00Z' })
    fs.writeFileSync(file, [l1, l2].join('\n'), 'utf8')
    clearCopilotCliDeltaStateCache()
    const r2 = await copilotCliPlugin.parseFile(ctx, file, r1.nextLine)
    expect(r2.records).toHaveLength(1)
    expect(r2.records[0].source).toEqual({ filePath: file, line: 2, requestId: 'evt-2:m' })
    expect(r2.records[0].inputTokens).toBe(150)
    expect(r2.records[0].outputTokens).toBe(10)
    expect(r2.nextLine).toBe(3)
    expect(r2.eof).toBe(true)
  })

  it('空文件游标停在 1，append 后从游标续读产出不漏', async () => {
    const empty = writeEvents('sess-10', [])
    const r1 = await copilotCliPlugin.parseFile(ctx, empty, 0)
    expect(r1.records).toHaveLength(0)
    expect(r1.eof).toBe(true)
    expect(r1.nextLine).toBe(1)

    fs.writeFileSync(empty, `${shutdownOf({ m: B(44) }, { id: 'evt-1', timestamp: '2026-05-07T09:00:00Z' })}\n`, 'utf8')
    const r2 = await copilotCliPlugin.parseFile(ctx, empty, r1.nextLine)
    expect(r2.records).toHaveLength(1)
    expect(r2.records[0].source).toEqual({ filePath: empty, line: 1, requestId: 'evt-1:m' })
    expect(r2.records[0].inputTokens).toBe(44)
    expect(r2.nextLine).toBe(2)
  })

  it('fromLine 越过 EOF 时无记录且游标不倒退', async () => {
    const file = writeEvents('sess-11', [shutdownOf({ m: B(1) })])
    const res = await copilotCliPlugin.parseFile(ctx, file, 99)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(99)
    expect(res.eof).toBe(true)
  })

  it('文件读取失败时返回空结果且游标原样保留', async () => {
    const missing = path.join(tmpDir, 'missing', 'events.jsonl')
    const res = await copilotCliPlugin.parseFile(ctx, missing, 7)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(7)
    expect(res.eof).toBe(true)
  })
})

describe('parseTsMs 宽松时间解析', () => {
  it('ISO 字符串按 Date.parse 解析，数字毫秒原样', () => {
    expect(parseTsMs('2026-05-07T10:57:19.746Z')).toBe(Date.parse('2026-05-07T10:57:19.746Z'))
    expect(parseTsMs(1_754_286_611_000)).toBe(1_754_286_611_000)
  })

  it('无法解析的输入兜底当前时间且非 NaN', () => {
    for (const v of ['not-a-date', '', '   ', null, undefined, {}]) {
      const t = parseTsMs(v)
      expect(Number.isNaN(t)).toBe(false)
      expect(Math.abs(t - Date.now())).toBeLessThan(60_000)
    }
  })
})
