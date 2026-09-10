import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { qwenPlugin, dataRootOf, detectFromRoot, listFilesFromRoot, usageDirOf } from './qwen'
import type { PluginContext } from '../../../shared/context'

const ctx = {} as PluginContext

const TS_1 = '2026-08-19T10:00:05.000Z'
const TS_1_MS = Date.parse('2026-08-19T10:00:05.000Z')
const TS_2 = '2026-08-19T10:05:30.000Z'
const TS_2_MS = Date.parse('2026-08-19T10:05:30.000Z')

const usageLine = (o: {
  id?: string
  timestamp?: string
  sessionId?: string
  model?: string
  input?: number
  output?: number
  cached?: number
  thoughts?: number
  total?: number
  duration?: number
  authType?: string
  schemaVersion?: number
  omit?: string[]
} = {}): string => {
  const row: Record<string, unknown> = {
    schemaVersion: o.schemaVersion ?? 1,
    id: o.id ?? '11111111-1111-4111-8111-111111111111',
    timestamp: o.timestamp ?? TS_1,
    localDate: '2026-08-19',
    localMonth: '2026-08',
    sessionId: o.sessionId ?? 'sess-1',
    model: o.model ?? 'qwen3-coder-plus',
    authType: o.authType ?? 'qwen-oauth',
    source: 'main',
    inputTokens: o.input ?? 100,
    outputTokens: o.output ?? 50,
    cachedTokens: o.cached ?? 10,
    thoughtsTokens: o.thoughts ?? 5,
    totalTokens: o.total ?? 165,
    apiDurationMs: o.duration ?? 1234
  }
  for (const key of o.omit ?? []) delete row[key]
  return JSON.stringify(row)
}

