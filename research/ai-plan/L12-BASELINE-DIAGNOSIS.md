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

## 2026-11-18 第二轮：分层提示生效，但仍未交付

给 solver capped 加了分层分解提示（详见 `src/agent/loop/recipe.mjs`）后，
又跑了 10 轮（`.agent-run3.log`）。**诚实结论：没有交付。**

净效果分布：6 次 `inert`、2 次 `churn`、1 次 `stalled_growth`、1 次 `regressive`。

| 指标 | 第一轮后 | 第二轮后 |
|---|---|---|
| 产出 | 0/1000 | **0/1000** |
| 矿机 | 11 | **15** |
| mixer | 1 | **1** |
| stacker | 1 | **1** |
| 带子 | 673 | 724 |

**变化是真实的**：矿机从 11 台涨到 15 台，说明模型开始按「分层」思路建产线了。
但 mixer 一台没加 —— 而白料链至少需要两台（一台混 cyan、一台混 white）。

### 新发现：反复尝试一个必败动作，烧掉整个轮次预算

6 次 `inert` 里有 3 个 run 是同一个模式：模型每轮都提
`connect C1 → B40 / B45`（把切割机的两路输出接到没源头的带上），每轮失败，
每轮换一种端口写法重试：

```
R1: {"from":{"$ref":"C1"},"to":{"$ref":"B40"}}                    → port_already_bound
R2: {"from":{"$ref":"C1","port":{"role":"left","index":0}}, ...}   → occupied
R3: {"from":{"$ref":"C1"},"to":{"$ref":"B40"},"opts":{"rebind":true}} → 仍失败
```

失败信息其实很清楚（`port_already_bound` 的 hint 直说「传 opts.rebind=true」，
`occupied` 说「换一条不经过 trash#17138 的路」），模型也确实照做了 ——
但**两条一起失败**，于是 plan 被 `NO_REVERSIBLE_CALL` 整体拒掉
（`loop.mjs:1953`：有失败且剩下的不可撤销 ⇒ 拒）。

那个闸门本身是对的（提交「不完整且不可撤销」的子集是最糟的组合），
问题在于模型没有别的牌：它想改的两条带子都被占着，而它不会去拆那个挡路的垃圾桶。

### 循环检测是工作的，但不够快

`repair_decide` 里能看到 `world_fingerprint` 的 `seen` 计数是 1, 1, 2, 3，
第 4 轮触发 `NO_PROGRESS_3X` 停机。所以检测没坏，但**前两轮已经白烧了**。

key 是 `${fp}#${actKey}`，而 `actionSetHash` 只哈希宏**名**。
R1 和 R2 的 `actKey` 相同（都是 `connect,connect`），却被记成 `seen:1` ——
说明 R2 的 key 变了。这一点没查清，可能是 `lastMacros` 在失败后带了不同的内容。

### 下一轮该先做的

不是继续加轮次，而是**让模型有「拆掉挡路的东西」这张牌**。
`remove_machine` 已经在 `NO_PRODUCTION` 的候选表里（权重 6），
但 `NO_REVERSIBLE_CALL` 和 `port_already_bound` 这两个诊断的候选表里没有它 ——
而那正是「端口被占」时唯一能走通的路。

**已改**（`constants.mjs` 的 `RETRIEVAL_TABLE.NO_REVERSIBLE_CALL`，权重 2）。
验证方式值得记下来，因为它差点让我以为改动没生效：

```
candidatesFor([{code:'NO_REVERSIBLE_CALL'}])              → ["connect","extend_line","replace_run"]
candidatesFor([NO_REVERSIBLE_CALL, BELT_HANDOFF, NO_PROD]) → [..., "remove_machine", ...]
```

单诊断时它被 `cap=6` 和 top-3 截掉了 —— **但 L12 的实际诊断永远不止一条**
（`NO_PRODUCTION` + `BELT_HANDOFF_REJECTED` ×2 + `MIXER_COLOR_AIMED`），
所以在真实场景里它会出现。判断「候选有没有送到」必须用**真实的诊断组合**，
只喂单条会得到误导性的结论。

改了之后又跑了 6 轮（`.agent-run4.log`）：1 次 `stalled_growth`（机器 +3）、
3 次 `inert`，垃圾桶从 6 涨到 13 —— 它在**加**垃圾桶而不是拆，`remove_machine`
还是没被选中。候选送到了不等于会被选，这一层还没打通。

## 2026-11-18 第三轮：`build_line` 根本不在 agent 的调用链里

