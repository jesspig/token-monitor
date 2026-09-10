import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { kimiPlugin, detectFromRoot, listFilesFromRoot } from './kimi'
import type { PluginContext } from '../../../shared/context'

const ctx = {} as PluginContext

const T_MS = 1782276660974

const turnLine = (o: {
  model?: string
  input?: number
  output?: number
  cacheRead?: number
  cacheCreation?: number
  time?: number
  scope?: string
} = {}): string =>
  JSON.stringify({
    type: 'usage.record',
    model: o.model ?? 'kimi-k2.5',
    usage: {
      inputOther: o.input ?? 100,
      output: o.output ?? 50,
      inputCacheRead: o.cacheRead ?? 200,
      inputCacheCreation: o.cacheCreation ?? 30
    },
    ...(o.scope === undefined ? { usageScope: 'turn' } : { usageScope: o.scope }),
    time: o.time ?? T_MS
  })

const snakeTurnLine = (): string =>
  JSON.stringify({
    type: 'usage.record',
    model: 'kimi-k2.5',
    usage: {
      input_other: 100,
      output: 50,
      input_cache_read: 200,
      input_cache_creation: 30
    },
    usageScope: 'turn',
    time: T_MS
  })

const stepEndRecordLine = (): string =>
  JSON.stringify({
    type: 'usage.record',
    model: 'kimi-k2.5',
    usage: { inputOther: 100, output: 50, inputCacheRead: 200, inputCacheCreation: 30 },
    usageScope: 'step.end',
    time: T_MS
  })

const loopEventStepEndLine = (): string =>
  JSON.stringify({
    type: 'context.append_loop_event',
    event: {
      type: 'step.end',
      uuid: 's1',
      usage: { inputOther: 7962, output: 37, inputCacheRead: 9472, inputCacheCreation: 0 },
      finishReason: 'tool_use'
    },
    time: T_MS
  })

const turnPromptLine = (): string =>
  JSON.stringify({
    type: 'turn.prompt',
    input: [{ type: 'text', text: 'hi' }],
    time: T_MS
  })

const metadataLine = (): string =>
  JSON.stringify({ type: 'metadata', protocol_version: '1.3' })

function writeWire(
  root: string,
  lines: string[],
  o: { ws?: string; sid?: string; agent?: string } = {}
): string {
  const p = path.join(root, 'sessions', o.ws ?? 'ws', o.sid ?? 'sess-1', 'agents', o.agent ?? 'main', 'wire.jsonl')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, lines.join('\n'), 'utf8')
  return p
}