let tmpDir = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-plugin-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('qwenPlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(qwenPlugin.id).toBe('qwen')
    expect(qwenPlugin.name).toBe('Qwen Code')
    expect(qwenPlugin.version).toBe('1.0.0')
    expect(qwenPlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('dataRootOf 环境变量覆盖（QWEN_RUNTIME_DIR > QWEN_HOME > ~/.qwen）', () => {
  it('QWEN_RUNTIME_DIR 优先级最高', () => {
    vi.stubEnv('QWEN_RUNTIME_DIR', '/tmp/qwen-runtime')
    vi.stubEnv('QWEN_HOME', '/tmp/qwen-home')
    expect(dataRootOf()).toBe('/tmp/qwen-runtime')
  })

  it('仅 QWEN_HOME 时以其为根', () => {
    vi.stubEnv('QWEN_HOME', '/tmp/qwen-home')
    expect(dataRootOf()).toBe('/tmp/qwen-home')
  })

  it('均未设置时回退 ~/.qwen', () => {
    vi.stubEnv('QWEN_RUNTIME_DIR', '')
    vi.stubEnv('QWEN_HOME', '')
    expect(dataRootOf()).toBe(path.join(os.homedir(), '.qwen'))
  })
})

describe('detect', () => {
  it('usage 目录缺失时不可用，reason 提及 usageStatisticsEnabled', () => {
    const root = path.join(tmpDir, 'no-qwen')
    const res = detectFromRoot(root)
    expect(res.available).toBe(false)
    expect(res.reason).toContain('usageStatisticsEnabled')
    expect(res.sessionDir).toBe(usageDirOf(root))
  })

  it('usage 目录存在但无 token-usage 文件时不可用', () => {
    const root = path.join(tmpDir, 'qwen')
    fs.mkdirSync(usageDirOf(root), { recursive: true })
    fs.writeFileSync(path.join(usageDirOf(root), 'usage_record.jsonl'), '{"x":1}\n', 'utf8')
    const res = detectFromRoot(root)
    expect(res.available).toBe(false)
    expect(res.reason).toContain('usageStatisticsEnabled')
  })

  it('存在 token-usage 文件时可用并返回 usage 目录', () => {
    const root = path.join(tmpDir, 'qwen')
    fs.mkdirSync(usageDirOf(root), { recursive: true })
    fs.writeFileSync(path.join(usageDirOf(root), 'token-usage-2026-08.jsonl'), usageLine(), 'utf8')
    const res = detectFromRoot(root)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(usageDirOf(root))
  })
})

describe('listFilesFromRoot 收集范围与排序', () => {
  it('只收 token-usage-*.jsonl，按文件名（月份）排序；usage_record.jsonl 与临时文件不收', () => {
    const dir = usageDirOf(tmpDir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'token-usage-2026-08.jsonl'), usageLine(), 'utf8')
    fs.writeFileSync(path.join(dir, 'token-usage-2026-07.jsonl'), usageLine(), 'utf8')
    fs.writeFileSync(path.join(dir, 'token-usage-2026-09.jsonl'), usageLine(), 'utf8')
    fs.writeFileSync(path.join(dir, 'usage_record.jsonl'), '{"x":1}\n', 'utf8')
    fs.writeFileSync(path.join(dir, 'other.jsonl'), usageLine(), 'utf8')
    fs.writeFileSync(path.join(dir, 'token-usage-2026-06.jsonl.tmp'), usageLine(), 'utf8')
    fs.writeFileSync(path.join(dir, '.token-usage-2026-05.jsonl'), usageLine(), 'utf8')

    const entries = listFilesFromRoot(tmpDir)
    expect(entries.map((e) => path.basename(e.path))).toEqual([
      'token-usage-2026-07.jsonl',
      'token-usage-2026-08.jsonl',
      'token-usage-2026-09.jsonl'
    ])
    for (const e of entries) {
      expect(e.mtime).toBeGreaterThan(0)
    }
  })
})

describe('parseFile 行解析与字段映射', () => {
  it('正常行映射：tokens 四桶、semantics=1、latencyMs、requestId=id、createdAt=timestamp', async () => {
    const file = path.join(tmpDir, 'token-usage-2026-08.jsonl')
    fs.writeFileSync(file, usageLine({ id: 'req-abc', timestamp: TS_1, input: 100, output: 50, cached: 10, duration: 1234 }), 'utf8')

    const res = await qwenPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.nextLine).toBe(2)
    expect(res.eof).toBe(true)

    const r = res.records[0]
    expect(r).toMatchObject({
      appType: 'qwen',
      model: 'qwen3-coder-plus',
      rawModel: 'qwen3-coder-plus',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 0,
      inputSemantics: 1,
      status: 'success',
      latencyMs: 1234,
      sessionId: 'sess-1'
    })
    expect(r.createdAt).toBe(TS_1_MS)
    expect(r.source).toEqual({ filePath: file, line: 1, requestId: 'req-abc' })
  })

  it('多行逐条产出，source.line 递增；空行跳过推进游标', async () => {
    const file = path.join(tmpDir, 'token-usage-2026-08.jsonl')
    fs.writeFileSync(file, ['', usageLine({ id: 'a' }), '', usageLine({ id: 'b', timestamp: TS_2 }), ''].join('\n'), 'utf8')

    const res = await qwenPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records.map((r) => r.source.line)).toEqual([2, 4])
    expect(res.records[1].createdAt).toBe(TS_2_MS)
    expect(res.nextLine).toBe(5)
    expect(res.eof).toBe(true)
  })

  it('文件以换行结尾时 nextLine 不越界，append 后从游标续读能读到新行', async () => {
    const file = path.join(tmpDir, 'token-usage-2026-08.jsonl')
    fs.writeFileSync(file, `${usageLine({ id: 'a' })}\n`, 'utf8')

    const res = await qwenPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.nextLine).toBe(2)
    expect(res.eof).toBe(true)

    fs.appendFileSync(file, usageLine({ id: 'b', timestamp: TS_2 }), 'utf8')
    const res2 = await qwenPlugin.parseFile(ctx, file, res.nextLine)
    expect(res2.records).toHaveLength(1)
    expect(res2.records[0].source).toEqual({ filePath: file, line: 2, requestId: 'b' })
    expect(res2.nextLine).toBe(3)
  })

  it('usage_record.jsonl 不在收集范围：同目录写入也不被 listFiles 收集', () => {
    const dir = usageDirOf(tmpDir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'token-usage-2026-08.jsonl'), usageLine(), 'utf8')
    fs.writeFileSync(path.join(dir, 'usage_record.jsonl'), `${usageLine({ id: 'session-aggregate' })}\n`, 'utf8')

    const entries = listFilesFromRoot(tmpDir)
    expect(entries).toHaveLength(1)
    expect(path.basename(entries[0].path)).toBe('token-usage-2026-08.jsonl')
  })

  it('游标增量续读：续读只产出新增行，游标不回退', async () => {
    const file = path.join(tmpDir, 'token-usage-2026-08.jsonl')
    fs.writeFileSync(file, [usageLine({ id: 'a' }), usageLine({ id: 'b' })].join('\n'), 'utf8')

    const res1 = await qwenPlugin.parseFile(ctx, file, 0)
    expect(res1.records).toHaveLength(2)
    expect(res1.nextLine).toBe(3)

    const res2 = await qwenPlugin.parseFile(ctx, file, res1.nextLine)
    expect(res2.records).toHaveLength(0)
    expect(res2.eof).toBe(true)

    fs.appendFileSync(file, `\n${usageLine({ id: 'c', timestamp: TS_2, input: 7, output: 3, cached: 1 })}`, 'utf8')
    const res3 = await qwenPlugin.parseFile(ctx, file, res1.nextLine)
    expect(res3.records).toHaveLength(1)
    expect(res3.records[0].source).toEqual({ filePath: file, line: 3, requestId: 'c' })
    expect(res3.records[0]).toMatchObject({ inputTokens: 7, outputTokens: 3, cacheReadTokens: 1 })
    expect(res3.nextLine).toBe(4)
  })

  it('尾部半行不阻塞：游标停在半行行号，补全后续读产出', async () => {
    const file = path.join(tmpDir, 'token-usage-2026-08.jsonl')
    const trailingHalf = '{"schemaVersion":1,"id":"half","timestamp":"2026-08-19T10:00:05.000Z","model":"qwen3-coder-plus","inputTokens":'
    fs.writeFileSync(file, [usageLine({ id: 'a' }), trailingHalf].join('\n'), 'utf8')

    const res1 = await qwenPlugin.parseFile(ctx, file, 0)
    expect(res1.records).toHaveLength(1)
    expect(res1.records[0].source.line).toBe(1)
    expect(res1.nextLine).toBe(2)
    expect(res1.eof).toBe(true)

    fs.writeFileSync(file, [usageLine({ id: 'a' }), usageLine({ id: 'half', input: 42, output: 1, cached: 0 })].join('\n'), 'utf8')
    const res2 = await qwenPlugin.parseFile(ctx, file, res1.nextLine)
    expect(res2.records).toHaveLength(1)
    expect(res2.records[0].source).toEqual({ filePath: file, line: 2, requestId: 'half' })
    expect(res2.records[0].inputTokens).toBe(42)
    expect(res2.nextLine).toBe(3)
  })

  it('中间损坏行跳过：后续正常行继续产出，游标越过坏行', async () => {
    const file = path.join(tmpDir, 'token-usage-2026-08.jsonl')
    fs.writeFileSync(file, [usageLine({ id: 'a' }), '{broken json here', usageLine({ id: 'b', timestamp: TS_2 })].join('\n'), 'utf8')

    const res = await qwenPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records.map((r) => r.source.line)).toEqual([1, 3])
    expect(res.nextLine).toBe(4)
    expect(res.eof).toBe(true)
  })

  it('跨月文件同时解析且各自独立游标', async () => {
    const jul = path.join(tmpDir, 'token-usage-2026-07.jsonl')
    const aug = path.join(tmpDir, 'token-usage-2026-08.jsonl')
    fs.writeFileSync(jul, [usageLine({ id: 'j1' }), usageLine({ id: 'j2' })].join('\n'), 'utf8')
    fs.writeFileSync(aug, usageLine({ id: 'a1' }), 'utf8')

    const resJul = await qwenPlugin.parseFile(ctx, jul, 0)
    const resAug = await qwenPlugin.parseFile(ctx, aug, 0)
    expect(resJul.records).toHaveLength(2)
    expect(resJul.records.every((r) => r.source.filePath === jul)).toBe(true)
    expect(resAug.records).toHaveLength(1)
    expect(resAug.records[0].source.filePath).toBe(aug)

    fs.appendFileSync(jul, `\n${usageLine({ id: 'j3' })}`, 'utf8')
    const resJul2 = await qwenPlugin.parseFile(ctx, jul, resJul.nextLine)
    expect(resJul2.records).toHaveLength(1)
    expect(resJul2.records[0].source.requestId).toBe('j3')
    const resAug2 = await qwenPlugin.parseFile(ctx, aug, resAug.nextLine)
    expect(resAug2.records).toHaveLength(0)
  })
})

