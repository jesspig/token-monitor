import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { traeAgentPlugin, detectFromRoot, listFilesFromRoot, parseTrajectoryFile, trajectoriesRootOf } from './trae-agent'
import type { PluginContext } from '../../../shared/context'

const ctx = {} as PluginContext

const DEFAULT_ROOT = path.join(os.homedir(), '.local', 'share', 'trae-agent', 'trajectories')

const usageOf = (o: {
  input?: number
  output?: number
  cacheRead?: number
  cacheCreation?: number
  reasoning?: number
} = {}): Record<string, unknown> => {
  const usage: Record<string, unknown> = {
    input_tokens: o.input ?? 0,
    output_tokens: o.output ?? 0
  }
  if (o.cacheRead !== undefined) usage.cache_read_input_tokens = o.cacheRead
  if (o.cacheCreation !== undefined) usage.cache_creation_input_tokens = o.cacheCreation
  if (o.reasoning !== undefined) usage.reasoning_tokens = o.reasoning
  return usage
}

const llmCall = (o: {
  ts?: unknown
  provider?: string
  model?: string
  input?: number
  output?: number
  cacheRead?: number
  cacheCreation?: number
  reasoning?: number
  usage?: Record<string, unknown> | null
} = {}): Record<string, unknown> => {
  const item: Record<string, unknown> = {
    timestamp: 'ts' in o ? o.ts : '2026-09-11T08:00:00Z'
  }
  if (o.provider !== undefined) item.provider = o.provider
  if (o.model !== undefined) item.model = o.model
  item.response = { model: o.model ?? '', usage: 'usage' in o ? o.usage : usageOf(o) }
  return item
}

const mkTrajectory = (o: {
  provider?: string
  model?: string
  startTime?: unknown
  interactions?: unknown[]
  agentSteps?: unknown[]
}): string =>
  JSON.stringify({
    task: 'demo task',
    start_time: o.startTime === undefined ? '2026-09-11T07:59:00Z' : o.startTime,
    end_time: '2026-09-11T08:01:00Z',
    provider: o.provider ?? 'openai',
    model: o.model ?? 'file-model',
    max_steps: 20,
    llm_interactions: o.interactions ?? [],
    agent_steps: o.agentSteps ?? [],
    success: true,
    final_result: 'done',
    execution_time: 12.3
  })

let tmpDir = ''
let trajDir = ''

const envKeys = ['TRAE_TRAJECTORY_DIR'] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-agent-plugin-'))
  trajDir = path.join(tmpDir, 'trajectories')
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

const writeTraj = (name: string, content: string): string => {
  fs.mkdirSync(trajDir, { recursive: true })
  const p = path.join(trajDir, name)
  fs.writeFileSync(p, content, 'utf8')
  return p
}

