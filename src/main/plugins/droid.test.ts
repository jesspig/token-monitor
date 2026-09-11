import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import {
  droidPlugin,
  dataRootOf,
  detectFromRoot,
  listFilesFromRoot,
  parseSessionFile,
  parseSettingsSummaryFile
} from './droid'
import type { PluginContext } from '../../../shared/context'

const ctx = {} as PluginContext

type AssistantOpts = {
  mid?: string
  model?: unknown
  ts?: unknown
  inputTokens?: unknown
  outputTokens?: unknown
  cacheRead?: unknown
  cacheCreation?: unknown
  usage?: unknown
  withUsage?: boolean
}

const assistantLine = (o: AssistantOpts = {}): string => {
  const msg: Record<string, unknown> = {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    model: 'model' in o ? o.model : 'factory-large',
    id: o.mid ?? 'm1'
  }
  if (o.withUsage !== false) {
    msg.usage =
      o.usage !== undefined
        ? o.usage
        : {
            inputTokens: 'inputTokens' in o ? o.inputTokens : 100,
            outputTokens: 'outputTokens' in o ? o.outputTokens : 50,
            cacheCreationInputTokens: 'cacheCreation' in o ? o.cacheCreation : 20,
            cacheReadInputTokens: 'cacheRead' in o ? o.cacheRead : 30
          }
  }
  return JSON.stringify({
    type: 'message',
    id: `row-${o.mid ?? 'm1'}`,
    parentId: null,
    timestamp: 'ts' in o ? o.ts : '2026-09-11T08:00:00Z',
    message: msg
  })
}

const sessionStartLine = (o: { cwd?: unknown } = {}): string =>
  JSON.stringify({
    type: 'session_start',
    id: 'sess-1',
    ...('cwd' in o ? { cwd: o.cwd } : { cwd: '/demo/project' }),
    title: 'demo',
    owner: { id: 'u1' }
  })

const userMessageLine = (): string =>
  JSON.stringify({
    type: 'message',
    id: 'row-u1',
    parentId: null,
    timestamp: '2026-09-11T08:00:01Z',
    message: {
      role: 'user',
      content: 'hi',
      model: 'factory-large',
      id: 'u1',
      usage: { inputTokens: 9, outputTokens: 9, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
    }
  })

const compactionLine = (): string => JSON.stringify({ type: 'compaction_state', summary: 'none' })

let tmpDir = ''

const envKeys = ['DROID_DIR'] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'droid-plugin-'))
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

describe('droidPlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(droidPlugin.id).toBe('droid')
    expect(droidPlugin.name).toBe('Droid')
    expect(droidPlugin.version).toBe('1.0.0')
    expect(droidPlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('dataRootOf 路径解析', () => {
  it('DROID_DIR 优先于默认路径，语义为数据根本身', () => {
    const override = path.join(tmpDir, 'factory')
    process.env.DROID_DIR = override
    expect(dataRootOf()).toBe(override)
  })

  it('DROID_DIR 空白视为未设置，回退默认', () => {
    process.env.DROID_DIR = '   '
    expect(dataRootOf()).toBe(path.join(os.homedir(), '.factory'))
  })

  it('未设置时默认 ~/.factory', () => {
    expect(dataRootOf()).toBe(path.join(os.homedir(), '.factory'))
  })
})

describe('detect 三态', () => {
  it('数据根缺失时不可用，reason 说明默认路径与 DROID_DIR 覆盖', () => {
    const root = path.join(tmpDir, 'nope')
    const res = detectFromRoot(root)
    expect(res.available).toBe(false)
    expect(res.reason).toContain('DROID_DIR')
    expect(res.sessionDir).toBe(root)
  })

  it('数据根存在但 sessions/ 与 projects/ 均缺失时不可用', () => {
    const root = path.join(tmpDir, 'factory')
    fs.mkdirSync(root, { recursive: true })
    const res = detectFromRoot(root)
    expect(res.available).toBe(false)
    expect(res.reason).toContain('sessions/')
    expect(res.sessionDir).toBe(root)
  })

  it('sessions/ 子目录存在即可用', () => {
    const root = path.join(tmpDir, 'factory')
    fs.mkdirSync(path.join(root, 'sessions'), { recursive: true })
    const res = detectFromRoot(root)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(root)
  })

  it('projects/ 子目录存在也可用', () => {
    const root = path.join(tmpDir, 'factory-b')
    fs.mkdirSync(path.join(root, 'projects'), { recursive: true })
    const res = detectFromRoot(root)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(root)
  })
})

describe('环境变量覆盖下 detect 与 listFiles 走覆盖目录', () => {
  it('DROID_DIR 指向数据根时 detect 可用且 listFiles 收集其下会话', async () => {
    const root = path.join(tmpDir, 'override-factory')
    const sessionFile = path.join(root, 'sessions', 'projA', 'abc.jsonl')
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true })
    fs.writeFileSync(sessionFile, [sessionStartLine(), assistantLine()].join('\n'), 'utf8')
    process.env.DROID_DIR = root

    const res = await droidPlugin.detect(ctx)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(root)

    const files = await droidPlugin.listFiles(ctx)
    expect(files.map((f) => f.path)).toEqual([sessionFile])
  })
})

