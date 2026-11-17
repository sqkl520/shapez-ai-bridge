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
