# E2E 验收：宏库能否表达一次真实的就地改造

> 状态：已完成（只读验收，零游戏写操作）

## 0. 裁决：**判据达成**（1 次宏调用），但前提是「就地改造」被缩到单个 region 内

宏库用 **1 次** `replace_run` 就完整表达了 L4 改造（判据 ≤5）。独立核对：删除集合、
cutter 几何、输入/输出槽朝向、trash 落点全部正确。**主链路没有静默错误。**

但有三处报告/接口缺陷（§3.5、§3.6）：`sideEffects` 漏报一条真断线、
`dry_run` 语义易误读、2×1 机器的 `{cell}` 落点形态永远不可用。

另外这次调用在宏实现里是「扩展路径」（`remove.mjs` 文件头登记的扩展 1），
并非 `contract.mjs` 的 v1 原文；且它只做规划、`dry_run:false` 也只是标记，
真正落盘仍需外部 tx。见 §6。

## 1. 宏调用序列（逐次列出，含参数和返回）

世界：`research/ai-plan/live-L4-entities.json`（181 实体）。
离线调用（`ctx={entities}`，宏不写世界）。

### 调用 1（唯一一次）

```js
replaceRun({
  region: [4, -14, 5, -13],
  building: ["cutter", { kind: "trash", port: "left", confirm_waste: true }]
}, { entities })
```

返回（节选，全部来自实际输出）：

```
ok=true  cells_planned=6  cells_placed=6  flow="top"
removed = [10143@(4,-14), 10209@(4,-13), 10149@(5,-13)]     // 3 条，全是 belt
kept    = [10150@(5,-14)]                                    // 1 条，原样保留
placed  = cutter origin [4,-13] rotation 0, cells [[4,-13],[5,-13]]
            in : primary @ cell (4,-12) face bottom
            out: left  @ cell (4,-14) face top
            out: right @ cell (5,-14) face top
          trash  origin (4,-14)   ← 正好是 left 槽的喷口格
summary = {removed:3, placed:2, kept:1}
warnings = ["kept-belts"]
sideEffects = kept-belt-starved(10150) / starved-belt(10144) / starved-belt(10150)
```

注意 `region` 是契约明确允许的唯一 bbox 参数；`building` 里没有坐标。
这就是全部输入 —— 没有一格 x/y、没有一个 rotation 角度。

（我另外试过把同一件事拆成 `remove_run` + `insert_machine` + `trash_unused`
三次调用，语义上等价；`replace_run` 的扩展路径只是把它们打包。）

## 2. 宏调用次数统计（对比判据 ≤5）

| 调用 | 宏 | 作用 |
|---|---|---|
| 1 | `replace_run` | 区带→cutter + trash |

**总计 1 次**，判据 ≤5 的余量为 4。

但要如实记一笔：这个「1 次」不是宏库的自然粒度，而是 `replace_run` 的
**扩展路径**（`remove.mjs` §扩展 1）把「放机器 + 删覆盖带 + 放 trash + 后验拓扑」
四件事打包进了一个宏。契约 `contract.mjs` 的 v1 原文里 `replace_run.building`
只支持 `"belt"`，其余会报 `unsupported_building`。

若按契约原义拆解，同一件事至少要 3 次调用（`remove_run` → `insert_machine` → `trash_unused`），
仍在 ≤5 内。我实测了这个拆法：前两步 ok，**第三步失败** `bad_type` ——
因为 `insert_machine` 只返回计划（`uid:null`），`trash_unused` 的 `uid` 必须 ≥0。
也就是说**离线规划态下宏之间无法串接**；真实执行时必须
`remove_run → tx → obs → insert_machine → tx → obs → trash_unused`，
3 次宏调用 + 3 次世界重读。这解释了为什么 `replace_run` 的扩展路径有必要存在。

## 3. 结果正确性独立验证

**不读宏的 `ok`，用返回的计划重建世界后自己算。**

### 3.1 删除集合
实际 `removed` = `[10143, 10149, 10209]`，与任务给的三条 uid **集合相等**。
原实体类型逐一确认均为 `belt`（`r=0, rv=0, code=1`）。

### 3.2 cutter 几何
- origin `[4,-13]`，rotation `0`，footprint `[[4,-13],[5,-13]]` = 2×1，符合模板。
- 输入槽：`primary`，槽格 `(4,-13)`，面 `bottom` ⇒ 带格 `(4,-12)`。
- 输出槽：`left` 槽格 `(4,-13)` 面 `top` ⇒ 带格 `(4,-14)`；
  `right` 槽格 `(5,-13)` 面 `top` ⇒ 带格 `(5,-14)`。

### 3.3 关键：槽位方向是否真的接上
用 `belt-rules` 直接算原存档里那两个邻居：