describe('traeAgentPlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(traeAgentPlugin.id).toBe('trae-agent')
    expect(traeAgentPlugin.name).toBe('Trae Agent')
    expect(traeAgentPlugin.version).toBe('1.0.0')
    expect(traeAgentPlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('trajectoriesRootOf 路径解析', () => {
  it('TRAE_TRAJECTORY_DIR 设置时优先，且语义为 trajectories 目录本身', () => {
    process.env.TRAE_TRAJECTORY_DIR = path.join(tmpDir, 'override')
    expect(trajectoriesRootOf()).toBe(path.join(tmpDir, 'override'))
  })

  it('TRAE_TRAJECTORY_DIR 空白值视为未设置，回退默认目录', () => {
    process.env.TRAE_TRAJECTORY_DIR = '   '
    expect(trajectoriesRootOf()).toBe(DEFAULT_ROOT)
  })

  it('TRAE_TRAJECTORY_DIR 未设置时使用默认监控点', () => {
    expect(trajectoriesRootOf()).toBe(DEFAULT_ROOT)
  })
})

describe('detect', () => {
  it('轨迹目录缺失时不可用，reason 说明默认路径与覆盖变量', () => {
    const root = path.join(tmpDir, 'absent')
    const res = detectFromRoot(root)
    expect(res.available).toBe(false)
    expect(res.reason).toContain('TRAE_TRAJECTORY_DIR')
    expect(res.reason).toContain('trajectories')
    expect(res.sessionDir).toBe(root)
  })

  it('轨迹目录存在但无 trajectory_*.json 时不可用，说明尚未产生轨迹', () => {
    fs.mkdirSync(trajDir, { recursive: true })
    fs.writeFileSync(path.join(trajDir, 'notes.txt'), 'x', 'utf8')
    const res = detectFromRoot(trajDir)
    expect(res.available).toBe(false)
    expect(res.reason).toContain('trajectory_*.json')
    expect(res.sessionDir).toBe(trajDir)
  })

  it('轨迹目录存在且含 trajectory_*.json 时可用', () => {
    writeTraj('trajectory_20260911_080000.json', mkTrajectory({}))
    const res = detectFromRoot(trajDir)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(trajDir)
  })

  it('环境变量覆盖下 detect 与 listFiles 走覆盖目录', async () => {
    const overrideDir = path.join(tmpDir, 'override')
    fs.mkdirSync(overrideDir, { recursive: true })
    fs.writeFileSync(path.join(overrideDir, 'trajectory_20260911_090000.json'), mkTrajectory({}), 'utf8')
    process.env.TRAE_TRAJECTORY_DIR = overrideDir

    const res = await traeAgentPlugin.detect(ctx)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(overrideDir)

    const files = await traeAgentPlugin.listFiles(ctx)
    expect(files.map((f) => f.path)).toEqual([path.join(overrideDir, 'trajectory_20260911_090000.json')])
  })
})

describe('listFilesFromRoot', () => {
  it('只收集 trajectory_*.json，过滤临时/隐藏/非匹配名与非文件项，按路径排序', () => {
    fs.mkdirSync(trajDir, { recursive: true })
    fs.writeFileSync(path.join(trajDir, 'trajectory_20260911_080000.json'), mkTrajectory({}), 'utf8')
    fs.writeFileSync(path.join(trajDir, 'trajectory_20260910_075959.json'), mkTrajectory({}), 'utf8')
    fs.writeFileSync(path.join(trajDir, 'trajectory_x.json'), mkTrajectory({}), 'utf8')
    fs.writeFileSync(path.join(trajDir, 'trajectory_20260911_080001.json.tmp'), mkTrajectory({}), 'utf8')
    fs.writeFileSync(path.join(trajDir, 'trajectory_20260911_080002.json.swp'), mkTrajectory({}), 'utf8')
    fs.writeFileSync(path.join(trajDir, '.trajectory_20260911_080003.json'), mkTrajectory({}), 'utf8')
    fs.writeFileSync(path.join(trajDir, 'my-trajectory_20260911_080004.json'), mkTrajectory({}), 'utf8')
    fs.writeFileSync(path.join(trajDir, 'trajectory_20260911_080005.jsonl'), mkTrajectory({}), 'utf8')
    fs.writeFileSync(path.join(trajDir, 'trajectory_20260911_080006.json~'), mkTrajectory({}), 'utf8')
    fs.writeFileSync(path.join(trajDir, 'readme.md'), 'x', 'utf8')
    fs.mkdirSync(path.join(trajDir, 'trajectory_dir.json'), { recursive: true })

    const entries = listFilesFromRoot(trajDir)
    expect(entries.map((e) => path.basename(e.path))).toEqual([
      'trajectory_20260910_075959.json',
      'trajectory_20260911_080000.json',
      'trajectory_x.json'
    ])
    for (const e of entries) {
      expect(e.mtime).toBeGreaterThan(0)
    }
  })
})

describe('parseTrajectoryFile 正常解析与字段映射', () => {
  it('llm_interactions 条目映射四桶；anthropic→semantics 2，openai→semantics 1；reasoning_tokens 不入桶且无 requestId', async () => {
    const file = writeTraj(
      'trajectory_20260911_080000.json',
      mkTrajectory({
        interactions: [
          llmCall({
            ts: '2026-09-11T08:00:01Z',
            provider: 'anthropic',
            model: 'claude-sonnet-4-5',
            input: 100,
            output: 50,
            cacheRead: 70,
            cacheCreation: 30,
            reasoning: 20
          }),
          llmCall({
            ts: '2026-09-11T08:00:02Z',
            provider: 'openai',
            model: 'gpt-5',
            input: 200,
            output: 80,
            cacheRead: 40
          })
        ]
      })
    )

    const res = await traeAgentPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.nextLine).toBe(2)
    expect(res.eof).toBe(true)

    const [r1, r2] = res.records
    expect(r1).toMatchObject({
      appType: 'trae-agent',
      model: 'claude-sonnet-4-5',
      rawModel: 'claude-sonnet-4-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 70,
      cacheCreationTokens: 30,
      inputSemantics: 2,
      status: 'success'
    })
    expect(r1.createdAt).toBe(Date.parse('2026-09-11T08:00:01Z'))
    expect(r1.source).toEqual({ filePath: file, line: 1 })
    expect('requestId' in r1.source).toBe(false)

    expect(r2).toMatchObject({
      appType: 'trae-agent',
      model: 'gpt-5',
      inputTokens: 200,
      outputTokens: 80,
      cacheReadTokens: 40,
      cacheCreationTokens: 0,
      inputSemantics: 1,
      status: 'success'
    })
    expect(r2.source).toEqual({ filePath: file, line: 2 })
  })

  it('条目 model 空串/空白/缺失回退文件级 model；文件级也为空时该条跳过', async () => {
    const file = writeTraj(
      'trajectory_20260911_080000.json',
      mkTrajectory({
        model: 'file-model',
        interactions: [
          llmCall({ ts: '2026-09-11T08:00:01Z', model: '', input: 1 }),
          llmCall({ ts: '2026-09-11T08:00:02Z', model: '   ', input: 2 }),
          llmCall({ ts: '2026-09-11T08:00:03Z', input: 3 })
        ]
      })
    )

    const res = await traeAgentPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(3)
    for (const r of res.records) {
      expect(r.model).toBe('file-model')
      expect(r.rawModel).toBe('file-model')
    }
    expect(res.records.map((r) => r.source.line)).toEqual([1, 2, 3])

    const noModelFile = writeTraj(
      'trajectory_20260911_080100.json',
      mkTrajectory({ model: '', interactions: [llmCall({ ts: '2026-09-11T08:00:04Z', model: '', input: 4 })] })
    )
    const res2 = await traeAgentPlugin.parseFile(ctx, noModelFile, 0)
    expect(res2.records).toHaveLength(0)
    expect(res2.nextLine).toBe(1)
  })

  it('条目 provider 缺失回退文件级 provider；两级均空按 semantics 1 兜底', async () => {
    const file = writeTraj(
      'trajectory_20260911_080000.json',
      mkTrajectory({
        provider: 'doubao',
        interactions: [
          llmCall({ ts: '2026-09-11T08:00:01Z', input: 10, output: 5 }),
          llmCall({ ts: '2026-09-11T08:00:02Z', provider: 'anthropic', input: 3, output: 1 })
        ]
      })
    )

    const res = await traeAgentPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records[0].inputSemantics).toBe(1)
    expect(res.records[1].inputSemantics).toBe(2)

    const noProviderFile = writeTraj(
      'trajectory_20260911_080100.json',
      mkTrajectory({
        provider: '',
        interactions: [llmCall({ ts: '2026-09-11T08:00:03Z', input: 6, output: 2 })]
      })
    )
    const res2 = await traeAgentPlugin.parseFile(ctx, noProviderFile, 0)
    expect(res2.records).toHaveLength(1)
    expect(res2.records[0].inputSemantics).toBe(1)
  })

  it('条目 timestamp 缺失或无效回退文件级 start_time；两级均无效兜底当前时间', async () => {
    const file = writeTraj(
      'trajectory_20260911_080000.json',
      mkTrajectory({
        startTime: '2026-09-11T07:59:00Z',
        interactions: [
          llmCall({ ts: '', input: 1 }),
          llmCall({ ts: 'not-a-date', input: 2 }),
          llmCall({ ts: undefined, input: 3, usage: { input_tokens: 3, output_tokens: 1 } })
        ]
      })
    )

    const res = await traeAgentPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(3)
    const startMs = Date.parse('2026-09-11T07:59:00Z')
    for (const r of res.records) {
      expect(r.createdAt).toBe(startMs)
    }

    const bothInvalid = writeTraj(
      'trajectory_20260911_080100.json',
      mkTrajectory({
        startTime: 'garbage',
        interactions: [llmCall({ ts: undefined, input: 9 })]
      })
    )
    const res2 = await traeAgentPlugin.parseFile(ctx, bothInvalid, 0)
    expect(res2.records).toHaveLength(1)
    expect(Math.abs(res2.records[0].createdAt - Date.now())).toBeLessThan(60_000)
  })

  it('agent_steps 中的 usage 一律不采，防双计', async () => {
    const file = writeTraj(
      'trajectory_20260911_080000.json',
      mkTrajectory({
        interactions: [llmCall({ ts: '2026-09-11T08:00:01Z', input: 10, output: 5 })],
        agentSteps: [
          { step: 1, usage: { input_tokens: 999, output_tokens: 888 } },
          { step: 2, usage: { input_tokens: 777, output_tokens: 666 } }
        ]
      })
    )

    const res = await traeAgentPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({ inputTokens: 10, outputTokens: 5 })
  })

  it('response 或 usage 缺失/类型异常时四桶兜 0，条目仍产出', async () => {
    const file = writeTraj(
      'trajectory_20260911_080000.json',
      mkTrajectory({
        interactions: [
          llmCall({ ts: '2026-09-11T08:00:01Z', usage: null }),
          { timestamp: '2026-09-11T08:00:02Z', provider: 'openai', model: 'gpt-5', response: 'oops' },
          { timestamp: '2026-09-11T08:00:03Z', provider: 'openai', model: 'gpt-5', response: { usage: 'oops' } }
        ]
      })
    )

    const res = await traeAgentPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(3)
    for (const r of res.records) {
      expect(r).toMatchObject({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0
      })
    }
    expect(res.records.map((r) => r.source.line)).toEqual([1, 2, 3])
  })
})

