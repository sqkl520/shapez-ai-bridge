# P5 validator — NOTES（执行期发现、决策记录、待主线程裁决项）

> 包属主：P5 `validator`。只写本目录 + `src/ai/compiler/validate.mjs`、`src/ai/compiler/belt-sim.mjs`。
> 未 commit、未碰桥接、未改他人文件。

## 0. 交付物与验收

| 文件 | 行数 | 内容 |
|---|---|---|
| `src/ai/compiler/belt-sim.mjs` | ~520 | 独立实现 `computeBelt`（对照 `recon/upstream-full/src/js/game/buildings/belt.js:159-247`）+ 槽位法邻居模型（对照 `logic.js:391-470`）+ `topologyScore`（双实现拍腿）+ 存档回放 |
| `src/ai/compiler/validate.mjs` | ~1450 | V1-V10 + S1 十一判据、归因机制、`auditReport`、CLI（三种输入） |
| `research/ai-plan/validator/mutation-cases.mjs` | ~240 | 19 条注入（7 陷阱 + 8 清单 + 4 补充） |
| `research/ai-plan/validator/test.mjs` | ~590 | L0：A 判据自测 / B 变异矩阵 / C 双实现对拍 / D golden / E lint / F 自洽 / G CLI / H 三态归属 / I 回归锁 / J P5⇄P1/P8 交接 / K hub 锚点 |

```
node research/ai-plan/validator/test.mjs          → 171 pass / 0 fail（~4s，A-K 十一组）
node src/ai/compiler/validate.mjs --test          → 同上（转发，同一入口）
node src/ai/compiler/belt-sim.mjs                 → 自测通过
```
回归对照：`src/ai/belt-rules.test.mjs` 17/17、P1 `contract/test.mjs` 全绿、`op-templates --test` 全绿（本包未改这些文件）。

---

## 1. 双实现交叉对拍（L0 验收 2）—— **0 差异**

两条腿是**互不 import 的两套代码**，同一份数据 `research/ai-player/facts/live/world-full.json`（1906 带子）：

| 判据 | P0-verify（`belt-rules.test.mjs`） | P5（`belt-sim.mjs`） | 结果 |
|---|---|---|---|
| 下游闭合 | `entryW(nb)==OPP[ex]`（方位回指） | 槽位法：邻居 acceptor 的 `sourceTile` 是否等于本格（`logic.js:436-452`） | **1267 / 1268** 两边同值 |
| 弯带双侧闭合 | 上游出口回指 + 下游入边回指 | 上游 ejector 命中本格 **且** 下游 acceptor 命中本格 | **69 / 69** 两边同值 |

对拍方式不是我把数字写死：test.mjs **C7** 从 `belt-rules.test.mjs` 源码里正则解析出它自己断言的 4 个常数，再与我算出的值比（C8），并实跑 `node --test src/ai/belt-rules.test.mjs`（C9/C10，17 pass）。

### 1.1 途中踩到的真问题：层归属

`world-full.json` 把 regular/tunnel 层**拍平**成同一张表（obs 只回报 `layer` 字段，182 条 `underground_belt` 的坐标与带子重合）。第一版我用 `Map.set` 后写覆盖，得到 **1254/1255、67/67** —— 与 P0-verify 差 13 条。原因：隧道盖掉了带子的格归属。
P0-verify 的 `buildGrid`（`belt-rules.test.mjs:143-157`）是"先放带子、非带子只填空位"。我对齐成同一策略（**带子优先**），差异归零。
⇒ 这条已写进 `belt-sim.buildWorldModel` 的注释：**两侧独立实现必须有同一归并规则，否则对拍必然出差异**。P6/P7 若也用这份拍平数据做逐格对拍，同样要注意（红队 needs_live_test #2 的读盘 diff 会撞上同一件事）。

### 1.2 "proto 的 82.5% 不可复用"—— 量化了

2×2 矩阵（test.mjs 打印，C17-C20 断言）：

| originalRotation 口径 | 邻居只喂带子 | 邻居含机器 |
|---|---|---|
| `orig = r`（stride=4 粘贴后的真值，`bridge:814`） | 86.3% | **92.5%** |
| `orig = r − VARIANT_SHIFT[rv]`（proto 的 `inferOrig`） | 83.8% | 95.8% |

