# 布线覆盖 —— 契约决定（P1 交付）

> 2026-11-01。P1 契约对齐 agent。
> 本文是**实现方必须遵守的形状**。契约真值在 `src/agent/macros/contract.mjs`
> （`REPLACED_DESTROYS_FIELD` / `REPLACED_DESTROYS_LEGACY_FIELDS` /
> `validateReplacedDestroys()` / `checkReplacingWarningMatchesDestroys()` /
> `DESTROYS_CONSUMPTION_SPEC`）。本文与之冲突时，**以 `contract.mjs` 为准**并立刻报告。

---

## 结论

**`connect` 不新增顶层 `replaces`，也不新增 warning code。**

三个宏统一用信封里**早就存在**的 `changed.removed_uids: Uid[]` 作为
「本单会销毁哪些既有实体」的**唯一规范通道**。`connect` 的缺口就是这一个字段没填。

`warnings[].detail` 里的格数降级为**纯人读摘要**，禁止任何机器解析。
warning 上可以挂可选的 `replaced_belt_uids` / `replaced_cells` 作冗余展示，
但契约强制它与 `changed.removed_uids` 同集合 —— 两份列表不可能各自漂移。

---

## 一、三宏现状（实测原始输出）

夹具：`.tmpverify/final-half/probe-obs.json`（42 实体，半成品世界）。
复跑：`node .tmpverify/p1-probe.mjs`、`node .tmpverify/p1-probe-xcheck.mjs`。

### `connect`（`allow_replace:true`，`10538@(1,-6) → hub`）

```
ok: true, cells_placed: 6
keys: ok,macro,cells_planned,cells_placed,first_mismatch,changed,warnings,error,
      dry_run,cells,pathLen,choice,strategy,alternatives
changed            : {"added_uids":[],"removed_uids":[]}     ← 空
removed_uids       : undefined                               ← 没有
replaced_belt_uid  : undefined                               ← 没有
replaces           : undefined                               ← 没有
warnings: [{"code":"replacing-belts",
            "detail":"allow_replace=true：路径上有 1 格是既有带子，执行时必须先 delete{uid} 并纳入 tx 回滚"},
           {"code":"hub-entry-chosen","detail":"…选了 entry=8（0,-3）…"}]
cells: [[1,-7],[0,-7],[0,-6],[0,-5],[0,-4],[0,-3]]           ← (1,-7) 是 uid=10537
```

**核实结论：`connect` 只给格数，完全不给 uid。契约 `contract.mjs` 旧文案「connect 在 detail 里给格数」
准确描述了现状 —— 但它同时是唯一一个不满足契约义务的宏，因为同一句的另外两个分句都给了 uid。**

补充实测（`.tmpverify/p1-probe-xcheck.mjs`）：21 条候选里 `replaceable` 计数与
`cells[] ∩ obs` 的**带子格数逐条相等（mismatch=0）**。这条很重要 —— 它证明
`checkOccupancy` 的计数是可信的，P2 只要把计数换成列表即可，不需要改算法。
分布：`{0格:1, 1格:13, 5格:1, 11格:1, 14格:4, 17格:1}`（这份夹具上最多覆盖 17 格）。

### `insert_machine`（`at:[4,-8], facing:left, machine:cutter`）

```
ok: true
changed            : {"added_uids":[],"removed_uids":[10516,10515]}
removed_uids       : [10516,10515]        ← 顶层同值副本
replaced_belt_uid  : undefined
warnings: [{"code":"replacing_belts",     ← 下划线拼写（已在闭集登记为 alias）
            "detail":"footprint 内有 2 格既有带子（uid 10516, 10515）→ …"}]
```

**核实结论：真给 `removed_uids`，位置是 `changed.removed_uids`（顶层有一份同值副本）。
形态是 `Uid[]`，按 `(y,x)` 排序。detail 里也重复了一遍 uid（人读）。**

### `trash_unused`（`outlet:{uid:10508, port:{role:"secondary",index:0}}`，`replace_belt:true`）

```
ok: true
changed            : {"added_uids":[],"removed_uids":[10543]}
replaced_belt_uid  : 10543                ← 单数标量
removed_uids       : undefined            ← 没有顶层复数形态
warnings: [{"code":"replacing-belt",      ← 单数拼写（已在闭集登记为 alias）
            "detail":"opts.replace_belt=true：喷口格上的带子 uid=10543 会被销毁…"}]
```

