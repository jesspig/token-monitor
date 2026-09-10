import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import {
  devEcoPlugin,
  dataRoot,
  detectFromRoot,
  listFilesFromRoot,
  parseDbFile,
  statMtimeMs,
  maxMtime,
  DB_SOURCE_SUFFIX
} from './dev-eco'
import type { PluginContext } from '../../../shared/context'

const ctx = {} as PluginContext

let tmpDir = ''

const envKeys = ['DEVECO_DIR', 'XDG_DATA_HOME', 'DEVECO_DB'] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-eco-plugin-'))
  for (const k of envKeys) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  for (const k of envKeys) {
    const v = savedEnv[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

function buildDevEcoDb(
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
    insM.run(m.id, m.sessionId ?? null, m.timeCreated, m.timeUpdated ?? m.timeCreated, JSON.stringify(m.data))
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
      modelID: o.modelID ?? 'deepseek-chat',
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

describe('devEcoPlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(devEcoPlugin.id).toBe('dev-eco')
    expect(devEcoPlugin.name).toBe('DevEco Code')
    expect(devEcoPlugin.version).toBe('1.0.0')
    expect(devEcoPlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('dataRoot 路径解析', () => {
  it('DEVECO_DIR 优先于 XDG_DATA_HOME 与默认路径', () => {
    process.env.DEVECO_DIR = path.join(tmpDir, 'deveco-home')
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'xdg')
    expect(dataRoot()).toBe(path.join(tmpDir, 'deveco-home'))
  })

  it('仅 XDG_DATA_HOME 时使用 $XDG_DATA_HOME/deveco', () => {
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'xdg')
    expect(dataRoot()).toBe(path.join(tmpDir, 'xdg', 'deveco'))
  })

  it('无任何覆盖时默认 ~/.local/share/deveco', () => {
    expect(dataRoot()).toBe(path.join(os.homedir(), '.local', 'share', 'deveco'))
  })

  it('空白值视为未设置：DEVECO_DIR 空白落到 XDG 档，XDG 空白落到默认档', () => {
    process.env.DEVECO_DIR = '   '
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'xdg')
    expect(dataRoot()).toBe(path.join(tmpDir, 'xdg', 'deveco'))

    process.env.DEVECO_DIR = '   '
    process.env.XDG_DATA_HOME = '   '
    expect(dataRoot()).toBe(path.join(os.homedir(), '.local', 'share', 'deveco'))
  })
})

describe('detect 探测三态', () => {
  it('数据根缺失时不可用，reason 说明默认路径与 DEVECO_DIR/DEVECO_DB 覆盖', () => {
    const root = path.join(tmpDir, 'deveco')
    const res = detectFromRoot(root)
    expect(res.available).toBe(false)
    expect(res.reason).toContain('~/.local/share/deveco')
    expect(res.reason).toContain('$DEVECO_DIR')
    expect(res.reason).toContain('$DEVECO_DB')
    expect(res.sessionDir).toBe(root)
  })

  it('数据根存在但无任何候选 db 时不可用并说明未产生会话', () => {
    const root = path.join(tmpDir, 'deveco')
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'notes.txt'), 'x', 'utf8')
    const res = detectFromRoot(root)
    expect(res.available).toBe(false)
    expect(res.reason).toContain('deveco.db')
    expect(res.sessionDir).toBe(root)
  })

  it('存在 deveco.db 时可用', () => {
    const root = path.join(tmpDir, 'deveco')
    fs.mkdirSync(root, { recursive: true })
    buildDevEcoDb(path.join(root, DB_SOURCE_SUFFIX), {})
    const res = detectFromRoot(root)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(root)
  })

  it('仅有 channel 变体 deveco-beta.db 时也可用', () => {
    const root = path.join(tmpDir, 'deveco')
    fs.mkdirSync(root, { recursive: true })
    buildDevEcoDb(path.join(root, 'deveco-beta.db'), {})
    const res = detectFromRoot(root)
    expect(res.available).toBe(true)
  })

  it('插件级 detect 读取 $DEVECO_DIR 覆盖的数据根', async () => {
    process.env.DEVECO_DIR = tmpDir
    buildDevEcoDb(path.join(tmpDir, DB_SOURCE_SUFFIX), {})
    const res = await devEcoPlugin.detect(ctx)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(tmpDir)
  })
})

