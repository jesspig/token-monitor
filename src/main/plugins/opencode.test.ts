import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import {
  opencodePlugin,
  detectFromRoot,
  listFilesFromRoot,
  parseDbFile,
  parseJsonFile,
  statMtimeMs,
  maxMtime,
  DB_SOURCE_SUFFIX,
  CHANNEL_DB_NAMES
} from './opencode'
import type { PluginContext } from '../../../shared/context'

const ctx = {} as PluginContext
const DB_CURSOR_MARKER = 2 ** 52

let tmpDir = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function buildOpencodeDb(
  dbPath: string,
  opts: {
    sessions?: Array<{ id: string; directory?: string | null }>
    messages?: Array<{
      id: string
      sessionId?: string | null
      timeCreated: number
      timeUpdated?: number
      data: unknown
      rawData?: string
    }>
  } = {}
): void {
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      directory TEXT,
      title TEXT,
      time_created INTEGER,
      time_updated INTEGER
    );
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT
    );
  `)
  const insS = db.prepare(
    'INSERT INTO session (id, project_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)'
  )
  for (const s of opts.sessions ?? []) {
    insS.run(s.id, null, s.directory ?? null, null, 0, 0)
  }
  const insM = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
  for (const m of opts.messages ?? []) {
    insM.run(m.id, m.sessionId ?? null, m.timeCreated, m.timeUpdated ?? m.timeCreated, m.rawData ?? JSON.stringify(m.data))
  }
  db.close()
}

function asstMsg(o: {
  id?: string
  time?: number
  modelID?: string
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
} = {}): { id: string; sessionId: string; timeCreated: number; data: unknown } {
  const time = o.time ?? 1_000
  return {
    id: o.id ?? 'm-1',
    sessionId: 'sess-1',
    timeCreated: time,
    data: {
      role: 'assistant',
      time: { created: time },
      modelID: o.modelID ?? 'glm-5.1',
      providerID: 'provider-1',
      agent: 'build',
      cost: 0,
      tokens: {
        input: o.input ?? 123,
        output: o.output ?? 45,
        reasoning: 10,
        cache: { read: o.cacheRead ?? 8, write: o.cacheWrite ?? 3 }
      }
    }
  }
}

const userMsg = (o: { id?: string; time?: number } = {}): {
  id: string
  sessionId: string
  timeCreated: number
  data: unknown
} => ({
  id: o.id ?? 'u-1',
  sessionId: 'sess-1',
  timeCreated: o.time ?? 500,
  data: { role: 'user', time: { created: o.time ?? 500 }, content: 'hello' }
})

describe('opencodePlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(opencodePlugin.id).toBe('opencode')
    expect(opencodePlugin.name).toBe('OpenCode')
    expect(opencodePlugin.version).toBe('1.0.0')
    expect(opencodePlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('detectFromRoot 探测', () => {
  it('数据根缺失时不可用并给出原因与预期目录', () => {
    const root = path.join(tmpDir, 'opencode')
    const res = detectFromRoot(root)
    expect(res.available).toBe(false)
    expect(res.reason).toBeTruthy()
    expect(res.sessionDir).toBe(root)
  })

  it('数据根存在但无 db 也无 storage/message 时不可用', () => {
    const root = path.join(tmpDir, 'opencode')
    fs.mkdirSync(root, { recursive: true })
    const res = detectFromRoot(root)
    expect(res.available).toBe(false)
    expect(res.reason).toBeTruthy()
  })

  it('存在 opencode.db 时可用', () => {
    const root = path.join(tmpDir, 'opencode')
    fs.mkdirSync(root, { recursive: true })
    buildOpencodeDb(path.join(root, DB_SOURCE_SUFFIX), {})
    const res = detectFromRoot(root)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(root)
  })

  it('存在官方 prod 渠道数据库时可用', () => {
    const root = path.join(tmpDir, 'opencode')
    fs.mkdirSync(root, { recursive: true })
    buildOpencodeDb(path.join(root, CHANNEL_DB_NAMES[0]), {})
    const res = detectFromRoot(root)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(root)
  })

  it('仅有旧版 storage/message 目录（空）时也可用', () => {
    const root = path.join(tmpDir, 'opencode')
    fs.mkdirSync(path.join(root, 'storage', 'message'), { recursive: true })
    const res = detectFromRoot(root)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(root)
  })

  it('插件级 detect 读取 $OPENCODE_HOME 覆盖的数据根', async () => {
    const prev = process.env.OPENCODE_HOME
    try {
      process.env.OPENCODE_HOME = tmpDir
      buildOpencodeDb(path.join(tmpDir, DB_SOURCE_SUFFIX), {})
      const res = await opencodePlugin.detect(ctx)
      expect(res.available).toBe(true)
      expect(res.sessionDir).toBe(tmpDir)
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_HOME
      else process.env.OPENCODE_HOME = prev
    }
  })
})

describe('listFilesFromRoot 收集范围', () => {
  it('db 存在时仅返回单条目（path 以 opencode.db 结尾，mtime>0）', () => {
    const root = path.join(tmpDir, 'opencode')
    fs.mkdirSync(path.join(root, 'storage', 'message'), { recursive: true })
    buildOpencodeDb(path.join(root, DB_SOURCE_SUFFIX), {})
    fs.writeFileSync(path.join(root, 'storage', 'message', 'old.json'), '{}')
    const entries = listFilesFromRoot(root)
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe(path.join(root, DB_SOURCE_SUFFIX))
    expect(entries[0].mtime).toBeGreaterThan(0)
  })

  it('主数据库与官方 prod 渠道数据库并存时全部列出', () => {
    const root = path.join(tmpDir, 'opencode')
    fs.mkdirSync(root, { recursive: true })
    const mainDb = path.join(root, DB_SOURCE_SUFFIX)
    const prodDb = path.join(root, CHANNEL_DB_NAMES[0])
    buildOpencodeDb(mainDb, {})
    buildOpencodeDb(prodDb, {})

    expect(listFilesFromRoot(root).map((entry) => entry.path)).toEqual([mainDb, prodDb])
  })

  it('无 db 时收集 storage/message/*.json + storage/session/**/*.json，忽略非候选文件', () => {
    const root = path.join(tmpDir, 'opencode')
    fs.mkdirSync(path.join(root, 'storage', 'message'), { recursive: true })
    const deep = path.join(root, 'storage', 'session', '2026', '08')
    fs.mkdirSync(deep, { recursive: true })
    fs.writeFileSync(path.join(root, 'storage', 'message', 'a.json'), '{}')
    fs.writeFileSync(path.join(root, 'storage', 'message', 'b.json'), '{}')
    fs.writeFileSync(path.join(root, 'storage', 'message', 'note.txt'), 'x')
    fs.writeFileSync(path.join(root, 'storage', 'message', 'tmp.json.tmp'), 'x')
    fs.writeFileSync(path.join(root, 'storage', 'message', '.hidden.json'), 'x')
    fs.writeFileSync(path.join(deep, 'c.json'), '{}')
    fs.writeFileSync(path.join(root, 'storage', 'session', 'loose.json'), '{}')
    const entries = listFilesFromRoot(root)
    expect(entries.map((e) => path.basename(e.path)).sort()).toEqual([
      'a.json',
      'b.json',
      'c.json',
      'loose.json'
    ])
    for (const e of entries) expect(e.mtime).toBeGreaterThan(0)
  })
})

describe('listFilesFromRoot WAL 感知 mtime', () => {
  function writeWithMtime(p: string, atMs: number): number {
    fs.writeFileSync(p, '')
    const t = new Date(atMs)
    fs.utimesSync(p, t, t)
    return Math.round(fs.statSync(p).mtimeMs)
  }

  it('db 与 -wal 同时存在且 wal 较新：条目 mtime 取两者较大值，path 仍为 db 路径', () => {
    const root = path.join(tmpDir, 'opencode')
    fs.mkdirSync(root, { recursive: true })
    const dbPath = path.join(root, DB_SOURCE_SUFFIX)
    const dbMtime = writeWithMtime(dbPath, Date.now() - 60_000)
    const walMtime = writeWithMtime(dbPath + '-wal', Date.now())
    const entries = listFilesFromRoot(root)
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe(dbPath)
    expect(entries[0].mtime).toBe(Math.max(dbMtime, walMtime))
    expect(entries[0].mtime).toBe(walMtime)
  })

  it('仅 db 无 -wal：条目 mtime 等于 db 自身 mtime', () => {
    const root = path.join(tmpDir, 'opencode')
    fs.mkdirSync(root, { recursive: true })
    const dbPath = path.join(root, DB_SOURCE_SUFFIX)
    const dbMtime = writeWithMtime(dbPath, Date.now() - 60_000)
    const entries = listFilesFromRoot(root)
    expect(entries).toHaveLength(1)
    expect(entries[0].mtime).toBe(dbMtime)
  })

  it('db 与 -wal 双缺：stat 兜底为 0（maxMtime 全失败 → 0）', () => {
    const missing = path.join(tmpDir, 'nope.db')
    expect(statMtimeMs(missing)).toBe(0)
    expect(maxMtime([missing, missing + '-wal'])).toBe(0)
    expect(maxMtime([])).toBe(0)
  })
})

describe('parseDbFile 解析与 rowid 水位游标', () => {
  it('assistant 消息产出完整 UsageRecord，project 来自 session.directory，source.line 使用数据库身份与 rowid 编码', () => {
    const dbPath = path.join(tmpDir, DB_SOURCE_SUFFIX)
    buildOpencodeDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/Users/a/opencode-proj' }],
      messages: [asstMsg({ id: 'm-1', time: 1_700_000_000_123 })]
    })
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({
      appType: 'opencode',
      model: 'glm-5.1',
      rawModel: 'glm-5.1',
      inputTokens: 123,
      outputTokens: 45,
      cacheReadTokens: 8,
      cacheCreationTokens: 3,
      inputSemantics: 2,
      status: 'success',
      project: '/Users/a/opencode-proj',
      sessionId: 'sess-1',
      createdAt: 1_700_000_000_123
    })
    expect(res.records[0].source).toEqual({
      filePath: DB_SOURCE_SUFFIX,
      line: res.nextLine,
      requestId: 'm-1'
    })
    expect(res.nextLine).toBeGreaterThanOrEqual(DB_CURSOR_MARKER)
    expect(res.eof).toBe(true)
  })

  it('非 assistant 与无 usage 等合法消息不产出，但 rowid 水位继续推进', () => {
    const dbPath = path.join(tmpDir, DB_SOURCE_SUFFIX)
    buildOpencodeDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      messages: [
        userMsg({ id: 'u-1', time: 1_000 }),
        asstMsg({ id: 'a-1', time: 2_000 }),
        {
          id: 'a-2',
          sessionId: 'sess-1',
          timeCreated: 3_000,
          data: { role: 'assistant', time: { created: 3_000 }, modelID: 'glm-5.1', tokens: undefined }
        },
        {
          id: 'a-3',
          sessionId: 'sess-1',
          timeCreated: 4_000,
          data: { role: 'assistant', time: { created: 4_000 }, tokens: { input: 1, output: 1 } }
        }
      ]
    })
    const first = parseDbFile(dbPath, 0)
    expect(first.records).toHaveLength(1)
    expect(first.records[0].source.line).toBeGreaterThanOrEqual(DB_CURSOR_MARKER)

    const db = new Database(dbPath)
    db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
    ).run('a-4', 'sess-1', 5_000, 5_000, JSON.stringify(asstMsg({ id: 'a-4', time: 5_000 }).data))
    db.close()

    const second = parseDbFile(dbPath, first.nextLine)
    expect(second.records).toHaveLength(1)
    expect(second.records[0].source.line).toBe(second.nextLine)
    expect(second.records[0].source.requestId).toBe('a-4')
  })

  it('rowid 增量可采集同时间戳晚插入消息，不受 time_created 顺序影响', () => {
    const dbPath = path.join(tmpDir, DB_SOURCE_SUFFIX)
    buildOpencodeDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      messages: [asstMsg({ id: 'm-1', time: 2_000 }), asstMsg({ id: 'm-2', time: 1_000 })]
    })
    const first = parseDbFile(dbPath, 0)
    expect(first.records[1].source.line).toBe(first.records[0].source.line + 1)

    const db = new Database(dbPath)
    db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
    ).run('m-3', 'sess-1', 1_000, 1_000, JSON.stringify(asstMsg({ id: 'm-3', time: 1_000 }).data))
    db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
    ).run('m-4', 'sess-1', 500, 500, JSON.stringify(asstMsg({ id: 'm-4', time: 500 }).data))
    db.close()

    const second = parseDbFile(dbPath, first.nextLine)
    expect(second.records[0].source.line).toBe(first.nextLine + 1)
    expect(second.records[1].source.line).toBe(first.nextLine + 2)
    expect(second.records.map((record) => record.source.requestId)).toEqual(['m-3', 'm-4'])

    const third = parseDbFile(dbPath, second.nextLine)
    expect(third.records).toHaveLength(0)
    expect(third.nextLine).toBe(second.nextLine)
  })

  it('旧版 time_created 数字游标会自愈为 rowid 游标并全量重读', () => {
    const dbPath = path.join(tmpDir, DB_SOURCE_SUFFIX)
    buildOpencodeDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      messages: [asstMsg({ id: 'm-1', time: 1_700_000_000_000 }), asstMsg({ id: 'm-2', time: 1_700_000_000_001 })]
    })

    const result = parseDbFile(dbPath, 1_700_000_000_001)
    expect(result.records.map((record) => record.source.requestId)).toEqual(['m-1', 'm-2'])
    expect(result.records[1].source.line).toBe(result.records[0].source.line + 1)
    expect(result.nextLine).toBeGreaterThanOrEqual(DB_CURSOR_MARKER)
  })

  it('同一毫秒多消息的 source.line 唯一且重复全量读取保持稳定', () => {
    const dbPath = path.join(tmpDir, DB_SOURCE_SUFFIX)
    buildOpencodeDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      messages: [asstMsg({ id: 'm-1', time: 1_000 }), asstMsg({ id: 'm-2', time: 1_000 })]
    })
    const first = parseDbFile(dbPath, 0)
    const second = parseDbFile(dbPath, 0)
    expect(first.records[1].source.line).toBe(first.records[0].source.line + 1)
    expect(second.records.map((record) => record.source.line)).toEqual(first.records.map((record) => record.source.line))
    expect(first.records.map((record) => record.source.requestId)).toEqual(['m-1', 'm-2'])
  })

  it('数据库重建且 rowid 回退时旧游标失效并全量读取新库', () => {
    const dbPath = path.join(tmpDir, DB_SOURCE_SUFFIX)
    buildOpencodeDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/old' }],
      messages: [
        asstMsg({ id: 'old-1', time: 1_000 }),
        asstMsg({ id: 'old-2', time: 2_000 }),
        asstMsg({ id: 'old-3', time: 3_000 })
      ]
    })
    const first = parseDbFile(dbPath, 0)

    fs.rmSync(dbPath)
    buildOpencodeDb(dbPath, {
      sessions: [{ id: 'sess-new', directory: '/new' }],
      messages: [{ ...asstMsg({ id: 'new-1', time: 4_000 }), sessionId: 'sess-new' }]
    })

    const second = parseDbFile(dbPath, first.nextLine)
    expect(second.records).toHaveLength(1)
    expect(second.records[0].source.filePath).toBe(DB_SOURCE_SUFFIX)
    expect(second.records[0].source.requestId).toBe('new-1')
    expect(second.records[0].source.line).toBe(second.nextLine)
    expect(second.records[0].source.line).not.toBe(first.records[0].source.line)
    expect(second.records[0].project).toBe('/new')
  })

  it('数据库缺失、缺表或缺必要列时抛出明确错误', () => {
    expect(() => parseDbFile(path.join(tmpDir, 'nope.db'), 0)).toThrow('无法以只读模式打开')

    const missingTable = path.join(tmpDir, 'missing-table.db')
    const db1 = new Database(missingTable)
    db1.exec('CREATE TABLE unrelated (x TEXT)')
    db1.close()
    expect(() => parseDbFile(missingTable, 42)).toThrow('缺少 message 表')

    const missingColumn = path.join(tmpDir, 'missing-column.db')
    const db2 = new Database(missingColumn)
    db2.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER);
    `)
    db2.close()
    expect(() => parseDbFile(missingColumn, 99)).toThrow('message 表缺少必要列：data')

    const missingSessionColumn = path.join(tmpDir, 'missing-session-column.db')
    const db3 = new Database(missingSessionColumn)
    db3.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
    `)
    db3.close()
    expect(() => parseDbFile(missingSessionColumn, 0)).toThrow('session 表缺少必要列：directory')
  })

  it('message.data 损坏或不是对象时抛错，修复后可从原游标重新读取', () => {
    const dbPath = path.join(tmpDir, DB_SOURCE_SUFFIX)
    buildOpencodeDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      messages: [{ ...asstMsg({ id: 'broken', time: 1_000 }), rawData: '{broken' }]
    })
    expect(() => parseDbFile(dbPath, 0)).toThrow('message.data 不是合法 JSON')

    const db = new Database(dbPath)
    db.prepare('UPDATE message SET data = ? WHERE id = ?').run(JSON.stringify(asstMsg({ id: 'broken', time: 1_000 }).data), 'broken')
    db.close()

    const fixed = parseDbFile(dbPath, 0)
    expect(fixed.records).toHaveLength(1)
    expect(fixed.records[0].source.requestId).toBe('broken')

    const nonObjectPath = path.join(tmpDir, 'non-object.db')
    buildOpencodeDb(nonObjectPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      messages: [{ ...asstMsg({ id: 'non-object', time: 2_000 }), rawData: '[]' }]
    })
    expect(() => parseDbFile(nonObjectPath, 0)).toThrow('message.data 不是消息对象')
  })
})

describe('parseJsonFile 旧版 JSON 源', () => {
  it('单对象 assistant 文件 → 单条记录 line 1；fromLine>0 已同步则跳过', () => {
    const file = path.join(tmpDir, 'storage', 'message', 'm-1.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(asstMsg({ id: 'm-1', time: 9_999 }).data), 'utf8')

    const r1 = parseJsonFile(file, 0)
    expect(r1.records).toHaveLength(1)
    expect(r1.records[0]).toMatchObject({
      appType: 'opencode',
      model: 'glm-5.1',
      inputTokens: 123,
      outputTokens: 45,
      cacheReadTokens: 8,
      cacheCreationTokens: 3,
      inputSemantics: 2,
      status: 'success',
      createdAt: 9_999,
      project: undefined,
      sessionId: undefined
    })
    expect(r1.records[0].source).toEqual({ filePath: file, line: 1 })
    expect(r1.nextLine).toBe(1)
    expect(r1.eof).toBe(true)

    const r2 = parseJsonFile(file, r1.nextLine)
    expect(r2.records).toHaveLength(0)
    expect(r2.nextLine).toBe(1)
    expect(r2.eof).toBe(true)
  })

  it('user 消息文件不产出记录', () => {
    const file = path.join(tmpDir, 'm-user.json')
    fs.writeFileSync(file, JSON.stringify(userMsg().data), 'utf8')
    const res = parseJsonFile(file, 0)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(1)
    expect(res.eof).toBe(true)
  })

  it('损坏/半写 JSON：空结果且游标停在原处（下次重试，不阻塞）', () => {
    const file = path.join(tmpDir, 'm-broken.json')
    fs.writeFileSync(file, '{"role":"assistant","tokens":{"input":', 'utf8')
    const res = parseJsonFile(file, 0)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(0)
    expect(res.eof).toBe(true)
  })

  it('数组文件多消息：逐条产出，line 1..N', () => {
    const file = path.join(tmpDir, 'm-arr.json')
    fs.writeFileSync(
      file,
      JSON.stringify([asstMsg({ id: 'm-1', time: 1 }).data, userMsg().data, asstMsg({ id: 'm-2', time: 2 }).data]),
      'utf8'
    )
    const res = parseJsonFile(file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records.map((r) => r.source.line)).toEqual([1, 3])
    expect(res.nextLine).toBe(3)
    expect(res.eof).toBe(true)
  })

  it('文件缺失 → 空结果且游标不推进', () => {
    const res = parseJsonFile(path.join(tmpDir, 'no.json'), 0)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(0)
    expect(res.eof).toBe(true)
  })
})

describe('语义 ID(source.requestId)透传', () => {
  it('db 源:message 行主键 id 写入 source.requestId', () => {
    const dbPath = path.join(tmpDir, DB_SOURCE_SUFFIX)
    buildOpencodeDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      messages: [asstMsg({ id: 'msg-db-1', time: 1_000 })]
    })
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source).toEqual({
      filePath: DB_SOURCE_SUFFIX,
      line: res.nextLine,
      requestId: 'msg-db-1'
    })
  })

  it('JSON 源:data.id 写入 source.requestId', () => {
    const file = path.join(tmpDir, 'with-id.json')
    const data = { ...(asstMsg({ time: 1 }).data as Record<string, unknown>), id: 'msg-json-1' }
    fs.writeFileSync(file, JSON.stringify(data), 'utf8')
    const res = parseJsonFile(file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.requestId).toBe('msg-json-1')
  })

  it('id 缺失/空白时不设 requestId(db 空串主键 + JSON 无 id 字段)', () => {
    const dbPath = path.join(tmpDir, DB_SOURCE_SUFFIX)
    buildOpencodeDb(dbPath, {
      sessions: [{ id: 'sess-1' }],
      messages: [{ id: '', sessionId: 'sess-1', timeCreated: 1_000, data: asstMsg({ time: 1_000 }).data }]
    })
    const r1 = parseDbFile(dbPath, 0)
    expect(r1.records).toHaveLength(1)
    expect(r1.records[0].source.requestId).toBeUndefined()

    const file = path.join(tmpDir, 'no-id.json')
    fs.writeFileSync(file, JSON.stringify(asstMsg({ time: 2 }).data), 'utf8')
    const r2 = parseJsonFile(file, 0)
    expect(r2.records).toHaveLength(1)
    expect(r2.records[0].source.requestId).toBeUndefined()
  })
})

describe('parseFile 双源分派', () => {
  it('core.dbNames 中的主库与 prod 渠道库均走数据库解析，其余文件走 JSON 解析', async () => {
    for (const dbName of [DB_SOURCE_SUFFIX, ...CHANNEL_DB_NAMES]) {
      const dbPath = path.join(tmpDir, dbName)
      buildOpencodeDb(dbPath, {
        sessions: [{ id: 'sess-1', directory: '/p' }],
        messages: [asstMsg({ id: `m-${dbName}`, time: 5_000 })]
      })
      const result = await opencodePlugin.parseFile(ctx, dbPath, 0)
      expect(result.records).toHaveLength(1)
      expect(result.records[0].source.filePath).toBe(DB_SOURCE_SUFFIX)
      expect(result.records[0].source.requestId).toBe(`m-${dbName}`)
    }

    const jsonPath = path.join(tmpDir, 'm-1.json')
    fs.writeFileSync(jsonPath, JSON.stringify(asstMsg({ id: 'm-1', time: 6_000 }).data), 'utf8')
    const jsonResult = await opencodePlugin.parseFile(ctx, jsonPath, 0)
    expect(jsonResult.records).toHaveLength(1)
    expect(jsonResult.records[0].source.filePath).toBe(jsonPath)
  })
})

describe('失败分支（T01 宽松 error 探测）', () => {
  it('assistant 消息含 error 字段的 JSON 文件产出 error 记录，tokens 保留，errorMessage/httpStatus 正确', () => {
    const file = path.join(tmpDir, 'err.json')
    const data = {
      ...(asstMsg({ time: 1_000 }).data as Record<string, unknown>),
      id: 'm-err',
      error: 'upstream timeout',
      httpStatus: 504
    }
    fs.writeFileSync(file, JSON.stringify(data), 'utf8')
    const res = parseJsonFile(file, 0)
    expect(res.records).toHaveLength(1)
    const r = res.records[0]
    expect(r.status).toBe('error')
    expect(r.errorMessage).toBe('upstream timeout')
    expect(r.httpStatus).toBe(504)
    expect(r.inputTokens).toBe(123)
    expect(r.outputTokens).toBe(45)
    expect(r.source.requestId).toBe('m-err')
  })

  it('status 异常的 assistant 消息产出 error，errorMessage 取 status 文案兜底', () => {
    const file = path.join(tmpDir, 'status-err.json')
    const data = {
      ...(asstMsg({ time: 2_000 }).data as Record<string, unknown>),
      status: 'failed',
      id: 'm-status'
    }
    fs.writeFileSync(file, JSON.stringify(data), 'utf8')
    const res = parseJsonFile(file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].status).toBe('error')
    expect(res.records[0].errorMessage).toBe('failed')
  })

  it('error 为对象时宽松提取 message，httpStatus 从嵌套取', () => {
    const file = path.join(tmpDir, 'obj-err.json')
    const data = {
      ...(asstMsg({ time: 3_000 }).data as Record<string, unknown>),
      error: { message: 'model overloaded', httpStatus: 503 }
    }
    fs.writeFileSync(file, JSON.stringify(data), 'utf8')
    const res = parseJsonFile(file, 0)
    expect(res.records[0].errorMessage).toBe('model overloaded')
    expect(res.records[0].httpStatus).toBe(503)
    expect(res.records[0].status).toBe('error')
  })

  it('失败时无 tokens 仍产出，tokens 全 0', () => {
    const file = path.join(tmpDir, 'no-tokens-err.json')
    const data = {
      role: 'assistant',
      time: { created: 4_000 },
      modelID: 'glm-5.1',
      id: 'm-no-tokens',
      error: 'no tokens but failed'
    }
    fs.writeFileSync(file, JSON.stringify(data), 'utf8')
    const res = parseJsonFile(file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].status).toBe('error')
    expect(res.records[0].inputTokens).toBe(0)
    expect(res.records[0].outputTokens).toBe(0)
  })

  it('errorMessage 超 500 截断', () => {
    const file = path.join(tmpDir, 'long-err.json')
    const longMsg = 'e'.repeat(600)
    const data = {
      ...(asstMsg({ time: 5_000 }).data as Record<string, unknown>),
      error: longMsg
    }
    fs.writeFileSync(file, JSON.stringify(data), 'utf8')
    const res = parseJsonFile(file, 0)
    expect(res.records[0].errorMessage!.length).toBe(500)
  })

  it('中断 cancelled/interrupted 忽略不产记录', () => {
    const file1 = path.join(tmpDir, 'cancelled.json')
    const file2 = path.join(tmpDir, 'interrupted.json')
    const d1 = { ...(asstMsg({ time: 6_000 }).data as Record<string, unknown>), error: 'cancelled', id: 'm-cancel' }
    const d2 = { ...(asstMsg({ time: 6_001 }).data as Record<string, unknown>), status: 'interrupted', id: 'm-inter' }
    fs.writeFileSync(file1, JSON.stringify(d1), 'utf8')
    fs.writeFileSync(file2, JSON.stringify(d2), 'utf8')
    expect(parseJsonFile(file1, 0).records).toHaveLength(0)
    expect(parseJsonFile(file2, 0).records).toHaveLength(0)
  })

  it('db 源 SQLite 附加 error 列亦产出 error（宽松兼容）', () => {
    const dbPath = path.join(tmpDir, DB_SOURCE_SUFFIX)
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, error TEXT);
    `)
    const data = asstMsg({ id: 'm-db-err', time: 7_000 }).data as Record<string, unknown>
    db.prepare('INSERT INTO session (id, directory) VALUES (?, ?)').run('sess-1', '/p')
    db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data, error) VALUES (?, ?, ?, ?, ?, ?)').run(
      'm-db-err',
      'sess-1',
      7_000,
      7_000,
      JSON.stringify(data),
      'db column error'
    )
    db.close()
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].status).toBe('error')
    expect(res.records[0].errorMessage).toBe('db column error')
  })

  it('db 源 data 内 error 与 db 列同时存在时以 data 优先', () => {
    const dbPath2 = path.join(tmpDir, 'opencode2.db')
    const db = new Database(dbPath2)
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT, error TEXT);
    `)
    const dataWithErr = {
      ...(asstMsg({ id: 'm-both', time: 8_000 }).data as Record<string, unknown>),
      error: 'data error'
    }
    db.prepare('INSERT INTO session (id, directory) VALUES (?, ?)').run('sess-1', '/p')
    db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data, error) VALUES (?, ?, ?, ?, ?, ?)').run(
      'm-both',
      'sess-1',
      8_000,
      8_000,
      JSON.stringify(dataWithErr),
      'column error'
    )
    db.close()
    const res = parseDbFile(dbPath2, 0)
    expect(res.records[0].errorMessage).toBe('data error')
  })

  it('非 assistant 角色即使含 error 也不产出', () => {
    const file = path.join(tmpDir, 'user-err.json')
    fs.writeFileSync(file, JSON.stringify({ role: 'user', error: 'should ignore' }), 'utf8')
    expect(parseJsonFile(file, 0).records).toHaveLength(0)
  })
})
