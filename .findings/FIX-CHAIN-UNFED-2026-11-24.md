# 修复：`CHAIN_UNFED` 把矿机与它下游的带子混在一个 `uids` 里

2026-11-24。执行 agent C2。来自 `.findings/CODE-DEFECTS-FROM-ROOTCAUSE-2026-11-23.md` 缺陷 2。

---

## 1. 缺陷确认（代码位置）

**位置**：`src/agent/loop/structural.mjs`，`structuralDiagnoses()` 里的 `barrenGroups` 输出段
（修复前约 L787–809，修复后端点在 `barrenGroups` 循环）。

**修复前的实际代码**（不是报告里的推测，是逐行读出来的）：

```js
evidence: {
  handles: [minerH, ...chainH].filter(Boolean),
  uids: [g.miner.uid, ...g.heads.map(x => x.uid)],   // ← 矿机 + 下游带子 拼成一个数组
  ...
  barren_miner: true,
  chain_belts: g.heads.length,
},
candidates: ["remove_run", "replace_run", "insert_machine"],   // ← 第一条是 remove_run
```

三个问题的答案：

1. **`uids` 怎么拼的**：`[矿机 uid, ...它馈着的每条链的链头 uid]`。
   `g.heads` 来自 `facts.unfedHeads` 里 `barren === true` 的项，每一项是**链头带子**。
2. **`candidates[0]` 真的是 `remove_run`**：是。且 `remove_run` 的选区口径就是
   「uids 里的带子」—— 矿机 uid 在里面会被宏回 `not_a_machine`，
   所以模型实践上只会用到那几格带子。**混组不是「冗余信息」，它正好给了 `remove_run` 一个合法选区。**
3. **`barren_miner: true` 时下游带子怎么进的 `chain_belts`**：
   `collectTopologyFacts()` 对**每条带子**跑 `sourceEntityOf()` 一路爬到源头。
   源头是矿机、而矿机脚下没矿 ⇒ `barren = true` ⇒ 这条带子成了 `unfedHeads` 的一项。
   同一台矿机馈着的所有链都指向同一台矿机，于是按 `sourceEntity.uid` 归成一个 group
   （这段去重本身是对的：L4 的 M4 会报 7 条，逐条报会吃满 8 条上限）。

**一句话总结**：「矿机没矿」这个**正确的**根因，被 `uids` 混组 + `candidates[0]` 传播成了
「它下游那几格也该拆」。诊断自己完全不知道那几格末端接着谁。

---

## 2. 影响面（扫 `research/ai-plan/runs/`）

扫描口径：读每个 run 的 `obs-last.json`，**重新调用 `structuralDiagnoses()`**（不是读历史
transcript 的旧 JSON —— 那是修复前的输出，没法验修复）。共 575 个 run 目录、567 个含 obs 的
快照，其中 23 个快照产出 `CHAIN_UNFED{barren_miner:true}`。

| 指标 | 数值 |
|---|---|
| 触发 `CHAIN_UNFED ∧ barren_miner:true` 的快照 | **23** |
| 分组（每台架空矿机一个） | **25** |
| 被一起列进 `uids` 的带子总数 | **598** 格 |
| 其中**末端接着活机器**的分组 | **11 / 25** |
| 其中这 11 个分组里是「该槽唯一供料」的 | **11 / 11** |
| 这 11 个分组覆盖的带子 | **179** 格 |
| 这些分组原先 `candidates[0]` 全是 `remove_run` | **11 / 11** |

**「活机器」的定义**（`machineAliveAt()`，三条都成立才算）：

1. 从链里某条带子的出口出发，沿货流**真的走到**一台机器。
   必须用 `accepts()` 而不是 `at()`：**`painter.color` 的槽位本体不在 footprint 内**，
   `at()` 返回 null，会把一条接好的线判成「断在空格」。
   （这个 footprint 陷阱在本项目已经踩过四次：`DEAD_END` / `upstreamFed` / `accepts` / 这里。）
2. 落点确实是它的**输入槽**（`slotsOf()` 的真槽位表，不是「机器占地」那种近似）。
3. 那台机器**还活着**：另外至少一个输入槽有货（`inputFed`），
   **或**任一输出槽有去处（`outputRouted`）。

**为什么这三个口径，而不是别的**：

