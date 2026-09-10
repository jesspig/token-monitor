
export const ERROR_MESSAGE_MAX_LENGTH = 500

export const IGNORED_FAILURE_STATUSES = ['cancelled', 'interrupted'] as const
export type IgnoredFailureStatus = (typeof IGNORED_FAILURE_STATUSES)[number]

export const HTTP_ERROR_STATUS_MIN = 400
export const HTTP_ERROR_STATUS_MAX = 599

export function isHttpErrorStatus(code: number): boolean {
  return code >= HTTP_ERROR_STATUS_MIN && code <= HTTP_ERROR_STATUS_MAX
}

export function isIgnoredFailureReason(reason: string): boolean {
  const r = reason.toLowerCase()
  return (IGNORED_FAILURE_STATUSES as readonly string[]).includes(r)
}
