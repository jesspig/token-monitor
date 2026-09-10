import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { dshPlugin, dataRootOf, detectFromRoot, listFilesFromRoot } from './dsh'
import type { PluginContext } from '../../../shared/context'

type CursorMetaStub = { lineOffset: number; fileMtime: number; byteOffset?: number | null } | null

function makeCtxWithStorage(meta: CursorMetaStub = null): {
  ctx: PluginContext
  cursorWrites: { filePath: string; line: number; mtime: number | undefined; byteOffset: number | null | undefined }[]
} {
  const cursorWrites: {
    filePath: string
    line: number
    mtime: number | undefined
    byteOffset: number | null | undefined
  }[] = []
  const ctx = {
    storage: {
      getCursorMeta: vi.fn(async () => meta),
      setCursor: vi.fn(
        async (filePath: string, line: number, mtime?: number, byteOffset?: number | null) => {
          cursorWrites.push({ filePath, line, mtime, byteOffset })
        }
      )
    }
  } as unknown as PluginContext
  return { ctx, cursorWrites }
}

const ctx = makeCtxWithStorage().ctx

const DSH_TS = 1770000000000
const SESSION_ID = 'sess-dsh-1'
const CWD = '/home/alice/demo'

const headerLine = (o: { id?: string; cwd?: string } = {}): string =>
  JSON.stringify({
    type: 'session',
    version: 0,
    id: o.id ?? SESSION_ID,
    cwd: o.cwd ?? CWD,
    createdAt: DSH_TS
  })

const userMessageLine = (seq = 1): string =>
  JSON.stringify({
    type: 'user/message',
    seq,
    time: DSH_TS + 1000,
    data: { message: { role: 'user', content: '你好' } }
  })

const toolResultLine = (seq = 4): string =>
  JSON.stringify({ type: 'tool/result', seq, time: DSH_TS + 3000, data: { toolCallId: 't-1', result: 'ok' } })

const requestHeaderLine = (
  o: { seq?: number; time?: number; provider?: string; model?: string } = {}
): string =>
  JSON.stringify({
    type: 'request/header',
    seq: o.seq ?? 5,
    time: o.time ?? DSH_TS + 4000,
    data: {
      header: {
        config: {
          provider: o.provider ?? 'deepseek',
          model: o.model ?? 'deepseek-v4-flash',
          reasoningEffort: 'max'
        }
      }
    }
  })

const assistantChunkLine = (seq = 6): string =>
  JSON.stringify({ type: 'assistant/chunk', seq, time: DSH_TS + 5000, data: { chunks: [{ kind: 'text', text: '答' }] } })

const DEFAULT_USAGE = {
  inputTokens: 120,
  outputTokens: 60,
  cacheReadTokens: 800,
  cacheWriteTokens: 30,
  reasoningTokens: 15
}

const assistantMessageLine = (
  o: {
    seq?: number
    time?: number | null
    role?: string
    sourceModel?: string
    messageModel?: string
    provider?: string
    usage?: Record<string, unknown> | null
  } = {}
): string =>
  JSON.stringify({
    type: 'assistant/message',
    seq: o.seq ?? 2,
    ...(o.time === undefined || o.time === null ? {} : { time: o.time }),
    data: {
      message: {
        ...(o.role === undefined ? {} : { role: o.role }),
        ...(o.messageModel === undefined ? {} : { model: o.messageModel }),
        ...(o.sourceModel === undefined
          ? {}
          : { source: { provider: o.provider ?? 'deepseek', model: o.sourceModel } }),
        provider: o.provider === undefined ? 'deepseek' : o.provider,
        content: '回答内容'
      },
      ...(o.usage === null ? {} : { usage: o.usage ?? DEFAULT_USAGE })
    }
  })

const llmRetryFailureLine = (
  o: {
    seq?: number
    time?: number
    code?: string | number | null
    message?: string | null
    model?: string | null
    failure?: Record<string, unknown> | null
    dataModel?: string | null
  } = {}
): string =>
  JSON.stringify({
    type: 'llm/retry',
    seq: o.seq ?? 8,
    time: o.time ?? DSH_TS + 7000,
    data: {
      ...(o.dataModel === undefined ? {} : o.dataModel === null ? {} : { model: o.dataModel }),
      failure:
        o.failure !== undefined
          ? o.failure
          : {
              ...(o.code === undefined || o.code === null ? {} : { code: o.code }),
              ...(o.message === undefined || o.message === null ? {} : { message: o.message }),
              ...(o.model === undefined || o.model === null ? {} : { model: o.model })
            }
    }
  })

const llmRetryStartedLine = (seq = 9, time: number = DSH_TS + 8000): string =>
  JSON.stringify({ type: 'llm/retry-started', seq, time, data: { attempt: 1 } })

const llmRetryNoFailureLine = (seq = 10, time: number = DSH_TS + 9000): string =>
  JSON.stringify({ type: 'llm/retry', seq, time, data: { retryCount: 1 } })

const writeJsonl = (file: string, lines: string[]): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, lines.join('\n'), 'utf8')
}

let tmpDir = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-'))
})