- 「在 `MACHINE_STARVED` 里被报成缺料」不行 —— 它依赖语义层/配方，而 `CHAIN_UNFED` 是**纯拓扑层**
  （结构性判据不依赖可达性与配方，这是本文件的第一条纪律）。引入语义依赖会让同一份 obs
  在配方解不出时产出不同的结构诊断。
- 「它在 `MACHINE_STARVED` 里」也不行，语义层对 painter **两路全空时不报**（那是 CHAIN_UNFED 的地盘），
  这条最关键的样本恰恰不在 `MACHINE_STARVED` 里。
- **hub / trash 不算「在等」**。它们是汇，不是消费者：hub 16 个入口少一路不缺，
  trash 本来就吃任何东西。算进来会让 11 个「矿机→垃圾站」的死链也失去 `remove_run` —— 那是过度保守。
  实测里这 11 个 trash 尾 + 2 个 hub 尾正好占了另外一半。

细分：

| 末端形态 | 分组数 | 处理 |
|---|---|---|
| 活机器（唯一供料） | **11** | 移除 `remove_run`、点名末端、给「换源头」出路 |
| trash | 11 | 保持原样（可拆） |
| hub 入口 | 2 | 保持原样（`dropInlets` 另有过滤） |
| 全为空格（真死链） | 1 | 保持原样（可拆） |

**这 11 个分组的具体末端**（全部来自真实快照）：

- `painter#13552 @ color` × **10**（那次事故的形态；9 次在 15032/M7、1 次在 15103/M15）
- `mixer#11803 @ color` × 1
- `balancer#10085 @ secondary` × 1（L4 夹具，`r-20261031214805-dc42`）

其中事故快照 `r-20261115140819-dcb5` 与 `r-20261115141044-aba3` 都是
`M15(15103) / 2 格带子 / painter#13552.color / unique_feed=true` —— 与报告里的事故现场完全对上。

---

## 3. 选哪个修法

**选 A + B + C 全做，但 C 严格以「算得出来」为前提。**

- **A（拆两组）**：`uids` 只放矿机，新增 `chain_belt_uids` 放下游带子。
  **这是根上的修法**：`remove_run` 只作用于带子、`remove_machine` 只作用于机器，
  把两类混在一个数组里，**任何**读它的消费者都得自己重新分类。分开之后混用不再可能。
- **B（加门槛）**：末端有任何一台「活机器」且该槽**唯一供料**时，`candidates` 换成
  `["connect","remove_machine","insert_machine"]`，`remove_run` 彻底不出现。
  **不抑制诊断本身** —— 矿机脚下没矿是事实，仍要报；去掉的只是「拆下游」这个选项。
- **C（点名）**：`evidence.live_chain_ends` 给出 `{handle, type, uid, slot, unique_feed}`，
  hint 里写成「末端是 C1（painter）的 color 槽（唯一供料）」。
  **只在句柄查得到时才写**：`handleOf` 返回 null 的那条不进这句话（宁可不点名，也不编）。
  `slot` 的 role 来自 `slotsOf()` 的真实槽位表，不是猜的。

**为什么不只做 A**：A 之后模型拿到 `uids:[15103]` + `chain_belt_uids:[14975,14976]`，
但 `candidates` 若仍是 `["remove_run",...]`，`remove_run` 照样会作用于 `chain_belt_uids`
（那是它唯一合法的选区）。**A 单独做不能阻止这次事故。**

**为什么不只做 B / C**：B/C 是「事后判断谁在等」，A 是「让混用不可能发生」。
两者修的是不同层 —— 只做 B/C 的话，任何以后读 `uids` 的新消费者还会再踩一次。

**为什么要求「唯一供料」**：这是**防过度保守**的那道门。
如果那个槽还挂着第二条带子，拆掉这条链不会让机器断粮，`remove_run` 必须留着。
实测 11/11 都是 `unique_feed=true`，所以这条附加条件**没有削弱**本次修复，
它只是把「有备份时也拦」这种错方向堵掉（`T-chain-8` 钉住它）。

---

## 4. 改了什么 / 加了什么测试 / 引用点检查

### 仓库改动（只两个文件）

**`src/agent/loop/structural.mjs`**