describe('listFilesFromRoot 双布局收集', () => {
  it('sessions/ 与 projects/ 子树收集 JSONL 和配套 settings，临时隐藏文件排除', () => {
    const root = path.join(tmpDir, 'factory')
    const sessions = path.join(root, 'sessions')
    fs.mkdirSync(path.join(sessions, 'projA'), { recursive: true })
    fs.mkdirSync(path.join(sessions, 'sess-uuid'), { recursive: true })
    fs.mkdirSync(path.join(root, 'projects', 'enc-proj'), { recursive: true })
    fs.mkdirSync(path.join(root, 'other'), { recursive: true })

    fs.writeFileSync(path.join(sessions, 'projA', 'abc.jsonl'), assistantLine(), 'utf8')
    fs.writeFileSync(path.join(sessions, 'projA', 'abc.settings.json'), '{}', 'utf8')
    fs.writeFileSync(path.join(sessions, 'projA', 'def.jsonl.tmp'), assistantLine(), 'utf8')
    fs.writeFileSync(path.join(sessions, 'projA', '.hidden.jsonl'), assistantLine(), 'utf8')
    fs.writeFileSync(path.join(sessions, 'projA', 'ghi.jsonl.swp'), assistantLine(), 'utf8')
    fs.writeFileSync(path.join(sessions, 'projA', 'jkl.jsonl~'), assistantLine(), 'utf8')
    fs.writeFileSync(path.join(sessions, 'sess-uuid', 'main.jsonl'), assistantLine(), 'utf8')
    fs.writeFileSync(path.join(sessions, 'sess-uuid', 'agent-1.jsonl'), assistantLine(), 'utf8')
    fs.writeFileSync(path.join(root, 'projects', 'enc-proj', 'sid1.jsonl'), assistantLine(), 'utf8')
    fs.writeFileSync(path.join(root, 'other', 'loose.jsonl'), assistantLine(), 'utf8')
    fs.writeFileSync(path.join(root, 'readme.md'), 'x', 'utf8')

    const entries = listFilesFromRoot(root)
    expect(entries.map((e) => path.basename(e.path))).toEqual([
      'sid1.jsonl',
      'abc.jsonl',
      'abc.settings.json',
      'agent-1.jsonl',
      'main.jsonl'
    ])
    for (const e of entries) {
      expect(e.mtime).toBeGreaterThan(0)
    }
  })
})

