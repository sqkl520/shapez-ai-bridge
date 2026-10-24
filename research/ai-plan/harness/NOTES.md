# P8 `harness` — NOTES（决策、上游阻断、缺口、待主线程裁决）

> 包属主：P8 `harness`。可写：`src/ai/compiler/compile.mjs`、`src/ai/compiler/cli.mjs`、`research/ai-plan/harness/**`。
> 未 commit、未碰桥接、未改任何上游文件；L3 实机执行是 P7 的活（本包只产 `out/` 交接件）。
> 全程离线（plan §4 第 2 条）：唯一的子进程是 `node research/ai-player/proto/solver.mjs --json`。

## 0. 交付与验收

| 文件 | 内容 |
|---|---|
| `src/ai/compiler/compile.mjs` | 顶层编排 `compilePlan()` + 8 段 stage + 交接件写出 + 自检；**永不 throw** |
| `src/ai/compiler/cli.mjs` | `--goal/--seed/--hub/--json/--out` CLI（plan §1.8 / §5 L3 的命令形态） |
| `research/ai-plan/harness/test.mjs` | L0：A 端到端 / B 确定性 / C 失败路径 / D 交接件 / E lint / F 契约 / G 永不 throw / H 单元 / I 上游证据 |
| `research/ai-plan/harness/run-all.mjs` | 全家族一条命令（13 组 ≈1873 断言 + grep lint） |
| `research/ai-plan/harness/out/` | 交接区：`<goal>.szbp.txt` + `.intent.json` + `.validator.json` |

```
node research/ai-plan/harness/test.mjs     → 336 通过 / 0 失败（~16s）
node research/ai-plan/harness/run-all.mjs  → 13/13 组绿，≈2000 条断言，全绿（~36s）
node src/ai/compiler/cli.mjs --goal "Cu----Cu" --seed 43391
```

## 1. 坐标系裁决（本包最容易踩死的一处）

**layout / entities / beltIntent 全程留在「作图局部系」**，`site.anchor` 是**世界平移量**，世界格 = `anchor + [dx,dy]`（plan §2.1）。
局部原点有**两档**（B-4 修复后，见 §2 B-4）：给了真实世界 hub ⇒ 原点 = 真 hub（`hubLocal=[0,0]`）；
未给 hub ⇒ 原点 = 设计系 `[0,0]`（hub 在 `hubDesign=[-4,-4]`，逐字节旧基线）。

这条不是我拍的，是两条上游事实夹出来的：

1. P1 的 `fixtures/plan-l1.json` 就是这个口径：`site.anchor=[1200,-1396]` 是世界坐标，而 `layout.placements[].cell=[0,5]`、
   `hubConnection.entry=[0,0]`、`occupancy` 的 hub 16 格全是**小值**（世界 − anchor）。
2. P3 在提交 `80e1444` 之后明确改了实现（commit message：「keep the layout frame site-relative, converting every world
   input at the door」）：`place()` 现在 `origin = site ?? hub ?? 0`，并把 hub / occupancy / 资源格**在摄入时**换算进同一框。

**后果（我踩过的现场）**：一开始我把 `hub` 按世界坐标给 `place()`、又按设计系灌 `WorldState` → occupancy 与机器混框，
P5 的 V4 报「(0,3) 不是 hub 的输入槽」。修法就是 §1 那条：`place()` 只给 `site={x:0,y:0}` + `hub=hubDesign` + 同框的 world；
世界平移只体现在 `provenance.worldPlacement`（P7 的 paste 点）。

### 1.0 四个 hub 概念 —— **固定说明（第四次在同一坐标系上出错后写死）**

这一处已经错过四次（P3 混框 → V4 假 fail；P8 给 emit `site.anchor=[0,0]` → P7 paste 到世界原点；P8 的 `siteStage`
从不看真实 hub → 布局压 hub 半建；B-4 的假 hub + `seed:null` → 零交付）。以后改任何一处，先读这张表：

| 名字 | 在哪 | 系 | 谁写 / 谁读 | 用途（**只有这一个**） |
|---|---|---|---|---|
| `ctx.hub` | `placeStage` / `siteStage` 的 ctx（来自 `input.hub` → `normalizeHub().world`） | **世界系**：hub 在真实地图上的 4×4 左上角 | P8 写（CLI `--hub` / L3 的 obs） | 传给 `place()` 当 `site`/`hub`（⇒ 局部原点=真 hub），并供世界系 V1 判据。`null` = 未知，走旧路径 |
| `hubLocal` | `compileInner` 的局部量；进 `placeStage`/`routeStage`/`siteStage`/`validateStage` 的 ctx | **作图局部系**：hub 左上角在 layout 坐标里的位置 | 给了 hub ⇒ `[0,0]`；未给 ⇒ `hubDesign` | 一条公式贯穿：`anchor = hubWorld − hubLocal`；P4 `hubOrigin`、P5 `hubWorldState`、P3 occupancy 都用它 ⇒ 不可能混框 |
| `ctx.hubDesign` | `normalizeHub().design`，恒 `[-4,-4]` | **设计系**：只用于**未给 hub** 的旧路径 | `placeStage` ⓑ、`siteStage` ⓑ | 金网格 / L0 确定性基线的逐字节兼容；给了 hub 后**不参与布局** |
| `HUB_CLEAR` | `place.mjs:71`（P3 的常量，当前 **3**） | **局部系**：机器簇顶行到 hub 底缘的**净空行数** | 只在 P3 的 `place()` 内部、且**只在没有 seed 时**用 | 让废料带/trash 躲开 hub 的 16 入口"正交邻接圈"（B-1 修复） |

