# 研究简报：让 AI 更聪明地玩 shapez —— 统一背景（所有子 Agent 必读）

> 本文件是本次「AI 玩家方案」研究的共同事实基座。**读到与本文冲突的信息，以本文为准；
> 本文未覆盖的，去标注的权威源头查，不要凭记忆编。**
> 证据标注：【观测】=仓库内已有实录/代码确认；【上游】=官方开源仓库源码确认；
> 【推断】=有依据的推测；【待验】=需实机或进一步查证。

## 1. 我们要解决的问题（不是写攻略）

产出一个**可落地的 AI 玩家方案**：让 AI（LLM 或算法 agent）能在 shapez.io 里**自主、越来越聪明地玩**——
从「能放对一条传送带」升级到「能规划并建成一条完整的生产链，并随等级目标升级工厂」。

判据是**可落地**：每个结论都要落到具体的 API、数据结构、算法或代码改动上，写清
「做什么 / 在哪做 / 怎么验证 / 成本与风险」。**禁止**出现「用强化学习训练」「加个神经网络」这类
无接口、无数据、无验证路径的空话。

## 2. 硬事实基座（先读，省得你重复挖）

### 2.1 游戏与工具链

- 游戏：shapez.io **1.5.6**（Steam），构建 `ee2279d5`，Electron 16.2.8。【观测】
- 官方源码仓库（GPL-3.0，tobspr/shapez.io）——**本机已有部分提取**在 `recon/upstream/`
  （files: `src_js_game_game_logic.js`、`src_js_game_buildings_belt.js`、`src_js_game_buildings_hub.js`、
  `src_js_game_components_item_acceptor.js`、`src_js_game_components_item_processor.js`、
  `src_js_game_systems_item_processor.js`、`src_js_game_building_codes.js`、`src_js_mods_*`、
  `src_js_core_lzstring.js`、`src_js_savegame_savegame_compressor.js`）。
  **更全的 1.5.6 beautified bundle 在 `recon/bundle.pretty.js`（3MB）**——这是最权威的本地源头，
  任何游戏内部行为（形状运算、建筑槽位、belt 路由、目标生成、tick 机制）都能在里面查到。
  ⚠️ `recon/` 是本地研究产物，**不得随分发**（.gitignore 已排除）。
- 官方 mod 文档与示例：仓库 README 指向 shapez.io/modding + `recon/upstream/mod_examples_*.js`。
- 联网权威源（可 WebFetch/WebSearch）：
  - 源码：`https://github.com/tobspr/shapez.io`（v1.5.6 tag）
  - 具体文件：`https://raw.githubusercontent.com/tobspr/shapez.io/v1.5.6/src/js/game/...`
  - 官方 Wiki：`https://shapez.fandom.com` / `https://shapez.io/wiki`
  - mod 文档：`https://shapez.io/modding.html`

### 2.2 工具链能力（我们已建成，实机验证过）

三层：**游戏内 Mod（单文件 .js）→ Node 桥接（零依赖）→ MCP server / Agent**。

桥接 HTTP `POST /rpc`（默认 `http://127.0.0.1:7777`），JSON-RPC 2.0。方法：
`status / obs / act / batch / screenshot / save_now / list_saves / load_save / new_game / snapshot_save / snapshot_load`

**动作原语（act 的 op）**——这是 AI 的手，务必用准：

| op | 参数 | 语义 |
|---|---|---|
| `place` | `building,x,y,r?,variant?` | 放一个建筑 |
| `place_path` | `building,from:[x,y],to:[x,y]` | 轴对齐直线铺满（含端点）；belt 自动定向 |
| `delete` | `x,y,layer?` | 删一个 |
| `bulk_delete` | `region:[x0,y0,x1,y1]` | 区域删除 |
| `paste_blueprint` | `text,x,y,charge?` | 粘贴 SZBP1 蓝图（`charge:false` 免费） |
| `export_blueprint` | `region:[x0,y0,x1,y1]` | 区域→SZBP1 字符串 |
| `set_speed` | `speed:"paused"\|"regular"\|"fast_forward"` | 游戏速度 |
| `step` | `ticks:1..20000, collect?` | **同步确定性快进 N tick**（复刻 puzzle 校验循环） |
| `await` | `until,timeout_ticks,chunk?` | 快进到条件满足或超时。`until` ∈ `hub_delivered_increased\|level_increased\|entities_changed` |
| `camera` | `x,y,zoom?` | 镜头（截图用） |