**核实结论：真给 `replaced_belt_uid`，是标量不是数组，且只在 `ok:true` 分支给；空场景给 `null`。
结构上只能表达 1 个 —— 因为喷口格本身只有一格。它同时**已经**填了 `changed.removed_uids`。**

### `replace_run`（附带核实，简报没要求但影响同形决策）

```
belt 模式    : changed.removed_uids = [10531,10532,10533]   顶层还有 removed_uids + replaced_uids
machines 模式: changed.removed_uids = [...]                顶层还有 removed_uids
```

### 契约与实际不符的地方（逐条点名）

| 契约旧文案 | 实际 | 判定 |
|---|---|---|
| 「connect 在 detail 里给格数」 | 确实只给格数 | **文案准确，但描述的是一个违约状态**。契约在同一句里要求「把要删的 uid 纳入 destroys」，connect 做不到 ⇒ 自相矛盾 |
| 「insert_machine 给 `removed_uids`」 | `changed.removed_uids` 与顶层 `removed_uids` 同值 | 准确，但**没指明哪个是规范通道** —— 下游因此两条都读 |
| 「trash_unused 给 `replaced_belt_uid`」 | 准确 | 准确，但没说它是**单数**、上限 1、且已同时填了 `changed.removed_uids` |
| `WARNING_CODES["replacing-belts"].macro` 只列三个宏 | `replace_run` 在 belt 模式也销毁并重建带子 | **漏了第四个宏**（已补） |

---

## 二、决策与理由

### 选定的形态

```js
// 唯一的规范通道（信封字段，四个宏同形）
changed: { added_uids: [], removed_uids: [10537] }   // Uid[]，no-dup，确定序

// 可选的冗余展示（挂在 replacing-* 警告上，契约强制与上一行同集合）
warnings: [{ code: "replacing-belts",
             detail: "…1 格…",              // 人读，禁止机器解析
             replaced_belt_uids: [10537],   // 可选，Uid[]，与 removed_uids 同集合
             replaced_cells: [[1,-7]] }]    // 可选，Cell[]，与上一条同序同长
```

### 为什么是 `changed.removed_uids` 而不是新增顶层 `replaces: [{uid,x,y,kind}]`

**1. 它已经存在，而且四个宏里三个已经填对了。**
新增 `replaces` 等于再造一个并行通道：`insert_machine` / `trash_unused` / `replace_run`
都得再写一遍、再和 `changed.removed_uids` 对齐一次。世界上多一份能漂移的副本，
就多一个「两份不一致时信谁」的问题。P2 的实际工作量也因此从「填一个空数组」
变成「填一个字段 + 保证与旧字段同步」。

**2. R3 已经在读它。**
`planToTxOps.mjs:113` 第一行就是 `result.changed.removed_uids`。选它，
下游零改动即可消费；选 `replaces` 则要改 `selfReportedDestroys()`。

**3. 它是信封字段，`validateMacroResult` 不校验它的存在与形状 —— 所以契约必须补校验。**
这正是本次加 `validateReplacedDestroys()` 的原因：旧信封把它写成 `changed:{...}`
却从不检查，于是 `connect` 填了个恒空数组也一路绿灯。

### 我否掉的方案

**(a) 塞进既有 warning 的 `detail` 里（`detail: "…覆盖 uid 10537…"`）—— 否。**
这是最省事的做法，但它把结构化数据塞进自由文本。任何下游都要写正则，
而正则对「2 格」和「12 格」、对「uid 10516, 10515」和「uid 10516,10515」都会漂。
项目里已有前车之鉴：`connect.test.mjs:470` 用 `/3 格/` 断言 detail ——
那条测试只要人类改一个标点就红，而它对真实缺陷毫无保护力。

**(b) 只加顶层 `replaces: [{uid,x,y,kind}]`，不动 `changed.removed_uids` —— 否。**
理由同上第 1 点：制造第二份副本。另外 `kind` 字段是冗余的 ——
`removed_uids` 的每个 uid 都能在 obs 里查到 type，而计划态本来就要拿 obs 对账
（R7/R13 都要求 uid 在 obs 里）。多存一份 kind 只会引入「uid 说是 belt、obs 说是机器」的争执。

