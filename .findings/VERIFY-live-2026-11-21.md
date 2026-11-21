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
