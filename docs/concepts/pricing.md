---
type: pricing-design
title: 定价与费用
description: 模型定价表（seed/sync/user 三态分级覆盖）、models.dev 全自动同步（间隔可配，默认 5 分钟）、零成本回填与存量缓存口径重算；费用 = fresh_input × input 价 + 其余 token × 各自价格，input 按 semantics 三态扣减。
tags: [pricing, cost, token, model, modelsdev]
resource: src/main/services/pricing.ts
timestamp: 2026-08-24T16:58:00+08:00
---

# 定价与费用

> [!note] 当前状态
> **已实现**。归一化与费用计算落地于 `src/main/services/pricing.ts`；定价表 v2 迁移（`source` 列）与 models.dev 同步（`src/main/services/modelsdev.ts`）于 2026-08-22 落地；同日第三轮迭代将 models.dev 同步改为**无条件自动同步**（无启停开关），定价 UI/IPC 收窄为只读；第四轮迭代把同步间隔改为设置可配（`pricingSyncIntervalMs`，默认 5 分钟）；2026-08-23 第五轮迭代接入输入语义计费（v4 迁移 + 存量重算）并增强匹配兜底链；**2026-08-24 定价写入批量化（seed 播种与 models.dev 同步均收敛为单事务批量 upsert，数千次独立 fsync → 1 次）与启动错峰（models.dev 首次同步延迟 10s）落地**。

## 定价表（v2，已实现）

`model_pricing` 记录每百万 token 价格：input / output / cache_read / cache_creation，含 `currency`（默认 USD）与 `cost_multiplier`（默认 1）；v2 迁移新增 **`source`** 列标记行来源，三态为：

| source | 写入方 | 覆盖规则 |
|---|---|---|
| `seed` | 启动时 `seedPricing` 播种 | 可被 sync/user 覆盖 |
| `sync` | models.dev 全量同步写入 | 可覆盖 seed/sync；被 user 挡住 |
| `user` | 存量行保护标记（v2 迁移把历史行保守标 'user'；IPC 手动写价入口已下线） | **挡住一切非 user 写入** |

分级覆盖语义：任何非 user 来源的写入对已存在的 user 行不生效；models.dev 同步完成后必须失效 pricing 内存缓存（`invalidateCache`，宿主同步入口已内置）。

## 费用计算（已实现，按输入语义扣减）

估算费用 = `fresh_input × input 价 + output × output 价 + cacheRead × read 价 + cacheCreation × write 价`（全部乘 cost_multiplier），按微美元整数精度求和后输出 USD 字符串；未找到定价项返回 undefined（记录照常入库，costUsd 为空）。

**fresh_input 按 `record.inputSemantics` 三态区分口径**（SSOT 定义，与 data-model.md 一致）：

| inputSemantics | 含义 | fresh_input |
|---|---|---|
| 0 | 未知 | inputTokens（全额，保守不扣） |
| 1 | input 为含缓存读写的总量 | `max(0, input − cacheRead − cacheCreation)` |
| 2 | input 已为纯新输入 | inputTokens |

五源实际口径（2026-08-23 经上游源码逐一核实）：claude 与 opencode 上游已扣减缓存（=2，不扣）；codex / gemini / grok 的 input_tokens 为含缓存总量（=1，扣 read+write，三源 write 桶实际恒为 0）。旧公式对 semantics=1 全额计价曾造成缓存部分重复计费、费用系统性高估，已修复。

## 模型 ID 归一化（已实现，8 步规则）

查价前先清洗模型 ID（自研规则，按序执行）：

1. trim + 转小写；
2. 去掉最后一个 `/` 之前的供应商前缀；
3. 去掉 `:` 之后的后缀（`model:suffix → model`）；若冒号前为已知供应商名则改为保留冒号后（`provider:model → model`）；
4. 去掉末尾 `[1m]`；
5. `@` → `-` 并去掉开头 `-`；
6. 去掉常见包装前缀（`provider.model` / `provider_model` → model，供应商名单内置 19 个）；
7. 去掉版本/日期后缀（`-YYYY-MM-DD`、`-YYYYMMDD`）；
8. 剥离 reasoning effort 后缀（`-low` / `-high` / `-xhigh`，单次，`$` 锚定防误伤）。

## 定价匹配策略（已实现，五级兜底链）

`matchPrice` 按序尝试，命中即返回：

