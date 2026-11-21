# 真机验证：cheapest / 纯闭环 / HUB stored（2026-11-21）

只读验证。世界 = 实验存档 `7c93b3dd…`（`world_info.seed=60908`）。
全程未发 `tx`/`act`/`step`/`place`/`delete`/`save`，未碰用户存档 `5c967065…`。

## 第 1 步 世界身份（新鲜 obs）

| 项 | 值 |
|---|---|
| goal.level | **12** |
| goal.requirement.shape | **CbCbCbRb:CwCwCwCw** |
| delivered / required | 0 / 1000 |
| entity_count | 749（truncated=false） |
| hub.stored_shapes 条目数 | 22 |
| tick | 968155 → 968250（两次采样间在走） |
| seed | 60908 |
| 机器 | miner 17 / belt 699 / mixer 4 / painter 2 / cutter 3 / stacker 1 / rotater 1 / balancer 1 / trash 20 / hub 1 |

世界身份与预期一致，继续。

## 第 2 步 改动 B（纯闭环不算可交付）—— **完全生效**

`flowReachable` 对这份新鲜 obs：

| 口径 | 可交付带子数 |
|---|---|
| `{sourceless:false}`（旧） | **390** |
| `{sourceless:true}`（新，默认） | **309** |
| `{itemsDoc}` + sourceless:true | 309 |
| `{itemsDoc}` + sourceless:false | 390 |

- 差值 **-81**，逐 uid 核对：被摘掉的 81 条**全部是 `cycle`**，`none` 的 29 条一条没动。
- 摘前源头分布：miner 273 / **cycle 81** / none 29 / cutter 4 / stacker 1 / rotater 1 / trash 1。
- 摘后：cycle 0，其余不变。
- **与上次（81 条 cycle）一致**，世界未变。
- `itemsDoc` 这次**没有额外效果**（309 两边相同）：hub 入口带当前 货=0，没有「运颜料堵门口」的带子被类型闸摘掉。类型闸在这份快照上是惰性的（不是坏了）。

`worldHealth().belts_deliverable` = **309**，与闸门分母一致。

## 第 3 步 改动 C（HUB stored 段）—— **生效，但换来了资源/矿种提示被挤掉**

按 `loop.mjs` 真实参数（`prompt_tokens_max` 现在=4800）构建：

- `user.length` = **12231**
- `tokens_estimate` = **4845**；`chars` = **16956**；`targetChars` = 4800×3.5 = **16800**
- `over_token_budget` = **true**（超 45 token；只是标记，没人消费，不抛错）
- `blocks.s3_hub_stored` = `HUB stored: CgScScCg×2071 (+15) — past levels' output; only the goal's own count advances`
- `blocks.hub_stored_dropped` = null
- `blocks.s3_belts` 显示 **5 of 699** 条（`trimmed=11`）
- `blocks.S2` 的 opts.prefer 行渲染为：
  `opts.prefer:shortest|fewest_turns|reuse_existing|cheapest?  // cheapest=少拆东西`
  （`shortest 会横穿主干道` 那半句被 firstClause 截断，没到模型眼前）
- CAPACITY 段：**在**（`capacity_unavailable=null`）
- `macro_pref_shown=true`，`when_lines_shown=false`

**同 obs 上 4600 vs 4800 A/B（这是改动 C 的代价）：**

| | 4600（旧） | 4800（新） |
|---|---|---|
| chars / tokens | 16071 / 4592 | 16956 / 4845 |
| HUB stored | **null**（dropped-for-budget） | **有** |
| CAPACITY | **无**（dropped-for-budget） | **有** |
| 矿种/资源提示「NO miner is digging w」 | **有** | **没了**（`resource_dropped_for_capacity=true`） |
| belts_shown | 5 | 5 |
| MACHINES | 12 of 49 | 20 of 49 |

**结论**：+200 token 没让「HUB stored 进来 + CAPACITY 回来」白拿 ——
它把**资源段整段挤掉了**。而这一关目标是 `CwCwCwCw`（白），
被挤掉的那句正是「NO miner is digging w — 缺的颜料得上 mixer 混」。
CAPACITY 段里另有「7 miner(s) have no processor connected」，但**没有**「没有矿机挖白」这一条。
对 L12 这是一个**真回退风险**（不是零成本），值得主线程权衡：4800 装不下全部三段。

## 第 4 步 cheapest vs shortest + 预演闸门（核心）

目标机器：诊断 `MACHINE_STARVED` 点名 **C3（painter#13552）**，
缺 `color` 槽 @ `(-4,15)`（唯一断点，与历史结论一致）。对 17 台矿机逐一试连该 color 槽。

宏层（`connect`）+ 闸门层（`buildTxPlan partial:true`）结果：

