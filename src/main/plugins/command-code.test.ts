import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import {
  commandCodePlugin,
  dataRootOf,
  projectsRootOf,
  detectFromRoot,
  listFilesFromRoot,
  parseTranscriptFile
} from './command-code'
import type { PluginContext } from '../../../shared/context'

const ctx = {} as PluginContext

const T_U1 = '2026-08-31T04:38:00.000Z'
const T_A1 = '2026-08-31T04:39:20.351Z'
const T_A2 = '2026-08-31T04:41:00.000Z'

const sessionHeader = (o: { id?: string; cwd?: string } = {}): string =>
  JSON.stringify({
    type: 'session',
    version: 3,
    id: o.id ?? 'sess-1',
    ...(o.cwd !== undefined ? { cwd: o.cwd } : {}),
    timestamp: '2026-08-31T04:36:38.441Z'
  })

const userLine = (o: { id?: string; parentId?: string | null; timestamp?: string } = {}): string =>
  JSON.stringify({
    type: 'message',
    id: o.id ?? 'u1',
    ...(o.parentId !== undefined ? { parentId: o.parentId } : { parentId: null }),
    timestamp: o.timestamp ?? T_U1,
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] }
  })

const assistantLine = (o: {
  id?: string
  parentId?: string | null
  timestamp?: string
  model?: string
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  withUsage?: boolean
  extraUsageKeys?: Record<string, unknown>
} = {}): string =>
  JSON.stringify({
    type: 'message',
    id: o.id ?? 'a1',
    ...(o.parentId !== undefined ? { parentId: o.parentId } : { parentId: 'u1' }),
    timestamp: o.timestamp ?? T_A1,
    message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
    ...(o.withUsage === false
      ? {}
      : {
          usage: {
            inputTokens: o.input ?? 100,
            outputTokens: o.output ?? 50,
            cacheReadTokens: o.cacheRead ?? 10,
            cacheWriteTokens: o.cacheWrite ?? 5,
            ...(o.extraUsageKeys ?? {})
          }
        }),
    ...(o.model !== undefined ? { model: o.model } : {})
  })

const modelChangeLine = (o: {
  id?: string
  parentId?: string | null
  model?: string
  timestamp?: string
} = {}): string =>
  JSON.stringify({
    type: 'model_change',
    id: o.id ?? 'mc-1',
    ...(o.parentId !== undefined ? { parentId: o.parentId } : { parentId: 'a1' }),
    timestamp: o.timestamp ?? '2026-08-31T04:40:00.000Z',
    model: o.model ?? 'minimax/minimax-m3'
  })

let tmpDir = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'command-code-plugin-'))
  delete process.env.COMMANDCODE_DIR
})

