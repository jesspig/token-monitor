import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'
import {
  kiroPlugin,
  currentDataRootsOf,
  currentDbPathOf,
  dataRootOf,
  detectFromRoot,
  detectFromRoots,
  inspectCurrentDb,
  listCurrentDbFiles,
  listFilesFromRoot,
  listFilesFromRoots,
  parseCurrentDbFile,
  parseSessionFile,
  parseTsMs,
  sessionRootOf
} from './kiro'
import type { PluginContext } from '../../../shared/context'
import { createDatabase, migrate } from '../services/db'
import { SqliteStorage } from '../services/storage'

const ctx = {} as PluginContext
const END_TS_SEC = 1781220419
const UPDATED_AT = '2026-06-11T23:26:46.269Z'
const JSONL_EVENT =
  '{"version":"v1","kind":"Prompt","data":{"message_id":"p1","content":[{"kind":"text","data":"hi"}],"meta":{"timestamp":1781220419}}}'

interface SidecarOpts {
  sessionId?: string
  cwd?: string
  updatedAt?: string
  modelId?: string | null
  hasModelInfo?: boolean
  turns?: Array<Record<string, unknown>>
}

interface DbConversation {
  key: string
  value: string
  createdAt?: number
  updatedAt?: number
}

const turnMeta = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  loop_id: { agent_id: { name: 'kiro_default', parent_id: null, rand: 1 }, rand: 2 },
  result: { Ok: {} },
  message_ids: ['m-1'],
  builtin_tool_uses: [],
  end_reason: 'tool_use',
  end_timestamp: END_TS_SEC,
  input_token_count: 0,
  output_token_count: 0,
  total_request_count: 1,
  number_of_cycles: 1,
  metering_usage: [],
  turn_duration: 3,
  ...overrides
})

const sidecarValue = (options: SidecarOpts = {}): Record<string, unknown> => ({
  session_id: options.sessionId ?? 'sess-abc',
  cwd: options.cwd ?? '/Users/a/proj',
  created_at: '2026-06-11T23:00:00.000Z',
  updated_at: options.updatedAt ?? UPDATED_AT,
  title: 'first prompt',
  session_created_reason: null,
  parent_session_id: null,
  session_state: {
    version: 'v1',
    agent_name: 'kiro_default',
    conversation_metadata: {
      user_turn_metadatas: options.turns ?? [],
      user_turn_start_request: null,
      last_request: null
    },
    rts_model_state: {
      conversation_id: 'conv-1',
      model_info:
        options.hasModelInfo === false
          ? null
          : {
              model_id: options.modelId ?? 'claude-sonnet-4-5'
            }
    },
    permissions: {}
  }
})

let tmpDir = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-plugin-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.KIRO_DIR
  delete process.env.KIRO_DATA_DIR
})

function sidecarOf(jsonlPath: string): string {
  return jsonlPath.replace(/\.jsonl$/i, '.json')
}

function writeLegacySession(
  sessionDir: string,
  id: string,
  options: SidecarOpts = {},
  jsonlContent = `${JSONL_EVENT}\n`
): string {
  fs.mkdirSync(sessionDir, { recursive: true })
  const jsonlPath = path.join(sessionDir, `${id}.jsonl`)
  fs.writeFileSync(jsonlPath, jsonlContent, 'utf8')
  fs.writeFileSync(sidecarOf(jsonlPath), JSON.stringify(sidecarValue({ sessionId: id, ...options })), 'utf8')
  return jsonlPath
}

function buildCurrentDb(dbPath: string, conversations: DbConversation[] = []): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE conversations_v2 (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  const insert = db.prepare(
    'INSERT INTO conversations_v2 (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)'
  )
  for (const conversation of conversations) {
    insert.run(
      conversation.key,
      conversation.value,
      conversation.createdAt ?? 1_781_220_000_000,
      conversation.updatedAt ?? 1_781_220_419_000
    )
  }
  db.close()
}

function validDbConversation(
  key: string,
  options: SidecarOpts = { turns: [turnMeta({ input_token_count: 100, output_token_count: 50 })] }
): DbConversation {
  return {
    key,
    value: JSON.stringify(sidecarValue({ sessionId: key, ...options }))
  }
}