afterEach(() => {
  delete process.env.DSH_HOME
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('dshPlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(dshPlugin.id).toBe('dsh')
    expect(dshPlugin.name).toBe('DeepSeek Harness')
    expect(dshPlugin.version).toBe('1.0.0')
    expect(dshPlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('dataRootOf 环境变量覆盖', () => {
  it('默认 ~/.dsh/sessions', () => {
    expect(dataRootOf()).toBe(path.join(os.homedir(), '.dsh', 'sessions'))
  })

  it('$DSH_HOME 非空时取其下 sessions 子目录（含 trim），空白串视为未设置', () => {
    process.env.DSH_HOME = ` ${tmpDir} `
    expect(dataRootOf()).toBe(path.join(tmpDir, 'sessions'))
    process.env.DSH_HOME = '   '
    expect(dataRootOf()).toBe(path.join(os.homedir(), '.dsh', 'sessions'))
  })

  it('插件级 listFiles/detect 读取 $DSH_HOME 覆盖的数据根', async () => {
    const sessionsDir = path.join(tmpDir, 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    writeJsonl(path.join(sessionsDir, '--home-alice-demo--', 'abc123', 'session.jsonl'), [
      headerLine(),
      assistantMessageLine()
    ])
    process.env.DSH_HOME = tmpDir

    const entries = await dshPlugin.listFiles(ctx)
    expect(entries.map((e) => path.basename(e.path))).toEqual(['session.jsonl'])
    const res = await dshPlugin.detect(ctx)
    expect(res.available).toBe(true)
  })
})

describe('detectFromRoot 探测逻辑', () => {
  it('数据根缺失时不可用，reason 含 $DSH_HOME 提示与 SQLite 后端不支持说明', () => {
    const root = path.join(tmpDir, 'sessions')
    const res = detectFromRoot(root)
    expect(res.available).toBe(false)
    expect(res.reason).toContain('$DSH_HOME')
    expect(res.reason).toContain('SQLite 后端暂不支持')
    expect(res.sessionDir).toBe(root)
  })

  it('数据根存在但无会话工件时不可用；有固定名工件时可用', () => {
    const root = path.join(tmpDir, 'sessions')
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'notes.db'), 'x')
    expect(detectFromRoot(root).available).toBe(false)

    writeJsonl(path.join(root, '--home-alice-demo--', 'abc123', 'session.jsonl.zstd'), ['placeholder'])
    const res = detectFromRoot(root)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(root)
  })
})

describe('listFilesFromRoot 收集范围', () => {
  it('递归收集 --cwd--/<id>/ 下固定名 session.jsonl 与 session.jsonl.zstd，排除其他命名；目录缺失返回空数组', async () => {
    const root = path.join(tmpDir, 'sessions')
    const encodedDir = path.join(root, '--home-alice-demo--')
    const idDirA = path.join(encodedDir, 'abc12345')
    const idDirB = path.join(encodedDir, 'def67890')
    fs.mkdirSync(idDirA, { recursive: true })
    fs.mkdirSync(idDirB, { recursive: true })

    writeJsonl(path.join(idDirA, 'session.jsonl'), [headerLine()])
    fs.writeFileSync(path.join(idDirB, 'session.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
    writeJsonl(path.join(idDirA, 'other.jsonl'), ['x'])
    writeJsonl(path.join(idDirA, 'meta.json'), ['x'])
    writeJsonl(path.join(idDirA, 'session.jsonl.tmp'), ['x'])
    writeJsonl(path.join(idDirA, '.session.jsonl'), ['x'])
    writeJsonl(path.join(idDirA, 'session.jsonl~'), ['x'])
    writeJsonl(path.join(idDirA, 'sessions.db'), ['x'])

    const entries = await listFilesFromRoot(root)
    expect(entries.map((e) => path.basename(e.path)).sort()).toEqual(['session.jsonl', 'session.jsonl.zstd'])
    for (const e of entries) {
      expect(e.mtime).toBeGreaterThan(0)
    }

    expect(await listFilesFromRoot(path.join(tmpDir, 'missing'))).toEqual([])
  })
})

describe('parseFile 增量解析（raw JSONL）', () => {
  it('端到端（矩阵 a）：request/header 提供模型，仅 assistant/message+usage 产出，sessionId/project/四桶/semantics=2/requestId 全部正确', async () => {
    const file = path.join(tmpDir, 'session.jsonl')
    writeJsonl(file, [
      headerLine(),
      userMessageLine(1),
      requestHeaderLine({ seq: 2 }),
      assistantMessageLine({ seq: 3, time: DSH_TS + 2000 }),
      toolResultLine(4),
      requestHeaderLine({ seq: 5 }),
      assistantChunkLine(6)
    ])

    const res = await dshPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.eof).toBe(true)

    const r = res.records[0]
    expect(r).toMatchObject({
      appType: 'dsh',
      model: 'deepseek-v4-flash',
      rawModel: 'deepseek-v4-flash',
      inputTokens: 120,
      outputTokens: 60,
      cacheReadTokens: 800,
      cacheCreationTokens: 30,
      inputSemantics: 2,
      status: 'success',
      sessionId: SESSION_ID,
      project: CWD,
      createdAt: DSH_TS + 2000
    })
    expect(r.source).toEqual({ filePath: file, line: 4, requestId: `${SESSION_ID}:3` })
    expect(res.nextLine).toBe(8)
  })

  it('游标增量：fromLine 续读只产出新增 assistant/message 条目；窗口内请求头可恢复 currentModel', async () => {
    const file = path.join(tmpDir, 'session-append.jsonl')
    writeJsonl(file, [
      headerLine(),
      requestHeaderLine({ seq: 1 }),
      assistantMessageLine({ seq: 2 })
    ])

    const first = await dshPlugin.parseFile(ctx, file, 0)
    expect(first.records.map((r) => r.source.requestId)).toEqual([`${SESSION_ID}:2`])
    expect(first.nextLine).toBe(4)

    fs.appendFileSync(
      file,
      '\n' +
        [requestHeaderLine({ seq: 3 }), assistantMessageLine({ seq: 4, time: DSH_TS + 9000 })].join(
          '\n'
        ),
      'utf8'
    )

    const second = await dshPlugin.parseFile(ctx, file, first.nextLine)
    expect(second.records).toHaveLength(1)
    expect(second.records[0].sessionId).toBe(SESSION_ID)
    expect(second.records[0].project).toBe(CWD)
    expect(second.records[0].source.requestId).toBe(`${SESSION_ID}:4`)
    expect(second.records[0].model).toBe('deepseek-v4-flash')
    expect(second.records[0].source.line).toBe(5)
    expect(second.records[0]).toMatchObject({ inputTokens: 120, outputTokens: 60, inputSemantics: 2 })
    expect(second.nextLine).toBe(6)
    expect(second.eof).toBe(true)
  })

  it('尾部半行：游标停驻该行且 eof=true，写入补全后重试产出完整记录', async () => {
    const file = path.join(tmpDir, 'session-half-line.jsonl')
    const halfLine =
      '{"type":"assistant/message","seq":9,"data":{"message":{"role":"assistant","model":"deepseek-chat"'
    writeJsonl(file, [
      headerLine(),
      requestHeaderLine({ seq: 1 }),
      assistantMessageLine({ seq: 2 }),
      halfLine
    ])

    const first = await dshPlugin.parseFile(ctx, file, 0)
    expect(first.records.map((r) => r.source.requestId)).toEqual([`${SESSION_ID}:2`])
    expect(first.nextLine).toBe(4)
    expect(first.eof).toBe(true)

    writeJsonl(file, [
      headerLine(),
      requestHeaderLine({ seq: 1 }),
      assistantMessageLine({ seq: 2 }),
      assistantMessageLine({ seq: 9, time: DSH_TS + 6000, messageModel: 'deepseek-chat' })
    ])
    const retry = await dshPlugin.parseFile(ctx, file, first.nextLine)
    expect(retry.records).toHaveLength(1)
    expect(retry.records[0].source.requestId).toBe(`${SESSION_ID}:9`)
    expect(retry.records[0].sessionId).toBe(SESSION_ID)
    expect(retry.records[0].model).toBe('deepseek-chat')
    expect(retry.records[0].source.line).toBe(4)
    expect(retry.nextLine).toBe(5)
  })

  it('中间损坏行宽松跳过，后续 assistant/message 条目不受阻塞', async () => {
    const file = path.join(tmpDir, 'session-corrupt-middle.jsonl')
    writeJsonl(file, [
      headerLine(),
      '{broken json',
      requestHeaderLine({ seq: 1 }),
      assistantMessageLine({ seq: 2 }),
      assistantMessageLine({ seq: 3 })
    ])

    const res = await dshPlugin.parseFile(ctx, file, 0)
    expect(res.records.map((r) => r.source.requestId)).toEqual([`${SESSION_ID}:2`, `${SESSION_ID}:3`])
    expect(res.records[0].source.line).toBe(4)
    expect(res.records[1].source.line).toBe(5)
    expect(res.nextLine).toBe(6)
    expect(res.eof).toBe(true)
  })

  it('usage 缺失 / role 异值的 assistant/message 与 user 条目跳过但水位推进', async () => {
    const file = path.join(tmpDir, 'session-skips.jsonl')
    writeJsonl(file, [
      headerLine(),
      assistantMessageLine({ seq: 1, usage: null }),
      assistantMessageLine({ seq: 2, role: 'user' }),
      userMessageLine(3),
      requestHeaderLine({ seq: 4 }),
      assistantMessageLine({ seq: 5 })
    ])

    const res = await dshPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source).toEqual({
      filePath: file,
      line: 6,
      requestId: `${SESSION_ID}:5`
    })
    expect(res.nextLine).toBe(7)
    expect(res.eof).toBe(true)
  })

  it('time 缺失或无效时 createdAt 兜底当前时间；sessionId 缺失时不设 requestId', async () => {
    const file = path.join(tmpDir, 'session-no-header.jsonl')
    writeJsonl(file, [
      requestHeaderLine({ seq: 6 }),
      assistantMessageLine({ seq: 7, time: null }),
      assistantMessageLine({ seq: 8, time: 0 })
    ])

    const res = await dshPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records[0].sessionId).toBeUndefined()
    expect(res.records[0].project).toBeUndefined()
    expect(res.records[0].source.requestId).toBeUndefined()
    expect(Math.abs(res.records[1].createdAt - Date.now())).toBeLessThan(60_000)
  })
})

describe('parseFile 模型三级来源（source.model → message.model → request/header 状态机）', () => {
  it('矩阵 b：message.source.model 优先于顶层 model 与请求头携带的模型', async () => {
    const file = path.join(tmpDir, 'session-own-model.jsonl')
    writeJsonl(file, [
      headerLine(),
      requestHeaderLine({ seq: 1 }),
      assistantMessageLine({ seq: 2, sourceModel: 'glm-5', messageModel: 'kimi-3' }),
      assistantMessageLine({ seq: 3, messageModel: 'minimax-m2' }),
      assistantMessageLine({ seq: 4 }),
      requestHeaderLine({ seq: 5, model: 'deepseek-reasoner' }),
      assistantMessageLine({ seq: 6 })
    ])

    const res = await dshPlugin.parseFile(ctx, file, 0)
    expect(res.records.map((r) => r.model)).toEqual([
      'glm-5',
      'minimax-m2',
      'deepseek-v4-flash',
      'deepseek-reasoner'
    ])
    expect(res.records.map((r) => r.rawModel)).toEqual([
      'glm-5',
      'minimax-m2',
      'deepseek-v4-flash',
      'deepseek-reasoner'
    ])
    expect(res.records.map((r) => r.source.line)).toEqual([3, 4, 5, 7])
    expect(res.nextLine).toBe(8)
    expect(res.eof).toBe(true)
  })

  it('核心回归：增量续读窗口无任何 session/request/header 行时由缓存恢复状态，用量不再漏采', async () => {
    const file = path.join(tmpDir, 'session-resume-cache.jsonl')
    writeJsonl(file, [
      headerLine(),
      requestHeaderLine({ seq: 1, model: 'deepseek-reasoner' }),
      userMessageLine(2),
      assistantMessageLine({ seq: 3, time: DSH_TS + 3000 })
    ])

    const first = await dshPlugin.parseFile(ctx, file, 0)
    expect(first.records.map((r) => r.model)).toEqual(['deepseek-reasoner'])
    expect(first.nextLine).toBe(5)

    fs.appendFileSync(
      file,
      '\n' +
        [userMessageLine(4), assistantMessageLine({ seq: 5, time: DSH_TS + 8000 })].join('\n'),
      'utf8'
    )

    const second = await dshPlugin.parseFile(ctx, file, first.nextLine)
    expect(second.records).toHaveLength(1)
    expect(second.records[0]).toMatchObject({
      model: 'deepseek-reasoner',
      sessionId: SESSION_ID,
      project: CWD,
      inputTokens: 120,
      outputTokens: 60,
      inputSemantics: 2
    })
    expect(second.records[0].source.requestId).toBe(`${SESSION_ID}:5`)
    expect(second.records[0].source.line).toBe(6)
    expect(second.nextLine).toBe(7)
    expect(second.eof).toBe(true)
  })

  it('缓存 cursorLine 与传入 fromLine 不一致时不用缓存，状态缺失条目按现状跳过', async () => {
    const file = path.join(tmpDir, 'session-cursor-drift.jsonl')
    writeJsonl(file, [
      headerLine(),
      requestHeaderLine({ seq: 1 }),
      assistantMessageLine({ seq: 2 })
    ])
    const first = await dshPlugin.parseFile(ctx, file, 0)
    expect(first.nextLine).toBe(4)

    const resumed = await dshPlugin.parseFile(ctx, file, 3)
    expect(resumed.records).toEqual([])
    expect(resumed.nextLine).toBe(4)
    expect(resumed.eof).toBe(true)
  })

  it('矩阵 c：条目前无任何 request/header 时跳过；缓存未衔接的续读同样跳过但水位照常推进', async () => {
    const file = path.join(tmpDir, 'session-no-request-header.jsonl')
    writeJsonl(file, [
      headerLine(),
      assistantMessageLine({ seq: 1 }),
      requestHeaderLine({ seq: 2 }),
      assistantMessageLine({ seq: 3 })
    ])

    const res = await dshPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].model).toBe('deepseek-v4-flash')
    expect(res.records[0].source.line).toBe(4)
    expect(res.nextLine).toBe(5)
    expect(res.eof).toBe(true)

    const resumed = await dshPlugin.parseFile(ctx, file, 4)
    expect(resumed.records).toEqual([])
    expect(resumed.nextLine).toBe(5)
    expect(resumed.eof).toBe(true)
  })

  it('矩阵 d：连续两个 request/header 切换模型，其后条目分别取新值且持续生效', async () => {
    const file = path.join(tmpDir, 'session-model-switch.jsonl')
    writeJsonl(file, [
      headerLine(),
      requestHeaderLine({ seq: 1, model: 'deepseek-v4-flash' }),
      assistantMessageLine({ seq: 2 }),
      requestHeaderLine({ seq: 3, model: 'deepseek-reasoner' }),
      assistantMessageLine({ seq: 4 }),
      assistantMessageLine({ seq: 5 })
    ])

    const res = await dshPlugin.parseFile(ctx, file, 0)
    expect(res.records.map((r) => r.model)).toEqual([
      'deepseek-v4-flash',
      'deepseek-reasoner',
      'deepseek-reasoner'
    ])
    expect(res.records.map((r) => r.source.line)).toEqual([3, 5, 6])
    expect(res.nextLine).toBe(7)
    expect(res.eof).toBe(true)
  })
})

