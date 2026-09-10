import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import {
  goosePlugin,
  sessionsDirOf,
  dbPathOf,
  detectFromDir,
  listFilesFromDir,
  parseDbFile,
  toUsageRecord,
  parseTsMs,
  readLedgerColumns,
  hasRequiredColumns,
  GOOSE_REQUIRED_COLUMNS
} from './goose'
import type { PluginContext } from '../../../shared/context'

const ctx = {} as PluginContext

let tmpDir = ''

const envKeys = ['GOOSE_DIR', 'GOOSE_PATH_ROOT', 'APPDATA'] as const
const savedEnv: Record<string, string | undefined> = {}
const savedPlatform = process.platform

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goose-plugin-'))
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
  Object.defineProperty(process, 'platform', { value: savedPlatform })
})

const setPlatform = (p: string): void => {
  Object.defineProperty(process, 'platform', { value: p })
}

const USAGE_LEDGER_DDL = `
  CREATE TABLE usage_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    created_timestamp INTEGER,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    total_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    cost REAL,
    cost_source TEXT,
    is_compaction INTEGER
  )`

const INSERT_LEDGER_SQL =
  'INSERT INTO usage_ledger (session_id, created_timestamp, model, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_write_tokens, cost, cost_source, is_compaction) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'

interface LedgerSeed {
  sessionId?: string | null
  createdAt?: number | null
  model?: string | null
  inputTokens?: number | null
  outputTokens?: number | null
  cacheRead?: number | null
  cacheWrite?: number | null
  isCompaction?: number
}

function ledgerValues(s: LedgerSeed): unknown[] {
  const input = s.inputTokens === undefined ? 100 : s.inputTokens
  const output = s.outputTokens === undefined ? 20 : s.outputTokens
  const total = input === null || output === null ? null : input + output
  return [
    s.sessionId ?? 'sess-1',
    s.createdAt === undefined ? 1_780_000_000 : s.createdAt,
    s.model === undefined ? 'claude-sonnet-4' : s.model,
    input,
    output,
    total,
    s.cacheRead === undefined ? 60 : s.cacheRead,
    s.cacheWrite === undefined ? 30 : s.cacheWrite,
    0.05,
    'model',
    s.isCompaction ?? 0
  ]
}

function buildGooseDb(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.exec(USAGE_LEDGER_DDL)
  db.close()
}

function insertLedgerRow(dbPath: string, seed: LedgerSeed = {}): number {
  const db = new Database(dbPath)
  const info = db.prepare(INSERT_LEDGER_SQL).run(...ledgerValues(seed))
  db.close()
  return Number(info.lastInsertRowid)
}

function writeWithMtime(p: string, atMs: number): number {
  fs.writeFileSync(p, '')
  const t = new Date(atMs)
  fs.utimesSync(p, t, t)
  return Math.round(fs.statSync(p).mtimeMs)
}

