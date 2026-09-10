# AGENTS.md

## 定位
Electron + TypeScript 桌面工具：扫描各 AI 编程 CLI 的本地会话日志，统计 Token 用量与费用；**不做代理拦截**。技术栈固定（Electron / electron-vite / React + Tailwind + TanStack Query + ECharts / better-sqlite3 / chokidar），勿擅自更改。

## 命令
| 命令 | 用途 |
|---|---|
| `pnpm dev` | 开发模式（electron-vite dev，热更新） |
| `pnpm typecheck` | 类型检查，两段串行：`tsconfig.node.json` + `tsconfig.web.json` |
| `$env:ELECTRON_RUN_AS_NODE='1'; & "node_modules\electron\dist\electron.exe" node_modules/vitest/vitest.mjs run` | **全量单测（840 用例）**。`package.json` 无 test 脚本；better-sqlite3 已编为 Electron ABI，系统 Node 跑 vitest 报 `NODE_MODULE_VERSION` 错，**只能这样跑** |
| `$env:ELECTRON_RUN_AS_NODE='1'; & "node_modules\electron\dist\electron.exe" node_modules/vitest/vitest.mjs run <file>` | 单文件测试 |
| `pnpm build` | 构建到 `out/`（main/preload/renderer 三段） |
| `pnpm dist` / `pnpm dist:dir` | electron-builder 打包，产物 `release/` |

无 lint/format 配置；验证闭环 = `typecheck` + vitest。

## 环境坑（本机沙箱）
- pnpm 11 非 TTY 下跑脚本会中止（`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`）：先 `$env:CI='true'` 再跑 pnpm。
- 沙箱限制写用户目录：`pnpm install` 用 `--no-frozen-lockfile --cache-dir ./.pnpm-cache --store-dir ./.pnpm-store`；打包设 `ELECTRON_CACHE`/`electron_config_cache`→`.electron-cache`、`npm_config_cache`→`.npm-cache`（已在 `.gitignore`）。
- **better-sqlite3 ABI 双运行时**：安装按系统 Node v24（ABI 137）编译，Electron 33.4.11 需 ABI 130，故 `pnpm dev` 报 `NODE_MODULE_VERSION 137 vs 130`。已用 `pnpm dlx @electron/rebuild -f -w better-sqlite3 -v 33.4.11` 重编为 Electron ABI（dev 已验证）。**禁止**再用 `pnpm exec vitest run` 跑主进程测试、也**禁止**对 better-sqlite3 执行面向系统 Node 的 rebuild（会弄坏 dev）；electron-builder 打包自带重编不受影响。

