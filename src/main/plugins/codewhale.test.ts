import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { codewhalePlugin, detectFromRoot, listFilesFromRoot, sessionsRootOf } from './codewhale'
import type { PluginContext } from '../../../shared/context'

const ctx = {} as PluginContext

const sessionJson = (o: {
  id?: unknown
  total?: unknown
  model?: unknown
  workspace?: unknown
  updatedAt?: unknown
} = {}): string =>
  JSON.stringify({
    schema_version: 1,
    metadata: {
      id: 'id' in o ? o.id : 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
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
  const p = path.join(dir, name)
  fs.writeFileSync(p, content, 'utf8')
  return p
}

let tmpDir = ''

const envKeys = ['CODEWHALE_DIR', 'CODEWHALE_HOME'] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codewhale-plugin-'))
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

describe('codewhalePlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(codewhalePlugin.id).toBe('codewhale')
    expect(codewhalePlugin.name).toBe('CodeWhale')
    expect(codewhalePlugin.version).toBe('1.0.0')
    expect(codewhalePlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('sessionsRootOf 路径解析与环境变量覆盖', () => {
  it('CODEWHALE_DIR 优先且语义为 sessions 目录本身', () => {
    process.env.CODEWHALE_DIR = path.join(tmpDir, 'override-sessions')
    process.env.CODEWHALE_HOME = path.join(tmpDir, 'home')
    expect(sessionsRootOf()).toBe(path.join(tmpDir, 'override-sessions'))
  })

  it('仅 CODEWHALE_HOME 时回落 $CODEWHALE_HOME/sessions', () => {
    process.env.CODEWHALE_HOME = path.join(tmpDir, 'home')
    expect(sessionsRootOf()).toBe(path.join(tmpDir, 'home', 'sessions'))
  })

  it('均未设置或空白值时默认 ~/.codewhale/sessions', () => {
    expect(sessionsRootOf()).toBe(path.join(os.homedir(), '.codewhale', 'sessions'))

    process.env.CODEWHALE_DIR = '   '
    process.env.CODEWHALE_HOME = '   '
    expect(sessionsRootOf()).toBe(path.join(os.homedir(), '.codewhale', 'sessions'))
  })
})

describe('detect', () => {
  it('sessions 目录缺失时不可用并说明默认路径与覆盖方式', () => {
    const sessionsDir = path.join(tmpDir, 'missing', 'sessions')
    const res = detectFromRoot(sessionsDir)
    expect(res.available).toBe(false)
    expect(res.reason).toContain('~/.codewhale/sessions')
    expect(res.reason).toContain('CODEWHALE_DIR')
    expect(res.reason).toContain('CODEWHALE_HOME')
    expect(res.sessionDir).toBe(sessionsDir)
  })

  it('sessions 目录存在（即使为空）即可用', () => {
    const sessionsDir = path.join(tmpDir, 'home', 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    const res = detectFromRoot(sessionsDir)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(sessionsDir)
  })

  it('sessions 目录存在且含会话文件时可用，环境变量覆盖生效', async () => {
    const sessionsDir = path.join(tmpDir, 'override-sessions')
    writeSession(sessionsDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.json', sessionJson())
    process.env.CODEWHALE_DIR = sessionsDir

    const res = await codewhalePlugin.detect(ctx)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(sessionsDir)
  })
})

describe('listFilesFromRoot', () => {
  it('只收集一级 *.json 并按路径排序，子目录内容与临时/隐藏文件不收', () => {
    const root = path.join(tmpDir, 'sessions')
    writeSession(root, 'c.json', sessionJson())
    writeSession(root, 'a.json', sessionJson())
    writeSession(root, 'b.json', sessionJson())
    writeSession(root, 'b.json.tmp', sessionJson())
    writeSession(root, '.hidden.json', sessionJson())
    writeSession(root, 'd.json~', sessionJson())
    writeSession(root, 'd.json.swp', sessionJson())
    writeSession(root, 'readme.txt', 'x')
    writeSession(path.join(root, 'checkpoints'), 'inner.json', sessionJson())
    writeSession(path.join(root, '.late-usage'), 'late.json', sessionJson())
    fs.mkdirSync(path.join(root, 'subdir.json'), { recursive: true })

    const entries = listFilesFromRoot(root)
    expect(entries.map((e) => path.basename(e.path))).toEqual(['a.json', 'b.json', 'c.json'])
    for (const e of entries) {
      expect(e.mtime).toBeGreaterThan(0)
    }
  })

  it('目录缺失或非 json 内容时返回空数组', () => {
    expect(listFilesFromRoot(path.join(tmpDir, 'missing'))).toEqual([])

    const root = path.join(tmpDir, 'empty')
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'notes.md'), 'x', 'utf8')
    expect(listFilesFromRoot(root)).toEqual([])
  })
})

describe('parseSessionFile 正常解析', () => {
  it('整文件快照映射：delta 入 input 桶、semantics=0、requestId/sessionId/project/updated_at 齐全', async () => {
    const file = writeSession(tmpDir, 'session-a.json', sessionJson({ total: 12345 }))

    const res = await codewhalePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.nextLine).toBe(12345)
    expect(res.eof).toBe(true)

    const r = res.records[0]
    expect(r).toMatchObject({
      appType: 'codewhale',
      model: 'deepseek-chat',
      rawModel: 'deepseek-chat',
      inputTokens: 12345,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      inputSemantics: 0,
      status: 'success',
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      project: '/repo/proj'
    })
    expect(r.createdAt).toBe(Date.parse('2026-09-10T09:00:00Z'))
    expect(r.source).toEqual({
      filePath: file,
      line: 12345,
      requestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:12345'
    })
  })

  it('model 缺失/空串/非字符串兜底 unknown', async () => {
    for (const model of [undefined, '', '   ', 42]) {
      const file = writeSession(tmpDir, `m-${String(model)}.json`, sessionJson({ model, total: 10 }))
      const res = await codewhalePlugin.parseFile(ctx, file, 0)
      expect(res.records).toHaveLength(1)
      expect(res.records[0].model).toBe('unknown')
      expect(res.records[0].rawModel).toBe('unknown')
    }
  })

  it('workspace 缺失或空串时不带 project 字段', async () => {
    for (const workspace of [undefined, '', '   ']) {
      const file = writeSession(tmpDir, `w-${String(workspace)}.json`, sessionJson({ workspace, total: 5 }))
      const res = await codewhalePlugin.parseFile(ctx, file, 0)
      expect(res.records).toHaveLength(1)
      expect('project' in res.records[0]).toBe(false)
    }
  })

  it('updated_at 无法解析时 createdAt 兜底为当前时间（非 NaN）', async () => {
    const file = writeSession(tmpDir, 'bad-ts.json', sessionJson({ updatedAt: 'not-a-date', total: 7 }))
    const res = await codewhalePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(Number.isNaN(res.records[0].createdAt)).toBe(false)
    expect(Math.abs(res.records[0].createdAt - Date.now())).toBeLessThan(60_000)
  })
})

describe('parseSessionFile 快照水位增量', () => {
  it('同文件 total 增大后重析只产出增量 delta', async () => {
    const file = writeSession(tmpDir, 'grow.json', sessionJson({ total: 100 }))

    const r1 = await codewhalePlugin.parseFile(ctx, file, 0)
    expect(r1.records).toHaveLength(1)
    expect(r1.records[0].inputTokens).toBe(100)
    expect(r1.nextLine).toBe(100)

    fs.writeFileSync(file, sessionJson({ total: 250 }), 'utf8')
    const r2 = await codewhalePlugin.parseFile(ctx, file, r1.nextLine)
    expect(r2.records).toHaveLength(1)
    expect(r2.records[0].inputTokens).toBe(150)
    expect(r2.records[0].outputTokens).toBe(0)
    expect(r2.records[0].source).toEqual({
      filePath: file,
      line: 250,
      requestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:250'
    })
    expect(r2.nextLine).toBe(250)
  })

  it('total 回退（文件被替换变小）时按新 total 全量重计', async () => {
    const file = writeSession(tmpDir, 'reset.json', sessionJson({ total: 500 }))
    const r1 = await codewhalePlugin.parseFile(ctx, file, 0)
    expect(r1.records[0].inputTokens).toBe(500)

    fs.writeFileSync(file, sessionJson({ total: 200 }), 'utf8')
    const r2 = await codewhalePlugin.parseFile(ctx, file, 500)
    expect(r2.records).toHaveLength(1)
    expect(r2.records[0].inputTokens).toBe(200)
    expect(r2.records[0].source.line).toBe(200)
    expect(r2.records[0].source.requestId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:200')
    expect(r2.nextLine).toBe(200)
  })

  it('delta=0 时无记录但游标推进到 total', async () => {
    const file = writeSession(tmpDir, 'same.json', sessionJson({ total: 12345 }))
    const res = await codewhalePlugin.parseFile(ctx, file, 12345)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(12345)
    expect(res.eof).toBe(true)
  })
})

describe('parseSessionFile 容错', () => {
  it('metadata 缺失或非对象时空结果且游标不动', async () => {
    const noMeta = writeSession(tmpDir, 'no-meta.json', JSON.stringify({ schema_version: 1, messages: [] }))
    const r1 = await codewhalePlugin.parseFile(ctx, noMeta, 88)
    expect(r1.records).toHaveLength(0)
    expect(r1.nextLine).toBe(88)

    const metaNull = writeSession(tmpDir, 'meta-null.json', JSON.stringify({ metadata: null }))
    const r2 = await codewhalePlugin.parseFile(ctx, metaNull, 77)
    expect(r2.records).toHaveLength(0)
    expect(r2.nextLine).toBe(77)
  })

  it('metadata.id 缺失/空串/非字符串时空结果且游标不动（等待回填）', async () => {
    for (const id of [undefined, '', '   ', 42]) {
      const file = writeSession(tmpDir, `id-${String(id)}.json`, sessionJson({ id, total: 300 }))
      const res = await codewhalePlugin.parseFile(ctx, file, 120)
      expect(res.records).toHaveLength(0)
      expect(res.nextLine).toBe(120)
      expect(res.eof).toBe(true)
    }
  })

  it('坏 JSON 时返回空结果且游标原样保留', async () => {
    const file = writeSession(tmpDir, 'broken.json', '{this is broken json')
    const res = await codewhalePlugin.parseFile(ctx, file, 42)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(42)
    expect(res.eof).toBe(true)
  })

  it('文件缺失时返回空结果且游标原样保留', async () => {
    const missing = path.join(tmpDir, 'missing.json')
    const res = await codewhalePlugin.parseFile(ctx, missing, 9)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(9)
    expect(res.eof).toBe(true)
  })

  it('环境变量覆盖下 listFiles 走覆盖目录', async () => {
    const sessionsDir = path.join(tmpDir, 'override-sessions')
    writeSession(sessionsDir, 'b.json', sessionJson({ total: 1 }))
    writeSession(sessionsDir, 'a.json', sessionJson({ total: 2 }))
    process.env.CODEWHALE_DIR = sessionsDir

    const files = await codewhalePlugin.listFiles(ctx)
    expect(files.map((f) => path.basename(f.path))).toEqual(['a.json', 'b.json'])
  })
})
