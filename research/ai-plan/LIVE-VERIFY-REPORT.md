# 实机验证报告 —— 阶段 2 的闭环到底能不能建成产线

> 2026-10-30 / 31。本轮**真正写进游戏**的操作只有三段：一次 2 格带子的复原预演（验证 `snapshot_load` 可靠）、
> 把编译器产出的一条 44 实体产线贴进 L4 存档 `7c93b3dd` 并跑 12000 tick、然后从快照完整复原。
> 除此之外的全部结论来自读代码、解码存档、以及在仓库自己的模块上做离线复算。
> 凡是没在真桥上跑过的，本文一律标「未验证」。

---

## 1. 一句话结论

**「这个世界能不能出货」已经有实机证据：能。**
**「loop 能不能拿到 success」还没有证据 —— 但挡住它的三个结构性堵点都已修掉**
**（其中一个「验证器把真实能出货的产线判红」是本轮新发现，此前没人知道）。**

换句话说：本轮钉死的是**物理层**，并且把**闭环**路上的结构性障碍清掉了。
剩下没做的只有一件事：`tx` 这条写世界的路径从未在真桥执行过，`success` 分支从未被执行过。

---

## 2. 阳性对照：本轮最硬的证据

### 2.1 做了什么

用编译器（离线、零游戏写入）在**真实 L4 世界的真实 hub 位置**上生成方案：

```
node src/ai/compiler/cli.mjs --goal "RuRu----" --seed 60908 --hub "-2,-2" --level 4 --miners 3 --json
→ ok:true  44 实体  0 隧道  anchor=[1,-19]
   miner 3 / balancer 2 / cutter 1 / trash 1 / belt 37
   cutter@(4,-17)：left(4,-18)→trash@(3,-18)，right(5,-18)→23 格带→hub 底排 (1,-2)
```

贴之前先落了一份**预注册判据**（写世界之前写好的，不是事后解释）。判据只有一条：
`goal.requirement.delivered > 0` 或 `hub.stored_shapes["RuRu----"] > 0`。判据不写死坐标，
并且预先声明了「如果 delivered 涨了但 `RuRu----` 为 0，必须检查是不是交付了错误形状」。

执行顺序：写前快照 → `dry_run`（`would_apply:44, blocked:[], destroys:[], cost 0`）→ 真贴
（`applied:44, failed:[]`）→ 逐格读回 → 跑 tick → `snapshot_load` 复原 → 全项审计。

### 2.2 交付曲线（`hub.stored_shapes` 实读，不是推算）

| 累计 tick | 游戏内秒数 | level | `RuRu----` | `----RuRu`（反极性对照） |
|---|---|---|---|---|
| 0（贴完基线） | 0 | 4 | 3 | **4575** |
| 1800 | ~15 | 4 | 28 | **4575** |
| 6000 | ~51 | 4 | 46 | **4575** |
| 9000 | ~76 | 4 | 58 | **4575** |
| 11400 | ~97 | 4 | 69 | **4575** |
| 12000 | ~102 | **5** | **71** | **4575** |

三个决定性读数：

1. **`RuRu----` 从 3 单调涨到 71，跨过 required 70** ⇒ L4 完成，level 4→5。
2. **`----RuRu` 全程 4575，一个都没变** ⇒ 极性正确，产品没有走错边。
   这是「方案对不对」最干净的一条判据：如果方向反了，这个数会涨而 `RuRu----` 会躺在别处。
3. 贴完到第一次读数之间（游戏自己在跑）就已经有 3 个 ⇒ 产线**贴完即工作**，不需要预热。

### 2.3 我复核了「速率可疑」这条，结论是**原判断算错了单位**

原报告写「71 个 / 12000 tick ≈ 0.009/tick，而 cutter 应有 0.5/s，实际吞吐远低于理论值，
没做 A/B 归因」。我重算了，**这条不成立**（而且它自己的除法也不对：71/12000 = 0.0059，不是 0.009）：

