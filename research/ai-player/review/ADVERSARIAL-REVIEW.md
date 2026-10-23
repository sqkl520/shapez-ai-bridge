# 对抗性审查：「AI 玩 shapez」方案（SYNTHESIS 及其证据链）

> 审查对象：`research/ai-player/SYNTHESIS.md` + `facts/*` + `designs/*` + `proto/*`。
> 方法：全部关键断言回到 `recon/upstream-full/`（1.5.6 @ ee2279d）源码逐行核对；
> 所有"实测 PASS"逐一对拍 `facts/live/*.result.json` 原始数据；竞品 `Songxwn/shapez-auto`
> 与公开求解器 `TomasSirgedas/Shapez-solver` 已克隆通读。
> 立场：挑毛病。扎实的部分只给一句话确认。

---

## 0. 先说扎实的部分（简短）

- **形状代数**：`proto/shape-ops.mjs` 对 `shape_definition.js`（TR/BR/BL/TL、rotateCW
  `unshift+pop`、stack 的最小间隙语义、cutHalf `[quads(2,3), quads(0,1)]`）的复刻**逐行核对无误**；
  `CgScScCg` 7 步链我独立复放通过。cutter 槽位→左右列映射与 `item_processor.js:367-388` 一致。
- **离线资源图**：`gen-resources.mjs --validate` 我当场重跑，3002/3002、111/111 chunk 属实，
  且对拍对象是实机 dump（`facts/live/resources.json`），非自证。
- **机器几何**：miner/cutter/stacker/painter/mixer/hub 的槽位方向与 `buildings/*.js` 全部吻合。
- **自我纠错过程**（H7 → ROOT-CAUSE → RV-FIX）是这份研究最有价值的部分，方法上成立。

以下全部是问题。

---

## 1. 致命缺陷（按严重度排序）

### F1. 「蓝图粘贴完全确定」没有证据支持，而且源码显示它**结构上不成立**

这是整个方案的承重墙（§4.0 修复、§0 工作流、§7 "落地环节就通了" 全压在它上面）。三重问题：

**(a) 证据与文档矛盾。** `facts/RV-FIX-verified.md` 宣称"✅ 已验证、与源产线一致、世界 2805/2805
extra 0"，但它引用的原始数据 `facts/live/exp-rv-fix.result.json` 写的是：
- `"pass": false`（脚本自己的判定！）
- 源线 9 条带 vs 粘贴 8 条带 —— 脚本比对 `nSrc === n0` 必然为 false（粘贴 obs 框
  `[px-2, py-5, px+8, py+3]` 漏掉了 dy=4 那条带，锚点归一化也差一格）；
- `baseline: 2805, after_total: 2807` —— 清理后世界**多了 2 个实体没删掉**，与文档
  "逐 uid 对比 2805/2805" 直接矛盾。
数据里真正成立的只有：两次粘贴的 8 条观测带逐格相同（拐角 code=3）。文档把
"两次粘贴彼此一致" 包装成了 "与源一致 + 幂等 + 世界无损" 三件事，其中两件被自己的结果文件否定。
`ROOT-CAUSE-rotationVariant-override.md:94` 的待办 "⬜ 重新验证 H7（这次是真的）" 从未打勾。

**(b) 机制上，游戏会在粘贴过程中改写 rv。** 上游 `systems/belt.js:60-64` 把
`updateSurroundingBeltPlacement` 挂在 `entityAdded/entityDestroyed` 上；每放入一个实体，
它会用 `computeOptimalDirectionAndRotationVariantAtTile` **重算并覆写周围带子的
rotation/rotationVariant/code**（`systems/belt.js:160-205`）。唯一的豁免开关是
`immutableOperationRunning`（`systems/belt.js:169`）。游戏自己的蓝图粘贴是
`performBulkOperation(performImmutableOperation(...))` 双层包裹（`blueprint.js:159-160`）——
**这正是官方为"粘贴保真"设计的机制**。我们的 mod 粘贴只有 `performBulkOperation`
（`src/mod/shapez-ai-bridge.js:1545`），全仓库没有任何地方用 `performImmutableOperation`
（grep 为空）。`bulkOperationRunning ≠ immutableOperationRunning`（`logic.js:170-201`），
所以**我们粘贴时每放一格，游戏都在按邻居重算已放格**；`placeOne` 的 rv 覆盖只在"放置那一刻"
生效，邻居随后可把它改回去。RV-FIX 实验之所以通过，是因为那条 L 形的"全邻居就位后的
自动重算结果"恰好等于蓝图存的值（我按 `belt.js:161-247` 手推验证：corner r=0/rv=2，
下带弹射+右带接收 → 重算得 {rotation 0, variant 2}，一致）。**这是收敛情形，不是确定性证明。**
任何"玩家强制转向（R 锁）放出的、与启发式不一致的带子"（源码注释自己承认启发式
`prefer side turns *way* too much`，`belt.js:228`）进入蓝图后，粘贴结果会被游戏改写。
→ **结论：§4.0 修复是必要不充分；在补上 immutable 包裹（或粘贴完成后二次重钉 rv）并做
"故意让 rv 与启发式相悖"的反例实验之前，"离线布局 → 蓝图 = 完全确定"是未证断言。**
可执行判据：粘贴两条互相矛盾的拐角带（如 r=0 的直行夹在侧向接收者中间），断言 code 保持。

