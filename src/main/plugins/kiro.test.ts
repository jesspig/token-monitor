import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import {
  kiroPlugin,
  dataRootOf,
  detectFromRoot,
  listFilesFromRoot,
  parseSessionFile,
  sessionRootOf,
  parseTsMs
} from './kiro'
import type { PluginContext } from '../../../shared/context'

const ctx = {} as PluginContext

const END_TS_SEC = 1781220419
const UPDATED_AT = '2026-06-11T23:26:46.269Z'

const turnMeta = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
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
  ...o
})

interface SidecarOpts {
  sessionId?: string
  cwd?: string
  updatedAt?: string
  modelId?: string | null
  hasModelInfo?: boolean
  turns?: Record<string, unknown>[]
}

const sidecarJson = (o: SidecarOpts = {}): string =>
  JSON.stringify({
    session_id: o.sessionId ?? 'sess-abc',
    cwd: o.cwd ?? '/Users/a/proj',
    created_at: '2026-06-11T23:00:00.000Z',
    updated_at: o.updatedAt ?? UPDATED_AT,
    title: 'first prompt',
    session_created_reason: null,
    parent_session_id: null,
    session_state: {
      version: 'v1',
      agent_name: 'kiro_default',
      conversation_metadata: {
        user_turn_metadatas: o.turns ?? [],
        user_turn_start_request: null,
        last_request: null
      },
      rts_model_state: {
        conversation_id: 'conv-1',
        model_info:
          o.hasModelInfo === false
            ? null
            : {
                model_id: o.modelId ?? 'claude-sonnet-4-5'
              },
      },
      permissions: {}
    }
  })

const JSONL_EVENT = '{"version":"v1","kind":"Prompt","data":{"message_id":"p1","content":[{"kind":"text","data":"hi"}],"meta":{"timestamp":1781220419}}}'

let tmpDir = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-plugin-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.KIRO_DIR
})

function writeSession(id: string, o: SidecarOpts = {}, jsonlContent = `${JSONL_EVENT}\n`): string {
  const jsonlPath = path.join(tmpDir, `${id}.jsonl`)
  fs.writeFileSync(jsonlPath, jsonlContent, 'utf8')
  fs.writeFileSync(path.join(tmpDir, `${id}.json`), sidecarJson({ sessionId: id, ...o }), 'utf8')
  return jsonlPath
}

