# 红队：diagnose 语义化契约

> 攻击对象：`research/ai-plan/DIAGNOSE-SEMANTICS-CONTRACT.md`（v1，402 行）
> 方法：读代码 + 在真夹具上按契约字面规则重算 + 对历史正解做受控克隆 + 真 `buildPrompt` 量预算。
> **没有改源码**（`git diff -- src` 与开场快照一致；临时脚本全部在 `.tmpverify/rt/`），**没有碰游戏实例**。
> 复现：`node .tmpverify/rt/summary.mjs`（一条命令跑出本报告的主要数字）。

---

## 结论（能不能直接开工）

**不能。** 不是"再补几条边界"，是有三处**判据级**的塌方：

1. **T3（修好后 0 blocker）按契约自己的定义必然红** —— 不是实现细节，是分类表的问题：
   §1 把 `PROCESSOR_REQUIRED{scope:"stream"}` 称作「正常断（有救）」，§3 又把它定成 **L4/blocker**；
   而 T3 要求 blocker=0。L4 修好后至少还剩 2 条这样的"正常断"。契约 §8 自己写了「T3 红 ⇒ 直接回滚」——
   **按它自己的 kill switch，这一版应该被回滚。**
2. **§1 的排序键与 §5/T1 的期望互相矛盾** —— 排序第一/第三键（能否到 hub 降序、到 hub 跳数升序）会把唯一的 cutter
   分配给**已经通到 hub 的 34 节主干**（`B4`），而不是 §5 期望的 x=4 段；而 §11 自己警告的恰恰是"按拓扑就近"。
3. **§8/T1 的接受集漏掉了 x=2 与 x=3 两列** —— 我实测这两列各有 6–7 行能落 cutter+trash 且右口产品口真的通到 hub。
   按 §8 的 PASS 定义，这些**正解会被判错** —— 与第十二轮"判据把正确答案判错"同型。

底层还有一条事实错误（隧道）和一条可实现性冲突（零 `node:` import），见下。

可以保留、且我攻不动的部分：recipe 预计算/注入、`--no-cutquad` 门控（那是真 bug）、`diagnose` 保持纯函数的方向。

---

## 致命问题（按严重度）

### F-1（最高）T3 在契约自己的定义下不可能达成；"正常断"被定成 blocker

**问题**
- §1 分类表第 1 行：`PROCESSOR_REQUIRED{scope:"stream"}` = 「**正常断（有救）**」。
- §3 码表：`PROCESSOR_REQUIRED` = **L4/blocker**。
- §7 T3：修好后「`blocker` 级语义码 **= 0**」。
- §8：T3 红 ⇒ 回滚。

"正常"的东西被标成 blocker，再要求"正常世界 0 个 blocker"——**这三句不能同时成立**。

**证据**（`node .tmpverify/rt/t3charitable.mjs`，最宽容实现：已在下游找到合法 cutter 即算满足；工厂有闲置 cutter 就分配）

```
L4 original  factory cutters 1 | relevant Ru streams 4
             satisfied: B110
             blocker PROCESSOR_REQUIRED: B111,B112,B4  → 3
L4 repaired  factory cutters 2 | relevant Ru streams 4
             satisfied: B107,B108
             blocker PROCESSOR_REQUIRED: B109,B4       → 2
T3 needs 0 on repaired: false（实得 2）
```

即便用最宽松的口径，历史正解的世界里仍有 2 条 `PROCESSOR_REQUIRED`。
按契约字面（不检测"下游已有 cutter"，只按 `need=1` 配额）会更多（`summary.mjs` [3]）：

```
L4 original: RuRuRuRu 流 6 条，need=1 → 残余 5 条
L4 repaired: RuRuRuRu 流 5 条，need=1 → 残余 4 条
```

**第二重原因（更致命）**：`WRONG_SHAPE_AT_HUB` 的触发是「`delivered==0` 且 hub 入口流形状 ⊄ {goal} 且非空」。
L4 修好后，铜线 `C1.left → B84 → … → B135 → hub` **原封不动**，hub 仍然收到 `----CuCu`；
而主干 `B4` 那条流一路运的是 `RuRuRuRu`（修复后还多出 `RuRu----`）。这两件都是设计如此，不是缺陷。

```
L4 repaired hub inlets（in-memory 克隆；修复后句柄已重编号）
  (-2,-3) B132 = 旧 B135，铜线 C1.left → ----CuCu
  (-1,-3) B133 = 旧 B136，空入口（上游=无）
  ( 1,-3) B134 = 旧 B137，主干 B4 那条流 → RuRuRuRu（修复后另含 RuRu----）
```

⇒ `WRONG_SHAPE_AT_HUB` **永久为红**，直到玩家把整张图的副产线全拆掉。T3 与它是死结。

**后果**
- 语义层会对**正解**持续报红，模型看到"修完还是红"，触发 `mustChange` / `NO_PROGRESS_3X`，把正确动作换掉。
- 这正是 §8 自己定义的"跟正解打架"。

