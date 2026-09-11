import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { claudePlugin, detectFromRoot, foldById, listFilesFromRoot } from './claude'
import type { PluginContext } from '../../../shared/context'
import type { UsageRecord } from '../../../shared/dto'

const ctx = {} as PluginContext

const USER_TS = '2026-08-19T10:00:00+08:00'
const ASST_TS = '2026-08-19T10:00:05+08:00'

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
    const brokenMid = '{this is broken json'
    const trailingHalf =
      '{"type":"assistant","uuid":"a-2","message":{"role":"assistant","model":"claude-sonnet-4-5","usage":{"input_tokens":'
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

    const res2 = await claudePlugin.parseFile(ctx, file, res.nextLine)
    expect(res2.records).toHaveLength(0)
    expect(res2.eof).toBe(true)

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
    fs.writeFileSync(
      file,
      [
        assistantLine({ uuid: 'a-1', id: 'msg_01ABC' }),
        assistantLine({ uuid: 'a-2', timestamp: '2026-08-19T10:00:10+08:00' }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a-3',
          timestamp: '2026-08-19T10:00:15+08:00',
          sessionId: 'sess-1',
          cwd: '/Users/a/b',
          message: { role: 'assistant', id: 42, model: 'claude-sonnet-4-5', usage: { input_tokens: 1, output_tokens: 1 } }
        }),
        assistantLine({ uuid: 'a-4', id: '   ', timestamp: '2026-08-19T10:00:20+08:00' })
      ].join('\n'),
      'utf8'
    )
    const res = await claudePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(4)
    expect(res.records[0].source).toEqual({ filePath: file, line: 1, requestId: 'msg_01ABC' })
    expect(res.records[0].isReplaceableSnapshot).toBe(true)
    for (const record of res.records.slice(1)) {
      expect(record.source.requestId).toBeUndefined()
      expect(record.isReplaceableSnapshot).toBeUndefined()
      expect('requestId' in record.source).toBe(false)
    }
  })
})

