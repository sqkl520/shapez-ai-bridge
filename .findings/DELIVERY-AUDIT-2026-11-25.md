# 送达审计 —— 上一轮 8 个修复，几个真的到了模型眼前

2026-11-25。投递审计 Agent。**没碰游戏**（全部离线），没改 `src/`，没 `git stash/commit/push/checkout/reset`，
没读 `ANTHROPIC_BASE_URL`。临时脚本在 `.tmp-delivery/`（**已删除**）。新工具：
`tools/delivery-ledger.mjs`（保留）。

> ⚠️ **开工时工作区已被另一个 agent 改过**：`src/agent/loop/semantic.mjs` 有 71 行未提交改动
> （2026-11-25 的 `MACHINE_STARVED` 缺槽角色名修复，`missRole` / `d.slot`）。
> 我第一次 import 时它抛 `ReferenceError: missRole is not defined`（`missRole` 在一处已声明、
> 另一处声明还没写进去的中间态）。本报告的所有结论都是在**该文件能正常 import 之后**跑的；
> 涉及 `MACHINE_STARVED` / `d.slot` 的判断请以那次改动落地后的 HEAD 为准，不要用本报告当证据。
> `3101b69` / `6e98253` / `c63df17` 三个提交本身**没有被重写**，本报告审的是它们。

---

## 一句话结论

**8 个修复里，能确认送到模型眼前的只有 2 个半（#2、#7c 的一半、#3）。其余 5 个半要么根本没数据、
要么被渲染层的闸门/下标/过滤器吃掉，要么在删除 `WORLD_FROZEN` 时一起没了。**
其中 **#8 的 CAPACITY 极短保底是死代码**（`full` 分支在 `room<200` 时也返回字符串，
`short` 分支永远轮不到），**#7 的 `chain_belt_uids` 是纯噪音字段**（`src/` 里 0 个消费者，
唯一引用是注释），**#5 的 `tickSincePrev` 是纯噪音**（`semantic.mjs` 一次都没读过它）。

---

## 汇总表

| # | 修复 | in_diag | in_prompt | 判定 |
|---|---|---|---|---|
| 1 | `reorientedBelts` + `reoriented belts:` 段 | ✓（verify 有 `belt_reorient` 字段，但 47/47 次 `count=0`） | ✗ | **从未在真机出现过** —— 渲染正常，但**数据源一次都没触发**。根因见下 |
| 2 | `slotRoleAt` 的 `{role,index}` 字面量 | —（不在 diag 里，在 handles） | ✓ @14146 | **送达**。BELTS 段渲染成 `下游=H1.{role:"primary", index:1}`，且 `validatePort` 接受这种对象 |
| 3 | `health` 的 `\|\|` 改 `after` | — | ✓（`## LAST STEP` 有，`net_effect.delta` 原始行不进 prompt） | **部分送达**。判词进了 prompt，但同一份数据上 `healthDelta` 的 `sign` 仍是 `\|\|`，两者会分叉（见详查） |
| 4 | `items_on_belts` 加进 `NO_DIRECTION` | —（timeline 不是 diag） | ✗（timeline 不进 prompt，**本来就不需要送达**） | **正确，无需送达**。但改后 `healthDelta` 的 `sign` 与 `classifyNetEffect` 对同一事件给出相反口径 |
| 5 | `obsTickPrev` → `obsTickLastSeen` | ✗（`semantic.mjs` **完全不读** `tickSincePrev`） | ✗ | **死机制**（`WORLD_FROZEN` 是它唯一消费者，已删）。详查给结论：**留着** |
| 6 | `WORLD_FROZEN` 截断漏报修复 | — | — | **随着 WORLD_FROZEN 一起删没了**。`git show c63df17` 删了 `semantic.mjs` 里 14 处 `truncatedPaths`/`可见最堵`，HEAD 里剩 0。确认 |
| 7a | `CHAIN_UNFED` 的 `chain_belt_uids` | ✓（evidence 里有，真实世界 25/401 有） | ✗ | **纯噪音字段**。`src/` 里 0 消费者（`grep` 只有新代码 + 新测试 + 一句注释） |
| 7b | `live_chain_ends` | ✓（11/25 分组有） | ✓（通过 `hint`「末端是 X（唯一供料）」） | **送达**（在真有 live 末端的形态下）。但只走 `hint` 那条路 |
| 7c | `CHAIN_UNFED` 的 `hint` | ✓ | ✓（DIAGNOSIS 行尾，实测 149~154 字符，**不被 180 截断**） | **送达**（在 `nearbySource` 或 `guarded` 形态下）。但**普通形态的 `CHAIN_UNFED`（无 hint）实测 0 条送达**，见下 |
| 8 | 删 `WORLD_FROZEN` + `CHAIN_UNFED` 补 `remove_run` + `## CAPACITY` 极短保底 | `remove_run` 进了 RETRIEVAL_TABLE ✓ | **`remove_run` 卡片只在「双 CHAIN_UNFED」时出现**；极短保底 ✗ | **`remove_run` 补丁半失效**（下标 3 读不到）；**极短保底是死代码** |

