# `painter#13552` 的 color 槽 `(-4,15)` 为什么是空的

2026-11-23。**全程离线**：只读 `research/ai-plan/runs/`（575 个 run）与 git 历史。
没连游戏，没改 `src/`。

---

## 一句话

**是 `r-20261115141044-aba3` 第 1 轮的 `remove_run`，在 2026-11-15 14:11:27 这条 tx 里
把 `belt#14976@(-4,15)` 和 `belt#14975@(-3,15)` 一起删了。**

它不是一个孤立的误操作，而是 **13 步连锁拆除的最后一步**：从 11-15 11:57 到 14:11，
9 个 run、14 条 tx 把这台 painter 的整条颜料供料链从 25 格拆到 0 格。
最后一次 `remove_run` 只是顺手把剩下的 2 格收走了。

而 `(-4,15)` 之所以能一直空到今天，是因为**没有任何诊断能看见它**——
`MACHINE_STARVED` 对 painter 不报（两路全空 ⇒ 被「全空交给 CHAIN_UNFED」的规则排除），
`CHAIN_UNFED` 只看带子的入口不看机器的槽。这条空格因此在 508 个 L12 快照里**零次被点名**。

---

## 一、时间线与判据

按**位置**认（`uid` 会变，位置不变）：painter 本体 `(-5,14)` r=90 default，
`slotsOf("painter","default",-5,14,90)` 给出：

| 槽 | role | 槽位本体格 | approach 格 |
|---|---|---|---|
| 0 | shape | `(-5,14)` | `(-5,13)` |
| 1 | **color** | **`(-5,15)`** | **`(-4,15)`** |
| out | out | `(-5,15)` | `(-5,16)` |

`(-4,15)` 在 575 个 run 里**只出现过一种实体：belt**（23 个快照里有，其余 544 个为空）。
从没有机器、垃圾桶或其它东西落在这里。

### 完整时间线（L12 世界，`7c93b3dd…` seed 60908）

```
2026-11-15 11:13:49  r-20261115111349-0095   (-4,15)=belt#14976   ← 第一个 L12 快照就有带子
        ...（11:13 → 14:08 共 22 个 run 全部有带子，uid 恒为 14976，r=270 rv=0）...
2026-11-15 14:08:19  r-20261115140819-dcb5   (-4,15)=belt#14976   ← 最后一个有带子的时刻
2026-11-15 14:10:44  r-20261115141044-aba3   (-4,15)=EMPTY         ← 第一个空的时刻
        ...（11-15 至 11-23 共 485 个快照，除下面那一次例外，全部为空）...
2026-11-21 19:04:39  r-20261121190439-6190   (-4,15)=belt#17649   ← 唯一例外：重接过，见 §4
2026-11-21 19:05:16  （同一次 run 被判 regressive，用 checkpoint 完整回滚）
2026-11-23 13:57:33  r-20261123135733-fe21   (-4,15)=EMPTY         ← 空，直到今天
```

### 这次变化对应的 tx（精确到秒）

```
run     r-20261115141044-aba3   round 1
plan    2026-11-15T14:11:27.668Z
apply   2026-11-15T14:11:27.709Z   tx_ok:true  applied:2  removed:2
macro   remove_run  args: {region: {$path_of: ["B342","B341"]}}
tx_plan {ops:2, destroys:[14975, 14976], placements:0}
warnings ["would-disconnect", "stranded-items-unknown"]
```

`destroys` 里的两个 uid 正是：

```
14976 → belt @(-4,15) r=270 rv=0    ← color 槽 approach 格
14975 → belt @(-3,15) r=180 rv=2    ← 它的上游一格
```

**模型的 why（原文）**

> `diagnosis 2 lists remove_run on exactly this ore-less miner's dead chain; cleanup is the one action that has never made the world worse`

**模型的 say（原文）**

> `M15 has no ore under it, so its B342/B341 chain can never carry anything — clear that dead run this round and save the remaining rounds for a real ore→pigment→stacker line toward CbCbCbRb:CwCwCwCw.`

**它依据的诊断（`r-20261115141044-aba3` r1，`diagnose` 事件原文）**

