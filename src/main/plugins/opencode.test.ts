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
  DB_SOURCE_SUFFIX
} from './opencode'
import type { PluginContext } from '../../../shared/context'

/** parseFile 不使用 ctx 上的服务，测试时给个空壳即可 */
const ctx = {} as PluginContext

let tmpDir = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** 构造 opencode 风格 SQLite（message + session 表） */
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
    insM.run(m.id, m.sessionId ?? null, m.timeCreated, m.timeUpdated ?? m.timeCreated, JSON.stringify(m.data))
  }
  db.close()
}

/** assistant 消息样例（db 行：data JSON + time_created 列；字段可覆盖） */
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

/** user 消息样例（无 tokens，不应产出记录） */
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

describe('parseDbFile 解析与水位游标', () => {
  it('assistant 消息产出完整 UsageRecord，project 来自 session.directory，line=time_created', () => {
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
      inputSemantics: 1,
      status: 'success',
      project: '/Users/a/opencode-proj',
      sessionId: 'sess-1',
      createdAt: 1_700_000_000_123
    })
    expect(res.records[0].source).toEqual({ filePath: DB_SOURCE_SUFFIX, line: 1_700_000_000_123 })
    expect(res.nextLine).toBe(1_700_000_000_123)
    expect(res.eof).toBe(true)
  })

  it('user 行与无 tokens/无 modelID 的 assistant 行不产出记录，但水位仍推进', () => {
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
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.line).toBe(2_000)
    expect(res.nextLine).toBe(4_000) // 水位覆盖所有新行（含未产出记录的行）
    expect(res.eof).toBe(true)
  })

  it('水位游标增量：只处理 time_created > fromLine 的行，nextLine 返回本次最大 time_created', () => {
    const dbPath = path.join(tmpDir, DB_SOURCE_SUFFIX)
    buildOpencodeDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      messages: [asstMsg({ id: 'm-1', time: 1_000 }), asstMsg({ id: 'm-2', time: 2_000 })]
    })
    const r1 = parseDbFile(dbPath, 0)
    expect(r1.records).toHaveLength(2)
    expect(r1.records.map((r) => r.source.line)).toEqual([1_000, 2_000])
    expect(r1.nextLine).toBe(2_000)

    // 追加更新的消息后再解析：只产出新增（time > 2_000）
    const db = new Database(dbPath)
    db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
    ).run('m-3', 'sess-1', 3_000, 3_000, JSON.stringify(asstMsg({ id: 'm-3', time: 3_000 }).data))
    db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
    ).run('m-4', 'sess-1', 4_000, 4_000, JSON.stringify(asstMsg({ id: 'm-4', time: 4_000 }).data))
    db.close()

    const r2 = parseDbFile(dbPath, r1.nextLine)
    expect(r2.records).toHaveLength(2)
    expect(r2.records.map((r) => r.source.line).sort((a, b) => a - b)).toEqual([3_000, 4_000])
    expect(r2.nextLine).toBe(4_000)
    expect(r2.eof).toBe(true)

    // 无新增：nextLine 返回原 fromLine
    const r3 = parseDbFile(dbPath, r2.nextLine)
    expect(r3.records).toHaveLength(0)
    expect(r3.nextLine).toBe(4_000)
    expect(r3.eof).toBe(true)
  })

  it('同一毫秒多消息：line 单调递增保持去重唯一', () => {
    const dbPath = path.join(tmpDir, DB_SOURCE_SUFFIX)
    buildOpencodeDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      messages: [asstMsg({ id: 'm-1', time: 1_000 }), asstMsg({ id: 'm-2', time: 1_000 })]
    })
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(2)
    const lines = res.records.map((r) => r.source.line)
    expect(new Set(lines).size).toBe(2)
    expect(lines[0]).toBeLessThan(lines[1])
    expect(res.nextLine).toBe(1_000)
  })

  it('db 缺失 / message 表不存在 → 空结果且游标不推进', () => {
    const missing = path.join(tmpDir, 'nope.db')
    const r1 = parseDbFile(missing, 0)
    expect(r1.records).toHaveLength(0)
    expect(r1.nextLine).toBe(0)
    expect(r1.eof).toBe(true)

    // 仅含空库（无 message 表）
    const emptyDb = path.join(tmpDir, 'empty.db')
    const db = new Database(emptyDb)
    db.exec('CREATE TABLE unrelated (x TEXT)')
    db.close()
    const r2 = parseDbFile(emptyDb, 42)
    expect(r2.records).toHaveLength(0)
    expect(r2.nextLine).toBe(42)
    expect(r2.eof).toBe(true)
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
      inputSemantics: 1,
      status: 'success',
      createdAt: 9_999,
      project: undefined,
      sessionId: undefined
    })
    expect(r1.records[0].source).toEqual({ filePath: file, line: 1 })
    expect(r1.nextLine).toBe(1)
    expect(r1.eof).toBe(true)

    // 文件未变 + fromLine>0：跳过，游标不倒退
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

describe('parseFile 双源分派', () => {
  it('path 以 opencode.db 结尾走 db 源，否则走 JSON 源', async () => {
    const dbPath = path.join(tmpDir, DB_SOURCE_SUFFIX)
    buildOpencodeDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      messages: [asstMsg({ id: 'm-1', time: 5_000 })]
    })
    const r1 = await opencodePlugin.parseFile(ctx, dbPath, 0)
    expect(r1.records).toHaveLength(1)
    expect(r1.records[0].source.filePath).toBe(DB_SOURCE_SUFFIX)

    const jsonPath = path.join(tmpDir, 'm-1.json')
    fs.writeFileSync(jsonPath, JSON.stringify(asstMsg({ id: 'm-1', time: 6_000 }).data), 'utf8')
    const r2 = await opencodePlugin.parseFile(ctx, jsonPath, 0)
    expect(r2.records).toHaveLength(1)
    expect(r2.records[0].source.filePath).toBe(jsonPath)
  })
})
