import { createHash } from 'node:crypto'


export interface SemanticFingerprintInput {
  appType: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  createdAt: number
}

export function semanticFingerprint(r: SemanticFingerprintInput): string {
  const normalized = [r.appType, r.model, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheCreationTokens, r.createdAt].join('|')
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}
