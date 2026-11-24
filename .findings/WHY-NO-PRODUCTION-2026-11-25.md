# 这个世界为什么从来没产出过目标形状

2026-11-25。**全程离线**：没连 bridge、没发 tx/act/step、没改 `src/`。
数据源只有 `research/ai-plan/runs/`（581 个 run dir，其中 **514 个是 L12**）与 `src/` 源码。
临时脚本在 `.tmp-why/`，已删。

形状代数全部走 `research/ai-player/proto/solver.mjs`（`shape-ops.mjs` 的封装），没有一处手推。
机器速率全部从游戏源码 `core/config.js` + `hub_goals.js` 算出，不是抄别人的表。

---

## 一句话结论

**这个世界卡在「接线」这一层，而接线卡在一个定义冲突上：诊断和宏对「一个槽有没有被喂」用了两个相反的定义。**

同一个槽（`stacker#14684` 的 lower）：

| 子系统 | 判据 | 结论 |
|---|---|---|
| `semantic.mjs` `cellHasCargo()` | 那条带上**有没有货** | `cargo=0` ⇒ **starved** |
| `connect.mjs` `portFedKind()` | 那条带**存不存在**且 exit 朝本端口（**不看货**） | 带子在 ⇒ **target_already_fed** |

实测（`r-20261123135733-fe21`）：

```
(-2,6) belt#14992 cargo=0     ← lower 的喂料带，空着
(-1,6) belt#14805 cargo=259   ← upper 的喂料带，堵满

MACHINE_STARVED 说：stacker#14684(1/2，缺 lower槽)
connect    →C4.lower:  FAIL target_already_fed
connect    →C4.upper:  FAIL target_already_fed
```

**两个槽都「缺料」，两个槽都「已被喂」—— 所以不存在任何一条 `connect` 能让这台 stacker 吃到料。**
模型三轮撞 `C4.upper` 只是这个死锁的表象；它换成 `lower` 也一样过不去。

上面三条不是我的推断，是逐个调 `connect(...)` 的返回值（§3.2）。

### ★ 这条结论在 `dca5ae0` 之后仍然成立（本次复核的直接验证）

调查过程中另一个 agent 提交了 `dca5ae0`
（`fix(diag): MACHINE_STARVED 丢了「缺的是哪个槽」`），**只改了 `semantic.mjs`，没碰 `connect.mjs`**。
我在新 HEAD 上重跑同一条判据：

```
MACHINE_STARVED subject: C4 | slot: {"role":"lower"}
observed: 1 台机器缺进料：stacker#14684(1/2，缺 lower槽)     ← 模型现在知道是 lower 了

model now knows it's "lower" → connect C8 → C4.lower: FAIL target_already_fed
model now knows it's "upper" → connect C8 → C4.upper: FAIL target_already_fed
```

**⇒ 角色名送达了（那一层修对了），但修复动作依然不存在。**
「告诉模型缺的是 lower」是必要不充分的：它下一步会去 `connect …lower`，
然后撞上同一堵墙。§3.6 的定义冲突是更下面的一层。

---

## 1. 预算算术：`ROUNDS_MAX=3` / 每轮多少游戏秒 / 最多能交付多少件

### 1.1 先纠正一个流传很广的错误数字

`GOAL-IS-OUT-OF-BUDGET.md` 与 `SEARCH-WHITE-PATH-2026-11-23.md` 都写「每轮只推进 **40 游戏秒**」。
**这个数是错的，或者至少不是现在这个世界的数。**

`loop.mjs:3312` 的 `budgetLeft()` 与 `loop.mjs:5160` 的 `behavior.ticks` 现在都读
`budget.TICKS_MAX - st.ticks`，而 `constants.mjs:294` 是 `TICKS_MAX: 24000`。
再加上 `verify_runtime.mjs:897` 的 `extendTicks=2400 / maxExtend=2`，
`verify-last.json` 里明确写着：