**三者关系（一句话）**：`HUB_CLEAR` 是**局部系里的排版余量**，保证布局与 hub 不相邻；
`hubLocal` 是**hub 在布局坐标里的位置**，P3/P4/P5 靠它算 occupancy / 车道 / 槽位；
`ctx.hub` 是**世界系里 hub 的位置**，只有它能回答"贴到世界里会不会压到真 hub"。
`anchor = ctx.hub − hubLocal` 把它们钉在一起；只要这一条成立，三个系就不会各自漂。

**两个系怎么对齐（B-4 之后）**：局部原点**就是**真 hub ⇒ `hubLocal=[0,0]`、`anchor=hubWorld`。
不再有"钉死 vs 退回"的分叉：`place()` 按 `seed` 摆矿机、按真 hub 接收集带，anchor 由 hub 唯一确定。
`site.hubPinned` 现在恒 `true`（给了 hub 且 ok:true 时）—— 这是**结论**，不是**假设**：
J-3 用 `hubEntriesWorld()` 逐口对拍锁死。

**设计系自洽 ≠ 世界系自洽（历史缺陷的根）**：P5 的 `validateStage` 拿的是**局部系**的 `hubWorldState`，
在局部系里布局与 hub 天然不相交 ⇒ **V1 永远只能 pass**。处置：`compileInner` 在 P5 之后、emit 之前加
**`worldFrameHubCheck()`**（`stages.worldFrameV1`），判据与 dry_run 的 `solid collision` 同义（**逐格**，
不是包围框 —— 见 §2 B-4）；失效即 `validate:V1` 整单 fail。

## 2. 上游阻断（**本包不改上游**；这里给最小复现与归因，交主线程裁决）

### B-1【P3 · 高】cutter 的废料通道被排进 hub 底排入口行 → V3 判死（`----CuCu` / `CuCu----` / `RuRu----` 全部布不通）

**症状**：level-2 官方目标 `----CuCu` 端到端 `ok:false`，`reason=validate:V3`，`failingNode={cell:[-3,0], check:"V3-belt-fixed-point"}`，
`beltSim.drift=[{cell:[-3,0], wantRv:0, gotRv:2}]`。

**最小复现**（`_probe` 已删，下面是可复制的判据）：
```js
const steps=[{id:'n0',op:'mine',hash:'CuCuCuCu',inputs:[],depth:0,args:{}},
             {id:'n1',op:'cut', hash:'----CuCu',inputs:['CuCuCuCu'],depth:1,args:{half:'left'}}];
place({steps, site:{x:0,y:0}, hub:{x:-4,y:-4}, world:hubWorldState([-4,-4],null)})
// → placements: miner(-4,9) / cutter(-4,1) / trash(-2,0)
// → 机器簇顶行 y=1；hub 底缘 y=-1 ⇒ 顶行与 hub 之间**只隔 1 行**（y=0）
// cutter 的废料口在 (-3,1) 朝 top、trash 在 (-2,0) ⇒ 废料带落在 (-3,0) 且必须右转
// 而 (-3,0) 正下方 (-3,-1) 是 hub 的 bottom acceptor ⇒ computeBelt 看到
//   ejector(top, from cutter) + acceptor(left, from trash) + acceptor(bottom, from hub)
//   ⇒ 支①（局部下方有 ejector）优先 ⇒ 返回 rv=0 ⇒ 设计态 rv=2 不是不动点 ⇒ V3 fail
```

**为什么不是我的错**：把 `hubDesign` 换成任意值（`[-4,-4]`、`[0,-4]`、`[100,-4]`、`[-4,-40]`）相对布局**完全不变**
（`place()` 把机器簇左边缘对齐到 hub 左列、顶行固定在 hub 底缘 + 2），所以「换个 hub 位置」不是解法。
`rowGap ∈ {8..20} × colGap ∈ {3..8} × hubDesign 4 值` 共 640 组，V3 命中 **0**。
不连 hub 时（`connectHub:false`）同一布局 **V3 通过** —— 证明失败来自 hub 邻接，不是几何本身。

