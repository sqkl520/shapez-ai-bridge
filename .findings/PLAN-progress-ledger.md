# 跨轮进度台账：设计 + 可行性验证

2026-11-22。只读分析，未连 bridge、未改 src、未提交。
数据源：`research/ai-plan/runs/` 下 **506 个 L12 快照**（512 份 transcript），
游戏版本 1.5.6 单一，世界全部 `seed:60908`。

---

## 0. 先说三条必须先知道的事

**① 这个目标在 506 个快照里的进度，只有一个值。**

用 `debug_items` 的真实货物（不是传播推算）算一个 7 元组
`(delivered, stored_goal, goal_on_belt, lower_on_belt, upper_on_belt, white, blue)`，
506 个快照只产生 **2 种取值**：

```
484×  delivered=0 storedGoal=0 goalOnBelt=0 lower=0 upper=0 white=0 blue=>0
 22×  同上，但 blue 也没有
```

也就是说：**没有任何一层、没有任何目标形状、120 游戏小时里一次都没有。**
唯一变化的是"颜料矿有没有被挖"。这不是"进度台账没记"，是**进度一直是 0**。

**② 「300 轮」的算术方向错了 —— 世界已经白跑了 9000 轮。**

`GOAL-IS-OUT-OF-BUDGET.md` 算的是「每轮 step 推进 40 游戏秒 ⇒ 需要 300 轮」。
实测这个前提不成立：

| 量 | 实测 |
|---|---|
| L12 全部 994 次成功 apply，每次 `step(2400)` | 994 × 40 s = **11 游戏小时** |
| 世界游戏时钟实际走过 | **118.8 游戏小时** |
| ⇒ 由 agent 推进的占比 | **9.3%**（按 tx=1005 口径算 9.4%，两个口径一致） |
| ⇒ 两次 run 之间自己跑掉的 | **≈90.7%** |

那 90.7% 不是空转，它真的在产出东西 —— 但产的全是上一关的：

```
46 个「间隔 ≥10 分钟」的空隙，合计 101.1 游戏小时
  · 其中 2 个空隙 stored_shapes 变了：CgScScCg 1329→1812→2022（+693）
  · 其余 44 个空隙：0 变化
  · 目标形状：0 件，全部 46 个空隙都是 0
```

`CgScScCg` 是 **L11 的目标**（`levels.js:240`，required 1000）。
所以：**世界在无人值守的情况下已经跑了约 9,090 个「40 秒轮次」，交付了 0 件本关目标。**
瓶颈不是"轮次不够"，是"这条链根本不存在"。继续加轮次只会把 L11 的线跑得更久。

**③ 唯一能回答"哪些带子在搬这个形状"的函数，在 506/506 个快照上是空的。**

`semantic.mjs` 的 `beltsCarryingShape(obs, recipe, shape, …)`：

```
r-20261121190439-6190
  ground truth（debug_items）：139 条带子上真的有 ScSc----
  beltsCarryingShape("ScSc----")  →  0        ← 100% 假阴
  beltsCarryingShape("CuCuCuCu")  →  0        ← 真值 12
  beltsCarryingShape("color:blue") → 200      ← 真值 210，这一条是**对的**
```

全库统计：`ScSc----` 在 **506/506** 个快照上有货，`beltsCarryingShape` 返回 >0 的 **0** 个。
颜料路径（`color:*`）能跑通，**形状路径一条都跑不通**。

⇒ 任何建在它上面的台账都会**永远为空且不报错**。这正是本项目最高频的缺陷族
（`computed-but-never-delivered`）的最坏形态：它不红，它返回 `[]`。

---

## 1. Q1：「进度」该怎么表示

### 1.1 `hub.stored_shapes` 不能当进度，实测三条理由

**(a) 它是累计账本，混着所有更早关卡的产出。** 这份世界的 22 个 key 里：

```
Cu------ 33532   CrCrCrCr 41662   Cu----Cu 27823   RuRuRuRu 14843
RuRu---- 6619    ----CuCu 8476    ----RuRu 4575    --RuRu-- 317
CgScScCg 2071    ← L11 的目标（levels.js:240，required 1000）
CbCbCbCb    6    ← 本关下层的形状，但只有 6 件，且早于档案起点
```

