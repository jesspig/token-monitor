import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import {
  zcodePlugin,
  dataRootOf,
  dbPathOf,
  detectFromRoot,
  listFilesFromRoot,
  parseDbFile,
  statMtimeMs,
  maxMtime
} from './zcode'
import type { PluginContext } from '../../../shared/context'

/** parseFile 不使用 ctx 上的服务，测试时给个空壳即可 */
const ctx = {} as PluginContext

let tmpDir = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-plugin-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** model_usage 行种子（字段可覆盖，默认对齐 CLI db v0.14.8 schema） */
interface UsageSeed {
  id: string
  sessionId?: string | null
  modelId?: string | null
  input?: number
  output?: number
  reasoning?: number
  cacheRead?: number
  cacheCreation?: number
  startedAt?: number
  completedAt?: number | null
}

const USAGE_COLUMNS =
  '(id, session_id, turn_id, model_id, input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, started_at, completed_at)'

const USAGE_PLACEHOLDERS = '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'

/** 失败语义扩展种子（新增 4 列，兼容旧库缺列） */
interface FailureUsageSeed extends UsageSeed {
  status?: string | null
  errorType?: string | null
  errorCode?: string | number | null
  errorMessage?: string | null
}

const USAGE_COLUMNS_FAILURE =
  '(id, session_id, turn_id, model_id, input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, started_at, completed_at, status, error_type, error_code, error_message)'

const USAGE_PLACEHOLDERS_FAILURE = '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'

function failureValues(u: FailureUsageSeed): unknown[] {
  return [
    ...usageValues(u),
    u.status ?? null,
    u.errorType ?? null,
    u.errorCode ?? null,
    u.errorMessage ?? null
  ]
}

/** 构造含失败列的 zcode SQLite（新 schema，含 status/error_* 四列） */
function buildZcodeDbWithFailure(
  dbPath: string,
  opts: {
    sessions?: Array<{ id: string; directory?: string | null }>
    usages?: FailureUsageSeed[]
  } = {}
): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      directory TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_usage (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT,
      model_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      status TEXT,
      error_type TEXT,
      error_code TEXT,
      error_message TEXT
    );
  `)
  const insS = db.prepare('INSERT INTO session (id, directory) VALUES (?, ?)')
  for (const s of opts.sessions ?? []) {
    insS.run(s.id, s.directory ?? '')
  }
  const insU = db.prepare(`INSERT INTO model_usage ${USAGE_COLUMNS_FAILURE} VALUES ${USAGE_PLACEHOLDERS_FAILURE}`)
  for (const u of opts.usages ?? []) {
    insU.run(...failureValues(u))
  }
  db.close()
}

function usageValues(u: UsageSeed): unknown[] {
  return [
    u.id,
    u.sessionId ?? 'sess-1',
    null,
    u.modelId === undefined ? 'GLM-5.2' : u.modelId,
    u.input ?? 123,
    u.output ?? 45,
    u.reasoning ?? 10,
    u.cacheCreation ?? 3,
    u.cacheRead ?? 8,
    u.startedAt ?? 1_700_000_000_100,
    u.completedAt === undefined ? 1_700_000_000_150 : u.completedAt
  ]
}

/** 构造 zcode 风格 SQLite（session + model_usage 两表，schema 对齐 CLI db v0.14.8） */
function buildZcodeDb(
  dbPath: string,
  opts: {
    sessions?: Array<{ id: string; directory?: string | null }>
    usages?: UsageSeed[]
  } = {}
): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      directory TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_usage (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT,
      model_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );
  `)
  const insS = db.prepare('INSERT INTO session (id, directory) VALUES (?, ?)')
  for (const s of opts.sessions ?? []) {
    insS.run(s.id, s.directory ?? '')
  }
  const insU = db.prepare(`INSERT INTO model_usage ${USAGE_COLUMNS} VALUES ${USAGE_PLACEHOLDERS}`)
  for (const u of opts.usages ?? []) {
    insU.run(...usageValues(u))
  }
  db.close()
}

/** 向已有 db 追加一行 model_usage（增量游标测试用） */
function appendUsage(dbPath: string, u: UsageSeed): void {
  const db = new Database(dbPath)
  db.prepare(`INSERT INTO model_usage ${USAGE_COLUMNS} VALUES ${USAGE_PLACEHOLDERS}`).run(...usageValues(u))
  db.close()
}