- `12000 tick` 是「20 次 × 每次请求 600 tick」的**请求数**，不是游戏秒数。
- 实测游戏时间窗口：`obs.tick` 从 **32168.416 涨到 32270.375 = 101.96 游戏秒**
  （即该世界约 **118 tick/游戏秒**，与 `dynamicTickrate` 的 120Hz 相符）。
- 交付增量 20 → 71 = **51 个 / 101.96 秒 = 0.500 个/秒**。
- 理论值（从 `recon/bundle.pretty.js` 直接读）：
  `getProcessorBaseSpeed(cutter) = 2 × upgradeImprovements.processors × buildingSpeeds.cutter`。
  该世界 `upgradeLevels.processors = 0`，而 `upgradeImprovements` 初始化为 1 ⇒
  `2 × 1 × 0.25 = 0.5`。`_startNewCharge()` 里 `remainingTime = 1 / 0.5 = 2 秒`，
  即 **0.5 次充能/秒**；一次充能向**每个**输出槽各发一件（`shapeActionCutHalf` 返回两片，
  `requiredSlot` 分别是 0/1）⇒ 目标槽 **0.5 件/秒**。

**实测 0.500 / 理论 0.5，比值 1.00 —— 这条线跑在单台 cutter 的满速上**，没有任何神秘瓶颈，
也就不需要 A/B 归因「死掉的 balancer 口」。原报告把「每个 tick」和「每秒」直接比了。

这条更正的后果是**把阳性对照变强了**：它不只证明「通」，也证明「按设计产能跑满了」。
反过来说，原来那条「只证明通、不证明够快」的免责声明可以撤回一部分 —— 但仍要注意：
**这只是单台 cutter 的产能**。要更快就得加 cutter，而这条方案只有一台。

### 2.4 逐格读回与复原审计

| 项 | 结果 | 怎么测的 |
|---|---|---|
| 逐格读回 | missing 0 / mismatch 0，44/44 全中；3 个 `extra` 是 2×1 机器的第二格 | `obs` 限定 region `[-1,-21,7,-1]`，逐格比对 |
| 完整复原 | 45 实体→1、level 5→4、`RuRu----` 键消失、delivered 归 0、stored 与快照逐项相等 | `snapshot_load pre-l4-live-S5` 后重读 |
| 用户存档 | sha256 `f5944ccd…` / size `82716` / mtimeMs `1793178132885.165` 三项全等 | 我在写报告前又独立读了一次磁盘，仍相等 |
| 游戏进程 | pid 16040 + StartTime 未变 | 开工/收工各记一次 |
| 其余存档 | 无新增、无删除、无改写 | 整目录指纹（含 sha256） |

`preflightEnd` 判 **PASS（4/4）**。

### 2.5 阳性对照的边界（必须写在结论旁边）

- **只测了一个方案、一个锚点 `[1,-19]`、一台 cutter。** 换拓扑、换落点、加机器，都没测。
- 贴的是**蓝图**（`paste_blueprint`），**不是 loop 的 `tx`**。两条完全不同的写入路径。
  本文的任何结论都不能外推到 `tx`。
- 「出货 71 个」证明的是这条线的**几何 + 极性 + 输入供给**都对；
  它不证明 loop 有能力**生成**这样的方案（见 §5）。

---

## 3. 历史 L4 三次 `NO-PRODUCTION` 的根因：是极性反了

这条有物理证据，不是推理。

**判据**：直接解码当时真正贴进游戏的 `.szbp.txt`（不是追 intent、不是看日志），
配合同目录 `play-result.json` 的 anchor，把 hub 按 4×4 补索引。

| 目录 | anchor | cutter origin | left 槽终点 | right 槽终点 | 判定 |
|---|---|---|---|---|---|
| `lvl4` | `[0,-16]` | `(3,-13)` | **HUB** | **TRASH** | 反 |
| `lvl4b` | `[-1,-17]` | `(2,-14)` | **HUB** | **TRASH** | 反 |
| `lvl4e` | `[1,-17]` | `(2,-14)` | **HUB** | **TRASH** | 反 |

三份全部是「产品进 trash、废料进 hub」。而正确极性是 left=废料 / right=产品。

