# P3 `placer` — NOTES.md

接管现场：上一任死在中途写入 —— `src/ai/compiler/place.mjs` 是 881 行的**语法不完整文件**
（末尾悬空、被截断）。第一笔操作即用语法完整、可 `node --check` 的骨架整体替换，
之后每段 Edit 后跑 `node --check`，全程盘上文件合法。测试目录 `research/ai-plan/placer/` 新建。

最终：`node research/ai-plan/placer/test.mjs` → **78 断言全绿**（含四张金网格逐字节 +
planChannel 逐形态 + 负例 + 契约 + 裁决落地 G1/G7/G10/K1 + import lint + node --check）。

---

## 一、与 P1 fixtures 对齐的三条口径（N-1，读 report-layout.json / plan-l1.json 逐格核对得到）

这三条不是我自己拍的，是从 P1 已入库的两个 fixture **反推**出来的读法，写死在文件头注释里：

1. **坐标不平移**：`bbox = [maxX-minX+1, maxY-minY+1]`，grid 第 i 行 ↔ `y = minY + i`，**允许负 y**
   （report-layout.json 的 trash 在 y=-1、plan-l1 的 hub 口在 y=-1 —— 若平移原点就逐字节对不上）。
2. `channels[].from/to.cell` = **机器槽位的绝对格**（不是带子格）；且 **slot === outDir/inDir**（= 槽位朝向）。
   带子几何量在内部换算：`first = add(fromCell, outDir)`、`last = add(toCell, inDir)`、`d2 = OPP[inDir]`。
   这条在 test ③ 用 fixture 反向核对（`fixture channels 的 slot 与 outDir/inDir 同值`）。
3. `hubConnection.entry` = `hubEntriesWorld()` 返回的 `cell`（带子末格），`side` = `face`（贴的 hub 边），
   `dir` = 带子流向角。hub 槽格 = `add(entry, ANGLE_DIR[dir])`，其 acceptor 方位 = `side`。

**金网格是本包生成的快照，不是抄 P1 fixture**：P1 的 `plan-l1.json.grid` 是「形状示意」
（plan §2.7 原话，且它的 ROW_H/锚点与本包不同），逐字节对不上是正常的。本包的 G1/G2/G3 是
**当前实现输出的字节锁** —— 一旦几何改动破坏了「全竖直零拐角 / 恰 2 拐角 / 垂直进料通道」，
逐字节断言就变红。M4 语义凭据（'7' 角 → solveTurn r0/rv1、'9' 角 → r270/rv2）单独用 test ② 的
不变式锁死，与 fixture 同源。

## 二、多层（scope.layers）的裁决口径（见 CONTEST C-1，这里是实现口径）

- stacker **单次合成**（2 个非堆叠上游 → 1 个 2 层形状，如 `CuCuSuSu:RuRuCuCu`）是 v1 支持的
  （M4 实机验证过），其输出 hash 含 ':' **合法**（P1 report-layout.json 就这么写）。**不拒**。
  → 早先我误把「hash 含 ':'」当多层拒绝，会误杀 gold ②，已改成只看**结构**。
- 真正越界的是 **堆叠机产物再进堆叠机**（嵌套 stack ⇒ ≥2 合成级）。这是唯一能用 v1 op 集表达、
  又确实超出 `scope.layers:1` 的形态 → `out-of-scope:multilayer`（gold ④ 走这条，见 CONTEST）。

## 三、车道（lane）与 P4 的接缝

- 本包只**选一个可行车道行/列**用于算格与拐角数；真正的 left-edge 分配归 P4（执行书 + routing-prior-art §8）。
  `channels[].lane`：straight/elbow/degenerate = `null`，z/z-col = 数字。每条非空 lane 都同步进 `lanes[]`
  （满足 P4 NOTES R-2 要求的 `channels[].lane ⟺ lanes[].row` 互逆）。
- `ordinal` 在同一 `(from,to)` 内**唯一**（test ② 末「ordinal 唯一」三连锁）：P4 用 `from→to#ordinal`
  派生 channelId（router NOTES R-5），撞号会被 P4 记成同一 id。本包按槽序 index 出 ordinal，天然不撞。