let tmpDir = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-plugin-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('kimiPlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(kimiPlugin.id).toBe('kimi')
    expect(kimiPlugin.name).toBe('Kimi Code')
    expect(kimiPlugin.version).toBe('1.0.0')
    expect(kimiPlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('detect', () => {
  it('sessions 目录缺失时不可用并给出中文原因与预期目录', () => {
    const res = detectFromRoot(path.join(tmpDir, 'nope'))
    expect(res.available).toBe(false)
    expect(res.reason).toBeTruthy()
    expect(res.sessionDir).toBe(path.join(tmpDir, 'nope'))
  })

  it('sessions 目录存在但无 wire.jsonl 时不可用', () => {
    fs.mkdirSync(path.join(tmpDir, 'sessions', 'ws', 's1'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'sessions', 'ws', 's1', 'state.json'), '{}')
    const res = detectFromRoot(tmpDir)
    expect(res.available).toBe(false)
    expect(res.reason).toBeTruthy()
  })

  it('sessions 下存在 wire.jsonl 时可用并返回根目录', () => {
    writeWire(tmpDir, [turnLine()])
    const res = detectFromRoot(tmpDir)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(tmpDir)
  })
})

describe('listFilesFromRoot 深层枚举', () => {
  it('收集 workspace/sessionId/agents/agent 深层的 wire.jsonl，排除其他文件与临时目录', () => {
    const a = writeWire(tmpDir, [turnLine()], { ws: 'ws1', sid: 's1', agent: 'main' })
    const b = writeWire(tmpDir, [turnLine()], { ws: 'ws1', sid: 's1', agent: 'sub-agent' })
    const c = writeWire(tmpDir, [turnLine()], { ws: 'ws2', sid: 's2', agent: 'main' })
    fs.mkdirSync(path.join(tmpDir, 'sessions', 'ws1', 's1', 'agents', '.tmp'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'sessions', 'ws1', 's1', 'agents', '.tmp', 'wire.jsonl'), turnLine())
    fs.writeFileSync(path.join(tmpDir, 'sessions', 'ws1', 's1', 'state.json'), '{}')
    fs.writeFileSync(path.join(tmpDir, 'sessions', 'ws1', 's1', 'context.jsonl'), '{}')
    fs.writeFileSync(path.join(tmpDir, 'sessions', 'readme.md'), 'ignore')
    fs.mkdirSync(path.join(tmpDir, 'loose'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'loose', 'wire.jsonl'), turnLine())

    const entries = listFilesFromRoot(tmpDir)
    expect(entries.map((e) => e.path).sort()).toEqual([a, b, c].sort())
    for (const e of entries) {
      expect(e.mtime).toBeGreaterThan(0)
      expect(path.basename(e.path)).toBe('wire.jsonl')
    }
  })
})

describe('parseFile 字段映射', () => {
  it('snake_case turn 行映射四桶 + semantics=2 + 毫秒时间 + line 游标键', async () => {
    const file = writeWire(tmpDir, [snakeTurnLine()])
    const res = await kimiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.nextLine).toBe(2)
    expect(res.eof).toBe(true)
    const r = res.records[0]
    expect(r).toMatchObject({
      appType: 'kimi',
      model: 'kimi-k2.5',
      rawModel: 'kimi-k2.5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 200,
      cacheCreationTokens: 30,
      inputSemantics: 2,
      status: 'success',
      sessionId: 'sess-1'
    })
    expect(r.createdAt).toBe(T_MS)
    expect(r.source).toEqual({ filePath: file, line: 1 })
    expect('requestId' in r.source).toBe(false)
  })

  it('camelCase turn 行（官方实际格式）同样映射', async () => {
    const file = writeWire(tmpDir, [turnLine()])
    const res = await kimiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 200,
      cacheCreationTokens: 30,
      inputSemantics: 2
    })
  })

  it('snake_case 缺失时回退 camelCase，两者并存时 snake 优先', async () => {
    const mixed = JSON.stringify({
      type: 'usage.record',
      model: 'kimi-k2.5',
      usage: {
        input_other: 111,
        inputOther: 222,
        output: 10,
        input_cache_read: 5,
        inputCacheRead: 6,
        input_cache_creation: 7,
        inputCacheCreation: 8
      },
      usageScope: 'turn',
      time: T_MS
    })
    const fallback = JSON.stringify({
      type: 'usage.record',
      model: 'kimi-k2.5',
      usage: { inputOther: 33, output: 9, inputCacheRead: 4, inputCacheCreation: 2 },
      usageScope: 'turn',
      time: T_MS
    })
    const file = writeWire(tmpDir, [mixed, fallback])
    const res = await kimiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records[0]).toMatchObject({
      inputTokens: 111,
      outputTokens: 10,
      cacheReadTokens: 5,
      cacheCreationTokens: 7
    })
    expect(res.records[1]).toMatchObject({
      inputTokens: 33,
      outputTokens: 9,
      cacheReadTokens: 4,
      cacheCreationTokens: 2
    })
  })

  it('数字字符串宽松解析为数值', async () => {
    const line = JSON.stringify({
      type: 'usage.record',
      model: 'kimi-k2.5',
      usage: { input_other: '42', output: '17' },
      usageScope: 'turn',
      time: T_MS
    })
    const file = writeWire(tmpDir, [line])
    const res = await kimiPlugin.parseFile(ctx, file, 0)
    expect(res.records[0]).toMatchObject({ inputTokens: 42, outputTokens: 17, cacheReadTokens: 0, cacheCreationTokens: 0 })
  })

  it('字段部分缺失兜底 0 且仍产出；全 0 不丢弃', async () => {
    const partial = JSON.stringify({
      type: 'usage.record',
      model: 'kimi-k2.5',
      usage: { inputOther: 25 },
      usageScope: 'turn',
      time: T_MS
    })
    const zeros = turnLine({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 })
    const file = writeWire(tmpDir, [partial, zeros])
    const res = await kimiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records[0]).toMatchObject({
      inputTokens: 25,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0
    })
    expect(res.records[1]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0
    })
  })

  it('time 为秒级时放大为毫秒；缺失或非法时兜底当前时间', async () => {
    const seconds = turnLine({ time: 1782276660 })
    const missing = JSON.parse(turnLine())
    delete missing.time
    const invalid = JSON.stringify({
      type: 'usage.record',
      model: 'kimi-k2.5',
      usage: { output: 1 },
      usageScope: 'turn',
      time: 'not-a-number'
    })
    const file = writeWire(tmpDir, [seconds, JSON.stringify(missing), invalid])
    const res = await kimiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(3)
    expect(res.records[0].createdAt).toBe(1782276660000)
    expect(Math.abs(res.records[1].createdAt - Date.now())).toBeLessThan(60_000)
    expect(Number.isNaN(res.records[2].createdAt)).toBe(false)
  })
})