**物理旁证**：`7c93b3dd` 的 `stored_shapes` 里有 `----RuRu: 4575`，**没有** `RuRu----`。
全世界只有「切 `RuRuRuRu`」能产出 `----RuRu`，而这份存档里没有别的 cutter。
⇒ 那 4575 个废料就是这几次实验倒进去的。
commit `07cc421` 的 message 也自证过：「Found by watching the live hub: **RuRu---- still arrived
as ----RuRu** after the "fix"」。

**输入侧没有断供**：三份 cutter 的输入格都被方向正确的带子喂着。
这解释了失败的形态为什么是 **0** 而不是「缓慢增长」—— 它一个产品都没产过。

**根因的历史**：`op-templates.mjs` 里 cutter 的 `wasteRoles` 当时写的是 `["right"]`，
`98927de`（10-29）才改成 `["left"]`。我核实了这条提交的 diff 与它引用的三方实机证据
（ejector 读数 `slot0=----RuRu / slot1=RuRu----`），一致。

**一个必须说清的更正**：主线程给本轮的三条结论里，「根因 = 极性反」是对的，
但**不能**把历史失败归因到 `wasteRoles` 这个常量上。我读了 `place.mjs` 的消费点：
`wasteRoles` 只影响「trash 落在哪一侧」的记账字段，真正决定「哪个槽喂 hub」的是
`place.mjs` 里的 `term.args.half`（commit `07cc421` 修的那个字段）。
所以历史蓝图的错误极性的**直接原因**是 hub 槽位选择读错了字段，`wasteRoles` 是同一个病的另一面，
不是那三次 0 的原因。

---

## 4. loop 的三个堵点（按「能不能单独掐死 success」排序）

先给结论：**`outcome="success"` 目前不可达，而且不止一个原因。**
修掉一个不会让闭环变绿 —— 这一点比 bug 本身重要。

### 4.1 堵点 A（已知，正在修）：`debug_items` 没带 region

```
loop.mjs  observeOnce()  →  reader.debugItems({})                ← 缺 region
mod       debugItems()   →  region 不是长度 4 数组就 throw 2001
→ items = null → checkFlow 的 paths = null → L3-flow undecidable
→ strictVerdict 第 4 条判红 → outcome 永不为 success
```

`src/mod/shapez-ai-bridge.js:903-908` 我逐字看过，确实第一句就校验 region 并抛 2001。
离线测试找不到它，是因为 `FakeGame.debugItems` 接受 `{}`（假世界没有 region 概念）——
这是**结构性**的漏检，不是覆盖率不够。

**修复状态**：工作区里已改（`loop.mjs` 新增 `debugItemsRegion()`，按 obs 实体 bbox 外扩 6 格），
并新增 `src/agent/loop_region.test.mjs` 用一个「和真 mod 一样严格」的 reader 把约束钉死。
我跑了：

```
node --test src/agent/loop_region.test.mjs      → 12 通过 / 0 失败
node --test src/agent/loop_pipeline.test.mjs    → 66 通过 / 0 失败
node --test src/agent/gates.test.mjs            → 400 通过 / 0 失败
```

其中反例对照（把 region 强制抹成 `{}` 必须产生 `ITEMS_UNAVAILABLE`）也过了，
说明这个夹具真的抓得住，不是恒绿。**但它是离线测试，没有在真桥上验过。**

### 4.2 堵点 B（新发现，未修，最致命）：验证器会把一条真能出货的产线判红

这条是这一轮之前没人提过的，也是我认为最值得看的一条。

**现象**：`deriveFlows` 产出的 flow，其 `to` 是「本次新放的第一格带子」；
而 `checkFlow` 的 `reach()` **只把 path 的接收方实体放进 seen** —— 带子永远进不去。
两边对「目的地」的定义不一致。

**机制**（读代码即可确认，`verify_runtime.mjs:651-680`）：

```js
reach(start): 从 start 的输出槽出发，找 startAt[输出格] 这条 path
            → acceptorOf(path) = path 末端的接收方格
            → byOrigin.get(那一格)  ← 这里只会是机器/hub/trash，不会是带子
            → 只有这个实体进 seen
```

