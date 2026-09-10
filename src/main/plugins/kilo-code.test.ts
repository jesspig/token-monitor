import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { kiloCodePlugin } from './kilo-code'
import { rooCodePlugin } from './roo-code'
import type { PluginContext } from '../../../shared/context'

const ctx = {} as PluginContext
const ROO_EXT_ID = 'rooveterinaryinc.roo-cline'
const KILO_EXT_ID = 'kilocode.kilo-code'
const DEFAULT_TS = 1763726728841

const usageInfo = (fields: Record<string, unknown>): string =>
  JSON.stringify({ request: 'fix the bug', ...fields })

const apiReqStarted = (o: {
  ts?: number
  text?: string
  modelId?: string
  apiProtocol?: string
} = {}): Record<string, unknown> => ({
  ts: o.ts ?? DEFAULT_TS,
  type: 'say',
  say: 'api_req_started',
  ...(o.modelId
    ? { modelInfo: { modelId: o.modelId, providerId: 'anthropic', mode: 'act' } }
    : {}),
  ...(o.apiProtocol ? { apiProtocol: o.apiProtocol } : {}),
  ...(o.text !== undefined ? { text: o.text } : { text: usageInfo({ tokensIn: 100, tokensOut: 50 }) })
})

const otherSay = (o: { ts?: number; say?: string; text?: string } = {}): Record<string, unknown> => ({
  ts: o.ts ?? DEFAULT_TS + 1,
  type: 'say',
  say: o.say ?? 'text',
  text: o.text ?? 'assistant reply'
})

const writeUiMessages = (taskDir: string, entries: unknown[]): string => {
  fs.mkdirSync(taskDir, { recursive: true })
  const file = path.join(taskDir, 'ui_messages.json')
  fs.writeFileSync(file, JSON.stringify(entries), 'utf8')
  return file
}

let tmpDir = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kilo-code-plugin-'))
  vi.stubEnv('ROO_CODE_DIR', globalStorage())
  vi.stubEnv('KILO_CODE_DIR', globalStorage())
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const globalStorage = (): string => path.join(tmpDir, 'globalStorage')
const rooTaskRoot = (): string => path.join(globalStorage(), ROO_EXT_ID, 'tasks')
const kiloTaskRoot = (): string => path.join(globalStorage(), KILO_EXT_ID, 'tasks')

describe('kiloCodePlugin 元数据', () => {
  it('id/name/version/deps 对齐契约且与 roo-code 区分', () => {
    expect(kiloCodePlugin.id).toBe('kilo-code')
    expect(kiloCodePlugin.name).toBe('Kilo Code')
    expect(kiloCodePlugin.version).toBe('1.0.0')
    expect(kiloCodePlugin.deps).toEqual(['storage', 'pricing', 'events'])
    expect(kiloCodePlugin.id).not.toBe(rooCodePlugin.id)
  })
})

describe('detect', () => {
  it('globalStorage 缺失时不可用并给出中文原因与 kilo tasks 预期目录', async () => {
    const res = await kiloCodePlugin.detect(ctx)
    expect(res.available).toBe(false)
    expect(res.reason).toBeTruthy()
    expect(res.sessionDir).toBe(kiloTaskRoot())
  })

  it('tasks 存在但无任何 ui_messages.json（空任务目录/仅杂文件）时不可用', async () => {
    fs.mkdirSync(path.join(kiloTaskRoot(), 'task-empty'), { recursive: true })
    fs.writeFileSync(path.join(kiloTaskRoot(), 'loose.json'), '[]', 'utf8')
    const res = await kiloCodePlugin.detect(ctx)
    expect(res.available).toBe(false)
    expect(res.reason).toContain(KILO_EXT_ID)
  })

  it('任务目录含 ui_messages.json 时可用', async () => {
    writeUiMessages(path.join(kiloTaskRoot(), 'task-1'), [apiReqStarted()])
    const res = await kiloCodePlugin.detect(ctx)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(kiloTaskRoot())
  })

  it('仅 kilo 数据存在：kilo 可用而 roo 不可用，互不串目录', async () => {
    writeUiMessages(path.join(kiloTaskRoot(), 'k1'), [apiReqStarted()])
    expect((await kiloCodePlugin.detect(ctx)).available).toBe(true)
    expect((await rooCodePlugin.detect(ctx)).available).toBe(false)
  })

  it('仅 roo 数据存在：roo 可用而 kilo 不可用，互不串目录', async () => {
    writeUiMessages(path.join(rooTaskRoot(), 'r1'), [apiReqStarted()])
    expect((await rooCodePlugin.detect(ctx)).available).toBe(true)
    expect((await kiloCodePlugin.detect(ctx)).available).toBe(false)
  })
})

