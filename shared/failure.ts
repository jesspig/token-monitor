/**
 * 失败语义界定（T01 契约固化，SSOT）
 * 本文件以注释形式固化判定矩阵，避免单独文档漂移；后续任务（存储/采集/插件）均以此为准。
 *
 * ## 判定矩阵
 * ```
 * 通用：HTTP 4xx/5xx、isApiErrorMessage、LLM failure、status != completed 判 error；
 *       cancelled / interrupted 属用户中断，忽略不计 error（不入 error 计数，不触发失败告警）。
 *
 * claude: isApiErrorMessage === true => error，httpStatus = apiErrorStatus，model = <synthetic>
 * zcode: model_usage.status != 'completed' && error_type != null => error（error_type === 'cancelled' 忽略）
 * dsh: llm/retry.failure => error（仅尝试级 failure 事件产出 error 记录，会话级中断忽略）
 * gemini: type === 'error' => error（双格式 JSONL 均以该标记为准）
 * codex: stream_error => error
 * grok / opencode / pi: 宽松探测，按各源 error 标记（存在 error 字段/非 completed 状态即判 error，中断标记除外）
 * ```
 *
 * ## 字段约束
 * - httpStatus?: number 仅失败时有效，成功/中断为 undefined（存储层为 null）
 * - errorMessage?: string 最长 500 字符约束由存储层执行（入库前截断，DTO 层不限长）
 * - status?: RequestStatus 缺省视为 'success'，仅按矩阵判 error 时才置 'error'
 *
 * @see shared/dto.ts 顶部同矩阵注释
 * @see shared/tables.ts UsageRecordRow.http_status / error_message
 * @see shared/query.ts LogFilters.status / statusCode / httpStatus
 */

/** 错误文案最大长度，存储层截断用 */
export const ERROR_MESSAGE_MAX_LENGTH = 500

/** 视为中断忽略的状态值（不计 error） */
export const IGNORED_FAILURE_STATUSES = ['cancelled', 'interrupted'] as const
export type IgnoredFailureStatus = (typeof IGNORED_FAILURE_STATUSES)[number]

/** HTTP 失败状态码区间（4xx/5xx 判 error） */
export const HTTP_ERROR_STATUS_MIN = 400
export const HTTP_ERROR_STATUS_MAX = 599

/** 判断 HTTP 状态码是否属失败区间 */
export function isHttpErrorStatus(code: number): boolean {
  return code >= HTTP_ERROR_STATUS_MIN && code <= HTTP_ERROR_STATUS_MAX
}

/** 判断是否为中断忽略（cancelled/interrupted） */
export function isIgnoredFailureReason(reason: string): boolean {
  const r = reason.toLowerCase()
  return (IGNORED_FAILURE_STATUSES as readonly string[]).includes(r)
}