describe('kiroPlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(kiroPlugin.id).toBe('kiro')
    expect(kiroPlugin.name).toBe('Kiro CLI')
    expect(kiroPlugin.version).toBe('1.0.0')
    expect(kiroPlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('dataRootOf KIRO_DIR 覆盖', () => {
  it('KIRO_DIR 设置时覆盖默认根（含首尾空白修剪）', () => {
    process.env.KIRO_DIR = '  /custom/kiro  '
    expect(dataRootOf()).toBe('/custom/kiro')
  })

  it('KIRO_DIR 未设或空白时回退 ~/.kiro', () => {
    delete process.env.KIRO_DIR
    expect(dataRootOf()).toBe(path.join(os.homedir(), '.kiro'))
    process.env.KIRO_DIR = '   '
    expect(dataRootOf()).toBe(path.join(os.homedir(), '.kiro'))
  })
})

describe('detect', () => {
  it('sessions/cli 目录缺失时不可用并给出中文原因与预期目录', () => {
    const res = detectFromRoot(path.join(tmpDir, '.kiro'))
    expect(res.available).toBe(false)
    expect(res.reason).toContain('sessions')
    expect(res.reason).toContain('KIRO_DIR')
    expect(res.sessionDir).toBe(path.join(tmpDir, '.kiro', 'sessions', 'cli'))
  })

  it('目录存在但无 .jsonl（仅 sidecar/.lock/.history）时不可用', () => {
    const root = path.join(tmpDir, '.kiro')
    const cliDir = sessionRootOf(root)
    fs.mkdirSync(cliDir, { recursive: true })
    fs.writeFileSync(path.join(cliDir, 's1.json'), '{}')
    fs.writeFileSync(path.join(cliDir, 's1.lock'), '')
    fs.writeFileSync(path.join(cliDir, 's1.history'), '')
    const res = detectFromRoot(root)
    expect(res.available).toBe(false)
    expect(res.reason).toBeTruthy()
    expect(res.sessionDir).toBe(cliDir)
  })

  it('目录含 .jsonl 时可用', () => {
    const root = path.join(tmpDir, '.kiro')
    const cliDir = sessionRootOf(root)
    fs.mkdirSync(cliDir, { recursive: true })
    fs.writeFileSync(path.join(cliDir, 's1.jsonl'), JSONL_EVENT)
    const res = detectFromRoot(root)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(cliDir)
  })
})

describe('listFilesFromRoot 过滤与收集', () => {
  it('只收集 .jsonl：过滤 .history/.lock/临时/点前缀/.json sidecar/目录', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.jsonl'), JSONL_EVENT)
    fs.writeFileSync(path.join(tmpDir, 'a.json'), '{}')
    fs.writeFileSync(path.join(tmpDir, 'a.history'), '')
    fs.writeFileSync(path.join(tmpDir, 'a.lock'), '')
    fs.writeFileSync(path.join(tmpDir, 'b.jsonl.tmp'), '')
    fs.writeFileSync(path.join(tmpDir, '.hidden.jsonl'), '')
    fs.writeFileSync(path.join(tmpDir, 'c.jsonl~'), '')
    fs.mkdirSync(path.join(tmpDir, 'nested'))
    fs.writeFileSync(path.join(tmpDir, 'nested', 'd.jsonl'), JSONL_EVENT)

    const entries = listFilesFromRoot(tmpDir)
    expect(entries.map((e) => path.basename(e.path))).toEqual(['a.jsonl'])
    expect(entries[0].mtime).toBeGreaterThan(0)
  })

  it('mtime 取 .jsonl 与 sidecar .json 的较大值', () => {
    const jsonlPath = writeSession('sess-mtime')
    const old = new Date(Date.now() - 60_000)
    const near = new Date()
    fs.utimesSync(jsonlPath, old, old)
    fs.utimesSync(sidecarOf(jsonlPath), near, near)

    const entries = listFilesFromRoot(tmpDir)
    expect(entries).toHaveLength(1)
    expect(entries[0].mtime).toBeGreaterThanOrEqual(Math.round(near.getTime()) - 1500)
  })
})

function sidecarOf(jsonlPath: string): string {
  return jsonlPath.replace(/\.jsonl$/i, '.json')
}

describe('parseSessionFile 逐 turn 解析与四桶映射', () => {
  it('explicit token 四桶映射：semantics=0、status/project/sessionId/source 齐全', async () => {
    const jsonlPath = writeSession('sess-1', {
      turns: [turnMeta({ input_token_count: 100, output_token_count: 50 })]
    })
    const res = await kiroPlugin.parseFile(ctx, jsonlPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.eof).toBe(true)
    expect(res.records[0]).toMatchObject({
      appType: 'kiro',
      model: 'claude-sonnet-4-5',
      rawModel: 'claude-sonnet-4-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      inputSemantics: 0,
      status: 'success',
      project: '/Users/a/proj',
      sessionId: 'sess-1'
    })
    expect(res.records[0].source).toEqual({
      filePath: jsonlPath,
      line: 1,
      requestId: 'sess-1:0'
    })
  })

  it('requestId 按 turn 序号组合 <sessionId>:<index>，line 从 1 递增', () => {
    const jsonlPath = writeSession('sess-2', {
      turns: [turnMeta(), turnMeta(), turnMeta()]
    })
    const res = parseSessionFile(jsonlPath, 0)
    expect(res.records.map((r) => r.source.requestId)).toEqual(['sess-2:0', 'sess-2:1', 'sess-2:2'])
    expect(res.records.map((r) => r.source.line)).toEqual([1, 2, 3])
    expect(res.nextLine).toBe(4)
  })

  it('explicit input 为 0 时按原值记录，不做任何估算回填', () => {
    const jsonlPath = writeSession('sess-3', {
      turns: [turnMeta({ input_token_count: 0, output_token_count: 5 })]
    })
    const res = parseSessionFile(jsonlPath, 0)
    expect(res.records[0].inputTokens).toBe(0)
    expect(res.records[0].outputTokens).toBe(5)
  })

  it('全零 turn 产出四桶 0 的记录，交由 collector isAllZeroUsage 兜底拦截', () => {
    const jsonlPath = writeSession('sess-6', { turns: [turnMeta()] })
    const res = parseSessionFile(jsonlPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      status: 'success'
    })
    expect(res.nextLine).toBe(2)
  })

  it('turn 数值字段缺失时宽松兜底为 0（不抛错、照常产出）', () => {
    const jsonlPath = writeSession('sess-7', {
      turns: [{ message_ids: ['m-1'] } as Record<string, unknown>]
    })
    const res = parseSessionFile(jsonlPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      inputSemantics: 0
    })
  })

  it('model 缺失（model_info 为 null 或空串）时全部 turn 跳过且游标不动', () => {
    const nullInfo = writeSession('sess-8', { hasModelInfo: false, turns: [turnMeta()] })
    const r1 = parseSessionFile(nullInfo, 0)
    expect(r1.records).toHaveLength(0)
    expect(r1.nextLine).toBe(0)

    const emptyModel = writeSession('sess-9', { modelId: '  ', turns: [turnMeta()] })
    const r2 = parseSessionFile(emptyModel, 0)
    expect(r2.records).toHaveLength(0)
    expect(r2.nextLine).toBe(0)
  })

  it("model 为 'auto'（Kiro 默认模型名）时保留产出", () => {
    const jsonlPath = writeSession('sess-10', { modelId: 'auto', turns: [turnMeta()] })
    const res = parseSessionFile(jsonlPath, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].model).toBe('auto')
  })

  it('sidecar 损坏（截断 JSON）或缺失时不产出且游标停留原位', () => {
    const broken = path.join(tmpDir, 'sess-broken.jsonl')
    fs.writeFileSync(broken, JSONL_EVENT)
    fs.writeFileSync(sidecarOf(broken), '{"session_id": "x", "sess')
    const r1 = parseSessionFile(broken, 3)
    expect(r1.records).toHaveLength(0)
    expect(r1.nextLine).toBe(3)
    expect(r1.eof).toBe(true)

    const missing = path.join(tmpDir, 'sess-missing.jsonl')
    fs.writeFileSync(missing, JSONL_EVENT)
    const r2 = parseSessionFile(missing, 5)
    expect(r2.records).toHaveLength(0)
    expect(r2.nextLine).toBe(5)
    expect(r2.eof).toBe(true)
  })

  it('增量续读：fromLine 为已处理 turn 水位，只产出新增 turn', () => {
    const jsonlPath = writeSession('sess-11', {
      turns: [turnMeta(), turnMeta({ input_token_count: 7 }), turnMeta({ input_token_count: 8 })]
    })
    const r1 = parseSessionFile(jsonlPath, 0)
    expect(r1.records.map((r) => r.source.line)).toEqual([1, 2, 3])
    expect(r1.nextLine).toBe(4)

    const r2 = parseSessionFile(jsonlPath, r1.nextLine)
    expect(r2.records).toHaveLength(0)
    expect(r2.nextLine).toBe(4)
    expect(r2.eof).toBe(true)
  })

  it('sidecar 追加新 turn 后以旧游标续读只产出新增（append 回归）', () => {
    const jsonlPath = writeSession('sess-12', {
      turns: [turnMeta({ input_token_count: 1 }), turnMeta({ input_token_count: 2 })]
    })
    const r1 = parseSessionFile(jsonlPath, 0)
    expect(r1.records).toHaveLength(2)
    expect(r1.nextLine).toBe(3)

    fs.writeFileSync(
      path.join(tmpDir, 'sess-12.json'),
      sidecarJson({
        sessionId: 'sess-12',
        turns: [
          turnMeta({ input_token_count: 1 }),
          turnMeta({ input_token_count: 2 }),
          turnMeta({ input_token_count: 30 }),
          turnMeta({ input_token_count: 40 })
        ]
      }),
      'utf8'
    )

    const r2 = parseSessionFile(jsonlPath, 3)
    expect(r2.records.map((r) => r.source.line)).toEqual([3, 4])
    expect(r2.records.map((r) => r.source.requestId)).toEqual(['sess-12:2', 'sess-12:3'])
    expect(r2.records.map((r) => r.inputTokens)).toEqual([30, 40])
    expect(r2.nextLine).toBe(5)
  })

  it('fromLine 越过现有 turn 数时游标不倒退、不产出', () => {
    const jsonlPath = writeSession('sess-13', { turns: [turnMeta()] })
    const res = parseSessionFile(jsonlPath, 99)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(99)
    expect(res.eof).toBe(true)
  })

  it('无 turn 的 sidecar：nextLine 兜底为 1、无记录', () => {
    const jsonlPath = writeSession('sess-14', { turns: [] })
    const res = parseSessionFile(jsonlPath, 0)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(1)
    expect(res.eof).toBe(true)
  })

  it('session_id 缺失时以文件名 stem 兜底 sessionId 与 requestId', () => {
    const jsonlPath = writeSession('sess-stem', {
      sessionId: '',
      turns: [turnMeta({ input_token_count: 5 })]
    })
    const res = parseSessionFile(jsonlPath, 0)
    expect(res.records[0].sessionId).toBe('sess-stem')
    expect(res.records[0].source.requestId).toBe('sess-stem:0')
  })

  it('cwd 缺失时 project 不写入', () => {
    const jsonlPath = writeSession('sess-15', { cwd: '', turns: [turnMeta({ input_token_count: 5 })] })
    const res = parseSessionFile(jsonlPath, 0)
    expect(res.records[0].project).toBeUndefined()
  })
})

