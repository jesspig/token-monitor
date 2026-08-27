import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { geminiPlugin, detectFromRoot, listFilesFromRoot } from './gemini'
import type { PluginContext } from '../../../shared/context'

const ctx = {} as PluginContext

const USER_TS = '2026-08-19T10:00:00+08:00'
const GEMINI_TS = '2026-08-19T10:00:05+08:00'
const LAST_TS = '2026-08-19T10:00:10+08:00'

const buildSession = (messages: unknown[], sessionId = 'sess-g-1'): string =>
  JSON.stringify({
    sessionId,
    projectHash: 'hash-123',
    startTime: USER_TS,
    lastUpdated: LAST_TS,
    messages
  })

const userMsg = (o: { timestamp?: string } = {}): Record<string, unknown> => ({
  type: 'user',
  timestamp: o.timestamp ?? USER_TS,
  text: '你好'
})

const geminiMsg = (
  o: {
    timestamp?: string
    model?: string
    tokens?: Record<string, number>
    type?: string
    id?: string
  } = {}
): Record<string, unknown> => ({
  ...(o.id === undefined ? {} : { id: o.id }),
  type: o.type ?? 'gemini',
  timestamp: o.timestamp ?? GEMINI_TS,
  model: o.model ?? 'gemini-2.5-pro',
  tokens: o.tokens ?? {
    input_tokens: 100,
    output_tokens: 50,
    cached_input_tokens: 10,
    cache_creation_input_tokens: 20
  }
})

const errorMsg = (
  o: { timestamp?: string; content?: string; id?: string; text?: string; type?: string } = {}
): Record<string, unknown> => ({
  ...(o.id === undefined ? {} : { id: o.id }),
  type: o.type ?? 'error',
  timestamp: o.timestamp ?? GEMINI_TS,
  content: o.content ?? 'upstream error: 429 rate limited'
})