```json
"ticks": 2400, "extended_ticks": 4800, "effective_ticks": 7200
```

所以单轮请求的是 **7200 tick**，不是 2400。

⚠️ `loop.mjs:5225` 仍然写 `st.ticks += mode === "live" ? 2400 : 0;` —— 它只记 2400，
所以 `TICKS_MAX` 这个闸实际上比它自己以为的松 3 倍。**这是一个独立的记账 bug**，
但它是往「多推进」的方向错的，不影响本节结论。

### 1.2 实测：一次落地 tx 真正推进了多少游戏秒

`obs.tick` 是**游戏秒**（`game_time.js:152` `now() { return this.timeSeconds; }`），不是 tick 数。

323 个「有 tx 落地、且之后还 observe 过一次」的 L12 run：

```
Δgame-seconds（首次落地 tx 之前那次 observe → run 末 observe）
  median 119.3 s
  p90    214.1 s
  max    386.1 s
```

全部 520 个 L12 run 的**总和是 995 游戏分钟**。均值 120.6 s/run。

### 1.3 单件成品的机器时间（速率来自源码，不是抄表）

`core/config.js:81` `beltSpeedItemsPerSecond: 2`；`:101-111` `buildingSpeeds`；
`hub_goals.js:521-570` 的成品速率 = `beltSpeed × upgradeImprovements[组] × buildingSpeed`。
L12 快照 `upgrade_levels={belt:1,miner:2,processors:0,painting:1}`，
`fixedImprovements=[0.5,0.5,1,1,2,1,1]` ⇒ `upgradeImprovements={belt:1.5, miner:2, processors:1, painting:1.5}`。

| 机器 | 实际速率 |
|---|---|
| belt | 3.0 /s |
| miner | 0.8 /s |
| cutter | 0.500 /s |
| rotater | 2.000 /s |
| **stacker** | **0.250 /s** ← 最窄 |
| painter | 0.500 /s |
| mixer | 0.600 /s |

配方（`solver.mjs` 实算，两层都解得出）每件需要的串行机器秒：

```
stacker ×3 → 12.00 s/item   ← 瓶颈
cutter  ×4 →  8.00 s/item
painter ×2 →  4.00 s/item
mixer   ×2 →  3.33 s/item
rotater ×1 →  0.50 s/item
```

### 1.4 除法

| 判据 | 需要 | 每轮 120 s 时 | 每轮 386 s（实测最大值）时 |
|---|---|---|---|
| `delivered > 0`（1 件，12 机器秒） | 12 机器秒 | **1 轮** | 1 轮 |
| `delivered >= 1000` | 12000 机器秒 | **100 轮** | **32 轮** |

**⇒ 「1000 件」在当前预算下不可达，这个判定是对的，但原因不是「每轮 40 秒」。**

`ROUNDS_MAX=3` ⇒ 一个 run 最多 3 次落地 tx。worst 观测到 10 轮（`r-20261115203925-7314`，6 次落地）。
要在**一个 run 内**跑完 1000 件，即使每轮都拉满 386 秒，也要 **32 轮** —— 是 `ROUNDS_MAX=3` 的 **10.7 倍**。
而且这 32 轮还得每一轮都 tx 成功（实测 995 次落地 / 2479 轮 = 40%）。

**⇒ 在当前预算下，`delivered >= 1000` 这个目标不可达。这是算术，不是提示词问题。**
（除非把 `TICKS_MAX` 再抬 10 倍，或者让 `await` 之类的宏直接推进几千游戏秒。）

---

## 2. 三个层次的最小可行路径

先说结论：**三层都做得到，代价差三个数量级。**

### 2.1 `produced_total` 里出现目标形状一次（不要求进 hub）

**最难的一层，而且它不是靠「接一根线」能到的。**
`produced_total` 只在**整条链全部走通、且末端有东西在动**时才非零 —— 目标的最后一道是
`stack(CbCbCbRb, CwCwCwCw)`，它要求下层和上层**同时**到齐。