```json
{
  "code": "CHAIN_UNFED",
  "layer": "L2",
  "subject": {"handle": "M15", "type": "miner", "uid": 15103},
  "expected": "矿机脚底下有矿，能持续出货",
  "observed": "M15 脚底下没有矿（矿机被架空，永远不出货），它馈着的 2 条链因此全是死的",
  "evidence": {
    "handles": ["M15", "B342", "B341"],
    "uids": [15103, 14975, 14976],
    "barren_miner": true,
    "chain_belts": 2
  },
  "candidates": ["remove_run", "replace_run", "insert_machine"]
}
```

### ⚠️ 这条诊断有三分之二是对的

我按 `beltEntry` 逐格回溯了这条链（`machines` 用 `slotsOf`，带子用 `belt-rules`）：

```
(-4,15) belt#14976   in=right  out=left
(-3,15) belt#14975   in=top    out=left
(-3,14) miner#15103  ← r=180（朝下），M15 本人
```

`M15@(-3,14)` 脚下的确没有矿：`obs.resources` 在 `(-3,14)` 附近 3 格内**一个格子都没有**
（最近的矿在 `(-10,10)`，曼哈顿距离 11）。矿机是货真价实的空转机器。

**但被它一起删掉的两格带子，不是「它的死链」的尾巴——它们正是 painter 的 color 供料口。**
诊断给的 `chain_belts: 2` 说的就是这两格；诊断自己**不知道自己正在建议拆掉 painter 唯一的颜料入口**。

一个关键反证，下面 §5 会再提：这两格带子在 11-15 11:13 到 12:19 之间**是有货的**
（`items-last` 里 `(-4,15)` 上有 2 件 `green`，`(-3,15)` 上一路排到 `(-3,6)`）。
也就是说这条链在 12:19 之前**虽然在产绿色、却真的在给 painter 送货**——
它不是老死的，是 12:19 那一刀把它砍断之后才变成死链的，紧接着在 14:11 被当成死链拆干净。

---

## 二、这不是一次误操作，是一条 13 步的连锁拆除

`(-4,15)` 掉掉之前，这台 painter 的供料链已经被拆了 11 步。全部 14 条 tx，按时间：

| # | 时刻 (2026-11-15) | run | 宏 | destroys | 打在链上哪一格 |
|---|---|---|---|---|---|
| 1 | 11:15:46 | `0095` r3 | `replace_run` | 14909, 14910 | （别处） |
| 2 | 12:00:34 | `8b63` r3 | `replace_run` | 15002 | `(-3,-8)` 链头 |
| 3 | 12:14:35 | `264d` r3 | **`insert_machine`** **trash** | **15021** | **`(-3,-8)` 链头被替换成垃圾桶** |
| 4 | 12:50:59 | `59a1` r1 | `insert_machine` **miner** | 14954 | `(-3,-6)` |
| 5 | 12:51:50 | `59a1` r2 | `remove_run` | 14955,14956,14957,14962,14963 | `(-3,-5..-3)`,`(-3,2..3)` |
| 6 | 12:53:04 | `59a1` r3 | `replace_run`→miner | 14964 | `(-3,4)` |
| 7 | 13:48:26 | `d5f2` r4 | `remove_run` | 14965,14966,14967,14968,14969 | `(-3,5..9)` |
| 8 | 13:51:34 | `f98c` r3 | `remove_run` | 14970 | `(-3,10)` |
| 9 | 14:09:13 | `dcb5` r1 | `remove_run` ×2 | 15036, 15099 | （别处） |
| 10 | 14:09:25 | `dcb5` r2 | `remove_run` ×2 | 14971, 15035 | **`(-3,11)`** |
| 11 | 14:09:46 | `dcb5` r3 | `remove_run` ×2 | 14972, 15034 | **`(-3,12)`** |
| 12 | 14:10:01 | `dcb5` r4 | `remove_run` | 14973 | **`(-3,13)`** |
| 13 | 14:10:39 | `dcb5` r5 | `replace_run`→miner | 14974 | **`(-3,14)`**（链头换成矿机） |
| 14 | 14:11:27 | **`aba3` r1** | **`remove_run`** | **14975, 14976** | **`(-3,15)` + `(-4,15)`** |