describe('listFiles', () => {
  it('枚举各任务目录下的 ui_messages.json，跳过空任务目录与杂项文件，mtime 有效', async () => {
    const root = kiloTaskRoot()
    writeUiMessages(path.join(root, 'task-aaa'), [apiReqStarted()])
    writeUiMessages(path.join(root, 'task-bbb'), [apiReqStarted()])
    fs.mkdirSync(path.join(root, 'task-empty'), { recursive: true })
    fs.writeFileSync(path.join(root, 'loose.json'), '[]', 'utf8')

    const entries = await kiloCodePlugin.listFiles(ctx)
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => path.basename(path.dirname(e.path))).sort()).toEqual([
      'task-aaa',
      'task-bbb'
    ])
    for (const e of entries) {
      expect(path.basename(e.path)).toBe('ui_messages.json')
      expect(e.mtime).toBeGreaterThan(0)
    }
  })

  it('kilo 与 roo 目录并存时各自枚举，kilo 结果只含 kilo 扩展路径', async () => {
    writeUiMessages(path.join(kiloTaskRoot(), 'k1'), [apiReqStarted()])
    writeUiMessages(path.join(rooTaskRoot(), 'r1'), [apiReqStarted()])

    const kiloEntries = await kiloCodePlugin.listFiles(ctx)
    expect(kiloEntries).toHaveLength(1)
    expect(kiloEntries[0].path).toContain(KILO_EXT_ID)
    expect(kiloEntries[0].path).not.toContain(ROO_EXT_ID)

    const rooEntries = await rooCodePlugin.listFiles(ctx)
    expect(rooEntries).toHaveLength(1)
    expect(rooEntries[0].path).toContain(ROO_EXT_ID)
  })

  it('tasks 目录不存在时返回空数组不抛错', async () => {
    const entries = await kiloCodePlugin.listFiles(ctx)
    expect(entries).toEqual([])
  })
})