describe('kiroPlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(kiroPlugin.id).toBe('kiro')
    expect(kiroPlugin.name).toBe('Kiro CLI')
    expect(kiroPlugin.version).toBe('1.0.0')
    expect(kiroPlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('数据根发现', () => {
  it('KIRO_DIR 仅覆盖旧版根', () => {
    process.env.KIRO_DIR = '  /custom/kiro  '
    expect(dataRootOf()).toBe('/custom/kiro')
  })

  it('旧版根默认回退 ~/.kiro', () => {
    process.env.KIRO_DIR = '   '
    expect(dataRootOf()).toBe(path.join(os.homedir(), '.kiro'))
  })

  it('KIRO_DATA_DIR 覆盖当前数据库根', () => {
    expect(
      currentDataRootsOf({
        platform: 'linux',
        homeDir: '/home/user',
        env: { KIRO_DATA_DIR: '  /custom/kiro-data  ' }
      })
    ).toEqual(['/custom/kiro-data'])
  })

  it('Linux 使用 XDG 数据目录并保留 ~/.kiro 候选', () => {
    expect(
      currentDataRootsOf({
        platform: 'linux',
        homeDir: '/home/user',
        env: { XDG_DATA_HOME: '/var/data' }
      })
    ).toEqual([path.resolve('/var/data/kiro-cli'), path.resolve('/home/user/.kiro')])
  })

  it('macOS 使用 Application Support 并保留 ~/.kiro 候选', () => {
    expect(currentDataRootsOf({ platform: 'darwin', homeDir: '/Users/a', env: {} })).toEqual([
      path.resolve('/Users/a/Library/Application Support/kiro-cli'),
      path.resolve('/Users/a/.kiro')
    ])
  })

  it('Windows 使用 LOCALAPPDATA 并保留 ~/.kiro 候选', () => {
    expect(
      currentDataRootsOf({
        platform: 'win32',
        homeDir: 'C:\\Users\\a',
        env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }
      })
    ).toEqual([
      path.resolve('C:\\Users\\a\\AppData\\Local\\kiro-cli'),
      path.resolve('C:\\Users\\a\\.kiro')
    ])
  })
})

describe('当前数据库 schema 探测', () => {
  it('conversations_v2 必需列齐全时兼容', () => {
    const dbPath = path.join(tmpDir, 'data.sqlite3')
    buildCurrentDb(dbPath, [validDbConversation('session-1')])
    expect(inspectCurrentDb(dbPath)).toEqual({ compatible: true })
  })

  it('空 conversations_v2 仍视为兼容存储', () => {
    const dbPath = path.join(tmpDir, 'data.sqlite3')
    buildCurrentDb(dbPath)
    expect(inspectCurrentDb(dbPath)).toEqual({ compatible: true })
  })

  it('缺少表或必需列时显式不兼容', () => {
    const missingTable = path.join(tmpDir, 'missing-table.sqlite3')
    const db1 = new Database(missingTable)
    db1.exec('CREATE TABLE other_table (id INTEGER)')
    db1.close()
    expect(inspectCurrentDb(missingTable)).toMatchObject({ compatible: false })
    expect(inspectCurrentDb(missingTable).reason).toContain('conversations_v2')

    const missingColumn = path.join(tmpDir, 'missing-column.sqlite3')
    const db2 = new Database(missingColumn)
    db2.exec('CREATE TABLE conversations_v2 (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db2.close()
    expect(inspectCurrentDb(missingColumn)).toMatchObject({ compatible: false })
    expect(inspectCurrentDb(missingColumn).reason).toContain('必需列')
  })

  it('存在会话但没有可验证 Token 字段时显式拒绝估算', () => {
    const dbPath = path.join(tmpDir, 'data.sqlite3')
    buildCurrentDb(dbPath, [
      validDbConversation('session-1', {
        turns: [{ message_ids: ['m-1'], user_prompt_length: 100, response_size: 200 }]
      })
    ])
    const result = inspectCurrentDb(dbPath)
    expect(result.compatible).toBe(false)
    expect(result.reason).toContain('拒绝估算 Token')
  })

  it('损坏数据库可见且不会伪装为空结果', () => {
    const dbPath = path.join(tmpDir, 'data.sqlite3')
    fs.writeFileSync(dbPath, 'not a sqlite database', 'utf8')
    const result = inspectCurrentDb(dbPath)
    expect(result.compatible).toBe(false)
    expect(result.reason).toContain('无法只读打开')
  })
})

describe('detect 当前与旧版存储', () => {
  it('兼容的当前数据库可用', () => {
    const currentRoot = path.join(tmpDir, 'current')
    buildCurrentDb(currentDbPathOf(currentRoot), [validDbConversation('session-1')])
    const result = detectFromRoots(path.join(tmpDir, 'legacy'), [currentRoot])
    expect(result.available).toBe(true)
    expect(result.sessionDir).toBe(currentRoot)
  })

  it('旧版 sessions/cli 会话仍可用', () => {
    const legacyRoot = path.join(tmpDir, '.kiro')
    writeLegacySession(sessionRootOf(legacyRoot), 'legacy-1', {
      turns: [turnMeta({ input_token_count: 1, output_token_count: 2 })]
    })
    const result = detectFromRoot(legacyRoot)
    expect(result.available).toBe(true)
    expect(result.sessionDir).toBe(sessionRootOf(legacyRoot))
  })

  it('当前数据库不兼容但旧版可用时保留可用并显示警告', () => {
    const currentRoot = path.join(tmpDir, 'current')
    fs.mkdirSync(currentRoot, { recursive: true })
    fs.writeFileSync(currentDbPathOf(currentRoot), 'broken', 'utf8')
    const legacyRoot = path.join(tmpDir, 'legacy')
    writeLegacySession(sessionRootOf(legacyRoot), 'legacy-1', {
      turns: [turnMeta({ input_token_count: 1, output_token_count: 2 })]
    })
    const result = detectFromRoots(legacyRoot, [currentRoot])
    expect(result.available).toBe(true)
    expect(result.reason).toContain('部分 Kiro 数据库不兼容')
  })

  it('只有不兼容数据库时不可用并显示 schema 原因', () => {
    const currentRoot = path.join(tmpDir, 'current')
    const dbPath = currentDbPathOf(currentRoot)
    fs.mkdirSync(currentRoot, { recursive: true })
    const db = new Database(dbPath)
    db.exec('CREATE TABLE conversations_v3 (key TEXT, value TEXT)')
    db.close()
    const result = detectFromRoots(path.join(tmpDir, 'legacy'), [currentRoot])
    expect(result.available).toBe(false)
    expect(result.reason).toContain('schema 不兼容')
  })

  it('无当前数据库和旧版会话时说明覆盖变量', () => {
    const result = detectFromRoots(path.join(tmpDir, 'legacy'), [path.join(tmpDir, 'current')])
    expect(result.available).toBe(false)
    expect(result.reason).toContain('KIRO_DATA_DIR')
    expect(result.reason).toContain('KIRO_DIR')
  })
})

describe('文件发现与 mtime', () => {
  it('旧版只收集非临时 JSONL 并合并 sidecar mtime', () => {
    const jsonlPath = writeLegacySession(tmpDir, 'a', {
      turns: [turnMeta({ input_token_count: 1, output_token_count: 2 })]
    })
    fs.writeFileSync(path.join(tmpDir, 'b.jsonl.tmp'), '')
    fs.writeFileSync(path.join(tmpDir, '.hidden.jsonl'), '')
    fs.writeFileSync(path.join(tmpDir, 'c.jsonl~'), '')
    const old = new Date(Date.now() - 60_000)
    const recent = new Date()
    fs.utimesSync(jsonlPath, old, old)
    fs.utimesSync(sidecarOf(jsonlPath), recent, recent)

    const entries = listFilesFromRoot(tmpDir)
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe(jsonlPath)
    expect(entries[0].mtime).toBeGreaterThanOrEqual(Math.round(recent.getTime()) - 1500)
  })

  it('当前数据库 mtime 合并 WAL 且多根去重', () => {
    const currentRoot = path.join(tmpDir, 'current')
    const dbPath = currentDbPathOf(currentRoot)
    buildCurrentDb(dbPath)
    const old = new Date(Date.now() - 60_000)
    const recent = new Date()
    fs.utimesSync(dbPath, old, old)
    fs.writeFileSync(`${dbPath}-wal`, '')
    fs.utimesSync(`${dbPath}-wal`, recent, recent)

    const entries = listCurrentDbFiles([currentRoot, path.resolve(currentRoot)])
    expect(entries).toHaveLength(1)
    expect(entries[0].path).toBe(path.resolve(dbPath))
    expect(entries[0].mtime).toBeGreaterThanOrEqual(Math.round(recent.getTime()) - 1500)
  })

  it('当前数据库与旧版会话并存时全部列出', () => {
    const currentRoot = path.join(tmpDir, 'current')
    const legacyRoot = path.join(tmpDir, 'legacy')
    const dbPath = currentDbPathOf(currentRoot)
    buildCurrentDb(dbPath)
    const jsonlPath = writeLegacySession(sessionRootOf(legacyRoot), 'legacy-1', {
      turns: [turnMeta({ input_token_count: 1, output_token_count: 2 })]
    })
    expect(listFilesFromRoots(legacyRoot, [currentRoot]).map((entry) => entry.path)).toEqual(
      [path.resolve(dbPath), path.resolve(jsonlPath)].sort((a, b) => a.localeCompare(b))
    )
  })
})

describe('当前 conversations_v2 解析', () => {
  it('只映射显式 input/output Token，不估算 cache Token', () => {
    const dbPath = path.join(tmpDir, 'data.sqlite3')
    buildCurrentDb(dbPath, [
      validDbConversation('session-1', {
        cwd: '/project/current',
        modelId: 'claude-sonnet-4-5',
        turns: [
          turnMeta({
            message_ids: ['request-1', 'response-1'],
            input_token_count: 120,
            output_token_count: 34
          })
        ]
      })
    ])
    const result = parseCurrentDbFile(dbPath, 0)
    expect(result.eof).toBe(true)
    expect(result.nextLine).toBe(1)
    expect(result.records).toHaveLength(1)
    expect(result.records[0]).toMatchObject({
      appType: 'kiro',
      model: 'claude-sonnet-4-5',
      rawModel: 'claude-sonnet-4-5',
      inputTokens: 120,
      outputTokens: 34,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      inputSemantics: 0,
      isReplaceableSnapshot: true,
      project: '/project/current',
      sessionId: 'session-1',
      status: 'success'
    })
    expect(result.records[0].source.requestId).toBe('session-1:turn:0:messages:request-1,response-1')
    expect(result.records[0].source.line).toBeGreaterThan(0)
  })

  it('多会话同 turn 序号使用不同稳定 line 和 requestId', () => {
    const dbPath = path.join(tmpDir, 'data.sqlite3')
    buildCurrentDb(dbPath, [
      validDbConversation('session-1', {
        turns: [turnMeta({ message_ids: ['m-1'], input_token_count: 1, output_token_count: 2 })]
      }),
      validDbConversation('session-2', {
        turns: [turnMeta({ message_ids: ['m-1'], input_token_count: 3, output_token_count: 4 })]
      })
    ])
    const records = parseCurrentDbFile(dbPath, 0).records
    expect(new Set(records.map((record) => record.source.line)).size).toBe(2)
    expect(records.map((record) => record.source.requestId)).toEqual([
      'session-1:turn:0:messages:m-1',
      'session-2:turn:0:messages:m-1'
    ])
  })

  it('每次数据库变更后重读全部行，旧游标不会漏掉原行更新', () => {
    const dbPath = path.join(tmpDir, 'data.sqlite3')
    buildCurrentDb(dbPath, [
      validDbConversation('session-1', {
        turns: [turnMeta({ message_ids: ['m-1'], input_token_count: 1, output_token_count: 2 })]
      })
    ])
    const first = parseCurrentDbFile(dbPath, 0)
    expect(first.records[0].inputTokens).toBe(1)

    const db = new Database(dbPath)
    db.prepare('UPDATE conversations_v2 SET value = ?, updated_at = ? WHERE key = ?').run(
      JSON.stringify(
        sidecarValue({
          sessionId: 'session-1',
          turns: [turnMeta({ message_ids: ['m-1'], input_token_count: 9, output_token_count: 2 })]
        })
      ),
      1_781_220_500_000,
      'session-1'
    )
    db.close()

    const second = parseCurrentDbFile(dbPath, first.nextLine)
    expect(second.records[0].inputTokens).toBe(9)
    expect(second.records[0].source.requestId).toBe(first.records[0].source.requestId)
  })

  it('数据库重建且 rowid 回退时旧游标不会阻止新会话读取', () => {
    const dbPath = path.join(tmpDir, 'data.sqlite3')
    buildCurrentDb(dbPath, [validDbConversation('old-session')])
    const first = parseCurrentDbFile(dbPath, 99)
    expect(first.records[0].sessionId).toBe('old-session')

    fs.rmSync(dbPath)
    buildCurrentDb(dbPath, [validDbConversation('new-session')])
    const second = parseCurrentDbFile(dbPath, first.nextLine)
    expect(second.records).toHaveLength(1)
    expect(second.records[0].sessionId).toBe('new-session')
  })

  it('损坏 value 或 schema 漂移会抛出可见错误且不返回伪空结果', () => {
    const brokenValue = path.join(tmpDir, 'broken-value.sqlite3')
    buildCurrentDb(brokenValue, [{ key: 'session-1', value: '{bad' }])
    expect(() => parseCurrentDbFile(brokenValue, 0)).toThrow('不是有效 JSON')

    const drifted = path.join(tmpDir, 'drifted.sqlite3')
    const db = new Database(drifted)
    db.exec('CREATE TABLE conversations_v3 (key TEXT, value TEXT)')
    db.close()
    expect(() => parseCurrentDbFile(drifted, 0)).toThrow('schema 不兼容')
  })

  it('只读解析不会修改数据库内容', () => {
    const dbPath = path.join(tmpDir, 'data.sqlite3')
    buildCurrentDb(dbPath, [validDbConversation('session-1')])
    parseCurrentDbFile(dbPath, 0)
    const db = new Database(dbPath, { readonly: true })
    const count = db.prepare('SELECT COUNT(*) AS count FROM conversations_v2').get() as { count: number }
    db.close()
    expect(count.count).toBe(1)
  })

  it('同一 turn 从 1 修正为 9 后明细、日桶和小时桶均保持单条最终值', async () => {
    const sourceDbPath = path.join(tmpDir, 'data.sqlite3')
    buildCurrentDb(sourceDbPath, [
      validDbConversation('session-1', {
        turns: [turnMeta({ message_ids: ['m-1'], input_token_count: 1, output_token_count: 0 })]
      })
    ])
    const monitorDb = createDatabase(':memory:')
    migrate(monitorDb)
    const storage = new SqliteStorage(monitorDb)

    const first = parseCurrentDbFile(sourceDbPath, 0).records[0]
    first.costUsd = '0.001'
    expect(first.isReplaceableSnapshot).toBe(true)
    expect(await storage.recordUsage([first])).toBe(1)

    const sourceDb = new Database(sourceDbPath)
    sourceDb.prepare('UPDATE conversations_v2 SET value = ?, updated_at = ? WHERE key = ?').run(
      JSON.stringify(
        sidecarValue({
          sessionId: 'session-1',
          turns: [turnMeta({ message_ids: ['m-1'], input_token_count: 9, output_token_count: 0 })]
        })
      ),
      1_781_220_500_000,
      'session-1'
    )
    sourceDb.close()

    const updated = parseCurrentDbFile(sourceDbPath, 1).records[0]
    updated.costUsd = '0.009'
    expect(await storage.recordUsage([updated])).toBe(1)
    expect(await storage.recordUsage([updated])).toBe(0)

    expect(monitorDb.prepare('SELECT COUNT(*) AS count FROM usage_records').get()).toEqual({ count: 1 })
    expect(monitorDb.prepare('SELECT input_tokens, cost_usd, is_replaceable_snapshot FROM usage_records').get()).toEqual({
      input_tokens: 9,
      cost_usd: '0.009',
      is_replaceable_snapshot: 1
    })
    expect(monitorDb.prepare('SELECT request_count, success_count, input_tokens, cost_usd FROM usage_daily_rollups').get()).toEqual({
      request_count: 1,
      success_count: 1,
      input_tokens: 9,
      cost_usd: '0.009'
    })
    expect(monitorDb.prepare('SELECT request_count, success_count, input_tokens, cost_usd FROM usage_hourly_rollups').get()).toEqual({
      request_count: 1,
      success_count: 1,
      input_tokens: 9,
      cost_usd: '0.009'
    })
    monitorDb.close()
  })
})

describe('旧版 JSONL + sidecar 兼容', () => {
  it('保留显式 Token、模型、项目、会话和时间戳映射', async () => {
    const jsonlPath = writeLegacySession(tmpDir, 'legacy-1', {
      turns: [
        turnMeta({
          message_ids: ['m-1'],
          input_token_count: 100,
          output_token_count: 50
        })
      ]
    })
    const result = await kiroPlugin.parseFile(ctx, jsonlPath, 0)
    expect(result.records).toHaveLength(1)
    expect(result.records[0]).toMatchObject({
      appType: 'kiro',
      model: 'claude-sonnet-4-5',
      inputTokens: 100,
      outputTokens: 50,
      inputSemantics: 0,
      project: '/Users/a/proj',
      sessionId: 'legacy-1',
      createdAt: END_TS_SEC * 1000
    })
    expect(result.records[0].source).toEqual({
      filePath: jsonlPath,
      line: 1,
      requestId: 'legacy-1:turn:0:messages:m-1'
    })
    expect(result.records[0]).not.toHaveProperty('isReplaceableSnapshot')
  })

  it('增量续读只产出新增 turn', () => {
    const jsonlPath = writeLegacySession(tmpDir, 'legacy-2', {
      turns: [
        turnMeta({ message_ids: ['m-1'], input_token_count: 1, output_token_count: 2 }),
        turnMeta({ message_ids: ['m-2'], input_token_count: 3, output_token_count: 4 })
      ]
    })
    const first = parseSessionFile(jsonlPath, 0)
    expect(first.records).toHaveLength(2)
    expect(first.nextLine).toBe(3)

    fs.writeFileSync(
      sidecarOf(jsonlPath),
      JSON.stringify(
        sidecarValue({
          sessionId: 'legacy-2',
          turns: [
            turnMeta({ message_ids: ['m-1'], input_token_count: 1, output_token_count: 2 }),
            turnMeta({ message_ids: ['m-2'], input_token_count: 3, output_token_count: 4 }),
            turnMeta({ message_ids: ['m-3'], input_token_count: 5, output_token_count: 6 })
          ]
        })
      ),
      'utf8'
    )

    const second = parseSessionFile(jsonlPath, first.nextLine)
    expect(second.records).toHaveLength(1)
    expect(second.records[0].source.requestId).toBe('legacy-2:turn:2:messages:m-3')
    expect(second.nextLine).toBe(4)
  })

  it('损坏 sidecar、缺失模型或缺失显式 Token 字段均抛出可见错误', () => {
    const broken = path.join(tmpDir, 'broken.jsonl')
    fs.writeFileSync(broken, JSONL_EVENT)
    fs.writeFileSync(sidecarOf(broken), '{bad')
    expect(() => parseSessionFile(broken, 0)).toThrow('无法读取 Kiro 旧版 sidecar')

    const missingModel = writeLegacySession(tmpDir, 'missing-model', {
      hasModelInfo: false,
      turns: [turnMeta({ input_token_count: 1, output_token_count: 2 })]
    })
    expect(() => parseSessionFile(missingModel, 0)).toThrow('schema 不兼容')

    const missingTokens = writeLegacySession(tmpDir, 'missing-tokens', {
      turns: [{ message_ids: ['m-1'] }]
    })
    expect(() => parseSessionFile(missingTokens, 0)).toThrow('缺少可验证')
  })

  it('fromLine 越过现有 turn 时游标不回退', () => {
    const jsonlPath = writeLegacySession(tmpDir, 'legacy-3', {
      turns: [turnMeta({ input_token_count: 1, output_token_count: 2 })]
    })
    const result = parseSessionFile(jsonlPath, 99)
    expect(result.records).toHaveLength(0)
    expect(result.nextLine).toBe(99)
  })
})

describe('新旧存储语义去重', () => {
  it('同一 session/turn 在数据库和旧 sidecar 中产生相同 requestId', () => {
    const sessionId = 'shared-session'
    const turn = turnMeta({
      message_ids: ['request-1'],
      input_token_count: 10,
      output_token_count: 20
    })
    const dbPath = path.join(tmpDir, 'data.sqlite3')
    buildCurrentDb(dbPath, [validDbConversation(sessionId, { turns: [turn] })])
    const jsonlPath = writeLegacySession(tmpDir, sessionId, { turns: [turn] })

    const dbRecord = parseCurrentDbFile(dbPath, 0).records[0]
    const legacyRecord = parseSessionFile(jsonlPath, 0).records[0]
    expect(dbRecord.source.requestId).toBe(legacyRecord.source.requestId)
    expect(dbRecord.source.filePath).not.toBe(legacyRecord.source.filePath)
  })
})

describe('时间戳解析', () => {
  it('支持 Unix 秒、Unix 毫秒和 RFC3339，非法值返回 0', () => {
    expect(parseTsMs(END_TS_SEC)).toBe(END_TS_SEC * 1000)
    expect(parseTsMs(END_TS_SEC * 1000)).toBe(END_TS_SEC * 1000)
    expect(parseTsMs('2026-06-11T23:30:00.000Z')).toBe(Date.parse('2026-06-11T23:30:00.000Z'))
    expect(parseTsMs('not-a-date')).toBe(0)
    expect(parseTsMs(undefined)).toBe(0)
  })
})
