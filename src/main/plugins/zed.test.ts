import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import {
  zedPlugin,
  dataDirOf,
  dbPathOf,
  detectFromDb,
  listFilesFromDb,
  parseDbFile,
  projectFromFolders,
  statMtimeMs,
  maxMtime
} from './zed'
import type { PluginContext } from '../../../shared/context'

let tmpDir = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zed-plugin-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const ZSTD_FRAME_MAGIC = 0xfd2fb528

function makeZstdFrame(payload: Buffer): Buffer {
  if (payload.length >= 65_280) throw new Error('测试帧明文超出双字节 FCS 编码上限')
  const wideFcs = payload.length >= 256
  const fcsBytes = wideFcs ? 2 : 1
  const blockHeaderOffset = 5 + fcsBytes
  const frame = Buffer.alloc(blockHeaderOffset + 3 + payload.length)
  frame.writeUInt32LE(ZSTD_FRAME_MAGIC, 0)
  frame[4] = wideFcs ? 0x60 : 0x20
  if (wideFcs) frame.writeUIntLE(payload.length - 256, 5, 2)
  else frame[5] = payload.length
  frame.writeUIntLE((payload.length << 3) | 1, blockHeaderOffset, 3)
  payload.copy(frame, blockHeaderOffset + 3)
  return frame
}

interface ThreadSeed {
  id: string
  json: string
  dataType?: string
  updatedAt?: string
  createdAt?: string | null
  folderPaths?: string | null
  folderOrder?: string | null
}

const FULL_SCHEMA = `
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    data_type TEXT NOT NULL,
    data BLOB NOT NULL,
    parent_id TEXT,
    folder_paths TEXT,
    folder_paths_order TEXT,
    created_at TEXT
  );
`

const MINIMAL_SCHEMA = `
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    data_type TEXT NOT NULL,
    data BLOB NOT NULL
  );
`

function encodeData(seed: ThreadSeed): Buffer {
  const dataType = seed.dataType ?? 'zstd'
  if (dataType === 'zstd') return makeZstdFrame(Buffer.from(seed.json, 'utf8'))
  return Buffer.from(seed.json, 'utf8')
}

