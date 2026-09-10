import type { AppType, RequestStatus } from './app'


export interface Detection {
  available: boolean
  reason?: string
  sessionDir?: string
  cliVersion?: string | null
}

export interface FileEntry {
  path: string
  mtime: number
}

export interface UsageRecord {
  appType: AppType
  model: string
  rawModel?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  inputSemantics: number
  costUsd?: string
  currency?: string
  latencyMs?: number
  project?: string
  sessionId?: string
  status?: RequestStatus
  httpStatus?: number
  errorMessage?: string
  createdAt: number
  source: {
    filePath: string
    line: number
    requestId?: string
  }
}

export interface ParsedResult {
  records: UsageRecord[]
  nextLine: number
  eof: boolean
}