**修法（至少三选一，不能都不做）**
1. 把"正常断"从 blocker 降成 warn，并为 T3 改成「**新增** blocker 数=0」而不是「blocker 总数=0」。
2. `WRONG_SHAPE_AT_HUB` 只在「goal 相关入口流」上判，且要求该流**能到 hub 且头形状属于 recipe 输入侧**；
   铜线（waste 线）与副产线必须显式豁免。
3. 放弃"0 blocker"这个判据，改成「语义码 subject 集合 ⊆ 已知可改点」。

---

### F-2 §1 的排序键把 cutter 分给主干，与 §5/T1 的期望相反

**问题**：§1 排序 = `(能否到 hub 降序, 形状已知降序, 到 hub 跳数**升序**, 链头句柄升序)`。
第三键"离 hub 越近越优先"在 L4 上会选中 **`B4` 那条 34 节主干**（它的链尾 1 跳就是 hub），
而不是 §5/T1 要求改造的 x=4 段（2 跳）。§11 的原话是：
> 「把'哪条流该配哪台机器'的贪心分配写成'按拓扑就近'…… 分配器若按就近分配，会把 cutter 判给这条死流」

**契约自己把这条写成了规格**（跳到 hub 更近 = 更优先），这与它的警告是同一件事。

**证据**（`node .tmpverify/rt/verdict2.mjs`，只对"链头形状含 `RuRuRuRu`"的流排序）

```
=== L4 original ===  RuRuRuRu 流 6 条
  [键=链尾→hub] B4(h=0,len=34) B110(h=34,len=23) B26(h=34,len=7) B111(h=41,len=15) B56(h=41,len=7) B112(h=48,len=7)
      ⇒ 唯一 cutter 分给 B4（落在 x=4 可改造段? false）
  [键=链头→hub] B4(h=33,len=34) B26(h=41,len=7) B56(h=49,len=7) B110(h=57,len=23) B111(h=57,len=15) B112(h=57,len=7)
      ⇒ 唯一 cutter 分给 B4（落在 x=4 可改造段? false）
=== L4 repaired ===  RuRuRuRu 流 5 条
  [键=链尾→hub] B4(h=0) B107(h=34) B26(h=34) B108(h=41) B109(h=∞)
  [键=链头→hub] B4(h=33) B26(h=41) B107(h=57) B108(h=57) B109(h=∞)
```

两种口径（链头跳数 / 链尾跳数）**第一顺位都是 `B4`**——那条 34 节主干。
x=4 段的两条流在排序里排到最后（`B110/B111/B112` 之后）。

**后果**
- §5 第 2 行期望 `PROCESSOR_REQUIRED subject=L3`；算法实际会把 `B4` 的流配给唯一的 cutter，
  于是"缺 cutter"的诊断落到别的流上（`B26/B56/…`）。**T1 会红**，且红的原因不是实现错，是规格自相矛盾。
- 若真把 cutter 分配给 `B4`，模型会去改 L1 附近的主干——那里离目标区 20 多格，且物理上可施工
  （`insert_machine` 在 (1,-33)/(2,-33)/(1,-34)/(2,-34) 全 OK），于是**语义层主动把模型引到错误位置**。

**修法**：删掉"到 hub 跳数升序"，换成"**目标形状离成品还差几步工序升序**"或"该流是否已含目标原料；
其次才是句柄"。并明确 hops 是"链头还是链尾"——现在没定义。

---

### F-3 接受集不全：x=2、x=3 两列也是合法解，§8/T1 只认 x=4

**问题**：§7 T1 写「`site_handles` 合法集 = `y∈{-14..-9}` 共 6 行」，§8 写「L4 实测 = `y∈{-14…-9}` 6 行」。
实测（`node .tmpverify/rt/rows4.mjs`、`altx2.mjs`）：

| 落点 X | `replace_run` 可施工的 Y（region=[X,Y-1,X+1,Y]） | 行数 |
|---|---|---|
| 2 | -15,-14,-13,-12,-11,-10,-9 | **7** |
| 3 | -14,-13,-12,-11,-10,-9 | **6** |
| 4（历史正解） | -14,-13,-12,-11,-10,-9 | 6 |
| 5 | 无（x=6 没有可替换的带子） | 0 |

x=2 的解我做了完整闭环验证（`altx2.mjs`）：

```
cutter@(2,-13): 输入 (2,-12) ← M1 的 RuRuRuRu 链
  左口 (2,-14) → trash
  右口 (3,-14) → B67 → … → balancer#10084 → … → balancer#10083 → … → HUB
cutter emits left ----RuRu   right RuRu----
```

即：**同样能造出 `RuRu----` 并送达 hub**。x=3 同理（输入 (3,-12)，右口 (4,-14) → B69 → B63 → L3 → hub）。

**后果**
- §8 的 PASS 判据写死「落点 ∈ x∈{4,5}(实际只能是 4), y∈[-16,-8]」，会把 x=2/x=3 的正解判 FAIL。
  这正是第十二轮"判据本身错"的同型事故——契约声称要避免它，自己又犯了一次。
