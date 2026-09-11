import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import {
  minimaxPlugin,
  dataRootOf,
  dbCandidatesOf,
  detectAtRoot,
  listFilesAtRoot,
  parseDbFile,
  toUsageRecord,
  parseTsMs,
  readTableColumns,
  hasRequiredColumns,
  MINIMAX_REQUIRED_COLUMNS
} from './minimax'
import type { PluginContext } from '../../../shared/context'

const ctx = {} as PluginContext

let tmpDir = ''

const envKeys = ['MINIMAX_DIR', 'MINIMAX_DATA_DIR', 'MAVIS_DATA_DIR'] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-plugin-'))
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

type DbKind = 'legacy' | 'runtime'

const KIND_DB: Record<DbKind, { file: string; table: string }> = {
  legacy: { file: 'sqlite.db', table: 'token_usage' },
  runtime: { file: path.join('v2', 'sqlite', 'runtime-state.sqlite'), table: 'local_runtime_token_usage' }
}

const usageTableDdl = (table: string): string => `
  CREATE TABLE ${table} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    turn_id TEXT,
    model TEXT,
    ts INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    reasoning_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    cost_usd REAL,
    agent_name TEXT,
    raw TEXT
  )`

const insertSql = (table: string): string =>
  `INSERT INTO ${table} (session_id, turn_id, model, ts, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, cost_usd, agent_name, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

interface UsageSeed {
  sessionId?: string | null
  turnId?: string | null
  model?: string | null
  ts?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
  cacheRead?: number | null
  cacheWrite?: number | null
}

function seedValues(s: UsageSeed): unknown[] {
  return [
    s.sessionId === undefined ? 'sess-1' : s.sessionId,
    s.turnId === undefined ? 'turn-1' : s.turnId,
    s.model === undefined ? 'minimax/MiniMax-M3' : s.model,
    s.ts === undefined ? 1_780_000_000 : s.ts,
    s.inputTokens === undefined ? 100 : s.inputTokens,
    s.outputTokens === undefined ? 20 : s.outputTokens,
    5,
    s.cacheRead === undefined ? 60 : s.cacheRead,
    s.cacheWrite === undefined ? 30 : s.cacheWrite,
    0.02,
    'coder',
    '{}'
  ]
}

function dbPathOf(root: string, kind: DbKind): string {
  return path.join(root, KIND_DB[kind].file)
}

function buildDb(root: string, kind: DbKind): string {
  const dbPath = dbPathOf(root, kind)
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.exec(usageTableDdl(KIND_DB[kind].table))
  db.close()
  return dbPath
}

function insertRow(dbPath: string, kind: DbKind, seed: UsageSeed = {}): number {
  const db = new Database(dbPath)
  const info = db.prepare(insertSql(KIND_DB[kind].table)).run(...seedValues(seed))
  db.close()
  return Number(info.lastInsertRowid)
}

function writeWithMtime(p: string, atMs: number): number {
  fs.writeFileSync(p, '')
  const t = new Date(atMs)
  fs.utimesSync(p, t, t)
  return Math.round(fs.statSync(p).mtimeMs)
}

describe('minimaxPlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(minimaxPlugin.id).toBe('minimax')
    expect(minimaxPlugin.name).toBe('MiniMax Code')
    expect(minimaxPlugin.version).toBe('1.0.0')
    expect(minimaxPlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('dataRootOf 探测优先级', () => {
  it('$MINIMAX_DIR 最高优先（同时设置其余变量仍取 $MINIMAX_DIR）', () => {
    process.env.MINIMAX_DIR = tmpDir
    process.env.MINIMAX_DATA_DIR = path.join(tmpDir, 'a')
    process.env.MAVIS_DATA_DIR = path.join(tmpDir, 'b')
    expect(dataRootOf()).toBe(tmpDir)
  })

  it('仅 $MINIMAX_DATA_DIR 非空时作为数据根', () => {
    process.env.MINIMAX_DATA_DIR = path.join(tmpDir, 'a')
    process.env.MAVIS_DATA_DIR = path.join(tmpDir, 'b')
    expect(dataRootOf()).toBe(path.join(tmpDir, 'a'))
  })

  it('仅 $MAVIS_DATA_DIR 非空时作为数据根', () => {
    process.env.MAVIS_DATA_DIR = path.join(tmpDir, 'b')
    expect(dataRootOf()).toBe(path.join(tmpDir, 'b'))
  })

  it('全部未设置时默认 ~/.minimax', () => {
    expect(dataRootOf()).toBe(path.join(os.homedir(), '.minimax'))
  })

  it('空白环境值视为未设置（trim 后逐级回退）', () => {
    process.env.MINIMAX_DIR = '   '
    process.env.MINIMAX_DATA_DIR = `  ${path.join(tmpDir, 'a')}  `
    process.env.MAVIS_DATA_DIR = path.join(tmpDir, 'b')
    expect(dataRootOf()).toBe(path.join(tmpDir, 'a'))

    process.env.MINIMAX_DATA_DIR = '  '
    expect(dataRootOf()).toBe(path.join(tmpDir, 'b'))
  })
})

describe('detect 三态与容错', () => {
  it('数据根缺失 → 不可用，原因含默认路径与覆盖变量说明', () => {
    const root = path.join(tmpDir, 'nope')
    const res = detectAtRoot(root)
    expect(res.available).toBe(false)
    expect(res.reason).toContain('未找到 MiniMax Code 数据目录')
    expect(res.reason).toContain('.minimax')
    expect(res.reason).toContain('$MINIMAX_DIR')
    expect(res.reason).toContain('$MINIMAX_DATA_DIR')
    expect(res.reason).toContain('$MAVIS_DATA_DIR')
    expect(res.sessionDir).toBe(root)
  })

  it('数据根存在但两库都缺 → 不可用，说明尚未产生用量', () => {
    const root = path.join(tmpDir, 'root')
    fs.mkdirSync(root, { recursive: true })
    const res = detectAtRoot(root)
    expect(res.available).toBe(false)
    expect(res.reason).toContain('尚未产生用量')
    expect(res.sessionDir).toBe(root)
  })

  it('仅 legacy 库存在 → 可用', () => {
    buildDb(tmpDir, 'legacy')
    const res = detectAtRoot(tmpDir)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(tmpDir)
  })

  it('仅 runtime 库存在 → 可用', () => {
    buildDb(tmpDir, 'runtime')
    const res = detectAtRoot(tmpDir)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(tmpDir)
  })

  it('插件级 detect 经 $MINIMAX_DIR 覆盖生效（先缺库不可用，建库后可用）', async () => {
    process.env.MINIMAX_DIR = tmpDir
    const missing = await minimaxPlugin.detect(ctx)
    expect(missing.available).toBe(false)
    expect(missing.reason).toContain('尚未产生用量')

    buildDb(tmpDir, 'legacy')
    const ok = await minimaxPlugin.detect(ctx)
    expect(ok.available).toBe(true)
    expect(ok.sessionDir).toBe(tmpDir)
  })
})

describe('listFilesAtRoot 双库收集', () => {
  it('双库并存返回两条，path 分别指向 legacy 与 runtime 库', () => {
    const legacyPath = buildDb(tmpDir, 'legacy')
    const runtimePath = buildDb(tmpDir, 'runtime')
    const entries = listFilesAtRoot(tmpDir)
    expect(entries.map((e) => e.path).sort()).toEqual([legacyPath, runtimePath].sort())
  })

  it('mtime 取库文件与 -wal 较大值', () => {
    const legacyPath = buildDb(tmpDir, 'legacy')
    const dbMtime = writeWithMtime(legacyPath, Date.now() - 60_000)
    const walMtime = writeWithMtime(legacyPath + '-wal', Date.now())
    const entries = listFilesAtRoot(tmpDir)
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe(legacyPath)
    expect(entries[0].mtime).toBe(Math.max(dbMtime, walMtime))
    expect(entries[0].mtime).toBe(walMtime)
  })

  it('仅 runtime 库存在返回一条；数据根缺失返回空数组', () => {
    const runtimePath = buildDb(tmpDir, 'runtime')
    expect(listFilesAtRoot(tmpDir)).toEqual([{ path: runtimePath, mtime: expect.any(Number) }])
    expect(listFilesAtRoot(path.join(tmpDir, 'nope'))).toEqual([])
  })

  it('插件级 listFiles 经 $MINIMAX_DIR 覆盖收集存在的库', async () => {
    process.env.MINIMAX_DIR = tmpDir
    const legacyPath = buildDb(tmpDir, 'legacy')
    const runtimePath = buildDb(tmpDir, 'runtime')
    const entries = await minimaxPlugin.listFiles(ctx)
    expect(entries.map((e) => e.path).sort()).toEqual([legacyPath, runtimePath].sort())
  })
})

describe('列探测', () => {
  it('必需列齐备通过、缺列失败，缓存两列在必需清单内', () => {
    const legacyPath = buildDb(tmpDir, 'legacy')
    const db = new Database(legacyPath, { readonly: true })
    expect(hasRequiredColumns(readTableColumns(db, KIND_DB.legacy.table))).toBe(true)
    db.close()

    const partialPath = path.join(tmpDir, 'partial.db')
    const db2 = new Database(partialPath)
    db2.exec(
      `CREATE TABLE ${KIND_DB.runtime.table} (id INTEGER PRIMARY KEY, session_id TEXT, turn_id TEXT, model TEXT, ts INTEGER, input_tokens INTEGER, output_tokens INTEGER)`
    )
    const cols = readTableColumns(db2, KIND_DB.runtime.table)
    db2.close()
    expect(hasRequiredColumns(cols)).toBe(false)
    expect(MINIMAX_REQUIRED_COLUMNS).toContain('cache_read_tokens')
    expect(MINIMAX_REQUIRED_COLUMNS).toContain('cache_write_tokens')
  })

  it('双库候选路径与表名对齐侦察结论', () => {
    expect(dbCandidatesOf(tmpDir)).toEqual([
      { kind: 'legacy', filePath: path.join(tmpDir, 'sqlite.db'), table: 'token_usage' },
      {
        kind: 'runtime',
        filePath: path.join(tmpDir, 'v2', 'sqlite', 'runtime-state.sqlite'),
        table: 'local_runtime_token_usage'
      }
    ])
  })
})

describe('parseDbFile 正常解析', () => {
  it('标准行映射：四桶、semantics=2、秒→毫秒，并使用 session/turn/id 稳定身份（reasoning 不计入）', () => {
    const dbPath = buildDb(tmpDir, 'legacy')
    insertRow(dbPath, 'legacy', {
      sessionId: 'sess-abc',
      turnId: 'turn-1',
      model: 'minimax/MiniMax-M3',
      ts: 1_780_000_000,
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
      appType: 'minimax',
      model: 'minimax/MiniMax-M3',
      inputTokens: 120,
      outputTokens: 45,
      cacheReadTokens: 80,
      cacheCreationTokens: 25,
      inputSemantics: 2,
      status: 'success',
      sessionId: 'sess-abc',
      createdAt: 1_780_000_000_000
    })
    expect(r.source).toEqual({
      filePath: dbPath,
      line: 1,
      requestId: 'minimax:["sess-abc","turn-1",1]'
    })
  })

  it('model 空串/NULL/空白记 unknown，行不跳过', () => {
    const dbPath = buildDb(tmpDir, 'legacy')
    insertRow(dbPath, 'legacy', { model: '' })
    insertRow(dbPath, 'legacy', { model: null })
    insertRow(dbPath, 'legacy', { model: '   ' })
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(3)
    for (const r of res.records) {
      expect(r.model).toBe('unknown')
    }
    expect(res.nextLine).toBe(3)
  })

  it('同一 session/turn 多行使用各自 id，保持独立 requestId', () => {
    const dbPath = buildDb(tmpDir, 'legacy')
    insertRow(dbPath, 'legacy', { turnId: 'turn-same', inputTokens: 10, outputTokens: 5 })
    insertRow(dbPath, 'legacy', { turnId: 'turn-same', inputTokens: 30, outputTokens: 7 })
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records.map((r) => r.inputTokens)).toEqual([10, 30])
    expect(res.records.map((r) => r.outputTokens)).toEqual([5, 7])
    expect(res.records.map((r) => r.source.line)).toEqual([1, 2])
    expect(res.records.map((r) => r.source.requestId)).toEqual([
      'minimax:["sess-1","turn-same",1]',
      'minimax:["sess-1","turn-same",2]'
    ])
  })

  it('双库不重叠 turn 使用不同 requestId，互不误合并', () => {
    const legacyPath = buildDb(tmpDir, 'legacy')
    const runtimePath = buildDb(tmpDir, 'runtime')
    insertRow(legacyPath, 'legacy', { sessionId: 'sess-l', turnId: 'turn-shared', model: 'minimax/MiniMax-M3' })
    insertRow(runtimePath, 'runtime', { sessionId: 'sess-r', turnId: 'turn-shared', model: 'minimax/MiniMax-M2' })
    const r1 = parseDbFile(legacyPath, 0)
    const r2 = parseDbFile(runtimePath, 0)
    expect(r1.records).toHaveLength(1)
    expect(r1.records[0]).toMatchObject({ sessionId: 'sess-l', model: 'minimax/MiniMax-M3' })
    expect(r1.records[0].source).toEqual({
      filePath: legacyPath,
      line: 1,
      requestId: 'minimax:["sess-l","turn-shared",1]'
    })
    expect(r2.records).toHaveLength(1)
    expect(r2.records[0]).toMatchObject({ sessionId: 'sess-r', model: 'minimax/MiniMax-M2' })
    expect(r2.records[0].source).toEqual({
      filePath: runtimePath,
      line: 1,
      requestId: 'minimax:["sess-r","turn-shared",1]'
    })
  })

  it('双库重叠的相同 session/turn/id 产生相同 requestId', () => {
    const legacyPath = buildDb(tmpDir, 'legacy')
    const runtimePath = buildDb(tmpDir, 'runtime')
    insertRow(legacyPath, 'legacy', { sessionId: 'sess-shared', turnId: 'turn-shared' })
    insertRow(runtimePath, 'runtime', { sessionId: 'sess-shared', turnId: 'turn-shared' })

    const legacy = parseDbFile(legacyPath, 0).records[0]
    const runtime = parseDbFile(runtimePath, 0).records[0]

    expect(legacy.source.filePath).toBe(legacyPath)
    expect(runtime.source.filePath).toBe(runtimePath)
    expect(legacy.source.line).toBe(1)
    expect(runtime.source.line).toBe(1)
    expect(legacy.source.requestId).toBe('minimax:["sess-shared","turn-shared",1]')
    expect(runtime.source.requestId).toBe(legacy.source.requestId)
  })

  it('双库相同 session/turn 但 id 不同时不合并', () => {
    const legacyPath = buildDb(tmpDir, 'legacy')
    const runtimePath = buildDb(tmpDir, 'runtime')
    insertRow(legacyPath, 'legacy', { sessionId: 'sess-shared', turnId: 'turn-shared' })
    insertRow(runtimePath, 'runtime', { sessionId: 'sess-other', turnId: 'turn-other' })
    insertRow(runtimePath, 'runtime', { sessionId: 'sess-shared', turnId: 'turn-shared' })

    const legacy = parseDbFile(legacyPath, 0).records[0]
    const runtime = parseDbFile(runtimePath, 0).records[1]

    expect(legacy.source.requestId).toBe('minimax:["sess-shared","turn-shared",1]')
    expect(runtime.source.requestId).toBe('minimax:["sess-shared","turn-shared",2]')
    expect(runtime.source.requestId).not.toBe(legacy.source.requestId)
  })

  it('缺失或空白 session_id/turn_id 时保守不写 requestId', () => {
    const dbPath = buildDb(tmpDir, 'legacy')
    insertRow(dbPath, 'legacy', { sessionId: null, turnId: 'turn-1' })
    insertRow(dbPath, 'legacy', { sessionId: 'sess-1', turnId: null })
    insertRow(dbPath, 'legacy', { sessionId: '   ', turnId: 'turn-3' })
    insertRow(dbPath, 'legacy', { sessionId: 'sess-4', turnId: '   ' })

    const res = parseDbFile(dbPath, 0)

    expect(res.records).toHaveLength(4)
    expect(res.records.map((r) => r.source.line)).toEqual([1, 2, 3, 4])
    for (const record of res.records) expect('requestId' in record.source).toBe(false)
  })

  it('相同数据库稳定重放保持 requestId 与 source.line 不变', () => {
    const dbPath = buildDb(tmpDir, 'runtime')
    insertRow(dbPath, 'runtime', { sessionId: ' sess-stable ', turnId: ' turn-stable ' })

    const first = parseDbFile(dbPath, 0).records[0]
    const replay = parseDbFile(dbPath, 0).records[0]

    expect(first.source).toEqual({
      filePath: dbPath,
      line: 1,
      requestId: 'minimax:["sess-stable","turn-stable",1]'
    })
    expect(replay.source).toEqual(first.source)
    expect(first.sessionId).toBe('sess-stable')
  })

  it('数值列 NULL/异常兜 0，semantics 仍为 2', () => {
    const dbPath = buildDb(tmpDir, 'runtime')
    insertRow(dbPath, 'runtime', {
      inputTokens: null,
      outputTokens: null,
      cacheRead: null,
      cacheWrite: null
    })
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      inputSemantics: 2
    })
  })

  it('ts 秒与毫秒双形态，NULL/0 兜底当前时间', () => {
    const dbPath = buildDb(tmpDir, 'legacy')
    insertRow(dbPath, 'legacy', { ts: 1_780_000_000 })
    insertRow(dbPath, 'legacy', { ts: 1_780_000_000_123 })
    insertRow(dbPath, 'legacy', { ts: null })
    insertRow(dbPath, 'legacy', { ts: 0 })
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

  it('空库（表在无行）：空结果、游标 0', () => {
    const dbPath = buildDb(tmpDir, 'legacy')
    const res = parseDbFile(dbPath, 0)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(0)
    expect(res.eof).toBe(true)
  })
})

describe('parseDbFile 游标增量与容错', () => {
  it('游标增量：续读只取新增，无新行时游标不动', () => {
    const dbPath = buildDb(tmpDir, 'legacy')
    insertRow(dbPath, 'legacy', { ts: 1_000 })
    insertRow(dbPath, 'legacy', { ts: 2_000 })

    const r1 = parseDbFile(dbPath, 0)
    expect(r1.records.map((r) => r.source.line)).toEqual([1, 2])
    expect(r1.nextLine).toBe(2)

    insertRow(dbPath, 'legacy', { ts: 3_000 })
    insertRow(dbPath, 'legacy', { ts: 4_000 })

    const r2 = parseDbFile(dbPath, r1.nextLine)
    expect(r2.records.map((r) => r.source.line)).toEqual([3, 4])
    expect(r2.nextLine).toBe(4)
    expect(r2.eof).toBe(true)

    const r3 = parseDbFile(dbPath, r2.nextLine)
    expect(r3.records).toHaveLength(0)
    expect(r3.nextLine).toBe(4)
    expect(r3.eof).toBe(true)
  })

  it('runtime 库同样按 rowid 水位增量', () => {
    const dbPath = buildDb(tmpDir, 'runtime')
    insertRow(dbPath, 'runtime', { ts: 1_000 })
    const r1 = parseDbFile(dbPath, 0)
    expect(r1.records.map((r) => r.source.line)).toEqual([1])
    insertRow(dbPath, 'runtime', { ts: 2_000 })
    const r2 = parseDbFile(dbPath, r1.nextLine)
    expect(r2.records.map((r) => r.source.line)).toEqual([2])
    expect(r2.nextLine).toBe(2)
  })

  it('fromLine 越过最大 id：无记录、游标不倒退', () => {
    const dbPath = buildDb(tmpDir, 'legacy')
    insertRow(dbPath, 'legacy', {})
    const res = parseDbFile(dbPath, 99)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(99)
    expect(res.eof).toBe(true)
  })

  it('缺用量表（legacy 库无 token_usage）：空结果且游标不推进', () => {
    const dbPath = path.join(tmpDir, 'sqlite.db')
    const db = new Database(dbPath)
    db.exec('CREATE TABLE unrelated (x TEXT)')
    db.close()
    const res = parseDbFile(dbPath, 42)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(42)
    expect(res.eof).toBe(true)
  })

  it('表存在但缺必需列（runtime 库少缓存列）：空结果且游标不推进', () => {
    const dbPath = path.join(tmpDir, 'v2', 'sqlite', 'runtime-state.sqlite')
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    const db = new Database(dbPath)
    db.exec(
      `CREATE TABLE ${KIND_DB.runtime.table} (id INTEGER PRIMARY KEY, session_id TEXT, turn_id TEXT, model TEXT, ts INTEGER, input_tokens INTEGER, output_tokens INTEGER)`
    )
    db.prepare(
      `INSERT INTO ${KIND_DB.runtime.table} (session_id, turn_id, model, ts, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('sess-x', 'turn-x', 'minimax/MiniMax-M3', 1_780_000_000, 10, 5)
    db.close()
    const res = parseDbFile(dbPath, 7)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(7)
    expect(res.eof).toBe(true)
  })

  it('损坏库文件与缺失文件：空结果且游标原样保留', () => {
    const broken = path.join(tmpDir, 'sqlite.db')
    fs.writeFileSync(broken, 'not a sqlite database', 'utf8')
    const r1 = parseDbFile(broken, 7)
    expect(r1.records).toHaveLength(0)
    expect(r1.nextLine).toBe(7)
    expect(r1.eof).toBe(true)

    const missing = path.join(tmpDir, 'missing.sqlite')
    const r2 = parseDbFile(missing, 5)
    expect(r2.records).toHaveLength(0)
    expect(r2.nextLine).toBe(5)
    expect(r2.eof).toBe(true)
  })
})

