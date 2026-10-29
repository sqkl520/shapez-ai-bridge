# diagnose 产线语义化：实现契约 v1

日期：2026-10-29
输入：规划 agent 提案 + 核对 agent 事实 + 主线程复核

> **状态**：本文件是规划 agent 的产出，主线程已复核关键事实（F1/F3 与"最可能出错处"的预测全部成立）。
> F2（prompt.toHub 标记错）另派审计 agent 在查，**结论待补**。

---

## 0. 三条实测事实（主线程已逐条复跑验证）

| # | 事实 | 主线程复核 |
|---|---|---|
| F1 | **solver spawn 是 200–400 ms，不是 2–3 ms** | ✅ 实测 6 次：394/338/234/218/207/263 ms，中位 263 |
| F2 | **BELTS 段 `[not reaching hub]` 标记方向性错**：标 105 条，真正到不了 hub 的只有 23 条 ⇒ 87 条误标 | ⏳ 审计 agent 在查（`research/ai-plan/PROMPT-TOHUB-AUDIT.md`） |
| F3 | **L4 的真实病理不是「断」，是「送错」** | ✅ 完全坐实，见下 |

### F3 的完整证据（主线程实测）

L4 里唯一那台 cutter `C1#10036@(-8,-11)`：

```
输入（南, -8,-10）→ belt#10058
左口（北, -8,-12）→ belt#10059  → 沿下游追 ⇒ 【到达 hub】
右口（北, -7,-12）→ underground_belt#10077（隧道）⇒ 【停住，出不去】
```

hub 库存：`{CuCuCuCu: 46, ----CuCu: 47376, RuRuRuRu: 112866}` —— **没有 `RuRu----`**。

⇒ **废料 `----CuCu` 大量入库（47376），产品 `CuCu----` 卡在隧道里。**

这就是「病态」的定义级样本：**不是断了，是接反了**。

L5 同形但更直白：

```
cutter#10902@(4,-13):
  左口 → trash#10901@(4,-14)     ← 一边直接进垃圾桶
  右口 → belt#10150@(5,-14)
```

一台 cutter 把产品的一边扔掉，而目标 `Cu----Cu` 需要把 `CuCu----` 再旋转一次。

---

## 1. 核心裁决：不判「断」，判**残差**

把世界看成有向图（边 = 严格校验过可流性的输入槽/输出槽），然后：

1. `R` = 能走到 hub 的节点集（反向 BFS，**允许穿机器**，隧道视为屏障）
2. **流（stream）** = 两条边界之间的极大带子段。边界 = 矿机输出 / 机器输出槽 / hub / 断开点 / 隧道口
3. `need: Map<kind, n>` —— 由 **level-gated** solver 给出
4. **贪心分配**：按 `(能否到 hub 降序, 形状已知降序, 到 hub 跳数升序, 链头句柄升序)` 排序流；
   按配方拓扑序，把 `need[kind]` 台工序机器分配给**链头形状 == 该步输入哈希**的流
5. **残余即诊断**

| 残余情形 | 判定 | 码 |
|---|---|---|
| 某流带着 recipe 中间形状、需要工序 P，但 P 被更高优先级流占用/工厂不够 | **正常断（有救）** | `PROCESSOR_REQUIRED{scope:"stream"}` |
| 工厂里该类工序总数 < need（纯计数，不需要形状） | **正常断（缺机器）** | `PROCESSOR_REQUIRED{scope:"factory"}` |
| 流头形状 == 目标形状，但到不了 hub | **病态** | `GOAL_SHAPE_STRANDED` |
| 流头形状 ∉ recipe 闭包 ∪ {goal}，且该流能到 hub（会污染交付） | **病态（送错）** | `OFF_RECIPE_LINE` |
| 流头形状 ∉ 闭包 且到不了 hub | **正常/无关** | 不报 |
| 形状算不出来 | **不可判定** | `SHAPE_UNKNOWN`（info，绝不 blocker） |
| 分配后仍多余的同形流 | **正常（冗余）** | `SURPLUS_INPUT`（info） |