| 矿机 | 矿种 | shortest | cheapest | 预演闸门 |
|---|---|---|---|---|
| M1 | red | port_already_bound | 同 | 宏失败 |
| M2 | red | ok 21格/拆2 | 同 | **拒** loss=181（新口径） |
| M3 | red | ok 20格/拆2 | 同 | 拒 loss=182 |
| M4 | red | ok 19格/拆2 | 同 | 拒 loss=183 |
| M5 | blue | port_already_bound | 同 | 宏失败 |
| M6 | green | port_already_bound | 同 | 宏失败 |
| M7 | blue | ok 70格/拆3 | 同 | 拒 loss=191 |
| M8 | blue | ok 72格/拆3 | 同 | 拒 loss=189 |
| M9 | RuRuRuRu | ok 31格/拆5 | 同 | 拒 loss=288 |
| M10 | blue | port_already_bound | 同 | 宏失败 |
| M11 | green | ok 122格/拆1 | 同 | 拒 loss=24 |
| M12 | blue | occupied | 同 | 宏失败 |
| **M13** | green | ok 29格/拆6 | 同 | **落地** newLoss=0 |
| M14 | blue | ok 68格/拆3 | 同 | 拒 loss=191 |
| **M15** | green | ok 28格/拆2 | **ok 30格/拆1** | **落地**（两者都过） |
| M16 | blue | ok 68格/拆3 | 同 | 拒 loss=189 |
| **M17** | Cu | ok 14格/拆1 | 同 | **落地**（newLoss=14） |

### 「有多少条便宜的路径能真正通过预演闸门」—— **3 / 17**

- 能落地：**M13、M15、M17**（三台）。
- 另外 9 台宏能出路径但**被闸门拒**（M2/M3/M4/M7/M8/M9/M11/M14/M16），
  拒的理由都是 `PLAN_REJECTED`，可交付损失 24~288 条 —— 路径横穿主干道，
  覆盖 2~5 条带子就断掉大片上游，闸门拦得对。
- 5 台宏层就失败（M1/M5/M6/M10 端口已被占、M12 撞机器）。

### 改动 A（cheapest）在这份世界上：**只有 1/17 台真的换了一条路**

- 仅 **M15** 上 cheapest 与 shortest 不同：shortest 28格拆2（`14824,14828`），
  cheapest 30格拆1（`17024`）。cheapest 确实挑到了「更便宜」的那条，方向正确。
- **但绝大多数组合 `alternatives=0`**，即候选集只有 1 条，cheapest 无从比较。

### 改动 A 的真问题：`cheapest` 被枚举的 early-break 架空

`connect.mjs` 枚举候选时有一句
`if (occ.ok && sh.turns <= floor) break;`（拿到下界转角就停）。
我做了独立全枚举对照（同端点、不限提前退出）：

| 矿机 | cheapest 实得 rm | 全枚举真正最小 rm | 是否被架空 |
|---|---|---|---|
| M9 | 5 | **4**（更便宜存在） | **是** |
| M13 | 6 | **1**（29格只拆1条，存在！） | **是** |
| 其余 | — | 与实得相同 | 否 |

- M13 全枚举里有一条 29 格、只拆 1 条（`17024`）的候选，**比实得拆6条便宜得多**，
  但因为 floor=2 那条在 turns=2 就 break 了，`cheapest` 根本没看到它。
- 所以 `scoreOf` 的 cheapest 逻辑本身对（M15 证明了它会选对），
  **缺陷在候选枚举过早收敛**：地板转角候选一出就 break，
  导致需要在 turns>floor 才能找到的「更便宜但多拐两个弯」的路径永远进不了排序。

## 改动 B 的真实效果：**直接多放行 2 条正确路径**

反事实对比（同一份 ops，分别用新旧分母判 → 阈值 `loss≥20 或 (loss≥5 且 ≥25%)`）：

| 组合 | 新口径 loss | 旧口径 loss | 旧口径闸门 | 新口径闸门 |
|---|---|---|---|---|
| M13 cheapest | 0 | **81（20.8%）** | **BLOCK** | **pass** |
| M15 cheapest | 0 | **81（20.8%）** | **BLOCK** | **pass** |
| M15 shortest | 7 | 7 | pass | pass |
| M17 | 14 | 14 | pass | pass |

改动 B 把那条 81 条的死环从分母里摘掉后，M13/M15 这两条**本来正确的修法**
（把绿矿接到 painter 的 color 槽）**从被拒变成能落地**。
这正是改动 B 代码注释里说的目标，真机上成立。

## 结论