逐格塌陷（`obs-last` 实测，`x=-3` 那一列 + `(-4,15)`）：

```
y:      16 15 14 13 12 11 10  9  8  7  6  5  4  3  2  1  0 -1 -2 -3 -4 -5 -6 -7 -8   (-4,15)
11:13    .  b  b  b  b  b  b  b  b  b  b  b  b  b  b  b  b  b  b  b  b  b  b  b   b
12:11    .  b  b  b  b  b  b  b  b  b  b  b  b  b  b  b  b  b  b  b  b  b  b  t   b
12:49    .  b  b  b  b  b  b  b  b  b  b  b  m  .  .  b  b  b  b  .  .  .  m  b  t   b
13:45    .  b  b  b  b  b  b  .  .  .  .  .  m  .  .  b  b  b  b  .  .  .  m  b  t   b
13:48    .  b  b  b  b  b  .  .  .  .  .  .  m  .  .  b  b  b  b  .  .  .  m  b  t   b
14:08    .  b  m  .  .  .  .  .  .  .  .  .  m  .  .  b  b  b  b  .  .  .  m  b  t   b
14:10    .  .  m  .  .  .  .  .  .  .  .  .  m  .  .  b  b  b  b  .  .  .  m  b  t   .   ← 14:11
        (b=belt  m=miner  t=trash  .=empty)
```

**每一次 tx 单独看，模型都有理由**，而且绝大多数理由看起来是对的：

- 第 3 步（trash 插入）：`say` = "The dead loop from L1 keeps 68 items recycling without reaching the hub and no Cb ore exists for the goal shape, so I will sink that jammed dead-run cell instead of guessing another blocked route."
- 第 10–12 步（dcb5）连续三轮同一句式：`"B200 has no upstream source and only feeds a trash — dead run, safe to delete"` / `"B202 has no upstream and only feeds a trash; it is a dead stub"` / `"B339 has no supplier and never reaches the hub — deleting it is the one change that has consistently reduced dead belts here"`
- 第 13 步：`"B340 是一条无源头的死带，用原位替换把它换成矿机，让这个空入口变成一个真正的产出源。"`

**它们说的都是同一个事实**：这条链没有活着的源头，货量 0，接不到 hub。
这个事实本身**是真的**——从 12:19 起就是真的。而它是**上一步造成的**。

**没有任何一步说「我在拆 painter 的 color 供料口」。** 链一格一格往上游塌，
每一格被拆时都已经被上一步变成了「无源死带」。

---

## 三、真正的断点：12:19（供料停止）≠ 14:11（格子清空）

这是整条调查里最重要的一个区分。任务书问的是「格子什么时候空的」，但**工厂在格子变空之前 1 小时 52 分就已经停产了**。

### 12:11 → 12:19 之间发生了什么

`r-20261115121125-264d` 第 3 轮的 `insert_machine`（放一台 trash）：

```json
plan r3  2026-11-15T12:14:35.872Z
macro    insert_machine  args: {at: {$ref:"B109", asCell:true}, machine:"trash"}
tx_plan  {ops:2, destroys:[15021], placements:1}
warnings ["replacing_belts","input_not_fed","input_belt_wrong_direction",
          "input_belt_wrong_direction","orphaned_downstream","wiring_mismatch","FLOW_UNVERIFIED"]
say      "The dead loop from L1 keeps 68 items recycling without reaching the hub
          and no Cb ore exists for the goal shape, so I will sink that jammed
          dead-run cell instead of guessing another blocked route."
```

`obs-last` 逐格比对 `8b63`（12:11 前）→ `264d`（12:14 后），**只差三格**：

```
(-3,-8)  belt#15021  r90 rv0   →  trash#15023            ← 被替换成垃圾桶
(-3,-7)  belt#14953  r90 rv2   →  belt#14953 r90 rv0      ← 出口 bottom → right
(-2,-7)  belt#15019  r180 rv0  →  belt#15019 r90 rv2      ← 入口 top   → left
```