describe('DEVECO_DB 整体覆盖', () => {
  it('覆盖文件存在时 detect 可用且 sessionDir 为其所在目录，listFiles 返回该文件', async () => {
    const override = path.join(tmpDir, 'override', 'custom.db')
    buildDevEcoDb(override, {})
    process.env.DEVECO_DB = override

    const res = await devEcoPlugin.detect(ctx)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(path.dirname(override))

    const files = await devEcoPlugin.listFiles(ctx)
    expect(files.map((f) => f.path)).toEqual([override])
    expect(files[0].mtime).toBeGreaterThan(0)
  })

  it('覆盖文件不存在时 detect 不可用、listFiles 为空', async () => {
    process.env.DEVECO_DB = path.join(tmpDir, 'missing', 'custom.db')
    const res = await devEcoPlugin.detect(ctx)
    expect(res.available).toBe(false)
    expect(res.reason).toContain('$DEVECO_DB')
    expect(await devEcoPlugin.listFiles(ctx)).toEqual([])
  })

  it('覆盖优先于数据根下的候选 db，且不影响 dataRoot 本身', () => {
    const root = path.join(tmpDir, 'deveco')
    fs.mkdirSync(root, { recursive: true })
    buildDevEcoDb(path.join(root, DB_SOURCE_SUFFIX), {})
    const override = path.join(tmpDir, 'override', 'custom.db')
    buildDevEcoDb(override, {})
    process.env.DEVECO_DB = override

    expect(detectFromRoot(root).sessionDir).toBe(path.dirname(override))
    expect(listFilesFromRoot(root).map((f) => f.path)).toEqual([override])
    expect(dataRoot()).toBe(path.join(os.homedir(), '.local', 'share', 'deveco'))
  })
})

describe('listFilesFromRoot 收集范围', () => {
  it('列出主 db 与 channel 变体，忽略无关文件', () => {
    const root = path.join(tmpDir, 'deveco')
    fs.mkdirSync(root, { recursive: true })
    buildDevEcoDb(path.join(root, DB_SOURCE_SUFFIX), {})
    buildDevEcoDb(path.join(root, 'deveco-beta.db'), {})
    buildDevEcoDb(path.join(root, 'deveco-prod.db'), {})
    fs.writeFileSync(path.join(root, 'other.db'), 'x')
    fs.writeFileSync(path.join(root, 'deveco-old.db'), 'x')

    const entries = listFilesFromRoot(root)
    expect(entries.map((e) => path.basename(e.path)).sort()).toEqual([
      'deveco-beta.db',
      'deveco-prod.db',
      'deveco.db'
    ])
    for (const e of entries) expect(e.mtime).toBeGreaterThan(0)
  })

  it('WAL 较新时条目 mtime 取 db 与 -wal 较大值，path 仍为 db 路径', () => {
    const root = path.join(tmpDir, 'deveco')
    fs.mkdirSync(root, { recursive: true })
    const dbPath = path.join(root, DB_SOURCE_SUFFIX)
    const writeWithMtime = (p: string, atMs: number): number => {
      fs.writeFileSync(p, '')
      const t = new Date(atMs)
      fs.utimesSync(p, t, t)
      return Math.round(fs.statSync(p).mtimeMs)
    }
    const dbMtime = writeWithMtime(dbPath, Date.now() - 60_000)
    const walMtime = writeWithMtime(dbPath + '-wal', Date.now())

    const entries = listFilesFromRoot(root)
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe(dbPath)
    expect(entries[0].mtime).toBe(Math.max(dbMtime, walMtime))
  })

  it('仅 db 无 -wal 时 mtime 等于 db 自身 mtime；stat 失败兜底为 0', () => {
    const root = path.join(tmpDir, 'deveco')
    fs.mkdirSync(root, { recursive: true })
    const dbPath = path.join(root, DB_SOURCE_SUFFIX)
    buildDevEcoDb(dbPath, {})
    const dbMtime = statMtimeMs(dbPath)

    const entries = listFilesFromRoot(root)
    expect(entries).toHaveLength(1)
    expect(entries[0].mtime).toBe(dbMtime)

    const missing = path.join(tmpDir, 'nope.db')
    expect(statMtimeMs(missing)).toBe(0)
    expect(maxMtime([missing, missing + '-wal'])).toBe(0)
  })
})