**归因**：`place()` 的机器簇对齐策略（`dy = hubLocal[1] + HUB_SIZE + 1 - minY`，即留 **1 行**）没有为
「cutter 废料要先横移再竖走」留出空间；废料的 2 拐角路径必然蹭到 hub 底排 acceptor 的邻域。
**建议（P3）**：把间隙从 1 行加到 ≥2 行；或废料优先走**侧向**（离开 hub 那侧）而不是竖直下探。
**本包处置**：fail-closed + 精确 reason + drift 凭据（不产蓝图、不写 out/）。

### B-2【solver · 高】颜料被折进 `paint` 的 args，painter 的 `color` 槽永远无供料

**症状**：任何上色目标（`CrCrCrCr`、`RbRb----`、`CgScScCg`…）端到端 `ok:false`，
`reason=validate:V4`、`class=solver-pigment-folded-into-paint`。

**证据链**：
- `proto/solver.mjs` 的 `buildPlan()` 只为 paint 记 **1 个 parent**（实测 `parents.length===1`）；
  solver-README 自己登记：「解里 `paint cyan` 隐含 mixer（解的呈现没显式列出 mix 步骤）【缺口：plan 输出中应插入 mix 节点】」。
- painter 模板是 **2 个输入槽**（`shape←left`、`color←top`，GEOMETRY 表1:19）；表3 规则 6：「颜料是**独立物流**：
  painter 的 color 从 top 进 → 必须为颜料留垂直通道」；M2a 实机已证两条物流都到位才上色。
- 契约里**没有颜料通道的位置**：`channels[].payload` 必须是 shapez shortKey（types.mjs:597），而游戏里颜料是
  `ColorItem` 不是 `ShapeItem`（`recon/upstream-full/src/js/game/items/color_item.js:28` `getItemType()="color"`）。
  实测：`"--------"`（空形状）是 `parse∘hash` 的**唯一**不动点；`"-r-r-r-r"` 这类「有色空位」被 hash 归一回
  `"--------"` ⇒ S1 立刻报 `expectedHash="-r-r-r-r" actualHash="--------"`。也就是说**同一张图里画不出两个不同颜料的来源**。

**本包为什么不去「补」**：任务书写死「管线对上游违约输入要 fail-closed（拒了并说明，**不静默修数据**）」。
凭空造一台采「不存在颜料」的矿机 = 静默改配方；把颜料塞进 payload = 伪造形状语义。
**缺口登记**：`G-PIGMENT` —— 治本要么 solver 显式产出 mix/颜料节点，要么 P1 给 `channels[].payload` 加
`kind:"color"`（或 P2 给 `OpTemplate` 加 `colorSource` 字段）。二者都不是 P8 的地盘。

### B-3【P3/P4 · 中】多分支汇合（两路 → stacker）route 布不通

`CgScScCg` 在颜料闸之前就会被 B-2 拦下；直接把颜料当空形状手工试（`_pigment_probe`，已删）时：
- `place()` 出的 `channels[]` 让两条分支的水平通道抢同一行（`conflicts[lane-column]`），
- `routeAll()` 对 `n2->n6` 报 `crossing-needs-tunnel`（pops>4000 或 states 遍历完都无路）。
`solver-README` 的 L11 解是 **2 mine + 2 cut + 2 paint + stack + rotate**（8 节点、两分支）；v1 行式布局对
「两支各自加工后汇入一个 stacker」这个 M4 形态在**无隧道**前提下没有可行车道。
`MILESTONE-M4-SUCCESS.md` 的成功是 `place/place_path` **手写坐标** + 拐角最后放，不是编译器产出的。
**建议（P3/P4）**：把 M4 的「只让一条分支拐弯 + 两矿不同列」策略做成 `assignRows` 的硬约束（当前 `desiredX` 只是偏好）。

### B-4【P3 · 中】`hubConnection` 硬接设计系 hub 的正上方 → 世界 hub 不在设计系位置时**接不上**

**症状（本轮 L3 实测，不是推断）**：`----CuCu` 在 seed 37447 / hub(-2,-2) 下编译、validator、`dry_run`、
`paste`、逐格对拍**全绿**（`apply=14/14`、`blocked=0`、`intent_diff=0`），但 `await hub_delivered_increased`
跑满 20000 tick 交付仍是 0。原因是收集带末端停在 `(-7,-2)`、朝上喷进 `(-7,-3)`，
而真实 hub 的左/底入口在 `(-3,-2)` 一带 —— **横差 4 列**。