**观测（obs）**返回：`in_game, tick, paused, speed, layer, camera, goal{level,requirement{shape,required,delivered,progress,throughput_only},upgrade_levels{belt,miner,processors,painting}}, hub{stored_shapes,blueprint_cost}, region, entities[{uid,type,x,y,r,variant,rotation_variant,code,layer}], stats{total,by_type}, resources[[x,y,shape]...], truncated, entity_count`。
- 裁剪：`region:[x0,y0,x1,y1]`、`max_entities`（默认 2000，上限 20000）、`include_resources`、`include_hub`、`include_stats`。
- **entity.type 是建筑 gameId 字符串**（运行时由 code 经 `gBuildingVariants[code].metaInstance.getId()` 映射）——
  **完整建筑 id 列表要实机/源码确认，不要凭记忆枚举**。【待验 → 你要查】
- 实体有 `code`(数字) 与 `rotation_variant`——**建筑的可能变体（如切割机上下半 / 反向）就在这两者里**。【关键】
- 资源格：`resources` 是 `[x,y,shapeString]`，shapeString 如 `CuCuCuCu`（=4 个 quadrant 全是 Cu）。

**蓝图格式 SZBP1**：`SZBP1.<LZString-URI-safe(JSON{v,gv,w,e:[code,dx,dy,rot,...]})>`。
`e` 是扁平数组 stride=4，`code` 是内部建筑码，`gv` 是产出时游戏版本（粘贴时校验）。同版本内可自由交换。

**关键错误码**（AI 要用它们纠错）：`1003 not_in_game`、`1004 read_only`、`2001 invalid_action`（AI 的错，可重试改参）、
`2002 game_rejected`（位置被占/材料不足 → 重规划）、`2005 await_timeout`（不是错误态）、`2006 blueprint_incompatible`。

**参考 agent**（`src/agent/play.mjs`）现状：只有 `observe / action / b1 / plan` 四个模式，
其中 b1 是**硬编码启发式**（找最近资源→放矿机→L 形铺带到 hub）。**目前没有任何 LLM 在玩**。这是待升级的起点。

**基准脚本**：`scripts/bench_b1.mjs`（B1 链路）、`bench_b2.mjs`（完成当前等级目标）、
`bench_b3.mjs`（从新档玩到 level 3，动作数 ≤ N，含每级动作数/失败分布统计）。
B2/B3 内置启发式只覆盖 level 1–2；**level 3+ 明确标为超出能力，靠 `--plan` 外部提供计划**——这正是要补的缺口。

### 2.3 手头可用的实机资产

- **存档**：`list_saves` 当前有两档——level 1（小）与 **level 11（75KB，真工厂）**，internal_id `5c9670...`。
  还有一批 `.bin.backup`（开发期小档）。**level 11 档是研究/试验的好基地**（真实复杂工厂，能观测真实规模）。
- **快照**：`snapshots/live-test-1.bin`。桥接支持 `snapshot_save/snapshot_load`——**做实验前先快照，可回滚**。
- 桥接进程可随时 `node src/bridge/bridge.mjs` 启动；游戏进程当前在运行（在菜单，未进世界）。

### 2.4 shapez 玩法核心（事实层，供算法设计参考——细节仍需你到源码核）

### ⚡ 已验证的源码检索锚点（直接从这里开工，别从零 grep）

以下全部已在本机 `recon/bundle.pretty.js`（1.5.6 beautified）中**实测命中**，直接 Read 对应行号：

| 主题 | 位置（recon/bundle.pretty.js） | 内容 |
|---|---|---|
| **完整建筑类清单** | `:18301` `initMetaBuildingRegistry()` | 注册了 28 个建筑类：`MetaBalancer/Miner/Cutter/Rotater/Stacker/Mixer/Painter/Trash/Storage/Belt/UndergroundBelt/GoalAcceptor/Hub/Wire/ConstantSignal/LogicGate/Lever/Filter/WireTunnel/Display/VirtualProcessor/Reader/Transistor/Analyzer/Comparator/ItemProducer/ConstantProducer/Block` —— **id 名、变体、r 方向语义都从这些类里读** |
| **建筑变体注册** | `:18290-18300` `registerBuildingVariants` | `getAllVariantCombinations()` → `gBuildingVariants[code]`，这是 `obs.entities[].code` 的来源 |
| **形状运算实现** | `:29842-29895` | `_shapeActionCutHalf/CutQuad/RotateCW/RotateCCW/Stack/PaintWith/PaintWith2/PaintWith4Colors` —— 每种运算的**具体 quadrant 语义**在这里 |
| **运算在机器中的调用** | `:22402-22495` | cutter/rotater/stacker/painter 的实际处理循环（含 ItemEjector 输出方向） |
| **belt 速度常量** | `:888` `beltSpeedItemsPerSecond: 2` | ⚠️ 疑似默认值/多人常量，**必须核实**（belt 升级会改它） |
| **ItemAcceptor/Ejector 组件** | `:4036` / `:4173` | 输入/输出槽位系统——**布局能否成立的根** |
| **建筑 code 编解码** | `:15597` `getCodeFromBuildingData` | code ↔ building/variant/rotationVariant |
| **metaBuildingIds** | `:2647` `gMetaBuildingRegistry` | 注册表运行时接口 |

