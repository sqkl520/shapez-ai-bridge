# L12 开跑前的世界诊断（2026-11-18）

> 存档：`7c93b3dd…`（L12 实验世界，**不是**用户存档）
> 基线快照：`snapshots/l12-baseline-before-agent.bin`
> 产出：**0 / 1000**

## 目标解码

`CbCbCbRb:CwCwCwCw`

按「层 = 8 字符 = 4 象限 × (形状码 + 颜色码)」拆：

| 层 | 象限 | 形状 | 颜色 |
|---|---|---|---|
| 下层 | ×4 | `C` = circle | `b` = blue |
| 上层 | ×4 | `C` = circle | `w` = white |

**注意 `C` 是 circle 不是 cyan，`R` 是 rect 不是 red。** 形状码大写、颜色码小写，
两者在同一个 pair 里相邻出现。这个错误以前让颜料提示一直报错（见 memory
`shape-code-vs-color-code`）。

## 世界现有矿石（`resources` 实测，region ±40）

| 矿 | 格数 | 能直接产出 |
|---|---|---|
| `CuCuCuCu` | 53 | circle 形状、无色 |
| `green` | 41 | green 颜料 |
| `RuRuRuRu` | 38 | rect 形状、无色 |
| `blue` | 19 | blue 颜料 |
| `red` | 16 | red 颜料 |

**白色没有矿。** 目标上层要 `w`，只能由 红 + 蓝 + 绿 三色混合得到。
这是 L12 比前面几关难的根本原因：它要求一条**二级颜料链**
（挖三矿 → 混白 → 再染色），而不只是「挖矿 → 染色 → 送 hub」。

## 现有机器（`obs.stats.by_type`）

```
belt 670    miner 11    trash 6    cutter 3    painter 2
hub 1       stacker 1   rotater 1  balancer 1  mixer 1
```

对照目标需要的链路：

```
CuCuCuCu ──┐
           ├─► cutter(circle) ──┐
blue     ──┘                    ├─► painter(blue) ──┐
                                │                    │
                                │                    ├─► stacker ──► hub
                                │                    │
red + blue + green ─► mixer(白) ─┘                    │
                                                     │
RuRuRuRu ──┐                                         │
           ├─► cutter(rect) ──► painter(white) ──────┘
```

现有一台 mixer 远不够：**至少还要一台**（一台混白，一台供蓝）。
stacker 只有 1 台，勉强够（上下两层各占一个输入）。

## 已知的历史卡点（来自 memory，开跑时别重犯）

- `ORPHAN_MACHINES` 曾把刚放下的矿机当垃圾删掉 —— 已修：站在矿上的矿机不再算孤儿。
- `MIXER_MISSING` 曾因为配方解不出来而整层不跑 —— 已修，现在从「矿石图里缺哪些色码」反推。
- `intoFix` 曾建议改接收器朝向，反而把去 hub 的带子弄少了 60 条 —— 已修，现在先确认下游能活。
- 纯删除的计划会被 `flowsNotApplicable` 豁免 —— 已修，否则删完的东西永远判红。

## 结论

世界不缺矿、不缺带子，缺的是**一条完整的二级颜料链**。
agent 要做的不是「修红点」，而是「补上 mixer 和白料通路」。

## 2026-11-18 首次真 LLM 跑通后的实测结论

凭据接通后 agent 第一次真的跑起来了（`llm_calls` 2–5/run，`tx` 2–3/run，
`apply` 全部 `tx_ok:true`，`applied 7/7`）。它**确实在操作世界**，但 12 轮下来：

| 指标 | 开跑前 | 12 轮后 |
|---|---|---|
| 产出 | 0/1000 | 0/1000 |
| 实体 | 697 | 704 |
| mixer | 1 | **1** |
| stacker | 1 | **1** |
| painter | 2 | **2** |

**机器数一个都没加。** agent 在删带子、改朝向、拆垃圾桶，但从不新建机器。

### 根因：`build_line` 在真实世界里必然失败

`src/agent/macros/build_line.mjs` 的前置条件是 `empty-site` ——
**世界里有任何非 hub 实体就直接拒绝**。文件头自己写着：

> 空地 9/12、真实存档（有既有工厂）0/6 —— 用户场景下为零。

L12 有 704 个实体，所以 `build_line` 100% 被拒。`constants.mjs` 的
`NO_PRODUCTION` 候选表里也明确**不推** `build_line`，理由写得很清楚：

> L12 的世界有 374 个实体 —— 推它等于推一个必然失败的选项，每试一次浪费一轮。

于是 agent 只剩增量宏：`insert_machine` + `connect` + `replace_run`。
这三个能修好「某段带子接错了」，但**拼不出** mixer 混白料这种结构性工程 ——
那需要先把三种矿分别接进 mixer 的两个 color 槽，再从 mixer 接出去染色，
任何一步接错都会让整条链无声失效。

### 实测到的两类失败

1. `L1-landing`：计划里要把 `[35,-42]` 改成 code 3，实际得到 code 1 —— 世界拒绝了改动
2. `L3-flow`：16 格带子没有去处，货会堆在那里
3. `L4-behavior`：0 产出

agent 每轮都在修第 1、2 类，因为它们是**看得见的红点**；
第 3 类（整条链缺失）没有对应的具体红点，只有一句笼统的 `NO_PRODUCTION`。

### 下一步该解决的（按优先级）

1. **给 `NO_PRODUCTION` 一个具体的缺口诊断**，而不是笼统一句。
   像 `MIXER_COLOR_AIMED` 那样直接说「缺一台 mixer / 白料没有来源 / 某个槽没接」。
2. **让 agent 能在「远处空地建线 + connect 接回 hub」**：
   `build_line` 已经支持在空地建，缺的是把它和 hub 连起来的那一步。
   世界在 `(50..90, -20..20)` 有 91% 空地（1538 格），够用。
3. 或者给 `build_line` 加一个「忽略既有实体」的模式，让它只检查目标 region。

**在 1 或 2 落地之前，继续加轮次不会有产出** —— 这个结论 12 轮实测支持。

