import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { piPlugin, dataRootOf, detectFromRoot, listFilesFromRoot } from './pi'
import type { PluginContext } from '../../../shared/context'

/** parseFile 不使用 ctx 上的服务，测试时给个空壳即可 */
const ctx = {} as PluginContext

const PI_TS = 1770000000000
const SESSION_ID = 'sess-pi-1'
const CWD = '/home/alice/demo'

/** JSONL 首行：会话 header（id 即 sessionId，cwd 为项目目录，无 id/parentId 树字段语义） */
const HEADER_LINE = (o: { id?: string; cwd?: string } = {}): string =>
  JSON.stringify({ type: 'session', id: o.id ?? SESSION_ID, timestamp: PI_TS, cwd: o.cwd ?? CWD })

/** user 消息条目 */
const userLine = (id = 'u-1'): string =>
  JSON.stringify({
    type: 'message',
    id,
    parentId: null,
    timestamp: PI_TS + 1000,
    message: { role: 'user', content: '你好', contentType: 'text' }
  })

/**
 * assistant 计费条目（usage 四桶互不重叠；cost 为上游自带计价，本插件不采用）。
 * model/usage/timestamp/id 可覆盖，传 undefined 时整字段省略。
 */
const assistantLine = (
  o: {
    id?: string
    parentId?: string | null
    timestamp?: number
    model?: string
    usage?: Record<string, unknown> | null
  } = {}
): string =>
  JSON.stringify({
    ...(o.id === undefined ? {} : { id: o.id }),
    type: 'message',
    parentId: o.parentId === undefined ? 'u-1' : o.parentId,
    ...(o.timestamp === undefined ? {} : { timestamp: o.timestamp }),
    message: {
      role: 'assistant',
      ...(o.model === undefined ? {} : { model: o.model }),
      provider: 'anthropic',
      contentType: 'text',
      content: '回答内容',
      ...(o.usage === undefined || o.usage === null ? {} : { usage: o.usage })
    }
  })

/** 默认完整 usage 四桶 + 上游自带 cost（应被忽略） */
const FULL_USAGE = {
  input: 120,
  output: 60,
  cacheRead: 800,
  cacheWrite: 30,
  totalTokens: 1010,
  cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 }
}

/** compaction 条目（非计费条目） */
const compactionLine = (): string =>
  JSON.stringify({ type: 'compaction', id: 'c-1', parentId: 'm-1', trigger: 'manual', timestamp: PI_TS + 4000 })

/** model_change 条目（非计费条目） */
const modelChangeLine = (): string =>
  JSON.stringify({ type: 'model_change', id: 'mc-1', parentId: 'm-1', model: 'claude-opus-4-6', timestamp: PI_TS + 5000 })

/** 多行拼成 JSONL 文件内容（无尾随换行，行号即数组下标 +1） */
const writeJsonl = (file: string, lines: string[]): void =>
  fs.writeFileSync(file, lines.join('\n'), 'utf8')

