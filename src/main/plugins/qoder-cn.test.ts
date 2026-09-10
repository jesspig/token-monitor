import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import {
  qoderCnPlugin,
  appSupportRootOf,
  qoderCnCandidatesFromOverrideRoot,
  qoderCnCandidatesFromRoots,
  qoderCnDbCandidates,
  QODER_CN_DETECT_MISSING_REASON
} from './qoder-cn'
import { detectFromDbPaths, listFilesFromDbPaths, parseQoderDbFile } from './_lib/qoder-shared'
import type { PluginContext } from '../../../shared/context'

const ctx = {} as PluginContext

let tmpDir = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-cn-plugin-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const CHAT_MESSAGE_DDL = `
  CREATE TABLE chat_message (
    id varchar(64) PRIMARY KEY,
    session_id VARCHAR(64),
    request_id VARCHAR(64),
    role VARCHAR(64),
    content TEXT,
    summary TEXT,
    summary_modified INTEGER,
    summary_trigger INTEGER DEFAULT 0,
    tool_result TEXT,
    token_info TEXT,
    model_info TEXT,
    extra TEXT DEFAULT '',
    gmt_create INTEGER
  )`

const CHAT_RECORD_DDL = `
  CREATE TABLE chat_record (
    request_id varchar(64) PRIMARY KEY,
    session_id varchar(64),
    extra TEXT DEFAULT ''
  )`

const DEFAULT_TOKEN_INFO = JSON.stringify({ prompt_tokens: 100, completion_tokens: 20, cached_tokens: 80 })
const DEFAULT_MODEL_INFO = JSON.stringify({ model_key: 'qwen-plus' })
const DEFAULT_GMT = 1_780_000_000_000

interface MessageSeed {
  id: string
  sessionId?: string | null
  requestId?: string | null
  role?: string | null
  tokenInfo?: string | null
  modelInfo?: string | null
  gmtCreate?: number | null
}

function messageValues(m: MessageSeed): unknown[] {
  return [
    m.id,
    m.sessionId ?? 'sess-1',
    m.requestId ?? `req-${m.id}`,
    m.role ?? 'assistant',
    null,
    null,
    null,
    0,
    null,
    m.tokenInfo === undefined ? DEFAULT_TOKEN_INFO : m.tokenInfo,
    m.modelInfo === undefined ? DEFAULT_MODEL_INFO : m.modelInfo,
    m.gmtCreate === undefined ? DEFAULT_GMT : m.gmtCreate
  ]
}

interface RecordSeed {
  requestId: string
  sessionId?: string
  extra?: string
}

function buildQoderCnDb(
  dbPath: string,
  opts: { messages?: MessageSeed[]; records?: RecordSeed[]; withRecordTable?: boolean } = {}
): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.exec(CHAT_MESSAGE_DDL)
  if (opts.withRecordTable !== false) db.exec(CHAT_RECORD_DDL)
  const insM = db.prepare(
    'INSERT INTO chat_message (id, session_id, request_id, role, content, summary, summary_modified, summary_trigger, tool_result, token_info, model_info, gmt_create) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  for (const m of opts.messages ?? []) insM.run(...messageValues(m))
  if (opts.withRecordTable !== false) {
    const insR = db.prepare('INSERT INTO chat_record (request_id, session_id, extra) VALUES (?, ?, ?)')
    for (const r of opts.records ?? []) insR.run(r.requestId, r.sessionId ?? '', r.extra ?? '')
  }
  db.close()
}

function appendMessage(dbPath: string, m: MessageSeed): void {
  const db = new Database(dbPath)
  db.prepare(
    'INSERT INTO chat_message (id, session_id, request_id, role, content, summary, summary_modified, summary_trigger, tool_result, token_info, model_info, gmt_create) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(...messageValues(m))
  db.close()
}

function writeWithMtime(p: string, atMs: number): number {
  fs.writeFileSync(p, '')
  const t = new Date(atMs)
  fs.utimesSync(p, t, t)
  return Math.round(fs.statSync(p).mtimeMs)
}

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[key]
  try {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
    return fn()
  } finally {
    if (prev === undefined) delete process.env[key]
    else process.env[key] = prev
  }
}