describe('parseFile 解析', () => {
  it('正常条目字段映射：四桶 + semantics=2 + appType 归属 kilo-code + requestId=String(ts)', async () => {
    const file = writeUiMessages(path.join(kiloTaskRoot(), 'task-1'), [
      apiReqStarted({
        modelId: 'claude-sonnet-4-5',
        text: usageInfo({ tokensIn: 32078, tokensOut: 268, cacheWrites: 1200, cacheReads: 9000, cost: 0.05 })
      })
    ])
    const res = await kiloCodePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.nextLine).toBe(1)
    expect(res.eof).toBe(true)

    const r = res.records[0]
    expect(r).toMatchObject({
      appType: 'kilo-code',
      model: 'claude-sonnet-4-5',
      rawModel: 'claude-sonnet-4-5',
      inputTokens: 32078,
      outputTokens: 268,
      cacheReadTokens: 9000,
      cacheCreationTokens: 1200,
      inputSemantics: 2,
      status: 'success'
    })
    expect(r.costUsd).toBeUndefined()
    expect(r.createdAt).toBe(DEFAULT_TS)
    expect(r.source).toEqual({ filePath: file, line: 0, requestId: String(DEFAULT_TS) })
  })

  it('产出条目 appType 为 kilo-code 而非内核默认的 cline', async () => {
    const file = writeUiMessages(path.join(kiloTaskRoot(), 'task-app'), [
      apiReqStarted({ ts: 5, modelId: 'm1' })
    ])
    const res = await kiloCodePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].appType).toBe('kilo-code')
    expect(res.records[0].appType).not.toBe('cline')
  })

  it('混合 say/ask/非对象元素跳过，source.line 等于数组 index', async () => {
    const file = writeUiMessages(path.join(kiloTaskRoot(), 'task-mix'), [
      otherSay(),
      apiReqStarted({ ts: 1001, modelId: 'm1' }),
      { ts: 1002, type: 'ask', ask: 'followup', text: 'continue?' },
      apiReqStarted({ ts: 1003, modelId: 'm1' }),
      null,
      42
    ])
    const res = await kiloCodePlugin.parseFile(ctx, file, 0)
    expect(res.records.map((r) => r.source.line)).toEqual([1, 3])
    expect(res.records.map((r) => r.source.requestId)).toEqual(['1001', '1003'])
    expect(res.nextLine).toBe(6)
  })

  it('占位条目（text 空串/无 usage 数字）不产出且 nextLine=0，回填后重析同 line/requestId 产出', async () => {
    const taskDir = path.join(kiloTaskRoot(), 'task-backfill')
    const file = writeUiMessages(taskDir, [otherSay(), apiReqStarted({ ts: 777, text: '' })])

    const first = await kiloCodePlugin.parseFile(ctx, file, 0)
    expect(first.records).toHaveLength(0)
    expect(first.nextLine).toBe(0)
    expect(first.eof).toBe(true)

    writeUiMessages(taskDir, [
      otherSay(),
      apiReqStarted({ ts: 777, modelId: 'gpt-4o', text: usageInfo({ tokensIn: 10, tokensOut: 5 }) })
    ])

    const second = await kiloCodePlugin.parseFile(ctx, file, 0)
    expect(second.records).toHaveLength(1)
    expect(second.records[0].source).toEqual({ filePath: file, line: 1, requestId: '777' })
    expect(second.records[0].model).toBe('gpt-4o')
    expect(second.nextLine).toBe(2)
  })

  it('全部回填后 nextLine=数组长度', async () => {
    const file = writeUiMessages(path.join(kiloTaskRoot(), 'task-full'), [
      apiReqStarted({ ts: 1, modelId: 'm1' }),
      apiReqStarted({ ts: 2, modelId: 'm1' }),
      otherSay()
    ])
    const res = await kiloCodePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.nextLine).toBe(3)
  })

  it('fromLine 越界仍全量解析（文件整体重写语义）', async () => {
    const file = writeUiMessages(path.join(kiloTaskRoot(), 'task-t1'), [
      apiReqStarted({ ts: 1, modelId: 'm1' }),
      apiReqStarted({ ts: 2, modelId: 'm1' })
    ])
    const res = await kiloCodePlugin.parseFile(ctx, file, 999)
    expect(res.records).toHaveLength(2)
    expect(res.records.map((r) => r.source.line)).toEqual([0, 1])
    expect(res.nextLine).toBe(2)
  })

  it('条目无 modelInfo 时从同目录 api_conversation_history.json 提取 fallback model', async () => {
    const taskDir = path.join(kiloTaskRoot(), 'task-hist')
    const file = writeUiMessages(taskDir, [apiReqStarted({ ts: 1 })])
    fs.writeFileSync(
      path.join(taskDir, 'api_conversation_history.json'),
      JSON.stringify([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'ok', modelInfo: { modelId: 'claude-sonnet-4-5', providerId: 'anthropic', mode: 'act' } }
      ]),
      'utf8'
    )
    const res = await kiloCodePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].model).toBe('claude-sonnet-4-5')
  })

  it('条目自带 modelInfo.modelId 优先于 history fallback', async () => {
    const taskDir = path.join(kiloTaskRoot(), 'task-prio')
    const file = writeUiMessages(taskDir, [apiReqStarted({ ts: 1, modelId: 'kilo-model' })])
    fs.writeFileSync(
      path.join(taskDir, 'api_conversation_history.json'),
      JSON.stringify([{ role: 'assistant', content: 'x', modelInfo: { modelId: 'history-model', providerId: 'anthropic', mode: 'act' } }]),
      'utf8'
    )
    const res = await kiloCodePlugin.parseFile(ctx, file, 0)
    expect(res.records[0].model).toBe('kilo-model')
  })

  it('text 含 apiProtocol 等额外字段时宽松解析不受影响', async () => {
    const file = writeUiMessages(path.join(kiloTaskRoot(), 'task-proto'), [
      apiReqStarted({
        ts: 9,
        modelId: 'gpt-5',
        apiProtocol: 'openai',
        text: usageInfo({ tokensIn: 40, tokensOut: 15, cacheReads: 7, cacheWrites: 3, apiProtocol: 'azure/openai' })
      })
    ])
    const res = await kiloCodePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].inputTokens).toBe(40)
    expect(res.records[0].outputTokens).toBe(15)
    expect(res.records[0].cacheReadTokens).toBe(7)
    expect(res.records[0].cacheCreationTokens).toBe(3)
  })

  it('重复解析幂等：requestId 与 line 完全一致', async () => {
    const file = writeUiMessages(path.join(kiloTaskRoot(), 'task-idem'), [
      apiReqStarted({ ts: 1, modelId: 'm0' }),
      apiReqStarted({ ts: 2, modelId: 'm1' })
    ])
    const a = await kiloCodePlugin.parseFile(ctx, file, 0)
    const b = await kiloCodePlugin.parseFile(ctx, file, 0)
    expect(b.records.map((r) => r.source)).toEqual(a.records.map((r) => r.source))
    expect(b.records.map((r) => r.source.requestId)).toEqual(['1', '2'])
  })

  it('跨任务多文件解析产出独立记录', async () => {
    const f1 = writeUiMessages(path.join(kiloTaskRoot(), 'task-a'), [
      apiReqStarted({ ts: 11, modelId: 'm-a', text: usageInfo({ tokensIn: 10, tokensOut: 1 }) })
    ])
    const f2 = writeUiMessages(path.join(kiloTaskRoot(), 'task-b'), [
      apiReqStarted({ ts: 22, modelId: 'm-b', text: usageInfo({ tokensIn: 20, tokensOut: 2 }) })
    ])
    const r1 = await kiloCodePlugin.parseFile(ctx, f1, 0)
    const r2 = await kiloCodePlugin.parseFile(ctx, f2, 0)
    expect(r1.records[0].source.filePath).toBe(f1)
    expect(r2.records[0].source.filePath).toBe(f2)
    expect(r1.records[0].model).toBe('m-a')
    expect(r2.records[0].model).toBe('m-b')
  })
})