**(c) 新加一个 warning code（如 `replaced-belt-uids`）—— 否。**
`WARNING_CODES` 是闭集，加一个码要连带扩闭集、改 `contract.test.mjs` 的
`IMPL_WARNING_CODES`、还要让 `worstSeverity` 处理它。而它表达的信息
（「这次会覆盖带子」）和 `replacing-belts` **完全相同**，只是多带了数据。
warning 的 `code` 表达的是**调用方该做什么**，不是**数据载荷**。数据载荷的正确位置是信封字段。

**(d) 保留三种拼写，下游写三个分支 —— 否（作为长期方案）。**
这正是现在 `selfReportedDestroys()` 有五条读取路径的原因。每多一条路径，
就多一个「某天某条路径悄悄失效」的可能。但**迁移期必须保留**（见下）。

### 三宏同形：统一，但不删旧字段

**决定：统一到 `changed.removed_uids`，历史字段保留不删。**

代价（诚实列出）：

| 代价 | 具体是什么 | 谁来承担 |
|---|---|---|
| 实现里多一份赋值 | `connect` 要新增一行；其它三个已有 | P2（connect 一行） |
| 迁移期双写 | `insert_machine` 的顶层 `removed_uids`、`trash_unused` 的 `replaced_belt_uid` 仍会被测试与旧代码读到 | 无 —— **保持双写即可，成本是 0** |
| 契约多一层校验 | 新增 `validateReplacedDestroys()`（已写），迁移期强制新旧一致 | 无 —— 校验是纯函数，不参与运行时路径 |
| `planToTxOps` 的五条读取路径**暂时还在** | R3 不会立刻简化 | P3（可留作迁移期兜底，但必须发迁移警告） |

**不删旧字段的理由**（比「统一」更重要）：
`remove.test.mjs:254` 断言 `r.changed.removed_uids === r.removed_uids`；
`place.test.mjs:763` 读 `r.removed_uids`；`loop_pipeline.test.mjs:106` 两条都读。
删掉会一次性打破至少 4 处既有断言，而那些断言保护的是**别的东西**（删除集合完整性）。
用一个纯新增的规范通道达到统一，风险远低于改旧字段。

**唯一的硬要求：新代码（P2/P3/P6 以及 `planToTxOps`）只许读 `changed.removed_uids`。**
旧字段的存在不构成读取许可。

---

## 三、给 P2 / P3 的形状（必须逐条遵守）

### P2 —— `connect` 填 `changed.removed_uids`

**确切形状**

```js
// ok:true 且 allow_replace 生效、路径压过 N≥1 格既有带子时：
changed: { added_uids: [], removed_uids: [<N 个 uid，按 cells[] 的路径格序>] }
warnings: [{ code: "replacing-belts", detail: "…N 格…",
             replaced_belt_uids: [<同上，同序>],        // 可选但推荐
             replaced_cells: [[x,y], …] }]              // 可选，与上一行同序同长
```

**硬性条件**

1. **只在 `ok:true` 时出现。** `ok:false` 必须保持 `changed.removed_uids: []`
   （既有测试 `connect.test.mjs:509` 断言失败时 `warnings` 为空 —— 同理，失败时不许报销毁）。
2. **只在真的压过带子时非空。** 压 0 格必须是 `[]`，且**不得**发 `replacing-belts`。
   实测已确认这份夹具上存在这样的候选（`from=10547`，19 格全空）。
3. **只收 `belt` / `underground_belt`。** 机器与 hub 永不进列表
   （`checkOccupancy` 里 `rec.type === "belt"` 那条分支是唯一入口；隧道目前也走这条）。
4. **uid 必须来自本次 ctx 的 obs。** 不许合成、不许用 `pending` 推。
5. **顺序确定、无重复。** 建议直接按 `cells[]` 顺序 push（天然确定）。
6. **`cells_planned` 语义不变**：仍是「新铺的格数」，不因覆盖翻倍。
   （`connect.mjs:897` 现在写 `cellsOut.length`，不要动。）

**实现落点（仅供参考，P2 自行判断）**
`checkOccupancy`（`connect.mjs:645`）现在只累加 `replaceable++`。
把它改成同时收集 `{uid, cell}`，并在 `connect.mjs:881` 那里同时填
`changed.removed_uids` 与 warning 的冗余字段。

