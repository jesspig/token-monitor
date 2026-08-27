import type { AppType, RequestStatus } from './app'

/**
 * 失败判定矩阵（T01 契约固化，SSOT）：
 * - 通用：HTTP 4xx/5xx、isApiErrorMessage、LLM failure、status != completed 判 error；
 *          cancelled / interrupted 属用户中断，忽略不计 error。
 * - claude: isApiErrorMessage === true => error，httpStatus = apiErrorStatus，model = <synthetic>（合成失败模型）
 * - zcode: model_usage.status != 'completed' && error_type != null => error；error_type === 'cancelled' 忽略
 * - dsh: llm/retry.failure => error（仅尝试级 failure 事件产出 error 记录，会话级中断忽略）
 * - gemini: type === 'error' => error（双格式 JSONL 均以该标记为准）
 * - codex: stream_error => error
 * - grok / opencode / pi: 宽松探测，按各源 error 标记（存在 error 字段/非 completed 状态即判 error，中断标记除外）
 *
 * 约束：httpStatus 仅失败时有效；errorMessage 由存储层截断至 500 字符。
 * 详见 shared/failure.ts 与 docs/concepts/data-model.md。
 */

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
  /** 输入语义：0=未知 / 1=input 为含缓存读写的总量(计费前需扣减缓存) / 2=input 已为纯新输入 */
  inputSemantics: number
  /** 费用（USD，字符串避免浮点误差；由 pricing 计算后回填） */
  costUsd?: string
  currency?: string
  latencyMs?: number
  project?: string
  sessionId?: string
  /** 请求状态（可选，插件可携带错误信息，供日志状态筛选） */
  status?: RequestStatus
  /** HTTP 状态码，仅失败（status==='error'）时有效；成功/中断为 undefined */
  httpStatus?: number
  /**
   * 截断后的错误文案，最长 500 字符约束由存储层执行（入库前截断，DTO 层不限长）。
   * 仅失败时有效；成功/中断为 undefined。
   */
  errorMessage?: string
  /** 发生时间（epoch ms） */
  createdAt: number
  /**
   * 来源定位：文件路径 + 行号。
   * (file_path, line) 为天然唯一键，用于去重与游标回溯。
   */
  source: {
    filePath: string
    line: number
    /** 稳定语义请求 ID（如上游消息 UUID），跨文件/重写场景唯一标识同一逻辑请求；缺失时退回 (file,line) 主键去重 */
    requestId?: string
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
