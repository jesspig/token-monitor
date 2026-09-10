import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { reasonixPlugin, detectFromRoot, listFilesFromRoot, parseTsMs, statsRootOf } from './reasonix'
import type { PluginContext } from '../../../shared/context'

const ctx = {} as PluginContext

const statsLine = (o: {
  ts?: unknown
  model?: unknown
  prompt?: unknown
  completion?: unknown
  reasoning?: unknown
  cacheHit?: unknown
  cacheMiss?: unknown
} = {}): string =>
  JSON.stringify({
    ts: o.ts ?? '2026-08-04T09:10:11Z',
    ...('model' in o ? { model: o.model } : { model: 'deepseek/chat' }),
    ...('prompt' in o ? { prompt: o.prompt } : { prompt: 100 }),
    ...('completion' in o ? { completion: o.completion } : { completion: 50 }),
    ...('reasoning' in o ? { reasoning: o.reasoning } : { reasoning: 20 }),
    ...('cacheHit' in o ? { cache_hit: o.cacheHit } : { cache_hit: 30 }),
    ...('cacheMiss' in o ? { cache_miss: o.cacheMiss } : { cache_miss: 70 })
  })

const turnLine = (): string => JSON.stringify({ ts: '2026-08-04T09:10:12Z', turn: true })

let tmpDir = ''

const envKeys = ['REASONIX_STATE_HOME', 'REASONIX_HOME', 'APPDATA'] as const
const savedEnv: Record<string, string | undefined> = {}
const savedPlatform = process.platform

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-plugin-'))
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
  Object.defineProperty(process, 'platform', { value: savedPlatform })
})

const setPlatform = (p: string): void => {
  Object.defineProperty(process, 'platform', { value: p })
}

describe('reasonixPlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(reasonixPlugin.id).toBe('reasonix')
    expect(reasonixPlugin.name).toBe('Reasonix')
    expect(reasonixPlugin.version).toBe('1.0.0')
    expect(reasonixPlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('detect', () => {
  it('stats 目录缺失时不可用并给出原因与预期目录', () => {
    const statsDir = path.join(tmpDir, 'stats')
    const res = detectFromRoot(statsDir)
    expect(res.available).toBe(false)
    expect(res.reason).toContain('未找到统计数据目录')
    expect(res.sessionDir).toBe(statsDir)
  })

  it('stats 目录存在但无日期 jsonl 时不可用并给出原因', () => {
    const statsDir = path.join(tmpDir, 'stats')
    fs.mkdirSync(statsDir, { recursive: true })
    fs.writeFileSync(path.join(statsDir, 'notes.txt'), 'x', 'utf8')
    const res = detectFromRoot(statsDir)
    expect(res.available).toBe(false)
    expect(res.reason).toContain('YYYY-MM-DD.jsonl')
  })

  it('stats 目录存在且含日期 jsonl 时可用', () => {
    const statsDir = path.join(tmpDir, 'stats')
    fs.mkdirSync(statsDir, { recursive: true })
    fs.writeFileSync(path.join(statsDir, '2026-08-04.jsonl'), statsLine(), 'utf8')
    const res = detectFromRoot(statsDir)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(statsDir)
  })
})

describe('listFilesFromRoot', () => {
  it('只收集 YYYY-MM-DD.jsonl 且按文件名排序，过滤临时与非日期名', () => {
    const root = path.join(tmpDir, 'stats')
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, '2026-08-04.jsonl'), statsLine(), 'utf8')
    fs.writeFileSync(path.join(root, '2026-08-01.jsonl'), statsLine(), 'utf8')
    fs.writeFileSync(path.join(root, '2026-07-31.jsonl'), statsLine(), 'utf8')
    fs.writeFileSync(path.join(root, '2026-08-04.jsonl.tmp'), statsLine(), 'utf8')
    fs.writeFileSync(path.join(root, 'stats-backup.jsonl'), statsLine(), 'utf8')
    fs.writeFileSync(path.join(root, '20260805.jsonl'), statsLine(), 'utf8')
    fs.writeFileSync(path.join(root, 'readme.md'), 'x', 'utf8')
    fs.mkdirSync(path.join(root, '2026-08-09.jsonl'), { recursive: true })

    const entries = listFilesFromRoot(root)
    expect(entries.map((e) => path.basename(e.path))).toEqual([
      '2026-07-31.jsonl',
      '2026-08-01.jsonl',
      '2026-08-04.jsonl'
    ])
    for (const e of entries) {
      expect(e.mtime).toBeGreaterThan(0)
    }
  })
})