describe('插件级 parseFile 透传', () => {
  it('按 id 水位解析并回填 source.filePath 为传入绝对路径', async () => {
    const dbPath = buildDb(tmpDir, 'legacy')
    insertRow(dbPath, 'legacy', { sessionId: 'sess-pf' })
    const res = await minimaxPlugin.parseFile(ctx, dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].appType).toBe('minimax')
    expect(res.records[0].source.filePath).toBe(dbPath)
    expect(res.records[0].sessionId).toBe('sess-pf')
    expect(res.eof).toBe(true)
  })

  it('runtime 库文件按文件名路由到 local_runtime_token_usage 表', async () => {
    const dbPath = buildDb(tmpDir, 'runtime')
    insertRow(dbPath, 'runtime', { sessionId: 'sess-rt' })
    const res = await minimaxPlugin.parseFile(ctx, dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({ appType: 'minimax', inputSemantics: 2, sessionId: 'sess-rt' })
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

  it('toUsageRecord：session/turn 完整但 id 无效时不写 requestId', () => {
    const rec = toUsageRecord(
      {
        id: null,
        session_id: 'sess-1',
        turn_id: 'turn-1',
        model: 'minimax/MiniMax-M3',
        ts: 1_780_000_000,
        input_tokens: 10,
        output_tokens: 4,
        cache_read_tokens: 6,
        cache_write_tokens: 2
      },
      { filePath: 'runtime-state.sqlite', line: 9 }
    )

    expect(rec.sessionId).toBe('sess-1')
    expect(rec.source).toEqual({ filePath: 'runtime-state.sqlite', line: 9 })
    expect('requestId' in rec.source).toBe(false)
  })

  it('toUsageRecord：身份不完整时不产出 sessionId/requestId，line 仍取 rowid', () => {
    const rec = toUsageRecord(
      {
        id: 3,
        session_id: null,
        turn_id: 'turn-9',
        model: 'minimax/MiniMax-M3',
        ts: 1_780_000_000,
        input_tokens: 10,
        output_tokens: 4,
        cache_read_tokens: 6,
        cache_write_tokens: 2
      },
      { filePath: 'runtime-state.sqlite', line: 3 }
    )
    expect(rec).toMatchObject({
      appType: 'minimax',
      model: 'minimax/MiniMax-M3',
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 6,
      cacheCreationTokens: 2,
      inputSemantics: 2,
      status: 'success',
      createdAt: 1_780_000_000_000
    })
    expect(rec.sessionId).toBeUndefined()
    expect(rec.source).toEqual({ filePath: 'runtime-state.sqlite', line: 3 })
    expect('requestId' in rec.source).toBe(false)
  })
})