**(c) SZBP1 丢掉了 `originalRotation`，破坏"复制已建工厂"的保真。** 游戏的 belt 带子
`rotation`（当前朝向）与 `originalRotation`（玩家基准向）是两个字段；
`updateSurroundingBeltPlacement` 用 `targetStaticComp.originalRotation` 重算
（`systems/belt.js:160`）。我们的 `export_blueprint` 只导 `sme.rotation`
（`src/mod/shapez-ai-bridge.js:1457`、stride=4 的 `e:[code,dx,dy,rot]`），粘贴时
`placeOne` 把同一个值同时当 rotation 和 originalRotation 传给 `tryPlaceBuilding`
（`shapez-ai-bridge.js:808-814`）。于是：**对原 r=0 但被自动转向成 r=270 的拐角带
（M4 里就有 `(138,93) r=270`），导出再粘贴后 originalRotation 变成 270，日后任何一次邻域
扰动，它的重算基准都和原生工厂不同** —— H6/`exp-merge2` 那种"造出来就完了"的实验看不出来，
3.3"改造/扩张保留旧产线"必然踩。修法：SZBP1 stride 加一位存 originalRotation（游戏自己的
Blueprint.clone 走实体序列化，两个都带 —— `blueprint.js:166`）。

### F2. 「L2 只输出 paste_blueprint」的层间契约在剧情前 11 级根本不成立

- 游戏里蓝图功能 **level 12 才解锁**（`modes/levels.js:241-246`，L12 奖励
  `reward_blueprints`），且正常粘贴要消耗 `CbCbCbRb:CwCwCwCw`（`game_mode.js:195`），
  成本 `4·n^1.1`（`blueprint.js:64-68`）。SYNTHESIS §0 的核心工作流
  "离线求解 → 生成蓝图 → 一次粘贴" 在**目标恰是 level-11 的全部实验里**只能靠
  `charge:false`（mod 侧特权参数，`shapez-ai-bridge.js:1498`）。
- 后果一：2.2 "一键建线完成 level-2 目标" 用蓝图 = 用了剧情里不存在的工具 + 不扣材料。
  3.4 的"能力分 benchmark"如果不定义规则（是否允许 charge:false、是否允许提前摆放未解锁
  建筑），得分就是作弊分数。
- 后果二：mod 的 `place/place_path/paste` **都不检查 `getIsUnlocked`**（bridge 全文无
  unlock 判定；游戏只在 UI 层拦）。level-2 就能"放"stacker。做研究无害，做玩家/基准就是效度问题。
- 后果三：蓝图表达不了"连接到已有工厂"——粘贴是刚体矩形，与既有线的接口只能靠
  place_path 或粘贴后手补。而粘贴落在既有带上会**静默替换**（`belt.getIsReplaceable()=true`，
  `buildings/belt.js:68`；`tryPlaceBuilding → freeEntityAreaBeforeBuild` 删除可替换实体，
  `logic.js:139-165`）——一次落点算错的粘贴 = 又一次 bulk-delete 事故，且 `applied/failed`
  不报告"被覆盖删除了什么"。**§1 契约"L2 只输出 paste_blueprint 或 place_path"没有为
  "增量对接旧厂"留任何通道，与 3.3（不拆旧厂扩张）互相矛盾。**
