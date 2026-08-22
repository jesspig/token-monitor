import type { AppType, RequestStatus } from './app'

/**
 * 插件探测结果：CLI 是否安装、会话目录是否存在
 * （docs/concepts/monitor-plugins.md）。
 */
export interface Detection {
  available: boolean
  /** 不可用时说明原因（如未安装、目录不存在） */
  reason?: string
  /** 探测到的会话目录 */
  sessionDir?: string
  /** 探测到的 CLI 版本号；null 表示探测失败或未探测 */
  cliVersion?: string | null
}

/**
 * 待解析的会话文件条目（插件 listFiles 返回值）。
 */
export interface FileEntry {
  path: string
  /** 文件最后修改时间（epoch ms），用于增量同步的 mtime 比较 */
  mtime: number
}

/**
 * 单条用量记录（解析产物，写入 usage_records 前的内存形态）。
 * 字段对齐 docs/concepts/data-model.md 的明细表设计。
 */
export interface UsageRecord {
  /** 监控对象（插件 id） */
  appType: AppType
  /** 归一化模型 ID（计费用） */
  model: string
  /** 日志原始模型名 */
  rawModel?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** 输入语义：0=未知 / 1=含缓存写 / 2=纯新输入 */
  inputSemantics: number
  /** 费用（USD，字符串避免浮点误差；由 pricing 计算后回填） */
  costUsd?: string
  currency?: string
  latencyMs?: number
  project?: string
  sessionId?: string
  /** 请求状态（可选，插件可携带错误信息，供日志状态筛选） */
  status?: RequestStatus
  /** 发生时间（epoch ms） */
  createdAt: number
  /**
   * 来源定位：文件路径 + 行号。
   * (file_path, line) 为天然唯一键，用于去重与游标回溯。
   */
  source: {
    filePath: string
    line: number
  }
}

/**
 * 增量解析结果（docs/concepts/monitor-plugins.md）。
 */
export interface ParsedResult {
  /** 本次新解析出的用量记录 */
  records: UsageRecord[]
  /** 游标推进到的行号（下一轮 fromLine） */
  nextLine: number
  /** 是否已读到文件尾 */
  eof: boolean
}
