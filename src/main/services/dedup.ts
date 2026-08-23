import { createHash } from 'node:crypto'

/**
 * 语义去重设计（docs/concepts/data-model.md 的 dedup_ledger）：
 * - 主路径：ID 直配。插件产出稳定语义请求 ID（如上游消息 UUID）时，
 *   以 (data_source, request_id) 查 dedup_ledger 判重，命中即跳过，
 *   覆盖 fork/rewrite 场景（同一逻辑请求出现在不同文件/行号）。
 * - 兜底：指纹预留。无 requestId 的记录退回既有 (file,line) 主键去重；
 *   semanticFingerprint 仅用于回填 ledger 的 semantic_id 列，供未来
 *   指纹级判重扩展使用，不参与当前判定。
 */

/** 语义指纹的最小入参（结构化最小类型，不强制整个 UsageRecord） */
export interface SemanticFingerprintInput {
  appType: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  createdAt: number
}

/** 确定性兜底指纹：归一化串 sha256 取 hex 前 16 位，同输入必同输出 */
export function semanticFingerprint(r: SemanticFingerprintInput): string {
  const normalized = [r.appType, r.model, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheCreationTokens, r.createdAt].join('|')
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}