describe('parseSessionFile 正常解析与字段映射', () => {
  it('标准行映射：四桶 + semantics=2 + requestId=message.id + cwd→project + createdAt=timestamp', async () => {
    const file = path.join(tmpDir, 'abc.jsonl')
    fs.writeFileSync(file, [sessionStartLine(), assistantLine()].join('\n'), 'utf8')

    const res = await droidPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.nextLine).toBe(3)
    expect(res.eof).toBe(true)

    const r = res.records[0]
    expect(r).toMatchObject({
      appType: 'droid',
      model: 'factory-large',
      rawModel: 'factory-large',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 30,
      cacheCreationTokens: 20,
      inputSemantics: 2,
      status: 'success',
      isReplaceableSnapshot: true
    })
    expect(r.createdAt).toBe(Date.parse('2026-09-11T08:00:00Z'))
    expect(r.project).toBe('/demo/project')
    expect(r.source).toEqual({ filePath: file, line: 2, requestId: 'm1' })
  })

  it('usage 数值缺失或类型异常时兜底为 0，仍产出记录', async () => {
    const file = path.join(tmpDir, 'abc.jsonl')
    fs.writeFileSync(
      file,
      [
        assistantLine({ mid: 'a', inputTokens: '100', outputTokens: null, cacheRead: null, cacheCreation: undefined }),
        assistantLine({ mid: 'b', usage: {} })
      ].join('\n'),
      'utf8'
    )

    const res = await droidPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)
    for (const r of res.records) {
      expect(r).toMatchObject({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        inputSemantics: 2
      })
    }
  })

  it('timestamp 缺失或不可解析时 createdAt 兜底当前时间，数字毫秒原样采用', async () => {
    const file = path.join(tmpDir, 'abc.jsonl')
    fs.writeFileSync(
      file,
      [
        assistantLine({ mid: 'a', ts: 'not-a-date' }),
        assistantLine({ mid: 'b', ts: '' }),
        assistantLine({ mid: 'c', ts: 1_757_500_000_000 })
      ].join('\n'),
      'utf8'
    )

    const res = await droidPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(3)
    expect(Math.abs(res.records[0].createdAt - Date.now())).toBeLessThan(60_000)
    expect(Math.abs(res.records[1].createdAt - Date.now())).toBeLessThan(60_000)
    expect(res.records[2].createdAt).toBe(1_757_500_000_000)
  })

  it('project 取首个非空 session_start 的 cwd，后续 session_start 不覆盖、空 cwd 不更新', async () => {
    const file = path.join(tmpDir, 'abc.jsonl')
    fs.writeFileSync(
      file,
      [
        sessionStartLine({ cwd: '/first' }),
        assistantLine({ mid: 'a' }),
        sessionStartLine({ cwd: '/second' }),
        assistantLine({ mid: 'b' }),
        sessionStartLine({ cwd: '' }),
        assistantLine({ mid: 'c' })
      ].join('\n'),
      'utf8'
    )

    const res = await droidPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(3)
    for (const r of res.records) {
      expect(r.project).toBe('/first')
    }
  })
})

describe('同 message.id 流式分片折叠', () => {
  it('同 message.id 多行折叠取 output 最大整条（input 一致），不同 id 不折叠', async () => {
    const file = path.join(tmpDir, 'abc.jsonl')
    fs.writeFileSync(
      file,
      [
        sessionStartLine(),
        assistantLine({ mid: 'm1', outputTokens: 10, ts: '2026-09-11T08:00:01Z' }),
        assistantLine({ mid: 'm1', outputTokens: 50, ts: '2026-09-11T08:00:02Z' }),
        assistantLine({ mid: 'm1', outputTokens: 30, ts: '2026-09-11T08:00:03Z' }),
        assistantLine({ mid: 'm2', outputTokens: 7, ts: '2026-09-11T08:00:04Z' })
      ].join('\n'),
      'utf8'
    )

    const res = await droidPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(2)

    const folded = res.records[0]
    expect(folded.source.requestId).toBe('m1')
    expect(folded.outputTokens).toBe(50)
    expect(folded.inputTokens).toBe(100)
    expect(folded.cacheReadTokens).toBe(30)
    expect(folded.cacheCreationTokens).toBe(20)
    expect(folded.createdAt).toBe(Date.parse('2026-09-11T08:00:02Z'))
    expect(folded.source.line).toBe(3)
    expect(folded.isReplaceableSnapshot).toBe(true)

    expect(res.records[1].source.requestId).toBe('m2')
    expect(res.records[1].outputTokens).toBe(7)
    expect(res.records[1].source.line).toBe(5)
  })
})

