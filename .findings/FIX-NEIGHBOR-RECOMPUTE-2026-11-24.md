# `insert_machine` 的邻居重算副作用：它还在发生，而且比报告里说的更严重

2026-11-24。**全程离线**：只读 `src/`、`recon/upstream-full/`、`recon/bundle.js` 与
`research/ai-plan/runs/`。没连游戏、没改 mod、没碰存档。

---

## 0. 一句话

**这个副作用在当前代码里仍然会发生，而且每一条 op 都会发生。**
根因不是「没包 immutable」—— `tx` 确实包了 —— 而是
**`performImmutableOperation` 是同步的，而 `tx` 的执行体是 `async` 的**：
`await` 一挂起，immutable 标志就被 `finally` 复位，**第一条 op 之后的所有 op 都在
immutable 之外执行**。`systems/belt.js:169` 的那道闸门因此只护住了第一条 op。

修法选了 **C（只在 loop 侧渲染，不改 mod）**，因为 `loop.mjs` 每轮本来就有
`beforeObs` / `afterObs` 两份同口径世界，相减就能算出谁被改了——
**不需要重新 patch 游戏，可以立刻离线验**。

---

## 1. 这个副作用到底还发不发生？—— 会，而且每条 op 都会

### 1.1 游戏侧的机制（读 `recon/upstream-full/`，与 `recon/bundle.js` 逐字对照）

`systems/belt.js:59-64` 把同一个监听挂到**两个**信号上：

```js
this.root.signals.entityDestroyed.add(this.updateSurroundingBeltPlacement, this);
this.root.signals.entityAdded.add(this.updateSurroundingBeltPlacement, this);
```

`updateSurroundingBeltPlacement`（`systems/belt.js:117-212`）取
`staticComp.getTileSpaceBounds().expandedInAllDirections(1)`，
逐格看邻居带子，调 `computeOptimalDirectionAndRotationVariantAtTile()`
（`buildings/belt.js:161-247`）算出**游戏认为最优**的 `(rotation, rotationVariant)`，
然后**真的覆写** `targetStaticComp.rotation`、`updateVariants()`、`targetStaticComp.code`
（`systems/belt.js:186-196`）。

唯一的闸门在这一行：

```js
// recon/upstream-full/src/js/game/systems/belt.js:169
if (
    !this.root.immutableOperationRunning &&
    (targetStaticComp.rotation !== rotation || newDirection !== targetBeltComp.direction)
) {
```

我在**发布包** `recon/bundle.js` 里核对过同一行（`@496633`）：

```
if(!this.root.immutableOperationRunning&&(m.rotation!==y||C!==f.direction)){...}
```

并且发布包的 `performImmutableOperation`（`@1013008`）与源码同形：

```
_performImmutableOper(e){
  l.warn("Running immutable operation ..."),
  this.root.immutableOperationRunning=!0,
  var t=performance.now(), r=e(), i=performance.now()-t;
  return ... this.root.immutableOperationRunning=!1, ...
}
```

注意 `var r=e()` —— **同步调用**。它拿到的返回值直接往下传；如果 `e` 返回
Promise，它**不会等**，`immutableOperationRunning=!1` 在 Promise 还是 pending
的时候就已经执行了。

### 1.2 mod 侧：`tx` 确实包了，但包错了形状

`src/mod/shapez-ai-bridge.js:3800-3828`：

```js
await this.runGuarded(root, async () => {          // ← 异步执行体
    for (let i = 0; i < ops.length; ++i) {
        const res = await this.performAction(op);   // ← 每个 op 都 await
        ...
    }
});
```

`runGuarded`（`shapez-ai-bridge.js:2048-2056`）：

```js
runGuarded(root, fn) {
    const logic = root.logic;
    if (!logic) return fn();
    const needBulk = !root.bulkOperationRunning && typeof logic.performBulkOperation === "function";
    const needImmutable = !root.immutableOperationRunning && typeof logic.performImmutableOperation === "function";
    if (!needBulk && !needImmutable) return fn();
    const wrapped = () => (needImmutable ? logic.performImmutableOperation(fn) : fn());
    return needBulk ? logic.performBulkOperation(wrapped) : wrapped();
}
```

`performBulkOperation` / `performImmutableOperation` 都是**同步函数**，它们的
`finally` 在 `fn()` 返回那个 Promise 的**那一刻**就复位了标志。而 `fn` 是
`async`，`await this.performAction(op)` 让出执行栈 —— 于是：