describe('goosePlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(goosePlugin.id).toBe('goose')
    expect(goosePlugin.name).toBe('Goose')
    expect(goosePlugin.version).toBe('1.0.0')
    expect(goosePlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('sessionsDirOf 探测优先级', () => {
  it('$GOOSE_DIR 最高优先且语义为 sessions 目录本身（同时设置 $GOOSE_PATH_ROOT 仍取 $GOOSE_DIR）', () => {
    process.env.GOOSE_DIR = tmpDir
    process.env.GOOSE_PATH_ROOT = path.join(tmpDir, 'root')
    expect(sessionsDirOf()).toBe(tmpDir)
  })

  it('仅 $GOOSE_PATH_ROOT 非空时为 $GOOSE_PATH_ROOT/data/sessions', () => {
    process.env.GOOSE_PATH_ROOT = path.join(tmpDir, 'root')
    expect(sessionsDirOf()).toBe(path.join(tmpDir, 'root', 'data', 'sessions'))
  })

  it('空白环境值视为未设置（trim 后回退下一档）', () => {
    process.env.GOOSE_DIR = '   '
    process.env.GOOSE_PATH_ROOT = `  ${path.join(tmpDir, 'root')}  `
    expect(sessionsDirOf()).toBe(path.join(tmpDir, 'root', 'data', 'sessions'))
  })

  it('win32 走 %APPDATA%\\Block\\goose\\data\\sessions，APPDATA 缺失回退用户目录', () => {
    setPlatform('win32')
    process.env.APPDATA = path.join(tmpDir, 'appdata')
    expect(sessionsDirOf()).toBe(path.join(tmpDir, 'appdata', 'Block', 'goose', 'data', 'sessions'))

    delete process.env.APPDATA
    expect(sessionsDirOf()).toBe(path.join(os.homedir(), 'AppData', 'Roaming', 'Block', 'goose', 'data', 'sessions'))
  })

  it('非 win32 默认 ~/.local/share/goose/sessions', () => {
    setPlatform('linux')
    expect(sessionsDirOf()).toBe(path.join(os.homedir(), '.local', 'share', 'goose', 'sessions'))
  })
})

describe('detect 三态与容错', () => {
  it('目录缺失 → 不可用，原因含候选路径与 $GOOSE_DIR/$GOOSE_PATH_ROOT 覆盖说明', () => {
    const dir = path.join(tmpDir, 'sessions')
    const res = detectFromDir(dir)
    expect(res.available).toBe(false)
    expect(res.reason).toContain('未找到 Goose sessions 目录')
    expect(res.reason).toContain('$GOOSE_DIR')
    expect(res.reason).toContain('$GOOSE_PATH_ROOT')
    expect(res.sessionDir).toBe(dir)
  })

  it('目录存在但 sessions.db 缺失 → 不可用', () => {
    const dir = path.join(tmpDir, 'sessions')
    fs.mkdirSync(dir, { recursive: true })
    const res = detectFromDir(dir)
    expect(res.available).toBe(false)
    expect(res.reason).toContain('未发现 sessions.db')
    expect(res.sessionDir).toBe(dir)
  })

  it('sessions.db 存在且可读 → 可用', () => {
    const dir = path.join(tmpDir, 'sessions')
    buildGooseDb(dbPathOf(dir))
    const res = detectFromDir(dir)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(dir)
  })

  it('sessions.db 存在但损坏 → 不可用并说明无法读取', () => {
    const dir = path.join(tmpDir, 'sessions')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'sessions.db'), 'not a sqlite database', 'utf8')
    const res = detectFromDir(dir)
    expect(res.available).toBe(false)
    expect(res.reason).toContain('无法读取')
    expect(res.sessionDir).toBe(dir)
  })

  it('插件级 detect 经 $GOOSE_DIR 覆盖生效（先缺库不可用，建库后可用）', async () => {
    process.env.GOOSE_DIR = tmpDir
    const missing = await goosePlugin.detect(ctx)
    expect(missing.available).toBe(false)
    expect(missing.reason).toContain('sessions 目录存在但未发现 sessions.db')

    buildGooseDb(dbPathOf(tmpDir))
    const ok = await goosePlugin.detect(ctx)
    expect(ok.available).toBe(true)
    expect(ok.sessionDir).toBe(tmpDir)
  })
})

describe('listFilesFromDir 收集范围', () => {
  it('库存在时返回单条目，mtime 取 db 与 -wal 较大值且 path 仍为 db 路径', () => {
    const dir = path.join(tmpDir, 'sessions')
    const dbPath = dbPathOf(dir)
    buildGooseDb(dbPath)
    const dbMtime = writeWithMtime(dbPath, Date.now() - 60_000)
    const walMtime = writeWithMtime(dbPath + '-wal', Date.now())
    const entries = listFilesFromDir(dir)
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe(dbPath)
    expect(entries[0].mtime).toBe(Math.max(dbMtime, walMtime))
    expect(entries[0].mtime).toBe(walMtime)
  })

  it('库缺失时返回空数组', () => {
    expect(listFilesFromDir(path.join(tmpDir, 'nope'))).toEqual([])
  })
})

describe('插件级 listFiles', () => {
  it('$GOOSE_DIR 覆盖下返回存在的库', async () => {
    process.env.GOOSE_DIR = tmpDir
    const dbPath = dbPathOf(tmpDir)
    buildGooseDb(dbPath)
    const entries = await goosePlugin.listFiles(ctx)
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe(dbPath)
  })
})

describe('usage_ledger 列探测', () => {
  it('必需列齐备时通过，缺列时失败', () => {
    const dbPath = path.join(tmpDir, 'full.db')
    buildGooseDb(dbPath)
    const db = new Database(dbPath, { readonly: true })
    expect(hasRequiredColumns(readLedgerColumns(db))).toBe(true)
    db.close()

    const partial = path.join(tmpDir, 'partial.db')
    const db2 = new Database(partial)
    db2.exec(
      'CREATE TABLE usage_ledger (id INTEGER PRIMARY KEY, session_id TEXT, created_timestamp INTEGER, model TEXT, input_tokens INTEGER, output_tokens INTEGER)'
    )
    const cols = readLedgerColumns(db2)
    db2.close()
    expect(hasRequiredColumns(cols)).toBe(false)
    expect(GOOSE_REQUIRED_COLUMNS).toContain('cache_read_tokens')
    expect(GOOSE_REQUIRED_COLUMNS).toContain('cache_write_tokens')
  })
})

