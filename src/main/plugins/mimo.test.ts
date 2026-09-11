import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import {
  mimoPlugin,
  defaultDataRoot,
  homeLayoutRoot,
  dbCandidates,
  detectFromLayouts,
  listFilesFromLayouts,
  parseDbFile,
  DB_SOURCE_SUFFIX,
  CHANNEL_DB_NAMES,
  MIMOCODE_DB_ENV,
  MIMOCODE_HOME_ENV,
  MIMO_DIR_ENV,
  HOME_LAYOUT_DATA_SUBDIR
} from './mimo'
import type { PluginContext } from '../../../shared/context'

const ctx = {} as PluginContext
const DB_CURSOR_MARKER = 2 ** 52

let tmpDir = ''
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-plugin-'))
  savedEnv = {
    [MIMOCODE_DB_ENV]: process.env[MIMOCODE_DB_ENV],
    [MIMOCODE_HOME_ENV]: process.env[MIMOCODE_HOME_ENV],
    [MIMO_DIR_ENV]: process.env[MIMO_DIR_ENV]
  }
  delete process.env[MIMOCODE_DB_ENV]
  delete process.env[MIMOCODE_HOME_ENV]
  process.env[MIMO_DIR_ENV] = tmpDir
})

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function buildMimocodeDb(
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
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
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
      modelID: o.modelID ?? 'mimo-v2',
      providerID: 'xiaomi',
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

describe('mimoPlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(mimoPlugin.id).toBe('mimo')
    expect(mimoPlugin.name).toBe('MiMo Code')
    expect(mimoPlugin.version).toBe('1.0.0')
    expect(mimoPlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('dbCandidates 解析优先级', () => {
  it('无覆盖变量时列出默认布局三名候选，根取 $MIMO_DIR 覆盖值', () => {
    expect(defaultDataRoot()).toBe(tmpDir)
    const expected = [DB_SOURCE_SUFFIX, ...CHANNEL_DB_NAMES].map((n) => path.join(tmpDir, n))
    expect(dbCandidates()).toEqual(expected)
  })

  it('$MIMOCODE_DB 设置时成为唯一候选（默认布局存在 db 也不列入）', () => {
    buildMimocodeDb(path.join(tmpDir, DB_SOURCE_SUFFIX), {})
    const external = path.join(tmpDir, 'external', 'custom.db')
    fs.mkdirSync(path.dirname(external), { recursive: true })
    process.env[MIMOCODE_DB_ENV] = external
    expect(dbCandidates()).toEqual([external])
  })

  it('$MIMOCODE_DB 空白值视为未设置，回落布局候选', () => {
    process.env[MIMOCODE_DB_ENV] = '   '
    expect(dbCandidates()).toEqual([DB_SOURCE_SUFFIX, ...CHANNEL_DB_NAMES].map((n) => path.join(tmpDir, n)))
  })

  it('$MIMOCODE_HOME 设置时追加 home/data 布局三名候选，排在默认布局之后', () => {
    const home = path.join(tmpDir, 'home')
    process.env[MIMOCODE_HOME_ENV] = home
    expect(homeLayoutRoot(home)).toBe(path.join(home, HOME_LAYOUT_DATA_SUBDIR))
    expect(dbCandidates()).toEqual([
      ...[DB_SOURCE_SUFFIX, ...CHANNEL_DB_NAMES].map((n) => path.join(tmpDir, n)),
      ...[DB_SOURCE_SUFFIX, ...CHANNEL_DB_NAMES].map((n) => path.join(home, HOME_LAYOUT_DATA_SUBDIR, n))
    ])
  })

  it('$MIMOCODE_HOME 空白值视为未设置，不追加 home 布局候选', () => {
    process.env[MIMOCODE_HOME_ENV] = '  '
    expect(dbCandidates()).toHaveLength(3)
  })

  it('$MIMO_DIR 空白值视为未设置，回落默认根 ~/.local/share/mimocode', () => {
    process.env[MIMO_DIR_ENV] = '  '
    expect(defaultDataRoot()).toBe(path.join(os.homedir(), '.local', 'share', 'mimocode'))
    expect(dbCandidates()[0]).toBe(path.join(os.homedir(), '.local', 'share', 'mimocode', DB_SOURCE_SUFFIX))
  })
})

describe('detectFromLayouts 三态', () => {
  it('$MIMOCODE_DB 指向存在的库文件时可用，sessionDir 为其所在目录', () => {
    const external = path.join(tmpDir, 'external', 'custom.db')
    fs.mkdirSync(path.dirname(external), { recursive: true })
    buildMimocodeDb(external, {})
    process.env[MIMOCODE_DB_ENV] = external
    const res = detectFromLayouts()
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(path.dirname(external))
  })

  it('$MIMOCODE_DB 指向不存在的文件时不可用并给出原因', () => {
    process.env[MIMOCODE_DB_ENV] = path.join(tmpDir, 'missing.db')
    const res = detectFromLayouts()
    expect(res.available).toBe(false)
    expect(res.reason).toContain('MIMOCODE_DB')
    expect(res.sessionDir).toBe(path.dirname(path.join(tmpDir, 'missing.db')))
  })

  it('默认布局存在 channel 变体 db 时可用', () => {
    buildMimocodeDb(path.join(tmpDir, CHANNEL_DB_NAMES[0]), {})
    const res = detectFromLayouts()
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(tmpDir)
  })

  it('$MIMOCODE_HOME/data 布局存在 db 时可用', () => {
    const home = path.join(tmpDir, 'home')
    process.env[MIMOCODE_HOME_ENV] = home
    buildMimocodeDb(path.join(home, HOME_LAYOUT_DATA_SUBDIR, DB_SOURCE_SUFFIX), {})
    const res = detectFromLayouts()
    expect(res.available).toBe(true)
  })

  it('默认布局与 home 布局全缺时不可用，reason 说明默认路径与覆盖变量', () => {
    const res = detectFromLayouts()
    expect(res.available).toBe(false)
    expect(res.reason).toContain('mimocode')
    expect(res.reason).toContain('MIMOCODE_DB')
    expect(res.reason).toContain('MIMOCODE_HOME')
    expect(res.sessionDir).toBe(tmpDir)
  })

  it('插件级 detect 走环境变量注入的布局', async () => {
    buildMimocodeDb(path.join(tmpDir, DB_SOURCE_SUFFIX), {})
    const res = await mimoPlugin.detect(ctx)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(tmpDir)
  })
})

describe('listFilesFromLayouts 收集与 WAL mtime', () => {
  function writeWithMtime(p: string, atMs: number): number {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '')
    const t = new Date(atMs)
    fs.utimesSync(p, t, t)
    return Math.round(fs.statSync(p).mtimeMs)
  }

  it('多布局多候选全部列出，WAL 较新时条目 mtime 取 max(db, wal)，path 仍为 db 路径', () => {
    const home = path.join(tmpDir, 'home')
    process.env[MIMOCODE_HOME_ENV] = home
    const mainDb = path.join(tmpDir, DB_SOURCE_SUFFIX)
    const betaDb = path.join(tmpDir, CHANNEL_DB_NAMES[0])
    const prodDb = path.join(home, HOME_LAYOUT_DATA_SUBDIR, CHANNEL_DB_NAMES[1])
    const dbMtime = writeWithMtime(mainDb, Date.now() - 60_000)
    const walMtime = writeWithMtime(mainDb + '-wal', Date.now())
    writeWithMtime(betaDb, Date.now() - 30_000)
    writeWithMtime(prodDb, Date.now() - 10_000)
    const entries = listFilesFromLayouts()
    expect(entries.map((e) => e.path)).toEqual([mainDb, betaDb, prodDb])
    const main = entries.find((e) => e.path === mainDb)!
    expect(main.mtime).toBe(Math.max(dbMtime, walMtime))
    expect(main.mtime).toBe(walMtime)
    for (const e of entries) expect(e.mtime).toBeGreaterThan(0)
  })

  it('仅 db 无 -wal 时 mtime 等于 db 自身 mtime；不存在的候选不列出', () => {
    const mainDb = path.join(tmpDir, DB_SOURCE_SUFFIX)
    const dbMtime = writeWithMtime(mainDb, Date.now() - 60_000)
    const entries = listFilesFromLayouts()
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe(mainDb)
    expect(entries[0].mtime).toBe(dbMtime)
  })

  it('无任何 db 时返回空数组', () => {
    expect(listFilesFromLayouts()).toEqual([])
  })
})

describe('parseDbFile / parseFile 的 rowid 游标与映射', () => {
  it('assistant 消息保持四桶、semantics=2、稳定 requestId 与项目映射', async () => {
    const dbPath = path.join(tmpDir, DB_SOURCE_SUFFIX)
    buildMimocodeDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/work/mimo-proj' }],
      messages: [asstMsg({ id: 'msg-1', time: 1_700_000_000_123 })]
    })
    const res = await mimoPlugin.parseFile(ctx, dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({
      appType: 'mimo',
      model: 'mimo-v2',
      rawModel: 'mimo-v2',
      inputTokens: 123,
      outputTokens: 45,
      cacheReadTokens: 8,
      cacheCreationTokens: 3,
      inputSemantics: 2,
      status: 'success',
      project: '/work/mimo-proj',
      sessionId: 'sess-1',
      createdAt: 1_700_000_000_123
    })
    expect(res.records[0].source).toEqual({
      filePath: DB_SOURCE_SUFFIX,
      line: res.nextLine,
      requestId: 'msg-1'
    })
    expect(res.nextLine).toBeGreaterThanOrEqual(DB_CURSOR_MARKER)
    expect(res.eof).toBe(true)
  })

  it('主库、beta 与 prod 数据库均复用相同解析器', async () => {
    for (const dbName of [DB_SOURCE_SUFFIX, ...CHANNEL_DB_NAMES]) {
      const dbPath = path.join(tmpDir, dbName)
      buildMimocodeDb(dbPath, {
        sessions: [{ id: 'sess-1', directory: '/p' }],
        messages: [asstMsg({ id: `m-${dbName}`, time: 1_000 })]
      })
      const res = await mimoPlugin.parseFile(ctx, dbPath, 0)
      expect(res.records[0].source.filePath).toBe(DB_SOURCE_SUFFIX)
      expect(res.records[0].source.requestId).toBe(`m-${dbName}`)
    }
  })

  it('合法无用量消息不产出，但 rowid 水位继续推进', () => {
    const dbPath = path.join(tmpDir, DB_SOURCE_SUFFIX)
    buildMimocodeDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      messages: [
        userMsg({ id: 'u-1', time: 1_000 }),
        asstMsg({ id: 'a-1', time: 2_000 }),
        {
          id: 'a-2',
          sessionId: 'sess-1',
          timeCreated: 3_000,
          data: { role: 'assistant', time: { created: 3_000 }, modelID: 'mimo-v2', tokens: undefined }
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
    expect(first.records[0].source.requestId).toBe('a-1')
    expect(first.nextLine).toBeGreaterThan(first.records[0].source.line)
    expect(parseDbFile(dbPath, first.nextLine).records).toHaveLength(0)
  })

  it('rowid 增量采集同时间戳晚插入和时间倒序消息', () => {
    const dbPath = path.join(tmpDir, DB_SOURCE_SUFFIX)
    buildMimocodeDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      messages: [asstMsg({ id: 'm-1', time: 2_000 }), asstMsg({ id: 'm-2', time: 1_000 })]
    })
    const first = parseDbFile(dbPath, 0)

    const db = new Database(dbPath)
    const insert = db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
    )
    insert.run('m-3', 'sess-1', 1_000, 1_000, JSON.stringify(asstMsg({ id: 'm-3', time: 1_000 }).data))
    insert.run('m-4', 'sess-1', 500, 500, JSON.stringify(asstMsg({ id: 'm-4', time: 500 }).data))
    db.close()

    const second = parseDbFile(dbPath, first.nextLine)
    expect(second.records.map((record) => record.source.requestId)).toEqual(['m-3', 'm-4'])
    expect(second.records.map((record) => record.source.line)).toEqual([first.nextLine + 1, first.nextLine + 2])
    expect(parseDbFile(dbPath, second.nextLine).records).toHaveLength(0)
  })

  it('旧 time_created 数字游标自愈为编码 rowid 游标并全量重读', () => {
    const dbPath = path.join(tmpDir, DB_SOURCE_SUFFIX)
    buildMimocodeDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      messages: [asstMsg({ id: 'm-1', time: 1_700_000_000_000 }), asstMsg({ id: 'm-2', time: 1_700_000_000_001 })]
    })
    const res = parseDbFile(dbPath, 1_700_000_000_001)
    expect(res.records.map((record) => record.source.requestId)).toEqual(['m-1', 'm-2'])
    expect(res.nextLine).toBeGreaterThanOrEqual(DB_CURSOR_MARKER)
  })

  it('数据库重建且 rowid 回退时旧游标失效并读取新库', () => {
    const dbPath = path.join(tmpDir, DB_SOURCE_SUFFIX)
    buildMimocodeDb(dbPath, {
      sessions: [{ id: 'old-session', directory: '/old' }],
      messages: [
        { ...asstMsg({ id: 'old-1', time: 1_000 }), sessionId: 'old-session' },
        { ...asstMsg({ id: 'old-2', time: 2_000 }), sessionId: 'old-session' }
      ]
    })
    const first = parseDbFile(dbPath, 0)

    fs.rmSync(dbPath)
    buildMimocodeDb(dbPath, {
      sessions: [{ id: 'new-session', directory: '/new' }],
      messages: [{ ...asstMsg({ id: 'new-1', time: 3_000 }), sessionId: 'new-session' }]
    })
    const second = parseDbFile(dbPath, first.nextLine)
    expect(second.records).toHaveLength(1)
    expect(second.records[0].source.requestId).toBe('new-1')
    expect(second.records[0].project).toBe('/new')
    expect(second.records[0].source.line).not.toBe(first.records[0].source.line)
  })

  it('重复全量读取保持 source.line 与 requestId 稳定', () => {
    const dbPath = path.join(tmpDir, DB_SOURCE_SUFFIX)
    buildMimocodeDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      messages: [asstMsg({ id: 'm-1', time: 1_000 }), asstMsg({ id: 'm-2', time: 1_000 })]
    })
    const first = parseDbFile(dbPath, 0)
    const second = parseDbFile(dbPath, 0)
    expect(second.records.map((record) => record.source)).toEqual(first.records.map((record) => record.source))
  })
})