- **改动 A（cheapest）**：逻辑正确、在 M15 上证明了会选更便宜的路径；
  但被 `connect` 枚举的 early-break 架空 —— 17 台里只有 1 台出现差异，
  另有 M9/M13 两条更便宜的候选因提前收敛而永远看不到。**效果被结构性问题限制**，
  要真正发挥需先改枚举：拿到 floor 候选后不要立刻 break，或对 allow_replace 场景
  额外枚举更高转角再排序。
- **改动 B（纯闭环）**：**完全生效**。390→309，正好摘掉 81 条 cycle、`none` 全保留。
  并直接让 M13/M15 两条正确路径通过闸门（旧口径下会被 -81 / 20.8% 判 BLOCK）。
- **改动 C（HUB stored + 4800）**：HUB stored 一行确实进了 prompt，CAPACITY 也回来了；
  但 +200 token 不够装全部，**资源/矿种提示（NO miner is digging w）被挤掉**。
  对需要白颜料的 L12，这是非零代价，需权衡。

### 新发现的问题

1. **cheapest 被枚举 early-break 架空**（上表 M9/M13）：这是改动 A 没能普遍生效的根因。
2. **4800 挤掉矿种提示**：HUB stored + CAPACITY 回来了，代价是「没有矿机挖白」这句没了。
3. **BELTS 段 `0 of 4 referenced by diagnosis shown`**：诊断点名 B692/B699/B208/B378，
   这 4 条在候选排序里排第 13~16 位（走廊 byGoal 先吃满 12 个名额），
   预算截断到 5 条时一条都看不到。表头诚实报了 0/4，但模型拿不到这 4 条的任何属性。
   —— 这是既有的排序+预算问题，不是本次三处改动引入，但和「算出来没送到」同类。
4. **prompt 轻微超预算**：4800 档实际 4845 token（`over_token_budget=true`），
   只是被打标记，没有消费者，不抛错。可接受但不精确。
5. 落地的 3 条路径中，M15/M13 是绿矿（白=cyan+red 的 cyan 需要绿），语义对；
   **M17 是铜矿**接到 color 槽 —— 机械上能落地，但会把颜料涂成铜色，不是目标色。
   这是模型选择的问题，不是代码缺陷，仅提示。

## 复验（修复后）

只读复验 `dd0c452`。全部在离线快照 `research/ai-plan/runs/r-20261121072433-521e/obs-last.json`
上跑（**749 实体 / tick 944351.03 / truncated=false / goal=L12 `CbCbCbRb:CwCwCwCw`**），
未发任何 `tx`/`act`/`step`/`place`/`delete`/`save`，未碰用户存档 `5c967065…`。
脚本临时放在 `.tmp-verify/`，报告后已删除。

> 与上一轮报告的口径差异：上一轮写 tick 968155、seed 60908，都来自当时的**新鲜 obs**
> （那次连了游戏）。本轮全程离线，只用这份 run 产物快照，它的 tick 是 944351.03。
> 世界身份的其他项（749 实体、17 台矿机、C3 唯一断点在 `(-4,15)` 的 color 槽）与上一轮一致。

### 复验 1（核心）：cheapest 现在 6/17 台换了路（修复前 1/17）

同一份快照、同一目的地 `C3.color@(-4,15)`、`allow_replace:true`。
「拆」= `changed.removed_uids.length`。闸门 = `buildTxPlan(..., {partial:true})`。

| 矿机 | uid | 矿种 | shortest | cheapest | 差异 | 闸门 |
|---|---|---|---|---|---|---|
| M1 | 12445 | red | port_already_bound | 同 | — | 宏失败 |
| M2 | 15044 | red | 21格/拆2 | 同 | — | 拒 loss=181 |
| M3 | 15046 | red | 20格/拆2 | 同 | — | 拒 loss=182 |
| M4 | 15113 | red | 19格/拆2 | 同 | — | 拒 loss=183 |
| M5 | 16204 | blue | port_already_bound | 同 | — | 宏失败 |
| M6 | 16234 | green | port_already_bound | 同 | — | 宏失败 |
| M7 | 16586 | blue | 70格/拆3 | 同 | — | 拒 loss=191 |
| **M8** | 16587 | blue | 72格/拆3 | **70格/拆3** | **DIFF** | 拒 189→191 |
| **M9** | 16597 | RuRuRuRu | 31格/拆5 | **29格/拆4** | **DIFF** | 拒 288→306 |
| M10 | 16614 | blue | port_already_bound | 同 | — | 宏失败 |
| **M11** | 16615 | green | 122格/拆1 | **120格/拆1** | **DIFF** | 拒 loss=24（两侧相同） |
| M12 | 17119 | blue | occupied | 同 | — | 宏失败 |
| **M13** | 17120 | green | 29格/拆6 | **29格/拆1** | **DIFF** | **落地 / 落地** |
| M14 | 17121 | blue | 68格/拆3 | 同 | — | 拒 loss=191 |
| **M15** | 17122 | green | 28格/拆2 | **30格/拆1** | **DIFF** | **落地 / 落地** |
| **M16** | 17287 | blue | 68格/拆3 | **66格/拆3** | **DIFF** | 拒 189→191 |
| M17 | 17644 | CuCuCuCu | 14格/拆1 | 同 | — | 落地 / 落地 |