afterEach(() => {
  delete process.env.COMMANDCODE_DIR
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('commandCodePlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(commandCodePlugin.id).toBe('command-code')
    expect(commandCodePlugin.name).toBe('Command Code')
    expect(commandCodePlugin.version).toBe('1.0.0')
    expect(commandCodePlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('detect', () => {
  it('projects 目录缺失时不可用并给出中文原因与预期目录', () => {
    const projectsDir = path.join(tmpDir, 'projects')
    const res = detectFromRoot(projectsDir)
    expect(res.available).toBe(false)
    expect(res.reason).toContain('commandcode')
    expect(res.sessionDir).toBe(projectsDir)
  })

  it('projects 目录存在但无 jsonl 时不可用并提示尚未产生会话', () => {
    const projectsDir = path.join(tmpDir, 'projects', 'slug')
    fs.mkdirSync(projectsDir, { recursive: true })
    fs.writeFileSync(path.join(projectsDir, 'notes.txt'), 'x')
    const res = detectFromRoot(path.join(tmpDir, 'projects'))
    expect(res.available).toBe(false)
    expect(res.reason).toContain('未发现')
  })

  it('projects 目录深层存在 jsonl 时可用（探测短路递归）', () => {
    const projectsDir = path.join(tmpDir, 'projects')
    const deep = path.join(projectsDir, 'slug', 'nested')
    fs.mkdirSync(deep, { recursive: true })
    fs.writeFileSync(path.join(deep, 'sess-1.jsonl'), sessionHeader())
    const res = detectFromRoot(projectsDir)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(projectsDir)
  })

  it('插件 detect 经 COMMANDCODE_DIR 重定位数据根', async () => {
    process.env.COMMANDCODE_DIR = tmpDir
    const projectsDir = path.join(tmpDir, 'projects', 'slug')
    fs.mkdirSync(projectsDir, { recursive: true })
    fs.writeFileSync(path.join(projectsDir, 'sess-1.jsonl'), sessionHeader())
    const res = await commandCodePlugin.detect(ctx)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(path.join(tmpDir, 'projects'))
  })
})

describe('dataRootOf / projectsRootOf', () => {
  it('COMMANDCODE_DIR 非空时覆盖默认根', () => {
    process.env.COMMANDCODE_DIR = tmpDir
    expect(dataRootOf()).toBe(tmpDir)
    expect(projectsRootOf()).toBe(path.join(tmpDir, 'projects'))
  })

  it('COMMANDCODE_DIR 空白串时回退 ~/.commandcode', () => {
    process.env.COMMANDCODE_DIR = '   '
    expect(dataRootOf()).toBe(path.join(os.homedir(), '.commandcode'))
  })
})

describe('listFilesFromRoot 收集范围', () => {
  it('深层递归枚举 jsonl，排除 checkpoints/临时/隐藏/非 jsonl 文件', () => {
    const root = path.join(tmpDir, 'projects')
    const sess = path.join(root, 'proj-a', 'nested')
    fs.mkdirSync(sess, { recursive: true })
    fs.mkdirSync(root, { recursive: true })

    fs.writeFileSync(path.join(root, 'proj-a', 'main.jsonl'), sessionHeader())
    fs.writeFileSync(path.join(sess, 'deep.jsonl'), sessionHeader())
    fs.writeFileSync(path.join(root, 'proj-a', 's.checkpoints.jsonl'), '[]')
    fs.writeFileSync(path.join(root, 'proj-a', 'half.jsonl.tmp'), 'x')
    fs.writeFileSync(path.join(root, 'proj-a', '.hidden.jsonl'), 'x')
    fs.writeFileSync(path.join(root, 'proj-a', 'backup.jsonl~'), 'x')
    fs.writeFileSync(path.join(root, 'proj-a', 'meta.json'), 'x')
    fs.writeFileSync(path.join(root, 'proj-a', 'prompts.json'), 'x')

    const entries = listFilesFromRoot(root)
    expect(entries.map((e) => path.basename(e.path)).sort()).toEqual(['deep.jsonl', 'main.jsonl'])
    for (const e of entries) {
      expect(e.mtime).toBeGreaterThan(0)
    }
  })

  it('root 不存在时返回空数组', () => {
    expect(listFilesFromRoot(path.join(tmpDir, 'nope'))).toEqual([])
  })
})

describe('parseTranscriptFile v3 记录解析', () => {
  it('session 头/user 行/model_change 行不产出，assistant usage 四桶映射且 semantics=2', async () => {
    const file = path.join(tmpDir, 'sess-1.jsonl')
    fs.writeFileSync(
      file,
      [
        sessionHeader({ cwd: '/home/al/learning' }),
        userLine(),
        assistantLine({ model: 'deepseek/deepseek-v4-flash', input: 1200, output: 317, cacheRead: 4050, cacheWrite: 300 })
      ].join('\n'),
      'utf8'
    )
    const res = await commandCodePlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.nextLine).toBe(4)
    expect(res.eof).toBe(true)

    const r = res.records[0]
    expect(r).toMatchObject({
      appType: 'command-code',
      model: 'deepseek/deepseek-v4-flash',
      rawModel: 'deepseek/deepseek-v4-flash',
      inputTokens: 1200,
      outputTokens: 317,
      cacheReadTokens: 4050,
      cacheCreationTokens: 300,
      inputSemantics: 2,
      status: 'success',
      sessionId: 'sess-1',
      project: '/home/al/learning'
    })
    expect(r.createdAt).toBe(Date.parse(T_A1))
    expect(r.source).toEqual({
      filePath: file,
      line: 3,
      requestId: `a1:${Date.parse(T_A1)}`
    })
  })

  it('行自身 model 优先于此前 model_change 状态', async () => {
    const file = path.join(tmpDir, 's.jsonl')
    fs.writeFileSync(
      file,
      [
        sessionHeader(),
        assistantLine({ id: 'a1', parentId: null, model: 'deepseek/deepseek-v4-flash' }),
        modelChangeLine({ model: 'minimax/minimax-m3' }),
        assistantLine({ id: 'a2', parentId: 'mc-1', model: 'qwen/qwen3-coder', timestamp: T_A2 })
      ].join('\n'),
      'utf8'
    )
    const res = parseTranscriptFile(file, 0)
    expect(res.records.map((r) => r.model)).toEqual([
      'deepseek/deepseek-v4-flash',
      'qwen/qwen3-coder'
    ])
  })

  it('行无 model 且无 model_change 时兜底 unknown，usage 仍产出', async () => {
    const file = path.join(tmpDir, 's.jsonl')
    fs.writeFileSync(file, [sessionHeader(), assistantLine({ model: undefined as unknown as string })].join('\n'), 'utf8')
    const res = parseTranscriptFile(file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].model).toBe('unknown')
    expect(res.records[0].rawModel).toBe('unknown')
    expect(res.records[0].inputTokens).toBe(100)
  })

  it('model_change 在 assistant 无 model 且先于其出现时提供模型回退', async () => {
    const file = path.join(tmpDir, 's.jsonl')
    fs.writeFileSync(
      file,
      [
        sessionHeader(),
        assistantLine({ id: 'a1', parentId: null, model: 'minimax/minimax-m3' }),
        modelChangeLine({ model: 'poolside/laguna-s-2.1-free' }),
        assistantLine({ id: 'a2', parentId: 'mc-1', timestamp: T_A2 })
      ].join('\n'),
      'utf8'
    )
    const res = parseTranscriptFile(file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records[1].model).toBe('poolside/laguna-s-2.1-free')
  })

  it('无 usage 块或四桶全缺的 assistant 行跳过，不估算', async () => {
    const file = path.join(tmpDir, 's.jsonl')
    fs.writeFileSync(
      file,
      [
        sessionHeader(),
        assistantLine({ id: 'a1', withUsage: false }),
        assistantLine({ id: 'a2', extraUsageKeys: { costUsd: 0 } }).replace(
          /"inputTokens":100,|"outputTokens":50,|"cacheReadTokens":10,|"cacheWriteTokens":5,/g,
          ''
        ),
        assistantLine({ id: 'a3', timestamp: T_A2 })
      ].join('\n'),
      'utf8'
    )
    const res = parseTranscriptFile(file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.line).toBe(4)
    expect(res.records[0].source.requestId).toBe(`a3:${Date.parse(T_A2)}`)
  })

  it('usage 部分桶存在时缺失桶记 0，已上报桶原样采用', async () => {
    const file = path.join(tmpDir, 's.jsonl')
    const onlyOutput = JSON.stringify({
      type: 'message',
      id: 'a1',
      parentId: null,
      timestamp: T_A1,
      message: { role: 'assistant', content: [] },
      usage: { outputTokens: 42 },
      model: 'deepseek/deepseek-v4-flash'
    })
    fs.writeFileSync(file, [sessionHeader(), onlyOutput].join('\n'), 'utf8')
    const res = parseTranscriptFile(file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 42,
      cacheReadTokens: 0,
      cacheCreationTokens: 0
    })
  })

  it('全零 usage 行仍产出（零 token 拦截由入库层负责）', async () => {
    const file = path.join(tmpDir, 's.jsonl')
    fs.writeFileSync(
      file,
      [sessionHeader(), assistantLine({ id: 'a1', parentId: null, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })].join('\n'),
      'utf8'
    )
    const res = parseTranscriptFile(file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].inputTokens).toBe(0)
  })

  it('timestamp 缺失时 createdAt 兜底当前时间，requestId 用哨兵 -1 保持稳定', async () => {
    const file = path.join(tmpDir, 's.jsonl')
    const noTs = assistantLine({ id: 'a1', parentId: null }).replace(/,"timestamp":"[^"]+"/, '')
    fs.writeFileSync(file, [sessionHeader(), noTs].join('\n'), 'utf8')
    const res = parseTranscriptFile(file, 0)
    expect(res.records).toHaveLength(1)
    expect(Math.abs(res.records[0].createdAt - Date.now())).toBeLessThan(60_000)
    expect(res.records[0].source.requestId).toBe('a1:-1')
  })

  it('timestamp 非法字符串时同上兜底，usage 非有限数值记 0', async () => {
    const file = path.join(tmpDir, 's.jsonl')
    const badTs = assistantLine({ id: 'a1', parentId: null }).replace(T_A1, 'not-a-date')
    fs.writeFileSync(file, [sessionHeader(), badTs].join('\n'), 'utf8')
    const res = parseTranscriptFile(file, 0)
    expect(res.records).toHaveLength(1)
    expect(Math.abs(res.records[0].createdAt - Date.now())).toBeLessThan(60_000)
    expect(res.records[0].source.requestId).toBe('a1:-1')
    const badUsage = JSON.stringify({
      type: 'message',
      id: 'a2',
      parentId: null,
      timestamp: T_A2,
      message: { role: 'assistant', content: [] },
      usage: { inputTokens: 'many', outputTokens: null },
      model: 'm'
    })
    fs.writeFileSync(file, [sessionHeader(), badUsage].join('\n'), 'utf8')
    const res2 = parseTranscriptFile(file, 0)
    expect(res2.records[0].inputTokens).toBe(0)
    expect(res2.records[0].outputTokens).toBe(0)
  })

  it('未见 session 头时行内 sessionId 字段兜底；非对象行（数组/标量）跳过', async () => {
    const file = path.join(tmpDir, 's.jsonl')
    const legacyish = JSON.stringify({
      type: 'message',
      id: 'a1',
      parentId: null,
      sessionId: 'legacy-sess',
      timestamp: T_A1,
      message: { role: 'assistant', content: [] },
      usage: { inputTokens: 1, outputTokens: 1 },
      model: 'm'
    })
    fs.writeFileSync(file, ['[1,2]', '"scalar"', '123', legacyish].join('\n'), 'utf8')
    const res = parseTranscriptFile(file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].sessionId).toBe('legacy-sess')
    expect(res.records[0].project).toBeUndefined()
    expect(res.nextLine).toBe(5)
  })

  it('损坏行只破坏其所在条目，不产出不崩溃', () => {
    const file = path.join(tmpDir, 's.jsonl')
    fs.writeFileSync(
      file,
      [sessionHeader(), '{"type":"message","id":"broken"', assistantLine({ id: 'a1', parentId: null, timestamp: T_A2 })].join('\n'),
      'utf8'
    )
    const res = parseTranscriptFile(file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.line).toBe(3)
    expect(res.nextLine).toBe(4)
  })
})