describe('parseDbFile 正常解析', () => {
  it('标准行映射：四桶、semantics=1、秒→毫秒、source.line=id 且无 requestId', () => {
    const dbPath = path.join(tmpDir, 'sessions.db')
    buildGooseDb(dbPath)
    insertLedgerRow(dbPath, {
      sessionId: 'sess-abc',
      createdAt: 1_780_000_000,
      model: 'claude-sonnet-4',
      inputTokens: 120,
      outputTokens: 45,
      cacheRead: 80,
      cacheWrite: 25
    })
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.eof).toBe(true)
    expect(res.nextLine).toBe(1)
    const r = res.records[0]
    expect(r).toMatchObject({
      appType: 'goose',
      model: 'claude-sonnet-4',
      rawModel: 'claude-sonnet-4',
      inputTokens: 120,
      outputTokens: 45,
      cacheReadTokens: 80,
      cacheCreationTokens: 25,
      inputSemantics: 1,
      status: 'success',
      sessionId: 'sess-abc',
      createdAt: 1_780_000_000_000
    })
    expect(r.source).toEqual({ filePath: dbPath, line: 1 })
    expect('requestId' in r.source).toBe(false)
  })

  it('model 空串/NULL/空白记 unknown，行不跳过', () => {
    const dbPath = path.join(tmpDir, 'sessions.db')
    buildGooseDb(dbPath)
    insertLedgerRow(dbPath, { model: '' })
    insertLedgerRow(dbPath, { model: null })
    insertLedgerRow(dbPath, { model: '   ' })
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(3)
    for (const r of res.records) {
      expect(r.model).toBe('unknown')
      expect(r.rawModel).toBe('unknown')
    }
    expect(res.nextLine).toBe(3)
  })

  it('created_timestamp 秒×1000、毫秒原样、NULL/0 兜底当前时间', () => {
    const dbPath = path.join(tmpDir, 'sessions.db')
    buildGooseDb(dbPath)
    insertLedgerRow(dbPath, { createdAt: 1_780_000_000 })
    insertLedgerRow(dbPath, { createdAt: 1_780_000_000_123 })
    insertLedgerRow(dbPath, { createdAt: null })
    insertLedgerRow(dbPath, { createdAt: 0 })
    const before = Date.now()
    const res = parseDbFile(dbPath, 0)
    const after = Date.now()
    expect(res.records).toHaveLength(4)
    const [sec, ms, nullTs, zeroTs] = res.records.map((r) => r.createdAt)
    expect(sec).toBe(1_780_000_000_000)
    expect(ms).toBe(1_780_000_000_123)
    for (const t of [nullTs, zeroTs]) {
      expect(t).toBeGreaterThanOrEqual(before)
      expect(t).toBeLessThanOrEqual(after)
    }
  })

  it('is_compaction=1 行照常产出（真实 token 消耗不跳过）', () => {
    const dbPath = path.join(tmpDir, 'sessions.db')
    buildGooseDb(dbPath)
    insertLedgerRow(dbPath, { isCompaction: 1 })
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({
      appType: 'goose',
      inputSemantics: 1,
      status: 'success'
    })
    expect(res.nextLine).toBe(1)
  })

  it('数值列 NULL/异常兜 0，semantics 仍为 1', () => {
    const dbPath = path.join(tmpDir, 'sessions.db')
    buildGooseDb(dbPath)
    insertLedgerRow(dbPath, { inputTokens: null, outputTokens: null, cacheRead: null, cacheWrite: null })
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      inputSemantics: 1
    })
  })

  it('空库（表在无行）：空结果、游标 0', () => {
    const dbPath = path.join(tmpDir, 'sessions.db')
    buildGooseDb(dbPath)
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(0)
    expect(res.eof).toBe(true)
  })
})

