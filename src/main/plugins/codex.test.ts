import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { codexPlugin, detectFromRoot, listFilesFromRoot } from './codex'
import type { PluginContext } from '../../../shared/context'

/** parseFile 不使用 ctx 上的服务，测试时给个空壳即可 */
const ctx = {} as PluginContext

/**
 * 样例行构造器（对齐已核实的 Codex rollout JSONL 格式）：
 * { type: session_meta|turn_context|event_msg, timestamp, payload }。
 */

/** session_meta 行：payload.cwd = 工作目录、payload.id = 会话 id、payload.thread_id = 语义线程 id；传 null 可省略该字段 */
const sessionMetaLine = (o: { id?: string | null; cwd?: string | null; threadId?: string | null } = {}): string =>
  JSON.stringify({
    type: 'session_meta',
    timestamp: '2026-08-19T09:00:00+08:00',
    payload: {
      ...(o.id === null ? {} : { id: o.id ?? 'sess-1' }),
      ...(o.cwd === null ? {} : { cwd: o.cwd ?? '/Users/a/b' }),
      ...(o.threadId ? { thread_id: o.threadId } : {}),
      model: 'gpt-5' // 注意：session_meta.model 不作为「当前模型」
    }
  })

/** turn_context 行：payload.model = 本轮模型（可覆盖） */
const turnContextLine = (o: { model?: string; timestamp?: string } = {}): string =>
  JSON.stringify({
    type: 'turn_context',
    timestamp: o.timestamp ?? '2026-08-19T09:00:01+08:00',
    payload: { id: 'tc-1', model: o.model ?? 'gpt-5' }
  })

/** token_count 事件行：用 info.last_token_usage（本轮增量）产出记录；timestamp 传 null 可省略 */
const tokenCountLine = (o: {
  input?: number
  cached?: number
  output?: number
  reasoning?: number
  timestamp?: string | null
  infoTime?: string
} = {}): string => {
  const input = o.input ?? 100
  const cached = o.cached ?? 20
  const output = o.output ?? 50
  const reasoning = o.reasoning ?? 5
  return JSON.stringify({
    type: 'event_msg',
    ...(o.timestamp === null ? {} : { timestamp: o.timestamp ?? '2026-08-19T09:00:02+08:00' }),
    payload: {
      type: 'token_count',
      info: {
        ...(o.infoTime ? { time: o.infoTime } : {}),
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: reasoning,
          total_tokens: input + cached + output + reasoning
        },
        total_token_usage: {
          input_tokens: input + 1000,
          cached_input_tokens: cached + 500,
          output_tokens: output + 200,
          reasoning_output_tokens: reasoning + 10,
          total_tokens: input + cached + output + reasoning + 1710
        }
      }
    }
  })
}

/** token_count 事件但 info.last_token_usage 缺失（如仅 total_token_usage） */
const tokenCountNoLast = (): string =>
  JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-08-19T09:00:03+08:00',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 5 } } }
  })