describe('parseStatsFile 正常解析与字段映射', () => {
  it('标准行映射：prompt/completion/cache_hit/cache_miss → 四桶，semantics=1，createdAt=ts，line=行号且无 requestId', async () => {
    const file = path.join(tmpDir, '2026-08-04.jsonl')
    fs.writeFileSync(file, `${statsLine()}\n`, 'utf8')

    const res = await reasonixPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.nextLine).toBe(2)
    expect(res.eof).toBe(true)

    const r = res.records[0]
    expect(r).toMatchObject({
      appType: 'reasonix',
      model: 'deepseek/chat',
      rawModel: 'deepseek/chat',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 30,
      cacheCreationTokens: 70,
      inputSemantics: 1,
      status: 'success'
    })
    expect(r.createdAt).toBe(Date.parse('2026-08-04T09:10:11Z'))
    expect(r.source).toEqual({ filePath: file, line: 1 })
    expect('requestId' in r.source).toBe(false)
  })

  it('turn 标记行跳过，前后数据行正常产出', async () => {
    const file = path.join(tmpDir, '2026-08-04.jsonl')
    fs.writeFileSync(file, [statsLine(), turnLine(), statsLine({ ts: '2026-08-04T09:11:00Z', prompt: 8, completion: 4, cacheHit: 0, cacheMiss: 8 })].join('\n'), 'utf8')

    const res = await reasonixPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records.map((r) => r.source.line)).toEqual([1, 3])
    expect(res.records[1].inputTokens).toBe(8)
    expect(res.nextLine).toBe(4)
    expect(res.eof).toBe(true)
  })

  it('model 缺失/空串/非字符串行跳过', async () => {
    const file = path.join(tmpDir, '2026-08-04.jsonl')
    fs.writeFileSync(
      file,
      [
        statsLine({ model: undefined }),
        statsLine({ model: '   ' }),
        statsLine({ model: 42 }),
        statsLine({ ts: '2026-08-04T09:12:00Z' })
      ].join('\n'),
      'utf8'
    )

    const res = await reasonixPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.line).toBe(4)
    expect(res.records[0].model).toBe('deepseek/chat')
    expect(res.nextLine).toBe(5)
  })

  it('数值字段缺失或类型异常时兜底为 0', async () => {
    const file = path.join(tmpDir, '2026-08-04.jsonl')
    fs.writeFileSync(
      file,
      [
        statsLine({ ts: '2026-08-04T09:13:00Z', prompt: undefined, completion: undefined, cacheHit: undefined, cacheMiss: undefined }),
        statsLine({ ts: '2026-08-04T09:13:01Z', prompt: '100', completion: NaN, cacheHit: null, cacheMiss: true })
      ].join('\n'),
      'utf8'
    )

    const res = await reasonixPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    for (const r of res.records) {
      expect(r).toMatchObject({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        inputSemantics: 1
      })
    }
  })

  it('ts 缺失时 createdAt 兜底为当前时间（非 NaN），reasoning/total 等多余字段不参与映射', async () => {
    const file = path.join(tmpDir, '2026-08-04.jsonl')
    const raw = JSON.stringify({ model: 'deepseek/chat', prompt: 10, completion: 5, reasoning: 3, total: 15, requests: 1, turn: 1 })
    fs.writeFileSync(file, raw, 'utf8')

    const res = await reasonixPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(Number.isNaN(res.records[0].createdAt)).toBe(false)
    expect(Math.abs(res.records[0].createdAt - Date.now())).toBeLessThan(60_000)
    expect(res.records[0].outputTokens).toBe(5)
  })
})