```
(4,-12) uid=10208 belt  entry=bottom exit=top   → exit===OPP[bottom] ✅ 有货喷进输入口
(5,-14) uid=10150 belt  entry=bottom exit=top   → entry===OPP[top]    ✅ 会从右槽接货
(4,-11) uid=10206 belt  exit=top                → 仍然喂 (4,-12)      ✅ 上游没断
(5,-15) uid=10151 belt  entry=bottom exit=top   → 下游链完整
```

即：**上游 `(4,-12)` → cutter 输入；cutter 右槽 → `(5,-14)` → `(5,-15)` → balancer**，
主通路自洽。`RuRu----` 的左槽产物被 `(4,-14)` 的 trash 永久销毁 —— 与目标形状一致。

### 3.4 trash 落点
`(4,-14)`，正好等于 left 槽 `slot + DIRV[top]`。不是"附近一格"，是精确喷口格。

### 3.5 发现的三处问题
1. **`sideEffects` 漏报了一条真断线**：`10148@(5,-12)` 的 exit=top 指向 `(5,-13)`，
   而 `(5,-13)` 现在是 cutter 机身（2×1 的第二格）。它的正下游已经不存在，
   按 c 语言口径就是「被机器吃掉」。宏只报了 `kept`/`removed` 一侧，没报「谁指向 removed」。
   （注：`10208@(4,-12)` 指向 `(4,-13)` 是**合法**的 —— 那里正好是 cutter 输入槽的带格。）
2. 返回 `dry_run:false`，但 `remove.mjs` 文件头写「dry_run 恒为 true」。二者矛盾 ——
   实际语义是「这次调用没要求 dry-run」，而不是「已经写入」。这个字段名容易误读。
3. `(5,-16)` 是空的：`10151` 的出口指向空格。这是存档原有死路，不是本次改造引入。

### 3.6 契约文档与实现的一处硬冲突
`insert_machine` 的 `{cell:[x,y], part:"any"}` 形态，对 **2×1 机器永远不可用**：
`{cell:[4,-13]}` 实测返回 `ambiguous_site`（反解出 2 个 origin）。
于是调用方只剩 `at:[4,-13]`（origin 裸坐标）一种写法 —— 契约号称「调用方一个坐标都不给」，
在 2×1 机器上实际做不到。

## 4. 变体测试（哪些被正确拒绝）

| # | 变体 | 结果 | 评价 |
|---|---|---|---|
| V2 | `insert_machine` 只给 cutter，不给 trash（at `[4,-13]`, facing top） | **ok=true**，`wiring` 三个槽全 `ok`；只报 `orphaned_upstream(10148)` | 危险：左槽（废料侧）喷向 `(4,-14)` 的带子 `10143`，宏判定"有去处"并放行。**废料混入下游不会被拒** |
| V3 | `insert_machine` facing=`bottom`（反向） | ok=true，但 rotation=180 + 10 条警告（`input_belt_wrong_direction`、`wiring_mismatch`…） | **软失败**：不 return error，靠 warnings 表达"接不上" |
| V4 | `facing=90`（角度当方位） | **ok=false**, `bad_type` | ✅ 正确拒绝 |
| V5 | `replace_run` region 全是空地 `[10,10,12,12]` | **ok=false**, `precondition_failed` "region 里没有任何带子可替换" | ✅ 正确拒绝 |
| V6 | `replace_run` region 含 balancer `[4,-16,5,-14]` | **ok=false**, `not_a_run`，指名 `10085@(4,-16)` | ✅ 正确拒绝 |
| V7 | `extend_line` 从非末端 `10150` | **ok=false**, `precondition_failed` | ✅ 正确拒绝 |
| V8 | `replace_run` 给 trash 但不 `confirm_waste` | **ok=false**, `precondition_failed`，列出 wasteRoles | ✅ 正确拒绝（poka-yoke 生效） |
| V9 | `replace_run` trash 指向 `right`（模板默认废料侧） | **ok=true**，但删掉的是 `10150`（右槽下游！）、保留 `10143`；仅 1 条 `kept-belts` warning | 语义**错**却几乎静默通过 —— `confirm_waste` 只是签字闸，选错侧仍要靠调用方懂目标形状 |
| V10 | `connect` 指向不存在的 `{cell:[-5,-40]}` | **ok=false** `endpoint_not_found` | ✅ 拒绝「连到空地」 |
| V11 | `insert_machine at:{cell:[4,-13]}`（2×1 机器反解） | **ok=false** `ambiguous_site`（2 个 origin 候选） | ⚠️ 契约承诺的「只指一格」对 2×1 机器永远失败，被迫退回裸 origin |
| V12 | `replace_run` region 只容 1 格 `[5,-13,5,-13]` | **ok=false** `occupied`（cutter 2×1 放不下） | ✅ 拒绝，且给出尺寸原因 |

