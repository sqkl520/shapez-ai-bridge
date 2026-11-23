# WORLD_FROZEN 红队报告 —— 我尝试推翻它，找到了 3 个 blocker

2026-11-23。**全程离线，没碰游戏**（只读 `research/ai-plan/runs/` 的 567 个落盘快照 + `src/`）。
临时脚本在 `.tmp-redteam/`（跑完会删）。没有 `git stash/commit/push/checkout/reset`。

> ⚠️ **重要前提**：我开工时 HEAD 是 `a532239`，收工时 HEAD 已经是 `36f93c8`
> （期间落了 `0d9546e` / `f30bcdb` / `cb3c0a5` / `36f93c8`）。`f30bcdb` **改了 `WORLD_FROZEN` 本体**
> （句柄从末端 6 格改成源头 3 格、hint 重写）。**本报告的全部结论都在 `36f93c8` 上复测过**
> （`git diff --stat a532239..HEAD` 之后重跑了每一个判定）。测试现状：8 条全绿。

## 总判定

| # | 攻击角度 | 判定 |
|---|---|---|
| 1 | 误报：活世界被报 | **不成立**（50 个活世界、真实产出窗口下 0 误报）。但**有一个附带的真缺陷**：判据把「窗口空」当「世界死」，见 §1.3 |
| 2 | 预算挤占 | **成立**（部分）。同一条诊断，`## CAPACITY` 在 516 个快照里被它挤掉 66 次 |
| 3 | hint 被截断 | **部分成立**。动作在 180 内完整，但「另有」清单被切在半个括号里 |
| 4 | RANK=1 压掉更紧急的 | **不成立**。rank=4 与 rank=1 在 516 个快照上**8 条结果完全一致**（只是顺序换成 `HUB_FED_BY_COLOR` 打头） |
| 5 | `path.cells` 可信吗 | **不成立**（索引对齐 523/523），但**截断时严重低估**（17 个样本里 10 个漏报了更重的路径） |

**三个 blocker**（都不在上面的 5 个角度里，是我在攻击过程中撞出来的）：

- **B1**：这条诊断建议的动作，在 516 个零产出快照上**没有一次让世界变好**（0/516 reach 改善）。
- **B2**：`no_acceptor` 分支的判据是假的 —— 4/4 的「末端无人接收」末端**有**带子。
- **B3**：`fill` 用 `Math.floor(cells/0.63)` 当容量，**132/516 的快照报出 >100% 的满载率**（最高 103%）。

我尝试推翻它，**没能推翻「世界真的死了」这件事**（§1 的判据本身是对的），
但**推翻了「它给出的动作有用」这件事**（B1）。后者才是这条诊断存在的理由。

---

## 攻击 1｜误报：活世界被报

**判定：不成立**（就「活世界会不会被误报」这个提法而言）。
另有 **§1.3 一个真缺陷**（判据把「窗口空」当「世界死」）。

### 证据 1.1：50 个「确实在产出」的快照，两次判定

```
$ node .tmp-redteam/attack1b.mjs
healthy snapshots: 50
fired with REAL production window: 0
fired with EMPTY window (post-load surrogate): 50
```

50 个 `produced_total > 0` 的快照，用它们**落盘的**产出窗口，`WORLD_FROZEN` **一次都没报**。
判据 `if (prod && !anyProduced)` 的行为与测试 `★ 反例：世界还在动的时候一律不报` 一致。

### 证据 1.2：同一座工厂，两种产出口径

用 `world_hash`（实体集合的指纹）做对照组 —— **同一座工厂**：

```
$ node .tmp-redteam/attack1c.mjs
distinct world_hashes: 1069
hashes shared across runs with BOTH produced>0 and produced==0: 1
  fnv1a64:397a87a238661194:n=685  [{"d":"r-20261112190707-de26","prod":66},{"d":"r-20261112193013-99fb","prod":0}]
```

`de26` 与 `99fb` 是**同一个世界**（同一个 hash、`n=685`），一个报 66 件产出、一个报 0。
原因不是误报 —— `de26` 确实在产（timeline：`带上货 139→169`），而 `99fb` 时它真的停了
（timeline：`带上货 279`，ejector 全卡）。所以这一个是**真变化**，不是判据抖动。

### 证据 1.3（真缺陷）｜判据把「窗口空」当「世界死」

`ProductionAnalytics` **不写进存档**（`recon/upstream-full/src/js/savegame/savegame_serializer.js:24-40`
的 dump 里没有 `productionAnalytics`；`core.js:127` 每次 `new ProductionAnalytics(root)` 造一个全新的）。
`observeProduction` 取的是 `pa.history[key].slice(-N)`，而**刚构造出来的 history 是 100 个空片**
（`production_analytics.js:30-53`，构造函数里 `startNewSlice()` 循环 100 次）。

也就是说：**`load_save` 之后的头 10 秒，`produced_total` 必然是 `{}`，与世界的死活无关。**