**P2 的验收断言（建议）**

```js
const r = connect({from:{uid:10538}, to:{hub:{uid:hub.uid}}, opts:{allow_replace:true}}, {entities});
eq(r.changed.removed_uids, [10537]);
ok(validateReplacedDestroys(r, { macro: "connect" }).ok);
ok(checkReplacingWarningMatchesDestroys(r).ok);
// 反例
const r0 = connect({from:{uid:10547}, to:{hub:{uid:hub.uid}}, opts:{allow_replace:true}}, {entities});
eq(r0.changed.removed_uids, []);
ok(!r0.warnings.some(w => w.code === "replacing-belts"));
```

### P3 —— `planToTxOps` 怎么消费

**目标状态**（见 `DESTROYS_CONSUMPTION_SPEC`）：

1. **R3 主路径只读 `changed.removed_uids`。**
2. **别名读取可以留作迁移兜底，但必须留痕。**
   现存的 `removed_uids` / `replaced_belt_uid` / `replaced_uids` / `removes[].uid` /
   `removed[].uid` 五条路径，每条命中时 push 一条 `DESTROYS_LEGACY_FIELD` 警告。
   不静默吞掉 —— 否则「实现还在用旧字段」永远暴露不出来。
   （注意：这个码是 **`planToTxOps` 命名空间**的，**不要**往 `WARNING_CODES` 里加。）
3. **`connectDestroysFromObs` 从「数据源」降级为「交叉校验」。**
   这是本包**最重要的一条**。现状是：宏不自报 ⇒ 它从 `cells[] ∩ obs` 猜出来塞进 destroys。
   后果是「宏漏报」与「宏报对了」在 tx 里**长得完全一样** —— 而这正是要抓的缺陷形态。
   改成：
   ```js
   const derived = connectDestroysFromObs(c.result, entByCell).map(d => d.uid);
   const declared = c.result.changed.removed_uids;
   if (!sameSet(derived, declared)) return reject("R3", "destroys_mismatch",
       `connect 自报删除 ${declared} 与 obs 反推 ${derived} 不一致 —— 宏与 obs 不同步`);
   ```
   **绝不把 derived 里「多出来」的 uid 塞进 destroys。** 多出来意味着宏要么漏报、
   要么 cells 与 obs 不同步，两种都该拒绝（R6 会因为「格上有带子却不在 destroys」而拒，
   这正是想要的行为）。
4. **R13 必须放行「宏自报的替换式销毁」，但判据要结构性。**
   `namedUids` 里不会有「被覆盖的那格」（模型只点名了源端口 `10538`）。
   实测（`.tmpverify/p1-probe-r13b.mjs`）：

   ```
   namedUids=[10538]        => PLAN_REJECTED: 10537@(1,-7) 不在 LLM 指名的句柄里
   namedUids=[10537]        => ok, destroys=[10537]
   namedUids=[10538,10537]  => ok, destroys=[10537]
   ```

   **建议的结构性放行判据**（不是「给 R13 加个开关」）：

   ```js
   // 一个 uid 可以免于 R13，当且仅当它同时满足：
   //   ① 它出现在某个宏的 changed.removed_uids 里（宏自报，不是反推的）；
   //   ② 那个宏是「替换式」的：该 uid 所在格同时被本计划的某个 place 覆盖；
   //   ③ 该宏发了对应的 replacing-* 警告。
   // 三条全中 ⇒ 这是「宏为了把东西放下去而让位」，不是「模型乱删」。
   ```

   这三条都能机器判、都不依赖 LLM 的输出，且**不能**被「模型主动删没点名的 uid」利用：
   模型主动删的 uid 不会出现在 `changed.removed_uids` 里（那是 `remove_run`，
   它的 `removed_uids` 来自 args 里的 uids，已经过 R13 该走的路径）。
   ⚠️ 反例检查：`remove_run` 也填 `changed.removed_uids`。**放行判据必须限定宏名**
   （`connect` / `insert_machine` / `trash_unused` / `replace_run`），
   绝不能因为「字段在」就放行 —— 否则 `remove_run` 变成 R13 的后门。