**根因**：`place()` 的 hub 连接是设计系的：`hubConnection = {entry: 顶层输出槽, side:"bottom"}`，
即"终端正上方那条竖直带直插 hub 底排"。这个几何只在 `anchor + hubDesign === hub`（钉死）时成立。
`siteStage` 钉不死时（本例钉死要求矿机落在 `(-2,13)`，那里没有铜）会退回"不压 hub 的最近资源位"，
于是布局被整体平移到 `(-7,·)`，**hub 连接段就悬空了** —— 这条路 P3 从来没被要求支持。

**为什么 P5 不报**：V4 只查「带子出口落进 hub 的入口槽」，而设计系的 hub 就在 `[-4,-4]`，槽位对得上。
P5 的结论"槽位对齐"在**设计系**是真的，在**世界系**不成立 —— 与 §1.0 是同一类错位。

**建议（P3）**：让 hubConnection 支持四个面（`hubEntriesWorld` 已经有 16 入口的表），
或在 P4 加"终端 → hub 侧面入口"的折线；本包侧只能做到"钉死优先 + 钉不死如实报"。
**本包处置**：`site.hubPinned=false` + `provenance.hubInferred ≠ site.hub` 两处都写出来，
P7/主线程能一眼看到缺口；不伪造"接上了"。

### B-4 已修复（2026-10，跨包收尾；方案 (a)，不是降级）

**现场（修前 `l3-run`）**：
```
[3] ok=true ents=14 vpass=true bp=121 corners=0
[4] dry_run apply=14/14 blocked=0 delete=0
[5] paste applied=14 failed=0
[6] 逐格对拍 0/14
[7] await met=false ticks=20000 delivered 0→0  hub stored []     ← 蓝图完美、零交付
```

**P3 侧（已落地，见 `placer/NOTES.md` §6ter）**：`place()` 现在**吃 seed**：给了 `site`+`hub`+`seed` 时先
`pickResourceCells` 按真实资源反推机器簇平移量（矿机精确压真资源），收集带再从矿机处走到（局部）hub 的
**任一可达入口**（`planChannel` 的 Z 型可跨 13+ 格）。`test ①f F1/F3` 锁死「给真 hub+seed ⇒ 矿机压资源且
entry 落真入口」。

**P8 侧（本单）——关键是让 `place()` 拿到真 hub 与 seed**。`compileInner` 现在维护一个
**`hubLocal`**（= hub 在作图局部系里的坐标），三处坐标口径全部以它为准：

| 处 | 修前 | 修后（给了 `input.hub`） | 修后（未给 hub，旧路径） |
|---|---|---|---|
| `placeStage` | `site={0,0}`、`hub=hubDesign`、`world.seed=null` | `site=hub=ctx.hub`（真世界坐标）⇒ place 的 `origin=W`、`hubLocal=[0,0]`；`world=hubWorldState(W, seed)`（世界系，place 自己减 origin）；**`seed` 传入** | 原样 `site={0,0}`、`hub=hubDesign`、`seed:null` |
| `siteStage` | 只按资源解 anchor，hub 钉不死就回退 | `hubLocal` 分支：`anchor = hubWorld − hubLocal` **唯一确定**（不再资源重扫、不再"回退一个接不上的 anchor"）；仍逐台校验矿机压真资源、逐格校验不压 hub | 原「候选 anchor × 资源对拍」逐字节不变 |
| `alignBbox` / entities | 设计系 | 局部系（原点=真 hub）；`stats.bbox === entities 跨度` 的口径不变（`alignBbox` 本身没改，改的是喂它的 entities 系） | 不变 |
| P5 `world` | `hubWorldState(hubDesign, seed)` | `hubWorldState(hubLocal, seed)` = **同一框**（hub 在 (0,0)，与 `layout.occupancy` 的 16 格一致） | 不变 |
| P4 `hubOrigin` | `hubDesign`（恒 [-4,-4]） | `hubLocal`（= (0,0)）。P4 用它在 hub 周围留车道；给错框会让每条经过 hub 列的通道判"车道撞 hub"⇒ `column-conflict-unresolved`（本单实测 82125 一例） | 不变 |

**同时把世界系 V1 闸从「包围框」改成「逐格」**（`hubClearOf` / `worldFrameHubCheck` + 新的 `entityCellsOf`）：
B-4 之前收集带恒竖直贴 hub 底缘，包围框天然退出 hub；B-4 之后带子会**绕到 hub 顶/左/右入口**，
包围框把合法的贴边格吃进去 ⇒ 60 个 seed 里 13 个被误判 `validate:V1`。dry_run 的 `solid collision`
判的是实际格是否被 hub 的 solid 格占住，逐格判据与它同义。`hubClearOf` 对**四元数组**仍按旧包围矩形解释
（`siteStage` ⓑ 的候选粗判与旧单测继续可用）。

**不变式（升为断言，`harness/test.mjs` J-3 扫 36 组）**：
> **`ok:true` ⟹ `anchor + hubConnection.entry` ∈ `hubEntriesWorld(真 hub)`（且 side/dir 与该口一致）
>   且每台矿机的世界格 `tileResource(seed,·) === payload` 且 `site.hubPinned === true`。**

