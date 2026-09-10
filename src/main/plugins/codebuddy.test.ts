import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { codebuddyPlugin } from './codebuddy'
import { workbuddyPlugin } from './workbuddy'
import { detectFromRoot, listFilesFromRoot, parseJsonlFile } from './_lib/tencent-buddy'
import type { PluginContext } from '../../../shared/context'
import type { UsageRecord } from '../../../shared/dto'

const ctx = {} as PluginContext

const TS1 = 1785124534951
const TS2 = 1785124536206

const assistantMessageWithUsage = (o: {
  messageId?: string
  model?: string
  timestamp?: number
  status?: string
  input?: number
  output?: number
  cacheRead?: number
  sessionId?: string
  cwd?: string
}): string =>
  JSON.stringify({
    id: 'assistant-row',
    timestamp: o.timestamp ?? TS1,
    type: 'message',
    role: 'assistant',
    status: o.status ?? 'completed',
    sessionId: o.sessionId ?? 'sess-1',
    cwd: o.cwd ?? 'D:\\work\\repo',
    providerData: {
      ...(o.messageId ? { messageId: o.messageId } : {}),
      model: o.model ?? 'glm-5.2',
      requestModelId: o.model ?? 'glm-5.2'
    },
    message: {
      usage: {
        input_tokens: o.input ?? 24486,
        output_tokens: o.output ?? 120,
        total_tokens: (o.input ?? 24486) + (o.output ?? 120),
        cache_read_input_tokens: o.cacheRead ?? 14720
      }
    }
  })

const functionCallLine = (o: {
  id?: string
  timestamp?: number
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
    cwd: o.cwd ?? 'D:\\work\\repo',
    name: 'Read',
    callId: 'call_y1',
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

const REAL_RAW_USAGE = {
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

const DETECT_OPTIONS = {
  name: 'CodeBuddy',
  envKey: 'CODEBUDDY_DIR',
  tildeRoot: '~/.codebuddy/projects'
}

let tmpDir = ''
let envBackup: string | undefined

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-plugin-'))
  envBackup = process.env.CODEBUDDY_DIR
  delete process.env.CODEBUDDY_DIR
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  if (envBackup === undefined) delete process.env.CODEBUDDY_DIR
  else process.env.CODEBUDDY_DIR = envBackup
})

describe('codebuddyPlugin 元数据与复用', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(codebuddyPlugin.id).toBe('codebuddy')
    expect(codebuddyPlugin.name).toBe('CodeBuddy')
    expect(codebuddyPlugin.version).toBe('1.0.0')
    expect(codebuddyPlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })

  it('壳复用共享解析模块：parseFile 结果与 parseJsonlFile("codebuddy") 一致', async () => {
    const file = path.join(tmpDir, 'sess-x.jsonl')
    fs.writeFileSync(
      file,
      [assistantMessageWithUsage({ messageId: 'mid-1' }), functionCallLine({ id: 'call-2' })].join('\n'),
      'utf8'
    )
    const viaShell = await codebuddyPlugin.parseFile(ctx, file, 0)
    const viaLib = await parseJsonlFile('codebuddy', file, 0)
    expect(viaShell).toEqual(viaLib)
    expect(viaShell.records).toHaveLength(2)
    expect(viaShell.nextLine).toBe(3)
  })

  it('所有记录 appType 归属为 codebuddy', async () => {
    const file = path.join(tmpDir, 'sess-a.jsonl')
    fs.writeFileSync(
      file,
      [assistantMessageWithUsage({ messageId: 'mid-1' }), functionCallLine({ id: 'call-2' })].join('\n'),
      'utf8'
    )
    const res = await codebuddyPlugin.parseFile(ctx, file, 0)
    expect(res.records.map((r) => r.appType)).toEqual(['codebuddy', 'codebuddy'])
  })

  it('与 workbuddy 同内核：同内容仅 appType 不同，其余字段映射一致', async () => {
    const file = path.join(tmpDir, 'shared.jsonl')
    fs.writeFileSync(file, functionCallLine({ id: 'call-shared' }), 'utf8')
    const fromCodebuddy = await codebuddyPlugin.parseFile(ctx, file, 0)
    const fromWorkbuddy = await workbuddyPlugin.parseFile(ctx, file, 0)
    expect(fromCodebuddy.records).toHaveLength(1)
    expect(fromWorkbuddy.records).toHaveLength(1)
    const cb = fromCodebuddy.records[0]
    const wb = fromWorkbuddy.records[0]
    expect(cb.appType).toBe('codebuddy')
    expect(wb.appType).toBe('workbuddy')
    const cbRest = { ...cb } as Record<string, unknown>
    const wbRest = { ...wb } as Record<string, unknown>
    delete cbRest.appType
    delete wbRest.appType
    expect(cbRest).toEqual(wbRest)
  })
})