- 三个结论：**喂机器邻居在两种 orig 口径下都提高吻合率**（92.5>86.3、95.8>83.8）→ proto 只喂带子的 82.5% 是**低估**，其结论不可复用（plan §1.5 V3 的纪律成立）；
- 我的 belt-only+inferOrig 单元格 = 83.8%，与 proto 报的 82.5% 差 1.3pt，差值来源就是上面的层归属（proto 用 `grid.set` 无带子优先）；同一条代码路径能复现同量级数字 ⇒ 复刻本身没错。
- `world-full.json` **没有** `originalRotation`（obs 只回 `code/r/rotation_variant`，`bridge:441-456`）⇒ 无法直接重跑 proto 那一列。已在注释里写明我用 `orig=r` 的理由：那正是**粘贴后**世界的实际状态，对编译器的意义比"复现游戏当时的 orig"更直接（plan §1.6 决策 D2 说的"缺口被绕过"的确切条件就是它）。

---

## 2. 变异测试矩阵（L0 验收 1）

19 条注入 = 陷阱表 7（`MILESTONE-M4-partial-and-pitfalls.md:59-67`）+ 清单 8（`redteam:141-150`）+ 4 条补充（V2 毁带 / D1 旋转 / V10 报告口径 / S1 形状）。
每条断言 4 件事：**只**一个 fail、check id 对、`evidence.cell`+`nodeId` 指对被注入的格、evidence 命中点名的**子判据**；其余 check 不得 fail。全表 clean=true，且 11 条 check id **每条至少被一条注入命中**（B22：没有无人守的闸）。

### 2.1 归因唯一是怎么做到的（三层，不是一层"约定"）

1. **前置闸阻断**（`BLOCKED_BY`）：V8 fail → V3/V4/V5/V6/V9/S1 记 `not-applicable` 并在 note 点名 V8；V3（rv 漂移）fail → V4/V6 同理。
   理由：越界形态下 v1 的槽位表与带向真值**没有定义**；rv 漂移 ⇒ 由 (r,rv) 推导的 entry/exit 本身就错，链闭合无意义。
   ⚠️ 被阻断的 check **不删除**，一律留 `not-applicable` + 阻断者名字（D20/D21 断言：所有被染项的 note 都点名了来源，**不静默跳过**）。
2. **通道级非法边归 V5**（`edgeAudit`）：退化自环（陷阱 #3）与入度溢出多出来的那条边，V4/V6/V9/S1 **跳过**这些通道。否则一次注入报出 4 个 id。
3. **blame 键归属**（`attribute` + `DERIVES`）：只在**显式声明**的派生关系上降级。
   ⚠️ 这里我一开始做错过一次并修掉了：最初"凡键相撞就降级"，结果 golden 场景里 V4 的『输入槽空供料』与 V9 的『输出槽无去向』共享 `node:n1`+`(0,0)` 两个键，V9 被当成派生**吞掉**了 —— 那等于闸门自己把清单第 9 条弄丢。改成显式派生表后两条独立缺陷各自 fail（D11-D17 用 golden 场景重放锁住这点）。

### 2.2 陷阱表 → check id 的映射（含我的判断）

| 陷阱 | 归到 | 为什么 |
|---|---|---|
| #1 rv 由邻居派生 | V3 | 邻居含机器时 (r,rv) 不是不动点 |
| #2 对角缺口 | V4（子判据：通道走格断裂） | 缺的是"接不上的格"，属物流对齐 |
| #3 退化段 from==to | **V5**（不是 V4） | 自环是一条**非法入边**；V4 直接跳过它，避免派生噪声 |
| #4 输出/输入方向冲突 | V6（子判据：一格两股流） | 与清单第 4 条同一件事：两条流不能占同一格 |
| #5 车道必须不同行 | V6（子判据：lane 号 / 台账行） | 同上 |
| #6 不能边想边放 | **V3**（第二判据：entities 分层序） | 先放的带子在**定型时刻**邻居不齐 ⇒ 与"非不动点"同一语义；分层序函数直接 import P1 的 `entityOrderPhase` |
| #7 废弃输出必须接走 | V9 | 原样 |