J-3 实测：3 goal × 4 seed × 3 hub = 36 组里 20+ 组 ok:true，**违例 0**。另用 5 goal × 24 seed 扫 120 组，
ok 120 / 违例 0。

**接不上时不再"回退成另一个 anchor 的绿灯"**：`siteStage` ⓐ 分支只认 `anchor = hubWorld − hubLocal`；
资源/几何不成立 → 结构化失败（`no-resource-in-range` / `validate:V3` / `dag-not-placeable:*`），
不产蓝图（J-4 锁死）。**没有走 (b) 降级**：实测绝大多数 seed 能直接接通（见下），降级会把可用路径也否掉。

**实机验收（`node research/ai-plan/live/l3-run.mjs --goal CuCuCuCu`，level-1 的世界本身要 `CuCuCuCu`）**：
```
[3] ok=true ents=9 vpass=true bp=104 corners=1
[4] dry_run apply=9/9 blocked=0 delete=0 unknown=0
[5] paste applied=9 failed=0
[6] 逐格对拍 0/9
[7] await met=true ticks=960 delivered 0→1  hub stored [["CuCuCuCu",1]]
=== L3 PASS (CuCuCuCu) ===
```
同一链路用 `----CuCu`（level-2 目标，L1 存档里 hub 会拒绝它 —— 这一关的 `required` 是 `CuCuCuCu`）也验证了
"带子确实接上真 hub"：`hub stored [["----CuCu",61]]`，61 个物品真的进了 hub；
但这一关不认这个形状，所以 `delivered` 仍是 0 —— 这是**关卡目标不匹配**，不是链路问题。

**修前/修后成功率（`----CuCu` / hub(-2,-2)，seed = i×104729+7 mod 300000）**：修前 = 0 交付（所有 seed）；
修后 24 个 seed 全部 ok:true 且交付路径可达。`l3-run` 默认 seed 由游戏新档决定，实测 18043/55852/77844/32913/82125
均 ok:true（82125 是 P4 hubOrigin 框错的那一例，已修）。

**P3 `placer/test.mjs` F5**（「compile 链路是否已传真 hub+seed」的边界断言）随本单**转绿**：163/163。

## 3. 契约缺口（不阻断，但要显式）

1. **`§2.5` 没有「管线内部 / solver」这一类 reason。** 本包必须能表达三类失败：solver 进程/JSON 坏、solver 不可解、
   solver 的 dag 重建不出父节点。处置：**reason 严格落枚举**（`emit:mismatch` / `unlock:machine-not-available` / `validate:S1`），
   另加一个**枚举外的精确分诊码** `class`（`solver:cli-failed` / `solver:undecidable` / `solver:dag-unreconstructible` /
   `solver-pigment-folded-into-paint`），并把 `p.stages` 逐段结果一起返回。建议 P1 增补 `solver:undecidable` 等条目。
2. **`stats.bbox` 与 `layout.bbox` 的口径冲突（已用最小代价绕开）**：P1 契约要求 `stats.bbox === entities 跨度`
   **且** `=== layout.bbox`（types.mjs:505-512），而 P3 的 `layout.bbox` 把 **hub 4×4** 也算进去（place.mjs buildReport），
   hub 又**不在** entities 里（它是既有世界）⇒ 两个等式不可能同时成立。本包在 `alignBbox()` 里按 **P1 fixture 的口径**
   把 `layout.bbox` 重算为 entities 跨度，并把 P3 原值留在 `layout.bboxP3`（内容零改动、原值可见）。
   建议 P3 或 P1 二者之一改口径（P3 更该改：它是产出方）。
3. **solver 的 steps 不带 `parents`**（`proto/solver.mjs:218-231` 只 push `{hash,op,args,depth}`）。P3 的 `buildDag` 与
   P5 的 S1 都要边信息 ⇒ 本包用只读的 `proto/shape-ops.mjs` **重放重建**（`rebuildDag`，双输入按 (lower,upper) 保序）。
   这不是猜：找不父 = solver 自相矛盾，结构化拒。
4. **`hub` 的 16 入口没有 ejector**（P5 NOTES §5.3 已登记）：所以 hub 只能当终点，V4 只查「带子出口落进入口槽」一侧。

## 4. 本包自己修掉的 bug（诚实记录）

