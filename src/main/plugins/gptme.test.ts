import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { gptmePlugin, detectFromRoot, listFilesFromRoot, logsRootOf, parseTsMs } from './gptme'
import type { PluginContext } from '../../../shared/context'

const ctx = {} as PluginContext

const usage = (o: {
  model?: unknown
  input?: unknown
  output?: unknown
  cacheRead?: unknown
  cacheCreation?: unknown
} = {}): Record<string, unknown> => ({
  ...('model' in o ? { model: o.model } : { model: 'anthropic/claude-sonnet-4-5' }),
  ...('input' in o ? { input_tokens: o.input } : { input_tokens: 100 }),
  ...('output' in o ? { output_tokens: o.output } : { output_tokens: 50 }),
  ...('cacheRead' in o ? { cache_read_tokens: o.cacheRead } : { cache_read_tokens: 30 }),
  ...('cacheCreation' in o ? { cache_creation_tokens: o.cacheCreation } : { cache_creation_tokens: 0 })
})

const lineNew = (u: Record<string, unknown> = usage(), ts = '2025-12-25T22:47:40.922775'): string =>
  JSON.stringify({ role: 'assistant', content: 'ok', timestamp: ts, metadata: { usage: u } })

const lineOld = (u: Record<string, unknown> = usage(), ts = '2025-12-25T22:47:40.922775'): string =>
  JSON.stringify({ role: 'assistant', content: 'ok', timestamp: ts, metadata: { ...u } })

let tmpDir = ''

const envKeys = ['GPTME_DIR', 'GPTME_LOGS_HOME'] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gptme-plugin-'))
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