```
t0:  immutableOperationRunning = true      ← 进入 performImmutableOperation
t1:  op[0].performAction()                 ← 同步跑完，immutable = true   ✅
t2:  await → 让出执行栈
t3:  performImmutableOperation 的 finally   ← immutable = false
t4:  op[1].performAction()                 ← 同步跑完，immutable = false  ❌
t5:  op[2].performAction()                 ← immutable = false            ❌
```

### 1.3 我拿**真 mod 源码**证明了这一点

把 `src/mod/shapez-ai-bridge.js` 装进一个 vm 沙箱（与 `test/mod_selftest.mjs`
同一套 stub），用**真**的 `runGuarded` 套一个与 `opTx` 同形的 async 循环，
`root.logic` 按 `recon/upstream-full/src/js/game/logic.js:170-203` 逐行复刻：

```
REAL runGuarded over an async body (same shape as opTx):
  delete#15021     immutable=true
  place#trash      immutable=false

RESULT: 1/2 ops executed with immutableOperationRunning=false
  => systems/belt.js:169 guard is OFF => updateSurroundingBeltPlacement WILL rewrite neighbours.
```

**只有第一条 op 受保护。** 复现脚本在 `.tmp-neighbor/mod-async-proof.mjs`（已删）。

### 1.4 这解释了一件对不上的事

`git log` 显示 `e5785d2`（2026-11-03）就是「tx 漏了 immutable」的修复，而事故发生在
**2026-11-15**，晚了 12 天。修复之后为什么还会重算？

因为那次修复的**真机验证是单 op 的**：commit message 里写的是
`{"op":"place","building":"belt","x":4,"y":-8,...}` 一条 op、`applied=2`（另一条是它自己）。
**一条 op 的 tx 恰好是被保护住的那一条。** 多 op 的 tx —— 也就是
`insert_machine` 真实产生的形态（`destroys:[15021]` + 1 个 placement = **2 条 op**）——
第二条起就漏了。

事故的 tx 正是 2 条 op（`planToTxOps.mjs:842-844` 的排序是
**先全部 deletes，再全部 places**）：`delete#15021` 受保护，`place#trash` 不受保护。
垃圾桶落地时 `updateSurroundingBeltPlacement` 按邻居重算
`belt#14953` 与 `belt#15019` —— 时间线、格点、rv 方向全部对得上。

> ⚠️ 这是**离线推断**，不是真机复现。它的强度来自三处独立证据一致：
> ① 源码的 `if (!immutableOperationRunning)` 分支；② vm 里真 `runGuarded` 的标志泄漏；
> ③ 事故 tx 恰好是「1 delete + 1 place」而 commit 的验证恰好是「单 place」。
> **建议的实机验证见 §7。**

---

## 2. 为什么 immutable 没拦住它

不是「没包」，是**包在了一个同步原语里，却传给了一个异步执行体**。

`runGuarded` 自己的注释写着「不嵌套 —— 上游 `logic.js:190` 对重入是 assert 失败」。
这条约束是对的，但它只防了**重入**，没防**跨越 await**。上游的
`performImmutableOperation` 从设计上就假设 `operation` 是同步的 ——
游戏自己唯一的调用方（`blueprint.js:159` 的 `tryPlace`）确实是同步的循环，
所以上游从来没暴露过这个缺口。

还有一个旁证说明这个坑一直没人踩出来：`loop.mjs:5092` 上一轮才刚补上
`diff.modified` 落盘，而 `opTx` 里 `verify` 段的注释（`shapez-ai-bridge.js:3869-3871`）
写着「**modified 非空不代表回滚失败 —— 它可能是合法重算**」。也就是说
**代码早就知道「邻居会被重算」这件事**，只是把它当成正常现象，没当成要报告的副作用。

---

## 3. 选哪个修法

### 选 **C：只在 loop 侧渲染**（+ 在 verify 层加一条读数）

