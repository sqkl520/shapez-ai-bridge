# 布局编译器实施规划（plan-compiler.md）

> 角色：规划 Agent。本文只做**拆解与接口设计**，不含实现代码。
> 目标：把「shapez 布局编译器」拆成文件所有权不冲突、接口先行、可 5+ 并行执行的工作包。
> 状态图例：`[已定]` 已依据仓库事实确定 / `[假设]` 需实机或红队确认 / 未标 = 已定
> 本文所有 `文件:行号` 引用均在本仓库工作树核验过（2026-10-24）。

---

---

## 0.0 勘误（批次收敛后回写，2026-10-24）

实施过程中被测出并已修的口径，**以本节为准**（正文保留原始规划，不覆盖，便于追溯）：

1. **`dx/dy` 锚点**（§2.1）：`= site.anchor`（世界锚点），`w` 归一为世界 min corner。原文把两者混写，只在 anchor==w 时同时成立。
2. **`hubConnection.entry`**（§2.3）：= **带子末格**（hub 外的送带最后一格），`side` = 贴的 hub 边，`dir` = 带子流向。P3/P5/P7 三方独立收敛到此读法。
3. **`--plan` 单独输入是 UNDECIDABLE**（§5 L1.5）：必须带 intent（`--intent`），否则 exit 2 而非绿灯。
4. **三个 hub 概念**（实施中三次踩坑，见 P8 `harness/NOTES.md §1.0` 的完整表）：
   `ctx.hub` = 世界系 hub 位置；`ctx.hubDesign` = 设计系（局部）；`HUB_CLEAR` = 设计系排版净空行数。
   前两者再自洽也推不出第三者 —— `site.anchor` 是任意平移量（`anchor = hubWorld − hubLocal`）。
5. **§7 的"布局没人解决"是错的**：竞品 `Songxwn/shapez-auto` 有真布局编译器（源码已读）。差异化应表述为
   **地图先验 + 确定性时间控制 + 物流观测通道 + 可编程接口**，而不是"没人做过布局"。
6. **退火 / CP-SAT 不做**（`routing-prior-art.md §7`）：退火用 RNG ⇒ 不可复现，破坏变异测试与逐格 diff 的方法论；
   MIP 依赖专有/重依赖，违背零依赖铁律。抄它们的**约束清单**，不抄求解器。

---

## 0. 目标定义（编译器 I/O）

`[已定]` 输入 = 目标形状（游戏 level 定义或 `proto/solver.mjs` 的 steps）+ 地图（seed 离线可算）+ 已建世界（obs 归一为 `WorldState`，§2.6）。
`[已定]` 输出 = **一个 SZBP1 蓝图字符串 + 逐格意图表**（`CompiledPlan`，§2.1），`paste` 后产线可直接运行并产生 `hub_delivered_increased`。

`[已定]` 顶层入口（P8 实现，签名即 DESIGN:103-116 的具体化）：

```js
// src/ai/compiler/compile.mjs
/** @returns {CompiledPlan} 永不 throw；失败走 {ok:false,reason,failingNode,hint} */
export function compilePlan({ goal, seed, world, site, demandPerSec })
//   goal: string        目标 shortKey（"----CuCu" / "CgScScCg"），用 proto/shape-ops.mjs:27 parse 校验
//   seed: number        离线资源图真值（proto/gen-resources.mjs 的同一套算法）
//   world: WorldState   已建世界（§2.6）；全新址时 entities=[]
//   site: {anchor, hub} 建址；hub 未知时由 world 读
//   demandPerSec: number 需求吞吐（0 = 只要能跑通；影响 V7 行数）
// 管线内部：solver → world 选矿位(P2) → place(P3) → route(P4) → validate(P5) → emit(P6)
```

**范围裁决（v1 钉死，写进 `CompiledPlan.scope`）**：单层形状、无 wire、无隧道、机器恒 r=0、入度 ≤2、全新址不增量对接旧厂。超出者一律 `ok:false` + `reason`（§2.5），**绝不产出会堵死的蓝图**（redteam:158）。

---

## 1. 工作包清单

**命名与目录约定**（所有新包写入互不相交的子目录，杜绝冲突）：
- 库代码：`src/ai/compiler/<package-name>.mjs`（新建目录 `src/ai/compiler/`；`src/ai/` 根下只有 `belt-rules.mjs`(禁改) 与 `machine-spec.json/md`(P0-spec 独占)）
- 包私有测试与 fixture：`research/ai-plan/<package-name>/**`（每个包**只写自己的子目录**，可以读任何人的）
- 测试运行方式沿仓库既有约定：`node <file> --test`（README:213-215；无 npm test、无框架、零依赖）
- 唯一共享写区：`research/ai-plan/fixtures/`（**只有 P1 能写**，其余包只读；包私有样本放自己的目录）

### 1.0 已在跑的并行 Agent（第一批输入，不抢它们的文件）

| 包 | 拥有文件 | 状态 / 与本规划的关系 |
|---|---|---|
| P0-spec 规格专家 | `src/ai/machine-spec.json`、`src/ai/machine-spec.md` | 在写。它的 schema 由它自己 prompt 决定；**本规划不直接依赖它的字段名**——由 P2 的 `op-templates.mjs` 做唯一一次适配（见 §2.2「迁移路径」）。任何 schema 变动只改 P2 一处。 |
| P0-redteam 红队 | `research/ai-player/redteam-compiler-assumptions.md` | 已完成。**#4「可布性 8 条清单」(redteam:141-150) 直接成为 P5 validator 的需求单**；#3b 静默毁带、#2 wire 无豁免、#6 解锁定位 进入 §6 风险与 §2 契约字段。 |
| P0-verify 验证 | `src/ai/belt-rules.test.mjs`、`research/ai-player/verify-belt-rules.md` | 在写。其「邻居拓扑判据 + 跨实现重算」会被 P5 以**同一判据**复用（不共用文件，P5 自己实现 `belt-sim.mjs`，两边对拍）。 |
| P0-prior 外部检索 | `research/ai-player/routing-prior-art.md` | 在写。P4 路由选型输入；只读。 |

### 1.1 P1 `contract` —— 类型与网格原语（接口先行，必须最先落地）

- **拥有**：`src/ai/compiler/types.mjs`、`src/ai/compiler/grid.mjs`、`src/ai/compiler/errors.mjs`、`research/ai-plan/fixtures/**`（唯一有权写共享 fixture 的包）、`research/ai-plan/contract/**`（P1 自己的测试与 CONTEST 记录）
- **依赖**：无（只 import `src/ai/belt-rules.mjs` 的常量，只读）
- **内容**：§2 的四个类型 + JSDoc 校验器（`assertCompiledPlan` 等纯函数）+ `Grid` 原语（`get/set/occupy/occupyRect/bbox/isFree/key/toString`，**必须支持三态占用**：`empty | occupied_solid | occupied_replaceable`，见 §2.3 与 redteam:102-112）+ `cellKey`/`rotateLocalSlot` 小工具 + 规范化错误对象 `{ok:false,reason,failingNode,hint}`（DESIGN:114、redteam:158）
- **验收**（L0）：
  1. `node src/ai/compiler/grid.mjs --test`：同格二次 `set` 抛错；2×1 机器 `occupyRect` 在 r=0 时覆盖两格、r=90 时**必须**按 origin 位移规则覆盖（GEOMETRY 表1 只在 r=0 定义；v1 编译器**禁止**旋转机器，见 §2.3 决策 D1）；`occupied_replaceable` 对机器放置算冲突、对带子放置算可复用。
  2. `node src/ai/compiler/types.mjs --test`：`fixtures/plan-l1.json`、`fixtures/report-validator.json`、`fixtures/report-layout.json` 三个金样例 round-trip 通过（缺字段 → 结构化错误，不静默）。
  3. **导入 lint**：P1 的 test 断言 `src/ai/compiler/*.mjs` 里没有任何 `import ... "proto/belt-rules.mjs"`（红队 #1(2)：`research/ai-player/proto/belt-rules.mjs:49` 的 `beltEntry=OPP[beltExit]` 对弯带是错的，误用即整条 L 形 rv 全错）。
  4. 三个金样例必须能被 `src/shared/blueprint.mjs:73 summarizeBlueprint` 读通（P6 用）。
- **不许**：写任何布局逻辑、任何几何真值（几何表在 P2）、任何 RPC。

### 1.2 P2 `data` —— 机器规格适配 + Op 占地模板 + 离线世界访问