**这两处带子方向翻转不是 tx 显式写的——是游戏对邻居重算的结果。**

`plan` 的 `tx_plan` 只列了 `destroys:[15021]` + `placements:1`；
`apply` 回 `diff{added:1, removed:1}`。**没有任何一条 op 说「把 14953 和 15019 改向」。**
但 tx 落地后它们的方向变了。

而这一变，`belt#14953@(-3,-7)` 就不再往 `(-3,-6)`（竖列的倒数第二格）送货：

```
改前：belt#14953@(-3,-7) IN=left(-4,-7)  OUT=bottom(-3,-6)   ← 接上竖列
改后：belt#14953@(-3,-7) IN=left(-4,-7)  OUT=right (-2,-7)   ← 拐向 (-2,-7) → (-2,-6) → hub
```

`path` 编号的变化证实了这一点（`items-last`）：

```
12:11  在 (-4,15) 上的货属于 path 12，cells 从 (-3,-6) 起 → 23 格，仍是通往 painter 的那条
12:19  在 (-4,15) 上已经没有货，path 12 消失（-4,15 不在任何 path 里）
```

同一时刻，`production-last` 从有产出变成全零：

```
12:11:25  produced_total {"ScScCgCg":15,"----CgCg":14,...,"CgScScCg":14}  delivered {"CgScScCg":15}
12:19:51  produced_total {}                                                delivered {}
```

**这是全图最后一次产出。** 从此 508 个 L12 快照里 `produced_total` 恒为 `{}`。

### 所以真正的时间线是

```
2026-11-15 12:11:25  最后一个有产出的快照；(-4,15) 上有 2 件 green；painter 在喷漆
2026-11-15 12:14:35  insert_machine(trash) @(-3,-8) —— 只声明 1 destroys + 1 placement
2026-11-15 12:19:51  全图产出归零；(-4,15) 上的货消失；painter 出口 ejector 消失
                     ↑ 供料在这里断，格子还在
2026-11-15 14:11:27  remove_run 删掉 belt#14975 + belt#14976
                     ↑ 格子在这里空
```

**「格子空」是「供料断」的后果，不是原因。** 若按「格子什么时候空」去追，
会追到第 14 步；真正让 painter 停工的，是第 3 步。

### 旁证：11-21 的上游重建只证明格子能接回去，不证明链能工作

`r-20261121190439-6190`（11-21 19:04）确实把 `(-4,15)` 又填上了 `belt#17649`，
而且 tx 35/35 落地、货真的流了 46 件、hub 入库 9 件 `CgScScCg`
（详见 `.findings/LIVE-E2E-2026-11-21.md` §4–§5）。但那一次接的是 `M13` 这台绿矿机，
产出的是 **L11 的形状**，与 L12 目标无关；世界被判 regressive，**当场 checkpoint 回滚**。

我做了全量实体比对来验证这次回滚：

```
r-20261121100232-d10f（19:04 之前）   749 实体
r-20261123135733-fe21（11-23）        749 实体
→ 实体多重集逐字节相同（88445 bytes 对 88445 bytes），tick 不同
```

也就是说 11-23 那个世界**逐字节等于 11-21 19:04 之前的状态**——那次 tx 被完整撤销了。
这解释了「11-21 有带子、11-23 又没有」，并且**它不是第二次拆除**。

---

## 四、git log 交叉验证

任务书点名的两个 commit：

### `39ac669`（11-16 17:02）「刚放的矿机被判孤儿，agent 一次删了 6 台」

- **时间上晚于断点 26 小时**（断点在 11-15 12:14–14:11，这个 commit 在 11-16 17:02）。
  它不可能是 `(-4,15)` 变空的原因。
- 但它和本案是**同一族缺陷**，而且那次事件的形状几乎是本案的翻版：agent 照着诊断的
  `remove_machine {uids:$uids([M2,M8,M4,M3,M7,M6])}` 一次删了 6 台，包括刚放上去挖 blue 的。
  commit message 里那句话直接套用在本案：
  > 「这不是 agent 乱来：它照的是诊断的建议。」