**为什么可计算而非「看情况」**：
- `recipe.closure` 是 solver `steps[].hash` 的**字面集合**
- 分配顺序是**全序**（四项 tie-break 全来自 uid/句柄/整数）⇒ 同一份 obs 永远同一结果
- 三条判据互相独立可测：计数层 / 形状层 / 结构层

---

## 2. 「这条链在造什么形状」——能算，但只算到可证边界

前向传播（纯函数，用仓库既有代数，不重写）：

```
mine(resources[cell])            → resourceHash
belt:   shape = shape(上游实体)   （上游 = beltEntry 反向一格）
balancer: 两路输入取并集 → 两路输出都发全集
cutter:  cutHalf(parse(s))[0] = left, [1] = right   ← 用 shape-ops，不硬编码哪边是产品
rotater: rotateCW / rotateCCW / rotate180
stacker: stack(lower, upper)
painter: paint(shape, color)，颜色解析不出 ⇒ 未知
underground_belt: 屏障，不传播
```

**「未加工的完整形状」够用**：诊断只需回答两件事——
① 这条流当前形状是否在闭包里（决定"该不该动"）；② 下一步该用哪种工序（决定"缺什么"）。
两者都只依赖 hash 的**集合成员关系**。

L4 就是活例：只要知道 `shape(B63…B113) = RuRuRuRu ∈ closure` 且 `nextStep(RuRuRuRu) = cut`，
就足以给出全部结论。

**信息缺失时的行为（都要显式降级，不许猜）**：

| 缺失 | 行为 |
|---|---|
| `obs.resources` | 形状层整体禁用 → `SHAPE_UNKNOWN{reason:"no-resources"}` |
| solver 配方 | 语义层整体禁用，只留计数层 + 结构层 |
| 隧道配对 | 跨界结论 → `SHAPE_UNKNOWN{reason:"tunnel"}` |
| `r≠0` 的非方形机器 | `SHAPE_UNKNOWN{reason:"unverified-rotation"}` |

---

## 3. 新增 7 个诊断码

| 码 | 触发 | layer/severity | candidates |
|---|---|---|---|
| `PROCESSOR_REQUIRED` | 分配器残余 | L4/blocker | replace_run, insert_machine, connect |
| `GOAL_SHAPE_STRANDED` | 流头形状==goal 且到不了 hub | L4/blocker | connect, replace_run, extend_line |
| `WRONG_SHAPE_AT_HUB` | `delivered==0` 且 hub 入口流形状 ⊄ {goal} 且非空 | L4/blocker | replace_run, connect |
| `OFF_RECIPE_LINE` | 流头形状 ∉ 闭包 且能到 hub | L4/warn | trash_unused, remove_run |
| `SURPLUS_INPUT` | 同形流多于配方所需 | L4/info | trash_unused, remove_run |
| `BELT_DUMPS_INTO_BODY` | 带子出口格不是合法输入槽，或机器输出格是另一台机器本体 | L2/warn（goal-relevant 时 blocker） | connect, trash_unused, replace_run |
| `SHAPE_UNKNOWN` | 传播遇到 no-resources/tunnel/unknown-op/cycle/unverified-rotation | L4/info | `[]`（**不许喂给 LLM**） |

**明确不加** `HUB_INLET_UNFED` —— 16 个入口里 13 个空着是正常的，加了必然是噪音。

---

## 4. 过滤器怎么改

**把 `hubReachable` 换成两段式**：

```
goalRelevant = ⋃ components where (containsHub) ∨ (contains miner with resource ∈ recipe.rawSet)
```

- `recipe` 缺席 ⇒ `rawSet = ∅` ⇒ 只剩 `containsHub` 一支（保守）
- 语义码再额外要求 `component ∈ goalRelevant`

### 必须**不报**的清单