---

## 逐条详查

### 修复 1：`reorientedBelts` + `## LAST ROUND` 的 `reoriented belts:` 段

**数据在哪**：`verify.mjs:136` `reorientedBelts(beforeObs, afterObs)` → `verifyRound` 返回
`report.reoriented` → `loop.mjs:5250` 写进 `st.lastPlanSummary.belt_reorient` →
`prompt.mjs:3229` `renderLastRound` 渲染。

**送达了吗**：**没有，一次都没有。**

三个正交事实：

1. **渲染逻辑本身是对的。** 我用合成 `belt_reorient:{count:1,...}` 走 `buildPrompt`，
   `S5` 里确实出现 `reoriented belts (the game rewrote these — no op asked for it):` +
   `  · B149: in left→left, out bottom→right` + 那句 `⇒ You did not declare these…`。
   `reorient.test.mjs` 的断言是真的。
2. **渲染条件会满足。** `st.lastPlanSummary` 在 `continue` 路径上赋值
   （`loop.mjs:5249`，`success`/`offline_only` 都 `break` 了），而「第一次 apply 之后的下一轮」
   走的就是 `continue`（apply 成功但目标没达成）⟹ `lastRound` 非 null ⟹ 段会渲染。
   **这条怀疑不成立** —— 它不是「不渲染」，是「没数据」。
3. **数据一次都没触发。** 全部 1638 个 run 的 transcript，`verify` 记录里带
   `belt_reorient` 字段的共 **47 条，`count>0` 的 0 条**。`diff.modified` 在 2118 次成功 apply 里
   **0 次非空**。唯一的真人真机样本 `r-20261123234341-c6c7` r3（`replace_run`，applied=2，
   removed=1/added=1）算出来 `count:0`。

**如果没送达，为什么**：

`reorientedBelts` 的判据是「两份 obs **都在**的带子，`(r, rv)` 变了」。真实世界的带子
**不会被 op 改 rv**（`replace_run` 是删旧带 + 放新带，新带是 `added` 不是「被改」）；
只有 `BeltSystem.updateSurroundingBeltPlacement` 那种「游戏按邻居重算」才会动 rv。
在 699 条带子的 L12 世界里，一次 `replace_run` 只在原地换 1 格，周围的带子邻居没变 ⟹
重算结果与原来一致 ⟹ `count=0`。

**该修什么**：这条本身没坏，是**判据太窄**。但更要紧的是：**这 8 个修复里它是唯一一个
「代码改了、测试绿了、真机从没出现过」的典型**。它没有被证明送达，只被证明了「能渲染」。
要真验它，需要一个**会触发邻居重算**的 apply（place 机器到已有带子旁边），
而当前 0/2118 次 apply 满足。要么在 `reorient.test.mjs` 里加一个 `FakeGame` 端到端夹具
（place+delete 两 op，让 FakeGame 按同样规则重算邻居），要么承认它是未验证的。

---

### 修复 2：`slotRoleAt` 的 `[N]` → `{role:"x", index:N}`

**数据在哪**：`handles.mjs:645` `slotRoleAt` 返回 `{role:"primary", index:12}` 字符串 →
`describeEntity` 写进 `downstream` 描述 → `renderBelts` 渲染 → BELTS 段。

**送达了吗**：**送达，且形态合法。**

真实 run `r-20261124090316-0c8d` 重建出的 prompt（`tools/delivery-ledger.mjs --run …`）里：

```
B135 belt 上游=C5.out 下游=H1.{role:"primary", index:1} 货=0 段=1
B180 belt 上游=B181.out 下游=H1.{role:"primary", index:7} 货=…
```

`contract.mjs:698` `validatePort`：字符串判 `/^[a-z][a-z0-9_]{0,31}$/`（含方括号必拒）；
对象判 `keys.every(k => k === "role" || k === "index")` 且 `role:string` + `index:>=0`。
渲染出来的是**字面的 `{role:"primary", index:1}` 文本**，模型照抄即合法对象。**B1 修对了。**

**如果没送达，为什么**：不适用（送了）。

**该修什么**：无需。唯一残留是 `handles.mjs:738` 注释里那条沉睡的不一致
（`painter/quad` 的 `handles [1,2,3,4]` vs 宏 `[0,1,2,3]` 偏 1），但 `painter/quad` 不在
`SUPPORTED_BUILDINGS` 里、历史 570 run 0 台，今天不咬人。