最小路径（按 `solver.mjs`，纯用本图近距离矿 `CuCuCuCu`@12格 / `RuRuRuRu`@8格）：

```
下层 CbCbCbRb:  mine(Cu) ×2, cut ×4, stack ×2, rotCW ×1, paint(blue) ×1
上层 CwCwCwCw:  mine(Cu) ×1, mix(blue+green)=cyan, mix(cyan+red)=white, paint(white) ×1
合层:           stack ×1
```

机器缺口（相对现有）：**+2 stacker、+1 rotater**（`SEARCH-WHITE-PATH` 的结论我复核过，成立）。
但**真正的缺口是接线**：21 台机器里有 11 台矿机输出格是空地、4 台 mixer 里 0 台两槽有料、
2 台 painter 的 color 槽都是空的。

轮数估计：一条这样的链要 **15~25 条 wire op**，而实测每次落地 tx 的 ops **中位数是 2**
（995 次落地 tx：min 1 / median 2 / p90 7 / max 168）。
⇒ **光把一条链接起来就要 8~13 轮**（且 60% 的轮次会失败），然后才轮到「跑出第一件」的 1 轮。

### 2.2 `delivered > 0`（任何一件目标形状进 hub）

比 2.1 多一件：最后那段必须**物理上通到 hub**。
好消息是这段现有：`stacker#14684 → rotater#14685 → belt#15000 → hub 入口 primary@bottom(-2,2)`，
拓扑完好、只差 stacker 不吐货。所以 2.2 ≈ 2.1 + 0 轮（现存连线免费）。

⇒ **2.2 和 2.1 的轮数是同一个数：8~14 轮。**

### 2.3 `delivered >= 1000`

= 2.2 建成之后，**再跑 100 轮**（每轮 120 s）或 **32 轮**（每轮拉满 386 s）。

⇒ **总需求：建成 ~10 轮 + 吞吐 32~100 轮 = 42~110 轮，而预算是 3 轮。**

**这就是「不可达」的完整算式。** 三层都做得到；只有第一层（"产出来过一件"）在
「多个 run 累积」的意义上有可能，而**跨 run 累积本身现在也不成立**（见 §5）。

---

## 3. 现有机器逐台的实测状态（全部走 `slotsOf` + `items-last`，不是几何近似）

数据源 `r-20261123135733-fe21`（与任务书给的 `52a3` 是同一天同一世界，实体数 749 一致）。

### 3.1 逐台

| 机器 | 位置 | 槽状态（approach 格 / 货量） | 判定 |
|---|---|---|---|
| **stacker#14684** (C4) | (-2,5) | lower←(-2,6) belt#14992 **cargo=0**；upper←(-1,6) belt#14805 **cargo=259** | **两路都接线、只有一路有货** ⇒ 攒不满 2 件 ⇒ 不吐 |
| **rotater#14685** | (-2,3) | primary←(-2,4) belt#14999 cargo=0 | 接线对，等 stacker |
| **painter#13552** (C3) | (-5,14) | shape←(-5,13) belt#14838 **cargo=0**；color←**(-4,15) EMPTY** | **0/2**（`MACHINE_STARVED` 明确排除全空机器 ⇒ 它从未被点名） |
| **painter#14687** (C6) | (89,-14) | shape←(89,-13) EMPTY；color←(88,-15) EMPTY；出口也 EMPTY | **完全空壳** |
| **cutter#13544** (C2) | (-5,9) | primary←belt#14834 cargo=2；left出口→belt#14835；**right出口→(-6,10) EMPTY** | 在切，一个出口悬空 |
| **cutter#16598** | (28,-52) | primary←belt#16616 **cargo=2（蓝颜料）** | **来料是颜料，cutter 只收 shape ⇒ 永不工作** |
| **cutter#13369** | (84,-16) | primary←(84,-17) EMPTY；两出口全空 | 完全空壳 |
| **mixer#16742** (C8) | (-4,1) | color←(-3,1) **EMPTY**；color←(-3,0) **EMPTY** | **两槽全空**；出口接 belt#14827 → cutter#13544 |
| **mixer#17294** | (34,-40) | color←(35,-40) belt#17410 cargo=0；color←(35,-41) belt#17648 cargo=0 | 接线「对」，两条带都空 |
| **mixer#17319** | (30,-51) | color←(29,-51) belt#17585 cargo=0；color←(29,-50) belt#17586 cargo=0 | 见 §3.3 —— **上游是空地和一个自环** |
| **mixer#17340** | (36,-41) | color←(35,-41) belt#17648；color←(35,-40) belt#17410；**出口 (37,-41) EMPTY** | 和 #17294 **共用同一对喂料格**，且自己出不了货 |