describe('parseStatsFile 游标增量与容错', () => {
  it('完整文件一次读完，续读只产出新增；中间损坏行跳过不阻塞后续行', async () => {
    const file = path.join(tmpDir, '2026-08-04.jsonl')
    const brokenMid = '{this is broken json'
    fs.writeFileSync(
      file,
      [statsLine({ ts: '2026-08-04T09:10:11Z' }), brokenMid, statsLine({ ts: '2026-08-04T09:10:20Z', prompt: 9, completion: 3 })].join('\n'),
      'utf8'
    )

    const res = await reasonixPlugin.parseFile(ctx, file, 0)
    expect(res.records.map((r) => r.source.line)).toEqual([1, 3])
    expect(res.records[1].inputTokens).toBe(9)
    expect(res.nextLine).toBe(4)
    expect(res.eof).toBe(true)

    const res2 = await reasonixPlugin.parseFile(ctx, file, res.nextLine)
    expect(res2.records).toHaveLength(0)
    expect(res2.eof).toBe(true)

    fs.appendFileSync(file, `\n${statsLine({ ts: '2026-08-04T09:10:30Z', prompt: 12, completion: 6 })}`, 'utf8')
    const res3 = await reasonixPlugin.parseFile(ctx, file, res.nextLine)
    expect(res3.records).toHaveLength(1)
    expect(res3.records[0].source).toEqual({ filePath: file, line: 4 })
    expect(res3.records[0].inputTokens).toBe(12)
    expect(res3.nextLine).toBe(5)
    expect(res3.eof).toBe(true)
  })

  it('尾部半行不阻塞：游标停驻半行，补全后续读产出该行', async () => {
    const file = path.join(tmpDir, '2026-08-04.jsonl')
    const trailingHalf = '{"ts":"2026-08-04T09:10:40Z","model":"deepseek/chat","prompt":'
    fs.writeFileSync(file, [statsLine({ ts: '2026-08-04T09:10:11Z' }), trailingHalf].join('\n'), 'utf8')

    const res = await reasonixPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.line).toBe(1)
    expect(res.nextLine).toBe(2)
    expect(res.eof).toBe(true)

    fs.writeFileSync(
      file,
      [statsLine({ ts: '2026-08-04T09:10:11Z' }), statsLine({ ts: '2026-08-04T09:10:40Z', prompt: 66, completion: 33 })].join('\n'),
      'utf8'
    )
    const res2 = await reasonixPlugin.parseFile(ctx, file, res.nextLine)
    expect(res2.records).toHaveLength(1)
    expect(res2.records[0].source.line).toBe(2)
    expect(res2.records[0].inputTokens).toBe(66)
    expect(res2.records[0].outputTokens).toBe(33)
    expect(res2.nextLine).toBe(3)
    expect(res2.eof).toBe(true)
  })

  it('空文件游标停在 1，随后 append 首行可从游标正常读到不漏', async () => {
    const empty = path.join(tmpDir, '2026-08-04.jsonl')
    fs.writeFileSync(empty, '', 'utf8')
    const r1 = await reasonixPlugin.parseFile(ctx, empty, 0)
    expect(r1.records).toHaveLength(0)
    expect(r1.eof).toBe(true)
    expect(r1.nextLine).toBe(1)

    const rBlank = await reasonixPlugin.parseFile(ctx, empty, 6)
    expect(rBlank.records).toHaveLength(0)
    expect(rBlank.nextLine).toBe(6)

    fs.writeFileSync(empty, `${statsLine({ ts: '2026-08-04T09:14:00Z', prompt: 44 })}\n`, 'utf8')
    const r2 = await reasonixPlugin.parseFile(ctx, empty, r1.nextLine)
    expect(r2.records).toHaveLength(1)
    expect(r2.records[0].source).toEqual({ filePath: empty, line: 1 })
    expect(r2.records[0].inputTokens).toBe(44)
    expect(r2.nextLine).toBe(2)
  })

  it('fromLine 越过 EOF：无记录、游标不倒退', async () => {
    const one = path.join(tmpDir, '2026-08-05.jsonl')
    fs.writeFileSync(one, statsLine(), 'utf8')
    const r2 = await reasonixPlugin.parseFile(ctx, one, 99)
    expect(r2.records).toHaveLength(0)
    expect(r2.nextLine).toBe(99)
    expect(r2.eof).toBe(true)
  })

  it('跨日文件游标各自独立：两文件按 fromLine 分别解析互不影响', async () => {
    const day1 = path.join(tmpDir, '2026-08-04.jsonl')
    const day2 = path.join(tmpDir, '2026-08-05.jsonl')
    fs.writeFileSync(
      day1,
      [statsLine({ ts: '2026-08-04T09:00:00Z', prompt: 10 }), statsLine({ ts: '2026-08-04T10:00:00Z', prompt: 11 })].join('\n'),
      'utf8'
    )
    fs.writeFileSync(
      day2,
      [statsLine({ ts: '2026-08-05T09:00:00Z', prompt: 20 }), statsLine({ ts: '2026-08-05T10:00:00Z', prompt: 21 })].join('\n'),
      'utf8'
    )

    const entries = listFilesFromRoot(tmpDir)
    expect(entries.map((e) => path.basename(e.path))).toEqual(['2026-08-04.jsonl', '2026-08-05.jsonl'])

    const r1 = await reasonixPlugin.parseFile(ctx, entries[0].path, 2)
    expect(r1.records.map((r) => [r.source.filePath === day1, r.source.line, r.inputTokens])).toEqual([[true, 2, 11]])
    expect(r1.nextLine).toBe(3)

    const r2 = await reasonixPlugin.parseFile(ctx, entries[1].path, 0)
    expect(r2.records.map((r) => [r.source.filePath === day2, r.source.line, r.inputTokens])).toEqual([
      [true, 1, 20],
      [true, 2, 21]
    ])
    expect(r2.nextLine).toBe(3)

    const r1Again = await reasonixPlugin.parseFile(ctx, entries[0].path, r1.nextLine)
    expect(r1Again.records).toHaveLength(0)
  })

  it('文件读取失败时返回空结果且游标原样保留', async () => {
    const missing = path.join(tmpDir, 'missing.jsonl')
    const res = await reasonixPlugin.parseFile(ctx, missing, 7)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(7)
    expect(res.eof).toBe(true)
  })
})