describe('gptmePlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(gptmePlugin.id).toBe('gptme')
    expect(gptmePlugin.name).toBe('gptme')
    expect(gptmePlugin.version).toBe('1.0.0')
    expect(gptmePlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('logsRootOf 路径解析', () => {
  it('GPTME_DIR 优先于 GPTME_LOGS_HOME', () => {
    process.env.GPTME_DIR = path.join(tmpDir, 'dir')
    process.env.GPTME_LOGS_HOME = path.join(tmpDir, 'home')
    expect(logsRootOf()).toBe(path.join(tmpDir, 'dir'))
  })

  it('仅 GPTME_LOGS_HOME 时生效', () => {
    process.env.GPTME_LOGS_HOME = path.join(tmpDir, 'home')
    expect(logsRootOf()).toBe(path.join(tmpDir, 'home'))
  })

  it('空白值视为未设置，回退下一档', () => {
    process.env.GPTME_DIR = '   '
    process.env.GPTME_LOGS_HOME = path.join(tmpDir, 'home')
    expect(logsRootOf()).toBe(path.join(tmpDir, 'home'))

    process.env.GPTME_LOGS_HOME = '  '
    expect(logsRootOf()).toBe(path.join(os.homedir(), '.local', 'share', 'gptme', 'logs'))
  })

  it('默认路径 ~/.local/share/gptme/logs', () => {
    expect(logsRootOf()).toBe(path.join(os.homedir(), '.local', 'share', 'gptme', 'logs'))
  })
})

describe('detect', () => {
  it('logs 根缺失时不可用，原因含默认路径与覆盖变量', () => {
    const root = path.join(tmpDir, 'logs')
    const res = detectFromRoot(root)
    expect(res.available).toBe(false)
    expect(res.reason).toContain('.local/share/gptme/logs')
    expect(res.reason).toContain('GPTME_DIR')
    expect(res.reason).toContain('GPTME_LOGS_HOME')
    expect(res.sessionDir).toBe(root)
  })

  it('logs 根存在即可用（即使为空目录）', () => {
    const root = path.join(tmpDir, 'logs')
    fs.mkdirSync(root, { recursive: true })
    const res = detectFromRoot(root)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(root)
  })

  it('GPTME_DIR 覆盖下 detect 与 listFiles 走覆盖目录', async () => {
    const root = path.join(tmpDir, 'override')
    const conv = path.join(root, 'conv-a', 'conversation.jsonl')
    fs.mkdirSync(path.join(root, 'conv-a'), { recursive: true })
    fs.writeFileSync(conv, lineNew(), 'utf8')
    process.env.GPTME_DIR = root

    const det = await gptmePlugin.detect(ctx)
    expect(det.available).toBe(true)
    expect(det.sessionDir).toBe(root)

    const files = await gptmePlugin.listFiles(ctx)
    expect(files.map((f) => f.path)).toEqual([conv])
  })
})

describe('listFilesFromRoot', () => {
  it('只收一级子目录的 conversation.jsonl；branches 内文件、临时/隐藏目录、根散文件不收', () => {
    const root = path.join(tmpDir, 'logs')
    fs.mkdirSync(path.join(root, 'conv-a'), { recursive: true })
    fs.mkdirSync(path.join(root, 'conv-b'), { recursive: true })
    fs.mkdirSync(path.join(root, 'conv-b', 'branches'), { recursive: true })
    fs.mkdirSync(path.join(root, '.hidden'), { recursive: true })
    fs.mkdirSync(path.join(root, 'conv-tmp~'), { recursive: true })
    fs.mkdirSync(path.join(root, 'conv.swp'), { recursive: true })

    fs.writeFileSync(path.join(root, 'conv-a', 'conversation.jsonl'), lineNew(), 'utf8')
    fs.writeFileSync(path.join(root, 'conv-b', 'conversation.jsonl'), lineNew(), 'utf8')
    fs.writeFileSync(path.join(root, 'conv-b', 'branches', 'conversation.jsonl'), lineNew(), 'utf8')
    fs.writeFileSync(path.join(root, 'conv-b', 'other.jsonl'), lineNew(), 'utf8')
    fs.writeFileSync(path.join(root, '.hidden', 'conversation.jsonl'), lineNew(), 'utf8')
    fs.writeFileSync(path.join(root, 'conv-tmp~', 'conversation.jsonl'), lineNew(), 'utf8')
    fs.writeFileSync(path.join(root, 'conv.swp', 'conversation.jsonl'), lineNew(), 'utf8')
    fs.writeFileSync(path.join(root, 'conversation.jsonl'), lineNew(), 'utf8')

    const entries = listFilesFromRoot(root)
    expect(entries.map((e) => path.basename(path.dirname(e.path)))).toEqual(['conv-a', 'conv-b'])
    for (const e of entries) {
      expect(e.mtime).toBeGreaterThan(0)
    }
  })
})

describe('parseConversationFile 双形态解析', () => {
  it('新形态 metadata.usage：四桶映射 + semantics=2 + createdAt + source 无 requestId', async () => {
    const file = path.join(tmpDir, 'conversation.jsonl')
    fs.writeFileSync(
      file,
      `${lineNew(usage({ input: 33970, output: 50, cacheRead: 30000, cacheCreation: 0 }), '2025-12-25T22:47:40.922775')}\n`,
      'utf8'
    )

    const res = await gptmePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.nextLine).toBe(2)
    expect(res.eof).toBe(true)

    const r = res.records[0]
    expect(r).toMatchObject({
      appType: 'gptme',
      model: 'anthropic/claude-sonnet-4-5',
      rawModel: 'anthropic/claude-sonnet-4-5',
      inputTokens: 33970,
      outputTokens: 50,
      cacheReadTokens: 30000,
      cacheCreationTokens: 0,
      inputSemantics: 2,
      status: 'success'
    })
    expect(r.createdAt).toBe(Date.parse('2025-12-25T22:47:40.922775'))
    expect(r.source).toEqual({ filePath: file, line: 1 })
    expect('requestId' in r.source).toBe(false)
  })

  it('旧形态扁平 metadata：直接从 metadata 取 model 与四桶', async () => {
    const file = path.join(tmpDir, 'conversation.jsonl')
    fs.writeFileSync(
      file,
      `${lineOld(usage({ input: 500, output: 120, cacheRead: 400, cacheCreation: 10 }), '2025-12-25T10:00:00Z')}\n`,
      'utf8'
    )

    const res = await gptmePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({
      appType: 'gptme',
      model: 'anthropic/claude-sonnet-4-5',
      inputTokens: 500,
      outputTokens: 120,
      cacheReadTokens: 400,
      cacheCreationTokens: 10,
      inputSemantics: 2,
      status: 'success'
    })
    expect(res.records[0].createdAt).toBe(Date.parse('2025-12-25T10:00:00Z'))
  })

  it('metadata.usage 为空对象时回退整个 metadata 作为来源', async () => {
    const file = path.join(tmpDir, 'conversation.jsonl')
    const raw = JSON.stringify({
      role: 'assistant',
      content: 'x',
      timestamp: '2025-12-25T11:00:00Z',
      metadata: {
        usage: {},
        model: 'openai/gpt-5',
        input_tokens: 7,
        output_tokens: 3,
        cache_read_tokens: 1,
        cache_creation_tokens: 2
      }
    })
    fs.writeFileSync(file, raw, 'utf8')

    const res = await gptmePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({
      model: 'openai/gpt-5',
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 1,
      cacheCreationTokens: 2,
      inputSemantics: 2
    })
  })

  it('数值字段缺失或类型异常时兜底为 0', async () => {
    const file = path.join(tmpDir, 'conversation.jsonl')
    fs.writeFileSync(
      file,
      [
        lineNew(usage({ input: undefined, output: undefined, cacheRead: undefined, cacheCreation: undefined }), '2025-12-25T22:50:00Z'),
        lineNew(usage({ input: '100', output: NaN, cacheRead: null, cacheCreation: true }), '2025-12-25T22:50:01Z')
      ].join('\n'),
      'utf8'
    )

    const res = await gptmePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    for (const r of res.records) {
      expect(r).toMatchObject({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        inputSemantics: 2
      })
    }
  })
})

describe('行过滤', () => {
  it('非 assistant 行、无 metadata 行、metadata 非对象行、model 空行跳过，有效行照常产出', async () => {
    const file = path.join(tmpDir, 'conversation.jsonl')
    const userLine = JSON.stringify({ role: 'user', content: 'hi', timestamp: '2025-12-25T22:47:00Z' })
    const systemLine = JSON.stringify({ role: 'system', content: 'sys', timestamp: '2025-12-25T22:47:01Z' })
    const noMetaLine = JSON.stringify({ role: 'assistant', content: 'early', timestamp: '2025-12-25T22:47:10Z' })
    const metaNotObjectLine = JSON.stringify({ role: 'assistant', content: 'x', timestamp: '2025-12-25T22:47:20Z', metadata: 'oops' })
    const modelBlankLine = lineNew(usage({ model: '   ' }))
    const modelNonStringLine = lineNew(usage({ model: 42 }))
    const good = lineNew(usage({ input: 8, output: 4, cacheRead: 0, cacheCreation: 0 }), '2025-12-25T22:48:00Z')
    fs.writeFileSync(file, [userLine, systemLine, noMetaLine, metaNotObjectLine, modelBlankLine, modelNonStringLine, good].join('\n'), 'utf8')

    const res = await gptmePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.line).toBe(7)
    expect(res.records[0].inputTokens).toBe(8)
    expect(res.records[0].outputTokens).toBe(4)
    expect(res.nextLine).toBe(8)
    expect(res.eof).toBe(true)
  })
})