实测这个时窗是真实存在的（`run_start → 第一次 observe` 的间隔）：
- 567 个快照里 **41 个 < 2 秒、18 个 < 1 秒**（最短 82ms）；
- 有一条真机健康快照 `r-20261115222228-3d57`（L12，`produced_total={"CuCuCuCu":1}`，
  `produced_slices = [{"CuCuCuCu":1},{},{},{},{},{}]` —— **6 片里只有 1 片有货**），
  它的 `run_start→observe` 间隔 3.2 秒。

用「空窗口」当替身把 50 个活世界全跑一遍（上面 1.1 的第二行）：**50/50 全部误报**，
而且报出来的东西长这样：

```
"整图零产出；22 条带子满载或无处可去，最堵的一条 66 件 / 42 格（100%，RuRu----×66）"
subject {"handle":"B414","type":"belt","uid":11747}
```

—— 一个**每分钟都在交出 61 件成品**的世界，被提醒「整图零产出，最堵的一条 66 件满载」。
26 个真机 run 的间隔 < 1 秒（同一份快照、同一个 hash、`produced_slices` 全 6 片），
那些 run 的**第一轮** `diagnose()` 就会看到 `produced_total={}`。

**后果**：若在 `load_save` 之后立刻起 loop（`tools/run-level.sh` 的串联、`snapshot_load` 后接 run），
第一轮就是一条 rank 1 的 blocker「整座工厂零产出」。它会：
① 占掉 8 条诊断的一个名额（且是第 1 条）；
② 挤掉 `## CAPACITY`（见 §2）；
③ 把模型推向「拆掉那条 66 件的带子」—— 而那个世界正在正常运转。

**修法（最小）**：`produced_slices.length < N` 或 `slices_returned < 3` 时不判 —— 与现有
`prod === null ⇒ 不报` 是同一条纪律（「观测不全 ⇒ 不报」）。或者要求窗口里**至少一个片存在**
（`produced_slices.some(s => Object.keys(s).length)`），空片 = 没数据，不是零产出。

---

## 攻击 2｜预算挤占

**判定：成立（部分）**。带子反而多了（神志上是对的），但**别的段确实被挤掉**。

### 证据 2.1：旗舰快照，逐段对比（当前代码）

```
$ node .tmp-redteam/promptAB.mjs
with   : chars 18860 belts_shown 18
without: chars 18308 belts_shown 16
```

| block | without | with |
|---|---|---|
| `s3_belts` | 1019 | 1135 |
| `S4`（诊断段整体） | 2162 | 2636 |
| **`s3_hub_stored`** | **`str(...)`（存在）** | **`null`（消失）** |
| `s3_capacity` | 存在（265） | 存在（265） |
| `s3_machines` | 存在 | 存在 |

旗舰快照上**丢的是 `## HUB stored`**（那段能一次性排除整条 L11 遗留产线），
而任务书里点名要看的三段（CAPACITY / RECIPE / PRIOR ATTEMPTS / 矿机行尾标注）在这一个快照上都还在。
所以单看旗舰样本，攻击 2 够不上 blocker。

### 证据 2.2：516 个快照的横向统计（干净隔离，两组都是 8 条诊断）

用未截断诊断副本（`.tmp-redteam/loop_nocap.mjs`，`TOTAL=999`）拿全量表，两种情形都过 CAP=8：
A = 保留 WF，B = 把 WF 从表里删掉（让真正的第 9 条补进来）。

```
$ node .tmp-redteam/isolate_full.mjs
rows 516
WF occupies a slot that another code would use: 432
CAPACITY lost by WF: 66 gained: 10
HUB stored lost: 6 gained: 3
MACHINES shortened: 182
over-budget only with WF: 10
belts: A>B 106 same 62 A<B 348
```

- **`## CAPACITY` 在 66/516 个快照上被它挤掉**（`capacity_unavailable: "dropped-for-budget"`），
  而 CAPACITY 是本仓库实测 p≈5e-7 的信息源（`prompt.mjs` 里那段长注释）。
- 10 个快照**因为加它而从「不超预算」变成 `PROMPT_OVER_BUDGET`**（那是 `outcome:INTERNAL` 硬停）。
- 348 个快照带子反而**变少**（中位数少 2 条，最多少 12 条）——
  因为它把 6 个句柄塞进 `evidence.handles`，`pickBelts` 先给它们留位，
  于是「诊断名额保底」从 4 涨到 6，走廊里那几条正解带子让位。

### 证据 2.3：423 个诊断被它挤掉

被挤掉的不是「同类的重复」，而是**别的成因码**（B 组里出现、A 组里没有）：

```
displaced codes: { ORE_UNMINED: 124, MINER_UNWIRED: 125, MIXER_COLOR_AIMED: 112,
                   CHAIN_UNFED: 49, OUTPUT_STRANDED: 13, TRASH_OVERGROWN: 3,
                   SHAPE_UNKNOWN: 5, DEAD_END: 1 }
```

`MINER_UNWIRED` / `ORE_UNMINED`（rank 11）和 `MIXER_COLOR_AIMED`（rank 12）都是**成因**码，
不是症状。而 `WORLD_FROZEN` 说「先通开」，它们说「缺这一步工序 / 矿机没接线」——
在冻结世界里，后者更接近唯一可行的施工顺序（§B1 会证明「先通开」其实没解决任何问题）。