### 3.2 任务书问的「4 台 mixer 离最近的颜料矿多远」

| mixer | 最近的 red | 最近的 green | 最近的 blue | 备注 |
|---|---|---|---|---|
| #16742 (-4,1) | **11** | 13 | 47 | 最近的一台，但两槽都是**空地** |
| #17294 (34,-40) | 72 | **14** | 31 | 两槽接的是空带 |
| #17319 (30,-51) | 77 | **9** | 47 | 两槽接的带子上游是空地和自环 |
| #17340 (36,-41) | 73 | **13** | 32 | 出口悬空 |

**注意绿矿的高频出现**：3 台 mixer 的最近矿都是 green（9~14 格）。绿矿矿机是 #17122(-10,-7)、
#17120(-10,-6)、#16234(35,-54)、#16615(89,-10)。

而 white 需要的是 **blue + green → cyan，再 cyan + red**。绿矿近、红矿 11 格近、
**蓝矿最近 31 格**。所以「最少改动」应当从 **#16742（红 11 / 绿 13 都在 15 格内）** 下手。

### 3.3 两台 mixer 共用同一对喂料格（这是个拓扑 bug）

```
mixer#17294 @(34,-40) inputs: (35,-40), (35,-41)
mixer#17340 @(36,-41) inputs: (35,-41), (35,-40)   ← 完全相同的两格
```

两台 mixer 挤成对角，**吃同一对带子**。物理上不可能两台都同时吃到两种颜料——
一条带子只有一个流向。所以这 4 台 mixer 里，**#17294 和 #17340 最多只能有一台能用**。

而 #17319 更糟：它的两个上游是

```
(29,-51) ← EMPTY at (28,-51)        ← 空地，没有源头
(29,-50) ← b#17258 @(28,-50) ← CYCLE（回路到自己）
```

**一个上游空地、一个上游自环。** 这台 mixer 永远不可能出货。

⇒ **4 台 mixer 的真实可用数是 2（#16742 全空可接、#17294/#17340 二选一），不是 4。**
诊断里的 `NO_PRODUCTION` 说「mixer 只有 4 台」是对的，但它没说**这 4 台里 2 台是坏的**。

### 3.4 任务书给的「87 件纯蓝」离 mixer#17340 只差一格 —— 但接不过去

`path20` 的末格是 `belt#16638 @(37,-40) r=270 rv=0`，我算过它的出口：
`beltExit(0, 270)` ⇒ 入口 `right`、**出口 `left`** ⇒ 货**朝 (36,-40) 走**。
而 `(36,-40)` 是 **mixer#17340 自己的机身** —— 也就是说这 87 件蓝的终点**已经在撞 mixer 了**，
只是撞的是机身不是槽。

我实测了「从 `B16638` 接到 mixer 的两个 color 槽」：

```
B16638 → mixer17340.color[0]:  FAIL target_already_fed
B16638 → mixer17340.color[1]:  FAIL occupied（第一处冲突 36,-40 是 mixer 本体）
B16638 → mixer17294.color[0]:  FAIL occupied（同上）
B16638 → mixer17294.color[1]:  FAIL occupied（同上）
```