describe('parseDbFile 解析与水位游标', () => {
  it('assistant 消息产出完整 UsageRecord：四桶/semantics=2/requestId=message.id/project=session.directory', () => {
    const dbPath = path.join(tmpDir, DB_SOURCE_SUFFIX)
    buildDevEcoDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: 'D:\\work\\deveco-proj' }],
      messages: [asstMsg({ id: 'm-1', time: 1_700_000_000_123 })]
    })
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({
      appType: 'dev-eco',
      model: 'deepseek-chat',
      rawModel: 'deepseek-chat',
      inputTokens: 123,
      outputTokens: 45,
      cacheReadTokens: 8,
      cacheCreationTokens: 3,
      inputSemantics: 2,
      status: 'success',
      project: 'D:\\work\\deveco-proj',
      sessionId: 'sess-1',
      createdAt: 1_700_000_000_123
    })
    expect(res.records[0].source).toEqual({
      filePath: DB_SOURCE_SUFFIX,
      line: 1_700_000_000_123,
      requestId: 'm-1'
    })
    expect(res.nextLine).toBe(1_700_000_000_123)
    expect(res.eof).toBe(true)
  })

  it('channel 变体 db 同样可解析，source.filePath 仍为 deveco.db', () => {
    const betaPath = path.join(tmpDir, 'deveco-beta.db')
    buildDevEcoDb(betaPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      messages: [asstMsg({ id: 'm-beta-1', time: 2_000 })]
    })
    const res = parseDbFile(betaPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.filePath).toBe(DB_SOURCE_SUFFIX)
    expect(res.records[0].source.requestId).toBe('m-beta-1')
  })

  it('user 行与 modelID 空的 assistant 行跳过，水位仍推进', () => {
    const dbPath = path.join(tmpDir, DB_SOURCE_SUFFIX)
    buildDevEcoDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      messages: [
        userMsg({ id: 'u-1', time: 1_000 }),
        asstMsg({ id: 'a-1', time: 2_000 }),
        {
          id: 'a-2',
          sessionId: 'sess-1',
          timeCreated: 3_000,
          data: { role: 'assistant', time: { created: 3_000 }, modelID: '   ', tokens: { input: 1, output: 1 } }
        },
        {
          id: 'a-3',
          sessionId: 'sess-1',
          timeCreated: 4_000,
          data: { role: 'assistant', time: { created: 4_000 }, modelID: 'deepseek-chat', tokens: undefined }
        }
      ]
    })
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.line).toBe(2_000)
    expect(res.nextLine).toBe(4_000)
    expect(res.eof).toBe(true)
  })

  it('游标增量：只处理 time_created > fromLine 的行，续读不重不漏', () => {
    const dbPath = path.join(tmpDir, DB_SOURCE_SUFFIX)
    buildDevEcoDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      messages: [asstMsg({ id: 'm-1', time: 1_000 }), asstMsg({ id: 'm-2', time: 2_000 })]
    })
    const r1 = parseDbFile(dbPath, 0)
    expect(r1.records).toHaveLength(2)
    expect(r1.records.map((r) => r.source.line)).toEqual([1_000, 2_000])
    expect(r1.nextLine).toBe(2_000)

    const db = new Database(dbPath)
    const ins = db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
    )
    ins.run('m-3', 'sess-1', 3_000, 3_000, JSON.stringify(asstMsg({ id: 'm-3', time: 3_000 }).data))
    ins.run('m-4', 'sess-1', 4_000, 4_000, JSON.stringify(asstMsg({ id: 'm-4', time: 4_000 }).data))
    db.close()

    const r2 = parseDbFile(dbPath, r1.nextLine)
    expect(r2.records).toHaveLength(2)
    expect(r2.records.map((r) => r.source.line).sort((a, b) => a - b)).toEqual([3_000, 4_000])
    expect(r2.nextLine).toBe(4_000)
    expect(r2.eof).toBe(true)

    const r3 = parseDbFile(dbPath, r2.nextLine)
    expect(r3.records).toHaveLength(0)
    expect(r3.nextLine).toBe(4_000)
    expect(r3.eof).toBe(true)
  })

  it('同一毫秒多消息：line 单调递增保持去重唯一', () => {
    const dbPath = path.join(tmpDir, DB_SOURCE_SUFFIX)
    buildDevEcoDb(dbPath, {
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

  it('损坏 db 文件返回空结果且游标不推进', () => {
    const broken = path.join(tmpDir, 'broken.db')
    fs.writeFileSync(broken, 'this is not a sqlite database', 'utf8')
    const r1 = parseDbFile(broken, 7)
    expect(r1.records).toHaveLength(0)
    expect(r1.nextLine).toBe(7)
    expect(r1.eof).toBe(true)

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

describe('失败分支', () => {
  it('data 含 error 的 assistant 行产出 error 记录，tokens 保留', () => {
    const dbPath = path.join(tmpDir, DB_SOURCE_SUFFIX)
    const data = {
      ...(asstMsg({ time: 1_000 }).data as Record<string, unknown>),
      error: 'upstream timeout',
      httpStatus: 504
    }
    buildDevEcoDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      messages: [{ id: 'm-err', sessionId: 'sess-1', timeCreated: 1_000, data }]
    })
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(1)
    const r = res.records[0]
    expect(r.status).toBe('error')
    expect(r.errorMessage).toBe('upstream timeout')
    expect(r.httpStatus).toBe(504)
    expect(r.inputTokens).toBe(123)
    expect(r.outputTokens).toBe(45)
    expect(r.source.requestId).toBe('m-err')
  })

  it('cancelled/interrupted 忽略不产记录，但水位推进', () => {
    const dbPath = path.join(tmpDir, DB_SOURCE_SUFFIX)
    const cancelled = {
      ...(asstMsg({ time: 1_000 }).data as Record<string, unknown>),
      error: 'cancelled by user'
    }
    const interrupted = {
      ...(asstMsg({ time: 2_000 }).data as Record<string, unknown>),
      status: 'interrupted'
    }
    buildDevEcoDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      messages: [
        { id: 'm-cancel', sessionId: 'sess-1', timeCreated: 1_000, data: cancelled },
        { id: 'm-inter', sessionId: 'sess-1', timeCreated: 2_000, data: interrupted }
      ]
    })
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(2_000)
    expect(res.eof).toBe(true)
  })

  it('非 assistant 角色即使含 error 也不产出', () => {
    const dbPath = path.join(tmpDir, DB_SOURCE_SUFFIX)
    buildDevEcoDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      messages: [
        { id: 'u-err', sessionId: 'sess-1', timeCreated: 1_000, data: { role: 'user', error: 'should ignore' } }
      ]
    })
    expect(parseDbFile(dbPath, 0).records).toHaveLength(0)
  })
})
