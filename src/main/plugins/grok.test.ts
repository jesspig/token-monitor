import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { grokPlugin, detectFromRoot, listFilesFromRoot, loadModelMap } from './grok'
import type { PluginContext } from '../../../shared/context'

const ctx = {} as PluginContext

const inferenceLine = (o: {
  sessionId?: string
  sid?: unknown
  loopIndex?: unknown
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
  if (o.sid !== undefined) row.sid = o.sid
  if (o.loopIndex !== undefined) (row.ctx as Record<string, unknown>).loop_index = o.loopIndex
  if (o.noTime) {
  } else if (o.timestamp !== undefined || o.ts !== undefined || o.time !== undefined) {
    if (o.timestamp !== undefined) row.timestamp = o.timestamp
    if (o.ts !== undefined) row.ts = o.ts
    if (o.time !== undefined) row.time = o.time
  } else {
    row.timestamp = '2026-08-19T10:00:00+08:00'
  }
  return JSON.stringify(row)
}

const summaryJson = (model: string): string =>
  JSON.stringify({ current_model_id: model, version: 1, last_active_at: '2026-08-19T10:00:00+08:00' })

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
  await loadModelMap(tmpDir)
})

afterEach(() => {
  delete process.env.GROK_HOME
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

    const brokenMid = '{this is broken json'
    const trailingHalf = '{"msg":"shell.turn.inference_done","sessionId":"sess-1","ctx":{"prompt_tokens":'
    fs.writeFileSync(file, [inferenceLine(), inferenceLine(), brokenMid, trailingHalf].join('\n'), 'utf8')

    const res = await grokPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records.map((r) => r.source.line)).toEqual([1, 2])
    expect(res.nextLine).toBe(4)
    expect(res.eof).toBe(true)

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

    const res2 = await grokPlugin.parseFile(ctx, file, res.nextLine)
    expect(res2.records).toHaveLength(0)
    expect(res2.eof).toBe(true)

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

describe('parseFile requestId 组合键', () => {
  async function parseSingleSource(line: string): Promise<{ filePath: string; line: number; requestId?: string }> {
    makeSessions(tmpDir, { 'sess-1': 'grok-3-fast' })
    await loadModelMap(tmpDir)
    const file = path.join(tmpDir, 'logs', 'unified.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, line, 'utf8')
    const res = await grokPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    return res.records[0].source
  }

  it('行含 sid 与 loop_index 时 requestId 为 "<sid>:<loop_index>"', async () => {
    const source = await parseSingleSource(inferenceLine({ sid: '9f1c-uuid', loopIndex: 3 }))
    expect(source.requestId).toBe('9f1c-uuid:3')
  })

  it('缺 loop_index 时 requestId 为 undefined，其余字段不受影响', async () => {
    const source = await parseSingleSource(inferenceLine({ sid: '9f1c-uuid' }))
    expect(source.requestId).toBeUndefined()
    expect(source).toEqual({ filePath: path.join(tmpDir, 'logs', 'unified.jsonl'), line: 1 })
  })

  it('sid 缺失 / 空白串时 requestId 为 undefined（loop_index 在场也不设置）', async () => {
    const noSid = await parseSingleSource(inferenceLine({ loopIndex: 2 }))
    expect(noSid.requestId).toBeUndefined()

    const blankSid = await parseSingleSource(inferenceLine({ sid: '   ', loopIndex: 2 }))
    expect(blankSid.requestId).toBeUndefined()
  })

  it('loop_index 非有限数（字符串/缺失语义）时 requestId 为 undefined', async () => {
    const strLoop = await parseSingleSource(inferenceLine({ sid: '9f1c-uuid', loopIndex: '3' }))
    expect(strLoop.requestId).toBeUndefined()

    const nanLoop = await parseSingleSource(inferenceLine({ sid: '9f1c-uuid', loopIndex: Number.NaN }))
    expect(nanLoop.requestId).toBeUndefined()
  })

  it('loop_index 为 0 视为有效成分，组合键正常产出', async () => {
    const source = await parseSingleSource(inferenceLine({ sid: '9f1c-uuid', loopIndex: 0 }))
    expect(source.requestId).toBe('9f1c-uuid:0')
  })

  it('sid 首尾空白被 trim 后参与组合键', async () => {
    const source = await parseSingleSource(inferenceLine({ sid: '  9f1c-uuid  ', loopIndex: 5 }))
    expect(source.requestId).toBe('9f1c-uuid:5')
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

describe('每轮同步重建模型映射（listFiles 入口）', () => {
  it('第一轮 summary 缺失时记录被跳过；summary 新增后第二轮同 sessionId 正常产出模型', async () => {
    process.env.GROK_HOME = tmpDir
    makeSessions(tmpDir, { 'sess-old': 'grok-3' })
    const file = path.join(tmpDir, 'logs', 'unified.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, inferenceLine({ sessionId: 'sess-new' }), 'utf8')

    await grokPlugin.listFiles(ctx)
    const r1 = await grokPlugin.parseFile(ctx, file, 0)
    expect(r1.records).toHaveLength(0)
    expect(r1.nextLine).toBe(2)

    makeSessions(tmpDir, { 'sess-new': 'grok-4' })

    const files = await grokPlugin.listFiles(ctx)
    expect(files.some((e) => e.path.endsWith(path.join('sessions', 'sess-new', 'summary.json')))).toBe(true)
    const r2 = await grokPlugin.parseFile(ctx, file, 0)
    expect(r2.records).toHaveLength(1)
    expect(r2.records[0]).toMatchObject({
      sessionId: 'sess-new',
      model: 'grok-4',
      rawModel: 'grok-4',
      inputTokens: 120,
      outputTokens: 60
    })
  })

  it('单个损坏的 summary.json 不阻塞重建，其余映射照常生效', async () => {
    process.env.GROK_HOME = tmpDir
    makeSessions(tmpDir, { 'sess-ok': 'grok-3-fast' })
    const bad = path.join(tmpDir, 'sessions', 'sess-bad')
    fs.mkdirSync(bad, { recursive: true })
    fs.writeFileSync(path.join(bad, 'summary.json'), '{broken', 'utf8')

    const file = path.join(tmpDir, 'logs', 'unified.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, inferenceLine({ sessionId: 'sess-ok' }), 'utf8')

    await grokPlugin.listFiles(ctx)
    const res = await grokPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({ sessionId: 'sess-ok', model: 'grok-3-fast' })
  })
})

describe('parseFile 失败分支（T01 宽松 error 探测）', () => {
  it('含 error 字段的 inference_done 产出 error 记录，status=error，tokens 保留，errorMessage/httpStatus 正确', async () => {
    makeSessions(tmpDir, { 'sess-1': 'grok-3-fast' })
    await loadModelMap(tmpDir)
    const file = path.join(tmpDir, 'logs', 'unified.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const errLine = JSON.stringify({
      msg: 'shell.turn.inference_done',
      sessionId: 'sess-1',
      timestamp: '2026-08-19T10:00:00+08:00',
      sid: 'sid-1',
      ctx: { prompt_tokens: 50, completion_tokens: 20, cached_prompt_tokens: 5, loop_index: 1, error: 'rate limited' },
      error: 'rate limited',
      httpStatus: 429
    })
    fs.writeFileSync(file, errLine, 'utf8')
    const res = await grokPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    const r = res.records[0]
    expect(r.status).toBe('error')
    expect(r.errorMessage).toBe('rate limited')
    expect(r.httpStatus).toBe(429)
    expect(r.inputTokens).toBe(50)
    expect(r.outputTokens).toBe(20)
    expect(r.cacheReadTokens).toBe(5)
    expect(r.inputSemantics).toBe(1)
    expect(r.source.requestId).toBe('sid-1:1')
  })

  it('status 非 success 时产出 error，errorMessage 取 status 文案兜底', async () => {
    makeSessions(tmpDir, { 'sess-1': 'grok-3-fast' })
    await loadModelMap(tmpDir)
    const file = path.join(tmpDir, 'logs', 'unified.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const line = JSON.stringify({
      msg: 'shell.turn.inference_done',
      sessionId: 'sess-1',
      timestamp: '2026-08-19T10:00:00+08:00',
      ctx: { prompt_tokens: 10, completion_tokens: 5, cached_prompt_tokens: 0 },
      status: 'failed'
    })
    fs.writeFileSync(file, line, 'utf8')
    const res = await grokPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].status).toBe('error')
    expect(res.records[0].errorMessage).toBe('failed')
    expect(res.records[0].httpStatus).toBeUndefined()
  })

  it('ctx.error 为对象时宽松提取 message，httpStatus 从嵌套取', async () => {
    makeSessions(tmpDir, { 'sess-1': 'grok-3-fast' })
    await loadModelMap(tmpDir)
    const file = path.join(tmpDir, 'logs', 'unified.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const line = JSON.stringify({
      msg: 'shell.turn.inference_done',
      sessionId: 'sess-1',
      timestamp: '2026-08-19T10:00:00+08:00',
      ctx: { prompt_tokens: 1, completion_tokens: 1, error: { message: 'upstream 500', httpStatus: 500 } }
    })
    fs.writeFileSync(file, line, 'utf8')
    const res = await grokPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].errorMessage).toBe('upstream 500')
    expect(res.records[0].httpStatus).toBe(500)
  })

  it('errorMessage 超 500 截断', async () => {
    makeSessions(tmpDir, { 'sess-1': 'grok-3-fast' })
    await loadModelMap(tmpDir)
    const file = path.join(tmpDir, 'logs', 'unified.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const longMsg = 'a'.repeat(600)
    const line = JSON.stringify({
      msg: 'shell.turn.inference_done',
      sessionId: 'sess-1',
      timestamp: '2026-08-19T10:00:00+08:00',
      ctx: { prompt_tokens: 1, completion_tokens: 1, error: longMsg }
    })
    fs.writeFileSync(file, line, 'utf8')
    const res = await grokPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].errorMessage!.length).toBe(500)
  })

  it('中断 cancelled/interrupted 忽略不产记录', async () => {
    makeSessions(tmpDir, { 'sess-1': 'grok-3-fast' })
    await loadModelMap(tmpDir)
    const file = path.join(tmpDir, 'logs', 'unified.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const cancelled = JSON.stringify({
      msg: 'shell.turn.inference_done',
      sessionId: 'sess-1',
      timestamp: '2026-08-19T10:00:00+08:00',
      ctx: { prompt_tokens: 10, completion_tokens: 5, error: 'cancelled' },
      status: 'cancelled'
    })
    const interrupted = JSON.stringify({
      msg: 'shell.turn.inference_done',
      sessionId: 'sess-1',
      timestamp: '2026-08-19T10:00:01+08:00',
      ctx: { prompt_tokens: 10, completion_tokens: 5, error: 'interrupted by user' }
    })
    fs.writeFileSync(file, [cancelled, interrupted].join('\n'), 'utf8')
    const res = await grokPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(3)
  })

  it('error 为空串不判失败，仍为 success', async () => {
    makeSessions(tmpDir, { 'sess-1': 'grok-3-fast' })
    await loadModelMap(tmpDir)
    const file = path.join(tmpDir, 'logs', 'unified.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const line = JSON.stringify({
      msg: 'shell.turn.inference_done',
      sessionId: 'sess-1',
      timestamp: '2026-08-19T10:00:00+08:00',
      ctx: { prompt_tokens: 10, completion_tokens: 5, error: '' },
      error: ''
    })
    fs.writeFileSync(file, line, 'utf8')
    const res = await grokPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].status).toBe('success')
  })

  it('失败仍需模型映射，无映射跳过', async () => {
    await loadModelMap(tmpDir)
    const file = path.join(tmpDir, 'logs', 'unified.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const line = JSON.stringify({
      msg: 'shell.turn.inference_done',
      sessionId: 'sess-unknown',
      timestamp: '2026-08-19T10:00:00+08:00',
      ctx: { prompt_tokens: 10, completion_tokens: 5, error: 'boom' }
    })
    fs.writeFileSync(file, line, 'utf8')
    const res = await grokPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(0)
  })

  it('httpStatus 字符串数字亦兼容', async () => {
    makeSessions(tmpDir, { 'sess-1': 'grok-3-fast' })
    await loadModelMap(tmpDir)
    const file = path.join(tmpDir, 'logs', 'unified.jsonl')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const line = JSON.stringify({
      msg: 'shell.turn.inference_done',
      sessionId: 'sess-1',
      timestamp: '2026-08-19T10:00:00+08:00',
      ctx: { prompt_tokens: 1, completion_tokens: 1, error: 'err' },
      statusCode: '502'
    })
    fs.writeFileSync(file, line, 'utf8')
    const res = await grokPlugin.parseFile(ctx, file, 0)
    expect(res.records[0].httpStatus).toBe(502)
  })
})