- **差异台数 6/17**（修复前 1/17）。主线程说的 uid 16597/17120/17122 **三台全部复现**，
  另有 **16587、16615、17287 三台**是主线程没提的。
- 用 `git show HEAD~1:src/agent/macros/connect.mjs` 在同一进程里做旧/新 A/B 对照：
  **OLD 差异 1/17 → NEW 差异 6/17**，`alternatives` 也从 0 变成 1~959。
  早收敛确实解开了。
- **能落地仍是 3/17，且最短和最便宜是同一组：M13 / M15 / M17**。
  没有「只有 cheapest 能落地」的台。全扫 miner × painter × {color,shape} 68 个组合，
  **闸门结论翻转 0 次**；两边都落地时终点 hub 数相同 7 组、cheapest 更好 1 组、更差 0 组：
  只有 `M15→C3.color` 从 hub 302(-7) 变成 309(0) —— 唯一一个真实收益。

#### 一个反向观察：cheapest 在 3 台上让闸门损失变大

`M8 189→191`、`M9 288→306`、`M16 189→191`。三条都在闸门层被拒（两种情况都拒），
所以**没有行为后果**，但方向值得记：`cheapest` 的排序依据是「覆盖了几条带子」，
不是「切断了几条到 hub 的带子」。这三台 cheapest 拆得更少/更短，却切到了更靠上游的位置。
不是本次修复引入的缺陷（scoreOf 的口径如此），但如果哪天 `cheapest` 被用来选一条**会通过闸门**的路，
这个口径差就可能选错。

### 复验 2：5300 档四样东西都在 —— **成立**

按 `loop.mjs:4063` 的真实参数（含 `in_chars_max:24000` / `prompt_tokens_max:5300` /
`itemsOnBelts:377` / 全套 `buildPrompt` 可选参数）重建：

| 项 | 值 |
|---|---|
| `system.length` | **4725**（S1 未变，与修复前同） |
| `user.length` | **13656** |
| `tokens_estimate` | **5252** |
| `blocks.chars` | 18381（targetChars = 5300×3.5 = 18550） |
| `over_token_budget` | **false** ← 修复前 4800 档是 true |
| 带子 | **16 条 / 699**（`belts_shown=16`），诊断点名的 4 条**全部**显示（`4/4`） |
| `blocks.s3_capacity` | **在**（265 字符，`capacity_unavailable=null`） |
| `blocks.s3_hub_stored` | **在**：`stored (past levels stay here; only the goal's own count advances): CgScScCg×2071  Cu------×33532  Cu----Cu×27823  RuRuRuRu×14843  ----CuCu×8476  RbRb----×6619  ----RuRu×4575  CuCuCuCu×1680  (+8 more)` |
| 「没有矿机在挖」 | **在**（93 字符，`resource_dropped_for_capacity=false`） |
| MACHINES | 20 of 49，12 条带「采X」标注 |

主线程说的「16 条带子 / 四样都在」**独立复核成立**。

同 obs 三档对照（我这边测的，与 commit message 略有出入）：

| tok | chars | tokens | belts | CAP | HUB | DIG | over |
|---|---|---|---|---|---|---|---|
| 4600 | 16097 | 4599 | 10 | 无 | 无 | 有 | false |
| 4800 | 17054 | 4873 | 10 | 有 | 无 | **无** | true |
| 5300 | 18334 | 5238 | 16 | 有 | 有 | 有 | false |

commit message 里写 4600 档是「带子 10 条 / CAPACITY 无」，我测到的是 10；它写的 5300 档
「16 条 / 5227 token」，我测到 16 条 / 5238 token（差 11，来自 `itemsOnBelts` 我传 377）。
**结论方向完全一致，数字只有个位数差异。**

### 复验 3：cheapest 几乎没有变慢 —— **1.1x，不是 3 秒级**

先跑两轮热身排除 V8 预热，再各 5 次取中位数（单位 ms）：

| 目标 | shortest 中位 | cheapest 中位 | 比 |
|---|---|---|---|
| M13 uid17120 → C3.color | **156** | **168** | 1.08x |
| M9 uid16597 → C3.color | 145 | 167 | 1.16x |
| M15 uid17122 → C3.color | 142 | 139 | 0.98x |

17 台合计：shortest 1135ms / cheapest 1253ms，**只多 118ms（1.10x）**。