**后果**：`world_frozen.test.mjs` 只覆盖 1 个世界（`52a3`），没测过「加了它之后 CAPACITY 还在不在」。
在 516 个快照里，**66 次 CAPACITY 消失、10 次硬超预算**都是静默的（有 `blocks` 字段可以观测，
但没有一条测试看它）。

---

## 攻击 3｜hint 被截断后的可读性

**判定：部分成立**。动作（`remove_run` + 源头端句柄）**完整地在 180 内**，
但「另有」清单被切在**半个括号里**，且更长的 `no_acceptor` 分支同样如此。

### 证据 3.1：动作完整

```
$ node .tmp-redteam/hint_branches.mjs / 直接渲染
full len 208 | clipped len 180
CLIPPED: 整座工厂零产出。这条带子 259 件（99%）堵死 —— `remove_run` 它的**源头端** B522,B521,B520
（从末端切会让上游 165 格失去通路，预演必拒）。**先通开，再谈接上**：不疏通的话，接进去的货
一样出不来。（`trash_unused` 在这里没用 —— 它不接已有下游的带子。）另有：87 件 / 55 格（末端无人接…
LOST   : "）；3 件 / 2 格；0 件 / 1 格（末端无人接）。"
```

第 180 个字符落在 **`（末端无人接…`** —— 一个**开了没关的括号**，后面三项全丢。
这是「话说到一半」的教科书形态：模型读到「另有：87 件 / 55 格（末端无人接…」，
会以为清单就到这儿，或者被那个未闭合的括号迷惑。

### 证据 3.2：更长的 `no_acceptor` 分支同样断在半句

```
full len 225
CLIPPED: …这条线末端本来就没有接收方，（`trash_unused` 在这里没用 …
LOST   : "件 / 19 格；24 件 / 15 格（末端无人接）；14 件 / 9 格（末端无人接）。"
```

这里断得更糟：`这条线末端本来就没有接收方，` 后面紧跟 `（`trash_unused` …` —— 
**两个半句缝在一起**，读起来像「末端没有接收方，垃圾桶没用」。语义上勉强对，语法上是碎的。

### 证据 3.3：前 180 字符里**没有**关键数字

模型在 12 样本实验里 **0/12 复述过 259 / 165 / 99%**
（`.findings/VERIFY-WORLD-FROZEN-2026-11-23.md` 已实测）。
hint 把「259 件（99%）」写在第 8 个字符 —— 数字进 prompt 了，没进推理。
这不是截断的问题（数字在 180 内），是**排位**的问题（数字和动作挤在同一句里）。

**后果**：动作可用（`remove_run B522,B521,B520` 在 180 内、且 12/12 落地），
但「另有 N 条也在堵」这层信息**从来没到过模型**。
516/516 个触发样本都带 `另有：` 清单，平均 **3.0 条**别的堵点，全部落在 180 之后。

---

## 攻击 4｜RANK=1 是否压掉了更紧急的诊断

**判定：不成立**。

### 证据 4.1：rank=1 与 rank=4 的 8 条结果**完全一致**

用未截断副本拿全量，两种排序都过真实 CAP（每码 3、总量 8）：

```
$ node .tmp-redteam/rank_attack（.tmp-redteam/rank_diff.json）
firing snapshots 516 | cap-8 result differs rank1 vs rank4: 516
codes present at rank1 but displaced at rank4: {}
```

`differs: 516` 听起来是「全变了」，但 `displaced: {}` 是空 ——
**516 个样本的 8 条组成完全相同，只是顺序换了**：

```
 r1: WORLD_FROZEN, HUB_FED_BY_COLOR, MACHINE_STARVED, NO_PRODUCTION, …
 r4: HUB_FED_BY_COLOR, MACHINE_STARVED, WORLD_FROZEN, NO_PRODUCTION, …
```

所以「把 rank 改回 4 会砍掉谁」的答案是：**一个都不砍**。
rank 4 与 `HUB_INLET_THIN` 同级、按 code 字典序排，`HUB_*` 在 `WORLD_*` 之前 ⇒ WF 落到第 3 位。

### 证据 4.2：那「被压掉更紧急的」这个假设立得住吗

找不到证据。516 个零产出快照里：
- `WRONG_SHAPE_AT_HUB`（rank 1）与 WF **同时出现 0 次** —— 没有可比较对象；
- `MIXER_UNFED`（rank 2）与 WF 同时出现 0 次；
- `HUB_FED_BY_COLOR`（rank 3）与 WF 同时出现 **488 次**，但它排在 WF 之后（rank 3 > 1），
  改到 rank 4 之后它反而**排到 WF 前面**（见上面 r4 的顺序）。

也就是说：**现有数据里没有任何一个「比 WF 更紧急的码」被它挤掉。**
rank 1 的真实作用是把 WF 放到第 1 行（注意力第一位），
而顺序对 8 条组成无影响。

**后果**：rank 1 不是缺陷。它只是「把一条有用的诊断放到最显眼的位置」，
而 §B1 会证明这条诊断的**内容**有问题 —— 那才是要修的地方，不是 rank。

