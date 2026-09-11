import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import {
  clearCodeWhaleSnapshotCache,
  codewhalePlugin,
  detectFromRoot,
  listFilesFromRoot,
  parseTsMs,
  sessionsRootOf
} from './codewhale'
import type { PluginContext } from '../../../shared/context'

const ctx = {} as PluginContext
const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

const sessionJson = (o: {
  id?: unknown
  total?: unknown
  model?: unknown
  workspace?: unknown
  updatedAt?: unknown
  schemaVersion?: unknown
} = {}): string =>
  JSON.stringify({
    schema_version: 'schemaVersion' in o ? o.schemaVersion : 1,
    metadata: {
      id: 'id' in o ? o.id : SESSION_ID,
      title: '',
      created_at: '2026-09-10T08:00:00Z',
      updated_at: 'updatedAt' in o ? o.updatedAt : '2026-09-10T09:00:00Z',
      message_count: 10,
      total_tokens: 'total' in o ? o.total : 1000,
      model: 'model' in o ? o.model : 'deepseek-chat',
      model_provider: 'deepseek',
      workspace: 'workspace' in o ? o.workspace : '/repo/proj',
      cost: { session_cost_usd: 0.1, subagent_cost_usd: 0 }
    },
    messages: [],
    journal: []
  })

const writeSession = (dir: string, name: string, content: string): string => {
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, content, 'utf8')
  return filePath
}

let tmpDir = ''
const envKeys = ['CODEWHALE_DIR', 'CODEWHALE_HOME'] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codewhale-plugin-'))
  clearCodeWhaleSnapshotCache()
  for (const key of envKeys) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  clearCodeWhaleSnapshotCache()
  fs.rmSync(tmpDir, { recursive: true, force: true })
  for (const key of envKeys) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('codewhalePlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(codewhalePlugin.id).toBe('codewhale')
    expect(codewhalePlugin.name).toBe('CodeWhale')
    expect(codewhalePlugin.version).toBe('1.0.0')
    expect(codewhalePlugin.deps).toEqual(['storage', 'pricing', 'events'])
    expect(codewhalePlugin.dispose).toBe(clearCodeWhaleSnapshotCache)
  })
})

describe('sessionsRootOf 路径解析与环境变量覆盖', () => {
  it('CODEWHALE_DIR 优先且语义为 sessions 目录本身', () => {
    process.env.CODEWHALE_DIR = path.join(tmpDir, 'override-sessions')
    process.env.CODEWHALE_HOME = path.join(tmpDir, 'home')
    expect(sessionsRootOf()).toBe(path.join(tmpDir, 'override-sessions'))
  })

  it('仅 CODEWHALE_HOME 时回落到 sessions 子目录', () => {
    process.env.CODEWHALE_HOME = path.join(tmpDir, 'home')
    expect(sessionsRootOf()).toBe(path.join(tmpDir, 'home', 'sessions'))
  })

  it('无覆盖时使用默认会话目录', () => {
    expect(sessionsRootOf()).toBe(path.join(os.homedir(), '.codewhale', 'sessions'))
  })
})

describe('detect 与文件发现', () => {
  it('目录缺失时返回不可用原因', () => {
    const root = path.join(tmpDir, 'missing')
    const result = detectFromRoot(root)
    expect(result.available).toBe(false)
    expect(result.reason).toContain('~/.codewhale/sessions')
    expect(result.reason).toContain('CODEWHALE_DIR')
    expect(result.sessionDir).toBe(root)
  })

  it('目录存在时可用', () => {
    const root = path.join(tmpDir, 'sessions')
    fs.mkdirSync(root, { recursive: true })
    expect(detectFromRoot(root)).toEqual({ available: true, sessionDir: root })
  })

  it('只收集一级稳定 JSON 文件并按路径排序', () => {
    const root = path.join(tmpDir, 'sessions')
    writeSession(root, 'c.json', sessionJson())
    writeSession(root, 'a.json', sessionJson())
    writeSession(root, '.hidden.json', sessionJson())
    writeSession(root, 'partial.json.tmp', sessionJson())
    writeSession(root, 'swap.json.swp', sessionJson())
    writeSession(root, 'backup.json~', sessionJson())
    writeSession(root, 'readme.txt', 'x')
    writeSession(path.join(root, 'nested'), 'nested.json', sessionJson())

    expect(listFilesFromRoot(root).map((entry) => path.basename(entry.path))).toEqual(['a.json', 'c.json'])
  })
})