| 情形 | 防线 |
|---|---|
| hub 的 13 个空入口 | 不设 per-inlet 码 |
| balancer 的 secondary 空着 | 保留"任一槽通即不坏" |
| trash 没有输入 | `SLOT_STARVED` 跳过 `type==="trash"` |
| 与 hub 无关的旧线 | 组件过滤器 |
| 穿过隧道的流"看起来断了" | 降级 `SHAPE_UNKNOWN`，禁升级 blocker |
| 冗余输入（修好 L4 后 x=5 上半段） | `SURPLUS_INPUT{info}` |
| `obs.truncated` | 语义层整体返回空 |
| `items`/`production` 不可用 | 语义码**只**依赖 obs+recipe |

### 防指纹抖动的硬纪律

语义码的 `evidence` 只能含 `handles/uids/op/kind/need/have/scope/shape` 这类**世界稳定量**；
**禁止**放窗口计数、`itemsOnPath`、时间戳 —— 否则 `fingerprintOf` 每轮变，`NO_PROGRESS_3X` 静默失效。

---

## 5. L4 接上语义后应该输出什么

**前置**：`recipe = cut(half=right) from RuRuRuRu`；`need={cutter:1}`；`closure={RuRuRuRu, RuRu----}`

| # | code | subject | 关键内容 |
|---|---|---|---|
| 1 | `WRONG_SHAPE_AT_HUB` | H1 | hub 收到 `RuRuRuRu` 与 `----CuCu`，但目标要 `RuRu----` |
| 2 | `PROCESSOR_REQUIRED`(scope=stream) | L3 | 目标需要 cutter×1 在 `RuRuRuRu` 那条流上；唯一的 cutter 在铜线上 |
| 3 | `OFF_RECIPE_LINE` | C1 | 这条线的形状不在目标配方里（`CuCuCuCu → ----CuCu`） |
| 4 | `SHAPE_UNKNOWN`(tunnel) | B85 | 这条流穿过隧道 |
| 5 | `NO_PRODUCTION` | H1 | 现有码，保留 |

**明确不出现**：`GOAL_SHAPE_STRANDED`、`SLOT_STARVED`、`OUTPUT_UNROUTED`、`DEAD_END`、
任何以 `B136` 为 subject 的码。

### 模型还会不会去改 hub 入口？

**预期不会，起作用的是第 1 条 `WRONG_SHAPE_AT_HUB`。** 它做了三件 prompt 做不到的事：
1. 告诉模型**入口已经在送货**，只是形状不对 —— 消掉"hub 没交货"这个错误前提
2. 把"缺的是切"与"缺的是连接"分开（`replace_run` 权重 > `connect`）
3. 第 2 条把句柄级改点顶到 BELTS 段最前（`pickBelts` 先放 `referencedHandles`）

**诚实边界**：诊断只能降低、不能禁止。要禁止需在 plan 阶段加 `REPAIR_OFF_TARGET` —— **本次不做**。

---

## 6. 性能与纯函数性

### 决定一：`diagnose` **不许**调 solver，配方由 loop 预计算后注入

```js
export function diagnose(obs, items, production, report, goal, handles, ctx = {})
// ctx.recipe: {ok, steps, needs, closure, raw, level, gated, source, reason?}
```

- `ctx.recipe` 缺席 ⇒ 语义层自动降级，**绝不 spawn**
- 预计算点：loop 首轮 observe 之后（需要 `obs.goal.level`），每 run 一次

### 决定二：缓存三层

| 层 | 位置 | 键 | 上界 |
|---|---|---|---|
| per-run | loop 的 `st.recipe` | — | 1 |
| 模块内 memo | `recipe.mjs#recipeForGoalCached` | `${goal}|${level}` | 8（LRU） |
| 测试 | `clearRecipeCache()` | — | — |

**不允许持久化到磁盘**（会成为第二份真值）。

### 决定三：`diagnose` 保持纯函数