**取建筑 id 的稳妥办法**：`gMetaBuildingRegistry.getEntries()` → `meta.getId()`【已在 mod 里用，见 `src/mod/shapez-ai-bridge.js:418`】。

### 离线存档解码器（可直接用！）

`recon/decode_full.cjs` + `recon/show_save.cjs` 已能**离线**解出存档全量 JSON（1B version + LZString + 字典压缩）。
实测 level-11 档解出：`hubGoals{level:11, storedShapes{...}, upgradeLevels{belt:3,miner:3,processors:2,painting:1}}`、
`map.seed:43391`、entityMgr、beltPaths、gameMode。**研究工厂布局/目标生成/存档结构时，这是不需要开游戏的快通道。**

### 玩法事实（从上面锚点与实机读出）

- 形状 = 4 个 quadrant；每个 quadrant 是 `shape`（圆/方/星/风车…）+ `color`（无色/红/绿/蓝…）的组合。
  `CuCuCuCu` = 四象限都是圆形无色的「圆」；level-11 实测库存里有半形状 `----CuCu`、`Cu----Cu`、`Cu------`
  与四分之一形状——**证实游戏会用 CutHalf 与 CutQuad 两种切割**。
- **运算**（`shapeDefinitionMgr` 上的方法，AI 可用它们做搜索）：
  `shapeActionCutHalf`（一刀两半）、`shapeActionCutQuad`（切四分之一）、`shapeActionRotateCW` / `RotateCCW`、
  `shapeActionStack`（两半叠成全形）、`shapeActionPaintWith`（单色）、`shapeActionPaintWith4Colors`（四色）。
  **确切 quadrant/朝向语义你必须读 `:29842+` 与 `:22402+` 后给出，不要凭印象。**
- **建筑**：见上表 28 类。初始等级解锁的通常是 miner/belt/tunnel/balancer/cutter/rotator/stacker/painter/trash/hub。
  **每种建筑的输入/输出槽位相对 rotation 的方向必须查源码确认**——这是 AI 布局能否成立的根。
  特别注意：**切割机输出槽向与朝向一致的相邻传送带弹射；朝向不对会堵死整机**（开发期实机复现过）。
- **等级目标**：hub 要求交付特定形状×数量（`goal.requirement`）。升级链：交付解锁新等级 → 更复杂形状 →
  解锁新建筑/升级（`goal.upgrade_levels`：belt/miner/processors/painting）。
- **资源**：地图上有形状矿脉（`resources`），矿机放在矿脉格上产出该形状。

### 2.5 已有经验坑（省得你重踩）

- 建筑 code 表 + 内部 API 都是**版本相关**的，跨版本硬失败（这是刻意的）。
- `step/await` 同步跑在渲染线程，单次 step ≤ 20000 tick。**AI 靠 step 快进，不要 sleep**。
- 观测大工厂要裁剪，否则爆 token（实测 1544 实体 = 181KB）。
- 切割机输出堵塞是真实坑（见上）。
- 装任何 mod 都会禁 Steam 成就（官方行为）。
- `place_path` 对 belt 自动定向，但**拐角**方向组合有坑，`bench_b3` 里的 `placeLane()` 是逐格显式定方向的稳妥版。

## 3. 研究范围：六个方向（你只会被分到其中一个）

1. **观测升级**：让 AI「看得懂」工厂。补什么派生视图（连接关系、吞吐、堵塞点、供给-需求缺口、死端）？在哪算（mod 端 / 桥接端 / agent 端）？
2. **规划与求解**：给定目标形状 + 库存资源，如何求解「用哪些运算、什么拓扑」造出来？配方搜索空间、状态表示、搜索算法。
3. **LLM 接入**：让 LLM 真正驱动游戏。prompt 设计、工具/观测的 token 预算、状态表示、纠错循环、上下文管理。
4. **宏观策略**：等级跳跃、资源选址、产能扩张、工厂改造（re-plan）、优先级排序。
5. **基础设施**：为「更聪明」铺路的工具缺口——新动作原语、观测算子、缓存、离线↔在线一致性、评估基准。
6. **蓝图与知识库**：可复用蓝图库、子工厂模块、从蓝图反向解析、常见模式库、组合式搭建。

