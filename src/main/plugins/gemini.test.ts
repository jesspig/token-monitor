import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { geminiPlugin, detectFromRoot, listFilesFromRoot } from './gemini'
import type { PluginContext } from '../../../shared/context'

/** parseFile 不使用 ctx 上的服务，测试时给个空壳即可 */
const ctx = {} as PluginContext

const USER_TS = '2026-08-19T10:00:00+08:00'
const GEMINI_TS = '2026-08-19T10:00:05+08:00'
const LAST_TS = '2026-08-19T10:00:10+08:00'

/** 组装单个 gemini 会话文件（单 JSON 对象，非 JSONL） */
const buildSession = (messages: unknown[], sessionId = 'sess-g-1'): string =>
  JSON.stringify({
    sessionId,
    projectHash: 'hash-123',
    startTime: USER_TS,
    lastUpdated: LAST_TS,
    messages
  })

/** user 消息 */
const userMsg = (o: { timestamp?: string } = {}): Record<string, unknown> => ({
  type: 'user',
  timestamp: o.timestamp ?? USER_TS,
  text: '你好'
})

/** gemini 消息(默认 snake_case tokens,可覆盖;id 缺省时不写入) */
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
    expect(r.source).toEqual({ filePath: file, line: 2 }) // 消息数组中第 2 条（1-based）
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

    // 未追加时续读：无新增，nextLine 保持
    const res2 = await geminiPlugin.parseFile(ctx, file, res.nextLine)
    expect(res2.records).toHaveLength(0)
    expect(res2.nextLine).toBe(2)
    expect(res2.eof).toBe(true)

    // 追加 user + gemini 后续读：只产出新增的 gemini（消息序号 4）
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
    // chats 目录外的 session-*.json 不收集（不符合 tmp/*/chats/ 布局）
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

/* ---------- 新版 append-only JSONL 格式（Gemini CLI 2026-03 起，PR #23749） ---------- */

/** JSONL 首行：会话 metadata（含 sessionId，无 type 字段） */
const META_LINE = JSON.stringify({
  sessionId: 'sess-jsonl',
  projectHash: 'hash-123',
  startTime: USER_TS,
  lastUpdated: LAST_TS
})

/** $set 元数据更新行 */
const SET_LINE = JSON.stringify({ $set: { lastUpdated: LAST_TS, messageCount: 2 } })

/** JSONL gemini 消息行（新版短 key tokens：input/output/cached） */
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

/** 多行拼成 JSONL 文件内容（无尾随换行，行号即数组下标 +1） */
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
    // chats 子树外的 .jsonl 不收集（不符合 tmp/<hash>/chats/ 布局）
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
    // 4 行全部处理完毕，游标指向第 5 行（下次续读起点）
    expect(res.nextLine).toBe(5)
  })

  it('游标增量：fromLine=上次 nextLine 续读，只产出追加的新 gemini 行', async () => {
    const file = path.join(tmpDir, 'session-append.jsonl')
    writeJsonl(file, [META_LINE, jsonlGeminiLine({ id: 'm-1' })])

    const first = await geminiPlugin.parseFile(ctx, file, 0)
    expect(first.records.map((r) => r.source.requestId)).toEqual(['m-1'])
    expect(first.nextLine).toBe(3)

    // append-only 追加一行 gemini + 一行 user
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
    expect(first.nextLine).toBe(3) // 半行为第 3 行，游标原地等待下次重试
    expect(first.eof).toBe(true)

    // 写入器补全该行后，从停驻行重试
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