| 候选 | 判断 |
|---|---|
| **A. 在 `tx` 返回里加 `modified_detail`** | **不做**。数据确实有（`diffSnapshots` 已经算出 `modified` uid 列表，`serializeEntity` 也带 `rotation` / `rotationVariant`），但这是**改 mod**：要重新 patch 游戏、重启、真机验证。而游戏现在没跑（`mod_connected: false`），改完只能靠静态检查 —— 这个仓库的教训是「这类 bug 单测全绿真机无效」。而且它解决不了「用户不重装 mod 就看不到」的问题。 |
| **B. 在宏层加 warning** | **不可行，你说得对**。任务书自己也写了：`insert_machine` 落地后无法预知游戏会怎么重算 —— 那是 **tx 之后**的事，宏是纯规划器（`place.mjs:2` 明写「零游戏写操作」）。要在宏里算，就得在宏里模拟一遍 `computeOptimalDirectionAndRotationVariantAtTile` + 整个 footprint 外扩一圈，那是**第二份几何真值**，必然与游戏漂移。这个仓库已经因为「两处口径不同 = 两份世界」栽过（`loop.mjs` 里那条 V2 §5.5 注释）。 |
| **C. 只在模型侧渲染** | **做这个**。`loop.mjs` 每轮都有 `beforeObs`（轮首 observe）与 `afterObs`（verify 内部与 verify 之后各读一次，同口径）。两份相减 = 谁被改了。**不改 mod、不需要重装、可以立刻离线验**，而且对**任何**触发路径都有效（`place` / `delete` / `insert_machine` / `paste_blueprint` 一视同仁 —— 不像 B 只覆盖一个宏）。 |

**C 的判据边界（刻意窄）**：

- 只看**两份 obs 都在**的带子 —— `added` / `removed` 归 `diff` 管，混进来会让这个读数变成 diff 的复读机；
- 只看 `(r, rv)` 任一变化 —— `code` 由 `rv` 决定（`code = 1 + rv`），多看一遍只会重复计数；
- 排除 `txPlan.destroys` 里的 uid —— 计划声明过的删除不算「静默」；
- **不判红**：邻居重算是游戏正常行为，多数时候算出来和我们要的一致。判红会让每一次正常放置都失败。

---

## 4. 改了什么、加了什么测试

### 4.1 新函数：`reorientedBelts()`（`src/agent/loop/verify.mjs`）

纯函数。入参两份 obs + 可选的 `declaredDestroys` / `handleTable`，返回：

```js
{
  count: 2,
  items: [{
    uid: 14953, handle: "B149", x: -3, y: -7,
    before: { r: 90, rv: 2 }, after: { r: 90, rv: 0 },
    entry:  { before: "left", after: "left" },
    exit:   { before: "bottom", after: "right" },   // ← 「左→下转角 变 左→右直带」
  }, ...],
  truncated: false,
}
```

入口/出口方位用 `belt-rules.mjs` 的 `beltEntry()` / `beltExit()` 算 —— 与
`planToTxOps` 的 flow 派生、`verify_runtime` 的 `slotsOf` 同一套几何定义，
不是第二份实现。

### 4.2 `verifyRound()` 接线（同文件）

- 新增可选参数 `handles`（句柄表，只用于渲染成 `B149` 这种模型认得出的名字）；
- 产出 `report.reoriented`，并复制一份进 `evidence.reoriented`；
- 新增一条 check `V-belt-reorient`，**`ok: true`** —— 它是读数不是批评；
- **不动** `strictVerdict`、不动 `round.ok`、不动 `applyVerdict`：邻居重算不改变任何既有裁决。

### 4.3 `loop.mjs` 接线

- `verifyRound({ ..., handles: st.handles })`；
- `tr.write("verify", ...)` 里落 `belt_reorient`（计数 + 前 5 条）→ 进 `transcript.jsonl` 与 `verify-last.json`；
- `st.lastPlanSummary.belt_reorient`（只在 `continue` 路径上，`success` / `offline_only` 都 `break` 了，给了也没人读）。

### 4.4 `prompt.mjs`：`## LAST ROUND` 新增一段

```
reoriented belts (the game rewrote these — no op asked for it):
  · B149: in left→left, out bottom→right
  (+2 more)
  ⇒ You did not declare these. The game recomputes belts next to anything you
    place/remove. If one of them was feeding a machine, your change broke it.
```

排版纪律：用**句柄**不用 uid；报**入口/出口方位**不报裸数字；最多 3 条；
放在 `consequences of last round's calls` **之前**（「你没写但世界变了」比
「宏自己算出的后果」更意外）；方位算不出来时退回 `r/rv` 数字，**不猜**。

预算：这一段每轮最多约 200 字符，且只在 `count > 0` 时出现。
`prompt_budget.test.mjs` 的 B1/B4 全程绿。

### 4.5 测试：`src/agent/loop/reorient.test.mjs`（13 条，全绿）

