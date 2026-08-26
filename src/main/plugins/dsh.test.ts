import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { dshPlugin, dataRootOf, detectFromRoot, listFilesFromRoot } from './dsh'
import type { PluginContext } from '../../../shared/context'

/** 游标元信息桩（getCursorMeta 返回值） */
type CursorMetaStub = { lineOffset: number; fileMtime: number; byteOffset?: number | null } | null

/** 带 fake storage 的 ctx：捕获 setCursor 写入，getCursorMeta 返回注入的桩值 */
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

/** parseFile 对 raw JSONL 与解析失败的 zstd 工件不触碰游标，既有用例共用空壳即可 */
const ctx = makeCtxWithStorage().ctx

const DSH_TS = 1770000000000
const SESSION_ID = 'sess-dsh-1'
const CWD = '/home/alice/demo'

/** JSONL 首行：会话 header（SESSION_FORMAT_VERSION=0，id 即 sessionId，cwd 为项目目录） */
const headerLine = (o: { id?: string; cwd?: string } = {}): string =>
  JSON.stringify({
    type: 'session',
    version: 0,
    id: o.id ?? SESSION_ID,
    cwd: o.cwd ?? CWD,
    createdAt: DSH_TS
  })

/** 非 assistant/message 的 storage record 行（envelope：type + seq + time + data） */
const userMessageLine = (seq = 1): string =>
  JSON.stringify({
    type: 'user/message',
    seq,
    time: DSH_TS + 1000,
    data: { message: { role: 'user', content: '你好' } }
  })

const toolResultLine = (seq = 4): string =>
  JSON.stringify({ type: 'tool/result', seq, time: DSH_TS + 3000, data: { toolCallId: 't-1', result: 'ok' } })

/** request/header 行（仅在路由/配置变化时稀疏写入，reason ∈ initial/resume/change；
 * data.header.config 携带该步模型；seq/time/model 可覆盖） */
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

/** packed chunk row（assistant/chunk 打包流水行，应被 type 白名单过滤天然跳过） */
const assistantChunkLine = (seq = 6): string =>
  JSON.stringify({ type: 'assistant/chunk', seq, time: DSH_TS + 5000, data: { chunks: [{ kind: 'text', text: '答' }] } })

/**
 * assistant 计费条目（TokenUsage 四桶 disjoint；reasoningTokens 为 output 子集应不加速率；
 * provider/source.provider 为上游供应方标注，本插件丢弃）。真实形态：模型由
 * data.message.source.model 携带（AssistantProvenance，473/473 实测全部携带），顶层
 * message.model 与请求头均为回退来源；传 sourceModel 写 message.source 结构测首选路径，
 * 传 messageModel 才写顶层 message.model 测次级回退路径。role/time/usage 可覆盖。
 */
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

/** 多行拼成 JSONL 文件内容（无尾随换行，行号即数组下标 +1；自动创建父目录） */
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
  it('递归收集 --cwd--/<id>/ 下固定名 session.jsonl 与 session.jsonl.zstd，排除其他命名；目录缺失返回空数组', () => {
    const root = path.join(tmpDir, 'sessions')
    const encodedDir = path.join(root, '--home-alice-demo--')
    const idDirA = path.join(encodedDir, 'abc12345')
    const idDirB = path.join(encodedDir, 'def67890')
    fs.mkdirSync(idDirA, { recursive: true })
    fs.mkdirSync(idDirB, { recursive: true })

    writeJsonl(path.join(idDirA, 'session.jsonl'), [headerLine()])
    fs.writeFileSync(path.join(idDirB, 'session.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
    // 应排除的文件：非固定名 .jsonl/.json、临时/隐藏、SQLite 后端 .db
    writeJsonl(path.join(idDirA, 'other.jsonl'), ['x'])
    writeJsonl(path.join(idDirA, 'meta.json'), ['x'])
    writeJsonl(path.join(idDirA, 'session.jsonl.tmp'), ['x'])
    writeJsonl(path.join(idDirA, '.session.jsonl'), ['x'])
    writeJsonl(path.join(idDirA, 'session.jsonl~'), ['x'])
    writeJsonl(path.join(idDirA, 'sessions.db'), ['x'])

    const entries = listFilesFromRoot(root)
    expect(entries.map((e) => path.basename(e.path)).sort()).toEqual(['session.jsonl', 'session.jsonl.zstd'])
    for (const e of entries) {
      expect(e.mtime).toBeGreaterThan(0)
    }

    // 目录缺失 → 空数组
    expect(listFilesFromRoot(path.join(tmpDir, 'missing'))).toEqual([])
  })
})