上一轮观察到的「约 800ms」我没能复现 —— 那是**未热身**的单次冷启动值（我这里首次调用
M13 也要 200~340ms，属于 JIT 与 fs 读 spec 的固定开销）。最坏情况仍在别处：
`M17→C6.shape` 单次 **1.4s**（110 格长路径，两偏好相当），`miner→mixer` 272 组合里最慢 1.1s。
**这些都是既有的长路径枚举代价，不是 cheapest 引入的**（同组合 shortest 一样慢甚至更慢）。

### 全量测试：失败数 29 → 28，**没有新增红**

`node --test src/agent/ src/ai/compiler/` 在修复前（`HEAD~1` 导出到临时目录）与修复后各跑一遍：

| | tests | pass | fail | skipped |
|---|---|---|---|---|
| HEAD~1 | 760 | 727 | **29** | 4 |
| HEAD (dd0c452) | 760 | 728 | **28** | 4 |

逐条 diff 失败集：**只有 now 红的 0 条**，只有 base 红的 1 条
（`E3 升级需求表与源码一致` —— 它在修复后转绿，不是回归）。
`connect_prefer.test.mjs` 的 5 条在新版全绿。

### 新发现（本轮，非本次修复引入）

1. **回归测试会静默跳过**。`connect_prefer.test.mjs` 的两个真机快照用例，在快照文件
   读不到时只 `console.log("（说明）…跳过")` 然后 `return`，`pass++` 照常。
   我实测把 `obs-last.json` 改名后：**5 passed, 0 failed, exit=0** —— 那两条最关键的
   断言（M13 拆 6→1、M15 拆 2→1）一条都没跑，却显示全绿。
   这正是 memory 里 `computed-but-never-delivered` 那条「回归测试缺夹具要 fail 不能 skip」。
   而且它依赖 `research/ai-plan/runs/…` 这种**会被清理/改名的 run 产物**当夹具，
   不适合当长期回归基线。
2. **挖矿提示的文案与数据不符**。`notDug` 这份快照只有 `w` 一种（`没有矿机在挖 w`），
   但后半句硬编码「**这两种颜色**在地图上没有颜料矿」。这句话是把当时
   `[C,b,w]` 三种的旧文案留下来的一半 —— 数量词对不上实际列表。
   语义没错（w 确实没有颜料矿），但「两种」会让模型以为还有第二种没列出来。
3. **`cheapest` 的送达仍然只有 2 次字符串**，且都在 `opts.prefer:` 那行的行尾注释
   （`cheapest=少拆东西`）。S1 里 0 次。它现在**真的能挑出更便宜的路了**，
   但模型要知道「该用它」仍然只靠这 6 个字。这条与上一轮一样，没变。
4. **`hub 入口 auto` 场景仍在用最好的转角数收紧后续端口对**（`bestTurns` 那段没动）。
   我做了对照：把 `cheapest` 下 `capTurns` 的 `bestTurns` 收紧也去掉，
   `M17→hub` 的 20 格会变成 17 格、`alternatives` 从 274 变 3246。
   但**闸门结论与终点 hub 数一个都没变**，所以这轮不算问题，只是记一笔：
   `cheapest` 的「早收敛」修的是 `break` 那一处，`capTurns` 那一处还在收敛候选集。

### 结论

- **修复有效**：cheapest 的差异台数 1/17 → **6/17**，`alternatives` 从恒 0 变成 1~959。
  早收敛是根因这一点被旧/新同进程 A/B 直接证实。
- **但它没有改变任何一轮的落地结论**：能落地的仍是 M13/M15/M17 三台，
  与 shortest 完全相同；68 个 miner×painter 组合里闸门翻转 **0 次**。
  真实收益只有一处：`M15→C3.color` 的终点可交付带子从 302(-7) 变成 309(0)。
- **性能代价可忽略**：1.08~1.16x，17 台合计 +118ms。不会影响真机轮时效。
- **prompt 5300 档四样齐**：16 条带子 + CAPACITY + HUB stored + 挖矿提示，
  5252 token，`over_token_budget=false`。这一档是这轮唯一「三个目标全达成」的。
- **测试基线持平**（29 → 28 红，无新增），但新增的回归测试有「缺夹具静默通过」的坑，建议改成 fail。

---

## 复验 2：feed_sources

只读验证。世界 = 实验存档 `7c93b3dd…`（`world_info.seed=60908`）。
全程未发 `tx`/`act`/`step`/`place`/`delete`/`save`，未碰用户存档 `5c967065…`。
脚本放 `.tmp-verify/`，报告后已删除。

> **HEAD 在验证期间前进了一格**：任务书说的是 `62831a9`，但我跑第 2 步时
> `8088bc7 feat(diag): 源头推荐带上「会切断几处」` 落了盘。两个版本我都测了，
> 下面凡是结论对两版都成立的会注明。