describe('parseSessionFile 保守快照', () => {
  it('首次观察只建立基线，不导入已有历史', async () => {
    const file = writeSession(tmpDir, 'first.json', sessionJson({ total: 1000 }))
    const result = await codewhalePlugin.parseFile(ctx, file, 0)

    expect(result.records).toEqual([])
    expect(result.nextLine).toBeGreaterThan(0)
    expect(result.nextLine).not.toBe(1000)
    expect(result.eof).toBe(true)
  })

  it('总量上升时只产出差值，并保留未知输入语义', async () => {
    const file = writeSession(tmpDir, 'grow.json', sessionJson({ total: 100, updatedAt: '2026-09-10T09:00:00Z' }))
    const first = await codewhalePlugin.parseFile(ctx, file, 0)

    fs.writeFileSync(file, sessionJson({ total: 250, updatedAt: '2026-09-10T09:05:00Z' }), 'utf8')
    const second = await codewhalePlugin.parseFile(ctx, file, first.nextLine)

    expect(second.records).toHaveLength(1)
    expect(second.records[0]).toMatchObject({
      appType: 'codewhale',
      model: 'deepseek-chat',
      rawModel: 'deepseek-chat',
      inputTokens: 150,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      inputSemantics: 0,
      status: 'success',
      sessionId: SESSION_ID,
      project: '/repo/proj',
      createdAt: Date.parse('2026-09-10T09:05:00Z')
    })
    expect(second.records[0].source.filePath).toBe(file)
    expect(second.records[0].source.line).toBeGreaterThan(0)
    expect(second.records[0].source.requestId).toBe(
      `${SESSION_ID}:snapshot:100:250:${Date.parse('2026-09-10T09:05:00Z')}`
    )
  })

  it('清空进程缓存后仍能从编码游标恢复基线', async () => {
    const file = writeSession(tmpDir, 'restart.json', sessionJson({ total: 400 }))
    const first = await codewhalePlugin.parseFile(ctx, file, 0)
    clearCodeWhaleSnapshotCache()

    fs.writeFileSync(file, sessionJson({ total: 460, updatedAt: '2026-09-10T09:10:00Z' }), 'utf8')
    const second = await codewhalePlugin.parseFile(ctx, file, first.nextLine)

    expect(second.records).toHaveLength(1)
    expect(second.records[0].inputTokens).toBe(60)
  })

  it('兼容旧版裸 total 游标，迁移时只记录后续增长', async () => {
    const file = writeSession(tmpDir, 'legacy-cursor.json', sessionJson({ total: 175 }))
    const result = await codewhalePlugin.parseFile(ctx, file, 125)

    expect(result.records).toHaveLength(1)
    expect(result.records[0].inputTokens).toBe(50)
    expect(result.nextLine).not.toBe(175)
  })

  it('collector 因文件 mtime 重置行游标为 0 时使用热基线避免漏计', async () => {
    const file = writeSession(tmpDir, 'collector-reset.json', sessionJson({ total: 100 }))
    await codewhalePlugin.parseFile(ctx, file, 0)

    fs.writeFileSync(file, sessionJson({ total: 140, updatedAt: '2026-09-10T09:01:00Z' }), 'utf8')
    const growth = await codewhalePlugin.parseFile(ctx, file, 0)
    expect(growth.records[0].inputTokens).toBe(40)

    const stabilized = await codewhalePlugin.parseFile(ctx, file, 0)
    expect(stabilized.records).toEqual([])

    fs.writeFileSync(file, sessionJson({ total: 170, updatedAt: '2026-09-10T09:02:00Z' }), 'utf8')
    const nextGrowth = await codewhalePlugin.parseFile(ctx, file, stabilized.nextLine)
    expect(nextGrowth.records[0].inputTokens).toBe(30)
  })

  it('总量下降只重置基线，不产生记录', async () => {
    const file = writeSession(tmpDir, 'compact.json', sessionJson({ total: 500 }))
    const first = await codewhalePlugin.parseFile(ctx, file, 0)

    fs.writeFileSync(file, sessionJson({ total: 200, updatedAt: '2026-09-10T10:00:00Z' }), 'utf8')
    const compacted = await codewhalePlugin.parseFile(ctx, file, first.nextLine)

    expect(compacted.records).toEqual([])
    expect(compacted.nextLine).not.toBe(first.nextLine)
  })

  it('下降后的再次增长只计算新基线以上的差值', async () => {
    const file = writeSession(tmpDir, 'regrow.json', sessionJson({ total: 500 }))
    const first = await codewhalePlugin.parseFile(ctx, file, 0)

    fs.writeFileSync(file, sessionJson({ total: 200, updatedAt: '2026-09-10T10:00:00Z' }), 'utf8')
    const compacted = await codewhalePlugin.parseFile(ctx, file, first.nextLine)

    fs.writeFileSync(file, sessionJson({ total: 275, updatedAt: '2026-09-10T10:05:00Z' }), 'utf8')
    const regrown = await codewhalePlugin.parseFile(ctx, file, compacted.nextLine)

    expect(regrown.records).toHaveLength(1)
    expect(regrown.records[0].inputTokens).toBe(75)
  })

  it('fork 新文件只建立自己的基线，不把复制历史当新增', async () => {
    const parent = writeSession(tmpDir, 'parent.json', sessionJson({ id: 'parent', total: 800 }))
    const parentBaseline = await codewhalePlugin.parseFile(ctx, parent, 0)
    expect(parentBaseline.records).toEqual([])

    const fork = writeSession(tmpDir, 'fork.json', sessionJson({ id: 'fork', total: 800 }))
    const forkBaseline = await codewhalePlugin.parseFile(ctx, fork, 0)
    expect(forkBaseline.records).toEqual([])

    fs.writeFileSync(
      fork,
      sessionJson({ id: 'fork', total: 850, updatedAt: '2026-09-10T11:00:00Z' }),
      'utf8'
    )
    const forkGrowth = await codewhalePlugin.parseFile(ctx, fork, forkBaseline.nextLine)
    expect(forkGrowth.records).toHaveLength(1)
    expect(forkGrowth.records[0].inputTokens).toBe(50)
    expect(forkGrowth.records[0].sessionId).toBe('fork')
  })

  it('相同快照和游标重复解析生成稳定 requestId 与 source.line', async () => {
    const file = writeSession(tmpDir, 'stable.json', sessionJson({ total: 10 }))
    const first = await codewhalePlugin.parseFile(ctx, file, 0)
    clearCodeWhaleSnapshotCache()

    fs.writeFileSync(file, sessionJson({ total: 15, updatedAt: '2026-09-10T12:00:00Z' }), 'utf8')
    const a = await codewhalePlugin.parseFile(ctx, file, first.nextLine)
    clearCodeWhaleSnapshotCache()
    const b = await codewhalePlugin.parseFile(ctx, file, first.nextLine)

    expect(a.records[0].source).toEqual(b.records[0].source)
    expect(a.records[0].inputTokens).toBe(b.records[0].inputTokens)
  })

  it('非零持久化游标优先于热缓存，入库失败后的重试不会漏掉增量', async () => {
    const file = writeSession(tmpDir, 'retry.json', sessionJson({ total: 20 }))
    const first = await codewhalePlugin.parseFile(ctx, file, 0)

    fs.writeFileSync(file, sessionJson({ total: 35, updatedAt: '2026-09-10T12:10:00Z' }), 'utf8')
    const attempted = await codewhalePlugin.parseFile(ctx, file, first.nextLine)
    const retried = await codewhalePlugin.parseFile(ctx, file, first.nextLine)

    expect(attempted.records).toHaveLength(1)
    expect(retried.records).toHaveLength(1)
    expect(retried.records[0].inputTokens).toBe(15)
    expect(retried.records[0].source).toEqual(attempted.records[0].source)
  })

  it('首次总量为 0 时仍建立可恢复基线', async () => {
    const file = writeSession(tmpDir, 'zero.json', sessionJson({ total: 0 }))
    const first = await codewhalePlugin.parseFile(ctx, file, 0)
    clearCodeWhaleSnapshotCache()

    fs.writeFileSync(file, sessionJson({ total: 9, updatedAt: '2026-09-10T12:30:00Z' }), 'utf8')
    const second = await codewhalePlugin.parseFile(ctx, file, first.nextLine)

    expect(first.records).toEqual([])
    expect(second.records[0].inputTokens).toBe(9)
  })

  it('模型缺失回退 unknown，workspace 缺失时不产 project', async () => {
    const file = writeSession(tmpDir, 'optional.json', sessionJson({ total: 5, model: '', workspace: '' }))
    const first = await codewhalePlugin.parseFile(ctx, file, 0)
    clearCodeWhaleSnapshotCache()

    fs.writeFileSync(
      file,
      sessionJson({ total: 8, model: '', workspace: '', updatedAt: '2026-09-10T13:00:00Z' }),
      'utf8'
    )
    const second = await codewhalePlugin.parseFile(ctx, file, first.nextLine)

    expect(second.records[0].model).toBe('unknown')
    expect('project' in second.records[0]).toBe(false)
  })
})

