import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import {
  clinePlugin,
  detectClineLikeTasks,
  listClineLikeTaskFiles,
  listClineLikeTaskFilesFromRoots,
  parseUiMessages,
  loadHistoryModel
} from './cline'
import { editorGlobalStorageRoots } from './_lib/cline-roots'
import type { PluginContext } from '../../../shared/context'

const ctx = {} as PluginContext
const EXT_ID = 'saoudrizwan.claude-dev'
const ROO_EXT_ID = 'rooveterinaryinc.roo-cline'
const DEFAULT_TS = 1763726728841
const FAKE_FILE = 'C:\\fake\\task-1\\ui_messages.json'

const usageInfo = (fields: Record<string, unknown>): string =>
  JSON.stringify({ request: 'fix the bug', ...fields })

const apiReqStarted = (o: {
  ts?: number
  text?: string
  modelId?: string
  providerId?: string
} = {}): Record<string, unknown> => ({
  ts: o.ts ?? DEFAULT_TS,
  type: 'say',
  say: 'api_req_started',
  ...(o.modelId
    ? { modelInfo: { modelId: o.modelId, providerId: o.providerId ?? 'anthropic', mode: 'act' } }
    : {}),
  ...(o.text !== undefined ? { text: o.text } : { text: usageInfo({ tokensIn: 100, tokensOut: 50 }) })
})

const otherSay = (o: { ts?: number; say?: string; text?: string } = {}): Record<string, unknown> => ({
  ts: o.ts ?? DEFAULT_TS + 1,
  type: 'say',
  say: o.say ?? 'text',
  text: o.text ?? 'assistant reply'
})

const askEntry = (o: { ts?: number; ask?: string } = {}): Record<string, unknown> => ({
  ts: o.ts ?? DEFAULT_TS + 2,
  type: 'ask',
  ask: o.ask ?? 'followup',
  text: 'continue?'
})

const writeUiMessages = (taskDir: string, entries: unknown[]): string => {
  fs.mkdirSync(taskDir, { recursive: true })
  const file = path.join(taskDir, 'ui_messages.json')
  fs.writeFileSync(file, JSON.stringify(entries), 'utf8')
  return file
}

let tmpDir = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-plugin-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const globalStorage = (): string => path.join(tmpDir, 'globalStorage')
const taskRoot = (): string => path.join(globalStorage(), EXT_ID, 'tasks')