**(b) 它会被**扣**。** 升级从 `storedShapes` 里扣料（`hub_goals.js:352`）。实测跨关：

```
RuRuRuRu 15583 → 14843 (-740)     Cu------ 34332 → 33532 (-800)
RbRb----  7219 →  6619 (-600)     CpCpCpCp     0 →  1205
```

所以"存量涨了"可能是关内产出，也可能是别的关卡在进货；"存量跌了"可能是扣升级。

**(c) 本关目标形状在 `stored_shapes` 里**根本不存在这个 key**。**
`stored_shapes['CbCbCbRb:CwCwCwCw']` = `undefined`（不是 0）。
`worldHealth()` 因此给出 `stored_goal: null`，`classifyNetEffect` 的 positive 判据
（`stored_goal.delta > 0`）在这一关**永远不可能触发**。

### 1.2 `debug_items` 的货物 census 能当进度，但有一个陷阱

货物 census 是游戏自己数的真实数据，506 个快照都一致，可靠。但它区分不了
「活着在流」和「尸体躺在带子上」：

```
r-20261121190439-6190
  items on belts:  ScSc---- ×139, blue ×210, CuCuCuCu ×12, ----CgCg ×2 …
  production(60s): ----CgCg ×4，其余全 0
```

139 条 `ScSc----` 是**卡住的存货**，不是产线。若台账只读 census，会报「上半层有了！」
而事实是那条链冻着。必须同时读 `production` 的窗口产出：

| 字段 | 回答的问题 | 陷阱 |
|---|---|---|
| `items_on_belts[shape]` | 世界上有没有这个形状 | 尸体也算 |
| `production.produced_total[shape]` | 现在还能不能造出来 | 窗口 60s，慢线会漏 |
| `hub.stored_shapes[shape]` | 进过 hub 多少件 | 累计、跨关不清零、扣升级 |

### 1.3 结论：进度 = **每个工序阶段的三态**，不是数字

一关的完成是多步的，而"做到第几步"在本关的正确答案是"一步都没做到"。
能诚实地表达进度的最小结构是**逐阶段三态**：

```
absent        —— 世界从未有过（census 0 且 produced 0）
present-stuck —— 有货但窗口产出 0（像上面那 139 条 ScSc----）
alive         —— 窗口内有产出
delivered     —— 进过 hub（stored_shapes / delivered）
```

这个结构对当前世界会输出「全部 absent」，而那是**真的**，不是缺省值。

---

## 2. Q2：台账该记什么（字段 + 真机验证判据）

设计原则来自今天的三处「加了但没生效」：**每一项都要能回答「真机上怎么证伪」**。
答不上来的不设计。

### 2.1 A 段：阶段台账 —— **不需要存储**，每轮从 obs 现算

```js
/**
 * @typedef {Object} StageLedger
 * @property {string}  goal_shape        // obs.goal.requirement.shape
 * @property {number}  delivered         // obs.goal.requirement.delivered
 * @property {number}  required          // obs.goal.requirement.required
 * @property {number}  stored_goal       // hub.stored_shapes[goal] ?? 0   ← 不是 null
 * @property {Array<{shape:string, on_belts:number, produced:number}>} stages
 *           // stages[i].shape 来自 goal 的两层（":" 切分）+ 配方闭包里可解的子形状
 * @property {Record<'blue'|'green'|'red'|'white'|'cyan'|…, number>} pigments
 *           // 颜料在带子上的件数（census）
 * @property {string|null} first_missing   // 一句人话，指向第一个 absent/stuck 的阶段
 */
```

**为什么不需要存储**：它是 `(obs, items, production, goalShape)` 的纯函数。
存进 `attempts.json` 只会得到一份"每轮都被覆盖、内容恒等于同一串"的文件。

**真机验证判据（必须能证伪）**：

1. **跨快照判别测试**（防"恒等于常量"）：
   取 `r-20261115111349-0095`（census 里 `cyan ×83`）与 `r-20261121190439-6190`
   （`cyan 0`）两份真实 `obs/items`，渲染出的台账行**必须不同**。
   若两份渲染出同一行 ⇒ 功能是死的（这正是 `feed_sources` 那一类失败）。
   这条可以作为离线单测，夹具就是真机快照，不 skip。