let tmpDir = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plugin-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('codexPlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(codexPlugin.id).toBe('codex')
    expect(codexPlugin.name).toBe('Codex')
    expect(codexPlugin.version).toBe('1.0.0')
    expect(codexPlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('detect', () => {
  it('sessions 目录缺失时不可用并给出原因与预期目录', () => {
    const sessionDir = path.join(tmpDir, '.codex', 'sessions')
    const res = detectFromRoot(sessionDir)
    expect(res.available).toBe(false)
    expect(res.reason).toBeTruthy()
    expect(res.sessionDir).toBe(sessionDir)
  })

  it('sessions 目录存在时可用并返回会话目录', () => {
    const sessionDir = path.join(tmpDir, '.codex', 'sessions')
    fs.mkdirSync(sessionDir, { recursive: true })
    const res = detectFromRoot(sessionDir)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(sessionDir)
  })
})

describe('parseFile 增量解析', () => {
  it('从 0 解析：模型来自最近 turn_context、token 字段映射正确、损坏行跳过、尾部半行不阻塞', async () => {
    const file = path.join(tmpDir, 'rollout-abc123.jsonl')
    const brokenMid = '{this is broken json' // 中间损坏行
    const trailingHalf =
      '{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":' // 尾部半行（未写完）
    fs.writeFileSync(
      file,
      [sessionMetaLine(), turnContextLine(), tokenCountLine(), brokenMid, trailingHalf].join('\n'),
      'utf8'
    )

    const res = await codexPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.nextLine).toBe(5)
    expect(res.eof).toBe(true)

    const r = res.records[0]
    expect(r).toMatchObject({
      appType: 'codex',
      model: 'gpt-5',
      rawModel: 'gpt-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20, // cached_input_tokens
      cacheCreationTokens: 0,
      inputSemantics: 1,
      status: 'success',
      project: '/Users/a/b',
      sessionId: 'sess-1'
    })
    expect(r.createdAt).toBe(Date.parse('2026-08-19T09:00:02+08:00'))
    expect(r.source).toEqual({ filePath: file, line: 3 })
  })

  it('游标增量：续读只产出新增；追加仅 token_count（无新 turn_context）也能解析出模型', async () => {
    const file = path.join(tmpDir, 'rollout-abc123.jsonl')
    fs.writeFileSync(
      file,
      [sessionMetaLine(), turnContextLine(), tokenCountLine()].join('\n'),
      'utf8'
    )

    const res = await codexPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.line).toBe(3)
    expect(res.nextLine).toBe(4)
    expect(res.eof).toBe(true)

    // 追加一行 token_count（真实场景：本轮 token_count 晚于 turn_context 写入）
    fs.appendFileSync(
      file,
      `\n${tokenCountLine({ input: 7, cached: 1, output: 3, reasoning: 0, timestamp: '2026-08-19T09:00:10+08:00' })}`,
      'utf8'
    )
    const res2 = await codexPlugin.parseFile(ctx, file, res.nextLine)
    expect(res2.records).toHaveLength(1)
    expect(res2.records[0].source).toEqual({ filePath: file, line: 4 })
    expect(res2.records[0]).toMatchObject({
      model: 'gpt-5', // 模型状态由全文件扫描维持
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 1,
      cacheCreationTokens: 0,
      project: '/Users/a/b',
      sessionId: 'sess-1'
    })
    expect(res2.nextLine).toBe(5)
    expect(res2.eof).toBe(true)
  })

  it('模型取最近一次 turn_context（两次换模型）', async () => {
    const file = path.join(tmpDir, 'rollout-abc123.jsonl')
    fs.writeFileSync(
      file,
      [
        sessionMetaLine(),
        turnContextLine({ model: 'gpt-5' }),
        tokenCountLine(),
        turnContextLine({ model: 'gpt-5.1-codex', timestamp: '2026-08-19T09:00:10+08:00' }),
        tokenCountLine({ timestamp: '2026-08-19T09:00:11+08:00' })
      ].join('\n'),
      'utf8'
    )
    const res = await codexPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records.map((r) => [r.model, r.source.line])).toEqual([
      ['gpt-5', 3],
      ['gpt-5.1-codex', 5]
    ])
    expect(res.nextLine).toBe(6)
  })

  it('last_token_usage 缺失或全 0 时跳过；有有效值仍产出', async () => {
    const file = path.join(tmpDir, 'rollout-abc123.jsonl')
    fs.writeFileSync(
      file,
      [
        sessionMetaLine(),
        turnContextLine(),
        tokenCountLine({ input: 0, cached: 0, output: 0, reasoning: 0 }), // 全 0 → 跳过
        tokenCountNoLast(), // last_token_usage 缺失 → 跳过
        tokenCountLine({ timestamp: '2026-08-19T09:00:12+08:00' }) // 有效 → 产出
      ].join('\n'),
      'utf8'
    )
    const res = await codexPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.line).toBe(5)
    expect(res.records[0]).toMatchObject({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 })
    expect(res.nextLine).toBe(6)
    expect(res.eof).toBe(true)
  })

  it('无 turn_context（无当前模型）时 token_count 跳过；session_meta.model 不作为当前模型', async () => {
    const file = path.join(tmpDir, 'rollout-abc123.jsonl')
    fs.writeFileSync(file, [sessionMetaLine(), tokenCountLine()].join('\n'), 'utf8')
    const res = await codexPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(3)
    expect(res.eof).toBe(true)
  })

  it('sessionId：payload.id 覆盖文件名提取；两者皆无则省略', async () => {
    // payload.id='sess-1' 覆盖文件名提取的 'abc123'
    const f1 = path.join(tmpDir, 'rollout-abc123.jsonl')
    fs.writeFileSync(f1, [sessionMetaLine(), turnContextLine(), tokenCountLine()].join('\n'), 'utf8')
    const r1 = await codexPlugin.parseFile(ctx, f1, 0)
    expect(r1.records[0].sessionId).toBe('sess-1')

    // 文件名非 rollout-* 且 payload 无 id/cwd → sessionId 与 project 省略
    const f2 = path.join(tmpDir, 'session-2026.jsonl')
    fs.writeFileSync(
      f2,
      [sessionMetaLine({ id: null, cwd: null }), turnContextLine(), tokenCountLine()].join('\n'),
      'utf8'
    )
    const r2 = await codexPlugin.parseFile(ctx, f2, 0)
    expect(r2.records[0].sessionId).toBeUndefined()
    expect(r2.records[0].project).toBeUndefined()
  })

  it('createdAt：行无 timestamp 时取 info.time；timestamp 非法时兜底为当前时间', async () => {
    // info.time 兜底
    const f1 = path.join(tmpDir, 'rollout-a.jsonl')
    fs.writeFileSync(
      f1,
      [
        sessionMetaLine(),
        turnContextLine(),
        tokenCountLine({ timestamp: null, infoTime: '2026-08-19T09:00:05+08:00' })
      ].join('\n'),
      'utf8'
    )
    const r1 = await codexPlugin.parseFile(ctx, f1, 0)
    expect(r1.records).toHaveLength(1)
    expect(r1.records[0].createdAt).toBe(Date.parse('2026-08-19T09:00:05+08:00'))

    // timestamp 非法 → Date.now()（非 NaN）
    const f2 = path.join(tmpDir, 'rollout-b.jsonl')
    fs.writeFileSync(
      f2,
      [sessionMetaLine(), turnContextLine(), tokenCountLine({ timestamp: 'not-a-date' })].join('\n'),
      'utf8'
    )
    const r2 = await codexPlugin.parseFile(ctx, f2, 0)
    expect(r2.records).toHaveLength(1)
    expect(Number.isNaN(r2.records[0].createdAt)).toBe(false)
    expect(Math.abs(r2.records[0].createdAt - Date.now())).toBeLessThan(60_000)
  })

  it('空文件与 fromLine 越过 EOF 的边界：无记录、游标不倒退', async () => {
    const empty = path.join(tmpDir, 'rollout-empty.jsonl')
    fs.writeFileSync(empty, '', 'utf8')
    const r1 = await codexPlugin.parseFile(ctx, empty, 0)
    expect(r1.records).toHaveLength(0)
    expect(r1.eof).toBe(true)

    const one = path.join(tmpDir, 'rollout-one.jsonl')
    fs.writeFileSync(one, sessionMetaLine(), 'utf8')
    const r2 = await codexPlugin.parseFile(ctx, one, 99)
    expect(r2.records).toHaveLength(0)
    expect(r2.nextLine).toBe(99)
    expect(r2.eof).toBe(true)
  })

  it('thread_id + 行 timestamp + 用量组合为 source.requestId；成分缺失时不设置', async () => {
    // 全成分齐备：requestId = <threadId>:<行顶层timestamp>:<input>-<cached>-<output>
    const f1 = path.join(tmpDir, 'rollout-abc123.jsonl')
    fs.writeFileSync(
      f1,
      [sessionMetaLine({ threadId: 'thr-9' }), turnContextLine(), tokenCountLine()].join('\n'),
      'utf8'
    )
    const r1 = await codexPlugin.parseFile(ctx, f1, 0)
    expect(r1.records).toHaveLength(1)
    expect(r1.records[0].source).toEqual({
      filePath: f1,
      line: 3,
      requestId: 'thr-9:2026-08-19T09:00:02+08:00:100-20-50'
    })

    // 无 session_meta（无 threadId）→ 不设置 requestId，其余解析不变
    const f2 = path.join(tmpDir, 'rollout-noMeta.jsonl')
    fs.writeFileSync(f2, [turnContextLine(), tokenCountLine()].join('\n'), 'utf8')
    const r2 = await codexPlugin.parseFile(ctx, f2, 0)
    expect(r2.records).toHaveLength(1)
    expect(r2.records[0].source.requestId).toBeUndefined()
    expect('requestId' in r2.records[0].source).toBe(false)

    // session_meta 有 thread_id 但 token_count 行无顶层 timestamp → 不设置
    const f3 = path.join(tmpDir, 'rollout-noTs.jsonl')
    fs.writeFileSync(
      f3,
      [
        sessionMetaLine({ threadId: 'thr-9' }),
        turnContextLine(),
        tokenCountLine({ timestamp: null, infoTime: '2026-08-19T09:00:05+08:00' })
      ].join('\n'),
      'utf8'
    )
    const r3 = await codexPlugin.parseFile(ctx, f3, 0)
    expect(r3.records).toHaveLength(1)
    expect(r3.records[0].source.requestId).toBeUndefined()
  })

  it('尾部半行补全后，从 nextLine 续读只产出新增（line 5），不重放 line 3', async () => {
    const file = path.join(tmpDir, 'rollout-abc123.jsonl')
    const brokenMid = '{this is broken json'
    const trailingHalf =
      '{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":'
    fs.writeFileSync(
      file,
      [sessionMetaLine(), turnContextLine(), tokenCountLine(), brokenMid, trailingHalf].join('\n'),
      'utf8'
    )
    const res = await codexPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.line).toBe(3)
    expect(res.nextLine).toBe(5)
    expect(res.eof).toBe(true)

    // 半行补全为完整 token_count 行后，从 nextLine 续读
    fs.writeFileSync(
      file,
      [
        sessionMetaLine(),
        turnContextLine(),
        tokenCountLine(),
        brokenMid,
        tokenCountLine({ input: 7, cached: 1, output: 3, reasoning: 0, timestamp: '2026-08-19T09:00:10+08:00' })
      ].join('\n'),
      'utf8'
    )
    const res2 = await codexPlugin.parseFile(ctx, file, res.nextLine)
    expect(res2.records).toHaveLength(1)
    expect(res2.records[0].source).toEqual({ filePath: file, line: 5 })
    expect(res2.records[0]).toMatchObject({ inputTokens: 7, outputTokens: 3, cacheReadTokens: 1 })
    expect(res2.nextLine).toBe(6)
    expect(res2.eof).toBe(true)
  })
})