describe('detect', () => {
  it('projects 目录缺失时不可用并返回中文原因', () => {
    const root = path.join(tmpDir, '.codebuddy', 'projects')
    const res = detectFromRoot(root, DETECT_OPTIONS)
    expect(res.available).toBe(false)
    expect(res.reason).toContain('~/.codebuddy/projects')
    expect(res.reason).toContain('CODEBUDDY_DIR')
    expect(res.sessionDir).toBe(root)
  })

  it('目录存在但无 jsonl 时不可用', () => {
    const root = path.join(tmpDir, 'projects')
    fs.mkdirSync(root, { recursive: true })
    const res = detectFromRoot(root, DETECT_OPTIONS)
    expect(res.available).toBe(false)
  })

  it('projects 目录存在且含 jsonl 时可用', () => {
    const root = path.join(tmpDir, 'projects')
    const proj = path.join(root, 'd-work-repo')
    fs.mkdirSync(proj, { recursive: true })
    fs.writeFileSync(path.join(proj, 'sess-1.jsonl'), functionCallLine(), 'utf8')
    const res = detectFromRoot(root, DETECT_OPTIONS)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(root)
  })

  it('根目录缺失（仅 code-ratio watcher 数据的典型本机形态）时不可用', async () => {
    const home = path.join(tmpDir, 'home')
    fs.mkdirSync(path.join(home, 'code-ratio'), { recursive: true })
    fs.writeFileSync(path.join(home, 'code-ratio', 'ratio.json'), '{}', 'utf8')

    process.env.CODEBUDDY_DIR = path.join(home, 'projects')
    const res = await codebuddyPlugin.detect(ctx)
    expect(res.available).toBe(false)
    expect(res.sessionDir).toBe(path.join(home, 'projects'))

    const files = await codebuddyPlugin.listFiles(ctx)
    expect(files).toHaveLength(0)
  })
})

describe('listFilesFromRoot 收集范围', () => {
  it('收集 projects/<key>/<sessionId>.jsonl 直接子层', () => {
    const root = path.join(tmpDir, 'projects')
    const proj = path.join(root, 'd-work-repo')
    fs.mkdirSync(proj, { recursive: true })
    fs.writeFileSync(path.join(proj, 'sess-1.jsonl'), functionCallLine())
    fs.writeFileSync(path.join(proj, 'sess-2.jsonl'), functionCallLine())
    fs.writeFileSync(path.join(proj, 'readme.md'), 'x')

    const entries = listFilesFromRoot(root)
    expect(entries.map((e) => path.basename(e.path)).sort()).toEqual(['sess-1.jsonl', 'sess-2.jsonl'])
    for (const e of entries) expect(e.mtime).toBeGreaterThan(0)
  })

  it('排除 .tmp/.swp/点前缀/~ 结尾临时文件', () => {
    const root = path.join(tmpDir, 'projects')
    const proj = path.join(root, 'proj')
    fs.mkdirSync(proj, { recursive: true })
    fs.writeFileSync(path.join(proj, 'keep.jsonl'), functionCallLine())
    fs.writeFileSync(path.join(proj, 'x.jsonl.tmp'), 'x')
    fs.writeFileSync(path.join(proj, 'y.jsonl.swp'), 'x')
    fs.writeFileSync(path.join(proj, '.z.jsonl'), 'x')
    fs.writeFileSync(path.join(proj, 'w.jsonl~'), 'x')

    const entries = listFilesFromRoot(root)
    expect(entries.map((e) => path.basename(e.path))).toEqual(['keep.jsonl'])
  })

  it('含 subagents 子目录时递归收集其子树（与 workbuddy 同构）', () => {
    const root = path.join(tmpDir, 'projects')
    const sub = path.join(root, 'proj', 'sess-1', 'subagents')
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(path.join(root, 'proj', 'sess-1.jsonl'), functionCallLine())
    fs.writeFileSync(path.join(sub, 'agent-1.jsonl'), functionCallLine())

    const entries = listFilesFromRoot(root)
    expect(entries.map((e) => path.basename(e.path)).sort()).toEqual(['agent-1.jsonl', 'sess-1.jsonl'])
  })
})