这一轮查清了那条结构性瓶颈的全部真相，比任何代码改动都重要：

```
build_line 存在于 src/agent/macros/build_line.mjs
  ├─ MACRO_SPECS（contract.mjs 的宏注册表）  → 只有 8 个，没有它
  ├─ MACRO_IMPLS（remove.mjs 的分派表）      → 只有 4 个，没有它
  └─ RETRIEVAL_TABLE（候选表）               → 没有它
```

**agent 连发都发不出这条调用。** `constants.mjs` 里那段
「为什么不推 build_line」的注释（理由是「世界非空就拒，推它等于推一个必然
失败的选项」）其实是在解释一个它压根碰不到的东西。

### 已修：净地闸改成可以只判计划矩形

`build_line` 的前置条件是「世界里有任何非 hub 实体就拒」。但那条闸真正要回答的
是「我的新产线会不会压到别人的东西」—— 世界别处有 700 台机器与本计划无关。

新增 `siteScoped` 选项，只检查计划矩形内的实体（按 `anchor = hubWorld − hubLocal`
换算坐标系）。实测真实 L12 快照（762 实体）：

| 场景 | 结果 |
|---|---|
| 默认整体判据 | `site-not-empty`，**761** 个既有实体 |
| `siteScoped`（真 hub −2,−2） | `site-not-empty`，**8** 个既有实体（都紧贴 hub，这条计划确实会撞） |
| `siteScoped`（空地 hub 70,0） | **`ok:true`，建出 2 实体的线** |
| `siteScoped`（空地 hub 55,5） | **`ok:true`，建出 12 实体的线** |

判据第一次能回答实际问题了。

### 还没做：把它接进 agent

三张表都要加，而且加之前想清楚两件事：

1. **`build_line` 只返回蓝图，不写世界。** 文件头写着「本宏零游戏写操作」——
   落盘/粘贴是调用方的事。所以接进 agent 还需要一个「粘贴蓝图」的步骤
   （`paste_blueprint` 有 `dry_run`，正好是那道安全检查）。
2. **`siteScoped` 放松了安全闸。** 默认判据存在的理由（「带子被静默覆盖」）
   是真实的，所以粘贴前必须 `dry_run`，否则就是拿一个已知会覆盖别人建筑的
   蓝图去贴。

在 1、2 都落地之前，把 `build_line` 放进候选表只会让 agent 反复拿到一张
它没法执行的牌 —— 那是本轮实测已经证明过的失败形态（`NO_REVERSIBLE_CALL`
反复拒同一个必败动作，烧掉整个轮次预算）。

### 还发现一件更根本的事：`build_line` 天生建在 hub 旁边

编译器的坐标契约（`compile.mjs:718-727`）：

> ⓐ `ctx.hub` 给了（真实世界 hub 左上角 W）⇒ **局部原点 = W**（`site = hub = W`）

也就是说**只要给了真 hub，产线就必然从 hub 旁边开始铺**。L12 的 hub 周围
恰好有 8 个既有实体（stacker@(-2,5)、rotater@(-2,3)、belts@(-5,2..5)…），
所以「在远处空地建线」这条路 **`origin` 参数解决不了** —— origin 不决定产线建在哪。

我试过 `origin=[60,-10]` / `[70,0]`，两者都仍然 `site-not-empty`。

要让 `build_line` 真正对真实存档有用，需要的是第三条路：
**允许 anchor 与 hub 解耦**（产线建在远处，收集带走到 hub）。
那是编译器的结构性改动，不是加个选项能解决的 —— 而且收集带要横跨几十格，
本身就是一条需要规划的产线。

在这一步做成之前，这个项目的 agent 只能靠增量宏（connect / insert_machine /
replace_run）改造既有工厂，而 L12 需要的 mixer 混白料链是结构性工程。
**这就是 0/1000 的最深层原因。**






## 2026-11-18 第四轮：修掉了一条把 agent 引向错误方向的 hint

### 问题：`NO_PRODUCTION` 把「缺工序」误判成「世界太脏」

原判据是 `beltCount >= 300` ⇒ 判成腐化 ⇒ hint 说：

> 这个世界已经堆了 716 条带子却一件都产不出来 —— 说明绝大部分是接不上的旧线。
> **先清理，别再往上加**：用 `remove_run` 把到不了 hub 的旧线成片拆掉

L12 永远满足这个条件，于是每一轮每个 run 都收到这句话。实测十几轮的结果：
`cleanup` / `inert` 反复出现，机器一台没加，产出一直是 0。