V6 的三个子判据由 P4/P5/C4 三条注入**分别**命中（test.mjs 的 `sub` 断言证明不是同一条在重复计数）。

---

## 3. V7 与 0.78：我没有按字面用，也没有不用

任务书写"V7 吞吐用 rates + 弯带 0.78 折算"。我照源码把语义钉死后做了**有限使用**：

- 真值：`components/belt.js:6 curvedBeltLength=0.78`、`:64-71 getEffectiveLengthTiles()`（直带 1.0 / 弯带 0.78）⇒ 它是**弧长**。
- `routing-prior-art.md:347-352 / §7` 明确警告：0.78 → item-capacity 的换算**没有任何一手文档给出公式**，"不要直接拿来算吞吐"。
- 折中：V7 只在**链路被带子卡住**（min 机器速率 ≥ belt 2.0/s）时把 `derate=(直格+0.78×拐角)/(直格+拐角)` 折进判定；机器限速时（本项目所有 op 的 base 速率 ≤ 2.0/s）不改稳态件/s，但**照样把拐角数、有效带长、derate 写进 evidence/note** —— "拐角不免费"（ADVERSARIAL:221-223）方向保留，数值不假装精确。
- `demandPerSec=0` ⇒ `not-applicable`（plan §0 的"只要能跑通"），与 plan-l1 fixture 存的 status 逐条相同（A19）。
- `rowsPlanned` 的定义我改了：不是 `layout.rows.length`（那是 **DAG 层数**，plan-l1 里 =3 而实际 1 行），而是**瓶颈机器的实例数**（一台 2×1 记 1 行 —— 占地是格数不是行数）。与 fixture 存的 `rowsPlanned:1` 现在一致（A22）。

⇒ **待主线程/实机裁决**：0.78→capacity 的真实换算。验证办法同 prior-art §7 提的：两条等长、只差一个拐角的带子喂同一批 item 测稳态间隔。在此之前 V7 的数值口径应视为"下限估计"。

---

## 4. 发现的他包/文档缺陷（未改，点名）

| # | 位置 | 现象 | 建议归属 |
|---|---|---|---|
| F1 | `research/ai-player/plan-compiler.md` §5 的 L1.5 命令 | `node src/ai/compiler/validate.mjs --plan research/ai-plan/harness/out/*.validator.json` 喂的是 **ValidatorReport**（P5 的产物），不是 plan/layout。第一版 CLI 直接 throw。 | 文档命令与 P8 交接格式要对齐；我已让 CLI 三种输入都接（CompiledPlan / LayoutReport / ValidatorReport），报告走"自洽审计"。 |
| F2 | 同上 §2.3 `hubConnection` 的语义 | **已裁决（主线程）**：`entry` = **带子末格**。我的读法与之相同（反推 anchor = entry 按 side 偏移），并**用 P3 真产物复核过**：`place({hub:[1200,-1400]})` 输出 `hubConnection={entry:[1200,-1396],side:"bottom",dir:0}` ⇒ anchor = entry+[0,-4] = [1200,-1400] = hub 锚点，与 `hubEntriesWorld` 的 bottom 面逐字一致。三方（P3 `hubEntriesWorld.cell` / P5 K 组 / 裁决）合流，无冲突。 | 批次收敛时主线程把定义回写进 plan §2.3。我的 K1-K9 已锁住该读法。 |
| F3 | `src/ai/compiler/route.mjs` 的 `CORNER_COST_TILES = CURVED_BELT_LENGTH` | 我按 `CORNER_COST_TILES = <数字>` 做正则对拍，取不到值（P4 还在写，可能又变）。改成两级解析（直接数字 / 别名再解一次），A3/A4 现在绿。 | P4 若把该常量改名或改结构，A3 会**先红**（这正是想要的耦合报警）。 |
| F4 | `research/ai-plan/fixtures/report-validator.json` 的场景是**示意**的 | 它的 `V2 的 nodeId="belt@5,0"` 与 `beltSim.tilesChecked=4`（规划区有 (5,0) 又有 (6,0)）需要一张我这边不存在的图。我用一张等价的小图重放，复现了它的全部三条 fail id、三条 failingNode 格、以及**逐字段相同**的 drift（`{cell:[6,0],wantRv:2,gotRv:0}`）（D11-D17）。 | 无冲突，只是记录：golden 的"场景"不可直接喂给我，能复现的是它的**结论**。 |
| F5 | `world-full.json` 的拍平层（见 §1.1） | 不是 bug，但是**会咬人的数据形状**：任何用这份快照做逐格归属的代码都必须定义同格优先级。 | 建议在主线程的快照口径里写一句"带子优先"。 |