## 3.5 已知的前期研究（避免重复，从它的终点继续）

`research/ai-player/04-ai-planning-research.md`（772 行）已做过一轮**LLM 规划文献综述**，核心结论（要读原文，这里是索引）：
- LLM **不应**做规划主体（PlanBench 等）；应由**确定性求解器**做规划，LLM 做**提议/策略选择**（LLM-Modulo 模式）。
- **不要把坐标/旋转/建筑 id 交给 LLM**——让它输出**DSL 程序**，由确定性编译器转成动作（Code-as-Policies 家族）。
- **自评不可靠**（Huang et al.）；必须**执行式验证**（游戏自己的 shape hash 比较是免费真值）。
- **不要**做世界模型/深度 RL/视觉输入/多 agent 辩论；**要**做小规模、检查器过滤的技能库。
- 它给出了一个 4 层架构建议（Layer0 模拟器 / Layer1 确定性布局搜索 / Layer2 编译器+验证器 / Layer3 LLM 策略）。
- **它尚未做的**（你的机会）：把结论**落到本仓库真实 API 的具体设计**、**游戏侧硬事实的源码核证**、**可运行原型**。

**本次研究要产出的是它缺的那一半**：可落地的接口设计 + 源码核证的事实 + 对抗性验证。

## 3.6 ⚡ 主 Agent 已完成的硬核成果（直接采信，可运行）

以下三项是主 Agent 在本次研究中**亲自核证+实测**的成果，你的设计应建立其上（不要重新发明）：

1. **`facts/shape-algebra.md`** —— 形状字符串编码：8 字符/层 = 4 象限 × (形状码+颜色码)，
   顺序 TR→BR→BL→TL（顺时针）；形状 `R/C/S/W`；颜色 `r/g/b/y/p/c/w/u`；`-` = 空。
2. **`facts/ops-semantics-VERIFIED.md` + `proto/shape-ops.mjs`** —— 全部形状运算的精确语义
   （带源码行号）+ **可运行实现**（`node proto/shape-ops.mjs` 全绿）。
   含**金标准用例**：`CgScScCg`（level-11 真目标）的 7 步推演链已验证。
   **关键坑**：`cutHalf` 返回 `[quads(2,3), quads(0,1)]`；颜色是 3 位位域，**青=绿|蓝，青不是矿**。
3. **`facts/offline-map-reproduction.md` + `proto/gen-resources.mjs`** —— **整张资源图可离线复现**：
   从 `map.seed` 用 ALEA RNG（种子 `"<chunkX>|<chunkY>|<seed>"`，chunk=16×16）确定性生成。
   实测 **3002/3002 格与实机完全一致**。
4. **`facts/offline-map-EXPERIMENTS.md`** —— 三个实机实验全通过：远端 **2099 格**、**零观测**、
   **26ms** 盲建成功，预测逐字节准确。**"离线全知规划 → 实机直接施工"已打通**。
   唯一【待验】：未生成区域上**长链条**（传送带网络）能否正常工作。

**这意味着**：规划/选址/配方可行性都可以**离线**完成，无需边探索边发现。
`obs` 还会**触发生成** chunk（副作用，可当"侦察"用）。

## 4. 交付物与证据纪律（对每个子 Agent 的硬要求）

- **每条结论必须带证据等级 + 具体出处**：文件路径:行号 / 上游 URL / 实测命令与输出 / 明确的【推断】或【待验】。
- **优先查证而非回忆**：`recon/bundle.pretty.js`、`recon/upstream/*`、上游 GitHub raw、官方 Wiki。
  凡涉及「游戏里 X 是什么/能不能」，**没有源码或实测支撑就不要下断言**，标【待验】并写清怎么验。
- **可落地**：产出要能被工程直接接上——写清接口/数据结构/算法伪码/改动点/验证方法/成本。
- **敢说不知道**：不确定就标注，宁缺毋滥。不要用看似专业的空话填充。
- 语言：**中文**（代码/标识符/URL 用原文）。

## 5. 一句话

把「AI 玩 shapez」从**能放对一条带子**，推到**能自主读懂工厂、规划生产链、按等级目标扩张、并越玩越好**——
且每一步都咬死在真实 API 与真实游戏规则上。**给出方案，不是攻略。**