- 修法：契约改为"L2 输出**布局 IR**，落地策略（蓝图/place_path/混合）按等级解锁与成本选择"；
  benchmark 规则里显式声明 charge:false 属"研究沙箱"还是"合法动作"。

### F3. 竞争定位的核心卖点被竞品源码证伪

SYNTHESIS §7："唯独把生产 DAG 摆成…工厂**没有任何现成方案**……竞品用'每关清空重建 + 简单摆法'**绕开**了布局"。
实测（`git clone Songxwn/shapez-auto`，HEAD 73ac7fe，2026-10-15，12 commits，v0.1.0–v0.1.6）：

- 它的 `internal/plan/layout.go`（685 行）是一个**真布局编译器**：每个 Op 有占地模板
  （cutter 2×1 + trash 接废槽 `layout.go:cut()`；painter r=270 带形状/颜料双入口 `paint()`；
  stacker/mixer 二输入 `binary()`），螺旋候选位搜索（`candidates()` r≤120 × 80 个），
  **A\* 带路由**（`route()`，带状态 = (x,y,进入方向)，`BeltPose` 显式算 rotation+variant，
  见 `geom.go:39-58`），hub 四边 16 口回退连接（`connectHub/connectSouth`），
  多副本并行产线（`LayoutCopies`，最多 4 个方向进 hub）。
- 它的 `plan_test.go:37-88 TestStoryShapes` 对 **26 个官方关卡形状**（含 4 层
  `CbCuCbCu:Sr------:--CrSrCr:CwCwCwCw`）逐个 Solve+Eval 断言 hash 相等；
  `TestLayoutReachesHub` 对 4 个形状断言布局真的连到 hub。
- 拐角问题它**从架构上绕过了我们的坑**：它的 mod 直接 `tryPlaceBuilding({rotation,
  rotationVariant})`（`assets/shapez-auto.js:553-558`），从不经过
  `computeOptimal...AtTile` —— 我们花 5 次失败定位的 rv 覆盖，在它那里是第一天就写对的基本功。
  （注意：它也**没有**用 immutable 包裹，所以它同样暴露于 F1(b) 的邻域重算改写——
  这是它没踩的坑之外的、我们共同的坑。）
- 更早的 `TomasSirgedas/Shapez-solver`（我们的交叉验证依赖它）其实**也已经输出带拐角的蓝图**：
  `shapez_solver.html:593-601` 定义 `SHAPEZ_BELT_LEFT=2/RIGHT=3`（正是 rv），
  `bluePrintFor`（:912-985）对 CUT_RIGHT/STACK 输出 `BELT_RIGHT/BELT_LEFT` 拐角模块、
  trash 接废槽、stacker 双输入错位——一个（丑但完备的）"DAG→空间"编译器，2022 年就有。
- `ecosystem.md §2.1` 其实把上面这些都写对了（"A* 路由""候选位螺旋"）。**是 SYNTHESIS 的
  §0/§7 没有消化 ecosystem 的发现**，把"竞品绕开了布局"当成了卖点前提。
- **真实差异化**（值得保留的主张）：① 离线全知地图（seed→资源图，竞品/公开求解器都没有）；
  ② `step/await` 确定性快进 + 存档解码的物流观测（竞品用 monkey-patch 时间倍率，改物理）；
  ③ 可编程 MCP/桥接与协议化验证；④ 颜色/形状维度全量的代数复刻（Shapez-solver 只算无色拓扑）。
  "谁解决布局谁赢"这句要降级为"布局已有可行先例，我们的贡献是把地图先验、确定性落地、
  与增量改造做成别人没有的那一半"。

---

## 2. 需修正项（具体、可操作）

