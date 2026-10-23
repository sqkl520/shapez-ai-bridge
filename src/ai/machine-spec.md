# shapez 1.5.6 机器规格表（machine-spec）

> 交付物 2/2（机器可读版：`src/ai/machine-spec.json`）。布局编译器（P1–P8）的静态数据底座。
> 纯离线规格检索：权威源码 `recon/upstream-full/src/js/game/`（commit `ee2279d`，精确对应 1.5.6）。
> 状态：**编写中**（本文件由骨架逐步补全，每核一个建筑补一节；断线时未完成节标 `【待核】`）。

---

## 证据等级定义（本文所有表格均按此标注）

| 标记 | 含义 | 允许的出处 |
|---|---|---|
| 【实机】 | 从 1.5.6 实机桥接会话提取，已与实际游戏行为对拍 | `research/ai-player/facts/building-codes-live.json`（M1b/M2a）、`facts/GEOMETRY-TABLE.md`、`facts/ops-semantics-VERIFIED.md`（M3 / e2e / rv-fix3）、`rv-encoding-fixes.md` |
| 【源码】 | 仅由上游源码读出（文件:行号），未在实机验证 | `recon/upstream-full/src/js/game/**/*.js` |
| 【内嵌表】 | 本仓库已固化的常量表（可能与源码版本或解读有偏差） | `src/ai/belt-rules.mjs`、`src/shared/*` |
| 【未验证】 | 源码中找不到确定答案，或证据互相冲突且无法裁决 | — |

裁决优先级：**实机观测 > 上游源码 > 内嵌表/文档**。冲突一律进入 §4「矛盾清单」，不许和稀泥。

---

## 1. 概述与方法

【待核：说明 code 的内部生成路径（getAllVariantCombinations → internalId → BuildingVariantTiers/getBuildingVariant 反查），槽位读取路径（setupEntityComponents / updateVariants / VariantDefinitions），以及 JSON 的字段语义。】

### 1.1 数据结构（`machine-spec.json`）

【待核：字段表。】

### 1.2 覆盖计数

| 指标 | 数值 |
|---|---|
| 建筑（building key） | 【待核】 |
| 变体（variant 记录） | 【待核】 |
| 含 acceptor/ejector 槽位的变体 | 【待核】 |
| 与实机 code 记录对拍 | 【待核】 |

---

## 2. 逐建筑分节（骨架占位，按 §1.3 清单逐个补全）

<!-- BUILDING_SECTIONS_START -->
【待填：每个建筑一节，含 code 表 / 占地 / acceptor / ejector / 来源 文件:行号 / 实机验证状态 / 备注】
<!-- BUILDING_SECTIONS_END -->

---

## 3. rateMeta / rates 表

【待核：`config.js` 常量 + `hub_goals.js` 升级倍率乘算对象。】

---

## 4. 矛盾清单

【待填：逐条 (a) 三方各自说法 (b) 源码裁决 (c) 影响面。】

---

## 5. 编译器使用注意

【待填：v1 只用 rv=0；underground_belt / wire 的 v1 排除（C3/C4）；`getIsReplaceable` 只有 belt/wire（C1）；goal_acceptor 与 hub 的区别；unlockLevel 兜底常量与 levels.js 出处；belt 的 rv→code 以 `src/ai/belt-rules.mjs` 为权威；非 belt 建筑 rv 无实机证据 → v1 只用 rv=0 硬约束。】

---

## 6. 开放缺口

【待填：非 belt 的 rv 编码方向、BeltComponent.direction 不可读、stride=5 决策、MOD-GAPS。】