- **两条 Z 撞同一车道行** → 上报 `conflicts[lane-column]` 并保留几何（不静默），加宽 `rowGap/colGap`
  重试清零（test ②「加宽后重试」）。这正是 plan §1.3 验收「同一列被两条通道要求 → 报 conflict 并加宽重试」的落地。

## 四、trash（mustDiscardUnused / 陷阱表 #7）

- 未用输出槽自动接 trash；候选顺序 = ① 直串外推（零拐角优先）② 侧让（撞路时 trash 挪到带子首格垂直侧，
  首格成为 1 拐角，拐角**如实计入 cornerCount**，非静默近似）。每个候选都要「落子 + route」都成立才 commit，
  撞路则快照/回滚换下一候选 —— 绝不留下半成品（C1 整单 abort 精神）。
- **顶层产出优先喂 hub，再轮到 trash**（8.2 在 8.3 前）。顺序颠倒会让同一输出口被 route 两次（一次 hub 一次 trash）
  —— 这是我修掉的**本包真 bug**（曾导致 gold ③ 连 hub 时 hub 16 口全接不上）。

## 五、G7（象限断言）落点

- 所有进本包的角度都过 `assertQuadrantAngle`：`args.angle/rot/rotation/rotationVariant`（脏角 → `out-of-scope:rotated-machine`）、
  `hubEntriesWorld` 的 `dir`（脏 → 结构化抛错）。**刻意不量化不截断**：belt-rules 的 rotateLocal 是截断、
  angleToDir 是量化，语义不同（NOTES G7 的由来）；gold ④ 的 `args.angle:45` 被拒是这条的锁。

## 六、坐标系口径：为什么选 (b)（P5 揪出的世界系 hub 混框 bug）

**Bug（P5 复跑真 P3/P4 时发现，我的 test 之前全程 `connectHub:false` 零覆盖）**：
`place({steps, hub:{x:1200,y:-1400}})` 时机器排**局部** (0,…)、hub 按**世界**连，两者混框 →
收集带从局部机器铺到世界 hub，实测 `bbox=[1204,1414]`、`beltCells=2609`。

**决定：(b) LayoutReport 输出 site 相对局部系。** 依据不是拍脑袋，是 **P1 已入库的 `plan-l1.json`**：
它的 `site.anchor=[1200,-1396]`（世界）而 `layout.occupancy[0].cell=[0,-4]` —— 而 `[1200,-1400]−[1200,-1396]=[0,-4]`
= hub 世界坐标减 anchor。这坐实了契约：**site 是世界锚点，layout 内的每个坐标都是「世界 − site」的局部值**。
选 (a)（报告输出世界系）会**违反 plan §2.3 / P1 fixture**，逼着改 fixture；(b) 才是"照 plan 实现"。

**实现**（place.mjs `place()` 开头 + `buildReport`）：
- `origin = input.site || input.hub || {0,0}`；世界 hub、既有 occupancy、资源格（meta.minerCells）一律
  减 origin 摄入成局部；`hubEntries(hubLocal)` 用局部原点。
- 有 hub 时把机器簇整体平移到「hub 正下方」（顶行 = hub 底缘下 **HUB_CLEAR** 行、minX = hub 左列），落在 hub 底部 4 口之一上方；
  簇内相对几何不变，故**收集带只跨 1 段**（≈HUB 底到机器顶 + 机器内部高度），bbox 回到几十格。
  `HUB_CLEAR` 的取值与理由见 §六bis（B-1 修复）。
- 无 hub：origin 缺省 (0,0)、跳过平移 → **金网格逐字节不变**（test T4 锁死；G1/G2/G3/G4 未动、fixture 未动）。

**给 P8 的用法（回答协调者的"要回答 P8"）**：
- `place()` 的 LayoutReport 是**局部系**，原点 = `input.site`（你传什么 site 就以它为原点；不传 site 只传 hub → 以 hub 为原点）。
- **P8 的"输出整体平移"绕行：可以作废。** place() 已把坐标统一到局部，P8 只需在拼装 CompiledPlan 时
  把局部坐标 + `site.anchor` 还原成世界（P6 发射 `dx/dy` 时 `世界 = site.anchor + 局部`，与 plan-l1.json 同口径）。
  若 P8 仍想拿世界系坐标，直接传 `input.site = 世界锚点`，本包报告原点即该锚点、机器簇就在它附近。