| # | 位置 | 现状 | 应改为 | 依据 |
|---|---|---|---|---|
| C1 | `facts/RV-FIX-verified.md:55-66` + `SYNTHESIS.md:184` | 宣称"已验证/2805/2805/与源逐格一致" | 改为"两次粘贴观测子集一致；脚本判定 pass=false（源比对锚点差一格）；清理后 2807≠2805 残留 2 实体；重验 H7 待办未完成" | `facts/live/exp-rv-fix.result.json`（pass:false, after_total:2807, src 9 vs paste 8） |
| C2 | 同上（机制） | "粘贴完全确定" | 粘贴包 `performImmutableOperation`（对齐 `blueprint.js:159`）或粘贴后二遍重钉 rv，并跑 F1(b) 反例实验后才可恢复该措辞 | `systems/belt.js:60-64,169`；bridge:1545 只有 bulk |
| C3 | `src/shared/blueprint.mjs` / `opExportBlueprint`（bridge:1457） | stride=4 丢 originalRotation | stride=5 加 `originalRotation`；`placeOne` 分开传 | `systems/belt.js:160` 用 originalRotation 重算；`logic.js:122-129` |
| C4 | `facts/solver-cross-validation.md:3` + `SYNTHESIS.md:22` | "100% 一致" 暗示验证了"全部形状运算" | 显式限定：**仅 layer0 占用拓扑、无色无形状种类**；另：`validate-vs-public-solver.mjs:72` `want = code & 15` 是弱比对——我本地把全部 4 个 nibble 都比对，48433/48433 仍全过，**建议直接改成全码比对**，主张立刻变强且诚实 | 脚本第 71-72 行；我复跑的全 16-bit 对拍 0 失败 |
| C5 | `facts/solver-cross-validation.md:50` | "该表主要覆盖单层形状…多层【待验】" **说反了** | 表按 16-bit 码索引，48,433 条里 48,417 条是多层（2-4 层）码；且我们的 stack 与全码比对通过。改成"多层拓扑已一致；颜色/形状种类仍未交叉验证（RAW 只有 1 条，表是骨架求解器）" | `shapez_solver.html:511-512`（code=4×nibble）；对 bin 的 nibble 统计 |
| C6 | `facts/MILESTONE-M4-SUCCESS.md:3-4,59` | "用修复后的 rv 控制…一次通过" | 改为"用 M3 的'拐角最后放'模式通过；`exp-merge-line2.mjs` 未用蓝图、未用 rv 覆盖参数（grep 无 paste_blueprint），修复并未被该实验检验" | `exp-merge-line2.mjs:27-61` 全走 place/place_path |
| C7 | `facts/GEOMETRY-TABLE.md:1`（"全部实机验证"） | 表内 11 行有 6 行标 ⬜（quad/rotater/mirrored/mixer/hub/…） | 标题改"核心 5 机实测 + 其余源码核证未实测"；:11 "M1b + H7" 与 :67 的 H7 引用一并修（见 S 节） | 本文件自身表格 |
| C8 | `research/ai-player/facts/MERGE-diagnosis-final.md:48-51` | "方案 2：用蓝图（已实测保真，H7）…粘贴时直接指定，不经过自动定向" | 两处都错：保真结论已被推翻（见 S1），机制上"经过自动定向"（F1(b)）。指向 RV-FIX 未竟状态 | 同 ROOT-CAUSE:45-47 |
| C9 | `SYNTHESIS.md:3` | "12 份设计、24 份对抗验证" | designs/ 只有 3 份文件，`review/`、`critique/`、`facts/analysis/` 目录为**空**。要么补归档要么改口径（"由 ~60 个会话产出，未全部归档"） | `ls` 结果；commit bf40d2e 仅收录 layout-compiler 一份设计 |
| C10 | `SYNTHESIS.md:88`（第一批 #0 验收标准） | "粘贴**打乱顺序**后仍得到完全一致的 rv" | 这条验收**没有被执行**——exp-rv-fix 从未打乱顺序粘贴。列为未完成 | exp-rv-fix.mjs（固定顺序，两次只是换位置） |
| C11 | `designs/layout-compiler-DESIGN.md:95` | "Level 3 = await hub_delivered_increased" | 注意 `hub_delivered_increased` 要求当前 goal 就是产出的形状（`bridge:1417-1421`），验证任意配方要切档或用 stored_shapes 增量；设计文档要写明 | bridge opAwait |
| C12 | `facts/ops-semantics-VERIFIED.md:39`（"7 步…2×rotate"） | 无错但引用格式乱（"manager.js:92" 实为 `shape_definition_manager.js:92`，该文件与行号我核对属实） | 文件名统一 | 上游目录名 |
| C13 | `research/ai-player/proto/solver.mjs`（未跟踪，工作区） | 默认 `cutQuad` 全开 → L11 目标给出的解用了 L16 建筑（README:28 自己也承认） | **默认关闭 cutQuad**，加 `--unlock-level N` 门控（cutter L1/rotater L4/painter L6/mixer L8/stacker L10，见 human-strategies §2.2 与 levels.js）；默认预算下调到能在 CI 里跑 | solver.mjs:256,262-263（默认 depth 7 / 150k 状态） |
| C14 | `SYNTHESIS.md:91`（1.3 验收 "≥95% 一致率"） | 与已达成并 100% 通过的公开表自相矛盾：既然 `recipes_0_1_1.bin` 已 vendor 且验证 100%，**第一版求解器应直接查表 + 颜色映射（`shapez_solver.html:codeForShape/mapping`，Unlicense）**，BFS 只做兜底 | 把"造 BFS"降级、"查表+映射"升级为 1.3 主路径 | bin 文件 327,680B 与上游逐字节相同（我校验过） |
| C15 | `SYNTHESIS.md:170` "place_path 退化段报 2001，本次踩 3 次" | 属实（`bridge:1064-1066`），但同一函数还有未列的行为：**place_path 逐格调用 `placeOne` 自动定向**，一条长带中途被机器隔断时会静默放歪（每格独立看邻居）。工具缺陷表应加"place_path 与自动定向的组合语义要写进协议" | bridge:1086-1096 |
| C16 | 悬空引用（4 处） | `SYNTHESIS.md:91`→`designs/solver-*.md`、`SYNTHESIS.md:106`→`facts/observation-gaps.md`、`offline-map-EXPERIMENTS.md:133`→`facts/blueprint-format.md`、`ops-semantics-VERIFIED.md:88,161-165,208`→`building-io.md` —— **四个文件全不存在** | 改为指向实际存在文件或删除；`ops-semantics:161-162` 让 rotater/stacker 行"见 building-io"，而 §9 里自己已核实 —— 就地填回 | `ls` 验证缺失 |