---

### 修复 3：`health` 的 `||` 改 `after`

**数据在哪**：`health.mjs:784` `const producingNow = anyProducedIn(after)` →
`classifyNetEffect` 的 `cleanup` 分支 → `st.lastNetEffect` → `renderLastStep` → `## LAST STEP`。

**送达了吗**：**部分送达**。

`## LAST STEP` 会把 `kind` + `why[]` 渲染进 prompt（实测 `LASTSTEP yes`）。
但 `classifyNetEffect` 产出的 **`delta` 原始数组不进 prompt** —— 模型只看到
`your last change: churn — WASTE — the world changed but nothing measurable improved` +
`· 世界形态变了，但连通性与目标没动 —— 货量虽然涨了，那只是货堆在带子上，不是流动`。
判词送了，数字没送。

**如果没送达，为什么**：不是「没送」，是「只送判词」。`renderLastStep` 只渲染
`e.why`（截 110 字符）与一句 `⇒`，`e.delta` 完全不读。

**该修什么 —— 一个真发现：B2 只修了一半，同一份数据上 `sign` 与 `kind` 会分叉。**

`3101b69` 把 `classifyNetEffect` 的 `producingNow` 改成只看 `after`（`health.mjs:784`），
但 `healthDelta` 里 `items_on_belts` 的 `sign` **仍是** `anyProducedIn(after) || anyProducedIn(before)`
（`health.mjs:507`），`stalled_growth` 的判据也仍是 `||`（`health.mjs:840`）。

同一份快照（`before: 有产出, items 350`；`after: 零产出, items 362`）：

```
items_on_belts sign = +        ← healthDelta：货涨算改善，时间线印 ▲
net kind            = churn    ← classifyNetEffect：已改成只看 after，判「不是改善」
```

时间线说「▲ 货多了是好事」，`## LAST STEP` 说「churn，什么都没改善」。这是 B3 在
`classifyNetEffect` 里那句「判词不许声称货量没动」想修的现象，**换了个位置又出现了**：
现在 `sign` 单方面说「+」，而判词说「不是流动」。要么把 `sign` 也改成只看 `after`，
要么在判词里说明「sign 那一列是按旧口径印的」。

---

### 修复 4：`items_on_belts` 加进 `NO_DIRECTION`

**数据在哪**：`health.mjs:954` `NO_DIRECTION` 集合 → `formatDelta` 的 `keep` 谓词 →
`tl.push` → `timeline.log`。

**送达了吗**：**这条不需要送达。** `timeline.log` 是给人读的（`loop.mjs:416` 明写），
不进 prompt。任务书自己也标注「可能根本不需要送达」。

**但如果要看它有没有效**：跑真实的 `formatDelta`，`items 350→362` 现在印
`· items_on_belts 350→362(+12)`（`·` 标记 = 变了但方向不判）。**B3 修对了。**

一个观察：全 1639 run 的 `timeline.log` 里，带 `items_on_belts` 的行 1132 条，
**带 `·` 标记的 0 条**。这**不能**说明修复无效 —— 那 1132 行都是历史（旧口径 `▲/▼`），
修复只影响 11-24 之后的 8 个 run，而那 8 个 run 恰好货量没变（死世界）。

**该修什么**：无需。但它和修复 3 是同一份数据的两个口径，见上。

---

### 修复 5：`obsTickPrev` → `obsTickLastSeen`

**数据在哪**：`loop.mjs:3589` `st.obsTickPrev = …obsTickLastSeen` → `loop.mjs:4030`
`tickSincePrev: ob.obs.tick - st.obsTickPrev` → `diagnose(..., { tickSincePrev })` →
`loop.mjs:969` `tickSincePrev: cx.tickSincePrev` → `semanticDiagnoses(..., opts)`。

**送达了吗**：**没有，而且不是「渲染层」的问题 —— 是它根本没有消费者。**

`grep -rn "tickSincePrev\|obsTickLastSeen" src/`：

```
loop.mjs:969         ← 传进 semantic（上一环）
loop.mjs:3590        ← 写 st.obsTickLastSeen
loop.mjs:4030        ← 算 tickSincePrev
loop.mjs:3139/3572/3586/4029  ← 全是注释
```

`semantic.mjs` 里 `opts.*` 的实际读取：`recipe`(×3) / `level`(×3) / `limits`(×2) / `max`(×2) / `facing`(×3)。
**`opts.tickSincePrev` 一次都没读。** `structural.mjs` 也是（只读 `recipe`/`limits`）。

