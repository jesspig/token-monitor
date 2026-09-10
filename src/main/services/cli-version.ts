import { execFile } from 'node:child_process'
import process from 'node:process'
import { promisify } from 'node:util'
import type { AppType } from '../../../shared/app'

export const CLI_VERSION_TIMEOUT_MS = 3000

export type CommandExecutor = (command: string) => Promise<string>

export const CLI_VERSION_COMMANDS: Record<AppType, string> = {
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
  'copilot-chat': 'copilot',
  'dev-eco': 'deveco',
  mimo: 'mimo',
  goose: 'goose',
  'copilot-cli': 'copilot',
  gptme: 'gptme',
  'trae-agent': 'trae-cli',
  codewhale: 'codewhale',
  droid: 'droid',
  minimax: 'mcode'
}

const execFileAsync = promisify(execFile)

function firstNonEmptyLine(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return null
}

async function execWithTimeout(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: CLI_VERSION_TIMEOUT_MS,
      windowsHide: true
    })
    return stdout
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string | Buffer }
    if (!err.stdout) throw error
    return typeof err.stdout === 'string' ? err.stdout : err.stdout.toString('utf8')
  }
}

export const defaultExecutor: CommandExecutor = async (command) => {
  if (process.platform !== 'win32') {
    return execWithTimeout(command, ['--version'])
  }
  const whereOutput = await execWithTimeout('where.exe', [command])
  const resolvedPath = firstNonEmptyLine(whereOutput)
  if (resolvedPath === null) {
    throw new Error(`where.exe 未定位到命令：${command}`)
  }
  return execWithTimeout(resolvedPath, ['--version'])
}

const versionCache = new Map<string, string | null>()

export function clearCliVersionCache(): void {
  versionCache.clear()
}

export async function detectCliVersion(
  command: string,
  executor: CommandExecutor = defaultExecutor
): Promise<string | null> {
  const cached = versionCache.get(command)
  if (cached !== undefined) return cached
  let version: string | null
  try {
    version = firstNonEmptyLine(await executor(command))
  } catch {
    version = null
  }
  versionCache.set(command, version)
  return version
}