describe('宽松兜底', () => {
  it('数值字段缺失或非数字时兜底 0，行仍产出', async () => {
    const file = path.join(tmpDir, 'token-usage-2026-08.jsonl')
    fs.writeFileSync(
      file,
      usageLine({ omit: ['inputTokens', 'outputTokens', 'cachedTokens', 'totalTokens', 'apiDurationMs', 'sessionId'] }),
      'utf8'
    )

    const res = await qwenPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      latencyMs: 0,
      inputSemantics: 1
    })
    expect(res.records[0].sessionId).toBeUndefined()
    expect('sessionId' in res.records[0]).toBe(false)
  })

  it('model 缺失或空串兜底 unknown，rawModel 不设置；id 缺失不设 requestId', async () => {
    const file = path.join(tmpDir, 'token-usage-2026-08.jsonl')
    fs.writeFileSync(
      file,
      [usageLine({ omit: ['model', 'id'] }), usageLine({ id: 'has-id', model: '  ' })].join('\n'),
      'utf8'
    )

    const res = await qwenPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records[0]).toMatchObject({ model: 'unknown', inputSemantics: 1 })
    expect(res.records[0].rawModel).toBeUndefined()
    expect(res.records[0].source.requestId).toBeUndefined()
    expect('requestId' in res.records[0].source).toBe(false)
    expect(res.records[1].model).toBe('unknown')
    expect(res.records[1].source.requestId).toBe('has-id')
  })

  it('timestamp 缺失或非法时 createdAt 兜底为当前时间（非 NaN）', async () => {
    const file = path.join(tmpDir, 'token-usage-2026-08.jsonl')
    fs.writeFileSync(file, [usageLine({ omit: ['timestamp'] }), usageLine({ id: 'b', timestamp: 'not-a-date' })].join('\n'), 'utf8')

    const res = await qwenPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    for (const r of res.records) {
      expect(Number.isNaN(r.createdAt)).toBe(false)
      expect(Math.abs(r.createdAt - Date.now())).toBeLessThan(60_000)
    }
  })

  it('非对象行（数组/字符串/数字）与空文件、越界游标均安全', async () => {
    const mixed = path.join(tmpDir, 'token-usage-2026-08.jsonl')
    fs.writeFileSync(mixed, ['"just a string"', '[1,2,3]', '42', usageLine({ id: 'after-junk' })].join('\n'), 'utf8')
    const res = await qwenPlugin.parseFile(ctx, mixed, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.requestId).toBe('after-junk')

    const empty = path.join(tmpDir, 'token-usage-2026-07.jsonl')
    fs.writeFileSync(empty, '', 'utf8')
    const r1 = await qwenPlugin.parseFile(ctx, empty, 0)
    expect(r1.records).toHaveLength(0)
    expect(r1.eof).toBe(true)

    const one = path.join(tmpDir, 'token-usage-2026-06.jsonl')
    fs.writeFileSync(one, usageLine(), 'utf8')
    const r2 = await qwenPlugin.parseFile(ctx, one, 99)
    expect(r2.records).toHaveLength(0)
    expect(r2.nextLine).toBe(99)
    expect(r2.eof).toBe(true)
  })

  it('文件读取失败时不抛错，游标原样返回', async () => {
    const missing = path.join(tmpDir, 'token-usage-2026-05.jsonl')
    const res = await qwenPlugin.parseFile(ctx, missing, 7)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(7)
    expect(res.eof).toBe(true)
  })
})