理由不是洁癖：它在 loop 里每轮跑、在测试里被当纯函数直接调、输出进 `fingerprintOf`。
引入 spawn 会让"同 obs 两次调用结果不同"成为可能，指纹与 `NO_PROGRESS_3X` 全部失效。

**可测试性**：语义核放 `diag_semantics.mjs`（零 IO、零 `node:` import），
测试用**手工构造的 recipe 对象**驱动，完全不碰 solver。

### 连带修正（必须一起做）

`prompt.mjs` 现在**每次 `buildPrompt` 都 spawn 一次 solver**（200-400ms）。
加语义后若 diagnose 再 spawn，每轮成本翻倍。所以：
1. `buildPrompt` 接受可选 `recipe`（已算好就复用）
2. `recipeForGoalCached` 内部**按 level 门控**：`level < 16` 时加 `--no-cutquad`

**这是一处真实 bug 的修复**：现在 `prompt.test.mjs` 的 `baseOpts()`（goal `Cu----Cu`, level 5）
渲染出的配方是 `cutQuad×2 + stacker×1`（cutQuad 要 L16、stacker 要 L10），
而存档只有 2 台 cutter、0 台 stacker。**这段 prompt 目前在骗模型。**

---

## 7. 必须的 9 条测试（含 4 条负例）

| # | 断言 | 类型 |
|---|---|---|
| T1 | L4：`PROCESSOR_REQUIRED{op:"cut",scope:"stream",need:1,have:1}` 存在；`site_handles` 合法集 = `y∈{-14..-9}` 共 6 行（**断言集合成员，不断言单一坐标**）；无 `GOAL_SHAPE_STRANDED`；无任何 subject 为 B135/B136/B137 的码 | 正 |
| T2 | L4：`WRONG_SHAPE_AT_HUB` subject=H1 且 observed 含两种形状；`OFF_RECIPE_LINE` subject=C1 | 正 |
| T3 | **修好后**（克隆 L4，删 3 带 + 加 cutter/trash）：`blocker` 级语义码 **= 0** | **负** |
| T4 | L5 原样（无 resources）：出现 `PROCESSOR_REQUIRED{kind:"rotater",scope:"factory",need:1,have:0}`；形状类码全为 `SHAPE_UNKNOWN` | **负** |
| T5 | 噪音门：不含 M5/B129/L4/L5/L6/B83/B99/B92；无 `SLOT_STARVED` 指向 balancer secondary 或 trash | **负** |
| T6 | 纯函数：同 obs 调两次 → 指纹相同；源码扫描不含 `spawnSync|child_process`；无 recipe 时 500 次 < 1s | 正 |
| T7 | 配方门控：`recipeForGoal("Cu----Cu",{level:5})` 不含 `cutQuad`/`stacker`；`CUTQUAD_MIN_LEVEL === 16` | 正 |
| T8 | 隧道降级：只出 `SHAPE_UNKNOWN{tunnel}`，不出 `GOAL_SHAPE_STRANDED`/`OFF_RECIPE_LINE` | **负** |
| T9 | 坐标禁令 + 预算：新诊断不含坐标形态；L4 整份 prompt < 12000 chars、S4 < 2500 chars | 正 |

---

## 8. 可证伪判据（避免第十二轮那种"判据本身错"）

### 判据不写坐标、不写单一 y

复用语义核在实验脚本里**独立重算**：

```
apply(plan) → world'（FakeGame 深拷贝）
PASS ⟺ ① 新 cutter 输入槽被喂
       ② 产品口下游能到 hub
       ③ 废料口下游是 trash（或按 wasteRoles 被覆盖）
       ④ 无 blocker 级语义码
       ⑤ 原链没被删成"矿机悬空"
```

接受集 = **所有**满足上述的落点（L4 实测 = `y∈{-14…-9}` 6 行），不是历史那一行。

### 两个对照必须先跑