let tmpDir = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-plugin-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('geminiPlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(geminiPlugin.id).toBe('gemini')
    expect(geminiPlugin.name).toBe('Gemini CLI')
    expect(geminiPlugin.version).toBe('1.0.0')
    expect(geminiPlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('detect', () => {
  it('tmp 目录缺失时不可用并给出原因与预期目录', () => {
    const sessionDir = path.join(tmpDir, '.gemini', 'tmp')
    const res = detectFromRoot(sessionDir)
    expect(res.available).toBe(false)
    expect(res.reason).toBeTruthy()
    expect(res.sessionDir).toBe(sessionDir)
  })

  it('tmp 目录存在时可用并返回会话目录', () => {
    const sessionDir = path.join(tmpDir, '.gemini', 'tmp')
    fs.mkdirSync(sessionDir, { recursive: true })
    const res = detectFromRoot(sessionDir)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(sessionDir)
  })
})

describe('parseFile 增量解析', () => {
  it('从 0 解析完整会话：user 跳过、gemini 产出，snake_case tokens 正确映射', async () => {
    const file = path.join(tmpDir, 'session-2026-08-19T10-00-abc123.json')
    fs.writeFileSync(file, buildSession([userMsg(), geminiMsg()]), 'utf8')

    const res = await geminiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.eof).toBe(true)

    const r = res.records[0]
    expect(r).toMatchObject({
      appType: 'gemini',
      model: 'gemini-2.5-pro',
      rawModel: 'gemini-2.5-pro',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 20,
      inputSemantics: 1,
      status: 'success',
      sessionId: 'sess-g-1'
    })
    expect(r.project).toBeUndefined()
    expect(r.createdAt).toBe(Date.parse(GEMINI_TS))
    expect(r.source).toEqual({ filePath: file, line: 2 })
    expect(res.nextLine).toBe(2)
  })

  it('camelCase tokens 命名兼容（inputTokens/outputTokens/cacheReadTokens/cacheCreationTokens）', async () => {
    const file = path.join(tmpDir, 'session-2026-08-19T10-00-abc123.json')
    const msg = geminiMsg({
      tokens: { inputTokens: 200, outputTokens: 80, cacheReadTokens: 40, cacheCreationTokens: 25 }
    })
    fs.writeFileSync(file, buildSession([msg]), 'utf8')

    const res = await geminiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({
      inputTokens: 200,
      outputTokens: 80,
      cacheReadTokens: 40,
      cacheCreationTokens: 25
    })
    expect(res.records[0].source).toEqual({ filePath: file, line: 1 })
  })

  it('优先短 key input/output/cached，缺失计数按 0', async () => {
    const file = path.join(tmpDir, 'session-2026-08-19T10-00-abc123.json')
    const msg = geminiMsg({ tokens: { input: 300, output: 90, cached: 5 } })
    fs.writeFileSync(file, buildSession([msg]), 'utf8')

    const res = await geminiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({
      inputTokens: 300,
      outputTokens: 90,
      cacheReadTokens: 5,
      cacheCreationTokens: 0
    })
  })

  it('无 tokens / 无 model 的 gemini 消息跳过；user 消息跳过', async () => {
    const file = path.join(tmpDir, 'session-2026-08-19T10-00-abc123.json')
    const noTokens = { type: 'gemini', timestamp: GEMINI_TS, model: 'gemini-2.5-flash' }
    const noModel = { type: 'gemini', timestamp: GEMINI_TS, tokens: { input: 1, output: 1 } }
    fs.writeFileSync(file, buildSession([userMsg(), noTokens, noModel, geminiMsg()]), 'utf8')

    const res = await geminiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source).toEqual({ filePath: file, line: 4 })
    expect(res.records[0].model).toBe('gemini-2.5-pro')
    expect(res.nextLine).toBe(4)
    expect(res.eof).toBe(true)
  })

  it('游标增量：从 nextLine 续读只产出新增消息，无新增时 nextLine 保持原值', async () => {
    const file = path.join(tmpDir, 'session-2026-08-19T10-00-abc123.json')
    fs.writeFileSync(file, buildSession([userMsg(), geminiMsg()]), 'utf8')

    const res = await geminiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.nextLine).toBe(2)

    const res2 = await geminiPlugin.parseFile(ctx, file, res.nextLine)
    expect(res2.records).toHaveLength(0)
    expect(res2.nextLine).toBe(2)
    expect(res2.eof).toBe(true)

    fs.writeFileSync(
      file,
      buildSession([
        userMsg(),
        geminiMsg(),
        userMsg({ timestamp: LAST_TS }),
        geminiMsg({
          timestamp: LAST_TS,
          tokens: { input_tokens: 7, output_tokens: 3, cached_input_tokens: 1, cache_creation_input_tokens: 0 }
        })
      ]),
      'utf8'
    )
    const res3 = await geminiPlugin.parseFile(ctx, file, res.nextLine)
    expect(res3.records).toHaveLength(1)
    expect(res3.records[0].source).toEqual({ filePath: file, line: 4 })
    expect(res3.records[0]).toMatchObject({
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 1,
      cacheCreationTokens: 0
    })
    expect(res3.nextLine).toBe(4)
    expect(res3.eof).toBe(true)
  })

  it('JSON 解析失败返回空结果 eof:true，游标不推进不倒退', async () => {
    const file = path.join(tmpDir, 'broken.json')
    fs.writeFileSync(file, '{this is not valid json', 'utf8')
    const res = await geminiPlugin.parseFile(ctx, file, 5)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(5)
    expect(res.eof).toBe(true)
  })

  it('messages 缺失或为空返回空结果', async () => {
    const noMessages = path.join(tmpDir, 'no-messages.json')
    fs.writeFileSync(noMessages, JSON.stringify({ sessionId: 'sess-g-1', startTime: USER_TS }), 'utf8')
    const r1 = await geminiPlugin.parseFile(ctx, noMessages, 0)
    expect(r1.records).toHaveLength(0)
    expect(r1.nextLine).toBe(0)
    expect(r1.eof).toBe(true)

    const empty = path.join(tmpDir, 'empty-messages.json')
    fs.writeFileSync(empty, JSON.stringify({ sessionId: 'sess-g-1', messages: [] }), 'utf8')
    const r2 = await geminiPlugin.parseFile(ctx, empty, 0)
    expect(r2.records).toHaveLength(0)
    expect(r2.nextLine).toBe(0)
    expect(r2.eof).toBe(true)
  })

  it('timestamp 非法时 createdAt 兜底为当前时间（非 NaN）', async () => {
    const file = path.join(tmpDir, 'session-2026-08-19T10-00-abc123.json')
    fs.writeFileSync(file, buildSession([geminiMsg({ timestamp: 'not-a-date' })]), 'utf8')
    const res = await geminiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(Number.isNaN(res.records[0].createdAt)).toBe(false)
    expect(Math.abs(res.records[0].createdAt - Date.now())).toBeLessThan(60_000)
  })
})