`git show c63df17:src/agent/loop/semantic.mjs | grep tickSincePrev` = 0 —— 也就是说
**在删 `WORLD_FROZEN` 的那一刻（`c63df17`），它唯一的消费者就被删掉了**，
而 `loop.mjs` 的传参链（`st.obsTickLastSeen` → `tickSincePrev` → `cx.tickSincePrev` → `opts.tickSincePrev`）
原样保留到现在。

**这是死代码吗**：是。三样东西全是死的：

- `st.obsTickLastSeen` / `st.obsTickPrev`（两个字段，只互相赋值）
- `tickSincePrev`（算出来了，传进 `semanticDiagnoses` 的 `opts`，没人读）
- `diagnose` 的 `ctx.tickSincePrev`（同上）

**结论：留着还是删掉** ⇒ **删掉 `tickSincePrev` 那条链，但把 `obsTickLastSeen` 的
那句注释留成墓碑，说明「B4 的时序发现有价值，但没有消费者了」。**

理由：B4 的修法（分离开「轮首 observe 的 tick」与「verify 之后的 tick」）在**某一天有人
重新做「窗口够不够老」的判据时仍然是对的**。但当前不是一个「机制留着有价值」的状态 ——
它**四个环节里中间两环都在传一个没人读的值**，这正是 `computed-but-never-delivered`
的教科书形态。继续留着，下一个人会以为「诊断用到了它」。

（我不删，因为任务书禁止改 `src/`。这是一条给实施者的处方。）

---

### 修复 6：`WORLD_FROZEN` 截断漏报修复

**数据在哪**：`3101b69` 在 `semantic.mjs` 的 `WORLD_FROZEN` 分支里加
`pathsTruncated` / `pathCount` 判据、把「最堵的一条」改成「可见最堵 + 漏报的量」。

**送达了吗**：**没有。这个修复随着 `WORLD_FROZEN` 一起被删了。**

证据：
- `git show 3101b69 -- src/agent/loop/semantic.mjs | grep "^-" | grep -c "pathsTruncated|truncatedPaths|可见最堵"` = **14** 行被删
- `git show HEAD:src/agent/loop/semantic.mjs | grep -c "pathsTruncated|truncatedPaths|可见最堵"` = **0**
- 工作区（含未提交改动）也是 **0**
- `git show --name-only 6e98253` 只改了 `world_frozen.test.mjs` 和 findings，
  **代码删除发生在随后的 `c63df17`**（提交信息说「清掉注释」，实际删了 `semantic.mjs` 522 行）

**确认：修复 6 不存在了。** `6e98253` 的提交信息里「配套两件事」只提到 `remove_run` 和
CAPACITY 保底，**没提「截断漏报修复合着 WORLD_FROZEN 一起没了」**。这是真正的信息丢失：
那条修复（「截断时不许说『最堵的一条』」）本身是对的，只是它修的那条诊断被删了。
如果将来重新引入类似的「最堵」诊断，这条判据得重写。

**该修什么**：无需（诊断已删）。但在 `CHANGELOG` / findings 里应补一句
「截断漏报修复合着 WORLD_FROZEN 一起删除」，否则下一个人会以为它还活着。

---

### 修复 7：`CHAIN_UNFED` 的 `uids` 拆两组 + `live_chain_ends` + hint

这是唯一一个有三段的分项，逐段查。

#### 7a：`chain_belt_uids` —— **纯噪音字段**

**数据在哪**：`structural.mjs:1064` `chain_belt_uids: beltUids`（barren miner 分支）。

**送达了吗**：**没有。**

`grep -rn "chain_belt_uids" src/`（排除测试）：

```
src/agent/loop/constants.mjs:569   ← 一句注释
src/agent/loop/structural.mjs:1064 ← 生产（写字段）
```

**`src/` 里 0 个消费者。** `prompt.mjs` 里 `chain_belt_uids` 出现 0 次（我 grep 过），
`prompt.mjs` 只读 `evidence.handles` / `subject.handle` / `slot.cell_ref`（`referencedHandles`）。
所以这条「把下游带子单列，去掉 remove_run」的改动，**模型永远看不到下游带子的 uid 集合**。

**它有没有间接达到目的**：有 —— 但那条路**不经过这个字段**，见 8 的 `remove_run` 分析。
`structural.mjs:1036` 的 `guarded = liveRecs.length > 0 ? ["connect","remove_machine","insert_machine"] : ["remove_run",…]`
把 `remove_run` 从**诊断行的 candidates** 里拿掉了 —— 这一步是真的有效（实测诊断行
`candidates connect,remove_machine,insert_machine`）。但卡片的 `remove_run` 是从
`RETRIEVAL_TABLE` 来的，**不看 `d.candidates`**，所以 guard 管不到卡片（见 8）。