describe('parseFile llm/retry 失败可观测（T01 矩阵 dsh 分支）', () => {
  it('矩阵 dsh: llm/retry.failure => error：status=error，tokens 全 0，errorMessage 为 [code] message 截断500，无 httpStatus，model 取 failure.model 或缓存', async () => {
    const file = path.join(tmpDir, 'session-retry-failure.jsonl')
    writeJsonl(file, [
      headerLine(),
      requestHeaderLine({ seq: 1, model: 'deepseek-chat' }),
      assistantMessageLine({ seq: 2, time: DSH_TS + 2000 }),
      llmRetryFailureLine({ seq: 3, time: DSH_TS + 3000, code: 'RATE_LIMIT', message: 'Too many requests', model: 'deepseek-reasoner' }),
      llmRetryFailureLine({ seq: 4, time: DSH_TS + 4000, code: 'TIMEOUT', message: 'timeout' }),
      llmRetryFailureLine({ seq: 5, time: DSH_TS + 5000, code: 429, message: 'numeric code' })
    ])

    const res = await dshPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(4)
    expect(res.records[0]).toMatchObject({ status: 'success', model: 'deepseek-chat' })
    expect(res.records[0].source.line).toBe(3)
    const err1 = res.records[1]
    expect(err1).toMatchObject({
      appType: 'dsh',
      model: 'deepseek-reasoner',
      rawModel: 'deepseek-reasoner',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      inputSemantics: 2,
      status: 'error',
      errorMessage: '[RATE_LIMIT] Too many requests',
      sessionId: SESSION_ID,
      project: CWD,
      createdAt: DSH_TS + 3000
    })
    expect(err1.httpStatus).toBeUndefined()
    expect(err1.source).toEqual({ filePath: file, line: 4, requestId: `${SESSION_ID}:3` })

    const err2 = res.records[2]
    expect(err2.model).toBe('deepseek-chat')
    expect(err2.errorMessage).toBe('[TIMEOUT] timeout')
    expect(err2.source.requestId).toBe(`${SESSION_ID}:4`)
    expect(err2.httpStatus).toBeUndefined()

    const err3 = res.records[3]
    expect(err3.errorMessage).toBe('[429] numeric code')

    expect(res.nextLine).toBe(7)
    expect(res.eof).toBe(true)
  })

  it('llm/retry-started 与无 failure 的 llm/retry 行应忽略，不产出记录但游标推进', async () => {
    const file = path.join(tmpDir, 'session-retry-ignore.jsonl')
    writeJsonl(file, [
      headerLine(),
      requestHeaderLine({ seq: 1 }),
      llmRetryStartedLine(2),
      llmRetryNoFailureLine(3),
      assistantMessageLine({ seq: 4 }),
      llmRetryFailureLine({ seq: 5, code: 'ERR', message: 'fail' })
    ])

    const res = await dshPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records[0].status).toBe('success')
    expect(res.records[0].source.line).toBe(5)
    expect(res.records[1].status).toBe('error')
    expect(res.records[1].source.line).toBe(6)
    expect(res.records[1].errorMessage).toBe('[ERR] fail')
    expect(res.nextLine).toBe(7)
  })

  it('errorMessage 截断500：超长 [code] message 仅保留前500字符', async () => {
    const file = path.join(tmpDir, 'session-retry-truncate.jsonl')
    const longMsg = 'a'.repeat(600)
    writeJsonl(file, [
      headerLine(),
      requestHeaderLine({ seq: 1 }),
      llmRetryFailureLine({ seq: 2, code: 'LONG', message: longMsg })
    ])

    const res = await dshPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].status).toBe('error')
    expect(res.records[0].errorMessage!.length).toBe(500)
    expect(res.records[0].errorMessage).toBe(`[LONG] ${longMsg}`.slice(0, 500))
    expect(res.records[0].inputSemantics).toBe(2)
  })

  it('model 回落链：failure.model 优先于 data.model 与缓存；三者皆无时回落 unknown', async () => {
    const file = path.join(tmpDir, 'session-retry-model-fallback.jsonl')
    writeJsonl(file, [
      headerLine(),
      llmRetryFailureLine({ seq: 1, code: 'E1', message: 'm1', model: 'failure-model' }),
      llmRetryFailureLine({ seq: 2, code: 'E2', message: 'm2', failure: { code: 'E2', message: 'm2' }, dataModel: 'data-model' }),
      llmRetryFailureLine({ seq: 3, code: 'E3', message: 'm3' })
    ])

    const res = await dshPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(3)
    expect(res.records[0].model).toBe('failure-model')
    expect(res.records[1].model).toBe('data-model')
    expect(res.records[2].model).toBe('unknown')
    for (const r of res.records) {
      expect(r.status).toBe('error')
      expect(r.inputTokens).toBe(0)
      expect(r.outputTokens).toBe(0)
      expect(r.httpStatus).toBeUndefined()
    }
  })

  it('仅 code 或仅 message 时 errorMessage 宽松拼接；两者皆无时回落 JSON 兜底', async () => {
    const file = path.join(tmpDir, 'session-retry-partial.jsonl')
    writeJsonl(file, [
      headerLine(),
      requestHeaderLine({ seq: 1 }),
      llmRetryFailureLine({ seq: 2, code: 'ONLY_CODE' }),
      llmRetryFailureLine({ seq: 3, message: 'only message' }),
      llmRetryFailureLine({ seq: 4, failure: { reason: 'weird' } })
    ])

    const res = await dshPlugin.parseFile(ctx, file, 0)
    expect(res.records.map((r) => r.errorMessage)).toEqual(['[ONLY_CODE]', 'only message', JSON.stringify({ reason: 'weird' }).slice(0, 500)])
  })

  it('增量续读与 zstd 帧内均能捕获 llm/retry 失败，且保持 assistant/message 成功路径不变', async () => {
    const file = path.join(tmpDir, 'session-retry-incremental.jsonl')
    writeJsonl(file, [
      headerLine(),
      requestHeaderLine({ seq: 1 }),
      assistantMessageLine({ seq: 2 }),
      llmRetryFailureLine({ seq: 3, code: 'ERR', message: 'first' })
    ])

    const first = await dshPlugin.parseFile(ctx, file, 0)
    expect(first.records).toHaveLength(2)
    expect(first.records.map((r) => r.status)).toEqual(['success', 'error'])
    expect(first.nextLine).toBe(5)

    fs.appendFileSync(file, '\n' + llmRetryFailureLine({ seq: 4, code: 'ERR2', message: 'second' }), 'utf8')
    const second = await dshPlugin.parseFile(ctx, file, first.nextLine)
    expect(second.records).toHaveLength(1)
    expect(second.records[0].status).toBe('error')
    expect(second.records[0].errorMessage).toBe('[ERR2] second')
    expect(second.records[0].sessionId).toBe(SESSION_ID)
    expect(second.records[0].source.line).toBe(5)
    expect(second.records[0].source.requestId).toBe(`${SESSION_ID}:4`)

    const zfile = path.join(tmpDir, 'session-retry-zstd.jsonl.zstd')
    const [chunk] = makeZstdChunks([
      [headerLine(), requestHeaderLine({ seq: 1 }), llmRetryFailureLine({ seq: 2, code: 'ZERR', message: 'zstd fail' })]
    ])
    fs.writeFileSync(zfile, chunk)
    const { ctx: zctx, cursorWrites } = makeCtxWithStorage()
    const zres = await dshPlugin.parseFile(zctx, zfile, 0)
    expect(zres.records).toHaveLength(1)
    expect(zres.records[0].status).toBe('error')
    expect(zres.records[0].errorMessage).toBe('[ZERR] zstd fail')
    expect(cursorWrites[0].byteOffset).toBe(chunk.length)
  })
})