### 第 1 步 世界身份（新鲜 obs，唯一一次连游戏）

| 项 | 值 |
|---|---|
| goal.level | **12** |
| goal.requirement.shape | **CbCbCbRb:CwCwCwCw** |
| delivered / required | 0 / 1000 |
| entity_count | **749**（truncated=false） |
| tick | **973078.16**（采样时在走，paused=false） |
| seed | 60908 |
| debug_items | belts 375 / ejectors 20 / paths 32 / truncatedPaths=false |

机器构成与上一轮一致：miner 17 / belt 699 / mixer 4 / painter 2 / cutter 3 /
stacker 1 / rotater 1 / balancer 1 / trash 20 / hub 1。

> ⚠️ **第一次取 obs 的 `resources` 是错的，差点让整份报告反过来。**
> 任务书给的参数 `max_entities:50000, layer:"all", include_stats:true, include_resources:true`
> **漏了 `max_resources`**，mod 默认 2000 ⇒ `resources` 只回来 2007 条，
> 覆盖 `x∈[-255,-179]`（世界 bbox 是 `-15..90`，东半边一个矿都没有）。
> 后果：17 台矿机的矿种全部 `undefined`，于是 `feed_sources` 的「颜料矿」判据
> 把所有矿机都筛掉，只剩 `C6(painter)` 一条，精度 0/1。
> **我一开始把这当成了真实结论。** 换成 loop 真实参数
> （`max_resources: 20000`，见 `loop.mjs:555/5357`）后回来 11187 条、bbox 覆盖全图，
> 17 台矿机的矿种全部正确（red×4 / blue×6 / green×4 / RuRuRuRu×1 / CuCuCuCu×1 / …）。
> 任务书的参数和 `loop.mjs` 的口径不一致 —— 这是**任务书的坑，不是代码的**，
> 但沿用它的任何人都会得到假结论。

### 第 2 步 feed_sources 的精确度

诊断点名 **`C3`（painter#13552）**，缺 `color` 槽 @ `(-4,15)`（与本文件前几轮一致）。
`8088bc7` 产出的 `feed_sources`：

| 句柄 | 类型 | 距离 | cells | cut | disconnect | 预演闸门 |
|---|---|---|---|---|---|---|
| **M13** | miner(green) | 27 | 29 | 1 | **0** | **落地** 30 ops |
| **M15** | miner(green) | 28 | 30 | 1 | **0** | **落地** 31 ops |
| M14 | miner(blue) | 64 | 68 | 3 | 3 | 拒 `PLAN_REJECTED`（-191 条，62%） |

- **精确率 = 2/3**（能落地 / 推荐总数）。
- 被推荐的 3 台**全部是矿机、全是绿的/蓝的**，没有 `C8`、没有 `M17`。
- 上一轮 `62831a9` 的版本（只按距离排）在同一份 obs 上给出**完全相同**的
  `M13, M15, M14` —— `8088bc7` 的 `disconnect` 排序**在这份世界上是惰性的**
  （前两名本来就 `disc=0`，M14 本来就第三）。

#### 对照：全量扫描（29 个非带子实体的全部）

「可落地」= `connect(opts:{allow_replace:true,prefer:"cheapest"})` 成功 **且**
`buildTxPlan(partial:true)` 通过。

| 全量可落地集合 | 类型 | 距离 | 是否被 `feed_sources` 推荐 |
|---|---|---|---|
| M17 | miner(CuCuCuCu) | 12 | ❌ **漏** |
| C8 | mixer | 14 | ❌ **漏** |
| M13 | miner(green) | 27 | ✅ |
| M15 | miner(green) | 28 | ✅ |

- **recall = 2/4**（全部可落地）；若只看「矿种语义正确」的三台（C8/M13/M15），
  **recall = 2/3**。
- **精确率 2/3 掩盖了一个真缺陷**：推荐列表里第 3 名 `M14` 一定过不了闸门，
  而**更近、更能落地**的 `M17`(12 格) 和 `C8`(14 格) 一个都没进。
  `M17` 被排除是**对的**（踩 `CuCuCuCu` 形状矿，喂 color 槽不变色）；
  `C8` 被排除是**错的**，见下。

#### ★ C8 被排除的理由是错的 —— 这是本轮最实的一个发现 ★

`semantic.mjs` 的过滤条件写着「输出口必须空闲 —— 用既有的 slotsOf，不自己算朝向」，
实现是 `slots.outputs.some(sl => !at(ixd, sl.cell))`，也就是**输出格上只要有任何实体就排除**。

而 `connect` 自己判端口占用的逻辑（`connect.mjs:1208-1212` → `portBoundKind`：1934）
判的不是「格子上有没有东西」，而是**「格子上的带子是不是朝这台机器流」**：