---

## 攻击 5｜`path.cells` 在 `truncatedPaths=true` 时可信吗

**判定：不成立**（就「索引对不对」而言），但**截断造成系统性低估**（下面 5.2）。

### 证据 5.1：索引对齐 523/523

```
$ node .tmp-redteam/attack5.mjs
alignment: snapshots checked 523 with mismatches 0 []
```

`items.belts[].path` 与 `items.paths[]` 的下标**一字不差**（523 个非截断快照、逐条核对每条带子的
`cell` 都在它声明的 `path.cells` 里）。所以「`paths[i].cells` 与 `belts[].path` 对不上」这个担心不成立。

### 证据 5.2（真缺陷）｜截断时**漏报**更重的路径

`out.paths = paths.slice(0, 40)`（`shapez-ai-bridge.js:1141`），而 `belts[]` **是全量的**
（只按 region 过滤，不按 path 过滤）。于是 `clogged` 的扫描循环只走到 40 条，
**第 40 条之后的路径完全看不见**，但它们身上的货**照样被算进 `items.belts`**。

```
$ node .tmp-redteam/attack5b.mjs
truncated + zero-produced + WF fired: 17
hidden path carries MORE items than the reported worst (UNDER-REPORT): 10
{"id":"r-20261113084958-4e86","pathCount":50,"shown":40,
 "reportedWorst":31,"hiddenPath":49,"hiddenItems":166,"reportedClogged":21,
 "observed":"整图零产出；21 条带子满载或无处可去，最堵的一条 31 件 / 19 格（103%，RuRuRuRu×31）"}
```

**10/17 的快照里，真正最堵的那条路径被切掉了，诊断报的是可见范围内的一条 31 件 / 19 格。**
`observed` 里的「最堵的一条」**是错的** —— 有一条 166 件的被切在 40 之外。
`clogged_paths` 的 21 也是少报（全量下至少 22）。

更糟的是：这 10 个样本的 `codes` 里**都没有 `PATHS_TRUNCATED`**：

```
truncated WF-firing: 17 | PATHS_TRUNCATED in codes: 0
```

`observeOnce` 会产一条 `PATHS_TRUNCATED`（`loop.mjs:606`），但它在 rank 0，
按 `LIMITS.TOTAL=8` 早该被保留 —— 实测 17 个样本**一条都没有**（被 `dropInlets` /
合并阶段吞了，原因不在本次攻击范围）。结果是：**模型既看到一句错的「最堵的一条」，
又收不到「数据被截断了、别信」这条警告。** 这是 `computed-but-never-delivered` 的标准形态。

### 证据 5.3：`cells.length` 会不会失真

不会。被截断的只是**路径条数**，每条路径的 `cells` 是完整的 `entityPath`
（`paths.slice(0,40).map(p => ({cells: p.entityPath…}))`）。
`capacity = floor(cells/0.63)` 对**被看见的**路径是准的（见 §B3 对公式本身的质疑）。

**后果**：在 17 个真机快照（`pathCount` 41–54）上，「最堵的一条」这个**最硬的证据字段**是错的，
而且是最严重的那个方向（**低估**）。

---

## B1（blocker）｜这条诊断推荐的动作，没有一次让世界变好

**判定：成立（blocker）**。这是我最想推翻、但推翻不了的一条。

### 证据 B1.1：照 hint 做的 516 个世界，0 个变好

对每个触发快照，取 `wf.handles`（即 hint 里点名要 `remove_run` 的那 3 格），
直接从 obs 里删掉这 3 个实体，算 `worldHealth` 前后：

```
$ node .tmp-redteam/sim_all_src.mjs
simulated: 516 skipped: 0
net-effect kinds after following the hint: { cleanup: 30, regressive: 486 }
cases where reach to hub IMPROVED: 0
cases where reach to hub WORSENED: 486
reach delta min/median/max: -30 -3 0
```

- **0/516 让「到 hub 的带子」变多**；
- 486/516 让它**变少**（中位 -3 条）；
- 30 个 `cleanup` 全是「reach 不变、死带子减少」—— 清理，不是产出。
- **没有任何一个样本出现 delivered / stored_goal 上升。**

（这 516 个动作里只有 1 个样本的 hint 还真是 `no_acceptor` 分支，见 B2。）

### 证据 B1.2：真实的死锁链，hint 打在了症状上

`r-20261123151728-52a3` 逐跳追（几何全部用 `slotsOf`/`exitCellOf` 算，没手推形状）：

```
painter#13552  (-5,14) r=90
  in shape ← belt#14838  (货 0)
  in color ← 空格 (-4,15)        ← 真正的断点
  out      → belt#14977 = path14 的头 → …16 格… → 喂 stacker#14684 的 lower 槽（货 0）

stacker#14684  lower ← path14（货 0）        ← 等这一路
               upper ← path8（货 259）       ← hint 要拆的就是这一路

path8 头 B522 ← miner#16204（挖 blue 颜料）
path8 尾 B90  → stacker upper
```

