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
