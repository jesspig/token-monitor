# AGENTS.md

## 定位
Electron + TypeScript 桌面工具：扫描各 AI 编程 CLI 的本地会话日志和数据库，统计 Token 用量与费用；**不做代理拦截**。技术栈固定（Electron / electron-vite / React + Tailwind + TanStack Query + ECharts / better-sqlite3 / chokidar），勿擅自更改。

## 命令
| 命令 | 用途 |
|---|---|
| `pnpm dev` | 开发模式（electron-vite dev，热更新） |
| `pnpm typecheck` | 类型检查，两段串行：`tsconfig.node.json` + `tsconfig.web.json` |
| `$env:ELECTRON_RUN_AS_NODE='1'; & "node_modules\electron\dist\electron.exe" node_modules/vitest/vitest.mjs run` | **全量单测（54 文件 / 1166 用例）**。`package.json` 无 test 脚本；better-sqlite3 为 Electron ABI，只能这样运行主进程测试 |
| `$env:ELECTRON_RUN_AS_NODE='1'; & "node_modules\electron\dist\electron.exe" node_modules/vitest/vitest.mjs run <file>` | 单文件测试 |
| `pnpm build` | 构建到 `out/`（main/preload/renderer 三段） |
| `pnpm dist` / `pnpm dist:dir` | electron-builder 打包，产物 `release/` |

无 lint/format 配置；验证闭环 = `typecheck` + 全量 vitest + `pnpm build`。当前验证基线三项均通过。

## 环境坑（本机沙箱）
- pnpm 11 非 TTY 下跑脚本会中止：先设置 `$env:CI='true'`。
- 沙箱安装依赖使用工作区 cache/store；打包 cache 指向工作区目录，均已在 `.gitignore`。
- better-sqlite3 已重编为 Electron 33.4.11 ABI。禁止使用系统 Node 运行主进程 vitest，也禁止对 better-sqlite3 做面向系统 Node 的 rebuild。

## 架构
- 主进程承担全部数据逻辑；renderer 只经 preload `contextBridge` 白名单通信。`RendererApi` 为 **21 成员 = 20 invoke 通道 + `onUsageUpdated`**。
- 当前 SQLite schema 为 **v14**。六表：`usage_records`、日/小时 rollup、`model_pricing`、`sync_cursors`、`dedup_ledger`。v14 为 `usage_records` 增加 `request_id`、`is_replaceable_snapshot` 和同源非空 requestId 唯一部分索引。
- 数据流：`本地日志/数据库 → 插件增量解析（行/字节/编码水位/快照）→ 全零过滤 → 计价 → 不可变去重或可替换成功快照 → usage_records → 日/小时 rollup → worker 查询 → UI`。
- 可替换快照只对逐源明确标记的成功记录开放：Claude 有 message.id、Kiro current SQLite turn、Droid 有 message.id。新旧均可替换且均 success 才更新；同事务重建受影响日/小时桶。错误和其他记录保持 first-write-wins。
- 插件框架位于 `src/main/core/`。新增插件在 `plugins/<id>.ts` 实现 `MonitorPlugin`，并加入 `host.ts` 的 **`createBuiltinPlugins(getTraeTrajectoryRoots)` 工厂返回数组**。Trae 使用 `createTraeAgentPlugin`，设置 getter 通过参数注入；不再描述为静态 `BUILTIN_PLUGINS` 常量。
- 当前 31 插件：claude/codex/opencode/gemini/grok/pi/zcode/dsh + workbuddy/codebuddy/cline/roo-code/kilo-code/qwen/qoder/qoder-cn/kimi/zed/kiro/reasonix/command-code/copilot-chat + dev-eco/mimo/goose/copilot-cli/gptme/trae-agent/codewhale/droid/minimax。
- 查询由 `worker/queryClient.ts` 和 `workers/query-worker.ts` 的 2 worker 池执行；12 个 `UsageQueryService` 方法全部经 worker，`:memory:` 或 worker 失败回退主进程直查。
- renderer 为 6 页；ECharts 经 `useECharts`/`chart-theme`，查询状态经 `QueryState`，反馈经 Toast。
- 托盘后台常驻由 `tray.ts` + `index.ts` 实现；`closeToTray` 默认 true。

## 当前插件兼容事实
- DSH：legacy 与 v1/v2 JSONL/zstd；重启前缀恢复；未来版本、`.dsh`、SQLite 后端不猜测。
- Kilo：current `kilo.db` + 旧扩展；current semantics=0，旧扩展=2。
- Kiro：current `data.sqlite3` + 旧 sidecar；仅接受显式 input/output Token，无显式 Token 时拒绝估算。
- OpenCode/DevEco/MiMo：数据库指纹 + rowid 编码水位，旧时间戳游标自动重读。
- Copilot CLI/Command Code：从游标前缀重建累计高水位或 session/model/分支状态。
- gptme：递归 branches；只用明确稳定消息 ID 处理复制历史，缺 ID 不猜测。
- Trae：设置页多根优先，其次 `TRAE_TRAJECTORY_DIR`、旧默认候选；不扫描用户目录或磁盘。
- CodeWhale：首次只建基线不回填历史，增长取差值，下降重置；不拆分未知四桶。
- Cline/Roo：VS Code Stable/Insiders、VSCodium、Cursor；Cline CLI/SDK-managed 会话未接入。
- MiniMax：仅在 session/turn/记录 id 均有效时构造跨库语义 ID。
- Droid：JSONL usage 可替换；settings 只验证，不计 Token、不反推费用。

## 计费语义
`input_semantics`：0=未知，1=含缓存总量需扣减，2=纯新输入。

- 固定 1：codex/gemini/grok/zcode/workbuddy/codebuddy/qwen/reasonix/goose/copilot-cli。
- 固定 2：claude/opencode/pi/dsh/cline/roo-code/kimi/zed/command-code/copilot-chat/dev-eco/mimo/gptme/droid/minimax。
- 固定 0：qoder/qoder-cn/kiro/codewhale。
- kilo-code：current DB=0，旧扩展=2。
- trae-agent：按 provider 逐行判定，Anthropic 系=2，已验证的 OpenAI 等分支=1。

不得编造 requestId 覆盖数量；按插件/记录条件描述。无稳定 requestId 时退回文件路径和行号幂等。

## 代码与文档约定
- 代码不写注释；`docs/` 为唯一事实来源。改代码前先读 `docs/index.md` 和对应概念页，完成后同步文档与当前小时 changelog。
- 监控插件需宽松解析并显式报告 schema 不兼容；单文件失败不得阻塞整体同步；过滤半行和临时文件。
- 外部日志和数据库只读；无证据的 Token 字段、父子关系和 requestId 不估算、不猜测。
- 插件生命周期可逆，卸载时清理监听、缓存、worker 和服务注册。

## 项目知识库
- `docs/index.md`：目录与当前基线。
- `docs/log.md`：仅保留最近 7 天摘要。
- `docs/concepts/*.md`：10 个概念页；frontmatter `type` 必填，`resource` 指向源码（抽象页可省略），`timestamp` 为真实更新时间。
- `docs/changelog/`：按本机真实小时记录动机、事实、验证与限制。