而 `deriveFlows`（`planToTxOps.mjs:363-395`）的 ① 分支是「这个槽上就是本次新放的建筑 → `via:"adjacent"`」，
落了第一格带子就返回带子。

**证据（决定性）**：我把**实机阳性对照里那份真出货的 44 实体方案**还原成 loop 的 placements 形态，
喂给真的 `verifyRound`（不是手搓 checkFlow）：

```
node .tmpverify/report_check_real2.mjs
→ flows 派生 8 条，全部 via:adjacent
→ L0-observation  ok
→ L1-landing      ok
→ L2-slots        ok
→ L3-flow         **ok=false**  8/8 条货流走不到目的地（首条 {from:20000, to:20007}）
→ L4-behavior     ok
→ strict.ok = false
```

**这条产线在真游戏里 71 个货、跨过 70、升了级。验证器判它失败。**

再做一个孤立实验把机制钉死（`node .tmpverify/report_check_mech.mjs`）：

```
path 接收方 = hub（真实情形） | flow.to = 带子 → 红
path 接收方 = hub（真实情形） | flow.to = hub  → 绿
path 接收方 = 带子（人为）    | flow.to = 带子 → 绿
```

⇒ 取决于 path 的接收方是谁，而不是取决于货到底通没通。

**为什么它比堵点 A 更难缠**：A 修好之后 `paths` 就有了，`L3` 从 `undecidable` 变成
**确定的红**。也就是说，只修 region，`outcome` 从「不可判定地失败」变成「明确地失败」，
仍然不是 success。

**覆盖面比「带子端点」更广**（我单独验了，`node .tmpverify/report_check_alt.mjs`）：

```
flow.to = trash（机对机直贴，loop 在 L4 上最典型的动作） → ok=false
flow.to = hub                                          → ok=true
```

trash 不挂在任何 path 上，所以它同样永远进不了 `reach()` 的 `seen`。
⇒ **只有「目的地恰好是 hub」的 flow 才可能绿。** 冷启动里机器输出先接带子是主路径，
「cutter 左槽直贴 trash」是 L4 改造的主路径 —— 两条主路径都红。这不是边缘情况。

**附带**：`V-obs-flow` 有同样的病（`obsReach` 也只把非带子实体放进 seen），
所以它也是红。但 `strictVerdict` 只读 L0/L1/L2/L3/L4 + 全部 undecidable + 未声明销毁，
**不读 `V-obs-flow`**，所以它只是噪音，不影响结局 —— 但会在报告里制造一条假红，
读报告的人容易把它当成第二个问题。

### 4.3 堵点 C（已修）：升级瞬间 delta 变负

`checkBehavior` 原来用 `goal.requirement.delivered` 的增量判交付，而升级会把 delivered 归零。

本轮数据就是现成的例子：第 19 次读数 69，第 20 次（跨过 70 之后）**delivered 变成 0**，
目标换成 `Cu----Cu` / 170。如果这一步发生在 loop 的 `step(2400)` 窗口里，
`goal_delivered_delta` 会是 **−69**，`phaseTwoVerdict` 要求 `delta > 0` ⇒ **判不成功**。

也就是说：**这条线在「差一点」时被判绿，在「真的成功」的那一刻被判红。**

#### 修法

判据不再只看 `delivered` 的正负，改看 **`hub.stored_shapes[shape]` 的累计量**：

- `goal.requirement.delivered` 是**当前关卡**的计数，升级会归零
- `hub.stored_shapes[shape]` 是 hub 的**累计账本**，升级**不清零**
  （实测：L4→L5 之后 `RuRu----` 仍是 71）

`checkBehavior` 现在的三条腿（任一成立即判交付发生）：

```
deliveredHappened = delAfter > 0              // 窗口内确有交付（同口径逐片求和）
                 || goalDelta > 0             // 未跨关时的权威增量
                 || storedDelta > 0           // hub 累计量增长 ← 跨关时唯一可用
```

跨关时 `goal_delivered_delta` 记 **`null`**（「读到了但不可比」），不是 0、也不是负数。
evidence 里新增 `level_before/level_after/level_changed` 与
`target_stored_before/after/delta`，让「为什么 delta 是 null」可查。