- **拥有**：`src/ai/op-templates.mjs`、`src/ai/world.mjs`、`research/ai-plan/data/**`
- **依赖**：P1（类型）；**读** `src/ai/machine-spec.json`（P0-spec 产出）、`research/ai-player/facts/GEOMETRY-TABLE.md`、`research/ai-player/facts/building-codes-live.json`
- **内容**：
  - `loadMachineSpec()`：唯一一处消费 `machine-spec.json` 字段名的地方 → 归一成 §2.2 `OpTemplate[]`。
  - `OP_TEMPLATES`：每个 op（mine/cut/cutQuad/rotate/paint/mix/stack）→ 机器 code + 输入槽 + 输出槽 + 废槽默认 trash 规则 + 速率。**geometric 真值以 GEOMETRY-TABLE 表1（:13-23）为准**：cutter 2×1 bottom 进 / 左格 top=左列、右格 top=右列；stacker 2×1 双 bottom（左格=下层、右格=上层，M3 已实机确认槽位→层映射，GEOMETRY:18）；painter 2×1 shape←left / color←top / 出→right（GEOMETRY:19）；mixer 2×1 双 bottom 进、top 出（⬜ 未实测，GEOMETRY:21）；rotater 1×1 下进上出（⬜ 未实测，GEOMETRY:17）。
  - `world.mjs`：`tileResource(seed,x,y)` / `findResource(seed,shape,region)` —— **不得修改 `proto/gen-resources.mjs`**（它没有 `export`，`generateWorld` 是模块内函数，只有 CLI `node gen-resources.mjs <seed> x0 y0 x1 y1` 输出 `[x,y,shape]` JSON 行，见 gen-resources.mjs:194-256）。做法二选一，P2 自己决定并写进 `research/ai-plan/data/NOTES.md`：(a) 在 `src/ai/world.mjs` 内**复刻** chunk 算法（与 `exp-e2e.mjs:32-89` 同源，那段已内嵌在实验脚本里、可直接搬）；(b) 生成期调用 CLI 落成 fixture 再读。**禁止**要求别人把 gen-resources 改成可 import。
- **验收**：
  1. `node src/ai/op-templates.mjs --test`：对 `building-codes-live.json` 的 **15 条 code（1,7,8,9,10,11,12,13,14,15,16,17,18,19,20）**逐条断言 `codeFor(building,variant,r=0,rv=0)` 相等；每条模板的槽位数 == GEOMETRY 表1；`trash` code=20。
  2. 旋转律断言：模板槽位只定义在 r=0，世界槽位 = `rotateLocal(localDir, rotation)`（与 `src/ai/belt-rules.mjs:25-28` 同一函数，不许二次实现）。
  3. `node src/ai/world.mjs --validate`：对 level-11 存档 seed（`research/ai-player/facts/live/`）跑一片区域，与 `node research/ai-player/proto/gen-resources.mjs <seed> x0 y0 x1 y1` 的 JSON 输出**逐格对拍 0 差异**（离线，不需游戏）。
  4. 速率表（GEOMETRY:31-40）作为 `throughput` 字段导出，`stacker:0.25` 必须在（§5 吞吐判定用它）。

### 1.3 P3 `placer` —— 配方 DAG → 空间网格（作图）

- **拥有**：`src/ai/compiler/place.mjs`、`research/ai-plan/placer/**`
- **依赖**：P1（Grid/types）、P2（OP_TEMPLATES、world）；**参考但禁改** `proto/layout-grid.mjs`、`proto/layout-merge.mjs`（已验证骨架：`Grid.set` 冲突即抛 layout-grid.mjs:32-36；机器→直线→拐角的产出分层 layout-merge.mjs:96-127）
- **不 import P4**（防环）：P3 只决定"哪个 op 落在哪个格 + 每个连接对的 (from cell, outDir, inDir)"，把它写成 `LayoutReport.channels[]`（§2.3），**由 P4 消费**。
- **内容**：
  - 主结构 = DESIGN:44-71 的**行式布局**（拓扑分层 → 每层一条水平轨道 → 层内 barycenter 排序 → 竖直连接 → 收集带 → hub）。
  - **第一原则**（GRID-LAYOUT:41-62）：尽量串联同向机器、**零拐角**——cutter/stacker/rotater/mixer 全 "下进上出" 可竖直直串；只有 stacker/mixer 双输入、painter 的 +x 流、分支汇合才拐弯。
  - 汇合模式：M4-SUCCESS:33-47 的「只让一条分支拐弯」（第一个上游正好落在目标机器左格正下方 → 零拐角），其余分支 `竖直→拐角→车道→拐角→目标列`；不同分支的车道**必须不同行**（陷阱表 #5，M4 pitfalls:65）。
  - N>2 汇合：先二化成树（stacker/mixer 只有 2 个 bottom，redteam:147）。**多层形状（`:` 分隔）v1 显式拒绝**（redteam:150 第 8 条）。
  - 未使用输出槽**必须**自动接 trash（陷阱表 #7，pitfalls:67；`layoutSingleBranch` 已写死 layout-grid.mjs:90-92）。
  - hub 出口选择：`exp-e2e.mjs:93-102 hubEntries()` 的 16 入口表（顶排 dir=180 / 底排 dir=0 / 左列 dir=90 / 右列 dir=270，源 `buildings/hub.js:73-91`），P3 直接把这条表搬进自己文件（不 import exp-*）。
- **验收**（L0）：`node src/ai/compiler/place.mjs --test` 断言四张金网格（字符画，逐字节相等、无随机）：① 单分支 `miner→cutter→rotater` 全竖直线、零拐角（对齐 GRID-LAYOUT:44-53）；② 双分支汇合 stacker；③ painter 支线（shape 从 left、color 从 top，验证颜料垂直通道，GEOMETRY 规则6 :52-53）；④ level-11 形状 `CuCuSuSu:RuRuCuCu` 的 4 输入两两二叉化。再加：把两个 op 塞进同一格 → 抛 `cell already occupied`；同一列被两条通道要求 → 报 `conflict:lane-column` 并加宽后重试成功。

### 1.4 P4 `router` —— 带路由与拐角显式定向

- **拥有**：`src/ai/compiler/route.mjs`、`src/ai/compiler/lane.mjs`、`research/ai-plan/router/**`
- **依赖**：P1、P2；**只 import `src/ai/belt-rules.mjs`**（不许 import `proto/belt-rules.mjs`，见 §1.1 lint 与 §3）
- **不 import P3/P5**（防环）：输入是 `LayoutReport.channels[]`，输出是带子格集合 + 每格 `(inDir,outDir,rotation,rv,code)`。
- **内容**：
  - 直线段：轴对齐填充；退化段（from==to）在 IR 里**保留为一格**，不做「报 2001」那种把常规输出变异常处理的做法（tool-gaps §4.4，DESIGN:264-310）。
  - 拐角：`solveTurn(inDir,outDir)` → `{rotation, rotationVariant}`（`src/ai/belt-rules.mjs:42-53`），`code = beltCode(rv) = 1+rv`（:55-56）。**不需要**游戏自动定向——蓝图路径显式携带 rv（`src/ai/belt-rules.mjs:10` 头注 C 段 + `src/mod/shapez-ai-bridge.js:1576-1577` 的 `performImmutableOperation`）。`solveTurn` 返回 `null`（同向穿过 / 非直角非同向）→ 报结构化错误，不许硬凑。
  - 车道分配：为每条跨列通道选 (lane row, 进出列)，约束 = 不同分支不同行、同列不冲突、不穿机器占地、不穿 hub 4×4；冲突解法 v1 只用「水平错位 + 加宽行距」，**需要隧道/立体绕行即报 `ok:false, reason="需隧道，v1 不支持"`**（DESIGN:76-88 阶段 B + redteam:150 第 4 条）。
- **验收**（L0）：`node src/ai/compiler/route.mjs --test`：
  1. **链闭合**：对每条路由逐对相邻格断言 `beltExit(rv_u,rot_u) === OPP(beltEntry(rv_v,rot_v))`（等价 `src/ai/belt-rules.mjs:59-70` 自测的扩展）。
  2. **12 组全覆盖**：rv0/1/2 × rot 0/90/180/270 的 `solveTurn` 反查恒等（`solveTurn(beltEntry(rv,r),beltExit(rv,r)) == {r,rv}`）——红队 #1(1) 指出这条**只是自洽**，所以真正的语义判据交给 P5 的 computeBelt 与 P7 的实机 L2-paste-corner，P4 不得声称验证了语义。
  3. 端点对齐：路由首格 entry == 上游机器输出槽方向、末格 exit == 下游机器输入槽方向（用 P2 模板）。
  4. 拐角上/下行数差 1 格的 M4 陷阱 #1/#2 复现用例（`MILESTONE-M4-partial-and-pitfalls.md:24-40` 的 (141,90)/(142,90)/(135,90) 死循环）→ 断言现在的路由**不会**产生该形状（回归锁）。

### 1.5 P5 `validator` —— 离线自检器（产蓝图前的硬闸）