**结论**：结构性负例（裸角度、空 region、region 含机器、非末端）全部被拒。
但**语义负例**（V2/V3/V9）不会 return error，只给 warning 或干脆通过。

## 5. 宏库能力的边界

- **能**：`replace_run` 就地改一段带子（region 内全为带子），一次性表达
  「删 X 格带 + 放 1 台机器 + 给某个输出槽挂 trash + 保留其余带子」并做后验拓扑推演。
  这是 L4 形态，判据成立。
- **不能（实现缺失）**：
  - **在空地新建整条产线**。`insert_machine@(20,20)` 返回 `ok=true`，只挂 3 条
    `input_not_fed/output_not_connected` warning；没有 build_line。
  - **改一条正在跑的产线的方向**。`extend_line` 只接受末端；`replace_run` 只换建筑不换流向；
    `connect` 要求宿已存在（V10 实测 `endpoint_not_found`）。方向要变只能「删掉重建」，
    而 `remove_run` 之后没有任何宏能把新线接回去。
  - **修一条堵住的死路**。`trash_unused` 只处理「没有去处」的出口：真死路
    `10008@(-10,-3)` 可接（→ trash 落 `(-10,-4)`）；但 `10151` 出口对着 balancer
    输入槽则被 `port_already_bound` 拒绝。堵在隧道/hub 内部的死路无宏可表达。
  - **2×1 机器的「指一格」落点**：`{cell}` 形态恒 `ambiguous_site`（V11）。
- **不能（设计选择，合理）**：
  - `r≠0` 的机器一律 `out_of_scope` / `precondition_failed`（`rotated_machine_slots`
    仍是 `observed`）。V3 的 180° 只警告不拒绝，是这条设计的一个松动处。
  - hub / 隧道 / wire 不在 v1。
  - `remove_run` 只删带、`insert_machine` 不搬机器，强制「删旧 + 放新」走显式计划。
- **灰色**：V2 的「只给 cutter 不给 trash」是真实的生产事故形态（废料混入下游），
  当前宏不会拒绝，只会在 `wiring` 里显示"三个槽都 ok"。`mustDiscardUnused: true`
  在模板里存在，但没有被任何宏用于强制「多输出机器必须每路都有去处或声明销毁」。

## 6. 这个验收能/不能证明什么

**能证明**：
1. 宏库对 L4 这种「region 内的带子 → 一台机器 + trash」的改造，**接口层是完整的**：
   调用方只给 region 和建筑名，footprint / rotation / trash 落点 / 删哪些 / 留哪些
   全部由宏算出，且我独立复算后逐项对上。
2. poka-yoke 在**结构层**有效：裸角度、空 region、region 含机器、未签字的销毁，
   全部被 `ok=false` 拒绝，没有静默成功。
3. 判据「≤5 次宏调用」成立，且实际只用 1 次。
4. 宏**能报出中间态**：`remove_run` 的 `consequences` 精确列出
   `orphaned_outputs(10208, 10148)` 与 `starved_belts(10144, 10150)` ——
   这正是 `replace_run` 漏报的那几条。单步宏的诊断比打包宏更完整。

**不能证明（关键）**：
1. **没有一次真实落盘**。本验收全程 `ctx={entities}`，宏只返回计划；
   `dry_run:false` 只是"不是 dry-run 标记"，`changed.added_uids` 为空、`uid:null`。
   而且**宏之间在计划态下无法串接**（§2：`insert_machine` 的 `uid:null` 喂不进
   `trash_unused`），所以「一条链下来」这件事本身也没被验证。
   「宏动作层能把真实存档从 0 抬起来」的赌注，**这次验收没有触及**。
   要证明它，必须在受控存档上真的 `tx.begin → removes → place → tx.commit`，
   再用 `obs` 读回 cutter 的 `rotation/槽位邻接` 与 `boundAcceptor`，
   跑几个 tick 确认 `RuRu----` 真的产出。
2. **没有证明 `capability_assumptions.rotated_machine_slots`**。L4 恰好是 r=0，
   整条 `r≠0` 分支（V3 的 180° 只 warning）没有被验证。
3. **没有覆盖「宏生成的计划能被执行器正确翻译」**。`execution.note` 说
   `place{code:9,x:4,y:-13,r:0}`，但代码里没有任何一处验证 `code` 字段被 paster 接受。
   这是宏 ↔ tx 之间的接口缺口。

**还缺什么才能证明赌注**：一次**真实存档**的受控实验 —— 备份 → `replace_run` 出计划 →
`tx` 落盘 → `obs` 读回 uid/rotation/rv → `debug_items` 看物品真的从 `(4,-12)` 流向
`(5,-14)` → 回滚 → 存档 uid 集合逐字节相等。没有这一步，"宏库能表达"只是纸面正确。