describe('跨同步轮次可替换快照收敛', () => {
  it('partial→final 只产出最终快照并保持相同 requestId', async () => {
    const file = path.join(tmpDir, 'abc.jsonl')
    fs.writeFileSync(file, [sessionStartLine(), assistantLine({ mid: 'm1', outputTokens: 10 })].join('\n'), 'utf8')
    const first = await parseSessionFile(file, 0)
    expect(first.records[0]).toMatchObject({ outputTokens: 10, isReplaceableSnapshot: true, source: { requestId: 'm1', line: 2 } })
    fs.appendFileSync(file, '\n' + assistantLine({ mid: 'm1', outputTokens: 100, ts: '2026-09-11T08:00:02Z' }), 'utf8')
    const final = await parseSessionFile(file, first.nextLine)
    expect(final.records).toHaveLength(1)
    expect(final.records[0]).toMatchObject({ outputTokens: 100, isReplaceableSnapshot: true, source: { requestId: 'm1', line: 3 } })
  })

  it('前缀已有更完整快照时忽略后续过期快照', async () => {
    const file = path.join(tmpDir, 'abc.jsonl')
    fs.writeFileSync(file, [sessionStartLine(), assistantLine({ mid: 'm1', outputTokens: 100 })].join('\n'), 'utf8')
    const first = await parseSessionFile(file, 0)
    fs.appendFileSync(file, '\n' + assistantLine({ mid: 'm1', outputTokens: 30 }), 'utf8')
    const stale = await parseSessionFile(file, first.nextLine)
    expect(stale.records).toHaveLength(0)
  })

  it('output 相同时以后出现的完整四桶快照为准', async () => {
    const file = path.join(tmpDir, 'abc.jsonl')
    fs.writeFileSync(file, [sessionStartLine(), assistantLine({ mid: 'm1', outputTokens: 50 })].join('\n'), 'utf8')
    const first = await parseSessionFile(file, 0)
    fs.appendFileSync(file, '\n' + assistantLine({ mid: 'm1', inputTokens: 140, outputTokens: 50, cacheRead: 40, cacheCreation: 25 }), 'utf8')
    const final = await parseSessionFile(file, first.nextLine)
    expect(final.records).toHaveLength(1)
    expect(final.records[0]).toMatchObject({ inputTokens: 140, outputTokens: 50, cacheReadTokens: 40, cacheCreationTokens: 25, isReplaceableSnapshot: true, source: { requestId: 'm1', line: 3 } })
  })

  it('当前窗口多个新分片只返回最终胜出快照', async () => {
    const file = path.join(tmpDir, 'abc.jsonl')
    fs.writeFileSync(file, [sessionStartLine(), assistantLine({ mid: 'm1', outputTokens: 10 })].join('\n'), 'utf8')
    const first = await parseSessionFile(file, 0)
    fs.appendFileSync(file, '\n' + [30, 60, 100].map((value) => assistantLine({ mid: 'm1', outputTokens: value })).join('\n'), 'utf8')
    const final = await parseSessionFile(file, first.nextLine)
    expect(final.records).toHaveLength(1)
    expect(final.records[0]).toMatchObject({ outputTokens: 100, source: { requestId: 'm1', line: 5 } })
  })

  it('一次全量与重启后的两轮增量收敛到相同最终记录', async () => {
    const file = path.join(tmpDir, 'abc.jsonl')
    fs.writeFileSync(file, [sessionStartLine(), assistantLine({ mid: 'm1', outputTokens: 10 })].join('\n'), 'utf8')
    const first = await parseSessionFile(file, 0)
    fs.appendFileSync(file, '\n' + assistantLine({ mid: 'm1', inputTokens: 150, outputTokens: 100, cacheRead: 40 }), 'utf8')
    const incremental = await parseSessionFile(file, first.nextLine)
    const full = await parseSessionFile(file, 0)
    expect(incremental.records).toEqual(full.records)
  })

  it('无 message.id 的成功记录保持不可替换且不构造推测身份', async () => {
    const file = path.join(tmpDir, 'abc.jsonl')
    const row = JSON.parse(assistantLine()) as { message: Record<string, unknown> }
    delete row.message.id
    fs.writeFileSync(file, JSON.stringify(row), 'utf8')
    const res = await parseSessionFile(file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.requestId).toBeUndefined()
    expect(res.records[0].isReplaceableSnapshot).toBeUndefined()
  })
})