- 反过来，§8 的负对照 `cutter@(4,-8)+trash@(4,-9)` **根本施工不了**：
  `insert_machine` 报 `blocked_by_machine: footprint 覆盖到 miner@4,-8`；`replace_run` 报 `not_a_run`。
  负对照必须换一个真能落、但确实错的点（例如 `cutter@(6,-13)`，`insert_machine` 接受、但四周没有可接的带子）。

**修法**：接受集不要写成坐标区间，写成**几何谓词**（"cutter 输入槽被向上喂、右口下游能到 hub、左口下游是 trash"），
实验脚本按谓词枚举；T1 只断言"至少一个解满足谓词"，不断言行号集合。

---

### F-4 `WRONG_SHAPE_AT_HUB` 会把 hub 入口顶到 BELTS 最前——与"阻止改入口"目标相反，且无任何禁止机制

**问题**
- §5 声称「第 1 条 `WRONG_SHAPE_AT_HUB` 起作用」「预期模型不会去改 hub 入口」。
- 但 `pickBelts` 的第一优先级是 `referencedHandles(diagnoses)`（`prompt.mjs:574-593`），
  它**把诊断的 `evidence.handles` 和 `subject` 全部提前**。`WRONG_SHAPE_AT_HUB` 的 evidence 必然是
  hub 入口带子（否则它说不出"hub 收到 X 和 Y"）。

**证据**（真 `buildPrompt`）

```
evidence ["H1"]                    → BELTS 前 5：B63,B69,B81,B90,B97
evidence ["H1","B135","B137"]      → BELTS 前 5：B135,B137,B63,B69,B81
evidence ["H1","B135","B136","B137"] → BELTS 前 5：B135,B136,B137,B63,B69
```

也就是说：**新增这条码的直接效果，是把 `B135/B136/B137` 从"没出现"变成"第 1–3 位"**。
§5 第 3 点还把这件事当成优点（"把句柄级改点顶到 BELTS 段最前"），但它顶上去的是要被排除的那三条。

**且没有任何机制阻止改入口**（`hubedit2.mjs` / `hubedit3.mjs`）：

```
remove_run({uids:[10074]})                    → OK   （删 B135 允许）
replace_run({region:[-2,-3,-2,-3],building:'belt'}) → OK （把 B135 原地重铺允许）
connect(from, to:{hub:{entry}})               → port_already_bound / occupied（这条被挡）
```

`remove_run` 的 warnings 只有 `would-disconnect` / `stranded-items-unknown`，**不是拒绝**。
prompt 里也没有任何一句禁止（`grep hub|inlet` 只有 HUB 段与标记说明两处）。

**后果**：契约把"模型不会改入口"完全押在一条**会把人往入口引**的诊断上。
实证也不支持：审计 agent 从 `llm_raw` 复算，按"args 里真的出现 B135/B136/B137"计，
第十轮 **1/10**、第十一轮 **2/10**、第十二轮 **2/10**；带标记与不带标记**无可辨识差异**。

**修法**
1. `WRONG_SHAPE_AT_HUB` 的 evidence **不许**放入口带子，只放 hub 句柄 + 形状串（`buildPrompt` 的
   `referencedHandles` 只对带子生效，放 H1 不会污染 BELTS）。
2. prompt 的 S6 加一条硬规则：「hub 入口的问题由 HUB 段描述；不要 remove/replace hub 入口带子」——
   当前没有。
3. 真要禁止，就得做 §5 自己说"本次不做"的 `REPAIR_OFF_TARGET`。

---

### F-5 隧道事实错：L4 的 B85 不是"停住"，它把产品送进了 trash

**契约原文**（§0 F3、§3、§5 第 4 行、§10 反例 3）：
> 「右口（北, -7,-12）→ `underground_belt#10077`（隧道）⇒ **停住，出不去**」
> 「产品 `CuCu----` 卡在隧道里」
> 「`SHAPE_UNKNOWN{reason:"tunnel"}` 这条流穿过隧道」

**实测**（`node .tmpverify/rt/facts.mjs`，读上游源码 + 夹具 + 真实 `debug_items` dump）：

```
tunnel 10077 (-7,-12) code 22 sender r0  searchDirWorld top
   along: [{d:2, uid:10078, code:23, mode:receiver, r:0}]
tunnel 10078 (-7,-14) code 23 receiver
   receiver ejects to [-7,-15] -> trash#10037
ejector dump: {"cell":[-7,-14],"slot":0,"item":"CuCu----","progress":0.7875}
```

- 配对规则（`recon/upstream-full/src/js/game/systems/underground_belt.js:246-285`）：sender 沿自己朝向前方
  ≤5 格找同 tier、同 rotation 的 receiver；`(-7,-13)` 是普通带子、跳过，`(-7,-14)` 命中。
- receiver 的 ItemEjector 朝 top 喷 → `(-7,-15)` 正是 `trash#10037`。

⇒ **产品不是"卡住"，是被隧道送进垃圾桶销毁了。** 隧道不是"信息缺失"，它的去向完全由 obs 决定。
（另测：L11 上 91 个 sender **91 个**都能在 obs 里找到配对 receiver。）