- 新增 `chainEndOf(idx, belt)` —— 沿货流走到终点，**用 `accepts()` 认槽位本体**
  （不能用 `runEnd`：它内部是 `at()`，`painter.color` 的槽位本体不在 footprint 内，
  会把真实末端判成 `empty`。**这一点踩过一次**：第一版量化脚本用 `runEnd`，
  11 个画家的末端全被判成 `no-machine-end`，直接导致「影响面 = 0」的假结论）。
- 新增 `feedersOfSlot(idx, slotCell)` —— 返回这个槽的供料带 uid，
  与 `topology.inputFed` 同判据（否则会出现「诊断说没人喂、而 inputFed 说喂了」的自相矛盾）。
- 新增 `machineAliveAt(idx, m, exceptSlotCell)` —— 活判据（见 §2），hub/trash/miner 一律不算。
- 新增 `chainEndsOf(idx, beltUids)` —— 汇总末端，返回 `{ends, liveEnds}`。
- `barrenGroups` 输出段：
  - `uids: [minerUid]`（**契约级改动**）
  - 新增 `chain_belt_uids: beltUids`
  - 新增（有条件）`evidence.live_chain_ends`
  - `candidates` 按 `guarded` 分两套
  - 新增 `hint`（仅 guarded 时）
  - `observed` 追加一句「但其中 N 处末端还接着活着的机器」
- import 增补 `inputFed` / `outputRouted`（`topology.mjs` 已导出，无新依赖）。

**`src/agent/loop/structural.test.mjs`**

新增 8 条（`T-chain-1` … `T-chain-8`），全部基于真实几何的夹具
（矿机 r=270 → 3 格带子 → painter r=90；painter 的 color/shape/out 槽本体位置取自 `slotsOf` 实测）：

| 测试 | 钉住什么 |
|---|---|
| `T-chain-1` | `uids` 只有矿机；`chain_belt_uids` 是带子；两组**无交集** |
| `T-chain-2` | 末端活时 `remove_run` 不在候选里，且 `candidates[0]==="connect"`；候选全是真宏名 |
| `T-chain-3` | `live_chain_ends` 给出 uid/type/`slot:"color"`/`unique_feed:true`/句柄；**不含坐标** |
| `T-chain-4` | hint 点名 painter + color + 唯一供料 + 别拆；**≤180 字符**且宏调用不被闸门截断 |
| `T-chain-5` | 负例：末端无活机器 ⇒ `remove_run` 排第一、无 `live_chain_ends`、无 hint |
| `T-chain-6` | 负例：末端是 trash ⇒ 仍可拆（trash 是汇不是消费者） |
| `T-chain-7` | 确定性：同 obs 两次调用逐字节相同 |
| `T-chain-8` | 负例：该槽有**第二条**供料 ⇒ 不算唯一，仍可拆（防过度保守的门） |

**`T-chain-4` 里那条 180 字符断言不是形式主义**：第一版 hint 写满 204 字符，
`prompt.mjs` 的 `clip(..., 180)`（只有 `HUB_FED_BY_COLOR` / `HUB_INLET_THIN` 放宽到 400）
截掉的正好是 `remove_machine {...}` 那半句 —— 又是 `hint-truncated-before-arrival` 那个形态。
现在 141 字符，宏调用落在第 55 字符处。

### 引用点检查（契约级改动的必做项）

`grep -rn "chain_belts\|CHAIN_UNFED" src/` 的全部命中，逐个判定：

| 位置 | 是否依赖 `uids` 形态 | 结论 |
|---|---|---|
| `loop.mjs:318` `fingerprintOf` | 读 `evidence.uids` **整体排序拼串** | 不受影响。`uids` 变短反而让指纹**更稳定**（见 §6）。`uids[0]` 仍是矿机 |
| `loop.mjs:908` `dropInlets` | 只读 `subject.uid` / `evidence.handles` | 不变（`handles` 我**故意保留**了链头句柄，见下） |
| `loop.mjs:1529-1533` 补 candidates | `d.candidates` 已存在就不覆盖 | 不变 |
| `loop.mjs:4267` `candidatesFor(diagnoses)` | 读 **`RETRIEVAL_TABLE[code]`**，不读 `d.candidates` | **不受影响**（实测确认：`candidatesFor` 仍返回 `[connect,insert_machine,extend_line]`） |
| `prompt.mjs:2789` 渲染 `candidates` | 渲染 `d.candidates.slice(0,3)` | 生效：DIAGNOSIS 行会显示新候选 |
| `prompt.mjs:1159` `referencedHandles` | 读 `evidence.handles` | 不变 |
| `semantic.mjs:4680` / `structural.mjs:877` 排序 | 读 `evidence.uids[0]` | **`uids[0]` 仍是矿机**，排序不变 |
| `constants.mjs:575` `RETRIEVAL_TABLE` | 静态表，与该分支无关 | 不变 |
| `constants.mjs:129` `DIAG_CODES` 说明 | 文案 | 不变 |
| `structural.test.mjs:184` T4 快照 | 读 `subject.handle` | **基线时就已红**（见 §5），非本次引入 |
| `structural.test.mjs:571/592` nearby_source | 读 `evidence.uids[0]` | 绿 |