## 架构
- 进程边界：主进程（`src/main`）承担全部数据逻辑；渲染进程（`src/renderer`）只经 preload `contextBridge` 白名单通信，契约 = `shared/ipc.ts` 的 `RendererApi`（**21 成员 = 20 invoke 通道 + onUsageUpdated 事件订阅**，含 `getStatsByProject/Session/Status` 与 `getDailyModelBreakdown`），禁止直接暴露 Node。
- 数据流：`CLI 会话文件 → 插件增量解析(行游标) → 去重 → 费用计算 → usage_records → usage_daily_rollups（日聚合，永不清理）/ usage_hourly_rollups（小时聚合，v10）→ 前端查询`；`getDailyModelBreakdown` 无维度过滤时走 `usage_daily_rollups` 预聚合快路径，否则回退明细表（`idx_usage_records_model_created` 兜底，v11）；v12 重建缓存口径七源部分索引（`idx_usage_records_cached_input`）。
- 插件框架（`src/main/core/`：registry/context/lifecycle/event-bus）：**新增监控对象 = 新增 `plugins/<id>.ts` 实现 `MonitorPlugin`，并在 `host.ts` 的 `BUILTIN_PLUGINS` 登记一行**；经服务容器 `ctx`（storage/pricing/events/scheduler/watcher）访问能力，不直接 import 宿主实现。当前 22 插件：claude/codex/opencode/gemini/grok/pi/zcode/dsh + workbuddy/codebuddy/cline/roo-code/kilo-code/qwen/qoder/qoder-cn/kimi/zed/kiro/reasonix/command-code/copilot-chat。
- 统计查询卸载到只读 worker 线程：`src/main/worker/queryClient.ts`（主线程 RPC 客户端）+ `src/main/workers/query-worker.ts`（worker_threads 入口，只读 better-sqlite3 连接）；12 个 `UsageQueryService` 方法（`getDailyModelBreakdown` 已纳入重池 `pool[0]`）全部经 worker（2 worker 池，重/轻分流，`HEAVY_METHODS` 6 项 → `pool[0]`，in-flight 去重）；`electron.vite.config.ts` 有 `query-worker` 多入口；`:memory:` / worker 启动失败回退主进程直查。
- 渲染进程：6 页（Dashboard/日志/统计/定价/监控源/设置，**趋势页已合并退役**），`App.tsx` 对已访问页 `visitedRef` 常驻渲染+`display:none` 切换，`lib/range.ts` 分钟对齐，查询全量 `keepPreviousData + staleTime 2min`；图表 ECharts 6.1 按需注册，统一经 `hooks/useECharts.ts`（setOption 增量更新 + ResizeObserver）+ `components/chart-theme.ts`（色板/暗色样式/骨架工厂），数据区四态经 `components/QueryState.tsx`，反馈走 `ToastContext`。
- 系统托盘后台常驻：`src/main/tray.ts` + `src/main/index.ts`；设置项 `closeToTray?: boolean`（默认 true），开启时窗口关闭隐藏到托盘不退出。
- 计费语义：`input_semantics` 三态（0=未知 / 1=含缓存总量需扣减 / 2=纯新输入）；semantics=1：codex/gemini/grok/zcode/workbuddy/codebuddy/qwen/reasonix（8 源）；semantics=0：qoder/qoder-cn/kiro（3 源）；其余 claude/opencode/pi/dsh/cline/roo-code/kilo-code/kimi/zed/command-code/copilot-chat 为 2（11 源）；`calcCost` 对 semantics=1 先扣缓存再乘价。
- 去重：记录 id = `data_source:file_path:line` + `INSERT OR IGNORE`；22 插件中 20 个产出稳定 `source.requestId`（kimi/reasonix 例外，依赖行主键幂等），入库事务内按 `(data_source, request_id)` 查写 `dedup_ledger` 做 fork/rewrite 语义去重。
- 定价只读 + models.dev 每 5 分钟自动同步（`host.syncModelsDevPricing` 唯一写入入口）；seed 99 模型仅离线兜底。
- better-sqlite3 仅主进程使用（同步 API，对外 Promise 签名）。

## 代码与文档约定
- **代码注释已全部移除（2026-08-28），`docs/` 为唯一事实来源**；改代码或加特性前先读 `docs/index.md` 与对应概念页并同步维护；新增代码不加注释。
- 监控插件必须**宽松解析 + 错误兜底**：单文件解析失败不得阻塞整体同步；过滤半行与临时文件（`.tmp`/`.swp`/点前缀/`~`）。
- 插件宿主保证**可逆生命周期**：注册/监听/服务/事件卸载时必须清理，避免热切换泄漏。

## 项目知识库（docs/）
- 位置 `docs/`：项目唯一设计依据。结构 `index.md`（目录）/ `log.md`（按天摘要，仅留 7 天）/ `concepts/*.md`（概念页，当前 10 页：overview/architecture/data-flow/data-model/sync-mechanism/monitor-plugins/plugin-architecture/ui-pages/pricing/roadmap；YAML frontmatter：`type` 必填、`resource` 指向源码（抽象页可省略）、`timestamp` 真实时间）/ `changelog/`（按小时记录）。
- 概念页内容基于实际实现，无法核实处标 `> [!todo] 待补充`；更新页面须同步刷新 `timestamp`，增量修订受影响页并追加对应小时 changelog。