describe('parseTsMs 宽松时间解析', () => {
  it('ISO 字符串按 Date.parse 解析', () => {
    expect(parseTsMs('2026-08-04T09:10:11Z')).toBe(Date.parse('2026-08-04T09:10:11Z'))
  })

  it('数字毫秒原样、数字秒乘 1000、非正数兜底当前时间', () => {
    expect(parseTsMs(1_754_286_611_000)).toBe(1_754_286_611_000)
    expect(parseTsMs(1_754_286_611)).toBe(1_754_286_611_000)
    const fallback = parseTsMs(0)
    expect(Math.abs(fallback - Date.now())).toBeLessThan(60_000)
  })

  it('无法解析的字符串与非字符串兜底当前时间', () => {
    for (const v of ['not-a-date', '', '   ', null, undefined, {}]) {
      const t = parseTsMs(v)
      expect(Number.isNaN(t)).toBe(false)
      expect(Math.abs(t - Date.now())).toBeLessThan(60_000)
    }
  })
})

describe('statsRootOf 路径解析与环境变量覆盖', () => {
  it('REASONIX_STATE_HOME 优先于 REASONIX_HOME', () => {
    process.env.REASONIX_STATE_HOME = path.join(tmpDir, 'state')
    process.env.REASONIX_HOME = path.join(tmpDir, 'home')
    expect(statsRootOf()).toBe(path.join(tmpDir, 'state', 'stats'))
  })

  it('仅 REASONIX_HOME 时生效；空白值视为未设置', () => {
    process.env.REASONIX_HOME = path.join(tmpDir, 'home')
    expect(statsRootOf()).toBe(path.join(tmpDir, 'home', 'stats'))

    process.env.REASONIX_HOME = '   '
    process.env.REASONIX_STATE_HOME = '   '
    setPlatform('linux')
    expect(statsRootOf()).toBe(path.join(os.homedir(), '.reasonix', 'stats'))
  })

  it('win32 默认走 %APPDATA%\\reasonix\\stats，APPDATA 缺失时回退用户目录', () => {
    setPlatform('win32')
    process.env.APPDATA = path.join(tmpDir, 'appdata')
    expect(statsRootOf()).toBe(path.join(tmpDir, 'appdata', 'reasonix', 'stats'))

    delete process.env.APPDATA
    expect(statsRootOf()).toBe(path.join(os.homedir(), 'AppData', 'Roaming', 'reasonix', 'stats'))
  })

  it('非 win32 默认 ~/.reasonix/stats', () => {
    setPlatform('linux')
    expect(statsRootOf()).toBe(path.join(os.homedir(), '.reasonix', 'stats'))
  })

  it('环境变量覆盖下 detect 与 listFiles 走覆盖目录', async () => {
    const statsDir = path.join(tmpDir, 'override', 'stats')
    fs.mkdirSync(statsDir, { recursive: true })
    fs.writeFileSync(path.join(statsDir, '2026-08-04.jsonl'), statsLine(), 'utf8')
    process.env.REASONIX_STATE_HOME = path.join(tmpDir, 'override')

    const res = await reasonixPlugin.detect(ctx)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(statsDir)

    const files = await reasonixPlugin.listFiles(ctx)
    expect(files.map((f) => f.path)).toEqual([path.join(statsDir, '2026-08-04.jsonl')])
  })
})
