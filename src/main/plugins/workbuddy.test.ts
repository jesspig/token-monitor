import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { workbuddyPlugin } from './workbuddy'
import {
  detectFromRoot,
  foldByRequestId,
  listFilesFromRoot,
  parseJsonlFile
} from './_lib/tencent-buddy'
import type { PluginContext } from '../../../shared/context'
import type { UsageRecord } from '../../../shared/dto'

const ctx = {} as PluginContext

const TS1 = 1785124534951
const TS2 = 1785124536206

const assistantMessageWithUsage = (o: {
  messageId?: string
  traceId?: string
  model?: string
  timestamp?: number | string
  status?: string | null
  input?: number
  output?: number
  cacheRead?: number
  sessionId?: string
  cwd?: string
  withMessageUsage?: boolean
}): string =>
  JSON.stringify({
    id: 'assistant-row',
    timestamp: o.timestamp ?? TS1,
    type: 'message',
    role: 'assistant',
    ...(o.status === null ? {} : { status: o.status ?? 'completed' }),
    sessionId: o.sessionId ?? 'sess-1',
    cwd: o.cwd ?? 'C:\\tmp\\proj',
    providerData: {
      ...(o.messageId ? { messageId: o.messageId } : {}),
      ...(o.traceId ? { traceId: o.traceId } : {}),
      model: o.model ?? 'glm-5.2',
      requestModelId: o.model ?? 'glm-5.2'
    },
    ...(o.withMessageUsage === false
      ? {}
      : {
          message: {
            usage: {
              input_tokens: o.input ?? 24486,
              output_tokens: o.output ?? 120,
              total_tokens: (o.input ?? 24486) + (o.output ?? 120),
              cache_read_input_tokens: o.cacheRead ?? 14720
            }
          }
        })
  })

const functionCallLine = (o: {
  id?: string
  timestamp?: number | string
  sessionId?: string
  cwd?: string
  messageId?: string
  traceId?: string
  requestModelId?: string | null
  rawUsage?: Record<string, unknown> | null
  camelUsage?: Record<string, unknown>
} = {}): string =>
  JSON.stringify({
    id: o.id ?? 'call-1',
    timestamp: o.timestamp ?? TS2,
    type: 'function_call',
    sessionId: o.sessionId ?? 'sess-1',
    cwd: o.cwd ?? 'C:\\tmp\\proj',
    name: 'Bash',
    callId: 'call_x1',
    providerData: {
      ...(o.messageId ? { messageId: o.messageId } : {}),
      ...(o.traceId ? { traceId: o.traceId } : {}),
      ...(o.requestModelId !== null ? { requestModelId: o.requestModelId ?? 'glm-5.2' } : {}),
      ...(o.camelUsage ? { usage: o.camelUsage } : {}),
      ...(o.rawUsage !== null
        ? {
            rawUsage:
              o.rawUsage ?? {
                prompt_tokens: 35086,
                completion_tokens: 752,
                total_tokens: 35838,
                prompt_cache_hit_tokens: 15872,
                prompt_cache_miss_tokens: 19214,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
                prompt_cache_write_tokens: 0,
                completion_thinking_tokens: 488
              }
          }
        : {})
    }
  })

const userMessageLine = (): string =>
  JSON.stringify({
    id: 'user-1',
    timestamp: TS1 - 1000,
    type: 'message',
    role: 'user',
    sessionId: 'sess-1',
    cwd: 'C:\\tmp\\proj',
    providerData: { agent: 'cli' },
    message: {}
  })

const REAL_RAW_USAGE = {
  prompt_tokens: 35086,
  completion_tokens: 752,
  total_tokens: 35838,
  prompt_cache_hit_tokens: 15872,
  prompt_cache_miss_tokens: 19214,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  prompt_cache_write_tokens: 0,
  completion_thinking_tokens: 488,
  credit: 4.21
}

const DETECT_OPTIONS = {
  name: 'WorkBuddy',
  envKey: 'WORKBUDDY_DIR',
  tildeRoot: '~/.workbuddy/projects'
}

let tmpDir = ''
let envBackup: string | undefined

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-plugin-'))
  envBackup = process.env.WORKBUDDY_DIR
  delete process.env.WORKBUDDY_DIR
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  if (envBackup === undefined) delete process.env.WORKBUDDY_DIR
  else process.env.WORKBUDDY_DIR = envBackup
})