- **拥有**：`src/ai/compiler/validate.mjs`、`src/ai/compiler/belt-sim.mjs`、`research/ai-plan/validator/**`
- **依赖**：P1、P2、（读）P3/P4 的产物类型；**只 import** `src/ai/belt-rules.mjs`
- **需求单 = redteam「可布性必要检查清单」8 条（redteam:141-150），逐条落地成一条 check id**：
  | check | 判据 | 出处 |
  |---|---|---|
  | `V1-occupancy` | 落点矩形全空；多格机器用旋转后包围盒；三态占用中 `replaceable` 对非带子算冲突 | redteam:143、`logic.js:139-165` |
  | `V2-no-overwrite-existing-belt` | 与既有世界的带子**零重叠**（paste 会静默替换可替换带，已毁过 6 条真实带） | redteam:102-112、ADVERSARIAL:87-90 |
  | `V3-belt-fixed-point` | **含机器邻居**逐格跑 `computeBelt`，非不动点 → 报（现成 `validate-belt-rules.mjs:126-136` 只喂带子，82.5%，不能复用其结论） | redteam:144、`src/ai/belt-rules.mjs:8-10` |
  | `V4-slot-alignment` | 每根带子的 exit 落在下游 acceptor 槽、entry 承接上游 ejector 槽（用 P2 模板） | GEOMETRY 表3 |
  | `V5-degree` | 入度 ≤ 槽位数（stacker/mixer=2、cutter=1）；N>2 必须先二叉化否则报 | redteam:146 |
  | `V6-crossing` | 两股流需要穿格 → 报「需隧道」 | redteam:149 |
  | `V7-throughput` | `min(节点速率)` 对比需求；`stacker 0.25/s`（GEOMETRY:37）为瓶颈 → 行数不足即报 | DESIGN:122-136 |
  | `V8-scope` | 多层形状 / wire / 隧道 / 旋转机器 / quad cutter 4 路 → 一律显式 `ok:false` | redteam:150、ADVERSARIAL:162-164 |
  | `V9-unused-outlet` | 每个未接走的输出槽必须有 trash | 陷阱表 #7 |
  | `V10-unlock-report` | 用 `machine-spec.unlock_level` + solver 门控算出「当前等级不可用」清单，写入 report（不阻断，god-mode 口径，§6 R4） | redteam:190-216、`proto/solver.mjs:110`（cutQuad 默认开 → L16 建筑） |
- **另加离线复刻**：`shape-ops` 重放每个节点输入→输出 hash 相等（DESIGN:93 Level-1，`proto/shape-ops.mjs:50 hash`）。
- **验收**（L0）：`node src/ai/compiler/validate.mjs --test` = **变异测试**：对一张已知 good plan，逐个注入 7 条陷阱（`MILESTONE-M4-partial-and-pitfalls.md:59-67`）+ 8 条清单的反例，断言每次报出**且只报出**对应的 check id，且 `failingNode` 指向正确格子。P0-verify 的邻居拓扑判据与 P5 的 `V3` 必须在同一 fixture 上**双实现交叉对拍**（两份代码、同一批存档带子，0 差异）。

### 1.6 P6 `emitter` —— SZBP1 发射与回读自检

- **拥有**：`src/ai/compiler/emit.mjs`、`src/ai/compiler/roundtrip.mjs`、`research/ai-plan/emitter/**`
- **依赖**：P1、P2、P4（带子 code）、P5（validator 必须 0 error 才允许发射）；**只 import 只读** `src/shared/blueprint.mjs`
- **内容**：
  - 归一化锚点 `w=[minx,miny]`、`entities[] = {code,dx,dy,rot}`（`src/shared/blueprint.mjs:61-68 encodeBlueprint`）；`gv="1.5.6"`，**与游戏版本不符 mod 报 2006**（`docs/PROTOCOL.md:190`）。
  - belt code 由 `beltCode(rv)` 生成，**不得**手填 magic number。
  - `beltIntent[]`：与蓝图逐格对应的意图表 `{x,y,inDir,outDir,rotation,rotationVariant,code}`——**这是给 P7 做「落盘 vs 设计」对拍的唯一凭据**（redteam:155）。
  - `blueprintCost(n)` 预估并上报（`src/shared/blueprint.mjs:98-101`），配合 `charge:false` 的口径声明（§6 R4）。
  - **originalRotation 缺口处置（决策 D2）**：**不改** `blueprint.mjs`（stride=4，`src/shared/blueprint.mjs:44-53`；mod 侧 `shapez-ai-bridge.js:814` 把同一个值同时当 rotation 与 originalRotation）。规避 = P5 的 `V3` 强制保证「每条带子的 (r,rv) 就是含机器邻居下的 computeBelt 不动点」→ orig 重算不会改变它，缺口被绕过。**P6 必须在 `research/ai-plan/emitter/NOTES.md` 把 stride=5 的治本方案写成 mod/shared 缺口报告交给主 Agent，不自己动手**（红队 #3a、ADVERSARIAL:61-71）。
- **验收**（L1 门）：`node src/ai/compiler/roundtrip.mjs --test`：`emit → decodeBlueprint` 回推，逐格断言 `(code,dx,dy,rot)` 与 `beltIntent` 全等、`entities.length*4 === e.length`、belt 格 `code === 1+rv`、bbox 与 P3 的 `LayoutReport.bbox` 一致；把蓝图塞进 `summarizeBlueprint` 输出可读摘要（`src/shared/blueprint.mjs:73-93`）。

### 1.7 P7 `live` —— 实机验证包（**唯一**允许碰游戏/桥接的包）

- **拥有**：`research/ai-plan/live/**`（脚本、`results/*.json`、`LIVE-LOG.md`、`MOD-GAPS.md`）
- **依赖**：P1-P6 的产物；**读** `research/ai-plan/harness/out/*.szbp.txt`（P8 写）；**只写自己目录**
- **内容**：红队 #5 的三级最小实验（redteam:177-184），每级只引入一个新变量，全程远离工厂区 + `snapshot_save`：
  1. `exp-paste-l1.mjs`：离线合成「矿机→直带→hub 侧口」**蓝图**，`paste_blueprint`（`docs/PROTOCOL.md:131`）落地 → `await hub_delivered_increased`（:135）。**只换 place→paste 这一个变量**（`exp-e2e.mjs:175-194` 走的是 place 通道，paste 从未端到端交付过）。
  2. `exp-paste-corner.mjs`：加**一个拐角**（从顶/底口改为先横移再进侧口）。判据：拐角 `code` 粘贴后保持蓝图值（直接打 redteam #1/#3a）。
  3. `exp-paste-machine.mjs`：`2×miner→belt→stacker→hub`，含机器 acceptor 邻居 + 拐角 + 交付。判据：读回每根带子 `(r,rv)` 与 `beltIntent` **逐格 diff**（redteam needs_live_test #2）。
  - 每级都要跑破坏性回归：paste 前 `bulk_delete{region,dry_run:true}` 核对清单（`docs/PROTOCOL.md:121`，事故 `facts/INCIDENT-bulk-delete.md`），paste 后 `obs` + `snapshot_save`，清理后逐 uid 对拍基线（M4 系列口径：2805/2805/extra 0）。
  - **`MOD-GAPS.md`**：发现的 mod/bridge/shared 缺陷只登记不改（`blueprint.mjs` stride=4、`place` 不查解锁、无 `paste dry_run`、`place_path` 不返 uids、`BeltComponent.direction` 不可读、wire 无 immutable 豁免、`step` 在升级弹窗下抛 2002）。
- **验收**（L2 + L3 门）：三级实验各出 `results/*.json`，字段含 `{pass, seed, paste_anchor, intent_diff:[], delivered_before, delivered_after, world_baseline_uids_equal:bool}`；`pass` 必须由**脚本自己判定**（不许文档口径盖过 result —— ADVERSARIAL:31-40 的 RV-FIX 教训：文档说 ✅、`exp-rv-fix.result.json` 里 `pass:false`、清理后 2807≠2805）。

### 1.8 P8 `harness` —— goal → 产线闭环编排（顶层入口）

- **拥有**：`src/ai/compiler/compile.mjs`、`src/ai/compiler/cli.mjs`、`research/ai-plan/harness/**`（含 `out/` 交接区）
- **依赖**：P1-P6（串起来）；与 P7 的接口 = **文件交接**（P8 写 `harness/out/<goal>.szbp.txt` + `intent.json` + `validator.json`；P7 只读这些、把结果写进 `live/results/`；P8 只读 `live/results/`）→ 两包写区不重叠，可并行。
- **内容**：`goal → solver（`proto/solver.mjs:218-231 buildPlan().steps`，字段 `{hash,op,args,depth}`）→ 选矿位（P2 world）→ P3 place → P4 route → P5 validate → P6 emit → 交接 P7 → 读回判定`。CLI：`node src/ai/compiler/cli.mjs --goal "----CuCu" --seed 43391 [--site x,y] [--json]`。solver 的 op 名与编译器 op 名映射表在 P8 内（`cut/rotate/paint/mix/stack/cutQuad/mine`）。
- **验收**（L3 门）：见 §5 阶梯 L3：在**新档**（`new_game regularMode`，`docs/PROTOCOL.md:139`）跑 level-2 目标 `----CuCu` 从 goal 到 `hub_delivered_increased` 的 `delivered` 增加，全程无人工坐标输入。

### 1.9 依赖图

```
P1 contract ──┬── P2 data ──┬── P3 placer ──┐
              │             └── P4 router ──┤
              │                             ├── P5 validator ── P6 emitter ── P8 harness ──(文件交接)── P7 live
              └── (P0-spec machine-spec 由 P2 适配消费)                                        ▲
P0-redteam / P0-verify / P0-prior：只读输入，判据分别注入 P5 / P4·P5 / P4                    └── 结果 JSON 回读
```