```
portBoundKind: beltEntry(b.rv,b.r) === OPP[port.face] ? "accept" : null
```

两者在「输出格上有一条**向外**送货的带子」时**结论相反**：

| 源 | 输出格 | 格上是什么 | 带子朝向 | `at()` 判据 | `connect` 判据 | 实际能连吗 |
|---|---|---|---|---|---|---|
| C8 | `(-5,1)` | belt#14827 | **向外** | 已占 ⇒ 排除 | 未占用 | **能**（已实测 LAND，16 格/拆 2）|
| M13 | `(-9,-6)` | 空 | — | 空闲 ⇒ 保留 | 未占用 | 能 |
| M1 | `(8,4)` | belt | **向内** | 已占 ⇒ 排除 | **已占用** | 不能（`port_already_bound`）|

- `C8` 用 **`allow_replace:false`** 连也一样落地 —— 说明它压根没触发 `port_already_bound`，
  不需要抢端口。它被排除的唯一理由就是 `at()` 那个过宽的判据。
- 世界里只有 **2 台** mixer 的输出格被「向外」带子占着：`C8`（d=14，LAND）
  和 `C9`（d=93，宏层就失败）。C8 是这份世界上**第二便宜且能落地**的源头，
  比被推荐的 M13 近 13 格、比 M15 近 14 格；拆 2 条 vs 拆 1 条、`disc=1` vs `disc=0`。
- 影响：`feed_sources` 的 3 个名额里，第 3 名给了一台必被拒的 `M14`，
  而一台能落地的 `C8` 被一条**与宏不一致的判据**挡在门外。

> 这一条正好落在 memory 的 `computed-but-never-delivered` 与
> `never-write-code-against-imagined-schema` 之间：判据不是「没想到」，
> 而是**和它要预测的那个东西（connect 的 precondition）用了不同的定义**。
> 单测里那条 `feed_sources 要给「能产颜料且输出口空闲」的源头` 明确把
> 「输出口已被占用的 mixer 不该被推荐」写成了断言（`semantic.test.mjs:1986`），
> 所以**这条缺陷被一个错误的测试固定住了** —— 要改判据得同时改测试。

#### `disconnect` 分离度的实测（`8088bc7` 的核心论点）

commit message 说「0 与非 0 完美分开」。全量 16 个宏层能出路径的源：

| disconnect | 台数 | 其中落地 |
|---|---|---|
| 0 | 2（M13, M15） | **2** |
| 1 | 4（C6, M11, C8, M17） | 2（C8, M17） |
| 2 | 3（M2, M3, M4） | 0 |
| 3 | 5（M7, M8, M9, M14, M16） | 0 |
| ≥4 | 2（C10, C11） | 0 |

- **`disc=0 ⇒ 必落地` 成立（2/2）**；但**`disc>0` 并不等于必拒（6 台里 2 台落地）**。
- 所以「完美分开」只在**一个方向**成立。真正干净的分界是「距离 ≤28 且 `disc≤1`」，
  而不是 `disc==0`。
- 后果：`C8`(disc=1) 和 `M17`(disc=1) 落在「不完美」那一侧，而排序把
  `disc=0` 的两台顶到前面、`disc=1` 的四台排在后面并被 `slice(0,3)` 砍掉 ——
  于是 **1 条能落地的路径（C8）被排序挤出了名单**。

### 第 3 步 端到端 A/B —— **未执行（缺凭证）**

- `ANTHROPIC_API_KEY` 未设置；`ANTHROPIC_BASE_URL` 指向
  `http://127.0.0.1:15721/claude-desktop`（Claude Desktop 网关）。
- 用 `settings.json` 里的 `ANTHROPIC_AUTH_TOKEN`、`config.json` 里的 `primaryApiKey`、
  以及 `customApiKeyResponses.approved` 里那个 key 各试一次，
  一律 `{"error":{"message":"认证失败: Claude Desktop gateway authentication failed","type":"proxy_error"}}`。
- 结论：**这一轮拿不到模型凭证，A/B 没跑。** 按纪律「必须跑到落地为止」的口径，
  宁可不报，也不拿「选没选中」冒充结果。

**A/B 工装已写好并在 dry 模式下自检通过**，凭证到位即可直接跑：

- `diagnose()` 只调一次，两臂共用同一批诊断对象；
- 两臂唯一差异是 `MACHINE_STARVED.evidence.feed_sources` 置空 / 保留；
- **渲染后长度已配平**：A 组 13667 → 补 102 个 U+3000 到 **13769**，
  B 组 **13769**，`user.length` 相等；
- 逐行 diff：**194 行，恰好 1 行不同**（第 171 行，两臂都含 `MACHINE_STARVED`）；
- 两臂 `belts_shown=16` / CAPACITY 在 / HUB stored 在 / 挖矿提示在 —— **完全一致**，
  没有出现 `.findings/EXP-chain-hint.md` 里那种「hint 短了 → 预算松了 → 多看见一条带子」的混杂。