**后果**
- 契约要对 B85 出 `SHAPE_UNKNOWN{tunnel}`，等于**把 L4 最关键的病灶藏起来**：
  真正该说的是「C1 的右口（产品）经隧道进 trash，左口（废料）进 hub」。
- `SHAPE_UNKNOWN` 又被定为 info 且"不许喂 LLM"，于是这条信息在 prompt 里彻底消失。
- 连带 §5 第 3 行「`OFF_RECIPE_LINE subject=C1`」也站不住：按定义该码的 subject 是**流头**（M1/L7），不是 C1。

**修法**：给 `underground_belt` 补一个模板（sender/receiver 各一个槽），配对按源码规则从 obs 算；
隧道不是屏障，是一条普通边。真算不出时才降级（例如 tier2 或跨区缺格）。

---

### F-6 形状传播的三处硬伤：pigment/color 未建模、多输出未按槽、B113 根本不可算

**（a）`B113` 在夹具上算不出来，§2 的示例断言无法复现**

§2 写「`shape(B63…B113) = RuRuRuRu`」。实测：

```
miner M3 @(4,-8) 底下资源格 = RuRuRuRu
miner M4 @(5,-8) 底下资源格 = null（夹具的 resources[] 里没有这一格）
B63  = (4,-15) → RuRuRuRu  ✅
B113 = (5,-9)  → ?no-resource / 不可算  ❌
```

`miner.js` 的 `tileBelow = map.getLowerLayerContentXY(origin.x, origin.y)`（`recon/.../systems/miner.js`）确认：
矿机只挖**自己 origin 那一格**。
**但这不一定证明 M4 真的空转**：`resourceSnapshot` 是稀疏的（只 push 有 item 的格，`shapez-ai-bridge.js:1497-1530`；
L4 夹具 484 格 / 27 chunk，工厂窗口 26×21 里只报 35 格），所以"缺格"也可能只是快照没覆盖。
⇒ 契约把「两条链都运 RuRuRuRu」当作已核实事实，**它的证据不够**；必须在实机确认 M4 底下有没有矿。
若是空转，§0/F3、§5、§8、§13.1 的所有"两条链"叙述都要改；若不是，则 §2 的传播必须能处理稀疏资源。

**（b）pigment/color 流完全没有规则**

§2 的传播表只有 `cut / rotate / stack / paint / balancer / miner`，没有：
- `mineColor`（L11 上 **73 台**颜色矿机）、`mixer`（L11 上 24 台）、`color:*` 流（`getAsCopyableKey` 对 ColorItem 返回
  `"green"` 而不是形状串，`shape-ops.parse("green")` 直接 `AssertionError`）。
- `paint` 的**颜色入槽**怎么从一条"颜色带"取色——契约只说"颜色解析不出 ⇒ 未知"，但没定义"颜色流"这种类型。

实测（`alloc.mjs` 在 `research/ai-player/facts/live/world-full.json` 上跑）：
```
L11: streams 662 | known 60 | unknown 602（其中 ?color 64）| painter 输出全部 ?unmodeled:painter
```
⇒ 真实存档上语义层的覆盖率 **9%**。契约说"L4 就是活例"，但 L4 是 16 条流、形状 2 个的玩具；真实存档 662 条流。

**（c）多输出机器必须按"输出槽"传播，契约没写**

`cutter` 的两个口形状不同（`RuRu----` vs `----RuRu`）。若按"机器输出取并集"实现，`B135` 会得到
`{----CuCu, CuCu----}`，而 §5 期望的是「hub 收到 `RuRuRuRu` 与 `----CuCu`」——**两种输出不会出现**。
实测第一次原型就是这么错的（`shape at hub inlet B135 = ----CuCu|CuCu----`），改成"按输出槽追溯"后才对上。
契约的传播表把 `cutter` 写成"cutHalf()[0]=left,[1]=right"，但**没说流的形状是该机器哪个口的**。

**修法**：流的定义必须携带 `(producerEntity, outputRole)`，不能只有"链头形状"。

---

### F-7 prompt 预算：契约的诊断量会把 BELTS 压空、并把 RECIPE 丢掉

**问题 1：`buildPrompt` 的截断循环有一个真 bug**（`src/agent/loop/prompt.mjs:1207`）：

```js
let user = [s2, goalAndRecipe, ...].join("\n\n");          // 第一次：带 recipe
while (...) {
  user = [s2, s3Goal, s3Hub, ...].join("\n\n");            // 缩带子时：换成 s3Goal，recipe 永久丢失
}
```

只要触发一次截断，**RECIPE 段就从最终 user 里消失**，而契约 §9/P-c 正要把 recipe 作为关键输入。

**问题 2：诊断条数与预算**

真 `buildPrompt` 实测（`node .tmpverify/rt/promptcost.mjs`）：

| 诊断集 | chars | S4 | belts shown | recipe 还在? | over_token_budget |
|---|---|---|---|---|---|
| ① 契约 §5 期望的 5 条 | 8659 | 904 | 12 | 是 | 否 |
| ② §1 字面算法在 L4 的 13 条（6 blocker + 7 warn） | 9781 | 2989 | **2** | **否** | 否（但有效） |
| ③ T4 场景：L5 无 resources → 18×SHAPE_UNKNOWN + 1 | 10493 | 3625 | **0** | **否** | **是** |