describe('workbuddyPlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(workbuddyPlugin.id).toBe('workbuddy')
    expect(workbuddyPlugin.name).toBe('WorkBuddy')
    expect(workbuddyPlugin.version).toBe('1.0.0')
    expect(workbuddyPlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('detect', () => {
  it('projects 目录缺失时不可用并返回中文原因与预期目录', () => {
    const root = path.join(tmpDir, '.workbuddy', 'projects')
    const res = detectFromRoot(root, DETECT_OPTIONS)
    expect(res.available).toBe(false)
    expect(res.reason).toContain('~/.workbuddy/projects')
    expect(res.reason).toContain('WORKBUDDY_DIR')
    expect(res.sessionDir).toBe(root)
  })

  it('目录存在但没有任何 jsonl 时不可用', () => {
    const root = path.join(tmpDir, 'projects')
    fs.mkdirSync(path.join(root, 'proj-a'), { recursive: true })
    fs.writeFileSync(path.join(root, 'proj-a', 'notes.txt'), 'x', 'utf8')
    const res = detectFromRoot(root, DETECT_OPTIONS)
    expect(res.available).toBe(false)
  })

  it('projects 目录存在且含 jsonl 时可用', () => {
    const root = path.join(tmpDir, 'projects')
    const proj = path.join(root, 'proj-a')
    fs.mkdirSync(proj, { recursive: true })
    fs.writeFileSync(path.join(proj, 'sess-1.jsonl'), userMessageLine(), 'utf8')
    const res = detectFromRoot(root, DETECT_OPTIONS)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(root)
  })
})

describe('listFilesFromRoot 收集范围', () => {
  it('收集项目目录直接子层与 subagents 子树的 jsonl，忽略 tool-results', () => {
    const root = path.join(tmpDir, 'projects')
    const proj = path.join(root, 'c-tmp-proj')
    const sub = path.join(proj, 'sess-1', 'subagents')
    const nested = path.join(sub, 'agent-393583e5', 'tool-results')
    fs.mkdirSync(nested, { recursive: true })
    fs.writeFileSync(path.join(proj, 'sess-1.jsonl'), userMessageLine())
    fs.writeFileSync(path.join(proj, 'sess-2.jsonl'), userMessageLine())
    fs.writeFileSync(path.join(sub, 'agent-202e48bb.jsonl'), userMessageLine())
    fs.writeFileSync(path.join(sub, 'agent-393583e5.jsonl'), userMessageLine())
    fs.writeFileSync(path.join(nested, 'call_01.txt'), 'ignore')

    const entries = listFilesFromRoot(root)
    expect(entries.map((e) => path.basename(e.path)).sort()).toEqual([
      'agent-202e48bb.jsonl',
      'agent-393583e5.jsonl',
      'sess-1.jsonl',
      'sess-2.jsonl'
    ])
    for (const e of entries) expect(e.mtime).toBeGreaterThan(0)
  })

  it('排除 .tmp/.swp/点前缀/~ 结尾与非 jsonl 文件', () => {
    const root = path.join(tmpDir, 'projects')
    const proj = path.join(root, 'proj')
    fs.mkdirSync(proj, { recursive: true })
    fs.writeFileSync(path.join(proj, 'keep.jsonl'), userMessageLine())
    fs.writeFileSync(path.join(proj, 'half.jsonl.tmp'), 'x')
    fs.writeFileSync(path.join(proj, 'swap.jsonl.swp'), 'x')
    fs.writeFileSync(path.join(proj, '.hidden.jsonl'), 'x')
    fs.writeFileSync(path.join(proj, 'backup.jsonl~'), 'x')
    fs.writeFileSync(path.join(proj, 'notes.txt'), 'x')

    const entries = listFilesFromRoot(root)
    expect(entries.map((e) => path.basename(e.path))).toEqual(['keep.jsonl'])
  })

  it('不收集 root 散落文件与会话子目录直接子层 jsonl（仅 subagents 子树）', () => {
    const root = path.join(tmpDir, 'projects')
    const sess = path.join(root, 'proj', 'sess-1')
    fs.mkdirSync(path.join(sess, 'subagents'), { recursive: true })
    fs.writeFileSync(path.join(root, 'loose.jsonl'), userMessageLine())
    fs.writeFileSync(path.join(sess, 'direct.jsonl'), userMessageLine())
    fs.writeFileSync(path.join(sess, 'subagents', 'agent-a.jsonl'), userMessageLine())

    const entries = listFilesFromRoot(root)
    expect(entries.map((e) => path.basename(e.path))).toEqual(['agent-a.jsonl'])
  })
})

describe('两种 usage 形态的字段映射', () => {
  it('形态1 message 行：input/output/cache_read 直取，cacheCreation=0，semantics=1', async () => {
    const file = path.join(tmpDir, 'sess-1.jsonl')
    fs.writeFileSync(
      file,
      [userMessageLine(), assistantMessageWithUsage({ messageId: 'mid-1' })].join('\n'),
      'utf8'
    )
    const res = await parseJsonlFile('workbuddy', file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({
      appType: 'workbuddy',
      model: 'glm-5.2',
      rawModel: 'glm-5.2',
      inputTokens: 24486,
      outputTokens: 120,
      cacheReadTokens: 14720,
      cacheCreationTokens: 0,
      inputSemantics: 1,
      status: 'success',
      project: 'C:\\tmp\\proj',
      sessionId: 'sess-1'
    })
    expect(res.records[0].createdAt).toBe(TS1)
    expect(res.records[0].source).toEqual({ filePath: file, line: 2, requestId: 'mid-1' })
  })

  it('形态2 function_call 行：prompt_tokens 原始总量入库，cacheRead 取 prompt_cache_hit_tokens', async () => {
    const file = path.join(tmpDir, 'sess-2.jsonl')
    fs.writeFileSync(file, functionCallLine({}), 'utf8')
    const res = await parseJsonlFile('workbuddy', file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({
      appType: 'workbuddy',
      model: 'glm-5.2',
      inputTokens: 35086,
      outputTokens: 752,
      cacheReadTokens: 15872,
      cacheCreationTokens: 0,
      inputSemantics: 1,
      status: 'success',
      sessionId: 'sess-1'
    })
    expect(res.records[0].createdAt).toBe(TS2)
  })

  it('形态2 cacheCreation 优先 cache_creation_input_tokens，为 0 时回退 prompt_cache_write_tokens', async () => {
    const file = path.join(tmpDir, 'sess-3.jsonl')
    fs.writeFileSync(
      file,
      [
        functionCallLine({ id: 'call-a', rawUsage: { ...REAL_RAW_USAGE, prompt_cache_write_tokens: 512 } }),
        functionCallLine({
          id: 'call-b',
          rawUsage: { ...REAL_RAW_USAGE, cache_creation_input_tokens: 900, prompt_cache_write_tokens: 512 }
        })
      ].join('\n'),
      'utf8'
    )
    const res = await parseJsonlFile('workbuddy', file, 0)
    expect(res.records.map((r) => r.cacheCreationTokens)).toEqual([512, 900])
  })

  it('camel 形态 providerData.usage：inputTokens/outputTokens 直取，无缓存字段时为 0', async () => {
    const file = path.join(tmpDir, 'sess-4.jsonl')
    fs.writeFileSync(
      file,
      functionCallLine({
        rawUsage: null,
        camelUsage: {
          requests: 1,
          inputTokens: 35086,
          outputTokens: 752,
          totalTokens: 35838,
          inputTokensDetails: [{ cached_tokens: 15872 }]
        }
      }),
      'utf8'
    )
    const res = await parseJsonlFile('workbuddy', file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({
      inputTokens: 35086,
      outputTokens: 752,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      model: 'glm-5.2'
    })
  })

  it('semantics=1 扣减口径：inputTokens 保留含缓存原始量，cacheRead 独立记录不并入', async () => {
    const file = path.join(tmpDir, 'sess-5.jsonl')
    fs.writeFileSync(file, assistantMessageWithUsage({ input: 24486, cacheRead: 14720, output: 120 }), 'utf8')
    const res = await parseJsonlFile('workbuddy', file, 0)
    const r = res.records[0]
    expect(r.inputTokens).toBe(24486)
    expect(r.cacheReadTokens).toBe(14720)
    expect(r.inputSemantics).toBe(1)
    expect(r.inputTokens - r.cacheReadTokens).toBe(9766)
  })

  it('model 提取：形态1 取 providerData.model，形态2 取 providerData.requestModelId', async () => {
    const file = path.join(tmpDir, 'sess-6.jsonl')
    fs.writeFileSync(
      file,
      [
        functionCallLine({ id: 'c1', requestModelId: 'glm-5.2', rawUsage: { prompt_tokens: 3, completion_tokens: 1 } }),
        assistantMessageWithUsage({ messageId: 'm1', model: 'deepseek-v4-pro' })
      ].join('\n'),
      'utf8'
    )
    const res = await parseJsonlFile('workbuddy', file, 0)
    expect(res.records.find((r) => r.source.requestId === 'c1')?.model).toBe('glm-5.2')
    expect(res.records.find((r) => r.source.requestId === 'm1')?.model).toBe('deepseek-v4-pro')
  })
})

describe('行级过滤', () => {
  it('无 model 行跳过', async () => {
    const file = path.join(tmpDir, 'a.jsonl')
    fs.writeFileSync(file, functionCallLine({ requestModelId: null }), 'utf8')
    const res = await parseJsonlFile('workbuddy', file, 0)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(2)
  })

  it('status 存在且非 completed 跳过；function_call 无 status 不受影响', async () => {
    const file = path.join(tmpDir, 'b.jsonl')
    fs.writeFileSync(
      file,
      [
        assistantMessageWithUsage({ messageId: 'm-inc', status: 'incomplete' }),
        functionCallLine({})
      ].join('\n'),
      'utf8'
    )
    const res = await parseJsonlFile('workbuddy', file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.requestId).toBe('call-1')
  })

  it('user/reasoning/file-history-snapshot 等其他行类型全部跳过', async () => {
    const file = path.join(tmpDir, 'c.jsonl')
    const reasoning = JSON.stringify({
      id: 'r1',
      timestamp: TS1,
      type: 'reasoning',
      sessionId: 'sess-1',
      cwd: 'C:\\tmp\\proj',
      providerData: { model: 'glm-5.2' },
      content: 'thinking'
    })
    const snapshot = JSON.stringify({
      id: 's1',
      timestamp: TS1,
      type: 'file-history-snapshot',
      cwd: 'C:\\tmp\\proj',
      snapshot: {}
    })
    fs.writeFileSync(file, [userMessageLine(), reasoning, snapshot].join('\n'), 'utf8')
    const res = await parseJsonlFile('workbuddy', file, 0)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(4)
  })

  it('无 usage 行跳过：assistant 无 message.usage 且 providerData 无 rawUsage/usage', async () => {
    const file = path.join(tmpDir, 'd.jsonl')
    fs.writeFileSync(
      file,
      [assistantMessageWithUsage({ messageId: 'm-empty', withMessageUsage: false }), assistantMessageWithUsage({ messageId: 'm-ok' })].join('\n'),
      'utf8'
    )
    const res = await parseJsonlFile('workbuddy', file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.requestId).toBe('m-ok')
    expect(res.records[0].source.line).toBe(2)
  })
})

describe('游标增量与容错', () => {
  it('从 0 全量解析后追加，增量只解析新行；游标口径与 claude 一致', async () => {
    const file = path.join(tmpDir, 'main.jsonl')
    fs.writeFileSync(
      file,
      [userMessageLine(), assistantMessageWithUsage({ messageId: 'mid-1' })].join('\n'),
      'utf8'
    )
    const res = await parseJsonlFile('workbuddy', file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.line).toBe(2)
    expect(res.nextLine).toBe(3)
    expect(res.eof).toBe(true)

    const r2 = await parseJsonlFile('workbuddy', file, res.nextLine)
    expect(r2.records).toHaveLength(0)

    fs.appendFileSync(file, `\n${functionCallLine({ id: 'call-9' })}`, 'utf8')
    const r3 = await parseJsonlFile('workbuddy', file, res.nextLine)
    expect(r3.records).toHaveLength(1)
    expect(r3.records[0].source.line).toBe(3)
    expect(r3.nextLine).toBe(4)
  })

  it('文件以换行结尾时 nextLine 不越界，append 后从游标续读能读到新行', async () => {
    const file = path.join(tmpDir, 'trailing-nl.jsonl')
    fs.writeFileSync(file, `${functionCallLine({ id: 'call-1' })}\n`, 'utf8')

    const res = await parseJsonlFile('workbuddy', file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.nextLine).toBe(2)
    expect(res.eof).toBe(true)

    fs.appendFileSync(file, functionCallLine({ id: 'call-2' }), 'utf8')
    const res2 = await parseJsonlFile('workbuddy', file, res.nextLine)
    expect(res2.records).toHaveLength(1)
    expect(res2.records[0].source).toEqual({ filePath: file, line: 2, requestId: 'call-2' })
    expect(res2.nextLine).toBe(3)
  })

  it('尾部半行不阻塞：游标停在该行等待补全，补全后续读产出', async () => {
    const file = path.join(tmpDir, 'half.jsonl')
    const trailingHalf =
      '{"id":"call-h","timestamp":1785124536206,"type":"function_call","providerData":{"requestModelId":"glm-5.2","rawUsage":{"prompt_tokens":'
    fs.writeFileSync(
      file,
      [assistantMessageWithUsage({ messageId: 'mid-1' }), trailingHalf].join('\n'),
      'utf8'
    )
    const res = await parseJsonlFile('workbuddy', file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.nextLine).toBe(2)
    expect(res.eof).toBe(true)

    fs.writeFileSync(
      file,
      [assistantMessageWithUsage({ messageId: 'mid-1' }), functionCallLine({ id: 'call-h' })].join('\n'),
      'utf8'
    )
    const res2 = await parseJsonlFile('workbuddy', file, res.nextLine)
    expect(res2.records).toHaveLength(1)
    expect(res2.records[0].source.line).toBe(2)
    expect(res2.nextLine).toBe(3)
  })

  it('中间损坏行跳过不抛错，后续行正常产出', async () => {
    const file = path.join(tmpDir, 'broken.jsonl')
    fs.writeFileSync(
      file,
      [
        assistantMessageWithUsage({ messageId: 'mid-1' }),
        '{this is broken json',
        functionCallLine({ id: 'call-2' })
      ].join('\n'),
      'utf8'
    )
    const res = await parseJsonlFile('workbuddy', file, 0)
    expect(res.records).toHaveLength(2)
    expect(res.records.map((r) => r.source.line)).toEqual([1, 3])
    expect(res.nextLine).toBe(4)
    expect(res.eof).toBe(true)
  })

  it('空文件与 fromLine 越过 EOF：无记录、游标不倒退', async () => {
    const empty = path.join(tmpDir, 'empty.jsonl')
    fs.writeFileSync(empty, '', 'utf8')
    const r1 = await parseJsonlFile('workbuddy', empty, 0)
    expect(r1.records).toHaveLength(0)
    expect(r1.eof).toBe(true)

    const one = path.join(tmpDir, 'one.jsonl')
    fs.writeFileSync(one, userMessageLine(), 'utf8')
    const r2 = await parseJsonlFile('workbuddy', one, 99)
    expect(r2.records).toHaveLength(0)
    expect(r2.nextLine).toBe(99)
    expect(r2.eof).toBe(true)
  })

  it('文件读取失败时返回空结果且游标保持', async () => {
    const missing = path.join(tmpDir, 'missing.jsonl')
    const res = await parseJsonlFile('workbuddy', missing, 7)
    expect(res).toEqual({ records: [], nextLine: 7, eof: true })
  })
})

describe('requestId 与折叠', () => {
  it('requestId 优先 providerData.messageId，回退 traceId，再回退行 id', async () => {
    const file = path.join(tmpDir, 'rid.jsonl')
    fs.writeFileSync(
      file,
      [
        functionCallLine({ id: 'row-id-1', messageId: 'mid-a' }),
        functionCallLine({ id: 'row-id-2', traceId: 'tr-b' }),
        functionCallLine({ id: 'row-id-3' }),
        assistantMessageWithUsage({ messageId: 'mid-c' })
      ].join('\n'),
      'utf8'
    )
    const res = await parseJsonlFile('workbuddy', file, 0)
    expect(res.records.map((r) => r.source.requestId)).toEqual(['mid-a', 'tr-b', 'row-id-3', 'mid-c'])
  })

  it('同 requestId 折叠：total 大者胜（GLM 汇总行与 function_call 行防双计）', async () => {
    const file = path.join(tmpDir, 'fold.jsonl')
    fs.writeFileSync(
      file,
      [
        assistantMessageWithUsage({ messageId: 'shared', input: 156550, output: 577, cacheRead: 155968 }),
        functionCallLine({ messageId: 'shared' })
      ].join('\n'),
      'utf8'
    )
    const res = await parseJsonlFile('workbuddy', file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].inputTokens).toBe(156550)
    expect(res.records[0].source.line).toBe(1)
  })

  it('同 requestId total 相等时后到覆盖（行号与时间戳随最新行）', () => {
    const rec = (line: number, total: number): UsageRecord => ({
      appType: 'workbuddy',
      model: 'glm-5.2',
      rawModel: 'glm-5.2',
      inputTokens: total,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      inputSemantics: 1,
      status: 'success',
      createdAt: line * 1000,
      source: { filePath: 'f.jsonl', line, requestId: 'same' }
    })
    const folded = foldByRequestId([rec(1, 100), rec(2, 100)])
    expect(folded).toHaveLength(1)
    expect(folded[0].source.line).toBe(2)
    expect(folded[0].createdAt).toBe(2000)
  })

  it('无 requestId 记录不折叠；不同 requestId 独立', () => {
    const rec = (line: number, rid?: string): UsageRecord => ({
      appType: 'workbuddy',
      model: 'glm-5.2',
      rawModel: 'glm-5.2',
      inputTokens: 10 + line,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      inputSemantics: 1,
      status: 'success',
      createdAt: line * 1000,
      source: { filePath: 'f.jsonl', line, ...(rid ? { requestId: rid } : {}) }
    })
    const folded = foldByRequestId([rec(1), rec(2), rec(3, 'a'), rec(4, 'a')])
    expect(folded.map((r) => r.source.line)).toEqual([1, 2, 4])
  })

  it('同一行重复解析产生同一 requestId', async () => {
    const file = path.join(tmpDir, 'stable.jsonl')
    fs.writeFileSync(file, functionCallLine({ id: 'call-s', messageId: 'mid-s' }), 'utf8')
    const a = await parseJsonlFile('workbuddy', file, 0)
    const b = await parseJsonlFile('workbuddy', file, 0)
    expect(a.records[0].source.requestId).toBe('mid-s')
    expect(b.records[0].source).toEqual(a.records[0].source)
  })
})

describe('时间戳', () => {
  it('行级 timestamp（毫秒数字）直接作为 createdAt', async () => {
    const file = path.join(tmpDir, 'ts.jsonl')
    fs.writeFileSync(file, functionCallLine({ id: 'c1', timestamp: 1785124567394 }), 'utf8')
    const res = await parseJsonlFile('workbuddy', file, 0)
    expect(res.records[0].createdAt).toBe(1785124567394)
  })

  it('timestamp 非数字时兜底为文件 mtime', async () => {
    const file = path.join(tmpDir, 'ts-fallback.jsonl')
    fs.writeFileSync(file, functionCallLine({ id: 'c1', timestamp: 'not-a-number' }), 'utf8')
    const expected = 1780000000000
    fs.utimesSync(file, new Date(expected), new Date(expected))
    const res = await parseJsonlFile('workbuddy', file, 0)
    expect(res.records[0].createdAt).toBe(expected)
  })
})

describe('环境变量覆盖', () => {
  it('WORKBUDDY_DIR 覆盖默认根目录', async () => {
    const root = path.join(tmpDir, 'custom-root')
    const proj = path.join(root, 'proj')
    fs.mkdirSync(proj, { recursive: true })
    fs.writeFileSync(path.join(proj, 'sess-1.jsonl'), userMessageLine(), 'utf8')

    process.env.WORKBUDDY_DIR = root
    const files = await workbuddyPlugin.listFiles(ctx)
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe(path.join(proj, 'sess-1.jsonl'))

    const det = await workbuddyPlugin.detect(ctx)
    expect(det.available).toBe(true)
    expect(det.sessionDir).toBe(root)
  })
})