**一格之遥，四条路全堵。** 任务书说「离 mixer#17340 的输入 (35,-40) 只差一格」——
差的那一格是**另一台 mixer 的身体**。

### 3.5 「只让你用最小的改动让 mixer 转起来，改哪几格」

**唯一可行的一组，我逐条实测过 `connect` 的返回值：**

| 动作 | 结果 |
|---|---|
| green `M17120(-10,-6)` → `C8(#16742).color[0]` @(-3,1) | ✅ OK，**13 格**，cut 1，**disc 0** |
| green `M17122(-10,-7)` → `C8.color[0]` | ✅ OK，14 格，cut 1，**disc 0** |
| blue `M17287(38,-7)` → `C8.color[1]` @(-3,0) | ✅ OK，**53 格**，cut 3，disc 2 |
| blue `M16586(37,-10)` → `C8.color[1]` | ✅ OK，57 格，cut 3，disc 2 |

⇒ **最小改动 = 2 条 `connect`，14 格 + 53 格，接到 `mixer#16742` 的两个空格 `(-3,1)` 和 `(-3,0)`。**
绿的那条 `disc=0`（不会切断任何东西，能过闸门）；蓝的那条 `disc=2`（会切断 2 处）。
蓝矿远在 53 格外是硬伤 —— 这正是任务书说「蓝图够但都在 60 格外」的实测版本。

⚠️ 而且这两条接上之后，`mixer#16742` 出的是 **cyan**，不是 white。
cyan 还要再和 red 混一次（需要第二台 mixer，而第二台只能从 #17294/#17340 里挑一台，
且必须先把那条 `(35,-40)/(35,-41)` 的共用冲突解开）。实测接红矿：

```
red M15113(5,5) → C8.color[?]  ✅ 但另一槽已被绿占
```

⇒ **完整链路至少要 3 次 `connect`（绿/蓝/红）+ 1 次 mixer 搬迁或改线，共 4 轮以上。**

### 3.6 一个自我矛盾：诊断和宏对「已喂」的定义相反

```
semantic.mjs:3554  cellHasCargo(cell) = 那条带上有没有 items       → cargo=0 ⇒ starved
connect.mjs:1942   portFedKind(port)  = 那条带存不存在、exit 是否朝本端口  → 不看 cargo
```

`(-2,6)` 上有一条 `cargo=0` 的带子，于是它**同时是**「缺料」（诊断说）和「已有供料方」（宏说）。
**这个槽在系统里没有任何可达的修复动作。**

我用 `connect` 实测确认：

```
C8 → C4.lower  plain = FAIL target_already_fed   rebind = OK 9 cells, cut 7
C8 → C4.upper  plain = FAIL target_already_fed   rebind = OK 10 cells, cut 8
```

只有 `rebind:true` 能过 —— 而 `rebind` 会 cut 掉 7~8 条带子，必然被预演闸门拒
（实测模型 r2 撞的就是这个：`PLAN_REJECTED 死带子 390→567`）。

⇒ **诊断在推荐一个只有「拆掉世界」才能执行的修复。这是「选对了根因、给错了动作」的最纯粹形态。**

---

## 4. 模型为什么反复撞 `C4.upper`

这一条已有独立的调查（`.findings/C4-UPPER-WALL-2026-11-25.md`，192 条真调 LLM 样本），
我从 prompt 侧复核并补两条它没覆盖的：

### 4.1 复核成立的部分

用 `buildPrompt` 按 `loop.mjs:4265` 的真实参数（`prompt_tokens_max:5300`、`in_chars_max:24000`）
重建 prompt（18650 字符，与真机 `prompt_chars` 18505~18808 同量级），逐字看 `C4` 的每一句：

**`## MACHINES`（第 176 行）—— 这句是对的，而且它明说 upper 已被接上：**

