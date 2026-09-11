---
type: roadmap
title: 里程碑与风险
description: 当前 31 插件、schema v14 与兼容性加固完成状态，以及仍需基于证据推进的后续风险。
tags: [roadmap, milestone, risk, plugin, schema]
timestamp: 2026-09-11T12:03:38+08:00
---

# 里程碑与风险

> [!note] 当前状态
> M1–M6 已完成；M7 的“扩展更多本地监控源”已推进到 **31 个内置插件**。2026-09-11 完成本轮兼容性加固与 schema v14：当前格式、增量恢复、数据库编码水位、多根设置、requestId 明细持久化和可替换成功快照已落地。验证基线：typecheck 两段通过、vitest 54 文件 / 1166 用例通过、`pnpm build` 通过。

## 已完成里程碑

| 里程碑 | 当前结果 |
|---|---|
| M1 脚手架 | Electron/electron-vite/React/TypeScript/Tailwind/better-sqlite3 打通 |
| M2 插件框架与数据层 | registry/context/lifecycle/event-bus、六表 SQLite、schema v14、定价与游标 |
| M3 首源闭环 | Claude 采集、计价、明细、聚合和 Dashboard 闭环 |
| M4 内置插件扩展 | 31 个本地日志/数据库插件由宿主统一装配 |
| M5 可视化 | Dashboard、日志、五维统计、定价、监控源、设置六页 |
| M6 健壮性与发布 | 增量同步、失败可观测、worker 查询、托盘、构建与打包能力 |
| M7a 兼容性加固 | DSH/Kilo/Kiro 当前格式；前缀恢复；OpenCode-like 编码水位；Trae 多根；可替换快照 |

## 本轮完成边界

- DSH：legacy 与 v1/v2 JSONL/zstd；未来版本、`.dsh` 和 SQLite 后端显式不支持。
- Kilo：当前 `kilo.db` + 旧扩展；当前 input/cache 关系保持未知。
- Kiro：current `data.sqlite3` + 旧 sidecar；缺显式 Token 时拒绝估算。
- Cline/Roo：VS Code Stable/Insiders、VSCodium、Cursor；Cline CLI/SDK-managed 会话未接入。
- CodeWhale：保守快照，首次不回填历史，无法恢复快照间模型切换。
- Droid：settings 只验证，不计 Token；JSONL 可替换快照收敛。
- OpenCode/DevEco/MiMo：数据库指纹 + rowid；旧行原位更新不重产。
- gptme：有稳定消息 ID 时处理 fork/branch 复制历史；无 ID 不猜测。

## 后续方向

后续工作必须先取得一手代码、数据或原始文档证据：

1. Cline CLI/SDK-managed 会话的独立本地存储和 Token schema。
2. DSH 未来版本、容器或 SQLite 后端的正式格式。
3. Kilo current input 与缓存桶的包含关系。
4. CodeWhale 逐 turn 权威四桶和稳定请求身份。
5. Kiro 在不同服务版本中的显式 Token 可用性。
6. Droid settings 是否形成稳定、跨 provider 的权威四桶契约。
7. 各 SQLite 上游发生 schema 迁移或原位更新时的版本识别。
8. 新监控源、数据导出和更细的兼容版本矩阵。

项目定位仍是**扫描本地会话日志和数据库**，不规划代理拦截。

## 风险控制

- 外部数据只读，不写回 CLI 会话库。
- schema 漂移必须显式可见，不能伪装成零新增。
- 无法验证的 Token、requestId 或父子关系不估算、不猜测。
- 多根目录只能显式配置或使用已验证候选，不做宽范围扫描。
- 新旧格式并存时必须证明不会重复计数。
- 可替换快照只对逐源明确标记的成功记录开放。
- 文档数值必须由实际代码或实际验证结果计算。

## 关联页面

- [项目总览](overview.md)
- [总体架构](architecture.md)
- [监控插件](monitor-plugins.md)
- [数据模型](data-model.md)
- [返回目录](../index.md)