---

## 3. 未证断言清单（文档当前按已证口径写的）

1. **"蓝图是确定性的落地方式"（§0/§1/§4.0/RV-FIX）** —— 见 F1：机制未被反例检验、
   实验自带 pass:false、清理残留 2 实体未消歧。**这是最高优先补验项。**
2. **"level-11 所需能力全部实测打通"（M4-SUCCESS:63、GEOMETRY-TABLE:63-72 的 ✅ 汇总）** ——
   缺两环：① **mixer 从未实机验证**，而金标准链第一步 cyan 必须 mixer（ops-semantics §3 自己强调）；
   M2a 用的是 blue 直矿。② **完整 CgScScCg 产线从未在实机建成**——已验证的是各单环节
   （M1b/M2a/M3/网格/ M4 的 2 层 stacker 输入是两个整矿，不是互补半形状再堆叠）。
   文档在"能力"层面成立、在"链"层面不成立，措辞需要区分。
3. **"交付到 hub"从未观测** —— 所有里程碑产物终点是 trash；没有任何实验用过
   `await hub_delivered_increased`（grep 全部 exp-*.mjs 为空）；hub 16 入口几何"未接 hub 做过实验"
   （M3 文档:75 自己承认）。§2.2 的验收（delivered 增加）整条链从未被部分验证。
4. **通用性外推**：M4 的"分支 A 竖直直入 + 分支 B 两拐角"模式被 M4-SUCCESS:83-93 写成
   "通用布局函数"，但**3 输入汇合（quad 切割后 4 路）没有可行模板**——stacker 只有 2 个 bottom
   输入，N>2 必须先二分成树，每层都要 M3 式"抬车道"，车道互不交叉性从未被论证或实验。
   H5b 的外推同罪：验的是 miner→belt，没有证据外推到"未生成区域的 cutter/painter 输入输出"
   （SYNTHESIS:194 已诚实列出，但 §0 表格把 H5b/H6 并列为"物流真的在流动"总证据，读者会过度解读）。
5. **26 级路线图后半程**：L14 起是 throughputOnly 关卡（levels.js，`required: 8/秒`），
   L17+ 出现 double painter、quad painter（电线）、4 层形状 —— 布局器、求解器、benchmark
   对吞吐关、电线逻辑（goal 信号读回，ops-semantics:249-251 承认未暴露）全部无设计。
   路线图的"1.x–3.x"事实上只覆盖到 level 11-13。