describe('parseFile zstd 工件容错', () => {
  it('损坏 zstd 数据（非 zstd 帧字节）→ 空结果且游标不推进 eof=true', async () => {
    const file = path.join(tmpDir, 'session.jsonl.zstd')
    fs.writeFileSync(file, Buffer.from([0x00, 0xff, 0x37, 0xc0, 0x99, 0x11]))

    const res = await dshPlugin.parseFile(ctx, file, 42)
    expect(res).toEqual({ records: [], nextLine: 42, eof: true })
  })

  it('.jsonl.zstd 扩展名单独走 decompress 路径：合法 JSONL 文本按 zstd 解压必失败 → 空结果', async () => {
    const file = path.join(tmpDir, 'session.jsonl.zstd')
    writeJsonl(file, [headerLine(), assistantMessageLine({ seq: 2 })])

    const res = await dshPlugin.parseFile(ctx, file, 0)
    expect(res).toEqual({ records: [], nextLine: 0, eof: true })
  })
})

const ZSTD_FRAME_MAGIC = 0xfd2fb528

function makeZstdFrame(payload: Buffer): Buffer {
  if (payload.length >= 65_280) throw new Error('测试帧明文超出双字节 FCS 编码上限')
  const wideFcs = payload.length >= 256
  const fcsBytes = wideFcs ? 2 : 1
  const blockHeaderOffset = 5 + fcsBytes
  const frame = Buffer.alloc(blockHeaderOffset + 3 + payload.length)
  frame.writeUInt32LE(ZSTD_FRAME_MAGIC, 0)
  frame[4] = wideFcs ? 0x60 : 0x20
  if (wideFcs) frame.writeUIntLE(payload.length - 256, 5, 2)
  else frame[5] = payload.length
  frame.writeUIntLE((payload.length << 3) | 1, blockHeaderOffset, 3)
  payload.copy(frame, blockHeaderOffset + 3)
  return frame
}