describe('qoderCnPlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(qoderCnPlugin.id).toBe('qoder-cn')
    expect(qoderCnPlugin.name).toBe('Qoder CN')
    expect(qoderCnPlugin.version).toBe('1.0.0')
    expect(qoderCnPlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('qoderCnDbCandidates 候选路径', () => {
  it('$QODER_CN_DIR 覆盖时候选为覆盖根下三种布局', () => {
    withEnv('QODER_CN_DIR', tmpDir, () => {
      expect(qoderCnDbCandidates()).toEqual(qoderCnCandidatesFromOverrideRoot(tmpDir))
      expect(qoderCnDbCandidates()).toEqual([
        path.join(tmpDir, 'shared_client', 'cache', 'db', 'local.db'),
        path.join(tmpDir, 'QoderCN', 'SharedClientCache', 'cache', 'db', 'local.db'),
        path.join(tmpDir, 'Qoder CN', 'SharedClientCache', 'cache', 'db', 'local.db')
      ])
    })
  })

  it('未覆盖时候选含 ~/.qoder-cn 插件布局与 QoderCN / Qoder CN 独立应用布局', () => {
    withEnv('QODER_CN_DIR', undefined, () => {
      const candidates = qoderCnDbCandidates()
      expect(candidates).toEqual(qoderCnCandidatesFromRoots(os.homedir(), appSupportRootOf()))
      expect(candidates[0]).toBe(path.join(os.homedir(), '.qoder-cn', 'shared_client', 'cache', 'db', 'local.db'))
      expect(candidates.some((p) => p.includes(path.join('QoderCN', 'SharedClientCache')))).toBe(true)
      expect(candidates.some((p) => p.includes(path.join('Qoder CN', 'SharedClientCache')))).toBe(true)
    })
  })
})

describe('detectFromDbPaths 探测', () => {
  it('无候选存在时不可用并给出中文原因与预期目录', () => {
    const dbPath = path.join(tmpDir, 'shared_client', 'cache', 'db', 'local.db')
    const res = detectFromDbPaths([dbPath], QODER_CN_DETECT_MISSING_REASON)
    expect(res.available).toBe(false)
    expect(res.reason).toBe(QODER_CN_DETECT_MISSING_REASON)
    expect(res.reason).toMatch(/未找到 Qoder CN 数据库/)
    expect(res.sessionDir).toBe(path.dirname(dbPath))
  })

  it('带空格 Qoder CN 目录布局存在时同样可用', () => {
    const spaced = path.join(tmpDir, 'Qoder CN', 'SharedClientCache', 'cache', 'db', 'local.db')
    buildQoderCnDb(spaced, { messages: [] })
    const res = detectFromDbPaths(
      [
        path.join(tmpDir, 'shared_client', 'cache', 'db', 'local.db'),
        path.join(tmpDir, 'QoderCN', 'SharedClientCache', 'cache', 'db', 'local.db'),
        spaced
      ],
      QODER_CN_DETECT_MISSING_REASON
    )
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(path.dirname(spaced))
  })
})

describe('插件级 detect', () => {
  it('$QODER_CN_DIR 指向的库存在时可用', async () => {
    const prev = process.env.QODER_CN_DIR
    try {
      process.env.QODER_CN_DIR = tmpDir
      buildQoderCnDb(path.join(tmpDir, 'QoderCN', 'SharedClientCache', 'cache', 'db', 'local.db'), {
        messages: []
      })
      const res = await qoderCnPlugin.detect(ctx)
      expect(res.available).toBe(true)
      expect(res.sessionDir).toBe(path.join(tmpDir, 'QoderCN', 'SharedClientCache', 'cache', 'db'))
    } finally {
      if (prev === undefined) delete process.env.QODER_CN_DIR
      else process.env.QODER_CN_DIR = prev
    }
  })

  it('$QODER_CN_DIR 指向的库缺失时不可用且原因为中文', async () => {
    const prev = process.env.QODER_CN_DIR
    try {
      process.env.QODER_CN_DIR = tmpDir
      const res = await qoderCnPlugin.detect(ctx)
      expect(res.available).toBe(false)
      expect(res.reason).toMatch(/未找到 Qoder CN 数据库/)
    } finally {
      if (prev === undefined) delete process.env.QODER_CN_DIR
      else process.env.QODER_CN_DIR = prev
    }
  })
})

describe('listFilesFromDbPaths 多路径枚举', () => {
  it('多个候选库并存时全部纳入，mtime 取各自 db 与 -wal 较大值', () => {
    const pluginDb = path.join(tmpDir, 'shared_client', 'cache', 'db', 'local.db')
    buildQoderCnDb(pluginDb, { messages: [] })
    const standaloneDb = path.join(tmpDir, 'QoderCN', 'SharedClientCache', 'cache', 'db', 'local.db')
    buildQoderCnDb(standaloneDb, { messages: [] })
    writeWithMtime(standaloneDb + '-wal', Date.now())

    const entries = listFilesFromDbPaths([pluginDb, standaloneDb, path.join(tmpDir, 'missing.db')])
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.path)).toEqual([pluginDb, standaloneDb])
    for (const e of entries) expect(e.mtime).toBeGreaterThan(0)
  })

  it('仅部分候选存在时缺失路径被忽略', () => {
    const standaloneDb = path.join(tmpDir, 'Qoder CN', 'SharedClientCache', 'cache', 'db', 'local.db')
    buildQoderCnDb(standaloneDb, { messages: [] })
    const missing = path.join(tmpDir, 'shared_client', 'cache', 'db', 'local.db')
    const entries = listFilesFromDbPaths([missing, standaloneDb])
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe(standaloneDb)
  })

  it('全部候选缺失时返回空数组', () => {
    const missing = path.join(tmpDir, 'nope', 'local.db')
    expect(listFilesFromDbPaths([missing, missing + '2', missing + '3'])).toEqual([])
  })

  it('db 与 -wal 并存且 wal 较新时条目 mtime 取较大值', () => {
    const dbPath = path.join(tmpDir, 'local.db')
    const dbMtime = writeWithMtime(dbPath, Date.now() - 60_000)
    const walMtime = writeWithMtime(dbPath + '-wal', Date.now())
    const entries = listFilesFromDbPaths([dbPath])
    expect(entries).toHaveLength(1)
    expect(entries[0].mtime).toBe(Math.max(dbMtime, walMtime))
    expect(entries[0].mtime).toBe(walMtime)
  })
})

