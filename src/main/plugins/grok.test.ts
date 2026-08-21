import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { grokPlugin, detectFromRoot, listFilesFromRoot, loadModelMap } from './grok'
import type { PluginContext } from '../../../shared/context'

/** parseFile 不使用 ctx 上的服务，测试时给个空壳即可 */
const ctx = {} as PluginContext

/** inference_done 事件行样例（字段可覆盖；noTime 时不写任何时间字段） */
const inferenceLine = (o: {
  sessionId?: string
  prompt?: number
  cached?: number
  completion?: number
  timestamp?: unknown
  ts?: unknown
  time?: unknown
  noTime?: boolean
} = {}): string => {
  const row: Record<string, unknown> = {
    msg: 'shell.turn.inference_done',
    sessionId: o.sessionId ?? 'sess-1',
    ctx: {
      prompt_tokens: o.prompt ?? 120,
      cached_prompt_tokens: o.cached ?? 30,
      completion_tokens: o.completion ?? 60,
      reasoning_tokens: 10
    }
  }
  if (o.noTime) {
    // 不写时间字段
  } else if (o.timestamp !== undefined || o.ts !== undefined || o.time !== undefined) {
    if (o.timestamp !== undefined) row.timestamp = o.timestamp
    if (o.ts !== undefined) row.ts = o.ts
    if (o.time !== undefined) row.time = o.time
  } else {
    row.timestamp = '2026-08-19T10:00:00+08:00'
  }
  return JSON.stringify(row)
}

/** summary.json 内容（current_model_id 为主字段） */
const summaryJson = (model: string): string =>
  JSON.stringify({ current_model_id: model, version: 1, last_active_at: '2026-08-19T10:00:00+08:00' })

/** 建临时 sessions 树：{ sessionId: model } */
function makeSessions(root: string, sessions: Record<string, string>): void {
  for (const [id, model] of Object.entries(sessions)) {
    const dir = path.join(root, 'sessions', id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'summary.json'), summaryJson(model), 'utf8')
  }
}