- **正对照**：历史解 `cutter@(4,-13)+trash@(4,-14)` → 必须 PASS
- **负对照**：`cutter@(4,-8)+trash@(4,-9)`（落在矿机那一行，输入槽对着空气）
  → **旧判据会 PASS**（y=-8 在 `[-16,-8]` 内、trash 在 y-1、删的都是链上带子），
  **新判据必须 FAIL**

负对照同时证明旧 20% 的口径在链头有洞，新判据不是同义反复。

### 成功 / 失败的判据

**成功（缺一不算）**：
1. **行为层（最灵敏）**：`touched hub inlet without fixing the Ru line` 从基线 **6/10** 降到 **≤1/10**
2. 旧判据 `structural_ok` 不回归（≥2/10）
3. 新判据 ≥6/10，且先过正/负对照
4. 正解可见性仍 10/10（回归红线）

**失败**：语义正确 ≤2/10，或 `touched hub inlet` 上升，或可见性跌破 10/10。

**单元级最快证伪（便宜且零方差）**：T3（修好后的世界仍有 blocker）红 ⇒ 语义层会跟正解打架，
直接回滚，不必跑真 LLM。

### 统计的诚实边界

n=10 无法区分 40% 与 60%。所以**不要**用"20%→40%"宣称成功；
只用「**行为指标 6/10→≤1/10** + 单元判据全绿 + 正/负对照通过」作为成功证据。

---

## 9. 文件清单

| 文件 | 改动 | 风险 |
|---|---|---|
| `src/agent/loop/diag_semantics.mjs` | **新增** ~450 行纯函数 | 低 |
| `src/agent/loop.mjs` | `diagnose` 加第 7 参；过滤器替换；新码发射；`RANK` 重排 | **中** |
| `src/agent/loop/constants.mjs` | `DIAG_CODES` +7；`RETRIEVAL_TABLE` +7 | 低 |
| `src/agent/loop/recipe.mjs` | `recipeForGoal` + level 门控 + LRU 缓存 | 低 |
| `src/agent/loop/prompt.mjs` | `buildPrompt({recipe})` 复用；标记改基于 `goalRelevant` | 中 |
| `src/agent/experiment-coldstart.mjs` | 注入 recipe；语义判据 + 正负对照 | 中 |

**不改**：`src/ai/compiler/**`、`handles.mjs`、`verify_runtime.mjs`、宏层。

---

## 10. 反例清单（9 种误导情形 + 防线）

| # | 情形 | 误导 | 防线 |
|---|---|---|---|
| 1 | `obs.truncated` | 拓扑/形状全错却给 blocker | 语义层返回空 |
| 2 | 缺 resources（L5 夹具） | 把所有流判成"不在配方里" | `SHAPE_UNKNOWN{no-resources}` |
| 3 | 路径有隧道（L4 B85/B65） | 流"看起来断了" | 隧道=屏障；降级 |
| 4 | balancer 两路等价 | 假 `OUTPUT_UNROUTED` 满天 | "任一槽通即不坏" |
| 5 | **按 `wasteRoles` 硬编码产品/废料** | 目标被丢进 trash（历史真发生过） | **不**硬编码端口；用配方下一步哈希匹配 |
| 6 | 配方未 level 门控（现状 bug） | 在 L5 叫模型造 L16 的 cutQuad | `--no-cutquad` + T7 |
| 7 | **冗余输入被当 blocker** | 模型去"修"正解造成的副作用 | `SURPLUS_INPUT{info}` + T3 |
| 8 | 语义码里放窗口计数 | 指纹每轮变，`NO_PROGRESS_3X` 失效 | evidence 只许稳定量 + T6 |
| 9 | `SLOT_STARVED` 指向 trash/无源 balancer | 引模型去给旧线接料 | 跳过 trash；组件过滤器 |

---

## 11. 规划 agent 的「最可能出错处」——已验证成立