describe('失败请求可观测（isApiErrorMessage === true）', () => {
  const errorLine = (o: {
    uuid?: string
    id?: string
    timestamp?: string
    apiErrorStatus?: number
    contentText?: string
    messageContentText?: string
    messageContentAsString?: string
    model?: string
    isApiErrorMessage?: boolean | string
    extraTopContent?: unknown
  } = {}): string => {
    const isErr = o.isApiErrorMessage ?? true
    const topContent =
      o.extraTopContent !== undefined
        ? o.extraTopContent
        : o.contentText !== undefined
          ? [{ type: 'text', text: o.contentText }]
          : undefined
    return JSON.stringify({
      type: 'assistant',
      uuid: o.uuid ?? 'err-uuid-1',
      timestamp: o.timestamp ?? '2026-08-19T10:00:20+08:00',
      sessionId: 'sess-1',
      cwd: '/Users/a/b',
      isApiErrorMessage: isErr,
      ...(o.apiErrorStatus !== undefined ? { apiErrorStatus: o.apiErrorStatus } : {}),
      ...(topContent !== undefined ? { content: topContent } : {}),
      message: {
        role: 'assistant',
        ...(o.id ? { id: o.id } : {}),
        ...(o.model ? { model: o.model } : {}),
        ...(o.messageContentText !== undefined
          ? { content: [{ type: 'text', text: o.messageContentText }] }
          : o.messageContentAsString !== undefined
            ? { content: o.messageContentAsString }
            : o.contentText === undefined && o.messageContentText === undefined && o.messageContentAsString === undefined
              ? { content: [{ type: 'text', text: 'API Error: 429 rate limited' }] }
              : {}),
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      }
    })
  }

  it('isApiErrorMessage===true 产出 error 记录：status/error、httpStatus、tokens 0、model <synthetic>、截断前 500', async () => {
    const file = path.join(tmpDir, 'main.jsonl')
    fs.writeFileSync(
      file,
      errorLine({ uuid: 'u-err-1', id: 'msg_err_1', apiErrorStatus: 429, contentText: 'API Error: 429 Too Many Requests', model: 'claude-sonnet-4-5' }),
      'utf8'
    )
    const res = await claudePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    const r = res.records[0]
    expect(r).toMatchObject({
      appType: 'claude',
      model: 'claude-sonnet-4-5',
      rawModel: 'claude-sonnet-4-5',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      inputSemantics: 2,
      status: 'error',
      httpStatus: 429,
      errorMessage: 'API Error: 429 Too Many Requests'
    })
    expect(r.source).toEqual({ filePath: file, line: 1, requestId: 'msg_err_1' })
    expect(r.isReplaceableSnapshot).toBeUndefined()
    expect(r.createdAt).toBe(Date.parse('2026-08-19T10:00:20+08:00'))
    expect(r.project).toBe('/Users/a/b')
    expect(r.sessionId).toBe('sess-1')
  })

  it('model 缺失时兜底 <synthetic>；无 message.model 且无 msg 时亦为 <synthetic>', async () => {
    const file = path.join(tmpDir, 'main.jsonl')
    const lineNoModel = JSON.stringify({
      type: 'assistant',
      uuid: 'u-err-2',
      timestamp: '2026-08-19T10:00:21+08:00',
      sessionId: 'sess-1',
      cwd: '/Users/a/b',
      isApiErrorMessage: true,
      apiErrorStatus: 500,
      content: [{ type: 'text', text: 'internal error' }],
      message: { role: 'assistant', id: 'msg_err_2', content: [{ type: 'text', text: 'internal error' }] }
    })
    fs.writeFileSync(file, lineNoModel, 'utf8')
    const res = await claudePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].model).toBe('<synthetic>')
    expect(res.records[0].rawModel).toBe('<synthetic>')
    expect(res.records[0].httpStatus).toBe(500)
  })

  it('errorMessage 优先取顶层 content[0].text，其次 message.content；超 500 截断', async () => {
    const file = path.join(tmpDir, 'main.jsonl')
    fs.writeFileSync(
      file,
      [
        errorLine({ uuid: 'u-1', id: 'msg_a', apiErrorStatus: 400, contentText: 'top level error', messageContentText: 'message level error' }),
        errorLine({ uuid: 'u-2', id: 'msg_b', apiErrorStatus: 400, contentText: undefined, messageContentText: 'from message', extraTopContent: [] } as any),
        JSON.stringify({
          type: 'assistant',
          uuid: 'u-3',
          timestamp: '2026-08-19T10:00:22+08:00',
          sessionId: 'sess-1',
          cwd: '/Users/a/b',
          isApiErrorMessage: true,
          apiErrorStatus: 502,
          message: { role: 'assistant', id: 'msg_c', model: 'claude-sonnet-4-5', content: 'string content error' }
        }),
        errorLine({ uuid: 'u-4', id: 'msg_d', apiErrorStatus: 529, contentText: 'x'.repeat(800) })
      ].join('\n'),
      'utf8'
    )
    const res = await claudePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(4)
    expect(res.records[0].errorMessage).toBe('top level error')
    expect(res.records[1].errorMessage).toBe('from message')
    expect(res.records[2].errorMessage).toBe('string content error')
    expect(res.records[3].errorMessage?.length).toBe(500)
    expect(res.records[3].errorMessage).toBe('x'.repeat(500))
  })

  it('requestId 取 message.id 优先，缺失时回落 uuid；apiErrorStatus 非有限数字时不写入 httpStatus', async () => {
    const file = path.join(tmpDir, 'main.jsonl')
    const lineWithUuidOnly = JSON.stringify({
      type: 'assistant',
      uuid: 'fallback-uuid-99',
      timestamp: '2026-08-19T10:00:23+08:00',
      sessionId: 'sess-1',
      cwd: '/Users/a/b',
      isApiErrorMessage: true,
      apiErrorStatus: 'not-a-number' as unknown as number,
      content: [{ type: 'text', text: 'bad status type' }],
      message: { role: 'assistant', content: [{ type: 'text', text: 'bad status type' }] }
    })
    const lineWithId = errorLine({ uuid: 'u-5', id: 'msg_has_id', apiErrorStatus: 401, contentText: 'unauthorized' })
    const lineNoId = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-19T10:00:24+08:00',
      sessionId: 'sess-1',
      cwd: '/Users/a/b',
      isApiErrorMessage: true,
      apiErrorStatus: 403,
      content: [{ type: 'text', text: 'forbidden' }],
      message: { role: 'assistant', content: [{ type: 'text', text: 'forbidden' }] }
    })
    fs.writeFileSync(file, [lineWithUuidOnly, lineWithId, lineNoId].join('\n'), 'utf8')
    const res = await claudePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(3)
    expect(res.records[0].source.requestId).toBe('fallback-uuid-99')
    expect(res.records[0].httpStatus).toBeUndefined()
    expect(res.records[1].source.requestId).toBe('msg_has_id')
    expect(res.records[1].httpStatus).toBe(401)
    expect(res.records[2].source.requestId).toBeUndefined()
    expect('requestId' in res.records[2].source).toBe(false)
  })

  it('isApiErrorMessage !== true（false/字符串/缺失）不按失败产出，仍走 success/跳过逻辑', async () => {
    const file = path.join(tmpDir, 'main.jsonl')
    const falseLine = JSON.stringify({
      type: 'assistant',
      uuid: 'u-false',
      timestamp: '2026-08-19T10:00:25+08:00',
      sessionId: 'sess-1',
      cwd: '/Users/a/b',
      isApiErrorMessage: false,
      apiErrorStatus: 429,
      content: [{ type: 'text', text: 'should not be error' }],
      message: { role: 'assistant', model: 'claude-sonnet-4-5', usage: { input_tokens: 1, output_tokens: 1 } }
    })
    const stringLine = JSON.stringify({
      type: 'assistant',
      uuid: 'u-str',
      timestamp: '2026-08-19T10:00:26+08:00',
      sessionId: 'sess-1',
      cwd: '/Users/a/b',
      isApiErrorMessage: 'true' as unknown as boolean,
      apiErrorStatus: 429,
      content: [{ type: 'text', text: 'string true not error' }],
      message: { role: 'assistant', model: 'claude-sonnet-4-5', usage: { input_tokens: 2, output_tokens: 2 } }
    })
    fs.writeFileSync(file, [falseLine, stringLine].join('\n'), 'utf8')
    const res = await claudePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records[0].status).toBe('success')
    expect(res.records[1].status).toBe('success')
    expect(res.records[0].httpStatus).toBeUndefined()
    expect(res.records[1].httpStatus).toBeUndefined()
  })

  it('与 success 记录共存于同一文件，互不冲突且计数正确', async () => {
    const file = path.join(tmpDir, 'main.jsonl')
    fs.writeFileSync(file, [assistantLine({ uuid: 'a-1', id: 'msg_succ', output: 10 }), errorLine({ uuid: 'u-err', id: 'msg_err', apiErrorStatus: 429, contentText: 'rate limited' })].join('\n'), 'utf8')
    const res = await claudePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    const succ = res.records.find((r) => r.status === 'success')!
    const err = res.records.find((r) => r.status === 'error')!
    expect(succ.outputTokens).toBe(10)
    expect(err.httpStatus).toBe(429)
    expect(err.errorMessage).toBe('rate limited')
  })

  it('error 记录不被折叠逻辑吞并：同 message.id 的 error 与 success 并存，success 仍按 output 最大折叠', async () => {
    const file = path.join(tmpDir, 'main.jsonl')
    fs.writeFileSync(
      file,
      [
        assistantLine({ uuid: 'a-1', id: 'shared_id', timestamp: '2026-08-19T10:00:01+08:00', output: 10 }),
        assistantLine({ uuid: 'a-2', id: 'shared_id', timestamp: '2026-08-19T10:00:02+08:00', output: 50 }),
        errorLine({ uuid: 'u-err-shared', id: 'shared_id', timestamp: '2026-08-19T10:00:03+08:00', apiErrorStatus: 500, contentText: 'shared id error' })
      ].join('\n'),
      'utf8'
    )
    const res = await claudePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    const succ = res.records.find((r) => r.status === 'success')!
    const err = res.records.find((r) => r.status === 'error')!
    expect(succ.outputTokens).toBe(50)
    expect(succ.source.requestId).toBe('shared_id')
    expect(succ.isReplaceableSnapshot).toBe(true)
    expect(err.source.requestId).toBe('shared_id')
    expect(err.isReplaceableSnapshot).toBeUndefined()
    expect(err.httpStatus).toBe(500)
  })

  it('foldById 对 error 记录不折叠：同 requestId 的多条 error 均保留', () => {
    const errRec = (line: number, rid: string): UsageRecord => ({
      appType: 'claude',
      model: '<synthetic>',
      rawModel: '<synthetic>',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      inputSemantics: 2,
      status: 'error',
      httpStatus: 429,
      errorMessage: 'err',
      createdAt: line * 1000,
      source: { filePath: 'f.jsonl', line, requestId: rid }
    })
    const folded = foldById([errRec(1, 'msg_E'), errRec(2, 'msg_E')])
    expect(folded).toHaveLength(2)
    expect(folded.map((r) => r.source.line)).toEqual([1, 2])
  })
})