describe('zcodePlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(zcodePlugin.id).toBe('zcode')
    expect(zcodePlugin.name).toBe('ZCode')
    expect(zcodePlugin.version).toBe('1.0.0')
    expect(zcodePlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('detectFromRoot 探测', () => {
  it('数据根缺失时不可用并给出原因与预期目录', () => {
    const root = path.join(tmpDir, 'zcode')
    const res = detectFromRoot(root)
    expect(res.available).toBe(false)
    expect(res.reason).toBeTruthy()
    expect(res.sessionDir).toBe(root)
  })

  it('数据根存在但无 cli/db/db.sqlite 时不可用', () => {
    const root = path.join(tmpDir, 'zcode')
    fs.mkdirSync(root, { recursive: true })
    const res = detectFromRoot(root)
    expect(res.available).toBe(false)
    expect(res.reason).toBeTruthy()
  })

  it('db 存在时可用', () => {
    const root = path.join(tmpDir, 'zcode')
    buildZcodeDb(path.join(root, 'cli', 'db', 'db.sqlite'), {})
    const res = detectFromRoot(root)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(root)
  })

  it('插件级 detect 读取 $ZCODE_STORAGE_DIR 覆盖的数据根', async () => {
    const prev = process.env.ZCODE_STORAGE_DIR
    try {
      process.env.ZCODE_STORAGE_DIR = tmpDir
      expect(dataRootOf()).toBe(tmpDir)
      buildZcodeDb(path.join(tmpDir, 'cli', 'db', 'db.sqlite'), {})
      const res = await zcodePlugin.detect(ctx)
      expect(res.available).toBe(true)
      expect(res.sessionDir).toBe(tmpDir)
    } finally {
      if (prev === undefined) delete process.env.ZCODE_STORAGE_DIR
      else process.env.ZCODE_STORAGE_DIR = prev
    }
  })
})

describe('listFilesFromRoot 收集范围与 WAL 感知', () => {
  /** 写入空文件并设置指定 mtime（epoch ms），返回实际 stat 到的毫秒值（规避文件系统时间精度截断） */
  function writeWithMtime(p: string, atMs: number): number {
    fs.writeFileSync(p, '')
    const t = new Date(atMs)
    fs.utimesSync(p, t, t)
    return Math.round(fs.statSync(p).mtimeMs)
  }

  it('db 存在时仅返回单条目（path 为真实 db 绝对路径，mtime>0）', () => {
    const root = path.join(tmpDir, 'zcode')
    const dbPath = path.join(root, 'cli', 'db', 'db.sqlite')
    buildZcodeDb(dbPath, { usages: [] })
    const entries = listFilesFromRoot(root)
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe(dbPath)
    expect(entries[0].path).toBe(dbPathOf(root))
    expect(entries[0].mtime).toBeGreaterThan(0)
  })

  it('db 与 -wal 同时存在且 wal 较新：条目 mtime 取两者较大值，path 仍为 db 路径', () => {
    const root = path.join(tmpDir, 'zcode')
    const dbPath = path.join(root, 'cli', 'db', 'db.sqlite')
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    const dbMtime = writeWithMtime(dbPath, Date.now() - 60_000)
    const walMtime = writeWithMtime(dbPath + '-wal', Date.now())
    const entries = listFilesFromRoot(root)
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe(dbPath)
    expect(entries[0].mtime).toBe(Math.max(dbMtime, walMtime))
    expect(entries[0].mtime).toBe(walMtime)
  })

  it('仅 db 无 -wal：条目 mtime 等于 db 自身 mtime', () => {
    const root = path.join(tmpDir, 'zcode')
    const dbPath = path.join(root, 'cli', 'db', 'db.sqlite')
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    const dbMtime = writeWithMtime(dbPath, Date.now() - 60_000)
    const entries = listFilesFromRoot(root)
    expect(entries).toHaveLength(1)
    expect(entries[0].mtime).toBe(dbMtime)
  })

  it('db 与 -wal 双缺：stat 兜底为 0（maxMtime 全失败 → 0）', () => {
    const missing = path.join(tmpDir, 'nope.sqlite')
    expect(statMtimeMs(missing)).toBe(0)
    expect(maxMtime([missing, missing + '-wal'])).toBe(0)
    expect(maxMtime([])).toBe(0)
  })

  it('db 缺失时返回空数组', () => {
    const root = path.join(tmpDir, 'zcode')
    fs.mkdirSync(root, { recursive: true })
    expect(listFilesFromRoot(root)).toEqual([])
  })
})

describe('parseDbFile 解析与水位游标', () => {
  it('model_usage 行产出完整 UsageRecord（project 来自 session.directory，line=rowid）', () => {
    const dbPath = path.join(tmpDir, 'cli', 'db', 'db.sqlite')
    buildZcodeDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/Users/a/zcode-proj' }],
      usages: [{ id: 'mu-1' }]
    })
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({
      appType: 'zcode',
      model: 'GLM-5.2',
      rawModel: 'GLM-5.2',
      inputTokens: 123,
      outputTokens: 45,
      cacheReadTokens: 8,
      cacheCreationTokens: 3,
      inputSemantics: 1,
      status: 'success',
      project: '/Users/a/zcode-proj',
      sessionId: 'sess-1',
      createdAt: 1_700_000_000_150
    })
    expect(res.records[0].source).toEqual({
      filePath: dbPath,
      line: 1,
      requestId: 'mu-1'
    })
    expect(res.nextLine).toBe(1)
    expect(res.eof).toBe(true)
  })

  it('outputTokens 不含 reasoning_tokens（独立列不折入速率）', () => {
    const dbPath = path.join(tmpDir, 'cli', 'db', 'db.sqlite')
    buildZcodeDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      usages: [{ id: 'mu-r', output: 45, reasoning: 99 }]
    })
    const res = parseDbFile(dbPath, 0)
    expect(res.records[0].outputTokens).toBe(45)
  })

  it('completed_at 为 NULL 时 createdAt 回退 started_at', () => {
    const dbPath = path.join(tmpDir, 'cli', 'db', 'db.sqlite')
    buildZcodeDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      usages: [{ id: 'mu-null', completedAt: null }]
    })
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].createdAt).toBe(1_700_000_000_100)
  })

  it('全零四桶行照常产出（由 collector 统一拦截），水位照常推进', () => {
    const dbPath = path.join(tmpDir, 'cli', 'db', 'db.sqlite')
    buildZcodeDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      usages: [{ id: 'mu-zero', input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheCreation: 0 }]
    })
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.nextLine).toBe(1)
  })

  it('水位游标增量：只处理 rowid > fromLine 的行，无新行 nextLine 不动', () => {
    const dbPath = path.join(tmpDir, 'cli', 'db', 'db.sqlite')
    buildZcodeDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      usages: [
        { id: 'mu-1', startedAt: 1_000 },
        { id: 'mu-2', startedAt: 2_000 }
      ]
    })
    const r1 = parseDbFile(dbPath, 0)
    expect(r1.records).toHaveLength(2)
    expect(r1.records.map((r) => r.source.line)).toEqual([1, 2])
    expect(r1.nextLine).toBe(2)

    // 追加两行后再解析：只产出新增（rowid 3、4），line=rowid 单调递增跨轮去重唯一
    appendUsage(dbPath, { id: 'mu-3', startedAt: 3_000 })
    appendUsage(dbPath, { id: 'mu-4', startedAt: 4_000 })

    const r2 = parseDbFile(dbPath, r1.nextLine)
    expect(r2.records).toHaveLength(2)
    expect(r2.records.map((r) => r.source.line)).toEqual([3, 4])
    expect(r2.nextLine).toBe(4)
    expect(r2.eof).toBe(true)

    // 无新增：nextLine 返回原 fromLine
    const r3 = parseDbFile(dbPath, r2.nextLine)
    expect(r3.records).toHaveLength(0)
    expect(r3.nextLine).toBe(4)
    expect(r3.eof).toBe(true)
  })

  it('session 行缺失时 project 为 undefined 但照常产出记录', () => {
    const dbPath = path.join(tmpDir, 'cli', 'db', 'db.sqlite')
    buildZcodeDb(dbPath, {
      sessions: [],
      usages: [{ id: 'mu-orphan' }]
    })
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].project).toBeUndefined()
    expect(res.records[0].sessionId).toBe('sess-1')
  })

  it('model_id 缺失/空白的行跳过不产出，但水位仍推进', () => {
    const dbPath = path.join(tmpDir, 'cli', 'db', 'db.sqlite')
    buildZcodeDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      usages: [
        { id: '', modelId: '' },
        { id: 'mu-ok' }
      ]
    })
    const res = parseDbFile(dbPath, 0)
    expect(res.records.map((r) => r.source.requestId)).toEqual(['mu-ok'])
    expect(res.nextLine).toBe(2)
  })

  it('id 缺失/空白时不设 requestId（退回 (file,line) 主键去重）', () => {
    // TEXT PK 允许空串；宽松透传为 undefined
    const dbPath = path.join(tmpDir, 'cli', 'db', 'db.sqlite')
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL);
      CREATE TABLE model_usage (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        model_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      INSERT INTO session (id, directory) VALUES ('sess-1', '/p');
    `)
    db.prepare(`INSERT INTO model_usage ${USAGE_COLUMNS} VALUES ${USAGE_PLACEHOLDERS}`).run(
      ...usageValues({ id: '', sessionId: 'sess-1' })
    )
    db.close()
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.requestId).toBeUndefined()
  })

  it('db 缺失 / model_usage 表不存在 → 空结果且游标不推进', () => {
    const missing = path.join(tmpDir, 'nope.sqlite')
    const r1 = parseDbFile(missing, 0)
    expect(r1.records).toHaveLength(0)
    expect(r1.nextLine).toBe(0)
    expect(r1.eof).toBe(true)

    // 仅含无关表的空库（无 model_usage 表）
    const emptyDb = path.join(tmpDir, 'empty.sqlite')
    const db = new Database(emptyDb)
    db.exec('CREATE TABLE unrelated (x TEXT)')
    db.close()
    const r2 = parseDbFile(emptyDb, 42)
    expect(r2.records).toHaveLength(0)
    expect(r2.nextLine).toBe(42)
    expect(r2.eof).toBe(true)
  })
})

describe('parseDbFile 失败语义（status/error_type/error_code/error_message）', () => {
  it('error_type 非 cancelled 且 status != completed 时产 error：status error、httpStatus/errorMessage 正确、截断500', () => {
    const dbPath = path.join(tmpDir, 'cli', 'db', 'db.sqlite')
    const longMsg = 'x'.repeat(800)
    buildZcodeDbWithFailure(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      usages: [
        { id: 'mu-err-1', status: 'failed', errorType: 'api_error', errorCode: '429', errorMessage: longMsg },
        { id: 'mu-err-2', status: 'error', errorType: 'timeout', errorCode: 500, errorMessage: 'timeout boom' },
        { id: 'mu-err-3', status: 'failed', errorType: 'api_error', errorCode: 'not-a-number', errorMessage: 'bad code' }
      ]
    })
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(3)
    // mu-err-1：字符串 code 转数字 + 截断 500
    expect(res.records[0].status).toBe('error')
    expect(res.records[0].httpStatus).toBe(429)
    expect(res.records[0].errorMessage?.length).toBe(500)
    expect(res.records[0].errorMessage).toBe('x'.repeat(500))
    // mu-err-2：数字 code 保留
    expect(res.records[1].status).toBe('error')
    expect(res.records[1].httpStatus).toBe(500)
    expect(res.records[1].errorMessage).toBe('timeout boom')
    // mu-err-3：非有限数 code 不保留
    expect(res.records[2].status).toBe('error')
    expect(res.records[2].httpStatus).toBeUndefined()
    expect(res.records[2].errorMessage).toBe('bad code')
    expect(res.nextLine).toBe(3)
  })

  it('error_type 为 cancelled 时仍 success，不产 errorMessage/httpStatus（忽略不计 error）', () => {
    const dbPath = path.join(tmpDir, 'cli', 'db', 'db.sqlite')
    buildZcodeDbWithFailure(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      usages: [
        { id: 'mu-cancel', status: 'failed', errorType: 'cancelled', errorCode: '499', errorMessage: 'cancelled by user' },
        { id: 'mu-cancel2', status: 'interrupted', errorType: 'cancelled', errorCode: 500, errorMessage: 'should ignore' }
      ]
    })
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(2)
    for (const r of res.records) {
      expect(r.status).toBe('success')
      expect(r.httpStatus).toBeUndefined()
      expect(r.errorMessage).toBeUndefined()
    }
    expect(res.records.map((r) => r.source.requestId)).toEqual(['mu-cancel', 'mu-cancel2'])
  })

  it('status 为 completed 时忽略 error_type，仍产 success', () => {
    const dbPath = path.join(tmpDir, 'cli', 'db', 'db.sqlite')
    buildZcodeDbWithFailure(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      usages: [
        { id: 'mu-completed', status: 'completed', errorType: 'api_error', errorCode: '500', errorMessage: 'should be ignored' },
        { id: 'mu-completed2', status: 'completed', errorType: 'timeout', errorCode: 429, errorMessage: 'also ignored' }
      ]
    })
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(2)
    for (const r of res.records) {
      expect(r.status).toBe('success')
      expect(r.httpStatus).toBeUndefined()
      expect(r.errorMessage).toBeUndefined()
    }
  })

  it('缺列兼容：旧库无 status/error_* 列时宽松视为 success，不抛错且无 httpStatus/errorMessage', () => {
    const dbPath = path.join(tmpDir, 'cli', 'db', 'db.sqlite')
    // 使用旧 schema 构建（无失败列）
    buildZcodeDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      usages: [{ id: 'mu-old-1' }, { id: 'mu-old-2', input: 10, output: 20 }]
    })
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(2)
    for (const r of res.records) {
      expect(r.status).toBe('success')
      expect(r.httpStatus).toBeUndefined()
      expect(r.errorMessage).toBeUndefined()
    }
    expect(res.nextLine).toBe(2)
  })

  it('边界：status 非 completed 但 error_type 为空/NULL 时仍 success；error_message 空白时不产 errorMessage', () => {
    const dbPath = path.join(tmpDir, 'cli', 'db', 'db.sqlite')
    buildZcodeDbWithFailure(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      usages: [
        { id: 'mu-null-type', status: 'failed', errorType: null, errorCode: '500', errorMessage: 'has code but no type' },
        { id: 'mu-empty-type', status: 'failed', errorType: '', errorCode: '500', errorMessage: 'empty type' },
        { id: 'mu-empty-msg', status: 'failed', errorType: 'api_error', errorCode: '500', errorMessage: '   ' },
        { id: 'mu-no-code', status: 'failed', errorType: 'api_error', errorCode: null, errorMessage: 'no code' }
      ]
    })
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(4)
    // 前两者因 error_type 缺失/空白 → success，无 httpStatus/errorMessage
    expect(res.records[0].status).toBe('success')
    expect(res.records[0].httpStatus).toBeUndefined()
    expect(res.records[0].errorMessage).toBeUndefined()
    expect(res.records[1].status).toBe('success')
    expect(res.records[1].httpStatus).toBeUndefined()
    expect(res.records[1].errorMessage).toBeUndefined()
    // mu-empty-msg：errorMessage 空白 → 不产 errorMessage，但仍为 error
    expect(res.records[2].status).toBe('error')
    expect(res.records[2].httpStatus).toBe(500)
    expect(res.records[2].errorMessage).toBeUndefined()
    // mu-no-code：无 code 时 httpStatus 省略，仍为 error 且有 message
    expect(res.records[3].status).toBe('error')
    expect(res.records[3].httpStatus).toBeUndefined()
    expect(res.records[3].errorMessage).toBe('no code')
  })
})

describe('插件级 parseFile 透传', () => {
  it('单数据源不分派：直接按 rowid 水位解析 db，source.filePath 为传入绝对路径', async () => {
    const dbPath = path.join(tmpDir, 'cli', 'db', 'db.sqlite')
    buildZcodeDb(dbPath, {
      sessions: [{ id: 'sess-1', directory: '/p' }],
      usages: [{ id: 'mu-pf' }]
    })
    const res = await zcodePlugin.parseFile(ctx, dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.filePath).toBe(dbPath)
    expect(res.records[0].source.requestId).toBe('mu-pf')
  })
})