## 5. 契约缺口（不阻断，但要显式）

0. **V6 的车道台账判据偏保守**：`lanes[].channelIds` 出现 **>1 条**就算冲突（陷阱 #5 的字面读法"两条车道必须不同行"）。
   若将来 P3 允许"同一行承载两条**同 payload** 的通道"（fan-out 到两个目的地），本判据会误报 —— 但
   `LayoutReport.lanes` 没有 payload 字段，`channelIds` 又是 `"chB"` 这种不透明串（无 schema 保证与
   `channels[]` 下标对应），**在不 import P3 的前提下无法反解 payload**。当前选择：宁可保守误报（可解释、
   可归因），不静默放过。⇒ 建议 P1 给 `lanes[]` 加 `payloads[]` 或让 `channelIds` 明确成 channels 的下标。

1. **`op` → `kind` 无映射函数**。P2 的 `TEMPLATES` 以 op 为键（`mine/cut/stack/…`），`LayoutReport.placements[].kind` 是 `miner/cutter/stacker`，两套名字不同且 P2 没导出 op→kind。我在 `resolveNode` 里做 `TEMPLATES[p.op] || templateByBuildingVariant(p.kind,"default")` 兜底（H3/`resolveNode` 注释）。⇒ 建议 P2 补一个 `kindOf(op)` 导出，P3/P4/P5/P6 都会需要（P6 的 code→kind 反查是同一件事的另一半）。
2. **`LayoutReport` 不带 `entities`（带子意图表）**，而 V3/V4/V6 必须知道每根带子的 `(r,rv)`。plan §2.3 只在 `CompiledPlan.entities` 里放它。⇒ P8 走"plan 整体"没问题；**单独**跑 `--plan report-layout.json` 必须 `--intent`，否则我给它 **UNDECIDABLE + 退出码 2**（G6/G7），而不是放行。P1 已在 `contract/merge-belt-intent.json` 放了这份附表，我按只读用。
   **【已裁决并落地】**主线程裁定「P8 交接必须永远带 intent 文件」⇒ 已写进 P8 任务书。我的 UNDECIDABLE/exit-2 行为正是这条裁决的**离线兜底**：即便 P8 漏传，闸也只会拒判、绝不会把"没有带子可判"误报成绿灯。G6/G7 就是锁这条的。

3. **`hub` 的 16 入口只有 `acceptor`，没有 ejector**（`hub.js:73-91`）⇒ hub 不能作为带子的上游邻居。V4 的槽位对齐因此对 hub 只查"带子出口落进入口槽"这一侧，符合语义，但值得在 §2.3 显式写一句。

