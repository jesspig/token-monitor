import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { claudePlugin, detectFromRoot, foldById, listFilesFromRoot } from './claude'
import type { PluginContext } from '../../../shared/context'
import type { UsageRecord } from '../../../shared/dto'

/** parseFile 不使用 ctx 上的服务，测试时给个空壳即可 */
const ctx = {} as PluginContext

const USER_TS = '2026-08-19T10:00:00+08:00'
const ASST_TS = '2026-08-19T10:00:05+08:00'

/** user 行样例 */
const userLine = (): string =>
  JSON.stringify({
    type: 'user',
    uuid: 'u-1',
    timestamp: USER_TS,
    sessionId: 'sess-1',
    cwd: '/Users/a/b',
    gitBranch: 'main',
    version: '2.0.0',
    message: { role: 'user', content: 'hello' }
  })

/** assistant 行样例（含 message.usage，字段可覆盖；id 为 message.id 语义请求 ID） */
const assistantLine = (o: {
  uuid?: string
  id?: string
  timestamp?: string
  model?: string
  input?: number
  output?: number
  cacheRead?: number
  cacheCreation?: number
} = {}): string =>
  JSON.stringify({
    type: 'assistant',
    uuid: o.uuid ?? 'a-1',
    parentUuid: 'u-1',
    timestamp: o.timestamp ?? ASST_TS,
    sessionId: 'sess-1',
    cwd: '/Users/a/b',
    version: '2.0.0',
    message: {
      role: 'assistant',
      ...(o.id ? { id: o.id } : {}),
      model: o.model ?? 'claude-sonnet-4-5',
      usage: {
        input_tokens: o.input ?? 100,
        output_tokens: o.output ?? 50,
        cache_creation_input_tokens: o.cacheCreation ?? 20,
        cache_read_input_tokens: o.cacheRead ?? 10
      }
    }
  })