2. **三态判别测试**：6190 的 `ScSc----` 必须渲染成 `present-stuck`（有 139 件、窗口产出 0），
   而 `----CgCg` 必须渲染成 `alive`（窗口产出 4）。两者都非空时才能证明三态真的分开了。
3. **真机落地**：跑一轮，看 `timeline.log` 里该行是否随 tx 变化。
   这一条不能代替 1/2，只能补充 —— 名称与措辞的任何改动都先跑 1/2。

### 2.2 B 段：历史高水位 —— **唯一真正需要跨 run 存储的东西**

单张快照无法回答"我是不是在退步"。实测这条是真痛点：

```
峰值  belts_reaching_hub = 602   (r-20261118160033-bceb)
现在  belts_reaching_hub = 309   (r-20261121190439-6190)
```

模型从来没见过 602 这个数。它每一轮只看见 309，于是"把死带子从一处挪到另一处"
看起来像在干活。

```js
// attempts.json → worlds[worldKey].hw[goalShape]
{
  "delivered_max": 0,        // number  历次 max(goal.requirement.delivered)
  "stored_max": 6,           // number  历次 max(hub.stored_shapes[goal] ?? 0)
  "reach_max": 602,          // number  历次 max(worldHealth.belts_reaching_hub)
  "reach_last": 309,         // number  上一次 run 结束时的值
  "runs": 506,               // number  在这个目标上跑过几次
  "first_seen": "2026-11-15T11:13:49Z",
  "last_seen":  "2026-11-21T19:05:16Z"
}
```

**这一项有真实的落地陷阱，必须先修**：`memory.mjs` 的 `normalizeWorld` 只白名单
4 个字段，其它一律丢弃 —— **静默**。实测：

```
mergeMemory({version:2,...}, [], {"seed:1":{last_goal:"A", progress:{...}}})
  → worlds["seed:1"] = {"last_goal":"A","last_level":12,"last_seen":"…"}   ← progress 没了
saveMemory → loadMemory 一样没了                                            ← 两处都丢
```

这与 `memory.mjs` 文件头里记过两次的 bug 是同一族（"加顶层字段时两处都要改"）。
另外 `mergeMemory:386` 是**浅合并** `{...worlds[key], ...w}` —— 嵌套的 `hw`
会被整块替换，第二个 goal 的历史会丢。这条也要改。

**真机验证判据**：

1. **往返测试**（防静默丢弃）：`mergeMemory(old, [], patch)` → `saveMemory` → `loadMemory`，
   断言 `hw` 与里面每个字段逐一相等。**当前这条会红** —— 红就说明还没接上。
2. **从真实档案回放**：把 index ≤ K 的 506 个快照按时间顺序喂给累加器，
   断言 `reach_max === 602`，且第 506 条的 `reach_last === 309`。
   这是用真数据算出来的期望值，不是手写的常量。
3. **渲染测试**：用 6190 的 obs 构造 prompt，断言 `## GOAL` 段出现 `best-ever 602`。
   （见 2.3 的预算实测：这段放得下。）

### 2.3 C 段：**明确不做的几项**（以及为什么）

| 想记的 | 为什么不做 |
|---|---|
| "已完成步骤列表 `steps_done[]`" | 本关 506 个快照 `steps_done` 恒为空。写一个恒空数组，模型会以为"清单没读到" |
| "下一步 `next_step`" | 这是**建议**不是**记账**。而且配方求解器在 L12 上是 capped（`recipe.ok=false`），唯一可用的分层提示已经在 prompt 里了 |
| 进度百分比 / 进度条 | 用户明确说过不需要；而且分母（1000 件）在当前产能下没有意义 |
| 用 `beltsCarryingShape` 定位阶段 | 506/506 假阴，见 §0③。**任何用到它的台账都是恒空** |
| 把 `CgScScCg` 的 2071 件记成"进度" | 它是 L11 的遗产，而且**冻结了**：`r-20261116005053-bdd0` 之后 373 个 run、104 游戏小时，它一分没动 |

顺带一个必须写进 prompt 的事实：`CgScScCg` 自 **2026-11-16 00:50** 起冻结。
世界已经 138 壁钟小时没有向 hub 送进任何东西。这是"世界是静止的"最硬的证据，
而模型从来没有机会知道。