describe('parseFile 增量解析（raw JSONL）', () => {
  it('端到端（矩阵 a）：request/header 提供模型，仅 assistant/message+usage 产出，sessionId/project/四桶/semantics=2/requestId 全部正确', async () => {
    const file = path.join(tmpDir, 'session.jsonl')
    writeJsonl(file, [
      headerLine(), // 1
      userMessageLine(1), // 2
      requestHeaderLine({ seq: 2 }), // 3: currentModel 就绪
      assistantMessageLine({ seq: 3, time: DSH_TS + 2000 }), // 4
      toolResultLine(4), // 5
      requestHeaderLine({ seq: 5 }), // 6
      assistantChunkLine(6) // 7
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
    // reasoningTokens=15 为 output 子集不加速率：上方四桶精确匹配已保证未计入任一桶
    expect(r.source).toEqual({ filePath: file, line: 4, requestId: `${SESSION_ID}:3` })
    // 7 行全部处理完毕，游标指向第 8 行
    expect(res.nextLine).toBe(8)
  })

  it('游标增量：fromLine 续读只产出新增 assistant/message 条目；窗口内请求头可恢复 currentModel', async () => {
    const file = path.join(tmpDir, 'session-append.jsonl')
    writeJsonl(file, [
      headerLine(), // 1
      requestHeaderLine({ seq: 1 }), // 2
      assistantMessageLine({ seq: 2 }) // 3
    ])

    const first = await dshPlugin.parseFile(ctx, file, 0)
    expect(first.records.map((r) => r.source.requestId)).toEqual([`${SESSION_ID}:2`])
    expect(first.nextLine).toBe(4)

    // 真实写入顺序为每步 dispatch 前先写 request/header 再写 assistant/message，
    // 故追加块自带请求头，续读窗口内 currentModel 可恢复
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
    // sessionId/project 由模块级缓存恢复（上轮写回的 cursorLine 与 fromLine 精确衔接）
    expect(second.records[0].sessionId).toBe(SESSION_ID)
    expect(second.records[0].project).toBe(CWD)
    expect(second.records[0].source.requestId).toBe(`${SESSION_ID}:4`)
    // currentModel 由窗口内的请求头（第 4 行）恢复
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
      headerLine(), // 1
      requestHeaderLine({ seq: 1 }), // 2
      assistantMessageLine({ seq: 2 }), // 3
      halfLine // 4
    ])

    const first = await dshPlugin.parseFile(ctx, file, 0)
    expect(first.records.map((r) => r.source.requestId)).toEqual([`${SESSION_ID}:2`])
    expect(first.nextLine).toBe(4) // 半行为第 4 行，游标原地等待下次重试
    expect(first.eof).toBe(true)

    // 写入器补全该行后，从停驻行重试；会话头状态由上轮写回的缓存恢复
    writeJsonl(file, [
      headerLine(), // 1
      requestHeaderLine({ seq: 1 }), // 2
      assistantMessageLine({ seq: 2 }), // 3
      assistantMessageLine({ seq: 9, time: DSH_TS + 6000, messageModel: 'deepseek-chat' }) // 4
    ])
    const retry = await dshPlugin.parseFile(ctx, file, first.nextLine)
    // 续读窗口越过 session header 与 request/header，但缓存游标（4）与 fromLine 精确衔接
    // → sessionId/project/currentModel 均由缓存恢复，requestId 正常设置
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
      headerLine(), // 1
      '{broken json', // 2
      requestHeaderLine({ seq: 1 }), // 3
      assistantMessageLine({ seq: 2 }), // 4
      assistantMessageLine({ seq: 3 }) // 5
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
      headerLine(), // 1
      assistantMessageLine({ seq: 1, usage: null }), // 2: 无 usage → 跳过
      assistantMessageLine({ seq: 2, role: 'user' }), // 3: role 异值 → 跳过
      userMessageLine(3), // 4
      requestHeaderLine({ seq: 4 }), // 5
      assistantMessageLine({ seq: 5 }) // 6: 正常产出（模型取请求头）
    ])

    const res = await dshPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source).toEqual({
      filePath: file,
      line: 6,
      requestId: `${SESSION_ID}:5`
    })
    expect(res.nextLine).toBe(7) // 跳过条目同样推进水位
    expect(res.eof).toBe(true)
  })

  it('time 缺失或无效时 createdAt 兜底当前时间；sessionId 缺失时不设 requestId', async () => {
    const file = path.join(tmpDir, 'session-no-header.jsonl')
    writeJsonl(file, [
      requestHeaderLine({ seq: 6 }), // 无 session header → 仅提供 currentModel，sessionId/project 缺失
      assistantMessageLine({ seq: 7, time: null }), // 2
      assistantMessageLine({ seq: 8, time: 0 }) // 3: time 无效（<=0）→ Date.now() 兜底
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
      headerLine(), // 1
      requestHeaderLine({ seq: 1 }), // 2: deepseek-v4-flash
      assistantMessageLine({ seq: 2, sourceModel: 'glm-5', messageModel: 'kimi-3' }), // 3: source.model 最高优先
      assistantMessageLine({ seq: 3, messageModel: 'minimax-m2' }), // 4: 无 source.model 回落顶层 model
      assistantMessageLine({ seq: 4 }), // 5: 均无回落请求头值
      requestHeaderLine({ seq: 5, model: 'deepseek-reasoner' }), // 6: 切换请求头
      assistantMessageLine({ seq: 6 }) // 7: 取新请求头值
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
      headerLine(), // 1
      requestHeaderLine({ seq: 1, model: 'deepseek-reasoner' }), // 2
      userMessageLine(2), // 3
      assistantMessageLine({ seq: 3, time: DSH_TS + 3000 }) // 4
    ])

    const first = await dshPlugin.parseFile(ctx, file, 0)
    expect(first.records.map((r) => r.model)).toEqual(['deepseek-reasoner'])
    expect(first.nextLine).toBe(5)

    // 追加续读段不含任何 session/request/header 行（request/header 仅路由/配置变化时写入）
    fs.appendFileSync(
      file,
      '\n' +
        [userMessageLine(4), assistantMessageLine({ seq: 5, time: DSH_TS + 8000 })].join('\n'),
      'utf8'
    )

    const second = await dshPlugin.parseFile(ctx, file, first.nextLine)
    expect(second.records).toHaveLength(1)
    // 模型取缓存 currentModel，sessionId/project/requestId 也由缓存恢复 → 用量不漏采
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
      headerLine(), // 1
      requestHeaderLine({ seq: 1 }), // 2
      assistantMessageLine({ seq: 2 }) // 3
    ])
    const first = await dshPlugin.parseFile(ctx, file, 0)
    expect(first.nextLine).toBe(4)

    // 游标被重置到 3（如文件 truncate），与缓存 cursorLine=4 不一致 → 弃用缓存按现状重建：
    // 该条目无自带模型且会话状态缺失 → 跳过但水位照常推进
    const resumed = await dshPlugin.parseFile(ctx, file, 3)
    expect(resumed.records).toEqual([])
    expect(resumed.nextLine).toBe(4)
    expect(resumed.eof).toBe(true)
  })

  it('矩阵 c：条目前无任何 request/header 时跳过；缓存未衔接的续读同样跳过但水位照常推进', async () => {
    const file = path.join(tmpDir, 'session-no-request-header.jsonl')
    writeJsonl(file, [
      headerLine(), // 1
      assistantMessageLine({ seq: 1 }), // 2: 无自带 model 且此前无请求头 → 跳过
      requestHeaderLine({ seq: 2 }), // 3
      assistantMessageLine({ seq: 3 }) // 4: 正常产出
    ])

    const res = await dshPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].model).toBe('deepseek-v4-flash')
    expect(res.records[0].source.line).toBe(4)
    expect(res.nextLine).toBe(5) // 被跳过的第 2 行同样推进水位
    expect(res.eof).toBe(true)

    // 续读窗口越过第 3 行请求头：currentModel 缺失 → 该条目被跳过，水位仍推进
    const resumed = await dshPlugin.parseFile(ctx, file, 4)
    expect(resumed.records).toEqual([])
    expect(resumed.nextLine).toBe(5)
    expect(resumed.eof).toBe(true)
  })

  it('矩阵 d：连续两个 request/header 切换模型，其后条目分别取新值且持续生效', async () => {
    const file = path.join(tmpDir, 'session-model-switch.jsonl')
    writeJsonl(file, [
      headerLine(), // 1
      requestHeaderLine({ seq: 1, model: 'deepseek-v4-flash' }), // 2
      assistantMessageLine({ seq: 2 }), // 3 → v4-flash
      requestHeaderLine({ seq: 3, model: 'deepseek-reasoner' }), // 4: 切换
      assistantMessageLine({ seq: 4 }), // 5 → reasoner
      assistantMessageLine({ seq: 5 }) // 6 → reasoner（持续生效直到下一个请求头）
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

describe('parseFile zstd 工件容错', () => {
  it('损坏 zstd 数据（非 zstd 帧字节）→ 空结果且游标不推进 eof=true', async () => {
    const file = path.join(tmpDir, 'session.jsonl.zstd')
    // 非法帧字节（zstd magic 0xFD2FB528 之外的确定性随机数据）
    fs.writeFileSync(file, Buffer.from([0x00, 0xff, 0x37, 0xc0, 0x99, 0x11]))

    const res = await dshPlugin.parseFile(ctx, file, 42)
    expect(res).toEqual({ records: [], nextLine: 42, eof: true })
  })

  it('.jsonl.zstd 扩展名单独走 decompress 路径：合法 JSONL 文本按 zstd 解压必失败 → 空结果', async () => {
    const file = path.join(tmpDir, 'session.jsonl.zstd')
    // 内容为合法可解析 JSONL 文本；若误走纯文本路径会产出记录，
    // 断言空结果即证明扩展名路由到了解压分支并触发容错兜底
    writeJsonl(file, [headerLine(), assistantMessageLine({ seq: 2 })])

    const res = await dshPlugin.parseFile(ctx, file, 0)
    expect(res).toEqual({ records: [], nextLine: 0, eof: true })
  })
})

/**
 * 手工构造最小合法 zstd 帧（fzstd 0.1.1 仅提供 decompress 无 compress）：
 * Magic(28 B5 2F FD) + Frame_Header_Description（Single_Segment、无校验/字典）+
 * Frame_Content_Size + Raw Block 头（last=1 type=00，24-bit LE）+ 明文。
 * FCS 编码随载荷大小选择：单字节（flag=00，<256）/ 双字节偏移 256（flag=01，<65280）。
 */
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

    // 仅尾部新帧的记录；sessionId/project/currentModel 由会话头缓存衔接恢复
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

    // 最终记录集 == 整块解压（fromLine=0 全量重析参照）
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

    // 写入器补完半帧后从上轮偏移续读：半帧文本整体成为新片段首段
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
    // 伪 magic 独占的第 5 行 JSON.parse 失败，按中间损坏行宽松跳过
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
