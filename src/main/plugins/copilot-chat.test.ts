import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { copilotChatPlugin, detectFromRoots, listFilesFromRoots, parseChatJsonl } from './copilot-chat'
import type { PluginContext } from '../../../shared/context'

const ctx = {} as PluginContext

const TS_A = 1786350472455
const TS_B = 1786350525631

function headerLine(sessionId = 'sess-1', requests: unknown[] = []): string {
  return JSON.stringify({ kind: 0, v: { version: 3, sessionId, requests } })
}

function request(o: {
  requestId?: string
  modelId?: string
  timestamp?: number
  responseTimestamp?: number
  elapsedMs?: number
  promptTokens?: number
  completionTokens?: number
} = {}): Record<string, unknown> {
  return {
    ...(o.requestId !== undefined ? { requestId: o.requestId } : {}),
    ...(o.modelId !== undefined ? { modelId: o.modelId } : {}),
    ...(o.timestamp !== undefined ? { timestamp: o.timestamp } : {}),
    ...(o.responseTimestamp !== undefined ? { responseTimestamp: o.responseTimestamp } : {}),
    ...(o.elapsedMs !== undefined ? { elapsedMs: o.elapsedMs } : {}),
    ...(o.promptTokens !== undefined ? { promptTokens: o.promptTokens } : {}),
    ...(o.completionTokens !== undefined ? { completionTokens: o.completionTokens } : {}),
    message: { role: 'user', text: 'hi' },
    response: [{ type: 1, text: 'answer' }]
  }
}

function appendLine(entries: unknown[]): string {
  return JSON.stringify({ kind: 2, k: ['requests'], v: entries })
}

function patchLine(idx: number | string, field: string, value: number): string {
  return JSON.stringify({ kind: 1, k: ['requests', idx, field], v: value })
}

function shallowPatchLine(): string {
  return JSON.stringify({ kind: 1, k: ['customTitle'], v: '标题' })
}

function responseAppendLine(): string {
  return JSON.stringify({ kind: 2, k: ['requests', 0, 'response'], v: [{ value: 'chunk' }] })
}

let tmpDir = ''
let globalDir = ''
let wsRoot = ''

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-chat-plugin-'))
  globalDir = path.join(tmpDir, 'Code', 'User', 'globalStorage', 'emptyWindowChatSessions')
  wsRoot = path.join(tmpDir, 'Code', 'User', 'workspaceStorage')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeGlobal(name: string, lines: string[]): string {
  fs.mkdirSync(globalDir, { recursive: true })
  const p = path.join(globalDir, name)
  fs.writeFileSync(p, lines.join('\n'), 'utf8')
  return p
}

function writeWs(hash: string, name: string, lines: string[]): string {
  const dir = path.join(wsRoot, hash, 'chatSessions')
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, name)
  fs.writeFileSync(p, lines.join('\n'), 'utf8')
  return p
}

describe('copilotChatPlugin 元数据', () => {
  it('id/name/version/deps 对齐契约', () => {
    expect(copilotChatPlugin.id).toBe('copilot-chat')
    expect(copilotChatPlugin.name).toBe('VS Code Copilot Chat')
    expect(copilotChatPlugin.version).toBe('1.0.0')
    expect(copilotChatPlugin.deps).toEqual(['storage', 'pricing', 'events'])
  })
})

describe('detect', () => {
  it('两位置均无会话文件时不可用并给出中文原因与预期目录', () => {
    const res = detectFromRoots(globalDir, wsRoot)
    expect(res.available).toBe(false)
    expect(res.reason).toContain('Copilot Chat')
    expect(res.sessionDir).toBe(globalDir)
  })

  it('目录存在但均为空时仍不可用', () => {
    fs.mkdirSync(globalDir, { recursive: true })
    fs.mkdirSync(path.join(wsRoot, 'hash1', 'chatSessions'), { recursive: true })
    const res = detectFromRoots(globalDir, wsRoot)
    expect(res.available).toBe(false)
    expect(res.reason).toBeTruthy()
  })

  it('仅 globalStorage 存在会话文件时可用', () => {
    writeGlobal('a.jsonl', [headerLine()])
    const res = detectFromRoots(globalDir, wsRoot)
    expect(res.available).toBe(true)
    expect(res.sessionDir).toBe(globalDir)
  })

  it('仅 workspaceStorage 存在会话文件时可用', () => {
    writeWs('hash1', 'b.jsonl', [headerLine()])
    const res = detectFromRoots(globalDir, wsRoot)
    expect(res.available).toBe(true)
  })
})