describe('树状 transcript 与 rewind 分支处理', () => {
  it('rewind 孤儿分支被丢弃，仅保留从叶回溯的活跃链（parentId 空串归一化为根）', () => {
    const file = path.join(tmpDir, 's.jsonl')
    fs.writeFileSync(
      file,
      [
        sessionHeader(),
        userLine({ id: 'u1', parentId: '' }),
        assistantLine({ id: 'a1', parentId: 'u1', input: 111, timestamp: T_A1 }),
        userLine({ id: 'u2', parentId: 'u1', timestamp: T_A2 }),
        assistantLine({ id: 'a2', parentId: 'u2', input: 6000, timestamp: T_A2 })
      ].join('\n'),
      'utf8'
    )
    const res = parseTranscriptFile(file, 0)
    expect(res.records.map((r) => r.source.line)).toEqual([5])
    expect(res.records[0].inputTokens).toBe(6000)
  })

  it('parentId 为 JSON null 的根链同样过滤孤儿分支', () => {
    const file = path.join(tmpDir, 's.jsonl')
    fs.writeFileSync(
      file,
      [
        sessionHeader(),
        assistantLine({ id: 'a1', parentId: null, input: 111 }),
        assistantLine({ id: 'a2', parentId: null, input: 222, timestamp: T_A2 })
      ].join('\n'),
      'utf8'
    )
    const res = parseTranscriptFile(file, 0)
    expect(res.records.map((r) => r.source.line)).toEqual([3])
    expect(res.records[0].inputTokens).toBe(222)
  })

  it('断链 fail open：祖先行缺失（损坏）时保留全部消息，不丢真实计费', () => {
    const file = path.join(tmpDir, 's.jsonl')
    fs.writeFileSync(
      file,
      [
        sessionHeader(),
        userLine({ id: 'u1', parentId: null }),
        assistantLine({ id: 'a1', parentId: 'u1', input: 5000 }),
        '{"type":"message","id":"u2","parentId":"a1"',
        assistantLine({ id: 'a2', parentId: 'u2', input: 6000, timestamp: T_A2 })
      ].join('\n'),
      'utf8'
    )
    const res = parseTranscriptFile(file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records.map((r) => r.inputTokens)).toEqual([5000, 6000])
  })

  it('parentId 环有界回溯，不挂死且按部分链过滤', () => {
    const file = path.join(tmpDir, 's.jsonl')
    fs.writeFileSync(
      file,
      [
        sessionHeader(),
        assistantLine({ id: 'a1', parentId: 'u1', input: 5000 }),
        userLine({ id: 'u1', parentId: 'a2' }),
        assistantLine({ id: 'a2', parentId: 'u1', input: 200, timestamp: T_A2 })
      ].join('\n'),
      'utf8'
    )
    const res = parseTranscriptFile(file, 0)
    expect(res.records.map((r) => r.source.line)).toEqual([4])
  })

  it('增量窗口断链时 fail open 保留全部新增行', () => {
    const file = path.join(tmpDir, 's.jsonl')
    fs.writeFileSync(
      file,
      [
        sessionHeader(),
        userLine({ id: 'u1', parentId: '' }),
        assistantLine({ id: 'a1', parentId: 'u1' }),
        userLine({ id: 'u2', parentId: 'u1', timestamp: T_A2 }),
        assistantLine({ id: 'a2', parentId: 'u2', input: 6000, timestamp: T_A2 })
      ].join('\n'),
      'utf8'
    )
    const res = parseTranscriptFile(file, 4)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.line).toBe(5)
    expect(res.records[0].inputTokens).toBe(6000)
  })

  it('无 id 的 assistant 行保留且不写 requestId，退回 (file,line) 主键去重', () => {
    const file = path.join(tmpDir, 's.jsonl')
    const noId = assistantLine({}).replace(/"id":"a1",/, '')
    fs.writeFileSync(file, [sessionHeader(), noId].join('\n'), 'utf8')
    const res = parseTranscriptFile(file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.requestId).toBeUndefined()
    expect('requestId' in res.records[0].source).toBe(false)
  })
})