**painter 缺 color ⇒ 不喷 ⇒ path14 恒空 ⇒ stacker 两路只来一路 ⇒ 不吐货 ⇒ path8 淤 259 件。**
`WORLD_FROZEN` 建议删 path8 的**源头** —— 它拆的是**淤积的那条**，不是**堵住的那条**。
唯一能解开死锁的动作是给 painter 的 color 槽接料（`connect … to C3.color`），
而那正是 `MACHINE_STARVED` 的 hint 指的地方。

### 证据 B1.3：删了源头之后，堵点还在

```
$ node .tmp-redteam/sim_ends.mjs
SRC-REMOVE (hint) uids 16871,16870,16869  {"reach":306,"dead":390,"belts":696}
   在途物品落在被删 3 格上的件数: 4 / path8 总计 259
=> 剩下 255 件仍然堵在 path8，stacker 依然缺 lower 路
```

删掉的那 3 格上只有 4 件货；**255 件原封不动**。stacker 还是缺一路，painter 的 color 槽还是空的，
整图还是零产出。`VERIFY-WORLD-FROZEN` 的 E 臂实测同款：`remove_run B522` 判词 = **churn**。

而且它把链接断了：

```
$ node .tmp-redteam/sim_ends.mjs
SRC: regressive（到 hub 的带子 309→306）
END（旧版末 6 格）: regressive（309→144）
```

两臂**都是 regressive**。新代码把「被闸门拒掉」修成了「能落地」，但**没修「落地之后没用」**。

### 证据 B1.4：hint 里那句话本身是错的

`accepted` 分支的 hint 说「末端那台机器在等另一路料、永远等不到」。
用 `slotsOf` 核实 512 个 `accepted` 样本的末端机器：

```
$ node .tmp-redteam/harm2.mjs
firing: 516 | tail lands on a machine input: 512
acceptor machine types: { mixer: 2, cutter: 19, stacker: 452, hub: 39 }
hint claim 'machine is waiting for the other input that never comes' holds: 452 / 512
CLAIM FALSE: machine's other input IS fed: 41
CLAIM N/A: machine is single-input: 19
```

- **19 个样本的末端是 cutter（单输入）** —— 机器类型统计里 `cutter: 19` 正好对上
  `multiInput=false` 的那 19 个，「在等另一路料」这句在几何上不存在；
- **41 个样本的另一路进料是有货的**（其中 39 个末端是 hub 本身：`hub: 39`）——
  hub 有 16 个入口，报「hub 在等另一路料」是荒谬的。
- 真正成立（「另一路确实空着」）的是 **452 个 stacker + 2 个 mixer = 454 个**，
  也就是 `onlyFeed && multiInput` 那 452 个加上末端机器类型为 `stacker`/`mixer` 且槽不全的队伍。

**后果**：这是本仓库「错误的指路比不给更贵」（`feed-sources-need-two-filters`）的又一次复发。
模型 12/12 一字不差照抄了 hint 给的句柄（指路能力满分），
但那 12 个动作落地后 12/12 判词是 churn/regressive。
**诊断说对了病因（缺一路），给了治标的动作（拆掉另一路）。**

---

## B2（blocker）｜`no_acceptor` 判据是假的

**判定：成立（blocker，但只影响 4/516 个样本）**。

`boundAcceptor === null` 被当成「末端没有机器接收」。核实质心：

```
$ node .tmp-redteam/noacc_falsify.mjs
firing: 516 | no_acceptor branch: 4
--- NO_ACCEPTOR branch: is the exit cell really empty? ---
  exit cell OCCUPIED by an entity: 4 / 4 ← 判据假阳性
    r-20261112194710-c92a L9 tail belt r90 exit [35,-11] → belt r0 machine? false
```

4/4 的「末端无人接收」**末端有带子**。真相是**两条带子方向错位**：

```
$ 逐跳核实（r-20261112194710-c92a）
tail belt 11885 r=90 exit [35,-11]
neighbour belt 11963 r=0  at [35,-11]  entry [35,-10] exit [35,-12]
=> 邻居接受方向是 [35,-10]，我们的出料格是 [35,-11] → 差一格，收不到
```

游戏自己的 `boundAcceptor` 用 `computeAcceptingEntityAndSlot()` 判的也是这个
（`belt_path.js:236-256`：`ejectSlotWsDirection === beltAcceptingDirection` 才收），
所以 **`null` 的真实含义是「相邻那条带子的朝向不对」，不是「没有接收方」**。

hint 因此说「这条线末端本来就没有接收方」，并把模型推向
`connect 把它接到该去的地方` / `remove_run 整段拆掉`。而**真正的修法是一格旋转**：

```
$ replace_run {region:[35,-11,35,-11], building:"belt", opts:{facing:"left"}} → ok: true
```

一个 `replace_run`（1 格）就能让这条 166 件的路径接上 neighbor path40（79 件）。
诊断却建议拆掉整条 106 格的线。而 `trash_unused` 落在这条末端时被拒：

```
$ trash_unused({outlet:{uid:11885}})
{ "ok": false, "code": "precondition_failed",
  "message": "带子 uid=11885 的出口那一格有带子 uid=11963，但它的 entry 不朝这条带子" }
```

—— 宏自己说得比诊断清楚。

