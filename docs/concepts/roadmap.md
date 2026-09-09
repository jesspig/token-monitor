---
type: roadmap
title: 里程碑与风险
description: M1–M7 实施路线图与待研究点；插件框架先行，再铺开内置监控插件；2026-09-10 图表层 ECharts 迁移与 UI/UX 系统化。
tags: [roadmap, milestone, risk, planning, plugin]
timestamp: 2026-09-10T01:51:04+08:00
---

# 里程碑与风险

> [!note] 当前状态
> **第一阶段 M1–M6 已完成**（2026-08-20）：脚手架、插件框架内核与数据层、5 个监控插件、可视化、设置与健壮性、electron-builder 打包均已落地并通过编译/测试。M7（扩展更多监控插件 / 代理拦截 / 云账单 / 导出）待后续迭代。

> [!note] 截至 2026-09-10
> 已交付 8 个内置监控插件、统计查询卸载到只读 worker 线程、系统托盘后台常驻、仪表盘双图合并与趋势页退役、查询预聚合与联合索引；图表层已由 Recharts 整体迁移至 ECharts 6.1（Recharts 及 d3 分组卸载，相关死代码清理），渲染层 UI/UX 系统化（QueryState 四态边界、Toast、Toggle、useDismissable、tailwind 语义设计 token、时间范围 FilterContext 全局化）；全部代码注释已于 2026-08-28 移除，`docs/` 为唯一事实来源。具体路线图与各概念实现见 [总体架构](architecture.md) / [插件体系](plugin-architecture.md) / [监控插件](monitor-plugins.md) / [数据流](data-flow.md) 等各概念页。

## 实施路线图

| 里程碑 | 内容 | 交付物 |
|---|---|---|
| **M1 脚手架** | Electron + electron-vite + React + TS + Tailwind + pnpm workspace + better-sqlite3 打通 | 可启动空壳应用 + IPC 示例 |
| **M2 插件框架内核 + 数据层** | `core/`（registry/context/lifecycle/event-bus）+ schema/迁移/DAO/定价 seed/游标/去重表 | 插件宿主与 SQLite 模块，可单测 |
| **M3 首个监控插件端到端** | claude 插件 + 服务 + 费用计算 + Dashboard 最小闭环（真实数据） | 第一个可用监控对象 |
| **M4 其余内置插件** | codex / opencode / gemini / grok | 5 个内置插件全部可同步 |
| **M5 可视化完善** | 趋势图、日志表、统计、筛选、插件启停管理、实时刷新 | 完整 Dashboard |
| **M6 设置与健壮性** | 同步间隔、保留策略、错误上报、跨平台路径、打包 | 可发布 Beta |
| **M7（后续）** | 扩展更多监控插件（OpenClaw / Hermes 等）/ 代理拦截 / 云账单 / 导出 | 迭代版本 |

**建议顺序**：先做 M2→M3 打通插件框架 + 一个监控插件的端到端闭环，验证插件化架构后再批量铺开其余插件。

## 待研究点 / 风险

1. **多平台路径**：Windows / macOS / Linux 的 home 目录差异（`~`、`XDG_CONFIG_HOME` 等）。
2. **日志格式版本漂移**：各 CLI 更新可能改 JSONL 结构 → 插件需宽松解析 + 错误兜底。
3. **文件并发写入**：读到半行 / 临时文件（`*.jsonl.tmp`）需过滤。
4. **数据保留**：明细无限增长 → 默认保留 N 天明细，历史走日聚合。
5. **去重正确性**：fork/rewrite 双算与漏算的平衡，需样本验证。
6. **插件生命周期**：热装载/卸载的时序与资源泄漏需重点验证。
7. **OpenClaw / Hermes 日志格式（后续阶段）**：需自行调研其本地日志格式与路径，扩展时再做。

## 关联页面

- [项目总览](overview.md) — 目标与技术栈。
- [插件体系](plugin-architecture.md) — M2 的实现对象。
- [监控插件](monitor-plugins.md) — M3/M4 的实现对象。
- [返回目录](../index.md)