**并行度**：P1 落地后，P2 就绪即可同时开 **P3、P4、P5（写判据部分）、P7（写实验脚手架 + 跑三级实验）、P8（写编排与 CLI 骨架）** 五条线；P6 最后接（要 P4+P5 的输出类型，但类型定义在 P1，所以 P6 也可与 P3/P4 并行开工，只是 golden fixture 要等）。
**关键路径**：P1 → P2 → (P3 ∥ P4) → P5 → P6 → P8 → P7(L3)。P1 与 P2 必须由主 Agent 优先催成，其余包等它们。

---

## 2. 接口契约

> 全部定义在 `src/ai/compiler/types.mjs`（P1 独占写），JSDoc `@typedef` + 运行时 `assert*()` 校验器。
> 零依赖铁律：只有 ESM + `node:` 内置；**不得**引入 typescript/zod/npm 任何东西。
> 方向一律用字符串 `"top"|"right"|"bottom"|"left"`（y 向下，`src/ai/belt-rules.mjs:16-18`），角度一律 0/90/180/270。

### 2.1 `CompiledPlan`（编译器总产物，P6 发射、P5 校验、P7 落地）

```js
/** @typedef {{
 *   ok: boolean,
 *   goal: string,                        // 目标 shapez shortKey，如 "----CuCu"（shape-ops.parse 可解）
 *   reason: string|null,                 // !ok 时必填，取自固定枚举 §2.5
 *   failingNode: {nodeId:string, cell:[number,number], check:string}|null,
 *   hint: string|null,                   // 给 LLM/人读的修复建议
 *   site: {anchor:[number,number], hub:[number,number]|null},
 *   blueprint: string|null,              // "SZBP1." + LZString URI-safe；P6 产出
 *   entities: Array<{code:number, dx:number, dy:number, rot:number,
 *                    nodeId:string,             // 回指 DAG 节点，失败归因用
 *                    kind:"miner"|"belt"|"cutter"|"rotater"|"painter"|"stacker"|"mixer"|"trash"|"hub",
 *                    rotationVariant:number,
 *                    inDir:DirName|null, outDir:DirName|null}>,   // ← beltIntent（P7 对拍的凭据）
 *   layout: LayoutReport,
 *   validation: ValidatorReport,
 *   stats: { machines:Record<string,number>, beltTiles:number, trash:number,
 *            bbox:[number,number], corners:number,
 *            estThroughputPerSec:number, bottleneck:string|null,   // 如 "stacker@0.25"
 *            blueprintCost:number,          // shared/blueprint.mjs:98 blueprintCost(n)
 *            chargeMode:"false"|"auto" },  // §6 R4 口径声明
 *   scope: { layers:1, wires:false, tunnels:false, rotatedMachines:false, maxFanIn:2 },
 * }} CompiledPlan */
```

**硬规定**
- `ok:true` ⟺ `validation.errors.length === 0` **且** `blueprint !== null`。任何 error 都必须让 `ok:false` 且 `blueprint:null`（**绝不产出会堵死的蓝图**，redteam:158）。
- `entities[]` 顺序 = 蓝图内顺序 = **P3 先机器 → P4 再直线 → 最后拐角**（陷阱表 #6，`MILESTONE-M4-partial-and-pitfalls.md:66`；`proto/layout-merge.mjs:96-127` 已按此分层）。`place_path` 降级路径必须沿用这个顺序，`entities` 顺序即执行顺序。
- `entities[i].dx/dy` 相对**落点 `site.anchor`**：世界坐标 = `site.anchor + [dx,dy]`（主线程裁决 C-1：P7 的 kit/pasteAndDiff、mod 的 `opExportBlueprint` 都是这个口径）。发射时 `w` 归一为世界 min corner（`blueprint.mjs:64`）——`w` 是元数据锚点，`dx/dy` 仍以 anchor 为准，二者可不同、实体集相同（P6 已实现并测平移不变性）。P7 拿 `anchor` 作 `paste_blueprint{x,y}`。
<!-- 勘误 C-1（06:19 主线程，P6 CONTEST + P8 裁决）：原句同时写了"相对 w"与"世界=anchor+[dx,dy]"两口径，仅当 anchor===w 时兼容。现统一为 anchor 口径，w 归一 min corner。 -->
- `scope` 是**契约的一部分**：v1 只承诺单层/无 wire/无隧道/不旋转机器/入度≤2（redteam:160-164）。超出必须 `ok:false`，不许静默近似。
- `stats.chargeMode` 必须显式写出（当前用 `charge:false`，属 god-mode 口径，§6 R4）。

### 2.2 `MachineSpec` / `OpTemplate`（P2 拥有归一形式；P0-spec 拥有原始 JSON）

P2 是**唯一**读 `src/ai/machine-spec.json` 字段名的地方。归一后的 `OpTemplate`：

```js
/** @typedef {{
 *   op: "mine"|"cut"|"cutQuad"|"rotate"|"rotateCCW"|"rotate180"|"paint"|"paintMirrored"|"mix"|"stack",
 *   building: string,            // "cutter"
 *   variant: string,             // "default"|"quad"|"ccw"|"rotate180"|"mirrored"|"double"|"quad"
 *   code: number,                // 实机码，见下表
 *   unlockLevel: number|null,    // mine/cut=1, rotate=4, paint=6, mix=8, stack=10（solver.mjs:8 引 human-strategies §2.2）；
 *                                //   若 machine-spec.json 没这个字段 → P2 用上面常量兜底，并登记为 spec 缺口
 *   footprint: [number, number], // 只在 rot=0 定义：[w,h]，miner/belt/rotater/trash=[1,1]，cutter/stacker/painter/mixer=[2,1]
 *   inputs:  Array<{cell:[number,number], dir:DirName, role:"primary"|"secondary"|"shape"|"color"|"lower"|"upper"}>,
 *   outputs: Array<{cell:[number,number], dir:DirName, role:"left"|"right"|"quad0".."quad3"|"out"|"discard"}>,
 *   ratePerSec: number,          // GEOMETRY-TABLE 表2：belt2.0 miner0.4 rotater2.0 cutter0.5 stacker0.25 painter0.33 mixer0.4
 *   mustDiscardUnused: boolean,  // true：未被接走的输出槽必须自动接 trash（陷阱表 #7）
 *   verifiedOnLive: boolean      // 承 GEOMETRY 表1 的 ✅/⬜：rotater/mixer/quad/mirrored/hub = false
 * }} OpTemplate */
```

**已确证的 code 表**（`facts/building-codes-live.json`，实机提取）：belt=1(+rv→1/2/3)、miner default=7、miner chainable=8、cutter=9、cutter-quad=10、rotater=11、rotater-ccw=12、rotater-180=13、mixer=15、stacker=14、painter=16、painter-mirrored=17、painter-double=18、painter-quad=19、trash=20。该文件**只给各建筑的 default rv**（每条 `rotation_variant:0`，rv=1/2 只有 belt 有意义）→ **code 的 rv 位由 P2 用公式推导**（见下），不许假设它可从该文件直读。

**迁移路径（关键：不抢 P0-spec 的文件，也不被它的 schema 卡住）**
1. P2 先落地一张**自带的最小内嵌表**（就是上表 + GEOMETRY 表1 的槽位，硬编码在 `op-templates.mjs` 内），使 P2/P3/P4 不等 P0-spec。
2. `loadMachineSpec()` 是可选增强：若 `src/ai/machine-spec.json` 存在且 schema 可识别 → 用**它的值覆盖**内嵌表，并在 `research/ai-plan/data/NOTES.md` 逐字段记录差异（谁对谁错、为什么）；若字段名不同 → 在 `op-templates.mjs` 顶部一个 `SPEC_FIELD_ALIASES` 常量里做映射（改动集中一处）；若 schema 完全无法识别 → **保留内嵌表 + 记 gap**，绝不要求 P0-spec 改文件、绝不 fork `machine-spec.json`。
3. **belt 族的 code 唯一权威 = `beltCode(rv) = 1 + rv`**（`src/ai/belt-rules.mjs:55-56`，1906/1906 验证），machine-spec 若给出不同的 belt code 一律以 `belt-rules.mjs` 为准并登记冲突。
4. **非 belt 建筑的 rv 位**（cutter/painter/rotater/stacker 等建筑自身带 rotationVariant，例如 quad cutter 的多切形态、mirrored painter）在实机码里怎么编码，**当前无任何证据**（`building-codes-live.json` 全是 rv=0）。P2 必须把「非 belt 只用 rv=0、朝向一律 r=0」写死为硬断言，并在 NOTES.md 记为**开放缺口**交主 Agent；v1 编译器**绝不产出 rv≠0 的非 belt 机器**。
5. `summarizeBlueprint` 不解 code→名字（`src/shared/blueprint.mjs:9-13` 明写由 mod 注册表负责），所以 P6 的自检必须**自己用 `OP_TEMPLATES` 反查 code**，不能依赖游戏侧。

### 2.3 `LayoutReport`（P3 产出，P4 消费，P5 复核）