describe('parseFile 行过滤', () => {
  it('usageScope 为 step.end 的 usage.record 行被排除，不与 turn 行重复计数', async () => {
    const file = writeWire(tmpDir, [stepEndRecordLine(), turnLine()])
    const res = await kimiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.line).toBe(2)
    expect(res.records[0].inputTokens).toBe(100)
  })

  it('非 usage.record 行（loop event step.end / turn.prompt / metadata）全部跳过', async () => {
    const file = writeWire(tmpDir, [metadataLine(), turnPromptLine(), loopEventStepEndLine(), turnLine()])
    const res = await kimiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.line).toBe(4)
    expect(res.nextLine).toBe(5)
  })

  it('usageScope 缺失或为 session 累计口径的行被排除', async () => {
    const noScope = JSON.parse(turnLine())
    delete noScope.usageScope
    const sessionScope = turnLine({ scope: 'session' })
    const file = writeWire(tmpDir, [JSON.stringify(noScope), sessionScope, turnLine({ input: 7 })])
    const res = await kimiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({ inputTokens: 7 })
    expect(res.records[0].source.line).toBe(3)
  })

  it('usage 缺失或 model 缺失的行跳过', async () => {
    const noUsage = JSON.stringify({ type: 'usage.record', model: 'kimi-k2.5', usageScope: 'turn', time: T_MS })
    const noModel = JSON.stringify({ type: 'usage.record', usage: { output: 1 }, usageScope: 'turn', time: T_MS })
    const file = writeWire(tmpDir, [noUsage, noModel])
    const res = await kimiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(3)
    expect(res.eof).toBe(true)
  })
})