describe('requestId 稳定性与 fork/rewind 去重语义', () => {
  it('requestId = <条目id>:<timestampMs>，同文件解析两次完全一致（rewind 场景）', () => {
    const file = path.join(tmpDir, 's.jsonl')
    const content = [
      sessionHeader(),
      userLine({ id: 'u1', parentId: '' }),
      assistantLine({ id: 'a1', parentId: 'u1' }),
      userLine({ id: 'u2', parentId: 'u1', timestamp: T_A2 }),
      assistantLine({ id: 'a2', parentId: 'a1', timestamp: T_A2 })
    ].join('\n')
    fs.writeFileSync(file, content, 'utf8')
    const r1 = parseTranscriptFile(file, 0)
    const r2 = parseTranscriptFile(file, 0)
    expect(r1.records.map((r) => r.source.requestId)).toEqual([
      `a1:${Date.parse(T_A1)}`,
      `a2:${Date.parse(T_A2)}`
    ])
    expect(r2.records.map((r) => r.source.requestId)).toEqual(r1.records.map((r) => r.source.requestId))
  })

  it('同 id 同 timestamp 的 fork 副本（同/跨文件）产出相同 requestId，交由 dedup_ledger 折叠', () => {
    const fileA = path.join(tmpDir, 'a.jsonl')
    const fileB = path.join(tmpDir, 'b.jsonl')
    const line = assistantLine({ id: 'shared', parentId: null })
    fs.writeFileSync(fileA, [sessionHeader({ id: 'sess-a' }), line].join('\n'), 'utf8')
    fs.writeFileSync(fileB, [sessionHeader({ id: 'sess-b' }), line].join('\n'), 'utf8')
    const ra = parseTranscriptFile(fileA, 0)
    const rb = parseTranscriptFile(fileB, 0)
    expect(ra.records[0].source.requestId).toBe(`shared:${Date.parse(T_A1)}`)
    expect(rb.records[0].source.requestId).toBe(ra.records[0].source.requestId)
  })

  it('同 id 不同 timestamp 视为不同消息，requestId 不同', () => {
    const file = path.join(tmpDir, 's.jsonl')
    fs.writeFileSync(
      file,
      [
        sessionHeader(),
        assistantLine({ id: 'dup', parentId: null }),
        assistantLine({ id: 'dup', parentId: null, timestamp: T_A2 })
      ].join('\n'),
      'utf8'
    )
    const res = parseTranscriptFile(file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records[0].source.requestId).toBe(`dup:${Date.parse(T_A1)}`)
    expect(res.records[1].source.requestId).toBe(`dup:${Date.parse(T_A2)}`)
  })
})