**后果**：4 个真机样本上，模型会去拆一条**本来一个旋转就能救活**的线。
判据把「朝向错」读成「没有接收方」，动作从「转一格」放大成「拆 106 格」。

---

## B3（blocker）｜`fill` 公式会报出 >100% 的满载率

**判定：成立（blocker，影响面 132/516）**。

`capacity = Math.max(1, Math.floor(cells / 0.63))` —— 这是「格数 ÷ 每件间距」，
而**一条路径的可用长度不是 `cells × 0.63`**：弯带的 `getEffectiveLengthTiles()` 是 **0.78** 而不是 1.0
（`components/belt.js`，mod 的 `debugItems` 自己也用这个值算 `cellAt`），
而且 `spacingToFirstItem` 允许最后一格**多塞一件**（游戏自己就是这么判的，
`canAcceptItem()` 只看 `spacingToFirstItem >= itemSpacingOnBelt`）。

结果就是报出**物理上不可能的满载率**：

```
$ node .tmp-redteam/normalize.mjs
path 30 cells 19 items 31 code-capacity 30 code-fill 1.03
pos span 18.9 spacingToFirstItem 0.1 implied max items @0.63: 31
=> 用 0.63 间距算真正上限约 31，而代码报容量 30
observed: …最堵的一条 31 件 / 19 格（103%，RuRuRuRu×31）
```

```
$ 516 个触发样本
firings printing fill>100%: 132 / 516（最高 103%）
```

模型读到的是「**103%** 满载」。一个整数百分比超过 100 只会产生两种反应：
① 不信这个数（于是连 259 件这个真数字一起打折）；② 以为算术坏了。
`observed` 和 `hint` 里都印了它：

```
"整图零产出；21 条带子满载或无处可去，最堵的一条 31 件 / 19 格（103%，RuRuRuRu×31）"
"整座工厂零产出。这条带子 31 件（103%）堵死 —— …"
```

**后果**：`fill` 是这条诊断的**核心判据之一**（`fill >= 0.85`），
而它的分母在最常见的弯带路径上是错的（用 1.0 而不是 0.78 ⇒ 低估容量 ⇒ 高估满载）。
`31 件 / 19 格（103%）` 这个数会让模型把「这条线满载」的结论打折扣。

---

## 试过但没打穿的路径（也算结论）

- **判据本身**：`produced_total` 为空这个信号在 516 个真机样本上**全部可复现**
  （`itemsOn > 0` 的同时 `produced==0` 有 516 个，`ejectors` 全卡的有 516 个）。
  这不是判据抖，是世界真的停了。
- **「矿机还在产」**：`miner.js:77` 的 `itemProduced` 派发**不过滤 item 类型**，
  但 `production_analytics.js:47` 的 `onItemProduced` **只统计 `getItemType() === "shape"`**。
  于是颜料矿机在动、`produced_total` 仍然空 —— 这是**设计如此**，不是缺陷
  （L12 的失败正是「颜料在流、形状一件不出」）。
  103 个快照里有 ejector 处于 `0 < progress < 0.99`（真的在推），全是 `miner`/`mixer` 的
  `blue`/`green`/`red` **色料** —— 与「零**形状**产出」不矛盾。
- **`dropInlets` 再吞一次**：`subject` 指源头端之后，516/516 的 WF 都活着；
  516/516 的 `handles` 里**没有**残留 hub 入口带（`inlet.json`：`still carrying hub-inlet handles: 0`）。
- **`subject` 与 `handles` 方向相反**：`subject` 与 `handles[0]` 一致（516/516，`subj.log`）。
  这个 bug 已经被 `f30bcdb` 修掉了。
- **PATHS_TRUNCATED 在 17 个样本里一条都没出现** —— 这是个独立缺陷（rank 0 的诊断不该被压掉），
  但成因在 `dropInlets` / 合并阶段，不在 `WORLD_FROZEN` 里。已记在 §5.2。

---

## 建议的修法（按重要性）

1. **B1（最重要）**：在 `accepted` 分支下，不要把 `remove_run` 作为第一动作。
   链接尽头是**多输入机器**且它**另一路还有货**时，正确的动作是接另一路
   （与 `MACHINE_STARVED` 重合，那就不该重复报）。
   只在 **`no_acceptor` 分支**（且已按 B2 修正）或 **末端机器所有输入槽都空** 时才给 `remove_run`。
2. **B2**：`boundAcceptor === null` 改成「exit 格上有没有朝向本格的接收方」；
   若邻居是带子但朝向错，动作应是 `replace_run` 转一格，不是拆整条。
3. **B3**：`capacity` 用真实长度（弯 0.78 / 直 1.0）算，或者干脆用
   `itemsOnPath`（游戏自己数的）当「装载量」的上限，别自己发明第二个口径。
4. **§1.3**：`produced_slices` 全空 / `slices_returned < 3` ⇒ 不判（观测不全 ⇒ 不报）。
5. **§2**：加一条 `prompt` 级回归测试 ——「加了 `WORLD_FROZEN` 之后 `s3_capacity` 不许丢」。
   现在只有 `world_frozen.test.mjs` 的 1 个世界，看不到 66 次 CAPACITY 消失。