let tmpDir = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-plugin-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('claudePlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(claudePlugin.id).toBe('claude')
    expect(claudePlugin.name).toBe('Claude Code')
    expect(claudePlugin.version).toBe('1.0.0')
    expect(claudePlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('detect', () => {
  it('projects 目录缺失时不可用并给出原因与预期目录', () => {
    const sessionDir = path.join(tmpDir, '.claude', 'projects')
    const res = detectFromRoot(sessionDir)
    expect(res.available).toBe(false)
    expect(res.reason).toBeTruthy()
    expect(res.sessionDir).toBe(sessionDir)
  })

  it('projects 目录存在时可用并返回会话目录', () => {
    const sessionDir = path.join(tmpDir, '.claude', 'projects')
    fs.mkdirSync(sessionDir, { recursive: true })
    const res = detectFromRoot(sessionDir)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(sessionDir)
  })
})

describe('parseFile 增量解析', () => {
  it('从 0 解析：跳过 user/损坏行，尾部半行不阻塞，游标停在最后成功解析行', async () => {
    const file = path.join(tmpDir, 'main.jsonl')
    const brokenMid = '{this is broken json' // 中间损坏行
    const trailingHalf =
      '{"type":"assistant","uuid":"a-2","message":{"role":"assistant","model":"claude-sonnet-4-5","usage":{"input_tokens":' // 尾部半行（未写完）
    fs.writeFileSync(file, [userLine(), assistantLine(), brokenMid, trailingHalf].join('\n'), 'utf8')

    const res = await claudePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.nextLine).toBe(4)
    expect(res.eof).toBe(true)

    const r = res.records[0]
    expect(r).toMatchObject({
      appType: 'claude',
      model: 'claude-sonnet-4-5',
      rawModel: 'claude-sonnet-4-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 20,
      inputSemantics: 2,
      status: 'success',
      project: '/Users/a/b',
      sessionId: 'sess-1'
    })
    expect(r.createdAt).toBe(Date.parse(ASST_TS))
    expect(r.source).toEqual({ filePath: file, line: 2 })

    // 尾部半行补全后，从 nextLine 续读只产出新增（line 4），不重放 line 2
    fs.writeFileSync(
      file,
      [
        userLine(),
        assistantLine(),
        brokenMid,
        assistantLine({ uuid: 'a-2', timestamp: '2026-08-19T10:00:10+08:00', input: 7, output: 3, cacheRead: 1, cacheCreation: 0 })
      ].join('\n'),
      'utf8'
    )
    const res2 = await claudePlugin.parseFile(ctx, file, res.nextLine)
    expect(res2.records).toHaveLength(1)
    expect(res2.records[0].source).toEqual({ filePath: file, line: 4 })
    expect(res2.records[0]).toMatchObject({ inputTokens: 7, outputTokens: 3, cacheReadTokens: 1, cacheCreationTokens: 0 })
    expect(res2.nextLine).toBe(5)
    expect(res2.eof).toBe(true)
  })

  it('完整文件一次读完，重复调用从 nextLine 继续只产出新增', async () => {
    const file = path.join(tmpDir, 'main.jsonl')
    fs.writeFileSync(
      file,
      [userLine(), assistantLine(), assistantLine({ uuid: 'a-2', timestamp: '2026-08-19T10:00:10+08:00' })].join('\n'),
      'utf8'
    )
    const res = await claudePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records.map((r) => r.source.line)).toEqual([2, 3])
    expect(res.nextLine).toBe(4)
    expect(res.eof).toBe(true)

    // 未追加内容时续读：无新增
    const res2 = await claudePlugin.parseFile(ctx, file, res.nextLine)
    expect(res2.records).toHaveLength(0)
    expect(res2.eof).toBe(true)

    // 追加一行后再续读：只产出该新增行
    fs.appendFileSync(file, `\n${assistantLine({ uuid: 'a-3', timestamp: '2026-08-19T10:00:15+08:00' })}`, 'utf8')
    const res3 = await claudePlugin.parseFile(ctx, file, res.nextLine)
    expect(res3.records).toHaveLength(1)
    expect(res3.records[0].source).toEqual({ filePath: file, line: 4 })
    expect(res3.nextLine).toBe(5)
  })

  it('无 model / 无 usage 的 assistant 行跳过；全 0 usage 但含 model 仍产出', async () => {
    const noModel = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-19T10:00:06+08:00',
      sessionId: 'sess-1',
      cwd: '/Users/a/b',
      message: { role: 'assistant', content: 'no model', usage: { input_tokens: 5, output_tokens: 5 } }
    })
    const noUsage = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-19T10:00:07+08:00',
      sessionId: 'sess-1',
      cwd: '/Users/a/b',
      message: { role: 'assistant', model: 'claude-sonnet-4-5', content: 'no usage' }
    })
    const zeroUsage = assistantLine({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 })
    const file = path.join(tmpDir, 'main.jsonl')
    fs.writeFileSync(file, [noModel, noUsage, zeroUsage].join('\n'), 'utf8')

    const res = await claudePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.line).toBe(3)
    expect(res.records[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      inputSemantics: 2
    })
    expect(res.nextLine).toBe(4)
    expect(res.eof).toBe(true)
  })

  it('空文件与 fromLine 越过 EOF 的边界：无记录、游标不倒退', async () => {
    const empty = path.join(tmpDir, 'empty.jsonl')
    fs.writeFileSync(empty, '', 'utf8')
    const r1 = await claudePlugin.parseFile(ctx, empty, 0)
    expect(r1.records).toHaveLength(0)
    expect(r1.eof).toBe(true)

    const one = path.join(tmpDir, 'one.jsonl')
    fs.writeFileSync(one, userLine(), 'utf8')
    const r2 = await claudePlugin.parseFile(ctx, one, 99)
    expect(r2.records).toHaveLength(0)
    expect(r2.nextLine).toBe(99)
    expect(r2.eof).toBe(true)
  })

  it('timestamp 非法时 createdAt 兜底为当前时间（非 NaN）', async () => {
    const badTs = JSON.stringify({
      type: 'assistant',
      timestamp: 'not-a-date',
      sessionId: 'sess-1',
      cwd: '/Users/a/b',
      message: { role: 'assistant', model: 'claude-sonnet-4-5', usage: { input_tokens: 1, output_tokens: 1 } }
    })
    const file = path.join(tmpDir, 'main.jsonl')
    fs.writeFileSync(file, badTs, 'utf8')
    const res = await claudePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(Number.isNaN(res.records[0].createdAt)).toBe(false)
    expect(Math.abs(res.records[0].createdAt - Date.now())).toBeLessThan(60_000)
  })

  it('message.id 写入 source.requestId；缺失/非字符串时不设置（退回旧去重）', async () => {
    const file = path.join(tmpDir, 'main.jsonl')
    // 带 id：fork 场景同一消息出现在不同文件也能语义判重
    fs.writeFileSync(
      file,
      [
        assistantLine({ uuid: 'a-1', id: 'msg_01ABC' }),
        assistantLine({ uuid: 'a-2', timestamp: '2026-08-19T10:00:10+08:00' }), // 无 id
        JSON.stringify({
          type: 'assistant',
          uuid: 'a-3',
          timestamp: '2026-08-19T10:00:15+08:00',
          sessionId: 'sess-1',
          cwd: '/Users/a/b',
          message: { role: 'assistant', id: 42, model: 'claude-sonnet-4-5', usage: { input_tokens: 1, output_tokens: 1 } }
        }) // 非字符串 id
      ].join('\n'),
      'utf8'
    )
    const res = await claudePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(3)
    expect(res.records[0].source).toEqual({ filePath: file, line: 1, requestId: 'msg_01ABC' })
    expect(res.records[1].source.requestId).toBeUndefined()
    expect('requestId' in res.records[1].source).toBe(false)
    expect(res.records[2].source.requestId).toBeUndefined()
  })
})