describe('流式分片按 message.id 折叠', () => {
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
    expect(r.isReplaceableSnapshot).toBe(true)
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

describe('跨同步轮次的可替换快照收敛', () => {
  it('首轮中间快照、次轮最终快照使用相同 requestId 并产出胜出真实行', async () => {
    const file = path.join(tmpDir, 'main.jsonl')
    fs.writeFileSync(
      file,
      [userLine(), assistantLine({ id: 'msg_cross', output: 10, timestamp: '2026-08-19T10:00:01+08:00' })].join('\n'),
      'utf8'
    )

    const first = await claudePlugin.parseFile(ctx, file, 0)
    expect(first.records).toHaveLength(1)
    expect(first.records[0]).toMatchObject({
      outputTokens: 10,
      isReplaceableSnapshot: true,
      source: { filePath: file, line: 2, requestId: 'msg_cross' }
    })

    fs.appendFileSync(
      file,
      `\n${assistantLine({ id: 'msg_cross', output: 100, timestamp: '2026-08-19T10:00:02+08:00' })}`,
      'utf8'
    )
    const second = await claudePlugin.parseFile({} as PluginContext, file, first.nextLine)
    expect(second.records).toHaveLength(1)
    expect(second.records[0]).toMatchObject({
      outputTokens: 100,
      isReplaceableSnapshot: true,
      createdAt: Date.parse('2026-08-19T10:00:02+08:00'),
      source: { filePath: file, line: 3, requestId: 'msg_cross' }
    })
  })

  it('游标前已有更大 output 时，当前窗口较小过期快照不产出', async () => {
    const file = path.join(tmpDir, 'main.jsonl')
    fs.writeFileSync(
      file,
      assistantLine({ id: 'msg_stale', output: 100, timestamp: '2026-08-19T10:00:01+08:00' }),
      'utf8'
    )
    const first = await claudePlugin.parseFile(ctx, file, 0)
    fs.appendFileSync(
      file,
      `\n${assistantLine({ id: 'msg_stale', output: 30, timestamp: '2026-08-19T10:00:02+08:00' })}`,
      'utf8'
    )

    const second = await claudePlugin.parseFile(ctx, file, first.nextLine)
    expect(second.records).toEqual([])
    expect(second.nextLine).toBe(3)
  })

  it('output 相同但后出现时使用当前窗口完整字段并更新 source.line', async () => {
    const file = path.join(tmpDir, 'main.jsonl')
    fs.writeFileSync(
      file,
      assistantLine({
        id: 'msg_equal',
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheCreation: 20,
        timestamp: '2026-08-19T10:00:01+08:00'
      }),
      'utf8'
    )
    const first = await claudePlugin.parseFile(ctx, file, 0)
    fs.appendFileSync(
      file,
      `\n${assistantLine({
        id: 'msg_equal',
        input: 200,
        output: 50,
        cacheRead: 30,
        cacheCreation: 40,
        timestamp: '2026-08-19T10:00:02+08:00'
      })}`,
      'utf8'
    )

    const second = await claudePlugin.parseFile(ctx, file, first.nextLine)
    expect(second.records).toHaveLength(1)
    expect(second.records[0]).toMatchObject({
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
      isReplaceableSnapshot: true,
      createdAt: Date.parse('2026-08-19T10:00:02+08:00'),
      source: { filePath: file, line: 2, requestId: 'msg_equal' }
    })
  })

  it('当前窗口同 ID 多行只产出相对历史最终胜出的一条', async () => {
    const file = path.join(tmpDir, 'main.jsonl')
    fs.writeFileSync(
      file,
      assistantLine({ id: 'msg_window', output: 10, timestamp: '2026-08-19T10:00:01+08:00' }),
      'utf8'
    )
    const first = await claudePlugin.parseFile(ctx, file, 0)
    fs.appendFileSync(
      file,
      [
        assistantLine({ id: 'msg_window', output: 5, timestamp: '2026-08-19T10:00:02+08:00' }),
        assistantLine({ id: 'msg_window', output: 30, timestamp: '2026-08-19T10:00:03+08:00' }),
        assistantLine({ id: 'msg_window', output: 20, timestamp: '2026-08-19T10:00:04+08:00' }),
        assistantLine({ id: 'msg_window', output: 100, timestamp: '2026-08-19T10:00:05+08:00' })
      ].map((line) => `\n${line}`).join(''),
      'utf8'
    )

    const second = await claudePlugin.parseFile(ctx, file, first.nextLine)
    expect(second.records).toHaveLength(1)
    expect(second.records[0]).toMatchObject({
      outputTokens: 100,
      isReplaceableSnapshot: true,
      source: { filePath: file, line: 5, requestId: 'msg_window' }
    })
  })

  it('一次全量与多轮重启增量的最终胜出快照一致', async () => {
    const file = path.join(tmpDir, 'main.jsonl')
    const partial = assistantLine({
      id: 'msg_restart',
      input: 100,
      output: 10,
      cacheRead: 5,
      cacheCreation: 7,
      timestamp: '2026-08-19T10:00:01+08:00'
    })
    const final = assistantLine({
      id: 'msg_restart',
      input: 120,
      output: 100,
      cacheRead: 15,
      cacheCreation: 17,
      timestamp: '2026-08-19T10:00:02+08:00'
    })
    fs.writeFileSync(file, partial, 'utf8')
    const first = await claudePlugin.parseFile(ctx, file, 0)
    fs.appendFileSync(file, `\n${final}`, 'utf8')

    const incremental = await claudePlugin.parseFile({} as PluginContext, file, first.nextLine)
    const full = await claudePlugin.parseFile({} as PluginContext, file, 0)
    expect(incremental.records).toHaveLength(1)
    expect(full.records).toHaveLength(1)
    expect(incremental.records[0]).toEqual(full.records[0])
  })

  it('游标前错误、无 ID 成功和损坏行只参与跳过，不泄漏到当前窗口', async () => {
    const file = path.join(tmpDir, 'main.jsonl')
    const prefixError = JSON.stringify({
      type: 'assistant',
      uuid: 'prefix-error',
      timestamp: '2026-08-19T10:00:01+08:00',
      sessionId: 'sess-1',
      cwd: '/Users/a/b',
      isApiErrorMessage: true,
      apiErrorStatus: 500,
      message: {
        role: 'assistant',
        id: 'msg_prefix_error',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'failed' }],
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    })
    fs.writeFileSync(
      file,
      [
        prefixError,
        assistantLine({ output: 20, timestamp: '2026-08-19T10:00:02+08:00' }),
        '{broken prefix',
        assistantLine({ id: 'msg_prefix', output: 10, timestamp: '2026-08-19T10:00:03+08:00' })
      ].join('\n'),
      'utf8'
    )
    const first = await claudePlugin.parseFile(ctx, file, 0)
    fs.appendFileSync(
      file,
      `\n${assistantLine({ id: 'msg_prefix', output: 100, timestamp: '2026-08-19T10:00:04+08:00' })}`,
      'utf8'
    )

    const second = await claudePlugin.parseFile(ctx, file, first.nextLine)
    expect(second.records).toHaveLength(1)
    expect(second.records[0]).toMatchObject({
      outputTokens: 100,
      isReplaceableSnapshot: true,
      source: { filePath: file, line: 5, requestId: 'msg_prefix' }
    })
  })

  it('尾部半行补全后从停驻游标产出最终胜出快照', async () => {
    const file = path.join(tmpDir, 'main.jsonl')
    const partial = assistantLine({ id: 'msg_half', output: 10, timestamp: '2026-08-19T10:00:01+08:00' })
    const final = assistantLine({ id: 'msg_half', output: 100, timestamp: '2026-08-19T10:00:02+08:00' })
    fs.writeFileSync(file, `${partial}\n${final.slice(0, -12)}`, 'utf8')

    const first = await claudePlugin.parseFile(ctx, file, 0)
    expect(first.records).toHaveLength(1)
    expect(first.nextLine).toBe(2)

    fs.writeFileSync(file, `${partial}\n${final}`, 'utf8')
    const second = await claudePlugin.parseFile({} as PluginContext, file, first.nextLine)
    expect(second.records).toHaveLength(1)
    expect(second.records[0]).toMatchObject({
      outputTokens: 100,
      isReplaceableSnapshot: true,
      source: { filePath: file, line: 2, requestId: 'msg_half' }
    })
  })

  it('错误和无 ID 成功在增量窗口保持不可替换且逐条产出', async () => {
    const file = path.join(tmpDir, 'main.jsonl')
    fs.writeFileSync(
      file,
      assistantLine({ id: 'msg_history', output: 50, timestamp: '2026-08-19T10:00:01+08:00' }),
      'utf8'
    )
    const first = await claudePlugin.parseFile(ctx, file, 0)
    const error = JSON.stringify({
      type: 'assistant',
      uuid: 'err-incremental',
      timestamp: '2026-08-19T10:00:02+08:00',
      sessionId: 'sess-1',
      cwd: '/Users/a/b',
      isApiErrorMessage: true,
      apiErrorStatus: 500,
      message: {
        role: 'assistant',
        id: 'msg_history',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'failed' }],
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    })
    fs.appendFileSync(
      file,
      `\n${error}\n${assistantLine({ output: 25, timestamp: '2026-08-19T10:00:03+08:00' })}`,
      'utf8'
    )

    const second = await claudePlugin.parseFile(ctx, file, first.nextLine)
    expect(second.records).toHaveLength(2)
    expect(second.records[0]).toMatchObject({
      status: 'error',
      source: { filePath: file, line: 2, requestId: 'msg_history' }
    })
    expect(second.records[0].isReplaceableSnapshot).toBeUndefined()
    expect(second.records[1]).toMatchObject({
      status: 'success',
      outputTokens: 25,
      source: { filePath: file, line: 3 }
    })
    expect(second.records[1].source.requestId).toBeUndefined()
    expect(second.records[1].isReplaceableSnapshot).toBeUndefined()
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