describe('clinePlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(clinePlugin.id).toBe('cline')
    expect(clinePlugin.name).toBe('Cline')
    expect(clinePlugin.version).toBe('1.0.0')
    expect(clinePlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('detect（detectClineLikeTasks）', () => {
  it('tasks 目录缺失时不可用并给出中文原因与预期目录', () => {
    const res = detectClineLikeTasks(globalStorage(), EXT_ID)
    expect(res.available).toBe(false)
    expect(res.reason).toBeTruthy()
    expect(res.sessionDir).toBe(taskRoot())
  })

  it('tasks 存在但无任何 ui_messages.json（空任务目录/仅杂文件）时不可用', () => {
    fs.mkdirSync(path.join(taskRoot(), 'task-empty'), { recursive: true })
    fs.writeFileSync(path.join(taskRoot(), 'loose.json'), '[]', 'utf8')
    const res = detectClineLikeTasks(globalStorage(), EXT_ID)
    expect(res.available).toBe(false)
    expect(res.reason).toContain(EXT_ID)
  })

  it('任务目录含 ui_messages.json 时可用并返回 tasks 目录', () => {
    writeUiMessages(path.join(taskRoot(), 'task-1'), [apiReqStarted()])
    const res = detectClineLikeTasks(globalStorage(), EXT_ID)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(taskRoot())
  })

  it('extensionId 参数化：Roo 扩展目录独立探测，与 Cline 互不干扰', () => {
    writeUiMessages(path.join(globalStorage(), ROO_EXT_ID, 'tasks', 'r1'), [apiReqStarted()])
    const roo = detectClineLikeTasks(globalStorage(), ROO_EXT_ID)
    expect(roo.available).toBe(true)
    const cline = detectClineLikeTasks(globalStorage(), EXT_ID)
    expect(cline.available).toBe(false)
  })
})

describe('listClineLikeTaskFiles', () => {
  it('枚举各任务目录下的 ui_messages.json，跳过空任务目录与杂项文件，mtime 有效', () => {
    const root = taskRoot()
    writeUiMessages(path.join(root, 'task-aaa'), [apiReqStarted()])
    writeUiMessages(path.join(root, 'task-bbb'), [apiReqStarted()])
    fs.mkdirSync(path.join(root, 'task-empty'), { recursive: true })
    fs.writeFileSync(path.join(root, 'loose.json'), '[]', 'utf8')
    fs.writeFileSync(path.join(root, 'task-aaa', 'api_conversation_history.json'), '[]', 'utf8')

    const entries = listClineLikeTaskFiles(globalStorage(), EXT_ID)
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

  it('extensionId 参数化：不同扩展目录各自枚举，供 Roo/Kilo 复用', () => {
    writeUiMessages(path.join(globalStorage(), ROO_EXT_ID, 'tasks', 'r1'), [apiReqStarted()])
    writeUiMessages(path.join(taskRoot(), 'c1'), [apiReqStarted()])

    const rooEntries = listClineLikeTaskFiles(globalStorage(), ROO_EXT_ID)
    expect(rooEntries).toHaveLength(1)
    expect(rooEntries[0].path).toContain(ROO_EXT_ID)

    const clineEntries = listClineLikeTaskFiles(globalStorage(), EXT_ID)
    expect(clineEntries).toHaveLength(1)
    expect(clineEntries[0].path).toContain(EXT_ID)
  })
})

describe('parseUiMessages 解析', () => {
  it('正常条目字段映射：tokensIn/tokensOut/cacheReads/cacheWrites 四桶 + semantics=2 + modelInfo.modelId', () => {
    const entries = [
      apiReqStarted({
        modelId: 'claude-sonnet-4-5',
        text: usageInfo({ tokensIn: 32078, tokensOut: 268, cacheWrites: 1200, cacheReads: 9000, cost: 0.05 })
      })
    ]
    const res = parseUiMessages(FAKE_FILE, JSON.stringify(entries))
    expect(res.records).toHaveLength(1)
    expect(res.nextLine).toBe(1)
    expect(res.eof).toBe(true)

    const r = res.records[0]
    expect(r).toMatchObject({
      appType: 'cline',
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
    expect(r.source).toEqual({ filePath: FAKE_FILE, line: DEFAULT_TS, requestId: String(DEFAULT_TS) })
  })

  it('混合 say/ask/非对象元素跳过，产出条目 source.line 来自稳定请求身份', () => {
    const entries = [
      otherSay(),
      apiReqStarted({ ts: 1001 }),
      askEntry(),
      apiReqStarted({ ts: 1002 }),
      null,
      42
    ]
    const res = parseUiMessages(FAKE_FILE, JSON.stringify(entries), 'test-model')
    expect(res.records.map((r) => r.source.line)).toEqual([1001, 1002])
    expect(res.records.map((r) => r.source.requestId)).toEqual(['1001', '1002'])
    expect(res.nextLine).toBe(6)
  })

  it('未回填占位三形态（text 空串/{}/无 usage 数字）不产出且 nextLine=0', () => {
    const entries = [
      apiReqStarted({ ts: 1, text: usageInfo({ request: 'only request' }) }),
      apiReqStarted({ ts: 2, text: '{}' }),
      apiReqStarted({ ts: 3, text: '' }),
      apiReqStarted({ ts: 4 })
    ]
    const res = parseUiMessages(FAKE_FILE, JSON.stringify(entries), 'test-model')
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.line).toBe(4)
    expect(res.nextLine).toBe(0)
    expect(res.eof).toBe(true)
  })

  it('全部回填后 nextLine=数组长度', () => {
    const entries = [apiReqStarted({ ts: 1 }), apiReqStarted({ ts: 2 }), otherSay()]
    const res = parseUiMessages(FAKE_FILE, JSON.stringify(entries), 'test-model')
    expect(res.records).toHaveLength(2)
    expect(res.nextLine).toBe(3)
    expect(res.eof).toBe(true)
  })

  it('回填端到端：占位阶段 0 记录且游标归零，回填后重析同 line/requestId 产出', () => {
    const file = path.join(tmpDir, 'backfill', 'ui_messages.json')
    writeUiMessages(path.dirname(file), [
      otherSay(),
      apiReqStarted({ ts: 777, text: '' })
    ])

    const first = parseUiMessages(file, fs.readFileSync(file, 'utf8'))
    expect(first.records).toHaveLength(0)
    expect(first.nextLine).toBe(0)

    writeUiMessages(path.dirname(file), [
      otherSay(),
      apiReqStarted({ ts: 777, modelId: 'gpt-4o', text: usageInfo({ tokensIn: 10, tokensOut: 5 }) })
    ])

    const second = parseUiMessages(file, fs.readFileSync(file, 'utf8'))
    expect(second.records).toHaveLength(1)
    expect(second.records[0].source).toEqual({ filePath: file, line: 777, requestId: '777' })
    expect(second.records[0].model).toBe('gpt-4o')
    expect(second.nextLine).toBe(2)
  })

  it('重复解析幂等：同文件两次解析，requestId 与 line 完全一致', () => {
    const file = path.join(tmpDir, 'idempotent', 'ui_messages.json')
    const entries = [apiReqStarted({ ts: 1, modelId: 'm0' }), apiReqStarted({ ts: 2, modelId: 'm1' })]
    writeUiMessages(path.dirname(file), entries)

    const raw = fs.readFileSync(file, 'utf8')
    const a = parseUiMessages(file, raw)
    const b = parseUiMessages(file, raw)
    expect(b.records.map((r) => r.source)).toEqual(a.records.map((r) => r.source))
    expect(b.records.map((r) => r.source.requestId)).toEqual(['1', '2'])
    expect(b.records.map((r) => r.source.line)).toEqual([1, 2])
    expect(b.records.map((r) => r.inputTokens)).toEqual(a.records.map((r) => r.inputTokens))
    expect(b.nextLine).toBe(a.nextLine)
  })

  it('text 非 JSON 时显式报错', () => {
    const entries = [apiReqStarted({ ts: 1, text: '{"tokensIn":100,"tokensOut' })]
    expect(() => parseUiMessages(FAKE_FILE, JSON.stringify(entries))).toThrow('api_req_started.text')
  })

  it('数组为空返回空结果', () => {
    const res = parseUiMessages(FAKE_FILE, '[]')
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(0)
    expect(res.eof).toBe(true)
  })

  it('文件整体损坏时显式报错', () => {
    expect(() => parseUiMessages(FAKE_FILE, '{"ts":1763726728841,type: broken')).toThrow('不是合法 JSON')
  })

  it('顶层非数组时显式报 schema 不兼容', () => {
    expect(() => parseUiMessages(FAKE_FILE, '{"a":1}')).toThrow('顶层必须是数组')
    expect(() => parseUiMessages(FAKE_FILE, '42')).toThrow('顶层必须是数组')
    expect(() => parseUiMessages(FAKE_FILE, '"str"')).toThrow('顶层必须是数组')
  })

  it('仅 tokensOut 有效时产出且 inputTokens=0', () => {
    const entries = [apiReqStarted({ text: usageInfo({ tokensOut: 5 }) })]
    const res = parseUiMessages(FAKE_FILE, JSON.stringify(entries), 'test-model')
    expect(res.records).toHaveLength(1)
    expect(res.records[0].inputTokens).toBe(0)
    expect(res.records[0].outputTokens).toBe(5)
    expect(res.nextLine).toBe(1)
  })

  it('条目无 modelInfo 且无 fallbackModel 时不产出，已回填游标仍正常推进', () => {
    const entries = [apiReqStarted({ ts: 1 }), apiReqStarted({ ts: 2 })]
    const res = parseUiMessages(FAKE_FILE, JSON.stringify(entries))
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(2)
  })

  it('条目无 modelInfo 时采用 fallbackModel', () => {
    const entries = [apiReqStarted({ ts: 1 })]
    const res = parseUiMessages(FAKE_FILE, JSON.stringify(entries), 'deepseek-chat')
    expect(res.records).toHaveLength(1)
    expect(res.records[0].model).toBe('deepseek-chat')
    expect(res.records[0].rawModel).toBe('deepseek-chat')
  })

  it('条目 modelInfo.modelId 非字符串/空串时回退 fallbackModel', () => {
    const entries = [
      { ts: 1, type: 'say', say: 'api_req_started', modelInfo: { modelId: '' }, text: usageInfo({ tokensIn: 1, tokensOut: 1 }) },
      { ts: 2, type: 'say', say: 'api_req_started', modelInfo: { modelId: 42 }, text: usageInfo({ tokensIn: 1, tokensOut: 1 }) },
      { ts: 3, type: 'say', say: 'api_req_started', modelInfo: 'broken', text: usageInfo({ tokensIn: 1, tokensOut: 1 }) }
    ]
    const res = parseUiMessages(FAKE_FILE, JSON.stringify(entries), 'fallback-m')
    expect(res.records).toHaveLength(3)
    for (const r of res.records) expect(r.model).toBe('fallback-m')
  })

  it('ts 缺失/非法时 createdAt 兜底为当前时间且不设置 requestId', () => {
    const entries = [
      { type: 'say', say: 'api_req_started', text: usageInfo({ tokensIn: 1, tokensOut: 1 }) },
      { ts: 'not-a-number', type: 'say', say: 'api_req_started', text: usageInfo({ tokensIn: 2, tokensOut: 2 }) }
    ]
    const res = parseUiMessages(FAKE_FILE, JSON.stringify(entries), 'm')
    expect(res.records).toHaveLength(2)
    for (const r of res.records) {
      expect(Number.isNaN(r.createdAt)).toBe(false)
      expect(Math.abs(r.createdAt - Date.now())).toBeLessThan(60_000)
      expect('requestId' in r.source).toBe(false)
    }
  })
})

describe('loadHistoryModel 与 parseFile 集成', () => {
  it('loadHistoryModel 反向取最后一条带 modelInfo 的消息', async () => {
    const historyPath = path.join(tmpDir, 'api_conversation_history.json')
    fs.writeFileSync(
      historyPath,
      JSON.stringify([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'a' }], modelInfo: { modelId: 'claude-3', providerId: 'anthropic', mode: 'act' } },
        { role: 'user', content: 'more' },
        { role: 'assistant', content: [{ type: 'text', text: 'b' }], modelInfo: { modelId: 'gpt-4o', providerId: 'openai', mode: 'act' } }
      ]),
      'utf8'
    )
    await expect(loadHistoryModel(historyPath)).resolves.toBe('gpt-4o')
  })

  it('loadHistoryModel 对缺失和无 modelInfo 返回 undefined，对损坏或未知 schema 显式报错', async () => {
    await expect(loadHistoryModel(path.join(tmpDir, 'missing.json'))).resolves.toBeUndefined()

    const broken = path.join(tmpDir, 'broken.json')
    fs.writeFileSync(broken, '{broken', 'utf8')
    await expect(loadHistoryModel(broken)).rejects.toThrow('不是合法 JSON')

    const incompatible = path.join(tmpDir, 'incompatible.json')
    fs.writeFileSync(incompatible, JSON.stringify({ messages: [] }), 'utf8')
    await expect(loadHistoryModel(incompatible)).rejects.toThrow('顶层必须是数组')

    const noModel = path.join(tmpDir, 'no-model.json')
    fs.writeFileSync(noModel, JSON.stringify([{ role: 'user', content: 'hi' }]), 'utf8')
    await expect(loadHistoryModel(noModel)).resolves.toBeUndefined()
  })

  it('parseFile 忽略 fromLine 对条目选择的作用：fromLine 越界仍全量解析', async () => {
    const file = writeUiMessages(path.join(tmpDir, 't1'), [
      apiReqStarted({ ts: 1, modelId: 'm1' }),
      apiReqStarted({ ts: 2, modelId: 'm1' })
    ])
    const res = await clinePlugin.parseFile(ctx, file, 999)
    expect(res.records).toHaveLength(2)
    expect(res.records.map((r) => r.source.line)).toEqual([1, 2])
    expect(res.nextLine).toBe(2)
  })

  it('parseFile 从同目录 api_conversation_history.json 提取 fallback model', async () => {
    const taskDir = path.join(tmpDir, 't2')
    const file = writeUiMessages(taskDir, [apiReqStarted({ ts: 1 })])
    fs.writeFileSync(
      path.join(taskDir, 'api_conversation_history.json'),
      JSON.stringify([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'ok', modelInfo: { modelId: 'claude-sonnet-4-5', providerId: 'anthropic', mode: 'act' } }
      ]),
      'utf8'
    )
    const res = await clinePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].model).toBe('claude-sonnet-4-5')
  })

  it('parseFile 在 history 缺失且条目无 modelInfo 时不产出记录', async () => {
    const file = writeUiMessages(path.join(tmpDir, 't3'), [apiReqStarted({ ts: 1 })])
    const res = await clinePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(1)
  })

  it('parseFile 文件读取失败时保持 fromLine 不抛错', async () => {
    const res = await clinePlugin.parseFile(ctx, path.join(tmpDir, 'nope', 'ui_messages.json'), 7)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(7)
    expect(res.eof).toBe(true)
  })

  it('跨任务多文件：两个任务各自解析产出独立记录', async () => {
    const f1 = writeUiMessages(path.join(tmpDir, 'multi', 'task-a'), [
      apiReqStarted({ ts: 11, modelId: 'm-a', text: usageInfo({ tokensIn: 10, tokensOut: 1 }) })
    ])
    const f2 = writeUiMessages(path.join(tmpDir, 'multi', 'task-b'), [
      apiReqStarted({ ts: 22, modelId: 'm-b', text: usageInfo({ tokensIn: 20, tokensOut: 2 }) })
    ])

    const r1 = await clinePlugin.parseFile(ctx, f1, 0)
    const r2 = await clinePlugin.parseFile(ctx, f2, 0)
    expect(r1.records).toHaveLength(1)
    expect(r2.records).toHaveLength(1)
    expect(r1.records[0].source.filePath).toBe(f1)
    expect(r1.records[0].source.requestId).toBe('11')
    expect(r2.records[0].source.filePath).toBe(f2)
    expect(r2.records[0].source.requestId).toBe('22')
    expect(r1.records[0].model).toBe('m-a')
    expect(r2.records[0].model).toBe('m-b')
  })
})