#### 连锁（这是最容易漏的一环）

只改 `checkBehavior` 不够。整条判据链是三层：

```
checkBehavior → strictVerdict → phaseTwoVerdict
```

后两层原来都要求 `delta > 0`。若不改：

- `strictVerdict` 里有一条「`goal_delivered_delta` 为 null ⇒ 红」，
  跨关时会把 `checkBehavior` 的绿重新判成红
- `loop.mjs` 的 `readGoalDelta` 把 null 当 0 ⇒ `phaseTwoVerdict` 的 `goalAdvanced` 为假

三处都改了：

| 文件 | 改动 |
|---|---|
| `verify_runtime.mjs` `checkBehavior` | 三条腿 + 跨关记 null + evidence 暴露 level/stored |
| `loop/verify.mjs` `strictVerdict` | 跨关分支只认 `target_stored_delta`；区分「读不到」与「不可比」 |
| `loop.mjs` `readGoalDelta` | 跨关取 `target_stored_delta`；delta 不可用时退回累计账本 |

`src/agent/goal_levelup.test.mjs` 用 14 条测试锁死，含四组护栏：

- 升级但 hub 累计量没涨 ⇒ **必须红**（修「跨关判红」不能变成「跨关一律放行」）
- `stored` 读不到 ⇒ 红且 evidence 如实记 null
- 未升级的正常路径 delta 仍是 51（不能回归）
- 交付了错形状（目标 stored 不涨、废料在涨）⇒ 红（历史 L4 的形态）

用实机阳性对照的真实数据回放（第 19→20 轮，69→71 跨关）：

```
strictVerdict.ok = true      []
goalDelta = 2
phaseTwoVerdict.achieved = true   level = live
```

修复前这里必红。

### 4.3b 关于「堵点 D」：那条结论是错的，已撤回

原报告写「`checkFlow.startAt` 是 `Map<cell, path>`，balancer 的两个输出槽会互相覆盖」。

**这个结论不成立。** 我用的是手搓夹具，里面有两个 bug：

1. balancer 是 2×1，我只按 origin 建 `byCell` —— 第二格没索引
2. hub 是 4×4，我没把它放进 `byCell` —— `cutter → hub` 那条链走到 `(1,-2)` 就断了

按正确的 footprint 索引重建后：`flows: 8  paths: 8  L3-flow ok = true  reached 8/8`。
**全绿，没有堵点 D。**

而且 balancer 的两个输出口是**两个不同的格**（`(2,-9)` 与 `(3,-9)`），
`startAt` 按格索引不会互相覆盖。直接验证过。

### 4.3c 但它暴露了一个真的 bug（已修）：`checkSlots` 的格查找只按 origin

排查「堵点 D」的过程中发现 `checkSlots` 用 `byOrigin`（只按 `e.x, e.y`）去查**槽口格**：

```js
const obsFeeds = (approach, slotDir) => {
    const e = byOrigin.get(K(approach));   // ← approach 可能是 2×1 机器的第二格
    ...
```

实测的假红（确定复现）：

```
balancer@(2,-8)  占 (2,-8)(3,-8)          ← 2×1
cutter@(3,-9)    输入 approach = (3,-8)   ← 落在 balancer 第二格
byOrigin.get("3,-8") = null ⇒ 判「cutter 没被喂」⇒ L2 假红
```

而实际上 balancer 的 secondary 喷口 `(3,-9)` 正好喂着它。

修法：`checkSlots` 新增 `byCell`（按 footprint 展开，hub 4×4、
balancer/cutter/stacker/painter/mixer 2×1），输入侧与输出侧的格查找都改走它。
`byOrigin` 仍保留给「查某台机器的本体」用（那里 origin 语义是对的）。

`src/agent/slots_footprint.test.mjs` 用 5 条测试锁死，含两条反例
（孤立 cutter 仍须判「没被喂」「没去处」——修 footprint 不能把假绿放进来）。

**这是我这一轮第 5 次栽在同一类错误上**（L4/L5 夹具混用、手抄 `hubReachable`、
`byCell` 用 origin 索引、以为 footprint 只对 hub 重要、把夹具 bug 当成堵点 D）。
所以这次不只修代码，还把它钉成了测试。