describe('createdAt 时间戳链', () => {
  it('end_timestamp unix 秒转毫秒', () => {
    const jsonlPath = writeSession('sess-ts1', { turns: [turnMeta({ end_timestamp: END_TS_SEC })] })
    const res = parseSessionFile(jsonlPath, 0)
    expect(res.records[0].createdAt).toBe(END_TS_SEC * 1000)
  })

  it('end_timestamp 为字符串 RFC3339 时可解析', () => {
    const jsonlPath = writeSession('sess-ts2', {
      turns: [turnMeta({ end_timestamp: '2026-06-11T23:30:00.000Z' })]
    })
    const res = parseSessionFile(jsonlPath, 0)
    expect(res.records[0].createdAt).toBe(Date.parse('2026-06-11T23:30:00.000Z'))
  })

  it('end_timestamp 缺失/非法时回退 sidecar updated_at，再回退当前时间', () => {
    expect(parseTsMs('not-a-date')).toBe(0)
    expect(parseTsMs(undefined)).toBe(0)

    const fallbackUpdatedAt = writeSession('sess-ts3', {
      updatedAt: '2026-06-12T00:00:00.000Z',
      turns: [turnMeta({ end_timestamp: 'bad' })]
    })
    const r1 = parseSessionFile(fallbackUpdatedAt, 0)
    expect(r1.records[0].createdAt).toBe(Date.parse('2026-06-12T00:00:00.000Z'))

    const noDates = writeSession('sess-ts4', {
      updatedAt: '',
      turns: [turnMeta({ end_timestamp: null })]
    })
    const r2 = parseSessionFile(noDates, 0)
    expect(Number.isNaN(r2.records[0].createdAt)).toBe(false)
    expect(Math.abs(r2.records[0].createdAt - Date.now())).toBeLessThan(60_000)
  })
})