describe('parseTrajectoryFile 数组水位增量与容错', () => {
  it('数组水位增量：重析后 append 新条目只产出新增，游标推进到数组长度', async () => {
    const file = writeTraj(
      'trajectory_20260911_080000.json',
      mkTrajectory({
        interactions: [
          llmCall({ ts: '2026-09-11T08:00:01Z', provider: 'anthropic', input: 10, output: 5 }),
          llmCall({ ts: '2026-09-11T08:00:02Z', provider: 'openai', input: 20, output: 8 })
        ]
      })
    )

    const r1 = await traeAgentPlugin.parseFile(ctx, file, 0)
    expect(r1.records).toHaveLength(2)
    expect(r1.nextLine).toBe(2)
    expect(r1.eof).toBe(true)

    const r1Again = await traeAgentPlugin.parseFile(ctx, file, r1.nextLine)
    expect(r1Again.records).toHaveLength(0)
    expect(r1Again.nextLine).toBe(2)

    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { llm_interactions: unknown[] }
    doc.llm_interactions.push(
      llmCall({ ts: '2026-09-11T08:00:30Z', provider: 'google', input: 7, output: 3 })
    )
    fs.writeFileSync(file, JSON.stringify(doc), 'utf8')

    const r2 = await traeAgentPlugin.parseFile(ctx, file, r1.nextLine)
    expect(r2.records).toHaveLength(1)
    expect(r2.records[0].source).toEqual({ filePath: file, line: 3 })
    expect(r2.records[0].inputTokens).toBe(7)
    expect(r2.records[0].inputSemantics).toBe(1)
    expect(r2.nextLine).toBe(3)
    expect(r2.eof).toBe(true)
  })

  it('文件被覆盖变短（条目数 < 水位）时水位重置 0 全量重析', async () => {
    const file = writeTraj(
      'trajectory_20260911_080000.json',
      mkTrajectory({
        interactions: [
          llmCall({ ts: '2026-09-11T08:00:01Z', input: 11, output: 1 }),
          llmCall({ ts: '2026-09-11T08:00:02Z', input: 22, output: 2 })
        ]
      })
    )

    const res = await traeAgentPlugin.parseFile(ctx, file, 5)
    expect(res.records).toHaveLength(2)
    expect(res.records.map((r) => r.source.line)).toEqual([1, 2])
    expect(res.records.map((r) => r.inputTokens)).toEqual([11, 22])
    expect(res.nextLine).toBe(2)
    expect(res.eof).toBe(true)
  })

  it('坏 JSON 容错：空 records 且游标不动（含首次解析与已推进水位两种）', async () => {
    const file = writeTraj('trajectory_20260911_080000.json', '{"task": "x", "llm_interactions": [ {broken')

    const rFrom3 = await traeAgentPlugin.parseFile(ctx, file, 3)
    expect(rFrom3.records).toHaveLength(0)
    expect(rFrom3.nextLine).toBe(3)
    expect(rFrom3.eof).toBe(true)

    const rFrom0 = await traeAgentPlugin.parseFile(ctx, file, 0)
    expect(rFrom0.records).toHaveLength(0)
    expect(rFrom0.nextLine).toBe(0)

    const arrayRoot = writeTraj('trajectory_20260911_080100.json', '[1, 2, 3]')
    const rArray = await traeAgentPlugin.parseFile(ctx, arrayRoot, 4)
    expect(rArray.records).toHaveLength(0)
    expect(rArray.nextLine).toBe(4)
  })

  it('文件读取失败时返回空结果且游标原样保留', async () => {
    const missing = path.join(tmpDir, 'missing.json')
    const res = await traeAgentPlugin.parseFile(ctx, missing, 7)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(7)
    expect(res.eof).toBe(true)
  })

  it('llm_interactions 缺失或非数组时无记录，空数组文件水位归 0', async () => {
    const noField = writeTraj(
      'trajectory_20260911_080000.json',
      JSON.stringify({ task: 'x', start_time: '2026-09-11T07:59:00Z', provider: 'openai', model: 'm' })
    )
    const r1 = await traeAgentPlugin.parseFile(ctx, noField, 0)
    expect(r1.records).toHaveLength(0)
    expect(r1.nextLine).toBe(0)
    expect(r1.eof).toBe(true)

    const empty = writeTraj('trajectory_20260911_080100.json', mkTrajectory({ interactions: [] }))
    const r2 = await traeAgentPlugin.parseFile(ctx, empty, 0)
    expect(r2.records).toHaveLength(0)
    expect(r2.nextLine).toBe(0)
    expect(r2.eof).toBe(true)
  })
})

describe('parseTrajectoryFile 导出一致性', () => {
  it('模块级解析函数与插件方法结果一致', async () => {
    const file = writeTraj(
      'trajectory_20260911_080000.json',
      mkTrajectory({ interactions: [llmCall({ ts: '2026-09-11T08:00:01Z', input: 5, output: 2 })] })
    )
    const direct = parseTrajectoryFile(file, 0)
    const viaPlugin = await traeAgentPlugin.parseFile(ctx, file, 0)
    expect(direct).toEqual(viaPlugin)
  })
})