describe('语义 ID(source.requestId)接入', () => {
  it('消息带 id 时写入 source.requestId', async () => {
    const file = path.join(tmpDir, 'session-with-id.json')
    fs.writeFileSync(file, buildSession([geminiMsg({ id: 'msg-g-1' })]), 'utf8')

    const res = await geminiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source).toEqual({ filePath: file, line: 1, requestId: 'msg-g-1' })
  })

  it('消息缺 id 时 source.requestId 为 undefined', async () => {
    const file = path.join(tmpDir, 'session-no-id.json')
    fs.writeFileSync(file, buildSession([geminiMsg()]), 'utf8')

    const res = await geminiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.requestId).toBeUndefined()
  })
})

describe('listFilesFromRoot 收集范围', () => {
  it('只收集 tmp/*/chats/ 下（递归）的 session-*.json，忽略 checkpoints/临时文件/目录外文件', () => {
    const root = path.join(tmpDir, 'tmp')
    const chats = path.join(root, 'hash-abc', 'chats')
    const checkpoints = path.join(chats, 'checkpoints')
    fs.mkdirSync(checkpoints, { recursive: true })

    fs.writeFileSync(path.join(chats, 'session-2026-08-19T10-00-aaa111.json'), buildSession([geminiMsg()]))
    fs.writeFileSync(path.join(chats, 'session-2026-08-19T11-00-bbb222.json'), buildSession([geminiMsg()]))
    fs.writeFileSync(path.join(chats, 'checkpoint-2026-08-19T10-00.json'), '{}')
    fs.writeFileSync(path.join(chats, 'session-2026-08-19T12-00-tmp.json.tmp'), '{}')
    fs.writeFileSync(path.join(checkpoints, 'checkpoint-2026-08-19T09-00.json'), '{}')
    fs.writeFileSync(path.join(root, 'hash-abc', 'session-2026-08-19T13-00-outside.json'), '{}')

    const entries = listFilesFromRoot(root)
    expect(entries.map((e) => path.basename(e.path)).sort()).toEqual([
      'session-2026-08-19T10-00-aaa111.json',
      'session-2026-08-19T11-00-bbb222.json'
    ])
    for (const e of entries) {
      expect(e.mtime).toBeGreaterThan(0)
    }
  })
})


const META_LINE = JSON.stringify({
  sessionId: 'sess-jsonl',
  projectHash: 'hash-123',
  startTime: USER_TS,
  lastUpdated: LAST_TS
})

const SET_LINE = JSON.stringify({ $set: { lastUpdated: LAST_TS, messageCount: 2 } })

const jsonlGeminiLine = (
  o: { id?: string; timestamp?: string; tokens?: Record<string, number> } = {}
): string =>
  JSON.stringify({
    ...(o.id === undefined ? {} : { id: o.id }),
    type: 'gemini',
    timestamp: o.timestamp ?? GEMINI_TS,
    model: 'gemini-2.5-pro',
    content: '回答内容',
    tokens: o.tokens ?? { input: 100, output: 50, cached: 10 }
  })

const jsonlErrorLine = (o: { id?: string; timestamp?: string; content?: string } = {}): string =>
  JSON.stringify({
    ...(o.id === undefined ? {} : { id: o.id }),
    type: 'error',
    timestamp: o.timestamp ?? GEMINI_TS,
    content: o.content ?? 'upstream error: 429 rate limited'
  })

const writeJsonl = (file: string, lines: string[]): void =>
  fs.writeFileSync(file, lines.join('\n'), 'utf8')