- ②：BELTS 只剩 `B110,B111` 两条，正解三条**全部消失**；recipe 被丢。
- ③：直接 `over_token_budget=true`，一条带子都看不到。
- 而 §3 说 `SHAPE_UNKNOWN` 是 `candidates:[]` 且"**不许喂给 LLM**"—— 但 `renderDiagnoses`
  （`prompt.mjs:1057`）**不看 severity、不看 candidates，逐条打印**。实测 `SHAPE_UNKNOWN` 原样进 prompt。
  要兑现"不许喂"必须在 prompt 侧加过滤，§9 的文件清单里没有这一项。

**问题 3：§5 的 5 条刚好把 `B82` 挤出去**

```
shown = B135,B137,B63,B64,B85,B69,B81,B90,B97,B105,B112,B70
B69/B81/B82 可见 = [true,true,false]
```

`B82` 是 x=5 列的目标格之一。§5 说「T1 断言无 subject 为 B135/B136/B137 的码」，
但 `WRONG_SHAPE_AT_HUB` 的 evidence 含 B135/B137 → 它们占据 BELTS 第 1–2 位，
把 `B82`（以及 x=5 列的 `B70` 之后）挤出 12 个名额。`$path_of` 少一条并排链 → region 宽 1 → cutter 放不下。
**新诊断越"准"，模型可用的改造窗口越窄。**

**修法**：给 S4 设条数上限（按 severity 优先、blocker 前 N 条），并修 1207 行的 `s3Goal → goalAndRecipe`。

---

### F-8 句柄会因一次 apply 重编号，跨轮指纹不可比；`fingerprintOf` 又根本不看语义字段

**证据**（`summary.mjs` [4]）：

```
修复后句柄变更 96/181
旧 C1(uid 10036) = C1 → C2；新 cutter(uid 10224) 得到 C1
B84(10059) → B81；B135(10074) → B132；B137(10183) → B134
```

`buildHandles` 按 `(y,x)` 排序编号（`handles.mjs:58-63`），插一台机器就会让其后所有同前缀实体顺移。
语义诊断的 `subject` / `evidence.handles` 全是句柄 ⇒ **同一语义问题在两轮之间换了名字**。
`NO_PROGRESS_3X` 数的是 `fingerprintOf`，它变了 ⇒ 系统认为"有进展"。

契约 §4 的"防指纹抖动"只写了"evidence 只能含稳定量"，**没有处理句柄本身不稳定**这件事。

**第二半**：`fingerprintOf`（`loop.mjs:255-266`）只取 `code / layer / subject / evidence.handles / evidence.uids`。
契约 §4 说"evidence 禁止放窗口计数、itemsOnPath、时间戳，否则指纹抖动"——实际上那些字段**根本进不了指纹**，
写了也不会抖。反过来，契约允许的 `shape / need / have / scope` 也进不了指纹 ⇒
「同 code 同句柄但形状不同」会被折叠成同一指纹。这条纪律的作用被说反了。

**修法**：语义码的 subject 用 **uid**（进指纹的 `uids`）而不是句柄；或在 apply 后重建指纹基线。

---

### F-9 "零 `node:` import" 与复用既有几何不可兼得

§6 说 `diag_semantics.mjs` 要「零 IO、零 `node:` import」，§9 又说"不重写代数"，§2 说"用仓库既有代数"。

但仓库里唯一能算槽位的是 `verify_runtime.mjs#slotsOf` → `op-templates.mjs#templateByBuildingVariant`：

```
src/agent/verify_runtime.mjs:53-55   import fs / path / fileURLToPath  from "node:..."
src/ai/op-templates.mjs:47-48        import fs / path                 from "node:..."
```

⇒ 只要 import `slotsOf`，`node:` 就进来了，T6 的源码扫描（`spawnSync|child_process`）虽不命中，
但 §6 的"零 node: import"这条自律落不了地。要么放宽成"零 IO / 零 child_process"，要么自己重写槽位几何
（第二份真值——本仓库已经因两份真值出过至少 3 次事故，`belt-rules.mjs` 头注就写着）。

**修法**：把 T6 改成"源码扫描不含 `child_process|spawnSync|fetch`"，并在文件头写明"允许 import verify_runtime 的纯函数"。

---

### F-10 `PROCESSOR_REQUIRED` 的字段名与 scope 自相矛盾

同一个码，契约里出现三种形态：

| 位置 | 写法 |
|---|---|
| §3 码表 | `PROCESSOR_REQUIRED`，layer L4/blocker，candidates replace_run/insert_machine/connect |
| §5 第 2 行 | `PROCESSOR_REQUIRED(scope=stream)`，subject `L3` |
| §7 T1 | `PROCESSOR_REQUIRED{op:"cut",scope:"stream",need:1,have:1}` |
| §7 T4 | `PROCESSOR_REQUIRED{kind:"rotater",scope:"factory",need:1,have:0}` |