describe('数据库错误可见性', () => {
  it('数据库缺失、损坏、缺表、缺列和损坏消息均抛出明确错误', () => {
    expect(() => parseDbFile(path.join(tmpDir, 'missing.db'), 0)).toThrow('无法以只读模式打开')

    const brokenDb = path.join(tmpDir, 'broken.db')
    fs.writeFileSync(brokenDb, 'not sqlite', 'utf8')
    expect(() => parseDbFile(brokenDb, 0)).toThrow()

    const missingTable = path.join(tmpDir, 'missing-table.db')
    const db1 = new Database(missingTable)
    db1.exec('CREATE TABLE unrelated (x TEXT)')
    db1.close()
    expect(() => parseDbFile(missingTable, 0)).toThrow('缺少 message 表')

    const missingColumn = path.join(tmpDir, 'missing-column.db')
    const db2 = new Database(missingColumn)
    db2.exec('CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER);')
    db2.close()
    expect(() => parseDbFile(missingColumn, 0)).toThrow('message 表缺少必要列：data')

    const invalidJson = path.join(tmpDir, 'invalid-json.db')
    buildMimocodeDb(invalidJson, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      messages: [{ ...asstMsg({ id: 'broken-json', time: 1_000 }), rawData: '{broken' }]
    })
    expect(() => parseDbFile(invalidJson, 0)).toThrow('message.data 不是合法 JSON')
  })
})
