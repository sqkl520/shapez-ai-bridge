# 一个真实的设计冲突：报警 vs 施工单，抢同一个名额

2026-11-24。由真机实验发现，主线程记录。**尚未裁决**（已交给存废 Agent）。

---

## 一、事实

`LIMITS = { PER_CODE: 3, TOTAL: 8 }`（`loop.mjs:1567`）。合并后的诊断按 `RANK` 排序，**取前 8 条**。

真机三次独立复现（`.findings/LIVEVERIFY-ALARM-2026-11-24.md`）：

```
r1（无 WORLD_FROZEN）: MACHINE_STARVED,HUB_INLET_THIN,NO_PRODUCTION,BELT_HANDOFF_REJECTED,
                       OUTPUT_STRANDED,CHAIN_UNFED,CHAIN_UNFED,MINER_UNWIRED      ← 8 条
r2（有 WORLD_FROZEN）: MACHINE_STARVED,HUB_INLET_THIN,NO_PRODUCTION,WORLD_FROZEN,
                       BELT_HANDOFF_REJECTED,OUTPUT_STRANDED,CHAIN_UNFED,CHAIN_UNFED
                                                                                  ← MINER_UNWIRED 消失
```

**`WORLD_FROZEN` 精确地抢了 `MINER_UNWIRED` 的最后一格。**

- `MINER_UNWIRED` 说「9 台矿机踩在矿上、输出口是空的」——**一张施工单**（接一下就能出货）
- `WORLD_FROZEN` 说「整图零产出」——**一句报警**（说了也不给动作）

用报警挤掉施工单，是把 8 个稀缺名额花在不产生动作的信息上。

---

## 二、我试过的修法：把 RANK 从 8 挪到 15

**结果它自己永远看不见了。**

因为 `TOTAL = 8` 取前 8 条，排 15 必然被砍。而 `world_frozen.test.mjs` 的 14 条
测试是拿 `diagnose()` 的**最终输出**断言的 —— 现在 14 条全红。

```
✖ 死世界必须报 WORLD_FROZEN，实得 MACHINE_STARVED,HUB_INLET_THIN,NO_PRODUCTION,
  BELT_HANDOFF_REJECTED,OUTPUT_STRANDED,CHAIN_UNFED,CHAIN_UNFED,MINER_UNWIRED
```

**两个要求互相排斥：**
- 要保住 `MINER_UNWIRED` ⇒ `WORLD_FROZEN` 排后面 ⇒ 它自己被砍
- 要让 `WORLD_FROZEN` 可见 ⇒ 它排前 8 ⇒ 挤掉 `MINER_UNWIRED`

---

## 三、三个候选（待裁决）

### A. 并进 `NO_PRODUCTION` 的 observed

`NO_PRODUCTION` 已经说了「窗口内目标产出 0（delivered 0/1000）」。
把「全图零产出 + 淤积最重的那条」并成它的一句，`WORLD_FROZEN` 这个码整个删掉。

- 收益：不占名额、不撒谎
- 代价：丢掉「全图」与「目标」的区别（目标零产出 ≠ 全图零产出）
- 风险：`observed` 会被 `compact(…,120)` 截断，塞不进去两句

### B. 条件 RANK

当诊断池里有可施工的码（`MINER_UNWIRED` / `MACHINE_STARVED` / `CHAIN_UNFED`）时降到 15（被砍）；
没有时才用 8。

- 收益：两种情况都照顾到
- 代价：排序逻辑变复杂
- **风险（重点）**：`fingerprintOf` 会因此抖动 —— 同一份世界可能因为别的诊断出现与否
  而改变指纹，而「同世界同指纹」是 `SAME_FINGERPRINT_MAX` halt 判据的基础。
  **这条必须先查。**

### C. 删掉 `WORLD_FROZEN`

- 收益：干净
- 代价：失去「全图停转」这个事实的唯一来源
- 前提：确认 `NO_PRODUCTION` + `MACHINE_STARVED` 真的覆盖了它的信息

---

## 四、这一轮暴露的更深的问题

**「诊断值不值得占名额」这件事，项目从来没有判据。**

`RANK` 是手工维护的一张表，每个码的分值靠人判断，而且**加了新码之后没人量过它挤掉了谁**。
真机实验是第一次把这个副作用量出来（`WORLD_FROZEN` → `MINER_UNWIRED`）。

⇒ 应该有一个常驻的检查：**在真实快照上，任意两条诊断的 RANK 相邻时，
加一条会不会挤掉另一条**。现在没有。