describe('parseFile 游标与容错', () => {
  it('全量读取后从 nextLine 续读只产出新增；非 usage 行推进行号', async () => {
    const file = writeWire(tmpDir, [metadataLine(), turnLine({ input: 1 }), turnLine({ input: 2 })])
    const res = await kimiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records.map((r) => r.source.line)).toEqual([2, 3])
    expect(res.nextLine).toBe(4)
    expect(res.eof).toBe(true)

    const res2 = await kimiPlugin.parseFile(ctx, file, res.nextLine)
    expect(res2.records).toHaveLength(0)
    expect(res2.eof).toBe(true)

    fs.appendFileSync(file, `\n${turnLine({ input: 3 })}`, 'utf8')
    const res3 = await kimiPlugin.parseFile(ctx, file, res.nextLine)
    expect(res3.records).toHaveLength(1)
    expect(res3.records[0].source).toEqual({ filePath: file, line: 4 })
    expect(res3.records[0].inputTokens).toBe(3)
    expect(res3.nextLine).toBe(5)
  })

  it('尾部半行不阻塞：游标停在半行处，补全后续读产出完整记录', async () => {
    const file = writeWire(tmpDir, [turnLine({ input: 1 }), '{"type":"usage.record","model":"kimi'])
    const res = await kimiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.nextLine).toBe(2)
    expect(res.eof).toBe(true)

    fs.writeFileSync(
      file,
      [turnLine({ input: 1 }), turnLine({ input: 9 })].join('\n'),
      'utf8'
    )
    const res2 = await kimiPlugin.parseFile(ctx, file, res.nextLine)
    expect(res2.records).toHaveLength(1)
    expect(res2.records[0].source).toEqual({ filePath: file, line: 2 })
    expect(res2.records[0].inputTokens).toBe(9)
    expect(res2.nextLine).toBe(3)
  })

  it('中间损坏行跳过并推进行号，不阻塞后续解析', async () => {
    const file = writeWire(tmpDir, [turnLine({ input: 1 }), '{broken json', turnLine({ input: 2 })])
    const res = await kimiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records.map((r) => r.source.line)).toEqual([1, 3])
    expect(res.nextLine).toBe(4)
  })

  it('空文件与 fromLine 越过 EOF：无记录、游标不倒退', async () => {
    const empty = writeWire(tmpDir, [])
    const r1 = await kimiPlugin.parseFile(ctx, empty, 0)
    expect(r1.records).toHaveLength(0)
    expect(r1.eof).toBe(true)

    const one = writeWire(tmpDir, [turnLine()], { ws: 'ws2', sid: 's9' })
    const r2 = await kimiPlugin.parseFile(ctx, one, 99)
    expect(r2.records).toHaveLength(0)
    expect(r2.nextLine).toBe(99)
    expect(r2.eof).toBe(true)
  })

  it('空行推进游标不产出记录', async () => {
    const file = writeWire(tmpDir, ['', turnLine(), ''])
    const res = await kimiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.line).toBe(2)
    expect(res.nextLine).toBe(3)
  })

  it('文件以换行结尾时 nextLine 不越界，append 后从游标续读能读到新行', async () => {
    const file = writeWire(tmpDir, [turnLine({ input: 1 })])
    fs.appendFileSync(file, '\n', 'utf8')

    const res = await kimiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.nextLine).toBe(2)
    expect(res.eof).toBe(true)

    fs.appendFileSync(file, turnLine({ input: 2 }), 'utf8')
    const res2 = await kimiPlugin.parseFile(ctx, file, res.nextLine)
    expect(res2.records).toHaveLength(1)
    expect(res2.records[0].source).toEqual({ filePath: file, line: 2 })
    expect(res2.records[0].inputTokens).toBe(2)
    expect(res2.nextLine).toBe(3)
  })
})

describe('sessionId 提取与环境变量', () => {
  it('标准 agents 布局从路径提取 sessionId；非 agents 布局不设置', async () => {
    const agentsFile = writeWire(tmpDir, [turnLine()])
    const res = await kimiPlugin.parseFile(ctx, agentsFile, 0)
    expect(res.records[0].sessionId).toBe('sess-1')

    const flat = path.join(tmpDir, 'sessions', 'ws2', 'sess-9', 'wire.jsonl')
    fs.mkdirSync(path.dirname(flat), { recursive: true })
    fs.writeFileSync(flat, snakeTurnLine(), 'utf8')
    const res2 = await kimiPlugin.parseFile(ctx, flat, 0)
    expect(res2.records).toHaveLength(1)
    expect(res2.records[0].sessionId).toBeUndefined()
    expect('sessionId' in res2.records[0]).toBe(false)
  })

  it('KIMI_CODE_HOME 覆盖根目录：listFiles 与 detect 均指向新根', async () => {
    const root = path.join(tmpDir, 'custom-home')
    writeWire(root, [turnLine()])
    vi.stubEnv('KIMI_CODE_HOME', root)
    const files = await kimiPlugin.listFiles(ctx)
    expect(files).toHaveLength(1)
    expect(files[0].path.startsWith(root)).toBe(true)
    const det = await kimiPlugin.detect(ctx)
    expect(det.available).toBe(true)
    expect(det.sessionDir).toBe(root)
  })

  it('KIMI_CODE_HOME 为空时回退 ~/.kimi-code', async () => {
    vi.stubEnv('KIMI_CODE_HOME', '')
    const det = await kimiPlugin.detect(ctx)
    expect(det.sessionDir).toBe(path.join(os.homedir(), '.kimi-code'))
  })
})
