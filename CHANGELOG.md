# Changelog

本项目：**shapez-ai-bridge** —— 把 [shapez.io](https://shapez.io) 变成一个可用程序驱动的工厂：单文件官方 mod + 零依赖本地桥 + MCP 服务器 + 一个会自我纠正的 agent 循环。

> **仓库**：<https://github.com/sqkl520/shapez-ai-bridge> ｜ **版本**：`0.1.0-SNAPSHOT`

格式参照 [Keep a Changelog](https://keepachangelog.com/)。项目尚未正式发版，各段以**工作阶段/里程碑**划分，并标注对应的 git commit 范围与记录文档。

> **★ 硬规则（项目约定）**：**任何代码/配置/文档的更改，都必须记入本 CHANGELOG**
> （在最上方的 `[Unreleased]` 段按 Added/Changed/Fixed/Removed/Notes 分类追加）。
> 版本号规则：当前为 `0.1.0-SNAPSHOT`；**待「能自动从零建成一条产线并交付进 hub」后才标 `1.0.0`**。
> **本文件只记「改了什么」**；经验 / 方法论 / 踩坑写进 `research/ai-plan/`，不要写在这里。

---

## [Unreleased]

### Added — `## STICKY GOAL`：跨多轮的成因不许被更近的红点挤掉

`## THIS RUN` 解决了「忘了自己决定过什么」，但还不够：第 9 关实测，
每轮 observe 都会重算出结构层的红点（`BELT_HANDOFF_REJECTED` ×3、`CHAIN_UNFED` ×3），
它们是**眼前看得见的**，模型连续 8 轮都在修它们、`tx=5`，
**一次都没往红矿那个方向走**。

诊断是「每轮重新拍的快照」，没有「哪件事一直没做成」的概念。
一个需要跨很多轮才能完成的工程，每一轮都会被更近的红点挤到后面。

新增 `st.stickyGoal`：**连续 ≥2 轮**存在的成因类诊断（`MIXER_UNFED` /
`PROCESSOR_REQUIRED`，且 severity=blocker）会被每轮强制置顶，
并在 prompt 里渲染成 `## STICKY GOAL`，说清「它是成因、下面的红点是它的下游、
修它们没用」，同时给出可执行纪律。

三个设计要点：

- **≥2 轮才钉**：只出现一轮的诊断多半是上一轮改动的瞬时后果，钉住反而误导
- **必须有出口**：`STICKY_MAX_ROUNDS = 6`，超时自动解除 —— 无限钉住等于把模型
  锁死在一个做不到的计划上
- **一轮做不完时给许可**：只禁「修红点」而不给替代出路，会把它逼死

### Fixed — 「必须换动作」的检查读了自己刚写的变量，把正确的计划拦掉了

真机 `r-20261111170332-1d9e` 的完整复现：

- 第 1、2 轮 `connect` 都被 `NO_REVERSIBLE_CALL` 拒（宏失败，没进 tx）
  ⇒ 上一轮**什么都没执行**
- 第 3 轮模型换成 `insert_machine`，plan 全绿（`ops=2`、`placements=1`、`partial=false`）
- 结果这道检查拿**刚被自己写进去**的 `lastExecutedMacros = ["insert_machine"]` 去比，
  判成「仍然用了 insert_machine（与上一轮相同）」⇒ `halt: NO_PROGRESS`，
  **把这一轮自己的 tx 也跳过了**（`tx=0`）

它问的是「上一轮执行过的那套动作，这次又照抄了吗」，必须读上一轮留下的值。
现在先存 `prevExecuted` 再赋值，检查读 `prevExecuted`。

回归测试 `5b2`：上一轮全部失败、本轮换动作，断言 `apply ≥ 1`、`tx_count ≥ 1`。

写这条测试时自己也踩了一次坑：第一版用 `at: [4, -13]` 写字面坐标，
被 `assertNoHumanCoords` 判成 `LLM_COORD` —— 看起来像测试数据，其实测的是
一个**按设计一定会被拒**的输入。改用句柄 `{$ref:"B81", asCell:true}`。

### Fixed — 计划被拒之后，下一轮的 `LAST ROUND` 显示 "none"

`settleFailure`（计划/应用失败时的收尾）只写 transcript 的 `repair_decide`，
**不更新 `lastPlanSummary`**。后果：

```
## LAST ROUND
none (this is round 1)
```

模型压根不知道上一轮失败过、更不知道输在哪。

实机第 9 关：第 1 轮 `connect` 被 `target_already_fed` 拒，
第 2 轮它换了个 `prefer` 又调了一次**几乎完全相同**的 `connect` ——
因为它读到的是「上一轮：无」。

现在 `settleFailure` 也写 `lastPlanSummary`（形态与成功路径一致），
失败的那条带 `code` + `hint` + `observed`：

```
## LAST ROUND
round 1: calls [connect]
codes: MACRO_REFUSED
previous failures:
  · connect → target_already_fed: C7 的 color slot 0 已经被 B205 占着
    ↳ 换一个 port，或传 opts.rebind=true。
```

**错误码、具体格子、修法**三样都到模型眼前了。

### Added — `## THIS RUN`：本次 run 的决策轨迹（跨轮目标坚持）

第 9 关暴露的最后一个缺陷不是「信息没送到」，而是**跨轮没有目标坚持**。

`MIXER_UNFED` 明确写着「红矿在 44 格外，这不是接一根线，是一条要单独规划的长支线」。
模型第 4 轮的 `say` 原文：

> place the existing mixer concept on the blue stream at B194 so the mix step sits in-line,
> **rather than building a far-off color branch first**

它**知道**那个选项，主动选择先做别的。然后下一轮完全忘了 —— 又试 `connect`、
又放 mixer，三轮下来一步没往支线走。

根因：每轮都是新 prompt，`## LAST ROUND` 只带上一轮的动作与结果，
不带「我前几轮决定过什么」。

新增 `st.runLog`：每轮记 `{round, say, calls, outcome}`，tx 后回填真实净效果。
prompt 里渲染成 `## THIS RUN`，只列**最近 4 轮**，每轮一句：

```
## THIS RUN
what you decided earlier in THIS run (most recent last):
  · r2 insert_machine → added stuff, no delivery — "place a mixer first, rather than building a far-off color branch"
  · r3 connect → made it worse — "connect B192 into C7 slot 1"
⇒ Stay on one plan until it is DONE or proven impossible. If an earlier round named something
  it deliberately postponed ("rather than ... first"), either do it now or say plainly why
  you are abandoning it. Do not silently restart the same step.
```

关键是**把模型自己说过的话原样还回去** —— 那是「我决定过什么」的唯一来源。
收尾那句给它一条可执行的纪律，而不只是陈列历史。

与 `## PRIOR ATTEMPTS` 的分工：

- `PRIOR ATTEMPTS` = **跨 run** 的统计（「这个宏在这个目标上历来没用」）
- `THIS RUN` = **本次 run** 的意图（「我第 4 轮说要先放 mixer」）

前者防重蹈覆辙，后者防半途而废。两者都需要，且独立失效 —— `blocks` 里
`prior_attempts_shown` 与 `this_run_shown` 分开记。

12 条新断言覆盖：段出现/不出现、say 原文被还回去、意图与结局并排、
4 轮上限、`planned` 状态如实显示。

### Fixed — 颜料矿机的输出是裸名，配方要的是 `color:<name>`

两套命名在形状传播里撞车：

- `obs.resources` 的矿种是裸名：`blue` / `red` / `green` / `CuCuCuCu`
- 配方里的颜料是带前缀的：`color:blue` / `color:red`（`mineColor` 步的 hash）

`mine` 分支原样返回 `"blue"`，而下游判据找 `v.startsWith("color:")`
⇒ **一条都认不出来**。

实机症状（第 9 关）：两条喂料带子方向完全正确、确实连着蓝矿机，
诊断却报 `color slot 0/1: no known incoming pigment`；
`beltsCarryingShape(obs, recipe, "color:blue")` 返回 **0 条**。

修法：只给**颜料类**矿种加前缀，形状类（`CuCuCuCu` / `RuRuRuRu`）保持裸名 ——
后者本身就是最终形态，配方里也是裸名。修后 `color:blue` 认回 5 条带子。

### Fixed — 「颜料在多远」这条决定性信息被 180 字符截断吃掉

`MIXER_UNFED` 现在会算出配方要的每种颜料**最近的矿在哪、多远**。但这条信息
原来排在 hint 最末尾，而 prompt 只取 hint 前 180 字符 ⇒ 模型看到的是

```
这台 mixer 只有一路颜料……connect 时用 `port:{role:"color", index:0}`…
```

后面那句「红矿在 44 格外、这是支线工程不是接线问题」**整个被切掉**。

实测距离：蓝 5 格，红 **44 格**。这决定了行动性质完全不同 —— 前者是接一根线，
后者要先去那片矿区放矿机、再一路铺过来。

按重要性重排 hint：**矿距放最前**，端口索引与朝向修正排后面。
修后 180 字符内完整保留「blue 5 tiles / red 44 tiles / 不是接一根线，是要规划长支线」。

### Notes — 模型看懂了，但主动选择不做

有了上面两条，prompt 里已经明确写着「红矿 44 格外，反复改现有那条线没用」。
模型的表现是（`r-20261111140954-154a` 第 4 轮 `say` 原文）：

> place the existing mixer concept on the blue stream at B194 so the mix step sits in-line,
> **rather than building a far-off color branch first**

它**明确知道**远处支线这个选项，并主动选择先做别的。

所以第 9 关现在的瓶颈不再是「信息没送到」，而是**策略选择**：
在「补完一条 44 格支线」与「先摆好 mixer」之间，模型每次都选后者。
这需要的是跨多轮的目标坚持（记住「我正在建那条支线」），
而当前 loop 每轮都是新的 prompt、只带一轮 `LAST ROUND`。

### Fixed — 真实规模下带子列表永远是 0 条

第 9 关（536 条带子 / 8 条诊断 / 37 台机器）实测：

```
BELTS (0 of 536; 0 of 10 referenced by diagnosis shown)
```

模型被要求「把 B205/B206 的朝向往回改」，而那两条带子**从来没出现过** ——
它看不到出口朝向、看不到能否到 hub，只能从诊断里那句 `belt-not-aimed` 猜。

三处根因叠加：

1. **默认预算 2800 tok 是按 37 条带子的小场景定的。** `targetChars = 9800`，
   而 S1（系统规则）就占 4716 字符 ≈ 1348 tok —— 光规则就吃掉一半预算。
   S2+S3+S4 合计 7473 ⇒ 带子抢不到任何名额。实测 2800 → `belts_shown: 0`；
   4000 → 12。默认值抬到 **4000**。

2. **诊断点名的带子与目标走廊抢同一批名额（`reserve = 2`）。** 第 9 关 8 条诊断
   点名 10 条带子，`reserve=2` ⇒ 只有 `1/10` 可见。但直接把 reserve 调到 6
   会把 L4 的正解挤掉（3/3 → 2/3，B82 在 byGoal 序 9）。**两个诉求都是真的，
   固定值不可能同时满足。**

   根因是「抢同一批名额」这个前提本身有问题：走廊是结构性事实，诊断点名是
   「这一步就要改它」，两者性质不同。改成：走廊吃满 `cap`，诊断点名的
   **额外追加**在 cap 之外（上限 `cap + reserve`）。

3. **`when:` 行的门槛 4000 与新的默认值撞车。** 默认变成「宽裕」⇒ 截断测试
   压低预算时 `when:` 行消失 ⇒ `S2` 逐字节变了，而截断的契约是「只动带子列表」。
   门槛抬到 **5000**。

实机效果（同一份 obs）：

| | chars | belts_shown | 诊断点名可见 |
|---|---|---|---|
| 修前 | 7722 | **0** | **0/10** |
| 修后 | 9429 | 18 | **7/10** |

四条断言编码的是旧契约（cap=12 硬上限、reserve 从走廊里扣、默认预算下会掉带子），
按新契约改写并写清为什么变。其中 B3 的原标题「16000/4600 是饱和点」改为
「**带子**饱和点」—— `when:` 行门槛变化让 user 不再逐字节相同，
但带子名额的独立性才是它要守的。

B1 的注释里早就写着「如果哪天有人把 `PROMPT_TOKENS_MAX` 调够了，这条会变红，
提醒同步更新理由」—— 那天就是今天。

### Fixed — agent 终于能连上代理（`runLoopCli`）

`--llm` 模式下 `--base-url` / `--model` / `--api-key` 三个 flag **根本不存在**，
传了会被静默忽略。后果不是报错，而是「以为在打代理，其实打了官方地址」——
排查方向被引到完全错误的地方，上一轮的工作因此只能由主线程手工打 RPC 完成。
现在三个 flag 都接上，并补了 `--max-tokens`（代理上的模型先吐很长的 thinking，
默认 1200 会被吃满 ⇒ `content` 里一个 text 块都没有 ⇒ 报 `LLM_NOT_JSON: output is empty`，
看起来像「模型不会输出 JSON」，实际只是预算不够）。

### Fixed — 残线在 prompt 里整段不可见（`renderLeftoverLines`）

残线清单原来是 `renderGoalChanged(goalChanged, obsoleteLines)` 的**第二参数**，
而那个函数第一行就是 `if (!g || !g.to) return null`。于是残线只在
**本次 run 内部观察到换关**时才渲染。

实机第 9 关：run 一开始就在第 9 关，`goalChanged` 是 null，整段从未出现。
而那一刻 `hub.stored_shapes` 里躺着 `Cu----Cu 27823`、`Cu------ 28926`……
前六关的全部产线还在原地占着地、继续挖继续切。模型能看到的只有
「没有产线在造 CpCpCpCp」，它于是去**新建** —— 在已经挤满旧线的世界里再挤一条。

现在残线单独成段，不再依赖 `goalChanged`；`blocks.leftover_lines_shown`
与 `goal_changed_shown` 分开记录，让「没换关」不再被误读成「没有残线」。

### Fixed — `OBSOLETE_LINE` 无法施工（没有句柄）

诊断只说「工厂在造 `Cu----Cu` ×29、一件都没进 hub」，`evidence.handles` 是空的 ——
比对同一轮的 `PROCESSOR_REQUIRED`，后者老老实实给了 `stream_handles`。
模型知道「有一条该拆的线」，却没有任何句柄能交给 `remove_run`。

新增 `semantic.beltsCarryingShape()`：从形状传播（`makeShapeEngine` + `buildStreams`）
把「哪些带子正在搬这个形状」拿回来 —— 产出窗口只有形状名，没有位置。
实机验证：`Cu----Cu` → 8 个句柄 → `remove_run` 拿到一条真实可删的 8 格残线。

### Fixed — 拆残线会被系统撤销（`isSanctionedTeardown` 的门挂错了层）

`isSanctionedTeardown` 第一行是 `if (levelChanged !== true) return false`。
run 一开始就在第 9 关 ⇒ `goalChanged` 恒假 ⇒ 模型照 `OBSOLETE_LINE` 去拆旧线
⇒ 判 `regressive` ⇒ 连撤两次。**系统一边骂它不收拾残局，一边把它收拾的动作撤销掉。**

那道门槛该在**产生清单**的那一步（`findStoredObsolete` 仍要求 `levelChanged`，
V38 锁着它），不在消费清单的这一边。现在只认清单本身。

### Fixed — `insert_machine` 指着一格带子时恒 `ambiguous_site`

实机第 9 关：模型三轮都调 `insert_machine {at: B420, machine: "painter"}`，
全部失败。它读带子句柄、读诊断、指出正确的那一格 —— 都没错。

两处错都在宏这边：

1. `at.cell` 是一格**带子**时，调用方说的是「机器接在这条流上」，指向的是
   机器的**来料落点**；旧逻辑把它当「机器要占的其中一格」去反解 footprint，
   2×1 机器必然两解。
2. 朝向本来也是算得出来的：`beltExit(rv, r)` 就在手边。机器顺着原来的流向接力
   才是对的，让 LLM 去猜一个几何量是没有意义的难度。

现在：带子格 ⇒ 按「输入槽来料落点」反解，并按**槽的主次**分档（painter 的
`shape` 优先于 `color`）；没给 `facing` ⇒ 从货流推出来（`facing_derived`）；
给了但和货流冲突 ⇒ `facing_conflicts_with_flow` 警告而不是硬拒。
真歧义（mixer 两个同向并列输入槽，两种摆法几何与来料都等价）⇒ 仍然不猜，
但报错里直接列出两种摆法各占哪几格、各喂哪两格。

旧的「`at` 指机身格」语义原样保留 —— 它锁着 E2E 缺陷 4 的回归位。

### Changed — `connect` 的默认路径偏好 `fewest_turns` → `shortest`

旧默认的理由写的是「拐角有代价」。**在 shapez 里这是错的**：传送带恒速，
拐角不掉速也不掉吞吐，转角纯粹是视觉上的。

代价是可测的：399 个端口对里 **48%** 的布线因此选了比必要更长的路（最多多绕 4 格）。
用户看着满屏绕远路的带子说「效率这么慢的机器是怎么想出来的」——
这是其中一半的成因。要少转角仍可显式传 `fewest_turns`。

### Fixed — R13 拦掉了 `insert_machine` 唯一的正确写法

第 9 关第 4 轮，模型给出了完全正确的一步：

```
insert_machine {at: B420, machine: "painter"}
```

宏本身通过了（`removed_uids: [11205, 11206]` —— 就是 painter footprint 压掉的那两格），
但 R13 判 `destroys_not_named`：那两格带子「不在 LLM 指名的句柄里」。
**没有任何写法能让模型「先点名」它们** —— 它的意图本来就是「把机器插进这段带子」，
压掉哪几格是宏按几何算的。

两处修正：

1. `collectNamedUids` 现在也收**宏自己声明要删的**（`changed.removed_uids` /
   `removed_uids`）。这与既有 `connect(allow_replace)` 的豁免同源：删除范围由
   footprint/cells 唯一决定，不是 `$bbox_of` 猜的矩形——R13 要防的是误框，不是宏拆自己脚下的带子。
2. 调用点从 `collectNamedUids(res.calls, …)` 改成 `collectNamedUids(executed, …)` ——
   只有后者带 `result`，而 `removed_uids` 正是「宏按自己语义算出的删除」的唯一来源。

端到端验证：`{at: {$ref:"B420", asCell:true}, machine:"painter"}` 现在产出 3 条 op，
不再被拒。

### Fixed — `insert_machine` 允许把机器放在「产物永远出不去」的位置

第 9 关实机：模型把 4 台 painter 放进了世界，`debug_items` 显示**每一台的产物都是
`progress: 1.00`** —— 全部堵死在出口，一件都送不出去。用户看着满屏的坏机器问
「效率这么慢的机器是怎么想出来的」。

根因：painter 的输出格正好落在**另一台机器的格子上**（其中两台的输出格就是矿机本体）。
`classifyFeed` 对这种情况返回 `mismatch`，而那只是一条 warning —— 机器照样落盘。

这不属于「接线方向不对、等一下再连」：输出格被一台永不让位的机器占着，
几何上就不可能接出去。现在 `insert_machine` 直接拒（`blocked_by_machine`），
并在 message 里点名是哪个输出槽、落在哪一格、被谁占着。
输出格上是**带子**仍只警告 —— 那是可以用 connect / extend_line 修的。

### Fixed — 「工厂缺 X」的诊断把 hub 当成了可放位置

`PROCESSOR_REQUIRED{scope:"factory"}` 的 `evidence.handles` 原来放的是 **hub 的句柄**
（`H1`），意思是「相关对象是 hub」。模型的读法是「这些是我该动手的格子」。

第 9 关实测：模型连着两轮调
`insert_machine {at: {$ref:"H1", asCell:true}, machine:"mixer"}` —— 而 hub 周围
16 个入口槽全被带子占着，一台 2×1 的 mixer 都放不下。它每次都失败，然后换一个几乎一样的写法重试。

一条「工厂缺 X」的诊断，真正该回答的是「**那 X 能放哪**」。现在会枚举观测范围内
`footprint` 完全空着的格子，按离 hub 的距离排序（越近的线越短，越不容易和既有产线打架），
放进 `evidence.site_cells`；hub 的句柄降级成 `hub_handle`（只作上下文）。

找不到空地时**不再假装有**：`free_sites: 0`，候选换成 `remove_run` / `trash_unused`，
hint 直说「先把挡路的旧线拆掉腾出位置」。实机验证：mixer 有 13824 个空位，
painter 在当前观测范围内**一个都没有** —— 那个诊断现在会正确地让模型先去拆。

### Fixed — painter 诊断永远「fits at 0 place(s)」（新增 `paintSites`）

`sitesFor()` 只给 `cut` 与 `rotate` 系列算落点，`paint` 走的是空数组。
于是 `PROCESSOR_REQUIRED` 对 painter 永远报「a painter fits at **0** place(s)」——
而宏完全放得下（实测 B423/B424/B425 三个句柄全部成功）。

后果不是「少一条建议」：一条**看起来可施工、实际无解**的诊断把模型钉死了。
第 9 关的 run 里模型连着三轮追这条 painter 诊断（三种不同写法全部失败），
一次都没去看那条「缺 mixer」的诊断——尽管 mixer 有上千个空位、是配方的真正前置步骤。

新增 `paintSites()`：逐 rotation 检查「整台机器能不能嵌进这段带子」，
footprint 内每格必须空着或是会让位的带子，主输入槽的槽格必须正好是那条带子，
输出格必须空着或接得住货。实机验证：painter 落点 **0 → 15**。

### Fixed — 诊断算出的落点从来没进过 prompt

`site_cells` / `site_handles` / `site_facings` 三个词在 `prompt.mjs` 里**一次都不出现**。
诊断说「有 15 个可行落点」，模型一个都拿不到，只能继续 `$path_of(["B434"])` 猜。

现在渲染成**句柄**（`a painter can go on: B198,B217,...`）：
坐标仍然不进 prompt（那是本文件的硬约束，`sanitize()` 会把数字对打成 `<coord>`），
而句柄正是 `insert_machine` 的 `at:{$ref,asCell:true}` 直接接受的形态。

同时改掉一句误导性文案：原来写「pass them to `$path_of` as the region」，
那句话把模型引向 `replace_run`，而那些落点在流上是**散开的**，
`$path_of` 算不出矩形 ⇒ 第 9 关实测三连败。同一批句柄在 `insert_machine` 下全部成功。
`candidates` 也随之把 `insert_machine` 排在 `replace_run` 前面。

### Fixed — 「工厂缺 X」的诊断把 hub 当成了可放位置

`PROCESSOR_REQUIRED{scope:"factory"}` 的 `evidence.handles` 原来放的是 **hub 的句柄**
（`H1`），意思是「相关对象是 hub」。模型的读法是「这些是我该动手的格子」。

第 9 关实测：模型连着两轮调 `insert_machine {at:{$ref:"H1"}, machine:"mixer"}`——
而 hub 周围 16 个入口槽全被带子占着，一台 2×1 的 mixer 都放不下。

现在会枚举观测范围内 `footprint` 完全空着的格子，按离 hub 的距离排序
（越近的线越短，越不容易和既有产线打架），放进 `evidence.site_cells`；
hub 的句柄降级成 `hub_handle`（只作上下文）。
找不到空地时**不再假装有**：`free_sites: 0`，候选换成 `remove_run` / `trash_unused`。

### Notes — 第 9 关的真实解法（尚未完成）

紫色必须由 mixer 把**红 + 蓝**混出来，而世界上没有紫矿。
蓝矿就在 mixer 旁边（5 格），**红矿最近的一处在 44 格外**。

模型已经能把 mixer 放进世界（`tx=2`，机器 +2），但它选的流源头是单台蓝矿，
供不了第二种颜色 ⇒ `L2-slots` 判红「1 台机器一个输入槽都没被喂」。

下一步的正解不是修宏，是让诊断说出「mixer 需要两种不同颜色的来料，
而这条流只有一种」——`PROCESSOR_REQUIRED` 目前只数「有几台」，不检查「喂得对不对」。
详见 `research/ai-plan/P23-LEVEL9-PURPLE-BRANCH.md`。

### Fixed — `trash_unused` 的每条 place 都被判「没有 provenance」

`attachProvenance` 给每条 op 挂来源标签，三级优先：pending token → `$bbox_of` → `obs:uid`。
`trash_unused` 是唯一一个**有落点但没有 pending 引用**的宏：
`trashCell` 由宏从端口几何算出来，可它落在**出口格**、不是被点名那条带子本身，
所以 `obs:uid` 那一级也不成立（判据是 `e.x === op.x`）。于是**每一条都被判 MISSING_PROVENANCE**。

实测（第 9 关）：模型一轮里三条 `trash_unused` 全部通过宏、全部有落点，
整轮却因为「3 条 op 都没有 provenance」被拒。而那条诊断的原文还写着
「planToTxOps 目前不产出这一层，loop 必须补齐」——补齐的地方就在 `attachProvenance`，
只是当初漏了 trash 这一支。

现在 `trash_unused` 和 `connect` / `extend_line` 一样合成 token
（`trash_unused:trash@<x>,<y>`），语义是「这一格的坐标来自这个宏这一次调用的返回值」。

### Added — 执行前的净效果预演（`stage:"simulate"`）

`classifyNetEffect` 一直能判 `regressive`，但那是**事后** —— 世界已经被改了。
第 9 关有一轮里，模型两次 `connect {allow_replace:true}` 覆盖了正在工作的带子：
到 hub 的带子 320 → 254、死带子 184 → 282。判定层如实判了 regressive 并回滚，
但那两步都白做了，而模型**看不到自己那一步的代价**，下一轮接着用同样的写法。

`applyToWorld` 的语义就是「把宏结果折进世界」，`worldHealth` 接受任意 obs ——
两者加起来就能在**写盘前**回答「这一步会让世界变好还是变坏」。新增
`applyTxOpsToObs()`（内存里应用 ops，不动原对象）+ `buildTxPlan` 里的预演闸门。

关键设计：**只拦破坏，不拦施工**。两者在「到 hub 的带子变少了」上看起来完全一样，
只有调用性质不同：

- `insert_machine` / `replace_run` 改朝向 = **施工**，临时减少连通性是正常的
  （`rollback.mjs` 的文件头早就写明：拆旧线是唯一可行的施工模式）
- `connect{allow_replace}` / `rebind` / `trash_unused` = **覆盖/封死既有货流**

第一版没有这个区分，直接把 `partial_apply` 的 P0/P13 打红 —— 那两条正是
「放一台 cutter」这种正解第一步。收窄后两者都通过。

阈值：相对损失 ≥25%，或绝对损失 ≥20 格。第一版写的是 `loss > ops.length`，
方向反了（一条 op 杀掉几十格连通性是常态，op 多的调用反而更难触发）。

### Added — `MIXER_UNFED`：「机器在了，槽没喂」是 `PROCESSOR_REQUIRED` 看不见的一类病

第 9 关的最后一堵墙。`PROCESSOR_REQUIRED` 只**数**「工厂里有几台 mixer」：

- 模型照着它，把一台 mixer 插进了一条**只有蓝色**的流上
- 数量达标（`have: 1`）⇒ 诊断消失
- 而配方里 `mix` 步的 `inputs` 是 `["color:blue","color:red"]` —— **两种不同的颜料**
- 于是 `mix()` 永远不可能跑，而系统再也不会提这件事

真实数据（同一份 obs）：唯一那台 mixer 的两个 color 槽，上游是**同一条蓝矿线**；
红矿在 44 格外、有矿石有矿机、只是没接过来。**材料全在，判据只差一步「两个槽分别收到了什么」。**

形状传播引擎早就算得出这件事（`inputSlotValue`），从没被用来回答这个问题。现在：

- 配方说 `mix` 要哪几种颜色（从 `steps[].inputs` 读，不硬编码）
- 对每台 mixer 逐 color 槽取上游值
- 两槽不同 ⇒ 正常；有一槽解不出 ⇒ 报「另一路没接上」；两槽相同 ⇒ 报「同源，产不出第三种颜色」
- **解不出时不猜是哪种颜色** —— 只说这一槽没有已知来料，并给出该槽的缺口原因
  （`feed-cell-empty` / `belt-not-aimed` / `tunnel-barrier` / …）与喂料带子句柄
- `candidates` 把 `connect` 排第一（首要修法是铺线，不是再放一台 mixer）

配方只要一种颜色时**不报**（M4 锁着这条，防止误伤单输入配方）。
没有 mixer 时也不报 —— 那是 `PROCESSOR_REQUIRED` 的活（M1）。

5 条新测试：M1 无 mixer 不报 / M2 一喂一空必报且两槽原因不同 / M3 全空也报 /
M4 单色配方不报 / M5 已登记 `DIAG_CODES`。

### Added — `debug_building_unlocked` 的实机结论

第 9 关要求紫色（`CpCpCpCp`），而世界里**没有紫矿** —— 只有
`green / Cu / Ru / red / blue` 五种。紫色必须由 mixer 把红+蓝混出来。
确认第 8 关的 `reward_mixer` 已授予：`{"mixer": true, "stacker": false}`。

---

## [0.1.0-SNAPSHOT] - 2026-11-09

首次公开发布。此前 272 个提交在本地累积，本版把它们整理成一份干净的历史。

### Added — 闭环 agent（`src/agent/loop/`）

这是本版的主体：一个会自我纠正的 agent 循环，而不是「调一次 LLM 然后祈祷」。

- **七个宏 + 句柄寻址**（`src/agent/macros/`）：`connect` / `insert_machine` /
  `replace_run` / `remove_run` / `remove_machine` / `trash_unused` / `extend_line`。
  模型用句柄（`B12` / `M3` / `C1`）指代对象，**人类坐标在解析层就被拒** ——
  计划里不可能出现模型自己编的位置。
- **整轮原子**：一轮里所有调用进同一个 `tx`。任何一条失败，整轮在写盘前被拒。
- **净效果分档**（`health.mjs`）：每轮结束后世界健康度的增量被机器判成
  `positive` / `constructive` / `cleanup` / `regressive` / `churn` / `inert` 六档。
  **这是代码算的，不是模型自评的。**
- **自动回滚**（`rollback.mjs` + mod 四个 checkpoint RPC）：连续两轮 `regressive`
  触发真回滚。还原后自校验 uid 集合与逐格几何。
- **跨 run 记忆**（`memory.mjs`）：尝试按 `(目标形状, 世界)` 双分组，下次 run
  作为 `## PRIOR ATTEMPTS` 喂回去。合并按硬度 —— `regressive` 不被 `inert` 覆盖。
- **关卡变更检测**（`obsolete.mjs`）：hub 升级时重读目标、识别作废的线，
  且「拆掉它们」只在升级那一轮被认可。
- **删除冗余度**（`redundancy.mjs`）：回答「这个世界有多少条带子删了不伤任何下游」。
- **V-health 判据**（`verify.mjs`）：判定层第一次能说「这一步把世界改坏了」，
  而不只是「计划落地了没有」。

### Added — 布局编译器（`src/ai/`）

- 给一个目标形状，离线规划出一条能交付的产线，输出 SZBP1 蓝图。
- 全链路无游戏依赖：配方求解 → 离线资源图（世界是 `map.seed` 的纯函数）→
  行布局 → 带回转的带子路由 → 十项校验 → 蓝图。
- `--hub` 必填。没钉住 hub 的编译报 `hub:unpinned` 失败，而不是给一个
  把货送到空地的「成功」。

### Changed — 仓库整理

- `.gitignore` 补上 `.tmpverify/`、`research/ai-plan/runs/`、`research/ai-plan/tmp/`、
  `nul`（写作时误产生的 Windows 设备名文件）。
- A/B 装置迁到 `research/ai-plan/ab/{when,consequence}/`，输出走各自目录下的
  `out/`，路径按文件位置算而不依赖 cwd。

### Security

- **移除了误提交进历史的 API 密钥。** 该密钥只在本地提交里出现过，从未推送到公开仓。
  清洗走 `scripts/scrub-fast.mjs`（fast-export/fast-import 流式过滤，13 秒），
  同时删掉了 5 个本就不该进仓的临时脚本。
- A/B 装置改为从 `ANTHROPIC_API_KEY` 环境变量读密钥，不再内置。

### Notes — 这一阶段最重要的三条结论

写在 CHANGELOG 里，是因为它们改变了我们对代码的判断。

**1. 「模型不愿删」从来不是缺陷 —— 前提就错了。**

连续三轮实验（P14 `$ore` 提示、P17 卡片 `when:`、P18 后果可见）都在优化
「怎么让模型多用 `remove_run`」，全部证伪。最后做了一件本该第一个做的事：
数一数每个世界里有多少带子是可以安全删的。

```
世界                    带子数   可安全单删    会断东西
L4 夹具                  161        0          161
L5 真机基线              158        0          158
L11 成熟世界             2107      265 (12.6%) 1842
```

**L4/L5 是零冗余世界：每一条带子都是某条链的必要环节。**
在那里删任何一条都是错的 —— 模型拒绝裸 `remove_run` **是对的**。
我把它读成了缺陷，拿一个不适用的指标做了三轮实验。

教训：**先测清楚「正确行为在数据里长什么样」，再去测「模型有没有做到」。**

**2. 一个值「被算出来」和「被送到决策者眼前」是两件事。**

`would-disconnect` 从 P4 就有、`rv-drift` 从 P5 就有，一次都没进过 prompt ——
只躺在 transcript 里。`grep warnings prompt.mjs` 之前是零结果。
同类问题还有：宏卡片 7 个里 6 个只有「别用它」没有「什么时候用」。

**3. 本机的 git 写操作约 1 秒/次，任何 O(提交数) 的重写都不可接受。**

历史清洗试了五版才成：filter-branch tree-filter（2 分钟/提交）、
index-filter（30 秒/提交）、手写解析 tree 二进制（**静默失败**，报"完成"而密钥还在）、
逐提交 ls-tree（10+ 分钟卡住）…… 最后 `fast-export`/`fast-import`
流式过滤 13 秒解决。前五版的失败原因写在 `scripts/scrub-fast.mjs` 文件头。

---

## 版本历史

| 版本 | 日期 | 内容 |
|---|---|---|
| `0.1.0-SNAPSHOT` | 2026-11-09 | 首次公开发布：闭环 agent、布局编译器、自动回滚、跨 run 记忆、健康度度量 |

## 尚未达成

- **自动从零建成一条产线并交付进 hub。** 目前 `Cu----Cu` 曾在真机上抵达 65%
  （[`research/ai-plan/P7-GOAL-ACHIEVED.md`](research/ai-plan/P7-GOAL-ACHIEVED.md)），
  阶段 2 的验收（[`PHASE2-ACCEPTANCE.md`](research/ai-plan/PHASE2-ACCEPTANCE.md)）
  尚未通过。这是 `1.0.0` 的门槛。
- **跨 run 记忆、关卡变更检测、`connect` 自动放宽**只在离线验证过，
  未在真机上端到端跑过（见 [`research/ai-plan/P16-LIVE-VERIFICATION.md`](research/ai-plan/P16-LIVE-VERIFICATION.md) §7）。
- **产能提升**（用户最初抱怨的「明明有可以快捷提高产能的方法却没有用」）
  尚未动。按 P18 的结论，这才是 level 4/5 该做的事。
