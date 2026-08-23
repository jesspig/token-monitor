import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { dshPlugin, dataRootOf, detectFromRoot, listFilesFromRoot } from './dsh'
import type { PluginContext } from '../../../shared/context'

/** parseFile 不使用 ctx 上的服务，测试时给个空壳即可 */
const ctx = {} as PluginContext

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

/** request/header 行（每步 dispatch 前写入，data.header.config 携带该步模型；seq/time/model 可覆盖） */
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
 * provider 为上游供应方标注，本插件丢弃）。message 默认不带 model（真实形态：120 文件 /
 * 6084 条实测均无自带 model，模型由 request/header 携带），传入 messageModel 时才写
 * message.model 用于测「自带优先」路径。role/time/usage 可覆盖。
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
    // 续读窗口越过首行 header，会话状态缺失 → sessionId/requestId 不设置（与 pi 同语义）
    expect(second.records[0].sessionId).toBeUndefined()
    expect(second.records[0].source.requestId).toBeUndefined()
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

    // 写入器补全该行后，从停驻行重试；自带 model 以越过窗口外请求头缺失的 currentModel
    writeJsonl(file, [
      headerLine(), // 1
      requestHeaderLine({ seq: 1 }), // 2
      assistantMessageLine({ seq: 2 }), // 3
      assistantMessageLine({ seq: 9, time: DSH_TS + 6000, messageModel: 'deepseek-chat' }) // 4
    ])
    const retry = await dshPlugin.parseFile(ctx, file, first.nextLine)
    // 续读窗口越过 session header 与 request/header → sessionId/currentModel 均缺失,
    // requestId 不设置由 (file,line) 主键去重兜底不双算；模型取条目自带的 message.model
    expect(retry.records).toHaveLength(1)
    expect(retry.records[0].source.requestId).toBeUndefined()
    expect(retry.records[0].sessionId).toBeUndefined()
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

describe('parseFile 模型两级来源（request/header 状态机）', () => {
  it('矩阵 b：message 自带 model 时优先于请求头携带的模型', async () => {
    const file = path.join(tmpDir, 'session-own-model.jsonl')
    writeJsonl(file, [
      headerLine(), // 1
      requestHeaderLine({ seq: 1 }), // 2: deepseek-v4-flash
      assistantMessageLine({ seq: 2, messageModel: 'glm-5' }), // 3: 自带优先
      requestHeaderLine({ seq: 3 }), // 4
      assistantMessageLine({ seq: 4 }) // 5: 回落请求头值
    ])

    const res = await dshPlugin.parseFile(ctx, file, 0)
    expect(res.records.map((r) => r.model)).toEqual(['glm-5', 'deepseek-v4-flash'])
    expect(res.records.map((r) => r.source.line)).toEqual([3, 5])
    expect(res.nextLine).toBe(6)
    expect(res.eof).toBe(true)
  })

  it('矩阵 c：条目前无任何 request/header 时跳过；续读越过请求头同样跳过但水位照常推进', async () => {
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