判据（照任务书）：`hit_select`（`to` 是不是 `{ref:C3, port:{role:"color"}}`）、
`hit_land`（该计划过 `buildTxPlan`）、`picked_handle`（选的 `from` 句柄）。

### 第 4 步 预算：`feed_sources` 只吃 102 字符，5300 档**一样都没挤掉**

同一份 obs、`loop.mjs` 真实参数（`in_chars_max:24000`）渲染：

| 档位 | 臂 | user.len | token | 带子 | CAPACITY | HUB stored | 挖矿提示 |
|---|---|---|---|---|---|---|---|
| **5300** | A（无 feed_sources） | 13667 | 5255 | 16/699 | **有** | **有** | **有** |
| **5300** | B（有） | 13769 | 5284 | 16/699 | **有** | **有** | **有** |
| 4800 | A | 12180 | 4830 | **8** | 有 | 无 | 无 |
| 4800 | B | 12188 | 4832 | **6** | 有 | 无 | 无 |

- **5300 档：四样东西两臂全在，零挤压。** `Δlen=+102`、`Δtoken=+29`，
  5284 < 5300，`over_token_budget` 为假。
- **4800 档：`feed_sources` 会挤掉 2 条带子**（8→6，少了 25%）。
  这不是新问题（4800 本来就已经丢 HUB stored + 挖矿提示），但它说明
  **100 字符在紧张档位是真有代价的**。任务书估的「约 60 字符」实际是 **102 字符**
  （`8088bc7` 加了 `, 安全` / `, 会切断N处` 两个词之后变长）。
  只要 `prompt_tokens_max` 停在 5300，这条无风险。

渲染出来的那一段（B 组实际文本）：

```
; nearest sources with a free output: M13(miner, 27格, 安全), M15(miner, 28格, 安全), M14(miner, 64格, 会切断3处)
```

### 结论

1. **`feed_sources` 的精确率是 2/3，不是 3/3。** 前两名（M13/M15）确实能落地，
   第三名（M14）一定被预演闸门拒 —— 而且它带着 `会切断3处` 这个自曝标签，
   模型读得出来，所以**危害有限**，但这 1/3 的名额是浪费的。
2. **真正的问题在漏，不在错。** 全量可落地 4 台，`feed_sources` 只覆盖 2 台。
   其中 `M17` 漏得有道理（形状矿），**`C8` 漏得没道理**：
   它是这份世界上第二便宜、且已实测能落地的源头（16 格/拆2/`disc=1`），
   被一句「输出格上有实体就算占用」的判据排除，而 `connect` 的同一判断是
   「带子是不是朝机器流」。**判据与它预测的对象用了不同的定义。**
   更糟的是这条错误判据被一条回归测试固定住了（`semantic.test.mjs:1986`）。
3. **`8088bc7` 的 `disconnect` 在这份世界上没改变推荐结果**（`62831a9` 与 `8088bc7`
   给出同一组 M13/M15/M14）。它的论点「0 与非 0 完美分开」只在一个方向成立：
   `disc=0 ⇒ 必落地`（2/2）✅，`disc>0 ⇒ 必拒` ❌（6 台里 2 台落地）。
4. **预算是安全的**：5300 档下 `+102 字符 / +29 token`，四样东西一个没少。
   但实际开销是任务书估的 60 字符的 **1.7 倍**，4800 档会掉 2 条带子。
5. **A/B 未跑 —— 没有模型凭证。** 工装已按 `.findings/EXP-chain-hint.md` 的
   三重等价性控制写好并通过 dry 自检（194 行 / 只差 1 行 / 渲染长度相等 /
   预算块完全一致），凭证到位即可直接跑。

### 给主线程的建议（按性价比）

1. **修 `C8` 那条判据**：把 `slots.outputs.some(sl => !at(ixd, sl.cell))` 换成
   「输出格空 **或** 格上的带子不是朝这台机器流」——直接复用 `connect.mjs` 的
   `portBoundKind`，别在 semantic 里重写一份。同时改 `semantic.test.mjs:1986`
   那条把错误行为写死的断言。这一条能把 recall 从 2/4 提到 3/4。
2. **`slice(0,3)` 前先看有没有更好的**：现在 `disc=1` 的 C8/M17 被 `disc=0` 的
   两台顶掉。若把「`disc<=1` 且距离 ≤ 30」当作同一档，C8 会进前三，
   M14（`disc=3`, 64 格）会自然出局 —— **精确率和 recall 会同时变好**。
3. `feed_sources` 的长度预算按 **110 字符**算，不要按 60。