| 症状 | 根因 | 修法 |
|---|---|---|
| V4 报「(0,3) 不是 hub 的输入槽」 | `place()` 给世界 hub、`WorldState` 给设计 hub，两框混用 | 统一设计系（§1） |
| CLI 不认 `----CuCu` | `val()` 拒绝任何以 `--` 开头的值（而 `----CuCu` 就是形状） | 只排除「已知 flag 名」，不排除 `--` 前缀 |
| `val()` 认不出裸位置参数 goal | `isGoalLike` 正则把 shortKey 当 8 个同字符集字符（实际是 4×`[sub][color]`） | 改 `^([-RCSW][rgbypcuw-]){4}(:...)*$` |
| 失败只给一行 message，drift 凭据丢了 | `validateStage` 失败时不带 report | 失败对象附 `report/audit`，顶层附 `layout/entities/validation` |
| lint 自检把自己判红 | 判据字符串里写了禁用模块名 | 改用 P1 的词法级 `collectImportSpecifiers`（只看真 import） |
| **L3 首个实机缺陷**：`dry_run` 3 格 blocked（occupant=hub uid 10000）、`apply=11/14` | ①`siteStage` 挑 anchor 只看"矿机压资源 + 离原点近"，**从不检查世界系落点矩形是否压 hub**；②`regionClear` 只拒"含非 hub 实体"的世界，**hub 自己不进占用判定** | ①候选 anchor 加硬约束 `anchor + 实体矩形 ∩ hub 世界 4×4 == ∅`（`hubClearOf`），并**优先**试 hub 钉死的 anchor（`hub = anchor + hubDesign`）；②`regionClear` 的 javadoc 写明"hub 不进这里是有意的"，hub 判据移到 `hubClearOf` |
| 同上：`plan.site.anchor` 宣告 `[0,0]`，P7 照它 paste → 世界原点 | 喂 P6 的 `anchor` 是设计系 `[0,0]`；emit 归一后 `entities.dx/dy` 以 min corner 为 0，但 `site.anchor` 原样透传 ⇒ §2.1 的 `世界 = anchor + dx/dy` 不成立 | 喂 P6 的 `anchor = site.anchor`（世界），并在 emit 后把 `final.site.anchor` 钉成 `em.emit.anchor`（= 世界 min corner = `pasteAt`）；`site.hub` 未给 hub 时改 `null`（原来是设计系 `[-4,-4]` 冒充世界坐标） |
| 需要四道门才能端到端：L3 dry_run | V1 只看设计系（`hubWorldState(hubDesign)`），**永远只能 pass** —— 是"框"的错位，不是判据洞 | 加 `worldFrameHubCheck()`（`stages.worldFrameV1`）：实体矩形 + anchor vs 真实 hub 4×4，压上即 `validate:V1` 整单 fail；test.mjs §J 用 L3 实参锁"布局压 hub ⇒ V1 fail"（命中 3 格与实机 dry_run 的 3 条 blocked 逐数对上） |

## 5. 待主线程裁决

1. **B-1 归谁修**：P3 的机器簇间隙（改 `dy` +1 行 / 废料侧向）——我判断是 P3，且改动小、有现成回归锁（placer 96 条）。
2. **B-2 归谁修**：solver 产出 mix 节点（改禁改文件 `proto/solver.mjs`，需主线程批准）；或 P1 给 payload 加 `kind`。
   在这之前，**所有上色目标（含 level-7/8/10/11 官方目标）都无法端到端出蓝图**——这是当前最大的能力缺口。
3. **`§2.5` 是否补 solver 类 reason**（见 §3.1）。
4. **B-3 是否需要 P3/P4 第二轮**（M4 策略从「偏好」升「硬约束」）。

## 6. 交接件格式（P8 → P7，plan §4.6）

```
out/<goal>.szbp.txt       蓝图字符串（逐字节 == plan.blueprint）
out/<goal>.intent.json    {goal, schema, blueprint, anchor, hub, chargeMode, gv, count, stride,
                           entityOrder[], entities[]（P5 --intent 可直接吃）, beltIntent[], stats, scope,
                           validation{pass,errors,failIds,beltSim,shapeReplay,throughput},
                           validator{pass:true}, roundtrip, provenance}
out/<goal>.validator.json {goal, ...ValidatorReport, gate:auditReport}
```

- `<goal>` 用 `goalSlug()`（`:`/`-` 保留，其余换 `_`），所以 `--CuCu--.szbp.txt` 这种文件名是合法的。
- **只有 `validator.pass===true` 才写**（`writeHandoff` 里双查：`plan.ok` + `auditReport().gate`）。
- P7 的 paste 点 = `intent.anchor`（= `site.anchor`；世界系）；`intent.hub` 是 hub 的世界左上角。
- `provenance.worldPlacement.pasteAt = anchor + emit.anchor` 是「蓝图内 min corner 的世界坐标」，
  与 mod 的 `export_blueprint` 口径一致（`paste_blueprint{x,y}` 填它或 anchor 等价 —— 本包的 anchor 已归一）。


## 7. 接新颜料契约（B-2 修复后，P8 最后一轮）