describe('settings 摘要安全发现与忽略策略', () => {
  it('旧版、新版、过期和仅费用摘要均不作为 Token 来源', async () => {
    const summaries = [
      { lastTokenUsage: { inputTokens: 10, outputTokens: 5 } },
      { lastUsageTableData: { input: 10, output: 5 }, lastCost: 0.02 },
      { updatedAt: '2026-09-10T00:00:00Z', lastTokenUsage: { total: 99 } },
      { provider: 'unknown-provider', lastCost: 0.5 }
    ]
    for (let i = 0; i < summaries.length; i++) {
      const file = path.join(tmpDir, 'session-' + i + '.settings.json')
      fs.writeFileSync(file, JSON.stringify(summaries[i]), 'utf8')
      expect(await parseSettingsSummaryFile(file, 0)).toEqual({ records: [], nextLine: 1, eof: true })
    }
  })

  it('坏 JSON 和非对象顶层显式失败', async () => {
    const broken = path.join(tmpDir, 'broken.settings.json')
    fs.writeFileSync(broken, '{bad', 'utf8')
    await expect(parseSettingsSummaryFile(broken, 0)).rejects.toThrow('不是合法 JSON')
    const array = path.join(tmpDir, 'array.settings.json')
    fs.writeFileSync(array, '[]', 'utf8')
    await expect(parseSettingsSummaryFile(array, 0)).rejects.toThrow('顶层必须是对象')
  })

  it('settings 缺失时保留游标且不影响 JSONL 原行为', async () => {
    const missing = path.join(tmpDir, 'missing.settings.json')
    expect(await parseSettingsSummaryFile(missing, 7)).toEqual({ records: [], nextLine: 7, eof: true })
    const jsonl = path.join(tmpDir, 'session.jsonl')
    fs.writeFileSync(jsonl, assistantLine({ mid: 'm1' }), 'utf8')
    const res = await droidPlugin.parseFile(ctx, jsonl, 0)
    expect(res.records).toHaveLength(1)
  })

  it('settings 通过插件入口解析且从不与 JSONL 独立累计', async () => {
    const settings = path.join(tmpDir, 'abc.settings.json')
    fs.writeFileSync(settings, JSON.stringify({ lastTokenUsage: { inputTokens: 100, outputTokens: 50 }, lastCost: 1 }), 'utf8')
    expect(await droidPlugin.parseFile(ctx, settings, 0)).toEqual({ records: [], nextLine: 1, eof: true })
  })

  it('sessions 与 projects 的重复消息使用相同可替换语义身份', async () => {
    const sessionFile = path.join(tmpDir, 'sessions', 'same.jsonl')
    const projectFile = path.join(tmpDir, 'projects', 'same.jsonl')
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true })
    fs.mkdirSync(path.dirname(projectFile), { recursive: true })
    fs.writeFileSync(sessionFile, assistantLine({ mid: 'shared-message', outputTokens: 10 }), 'utf8')
    fs.writeFileSync(projectFile, assistantLine({ mid: 'shared-message', outputTokens: 100 }), 'utf8')

    const session = await parseSessionFile(sessionFile, 0)
    const project = await parseSessionFile(projectFile, 0)
    expect(session.records[0].source.requestId).toBe('shared-message')
    expect(project.records[0].source.requestId).toBe('shared-message')
    expect(session.records[0].isReplaceableSnapshot).toBe(true)
    expect(project.records[0].isReplaceableSnapshot).toBe(true)
  })
})

describe('跳过规则', () => {
  it('非 message 行、非 assistant、无 usage、usage 非对象、model 空的行全部跳过', async () => {
    const file = path.join(tmpDir, 'abc.jsonl')
    fs.writeFileSync(
      file,
      [
        compactionLine(),
        userMessageLine(),
        assistantLine({ mid: 'nu', withUsage: false }),
        assistantLine({ mid: 'un', usage: null }),
        assistantLine({ mid: 'us', usage: 'weird' }),
        assistantLine({ mid: 'e1', model: '' }),
        assistantLine({ mid: 'e2', model: '   ' }),
        assistantLine({ mid: 'ok1' })
      ].join('\n'),
      'utf8'
    )

    const res = await droidPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.line).toBe(8)
    expect(res.records[0].source.requestId).toBe('ok1')
    expect(res.nextLine).toBe(9)
  })
})