describe('parseSessionFile 显式失败与隔离', () => {
  it('坏 JSON 显式失败', async () => {
    const file = writeSession(tmpDir, 'broken.json', '{broken')
    await expect(codewhalePlugin.parseFile(ctx, file, 42)).rejects.toThrow('CodeWhale 会话 JSON 损坏')
  })

  it('未知 schema 显式失败', async () => {
    const file = writeSession(tmpDir, 'schema.json', sessionJson({ schemaVersion: 2 }))
    await expect(codewhalePlugin.parseFile(ctx, file, 0)).rejects.toThrow('不支持 schema_version=2')
  })

  it('缺失身份、非法 total 和非法更新时间均显式失败', async () => {
    const noId = writeSession(tmpDir, 'no-id.json', sessionJson({ id: '' }))
    const badTotal = writeSession(tmpDir, 'bad-total.json', sessionJson({ total: '100' }))
    const badTime = writeSession(tmpDir, 'bad-time.json', sessionJson({ updatedAt: 'not-a-date' }))

    await expect(codewhalePlugin.parseFile(ctx, noId, 0)).rejects.toThrow('metadata.id 缺失')
    await expect(codewhalePlugin.parseFile(ctx, badTotal, 0)).rejects.toThrow('metadata.total_tokens')
    await expect(codewhalePlugin.parseFile(ctx, badTime, 0)).rejects.toThrow('metadata.updated_at 无效')
  })

  it('文件缺失显式失败', async () => {
    await expect(codewhalePlugin.parseFile(ctx, path.join(tmpDir, 'missing.json'), 9)).rejects.toThrow(
      '无法读取 CodeWhale 会话文件'
    )
  })

  it('单个坏文件失败后不污染其他文件的基线', async () => {
    const bad = writeSession(tmpDir, 'bad.json', '{bad')
    const good = writeSession(tmpDir, 'good.json', sessionJson({ id: 'good', total: 50 }))

    await expect(codewhalePlugin.parseFile(ctx, bad, 0)).rejects.toThrow()
    const result = await codewhalePlugin.parseFile(ctx, good, 0)
    expect(result.records).toEqual([])
    expect(result.nextLine).toBeGreaterThan(0)
  })
})

describe('parseTsMs', () => {
  it('解析秒、毫秒和 ISO 时间，无效值返回 0', () => {
    expect(parseTsMs(1_780_000_000)).toBe(1_780_000_000_000)
    expect(parseTsMs(1_780_000_000_123)).toBe(1_780_000_000_123)
    expect(parseTsMs('2026-09-10T09:00:00Z')).toBe(Date.parse('2026-09-10T09:00:00Z'))
    expect(parseTsMs('bad')).toBe(0)
  })
})