```
C4 stacker 输入=lower@bottom(←B133)/upper@bottom(←B90) 输出=out@top(→B134) port=out in.port=lower|upper
```

**`## BELTS`（第 205 行）—— B90 / B133 一条都不在，全文 0 行提到 `C4.`：**

```
## BELTS (16 of 699; 4 referenced by diagnosis)
```

B90/B133 既不在「目标走廊」也不被任何诊断的 `evidence.handles` 点名（`MACHINE_STARVED` 的
handles 只有 `["C4"]`），于是掉进「表顺序兜底」，699 条里排 90/133 位 —— **永远轮不到**。

**`## DIAGNOSIS`（第 233 行）—— 缺的槽名在到达模型之前丢了：**

```
1. MACHINE_STARVED ...: C4 (stacker); observed 1 台机器缺进料：stacker#14684(1/2，缺 [<coord>]); ...
```

`缺 [<coord>]` 里的 `<coord>` 是 `sanitize()` 把 `[-2,6]` 打码的结果。
`prompt.mjs:2803` 有一个专门渲染 `@${d.slot.role}` 的位置，而 `MACHINE_STARVED`
**从来没填过 `d.slot`** —— 它把角色写进了 `evidence.starved[].missing_cells`（只有坐标）。

### 4.2 判定：prompt 有没有让它以为 upper 空着？

**没有一句话这么说。** 逐句排除：

| 句子 | 能推出「upper 空着」吗 |
|---|---|
| `输入=lower@bottom(←B133)/upper@bottom(←B90)` | ❌ 不能，它明说 upper 有 B90 |
| `observed …缺 [<coord>]` | ❌ 不能，坐标被打码，且没给角色 |
| `hint …把缺的那一路接上` | ❌ 不能，只说「那一路」 |
| `hint …它在缺料机器里最靠**上游**` | ⚠️ **能，但是误读** —— 「上游」被读成 stacker 的「upper」槽 |
| `PROGRESS … layers: CwCwCwCw absent` | ❌ 不能，那是目标的**上层形状**，不是输入槽 |

**模型的 77:0 不是「读了错的信息」，是「没有任何可读的依据」。**
在 `lower` 和 `upper` 两个名字里，它按出现顺序取了后一个。

### 4.3 我在 prompt 侧新发现的两条

**① `MACHINE_STARVED` 的 `feed_sources` 是算给 `lower` 的，但没说是给哪个槽的。**

prompt 原文：
```
nearest sources with a free output: C8(mixer, 7格, 造缺失色), C2(cutter, 6格), M4(miner, 8格)
```

这三台是按「到 lower 的 approach 格 (-2,6) 的距离」算的。但渲染出来只是「最近的源头」，
模型无从知道它们是为 `lower` 算的。而 `C2`（cutter）**语义上根本不可能**喂 color 槽
（cutter 只收 shape，`cutter.js:100` `filter:"shape"`）—— 这条建议是错的，且它会误导。

**② 模型 r2 的 `connect C2→C4.upper` 还有个更硬的问题：`C2` 是 cutter，接 color 槽必然失败。**

`REAL-GAP-SELECT-VS-LAND.md` 记录过同一族问题。这条与 C4 无关，但它说明
`feed_sources` 的「只按距离 + 只判输出口空闲」这个判据放过了语义上不可能的源头。

### 4.4 修复之后仍然撞（实测）

`f30bcdb`（11-24 03:25）修了 `slotRoleAt` 的同向消歧。**11-24 09:27 的 run `a764` 仍然选 `upper`：**

```
r1: connect C8 → C4.upper          → target_already_fed
r2: connect C2.right → C4.upper rebind → PLAN_REJECTED（死带子 390→567）
r3: trash_unused C2.right          → out_of_scope
```

**为什么修了还是撞**：那次修复改的是 `## BELTS` 段里 B90/B133 的 `下游=` 标注，
**而这两条带子从来不在 prompt 里**（§4.1）。修在了送达不到的那一端。