- `op` 还是 `kind`？T1 用 `op:"cut"`，T4 用 `kind:"rotater"`。实现只能选一个，另一个测试必红。
- `scope:"factory"` 的触发（工厂该类机器总数 < need）**不在 §3 的触发条件里**（§3 只写"分配器残余"）。
- `have:1` 与 `need:1` 同时出现在 T1，按 §1 的分配语义应该已经"满足"，不该报——T1 期望的这条自身就矛盾。

**修法**：定一个字段（建议 `kind`，与 `op-templates` 的 `kind` 对齐），把 `scope` 的两种触发分别写进 §3。

---

### F-11 §8 的负对照施工不了

§8 要求负对照 `cutter@(4,-8)+trash@(4,-9)`「旧判据会 PASS，新判据必须 FAIL」。
实测（`summary.mjs` [5]、`finalcheck.mjs`）：

```
insert_machine(cutter@(4,-8))  → blocked_by_machine: footprint 覆盖到 miner@4,-8（uid=10081）
replace_run([4,-9,5,-8])       → not_a_run（region 里有矿机）
```

**这台机器物理上就放不下**，负对照跑不起来，也就不能"证明旧判据有洞"。
换一个能落的错误点：`cutter@(6,-13)`（`insert_machine` 接受，但四周无带可接）或 `cutter@(2,-30)`（主干上，
能落、但会把产品送进 balancer 的另一路）。

---

### F-12 §8 的行为基线 `6/10` 已被本轮审计撤回，契约仍拿它当成功判据

契约 §8：
> 「行为层（最灵敏）：`touched hub inlet without fixing the Ru line` 从基线 **6/10** 降到 **≤1/10**」

`research/ai-plan/PROMPT-TOHUB-AUDIT.md` §C.1 的原话：
> 「第十轮 6/10 盯 hub 入口 **不成立**：按定位口径是 **1/10**……那 6/10 是数'`say` 里出现了 hub 这个词'」

我用审计脚本复算（`node .tmpverify/tohub_raw.mjs`，按 `calls[].args` 里是否真的出现 B135/B136/B137）：

```
第七轮 3/5 | 第九轮 3/5 | 第十轮 1/10 | 第十一/十二轮 2/10 | 第十二轮 2/10
```

⇒ 基线是 **1/10**，成功线 **≤1/10** 意味着"零改善也算成功"。这条判据要么写成"目标：从 1/10 降到 0/10（且分母 ≥20）"，
要么放弃。**这是硬事实错误，不是笔误。**

---

## 硬事实核实表

| # | 契约断言 | 判定 | 证据 / 命令 |
|---|---|---|---|
| F1 | solver spawn 200–400 ms，中位 263 | **成立** | 今日 10 次 `172,180,194,225,229,230,236,266,272,276`，median **230**；裸 `node -e 0` median **233** ⇒ 成本全在 node 启动（`summary.mjs` [2]：`buildPrompt` 单次 **358 ms**） |
| F2 | 标 105 条、真不可达 23 条 ⇒ 87 误标 | **数字成立**，但状态写"待补" | 审计 §A.5：105−18=87；契约 §9 还计划"标记改基于 goalRelevant"，而审计 §D 说这么改会让正解可见率 **10/10→0/10** |
| F3 | L4 病理是"送错"不是"断" | **方向成立，机制有两处错** | ① 产品不是"卡在隧道"，是 sender→receiver→**trash**（F-5）；② B113 不可算（M4 无矿，F-6a） |
| §11 | 修好后 x=5 上半段被 cutter 本体堵死 | **成立** | `(5,-12)` 的 B91 出口指向 `(5,-13)`；修复后该点被 cutter#10224 占用（`dumpcheck.mjs`：`DUMP B88@5,-12 → cutter#10224`） |
| §0 行号 | `loop.mjs:550 diagnose()` | **成立** | `grep -n "export function diagnose" src/agent/loop.mjs` → `550` |
| §2 | `shapeAt(B63)=RuRuRuRu` | **成立** | 按输出槽传播：`B63 → … → M3@(4,-8)，资源 RuRuRuRu` |
| §2 | `shapeAt(B135)=----CuCu` | **成立**（需按槽，不是并集） | 按槽追溯 → C1 `left`；若取并集会得到 `----CuCu｜CuCu----` |
| §2 | `shape(B63…B113)=RuRuRuRu` | **无法复现** | 夹具 `resources[]` 里 `(5,-8)` 缺格 ⇒ B113 不可算；但资源快照本身稀疏（见「遗漏」第 7 条），需实机确认 M4 是否真的空转 |
| §0 L5 | 「cutter 把产品的一边扔掉」 | **措辞不准** | `cutHalf(CuCuCuCu)` 左 = `----CuCu`，`rotateCW(----CuCu)` = **`Cu----Cu`** ⇒ 左半也是合法中间产物，不是"废料"；真正缺的是 rotater |
| §6 | `prompt.mjs` 每次 `buildPrompt` spawn 一次 solver | **成立**，但调用频率说低了 | `recipe.mjs:66` spawn；`prompt.mjs:1182` 每次调用都跑。`buildPrompt` 是**每 LLM call** 调一次（`loop.mjs:1515`），`LLM_CALLS_MAX=8` ⇒ 一次 run 最坏 8×358 ms，不是"每轮×3" |
| §6 | level<16 加 `--no-cutquad` | **成立** | `solver.mjs:444` 有该 flag；`compile.mjs:248` 已有先例 |
| §0 F2 状态 | "审计 agent 在查（结论待补）" | **已过时** | `PROMPT-TOHUB-AUDIT.md` 已落盘且结论与契约 §9 的计划冲突 |
| §3 | `SHAPE_UNKNOWN` candidates=`[]`，"不许喂给 LLM" | **不成立（当前实现）** | `prompt.mjs:1057-1083` 不按 severity/candidates 过滤；实测 `SHAPE_UNKNOWN` 原样出现在 `p.blocks.S4` |
| §7 T6 | "无 recipe 时 500 次 < 1s" | **仅当语义层关闭时成立** | 现有 `diagnose` L4 **1.07 ms**（500 次 534 ms）；加语义原型 **+2.10 ms** ⇒ 500 次 **1582 ms**；L11 `diagnose` **17.7 ms**，语义 **+33 ms** |