| # | 钉住什么 |
|---|---|
| R1 | ★ 事故复现：rv 2→0 与 r 180→90 必须被算出，**且没变的两条不许出现**（判别力） |
| R2 | 入口/出口方位算对（`out bottom→right` 就是事故原文那一条） |
| R3 | 新放的带子不算「被改向」（added 归 diff） |
| R4 | `declaredDestroys` 里的不算静默 |
| R5 | 非带子实体（机器）转向不进来 |
| R6 | 缺一份 obs → 返回空，不抛不猜 |
| R7 | 有句柄表用句柄，没有退 uid（不编） |
| R8 | ★ prompt 里出现句柄 + 方位 + `You did not declare these` |
| R9 | 没有改向时**整段不出现**（不许每轮空转） |
| R10 | 只渲染前 3 条，其余 `(+N more)` |
| R11 | prompt 里不许出现裸坐标 / 裸 uid |
| R12 | ★ `verifyRound` 端到端：`reoriented` + `evidence` + `ok:true` 的 check，且**不让 `applyVerdict` 变红** |
| R13 | 没重算时是 `0` 不是「缺失」（「0 条」与「没算」必须长得不一样） |

### 4.6 回归

```
node --test src/agent/
  baseline: tests 773 / pass 741 / fail 28    ← 改动前
  after:    tests 799 / pass 767 / fail 28    ← 改动后
  新增 13 条全绿；失败集合逐条比对：新增 0、修复 0（同一批 28 条老失败）
```

> 测试总数 773 → 799 = +13（本次新增）+13（并发 agent 新增的
> `structural.test.mjs` / `world_frozen.test.mjs` 增量）。失败数严格保持 28。

> ⚠️ 期间有另一个 agent 在并发改 `semantic.mjs` / `structural.mjs` / `structural.test.mjs`。
> 中途有一次跑出 30 个失败（多出 B1/B4），复跑后回到 28 —— 是那个 agent 的中间态，
> 与本次改动无关（我的 prompt 段在 `lastRound == null` 时走
> `renderLastRound` 的早退分支，而 B1/B4 恰好传 `lastRound: null`）。

---

## 5. 是否需要重新 patch 游戏？

**不需要。**

这次改动全在 `src/agent/loop/`（Node 侧，不在游戏里跑）。`src/mod/shapez-ai-bridge.js`
**一个字节都没改**，所以：

- 不需要重装 / 重新 patch mod；
- 不需要重启游戏（游戏现在也没跑，`mod_connected: false`）；
- 用当前已装的 mod 版本就能生效。

**它为什么能不改 mod**：判据需要的两条信息（`beforeObs` / `afterObs`）loop 本来就有。
`verifyRound` 内部读 `afterObs` 时用的参数与 `loop.mjs` 的主 obs **逐字一致**
（`layer:"all", max_entities:50000, include_stats:true, include_resources:true,
max_resources:20000`）—— 这是 v2 §2.4 那条「两份 obs 取数口径必须相同」的纪律，
我复用了它，没有新开一条口径。

---

## 6. 反证：这个修法有没有可能引入新问题？

### 反证 1（已处理）：会不会把「我们自己想要的改向」也报成异常？

会，而且**这是对的**。`place` 一条带子时，游戏可能顺手把它旁边的带子重算成
「我们其实也想要」的方向 —— 那时这一段仍会出现。我选择**不**尝试判断
「这次重算是不是好事」：那需要一个「期望拓扑」的独立真值，就是候选 B 的死路
（第二份几何真值）。

代价是这一段可能偶尔是噪音（一次正常的转角重连）。接受这个代价的理由：
它是 `ok:true` 的读数，不改变任何裁决；而漏报的代价是 2026-11-15 那种**整厂停产**。
不对称。

### 反证 2（已处理）：性能 —— 每轮多扫一遍实体表？

`reorientedBelts` 是两次 O(n) 遍历 + 一次 Map 查找，n = 实体数（L12 实测约 750）。
这比 `verifyRound` 里已有的两次 `worldHealth()`（各含连通性 BFS）**便宜得多**，可以忽略。
不过它确实是**新增的每轮开销**，在大存档（>5000 实体）上会略有增长 —— 没有基准测试，
这是我没有量化的边界。

### 反证 3（真风险，尚未处理）：`V-belt-reorient` 会让 `checks` 多一条，可能影响别处的计数