describe('两种 usage 形态的字段映射（同内核，重点回归）', () => {
  it('形态1 message 行完整映射', async () => {
    const file = path.join(tmpDir, 'f1.jsonl')
    fs.writeFileSync(file, assistantMessageWithUsage({ messageId: 'mid-1' }), 'utf8')
    const res = await codebuddyPlugin.parseFile(ctx, file, 0)
    expect(res.records[0]).toMatchObject({
      appType: 'codebuddy',
      model: 'glm-5.2',
      inputTokens: 24486,
      outputTokens: 120,
      cacheReadTokens: 14720,
      cacheCreationTokens: 0,
      inputSemantics: 1,
      status: 'success',
      project: 'D:\\work\\repo',
      sessionId: 'sess-1'
    })
    expect(res.records[0].createdAt).toBe(TS1)
  })

  it('形态2 function_call 行完整映射：prompt_tokens 含缓存原始量', async () => {
    const file = path.join(tmpDir, 'f2.jsonl')
    fs.writeFileSync(file, functionCallLine({}), 'utf8')
    const res = await codebuddyPlugin.parseFile(ctx, file, 0)
    expect(res.records[0]).toMatchObject({
      appType: 'codebuddy',
      model: 'glm-5.2',
      inputTokens: 35086,
      outputTokens: 752,
      cacheReadTokens: 15872,
      cacheCreationTokens: 0,
      inputSemantics: 1
    })
    expect(res.records[0].createdAt).toBe(TS2)
  })

  it('cacheCreation 回退 prompt_cache_write_tokens', async () => {
    const file = path.join(tmpDir, 'f3.jsonl')
    fs.writeFileSync(
      file,
      functionCallLine({ id: 'call-w', rawUsage: { ...REAL_RAW_USAGE, prompt_cache_write_tokens: 512 } }),
      'utf8'
    )
    const res = await codebuddyPlugin.parseFile(ctx, file, 0)
    expect(res.records[0].cacheCreationTokens).toBe(512)
  })

  it('camel 形态 providerData.usage 映射', async () => {
    const file = path.join(tmpDir, 'f4.jsonl')
    fs.writeFileSync(
      file,
      functionCallLine({
        rawUsage: null,
        camelUsage: { requests: 1, inputTokens: 35086, outputTokens: 752, totalTokens: 35838 }
      }),
      'utf8'
    )
    const res = await codebuddyPlugin.parseFile(ctx, file, 0)
    expect(res.records[0]).toMatchObject({ inputTokens: 35086, outputTokens: 752, cacheReadTokens: 0 })
  })

  it('cacheRead 独立记录：inputTokens 不扣减（扣减由 calcCost 层做）', async () => {
    const file = path.join(tmpDir, 'f5.jsonl')
    fs.writeFileSync(file, assistantMessageWithUsage({ input: 113415, cacheRead: 112224, output: 990 }), 'utf8')
    const res = await codebuddyPlugin.parseFile(ctx, file, 0)
    const r = res.records[0]
    expect(r.inputTokens).toBe(113415)
    expect(r.cacheReadTokens).toBe(112224)
    expect(r.inputSemantics).toBe(1)
  })
})

