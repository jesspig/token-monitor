import { describe, it, expect } from 'vitest'
import { semanticFingerprint } from './dedup'

describe('semanticFingerprint', () => {
  const base = {
    appType: 'claude',
    model: 'claude-sonnet-4',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 20,
    cacheCreationTokens: 10,
    createdAt: 1755578400000
  }

  it('同输入同输出，长度为 16', () => {
    expect(semanticFingerprint(base)).toBe(semanticFingerprint({ ...base }))
    expect(semanticFingerprint(base)).toHaveLength(16)
  })

  it('任一字段变化输出不同', () => {
    const variants = [
      { ...base, appType: 'codex' },
      { ...base, model: 'gpt-5' },
      { ...base, inputTokens: base.inputTokens + 1 },
      { ...base, outputTokens: base.outputTokens + 1 },
      { ...base, cacheReadTokens: base.cacheReadTokens + 1 },
      { ...base, cacheCreationTokens: base.cacheCreationTokens + 1 },
      { ...base, createdAt: base.createdAt + 1 }
    ]
    for (const v of variants) {
      expect(semanticFingerprint(v)).not.toBe(semanticFingerprint(base))
    }
  })
})