function buildThreadsDb(
  dbPath: string,
  seeds: ThreadSeed[],
  schema: 'full' | 'minimal' = 'full'
): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.exec(schema === 'full' ? FULL_SCHEMA : MINIMAL_SCHEMA)
  const isFull = schema === 'full'
  const insert = db.prepare(
    isFull
      ? `INSERT INTO threads (id, summary, updated_at, data_type, data, created_at, folder_paths, folder_paths_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      : `INSERT INTO threads (id, summary, updated_at, data_type, data)
         VALUES (?, ?, ?, ?, ?)`
  )
  for (const seed of seeds) {
    const shared = [
      seed.id,
      'Test thread',
      seed.updatedAt ?? '2026-05-01T12:30:00Z',
      seed.dataType ?? 'zstd',
      encodeData(seed)
    ]
    if (isFull) {
      insert.run(
        ...shared,
        seed.createdAt ?? null,
        seed.folderPaths ?? null,
        seed.folderOrder ?? null
      )
    } else {
      insert.run(...shared)
    }
  }
  db.close()
}

function updateThreadData(dbPath: string, id: string, json: string, updatedAt: string): void {
  const db = new Database(dbPath)
  db.prepare(`UPDATE threads SET data = ?, updated_at = ? WHERE id = ?`).run(
    makeZstdFrame(Buffer.from(json, 'utf8')),
    updatedAt,
    id
  )
  db.close()
}

interface ThreadJsonOpts {
  provider?: string
  model?: string
  usage?: unknown
  cumulative?: unknown
  imported?: boolean
  updatedAt?: string
  withModel?: boolean
}

function threadJson(opts: ThreadJsonOpts = {}): string {
  const payload: Record<string, unknown> = {
    version: '0.3.0',
    title: 'Test thread',
    messages: [],
    updated_at: opts.updatedAt ?? '2026-05-01T12:30:00Z'
  }
  if (opts.usage !== undefined) payload.request_token_usage = opts.usage
  if (opts.cumulative !== undefined) payload.cumulative_token_usage = opts.cumulative
  if (opts.withModel !== false) {
    payload.model = { provider: opts.provider ?? 'zed.dev', model: opts.model ?? 'claude-sonnet-4-5' }
  }
  if (opts.imported !== undefined) payload.imported = opts.imported
  return JSON.stringify(payload)
}

function usageEntry(input: number, output: number, cacheRead = 0, cacheCreation = 0) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation
  }
}

interface SavedCursor {
  lineOffset?: number
  byteOffset?: number | null
}

function makeCtxWithStorage(saved?: SavedCursor): {
  ctx: PluginContext
  cursorWrites: Array<{ filePath: string; line: number; mtime?: number; byteOffset?: number | null }>
} {
  const cursorWrites: Array<{
    filePath: string
    line: number
    mtime?: number
    byteOffset?: number | null
  }> = []
  const ctx = {
    storage: {
      getCursorMeta: async () =>
        saved === undefined
          ? null
          : { lineOffset: saved.lineOffset ?? 0, fileMtime: 0, byteOffset: saved.byteOffset ?? null },
      setCursor: async (
        filePath: string,
        line: number,
        mtime?: number,
        byteOffset?: number | null
      ) => {
        cursorWrites.push({ filePath, line, mtime, byteOffset })
      }
    }
  } as unknown as PluginContext
  return { ctx, cursorWrites }
}

describe('zedPlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(zedPlugin.id).toBe('zed')
    expect(zedPlugin.name).toBe('Zed')
    expect(zedPlugin.version).toBe('1.0.0')
    expect(zedPlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('dbPathOf 平台路径解析', () => {
  it('win32 取 LOCALAPPDATA 下的 Zed\\threads\\threads.db', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' }
    expect(dbPathOf('win32', env)).toBe(
      path.join('C:\\Users\\demo\\AppData\\Local', 'Zed', 'threads', 'threads.db')
    )
    expect(dataDirOf('win32', env)).toBe(path.join('C:\\Users\\demo\\AppData\\Local', 'Zed'))
  })

  it('win32 LOCALAPPDATA 缺省时回退 home 下 AppData/Local', () => {
    const dir = dataDirOf('win32', {})
    expect(dir).toBe(path.join(os.homedir(), 'AppData', 'Local', 'Zed'))
  })

  it('darwin 取 Application Support/Zed/threads/threads.db', () => {
    expect(dbPathOf('darwin', {})).toBe(
      path.join(os.homedir(), 'Library', 'Application Support', 'Zed', 'threads', 'threads.db')
    )
  })

  it('linux 优先 XDG_DATA_HOME 且目录为小写 zed', () => {
    const env = { XDG_DATA_HOME: '/xdg/data' }
    expect(dbPathOf('linux', env)).toBe(path.join('/xdg/data', 'zed', 'threads', 'threads.db'))
  })

  it('linux 无 XDG_DATA_HOME 时回退 ~/.local/share/zed', () => {
    expect(dbPathOf('linux', {})).toBe(
      path.join(os.homedir(), '.local', 'share', 'zed', 'threads', 'threads.db')
    )
  })

  it('ZED_DIR 环境变量覆盖覆盖优先于平台默认', () => {
    expect(dataDirOf('win32', { ZED_DIR: 'D:\\zed-data' })).toBe('D:\\zed-data')
    expect(dbPathOf('win32', { ZED_DIR: 'D:\\zed-data' })).toBe(
      path.join('D:\\zed-data', 'threads', 'threads.db')
    )
  })
})

describe('detectFromDb 探测', () => {
  it('threads.db 缺失时不可用并给出中文原因与 threads 目录', () => {
    const dbPath = path.join(tmpDir, 'threads', 'threads.db')
    const res = detectFromDb(dbPath)
    expect(res.available).toBe(false)
    expect(res.reason).toContain('threads.db')
    expect(res.sessionDir).toBe(path.dirname(dbPath))
  })

  it('threads.db 存在时可用且 sessionDir 为 threads 目录', () => {
    const dbPath = path.join(tmpDir, 'threads', 'threads.db')
    buildThreadsDb(dbPath, [])
    const res = detectFromDb(dbPath)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(path.dirname(dbPath))
  })

  it('插件级 detect 读取 $ZED_DIR 覆盖的数据目录', async () => {
    const prev = process.env.ZED_DIR
    try {
      process.env.ZED_DIR = tmpDir
      const dbPath = path.join(tmpDir, 'threads', 'threads.db')
      buildThreadsDb(dbPath, [])
      const res = await zedPlugin.detect({} as PluginContext)
      expect(res.available).toBe(true)
      expect(res.sessionDir).toBe(path.join(tmpDir, 'threads'))
    } finally {
      if (prev === undefined) delete process.env.ZED_DIR
      else process.env.ZED_DIR = prev
    }
  })
})

describe('listFilesFromDb 收集范围与 WAL 感知', () => {
  function writeWithMtime(p: string, atMs: number): number {
    fs.writeFileSync(p, '')
    const t = new Date(atMs)
    fs.utimesSync(p, t, t)
    return Math.round(fs.statSync(p).mtimeMs)
  }

  it('threads.db 存在时返回单条目（path 为 db 绝对路径，mtime>0）', () => {
    const dbPath = path.join(tmpDir, 'threads', 'threads.db')
    buildThreadsDb(dbPath, [])
    const entries = listFilesFromDb(dbPath)
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe(dbPath)
    expect(entries[0].mtime).toBeGreaterThan(0)
  })

  it('-wal 较新时条目 mtime 取两者较大值，path 仍为 db 路径', () => {
    const dbPath = path.join(tmpDir, 'threads', 'threads.db')
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    const dbMtime = writeWithMtime(dbPath, Date.now() - 60_000)
    const walMtime = writeWithMtime(dbPath + '-wal', Date.now())
    const entries = listFilesFromDb(dbPath)
    expect(entries).toHaveLength(1)
    expect(entries[0].mtime).toBe(Math.max(dbMtime, walMtime))
    expect(entries[0].mtime).toBe(walMtime)
  })

  it('threads.db 缺失时返回空数组', () => {
    expect(listFilesFromDb(path.join(tmpDir, 'nope', 'threads.db'))).toEqual([])
  })

  it('statMtimeMs/maxMtime 对缺失路径兜底为 0', () => {
    const missing = path.join(tmpDir, 'missing.db')
    expect(statMtimeMs(missing)).toBe(0)
    expect(maxMtime([missing, missing + '-wal'])).toBe(0)
    expect(maxMtime([])).toBe(0)
  })
})

describe('parseDbFile thread 行解析', () => {
  it('zstd 压缩行（object 形态 request_token_usage）每请求产出一条记录', async () => {
    const dbPath = path.join(tmpDir, 'threads', 'threads.db')
    buildThreadsDb(dbPath, [
      {
        id: 'thread-1',
        json: threadJson({
          usage: {
            'user-1': usageEntry(100, 20, 10, 5),
            'user-2': usageEntry(50, 7)
          },
          updatedAt: '2026-05-01T12:30:00Z'
        }),
        updatedAt: '2026-05-01T12:30:00Z',
        createdAt: '2026-05-01T12:00:00Z',
        folderPaths: '/workspace/a',
        folderOrder: null
      }
    ])
    const { ctx } = makeCtxWithStorage()
    const res = await parseDbFile(ctx, dbPath, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records[0]).toMatchObject({
      appType: 'zed',
      model: 'claude-sonnet-4-5',
      rawModel: 'claude-sonnet-4-5',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
      inputSemantics: 2,
      status: 'success',
      project: '/workspace/a',
      sessionId: 'thread-1',
      createdAt: Date.parse('2026-05-01T12:00:00Z')
    })
    expect(res.records[0].source).toEqual({
      filePath: dbPath,
      line: 1000,
      requestId: 'thread-1:user-1'
    })
    expect(res.records[1].source).toEqual({
      filePath: dbPath,
      line: 1001,
      requestId: 'thread-1:user-2'
    })
    expect(res.records[1].inputTokens).toBe(50)
    expect(res.records[1].outputTokens).toBe(7)
    expect(res.nextLine).toBe(1)
    expect(res.eof).toBe(true)
  })

  it('明文 json 行（data_type=json）照常解析，data_type 大小写宽容', async () => {
    const dbPath = path.join(tmpDir, 'threads', 'threads.db')
    buildThreadsDb(dbPath, [
      {
        id: 'thread-json',
        json: threadJson({ usage: { 'user-1': usageEntry(11, 22) } }),
        dataType: 'JSON',
        updatedAt: '2026-05-01T12:30:00Z'
      }
    ])
    const { ctx } = makeCtxWithStorage()
    const res = await parseDbFile(ctx, dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].inputTokens).toBe(11)
    expect(res.records[0].outputTokens).toBe(22)
    expect(res.records[0].source.requestId).toBe('thread-json:user-1')
  })

  it('provider 非 zed.dev（外部 ACP agent）整行排除，水位照常推进', async () => {
    const dbPath = path.join(tmpDir, 'threads', 'threads.db')
    buildThreadsDb(dbPath, [
      {
        id: 'thread-ext',
        json: threadJson({ provider: 'anthropic', usage: { 'user-1': usageEntry(100, 20) } })
      }
    ])
    const { ctx } = makeCtxWithStorage()
    const res = await parseDbFile(ctx, dbPath, 0)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(1)
  })

  it('provider 比较大小写不敏感（ZED.DEV 保留）', async () => {
    const dbPath = path.join(tmpDir, 'threads', 'threads.db')
    buildThreadsDb(dbPath, [
      {
        id: 'thread-upper',
        json: threadJson({ provider: 'ZED.DEV', usage: { 'user-1': usageEntry(8, 9) } })
      }
    ])
    const { ctx } = makeCtxWithStorage()
    const res = await parseDbFile(ctx, dbPath, 0)
    expect(res.records).toHaveLength(1)
  })

  it('imported=true 的 thread 整行排除', async () => {
    const dbPath = path.join(tmpDir, 'threads', 'threads.db')
    buildThreadsDb(dbPath, [
      {
        id: 'thread-imported',
        json: threadJson({ usage: { 'user-1': usageEntry(100, 20) }, imported: true })
      }
    ])
    const { ctx } = makeCtxWithStorage()
    const res = await parseDbFile(ctx, dbPath, 0)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(1)
  })

  it('array 形态 request_token_usage 按序号产出 requestId，全零条目跳过', async () => {
    const dbPath = path.join(tmpDir, 'threads', 'threads.db')
    buildThreadsDb(dbPath, [
      {
        id: 'thread-arr',
        json: threadJson({
          usage: [usageEntry(10, 1), usageEntry(0, 0, 0, 0), usageEntry(20, 2)]
        })
      }
    ])
    const { ctx } = makeCtxWithStorage()
    const res = await parseDbFile(ctx, dbPath, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records[0].source).toMatchObject({ line: 1000, requestId: 'thread-arr:0' })
    expect(res.records[1].source).toMatchObject({ line: 1002, requestId: 'thread-arr:2' })
    expect(res.records[1].inputTokens).toBe(20)
  })

  it('request_token_usage 汇总为零时回退 cumulative_token_usage（requestId 带 cumulative 标记）', async () => {
    const dbPath = path.join(tmpDir, 'threads', 'threads.db')
    buildThreadsDb(dbPath, [
      {
        id: 'thread-cum',
        json: threadJson({
          usage: {},
          cumulative: usageEntry(12, 3, 4, 2)
        })
      }
    ])
    const { ctx } = makeCtxWithStorage()
    const res = await parseDbFile(ctx, dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 4,
      cacheCreationTokens: 2,
      inputSemantics: 2
    })
    expect(res.records[0].source).toMatchObject({ line: 1000, requestId: 'thread-cum:cumulative' })
  })

  it('request_token_usage 缺失时直接采用 cumulative_token_usage', async () => {
    const dbPath = path.join(tmpDir, 'threads', 'threads.db')
    buildThreadsDb(dbPath, [
      {
        id: 'thread-noreq',
        json: threadJson({ cumulative: usageEntry(7, 1) })
      }
    ])
    const { ctx } = makeCtxWithStorage()
    const res = await parseDbFile(ctx, dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].inputTokens).toBe(7)
    expect(res.records[0].outputTokens).toBe(1)
  })

  it('usage 字段宽容解析：数字字符串可解析、负值钳制为 0', async () => {
    const dbPath = path.join(tmpDir, 'threads', 'threads.db')
    buildThreadsDb(dbPath, [
      {
        id: 'thread-lenient',
        json: threadJson({
          usage: {
            'user-1': {
              input_tokens: '150',
              output_tokens: '20',
              cache_read_input_tokens: -5,
              cache_creation_input_tokens: 3
            }
          }
        })
      }
    ])
    const { ctx } = makeCtxWithStorage()
    const res = await parseDbFile(ctx, dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({
      inputTokens: 150,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 3
    })
  })

  it('model 字段缺失或 model.model 为空时整行跳过', async () => {
    const dbPath = path.join(tmpDir, 'threads', 'threads.db')
    buildThreadsDb(dbPath, [
      { id: 'thread-nomodel', json: threadJson({ withModel: false, usage: { 'user-1': usageEntry(1, 1) } }) },
      { id: 'thread-emptymodel', json: threadJson({ model: '   ', usage: { 'user-1': usageEntry(1, 1) } }) },
      { id: 'thread-ok', json: threadJson({ usage: { 'user-1': usageEntry(2, 2) } }) }
    ])
    const { ctx } = makeCtxWithStorage()
    const res = await parseDbFile(ctx, dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].sessionId).toBe('thread-ok')
    expect(res.nextLine).toBe(3)
  })

  it('project 取 folder_paths 中 order 最小序的路径，无 order 时取首行', async () => {
    expect(projectFromFolders('/sorted/a\n/sorted/b', '1,0')).toBe('/sorted/b')
    expect(projectFromFolders('/sorted/a\n/sorted/b', null)).toBe('/sorted/a')
    expect(projectFromFolders('/only/a', '9')).toBe('/only/a')
    expect(projectFromFolders(null, null)).toBeUndefined()
    expect(projectFromFolders('  \n  ', '1')).toBeUndefined()

    const dbPath = path.join(tmpDir, 'threads', 'threads.db')
    buildThreadsDb(dbPath, [
      {
        id: 'thread-folders',
        json: threadJson({ usage: { 'user-1': usageEntry(1, 1) } }),
        folderPaths: '/sorted/a\n/sorted/b',
        folderOrder: '1,0'
      }
    ])
    const { ctx } = makeCtxWithStorage()
    const res = await parseDbFile(ctx, dbPath, 0)
    expect(res.records[0].project).toBe('/sorted/b')
  })

  it('createdAt 三级回退：row.created_at → row.updated_at → JSON.updated_at → Date.now()', async () => {
    const dbPath = path.join(tmpDir, 'threads', 'threads.db')
    buildThreadsDb(dbPath, [
      {
        id: 'thread-ts-created',
        json: threadJson({ usage: { 'user-1': usageEntry(1, 1) }, updatedAt: '2026-05-01T14:00:00Z' }),
        updatedAt: '2026-05-01T13:00:00Z',
        createdAt: '2026-05-01T12:00:00Z'
      },
      {
        id: 'thread-ts-updated',
        json: threadJson({ usage: { 'user-1': usageEntry(1, 1) }, updatedAt: '2026-05-01T14:00:00Z' }),
        updatedAt: '2026-05-01T13:00:00Z',
        createdAt: null
      },
      {
        id: 'thread-ts-json',
        json: threadJson({ usage: { 'user-1': usageEntry(1, 1) }, updatedAt: '2026-05-01T14:00:00Z' }),
        updatedAt: 'garbage',
        createdAt: 'also-garbage'
      }
    ])
    const { ctx } = makeCtxWithStorage()
    const startedAt = Date.now()
    const res = await parseDbFile(ctx, dbPath, 0)
    expect(res.records).toHaveLength(3)
    expect(res.records[0].createdAt).toBe(Date.parse('2026-05-01T12:00:00Z'))
    expect(res.records[1].createdAt).toBe(Date.parse('2026-05-01T13:00:00Z'))
    expect(res.records[2].createdAt).toBe(Date.parse('2026-05-01T14:00:00Z'))

    const dbPath2 = path.join(tmpDir, 'threads2', 'threads.db')
    buildThreadsDb(dbPath2, [
      {
        id: 'thread-ts-none',
        json: threadJson({ usage: { 'user-1': usageEntry(1, 1) }, updatedAt: 'never' }),
        updatedAt: 'nope',
        createdAt: 'nope'
      }
    ])
    const res2 = await parseDbFile(ctx, dbPath2, 0)
    expect(res2.records[0].createdAt).toBeGreaterThanOrEqual(startedAt)
  })
})

describe('parseDbFile 游标增量与容错', () => {
  it('rowid 游标增量：只解析 rowid > fromLine 的新行', async () => {
    const dbPath = path.join(tmpDir, 'threads', 'threads.db')
    buildThreadsDb(dbPath, [
      { id: 'thread-a', json: threadJson({ usage: { 'user-1': usageEntry(1, 1) } }), updatedAt: '2026-05-01T10:00:00Z' },
      { id: 'thread-b', json: threadJson({ usage: { 'user-1': usageEntry(2, 2) } }), updatedAt: '2026-05-01T11:00:00Z' }
    ])
    const { ctx } = makeCtxWithStorage()
    const r1 = await parseDbFile(ctx, dbPath, 0)
    expect(r1.records).toHaveLength(2)
    expect(r1.records.map((r) => r.sessionId)).toEqual(['thread-a', 'thread-b'])
    expect(r1.nextLine).toBe(2)

    const db = new Database(dbPath)
    db.prepare(
      `INSERT INTO threads (id, summary, updated_at, data_type, data, created_at, folder_paths, folder_paths_order)
       VALUES (?, ?, ?, 'zstd', ?, NULL, NULL, NULL)`
    ).run(
      'thread-c',
      'Test thread',
      '2026-05-01T12:00:00Z',
      makeZstdFrame(Buffer.from(threadJson({ usage: { 'user-1': usageEntry(3, 3) } }), 'utf8'))
    )
    db.close()

    const r2 = await parseDbFile(
      makeCtxWithStorage({ lineOffset: r1.nextLine, byteOffset: Date.parse('2026-05-01T11:00:00Z') }).ctx,
      dbPath,
      r1.nextLine
    )
    expect(r2.records).toHaveLength(1)
    expect(r2.records[0].sessionId).toBe('thread-c')
    expect(r2.records[0].source.line).toBe(3000)
    expect(r2.nextLine).toBe(3)
  })

  it('updated_at 水位：rowid 不变的更新行在 byteOffset 水位推进后被重扫，新增请求产出', async () => {
    const dbPath = path.join(tmpDir, 'threads', 'threads.db')
    const t1 = '2026-05-01T12:00:00Z'
    const t2 = '2026-05-01T13:00:00Z'
    buildThreadsDb(dbPath, [
      {
        id: 'thread-live',
        json: threadJson({ usage: { 'user-1': usageEntry(10, 1) }, updatedAt: t1 }),
        updatedAt: t1
      }
    ])

    const first = makeCtxWithStorage()
    const r1 = await parseDbFile(first.ctx, dbPath, 0)
    expect(r1.records).toHaveLength(1)
    expect(r1.records[0].source.requestId).toBe('thread-live:user-1')
    expect(first.cursorWrites).toEqual([
      { filePath: dbPath, line: 1, mtime: undefined, byteOffset: Date.parse(t1) }
    ])

    updateThreadData(
      dbPath,
      'thread-live',
      threadJson({ usage: { 'user-1': usageEntry(10, 1), 'user-2': usageEntry(20, 2) }, updatedAt: t2 }),
      t2
    )

    const second = makeCtxWithStorage({ lineOffset: r1.nextLine, byteOffset: Date.parse(t1) })
    const r2 = await parseDbFile(second.ctx, dbPath, r1.nextLine)
    expect(r2.records.map((r) => r.source.requestId).sort()).toEqual([
      'thread-live:user-1',
      'thread-live:user-2'
    ])
    expect(r2.records[0].sessionId).toBe('thread-live')
    expect(second.cursorWrites).toEqual([
      { filePath: dbPath, line: 1, mtime: undefined, byteOffset: Date.parse(t2) }
    ])
  })

  it('updated_at 水位未推进时已扫行不重复产出，游标不推进', async () => {
    const dbPath = path.join(tmpDir, 'threads', 'threads.db')
    const t1 = '2026-05-01T12:00:00Z'
    buildThreadsDb(dbPath, [
      { id: 'thread-idle', json: threadJson({ usage: { 'user-1': usageEntry(10, 1) }, updatedAt: t1 }), updatedAt: t1 }
    ])
    const first = makeCtxWithStorage()
    const r1 = await parseDbFile(first.ctx, dbPath, 0)
    expect(r1.records).toHaveLength(1)

    const second = makeCtxWithStorage({ lineOffset: r1.nextLine, byteOffset: Date.parse(t1) })
    const r2 = await parseDbFile(second.ctx, dbPath, r1.nextLine)
    expect(r2.records).toHaveLength(0)
    expect(r2.nextLine).toBe(1)
    expect(r2.eof).toBe(true)
  })

  it('损坏 zstd data 跳过该行不抛错，水位照常推进', async () => {
    const badPath = path.join(tmpDir, 'threads', 'broken.db')
    fs.mkdirSync(path.dirname(badPath), { recursive: true })
    const db = new Database(badPath)
    db.exec(FULL_SCHEMA)
    db.prepare(
      `INSERT INTO threads (id, summary, updated_at, data_type, data, created_at, folder_paths, folder_paths_order)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`
    ).run('thread-broken', 't', '2026-05-01T12:00:00Z', 'zstd', Buffer.from('this is not zstd'))
    db.close()

    const { ctx } = makeCtxWithStorage()
    const res = await parseDbFile(ctx, badPath, 0)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(1)
    expect(res.eof).toBe(true)
  })

  it('未知 data_type 与损坏 JSON 均跳过该行，其余行照常产出', async () => {
    const dbPath = path.join(tmpDir, 'threads', 'threads.db')
    buildThreadsDb(dbPath, [
      { id: 'thread-brotli', json: '{}', dataType: 'brotli', updatedAt: '2026-05-01T10:00:00Z' },
      { id: 'thread-badjson', json: '{{{nope', dataType: 'json', updatedAt: '2026-05-01T11:00:00Z' },
      { id: 'thread-ok', json: threadJson({ usage: { 'user-1': usageEntry(5, 5) } }), updatedAt: '2026-05-01T12:00:00Z' }
    ])
    const { ctx } = makeCtxWithStorage()
    const res = await parseDbFile(ctx, dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].sessionId).toBe('thread-ok')
    expect(res.nextLine).toBe(3)
  })

  it('旧 schema（无 created_at/folder_paths 列）动态兼容照常解析', async () => {
    const dbPath = path.join(tmpDir, 'threads', 'old-schema', 'threads.db')
    buildThreadsDb(
      dbPath,
      [
        {
          id: 'thread-old',
          json: threadJson({ usage: { 'user-1': usageEntry(9, 9) }, updatedAt: '2026-05-01T12:30:00Z' }),
          updatedAt: '2026-05-01T12:30:00Z'
        }
      ],
      'minimal'
    )
    const { ctx } = makeCtxWithStorage()
    const res = await parseDbFile(ctx, dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({
      sessionId: 'thread-old',
      inputTokens: 9,
      createdAt: Date.parse('2026-05-01T12:30:00Z')
    })
    expect(res.records[0].project).toBeUndefined()
  })

  it('threads 表不存在 → 空结果且游标不推进', async () => {
    const dbPath = path.join(tmpDir, 'unrelated', 'threads.db')
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    const db = new Database(dbPath)
    db.exec('CREATE TABLE unrelated (x TEXT)')
    db.close()
    const { ctx } = makeCtxWithStorage({ lineOffset: 42, byteOffset: 1_000 })
    const res = await parseDbFile(ctx, dbPath, 42)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(42)
    expect(res.eof).toBe(true)
  })

  it('db 文件缺失 → 空结果且游标不推进', async () => {
    const missing = path.join(tmpDir, 'nope', 'threads.db')
    const { ctx } = makeCtxWithStorage()
    const res = await parseDbFile(ctx, missing, 7)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(7)
  })
})

describe('插件级 parseFile 透传与游标写回', () => {
  it('parseFile 直接解析 db 并把 updated_at 水位写回 sync_cursors.byte_offset', async () => {
    const dbPath = path.join(tmpDir, 'threads', 'threads.db')
    const t1 = '2026-05-01T12:00:00Z'
    buildThreadsDb(dbPath, [
      { id: 'thread-pf', json: threadJson({ usage: { 'user-1': usageEntry(4, 4) }, updatedAt: t1 }), updatedAt: t1 }
    ])
    const { ctx, cursorWrites } = makeCtxWithStorage()
    const res = await zedPlugin.parseFile(ctx, dbPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.filePath).toBe(dbPath)
    expect(res.records[0].source.requestId).toBe('thread-pf:user-1')
    expect(cursorWrites).toEqual([
      { filePath: dbPath, line: 1, mtime: undefined, byteOffset: Date.parse(t1) }
    ])
  })
})