**结论：`chain_belt_uids` 是死代码。** 它的注释说「`remove_run` 只作用于这一组」，
但 `remove_run` 的 `region`/`uids` 是模型从卡片示例 `$uids:["B7","B8","B9"]` 里抄句柄的，
**没有任何代码把 `chain_belt_uids` 自动喂给 `remove_run`**。这个字段造出来是为了
「拆带子时用这组 uid」，但那条连线从来没接上。

#### 7b：`live_chain_ends` —— **送达（只经 hint）**

**数据在哪**：`structural.mjs:1078` `live_chain_ends: liveRecs.map(...)`，只在 `guarded` 时出现。

**送达了吗**：**送达，但只通过 `hint`。** 我合成一条 guarded 形态跑 `buildPrompt`：

```
1. CHAIN_UNFED …: M4 (miner); … observed M4 脚底下没有矿…；但其中 1 处末端还接着活着的机器;
   handles M4; hint: ⚠️ 别拆这条链。末端是 C3（painter） 的 color 槽（唯一供料），
   那台机器还活着、一直在等这一路。…; candidates connect,remove_machine,insert_machine
```

`live_chain_ends` 的**结构化字段名**不进 prompt（`renderDiagnoses` 不读它），但它要表达的
事实（「末端是 C3 的 color 槽、唯一供料」）**进了 hint**。这是仓库那条纪律的正确形态：
「模型读的是渲染文本，不是结构化字段」。**修对了。**

一个限定：`live_chain_ends` 只在 25 个 barren-miner 分组里的 **11 个**出现
（我在 401 个真实世界上跑 `structuralDiagnoses`：`withBarren:25, withChainBelts:25, withLiveEnds:11`）。
其余 14 个没 live 末端 ⟹ 本来就不该有这条事实 ⟹ 没有是**对的**，不是漏送。

#### 7c：`CHAIN_UNFED` 的 `hint` —— **送达（但普通形态没有 hint）**

**送达了吗**：**在 `nearbySource` 或 `guarded` 形态下送达；普通形态 0 条送达。**

真实世界 `r-20261031214805-dc42` 的 guarded 形态 hint（149 字符）走 `buildPrompt` 后完整出现
在 DIAGNOSIS 行尾。我实测 62 条真实 `CHAIN_UNFED` hint 的长度：

```
CHAIN_UNFED hints: 62  >180 (would be clipped): 0  min/median/max 149 149 154
```

**全部 ≤180，不会被 `clip(hint,180)` 截断。** `hint-truncated-before-arrival` 那个坑这次没踩到。

**但**：后修复的两个真实 run（`r-20261124090316-0c8d` / `r-20261124092748-a764`）
里 4 条 `CHAIN_UNFED` 全是 `hint:null`（evidence 只有 `handles,uids,tier,source`，
没有 `barren_miner`，也没有 `nearby_source`）。那两条诊断走的是
`structural.mjs:944` 的**普通分支**（入口没实体、附近也没机器输出口）⟹ `hint` 不存在 ⟹
DIAGNOSIS 行只有 `expected / observed / handles / candidates`，**没有任何「该怎么办」**。

**该修什么**：普通形态（输入端无实体、附近无机器）是最常见的 `CHAIN_UNFED`（真实 run 里 4/4），
它**没有 hint**。如果这条诊断想给动作，普通分支也该有一条（例如「从哪台机器接」或
「这条链该拆」）。现在的形态是：只有罕见形态（附近有源 / 有 live 末端）才拿到 hint。

---

### 修复 8：删 `WORLD_FROZEN` + `CHAIN_UNFED` 补 `remove_run` + `## CAPACITY` 极短保底

#### 8a：`## CAPACITY` 极短保底 —— **死代码，确认**

这是任务书要我重点查的一条。**结论：`short` 分支在零产出路径上永远不可达。**

调用点（`prompt.mjs:4288`）：

```js
if (room >= 120) {
    for (const form of ["full", "short"]) {
        const text = renderCapacity(capacityInfo.capacity, capacityInfo.options, { room, form, production, itemsOnBelts });
        if (text) { s3Capacity = text; capacityDowngraded = form === "short"; break; }
    }
}
```

`renderCapacity` 的零产出分支（`prompt.mjs:2578`）是：

```js
if (opts.form === "short" && num(opts.room) !== null && num(opts.room) < 200) { … return 短版 }
const head = flowing ? … : …;      // ← full 分支，返回 ~186 字符
return head + … + ".";
```

**`full` 分支在返回前根本不看 `room`。** 实测（零产出，`itemsOnBelts:376`）：

```
room=120 .. 2000  → full 分支返回 265 字符（或 186，取决于 iso）
```

也就是说：`room=120..199` 时，`full` 返回 265 字符（**比 room 还长**），
`renderCapacity` **不检查 `out.length > room` 就返回了**（因为零产出分支是 `return head + …`，
不是底部的 `if (room !== null && out.length > room) return null`）。于是：