describe('游标增量续读', () => {
  it('一次读完，从 nextLine 续读零新增，append 后续读只产出新行', async () => {
    const file = path.join(tmpDir, 's.jsonl')
    fs.writeFileSync(
      file,
      [
        sessionHeader(),
        userLine(),
        assistantLine({ id: 'a1' }),
        assistantLine({ id: 'a2', parentId: 'a1', timestamp: T_A2 })
      ].join('\n'),
      'utf8'
    )
    const res = await commandCodePlugin.parseFile(ctx, file, 0)
    expect(res.records.map((r) => r.source.line)).toEqual([3, 4])
    expect(res.nextLine).toBe(5)
    expect(res.eof).toBe(true)

    const res2 = await commandCodePlugin.parseFile(ctx, file, res.nextLine)
    expect(res2.records).toHaveLength(0)
    expect(res2.eof).toBe(true)

    fs.appendFileSync(file, `\n${assistantLine({ id: 'a3', timestamp: '2026-08-31T04:50:00.000Z' })}`, 'utf8')
    const res3 = await commandCodePlugin.parseFile(ctx, file, res.nextLine)
    expect(res3.records).toHaveLength(1)
    expect(res3.records[0].source.line).toBe(5)
    expect(res3.records[0].source.requestId).toBe(`a3:${Date.parse('2026-08-31T04:50:00.000Z')}`)
    expect(res3.nextLine).toBe(6)
  })

  it('重启后从前缀恢复 session、project 和模型切换，只产出游标后的记录', () => {
    const file = path.join(tmpDir, 's.jsonl')
    const initial = [
      sessionHeader({ id: 'sess-restart', cwd: '/workspace/restart' }),
      modelChangeLine({ id: 'mc-0', parentId: null, model: 'model/alpha' }),
      userLine({ id: 'u1', parentId: 'mc-0' }),
      assistantLine({ id: 'a1', parentId: 'u1', model: undefined as unknown as string })
    ]
    fs.writeFileSync(file, initial.join('\n'), 'utf8')
    const first = parseTranscriptFile(file, 0)

    fs.appendFileSync(
      file,
      `\n${[
        userLine({ id: 'u2', parentId: 'a1', timestamp: T_A2 }),
        assistantLine({ id: 'a2', parentId: 'u2', model: undefined as unknown as string, timestamp: T_A2 }),
        modelChangeLine({ id: 'mc-1', parentId: 'a2', model: 'model/beta' }),
        assistantLine({
          id: 'a3',
          parentId: 'mc-1',
          model: undefined as unknown as string,
          timestamp: '2026-08-31T04:42:00.000Z'
        })
      ].join('\n')}`,
      'utf8'
    )

    const incremental = parseTranscriptFile(file, first.nextLine)
    const full = parseTranscriptFile(file, 0)
    expect([...first.records, ...incremental.records]).toEqual(full.records)
    expect(incremental.records).toHaveLength(2)
    expect(incremental.records.map((r) => r.model)).toEqual(['model/alpha', 'model/beta'])
    expect(incremental.records.map((r) => r.sessionId)).toEqual(['sess-restart', 'sess-restart'])
    expect(incremental.records.map((r) => r.project)).toEqual([
      '/workspace/restart',
      '/workspace/restart'
    ])
    expect(incremental.records.map((r) => r.source.line)).toEqual([6, 8])
  })

  it('重启增量使用完整 parentMap 和活动尾节点，结果与全量解析的新增窗口一致', () => {
    const file = path.join(tmpDir, 's.jsonl')
    const initial = [
      sessionHeader({ cwd: '/workspace/fork' }),
      userLine({ id: 'u1', parentId: null }),
      assistantLine({ id: 'a1', parentId: 'u1', model: 'model/alpha' })
    ]
    fs.writeFileSync(file, initial.join('\n'), 'utf8')
    const first = parseTranscriptFile(file, 0)

    fs.appendFileSync(
      file,
      `\n${[
        userLine({ id: 'orphan-user', parentId: 'a1', timestamp: T_A2 }),
        assistantLine({ id: 'orphan-assistant', parentId: 'orphan-user', input: 9000, timestamp: T_A2 }),
        userLine({ id: 'active-user', parentId: 'a1', timestamp: '2026-08-31T04:42:00.000Z' }),
        assistantLine({
          id: 'active-assistant',
          parentId: 'active-user',
          input: 7000,
          timestamp: '2026-08-31T04:43:00.000Z'
        })
      ].join('\n')}`,
      'utf8'
    )

    const full = parseTranscriptFile(file, 0)
    const incremental = parseTranscriptFile(file, first.nextLine)
    const expected = full.records.filter((record) => record.source.line >= first.nextLine)
    expect(incremental.records).toEqual(expected)
    expect(incremental.records.map((r) => r.source.requestId)).toEqual([
      `active-assistant:${Date.parse('2026-08-31T04:43:00.000Z')}`
    ])
    expect(incremental.records[0].inputTokens).toBe(7000)
  })

  it('缺少 session 头时可从前缀行内字段恢复状态，重复增量解析保持幂等', () => {
    const file = path.join(tmpDir, 's.jsonl')
    const prefix = JSON.stringify({
      type: 'message',
      id: 'u1',
      parentId: null,
      sessionId: 'legacy-session',
      cwd: '/workspace/legacy',
      model: 'model/legacy',
      timestamp: T_U1,
      message: { role: 'user', content: [] }
    })
    fs.writeFileSync(
      file,
      [
        prefix,
        assistantLine({ id: 'a1', parentId: 'u1', model: undefined as unknown as string })
      ].join('\n'),
      'utf8'
    )

    const incremental = parseTranscriptFile(file, 2)
    const repeated = parseTranscriptFile(file, 2)
    expect(incremental).toEqual(repeated)
    expect(incremental.records).toHaveLength(1)
    expect(incremental.records[0]).toMatchObject({
      sessionId: 'legacy-session',
      project: '/workspace/legacy',
      model: 'model/legacy'
    })
  })

  it('前缀中间坏行单独跳过且不妨碍后续状态恢复', () => {
    const file = path.join(tmpDir, 's.jsonl')
    fs.writeFileSync(
      file,
      [
        sessionHeader({ id: 'sess-bad-prefix', cwd: '/workspace/bad-prefix' }),
        '{"type":"message","id":"broken"',
        modelChangeLine({ id: 'mc-0', parentId: null, model: 'model/recovered' }),
        assistantLine({ id: 'a1', parentId: 'mc-0', model: undefined as unknown as string })
      ].join('\n'),
      'utf8'
    )

    const incremental = parseTranscriptFile(file, 4)
    expect(incremental.records).toHaveLength(1)
    expect(incremental.records[0]).toMatchObject({
      sessionId: 'sess-bad-prefix',
      project: '/workspace/bad-prefix',
      model: 'model/recovered'
    })
    expect(incremental.nextLine).toBe(5)
  })

  it('尾换行空行不越界：游标停在文件末行而非空行之后，append 回归可续读', async () => {
    const file = path.join(tmpDir, 's.jsonl')
    fs.writeFileSync(file, `${sessionHeader()}\n${userLine()}\n`, 'utf8')
    const res = parseTranscriptFile(file, 0)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(3)

    fs.appendFileSync(file, assistantLine({ id: 'a1' }), 'utf8')
    const res2 = parseTranscriptFile(file, res.nextLine)
    expect(res2.records).toHaveLength(1)
    expect(res2.records[0].source.line).toBe(3)
    expect(res2.nextLine).toBe(4)
  })

  it('尾部半行不阻塞：游标停驻该行，补全后续读产出', async () => {
    const file = path.join(tmpDir, 's.jsonl')
    const full = assistantLine({ id: 'a1' })
    const truncated = full.slice(0, Math.floor(full.length / 2))
    fs.writeFileSync(file, [sessionHeader(), truncated].join('\n'), 'utf8')
    const res = parseTranscriptFile(file, 0)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(2)
    expect(res.eof).toBe(true)

    fs.writeFileSync(file, [sessionHeader(), full].join('\n'), 'utf8')
    const res2 = parseTranscriptFile(file, res.nextLine)
    expect(res2.records).toHaveLength(1)
    expect(res2.records[0].source.line).toBe(2)
    expect(res2.nextLine).toBe(3)
  })

  it('fromLine 越过 EOF 时不倒退；空文件与读取失败均返回 eof', () => {
    const file = path.join(tmpDir, 's.jsonl')
    fs.writeFileSync(file, sessionHeader(), 'utf8')
    const res = parseTranscriptFile(file, 99)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(99)
    expect(res.eof).toBe(true)

    const empty = path.join(tmpDir, 'empty.jsonl')
    fs.writeFileSync(empty, '', 'utf8')
    const res2 = parseTranscriptFile(empty, 0)
    expect(res2.records).toHaveLength(0)
    expect(res2.eof).toBe(true)

    const res3 = parseTranscriptFile(path.join(tmpDir, 'missing.jsonl'), 7)
    expect(res3.records).toHaveLength(0)
    expect(res3.nextLine).toBe(7)
    expect(res3.eof).toBe(true)
  })
})