let tmpDir = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-plugin-'))
})

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('piPlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(piPlugin.id).toBe('pi')
    expect(piPlugin.name).toBe('Pi Coding Agent')
    expect(piPlugin.version).toBe('1.0.0')
    expect(piPlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('dataRootOf 环境变量覆盖', () => {
  it('默认 ~/.pi/agent/sessions', () => {
    expect(dataRootOf()).toBe(path.join(os.homedir(), '.pi', 'agent', 'sessions'))
  })

  it('$PI_CODING_AGENT_DIR 非空时取其下 sessions 子目录（含 trim）', () => {
    process.env.PI_CODING_AGENT_DIR = ` ${tmpDir} `
    expect(dataRootOf()).toBe(path.join(tmpDir, 'sessions'))
  })

  it('插件级 listFiles/detect 读取 $PI_CODING_AGENT_DIR 覆盖的数据根', async () => {
    const sessionsDir = path.join(tmpDir, 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    writeJsonl(path.join(sessionsDir, 'a.jsonl'), [HEADER_LINE(), assistantLine()])
    process.env.PI_CODING_AGENT_DIR = tmpDir

    const entries = await piPlugin.listFiles(ctx)
    expect(entries.map((e) => path.basename(e.path))).toEqual(['a.jsonl'])
    const res = await piPlugin.detect(ctx)
    expect(res.available).toBe(true)
  })
})

describe('detectFromRoot 探测逻辑', () => {
  it('数据根缺失时不可用并给出原因与预期目录', () => {
    const root = path.join(tmpDir, 'sessions')
    const res = detectFromRoot(root)
    expect(res.available).toBe(false)
    expect(res.reason).toBeTruthy()
    expect(res.sessionDir).toBe(root)
  })

  it('数据根存在但无会话文件时不可用', () => {
    const root = path.join(tmpDir, 'sessions')
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'notes.txt'), 'x')
    const res = detectFromRoot(root)
    expect(res.available).toBe(false)
    expect(res.reason).toBeTruthy()
  })

  it('数据根存在且至少一个 .jsonl 时可用', () => {
    const root = path.join(tmpDir, 'sessions', '--home-alice-demo--')
    fs.mkdirSync(root, { recursive: true })
    writeJsonl(path.join(root, `${PI_TS}_abc12345.jsonl`), [HEADER_LINE()])
    const res = detectFromRoot(path.join(tmpDir, 'sessions'))
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(path.join(tmpDir, 'sessions'))
  })
})

describe('listFilesFromRoot 收集范围', () => {
  it('递归收集子树内任意层级 *.jsonl，排除非 jsonl/临时/隐藏文件；目录缺失返回空数组', () => {
    const root = path.join(tmpDir, 'sessions')
    const encodedDir = path.join(root, '--home-alice-demo--')
    const deepDir = path.join(encodedDir, 'sub')
    fs.mkdirSync(deepDir, { recursive: true })

    writeJsonl(path.join(encodedDir, `${PI_TS}_abc12345.jsonl`), [HEADER_LINE()])
    writeJsonl(path.join(deepDir, `${PI_TS + 1}_def67890.jsonl`), [HEADER_LINE()])
    // 应排除的文件
    writeJsonl(path.join(encodedDir, 'notes.txt'), ['x'])
    writeJsonl(path.join(encodedDir, 'draft.jsonl.tmp'), ['x'])
    writeJsonl(path.join(encodedDir, '.hidden.jsonl'), ['x'])
    writeJsonl(path.join(encodedDir, 'backup.jsonl~'), ['x'])

    const entries = listFilesFromRoot(root)
    expect(entries.map((e) => path.basename(e.path)).sort()).toEqual([
      `${PI_TS}_abc12345.jsonl`,
      `${PI_TS + 1}_def67890.jsonl`
    ])
    for (const e of entries) {
      expect(e.mtime).toBeGreaterThan(0)
    }

    // 目录缺失 → 空数组
    expect(listFilesFromRoot(path.join(tmpDir, 'missing'))).toEqual([])
  })
})

describe('parseFile 增量解析', () => {
  it('端到端：仅 assistant+usage 条目产出，sessionId/project/requestId/四桶/semantics=2 全部正确', async () => {
    const file = path.join(tmpDir, `${PI_TS}_abc12345.jsonl`)
    writeJsonl(file, [
      HEADER_LINE(),
      userLine(),
      assistantLine({ id: 'm-1', model: 'claude-opus-4-6', usage: FULL_USAGE, timestamp: PI_TS + 2000 }),
      compactionLine(),
      modelChangeLine()
    ])

    const res = await piPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.eof).toBe(true)

    const r = res.records[0]
    expect(r).toMatchObject({
      appType: 'pi',
      model: 'claude-opus-4-6',
      rawModel: 'claude-opus-4-6',
      inputTokens: 120,
      outputTokens: 60,
      cacheReadTokens: 800,
      cacheCreationTokens: 30,
      inputSemantics: 2,
      status: 'success',
      sessionId: SESSION_ID,
      project: CWD,
      createdAt: PI_TS + 2000
    })
    // 上游自带 cost 不采用，费用统一本地计算
    expect(r.costUsd).toBeUndefined()
    expect(r.source).toEqual({ filePath: file, line: 3, requestId: 'm-1' })
    // 5 行全部处理完毕，游标指向第 6 行
    expect(res.nextLine).toBe(6)
  })

  it('游标增量：fromLine 续读只产出新增 assistant 条目', async () => {
    const file = path.join(tmpDir, 'session-append.jsonl')
    writeJsonl(file, [HEADER_LINE(), userLine(), assistantLine({ id: 'm-1', model: 'glm-5', usage: FULL_USAGE })])

    const first = await piPlugin.parseFile(ctx, file, 0)
    expect(first.records.map((r) => r.source.requestId)).toEqual(['m-1'])
    expect(first.nextLine).toBe(4)

    // append-only 追加 user + 新 assistant 条目
    fs.appendFileSync(
      file,
      '\n' +
        [
          userLine('u-2'),
          assistantLine({ id: 'm-2', parentId: 'u-2', timestamp: PI_TS + 9000, model: 'glm-5', usage: FULL_USAGE })
        ].join('\n'),
      'utf8'
    )

    const second = await piPlugin.parseFile(ctx, file, first.nextLine)
    expect(second.records).toHaveLength(1)
    // 续读窗口越过首行 header，会话状态缺失 → sessionId 为 undefined（与 gemini JSONL 同语义）
    expect(second.records[0].sessionId).toBeUndefined()
    expect(second.records[0].source).toEqual({ filePath: file, line: 5, requestId: 'm-2' })
    expect(second.records[0]).toMatchObject({ inputTokens: 120, outputTokens: 60, inputSemantics: 2 })
    expect(second.nextLine).toBe(6)
    expect(second.eof).toBe(true)
  })

  it('尾部半行：游标停驻该行且 eof=true，写入补全后重试产出完整记录', async () => {
    const file = path.join(tmpDir, 'session-half-line.jsonl')
    const halfLine =
      '{"type":"message","id":"m-x","message":{"role":"assistant","model":"claude-opus-4-6"'
    writeJsonl(file, [HEADER_LINE(), assistantLine({ id: 'm-1', model: 'claude-opus-4-6', usage: FULL_USAGE }), halfLine])

    const first = await piPlugin.parseFile(ctx, file, 0)
    expect(first.records.map((r) => r.source.requestId)).toEqual(['m-1'])
    expect(first.nextLine).toBe(3) // 半行为第 3 行，游标原地等待下次重试
    expect(first.eof).toBe(true)

    // 写入器补全该行后，从停驻行重试
    writeJsonl(file, [
      HEADER_LINE(),
      assistantLine({ id: 'm-1', model: 'claude-opus-4-6', usage: FULL_USAGE }),
      assistantLine({ id: 'm-x', model: 'claude-opus-4-6', usage: FULL_USAGE })
    ])
    const retry = await piPlugin.parseFile(ctx, file, first.nextLine)
    expect(retry.records.map((r) => r.source.requestId)).toEqual(['m-x'])
    expect(retry.records[0].source.line).toBe(3)
    expect(retry.nextLine).toBe(4)
  })

  it('中间损坏行宽松跳过，后续 assistant 条目不受阻塞', async () => {
    const file = path.join(tmpDir, 'session-corrupt-middle.jsonl')
    writeJsonl(file, [
      HEADER_LINE(),
      '{broken json',
      assistantLine({ id: 'm-1', model: 'claude-opus-4-6', usage: FULL_USAGE }),
      assistantLine({ id: 'm-2', model: 'claude-opus-4-6', usage: FULL_USAGE })
    ])

    const res = await piPlugin.parseFile(ctx, file, 0)
    expect(res.records.map((r) => r.source.requestId)).toEqual(['m-1', 'm-2'])
    expect(res.records[0].source.line).toBe(3)
    expect(res.records[1].source.line).toBe(4)
    expect(res.nextLine).toBe(5)
    expect(res.eof).toBe(true)
  })

  it('无 usage / 无 model 的 assistant 条目与 user 条目跳过但水位推进', async () => {
    const file = path.join(tmpDir, 'session-skips.jsonl')
    writeJsonl(file, [
      HEADER_LINE(),
      assistantLine({ id: 'no-model', model: '', usage: FULL_USAGE }), // 无 model → 跳过
      assistantLine({ id: 'no-usage', model: 'claude-opus-4-6', usage: null }), // 无 usage → 跳过
      userLine(),
      assistantLine({ id: 'm-ok', model: 'claude-opus-4-6', usage: FULL_USAGE })
    ])

    const res = await piPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source).toEqual({ filePath: file, line: 5, requestId: 'm-ok' })
    expect(res.nextLine).toBe(6) // 跳过条目同样推进水位
    expect(res.eof).toBe(true)
  })

  it('createdAt：优先条目级 epoch ms，其次 message 内，均缺失兜底当前时间', async () => {
    const file = path.join(tmpDir, 'session-timestamps.jsonl')

    // 仅 message 内时间戳有效 → 取 message 级
    const msgOnlyTs = JSON.parse(
      assistantLine({ id: 'msg-ts', model: 'glm-5', usage: FULL_USAGE })
    ) as Record<string, unknown>
    delete msgOnlyTs.timestamp
    ;(msgOnlyTs.message as Record<string, unknown>).timestamp = PI_TS + 7000

    // 两级时间戳均缺失 → Date.now() 兜底
    const noTs = JSON.parse(
      assistantLine({ id: 'no-ts', model: 'glm-5', usage: FULL_USAGE })
    ) as Record<string, unknown>
    delete noTs.timestamp
    delete (noTs.message as Record<string, unknown>).timestamp

    writeJsonl(file, [HEADER_LINE(), JSON.stringify(msgOnlyTs), JSON.stringify(noTs)])

    const res = await piPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records[0].createdAt).toBe(PI_TS + 7000)
    expect(Math.abs(res.records[1].createdAt - Date.now())).toBeLessThan(60_000)
  })
})