⇒ 这是 `computed-but-never-delivered` 的又一次性形态：**修对了，但没送到。**

---

## 5. 一句话结论：卡在哪一层

**卡在接线。但接线的真正障碍是一个定义冲突（§3.6），不是「模型不够聪明」也不是「prompt 没写清楚」。**

流水账版本：

1. **不是产能**（至少不是第一障碍）。1000 件需要 100 轮，而世界从来没接通过哪怕一条到目标的链 ——
   讨论产能的前提不成立。
2. **不是预算**（流程层）。`ROUNDS_MAX=3` 确实不足以跑完 1000 件（需要 32~100 轮，§1.4），
   但连 `delivered > 0` 都做不到，说明问题在预算之前。
3. **不是 prompt 误导**（它是**放大**而不是**成因**）。模型撞 `C4.upper` 是对的推理撞上错的送达——
   但即使它写对了 `lower`，也是 `target_already_fed`（§3.6）。
4. **是接线，而且是接线的定义层**：`MACHINE_STARVED` 说「这个槽缺料」，
   `connect` 说「这个槽已经被喂」—— **两句话都成立，所以没有任何动作能修它。**

**第二层成因（历史层）**：这个世界在 11-15 之前有过一台真正在产 cyan 的 mixer `#11803`
（83 件 cyan 在带上）。**11-16 13:42 被 `remove_machine` 删了**，
理由是 `ORPHAN_MACHINES` 报它「一根带子都没接」—— 而它在被删前的那一轮是
`in0=belt in1=belt out=belt`（三面都接着）。同一族缺陷，更早的一次。

**第三层（跨 run）**：995 次落地 tx、2479 轮、995 游戏分钟，**全部累计换来 0 件目标形状、
0 次目标形状进 hub**。世界实体数从 325 涨到 749，机器从「5 矿机+1 mixer」涨到 17 矿机+4 mixer，
但那些机器 71% 的时间是饿着的（504 个含 mixer 的快照里 360 个所有 mixer 输入全空）。
**这个系统在成功地建造，而建造的东西不产出。**

---

## 6. 反证：我的结论可能是错的

### 反证 1（最有力）：`delivered > 0` 也许并不需要 10 轮 —— 因为世界曾经差一点就成了

11-15 11:13 那个快照里，`mixer#11803` 在产 cyan（83 件），
`path [81,-13] .. [-1,6]` 有 161 件货、`acceptor: yes`。
也就是说 **cyan 这条支线当时是通的，而且连着 hub 方向的干线**。
目标要的是 `CwCwCwCw = paint(CuCuCuCu, white)`，而 white = cyan + red。
如果当时再接一条红矿到第二台 mixer，`white` 就有了。

**这推翻的是「10 轮」这个数**，不推翻「卡在接线」。
但它确实说明：**这个世界的起点比现在好得多，是 11-15~11-16 的那几十次 tx 把它拆坏的。**

### 反证 2：`produced_total` 可能不是「整链走通」才非零

我按 `verify_runtime.mjs` 的注释（`observedProduction` 是「最近 N 片求和」）推断
`produced_total` 覆盖全图所有机器。如果它只统计「到达 hub 的」或者只统计某些机器，
那 2.1（"产出来过一件"）的难度会被我高估。

**检验方式**：找一个有产出的快照（11-15 12:11 那次 `produced_total={"ScScCgCg":15,...}`），
看那一件货是**在哪台机器的 ejector 上**第一次出现的。`13` 次中间产物都算，
说明它统计的是「机器产出」而不是「hub 入库」—— 我倾向我的读法对，但没有直接验证。

### 反证 3：`target_already_fed` 也许有我没找到的绕过方式