1. **精确**匹配归一化 ID；
2. **点转横线变体的精确匹配**（`claude-sonnet-4.5 → claude-sonnet-4-5`）：仅作查价尝试，不进入 normalizeModelId——Gemini 等官方 id 自带点号，无条件转换会破坏精确命中；
3. **短 ID 匹配带版本/后缀项**（请求 ID 以定价 key 为前缀且后继为边界字符 `-`/`.`/数字时命中，取最长 key，避免家族误配）；
4. 点转横线变体的短 ID 匹配（同规则作用于 dotted 变体）；
5. **家族兜底**：定价 key 以请求 ID 为前缀且后继为边界字符时取**最短 key**（避免过专分档误配），仅当请求 ID 长度 ≥3 才启用。

> 排序约束：级 2 必须先于级 3——否则 `claude-opus-4.5` 会被短 ID `claude-opus-4` 截胡（`.` 通过边界判定），错配上一代价格（单价差 3 倍）；有防回归用例。

## 内置 seed 价格清单（已实现）

启动时 `seedPricing` 以 `source='seed'` **单事务批量** upsert 写入 **99 个主流模型**（币种 USD，公开参考价；已存在的非 user 行按分级覆盖规则更新）。**seed 仅作离线兜底**：启动序列在 seed 后执行一次 models.dev 全量同步，权威价格以 sync 价为准。完整清单以源码为准（`src/main/services/pricing.ts` 的 seed 数据），此处不再逐条罗列。

## models.dev 自动同步（已实现，无启停开关，间隔可配）

落地于 `src/main/services/modelsdev.ts`：拉取 models.dev `api.json` 全量目录并把条目映射为定价行写入（`source='sync'`）。cost 四档（input / output / cache_read / cache_creation）直接映射；**cost 档缺失补 0**；input/output 缺失的条目整条丢弃。写入经 `storage.updateModelPricingBatch` **单事务批量 upsert**（2026-08-24 由逐条独立事务改批，数千次 fsync 收敛为 1 次；user 分级保护在批量路径同样生效；批量失败即整体失败向上抛）。目录拉取是同步的内部步骤，不再暴露独立的在线浏览通道。

同步完全自动化（宿主 `host.ts`）：

- 启动序列 seed 定价后**延迟 10 秒**执行一次全量同步（2026-08-24 启动错峰，避免与首轮采集同帧争抢 IO）；
- 此后经 scheduler 按 `pricingSyncIntervalMs` 周期执行（默认 `300000` = 5 分钟），设置变更时即时重启调度；无启停开关，UI 仅在设置页暴露间隔输入（分钟）；
- PricingPage 仅保留「立即全量同步」按钮，手动触发同一宿主入口。

IPC 仅两通道：`pricing:list`（只读列表）/ `pricing:modelsdev-sync`（手动全量同步）。`pricing:update` / `pricing:delete` / 目录浏览与勾选导入通道已删除，定价表对 UI **只读**；user 档保护规则不变，历史手动价仍不会被 seed/sync 覆盖。

每次同步完成后执行 `pricing.invalidateCache()` 并触发零成本回填。

## 零成本回填（已实现）

`pricing.backfillZeroCost(db, pricing)`：扫描明细表中 `cost_usd = 0` 或为空的行，用当前定价重算费用并增量修正对应 `usage_daily_rollups.cost_usd`。

- 不变量：rollup 费用 ≡ 组内明细费用之和（增量修正而非重算全桶）；rollup 行缺失时不重建。
- 触发时机：应用启动、每次 models.dev 全量同步之后（自动调度与手动按钮共用同一入口）。

## 存量缓存口径重算（已实现，recalcCachedInputCosts）

`pricing.recalcCachedInputCosts(db, pricing)`：计费语义修复前 codex/gemini/grok 三源的历史明细（semantics=1）按「input 全额计价」被高估；本函数扫描这三源的 semantics=1 行，以新公式按**当前活定价**重算并回写，delta 增量修正对应 rollup（不变量与零成本回填一致）。

- 与迁移的分工：v4 迁移只做纯 SQL 的 opencode semantics 标注修正（1→2）；费用重算需要活定价而 migrate() 为同步纯 SQL,故落地为独立函数由宿主**启动序列**异步调用一次。
- 幂等：重算值与现值一致（delta=0）即跳过零写入,重复调用 updated=0;阶段二 UPDATE 附带 `cost_usd IS ?` 乐观守卫（NULL 安全），防覆盖并发写入。
- rollup 行缺失时不创建（同零成本回填口径）。

## 关联页面

- [数据模型](data-model.md) — `model_pricing` 表结构。
- [数据流](data-flow.md) — 费用计算在链路中的位置。
- [返回目录](../index.md)
