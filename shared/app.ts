/**
 * 应用类型 = 监控对象标识（内置监控插件，随新增监控插件扩展取值）。
 * 对应 docs/concepts/data-model.md 中 usage_records.app_type 的取值；
 * 后续新增监控插件时，其插件 id 即新的 AppType 取值，无需改表结构。
 */
export type AppType = 'claude' | 'codex' | 'opencode' | 'gemini' | 'grok' | 'pi' | 'zcode' | 'dsh'

/**
 * ctx 服务容器暴露的服务键（docs/concepts/plugin-architecture.md）。
 * 插件用 deps 声明所需服务，宿主按依赖解析装载顺序，服务就绪后才装载插件。
 */
export type ServiceKey = 'storage' | 'pricing' | 'events' | 'scheduler' | 'watcher'

/**
 * 请求状态（用于请求日志的筛选与行详情展示）。
 * - success：正常完成（含正常计费记录）
 * - error：失败（判定矩阵见 shared/dto.ts 顶部与 shared/failure.ts；cancelled/interrupted 不计 error）
 */
export type RequestStatus = 'success' | 'error'