describe('listFilesFromRoots 双位置枚举', () => {
  it('枚举 globalStorage 与多个 workspaceStorage hash 的 jsonl，过滤临时文件并按路径排序', () => {
    writeGlobal('a.jsonl', [headerLine()])
    writeGlobal('b.jsonl.tmp', [headerLine()])
    writeGlobal('.hidden.jsonl', [headerLine()])
    writeGlobal('c.jsonl~', [headerLine()])
    writeWs('hash-1', 'w1.jsonl', [headerLine()])
    writeWs('hash-2', 'w2.jsonl', [headerLine()])
    fs.mkdirSync(path.join(wsRoot, 'hash-3'), { recursive: true })
    fs.writeFileSync(path.join(wsRoot, 'loose.jsonl'), headerLine(), 'utf8')

    const entries = listFilesFromRoots(globalDir, wsRoot)
    const names = entries.map((e) => path.basename(e.path))
    expect(names).toEqual(['a.jsonl', 'w1.jsonl', 'w2.jsonl'])
    expect(entries.every((e) => e.mtime > 0)).toBe(true)
  })
})

describe('parseChatJsonl patch 流解析', () => {
  it('header+追加流：提取 usage 条目，model 原样保留、四桶映射、semantics=2、requestId/sessionId/latencyMs 齐全', () => {
    const file = writeGlobal('a.jsonl', [
      headerLine('sess-xyz'),
      shallowPatchLine(),
      appendLine([
        request({
          requestId: 'request_2270c01a',
          modelId: 'copilot/claude-haiku-4.5',
          timestamp: TS_A,
          responseTimestamp: TS_B,
          elapsedMs: 30780,
          promptTokens: 8450,
          completionTokens: 2555
        })
      ])
    ])
    const res = parseChatJsonl(file, fs.readFileSync(file, 'utf8'))
    expect(res.records).toHaveLength(1)
    expect(res.eof).toBe(true)
    const r = res.records[0]
    expect(r).toMatchObject({
      appType: 'copilot-chat',
      model: 'copilot/claude-haiku-4.5',
      rawModel: 'copilot/claude-haiku-4.5',
      inputTokens: 8450,
      outputTokens: 2555,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      inputSemantics: 2,
      status: 'success',
      latencyMs: 30780,
      sessionId: 'sess-xyz'
    })
    expect(r.createdAt).toBe(TS_B)
    expect(r.source).toEqual({ filePath: file, line: 3, requestId: 'request_2270c01a' })
  })

  it('header 携带非空 requests 时作为初始条目解析', () => {
    const file = writeGlobal('b.jsonl', [
      headerLine('sess-hdr', [
        request({ requestId: 'request_hdr1', modelId: 'copilot/auto', timestamp: TS_A, promptTokens: 100, completionTokens: 10 })
      ])
    ])
    const res = parseChatJsonl(file, fs.readFileSync(file, 'utf8'))
    expect(res.records).toHaveLength(1)
    expect(res.records[0]).toMatchObject({
      model: 'copilot/auto',
      inputTokens: 100,
      outputTokens: 10,
      sessionId: 'sess-hdr'
    })
    expect(res.records[0].source.line).toBe(1)
  })

  it('无 usage 的追加条目跳过（空会话）', () => {
    const file = writeGlobal('c.jsonl', [
      headerLine(),
      appendLine([request({ requestId: 'request_empty', modelId: 'copilot/auto', timestamp: TS_A })]),
      appendLine([
        request({ requestId: 'request_used', modelId: 'copilot/auto', timestamp: TS_B, promptTokens: 50, completionTokens: 5 })
      ])
    ])
    const res = parseChatJsonl(file, fs.readFileSync(file, 'utf8'))
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.requestId).toBe('request_used')
    expect(res.records[0].source.line).toBe(3)
  })

  it('深路径 patch（数字索引）更新 usage：终值胜出且 line 取 patch 行', () => {
    const file = writeGlobal('d.jsonl', [
      headerLine(),
      appendLine([request({ requestId: 'request_p1', modelId: 'copilot/auto', timestamp: TS_A, promptTokens: 27874, completionTokens: 861 })]),
      patchLine(0, 'promptTokens', 28744),
      patchLine(0, 'completionTokens', 900)
    ])
    const res = parseChatJsonl(file, fs.readFileSync(file, 'utf8'))
    expect(res.records).toHaveLength(1)
    const r = res.records[0]
    expect(r.inputTokens).toBe(28744)
    expect(r.outputTokens).toBe(900)
    expect(r.source.line).toBe(4)
    expect(r.source.requestId).toBe('request_p1')
  })

  it('同一请求多次 patch 演进时取最后一次写入值', () => {
    const file = writeGlobal('e.jsonl', [
      headerLine(),
      appendLine([request({ requestId: 'request_p2', modelId: 'copilot/auto', timestamp: TS_A, promptTokens: 100 })]),
      patchLine(0, 'promptTokens', 200),
      patchLine(0, 'promptTokens', 42880)
    ])
    const res = parseChatJsonl(file, fs.readFileSync(file, 'utf8'))
    expect(res.records[0].inputTokens).toBe(42880)
    expect(res.records[0].source.line).toBe(4)
  })

  it('字符串形式索引的深路径 patch 兼容', () => {
    const file = writeGlobal('f.jsonl', [
      headerLine(),
      appendLine([request({ requestId: 'request_p3', modelId: 'copilot/auto', timestamp: TS_A, promptTokens: 10 })]),
      patchLine('0', 'promptTokens', 20)
    ])
    const res = parseChatJsonl(file, fs.readFileSync(file, 'utf8'))
    expect(res.records[0].inputTokens).toBe(20)
  })

  it('kind=2 深路径（response 内容块追加）不产出记录', () => {
    const file = writeGlobal('g.jsonl', [
      headerLine(),
      appendLine([request({ requestId: 'request_r1', modelId: 'copilot/auto', timestamp: TS_A, promptTokens: 10, completionTokens: 2 })]),
      responseAppendLine()
    ])
    const res = parseChatJsonl(file, fs.readFileSync(file, 'utf8'))
    expect(res.records).toHaveLength(1)
    expect(res.records[0].outputTokens).toBe(2)
  })

  it('浅路径 kind=1 patch（customTitle/inputState）不影响解析', () => {
    const file = writeGlobal('h.jsonl', [
      headerLine(),
      JSON.stringify({ kind: 1, k: ['inputState', 'inputText'], v: '问题' }),
      appendLine([request({ requestId: 'request_s1', modelId: 'copilot/auto', timestamp: TS_A, promptTokens: 10, completionTokens: 2 })])
    ])
    const res = parseChatJsonl(file, fs.readFileSync(file, 'utf8'))
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.line).toBe(3)
  })

  it('requestId 缺失时仍产出且不写 requestId 键（退回行号幂等）', () => {
    const file = writeGlobal('i.jsonl', [
      headerLine(),
      appendLine([request({ modelId: 'copilot/auto', timestamp: TS_A, promptTokens: 10, completionTokens: 2 })])
    ])
    const res = parseChatJsonl(file, fs.readFileSync(file, 'utf8'))
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.requestId).toBeUndefined()
    expect('requestId' in res.records[0].source).toBe(false)
  })

  it('responseTimestamp 缺失时回落 timestamp', () => {
    const file = writeGlobal('j.jsonl', [
      headerLine(),
      appendLine([request({ requestId: 'request_t1', modelId: 'copilot/auto', timestamp: TS_A, promptTokens: 10, completionTokens: 2 })])
    ])
    const res = parseChatJsonl(file, fs.readFileSync(file, 'utf8'))
    expect(res.records[0].createdAt).toBe(TS_A)
  })

  it('时间戳全部缺失时 createdAt 兜底为当前时间（非 NaN）', () => {
    const file = writeGlobal('k.jsonl', [
      headerLine(),
      appendLine([request({ requestId: 'request_t2', modelId: 'copilot/auto', promptTokens: 10, completionTokens: 2 })])
    ])
    const res = parseChatJsonl(file, fs.readFileSync(file, 'utf8'))
    expect(res.records).toHaveLength(1)
    expect(Number.isNaN(res.records[0].createdAt)).toBe(false)
    expect(Math.abs(res.records[0].createdAt - Date.now())).toBeLessThan(60_000)
  })

  it('modelId 缺失时兜底 unknown', () => {
    const file = writeGlobal('l.jsonl', [
      headerLine(),
      appendLine([request({ requestId: 'request_m1', timestamp: TS_A, promptTokens: 10, completionTokens: 2 })])
    ])
    const res = parseChatJsonl(file, fs.readFileSync(file, 'utf8'))
    expect(res.records[0].model).toBe('unknown')
    expect(res.records[0].rawModel).toBe('unknown')
  })

  it('仅 promptTokens 无 completionTokens 时仍产出且 output=0', () => {
    const file = writeGlobal('m.jsonl', [
      headerLine(),
      appendLine([request({ requestId: 'request_n1', modelId: 'copilot/auto', timestamp: TS_A, promptTokens: 42 })])
    ])
    const res = parseChatJsonl(file, fs.readFileSync(file, 'utf8'))
    expect(res.records).toHaveLength(1)
    expect(res.records[0].inputTokens).toBe(42)
    expect(res.records[0].outputTokens).toBe(0)
    expect(res.records[0].inputSemantics).toBe(2)
  })

  it('elapsedMs 缺失时不出现在记录上', () => {
    const file = writeGlobal('n.jsonl', [
      headerLine(),
      appendLine([request({ requestId: 'request_o1', modelId: 'copilot/auto', timestamp: TS_A, promptTokens: 10, completionTokens: 2 })])
    ])
    const res = parseChatJsonl(file, fs.readFileSync(file, 'utf8'))
    expect('latencyMs' in res.records[0]).toBe(false)
  })

  it('sessionId 缺失时回落文件名去扩展名', () => {
    const file = writeGlobal('0f2e9d1c-0000-1111-2222-333344445555.jsonl', [
      JSON.stringify({ kind: 0, v: { version: 3, requests: [] } }),
      appendLine([request({ requestId: 'request_p4', modelId: 'copilot/auto', timestamp: TS_A, promptTokens: 10, completionTokens: 2 })])
    ])
    const res = parseChatJsonl(file, fs.readFileSync(file, 'utf8'))
    expect(res.records[0].sessionId).toBe('0f2e9d1c-0000-1111-2222-333344445555')
  })

  it('中途损坏行跳过不阻塞后续解析', () => {
    const file = writeGlobal('o.jsonl', [
      headerLine(),
      '{"kind":2,"k":["requests"],"v":[{"requestId":"request_broken"',
      appendLine([request({ requestId: 'request_ok', modelId: 'copilot/auto', timestamp: TS_A, promptTokens: 10, completionTokens: 2 })])
    ])
    const res = parseChatJsonl(file, fs.readFileSync(file, 'utf8'))
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.requestId).toBe('request_ok')
    expect(res.records[0].source.line).toBe(3)
  })

  it('尾部半行不阻塞且 eof=true', () => {
    const file = writeGlobal('p.jsonl', [
      headerLine(),
      appendLine([request({ requestId: 'request_q1', modelId: 'copilot/auto', timestamp: TS_A, promptTokens: 10, completionTokens: 2 })]),
      '{"kind":2,"k":["requests"],"v":[{"requestId":"request_half"'
    ])
    const res = parseChatJsonl(file, fs.readFileSync(file, 'utf8'))
    expect(res.records).toHaveLength(1)
    expect(res.records[0].source.requestId).toBe('request_q1')
    expect(res.eof).toBe(true)
  })

  it('空文件：无记录、eof=true', () => {
    const file = writeGlobal('q.jsonl', [])
    const res = parseChatJsonl(file, '')
    expect(res.records).toHaveLength(0)
    expect(res.eof).toBe(true)
  })

  it('fromLine 游标被忽略：patch 流每次全量重析，两次调用产出一致', async () => {
    const file = writeGlobal('r.jsonl', [
      headerLine(),
      appendLine([
        request({ requestId: 'request_z1', modelId: 'copilot/auto', timestamp: TS_A, promptTokens: 100, completionTokens: 10 })
      ])
    ])
    const first = await copilotChatPlugin.parseFile(ctx, file, 0)
    expect(first.records).toHaveLength(1)

    fs.appendFileSync(file, '\n' + appendLine([request({ requestId: 'request_z2', modelId: 'copilot/auto', timestamp: TS_B, promptTokens: 200, completionTokens: 20 })]), 'utf8')
    const second = await copilotChatPlugin.parseFile(ctx, file, first.nextLine)
    expect(second.records.map((r) => r.source.requestId)).toEqual(['request_z1', 'request_z2'])
    expect(second.records[0]).toMatchObject({ inputTokens: 100, outputTokens: 10 })
  })

  it('多请求追加数组与深路径索引对齐：idx=1 patch 命中第二个请求', () => {
    const file = writeGlobal('s.jsonl', [
      headerLine(),
      appendLine([
        request({ requestId: 'request_i0', modelId: 'copilot/auto', timestamp: TS_A, promptTokens: 100, completionTokens: 10 }),
        request({ requestId: 'request_i1', modelId: 'copilot/auto', timestamp: TS_A, promptTokens: 200, completionTokens: 20 })
      ]),
      patchLine(1, 'promptTokens', 250)
    ])
    const res = parseChatJsonl(file, fs.readFileSync(file, 'utf8'))
    expect(res.records).toHaveLength(2)
    const first = res.records.find((r) => r.source.requestId === 'request_i0')!
    const second = res.records.find((r) => r.source.requestId === 'request_i1')!
    expect(first.inputTokens).toBe(100)
    expect(second.inputTokens).toBe(250)
    expect(second.source.line).toBe(3)
  })

  it('深路径 patch 索引越界时安全忽略', () => {
    const file = writeGlobal('t.jsonl', [
      headerLine(),
      appendLine([request({ requestId: 'request_oob', modelId: 'copilot/auto', timestamp: TS_A, promptTokens: 100, completionTokens: 10 })]),
      patchLine(5, 'promptTokens', 999)
    ])
    const res = parseChatJsonl(file, fs.readFileSync(file, 'utf8'))
    expect(res.records).toHaveLength(1)
    expect(res.records[0].inputTokens).toBe(100)
  })

  it('非有限 usage 值（字符串/null）的 patch 忽略', () => {
    const file = writeGlobal('u.jsonl', [
      headerLine(),
      appendLine([request({ requestId: 'request_nan', modelId: 'copilot/auto', timestamp: TS_A, promptTokens: 100, completionTokens: 10 })]),
      JSON.stringify({ kind: 1, k: ['requests', 0, 'promptTokens'], v: 'not-a-number' }),
      JSON.stringify({ kind: 1, k: ['requests', 0, 'completionTokens'], v: null })
    ])
    const res = parseChatJsonl(file, fs.readFileSync(file, 'utf8'))
    expect(res.records).toHaveLength(1)
    expect(res.records[0].inputTokens).toBe(100)
    expect(res.records[0].outputTokens).toBe(10)
  })

  it('parseFile 读文件失败时返回空结果且游标不倒退', async () => {
    const res = await copilotChatPlugin.parseFile(ctx, path.join(tmpDir, 'missing.jsonl'), 42)
    expect(res.records).toHaveLength(0)
    expect(res.nextLine).toBe(42)
    expect(res.eof).toBe(true)
  })
})