---

## 3. Q3：与 `## PRIOR ATTEMPTS` 的分工，以及**预算实测**

### 3.1 分工：一个是判词，一个是读数

| | `PRIOR ATTEMPTS` | 进度台账 |
|---|---|---|
| 记什么 | 「我试过 X，机器判它 **有害/无用/有效**」 | 「世界上现在**有什么**，历史**最好过什么**」 |
| 来源 | `classifyNetEffect` 的结论（**判定**） | `debug_items` / `production` / `hub`（**读数**） |
| 粒度 | 每个 action_set 一条 | 每个阶段一条，全关一份 |
| 冲突时 | | **读数优先** |

冲突现在就已经存在，而且是实打实的：

```
PRIOR ATTEMPTS 说：  connect → ROLLED BACK automatically — judged harmful  [seen 26×]
6190 真机说的是：     connect tx 35/35 落盘，产生了这个世界唯一的增量产出（----CgCg ×4）
```

原因在 `health.mjs` 的 `classifyNetEffect`：`connect` 的特征是「带子 +N、死带子 +N」，
施工中间态按定义就是"死带子涨了"。容差修过两轮（2% / 10 条），但一次 23 格的长线
仍然会越界。另一个 agent 正在修这条，**在它落地之前，台账必须显式声明读数优先**，
否则模型拿到的是两条互相矛盾的记忆 —— 而"互相矛盾的记忆"在本项目里已经让模型
主动放弃了 `connect`（`one-belt-drop-ate-the-memory`）。

**建议的渲染顺序**（同一段内，相隔 3 行以内，中间必须有优先级句子）：

```
## WHERE THE CHAIN ACTUALLY IS           ← 读数（A 段）
...
## HISTORY ON THIS GOAL                  ← 高水位（B 段）
best-ever 602 belts reaching the hub; now 309 — you are 293 belts below your own best
## PRIOR ATTEMPTS                         ← 判词（现有段落，砍到 3 条）
...
⇒ Where the two disagree, the measured state above wins: a macro can be judged
  harmful and still have been the only thing that ever worked.
```

### 3.2 预算实测：**现在就已经装不下了**

这不是推测，是 `buildPrompt` 在真机快照上的实际行为（`prompt_tokens_max` 生产值是 **5300**）。

**`r-20261121100232-d10f`，同一份世界，只切换 `priorAttempts`：**

| | user 字符 | 带子 | 诊断点名带子 | CAPACITY | HUB stored |
|---|---|---|---|---|---|
| 不传 prior | 18710 | **16**/699 | **4**/4 | 有 | 有 |
| 传 6 条 prior | 18540 | **11**/699 | **0**/4 | **丢** | **丢** |

6 条 prior = 1236 字符 ≈ 354 token，代价是 **5 条带子 + CAPACITY 整段 + HUB 存量整段**。

**`r-20261121190439-6190`（772 实体 / 722 带子，最新也最大）在 5300 下：**

```
targetChars = 5300 × 3.5 = 18,550
实际 user    = 18,741        ← 已经超了 191 字符，over_token_budget = true
带子 9/722   · 诊断点名 0/5  · HUB stored 已丢
```

⇒ **世界一膨胀，prompt 就在饿死。** 再往 GOAL 里加一行（约 141 字符 ≈ 41 token）
必须从别处挪，而"带子优先"的结构性纪律不允许它抢带子。

（同日另一份分析 `.findings/PROMPT-BUDGET-SATURATED.md` 独立得出同一结论：
5300 档余量 −72 字符，任何新增信息都在和多显示一条带子竞争。两份数字可对账。）

### 3.3 唯一有余额的付款方：3633 字符的**与世界无关的**样板

`r-20261121190439-6190` 在 5300 下的段偏移实测：

```
  3482   73 ## GOAL                                     ← 18.6%
  3555  955 ## RECIPE UNAVAILABLE — search capped
  4510 1021 ## SHAPE CODE CHEAT SHEET
  5531 1108 ## BUILD ORDER FOR A COMPOUND SHAPE
  6639  549 ## THERE IS NO "BUILD THE WHOLE LINE" MACRO
  7188  152 ## HUB
  7340 1734 ## MACHINES (20 of 49)
  9074  229 ## CAPACITY
  9303  806 ## BELTS (9 of 722; 0 of 5 …)
 10495 3109 ## DIAGNOSIS (8)
```