那条判据漏了一件事：**带子多不等于全是废线**。L12 有 602 条到 hub 的活带，
是真的在流动的干线。真正缺的是工序级联 —— 目标要白颜料，
而 `white = blue+green+red` 三级混，一台 mixer 根本不够。

### 修法：加一条并列判据

机器数 ≥8 但 mixer ≤1 时，判成「缺级联」而不是「太脏」。hint 直接点名：

```
世界有 25 台机器和 714 条带子，但 **mixer 只有 1 台**，产出为 0。
这不是「太脏」，是**缺工序**：目标需要混色，而混色要 mixer。
先用 `insert_machine` 补一台 mixer...
别再拆带子了 —— 已经拆了很多轮，产出没变过。
```

candidates 也相应换成 `insert_machine` 打头。

### 实测效果（r-20261118161234-7c3a）

模型第一轮就据此推理：

> The goal is a two-layer shape needing a **white pigment cascade**, but the world has...

然后直接 `insert_machine {at:{...}, machine:"mixer", facing:"left"}`。

**世界 mixer 从 1 台变成 2 台。** 这是三十多轮以来第一次「因诊断指引而主动补工序」
而不是拆东西。随后几轮 miner 从 15 涨到 16，世界实体从 761 精简到 737。

### 但产出仍然是 0

两台 mixer 还不够走完 bl+gr→cyan、cyan+red→white 这条链，
而且白料还要送去给 circle 形状染色。这一步没做成。

**教训**：一条错误的 hint 可以让 agent 连续几十轮朝反方向努力，而且从
净效果看像是「它在动世界」（cleanup 被记成改善）。判断诊断对不对，
要看它把模型引向什么动作，不只是看世界变没变。

## 2026-11-18 第五轮：修掉三处互相打架的指令

这一轮没有再改「世界怎么想」，而是查 prompt 里的指令是否自相矛盾。找到三处。

### 1. `NO_REVERSIBLE_CALL` 的 hint 说「只做一个」，收尾指令说「1 到 6」

两条指令在同一个 prompt 里，而靠后的那条（模型照着写输出的位置）说可以提多个。
实测模型连续三轮提 `connect,connect`，每轮被拒，每轮收到「只做一个」，
每轮继续提两个 —— 它不是忽视 hint，是听到了更显眼的那句。

修：`NO_REVERSIBLE_CALL` / `PARTIAL_APPLY` 之后的下一轮换用
`**Exactly 1 call this round.**`。上一轮成功就立刻恢复常态。

**实测生效**：`r-20261118173206-b172` 的 R2/R4/R5 都只提 1 个（此前全是 2–4 个）。

### 2. 这个收窄判据第一版读错了字段，从未触发

`settleFailure` 把拒因写在 `verify.codes`（`loop.mjs:2884`），顶层 `codes` 是空的。
第一版只读顶层 ⇒ 收窄一次都没生效，prompt 里仍是「1 to 6 calls」。

我为它写了测试，并用**变异验证**确认：改回只读顶层后测试立刻失败。
原先那条测试用的是顶层 codes，所以它没抓到这个 bug —— 补了一条用
`verify.codes` 的。

### 3. `port_already_bound` 的 hint 在推荐一个会拆掉世界的动作

原来只有一句「传 `opts.rebind=true`」。实测（`r-20261118173404-ef9e`）：
模型严格照做，`rebind` 让 connect 成功了，但预演立刻报

> 到 hub 的带子 596 → 539（**-57，10%**），死带子 107 → 167

整个计划被 `PLAN_REJECTED` 拦下 —— 那个端口上接的是一条活干线。

**这条 hint 在建议一个会拆掉 57 条活带的动作**，而模型没有信息判断该不该抢。
现在改成：优先换端口/换源（同一台机器往往还有另一个 ejector），
把 `rebind` 的代价说清楚。

### 产出仍然是 0

模型现在会收窄规模、会照 hint 加 `rebind`、会说出「让两台 mixer 级联成脉」，
但每次 connect 都卡在 `ambiguous_port` 或 `port_already_bound`，
而 `rebind` 的代价又超出预演允许的范围。

**我已经修了 5 处 prompt/诊断缺陷，模型的行为一步步变对，但还没跨过
「能把一条线真正接活」这道坎。** 下一步该查的是 `connect` 在两个 cutter
输出口都被占的世界里到底有没有可行解 —— 如果物理上无解，
那问题在「世界布局」而不是「agent 决策」，应该先腾出一条路。