6. **§5.2**：`clogged` 扫描要覆盖 `pathCount` 而不是 `paths.length`；做不到时**不许**打印「最堵的一条」。

## 一句话

**判据是对的（世界真的死了），rank 是对的（不挤别人），索引是对的（523/523 对齐）。**
**但证据字段有假（B2/B3）、动作打偏了（B1，0/516 变好）、
以及在数据不全时会拿「窗口空」当「世界死」（§1.3，50/50 活世界会被误报）。**
这条诊断现在能成功地让模型去拆一条带子 —— 而拆完之后世界还是零产出。

---

# 追加：写完报告之后，`src/` 被改了三次 —— 每个判定在最终代码上复测

我刚写完上面那份报告，仓库就在我脚下动了三次：

```
0d9546e  docs（根因报告）
f30bcdb  fix：端口角色同向歧义 + WF 句柄改源头端   ← 我开工时就在改
cb3c0a5  docs（三处代码缺陷）
36f93c8  docs（path20 判读修正）
cffec58  fix：评分把「越堵越干净」当成改善
7538432  docs
910bf7c  fix(diag): WORLD_FROZEN 红队找到 3 个 blocker ← 引用我的报告，按 B1/B2/B3 修的
```

`910bf7c` 把我上面报的三个 blocker **全按我建议的方向修了**，并且**顺手删掉了我的 `.tmp-redteam/`**
（所以我重建了脚本，见每个复测段落）。这不是我干的，也不是我说了算 ——
但既然代码变了，**每一个判定都必须在最终代码（HEAD=`910bf7c`）上重新核一遍**。
下面是复测结果，**上面正文里的「判定」行按最终代码更新**（正文保留当时的原始证据，不改）。

复测脚本：`.tmp-redteam/final_check.mjs` / `.tmp-redteam/residual.mjs`（在 `research/ai-plan/runs` 的 567 个快照上跑；
「第一轮/第二轮」用 `report=null` vs `report={checks:[]}` 来区分）。

## 复测结果对照

| 角度 / blocker | 报告时（`36f93c8`） | 最终代码（`910bf7c`） | 现在还算不算 |
|---|---|---|---|
| §1 误报（真实窗口） | 活世界 0 误报 | 活世界 **0 误报**（同一批 50 个） | 不成立，稳定 |
| **§1.3 空窗口误报** | 50/50 会误报 | **第一轮拦住；第二轮及以后仍然 50/50 会误报** | **仍然是一个缺陷**（见下） |
| §2 预算挤占 | CAPACITY 丢 66/516 | **抽样 1/25：CAPACITY 丢 8/20**（≈ 40%，与 66/516 同量级） | **仍成立** |
| §3 hint 截断 | 208 → 180，尾巴丢 | **515/516 的 hint > 180，尾巴仍被切** | **仍成立**（但内容变了，见下） |
| §4 RANK | rank=1 vs 4 结果相同 | **rank 改成 8**（`loop.mjs:1380`）；实测落位 **第 4/5/6 位** | 不成立（结论不变） |
| §5 路径索引 | 523/523 对齐 | **仍 523/523 对齐** | 不成立，稳定 |
| §5.2 截断漏报 | 17 个里 10 个漏报 | **未修**（`itemsDoc.paths.entries()` 仍只看前 40） | **仍成立** |
| **B1 处方无效** | 0/516 变好 | **hint 不再开处方**（改成「这是结果，不是成因，别从它下手」） | **已修**（不过动作本身的行为没变，见下） |
| **B2 no_acceptor 假** | 4/4 末端有带子 | **`fill>1` 0 个、`no_acceptor` 分支 0 个** | **已修** |
| **B3 fill >100%** | 132/516，最高 103% | **0 个，max fill = 1.00** | **已修** |

最终代码上 `WORLD_FROZEN` 的落位分布（516 个零产出快照，第二轮及以后）：

```
slot distribution: {"4": 410, "5": 87, "6": 19}
```

也就是它现在**永远排在第 4~6 位**（在 `MACHINE_STARVED` / `HUB_INLET_THIN` 等成因码之后），
符合 `910bf7c` 把 RANK 改成 8 的意图。这一点是对的。

## 复测 §1.3：第一轮拦住了，但第二轮及以后 **仍然 50/50 误报**

`910bf7c` 加的门是：

```js
const isFirstRound = !opts || opts.report === null || opts.report === undefined;
const windowReady = !(isFirstRound && slices !== null && filledSlices === 0);
if (prod && !anyProduced && windowReady) { … }
```

注释里的推理是「第一轮的空窗口可能只是预热，第二轮及以后至少过了两轮之间的全部时间」。
但实测两轮之间的间隔**并不总是够 10 秒**：

```
$ 2203 个 round-2..n 的 observe 间隔
min 0.1s  p10 7.1s  median 16.6s  |  间隔 < 10s 的: 560 / 2203（25%）
```