**为什么 `evidence.handles` 仍然保留链头句柄**：`prompt.pickBelts` 靠它决定哪些带子进
`BELTS` 段。模型要修这条链（比如换个源头接过来）**必须看得见那些带子** ——
把句柄也摘掉会让诊断变成「有病因、没可操作对象」。摘掉的只有「允许删」这个授权，
不是「看得见」这个信息。

`grep -rn "chain_belt_uids" src/` 只有新代码 + 新测试，无历史消费者。

### 我没有做的（以及为什么）

- **没有新增 `CHAIN_FED_BY_DEAD_MINER` 之类的码**：新码要在 `DIAG_CODES` / `RETRIEVAL_TABLE` /
  `loop.mjs` 的 `RANK` 三处登记（`diag_registry.test.mjs` 守着），且会挤占 `LIMITS.TOTAL=8` 的名额。
  同一个根因拆两个码，模型会以为是两个问题。改候选 + 说话更省。
- **没有在 hint 里建议「把矿机挪到有矿的格子」**：`insert_machine` 目前**放不到资源格上**
  （`miner-relocation-gap`）。教它去搬等于给一条走不通的路 —— 那比不给建议更贵。
  hint 给的是两条真能落地的：`remove_machine` 拆空转矿机 + `connect` 从有矿矿机接过来。
- **没有做 `health` 的 `cleanup` → `regressive`**（缺陷 3）：超出本次范围，且两处独立可修。

---

## 5. 测试结果

```
$ node --test src/agent/
# tests 800   # pass 768   # fail 28   # skipped 4
```

**基线是 28 个失败，改完仍是 28 个，且失败集合逐条相同**（`diff` 两边的 `not ok` 清单 → 无差异）。
新增 8 条全部通过（`structural.test.mjs` 从 33 条升到 42 条，其中 41 绿 / 1 红 =
基线就红的 `T4` 快照）。

那 28 个基线失败与本改动无关：`T4 L4 冷启动的完整输出可复现` 是因为记忆里那份手柄表
（`B129/B130/...`）与当前 `buildHandles` 产出的命名（`B7/B14/...`）不一致 ——
**改动前后都是同一份 diff，说明不是本次引入的**。其余分布在 `timeline` / `partial_apply` /
`prompt` / `memory`，与 `structural.mjs` 的改动面不重叠。

单独跑：

```
$ node --test src/agent/loop/structural.test.mjs
# tests 42   # pass 41   # fail 1   （= 基线 T4）
$ node --test src/agent/loop/hint_signatures.test.mjs src/agent/loop/diag_registry.test.mjs \
                src/agent/candidates_for.test.mjs src/agent/loop/constants.test.mjs
# tests 13   # pass 13   # fail 0
```

`hint_signatures` 绿是必要的：它核对「hint 里写的宏调用参数名是否真存在」——
新 hint 里的 `remove_machine {uids:$uids([...])}` 与 `MACRO_SPECS` 对上了。

**真机渲染验证**（`buildPrompt` 实跑，不是看 DOM 猜测）：

```
2. CHAIN_UNFED [L2/blocker]: M1 (miner); ... observed M1 脚底下没有矿…；
   但其中 1 处末端还接着活着的机器; handles M1,B1,B2,B3;
   hint: ⚠️ 别拆这条链。末端是 C1（painter） 的 color 槽（唯一供料），
         那台机器还活着、一直在等这一路。病根是这台矿机脚下没有矿。
         出路：`remove_machine {uids:$uids(["M1"])}` 拆掉空转矿机，
         再用 `connect` 从有矿的矿机接过来。
   ; candidates connect,remove_machine,insert_machine
```