describe('游标增量与容错', () => {
  it('完整文件一次读完，续读为空；append 后续读只产出新增且 project 状态恢复', async () => {
    const file = path.join(tmpDir, 'abc.jsonl')
    fs.writeFileSync(
      file,
      [sessionStartLine(), assistantLine({ mid: 'm1' }), assistantLine({ mid: 'm2', ts: '2026-09-11T08:00:10Z' })].join('\n'),
      'utf8'
    )

    const res = await droidPlugin.parseFile(ctx, file, 0)
    expect(res.records.map((r) => r.source.requestId)).toEqual(['m1', 'm2'])
    expect(res.nextLine).toBe(4)
    expect(res.eof).toBe(true)

    const res2 = await droidPlugin.parseFile(ctx, file, res.nextLine)
    expect(res2.records).toHaveLength(0)
    expect(res2.eof).toBe(true)

    fs.appendFileSync(file, `\n${assistantLine({ mid: 'm3', ts: '2026-09-11T08:00:20Z' })}`, 'utf8')
    const res3 = await droidPlugin.parseFile(ctx, file, res.nextLine)
    expect(res3.records).toHaveLength(1)
    expect(res3.records[0].source).toEqual({ filePath: file, line: 4, requestId: 'm3' })
    expect(res3.records[0].project).toBe('/demo/project')
    expect(res3.nextLine).toBe(5)
    expect(res3.eof).toBe(true)
  })

  it('续读跳过头部 session_start 时仍能恢复 project 状态', async () => {
    const file = path.join(tmpDir, 'abc.jsonl')
    fs.writeFileSync(
      file,
      [sessionStartLine(), assistantLine({ mid: 'm1' }), assistantLine({ mid: 'm2', ts: '2026-09-11T08:00:10Z' })].join('\n'),
      'utf8'
    )

    const res = await parseSessionFile(file, 2)
    expect(res.records.map((r) => [r.source.line, r.project])).toEqual([
      [2, '/demo/project'],
      [3, '/demo/project']
    ])
  })

  it('中间坏行跳过不阻塞后续行', async () => {
    const file = path.join(tmpDir, 'abc.jsonl')
    fs.writeFileSync(
      file,
      [sessionStartLine(), '{this is broken json', assistantLine({ mid: 'm1' })].join('\n'),
      'utf8'
    )

    const res = await droidPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.line).toBe(3)
    expect(res.records[0].project).toBe('/demo/project')
    expect(res.nextLine).toBe(4)
    expect(res.eof).toBe(true)
  })

  it('尾部半行停驻：游标停在半行，补全后续读产出该行', async () => {
    const file = path.join(tmpDir, 'abc.jsonl')
    const trailingHalf = '{"type":"message","id":"row-m2","message":{"role":"assistant","model":"factory-la'
    fs.writeFileSync(file, [sessionStartLine(), assistantLine({ mid: 'm1' }), trailingHalf].join('\n'), 'utf8')

    const res = await droidPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.line).toBe(2)
    expect(res.nextLine).toBe(3)
    expect(res.eof).toBe(true)

    fs.writeFileSync(
      file,
      [sessionStartLine(), assistantLine({ mid: 'm1' }), assistantLine({ mid: 'm2', outputTokens: 66, ts: '2026-09-11T08:00:30Z' })].join('\n'),
      'utf8'
    )
    const res2 = await droidPlugin.parseFile(ctx, file, res.nextLine)
    expect(res2.records).toHaveLength(1)
    expect(res2.records[0].source.line).toBe(3)
    expect(res2.records[0].source.requestId).toBe('m2')
    expect(res2.records[0].outputTokens).toBe(66)
    expect(res2.nextLine).toBe(4)
    expect(res2.eof).toBe(true)
  })

  it('空文件游标停在 1；fromLine 越过 EOF 时无记录且游标不倒退', async () => {
    const empty = path.join(tmpDir, 'empty.jsonl')
    fs.writeFileSync(empty, '', 'utf8')
    const r1 = await droidPlugin.parseFile(ctx, empty, 0)
    expect(r1.records).toHaveLength(0)
    expect(r1.eof).toBe(true)
    expect(r1.nextLine).toBe(1)

    const one = path.join(tmpDir, 'one.jsonl')
    fs.writeFileSync(one, assistantLine(), 'utf8')
    const r2 = await droidPlugin.parseFile(ctx, one, 99)
    expect(r2.records).toHaveLength(0)
    expect(r2.nextLine).toBe(99)
    expect(r2.eof).toBe(true)
  })

  it('文件读取失败时返回空结果且游标原样保留', async () => {
    const missing = path.join(tmpDir, 'missing.jsonl')
    const res = await droidPlugin.parseFile(ctx, missing, 7)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(7)
    expect(res.eof).toBe(true)
  })
})

describe('无 session_start 的文件', () => {
  it('project 字段缺省，记录其余字段正常产出', async () => {
    const file = path.join(tmpDir, 'abc.jsonl')
    fs.writeFileSync(file, assistantLine({ mid: 'm1' }), 'utf8')

    const res = await droidPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect('project' in res.records[0]).toBe(false)
    expect(res.records[0].inputTokens).toBe(100)
    expect(res.records[0].source.requestId).toBe('m1')
  })
})