- 平移不变性有锁（test T2：site/hub 同步世界平移 → grid/bbox/channels/hubConnection 逐字节等价），
  证明"局部系"是真的、没有世界坐标泄漏（T3/T5 进一步锁 placement 与 meta.minerCells 都在局部幅度内）。

## 六bis、B-1：废料带压在 hub 入口圈 → V3 漂移（P8 集成发现，阻塞 L3）

**复现（P8 扫 640 组 rowGap×colGap×hubDesign 全 0 命中 ⇒ 拓扑问题，非调参）**：
`compilePlan({goal:'----CuCu',seed:43391,hub:{x:0,y:0}})` → `ok:false reason:validate:V3`。
drift 格 `[1,4]` 是 cutter 的**废料带拐角**，正好落在 hub 底排入口行 `y=hub.y+HUB_SIZE` 上 ——
它紧邻 hub 的 acceptor，computeBelt 把 hub 当**机器邻居**重算 rv（belt-rules.mjs:8-10 的机器邻居角落漂移），
P5 的 `V3-belt-fixed-point` 必红。

**修法选择：(a) 机器簇与 hub 之间留净空（取 `HUB_CLEAR = 3`）。** 为什么不是 (b) 侧向出料：
- (b) 要求**每一个**未用输出口都改走横向 —— 那会把 cutter 的右列废料带从"直串一步"变成"拐弯一步"，
  等于给所有带废料口的机器凭空加 1 个拐角（第一原则：拐角越少越好，GRID-LAYOUT:41-62），
  而且 painter/mixer 这类 +x 流机器的输出本来就横向，再"侧向"没有可去之处。治标不治本。
- (a) 只是把整个机器簇往下挪，**簇内相对几何完全不变**（拐角数、车道分配、相对列位一个都不动），
  因此金网格零扰动、P4 的车道推导也不受影响。这是唯一"改了 hub 邻接、没改布局本身"的修法。

**`HUB_CLEAR = 3` 的依据**（不是拍脑袋：2/3/4 逐值实测 + 16 口全表核对）：
- 只避开**底排**（`y = hub.y+HUB_SIZE`）不够 —— hub 还有**左列/右列**入口（`x = hub.x-1` / `hub.x+HUB_SIZE`），
  竖直走向的废料带（cutter 右列 → trash 常常 straight 向下）会撞上左/右列入口格 ⇒ 同样漂。故按**整圈 16 格**算，不按"行"算。
- **净空=1**（原状）：废料带拐角落在底排入口行 → drift=1（就是 P8 看到的 V3）。
- **净空=2**：带子已不漂（drift=0），**但发现一个更隐蔽的坑** —— trash **机器**恰好落在底排入口格 `(1,4)` 上。
  它不吃带子路径，可它①永久占掉 hub 的一个入口，②作为机器邻居同样干扰相邻的收集带格。
  「drift=0」这种单一判据会漏掉它，所以测试改成**同时锁"无机器落在入口圈上"**。
- **净空=3**：trash 退到 `(1,5)`、废料带 `(1,6..7)` 全在圈外；圈上只剩**收集带末格** `(0,4)` —— 那是它的职责，必须落在入口。
- 净空=4 只多浪费 1 行，无额外收益。
- 其它 hub 位置同样成立：净空相对 `hubLocal` 算，而 `hubLocal = hub − origin`，与世界坐标无关
  （test ④ 覆盖「无 site / site=hub / site 偏移」× 4 个 hub 位置 = 12 组）。

**验收证据**（`placer/test.mjs` ①e，44 条断言）：
- ① 废料带每格 ∉ `hubEntriesWorld(hubLocal)` 的 16 入口格（**全表**，不只底排；比对在**局部系**做 ——
  第一版我拿世界 hub 比局部带坐标，非零 hub 时断言恒真 = 假绿，已修）；