describe('timestamp 宽松解析', () => {
  it('naive 无时区 timestamp 可解析，按本地时区解释', () => {
    expect(parseTsMs('2025-12-25T22:47:40')).toBe(new Date(2025, 11, 25, 22, 47, 40).getTime())
  })

  it('微秒精度 timestamp 可解析且非 NaN', () => {
    const t = parseTsMs('2025-12-25T22:47:40.922775')
    expect(Number.isNaN(t)).toBe(false)
    expect(t).toBe(Date.parse('2025-12-25T22:47:40.922775'))
  })

  it('缺失、空串或非法 timestamp 兜底为当前时间（非 NaN）', () => {
    for (const v of ['', '   ', 'not-a-date', null, undefined, 123]) {
      const t = parseTsMs(v)
      expect(Number.isNaN(t)).toBe(false)
      expect(Math.abs(t - Date.now())).toBeLessThan(60_000)
    }
  })
})

describe('parseConversationFile 游标增量与容错', () => {
  it('完整文件一次读完，续读无产出，append 后只取新增行', async () => {
    const file = path.join(tmpDir, 'conversation.jsonl')
    fs.writeFileSync(
      file,
      [
        lineNew(usage(), '2025-12-25T22:47:40Z'),
        lineNew(usage({ input: 9, output: 3, cacheRead: 0, cacheCreation: 0 }), '2025-12-25T22:48:00Z')
      ].join('\n'),
      'utf8'
    )

    const res = await gptmePlugin.parseFile(ctx, file, 0)
    expect(res.records.map((r) => r.source.line)).toEqual([1, 2])
    expect(res.nextLine).toBe(3)
    expect(res.eof).toBe(true)

    const res2 = await gptmePlugin.parseFile(ctx, file, res.nextLine)
    expect(res2.records).toHaveLength(0)
    expect(res2.eof).toBe(true)

    fs.appendFileSync(
      file,
      `\n${lineNew(usage({ input: 12, output: 6, cacheRead: 0, cacheCreation: 0 }), '2025-12-25T22:49:00Z')}`,
      'utf8'
    )
    const res3 = await gptmePlugin.parseFile(ctx, file, res.nextLine)
    expect(res3.records).toHaveLength(1)
    expect(res3.records[0].source).toEqual({ filePath: file, line: 3 })
    expect(res3.records[0].inputTokens).toBe(12)
    expect(res3.nextLine).toBe(4)
    expect(res3.eof).toBe(true)
  })

  it('尾部半行不阻塞：游标停驻半行，补全后续读产出该行', async () => {
    const file = path.join(tmpDir, 'conversation.jsonl')
    const half = '{"role":"assistant","content":"x","timestamp":"2025-12-25T23:00:00Z","metadata":{"model":"openai/gpt-5","input_tok'
    fs.writeFileSync(file, [lineNew(usage(), '2025-12-25T22:47:40Z'), half].join('\n'), 'utf8')

    const res = await gptmePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.line).toBe(1)
    expect(res.nextLine).toBe(2)
    expect(res.eof).toBe(true)

    fs.writeFileSync(
      file,
      [
        lineNew(usage(), '2025-12-25T22:47:40Z'),
        lineNew(usage({ input: 66, output: 33, cacheRead: 0, cacheCreation: 0 }), '2025-12-25T23:00:00Z')
      ].join('\n'),
      'utf8'
    )
    const res2 = await gptmePlugin.parseFile(ctx, file, res.nextLine)
    expect(res2.records).toHaveLength(1)
    expect(res2.records[0].source.line).toBe(2)
    expect(res2.records[0].inputTokens).toBe(66)
    expect(res2.records[0].outputTokens).toBe(33)
    expect(res2.nextLine).toBe(3)
    expect(res2.eof).toBe(true)
  })

  it('中间坏行跳过不阻塞后续行', async () => {
    const file = path.join(tmpDir, 'conversation.jsonl')
    fs.writeFileSync(
      file,
      [
        lineNew(usage(), '2025-12-25T22:47:40Z'),
        '{this is broken json',
        lineNew(usage({ input: 9, output: 3, cacheRead: 0, cacheCreation: 0 }), '2025-12-25T22:48:20Z')
      ].join('\n'),
      'utf8'
    )

    const res = await gptmePlugin.parseFile(ctx, file, 0)
    expect(res.records.map((r) => r.source.line)).toEqual([1, 3])
    expect(res.records[1].inputTokens).toBe(9)
    expect(res.nextLine).toBe(4)
    expect(res.eof).toBe(true)
  })

  it('空文件游标停在 1；fromLine 越过 EOF 游标不倒退；文件读取失败游标原样保留', async () => {
    const empty = path.join(tmpDir, 'empty.jsonl')
    fs.writeFileSync(empty, '', 'utf8')
    const r1 = await gptmePlugin.parseFile(ctx, empty, 0)
    expect(r1.records).toHaveLength(0)
    expect(r1.nextLine).toBe(1)
    expect(r1.eof).toBe(true)

    const one = path.join(tmpDir, 'one.jsonl')
    fs.writeFileSync(one, lineNew(), 'utf8')
    const r2 = await gptmePlugin.parseFile(ctx, one, 99)
    expect(r2.records).toHaveLength(0)
    expect(r2.nextLine).toBe(99)
    expect(r2.eof).toBe(true)

    const missing = path.join(tmpDir, 'missing.jsonl')
    const r3 = await gptmePlugin.parseFile(ctx, missing, 7)
    expect(r3.records).toHaveLength(0)
    expect(r3.nextLine).toBe(7)
    expect(r3.eof).toBe(true)
  })
})