**样本验证**：对 23 个真实快照重跑，`uids` 全部只剩矿机，
11 个分组被正确识别为「末端有活机器」并换了候选，其余 14 个（trash/hub/空格）
**保持原样**（`candidates[0]` 仍是 `remove_run`）。

---

## 6. 反证：会不会变得太保守，从此不报真正的死链？

这是我唯一担心的地方，所以逐条查了。

### ① 诊断本身有没有被抑制？**没有。**

只换了 `candidates` 和 `hint`。`code` / `severity` / `subject` 一字未动 ——
23 个快照里 `CHAIN_UNFED{barren_miner}` 的**条数完全不变**（仍是 25 个分组）。
「矿机脚下没矿」这个事实永远会报出来。

### ② 会不会把「该拆的死链」也保护起来？**14/25 不会。**

trash 尾（11）、hub 入口（2）、纯空格尾（1）全部保持 `remove_run` 排第一。
这四类合计 419 格带子仍可拆。判据是「末端有没有**活着且唯一供料**的消费者」，
不是「末端有没有任何东西」。

### ③ 被保护的那 11 个，有没有「根本救不活」的？**没有。**

如果一条链被保护、而它周围没有有矿矿机可以接过来，那等于把一个死局锁死了。
实测：11 个分组**每一个**附近都有有矿矿机，最近距离 **3 / 8 / 17 格**
（`r-20261115142742-05a4` 是 3 格，事故现场 `dcb5` 是 17 格）——
`connect` 是真实可达的路，不是理论上的。hint 也如实引向它。

### ④ 有没有「该拆的是矿机而不是链，但我还是拦错了」？

如果一台空转矿机下游确实没人，我们**不拦**（`T-chain-5`）。
如果下游有人，正确动作是**删矿机、留链、换源头** —— 这恰好就是 hint 给的，
而且 `remove_machine` 对矿机是放行的（实测 `ok:true, removed:[2], would_disconnect:[]`：
差异法判据对矿机不报 `would_starve`，因为下游带子仍然连通）。

### ⑤ 有没有可能「那台机器其实也要死」，保护它是错的？

11 个末端里，`painter#13552` 的 shape 槽由 `cutter#13544`（**有矿**）在喂，
输出口也接着东西 —— 它是真活的。`balancer#10085` 的 primary 由 `miner#10081`
（**有矿**）在喂。`mixer#11803` 的另一个输入槽在 `obs` 里是空的 —— 这一例我判不准，
但它的输出口有去处，按定义算「活」。这一例可能偏保守，**代价是多保留 74 格带子**，
而拆错了的代价是不可逆的供料口消失。**两者不对等，我选保守。**

### ⑥ 一个意外的正向副作用：指纹变稳了

`fingerprintOf` 把 `evidence.uids` 排序拼串。改动前，矿机的链每被拆一格，
`uids` 的长度就变一次 ⇒ **指纹跟着变** ⇒ `countFingerprint` 以为「换过动作了」⇒
「同一指纹第 2 次必须换动作」「第 3 次必须停」这两道护栏**被绕开**。

实测 `r-20261115140819-dcb5`（连续拆 5 轮的那个 run）：

| 轮 | 指纹（前 8 位） | 现象 |
|---|---|---|
| r1 | `3a71273b` | |
| r2 | `ba64aa05` | 拆了 2 格 ⇒ 指纹变 |
| r3 | `6869e888` | 又变 |
| r4 | `790de0ab` | 又变 |
| r5 | `5db5e2d7` | 又变 |

连续 5 轮「诊断 → 拆一点 → 指纹变了 ⇒ 护栏认为有进展」。
现在 `uids` 固定是 `[矿机]`，**拆带子不再改变这个诊断的指纹** ——
护栏第一次能真正识别「你在原地打转」。

### ⑦ 已知的残余风险（写在这里，不假装没有）

- 判据是**纯拓扑**的，不看货。一台「几何上活着、但实际上永远收不到货」的机器
  （比如它的另一路供料也来自空转矿机）仍会被判「在等」。这种情况下我们**多保留**一条死链。
  代价有界：多留几格带子；而误删的代价是不可逆的。
- `unique_feed` 只数「链外的供料带」，不判那些供料带**上有没有货**。
  与上一条同源、同方向（偏保守）。