describe('listFilesFromRoot 收集范围', () => {
  it('递归收集日期分区与 archived_sessions 下 *.jsonl，过滤临时/隐藏文件', () => {
    const root = path.join(tmpDir, 'sessions')
    const day = path.join(root, '2026', '08', '19')
    const archived = path.join(root, 'archived_sessions', '2026', '07', '01')
    fs.mkdirSync(day, { recursive: true })
    fs.mkdirSync(archived, { recursive: true })

    fs.writeFileSync(path.join(day, 'rollout-1.jsonl'), sessionMetaLine())
    fs.writeFileSync(path.join(day, 'rollout-2.jsonl'), sessionMetaLine())
    fs.writeFileSync(path.join(day, 'rollout-3.jsonl.tmp'), 'ignore me') // 临时文件
    fs.writeFileSync(path.join(day, 'rollout-4.jsonl~'), 'ignore me') // 备份文件
    fs.writeFileSync(path.join(day, 'rollout-5.jsonl.swp'), 'ignore me') // 编辑交换文件
    fs.writeFileSync(path.join(day, '.rollout-hidden.jsonl'), 'ignore me') // 隐藏文件
    fs.writeFileSync(path.join(day, 'notes.txt'), 'ignore me') // 非 jsonl
    fs.writeFileSync(path.join(day, 'rollout-6.jsonl'), sessionMetaLine())
    fs.writeFileSync(path.join(archived, 'rollout-old.jsonl'), sessionMetaLine())

    const entries = listFilesFromRoot(root)
    expect(entries.map((e) => path.basename(e.path)).sort()).toEqual([
      'rollout-1.jsonl',
      'rollout-2.jsonl',
      'rollout-6.jsonl',
      'rollout-old.jsonl'
    ])
    for (const e of entries) {
      expect(e.mtime).toBeGreaterThan(0)
    }
  })
})