describe('JSONL 会话格式（新版）', () => {
  it('listFiles 收集 chats 子树内任意层级 .jsonl（含嵌套 subagent 目录），其余排除', () => {
    const root = path.join(tmpDir, 'tmp')
    const chats = path.join(root, 'hash-abc', 'chats')
    const subagentDir = path.join(chats, 'parent-session-uuid')
    fs.mkdirSync(subagentDir, { recursive: true })

    fs.writeFileSync(path.join(chats, 'session-1770000000000-ab12cd34.jsonl'), META_LINE)
    fs.writeFileSync(path.join(subagentDir, 'sub-abc12345.jsonl'), META_LINE)
    fs.writeFileSync(path.join(chats, 'notes.txt'), 'not a session')
    fs.writeFileSync(path.join(root, 'other.jsonl'), META_LINE)

    const entries = listFilesFromRoot(root)
    expect(entries.map((e) => path.basename(e.path)).sort()).toEqual([
      'session-1770000000000-ab12cd34.jsonl',
      'sub-abc12345.jsonl'
    ])
  })

  it('端到端：metadata/user/$set 行不产出，gemini 行 sessionId 取自 metadata 状态，requestId=line 正确', async () => {
    const file = path.join(tmpDir, 'session-1770000000000-ab12cd34.jsonl')
    const userLine = JSON.stringify({ id: 'u1', timestamp: USER_TS, type: 'user', content: '你好' })
    writeJsonl(file, [META_LINE, userLine, jsonlGeminiLine({ id: 'msg-jsonl-1' }), SET_LINE])

    const res = await geminiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.eof).toBe(true)

    const r = res.records[0]
    expect(r).toMatchObject({
      appType: 'gemini',
      model: 'gemini-2.5-pro',
      rawModel: 'gemini-2.5-pro',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreationTokens: 0,
      inputSemantics: 1,
      status: 'success',
      sessionId: 'sess-jsonl'
    })
    expect(r.createdAt).toBe(Date.parse(GEMINI_TS))
    expect(r.source).toEqual({ filePath: file, line: 3, requestId: 'msg-jsonl-1' })
    expect(res.nextLine).toBe(5)
  })

  it('游标增量：fromLine=上次 nextLine 续读，只产出追加的新 gemini 行', async () => {
    const file = path.join(tmpDir, 'session-append.jsonl')
    writeJsonl(file, [META_LINE, jsonlGeminiLine({ id: 'm-1' })])

    const first = await geminiPlugin.parseFile(ctx, file, 0)
    expect(first.records.map((r) => r.source.requestId)).toEqual(['m-1'])
    expect(first.nextLine).toBe(3)

    fs.appendFileSync(
      file,
      '\n' +
        [
          jsonlGeminiLine({ id: 'm-2', timestamp: LAST_TS }),
          JSON.stringify({ type: 'user', timestamp: LAST_TS, content: '追问' })
        ].join('\n'),
      'utf8'
    )

    const second = await geminiPlugin.parseFile(ctx, file, first.nextLine)
    expect(second.records).toHaveLength(1)
    expect(second.records[0].source).toEqual({ filePath: file, line: 3, requestId: 'm-2' })
    expect(second.records[0]).toMatchObject({ inputTokens: 100, outputTokens: 50 })
    expect(second.nextLine).toBe(5)
    expect(second.eof).toBe(true)
  })

  it('尾部半行：游标停在该行且 eof=true，写入补全后重试产出完整记录', async () => {
    const file = path.join(tmpDir, 'session-half-line.jsonl')
    const halfLine = '{"id":"m-x","type":"gemini","model":"gemini-2.5-pro"'
    writeJsonl(file, [META_LINE, jsonlGeminiLine({ id: 'm-1' }), halfLine])

    const first = await geminiPlugin.parseFile(ctx, file, 0)
    expect(first.records.map((r) => r.source.requestId)).toEqual(['m-1'])
    expect(first.nextLine).toBe(3)
    expect(first.eof).toBe(true)

    writeJsonl(file, [META_LINE, jsonlGeminiLine({ id: 'm-1' }), jsonlGeminiLine({ id: 'm-x' })])
    const retry = await geminiPlugin.parseFile(ctx, file, first.nextLine)
    expect(retry.records.map((r) => r.source.requestId)).toEqual(['m-x'])
    expect(retry.records[0].source.line).toBe(3)
    expect(retry.nextLine).toBe(4)
  })

  it('中间损坏行宽松跳过，后续 gemini 行不受阻塞', async () => {
    const file = path.join(tmpDir, 'session-corrupt-middle.jsonl')
    writeJsonl(file, [META_LINE, '{broken json', jsonlGeminiLine({ id: 'm-1' }), jsonlGeminiLine({ id: 'm-2' })])

    const res = await geminiPlugin.parseFile(ctx, file, 0)
    expect(res.records.map((r) => r.source.requestId)).toEqual(['m-1', 'm-2'])
    expect(res.records[0].source.line).toBe(3)
    expect(res.records[1].source.line).toBe(4)
    expect(res.nextLine).toBe(5)
    expect(res.eof).toBe(true)
  })

  it('$set 行携带 sessionId 时刷新会话状态，后续消息归属新 sessionId', async () => {
    const file = path.join(tmpDir, 'session-set-id.jsonl')
    writeJsonl(file, [
      META_LINE,
      jsonlGeminiLine({ id: 'm-1' }),
      JSON.stringify({ $set: { sessionId: 'sess-jsonl-2', lastUpdated: LAST_TS } }),
      jsonlGeminiLine({ id: 'm-2', timestamp: LAST_TS })
    ])

    const res = await geminiPlugin.parseFile(ctx, file, 0)
    expect(res.records.map((r) => r.sessionId)).toEqual(['sess-jsonl', 'sess-jsonl-2'])
  })
})