- `if (text)` 为真 ⟹ 选 `full` ⟹ `short` 分支**永远不执行**
- 结果是：一个 265 字符的 CAPACITY **被塞进只有 120~199 字符余量的窗口**

反证：`for (const form of ["full","short"])` 的先 `full` 后 `short` 顺序**不会**救它，
因为 `full` 不返回 null。我直接模拟了调用环：

```
room=119  → outer gate room<120 → dropped-for-budget   （保底够不到）
room=120  → chosen=full   len=265                       （保底够不到，且超窗）
room=150  → chosen=full   len=265                       （保底够不到，且超窗）
room=199  → chosen=full   len=265                       （保底够不到，且超窗）
```

**`short` 分支唯一会走到的情形**是 `form` 被显式传 `"short"`——而 `buildPrompt` 只在上面那个
`for` 环里传，且 `full` 先成功。**所以 `short` 在零产出路径上 100% 是死代码。**

（注：`short` 分支在**非零产出**路径上**是**可达的——那条路径走到底部
`if (room !== null && out.length > room) return null`，所以 `full` 会因超长返回 null，
然后 `short` 补上。实测：`production=null, room=150 → chosen=short, len=133`。
但**修复 8 加的那段保底在零产出分支里**，那条分支不校验 room ⟹ 保底死。）

**该修什么**：两步。

1. **`renderCapacity` 的零产出分支（两个 `return`）必须在返回前检查 `room`** ——
   `if (num(opts.room) !== null && text.length > opts.room) return null;`
   这样 `full` 超长返回 null ⟹ 调用环自然会试 `short`。
2. **更根本的是 `room` 的语义**：零产出分支造出来是为了「方向性区分」（有货但零产出 vs 全空），
   它**不该受 120 字符的门槛约束** —— 方向错的钱比字符贵。要么给它更高的优先级
   （在带子之前抢名额），要么承认它是「可截断段」。现在的形态是「自己声明 ≤120 字符、
   但实际返回 265、还绕过 room 检查」，三处不一致。

#### 8b：`CHAIN_UNFED` 补 `remove_run` —— **半失效（下标 3 读不到）**

`constants.mjs:557` 给 `CHAIN_UNFED` 的表加了 `["remove_run", 3]`（weight 3），
排序后 `CHAIN_UNFED` 的 list 是 `[connect, insert_machine, extend_line, remove_run]`，
**`remove_run` 在 index 3**。

而 `candidatesFor`（`loop.mjs:653`）两轮读法：

- 第①轮：`list.find(c => !seen.includes(c.macro))` —— 取**第一个**没被占的
- 第②轮：`list.slice(1, 3)` —— **只读 index 1、2**

**index 3 永远读不到。** 实证（直接调 `candidatesFor`）：

```
单 CHAIN_UNFED            → [connect, insert_machine, extend_line]         ← 没有 remove_run
单 CHAIN_UNFED ×2         → [connect, insert_machine, extend_line]         ← 没有 remove_run
8 条（双 CHAIN_UNFED）    → [replace_run, connect, insert_machine, trash_unused, extend_line, remove_run]
```

**为什么双条时出现了**：第①轮对第 2 条 `CHAIN_UNFED` 做 `find(unseen)` 时，
`connect/insert_machine/extend_line` 已被第一条占掉 ⟹ `find` 走到 `remove_run`。
也就是说：**`remove_run` 卡片只在同一个世界里有 ≥2 条 `CHAIN_UNFED`、且前三个宏都被占时
才出现**——这完全是 candidatesFor 的「每个诊断都要有代表」+「重复诊断让同一个 list 被扫两次」
的副产物，不是「补了 remove_run」这条改动的本意。

量化影响（跑 2789 条 diagnose 记录）：

```
单 CHAIN_UNFED 快照: 422，其中 337（79.9%）没有 remove_run 卡片
双 CHAIN_UNFED 快照: 1887，其中 1011（53.6%）没有 remove_run 卡片
真实 run 里有 remove_run 卡片的轮次: 518（CHAIN_UNFED×0: 154 / ×1: 86 / ×≥2: 278）
```

**结论**：`6e98253` 提交信息说「给 CHAIN_UNFED 补了最低权重的 remove_run」——
补丁**确实写进了 table**，但**有 79.9% 的单链世界读不到它**。这是「加了参数 ≠ 加了能力」
的又一次复发（memory 里 `cheapest-was-early-break-sabotaged` 同型）。