6. **"离线盲建在任意远坐标"**：最大实测距离 2874（H4）。>5000 格、跨 chunk 边界奇偶、
   与浮空 island 的 map 行为未测（SYNTHESIS:195 已列，OK）。
7. **LLM 层的任何效果**：1.5/3.5 只有 mock 计划，token 预算、修复成功率均未测（已诚实列出）。
8. **benchmark 效度**：见 F2（charge:false / 解锁不校验）——3.4 若不先定义"合法动作集"，
   分数不可比。

---

## 4. 残留的错误结论（被推翻但仍被引用；文件:行）

> 主 Agent 修了 3 处（commit 26bc19e：building-code-table:75、M4-partial:83、
> GEOMETRY-TABLE:52-54），下面是**漏网的**。S1 是同一实验（H7）的原始错误结论的残留。

- **S1** `facts/GEOMETRY-TABLE.md:11` —— belt 行证据写 "✅ M1b + **H7**"。H7 的结论已被
  ROOT-CAUSE 推翻（belt 变体保真当时未证）；此格证据应改 "M1b + RV-FIX（部分，见 F1）"。
- **S2** `facts/GEOMETRY-TABLE.md:67` —— "蓝图保留带子拐角变体 | ✅ 逐格 r/rv 一致 |
  `blueprint-integrity-EXPERIMENT.md` H7"。"保留"（存档层面）与"使用"（粘贴层面）是两个命题，
  后者曾被 H7 冒充；且现在的"修复后验证"证据本身有 F1(a) 问题。此行应降级为"✅ 存档保留 /
  ⚠️ 粘贴采用待补验（exp-rv-fix pass=false）"。
- **S3** `facts/MILESTONE-M3-stacker-verified.md:68` —— "belt（含拐角变体）✅ M1b + **H7**"。同 S1。
- **S4** `facts/MERGE-diagnosis-final.md:48-51` —— "✅ 方案 2：用蓝图（**已实测保真，H7**）"，
  机制描述"粘贴时直接指定，不经过自动定向"**两处错误**（H7 已推翻；且 `systems/belt.js`
  证明粘贴后邻域重算照样改）。这是三份文档里残留最重的一处（见 C8）。
- **S5** `facts/ROOT-CAUSE-rotationVariant-override.md:93-94` —— 待办 "⬜ 加 mod_selftest
  回归用例 / ⬜ 重新验证 H7" 前一项已完成（test/mod_selftest.mjs:348-376 三条断言，实跑
  21 全绿）、后一项未闭环但 RV-FIX 已自称闭环 —— 两个文档对同一验证的状态记载互相打架。
- **S6** 旧提交信息残留：`bf40d2e`（已入库的历史提交）正文断言 "Blueprints preserve belt
  rotation and corner variants exactly (H7)" —— 历史不可改，但在 SYNTHESIS §8 产出清单里
  应加一行"H7 结论后被推翻，见 ROOT-CAUSE"，防止从 commit message 二次引用。
- （已修好的确认：building-code-table:75、M4-partial:83、GEOMETRY-TABLE:52-54 现措辞正确；
  `blueprint-integrity-EXPERIMENT.md` 的修正节完整。）

---

## 5. 遗漏清单（方案完全没考虑的）

1. **粘贴的破坏半径**：与既有可替换实体（belt）重叠会**静默删除并替换**（F2 后果三）。
   没有"paste 冲突预检"（dry_run 版的 paste_blueprint），与 bulk_delete 事故同源，但更危险
   （蓝图一次可覆盖几十格）。**建议第一批就把 `paste_blueprint dry_run` 加上**，理由同 §4.1。
2. **部分粘贴**：49 实体粘贴若第 20 格被占，其余 29 格照常放（`opPasteBlueprint` 逐格 try），
   产出一座半毁子工厂且 `failed[]` 不含连锁损失。需要 all-or-nothing 模式
   （游戏原生粘贴正是这样：`checkCanPlaceEntity` 逐格跳过 —— 同样问题原生也有，但
   agent 方案必须能检测并回滚：现在没有 uid 全清单，见 §4.2）。