describe('异常容错', () => {
  it('文件整体损坏（非 JSON）返回空结果不抛错', async () => {
    const taskDir = path.join(kiloTaskRoot(), 'task-broken')
    fs.mkdirSync(taskDir, { recursive: true })
    const file = path.join(taskDir, 'ui_messages.json')
    fs.writeFileSync(file, '{"ts":1,type: broken', 'utf8')
    const res = await kiloCodePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(0)
    expect(res.eof).toBe(true)
  })

  it('顶层非数组（对象/数字/字符串）返回空结果', async () => {
    const taskDir = path.join(kiloTaskRoot(), 'task-nonarray')
    fs.mkdirSync(taskDir, { recursive: true })
    const file = path.join(taskDir, 'ui_messages.json')
    for (const content of ['{"a":1}', '42', '"str"']) {
      fs.writeFileSync(file, content, 'utf8')
      const res = await kiloCodePlugin.parseFile(ctx, file, 0)
      expect(res.records).toHaveLength(0)
    }
  })

  it('text 为截断 JSON 时按占位处理，nextLine=0', async () => {
    const file = writeUiMessages(path.join(kiloTaskRoot(), 'task-trunc'), [
      apiReqStarted({ ts: 1, text: '{"tokensIn":100,"tokensOut' })
    ])
    const res = await kiloCodePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(0)
  })

  it('ui_messages.json 文件缺失时保持 fromLine 不抛错', async () => {
    const res = await kiloCodePlugin.parseFile(ctx, path.join(kiloTaskRoot(), 'nope', 'ui_messages.json'), 7)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(7)
    expect(res.eof).toBe(true)
  })

  it('history 缺失且条目无 modelInfo 时不产出记录', async () => {
    const file = writeUiMessages(path.join(kiloTaskRoot(), 'task-nomodel'), [apiReqStarted({ ts: 1 })])
    const res = await kiloCodePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(1)
  })
})