`verifyRound` 的 `evidence.checks_ok` / `checks_failed` 按 `checks` 数组统计，
我加了一条 `ok:true` 的 check，所以 `checks_ok` 会 +1。我查过**没有任何判据用这两个数字**
（`strictVerdict` 按 name 查；`phaseTwoVerdict` 用 `classifyChecks` 的结果；
`offline_boundary` 不读它们）—— 它们只进 evidence/transcript。但如果将来有人
按 `checks.length` 做断言，会踩到。**这是已知的、有意的形状变化。**

### 反证 4（范围限制，必须说清）：它只看**朝向**，不看「这条带子还在不在链上」

如果游戏的重算改的是**路径归属**（`Belt.assignedPath`）而不改 `(r, rv)`，
这个读数看不见 —— `assignedPath` 不在实体 schema 里，也不在 obs 里。
不过事故那次改的正是 `(r, rv)`（rv 2→0 必然改 `code`），所以对这一类有效。

同理，`loop` 的 obs 若因为 `max_entities: 50000` 被截断，差集会出现假消失 ——
但 `reorientedBelts` 只处理**两边都在**的 uid，截断不会造成假的「改向」，
只会**漏报**被截掉那一部分的改向。`L0-observation` 截断时 `strict` 本来就会红。

### 反证 5（最重要的诚实边界）：这条读数**不解释因果**

它说「这两条带子的朝向变了、而且没有 op 要求」，但它**不说**「所以工厂停了」。
真正的因果链（`belt#14953` 改向 → 竖列进料口断 → painter 缺料 → 全图产出 0）
仍然要靠诊断层（`CHAIN_UNFED` / `MACHINE_STARVED`）在**下一轮**去发现。

这段的价值是**把「你顺手改了什么」这条事实送到决策者眼前**，
不是替它做归因。这与本仓库那条 `computed-but-never-delivered` 的教训一致：
先把事实送到，归因是下一层的事。

### 反证 6：我**没有**修那个真正的 bug（mod 的 immutable 泄漏）

第 1 节证明了 `tx` 的 immutable 只护住第一条 op。**我修的是「让它可见」，
不是「让它不发生」。** 这是一个有意的范围选择，理由是：

- 修 mod 需要重新 patch + 真机验证，而游戏现在没跑 —— 改了也验不了；
- 「让它可见」能立刻交付，且对**任何**触发路径有效（包括未来才发现的新路径）；
- 「让它不发生」是另一个决策（要不要让 tx 里的 place 与单独 place 行为不同？），
  而且万一改坏了**没有回退手段**（游戏侧行为）。

**这个泄漏应当单独立项修**，任务书交给我的唯一问题是「能不能让它可见」——
能，已经做到了。但请把 §1 当作一个独立的 blocker 上报：
只要那 3 行 `await` 还在，任何多 op 的 tx 都会在第一条 op 之后失去 immutable 保护，
这是 `insert_machine` / `replace_run` / `paste_blueprint` 之外的**所有**多 op 路径。

---

## 7. 建议的实机验证（等游戏能跑时）

改 mod 之前**先验** §1 的结论。两条独立的路：

1. **直接用现有 mod**：对同一个 2-op tx（1 delete + 1 place，place 在一条带子旁边）
   跑两次 —— 一次原样，一次拆成两个单 op 的 tx。如果 §1 成立，
   原样那次的第二条 op 会改到邻居的 rv，拆开的两次不会。
   `obs` 前后相减就能看见（**现在这个新读数就能直接读出来**）。

2. **只看日志**：真机日志里 `Running immutable operation ...` / `Done in X ms`
   成对出现时，`Done in` 后面紧跟着的 op 就已在 immutable 之外。
   多 op tx 应当看到 `Done in` 早于最后一条 op 完成。

---

## 8. 产出清单（绝对路径）

```
D:\Projects\rea\Project work\shapez\src\agent\loop\verify.mjs          reorientedBelts() + verifyRound 接线
D:\Projects\rea\Project work\shapez\src\agent\loop\prompt.mjs          ## LAST ROUND 的 reoriented belts 段
D:\Projects\rea\Project work\shapez\src\agent\loop.mjs                 handles 透传 + transcript + 下一轮 prompt
D:\Projects\rea\Project work\shapez\src\agent\loop\reorient.test.mjs   13 条测试（新增）
```

未改动：`src/mod/shapez-ai-bridge.js`（一个字节都没动 —— 这就是「不用重新 patch」的证据）。