---

## 过度设计（该砍的）

1. **`GOAL_SHAPE_STRANDED` 在两份夹具上触发 0 次**（L4 16 条流、L11 662 条流都测过）。
   它要"流头形状 == goal 且到不了 hub"——在"流头 = 矿机/工序输出"的定义下几乎不可能出现
   （goal 形状只会出现在工序**之后**，而工序之后若到不了 hub，流会在机器处断掉，不会以 goal 形状做头）。
   建议先删，等真实出现再补。
2. **三层（L4/blocker、L4/warn、L4/info）在 prompt 里没有消费者**：`renderDiagnoses` 只打印 `[L4/severity]` 字样，
   不做任何优先级选择；而 `candidatesFor` 是按码查表、与 severity 无关。要么给 S4 加 severity 优先级，要么砍掉 severity 分级。
3. **"配方闭包"这个概念被当成集合成员判定用，但真值就在 `debug_items.belts[].item`**：
   `research/ai-plan/tmp/di-all.json` 里 97 条带子带 `item`（`CuCuCuCu:59, ----CuCu:4, RuRuRuRu:24, RuRu----:10`），
   `ejectors[]` 直接给机器出口的物品。这是**运行时真值**，比从矿机推 50 跳便宜得多，而且能直接回答
   「这条带现在流的是什么」。契约完全没提它（`grep items` 只在"不可用"里出现）。
   语义层的价值应该是**补 items 看不到的部分**（上游/下游/应在何处），不是重算 items 已经给出的部分。
4. **7 个码里 3 个（`WRONG_SHAPE_AT_HUB` / `OFF_RECIPE_LINE` / `SHAPE_UNKNOWN`）在 L4 会把 S4 撑到 2–3 KB**，
   而 S4 是"永不截断"的段。新增码必须同时给 S4 设上限，否则"加语义"直接导致"看不到带子"（F-7）。

---

## 遗漏（契约没提但一定撞上的）

1. **`items` 已经在手里却被丢弃**：`diagnose(obs, items, …)` 收到 items 后只用于 `buildHandles`（`loop.mjs:556`），
   之后从未解引用。`debug_items.belts[].item` + `ejectors[].item` 是"这条带/这台机器在流什么"的直接真值。
2. **`paint` 需要**颜色源**，而颜色不是形状**：`getAsCopyableKey()` 对 ColorItem 返回 `"green"`；
   `shape-ops.parse("green")` 抛 `AssertionError`。契约的 `closure` 是 `steps[].hash` 字面集合，
   里面混着 `color:green` 这种 pigment 节点，与 shape 串不同域。实现时必然要在"颜色流"上分叉。
3. **`mixer` 完全没提**（L11 有 24 台）。`solver` 会产出 `mix:color:cyan`，`OP_TO_MACHINE` 表里没有 mixer。
4. **目标形状会随关卡变化**：L4 是 `RuRu----`（level 4），L5 是 `Cu----Cu`（level 5）——这是夹具里就摆着的两个真实档。
   `st.recipe` 按"每 run 一次"缓存，用的是 `opts.goal`（run 开始时的形状）；若 run 跨过升级，goal 串与 recipe 都会过期。
   契约的缓存键 `${goal}|${level}` 说明它知道 level 会变，但"每 run 一次"的预计算点没有重算触发。
5. **`trash` 作为流的终点没有定义**：§1 的边界列表是「矿机输出 / 机器输出槽 / hub / 断开点 / 隧道口」——**没有 trash**。
   而 L4 的核心病灶正是「C1 右口 → 隧道 → trash」。没有 trash 边界，这条流会被算成"断"，或被隧道降级吞掉。
6. **多输出机器的流头身份**：流的身份必须是 `(producer, outputRole)`；只写"链头句柄"无法区分
   cutter 的 left/right、balancer 的 primary/secondary、painter 的 out。§1 的排序键第 4 项也依赖这个定义。
