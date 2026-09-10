import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLI_VERSION_COMMANDS,
  CLI_VERSION_TIMEOUT_MS,
  clearCliVersionCache,
  detectCliVersion
} from './cli-version'

beforeEach(() => {
  clearCliVersionCache()
})

describe('detectCliVersion', () => {
  it('注入 fake executor 成功返回 stdout 时正确解析首个非空行', async () => {
    const executor = vi.fn(async () => '1.2.3\n')

    const version = await detectCliVersion('claude', executor)

    expect(version).toBe('1.2.3')
    expect(executor).toHaveBeenCalledTimes(1)
    expect(executor).toHaveBeenCalledWith('claude')
  })

  it('executor 抛错时得到 null 且不向上抛出', async () => {
    const executor = vi.fn(async () => {
      throw new Error('command not found')
    })

    const version = await detectCliVersion('claude', executor)

    expect(version).toBeNull()
  })

  it('模拟超时形态的 executor 拒绝时得到 null', async () => {
    const timeoutError = new Error('spawn timed out') as NodeJS.ErrnoException & {
      killed?: boolean
    }
    timeoutError.killed = true
    timeoutError.code = 'ETIMEDOUT'
    const executor = vi.fn(async () => {
      throw timeoutError
    })

    const version = await detectCliVersion('claude', executor)

    expect(version).toBeNull()
  })

  it('stdout 为空或仅空白时得到 null', async () => {
    for (const empty of ['', '   ', '\n', '  \n  \n']) {
      clearCliVersionCache()
      const version = await detectCliVersion('claude', async () => empty)
      expect(version).toBeNull()
    }
  })

  it('缓存生效：同命令第二次探测不再触发 executor，失败结果同样入缓存', async () => {
    const executor = vi.fn(async () => '4.5.6\n')

    await expect(detectCliVersion('codex', executor)).resolves.toBe('4.5.6')
    await expect(detectCliVersion('codex', executor)).resolves.toBe('4.5.6')
    expect(executor).toHaveBeenCalledTimes(1)

    const failingExecutor = vi.fn(async (): Promise<string> => {
      throw new Error('boom')
    })
    await expect(detectCliVersion('grok', failingExecutor)).resolves.toBeNull()
    await expect(detectCliVersion('grok', failingExecutor)).resolves.toBeNull()
    expect(failingExecutor).toHaveBeenCalledTimes(1)
  })

  it('不同命令互不串缓存：各自独立触发 executor', async () => {
    const executor = vi.fn(async (command: string) => `${command}-version\n`)

    await expect(detectCliVersion('claude', executor)).resolves.toBe('claude-version')
    await expect(detectCliVersion('gemini', executor)).resolves.toBe('gemini-version')
    expect(executor).toHaveBeenCalledTimes(2)
  })

  it('多行输出取首个非空行并去除首尾空白', async () => {
    const multiline = [
      '',
      '  ',
      '\t Claude Code v2.0.14 (Claude Code)',
      'node: v22.12.0',
      ''
    ].join('\r\n')

    const version = await detectCliVersion('claude', async () => multiline)

    expect(version).toBe('Claude Code v2.0.14 (Claude Code)')
  })
})

describe('常量映射', () => {
  it('二十二个监控对象均映射到 CLI 命令（同名直接映射，别名取实际可执行名）', () => {
    expect(CLI_VERSION_COMMANDS).toEqual({
      claude: 'claude',
      codex: 'codex',
      opencode: 'opencode',
      gemini: 'gemini',
      grok: 'grok',
      pi: 'pi',
      zcode: 'zcode',
      dsh: 'dsh',
      workbuddy: 'workbuddy',
      codebuddy: 'codebuddy',
      cline: 'cline',
      'roo-code': 'roo',
      'kilo-code': 'kilo',
      qwen: 'qwen',
      qoder: 'qoder',
      'qoder-cn': 'qoder',
      kimi: 'kimi',
      zed: 'zed',
      kiro: 'kiro',
      reasonix: 'reasonix',
      'command-code': 'commandcode',
      'copilot-chat': 'copilot'
    })
  })

  it('探测超时常量为 3000ms', () => {
    expect(CLI_VERSION_TIMEOUT_MS).toBe(3000)
  })
})