describe('parseDbFile 游标增量与容错', () => {
  it('游标增量：续读只取新增，无新行时游标不动', () => {
    const dbPath = path.join(tmpDir, 'sessions.db')
    buildGooseDb(dbPath)
    insertLedgerRow(dbPath, { createdAt: 1_000 })
    insertLedgerRow(dbPath, { createdAt: 2_000 })

    const r1 = parseDbFile(dbPath, 0)
    expect(r1.records.map((r) => r.source.line)).toEqual([1, 2])
    expect(r1.nextLine).toBe(2)

    insertLedgerRow(dbPath, { createdAt: 3_000 })
    insertLedgerRow(dbPath, { createdAt: 4_000 })

    const r2 = parseDbFile(dbPath, r1.nextLine)
    expect(r2.records.map((r) => r.source.line)).toEqual([3, 4])
    expect(r2.nextLine).toBe(4)
    expect(r2.eof).toBe(true)

    const r3 = parseDbFile(dbPath, r2.nextLine)
    expect(r3.records).toHaveLength(0)
    expect(r3.nextLine).toBe(4)
    expect(r3.eof).toBe(true)
  })

  it('fromLine 越过最大 id：无记录、游标不倒退', () => {
    const dbPath = path.join(tmpDir, 'sessions.db')
    buildGooseDb(dbPath)
    insertLedgerRow(dbPath, {})
    const res = parseDbFile(dbPath, 99)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(99)
    expect(res.eof).toBe(true)
  })

  it('缺 usage_ledger 表：空结果且游标不推进', () => {
    const dbPath = path.join(tmpDir, 'empty.db')
    const db = new Database(dbPath)
    db.exec('CREATE TABLE unrelated (x TEXT)')
    db.close()
    const res = parseDbFile(dbPath, 42)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(42)
    expect(res.eof).toBe(true)
  })

  it('表存在但缺必需列：空结果且游标不推进', () => {
    const dbPath = path.join(tmpDir, 'partial.db')
    const db = new Database(dbPath)
    db.exec(
      'CREATE TABLE usage_ledger (id INTEGER PRIMARY KEY, session_id TEXT, created_timestamp INTEGER, model TEXT, input_tokens INTEGER, output_tokens INTEGER)'
    )
    db.prepare(
      'INSERT INTO usage_ledger (session_id, created_timestamp, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)'
    ).run('sess-x', 1_780_000_000, 'm', 10, 5)
    db.close()
    const res = parseDbFile(dbPath, 7)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(7)
    expect(res.eof).toBe(true)
  })

  it('损坏库文件与缺失文件：空结果且游标原样保留', () => {
    const broken = path.join(tmpDir, 'broken.db')
    fs.writeFileSync(broken, 'not a sqlite database', 'utf8')
    const r1 = parseDbFile(broken, 7)
    expect(r1.records).toHaveLength(0)
    expect(r1.nextLine).toBe(7)
    expect(r1.eof).toBe(true)

    const missing = path.join(tmpDir, 'missing.db')
    const r2 = parseDbFile(missing, 5)
    expect(r2.records).toHaveLength(0)
    expect(r2.nextLine).toBe(5)
    expect(r2.eof).toBe(true)
  })
})

describe('toUsageRecord 与 parseTsMs 宽松解析', () => {
  it('parseTsMs：数字秒乘 1000、毫秒原样、非正数与异常输入兜底当前时间', () => {
    expect(parseTsMs(1_780_000_000)).toBe(1_780_000_000_000)
    expect(parseTsMs(1_780_000_000_123)).toBe(1_780_000_000_123)
    for (const v of [0, -5, null, undefined, 'not-a-date']) {
      const t = parseTsMs(v)
      expect(Number.isNaN(t)).toBe(false)
      expect(Math.abs(t - Date.now())).toBeLessThan(60_000)
    }
  })

  it('toUsageRecord：sessionId NULL 不产出该值，line 取 rowid，无 requestId', () => {
    const rec = toUsageRecord(
      {
        id: 3,
        session_id: null,
        created_timestamp: 1_780_000_000,
        model: 'gpt-5',
        input_tokens: 10,
        output_tokens: 4,
        cache_read_tokens: 6,
        cache_write_tokens: 2
      },
      { filePath: 'sessions.db', line: 3 }
    )
    expect(rec).toMatchObject({
      appType: 'goose',
      model: 'gpt-5',
      rawModel: 'gpt-5',
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 6,
      cacheCreationTokens: 2,
      inputSemantics: 1,
      status: 'success',
      createdAt: 1_780_000_000_000
    })
    expect(rec.sessionId).toBeUndefined()
    expect(rec.source).toEqual({ filePath: 'sessions.db', line: 3 })
    expect('requestId' in rec.source).toBe(false)
  })
})

describe('插件级 parseFile 透传', () => {
  it('按 id 水位解析并回填 source.filePath 为传入绝对路径', async () => {
    const dir = path.join(tmpDir, 'sessions')
    const dbPath = dbPathOf(dir)
    buildGooseDb(dbPath)
    insertLedgerRow(dbPath, { sessionId: 'sess-pf' })
    const res = await goosePlugin.parseFile(ctx, dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].appType).toBe('goose')
    expect(res.records[0].source.filePath).toBe(dbPath)
    expect(res.records[0].sessionId).toBe('sess-pf')
    expect(res.eof).toBe(true)
  })
})