describe('多客户端目录与稳定记录身份', () => {
  it('解析 Windows、macOS 与 Linux 的 Stable、Insiders、VSCodium、Cursor globalStorage 根', () => {
    const win = editorGlobalStorageRoots(undefined, { platform: 'win32', homeDir: tmpDir, appData: path.join(tmpDir, 'Roaming') })
    expect(win.map((root) => path.basename(path.dirname(path.dirname(root))))).toEqual(['Code', 'Code - Insiders', 'VSCodium', 'Cursor'])

    const mac = editorGlobalStorageRoots(undefined, { platform: 'darwin', homeDir: tmpDir })
    expect(mac.map((root) => path.basename(path.dirname(path.dirname(root))))).toEqual(['Code', 'Code - Insiders', 'VSCodium', 'Cursor'])

    const linux = editorGlobalStorageRoots(undefined, { platform: 'linux', homeDir: tmpDir, xdgConfigHome: path.join(tmpDir, '.config') })
    expect(linux.map((root) => path.basename(path.dirname(path.dirname(root))))).toEqual(['Code', 'Code - Insiders', 'VSCodium', 'Cursor'])
  })

  it('多根按规范化路径去重，并以任务 ID 折叠迁移副本', () => {
    const roots = [path.join(tmpDir, 'Code', 'User', 'globalStorage'), path.join(tmpDir, 'Cursor', 'User', 'globalStorage')]
    const oldFile = writeUiMessages(path.join(roots[0], EXT_ID, 'tasks', 'same-task'), [apiReqStarted({ ts: 1 })])
    const newFile = writeUiMessages(path.join(roots[1], EXT_ID, 'tasks', 'same-task'), [apiReqStarted({ ts: 1 }), apiReqStarted({ ts: 2 })])
    const now = new Date()
    fs.utimesSync(oldFile, new Date(now.getTime() - 1000), new Date(now.getTime() - 1000))
    fs.utimesSync(newFile, now, now)

    const files = listClineLikeTaskFilesFromRoots([roots[0], path.resolve(roots[0]), roots[1]], EXT_ID)
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe(newFile)
  })

  it('Cline 与 Roo 扩展目录在同一组客户端根中严格隔离', () => {
    const roots = [path.join(tmpDir, 'Code', 'User', 'globalStorage'), path.join(tmpDir, 'Cursor', 'User', 'globalStorage')]
    writeUiMessages(path.join(roots[0], EXT_ID, 'tasks', 'cline-task'), [apiReqStarted({ ts: 1 })])
    writeUiMessages(path.join(roots[1], ROO_EXT_ID, 'tasks', 'roo-task'), [apiReqStarted({ ts: 2 })])

    const files = listClineLikeTaskFilesFromRoots(roots, EXT_ID)
    expect(files).toHaveLength(1)
    expect(files[0].path).toContain(EXT_ID)
    expect(files[0].path).not.toContain(ROO_EXT_ID)
  })

  it('数组删除与重排后 requestId 和 source.line 保持稳定', () => {
    const first = parseUiMessages(FAKE_FILE, JSON.stringify([
      apiReqStarted({ ts: 101, modelId: 'm' }),
      otherSay(),
      apiReqStarted({ ts: 202, modelId: 'm' })
    ]))
    const second = parseUiMessages(FAKE_FILE, JSON.stringify([
      apiReqStarted({ ts: 202, modelId: 'm' }),
      apiReqStarted({ ts: 101, modelId: 'm' })
    ]))

    const identities = (result: typeof first) => new Map(result.records.map((record) => [record.source.requestId, record.source.line]))
    expect(identities(second)).toEqual(identities(first))
    expect([...identities(first).entries()]).toEqual([['101', 101], ['202', 202]])
  })

  it('显式 requestId 在缺少时间戳时提供稳定身份，缺少任何身份时才回退数组索引', () => {
    const entries = [
      { type: 'say', say: 'api_req_started', requestId: 'req-stable', modelInfo: { modelId: 'm' }, text: usageInfo({ tokensIn: 1, tokensOut: 1 }) },
      { type: 'say', say: 'api_req_started', modelInfo: { modelId: 'm' }, text: usageInfo({ tokensIn: 2, tokensOut: 2 }) }
    ]
    const first = parseUiMessages(FAKE_FILE, JSON.stringify(entries))
    const second = parseUiMessages(FAKE_FILE, JSON.stringify([entries[1], entries[0]]))
    expect(first.records[0].source.requestId).toBe('req-stable')
    expect(second.records[1].source).toEqual(first.records[0].source)
    expect(first.records[1].source.requestId).toBeUndefined()
  })

  it('单个损坏文件失败可见且不影响其他文件继续解析', async () => {
    const broken = writeUiMessages(path.join(tmpDir, 'broken-task'), [])
    fs.writeFileSync(broken, '{broken', 'utf8')
    const good = writeUiMessages(path.join(tmpDir, 'good-task'), [apiReqStarted({ ts: 9, modelId: 'm' })])

    await expect(clinePlugin.parseFile(ctx, broken, 0)).rejects.toThrow('不是合法 JSON')
    await expect(clinePlugin.parseFile(ctx, good, 0)).resolves.toMatchObject({ nextLine: 1 })
  })
})
