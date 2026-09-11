import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import { kiloCodePlugin } from './kilo-code'
import { currentDatabasePath, databaseMtime, KILO_DATABASE_FILE } from './_lib/kilo-storage'
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
  vi.stubEnv('KILO_DATA_HOME', currentDataRoot())
})

afterEach(() => {
  vi.unstubAllEnvs()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const globalStorage = (): string => path.join(tmpDir, 'globalStorage')
const rooTaskRoot = (): string => path.join(globalStorage(), ROO_EXT_ID, 'tasks')
const kiloTaskRoot = (): string => path.join(globalStorage(), KILO_EXT_ID, 'tasks')
const currentDataRoot = (): string => path.join(tmpDir, 'current')
const currentDbPath = (): string => path.join(currentDataRoot(), KILO_DATABASE_FILE)

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
  it('当前与旧版存储均缺失时不可用并指向当前数据根', async () => {
    const res = await kiloCodePlugin.detect(ctx)
    expect(res.available).toBe(false)
    expect(res.reason).toBeTruthy()
    expect(res.sessionDir).toBe(currentDataRoot())
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
    expect(r.source).toEqual({ filePath: file, line: DEFAULT_TS, requestId: String(DEFAULT_TS) })
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

  it('混合 say/ask/非对象元素跳过，source.line 来自稳定请求身份', async () => {
    const file = writeUiMessages(path.join(kiloTaskRoot(), 'task-mix'), [
      otherSay(),
      apiReqStarted({ ts: 1001, modelId: 'm1' }),
      { ts: 1002, type: 'ask', ask: 'followup', text: 'continue?' },
      apiReqStarted({ ts: 1003, modelId: 'm1' }),
      null,
      42
    ])
    const res = await kiloCodePlugin.parseFile(ctx, file, 0)
    expect(res.records.map((r) => r.source.line)).toEqual([1001, 1003])
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
    expect(second.records[0].source).toEqual({ filePath: file, line: 777, requestId: '777' })
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
    expect(res.records.map((r) => r.source.line)).toEqual([1, 2])
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
  it('文件整体损坏时显式报告旧版存储损坏', async () => {
    const taskDir = path.join(kiloTaskRoot(), 'task-broken')
    fs.mkdirSync(taskDir, { recursive: true })
    const file = path.join(taskDir, 'ui_messages.json')
    fs.writeFileSync(file, '{"ts":1,type: broken', 'utf8')
    await expect(kiloCodePlugin.parseFile(ctx, file, 0)).rejects.toThrow('旧版存储损坏')
  })

  it('顶层非数组时显式报告旧版 schema 不兼容', async () => {
    const taskDir = path.join(kiloTaskRoot(), 'task-nonarray')
    fs.mkdirSync(taskDir, { recursive: true })
    const file = path.join(taskDir, 'ui_messages.json')
    for (const content of ['{"a":1}', '42', '"str"']) {
      fs.writeFileSync(file, content, 'utf8')
      await expect(kiloCodePlugin.parseFile(ctx, file, 0)).rejects.toThrow('schema 不兼容')
    }
  })

  it('text 为截断非空 JSON 时显式报错', async () => {
    const file = writeUiMessages(path.join(kiloTaskRoot(), 'task-trunc'), [
      apiReqStarted({ ts: 1, text: '{"tokensIn":100,"tokensOut' })
    ])
    await expect(kiloCodePlugin.parseFile(ctx, file, 0)).rejects.toThrow('api_req_started.text')
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

interface CurrentMessageFixture {
  id: string
  sessionId: string
  timeCreated: number
  data: unknown
}

function assistantMessage(o: {
  id?: string
  sessionId?: string
  time?: number
  model?: string
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
} = {}): CurrentMessageFixture {
  const time = o.time ?? 1_700_000_000_000
  return {
    id: o.id ?? 'msg-1',
    sessionId: o.sessionId ?? 'session-1',
    timeCreated: time,
    data: {
      role: 'assistant',
      time: { created: time, completed: time + 10 },
      parentID: 'parent-1',
      modelID: o.model ?? 'claude-sonnet-4-5',
      providerID: 'anthropic',
      mode: 'build',
      agent: 'build',
      cost: 0.01,
      tokens: {
        input: o.input ?? 100,
        output: o.output ?? 50,
        reasoning: 0,
        cache: { read: o.cacheRead ?? 20, write: o.cacheWrite ?? 5 }
      },
      finish: 'stop'
    }
  }
}

function writeCurrentDatabase(
  messages: CurrentMessageFixture[] = [assistantMessage()],
  dbPath = currentDbPath()
): string {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workspace_id TEXT,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      share_url TEXT,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER,
      revert_message_id TEXT,
      revert_part_id TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_compacting INTEGER,
      time_archived INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `)
  const sessionIds = [...new Set(messages.map((message) => message.sessionId))]
  const insertSession = db.prepare(
    `INSERT INTO session (
      id, project_id, workspace_id, parent_id, slug, directory, title, version,
      share_url, summary_additions, summary_deletions, summary_files,
      revert_message_id, revert_part_id, time_created, time_updated, time_compacting, time_archived
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const sessionId of sessionIds) {
    insertSession.run(
      sessionId,
      'project-1',
      null,
      null,
      sessionId,
      `/work/${sessionId}`,
      'Test',
      '1',
      null,
      null,
      null,
      null,
      null,
      null,
      1,
      1,
      null,
      null
    )
  }
  const insertMessage = db.prepare(
    'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
  )
  for (const message of messages) {
    insertMessage.run(
      message.id,
      message.sessionId,
      message.timeCreated,
      message.timeCreated,
      typeof message.data === 'string' ? message.data : JSON.stringify(message.data)
    )
  }
  db.close()
  return dbPath
}

describe('当前统一 SQLite 存储', () => {
  it('KILO_DATA_HOME 指向官方数据根，kilo.db schema 兼容时可检测', async () => {
    writeCurrentDatabase()
    expect(currentDatabasePath()).toBe(currentDbPath())
    const result = await kiloCodePlugin.detect(ctx)
    expect(result).toEqual({ available: true, sessionDir: currentDataRoot() })
  })

  it('数据库与旧版任务并存时只枚举当前数据库，避免迁移数据重复统计', async () => {
    writeCurrentDatabase()
    writeUiMessages(path.join(kiloTaskRoot(), 'legacy-task'), [apiReqStarted({ ts: 1, modelId: 'legacy-model' })])
    const files = await kiloCodePlugin.listFiles(ctx)
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe(currentDbPath())
  })

  it('文件 mtime 包含 WAL 变化', () => {
    const dbPath = writeCurrentDatabase()
    const baseTime = new Date(Date.now() - 10_000)
    fs.utimesSync(dbPath, baseTime, baseTime)
    const walPath = `${dbPath}-wal`
    fs.writeFileSync(walPath, 'wal-change', 'utf8')
    const walTime = new Date(Date.now() - 1_000)
    fs.utimesSync(walPath, walTime, walTime)
    expect(databaseMtime(dbPath)).toBe(Math.round(fs.statSync(walPath).mtimeMs))
  })

  it('解析 assistant message 的模型、四桶 Token、项目、会话与稳定 requestId', async () => {
    const dbPath = writeCurrentDatabase([
      assistantMessage({
        id: 'message-current-1',
        sessionId: 'session-current',
        time: 1_700_000_000_123,
        model: 'gpt-5',
        input: 300,
        output: 80,
        cacheRead: 40,
        cacheWrite: 10
      })
    ])
    const result = await kiloCodePlugin.parseFile(ctx, dbPath, 0)
    expect(result.records).toHaveLength(1)
    expect(result.records[0]).toMatchObject({
      appType: 'kilo-code',
      model: 'gpt-5',
      rawModel: 'gpt-5',
      inputTokens: 300,
      outputTokens: 80,
      cacheReadTokens: 40,
      cacheCreationTokens: 10,
      inputSemantics: 0,
      status: 'success',
      project: '/work/session-current',
      sessionId: 'session-current',
      createdAt: 1_700_000_000_133
    })
    expect(result.records[0].source).toEqual({
      filePath: dbPath,
      line: 1,
      requestId: 'message-current-1'
    })
    expect(result.nextLine).toBe(1)
  })

  it('rowid 水位只读取后续消息，相同时间戳的消息不会漏采', async () => {
    const dbPath = writeCurrentDatabase([
      assistantMessage({ id: 'm-1', time: 1_000 }),
      assistantMessage({ id: 'm-2', time: 1_000 })
    ])
    const first = await kiloCodePlugin.parseFile(ctx, dbPath, 0)
    expect(first.records.map((record) => record.source.requestId)).toEqual(['m-1', 'm-2'])
    expect(first.nextLine).toBe(2)

    const db = new Database(dbPath)
    const next = assistantMessage({ id: 'm-3', time: 1_000 })
    db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
      next.id,
      next.sessionId,
      next.timeCreated,
      next.timeCreated,
      JSON.stringify(next.data)
    )
    db.close()

    const second = await kiloCodePlugin.parseFile(ctx, dbPath, first.nextLine)
    expect(second.records.map((record) => record.source.requestId)).toEqual(['m-3'])
    expect(second.records[0].source.line).toBe(3)
    expect(second.nextLine).toBe(3)
  })

  it('非 assistant 消息推进水位但不产生用量记录', async () => {
    const dbPath = writeCurrentDatabase([
      {
        id: 'user-1',
        sessionId: 'session-1',
        timeCreated: 1_000,
        data: { role: 'user', time: { created: 1_000 }, content: 'hello' }
      },
      assistantMessage({ id: 'assistant-1', time: 2_000 })
    ])
    const result = await kiloCodePlugin.parseFile(ctx, dbPath, 0)
    expect(result.records.map((record) => record.source.requestId)).toEqual(['assistant-1'])
    expect(result.nextLine).toBe(2)
  })

  it('解析过程只读，不改变外部数据库内容', async () => {
    const dbPath = writeCurrentDatabase([assistantMessage({ id: 'read-only' })])
    const before = fs.statSync(dbPath).size
    await kiloCodePlugin.parseFile(ctx, dbPath, 0)
    const db = new Database(dbPath, { readonly: true })
    const count = (db.prepare('SELECT COUNT(*) AS count FROM message').get() as { count: number }).count
    db.close()
    expect(count).toBe(1)
    expect(fs.statSync(dbPath).size).toBe(before)
  })
})

describe('当前存储 schema 与损坏隔离', () => {
  it('缺少必需列时 detect 显式返回 schema 不兼容', async () => {
    fs.mkdirSync(currentDataRoot(), { recursive: true })
    const db = new Database(currentDbPath())
    db.exec('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER); CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)')
    db.close()
    const result = await kiloCodePlugin.detect(ctx)
    expect(result.available).toBe(false)
    expect(result.reason).toContain('schema 不兼容')
    expect(result.reason).toContain('data')
  })

  it('未知数据库 schema 在 parseFile 中抛出明确错误且不推进游标', async () => {
    fs.mkdirSync(currentDataRoot(), { recursive: true })
    const db = new Database(currentDbPath())
    db.exec('CREATE TABLE unrelated (value TEXT)')
    db.close()
    await expect(kiloCodePlugin.parseFile(ctx, currentDbPath(), 9)).rejects.toThrow('schema 不兼容')
  })

  it('assistant 消息缺少官方 tokens.cache 结构时显式拒绝而不是静默零值', async () => {
    const malformed = assistantMessage({ id: 'malformed-1' })
    malformed.data = {
      role: 'assistant',
      time: { created: malformed.timeCreated },
      modelID: 'gpt-5',
      tokens: { input: 1, output: 2 }
    }
    const dbPath = writeCurrentDatabase([malformed])
    await expect(kiloCodePlugin.parseFile(ctx, dbPath, 0)).rejects.toThrow('tokens.cache')
  })

  it('当前数据库损坏时仍枚举旧版文件，单源失败不阻塞其余旧任务', async () => {
    fs.mkdirSync(currentDataRoot(), { recursive: true })
    fs.writeFileSync(currentDbPath(), 'not a sqlite database', 'utf8')
    const oldA = writeUiMessages(path.join(kiloTaskRoot(), 'legacy-a'), [apiReqStarted({ ts: 11, modelId: 'old-a' })])
    const oldB = writeUiMessages(path.join(kiloTaskRoot(), 'legacy-b'), [apiReqStarted({ ts: 22, modelId: 'old-b' })])

    const detection = await kiloCodePlugin.detect(ctx)
    expect(detection.available).toBe(true)
    const files = await kiloCodePlugin.listFiles(ctx)
    expect(files.map((entry) => entry.path)).toEqual([currentDbPath(), oldA, oldB])
    await expect(kiloCodePlugin.parseFile(ctx, currentDbPath(), 0)).rejects.toThrow()
    expect((await kiloCodePlugin.parseFile(ctx, oldA, 0)).records[0].model).toBe('old-a')
    expect((await kiloCodePlugin.parseFile(ctx, oldB, 0)).records[0].model).toBe('old-b')
  })
})