```js
/** @typedef {{
 *   grid: string,                       // 字符网格渲染（. M C R S T ^ v < > + 角），人读，逐字节可 diff（测试用）
 *   rows: Array<{level:number, y:number, nodeIds:string[]}>,   // 行式布局的层（DESIGN:64-67）
 *   placements: Array<{nodeId:string, op:string, kind:string, cell:[number,number],
 *                      rot:0|90|180|270, footprint:[number,number]}>,
 *   channels: Array<{from:{nodeId:string, cell:[number,number], slot:DirName, outDir:DirName},
 *                    to:  {nodeId:string, cell:[number,number], slot:DirName, inDir:DirName},
 *                    lane:number|null,   // 车道序号（不同分支必须不同行，陷阱表 #5）
 *                    laneAxis:"row"|"col"|null, // ← v2 新增：lane 是行号还是列号（缺省按 "row" 读旧报告）
 *                    payload:string}>,   // 该通道承载的 shape shortKey（吞吐/形状验证用）
 *   lanes: Array<{row:number|null, column:number|null, channelIds:string[]}>,  // 同轨冲突检测的凭据
   // ↑ 裁决（LANE_SCHEMA_VERSION 2，本轮）：**恰一个** of row/column 非 null。
   //   为什么不能只有 row：vlane（两端都水平出/进的通道，如 painter → hub）需要**列**车道。
   //   为什么不能用「一个整数 + axis」：row=3 与 column=3 是两条正交车道，同意会让
   //   「同一轨只能挂一条车道」的判重把跨轴同号误判成冲突。判重键因此是 (轴, 下标)。
   //   向后兼容：v1 报告（只有 row）永远合法。
 *   hubConnection: {entry:[number,number], side:"top"|"right"|"bottom"|"left", dir:0|90|180|270}|null,
   // ↑ 裁决（P5 CONTEST F2，主线程 06:19）：entry = **带子末格**（hub 外的送带最后格，
   //   即 hubEntriesWorld().cell），side = 贴的 hub 边（face），dir = 带子流向角。
   //   与 P3 N-1③ / P7 kit 三方合流。hub 槽格 = add(entry, ANGLE_DIR[dir])。
 *   bbox: [number, number],
 *   occupancy: Array<{cell:[number,number], state:"solid"|"replaceable"}>,  // 来自 obs 的既有世界（§2.6）
 *   conflicts: Array<{kind:"cell-occupied"|"lane-column"|"crossing"|"no-turn"|"hub-contention",
 *                     cells:[number,number][], nodeIds:string[], resolvedBy:string|null}>,
 *   cornerCount: number                   // 第一原则的度量：越少越好（GRID-LAYOUT:41-62）
 * }} LayoutReport */
```

**决策 D1（写死在契约里）**：v1 `placements[*].rot` 对**加工机器恒为 0**。理由：GEOMETRY-TABLE 表1 的槽位只在 r=0 定义，而 `static_map_entity.js:127-141` 在 rot=90/180/270 时 origin 会位移（redteam:143），实机未验证；旋转需求一律通过 belt 拐弯实现（`solveTurn` 已足够）。这条同时消除 `V1-occupancy` 的旋转包围盒复杂度。

### 2.4 `ValidatorReport`（P5 产出；`ok:false` 时 `CompiledPlan.reason` 取自它）

```js
/** @typedef {{
 *   pass: boolean,                       // == errors.length===0
 *   checks: Array<{
 *     id: "V1-occupancy"|"V2-no-overwrite-existing-belt"|"V3-belt-fixed-point"|
 *         "V4-slot-alignment"|"V5-degree"|"V6-crossing"|"V7-throughput"|"V8-scope"|
 *         "V9-unused-outlet"|"V10-unlock-report"|"S1-shape-replay",
 *     status: "pass"|"fail"|"not-applicable",
 *     evidence: {cell:[number,number]|null, nodeId:string|null,
 *                expected:string|null, actual:string|null, note:string}
 *   }>,
 *   errors: Array<{check:string, severity:"fatal"|"warn", nodeId:string, cell:[number,number]|null, message:string}>,
 *   beltSim: {tilesChecked:number, fixedPoints:number, drift:Array<{cell:[number,number], wantRv:number, gotRv:number}>,
 *             includesMachineNeighbors: true},   // ← 必须为 true：现成脚本只喂带子（redteam:144）
 *   shapeReplay: Array<{nodeId:string, expectedHash:string, actualHash:string, equal:boolean}>,
 *   throughput: {demandPerSec:number, bottleneck:{nodeId:string, ratePerSec:number}, rowsRequired:number, rowsPlanned:number}
 * }} ValidatorReport */
```

- `V3` 是**唯一能防住 rv 漂移**的检查（`src/ai/belt-rules.mjs:8-10`：邻居含机器的角落是漂移源；现成 `proto/validate-belt-rules.mjs:126-136` 只喂带子）。判据与 P0-verify 的邻居拓扑判据**双实现交叉对拍**（同 fixture、两份代码、0 差异）。
- `V2` 是防「毁掉 6 条真实带」的闸（redteam:102-112：`belt.getIsReplaceable()=true`，`logic.js:139-165` 的 `freeEntityAreaBeforeBuild` 会删可替换实体，且 `applied/failed` 不报告被删了什么）。P5 只做「规划区 vs 既有 replaceable 带」零重叠判定；**破坏半径检测最终要 `paste dry_run`（mod 缺口，见 §3）**。
- `S1-shape-replay` = DESIGN:93 的 Level-1：用 `proto/shape-ops.mjs`（只 import 不改）重放每个节点，hash 必须相等。

### 2.5 `reason` 枚举（P8 与 LLM 修复层的分诊依据）

`"dag-not-placeable:crossing-needs-tunnel"` ｜ `"dag-not-placeable:fanin>2"` ｜ `"dag-not-placeable:column-conflict-unresolved"` ｜ `"out-of-scope:multilayer"` ｜ `"out-of-scope:wire"` ｜ `"out-of-scope:tunnel"` ｜ `"out-of-scope:rotated-machine"` ｜ `"no-resource-in-range"` ｜ `"no-site-large-enough"` ｜ `"throughput:stacker-bottleneck"` ｜ `"belt-turn-unsolvable"` ｜ `"unlock:machine-not-available"` ｜ `"validate:<Vn>"` ｜ `"emit:mismatch"` ｜ `"live:paste-rejected-2002"` ｜ `"live:await-timeout"` ｜ `"live:intent-diff"`
（`review/ADVERSARIAL-REVIEW.md:91` 的裁决：L2 输出的不是"只有 paste"，而是**布局 IR + 落地策略**，所以失败语义必须先定死，本枚举即 P8 的分诊表。）

### 2.6 既有世界输入 `WorldState`（obs 的归一化，P1 定义、P8 采集、P3/P5 消费）

```js
/** @typedef {{
 *   tick:number, seed:number|null, hub:{x:number,y:number}|null,
 *   goal:{level:number, shape:string, required:number, delivered:number},
 *   upgradeLevels:Record<"belt"|"miner"|"processors"|"painting",number>,
 *   entities: Array<{uid:number, type:string, x:number, y:number, r:number,
 *                    variant:string, rotationVariant:number, code:number, layer:string}>,
 *   resources: Array<[number,number,string]>,
 *   replaceableBeltCells: Set<string>    // "x,y" —— type==="belt" 的格，paste 会静默替换它们
 * }} WorldState */
```
字段来源 = `docs/PROTOCOL.md:71-108`（obs 结构）+ `src/mod/shapez-ai-bridge.js:441-456`（`entityToObs` 回报 `uid/type/x/y/r/variant/rotation_variant/code/layer`）。注意 obs **已有** `rotation_variant` 与 `code`，而 `BeltComponent.direction` 不可读（redteam needs_live_test #6）—— P5/P7 一律用 `code↔rv↔(r,rv)→exit` 间接推流向，不假设能直读 direction。

### 2.7 金样例（P1 必须把这三个文件写进 `research/ai-plan/fixtures/`，其余包只读）

`fixtures/plan-l1.json` —— 最小的 `ok:true` 计划（`----CuCu`：2 矿机 + 1 cutter + 收集带；**全竖直线、零拐角**，对齐 `MILESTONE-GRID-LAYOUT-verified.md:44-53`；数值是形状示意，P6 发射时以 `beltCode(rv)` 与 `OP_TEMPLATES.code` 为准）：

```jsonc
{ "ok": true, "goal": "----CuCu", "reason": null, "failingNode": null, "hint": null,
  "site": { "anchor": [1200, -1400], "hub": [1196, -1386] },
  "blueprint": "SZBP1.<lz>",
  "entities": [
    { "code": 7,  "dx": 0, "dy": 11, "rot": 0, "nodeId": "n0", "instanceIdx": 0, "kind": "miner",
      "rotationVariant": 0, "inDir": null,     "outDir": "top" },
    { "code": 1,  "dx": 0, "dy": 10, "rot": 0, "nodeId": "e1", "instanceIdx": 0, "kind": "belt",
      "rotationVariant": 0, "inDir": "bottom", "outDir": "top" },
    { "code": 9,  "dx": 0, "dy": 8,  "rot": 0, "nodeId": "n1", "instanceIdx": 0, "kind": "cutter",
      "rotationVariant": 0, "inDir": "bottom", "outDir": "top" },
    { "code": 20, "dx": 0, "dy": 5,  "rot": 0, "nodeId": "d1", "instanceIdx": 0, "kind": "trash",
      "rotationVariant": 0, "inDir": "bottom", "outDir": null }
  ],
  "layout": { "grid": "…（字符网格，见 fixtures/plan-l1.grid.txt）", "cornerCount": 0, "bbox": [3, 12], "…": "见 §2.3" },
  "validation": { "pass": true, "errors": [], "beltSim": { "tilesChecked": 9, "fixedPoints": 9, "drift": [], "includesMachineNeighbors": true } },
  "stats": { "machines": { "miner": 1, "cutter": 1, "trash": 1 }, "beltTiles": 4, "trash": 1,
             "bbox": [3, 12], "corners": 0, "estThroughputPerSec": 0.4, "bottleneck": "miner@0.4",
             "blueprintCost": 20, "chargeMode": "false" },
  "scope": { "layers": 1, "wires": false, "tunnels": false, "rotatedMachines": false, "maxFanIn": 2 } }
```