describe('流式分片按 message.id 折叠', () => {
  /** foldById 单测用的最小记录构造器（line 兼作 createdAt，便于断言最终行） */
  const foldRecord = (o: { requestId?: string; output: number; line: number }): UsageRecord => ({
    appType: 'claude',
    model: 'claude-sonnet-4-5',
    rawModel: 'claude-sonnet-4-5',
    inputTokens: 100,
    outputTokens: o.output,
    cacheReadTokens: 10,
    cacheCreationTokens: 20,
    inputSemantics: 2,
    status: 'success',
    createdAt: o.line * 1000,
    source: { filePath: 'f.jsonl', line: o.line, ...(o.requestId ? { requestId: o.requestId } : {}) }
  })

  it('共享 message.id 的三行折叠为一条 final 记录：output 取最大、其余字段与行号取最终行', async () => {
    const file = path.join(tmpDir, 'main.jsonl')
    fs.writeFileSync(
      file,
      [
        userLine(),
        assistantLine({ uuid: 'a-1', id: 'msg_fold', timestamp: '2026-08-19T10:00:01+08:00', output: 10 }),
        assistantLine({ uuid: 'a-2', id: 'msg_fold', timestamp: '2026-08-19T10:00:02+08:00', output: 50 }),
        assistantLine({ uuid: 'a-3', id: 'msg_fold', timestamp: '2026-08-19T10:00:03+08:00', output: 100 })
      ].join('\n'),
      'utf8'
    )
    const res = await claudePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)

    const r = res.records[0]
    expect(r.outputTokens).toBe(100)
    expect(r.inputTokens).toBe(100)
    expect(r.cacheReadTokens).toBe(10)
    expect(r.cacheCreationTokens).toBe(20)
    expect(r.model).toBe('claude-sonnet-4-5')
    expect(r.createdAt).toBe(Date.parse('2026-08-19T10:00:03+08:00'))
    expect(r.source).toEqual({ filePath: file, line: 4, requestId: 'msg_fold' })
  })

  it('乱序防御：output 序列 100/30 时保留首条更大的记录', () => {
    const folded = foldById([
      foldRecord({ requestId: 'msg_A', output: 100, line: 1 }),
      foldRecord({ requestId: 'msg_A', output: 30, line: 2 })
    ])
    expect(folded).toHaveLength(1)
    expect(folded[0].outputTokens).toBe(100)
    expect(folded[0].source.line).toBe(1)
  })

  it('同值 output 后到仍覆盖：时间戳与行号随最新行更新', () => {
    const folded = foldById([
      foldRecord({ requestId: 'msg_A', output: 50, line: 1 }),
      foldRecord({ requestId: 'msg_A', output: 50, line: 2 })
    ])
    expect(folded).toHaveLength(1)
    expect(folded[0].outputTokens).toBe(50)
    expect(folded[0].source.line).toBe(2)
    expect(folded[0].createdAt).toBe(2000)
  })

  it('无 message.id 的行不参与折叠，逐条产出', () => {
    const folded = foldById([
      foldRecord({ output: 10, line: 1 }),
      foldRecord({ output: 20, line: 2 }),
      foldRecord({ output: 30, line: 3 })
    ])
    expect(folded).toHaveLength(3)
    expect(folded.map((r) => r.source.line)).toEqual([1, 2, 3])
  })

  it('不同 message.id 各自独立折叠并保持首次出现顺序', () => {
    const folded = foldById([
      foldRecord({ requestId: 'msg_A', output: 10, line: 1 }),
      foldRecord({ requestId: 'msg_B', output: 30, line: 2 }),
      foldRecord({ requestId: 'msg_A', output: 20, line: 3 }),
      foldRecord({ requestId: 'msg_B', output: 40, line: 4 })
    ])
    expect(folded.map((r) => r.source.requestId)).toEqual(['msg_A', 'msg_B'])
    expect(folded.map((r) => r.outputTokens)).toEqual([20, 40])
    expect(folded.map((r) => r.source.line)).toEqual([3, 4])
  })
})