solver `4e60013` 之后 `steps[]` 变成：形状节点 `hash=<shortKey>`，颜料节点 `hash=color:<name>`、
`op ∈ {mineColor, mix}`、`inputs` 显式（`paint → [shape, pigment]`、`mix → [colorA, colorB]`）。
P8 侧接法（**不改 P3/P1**）：

1. **`rebuildDag` 不再重建父节点**：solver 现在给了 `inputs`，直接采用；形状代数复算降级为**自证**
   （hash 与 inputs 对不上 → 结构化拒，仍不猜）。
2. **颜料节点 → 编译期 token**：`color:<name>` 不能进 P3（`channels.payload` 必须是 shortKey，
   types.mjs:597）。P8 在映射层把它换成**合法 shortKey 语法的 token**：
   四象限 sub 全 `'-'`、把颜色字符放在第 k 个象限（`-c------`、`--c-----`…）。
   · `parse` 对 `-c` 只看 sub（`'-'`）忽略颜色 ⇒ token 解析成空形状、不会污染形状代数；
   · 语法闸（每层 8 字符、每象限 `[sub][color]`）通过；
   · **同色第 k 份副本用第 k 个象限** ⇒ hash 唯一，满足 P3 的「hash 唯一」闸。
3. **共享颜料 = 复制矿机，不是扇出**（solver-README §3.4-3 / §3.5 实测：扇出会被 P3 判
   `crossing-needs-tunnel`）。每个消费者拿一份独立 token ⇒ 独立矿机 + 独立矿位。
4. **S1 只复放形状**：颜料节点不是形状（`ColorItem`），从 `dagForS1` 里剔除，`paint` 的 parents
   只留 shape。理由：`applyOp('paint')` 只用 `parents[0]`；而 pigment token 的 `parse∘hash` 会塌成
   空形状（solver-README §1.2 理由 2），留在 S1 里必假红。


## 8. 已产出的交接件（本轮）

下表是**未给 hub** 的交付口径（`compilePlan({goal, seed:43391})`，本地原点 = 设计系 [0,0]）。
**给真实 hub 时实体数与带子数会变**（B-4：矿位由 seed 决定、收集带按真入口走 Z 型 ⇒ 通常更多带子）：

| goal | 官方关卡 | 实体 | 带子 | 拐角 | 蓝图 | validator |
|---|---|---|---|---|---|---|
| `CuCuCuCu` | 1 | 4 | 3 | 0 | 见 out/ | pass |
| `RuRuRuRu` | 3 | 4 | 3 | 0 | 见 out/ | pass |
| `Cu----Cu` | 5 | 22 | 18 | 0 | 见 out/ | pass |
| `--CuCu--` | — | 22 | 18 | 0 | 见 out/ | pass |
| `Ru----Ru` | — | 22 | 18 | 0 | 见 out/ | pass |
| `--SuSu--` | — | 22 | 18 | 0 | 见 out/ | pass |
| **`----CuCu`** | **2（L3 验收目标）** | **14** | **11** | 4 | 见 out/ | pass |
| `RuRu----` | 4 | 14 | 11 | 4 | 见 out/ | pass |
| `Cu------` | 6 | 32 | 26 | — | 见 out/ | pass |

**给真 hub 的样例（seed 18043 / hub(-2,-2)）**：`----CuCu` → **19 实体 / 16 带 / 3 拐角 / 140 字符 / bbox [6,11]**，
`site.anchor=[-7,-4]`、`hubPinned=true`、矿格 `CuCuCuCu@(-7,6)`（离线资源图确认是铜）。
`out/` 里的 `----CuCu.*` 三件套已按这组参数重生成。

### 8.0 L3 实参重生成（seed 18043 / hub(-2,-2)）—— 世界系 hub 不相交修复后

`----CuCu` 三件套按 **任务书指定参数**重跑（`node src/ai/compiler/cli.mjs --goal "----CuCu" --seed 18043 --hub "-2,-2"`）：

| 量 | 修前（V1 修复前） | 修后（V1 修复后、B-4 前） | **B-4 修复后** |
|---|---|---|---|
| `site.anchor` | `[0,0]`（设计系原点，错） | `[-7,-3]`（世界 min corner） | **`[-7,-4]`**（世界 min corner；由 `hub − hubLocal` 唯一确定） |
| `site.hub` | `[-4,-4]`（设计系，冒充世界） | `[-2,-2]`（真实 hub） | **`[-2,-2]`** |
| `site.hubPinned` | —（无此字段） | `false`（如实：接不上） | **`true`**（收集带真接上，J-2/J-3 锁死） |
| `layout.hubConnection`（局部） | 设计系 entry | 设计系 entry | **`{entry:[0,-1], side:"top", dir:180}`** ⇒ 世界 `(-2,-3)` ∈ `hubEntriesWorld([-2,-2])` |
| `dry_run.would_apply` | **11** / 14 | 14 / 14 | **19 / 19**（seed 18043：CLI 实测 19 实体 / 16 带 / 140 字符） |
| `dry_run.blocked` | **3**（`(0,0)` belt / `(0,1)` belt / `(1,1)` trash，occupant=hub uid 10000） | 0 | **0**（结构：带子只走 hub 入口圈外的格，J-1b/J-2 锁死） |
| 交付 | — | **0（20000 tick）** | **`met=true`（`CuCuCuCu`，960 tick / 1080 tick 两次复现）** |