`fixtures/report-layout.json` —— 双分支汇合（唯一会产生拐角 + 车道的形态，P4 用它验 `solveTurn` 落地；拐角格 `inDir/outDir` 必须垂直，`MILESTONE-M4-SUCCESS.md:18-21` 的 `(147,93) r=0 rv=1 code=2` / `(138,93) r=270 rv=2 code=3` 是实机确认过的**期望值来源**）。

`fixtures/report-validator.json` —— 一张**故意错**的 plan 的 `ValidatorReport`：`V9-unused-outlet` fail（cutter 左列没接走）+ `V2` fail（规划区压住既有带子）+ `V3` 报 1 格 `drift`。P5 的变异测试以它为 golden，P8 的分诊表以它的 `check` 名对齐 §2.5。

> 三个 fixture 必须同时被 `types.mjs` 的 `assert*()` 与 P6 的 `roundtrip.mjs` 读通（`summarizeBlueprint` 不抛），这样「契约可解码」在 L0 就被锁住。

---

## 3. 文件所有权矩阵

| 包 | **可写**（独占） | 只读依赖 | import 谁 |
|---|---|---|---|
| P1 contract | `src/ai/compiler/types.mjs`、`src/ai/compiler/grid.mjs`、`src/ai/compiler/errors.mjs`、`research/ai-plan/contract/**`、`research/ai-plan/fixtures/**` | `src/ai/belt-rules.mjs` | 无（叶子） |
| P2 data | `src/ai/op-templates.mjs`、`src/ai/world.mjs`、`research/ai-plan/data/**` | `src/ai/machine-spec.json`(P0-spec)、`facts/GEOMETRY-TABLE.md`、`facts/building-codes-live.json`、`research/ai-player/proto/gen-resources.mjs`、`research/ai-player/exp-e2e.mjs`(搬 chunk 算法) | P1 |
| P3 placer | `src/ai/compiler/place.mjs`、`research/ai-plan/placer/**` | `proto/layout-grid.mjs`、`proto/layout-merge.mjs`、`designs/layout-compiler-DESIGN.md`、`exp-e2e.mjs:93-102`(hubEntries 搬进自己文件) | P1、P2 |
| P4 router | `src/ai/compiler/route.mjs`、`src/ai/compiler/lane.mjs`、`research/ai-plan/router/**` | `routing-prior-art.md`(P0-prior)、`MILESTONE-M4-partial-and-pitfalls.md` | P1、P2、`src/ai/belt-rules.mjs` |
| P5 validator | `src/ai/compiler/validate.mjs`、`src/ai/compiler/belt-sim.mjs`、`research/ai-plan/validator/**` | `redteam-compiler-assumptions.md:141-150`、`verify-belt-rules.md`(P0-verify)、`proto/shape-ops.mjs`、`proto/validate-belt-rules.mjs` | P1、P2、P3、P4、`src/ai/belt-rules.mjs` |
| P6 emitter | `src/ai/compiler/emit.mjs`、`src/ai/compiler/roundtrip.mjs`、`research/ai-plan/emitter/**` | `src/shared/blueprint.mjs`、`src/shared/lz-string.cjs` | P1、P2、P4、P5、`src/shared/blueprint.mjs` |
| P7 live | `research/ai-plan/live/**`（含 `results/*.json`、`LIVE-LOG.md`、`MOD-GAPS.md`） | `harness/out/*`(P8 写)、`docs/PROTOCOL.md` | **无 import**（自带 rpc 客户端，模式照 `exp-e2e.mjs:21-29`）；**独占游戏进程 + 桥接 `127.0.0.1:7777`** |
| P8 harness | `src/ai/compiler/compile.mjs`、`src/ai/compiler/cli.mjs`、`research/ai-plan/harness/**`（`out/` 是与 P7 的唯一交接区） | `proto/solver.mjs`、`facts/live/*.json` | P1、P2、P3、P4、P5、P6 |
| P0-spec | `src/ai/machine-spec.json`、`src/ai/machine-spec.md` | — | 无 |
| P0-redteam | `research/ai-player/redteam-compiler-assumptions.md` | 全仓 | 无 |
| P0-verify | `src/ai/belt-rules.test.mjs`、`research/ai-player/verify-belt-rules.md` | `src/ai/belt-rules.mjs`、存档 | `src/ai/belt-rules.mjs` |
| P0-prior | `research/ai-player/routing-prior-art.md` | — | 无 |

**禁改清单（任何人，包括 P7）**
- `src/ai/belt-rules.mjs` —— 已 1906/1906 + 链闭合双验（commit 01af847），编译器**只 import**。
- `src/shared/blueprint.mjs`、`src/shared/lz-string.cjs` —— SZBP1 容器层；stride=5（存 `originalRotation`）是**提议给主 Agent 的缺口**（ADVERSARIAL C3、redteam #3a），不是并行包的任务。
- `src/mod/*`（`shapez-ai-bridge.js`）—— 含 `paste` 的 `performImmutableOperation`（:1576-1577，commit a35a481）。缺 `paste dry_run`、不查解锁、`place_path` 不返 uids → 一律进 `research/ai-plan/live/MOD-GAPS.md`。
- `src/bridge/*`、`src/mcp/*`、`docs/PROTOCOL.md`、`test/**`、`research/ai-player/proto/**`（`solver.mjs`/`shape-ops.mjs`/`gen-resources.mjs` 只 import 或跑 CLI，不改；`proto/belt-rules.mjs` 是**已知错误副本**，见下）。
- `research/ai-player/**` 下的既有 `exp-*.mjs`、`facts/*`、`review/*`、`designs/*` —— 除各包自己的可写路径外一律只读。
- **不得新建 `src/ai/*.mjs`（根层）**，除 P2 的两个 `src/ai/op-templates.mjs`/`src/ai/world.mjs`；其余全在 `src/ai/compiler/`。

**已知陷阱（必须写进每个包的 prompt）**：仓库里有**两份** `belt-rules.mjs`。
- ✅ 权威：`src/ai/belt-rules.mjs`（`beltEntry(rv,rot)=rotateLocal("bottom",rot)`，:35）
- ❌ 错误：`research/ai-player/proto/belt-rules.mjs:49`（`beltEntry=OPP[beltExit]`，弯带入口判反 → 整条 L 形 rv 全错、物流死在第一个拐角；redteam #1(2)）
**所有编译器包只许 `import ... from "src/ai/belt-rules.mjs"`**，P1 的 lint 断言负责把关（§1.1 验收 3）。删/改 proto 那份不是并行包的任务（它被 `validate-belt-rules.mjs` 引用），交主 Agent 决定。

**冲突仲裁规则**：若两个包都需要同一份新逻辑（例如方向旋转工具、`cellKey`、`hubEntries`），**只有 P1 可以把它放进 `types.mjs`/`grid.mjs`**；其它包要么等 P1 版本，要么在自己文件里内联复制，**绝不去改别人的文件**。发现别人有 bug → 写进 `research/ai-plan/<自己>/NOTES.md` 并在汇报里点名，不改对方代码。

## 4. 活资源约定（游戏 / 桥接是单点资源）