**该修什么**：把 `["remove_run", 3]` 的权重提到 ≥ `extend_line` 的 4，或者直接改
`candidatesFor` 第②轮的 `slice(1, 3)` → `slice(1)`（但那会改变全表行为）。
最小改动：把 CHAIN_UNFED 表的 `remove_run` 移到 index 2（权重 4.5 或复用 4 但排序稳定在前），
并加一条测试断言「单条 CHAIN_UNFED 时 `candidatesFor` 含 remove_run」。

（顺带发现：**guard 挡不住卡片**。`structural.mjs:1036` 在「末端有活机器」时把 diagnosed
`candidates` 改成 `["connect","remove_machine","insert_machine"]`，这**只影响诊断行**的渲染
（`renderDiagnoses` 读 `d.candidates`），**不影响卡片**（`candidatesFor` 读 `RETRIEVAL_TABLE`，
完全不看 `d.candidates`）。实测：8 条诊断 + 双 guarded CHAIN_UNFED ⟹ 卡片里仍有 `remove_run`。
所以「末端有活机器就别拆」这条意图，在卡片层面没有生效。这是又一个「算出来 ≠ 送到」。）

---

## 最后一个数：`chain_belt_uids` / `tickSincePrev` / `## CAPACITY` 保底 的死代码判定

| 名字 | 生产点 | 消费者 | 判定 |
|---|---|---|---|
| `chain_belt_uids` | `structural.mjs:1064` | **`src/` 里 0 个**（仅 `constants.mjs:569` 一句注释 + 6 条测试断言） | **死字段** |
| `live_chain_ends` | `structural.mjs:1078` | `structural.mjs:1079` 自己（生成 hint 时读到） | **活的**（效果经 hint 送达） |
| `tickSincePrev` / `obsTickLastSeen` | `loop.mjs:3589/4030/969` | **`semantic.mjs` / `structural.mjs` 里 0 个** | **死链**（4 环传 1 个没人读的值） |
| `## CAPACITY` 极短保底（`form==="short" && room<200`） | `prompt.mjs:2578` | 调用环只在 `full` 返回 null 时试 `short`，而零产出分支 `full` 从不返回 null | **死代码** |

---

## 重建 prompt 的可信度

`tools/delivery-ledger.mjs` 逐项对齐 `loop.mjs:4262` 的 `buildPrompt` 实参
（`goal/obs/handles/diagnoses/candidates/production/itemsOnBelts/items/lastRound/lastNetEffect/
priorAttempts/goalChanged/obsoleteLines/recipe/runLog/stickyGoal/budget`），
预算键用生产值 `prompt_tokens_max: 5300` / `in_chars_max: 24000`。

**对 ≥3 个 run 的对齐结果**：

| run | 轮 | 重建 | 真机 `prompt_chars` | 差 | % |
|---|---|---|---|---|---|
| `r-20261123235846-de15` | 1 | 18789 | 18788 | **+1** | 0.01% |
| `r-20261123235846-de15` | 2 | 18780 | 18505 | +275 | 1.49% |
| `r-20261123235846-de15` | 3 | 18797 | 18520 | +277 | 1.50% |
| `r-20261124090316-0c8d` | 1 | 18776 | 18771 | +5 | 0.03% |
| `r-20261124090316-0c8d` | 2 | 18780 | 18808 | −28 | −0.15% |
| `r-20261124090316-0c8d` | 3 | 18831 | 18723 | +108 | 0.58% |
| `r-20261123135733-fe21` | 1 | 18793 | 18690 | +103 | 0.55% |
| `r-20261123231202-765f` | 2 | 18775 | 18549 | +226 | 1.22% |

**最大偏差 1.50%（≤3%），第一个 run 的第一轮差 1 字符。**

**但这些差是「逐段可解释的近似」，不是零误差**——必须读懂：

1. **transcript 不存逐轮 obs。** 每个 run 只有 `obs-last.json`（run 结束那一次）。
   对**第 1 轮**它恰好= 开局世界（零 apply），所以差 1 字符；
   对第 2/3 轮，世界已经改过，重建拿的是**末态**去近似**中间态** ⟹ `belts_shown` 会偏
   （实测 `de15` r2 重建 7 条带子、`r3` 2 条，而真机可能不同）⟹ 那 275/277 的差**主要是带子数量的差**。
2. **`priorAttempts` 的 world key 是猜的。** `worldInfo` 不在 transcript 里，
   我从 `attempts.json` 的 `worlds` 取「最近 `seed:*`」近似。`de15` 上我手动填 `seed:60908`
   （真实世界）才把差从 904 降到 1 —— 若猜错 key，`prior` 段整段消失/出现，差 ~600 字符。
3. **`runLog.detail` 退成宏名。** 真机用 `summarizeCalls` 生成一句话（「miner on blue ore」），
   重建只有宏名 ⟹ 偏短 ~10–30 字符/轮。