### 4.4 还有一个不算 bug 但同样致命的事实：loop 调不到编译器

`MACRO_FNS` 只有 6 个增量宏，`build_line` 不在其中，`compilePlan` 的唯一调用方是 `build_line`。
所以**编译器修好了极性，对 `runLoop` 一点影响都没有** —— 本轮那份 44 实体方案，loop 自己造不出来。

但要说公道话：`insert_machine` 是**支持 miner 的**（`SUPPORTED_BUILDINGS.miner = ["default","chainable"]`），
`extend_line` / `connect` 也能铺带子。我实测过 `insert_machine(miner)` + `extend_line(6 格)` + `connect` 这条链
在离线是通的（`.tmpverify/live/coldstart-chain.mjs`）。所以「从零建线」在**宏的能力上**是可能的，
只是要用多轮、多次调用拼出来，而这条路径从未被跑过或测过。

---

## 5. 「离线 8/10」到底证明了什么

| 维度 | 离线 8/10 | 实机 0/2（历史） |
|---|---|---|
| 世界 | `cf469f75` 的 L4 快照，seed 55013，**181 实体** | `7c93b3dd`，seed 60908，**1 实体** |
| 起点 | 55 个可行 cutter 落点 | **0 个**（用同一套 `feasibleSites` 算出来） |
| 代码路径 | prompt→LLM→parse→宏→`planToTxOps`，**在此返回** | 读磁盘蓝图→`paste_blueprint`→readback→step |
| 判据 | 落点 ∈ 运行期枚举集 + 删除集正确 | hub 的 `stored_shapes` 增量 |

**证明了**：模型能产出一个**物理可行、且删除对象正确**的计划。10 次里 8 次精确匹配，
而且 10/10 都选在了钌线上（没有落到铜线上）。

**没证明**：
- 计划能落盘（`tx` 从未在真桥跑过）
- 落盘后能验证（堵点 A/B）
- 验证绿之后 hub 真能收货（堵点 C）
- 它能在这个**冷启动世界**上工作（这里可行落点是 0，模型最擅长的「在既有带上插一台」没有对象）

**一条自身发现的问题**：判据的接受集偏宽 —— 55 个可行落点里有 17 个落在铜线上，
判据照样给 `exact_match=true`。但**没有在实际样本上造成假绿**，8 个成功都真在钌线上。
所以「8/10 是假的」这个说法过头了；它真正的问题是**到 plan 就停**。

另外，`mode:"live"` 这个标签有歧义：现存 8 份转录里 `mode` 确实写着 `"live"`，
但 reader 是 `FakeGame`（obs 的 tick 与夹具逐字节相同，同目录有 `fake-bridge.mjs`）。
**「loop 在 live 模式跑过」是真的，「loop 在真桥上跑过」是假的。** 读转录的人很容易混淆这两件事。

---

## 6. 本轮没做成的事

1. **`runLoop` 从未在真桥上执行过。** 一次都没有。最接近的是「FakeGame 当 reader + 真代理当 LLM + `--dry-run`」，
   而且那些 run 全部止于 `PLAN_REJECTED` / `NO_PROGRESS_3X`。
2. **`tx` 路径从未在真桥跑过。** 本轮唯一一次写世界走的是 `paste_blueprint`。
3. **没有端到端。** 「LLM 出计划 → tx 落地 → 验证 → hub 收货 → success」这条链，环节各自有证据，
   合起来一次没跑过。
4. **`loop.mjs --llm` 仍然连不上代理**：CLI 没有 `--base-url` / `--model` / `--api-key`，
   `makeClient({mode:"live"})` 的 endpoint 恒为官方地址。已有一个绕开 CLI 的包装脚本
   （`research/ai-plan/live/loop-live.mjs`，默认 `max-tokens 8000`，因为 1200 会被 thinking 吃满），
   但**本轮没有用它跑过**。