describe('失败可观测：type===error => error 记录（双格式兼容）', () => {
  it('legacy：孤立 error 行产出 error 记录，model 回退 unknown，tokens 全 0，httpStatus undefined', async () => {
    const file = path.join(tmpDir, 'session-error-alone.json')
    fs.writeFileSync(file, buildSession([errorMsg({ content: 'quota exceeded' })]), 'utf8')

    const res = await geminiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    const r = res.records[0]
    expect(r).toMatchObject({
      appType: 'gemini',
      model: 'unknown',
      rawModel: 'unknown',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      inputSemantics: 1,
      status: 'error',
      sessionId: 'sess-g-1'
    })
    expect(r.httpStatus).toBeUndefined()
    expect(r.errorMessage).toBe('quota exceeded')
    expect(r.createdAt).toBe(Date.parse(GEMINI_TS))
    expect(r.source).toEqual({ filePath: file, line: 1 })
    expect(res.nextLine).toBe(1)
  })

  it('legacy：gemini 后紧跟 error，error 的 model 取前一条 gemini 的 model', async () => {
    const file = path.join(tmpDir, 'session-error-fallback.json')
    fs.writeFileSync(
      file,
      buildSession([geminiMsg({ model: 'gemini-2.5-pro' }), errorMsg({ content: 'rate limited' })]),
      'utf8'
    )

    const res = await geminiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records[0]).toMatchObject({ status: 'success', model: 'gemini-2.5-pro' })
    expect(res.records[1]).toMatchObject({
      status: 'error',
      model: 'gemini-2.5-pro',
      rawModel: 'gemini-2.5-pro',
      inputTokens: 0,
      outputTokens: 0,
      errorMessage: 'rate limited'
    })
    expect(res.records[1].httpStatus).toBeUndefined()
    expect(res.records[1].createdAt).toBe(Date.parse(GEMINI_TS))
    expect(res.records[1].source.line).toBe(2)
  })

  it('legacy：error 混合成功/失败与 user 行，游标与模型回退正确', async () => {
    const file = path.join(tmpDir, 'session-mixed.json')
    fs.writeFileSync(
      file,
      buildSession([
        userMsg(),
        errorMsg({ content: 'first error' }),
        geminiMsg({ model: 'gemini-2.5-flash', tokens: { input: 10, output: 5, cached: 1 } }),
        errorMsg({ content: 'second error' }),
        userMsg({ timestamp: LAST_TS }),
        errorMsg({ content: 'third error', timestamp: LAST_TS })
      ]),
      'utf8'
    )

    const res = await geminiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(4)
    expect(res.records[0]).toMatchObject({ status: 'error', model: 'unknown', source: { line: 2 } })
    expect(res.records[1]).toMatchObject({ status: 'success', model: 'gemini-2.5-flash' })
    expect(res.records[2]).toMatchObject({ status: 'error', model: 'gemini-2.5-flash', source: { line: 4 } })
    expect(res.records[3]).toMatchObject({ status: 'error', model: 'gemini-2.5-flash', source: { line: 6 } })
    expect(res.nextLine).toBe(6)
  })

  it('legacy：error content 超 500 截断，httpStatus 保持 undefined', async () => {
    const file = path.join(tmpDir, 'session-truncate.json')
    const long = 'a'.repeat(600)
    fs.writeFileSync(file, buildSession([errorMsg({ content: long })]), 'utf8')

    const res = await geminiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].errorMessage!.length).toBe(500)
    expect(res.records[0].errorMessage).toBe('a'.repeat(500))
    expect(res.records[0].httpStatus).toBeUndefined()
    expect(res.records[0].status).toBe('error')
  })

  it('legacy：error 带 id 时透传 requestId，缺 id 时不设', async () => {
    const withId = path.join(tmpDir, 'session-error-id.json')
    fs.writeFileSync(withId, buildSession([errorMsg({ content: 'boom', id: 'err-1' })]), 'utf8')
    const r1 = await geminiPlugin.parseFile(ctx, withId, 0)
    expect(r1.records[0].source).toEqual({ filePath: withId, line: 1, requestId: 'err-1' })

    const noId = path.join(tmpDir, 'session-error-noid.json')
    fs.writeFileSync(noId, buildSession([errorMsg({ content: 'boom' })]), 'utf8')
    const r2 = await geminiPlugin.parseFile(ctx, noId, 0)
    expect(r2.records[0].source.requestId).toBeUndefined()
  })

  it('legacy：游标增量跨批，error 仍能回退到上一批的 gemini 模型', async () => {
    const file = path.join(tmpDir, 'session-incremental-error.json')
    fs.writeFileSync(file, buildSession([geminiMsg({ model: 'gemini-2.5-pro' })]), 'utf8')
    const first = await geminiPlugin.parseFile(ctx, file, 0)
    expect(first.records).toHaveLength(1)
    expect(first.nextLine).toBe(1)

    fs.writeFileSync(
      file,
      buildSession([geminiMsg({ model: 'gemini-2.5-pro' }), errorMsg({ content: 'after', timestamp: LAST_TS })]),
      'utf8'
    )
    const second = await geminiPlugin.parseFile(ctx, file, first.nextLine)
    expect(second.records).toHaveLength(1)
    expect(second.records[0]).toMatchObject({
      status: 'error',
      model: 'gemini-2.5-pro',
      errorMessage: 'after'
    })
    expect(second.records[0].source.line).toBe(2)
    expect(second.nextLine).toBe(2)
  })

  it('legacy：error 与 gemini 成功消息类型区分（tokens 互不干扰）', async () => {
    const file = path.join(tmpDir, 'session-distinct.json')
    fs.writeFileSync(file, buildSession([geminiMsg(), errorMsg({ content: 'fail' }), geminiMsg({ id: 'm2' })]), 'utf8')
    const res = await geminiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(3)
    expect(res.records[0]).toMatchObject({ status: 'success', inputTokens: 100 })
    expect(res.records[1]).toMatchObject({ status: 'error', inputTokens: 0, outputTokens: 0 })
    expect(res.records[2]).toMatchObject({ status: 'success', inputTokens: 100 })
  })

  it('JSONL：孤立 error 行产出 unknown，tokens 0，sessionId 取 metadata', async () => {
    const file = path.join(tmpDir, 'session-error-jsonl-alone.jsonl')
    writeJsonl(file, [META_LINE, jsonlErrorLine({ content: 'quota exceeded' })])

    const res = await geminiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    const r = res.records[0]
    expect(r).toMatchObject({
      appType: 'gemini',
      model: 'unknown',
      rawModel: 'unknown',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      inputSemantics: 1,
      status: 'error',
      sessionId: 'sess-jsonl',
      errorMessage: 'quota exceeded'
    })
    expect(r.httpStatus).toBeUndefined()
    expect(r.createdAt).toBe(Date.parse(GEMINI_TS))
    expect(r.source).toEqual({ filePath: file, line: 2 })
    expect(res.nextLine).toBe(3)
  })

  it('JSONL：gemini 后紧跟 error，model 回退前一条 gemini 模型', async () => {
    const file = path.join(tmpDir, 'session-jsonl-fallback.jsonl')
    writeJsonl(file, [META_LINE, jsonlGeminiLine({ id: 'g1' }), jsonlErrorLine({ content: 'rate limited' })])

    const res = await geminiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records[0]).toMatchObject({ status: 'success', model: 'gemini-2.5-pro' })
    expect(res.records[1]).toMatchObject({
      status: 'error',
      model: 'gemini-2.5-pro',
      errorMessage: 'rate limited'
    })
    expect(res.records[1].httpStatus).toBeUndefined()
  })

  it('JSONL：error content 超 500 截断', async () => {
    const file = path.join(tmpDir, 'session-jsonl-truncate.jsonl')
    writeJsonl(file, [META_LINE, jsonlErrorLine({ content: 'b'.repeat(700) })])

    const res = await geminiPlugin.parseFile(ctx, file, 0)
    expect(res.records[0].errorMessage!.length).toBe(500)
    expect(res.records[0].errorMessage).toBe('b'.repeat(500))
  })

  it('JSONL：游标增量跨批，error 回退到上一批 gemini 模型（全量扫描维护 lastModel）', async () => {
    const file = path.join(tmpDir, 'session-jsonl-incremental-error.jsonl')
    writeJsonl(file, [META_LINE, jsonlGeminiLine({ id: 'g1', timestamp: GEMINI_TS })])
    const first = await geminiPlugin.parseFile(ctx, file, 0)
    expect(first.records).toHaveLength(1)
    expect(first.nextLine).toBe(3)

    fs.appendFileSync(file, '\n' + jsonlErrorLine({ content: 'after error', timestamp: LAST_TS }), 'utf8')
    const second = await geminiPlugin.parseFile(ctx, file, first.nextLine)
    expect(second.records).toHaveLength(1)
    expect(second.records[0]).toMatchObject({
      status: 'error',
      model: 'gemini-2.5-pro',
      errorMessage: 'after error'
    })
    expect(second.records[0].source.line).toBe(3)
    expect(second.records[0].sessionId).toBe('sess-jsonl')
  })

  it('JSONL：中间损坏行不影响后续 error 产出，尾部半行重试', async () => {
    const file = path.join(tmpDir, 'session-jsonl-error-corrupt.jsonl')
    writeJsonl(file, [META_LINE, '{broken', jsonlGeminiLine({ id: 'g1' }), jsonlErrorLine({ id: 'e1' })])
    const res = await geminiPlugin.parseFile(ctx, file, 0)
    expect(res.records.map((r) => r.status)).toEqual(['success', 'error'])
    expect(res.records[1].source.line).toBe(4)
  })

  it('JSONL：error 与 success 区分，混合序列正确产出各自记录', async () => {
    const userLine = JSON.stringify({ type: 'user', timestamp: USER_TS, content: 'hi' })
    const file = path.join(tmpDir, 'session-jsonl-mixed.jsonl')
    writeJsonl(file, [
      META_LINE,
      userLine,
      jsonlErrorLine({ content: 'first' }),
      jsonlGeminiLine({ id: 'g1' }),
      jsonlErrorLine({ content: 'second' }),
      userLine,
      jsonlErrorLine({ content: 'third', timestamp: LAST_TS })
    ])

    const res = await geminiPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(4)
    expect(res.records[0]).toMatchObject({ status: 'error', model: 'unknown', source: { line: 3 } })
    expect(res.records[1]).toMatchObject({ status: 'success', model: 'gemini-2.5-pro' })
    expect(res.records[2]).toMatchObject({ status: 'error', model: 'gemini-2.5-pro', source: { line: 5 } })
    expect(res.records[3]).toMatchObject({ status: 'error', model: 'gemini-2.5-pro', source: { line: 7 } })
  })

  it('JSONL：error 带 id 时 requestId 透传', async () => {
    const file = path.join(tmpDir, 'session-jsonl-error-id.jsonl')
    writeJsonl(file, [META_LINE, jsonlErrorLine({ id: 'err-9', content: 'boom' })])
    const res = await geminiPlugin.parseFile(ctx, file, 0)
    expect(res.records[0].source).toEqual({ filePath: file, line: 2, requestId: 'err-9' })
  })

  it('双格式兼容：error 行与 gemini 成功行解析逻辑不互相覆盖（tokens 全 0 vs 有值）', async () => {
    const legacy = path.join(tmpDir, 'session-dual-legacy.json')
    fs.writeFileSync(legacy, buildSession([geminiMsg(), errorMsg({ content: 'legacy-fail' })]), 'utf8')
    const r1 = await geminiPlugin.parseFile(ctx, legacy, 0)
    expect(r1.records[0].inputTokens).toBe(100)
    expect(r1.records[1].inputTokens).toBe(0)
    expect(r1.records[1].status).toBe('error')

    const jsonl = path.join(tmpDir, 'session-dual-jsonl.jsonl')
    writeJsonl(jsonl, [META_LINE, jsonlGeminiLine(), jsonlErrorLine({ content: 'jsonl-fail' })])
    const r2 = await geminiPlugin.parseFile(ctx, jsonl, 0)
    expect(r2.records[0].inputTokens).toBe(100)
    expect(r2.records[1].inputTokens).toBe(0)
    expect(r2.records[1].status).toBe('error')
  })
})