function makeZstdChunks(groups: string[][]): Buffer[] {
  return groups.map((lines) => makeZstdFrame(Buffer.from(lines.join('\n') + '\n', 'utf8')))
}

describe('parseFile zstd 帧级增量解压', () => {
  it('多帧首读：整流逐帧解压全部完整帧，游标写回安全消费的压缩字节偏移', async () => {
    const file = path.join(tmpDir, 'session-first-read.jsonl.zstd')
    const [chunkA, chunkB] = makeZstdChunks([
      [headerLine(), requestHeaderLine({ seq: 1 }), assistantMessageLine({ seq: 2 })],
      [assistantMessageLine({ seq: 3 })]
    ])
    fs.writeFileSync(file, Buffer.concat([chunkA, chunkB]))

    const { ctx: ctxWithStorage, cursorWrites } = makeCtxWithStorage()
    const res = await dshPlugin.parseFile(ctxWithStorage, file, 0)

    expect(res.records.map((r) => r.source.requestId)).toEqual([`${SESSION_ID}:2`, `${SESSION_ID}:3`])
    expect(res.records.map((r) => r.source.line)).toEqual([3, 4])
    expect(res.nextLine).toBe(6)
    expect(res.eof).toBe(true)
    expect(cursorWrites).toEqual([
      { filePath: file, line: 6, mtime: undefined, byteOffset: chunkA.length + chunkB.length }
    ])
  })

  it('多帧追加：二次解析仅从游标偏移消费尾部新帧，最终记录集与整块解压一致', async () => {
    const file = path.join(tmpDir, 'session-append-frames.jsonl.zstd')
    const [chunkA] = makeZstdChunks([
      [headerLine(), requestHeaderLine({ seq: 1 }), assistantMessageLine({ seq: 2 })]
    ])
    fs.writeFileSync(file, chunkA)

    const first = await dshPlugin.parseFile(ctx, file, 0)
    expect(first.records.map((r) => r.source.requestId)).toEqual([`${SESSION_ID}:2`])
    expect(first.nextLine).toBe(5)

    const [chunkB] = makeZstdChunks([[assistantMessageLine({ seq: 3 })]])
    fs.appendFileSync(file, chunkB)

    const { ctx: ctxWithStorage, cursorWrites } = makeCtxWithStorage({
      lineOffset: first.nextLine,
      fileMtime: 12345,
      byteOffset: chunkA.length
    })
    const second = await dshPlugin.parseFile(ctxWithStorage, file, first.nextLine)

    expect(second.records).toHaveLength(1)
    expect(second.records[0]).toMatchObject({
      source: { filePath: file, line: 5, requestId: `${SESSION_ID}:3` },
      model: 'deepseek-v4-flash',
      sessionId: SESSION_ID,
      project: CWD,
      inputSemantics: 2
    })
    expect(second.nextLine).toBe(7)
    expect(cursorWrites).toEqual([
      { filePath: file, line: 7, mtime: undefined, byteOffset: chunkA.length + chunkB.length }
    ])

    const whole = await dshPlugin.parseFile(ctx, file, 0)
    expect(whole.records.map((r) => r.source.requestId).sort()).toEqual(
      [...first.records, ...second.records].map((r) => r.source.requestId).sort()
    )
  })

  it('byte_offset 为 NULL 的旧行：回退整块解压按行游标跳过已消费部分并回填偏移', async () => {
    const file = path.join(tmpDir, 'session-legacy-null-offset.jsonl.zstd')
    const [chunkA, chunkB] = makeZstdChunks([
      [headerLine(), requestHeaderLine({ seq: 1 }), assistantMessageLine({ seq: 2 })],
      [assistantMessageLine({ seq: 3, sourceModel: 'glm-5' })]
    ])
    fs.writeFileSync(file, Buffer.concat([chunkA, chunkB]))
    const totalLength = chunkA.length + chunkB.length

    const { ctx: ctxWithStorage, cursorWrites } = makeCtxWithStorage({
      lineOffset: 4,
      fileMtime: 1,
      byteOffset: null
    })
    const res = await dshPlugin.parseFile(ctxWithStorage, file, 4)

    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.line).toBe(4)
    expect(res.records[0].model).toBe('glm-5')
    expect(res.nextLine).toBe(6)
    expect(cursorWrites).toEqual([{ filePath: file, line: 6, mtime: undefined, byteOffset: totalLength }])
  })

  it('非法偏移（非帧边界）：回退整块解压自愈并回填正确偏移', async () => {
    const file = path.join(tmpDir, 'session-dirty-offset.jsonl.zstd')
    const [chunkA, chunkB] = makeZstdChunks([
      [headerLine(), requestHeaderLine({ seq: 1 }), assistantMessageLine({ seq: 2 })],
      [assistantMessageLine({ seq: 3, sourceModel: 'glm-5' })]
    ])
    fs.writeFileSync(file, Buffer.concat([chunkA, chunkB]))

    for (const dirtyOffset of [2, chunkA.length - 3, chunkA.length + chunkB.length + 999]) {
      const { ctx: ctxWithStorage, cursorWrites } = makeCtxWithStorage({
        lineOffset: 4,
        fileMtime: 1,
        byteOffset: dirtyOffset
      })
      const res = await dshPlugin.parseFile(ctxWithStorage, file, 4)
      expect(res.records.map((r) => r.source.line)).toEqual([4])
      expect(cursorWrites[0]?.byteOffset).toBe(chunkA.length + chunkB.length)
    }
  })

  it('EOF 半帧容错：byteOffset 只推进到最后完整帧末尾，补全后续读产出剩余记录', async () => {
    const file = path.join(tmpDir, 'session-half-frame.jsonl.zstd')
    const [chunkA] = makeZstdChunks([
      [headerLine(), requestHeaderLine({ seq: 1 }), assistantMessageLine({ seq: 2 })]
    ])
    const [fullChunkB] = makeZstdChunks([[assistantMessageLine({ seq: 3, sourceModel: 'glm-5' })]])
    const truncatedChunkB = fullChunkB.subarray(0, fullChunkB.length - 4)
    fs.writeFileSync(file, Buffer.concat([chunkA, truncatedChunkB]))

    const first = await dshPlugin.parseFile(ctx, file, 0)
    expect(first.records.map((r) => r.source.requestId)).toEqual([`${SESSION_ID}:2`])
    expect(first.nextLine).toBe(5)
    expect(first.eof).toBe(true)

    fs.appendFileSync(file, fullChunkB.subarray(truncatedChunkB.length))
    const { ctx: ctxWithStorage, cursorWrites } = makeCtxWithStorage({
      lineOffset: first.nextLine,
      fileMtime: 6789,
      byteOffset: chunkA.length
    })
    const second = await dshPlugin.parseFile(ctxWithStorage, file, first.nextLine)

    expect(second.records).toHaveLength(1)
    expect(second.records[0].source.line).toBe(5)
    expect(second.records[0].source.requestId).toBe(`${SESSION_ID}:3`)
    expect(second.records[0].model).toBe('glm-5')
    expect(second.nextLine).toBe(7)
    expect(cursorWrites[0]?.byteOffset).toBe(chunkA.length + fullChunkB.length)

    const whole = await dshPlugin.parseFile(ctx, file, 0)
    expect(whole.records).toHaveLength(2)
    expect(whole.records.map((r) => r.model)).toEqual(['deepseek-v4-flash', 'glm-5'])
  })

  it('帧明文含伪 magic：多帧整流一次解压不被内容中的 zstd magic 干扰，全部记录产出且 byteOffset 写回文件总长', async () => {
    const file = path.join(tmpDir, 'session-fake-magic.jsonl.zstd')
    const fakeMagic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
    const chunkA = makeZstdChunks([
      [headerLine(), requestHeaderLine({ seq: 1 }), assistantMessageLine({ seq: 2 })]
    ])[0]
    const chunkB = makeZstdFrame(
      Buffer.concat([
        Buffer.from(`${assistantMessageLine({ seq: 3 })}\n`, 'utf8'),
        fakeMagic,
        Buffer.from(`\n${assistantMessageLine({ seq: 4 })}`, 'utf8')
      ])
    )
    fs.writeFileSync(file, Buffer.concat([chunkA, chunkB]))

    const { ctx: ctxWithStorage, cursorWrites } = makeCtxWithStorage()
    const res = await dshPlugin.parseFile(ctxWithStorage, file, 0)

    expect(res.records.map((r) => r.source.requestId)).toEqual([
      `${SESSION_ID}:2`,
      `${SESSION_ID}:3`,
      `${SESSION_ID}:4`
    ])
    expect(res.records.map((r) => r.source.line)).toEqual([3, 4, 6])
    expect(res.nextLine).toBe(7)
    expect(res.eof).toBe(true)
    expect(cursorWrites).toEqual([
      { filePath: file, line: 7, mtime: undefined, byteOffset: chunkA.length + chunkB.length }
    ])
  })

  it('前一帧明文含伪 magic：追加新帧后从帧边界增量续读，记录与游标推进均不受干扰', async () => {
    const file = path.join(tmpDir, 'session-fake-magic-append.jsonl.zstd')
    const fakeMagic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
    const chunkA = makeZstdFrame(
      Buffer.concat([
        Buffer.from(
          [headerLine(), requestHeaderLine({ seq: 1 }), assistantMessageLine({ seq: 2 })].join('\n') +
            '\n',
          'utf8'
        ),
        fakeMagic,
        Buffer.from(`\n${assistantMessageLine({ seq: 3 })}`, 'utf8')
      ])
    )
    fs.writeFileSync(file, chunkA)

    const first = await dshPlugin.parseFile(ctx, file, 0)
    expect(first.records.map((r) => r.source.requestId)).toEqual([`${SESSION_ID}:2`, `${SESSION_ID}:3`])
    expect(first.records.map((r) => r.source.line)).toEqual([3, 5])
    expect(first.nextLine).toBe(6)
    expect(first.eof).toBe(true)

    const [chunkB] = makeZstdChunks([[assistantMessageLine({ seq: 4 })]])
    fs.appendFileSync(file, chunkB)

    const { ctx: ctxWithStorage, cursorWrites } = makeCtxWithStorage({
      lineOffset: first.nextLine,
      fileMtime: 4321,
      byteOffset: chunkA.length
    })
    const second = await dshPlugin.parseFile(ctxWithStorage, file, first.nextLine)

    expect(second.records).toHaveLength(1)
    expect(second.records[0]).toMatchObject({
      source: { filePath: file, line: 6, requestId: `${SESSION_ID}:4` },
      model: 'deepseek-v4-flash',
      sessionId: SESSION_ID,
      project: CWD,
      inputSemantics: 2
    })
    expect(second.nextLine).toBe(8)
    expect(second.eof).toBe(true)
    expect(cursorWrites).toEqual([
      { filePath: file, line: 8, mtime: undefined, byteOffset: chunkA.length + chunkB.length }
    ])
  })

  it('增量空文本：游标偏移处仅有完整空载荷帧+尾部半帧时，byteOffset 推进而行号保持不虚进', async () => {
    const file = path.join(tmpDir, 'session-empty-frame.jsonl.zstd')
    const [chunkA] = makeZstdChunks([
      [headerLine(), requestHeaderLine({ seq: 1 }), assistantMessageLine({ seq: 2 })]
    ])
    const emptyFrame = makeZstdFrame(Buffer.alloc(0))
    const [fullChunkB] = makeZstdChunks([[assistantMessageLine({ seq: 3, sourceModel: 'glm-5' })]])
    const truncatedChunkB = fullChunkB.subarray(0, fullChunkB.length - 4)
    fs.writeFileSync(file, Buffer.concat([chunkA, emptyFrame, truncatedChunkB]))

    const first = await dshPlugin.parseFile(ctx, file, 0)
    expect(first.records.map((r) => r.source.requestId)).toEqual([`${SESSION_ID}:2`])
    expect(first.nextLine).toBe(5)
    expect(first.eof).toBe(true)

    const { ctx: ctxWithStorage, cursorWrites } = makeCtxWithStorage({
      lineOffset: first.nextLine,
      fileMtime: 99,
      byteOffset: chunkA.length
    })
    const second = await dshPlugin.parseFile(ctxWithStorage, file, first.nextLine)

    expect(second).toEqual({ records: [], nextLine: 5, eof: true })
    expect(cursorWrites).toEqual([
      { filePath: file, line: 5, mtime: undefined, byteOffset: chunkA.length + emptyFrame.length }
    ])
  })

  it('中途坏帧（其后仍有 magic）：整块回退仍失败时空结果且不写游标', async () => {
    const file = path.join(tmpDir, 'session-broken-middle.jsonl.zstd')
    const garbageFrame = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x68, 0x10, 0x40, 0x24, 0xde, 0xad])
    const [chunkB] = makeZstdChunks([[assistantMessageLine({ seq: 3, sourceModel: 'glm-5' })]])
    fs.writeFileSync(file, Buffer.concat([garbageFrame, chunkB]))

    const { ctx: ctxWithStorage, cursorWrites } = makeCtxWithStorage()
    const res = await dshPlugin.parseFile(ctxWithStorage, file, 0)

    expect(res).toEqual({ records: [], nextLine: 0, eof: true })
    expect(cursorWrites).toEqual([])
  })

  it('裸 JSONL 工件无字节游标概念，解析成功也不写字节偏移', async () => {
    const file = path.join(tmpDir, 'session-no-byte-cursor.jsonl')
    writeJsonl(file, [headerLine(), assistantMessageLine({ seq: 2, sourceModel: 'deepseek-v4-flash' })])

    const { ctx: ctxWithStorage, cursorWrites } = makeCtxWithStorage()
    const res = await dshPlugin.parseFile(ctxWithStorage, file, 0)

    expect(res.records).toHaveLength(1)
    expect(cursorWrites).toEqual([])
  })
})