3. **升级/解锁 UI 对自动化的阻断**：`step` 在 `root.hud.shouldPauseGame()` 时抛 2002
   （bridge:1247-1255）。剧情升级弹窗（standalone_advantages 等）可见时**整个快进管线停摆**。
   全部里程碑都在旧档（无升级事件）里跑，从未遇到；"一键建线通关 level-2"第一次真升级就会踩。
   需要 `dismiss_overlays` 动作（竞品有 `dismissOverlays`，shapez-auto.js:576）。
4. **升级购买（belt/miner/processors/painting 倍率）**：工具链没有任何"买升级"操作；
   吞吐模型里的 `× 升级倍率` 永远取 1，到 L5/8/11/13 的官方 t2/t3 需求会吞吐不足——
   路线图 2.2/3.3 对此零字。
5. **弯带容量**：curved belt 有效长度 0.78 格（`components/belt.js:6` `curvedBeltLength`），
   物品间隔按长度计算 —— 布局器"拐角=免费"的隐含假设错了：拐角多的线吞吐上限更低。
   设计的吞吐公式（DESIGN:122-135）不含此项。
6. **多产线共享 hub 口的争用**：16 入口是"接收口"，多条线汇入同一格带时要有合并策略
   （balancer 未验证；`preferredSlot` 轮转语义 `item_processor.js:351-357` 只在 balancer 出现）。
   选址优化（3.2）没把 hub 口当稀缺资源建模。
7. **资源枯竭不存在、但"矿位互斥"存在**：一个矿机占一格资源；两条线抢同一资源簇、
   以及"矿机链变体（chainable）的连排规则"（miner.js 有链式变体，布局器完全没建模）。
8. **存档兼容与并发**：实验全部假设可随意 `save_now/snapshot_load`；agent 长跑时游戏
   自动存档（automatic_save.js）与 step 交错的一致性没有任何规则。
9. **benchmark 反作弊规则**（F2 后果一）。
10. **"100% 一致"的表只有一条 RAW**（code=1，单象限占位）——意味着公开表的配方树假设
    "任何形状可凭空生产"，与"必须从四象限整矿出发"的真实约束之间还有一层
    （我们的 7 步链之所以成立是因为选了整矿原料）。1.3 验收"与公开表一致率"对
    **原料可得性**是空指标。
11. 游戏暂停/加速的副作用：`step` 复刻 puzzle 校验循环，puzzle 模式下所有 processor 速度
    ×10×2（`hub_goals.js:519-522`）——用 step 在普通档量吞吐没问题，但别拿 puzzle 档数字
    当基准。文档没区分。

---

## 6. 评分（0–10，诚实）

| 维度 | 分 | 理由 |
|---|---|---|
| **证据扎实度** | **6.5** | 核心（代数/地图/单机几何）经得起我逐行复核，实机对拍是真的；但两处致命伤：① 旗舰证据 RV-FIX 的文档叙述与自己的 result.json 矛盾（pass=false、残留 2 实体）；② 三处 H7 残留引用 + M4-SUCCESS 把"没走修复路径"的实验记成"修复的胜利"。里程碑用 trash 终端、从不连 hub、从不看交付，把"环节验证"写成了"能力打通"。 |
| **可落地度** | **5** | 第一批（查表求解器 + 几何模板 + 带验证的 place 流程）确实可直接开工；但承重假设"蓝图=确定性落地"未完成证伪检验（F1），层间契约在 L12 解锁、成本、增量对接三点上与现实冲突（F2），SZBP1 缺 originalRotation（F1c）。按现方案推进会在"第一次真升级/第一次贴到旧厂旁边"时停摆。 |
| **杠杆作用** | **7** | 方向判断（确定性世界模型 + LLM 只做选择/修复）我认为是对的，且被竞品独立实现同构架构佐证；离线全图 + step/await + 存档解码这三件资产是真杠杆。扣分在卖点虚高：布局并非"没人做过"（F3），差异化该重述为"地图先验+确定性执行+可编程接口"。 |

---

## 7. 一句话结论

**值得做，但不能按 SYNTHESIS 现在的口径开工**：先花半天做一个"故意与启发式相悖的拐角蓝图
粘贴 + 邻域扰动"反例实验，把粘贴包进 `performImmutableOperation`、SZBP1 补 originalRotation、
把 §0 表格和 §7 的竞品论断按 F1/F3 改写——**最大风险不是布局难，而是全案把"未闭环的
确定性粘贴"当成已闭环的地基，在上面盖了三层楼。**