- ①b 无**机器**（含 trash）落在 16 入口格上；收集带最多 1 格在圈上（其末格）；
- ② 用 P5 的 `belt-sim.simulateBelts`（**只读依赖**，Coordinator 明确许可）对整张报告跑含机器邻居的不动点：`drift=0`、
  `fixedPoints === tilesChecked` —— 这是 V3 的**同一判据**，本测试绿 ⟺ V3 不会挂；
- ③ 反向自证：不连 hub 时 drift=0（证明漂移确由 hub 邻接引入，不是几何本身）；
- ④ hub 四个位置 × 三种 site（无 / 同锚 / 偏移）全扫（废料带 + 机器 + drift 三判据）。
- **变异锁**（证明非空断言）：`HUB_CLEAR` 改 1（原始缺陷）→ ①①②④ 全红；改 2 → ①b「无机器在入口圈」红
  （正是净空=2 漏掉 trash 落 `(1,4)` 的那一坑）；改 0 → T1/T2/T5 红。三档都被抓。

**金网格未动**：无 hub 时 `HUB_CLEAR` 不参与任何计算，G1/G2/G3 逐字节不变（test ① 直接锁死），fixture 未改。

**连带发现（别的包，只点名不动）**：P8 的 `harness/test.mjs` C5 **把缺陷当期望锁住了**
（`eq(p.reason, "validate:V3")`、注释"见 NOTES B-1"）—— 本修复让该断言翻红，但那是**缺陷消失**，不是回归。
C5 应改成断言 `----CuCu + hub` 现在 **ok:true / V3 pass**；另 C4/C6/C7 在我改前就红（颜料闸归因，P8 侧待办）。
I-1（四个 hubDesign 都与相对布局无关）在我改前红、改后**转绿**。

## 六ter、B-4：收集带末端接不到真实 hub（L3 最后阻塞）—— 修法 (a) + 给 P8 的精确接口

**症状（实机，l3-run 自己复现两次）**：
```
[3] ok=true ents=14 vpass=true bp=121 corners=0
[4] dry_run apply=14 blocked=0 delete=0      ← 贴得上、逐格 0 差
[5] paste applied=14 failed=0
[6] 逐格对拍 0/14
[7] await met=false ticks=20000 delivered 0→0  hub stored []
```
蓝图完美落地，但**收集带末端对着空气** → 零交付。

**根因（两层，必须分开看）**：
1. **place() 忽略 seed 摆机器**：恒把机器簇锚在 hub 正下方（HUB_CLEAR），矿机永远不在资源上。
   这是 place.mjs 自己的缺陷，**已修**（见下）。
2. **compile.mjs 传的是设计系假 hub**：`placeStage` 传 `site={0,0}, hub=hubDesign(-4,-4), world.seed=null`，
   真 hub 只在 `ctx.hub`（世界系）里、**没传进 place**；anchor 在 place 返回**之后**才由 siteStage 解。
   ⇒ 设计系 hub 恒在 (-4,-4)，平移 anchor 后在世界 `anchor+(-4,-4)`；该点只有 `hubPinned=true` 时才等于真 hub。
   **place() 结构上不可能知道 anchor / 真世界 hub ⇒ 这一层只能在 P8 侧修**（compile.mjs 归 P8，我不改）。

**修法选择：(a)（你裁，我实现了 place 侧那一半）。** 理由：
- (b)「要求调用方钉死 anchor，钉不死就 `hub-anchor-unpinned` 硬拒」会让**绝大多数 seed 直接失败**
  （实测 4 个 seed 里 3 个钉不死：资源不在锚点位上）。L3 的目标是"真能产"，不是"诚实地说不行"——
  硬拒只是把 0 交付换成 ok:false，仍然交不了货。所以 (b) 只能是兜底，不该是主路径。
- (a) 可行且通用：place() **已经有** `pickResourceCells`（seed → 资源格）这一整套机制，只是没用它摆机器。
  现在补上：**给 seed 时按资源反推机器簇平移量**，让矿机精确压在资源上；收集带再从矿机真所在处
  走到可达的 hub 入口（`planChannel` 的 Z 型本来就能跑长距离，实测 13 格 2 拐角）。