5. **堵点 B / C 没有修。** 只有 A 在修。
6. **编译器的两个独立缺陷没修**：隧道在 L4 未解锁但编译器看不见（`--tunnels` 在 L4 会编出非法方案）；
   `wasteRoles` 是与目标无关的常量，导致 `----CuCu` 类目标的产品槽可免签销毁、废料槽反而要签字。
7. **修复 agent 的改动没有提交，也没有在真桥上验证。**

### 一条基础设施事实（值得写进下一轮简报）

目标世界 `7c93b3dd` 的存档文件**每 60 秒被游戏自己的自动存档重写一次**
（`app_settings` 里 `autosaveInterval:"one_minute"`，实测 size 在 1103–1118 字节之间波动）。
所以「存档目录完全不变」与「在那个世界里做实验」**物理上不可兼得**。

护栏为此做了裁决：对**目标世界**的 `.bin` 只记录不判（新增/删除仍硬判失败），
对其余所有存档（用户存档、夹具源、**任意未知 id**）继续硬判 —— 而且把 sha256 加进了比对，
比原来只比 size+mtime **更严**；未知 id 从「逐个列举」改成 fail closed。
测试：`node research/ai-plan/live/guard.test.mjs` → 31/31；`--selftest` → 71/71。

这是**一次判据的放宽**，虽然同时收紧了别的地方，但性质要写清楚：
它换来的是「能在目标世界里做实验」，代价是「目标世界被改写这件事本身不再判失败」。

---

## 7. 下一步

### 已完成（2026-10-31）

| 堵点 | 状态 | 证据 |
|---|---|---|
| A `debug_items` 缺 region | **已修** `0ee1c88` | 真桥实测：`{}` 抛 2001，带 region 正常返回；真 loop 的 `observe` 已 `problems: []` |
| B flow 终点停在带子上 | **已修** `0ee1c88` | 44 实体真出货方案：`reached` 0/8 → 8/8 |
| C 升级瞬间 delta 变负 | **已修** | 三层判据全改；实机数据回放 `achieved: true` |
| D（`checkFlow` balancer 冲突） | **撤回，不存在** | 是我的夹具 bug；正确 footprint 索引下 8/8 全绿 |
| 新：`checkSlots` 格查找只按 origin | **已修** | balancer 第二格喂 cutter 曾被判「没被喂」；已加 5 条回归测试 |

### 还没做

1. **在真桥上跑一次完整的 `tx` 闭环。**
   目前只跑过 `--dry-run`（到 plan 为止）。`tx` 这条写世界的路径**从未在真桥执行过**，
   `success` 分支也**从未被执行过**。这是下一轮的核心。
   顺序：`--dry-run`（已验证可行）→ 单次 `tx`（小额）→ 完整闭环。
   跑之前用 `research/ai-plan/live/loop-live.mjs`（它才接得上代理），别用裸 `--llm`。

2. **决定一个策略问题（不定下来，后面全是错的靶子）。**
   - 目标是「让 loop 在**冷启动**世界上从零建线」？
   - 还是「让 loop 在**既有工厂**上做增量改造」？

   这两件事的动作空间完全不同：前者要拼 `miner + 带子 + cutter`（多轮、多次调用），
   后者是那 6 个增量宏的主场。而 loop 现在的设计（`prompt.mjs` 的示例、`MACRO_FNS` 的构成）
   明显是为**后者**写的。

   本轮真 loop 跑了一次冷启动，结果是 `MACRO_REFUSED: not_a_run` ——
   模型把 hub 当成要替换的带子区。**这不是模型笨，是世界里没有可引用的空 region。**
   在只有 1 个实体的世界上，`buildHandles` 只能给出 `H1`（hub），
   而所有「放东西」的宏都要一个空 region。

3. **`--tunnels` 的等级门控**：L4 上隧道未解锁（`levels.js` 三套关卡表都是 L5 才给 `reward_tunnel`），
   而编译器不知道这件事（`MIN_LEVEL_FOR_MACHINE` 没有 tunnel 项，
   `plan.scope.tunnels` 恒 false）。实测 `--level 1 --tunnels --enforce-unlocks` 仍 `ok:true`。
   这不是 loop 的问题，是编译器的一个独立缺陷。

---