describe('插件级 listFiles', () => {
  it('$QODER_CN_DIR 覆盖下枚举覆盖根内全部存在的库', async () => {
    const prev = process.env.QODER_CN_DIR
    try {
      process.env.QODER_CN_DIR = tmpDir
      const pluginDb = path.join(tmpDir, 'shared_client', 'cache', 'db', 'local.db')
      buildQoderCnDb(pluginDb, { messages: [] })
      const standaloneDb = path.join(tmpDir, 'QoderCN', 'SharedClientCache', 'cache', 'db', 'local.db')
      buildQoderCnDb(standaloneDb, { messages: [] })
      const entries = await qoderCnPlugin.listFiles(ctx)
      expect(entries).toHaveLength(2)
      expect(entries.map((e) => e.path)).toEqual([pluginDb, standaloneDb])
    } finally {
      if (prev === undefined) delete process.env.QODER_CN_DIR
      else process.env.QODER_CN_DIR = prev
    }
  })
})

describe('parseQoderDbFile 解析与水位游标', () => {
  it('assistant 行产出完整 UsageRecord（token_info JSON 解析、model_info.model_key、line=rowid）', () => {
    const dbPath = path.join(tmpDir, 'local.db')
    buildQoderCnDb(dbPath, {
      messages: [{ id: 'msg-1', sessionId: 'sess-cn', requestId: 'req-1', gmtCreate: 1_780_000_000_123 }]
    })
    const res = parseQoderDbFile('qoder-cn', dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({
      appType: 'qoder-cn',
      model: 'qwen-plus',
      rawModel: 'qwen-plus',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      cacheCreationTokens: 0,
      inputSemantics: 0,
      status: 'success',
      sessionId: 'sess-cn',
      createdAt: 1_780_000_000_123
    })
    expect(res.records[0].source).toEqual({
      filePath: dbPath,
      line: 1,
      requestId: 'req-1'
    })
    expect(res.nextLine).toBe(1)
    expect(res.eof).toBe(true)
  })

  it('model_info 无 model_key 时回退 chat_record.extra 的 modelConfig.key', () => {
    const dbPath = path.join(tmpDir, 'local.db')
    buildQoderCnDb(dbPath, {
      messages: [
        { id: 'msg-1', requestId: 'req-1', modelInfo: '{"foo":"bar"}' },
        { id: 'msg-2', requestId: 'req-2', modelInfo: '{"model_key":""}' }
      ],
      records: [
        { requestId: 'req-1', extra: JSON.stringify({ modelConfig: { key: 'qwen-plus' } }) },
        { requestId: 'req-2', extra: JSON.stringify({ modelConfig: { key: 'auto' } }) }
      ]
    })
    const res = parseQoderDbFile('qoder-cn', dbPath, 0)
    expect(res.records.map((r) => r.model)).toEqual(['qwen-plus', 'auto'])
  })

  it('model 双缺失的行跳过不产出，但水位仍推进', () => {
    const dbPath = path.join(tmpDir, 'local.db')
    buildQoderCnDb(dbPath, {
      messages: [
        { id: 'msg-bad', modelInfo: null },
        { id: 'msg-ok' }
      ]
    })
    const res = parseQoderDbFile('qoder-cn', dbPath, 0)
    expect(res.records.map((r) => r.source.requestId)).toEqual(['req-msg-ok'])
    expect(res.nextLine).toBe(2)
  })

  it('token_info 非 JSON 的行宽松跳过，水位仍推进', () => {
    const dbPath = path.join(tmpDir, 'local.db')
    buildQoderCnDb(dbPath, {
      messages: [
        { id: 'msg-broken', tokenInfo: 'not-json{{{' },
        { id: 'msg-ok' }
      ]
    })
    const res = parseQoderDbFile('qoder-cn', dbPath, 0)
    expect(res.records.map((r) => r.source.requestId)).toEqual(['req-msg-ok'])
    expect(res.nextLine).toBe(2)
  })

  it('token_info 为 NULL 或空串的行跳过', () => {
    const dbPath = path.join(tmpDir, 'local.db')
    buildQoderCnDb(dbPath, {
      messages: [
        { id: 'msg-null', tokenInfo: null },
        { id: 'msg-empty', tokenInfo: '' },
        { id: 'msg-ok' }
      ]
    })
    const res = parseQoderDbFile('qoder-cn', dbPath, 0)
    expect(res.records.map((r) => r.source.requestId)).toEqual(['req-msg-ok'])
    expect(res.nextLine).toBe(3)
  })

  it('prompt 与 completion 全零的行跳过（与官方 parseTokenInfo 语义一致）', () => {
    const dbPath = path.join(tmpDir, 'local.db')
    buildQoderCnDb(dbPath, {
      messages: [
        { id: 'msg-zero', tokenInfo: JSON.stringify({ prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 }) },
        { id: 'msg-only-cached', tokenInfo: JSON.stringify({ prompt_tokens: 0, completion_tokens: 0, cached_tokens: 50 }) },
        { id: 'msg-ok', tokenInfo: JSON.stringify({ prompt_tokens: 1, completion_tokens: 2, cached_tokens: 0 }) }
      ]
    })
    const res = parseQoderDbFile('qoder-cn', dbPath, 0)
    expect(res.records.map((r) => r.source.requestId)).toEqual(['req-msg-ok'])
    expect(res.nextLine).toBe(3)
  })

  it('role=user 行不产出记录，水位照常推进', () => {
    const dbPath = path.join(tmpDir, 'local.db')
    buildQoderCnDb(dbPath, {
      messages: [
        { id: 'msg-user', role: 'user' },
        { id: 'msg-assistant', role: 'assistant' },
        { id: 'msg-user-2', role: 'user' }
      ]
    })
    const res = parseQoderDbFile('qoder-cn', dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.requestId).toBe('req-msg-assistant')
    expect(res.records[0].source.line).toBe(2)
    expect(res.nextLine).toBe(3)
  })

  it('gmt_create 缺失或非正值时回退 Date.now()', () => {
    const dbPath = path.join(tmpDir, 'local.db')
    buildQoderCnDb(dbPath, {
      messages: [
        { id: 'msg-null-ts', gmtCreate: null },
        { id: 'msg-zero-ts', gmtCreate: 0 }
      ]
    })
    const before = Date.now()
    const res = parseQoderDbFile('qoder-cn', dbPath, 0)
    const after = Date.now()
    expect(res.records).toHaveLength(2)
    for (const r of res.records) {
      expect(r.createdAt).toBeGreaterThanOrEqual(before)
      expect(r.createdAt).toBeLessThanOrEqual(after)
    }
  })

  it('水位游标增量：只处理 rowid > fromLine 的行，无新行时游标不动', () => {
    const dbPath = path.join(tmpDir, 'local.db')
    buildQoderCnDb(dbPath, {
      messages: [
        { id: 'msg-1', gmtCreate: 1_000 },
        { id: 'msg-2', gmtCreate: 2_000 }
      ]
    })
    const r1 = parseQoderDbFile('qoder-cn', dbPath, 0)
    expect(r1.records).toHaveLength(2)
    expect(r1.records.map((r) => r.source.line)).toEqual([1, 2])
    expect(r1.nextLine).toBe(2)

    appendMessage(dbPath, { id: 'msg-3', gmtCreate: 3_000 })
    appendMessage(dbPath, { id: 'msg-4', gmtCreate: 4_000 })

    const r2 = parseQoderDbFile('qoder-cn', dbPath, r1.nextLine)
    expect(r2.records).toHaveLength(2)
    expect(r2.records.map((r) => r.source.line)).toEqual([3, 4])
    expect(r2.nextLine).toBe(4)
    expect(r2.eof).toBe(true)

    const r3 = parseQoderDbFile('qoder-cn', dbPath, r2.nextLine)
    expect(r3.records).toHaveLength(0)
    expect(r3.nextLine).toBe(4)
    expect(r3.eof).toBe(true)
  })

  it('db 缺失 / chat_message 表不存在 → 空结果且游标不推进', () => {
    const missing = path.join(tmpDir, 'nope.db')
    const r1 = parseQoderDbFile('qoder-cn', missing, 0)
    expect(r1.records).toHaveLength(0)
    expect(r1.nextLine).toBe(0)
    expect(r1.eof).toBe(true)

    const emptyDb = path.join(tmpDir, 'empty.db')
    const db = new Database(emptyDb)
    db.exec('CREATE TABLE unrelated (x TEXT)')
    db.close()
    const r2 = parseQoderDbFile('qoder-cn', emptyDb, 42)
    expect(r2.records).toHaveLength(0)
    expect(r2.nextLine).toBe(42)
    expect(r2.eof).toBe(true)
  })

  it('损坏的库文件安全返回空结果且游标不推进', () => {
    const broken = path.join(tmpDir, 'broken.db')
    fs.writeFileSync(broken, 'not a sqlite database')
    const res = parseQoderDbFile('qoder-cn', broken, 7)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(7)
    expect(res.eof).toBe(true)
  })

  it('缺 chat_record 表时降级为单表查询，chat_message 仍可解析', () => {
    const dbPath = path.join(tmpDir, 'norecord.db')
    buildQoderCnDb(dbPath, {
      withRecordTable: false,
      messages: [{ id: 'msg-solo', sessionId: 'sess-solo', requestId: 'req-solo' }]
    })
    const res = parseQoderDbFile('qoder-cn', dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({
      model: 'qwen-plus',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      sessionId: 'sess-solo'
    })
    expect(res.nextLine).toBe(1)
  })
})

describe('插件级 parseFile 透传', () => {
  it('按 rowid 水位解析并回填 source.filePath 为传入绝对路径', async () => {
    const dbPath = path.join(tmpDir, 'QoderCN', 'SharedClientCache', 'cache', 'db', 'local.db')
    buildQoderCnDb(dbPath, { messages: [{ id: 'msg-pf', requestId: 'req-pf' }] })
    const res = await qoderCnPlugin.parseFile(ctx, dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.filePath).toBe(dbPath)
    expect(res.records[0].source.requestId).toBe('req-pf')
    expect(res.records[0].appType).toBe('qoder-cn')
  })
})