我测的是 `connect` 的 `plain` 和 `rebind` 两种。如果 `portFedKind` 之外还有
（比如先 `remove_run` 那一条空带再 connect），那条路是可行的 ——
但那需要**两个 tx**（删 + 接），而 `ROUNDS_MAX=3` 给得起。
**所以「无解」应当收窄成「单 tx 无解，两 tx 可行」。**

这是我最可能高估严重性的地方。

### 反证 4：`obs.tick` 是游戏秒这个判断，我是从源码读的，没有真机验证

`game_time.js:152` 是 `now() { return this.timeSeconds; }`，而 `performTicks` 里
`this.timeSeconds += this.root.dynamicTickrate.deltaSeconds`。
如果 mod 在 `observe()` 里做了别的换算，我 §1.2 的 120 s/轮 会跟着错。
**但我用的是 `median 119.3 / p90 214 / max 386` 这组实测值本身做的除法**，
即使单位是 tick（而非秒），「32 轮 vs 3 轮」的量级差仍然成立。

---

## 附：本次复核用到的调用（可复现）

```bash
# 两层配方（都解得出，证明"做得到"）
node research/ai-player/proto/solver.mjs "CbCbCbRb" --colors blue --resources C,R --no-cutquad --max-states 200000 --depth 8
node research/ai-player/proto/solver.mjs "CwCwCwCw" --colors red,green,blue --max-states 400000

# 速率（源码）
#   core/config.js:81 beltSpeedItemsPerSecond=2
#   core/config.js:101-111 buildingSpeeds
#   hub_goals.js:521-570 成品速率公式
#   hub_goals.js:40-63 upgradeImprovements 累加

# 关键实测（离线调宏，不碰游戏）
#   connect({from:{uid:16742},to:{uid:14684,port:{role:'lower',index:0}},opts:{allow_replace:true}}, {entities: obs.entities})
#     → {ok:false, error:{code:'target_already_fed'}}
#   connect({...同上, opts:{allow_replace:true, rebind:true}})
#     → {ok:true, cells:9, changed:{removed_uids:[...7 条]}}
#   connect({from:{uid:17120},to:{uid:16742,port:{role:'color',index:0}},opts:{allow_replace:true,prefer:'cheapest'}})
#     → {ok:true, cells:13, consequences:{would_disconnect:[]}}
```

**证据文件（绝对路径）**

```
D:\Projects\rea\Project work\shapez\research\ai-plan\runs\r-20261123135733-fe21\
    obs-last.json / items-last.json / production-last.json / transcript.jsonl
D:\Projects\rea\Project work\shapez\research\ai-plan\runs\r-20261124092748-a764\transcript.jsonl
    修复（f30bcdb）之后仍然撞 C4.upper 的那次
D:\Projects\rea\Project work\shapez\research\ai-plan\runs\r-20261116134236-36b2\transcript.jsonl
    ORPHAN_MACHINES 让模型删掉唯一在产的 mixer#11803
D:\Projects\rea\Project work\shapez\research\ai-plan\runs\r-20261115121125-264d\items-last.json
    cyan 83 件在带上的最后一个快照
D:\Projects\rea\Project work\shapez\.findings\C4-UPPER-WALL-2026-11-25.md
    192 条真调 LLM 样本的 77:0（我复核过：upper=77, lower=0）
D:\Projects\rea\Project work\shapez\src\agent\loop\semantic.mjs:3554
    cellHasCargo —— 「喂」= 带上有没有货
D:\Projects\rea\Project work\shapez\src\agent\macros\connect.mjs:1942
    portFedKind —— 「喂」= 带存不存在（不看货）  ← 这两行的定义相反，是 §3.6 的根
D:\Projects\rea\Project work\shapez\src\agent\loop\verify_runtime.mjs:897
    extendTicks=2400 / maxExtend=2 ⇒ effective_ticks=7200
D:\Projects\rea\Project work\shapez\src\agent\loop\constants.mjs:294
    TICKS_MAX=24000 ⇒ 旧文档里的「每轮 40 秒」已经过时
```