7. **资源快照是稀疏的，不能把"缺格"读成"无矿"**：L4 夹具 484 格 / 27 个 chunk（chunk 16×16），
   工厂窗口 26×21 里只报 35 格。`resourceSnapshot` 只 push 有 item 的格（`shapez-ai-bridge.js:1497-1530`）。
   M4@(5,-8) 是"真没矿"还是"快照没覆盖"**必须实机确认**——这直接决定 §2 的示例是否成立。
8. **`debug_items` 在真桥要 `region`，loop 传 `{}`**：`makeBridgeReader.debugItems(p || {})`（`loop.mjs:1981`）
   → mod `debugItems` 对非四元 region 抛 `2001 invalid_action` ⇒ **真机上 items 永远不可用**。
   契约说"语义码只依赖 obs+recipe"是对的，但它在 §4 又要求 evidence 不含 `itemsOnPath`——两句话都在回避一个既有 bug。
9. **句柄重编号**（F-8）：一次 apply 后 96/181 个句柄变了，`C1` 从旧 cutter 换到新 cutter。
10. **诊断条数没有上限**：§3 只给单码定 severity，没有给"一轮最多报几条"。T4 场景 19 条就把 prompt 撑爆。
11. **`obs.truncated` 时语义层返回空**：但 `loop.mjs` 在 truncated 时**直接 halt**（1450-1457），永远不会调 diagnose 的第二参数。
    这条防线是死代码（无害，但说明契约没对齐 loop 的真实控制流）。
12. **`fingerprintOf` 与 evidence 的关系说反了**（F-8 后半）。

---

## 我攻击不动的三条（防全盘否定）

1. **`diagnose` 的纯函数性与指纹稳定性（在"同一份数组"意义上）成立。**
   `loop.mjs` 无 `spawnSync`/`child_process`；同 obs 连调两次指纹相同（`summary.mjs` [1]：`true`）。
   "diagnose 不许 spawn、配方由 loop 注入"这个裁决是对的。

2. **F1 的性能事实成立，且量级判断正确。**
   solver 墙钟 median 230 ms（今日 10 次），裸 `node -e 0` median 233 ms ⇒ 耗时几乎全是进程启动。
   把 solver 从"每次 buildPrompt"降到"每 run 一次"，能省掉约 0.7–2.5 s/run。这条值得做。

3. **`recipe.mjs` 没有 level 门控是真 bug，修法正确。**
   当前 `recipeBlock("Cu----Cu")` 输出：

   ```
   ------Cu ⇐ cutQuad(quad=3)   Cu------ ⇐ cutQuad(quad=0)   Cu----Cu ⇐ stack(merge=true)
   ⇒ machines this shape needs: miner×1, cutter×2, stacker×1
   ```

   而 level 5 合法解是 `mine → cut(half=left) → rotate(cw)`（`solver --no-cutquad` 实测）。
   `compile.mjs:248` 早就在做同一道门控，`recipe.mjs` 是唯一漏掉的消费方。T7 的判据正确。

4. **`shapeAt(B63)=RuRuRuRu`、`shapeAt(B135)=----CuCu` 两条断言本身是对的**（前提是按输出槽传播）。

5. **"T3 是最便宜、零方差的证伪手段"这个方法论我同意**——问题只在于按当前判据它会红（F-1）。

---

## 附：复现命令

```bash
# 一条命令跑出报告里的主要数字（指纹/耗时/Ru 流/句柄重编号/可施工落点/prompt 预算/组件相关）
node .tmpverify/rt/summary.mjs

# 按契约 §1 的排序键在 L4 与修复后的 L4 上重算分配与残余
node .tmpverify/rt/verdict2.mjs

# 最宽容的 T3 实现（下游已有 cutter 即算满足 + 闲置 cutter 分配）
node .tmpverify/rt/t3charitable.mjs

# 隧道配对与 trash 去向（sender 10077 → receiver 10078 → trash#10037）
node .tmpverify/rt/facts.mjs

# 三种诊断集对 prompt 预算/可见性/recipe 的影响
node .tmpverify/rt/promptcost.mjs

# 接受集枚举：x=2 有 7 行、x=3 有 6 行、x=4 有 6 行、x=5 为 0
node .tmpverify/rt/rows4.mjs

# x=2 的完整解：右口 → balancer L2 → L1 → hub（形状 RuRu----）
node .tmpverify/rt/altx2.mjs

# 契约基线 6/10 的复算（按 calls[].args 定位口径，用的是仓库里既有脚本）
node .tmpverify/tohub_raw.mjs
```

> 全部证据都来自 `node .tmpverify/rt/summary.mjs` 这一条命令；其余脚本是它的分解版。
> 纪律：只读夹具/仓库内 dump，不写世界、不连游戏实例；未改任何 `src/` 文件
> （`git diff --stat -- src/agent/loop.mjs` 的 81 行改动在本次会话开始前就存在，见开场 `git status`）。
> 回归：`node --test src/agent/loop/prompt.test.mjs` → **fail 0**；
> `node --test src/agent/loop/constants.test.mjs` → **fail 0**。