5. **R13 现状的一个既有缺陷（顺手报告，不属于本包）**：
   混合计划下 `insert_machine` 顺带删 2 格会**整轮被拒**。
   实测（`.tmpverify/p1-probe-mixed.mjs`）：

   ```
   remove_run(uids:[10546]) 命名 + insert_machine@[4,-8] 顺带删 [10516,10515]
   => PLAN_REJECTED: 计划要删除 3 个实体，其中 2 个不在 LLM 指名的句柄里：10515@(4,-8), 10516@(4,-9)
   ```

   ⇒ **R13 今天已经在误伤 `insert_machine`**，不只 `connect`。
   P3 用上面第 4 条的结构性放行可以一并修掉，但**必须**同时验证「模型乱删仍被拒」。

### P6 —— 建议夹具与断言

用 `.tmpverify/final-half/probe-obs.json`，至少覆盖：

- `connect` 覆盖 1 格 ⇒ `removed_uids === [10537]`，warning 与字段一致
- `connect` 覆盖 17 格（`from=10548`）⇒ 报全 17 个，不截断
- `connect` 覆盖 0 格（`from=10547`）⇒ `[]` 且无 `replacing-belts`   ← 反例
- `connect` 失败（不给 `allow_replace`，踩 `(1,-7)`）⇒ `[]` 且 `warnings` 无 replacing
- `planToTxOps`：`connect` 自报与 obs 反推一致才过，人为改 `removed_uids` ⇒ 判红
- R13：自动覆盖的 uid 放行；`remove_run` 删没点名的 uid 仍被拒

---

## 四、反例：什么情况下**不应该**出现这个字段

按重要性排序。**P2/P6 必须把前两条写成断言。**

1. **覆盖发生但没真的删东西 ⇒ 不该出现。**
   `allow_replace` 给了，但选中路径一格既有带子都没压到（实测 `from=10547` 就是这样）。
   此时 `changed.removed_uids` 必须是 `[]`，且**不得**发 `replacing-belts`。
   若填了非空，下游会生成一条 `delete` 一个根本没被覆盖的 uid —— 那是**凭空删东西**。

2. **`ok:false` ⇒ 不该出现。**
   失败时不存在「将要销毁」这回事。`connect` 的 `failure()` 已经给 `[]`，保持即可。
   （尤其注意：`occupied` 报「格上有带子但你没开 allow_replace」时，那个 uid
   **不是**要被删的 —— 它是**阻止**你行动的障碍。把它放进 `removed_uids` 等于
   把「被拒绝的原因」误当成「计划的一部分」。）

3. **机器 / hub 被 footprint 覆盖 ⇒ 不该出现在这个字段。**
   `insert_machine` 遇到机器是 `blocked_by_machine` 直接失败，永远不会「替换」机器。
   `removed_uids` 里出现非 belt / underground_belt 的 uid，说明实现错了。

4. **`pending` 里的计划态实体 ⇒ 不该出现。**
   那是「本次要新放的」，uid 由 tx 分配。把它塞进 `removed_uids` 会得到一条
   `delete{uid:<不存在的号>}`，tx 整单失败。

5. **只是「重连同一格」但没有销毁 ⇒ 不该出现。**
   如果将来有宏支持「就地改 rv」（不删不建），它不该报销毁 —— 那不是替换。

6. **`rebind` 抢口 ⇒ 不该出现在这个字段。**
   `opts.rebind` 让**旧接收方断流**，但它**不删**那条带子。两件事：
   `removed_uids` = **要删的实体**；`rebind` 的后果是**功能断流**，不是销毁。
   混在一起会让调用方删掉一条还该留着的线。
   （`connect.mjs:834` 的 `port_already_bound` 分支就是这样：那条带子不动。）

---

## 五、我不确定的 / 我没验证的

1. **`cells_planned` 在覆盖场景下的语义是否真的该保持不变。**
   契约写的是「计划**写**的世界格数（新增 + 替换/删除）」。按字面读，
   覆盖 1 格时 `cells_planned` 应该是 `6+1=7` 而不是 `6`。但实测四个宏都按「新铺格数」算
   （`connect.mjs:897` 用 `cellsOut.length`）。我**没有**去改这条 —— 它和本次目标无关，
   而且改了会动 `cells_planned === cells_placed` 这条自证。
   **建议：单独立项，不要夹在 P2/P3 里。** 我在契约里加的那句
   「`cells_planned` 仍只算新铺的格数，不因覆盖而翻倍」是**描述现状**，
   如果将来裁定成另一种语义，那句话要一起改。