4. **【新发现，非本包文件】世界系 `hub` + 局部系 `placements` ⇒ 一条 ~2600 格的离谱带子。**
   用**真 P3/P4** 跑 `place({steps:[cut], hub:{x:1200,y:-1400}})`（世界系 hub）+ `routeAll` 复现：
   `bbox=[1204,1409]`、`beltCells=2604`、带格跨 `x 0..1200`、`hubConnection={entry:[1200,-1396],side:"bottom"}`。
   根因：`place()` 只在 `pickResourceCells` 里把 `input.site/hub` 当**资源搜索中心**（place.mjs:627），
   机器 `placements` 仍从局部 (0,…) 起排；而 hub 占地位在世界系 (1200,-1400) ⇒ 连接带要从局部一路铺到世界系 hub。
   P3 自己的 test 全程 `connectHub:false`、从不传 `hub:`（test.mjs:86，逐行核过），所以这条路径没被走到过。
   - **闸的实测行为（不是我推测的）**：`validate()` 判 **pass:false / fails=["V3-belt-fixed-point"]**
     （"第 1402 项 belt/rv=0 排在 belt/rv=2 之前" ⇒ 陷阱表 #6 的分层序判据先命中），
     并按 BLOCKED_BY 把 V4/V6 记为 not-applicable；V1 因两侧不重叠而 pass。
     ⇒ **方向对（一定不放行），但归因是"施工顺序错"而不是"坐标系不一致"** —— 人读 note 会被引偏。
   - **归属**：P3⇄P8 的坐标系约定，不在 P5 范围。两个选项交主线程：
     (a) P3 内部把 placements 平移到 site 系（但 P3 NOTES §1 明说"坐标不平移"是有意的）；
     (b) P8 在调 place 前自己把 hub 换成局部系、并在 emit 时换回世界系（plan §2.1 的 `site.anchor+[dx,dy]` 本来就是这套）。
     我倾向 (b)：契约里 `entities[].dx/dy` 已经定义成"相对锚点"，(a) 会与 §2.1 冲突。
   - 若要闸直接点名，可加一条"bbox 尺寸 ≫ 通道数×上界"的 sanity；但那会用一个几何启发式去伪装坐标系问题，
     不如把归因留给 P8 的装配步骤（它才知道 hub 是哪个系）。**P5 不擅自加**。

## 6. 我改了主意/修过的自己的 bug（诚实记录）

| 症状 | 根因 | 修法 |
|---|---|---|
| 所有 fixture 都"没有带子"、V3 恒 not-applicable | `.filter(isBeltKind)` 把 entity **对象**当 kind 传 | 改 `.filter(e => isBeltKind(e.kind))`（4 处） |
| `V4-slot-alignment crashed: unfed is not defined` | 分节 Edit 把定义块挤掉了 | 重写 V4 主体，一条判据一个块 |
| `receiverAt` 崩（读 undefined 的 `[0]`） | 它读**模板**的 `.cell`（局部）却当世界格比 | 改走 `worldSlotsOf(...).inputs`（`.tile`） |
| plan-l1 的 V4 假 fail（hub 槽方位不符） | 把 hub 的**入口格**当**锚点**用，16 槽全错位 | `hubAnchorOf`（world > occupancy > entry 反推） |
| hub 顶/左/右三面反推错 | 反推硬编码 `y-4`（底排专属） | FACE 表 + 用 P2 `hubEntriesWorld` **自证**，猜不出返回 null（K2-K6） |
| 存档对拍差 13 条 | 层归属（§1.1） | 带子优先 |
| `iterate:true` 让测试从 3s 变 43s | `beltStateToWorld(world, state)` 写在逐格循环里 ⇒ O(n²) | 提到每轮一次；并把迭代改成 opt-in（权威判据是逐格单步） |
| golden 重放丢 V9 | "凡键相撞就降级"（§2.1 第 3 点） | `DERIVES` 显式派生表 |

## 7. 待办（若开 P5 第二轮）

1. V4 的 `+y 系与 painter(+x) 系不串同一直线`（清单第 5 条）目前只能被"槽位方位不符/端点不在槽位上"**间接**抓到（C5 注入就是这么被接住的）。要直接抓需要 P3 的 flowAxis 标注或我自己按 kind 判定 —— 后者会重复 P2 的表，暂不做。
2. 颜料通道**可达性**（清单第 6 条）：现在抓的是"输入槽没供料"（C6），mixer 产 cyan 那条链的可达性属于 P3/P4 的作图正确性，不在离线闸的能力范围内，未实现。
3. `paste dry_run` 缺口下，V2 只判"零重叠"，判不了**破坏半径**（plan §2.4 已承认）。P7 的 F1 实验是唯一凭据。
4. V10 忠实玩家口径（定位 A）只有 `enforceUnlocks:true` 开关；真要做游戏循环（交付中间形状升级）不在任何包范围内（SYNTHESIS §5.2）。