- 本 case 里诊断发给它的是 `CHAIN_UNFED{barren_miner:true, chain_belts:2, uids:[15103,14975,14976]}`
  ——诊断**亲手把 painter 供料口的两个 uid 写进了 `uids` 字段**，然后 `candidates` 第一条就是 `remove_run`。

### `a69d94d`（11-16 06:36）「掉 1 条活线就判『改坏了』」

- 同样**晚于断点**（11-15 → 11-16 06:36）。
- 但它解释了**为什么这条链会一路被拆到 0**：这条 commit 之前，
  「到 hub 的带子掉 1 条」就判 `regressive`。而 `remove_run` 在跨 run 记忆里被记成
  `regressive` **57 次**，理由全是「154→153」这种掉一条。
  代价是 agent 学到「删东西 = 改坏了」，或者反过来学到「只要拆的是死带子就安全」。
  在 11-15 那天它走的是后一条路：`dcb5` 的 `say` 明说
  > "deleting dead runs is the only cleanup the diagnosis supports this round"
  > "Only cleanup has ever helped in this world"

  三条 `remove_run` 连着三轮，每轮都算出「净效果 cleanup / 死带子减少」——
  **判据当时确实在奖励这个动作。** `dcb5` 的累计净效果是
  `cleanup（改善但不是交货）— 死带子 169→161`。

### 关键结论：代码改动 vs 世界状态改动

- **造成空格的是 tx**（`aba3` r1 的 `remove_run`，加上 `264d` r3 的 `insert_machine`），
  不是任何 commit。
- **诱使这些 tx 的是代码**，具体是三处，而且它们在 11-15 当天已经存在：
  1. `CHAIN_UNFED` 的 `uids` 字段把**机器槽的供料带**和**矿机的死链**混在一个数组里，
     而 `candidates` 只给 `remove_run / replace_run / insert_machine`——**没有「别删，这台机器还等着这路料」这一档**。
  2. `insert_machine` 只回报它**声明**的破坏（`destroys:[15021]`），
     **不回报游戏因此重算的邻居方向**（14953、15019 两格的 rv 翻转完全静默）。
     这个 tx 的 warnings 里**一条都没提**那两格：
     `["replacing_belts","input_not_fed","input_belt_wrong_direction","input_belt_wrong_direction","orphaned_downstream","wiring_mismatch","FLOW_UNVERIFIED"]`
     ——`orphaned_downstream` 指的是**被替换的那条带子的下游**（15021→15020），不是 `14953`。
  3. `health` 把「死带子减少」判成 `cleanup`（正向），把一个 25 格供料链的塌陷
     记成了净收益。

这三处都不是这次调查新发现的（`computed-but-never-delivered`、`semantic-layer-silent-breaks`、
`one-belt-drop-ate-the-memory` 三条记忆里都记过同类），但它们**在 11-15 那天同时在场**。

---

## 五、下界 vs 确切时刻

**不是下界。这是确切的。**

- 最后一个有带子的快照：`r-20261115140819-dcb5`（11-15 14:08:19 开始，末轮 tx 在 14:10:39）
- 第一个空的快照：`r-20261115141044-aba3`（11-15 14:10:44 开始，r1 tx 在 14:11:27）
- 那个 tx 的 `plan.tx_plan.destroys` 明文写着 `[14975, 14976]`
- `14976` 的 `obs` 坐标是 `(-4,15)`，`14975` 是 `(-3,15)`——两者都在同一次 `remove_run` 的 `region.$path_of:["B342","B341"]` 里

唯一的空隙是 14:10:39 → 14:10:44 这 5 秒（`dcb5` 收尾 → `aba3` 启动），
但 `dcb5` 的末状态里 `(-4,15)` 仍是 `belt#14976`，而 `aba3` 没有其它 tx。
所以是**确切时刻 2026-11-15 14:11:27**，误差 = 0 次 tx。

同样确切的是**供料断点：2026-11-15 12:14:35**（`264d` r3 的 `insert_machine`）。
这个不是「下界」——它是那 5 秒之前最近的一次 tx，且 `obs` 前后只差三格。

---

## 六、反证检查