1. **唯一属主 = P7**。游戏进程、mod 内的 `shapez` 对象、HTTP 桥接 `POST /rpc @ 127.0.0.1:7777`（`docs/PROTOCOL.md:223-230`）、WebSocket `/client`、`%APPDATA%/shapez.io/saves/*`、`snapshots/*` —— **全部只允许 P7 触碰**。
2. **其它所有包 100% 离线**：输入只有 (a) seed + `node research/ai-player/proto/gen-resources.mjs` 的资源 JSON；(b) `research/ai-player/facts/live/` 里已 dump 的存档解码结果；(c) 自己目录内的 fixture。**不许**在任何单测里 `fetch`/开 socket/起游戏/`save_now`。
3. **为什么必须这样**：桥接只有一条 mod 连接（`docs/PROTOCOL.md:196`：断线 3s 重连、同 game_version 的重复 hello 直接**替换**旧连接）。两个 Agent 同时驱动游戏 = 互相覆盖 world state + 同时 `step`/`await` 的时序不可复现 + `bulk_delete` 误删彼此实验体（事故 `facts/INCIDENT-bulk-delete.md`：曾一次误删 42 个真实工厂实体；红队 #3b：一次粘贴可覆盖几十格且**静默毁带不报告**）。
4. **P7 的自纪律**（写进它的 prompt）：每次实验前 `snapshot_save`，实验后 `bulk_delete{dry_run:true}` → 核对 → 真删 → **逐 uid 对拍基线**（M4 系列口径 `2805/2805/extra 0/missing 0`）；实验区一律远离工厂（2000+ 格外，`offline-map-EXPERIMENTS.md` H3/H6 已证盲建可用）；**独占期结束前不许别人排队**——P8 若需要提前跑 L3，向主 Agent 申请时间片，不自己连桥接。
5. **`await` 的隐藏前提**（ADVERSARIAL C11，`bridge:1417-1421`）：`hub_delivered_increased` 只在**当前 goal 就是产出形状**时才 met。所以 L3 必须用**新档 + 该目标关卡**（`new_game{game_mode:"regularMode"}`），不能拿 level-11 档验 `----CuCu` 的交付计数；用 `hub.stored_shapes[key]` 增量是替代判据（`exp-e2e.mjs:208`）。
6. **交接协议（P8 ⇄ P7，文件而非 socket）**
   ```
   research/ai-plan/harness/out/<goal>.szbp.txt      P8 写：SZBP1 字符串
   research/ai-plan/harness/out/<goal>.intent.json   P8 写：CompiledPlan.entities（beltIntent）+ site.anchor + hub + chargeMode
   research/ai-plan/harness/out/<goal>.validator.json P8 写：ValidatorReport（必须 pass 才有 out 文件）
   research/ai-plan/live/results/<goal>.<level>.json P7 写：见 §1.7 验收字段（含 intent_diff、delivered_before/after）
   ```
   P7 读 `out/*`、写 `results/*`；**P8 不写 `live/`，P7 不写 `harness/`**。
7. **只读模式**：桥接可配 `read_only:true`（`docs/PROTOCOL.md:198/244`）拦掉全部写 op。P7 需要写；若用户此刻开着只读，P7 必须先报告、不擅自改 `bridge.config.json`。

---

## 5. 验收阶梯（每级一个门，前一级不过不许进下一级）

| 门 | 谁负责 | 怎么测（具体命令/判据） | 通过标准 |
|---|---|---|---|
| **L0 离线单测** | P1-P8 各自 | `node src/ai/compiler/<file>.mjs --test`（沿 README:213-215 的 `node <file>` 约定，无框架）；P1 另跑 import-lint | 退出码 0；P3/P4 的金网格逐字节相等；P5 变异测试每次只报对应 check id；**零游戏、零网络** |
| **L1 蓝图自检（离线回推）** | P6 | `node src/ai/compiler/roundtrip.mjs --test`：`emit → src/shared/blueprint.mjs:29 decodeBlueprint` 回推 | 逐格 `(code,dx,dy,rot)` 与 `entities` 全等；`e.length/4 === entities.length`；belt 格 `code === 1+rv`；`bbox` 与 `LayoutReport.bbox` 一致；`summarizeBlueprint` 可读；`validation.pass===true` 且 `ok===true` 同时成立 |
| **L1.5 可布性闸（仍在离线）** | P5 | `node src/ai/compiler/validate.mjs --plan <plan.json> --intent <intent.json>`（**必须带 intent**：只给 plan/layout 时 V3/V4/V6 无法判定，CLI 返回 **UNDECIDABLE + exit 2**，不是绿灯；也可直接喂 `<goal>.validator.json` 做自洽审计） | `V1..V10 + S1` 全 pass 或 not-applicable；**`beltSim.includesMachineNeighbors===true` 且 `drift.length===0`**（这条是防 rv 漂移的核心，现成脚本只喂带子） |
| **L2 实机小 paste** | **仅 P7** | 三级各一脚本：`exp-paste-l1.mjs`（直带进 hub，只换 place→paste）→ `exp-paste-corner.mjs`（加一个拐角）→ `exp-paste-machine.mjs`（加一台加工机 + 拐角）。每级：`snapshot_save` → `paste_blueprint{text,x,y,charge:false}` → `obs{region}` 读回 → **与 `intent.json` 逐格 diff** → `step N` → 清理 → 逐 uid 对拍 | 三级各自 `pass:true`（**脚本自己判定**，不是文档口径）；`(r, rotation_variant, code)` 落盘 == 设计（`diff.length===0`）；清理后世界实体 == 基线（`extra:0, missing:0`）；`delivered_after > delivered_before` |
| **L3 端到端闭环（新档）** | P8 编排 + P7 执行 | 在**新档**（`new_game{game_mode:"regularMode"}`，`docs/PROTOCOL.md:139`）跑 level-2 目标 `----CuCu`：`node src/ai/compiler/cli.mjs --goal "----CuCu" --seed <新档 seed>` → 离线出蓝图 → P7 `paste` → `await{until:"hub_delivered_increased", timeout_ticks:15000}` | 全程**无人工输入坐标**；`met===true` 且 `goal.requirement.delivered` 严格增加；离线预测矿格 == 实机 `obs.resources` 同格形状（`exp-e2e.mjs:161-164` 的交叉核对必须在）；`result.json` 落盘 |
| **L4 回归（可选，M2/M3 复刻）** | P8+P7 | 目标 `CgScScCg`（7 步链，含 painter 颜料支线 + stacker 汇合） | 同上 + `hub.stored_shapes["CgScScCg"]` 增加。**注**：此目标需 painter(L6)/stacker(L10) → 只能在新档用 god-mode 口径（§6 R4），或先交付中间形状升级 |

**L2/L3 的强制纪律**（来自事故与审查）
- 先 `bulk_delete{region,dry_run:true}` 核对 `items` 清单再真删（`docs/PROTOCOL.md:120-121`）。
- 绝不在工厂区实验；paste 落点必须与既有 `replaceableBeltCells` **零重叠**（P5 的 `V2`）。
- 每级失败必须**唯一归因**到 paste / 拐角 / 机器 三者之一（redteam:184）。
- 文档结论必须与 `results/*.json` 一致；result 里 `pass:false` 时**禁止**任何文档写 ✅（ADVERSARIAL:31-40 的 RV-FIX 教训）。

## 6. 风险清单（最可能翻车的 5 点 + 预测试方法）

| # | 风险 | 为什么最可能翻车 | 预测试（离线优先） | 兜底 |
|---|---|---|---|---|
| **R1** | **含机器邻居的带子 rv 不是不动点 → 建好了但堵死** | `src/ai/belt-rules.mjs:8-10` 自己写"漂移全在邻居含机器的角落"；现成 `validate-belt-rules.mjs:126-136` C 项只有 **82.5%** 且**邻居只喂带子**（redteam:144、138）。immutable 只屏蔽粘贴期改写（`systems/belt.js:169`，redteam verified_ok），**粘贴之后**任何邻域扰动都会按 `originalRotation` 重算 | 离线 `V3`：`belt-sim.mjs` 把机器 ejector/acceptor 喂进 `computeBelt` 逐格检不动点；与 P0-verify 双实现交叉对拍；实机 `exp-paste-machine.mjs` 读回 (r,rv) 与 intent 逐格 diff（redteam needs_live_test #2） | 非不动点 → `ok:false` 不产蓝图；或改走 `place_path`+「拐角最后放」（M3/M4 实证过的替代通道，`MILESTONE-M4-SUCCESS.md:53-56`） |
| **R2** | **`originalRotation` 丢失（SZBP1 stride=4）在增量施工时悄悄翻向拐角** | `blueprint.mjs:44-53` 不存 orig；`bridge:814` 把同一个值同时当 `rotation` 与 `originalRotation`；`systems/belt.js:160` 用 orig 重算。M4 里就有 `(138,93) r=270` 这种被自动转向过的拐角（ADVERSARIAL:61-71）。H6/exp-merge2 那种"建完就不管"看不出来，**第二次 paste 到旁边**必踩 | 离线：`V3` 若保证 (r,rv) 本身是不动点，orig 错也不会被改 → R1 的检查**顺带**覆盖 R2；实机：redteam needs_live_test #1（paste 含拐角蓝图 → 旁边 `place` 一格触发重算 → 读回拐角 code 是否变） | 只登记缺口交主 Agent（stride=5）；v1 编译器**不做增量对接旧厂**（`scope` 写死"全新址"），并在 plan 里显式 `hint:"增量施工未支持"` |
| **R3** | **粘贴静默替换既有带子 = 又一次毁厂事故** | 只有 belt/wire `getIsReplaceable()=true`；`freeEntityAreaBeforeBuild`（`logic.js:139-165`）在 immutable 内删掉可替换实体；`applied/failed` **不报告被覆盖了什么**（redteam:102-112）。曾毁 6 条真实带；一次 paste 可覆盖几十格，比 bulk_delete 更危险 | 离线 `V2`：`WorldState.replaceableBeltCells` ∩ 规划区 == ∅；实机：redteam needs_live_test #5（paste 与既有 5 格带重叠 2 格 → 断言旧 uid 消失且 `ok:true`，然后 `snapshot_load` 恢复）——**这条实验要 P7 主动做，因为它是 mod 缺陷的唯一证据** | `paste dry_run` 缺口记进 `MOD-GAPS.md`（ADVERSARIAL:209 建议第一批就加）；每次 paste 前 `obs` 该区存 uid 清单，paste 后对比，发现消失的非本次实体立刻 `snapshot_load` |
| **R4** | **解锁/成本口径未定 → 交付数字是"作弊分"，且 L12 才解锁蓝图功能** | 蓝图 L12 解锁（`levels.js:241-246`）+ 正常 paste 消耗形状（`game_mode.js:195`），我们靠 `charge:false`；`place/place_path/paste` **都不查 `getIsUnlocked`**（`logic.js:117-133`，redteam:190-200）；`solver.mjs:110` 默认开 `cutQuad` → L11 目标会用到 L16 建筑（C13） | 无需上机（口径问题）。P2 的 `unlockLevel` + P5 的 `V10-unlock-report` 自动列出"该等级不可用"的机器；P8 在 `stats.chargeMode` 与 `CompiledPlan.scope` 里显式声明 god-mode | **blocking question（redteam:233-240 第 1 条）必须主 Agent 开工前定**：定位 A（忠实玩家：`getIsUnlocked` 门控 + ≤L11 禁蓝图 + 游戏循环纳入范围）还是定位 B（god-mode：所有"通关"claim 加标注）。**本规划默认 B**（既有产物事实上已是 B），并要求 L3 用 level-2 目标（`----CuCu` 只需 cutter L1）从而**两种口径都成立** |
| **R5** | **多分支汇合 / 吞吐不可布（3+ 输入、painter 与 +y 类混串、stacker 瓶颈）** | stacker/mixer 只有 2 个 bottom（redteam:146），quad 切割后 4 路汇合**无可行模板**（ADVERSARIAL:162-164）；cutter/stacker/mixer 沿 +y、painter 沿 +x，两类不能简单串（GEOMETRY 表3 规则 3，:49-51）；stacker 0.25/s = 带的 1/8 → 一条满带要 8 台（DESIGN:32-34）；弯带有效长度 0.78 格 → **拐角不是免费的**（ADVERSARIAL:221-223，DESIGN 吞吐公式没这项） | 离线 `V5`（入度）、`V6`（交叉→隧道）、`V7`（吞吐 min 与所需行数）；P3 验收④强制「4 输入两两二叉化」金网格；拐角数计入 `LayoutReport.cornerCount` 并在 `estThroughputPerSec` 里按 0.78 折算 | 超范围 → `reason="dag-not-placeable:fanin>2"` / `":crossing-needs-tunnel"` 上报给 L3/LLM 修复层（换配方/换址），**不硬凑** |