4. **`goalChanged` / `stickyGoal` 按 null 处理**（不在 transcript）。若真机那一轮有粘性目标，
   重建会少 ~200 字符。
5. **`recipe` 的 `capped` 是按 reason 文本推断的**（`/capped/i`）。`de15` 的 reason 含
   `"not proven unreachable"` ⟹ capped⟹ 触发 796 字符的 `## BUILD ORDER` 大段。
   这段长度正确，但若某 run 的 reason 措辞变了，推断会错。

**结论**：对**第 1 轮**（零 apply），重建可信（差 ≤108 字符、<0.6%）；
对**后续轮次**，它是**结构对齐、内容近似**，`belts_shown` 与 `prior`/`runLog` 的长度会漂。
「某字段在/不在 prompt 里」这类**定性**判断可信；「某个具体字符偏移」只在第 1 轮可信。

### 工具自身的一个假阳性（已修，记在这里防止下一个人重犯）

第一版 `8b` 用裸 `remove_run` 当 `in_prompt` 探针 —— 它 100% 命中，但命中的是
**SYSTEM 规则 3 的白名单行** `The ONLY allowed macro names are: connect, …, remove_run, …`，
不是卡片。这正是本仓库那条纪律：「`grep` 到了 ≠ 送到了」。改成锚定卡片头 `### remove_run`
（`renderCard` 的格式）之后才是真证据：`r-20261124090316-0c8d` 上它确实命中 @7870，
因为那一轮**是双 `CHAIN_UNFED`**（见 8b）——与「单链时拿不到」并不矛盾。

---

## 如果我是错的，最可能错在哪里

1. **修复 1 的「从未送达」是数据驱动的。** 我据「47/47 次 `count=0`」下结论。
   但 `reorientedBelts` 只在 `mode==="live"` 且有 `behavior` 时才算；若历史某个 live run
   在 `3101b69` **之后**跑过且 apply 过……我查了：`3101b69` 之后只有 2 个 live run
   （`0c8d` / `a764`），**都是 0 次 apply**。所以对它们「没数据」是必然的。若将来有一个
   place 机器到带子旁的 run，它可能会触发。

2. **CAPACITY 保底的死代码结论依赖于「零产出分支不检查 room」。** 我读的是
   `prompt.mjs:2578-2595`：`if (opts.form==="short" && room<200) return 短版` 之后
   直接 `return head + … + "."`，中途没有 `if (out.length > room) return null`。
   我用真实 `renderCapacity` 跑了 `room=0..2000` 全返回 186/265 字节，**实证成立**。
   但若调用环在未来改成 `["short","full"]` 顺序，保底会立刻生效——那也说明它现在的顺序是错的。

3. **`remove_run` 下标 3 读不到的结论**依赖 `candidatesFor` 第②轮是 `slice(1,3)`。
   我读了 `loop.mjs:653` 的实现并**直接调用**验证：单 CHAIN_UNFED 时卡片是
   `[connect,insert_machine,extend_line]`，**没有 remove_run**。这条是实跑出来的，不是读出来的。

4. **工作区被并行改了。** 见开头警告。`semantic.mjs` 的未提交改动若在我跑完之后又变，
   本报告的 `MACHINE_STARVED` 相关观察（我没在修复清单里审它）不适用；但 8 个修复的代码
   （`handles/health/prompt/structural/verify/constants`）不在那次改动范围。

---

## 给实施者的最小处方（按性价比排序）

1. **修 `renderCapacity` 零产出分支的 room 检查**（一行）：`return` 前加
   `if (num(opts.room) !== null && text.length > opts.room) return null;`。
   否则 CAPACITY 保底是死的，且当前 265 字符会挤进 <200 的窗口。
2. **修 `CHAIN_UNFED` 表里 `remove_run` 的下标**：从 index 3 提到 index ≤2（或改 `slice(1)`）。
   否则 79.9% 的单链世界拿不到「拆掉它」这张卡。
3. **删 `tickSincePrev` 那条链**（4 处传参 + 2 个 st 字段），留一句墓碑注释。
   否则下一个人会以为诊断在用「窗口够不够老」。
4. **删 `chain_belt_uids`**，或把它接到 `remove_run` 的 region 上。
   现在是「造了一个选区字段，没人用它做选区」。
5. **把 `healthDelta` 的 `sign` 也改成只看 `after`**（与 B2 对齐），
   否则时间线与 `## LAST STEP` 对同一事件给相反口径。
6. **给普通形态的 `CHAIN_UNFED` 补一条 hint**（真实 run 里 4/4 是普通形态，0 条有 hint）。
7. **`reorientedBelts` 加一个 `FakeGame` 端到端夹具**（place+delete 两 op，让 FakeGame 按
   邻居规则重算），否则它永远是「代码改了、测试绿了、真机从没出现过」。