**place() 侧已实现（本单改动）**：
- `place()` 新增 seed 感知：`hubLocal && seed` 时先 `pickResourceCells`，用「第一台矿机的资源局部格 − 当前局部格」
  求平移量，整体移动机器簇 ⇒ 矿机压真资源。无 seed / 无 hub 时走原路径,，**金网格逐字节不变**。
- `pickResourceCells` 现在**排除 hub 4×4 覆盖的资源格**（物理上放不下矿机；实测 seed 43391/hub(-30,25)
  有 3 个 CuCuCuCu 正压在 hub 身上）。
- trash 候选新增一条几何约束：trash 是机器，**不得 4-邻接别的通道的拐角带格**（机器邻居会让那格 rv 漂移，
  与 B-1 同类）。只约束拐角格 —— 直带格相邻是常态且无害（G1 的 trash 一直贴着主链直带）。
  实测修好了 hub(40,40) 的 drift 1 格。

**给 P8 的精确接口（compile.mjs 是你们的文件，我不改；以下是建议的最小改动）**：
`placeStage(steps, ctx)` 目前构造 —
```js
site: { x: 0, y: 0 },
hub:  { x: ctx.hubDesign[0], y: ctx.hubDesign[1] },      // 设计系
world: hubWorldState(ctx.hubDesign, null),                // seed: null
```
**建议改成**（当 `input.hub` 给了真实世界 hub 时）：
```js
// 以真 hub 为原点作图：origin = 真 hub ⇒ 局部 hub=(0,0)，机器簇按 seed 的资源摆放，
// 收集带从资源处走到 hub 的真实入口 —— 这样 siteStage 解出的 anchor 自然把两者对齐。
site: { x: hubW[0], y: hubW[1] },
hub:  { x: hubW[0], y: hubW[1] },
world: hubWorldState([0, 0], seed),      // 局部系里 hub 在原点；seed 传进去（关键！）
seed,                                    // ← 新增：place 靠它摆矿机
```
其中 `hubW = input.hub`（世界系左上角）。**注意**：这会改变 `layout` 的局部原点（从设计系 (-4,-4) 改成真 hub），
所以 `siteStage` 的 `hubDesign`、`alignBbox`、P5 的 world 三处要跟着改成同一框 —— 属于 P8 的坐标口径调整，
需要你们那边同步（我在 placer 侧保证：`place({site:W, hub:W, seed})` 的输出自洽、entry 落在真入口，
见 test ①f 的 F1/F3，共 30+ 断言锁死）。

**若 P8 暂时不想改坐标口径**（改动面较大）：那就退到 **(b) 诚实降级** —— 在 `site.hubPinned === false` 时
把整单改成 `ok:false, reason:"hub-anchor-unpinned"`（§2.5 需新增该 reason，或者复用
`dag-not-placeable:column-conflict-unresolved` 并在 hint 点名）。这样至少 `ok:true ⟹ 真能接上`。

**核心不变式（本单要求）**：`ok:true ⟹ 收集带末端落在真实 hub 的 16 入口之一上`。
placer 侧已用 test ①f 的 F1/F3 锁住"给真 hub 时必成立"；**整条链是否成立取决于 P8 传不传真 hub**。
当前链路仍不成立（L3 [7] 0 交付），已如实记录在 `research/ai-plan/live/results/l3-----CuCu.json`。

## 七、别人包的现场（只点名，不动）

- **op-templates `--test` 夹带（主线程 f7f7a2d 已修，本包从 P3 侧复证）**：本包静态 import op-templates.mjs，
  实测**零夹带输出**；且用探针注入一个红灯后 `process.exitCode=1` 不被洗绿。→ 本包**没有**为夹带写过任何
  输出剔除/计数补偿（grep 全文件确认），符合主线程要求①②。
- **world.mjs `nearestResource` 的 shape 参数**：文档签名写 `shape`，实际接受谓词；本包传 `s => s === want` 可用，
  但 `findResource` 的第二参在 README 里叫 `shape` 却要求 `region` 必给（世界无限）—— 本包已用 `regionAround` 兜住，
  仅作记录，非 bug。
