# AGENTS.md

## 项目定位与设计依据

- Electron + TypeScript 桌面工具：监控多个 AI 编程 CLI 的 Token 用量与费用；采集方式为扫描各 CLI 本地会话日志，**不做代理拦截**。
- **改代码前先读 `docs/index.md`**：`docs/` 知识库是唯一设计依据，全部概念页已与实现对齐（2026-08-21 审计）。既定技术栈（Electron / electron-vite / React + Tailwind + TanStack Query + Recharts / better-sqlite3 / chokidar）勿擅自更改。
- 第一阶段已交付：插件宿主 + 5 个内置监控插件（claude / codex / opencode / gemini / grok），typecheck / 156 单测 / 构建 / electron-builder 打包全部通过。

## 命令

| 命令 | 用途 |
|---|---|
| `pnpm dev` | 开发模式（electron-vite dev，热更新） |
| `pnpm typecheck` | 类型检查（tsconfig.node.json + tsconfig.web.json 两段串行） |
| `pnpm exec vitest run` | 全部单测（15 文件 / 156 用例）。**package.json 没有 test 脚本，只能这样跑** |
| `pnpm exec vitest run src/main/services/storage.test.ts` | 单文件测试 |
| `pnpm build` | 构建到 `out/`（main/preload/renderer 三段） |
| `pnpm dist` / `pnpm dist:dir` | electron-builder 打包（安装包 / 解包目录），产物在 `release/` |

- 无 lint / format 配置；验证闭环 = typecheck + vitest。

### 环境坑（本机沙箱）

- pnpm 11 跑任何脚本前会自动执行依赖校验安装；非 TTY 终端下会报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 中止。**先设 `$env:CI='true'` 再跑 pnpm 命令**。
- 沙箱限制写用户目录：`pnpm install` 需 `--no-frozen-lockfile --cache-dir ./.pnpm-cache --store-dir ./.pnpm-store`；打包时设 `ELECTRON_CACHE`/`electron_config_cache` 指向 `.electron-cache`、`npm_config_cache` 指向 `.npm-cache`。这些缓存目录已在 `.gitignore`。

## 架构速览（不显而易见）

- 数据流：`CLI 会话文件 → 插件增量解析(行游标) → 去重 → 费用计算 → usage_records 明细 → usage_daily_rollups 日聚合 → 前端查询`。
- 进程边界：主进程承担全部数据逻辑；渲染进程只经 preload `contextBridge` 白名单 API 通信（契约 = `shared/ipc.ts` 的 RendererApi，15 通道），禁止直接暴露 Node 能力。
- 插件体系为自研框架（`src/main/core/`：registry/context/lifecycle/event-bus）：**新增监控对象 = 新增 `plugins/<id>.ts` 实现 `MonitorPlugin`，并在 `host.ts` 的 `BUILTIN_PLUGINS` 登记一行**。插件经服务容器 `ctx`（storage/pricing/events/scheduler/watcher）访问能力、用 `deps` 声明依赖，不直接 import 宿主实现。
- 去重现状：记录 id = `data_source:file_path:line` + INSERT OR IGNORE；`dedup_ledger` 表已建但**未接入写入路径**（fork/rewrite 语义去重预留），不要假设账本在生效。
- 关键默认值：兜底同步间隔 5 分钟（设置可调）；明细保留 90 天、日聚合永不清理；事件 `usage-updated` 200ms 防抖、watcher 500ms 防抖；seed 定价 10 个模型（USD）。
- IPC 更新/删除定价后必须调 `pricing.invalidateCache()`，否则费用计算沿用旧内存索引。
- 各 CLI 数据源差异大（opencode 为 SQLite db 双源、gemini 为单 JSON 对象、grok 靠 summary.json 建 sessionId→模型映射），改插件前先读 `docs/concepts/monitor-plugins.md` 的实际清单。

## 行为约束

- 监控插件必须**宽松解析 + 错误兜底**：单文件解析失败不得阻塞整体同步；过滤正在写入的半行与临时文件（`.tmp` / `.swp` / 点前缀 / `~` 后缀）。
- 插件宿主保证**可逆生命周期**：任何注册（监听/服务/事件）卸载时必须清理，避免插件热切换泄漏。
- better-sqlite3 仅主进程使用（内部同步 API，对外 Promise 签名）。

## docs/ 知识库维护规则

- 概念页 `docs/concepts/*.md` 必须含 YAML frontmatter（`type` 必填且同类概念一致值；对应具体源码资产加 `resource`；`timestamp` 用真实系统时间）；内容基于实际实现，无法核实处标 `> [!todo] 待补充`。
- `index.md` / `log.md` 为保留文件不含 frontmatter；`log.md` 仅留最近 7 天。
- 维护日志 `docs/changelog/YYYY-MM-DD-HH.md` 按小时合并追加；更新页面须同步刷新其 `timestamp`，并增量修订受影响概念页、删除过时描述。