describe('listFilesFromRoot 收集范围', () => {
  it('只收集项目目录直接子层 + subagents/workflows 子树内的 *.jsonl', () => {
    const root = path.join(tmpDir, 'projects')
    const projA = path.join(root, '-Users-a-b')
    const sub = path.join(projA, 'session-abc', 'subagents')
    const wf = path.join(sub, 'workflows', 'wf_1')
    fs.mkdirSync(wf, { recursive: true })

    fs.writeFileSync(path.join(projA, 'main-1.jsonl'), userLine())
    fs.writeFileSync(path.join(projA, 'main-2.jsonl'), userLine())
    fs.writeFileSync(path.join(projA, 'notes.txt'), 'ignore me')
    fs.writeFileSync(path.join(projA, 'temp.jsonl.tmp'), 'ignore me')
    fs.writeFileSync(path.join(sub, 'sub-1.jsonl'), userLine())
    fs.writeFileSync(path.join(sub, 'sub-2.jsonl'), userLine())
    fs.writeFileSync(path.join(wf, 'deep-1.jsonl'), userLine())
    // 项目目录外的散落 jsonl 不收集
    fs.writeFileSync(path.join(root, 'loose.jsonl'), userLine())

    const entries = listFilesFromRoot(root)
    expect(entries.map((e) => path.basename(e.path)).sort()).toEqual([
      'deep-1.jsonl',
      'main-1.jsonl',
      'main-2.jsonl',
      'sub-1.jsonl',
      'sub-2.jsonl'
    ])
    for (const e of entries) {
      expect(e.mtime).toBeGreaterThan(0)
    }
  })
})