**四分之一的轮次间隔不到一个统计片（10 秒）**。`ProductionAnalytics.update()` 只在
`now - lastAnalyticsSlice > 10` 时轮转一片（`production_analytics.js:129`）——
间隔 < 10 秒时，窗口里**所有片都还是旧的、且当前片可能就是刚被清空的那一片**，
`produced_total` 依然会是 `{}`。

复测（把健康的 50 个世界喂一个空窗口 + `report` 非空，模拟「第二轮」）：

```
$ node .tmp-redteam/residual.mjs
RESIDUAL §1.3: healthy snapshots 50 | still fire in round-2+ thin window: 50
   {"id":"r-20261110143303-686b","lvl":9,"realProduced":266,"wf":66}
   {"id":"r-20261110143452-81a6","lvl":9,"realProduced":281,"wf":66}
   {"id":"r-20261110144549-23b4","lvl":9,"realProduced":278,"wf":66}
```

**50/50 仍然会报。** 那个世界每分钟交出 266–291 件成品，被报「整图零产出；最堵的一条 66 件」。

正确判据不是「第几轮」，而是**窗口本身够不够老**：
`slices_returned < 3` 或 `produced_slices.every(s => Object.keys(s).length === 0)` 且
**这一轮距上一轮的墙钟时间 < 10 秒** ⇒ 不判。
`910bf7c` 的注释写「实测带 tx 的轮次间隔中位数 37 游戏秒、墙钟十几秒」——
**中位数够，但 p10 只有 7.1 秒、25% 的轮次 < 10 秒**。用中位数当判据，漏掉了那 25%。

## 复测 §2：CAPACITY 仍然被挤

抽样 1/25（20 个触发快照上做 A/B，两边都是同一批诊断、只差 WF）：

```
$ node .tmp-redteam/final_check.mjs
BUDGET (sampled 1/25): CAPACITY lost by WF: 8 | HUB stored lost: 1 | flips to over-budget: 0
```

**8/20 ≈ 40%** 的抽样快照上，加 `WORLD_FROZEN` 会让 `## CAPACITY` 变成 `dropped-for-budget`。
与报告时 66/516 ≈ 13% 的比例略有上升（抽样噪声 + `910bf7c` 把 hint 写长了，见下）。
「flips to over-budget: 0」说明它不再把 prompt 推过硬上限 —— 那一条修好了。

## 复测 §3：hint 仍被切，但**切掉的不再是动作**

`910bf7c` 把 hint 换成了「这是结果，不是成因，别从它下手」的警报文案，长度反而更长：

```
hint len min/max: 173 211
firings whose hint >180 (tail clipped): 515 / 516
hint still names a macro in first 180 chars: 0 / 516
```

**好消息**：前 180 字符里**不再有任何一个宏名**（`hintHasAction: 0/516`）——
这正好是 `910bf7c` 想要的「不开处方」。旧的「话说到一半 → 模型照着半句话去拆带子」这条链**断了**。

**坏消息**：515/516 的 hint 仍然 > 180，尾巴仍然被切在**半句**：

```
r-20261112193013-99fb LOST: " 件 / 15 格；14 件 / 9 格。"
r-20261112194710-c92a LOST: " 件 / 15 格；14 件 / 9 格。"
```

`另有：` 那个清单仍然每次都断在「N 件 …（末端…」之间。不过现在它**只影响「还有几条堵点」这个背景信息**，
不再影响动作 —— 危害等级从「指错路」降到「信息不全」。**部分成立，不再是 blocker。**

## 复测 B1：处方删了，但**这条诊断对世界的贡献仍然是 0**

`910bf7c` 的修法是「hint 不再推荐 `remove_run`」。但 `handles` **还在**（`B522,B521,B520` 那三格）。
我把「模型仍然照旧拿 handles 去 `remove_run`」这个动作在最终代码上重跑了一遍：

```
sim remove_run(handles) net-effect: {"cleanup":30,"regressive":486}
```

**和报告时一模一样**：0/516 让 reach 变好，486/516 变差，30 个 cleanup 只是「reach 不变、死带子减少」。
也就是 **`910bf7c` 改的是「说不说」，没改「给什么」**。
如果模型仍然抓着 `handles` 去拆（而 hint 现在只是说「别拆」），世界还是不会变好 ——
只是现在**诊断自己不再为这个结果负责**。

这不是说修错了：把一条「警报」从「处方」里摘出来是对的。
但**判定要写清楚**：B1 的**处方**被删了，B1 背后的**事实**（这条带子删了没用）没有变。
只要 `handles` 还指在那里，模型就**仍然可能**去拆它 —— 而 hint 里那句「别从它下手」是在
**同一行**、**同一个 180 字符窗口**里说的，它压不住 6 个具体的句柄。

## 更新后的一句话

**判据对、索引对、排序对；B2/B3 已修；B1 的处方已撤（但句柄还在，动作的行为没变）；
§1.3 的空窗口误报在第一轮被拦住，但第二轮及以后仍有 25% 的轮次会踩中；§2 的 CAPACITY 挤占仍在。**
`910bf7c` 是一次**按红队报告逐条修**的提交 —— 三条 blocker 里两条（B2/B3）真正修好了，
B1 修的是「说不说」而不是「给什么」，§1.3 修了一半。