次要但会咬人：`step` 在升级弹窗可见时抛 2002（`docs/PROTOCOL.md`/`bridge:1247-1255`，ADVERSARIAL:214-217）→ L3 第一次真升级就会踩，需要 `dismiss_overlays`（mod 缺口）；wire 无 immutable 豁免（`systems/wire.js:714-760`，redteam #2-2）→ v1 已在 `scope` 里排除 wire。

## 7. 对规划本身的自我批判

**7.1 哪些接口一定会在实现中变形**
1. **`LayoutReport.channels[]`（P3⇄P4 的边界）最可能错**。我把"通道"定义成 (from cell, outDir) → (to cell, inDir) 的端点对，但真实的汇合需要"一个 op 的输出被两条通道共享"（fan-out，hub 的多入口收集带也是），而 `stack` 需要**两条通道按 lower/upper 有序落到左/右格**（GEOMETRY:18 的槽位→层映射是实机确认过的硬事实，顺序错了产物层数就反）。这个「通道↔槽位」的多对多关系几乎肯定要加 `slotRole`/`ordinal` 字段，或干脆把 channels 改成 `edges[]{fromSlotId,toSlotId}`。**缓解**：P1 在 `channels[]` 里预留 `slotRole` 与 `ordinal`（可空）；P3/P4 第一天就为「stacker 双输入」和「收集带 fan-out」各写一条失败测试，变形会被这两条测试**提前**逼出来而不是中途静默改接口。
2. **`CompiledPlan.entities[].nodeId` 假设了"一个 op 一台机器"**。吞吐不足时编译器要**复制节点并行成多行**（DESIGN:137），一个 `nodeId` 会对应多个实例 → 需要 `nodeId + instanceIdx`。P5 的 `V7` 一跑就会撞上这条。**缓解**：现在就写成 `nodeId:string` + `instanceIdx:number`（默认 0），并在 §2.1 注明多行是 v1.1 才有；`V7` 在 v1 只允许"报不足"，不允许编译器自动复制（避免 P3/P4 范围失控）。
3. **P2 的 `OpTemplate` 与 P0-spec 的 `machine-spec.json` 是并行写的两份真值**。我给了内嵌表 + 别名映射 + "belt 以 belt-rules 为准" 三条仲裁，但**非 belt 建筑的 rv 编码无人知晓**（`building-codes-live.json` 全 rv=0），P0-spec 很可能给出我无法验证的 code 组合。§2.2 第 4 条的"硬断言只用 rv=0"是把不确定性挡住，但代价是 `cutQuad`/`mirrored painter` 之类的真实 code **可能被证明是 rv≠0**，那时 P2 的模板要重写。**缓解**：P2 的第一条验收就是对 15 条实机 code 逐个断言（§1.2），任何不一致**立刻**是硬证据，比讨论 schema 便宜得多。
4. **`WorldState`/`obs` 假设了"既有世界能一次读全"**。`max_entities` 缺省 2000、超限 `truncated:true`（`docs/PROTOCOL.md:202`），level-11 档有 2805 实体 → 必须分 region 多次读；`resources` 只含**已探索** lower layer。P8 的采集函数会需要分页与合并，这不在任何包的验收里。**缓解**：§2.6 只定义归一形式；P8 prompt 里显式要求"按 region 分块读、`truncated` 必须循环读到 false"，并把它列为 L3 前置。

**7.2 哪些包可能拆早了**
- **P4 单独成包偏早**：车道分配与列分配本质上是 P3 作图的一部分（我为了并行度把它们切开）。如果 P3 实现时发现"必须边排行边知道车道"，P3/P4 的边界就得重画。**缓解**：P1 把 `conflicts[]`（含 `lane-column`）定成 P3 可**上报**的出口，P3 能先用"加宽行距"的土办法自解、把车道需求塞进 `channels[].lane=null` 交给 P4；两条路都能跑，边界移动不影响 §2.1 总契约。
- **P8 harness 在 L3 之前无法验收**：它依赖 P7（独占活资源），而 P7 排在最后。P8 可能变成"只有一个 CLI 的空包"。**缓解**：P8 的 L0/L1 验收改成对**录制的 obs 回放**（`facts/live/*.json` 当 fixture）跑通全链，实机交接只留一个"读 `results/*.json` 汇总"的适配器；这样 P8 全程离线、可独立通过。
- **P5 依赖 P3/P4 的产物**，所以 P5 的 `--test` 要等 P3/P4 有产出——但它依赖的是 **P1 里的类型**，不是 P3 的实现。**缓解**：P5 变异测试用 P1 的 fixture 手工构造 `LayoutReport`（不 import P3），这样 P5 与 P3/P4 真并行；代价是 fixture 与真实产物可能漂移，所以要加一条 P8 的"fixture-vs-真实产物 schema diff"断言。

**7.3 我自己最不同意的地方（诚实）**
- 我沿用了 `layout-compiler-DESIGN.md` 的行式布局，但**竞品 `Songxwn/shapez-auto` 的 A\* + 螺旋候选位（ADVERSARIAL:99-102，`internal/plan/layout.go` 685 行）是更成熟的方案，也是"布局并非无人做过"的证据**。我的拆解把行式布局当成默认，可能低估了它对 painter(+x)/其他(+y) 异质方向的处理难度——DESIGN 自己的阶段 B 也只给了"加宽行距"这一招，并明说隧道是 v2（DESIGN:88）。**缓解**：`routing-prior-art.md`(P0-prior) 出来后，若 A\* 明显更合适，只需替换 P4 的内部算法（`lane.mjs`），P3⇄P4 的 `channels[]` 契约不变——这是我把接口定在"端点对"而不是"路径网格"的原因。
- L2 的 `intent-diff===0` 是**理想标准**。redteam:144 与 `belt-rules.mjs:8-10` 说明"含机器邻居"下连不动点都不是恒等，L2 更可能以 `diff` 若干格的方式失败。我把 L2 定成硬门是**故意的不现实**：真实期望是"失败也要**逐格可归因**"。所以 P7 的 result schema 里 `intent_diff` 必须是**数组而不是布尔**——失败信息比绿灯值钱。
- 我把 8 个包一次性铺开，但**关键路径其实只有 4 步**（P1→P2→P3/P4→P5/P6）。并行 5 个 Agent 的意义在 P2 落地**之后**；在那之前 P3/P4/P5 只能对着 §2 的类型空转写测试。**缓解**：主 Agent 应先只发 P1+P2 两个包（各半天），再发其余，否则会出现"三个 Agent 同时改 P1 类型"的死锁——那正是本文件必须 P1 独占写、且类型改动只能走 P1 的原因。