**我找到了至少两条与本结论矛盾、或至少严重削弱的证据。逐条列出。**

### 反证 1（严重）：`(-4,15)` 空了，painter 的 **shape 槽也是空的**

任务书的给定事实是 `shape` 槽 `(-5,13)` 有 `belt#14838` 运 `----CuCu`，
只有 `color` 槽是空的。我核对了 11-23 那个世界（`r-20261123151728-52a3`）：

```
items-last.json path 5 = {cells:[[-5,10],[-5,11],[-5,12],[-5,13]], itemsOnPath: 0, boundAcceptor:"yes"}
(-5,10) 0 件   (-5,11) 0 件   (-5,12) 0 件   (-5,13) 0 件
cutter#13544 的 ejector @(-5,9) = CuCu---- progress:1（满、堵住）
```

**带子在，货不在。** `path 5` 这 4 格上**一件货都没有**。

用 `slotsOf` + `items-last` 复算 `MACHINE_STARVED` 的判据（与 `semantic.mjs:3753-3768` 同口径）：

```
painter#13552@(-5,14)  nFed=0/2  [{cell:[-5,13],ok:false,role:"shape"},
                                  {cell:[-4,15],ok:false,role:"color"}]
stacker#14684@(-2,5)   nFed=1/2  [{cell:[-2,6],ok:false,role:"lower"},
                                  {cell:[-1,6],ok:true, role:"upper"}]
```

painter 是 **0/2**，而 `MACHINE_STARVED` 的判据是
`if (nFed > 0 && nFed < fed.length)`（`semantic.mjs:3766`）——
**两路全空的机器被明确排除在外**（注释原文：「两路全空是上游没建好，那属于 CHAIN_UNFED 的地盘」）。

这在 11-23 的诊断里得到了证实：`MACHINE_STARVED` 只点名了 `stacker#14684`，
**painter 一次都没被提到**：

```
MACHINE_STARVED -> stacker#14684 | 1 台机器缺进料：stacker#14684(1/2，缺 [-2,6])
（painter#13552 不在任何一条诊断的 subject 里）
```

**这对结论的影响**：`(-4,15)` 是空的，这是事实，也是我追出来的那两格之一。
**但「把 `(-4,15)` 接上，painter 就会喷漆」这个推论不成立**——
shape 那一路也断着（`cutter#13544` 的出口堵死在 `CuCu----`，
可能是 cutter 自己缺上游，也可能是它的输出口朝向不对，我没有继续往下追）。
**修一条只能让 painter 从 0/2 变成 1/2，仍然不满足 `inputsPerCharge: 2`。**

### 反证 2（中等）：12:11 的快照显示链上**只有 2 件货**，不是「正在送货的活链」

我说过这条链 12:19 之前「真的在给 painter 送货」。这句话需要收窄：

```
11:13  在 (-4,15) 上 2 件 green；整条 path 13 有 39 件；列上 38 件
12:11  在 (-4,15) 上 2 件 green；整条 path 12 只有 16 件（列上 16 件）
12:19  0 件
```

从 39 件掉到 16 件，说明在 12:00–12:14 之间这条链**已经在衰减**——
`8b63` r3 的 `replace_run`（12:00:34，destroys `15002`）和 `264d` r1/r2 的失败 connect
都在这个窗口里。所以更准确的说法是：**12:14 是最后一击，不是唯一一击**。
「12:19 之前它在正常送货」是过强的表述；「12:19 之前它还在送，之后彻底不送」才准确。

### 反证 3（弱）：11-21 那次 tx 证明「格子接回去、货就能流」

`r-20261121190439-6190` 的 35 op 落地后，`(-4,15)` 上有 2 件 green，
painter 出口出现 `----CgCg`，`produced_total` 从 `{}` 变成
`{"----CgCg":4,"ScScCgCg":9,"CgScScCg":9}`，hub 入库 9 件。
**这说明当时 shape 那一路是通的**——如果 shape 也断着，painter 不可能出货。