四段样板合计 **3633 字符 ≈ 1038 token**，**每一轮逐字相同**，且没有一段能说明
"现在做到哪一步"。其中：

- `SHAPE CODE CHEAT SHEET`（1021）**必须保留** —— 它修的是
  `shape-code-vs-color-code` 那个真实错误（`Cb` 不是 cyan 蓝，是 circle+blue）。
- `BUILD ORDER`（1108）+ `NO "BUILD THE WHOLE LINE" MACRO`（549）= **1657 字符**，
  内容是"每一步花一整轮"、"不要找捷径"。506 个 run、0 步进度之后，这两段的生产率是 **0**。
- `RECIPE UNAVAILABLE`（955）在 L12 上恒为 capped，内容固定。

**付款方案**：删 `BUILD ORDER` + `NO-SHORTCUT`（−1657），加 A 段（+约 300）+ B 段（+约 120），
净 **−1200 字符**，带子与 CAPACITY 只会更好。实测 6190 在 `tok=5617` 时带子 9→17、
诊断点名 0/5→5/5、HUB stored 出现 —— 那正是 +1109 字符的效果，而这里净增 −1200。

---

## 4. Q4：最小可行版本

**如果只能做一件事：把「阶段台账」作为一行读数放进 `## GOAL`。不存储、不改记忆文件。**

理由，按证据排：

1. 它是**唯一一条**能改变"模型每轮从零推理"的事实，而且每一轮都在变（至少在
   census 上是变的）。
2. 它不需要碰 `memory.mjs` 的静默丢弃陷阱 —— v1 完全没有存储，就不会有
   "加了字段但被 `normalizeWorld` 吃掉"这种失败形态。
3. 它放得下：141 字符 ≈ 41 token，位于偏移 3482（18.6%），并且同段已有先例
   （`renderMinerColorGap` 就是按 `gap-hint-belongs-in-goal-section` 那条教训
   加进 `renderGoal` 的，第 80 字符处的提示模型当场采纳，第 2500 字符处 4 次全忽略）。
4. 它是**可证伪的**：两份真实快照（cyan 83 vs cyan 0）必须渲染出不同的行。

**具体形态**（贴近真实数据验证过的渲染，141 字符）：

```
PROGRESS delivered 0/1000 | layers: CbCbCbRb absent · CwCwCwCw absent |
pigments on belts: blue 210, white 0 | goal has never entered the hub
```

**改动面（不写代码，只定接口）**：

- 新纯函数 `progressLedger({ obs, items, production, goalShape })` → §2.1 的结构，
  放 `semantic.mjs` 或新模块，**零 IO、纯函数**（与 `worldHealth` 同一条纪律）。
- 在 `renderGoal`（`prompt.mjs:704`）里调用并 push 一行。
- 同时删掉 `BUILD ORDER` / `NO-SHORTCUT` 两段（`prompt.mjs` S3 组装处）。
- **不要**碰 `beltsCarryingShape`（它需要先修形状传播，那是另一件事）。
- **不要**碰 `memory.mjs`（v1 不存储）。

**验收（三条，全都能在离线快照上跑）**：

| # | 断言 | 会在什么情况下红 |
|---|---|---|
| 1 | 用 0095（cyan 83）与 6190（cyan 0）两份真实 items 渲染，两行**必须不同** | 台账恒等于常量（`feed_sources` 同族） |
| 2 | 6190 的 `ScSc----` 判 `present-stuck`，`----CgCg` 判 `alive` | 三态没分开，把尸体当成产能 |
| 3 | 渲染后的 prompt 里，带子数**不低于**加它之前（6190 基线 9 条） | 又被从带子名额里抢（这条最容易悄悄红） |

---

## 5. 我认为方向本身有问题的地方

### 5.1 「300 轮」不该由单个 agent 完成 —— 而且它已经不是瓶颈