**L3 实机验收（切到本关真实目标形状）**：level-1 的世界 `requirement.shape = CuCuCuCu`（hub 会**拒绝** `----CuCu` ——
所以用 `----CuCu` 跑 L3 永远 `delivered=0`，即使链路已通；修前修后都是这样，这是关卡口径不是链路问题）：

```
$ node research/ai-plan/live/l3-run.mjs --goal CuCuCuCu
[3] ok=true ents=9 vpass=true bp=104 corners=1
[4] dry_run: apply=9 delete=0 blocked=0 unknown=0
[5] paste: applied=9 failed=0
[6] 逐格对拍: 0 处不符 / 9 格
[7] await … met=true ticks=960 delivered 0→1   hub stored [["CuCuCuCu",1]]
=== L3 PASS (CuCuCuCu) ===
# 第二次（不同 seed 45970）：ents=10 bp=108 corners=2，apply=10/10，逐格 0/10，
#   met=true ticks=1080 delivered 0→1 —— 可复现
```

**同一链路用 `----CuCu` 的实测**（证明"带子真接上 hub"，只是关卡不认这个形状）：

```
[3] ok=true ents=20 vpass=true bp=147 corners=3
[4] dry_run: apply=20 delete=0 blocked=0 unknown=0
[5] paste: applied=20 failed=0
[6] 逐格对拍: 0 处不符 / 20 格
[7] await … met=false ticks=20000 delivered 0→0   hub stored [["----CuCu",61]]
```

`hub stored [["----CuCu",61]]` = **61 个物品真的进了 hub**（修前是 `[]`）。这就是 B-4 修好的直接凭据。

**如实标注**：`site.hubPinned` 现在恒 `true`（给了 `input.hub` 且 `ok:true` 时）。这不是"声称"——
J-3 对 36 组（3 goal × 4 seed × 3 hub）的成功产物逐口用 `hubEntriesWorld()` 对拍，违例 0；
另 5 goal × 24 seed = 120 组成功、违例 0。失败的目标（几何/资源不允许）现在**直接失败**，不产蓝图。

### 8.1 仍被拦的目标（精确 reason，不伪造）

| goal | 卡在哪 | reason | 归因 |
|---|---|---|---|
| `CrCrCrCr`（L7）、`RbRb----`（L8）、`CpCpCpCp`（L9） | `routeStage` | `dag-not-placeable:column-conflict-unresolved` | **P3/P4 几何**：painter 的输出朝 **+x**，而 hub 在树上端需要 **+y** 竖车道；`assignLanes` 对 `n2->hub[out]`（vlane）报 `lane-column`，与 hub 4×4 占位冲突。**颜料通道本身可布**（`connectHub:false` 时同一布局 route 全绿：28 带 / 5 拐角）⇒ 瓶颈不在颜料，是 painter→hub 的那一竖段。 |
| `CgScScCg`（L11） | `routeStage` | 同上（先遇到 `placeStage` 的 `crossing-needs-tunnel`，再是 lane 冲突） | P3/P4 的**双分支汇入 stacker**（B-3）叠加 painter→hub 的 +x/+y 问题 |

**给主线程的判断依据（可复现）**：
```js
// 同一 CrCrCrCr 布局：连 hub 失败，不连 hub 全绿 ⇒ 失败点是 hub 连接段
place({steps, hub:{x:-4,y:-4}, world:hubWorldState([-4,-4],null), connectHub:false})  // → route OK, 28 belts / 5 corners
place({steps, hub:{x:-4,y:-4}, world:hubWorldState([-4,-4],null)})                    // → route FAIL, n2->hub lane-column
```
扫过 `hub ∈ [-8..8]×[-8..0] × rowGap{8,10,12} × colGap{3,4,5,6}` 共 648 组：**0 命中** ⇒ 不是参数问题。
建议 P4：给 `painter`（`flowAxis:"x"`）到 hub 的通道**优先选水平入口**（hub 左列/右列），
或在 `assignLanes` 里允许 v1 用「列车道」；M2a 实机验证过 painter 右出接 trash，说明 +x 本身可达。

> `run-all` 的绿是「闸正常工作」；`----CuCu`（L3 目标）现在真的能出蓝图，上色目标仍被几何拦下 —— 如实分开记。