所以反证 1 的「shape 也是空的」是**后期才发生的**，不是 11-15 就有的。
我核对过：11-21 19:04 的快照里 `(-5,13)` 上有 2 件货（`shapescan` 的输出：
`2026-11-21 19:04:39 | (-5,13)= 2 | (-5,10..12)= 2 | cutter out(-5,9)= CuCu----`）。
到 11-23 才变成 0。

**结论**：`(-4,15)` 的空格确实是 11-15 14:11 造成的，这一点没有被推翻。
但「它是**唯一**的断点」被推翻了——到 11-23 那个世界，painter 是 0/2，
`DEADLOCK-CHAIN-2026-11-23.md` 里「color 槽是唯一断点」的说法在 11-23 的快照上不成立。

### 我没有找到的

- 我**没有**找到任何一条 tx 显式声明过「改 `14953`/`15019` 的方向」。这是静默的邻居重算。
  如果 mod 那边有日志能证明是谁触发的，也不在 `research/ai-plan/runs/` 里。
- 我**没有**找到 11-15 12:14:35 那一刀与后 11 步之间任何「模型明知在拆 painter 供料」的证据。
  所有 `say` 都在说「死链/死带子/清理」，逐条原文都在 §2。
- 我**没有**找到第二个与此结论矛盾的 tx 级证据（除了上面三条反证各自的范围）。

---

## 七、一句话回答

**`belt#14976 @(-4,15)` 是在 2026-11-15 14:11:27 被
`r-20261115141044-aba3` 第 1 轮的 `remove_run`（`region.$path_of:["B342","B341"]`）
连同 `belt#14975 @(-3,15)` 一起删掉的。**

**但真正让 painter 停工的是 1 小时 57 分钟前的另一刀**：
2026-11-15 12:14:35，`r-20261115121125-264d` 第 3 轮往 `(-3,-8)` 插了一个垃圾桶，
游戏按邻居重算了 `belt#14953` 和 `belt#15019` 的方向——**这两格改向没有出现在任何 op 或 warning 里**——
竖列的进料口因此被剪断，全图产出从那一刻起永久归零。

到 11-23 的世界，painter 是 **0/2**：`color` 槽 `(-4,15)` 空、
`shape` 槽 `(-5,13)` 的 4 格带上也是 0 件货。
**`DEADLOCK-CHAIN-2026-11-23.md` 里「color 槽是唯一断点」这句话，在 11-23 的快照上不成立。**

---

## 附：证据文件索引（全部绝对路径）

```
D:\Projects\rea\Project work\shapez\research\ai-plan\runs\r-20261115141044-aba3\transcript.jsonl
    第 1 轮 plan/apply 事件 —— destroys [14975,14976]，模型的 why/say
D:\Projects\rea\Project work\shapez\research\ai-plan\runs\r-20261115140819-dcb5\obs-last.json
    最后一个 (-4,15)=belt#14976 的快照
D:\Projects\rea\Project work\shapez\research\ai-plan\runs\r-20261115121125-264d\
    obs-last.json  —— 与 8b63 逐格比对只差三格
    transcript.jsonl —— r3 insert_machine 的 plan / apply / warnings
    production-last.json —— 最后一个有产出的快照
D:\Projects\rea\Project work\shapez\research\ai-plan\runs\r-20261115121951-39ea\production-last.json
    全零产出的第一个快照
D:\Projects\rea\Project work\shapez\research\ai-plan\runs\r-20261121190439-6190\transcript.jsonl
    11-21 的上游重建（35 ops / 35 applied / 后被 checkpoint 回滚）
D:\Projects\rea\Project work\shapez\.findings\LIVE-E2E-2026-11-21.md
    上面那次重建的完整记录（§4 逐 uid 归因、§5 货真的流了）
D:\Projects\rea\Project work\shapez\src\agent\loop\semantic.mjs:3700-3768
    MACHINE_STARVED 的判据，含「两路全空不报」那一行
D:\Projects\rea\Project work\shapez\src\agent\macros\place.mjs:830-935
    insert_machine 的 warnings 只覆盖自己 footprint 内的替换
D:\Projects\rea\Project work\shapez\src\ai\belt-rules.mjs
    beltEntry / beltExit —— 逐格算方向用
```