2. **`underground_belt` 进 `removed_uids` 是否安全。**
   `checkOccupancy` 只判 `rec.type === "belt"`，隧道会落到 `firstConflict` 的 else 分支
   （当作硬障碍）。所以**目前**隧道进不了这个列表。但契约里我写的是
   「只收 belt / underground_belt」—— 这是照 `replace_run` 的 `BELT_KINDS` 写的。
   如果 `connect` 将来支持覆盖隧道，需要确认 mod 的 `delete` 对隧道是否成对。

3. **`replace_run` 的 `replaced_uids` 与 `removed_uids` 是否恒等。**
   实测 belt 模式两者同值（`remove.mjs:1238-1239`），但没有穷举所有分支。
   `validateReplacedDestroys` 对二者都做一致性校验 —— 若某分支只有其一，会误报。
   我在迁移期把「字段缺失」当作「跳过」（`v === undefined || v === null` → continue），
   所以只有**同时存在且不等**才判红。

4. **`DESTROYS_LEGACY_FIELD` 会不会和 loop 既有警告码冲突。**
   我查了 `src/agent/loop/constants.mjs` 的码表，没有同名项。
   但那些码是诊断码（`mkDiag` 体系），和 `planToTxOps.warnings` 不是同一空间 ——
   我没有验证 loop 是否会把 `planToTxOps.warnings` 的 code 再映射一遍。

5. **`connect` 覆盖 17 格的那个候选（`from=10548`）在真实世界里是否真的会选中。**
   它出现在 `prefer` 的四个取值下都一样（实测 `p1-probe-prefer.mjs`），
   但那是因为这份夹具上它恰好是唯一/最优解。真实存档里 17 格覆盖可能意味着
   `max_cells` 超限或评分把它排到后面。**这不影响契约**（契约只说「报全」），
   但会影响 P3 的「覆盖上限 N」取多少 —— 那属于 P3 的决策。

---

## 六、如果我是错的，最可能是哪里错

**最可能：我低估了「统一到一个已有字段」的语义负担。**

`changed.removed_uids` 现在的语义是「本单会删除的实体」（对所有宏统一），
而我这次给它**额外**加了一条契约义务：「替换式销毁时也必须在这里报」。
这两件事在语义上并不完全重合：

- `remove_run` 的 `removed_uids` = 「模型点名要删的」
- `connect(allow_replace)` 的 `removed_uids` = 「宏为了放东西而顺带删的」

把两者塞进同一个字段，**会让 R13 那个结构性判据变难写**（P3 必须靠宏名区分，
而不能靠字段区分）。如果 P3 在实现时发现这个混淆导致判据写不干净，
**更正确的做法可能是回到方案 (b)（顶层 `replaces`），但只给 `connect` 一个宏用**，
让「模型点名的删除」与「宏顺带的替换」在形状上就分开。

我选统一而不是分开，理由是「下游少写分支」优先于「语义纯度」——
但这是一次判断，不是一条定理。**如果 P3 觉得判据写不干净，可以推翻我**，
代价是要同时改 `contract.mjs` 里我刚写的那一节（改动量不大，因为校验函数是按
「集合相等」写的，换字段名只需改 `REPLACED_DESTROYS_FIELD` 一处常量）。

**第二可能：我可能漏了一个消费者。**
我 grep 了 `src/` 下所有 `removed_uids` / `replaced_belt_uid`，确认生产代码里只有
`planToTxOps.mjs` 与 `place.mjs:861` 在读。但我没有 grep `.mjs` 之外的
（`research/` 下的脚本、`test/` 下的 live 脚本），也没有查 mod 侧
（`shapez-ai-bridge.js`）是否读宏返回值 —— 宏是纯 JS，理论上不经过 mod，
但 P7 会走 mod 的 `tx`，那时 `removed_uids` 只到 `ops` 为止，不进 mod。

**第三可能：`connect` 的实测数字依赖这份夹具。**
所有「覆盖 N 格」的数字都来自 `probe-obs.json`（42 实体）。
真实存档（L4 的 180+ 实体）上覆盖格数分布会不同 —— 但那不改变契约形状，
只改变 P3 的上限选择。