describe('行级过滤与容错', () => {
  it('无 model 行跳过', async () => {
    const file = path.join(tmpDir, 'g1.jsonl')
    fs.writeFileSync(file, functionCallLine({ requestModelId: null }), 'utf8')
    const res = await codebuddyPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(2)
  })

  it('status 非 completed 跳过', async () => {
    const file = path.join(tmpDir, 'g2.jsonl')
    fs.writeFileSync(
      file,
      [assistantMessageWithUsage({ messageId: 'm-bad', status: 'incomplete' }), functionCallLine()].join('\n'),
      'utf8'
    )
    const res = await codebuddyPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.requestId).toBe('call-1')
  })

  it('中间损坏行跳过不抛错', async () => {
    const file = path.join(tmpDir, 'g3.jsonl')
    fs.writeFileSync(
      file,
      [assistantMessageWithUsage({ messageId: 'mid-1' }), 'not-json{{{', functionCallLine({ id: 'call-2' })].join('\n'),
      'utf8'
    )
    const res = await codebuddyPlugin.parseFile(ctx, file, 0)
    expect(res.records.map((r) => r.source.line)).toEqual([1, 3])
    expect(res.nextLine).toBe(4)
  })

  it('尾部半行游标停在该行，补全后续读产出', async () => {
    const file = path.join(tmpDir, 'g4.jsonl')
    const half = '{"id":"call-h","timestamp":1785124536206,"type":"function_call","providerData":{"request'
    fs.writeFileSync(file, [assistantMessageWithUsage({ messageId: 'mid-1' }), half].join('\n'), 'utf8')
    const res = await codebuddyPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.nextLine).toBe(2)
    expect(res.eof).toBe(true)

    fs.writeFileSync(
      file,
      [assistantMessageWithUsage({ messageId: 'mid-1' }), functionCallLine({ id: 'call-h' })].join('\n'),
      'utf8'
    )
    const res2 = await codebuddyPlugin.parseFile(ctx, file, res.nextLine)
    expect(res2.records).toHaveLength(1)
    expect(res2.records[0].source.line).toBe(2)
  })

  it('游标增量：追加后只解析新行', async () => {
    const file = path.join(tmpDir, 'g5.jsonl')
    fs.writeFileSync(file, assistantMessageWithUsage({ messageId: 'mid-1' }), 'utf8')
    const res = await codebuddyPlugin.parseFile(ctx, file, 0)
    expect(res.nextLine).toBe(2)

    fs.appendFileSync(file, `\n${functionCallLine({ id: 'call-9' })}`, 'utf8')
    const res2 = await codebuddyPlugin.parseFile(ctx, file, res.nextLine)
    expect(res2.records).toHaveLength(1)
    expect(res2.records[0].source.line).toBe(2)
    expect(res2.nextLine).toBe(3)
  })

  it('空文件与 fromLine 越界', async () => {
    const empty = path.join(tmpDir, 'g6.jsonl')
    fs.writeFileSync(empty, '', 'utf8')
    const r1 = await codebuddyPlugin.parseFile(ctx, empty, 0)
    expect(r1.records).toHaveLength(0)
    expect(r1.eof).toBe(true)

    const one = path.join(tmpDir, 'g7.jsonl')
    fs.writeFileSync(one, functionCallLine(), 'utf8')
    const r2 = await codebuddyPlugin.parseFile(ctx, one, 50)
    expect(r2.records).toHaveLength(0)
    expect(r2.nextLine).toBe(50)
  })
})

describe('requestId、折叠与时间戳', () => {
  it('requestId 回退链：messageId → traceId → 行 id', async () => {
    const file = path.join(tmpDir, 'h1.jsonl')
    fs.writeFileSync(
      file,
      [
        functionCallLine({ id: 'row-1', messageId: 'mid-a' }),
        functionCallLine({ id: 'row-2', traceId: 'tr-b' }),
        functionCallLine({ id: 'row-3' })
      ].join('\n'),
      'utf8'
    )
    const res = await codebuddyPlugin.parseFile(ctx, file, 0)
    expect(res.records.map((r) => r.source.requestId)).toEqual(['mid-a', 'tr-b', 'row-3'])
  })

  it('同 requestId 折叠取 total 大者', async () => {
    const file = path.join(tmpDir, 'h2.jsonl')
    fs.writeFileSync(
      file,
      [assistantMessageWithUsage({ messageId: 'shared', input: 156550, output: 577 }), functionCallLine({ messageId: 'shared' })].join('\n'),
      'utf8'
    )
    const res = await codebuddyPlugin.parseFile(ctx, file, 0)
    expect(res.records).toHaveLength(1)
    expect(res.records[0].inputTokens).toBe(156550)
  })

  it('timestamp 非法时兜底文件 mtime；合法时直用', async () => {
    const file = path.join(tmpDir, 'h3.jsonl')
    fs.writeFileSync(
      file,
      [
        functionCallLine({ id: 'c1', timestamp: 1785124567394 }),
        functionCallLine({ id: 'c2', timestamp: 'bad' as unknown as number })
      ].join('\n'),
      'utf8'
    )
    const expected = 1780000000000
    fs.utimesSync(file, new Date(expected), new Date(expected))
    const res = await codebuddyPlugin.parseFile(ctx, file, 0)
    expect(res.records[0].createdAt).toBe(1785124567394)
    expect(res.records[1].createdAt).toBe(expected)
  })
})

describe('环境变量覆盖', () => {
  it('CODEBUDDY_DIR 覆盖默认根目录', async () => {
    const root = path.join(tmpDir, 'custom')
    const proj = path.join(root, 'proj')
    fs.mkdirSync(proj, { recursive: true })
    fs.writeFileSync(path.join(proj, 's.jsonl'), functionCallLine(), 'utf8')

    process.env.CODEBUDDY_DIR = root
    const files = await codebuddyPlugin.listFiles(ctx)
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe(path.join(proj, 's.jsonl'))

    const det = await codebuddyPlugin.detect(ctx)
    expect(det.available).toBe(true)

    const records: UsageRecord[] = (await codebuddyPlugin.parseFile(ctx, path.join(proj, 's.jsonl'), 0)).records
    expect(records[0].appType).toBe('codebuddy')
  })
})