> 「把'哪条流该配哪台机器'的贪心分配写成'按拓扑就近'。
> L4 修好之后，x=5 上半段会合法地变成一条被 cutter 本体堵死的冗余流；
> 分配器若按就近分配，会把 cutter 判给这条死流，然后对真正的 Ru 流再报一次
> `PROCESSOR_REQUIRED` —— 语义层就会跟正解打架，表现为'越修越红'。」

**主线程实测确认**（footprint 级索引）：

```
修复后 (4,-13) → cutter#20001
修复后 (5,-13) → cutter#20001      ← 被 cutter 本体占
修复后 (5,-12) → belt#10148        ← B91 的出口正指向 (5,-13)
⇒ x=5 上半段变成一条被堵死的冗余流
```

**防线只能是 T3（修好后的世界必须 0 个 blocker）+ T5 噪音门**，
二者不通过就回滚，不要靠 prompt 圆场。

---

## 12. 分阶段落地

1. **P-a**（纯新增，不动 loop）：`diag_semantics.mjs` + 测试 T1/T2/T5/T8 + `recipeForGoal` 门控(T7)
2. **P-b**（接线）：`constants` +7 码；`loop.diagnose` 第 7 参；过滤器替换；`RANK`；跑全量
3. **P-c**（prompt）：注入 recipe；改标记；S4 文案；同步 `prompt.test` §9
4. **P-d**（实验）：语义判据 + 正/负对照 + 两个行为指标

---

## 13. 主线程独立验证（追加）

### 13.1 形状传播的地基成立 ✅

矿机能读到挖什么：

```
M10001/10017/10033/10034 @ x=-10..-7  → CuCuCuCu
M10079/10080/10081/10082 @ x=2..5, y=-8 → RuRuRuRu
```

两条 Ru 链的完整拓扑（实测追踪）：

```
x=4: M10081(4,-8) → B10138(-9) → B10139(-10) → B10206(-11) → B10208(-12)
                  → B10209(-13) → B10143(-14) → B10144(-15) → balancer#10085(-16)
x=5: M10082(5,-8) → B10145(-9) → B10146(-10) → B10147(-11) → B10148(-12)
                  → B10149(-13) → B10150(-14) → B10151(-15) → 断
```

**两条链都运 `RuRuRuRu`**，正解是在 `(4,-13)+(5,-13)` 插 cutter（2×1 正好吃掉两列）。

句柄对照：`B112@(4,-9)`=链头、`B81@(4,-13)`=目标之一、`B63@(4,-15)`=链尾。

⇒ 契约 §2 的「未加工的完整形状够用」成立。

### 13.2 F3 的双向确认 ✅

L4 的 cutter `C1#10036@(-8,-11)`：
- 左口 → `B10059` → **到达 hub**
- 右口 → `underground_belt#10077`（隧道）→ **停住**

hub 库存 `{CuCuCuCu:46, ----CuCu:47376, RuRuRuRu:112866}` —— 没有 `RuRu----`。

⇒ 废料入库 47376、产品卡在隧道。**「送错」而非「断」**，与契约一致。

### 13.3 §11 的「最可能出错处」预测成立 ✅

克隆 L4 模拟修复（删 3 带 + 加 cutter@(4,-13)+trash@(4,-14)），
用 footprint 级索引检查：

```
(4,-13) → cutter#20001
(5,-13) → cutter#20001     ← cutter 2×1 占两格
(5,-12) → belt#10148       ← B91 的出口正指向 (5,-13)
```

⇒ **x=5 上半段确实变成一条被 cutter 本体堵死的冗余流**。

如果分配器把 cutter 判给这条死流，就会对真正的 Ru 流再报 `PROCESSOR_REQUIRED`，
**语义层跟正解打架**。T3（修好后 0 blocker）必须能过，否则回滚。

### 13.4 F1 性能确认 ✅

solver spawn 实测 6 次：394/338/234/218/207/263 ms，**中位 263ms**。
契约「diagnose 不许 spawn、改为注入」的裁决成立。