见 §0②。世界已经无人值守跑了约 9,090 个 40 秒轮次的游戏时间，交付 0 件。
再加轮次只会让 L11 的线多跑几百小时。

**正确的做法是先把"链存不存在"这件事做成可观测、可验收的**，
也就是本报告的 A 段。如果 A 段上线后连续 N 个 run 仍然全是 `absent`，
那结论就不是"轮次不够"，而是"当前 agent 造不出这条链" —— 那是完全不同的问题，
需要的是把装配拆成可验收的子目标（每一步都有独立的绿/红判据），
而不是加预算。

### 5.2 台账不能解决"跨 run"这件事 —— 因为这一关根本没有跨 run 的进度

`attempts.json` 里 `CbCbCbRb:CwCwCwCw` 有 24 条记录，但没有一条是"进度"，
全部是"试过什么"。这不是设计失误，是**客观事实**：这一关的进展是 0。
所以"跨轮进度台账"这个提法，在能记录任何进度之前，实际产物是一行
"你什么都没做成"。

**那一行仍然是有价值的** —— 因为模型现在连"什么都没做成"都不知道，
它每一轮都在修一条 2026-11-16 就冻结了的 L11 产线（`CgScScCg` 2071 件，
此后 373 个 run 一分没动）。但价值来源是**打破错觉**，不是**提供连续性**。
把预期写在前面：上线后如果看到的是"更早放弃"，那不是回归，那就是真话在起作用。

### 5.3 两个"看起来更急"但会毁掉台账的陷阱

**(a) 不要用 `beltsCarryingShape` 做任何台账字段。** 506/506 假阴且不报错。
用 `debug_items` 的 census 直接数。

**(b) 不要在没有修 `normalizeWorld` 的前提下加 `worlds[]` 字段。** 实测静默丢弃，
两处（`mergeMemory` / `loadMemory`）都丢，且 `mergeMemory:386` 是浅合并。
若直接按"加个 `progress` 字段"实现，会在真机上表现为"字段一直是空的"，
而单测如果只测函数返回值而不测往返，会全绿 —— 这是 `computed-but-never-delivered` 的第四次。

---

## 6. 若要做 v1.1（高水位）的附加条件

v1.1（B 段 reach_max / reach_last）值得做，但必须**先**满足：

1. `memory.mjs` 的 `normalizeWorld` 加白名单 + `mergeMemory:386` 改深合并 `hw`，
   并用 §2.2 的往返测试钉住。
2. `PRIOR ATTEMPTS` 从 6 条砍到 3 条（实测 6 条 = 1236 字符，砍一半约省 600 字符，
   足够付 B 段的 120 字符，还回 2~3 条带子）。
3. `classifyNetEffect` 的施工中间态豁免先落地 —— 否则 B 段的"你比最好成绩低 293"
   会和 PRIOR ATTEMPTS 的"connect 有害"同时出现，模型的反应大概率是
   **两边都不做**（`one-belt-drop-ate-the-memory` 实测过：57 次 `remove_run`
   被记成坏动作之后，agent 手上就没牌了）。

---

## 7. 方法与复现

分析脚本全部在 `.tmp-plan/`（报告后删除）。关键几条：

| 脚本 | 得到的东西 |
|---|---|
| `coord.mjs` | 506 快照的 7 元进度坐标 → 只 2 种取值 |
| `bsweep.mjs` | `beltsCarryingShape` 在 506/506 上的假阴率 100% |
| `drift.mjs` / `idle.mjs` | step 占 9.3% / 空转 90.7% / 空转只产 L11 |
| `freeze2.mjs` | `CgScScCg` 冻结起点 2026-11-16 00:50，其后 373 run |
| `memprobe.mjs` | `normalizeWorld` 静默丢弃未知字段（可复现） |
| `ab.mjs` / `marginal.mjs` / `secs.mjs` | prior 6 条的预算代价 + 3633 字符样板清单 |
| `render.mjs` | 141 字符台账行的原型渲染 |

用到的只读数据：`research/ai-plan/runs/*/obs-last.json`、`items-last.json`、
`production-last.json`、`transcript.jsonl`、`verify-last.json`、`HALT.json`；
游戏源码 `recon/upstream-full/src/js/game/{hub_goals.js, modes/levels.js, modes/regular.js}`。