let tmpDir = ''

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-plugin-'))
  await loadModelMap(tmpDir) // 重置映射缓存，保证测试隔离
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('grokPlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(grokPlugin.id).toBe('grok')
    expect(grokPlugin.name).toBe('Grok Build')
    expect(grokPlugin.version).toBe('1.0.0')
    expect(grokPlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('detect', () => {
  it('根目录缺失时不可用并给出原因与预期目录', () => {
    const root = path.join(tmpDir, 'missing-root')
    const res = detectFromRoot(root)
    expect(res.available).toBe(false)
    expect(res.reason).toBeTruthy()
    expect(res.sessionDir).toBe(root)
  })

  it('无 unified.jsonl 但 sessions 目录存在也可用', () => {
    fs.mkdirSync(path.join(tmpDir, 'sessions'), { recursive: true })
    const res = detectFromRoot(tmpDir)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(tmpDir)
  })

  it('unified.jsonl 存在时可用', () => {
    const logDir = path.join(tmpDir, 'logs')
    fs.mkdirSync(logDir, { recursive: true })
    fs.writeFileSync(path.join(logDir, 'unified.jsonl'), '', 'utf8')
    const res = detectFromRoot(tmpDir)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(tmpDir)
  })
})

describe('loadModelMap 模型映射', () => {
  it('递归读取 sessions 树 summary.json，按会话目录名映射 current_model_id', async () => {
    makeSessions(tmpDir, { 'sess-1': 'grok-3-fast', 'sess-2': 'grok-3' })
    const map = await loadModelMap(tmpDir)
    expect(map.size).toBe(2)
    expect(map.get('sess-1')).toBe('grok-3-fast')
    expect(map.get('sess-2')).toBe('grok-3')
  })

  it('支持更深层会话目录（sessions/2026/08/abc/summary.json → abc）', async () => {
    const deep = path.join(tmpDir, 'sessions', '2026', '08', 'abc')
    fs.mkdirSync(deep, { recursive: true })
    fs.writeFileSync(path.join(deep, 'summary.json'), summaryJson('grok-3-mini'), 'utf8')
    const map = await loadModelMap(tmpDir)
    expect(map.get('abc')).toBe('grok-3-mini')
  })

  it('缺 current_model_id 或解析失败的文件跳过', async () => {
    const s1 = path.join(tmpDir, 'sessions', 'sess-1')
    fs.mkdirSync(s1, { recursive: true })
    fs.writeFileSync(path.join(s1, 'summary.json'), summaryJson('grok-3'), 'utf8')
    const s2 = path.join(tmpDir, 'sessions', 'sess-2')
    fs.mkdirSync(s2, { recursive: true })
    fs.writeFileSync(path.join(s2, 'summary.json'), '{"no": "model"}', 'utf8')
    const s3 = path.join(tmpDir, 'sessions', 'sess-3')
    fs.mkdirSync(s3, { recursive: true })
    fs.writeFileSync(path.join(s3, 'summary.json'), '{broken', 'utf8')
    const map = await loadModelMap(tmpDir)
    expect(map.size).toBe(1)
    expect(map.get('sess-1')).toBe('grok-3')
    expect(map.has('sess-2')).toBe(false)
    expect(map.has('sess-3')).toBe(false)
  })

  it('无 sessions 目录时映射为空', async () => {
    const map = await loadModelMap(tmpDir)
    expect(map.size).toBe(0)
  })
})

describe('parseFile unified.jsonl', () => {
  it('遇 inference_done 产出记录：模型映射、token、语义、时间、来源', async () => {
    makeSessions(tmpDir, { 'sess-1': 'grok-3-fast' })
    await loadModelMap(tmpDir)
    const file = path.join(tmpDir, 'logs', 'unified.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, inferenceLine(), 'utf8')

    const res = await grokPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.eof).toBe(true)
    expect(res.nextLine).toBe(2)

    const r = res.records[0]
    expect(r).toMatchObject({
      appType: 'grok',
      model: 'grok-3-fast',
      rawModel: 'grok-3-fast',
      inputTokens: 120,
      outputTokens: 60,
      cacheReadTokens: 30,
      cacheCreationTokens: 0,
      inputSemantics: 1,
      status: 'success',
      sessionId: 'sess-1'
    })
    expect(r.createdAt).toBe(Date.parse('2026-08-19T10:00:00+08:00'))
    expect(r.source).toEqual({ filePath: file, line: 1 })
  })

  it('非目标事件 / 无 ctx / 无模型映射 / 无 sessionId 的行均跳过', async () => {
    makeSessions(tmpDir, { 'sess-1': 'grok-3-fast' })
    await loadModelMap(tmpDir)
    const file = path.join(tmpDir, 'logs', 'unified.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })

    const other = JSON.stringify({ msg: 'shell.turn.started', sessionId: 'sess-1', ctx: { prompt_tokens: 9 } })
    const noCtx = JSON.stringify({ msg: 'shell.turn.inference_done', sessionId: 'sess-1' })
    const noMapping = inferenceLine({ sessionId: 'ghost' })
    const noSession = inferenceLine({ sessionId: '' })

    fs.writeFileSync(file, [other, noCtx, noMapping, noSession].join('\n'), 'utf8')
    const res = await grokPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(5)
    expect(res.eof).toBe(true)
  })

  it('中间损坏行跳过，尾部半行不阻塞；补全后从 nextLine 续读只产出新增', async () => {
    makeSessions(tmpDir, { 'sess-1': 'grok-3-fast' })
    await loadModelMap(tmpDir)
    const file = path.join(tmpDir, 'logs', 'unified.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })

    const brokenMid = '{this is broken json' // 中间损坏行
    const trailingHalf = '{"msg":"shell.turn.inference_done","sessionId":"sess-1","ctx":{"prompt_tokens":' // 尾部半行
    fs.writeFileSync(file, [inferenceLine(), inferenceLine(), brokenMid, trailingHalf].join('\n'), 'utf8')

    const res = await grokPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records.map((r) => r.source.line)).toEqual([1, 2])
    expect(res.nextLine).toBe(4)
    expect(res.eof).toBe(true)

    // 尾部半行补全后，从 nextLine=4 续读只产出 line 4，不重放 line 1/2
    fs.writeFileSync(
      file,
      [
        inferenceLine(),
        inferenceLine(),
        brokenMid,
        inferenceLine({ prompt: 7, cached: 1, completion: 3, timestamp: '2026-08-19T10:00:10+08:00' })
      ].join('\n'),
      'utf8'
    )
    const res2 = await grokPlugin.parseFile(ctx, file, res.nextLine)
    expect(res2.records).toHaveLength(1)
    expect(res2.records[0].source).toEqual({ filePath: file, line: 4 })
    expect(res2.records[0]).toMatchObject({ inputTokens: 7, outputTokens: 3, cacheReadTokens: 1, cacheCreationTokens: 0 })
    expect(res2.nextLine).toBe(5)
    expect(res2.eof).toBe(true)
  })

  it('完整文件一次读完，重复调用从 nextLine 继续只产出新增', async () => {
    makeSessions(tmpDir, { 'sess-1': 'grok-3-fast' })
    await loadModelMap(tmpDir)
    const file = path.join(tmpDir, 'logs', 'unified.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      [
        inferenceLine(),
        inferenceLine({ timestamp: '2026-08-19T10:00:05+08:00' }),
        inferenceLine({ timestamp: '2026-08-19T10:00:10+08:00' })
      ].join('\n'),
      'utf8'
    )
    const res = await grokPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(3)
    expect(res.records.map((r) => r.source.line)).toEqual([1, 2, 3])
    expect(res.nextLine).toBe(4)
    expect(res.eof).toBe(true)

    // 未追加内容时续读：无新增
    const res2 = await grokPlugin.parseFile(ctx, file, res.nextLine)
    expect(res2.records).toHaveLength(0)
    expect(res2.eof).toBe(true)

    // 追加一行后再续读：只产出该新增行
    fs.appendFileSync(file, `\n${inferenceLine({ timestamp: '2026-08-19T10:00:15+08:00' })}`, 'utf8')
    const res3 = await grokPlugin.parseFile(ctx, file, res.nextLine)
    expect(res3.records).toHaveLength(1)
    expect(res3.records[0].source).toEqual({ filePath: file, line: 4 })
    expect(res3.nextLine).toBe(5)
    expect(res3.eof).toBe(true)
  })

  it('行时间宽松兼容：ts 数字（毫秒）与 time 字符串均可解析，缺失时兜底 Date.now()', async () => {
    makeSessions(tmpDir, { 'sess-1': 'grok-3-fast' })
    await loadModelMap(tmpDir)
    const file = path.join(tmpDir, 'logs', 'unified.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })

    const tsMs = Date.parse('2026-08-19T10:00:00+08:00')
    const timeStr = '2026-08-19T10:00:05+08:00'
    fs.writeFileSync(
      file,
      [inferenceLine({ ts: tsMs }), inferenceLine({ time: timeStr }), inferenceLine({ noTime: true })].join('\n'),
      'utf8'
    )

    const res = await grokPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(3)
    expect(res.records[0].createdAt).toBe(tsMs)
    expect(res.records[1].createdAt).toBe(Date.parse(timeStr))
    expect(Number.isNaN(res.records[2].createdAt)).toBe(false)
    expect(Math.abs(res.records[2].createdAt - Date.now())).toBeLessThan(60_000)
  })

  it('project 字段可选：行内 cwd 存在时回填', async () => {
    makeSessions(tmpDir, { 'sess-1': 'grok-3-fast' })
    await loadModelMap(tmpDir)
    const file = path.join(tmpDir, 'logs', 'unified.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const line = JSON.stringify({
      msg: 'shell.turn.inference_done',
      sessionId: 'sess-1',
      timestamp: '2026-08-19T10:00:00+08:00',
      cwd: '/work/my-proj',
      ctx: { prompt_tokens: 10, cached_prompt_tokens: 2, completion_tokens: 4 }
    })
    fs.writeFileSync(file, line, 'utf8')
    const res = await grokPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].project).toBe('/work/my-proj')
  })

  it('空文件与 fromLine 越过 EOF 的边界：无记录、游标不倒退', async () => {
    const file = path.join(tmpDir, 'logs', 'unified.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '', 'utf8')
    const r1 = await grokPlugin.parseFile(ctx, file, 0)
    expect(r1.records).toHaveLength(0)
    expect(r1.eof).toBe(true)

    fs.writeFileSync(file, inferenceLine(), 'utf8')
    const r2 = await grokPlugin.parseFile(ctx, file, 99)
    expect(r2.records).toHaveLength(0)
    expect(r2.nextLine).toBe(99)
    expect(r2.eof).toBe(true)
  })
})

describe('parseFile summary.json', () => {
  it('不产出记录，仅推进到文件尾', async () => {
    makeSessions(tmpDir, { 'sess-1': 'grok-3-fast' })
    const file = path.join(tmpDir, 'sessions', 'sess-1', 'summary.json')
    const res = await grokPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(0)
    expect(res.eof).toBe(true)
    expect(res.nextLine).toBe(0)
  })
})

describe('listFilesFromRoot 收集范围', () => {
  it('收集 unified.jsonl 与 sessions 树内全部 summary.json，过滤临时/非目标文件', () => {
    const root = tmpDir
    const logDir = path.join(root, 'logs')
    const s1 = path.join(root, 'sessions', 'sess-1')
    const s2 = path.join(root, 'sessions', '2026', '08', 'sess-2')
    fs.mkdirSync(logDir, { recursive: true })
    fs.mkdirSync(s1, { recursive: true })
    fs.mkdirSync(s2, { recursive: true })

    fs.writeFileSync(path.join(logDir, 'unified.jsonl'), '', 'utf8')
    fs.writeFileSync(path.join(s1, 'summary.json'), summaryJson('grok-3'), 'utf8')
    fs.writeFileSync(path.join(s2, 'summary.json'), summaryJson('grok-3-mini'), 'utf8')
    // 过滤项：临时文件、非 summary 的 json、目录外散落文件
    fs.writeFileSync(path.join(logDir, 'unified.jsonl.tmp'), '', 'utf8')
    fs.writeFileSync(path.join(s1, 'event.jsonl'), '', 'utf8')
    fs.writeFileSync(path.join(s1, 'summary.json.tmp'), '', 'utf8')
    fs.writeFileSync(path.join(root, 'loose.json'), '', 'utf8')

    const entries = listFilesFromRoot(root)
    const rel = entries.map((e) => path.relative(root, e.path).split(path.sep).join('/')).sort()
    expect(rel).toEqual([
      'logs/unified.jsonl',
      'sessions/2026/08/sess-2/summary.json',
      'sessions/sess-1/summary.json'
    ])
    for (const e of entries) {
      expect(e.mtime).toBeGreaterThan(0)
    }
  })

  it('无 unified.jsonl / sessions 时返回空列表', () => {
    const entries = listFilesFromRoot(tmpDir)
    expect(entries).toHaveLength(0)
  })
})