## 2026-11-18 第六轮：查清了「connect 到底有没有解」

这一轮不再猜，直接按世界快照逐对试 `connect`。

### 先说修的这一处：两端歧义一次报全

cutter 16598 和 mixer 16742 **两端都是歧义的**。原实现 from 失败就 return，
to 根本没检查 —— 模型补了 from 的 `{role,index}`，下一轮才撞到 to 的歧义。
**一次只报一个错 = 修一个歧义要多花一轮。**

现在合并成一个失败对象，hint 直接写出两端该写什么：

```
这个连接两端都有多个端口，**一次把两个都写上** ——
from.port: {role:"left",index:0} / {role:"right",index:0}；
to.port: {role:"color",index:0} / {role:"color",index:1}
```

### 但按 hint 写也接不上 —— 因为端口已经占满了

照 hint 把两端都写全，结果是：

```
{"role":"left","index":0}  → {"role":"color","index":0}  port_already_bound
{"role":"left","index":0}  → {"role":"color","index":1}  port_already_bound
{"role":"right","index":0} → {"role":"color","index":0}  port_already_bound
```

**cutter 16598 的两个 ejector 都已经被带子占着**（`left#0@29,-52`、
`right#0@29,-51`，都接满了）。所以从这个 cutter 出来的 connect **物理上无解** ——
除非 `rebind` 拆掉现有的，而预演会因为拆掉到 hub 的活带（596→539，-57）
把整个计划拒掉。

### 结论：这是世界布局问题，不是 agent 决策问题

模型这几十轮的表现，逐轮看其实一直在改进：
收窄调用数、照 hint 补端口、加 rebind、说出「让两台 mixer 级联成脉」。
但**它反复要连的那台 cutter 没有空口可接**。

再怎么调 prompt，只要世界是这样，它就接不上。

### 下一步该做的（按优先级）

1. **先腾空一个 ejector**：拆掉 cutter 16598 某一侧的下游带子（用 `remove_run`
   定向删那一段，而不是 rebind 抢整个端口），让出一个空口，再 connect。
   这需要 agent 理解「先拆再连」，而当前候选表里 remove_run 权重低于 connect。
2. **或者换一台机器**：世界还有 cutter@84,-16 和 cutter@-5,9，先看它们的口占没占。
3. **或者接受 rebind 的代价**：-57 条到 hub 的带子如果本来就是冗余的，
   预演那条闸的门槛可以重新评估 —— 但那要先用数据证明它们真是冗余的。

**在这三条里挑一条之前，继续加轮次不会有产出。**

## 2026-11-18 第七轮：agent 换机器了，mixer 从 2 涨到 4

上一轮查清「cutter 16598 两个口都占满、而另外两台 cutter 有空口」之后，
把这条写进了 `port_already_bound` 的 hint（三步：同机器换端口 → 换一台同类机器 → 才 rebind）。

### 实测效果

**模型不再死盯那一台机器了。** 之前的 run 清一色是 `connect(C1)` / `connect(C2)`，
现在变成 `connect(C4)` / `connect(C3)`：

```
R1 replace_run,connect(C4),connect(C3)
R2 connect(C4),connect(C3),connect(B178)
R4 connect(C4),trash_unused
```

**mixer 从 2 台涨到 4 台**（两次 `机器 +1`）。这正是 `needs_cascade` 阈值
（`mixerCount < 4`）指引的方向 —— 白料级联需要的台数到了。

### 但还是 0 产出

12 轮的净效果：3 cleanup、1 constructive、4 inert、1 regressive、2 stalled_growth。

新加的四台 mixer 还没被接进任何活着的货流 —— `stalled_growth` 的原话：
「结构变了（机器 +1），但世界完全没动：带上的货没有增加」。

而且 `trash` 从 12 涨到 15，说明它还在用垃圾桶止损。

### 现在的位置

| 阶段 | 状态 |
|---|---|
| 知道缺什么（白料级联要 mixer） | ✅ 确诊并说得出 |
| 会补机器 | ✅ mixer 1 → 4 |
| 会把机器接进产线 | ❌ 停在这一步 |
| 产出 | ❌ 0 |

**下一步该查的是：新放的四台 mixer 周围有没有可用的接入口。**
如果它们被放在没有带子通道的位置，那 `insert_machine` 放对了台数但放错了地方，
应该先看 `insert_machine` 选址用的判据是不是只看了「空不空」而没看「接不接得上」。
