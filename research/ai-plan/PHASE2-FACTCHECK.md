# PHASE2 事实核查（独立核实，2026-10-28）

方法：每一条都自己 grep/read 代码，涉及行为的另写临时脚本实跑（脚本在 `.tmpverify/factcheck_*.mjs`，可复跑）。
基线：`HEAD = ae12a9f`。核查期间工作区有并发提交落地（`07928ad` 假游戏 / L3 降级自曝、`ae12a9f` PHASE2-CONTRACT），
本文件以**当前工作区**为准，并注明哪些结论在 `HEAD` 与工作区之间发生过变化。

---

## 最危险的三个错误前提

**前提 1（最致命）：「`verifyRuntime` 返回 `ok:true` = 这条产线真的通了」。不成立。**
我构造了一个**只加一格带子、其余什么都没接**的计划，`verifyRuntime` 返回 `ok:true`：
L2 因「计划里没有机器」而 `skipped`，L3 无 flows 时是 `degraded:true` 的绿，L4 只要**全厂历史上**产出过该形状就绿
（它读 `produced_total` 的绝对值，不是增量；而且 `produced_delta` 只写进 evidence、不参与判定）。L0 与 L1 是真绿，但 L1 只判「我声称贴的东西在不在」。
证据：`src/agent/verify_runtime.mjs:850`（`checks.every(c => c.ok || c.skipped)`）、`:582`（L2 skip）、
`:718-732`（L3 degraded 绿）、`:748-760`（L4 用绝对值）。实跑见本条下面 §6/§7/§8。
→ loop 绝不能拿 `r.ok` 当成功判据，必须自带 `strictVerdict`（PHASE2-CONTRACT §1.5 已正确识别）。

**前提 2：「`insert_machine` 的 `pending` 可以喂给 `connect`」。不成立——契约接受，实现拒绝。**
`validateConnectArgs({from: pending})` 返回 `ok:true`（`contract.mjs:491-497`），但 `connect()` 在
`connect.mjs:304` 返回 `bad_type: "from 形态不认识"`。**六个宏里只有 `trash_unused` 真正实现了 pending 分支**
（`remove.mjs:1621`）。所以「insert_machine → trash_unused」能串（实跑成功），
「insert_machine → connect」必须分两轮（落盘 + 重读 obs 拿真 uid）。

**前提 3：「六个宏的返回值都能直接喂 `verifyRuntime`」。不成立，只有 3/6。**
`normalizePlan` 实际命中：`connect` → `connect.cells[]`、`extend_line` → **`connect.cells[]` 分支**（不是注释里写的 `execution.cells[]`，因为它的 `cells[]` 里带 `building` 且先命中 `:250-258`）、`replace_run` → `macro{placed,removed}`。
**`insert_machine` / `remove_run` / `trash_unused` 的返回值一律抛「无法识别的 plan 形态」**（实测）。
loop 必须自己拼 plan，不能把宏输出直接转手。

> 附加的第四条（不是"错误前提"，但同样会咬人）：`connect.cells[].rotationVariant` 是精确 rv，
> 而 `tx` 只能走 `place{rotationVariant}`；`place` **不接受 `code` 字段**（`shapez-ai-bridge.js:2424` 的字段白名单），
> 而游戏在 `entityAdded` 上会重算带子 rv（`shapez-ai-bridge.js:2596-2598` 的注释、`BELT-TOPOLOGY-RULES.md` 规则 2）。
> 也就是说「connect 的计划 → tx 逐格 place{r:rv} → 拓扑完全一致」**没有实机证据**，只能靠 `mismatch`/L1 抓。

---

### 1. `connect()` 返回值里 `cells[]` 的字段；能否直接转 tx `place`
**结论**：成立（字段齐全，但不能原样 spread）。
**证据**：`src/agent/macros/connect.mjs:854-857`
```js
const cellsOut = pick.chain.map(c => ({
    x: c.x, y: c.y, building: c.building,
    rotation: c.rotation, rotationVariant: c.rotationVariant, code: c.code,
    inDir: c.inDir, outDir: c.outDir, entry: c.entry, exit: c.exit,
}));
```
实跑（cutter@0,0 → hub@10,0，11 格）第一格：
`{"x":1,"y":-1,"building":"belt","rotation":0,"rotationVariant":2,"code":3,"inDir":"top","outDir":"right","entry":"bottom","exit":"right"}`
—— **拐角带的 rv 在里面**（rv=2，code=3=1+rv）。
转 tx 要改三个名（`building→building` 同名、`rotation→r`），并**丢掉** `code/inDir/outDir/entry/exit`
（`tx` 的 `place` 白名单只有 `building,x,y,r,variant,rotationVariant,rv,originalRotation,orig`，见 `src/mod/shapez-ai-bridge.js:2424`；
未知字段会被 `validateAction` 直接 2001 拒绝，`:2404-2416`）。且 `code` **不能**通过 place 指定。

**顺带发现两处宏自己给的"执行提示"是错的**（照抄会 2001）：
- `insert_machine.execution.note` 写的是 `place{code:9, x, y, r}`（`place.mjs:771-775`）——`code` 不在 `place` 白名单。
  实跑按这条 note 拼 op → unknown field `code`；去掉 `code` 才是合法 op。
- `extend_line.execution.method` 写的是 `"paste_blueprint"`（`place.mjs:1164`），而 `paste_blueprint` **不在** `tx` 允许的 op 里（§10），
  且它会扣 hub 的货（不可回滚）——照抄就等于放弃原子性。
**对 loop.mjs 设计的影响**：需要一个 `cellsToTxOps()` 显式映射层；rv 必须随格下发，`code` 只能当读回期望值。

### 2. `insert_machine` 返回 `pending`，下游宏真的能消费吗
**结论**：部分成立——`trash_unused` 能，`connect` **不能**（契约能，实现不能）。
**证据**：
- 契约侧放行：`src/agent/macros/contract.mjs:491-497`
```js
if (isPendingRef(v)) {
    if (v.port !== undefined) { const p = validatePort(v.port, `${field}.port`); if (!p.ok) return p; }
    return ok({ pending: v, ...(v.port !== undefined ? { port: v.port } : { port: "auto" }) });
}
```
- connect 实现侧的解析只有三个分支，然后落空：`src/agent/macros/connect.mjs:279-305`（调用点 `:686-688`）
```js
function resolveEntity(ep, world, field) {
    if (!world) return { ok:false, code:"precondition_failed", ... };
    if (ep.uid !== undefined) { ... }
    if (ep.hub !== undefined) { ... }
    if (ep.cell !== undefined) { ... }
    return { ok: false, code: "bad_type", message: `${field} 形态不认识` };   // ← :304 pending 落到这里
}
```
（pending 里 `uid:null` 被契约归一化时丢掉了，所以连 `endpoint_not_found` 都拿不到。）
- trash_unused 有 pending 分支：`src/agent/macros/remove.mjs:1621-1737`（`if (outlet.pending !== undefined)`）。
实跑三连（同一 ctx，hub@30,30）：
```
A) connect({from: im.pending, to: {hub:{}}})        -> false  bad_type "from 形态不认识"
B) applyToWorld(im) → connect({from:{uid:-1}})      -> false  bad_type "from.uid 必须 >= 0"
C) trash_unused({outlet: {...im.pending, port:"left"}}) -> true  trashCell=[21,20]
```
可行路径（实跑 22 格连通）：`applyToWorld(im, ctx)` → `connect({from:{cell:[20,20], port:"left"}, to:{hub:{}}})`。
**对 loop.mjs 设计的影响**：宏间"计划态串联"只能在 trash_unused 这一条边上成立；其余必须走「落盘→重读 obs」。

### 3. `replace_run` 的 `removed_uids` / `removes[]` 结构；能否直接转 `{op:"delete",uid}`
**结论**：成立。
**证据**：`src/agent/macros/remove.mjs:1558-1564`
```js
removed_uids: removed.map(r => r.uid),
added_uids: [],                       // 计划态没有真实 uid（由 tx 分配）
removes: removed.map(r => ({
    uid: r.uid,
    expect: { type: "belt", x: r.cell[0], y: r.cell[1], r: c0.world.byUid.get(r.uid).r },
})),
```
`removed_uids` 存在（`remove_run` 也有，`:599-606`）。`removes[]` 每项 = `{uid, expect:{type,x,y,r}}`。
转 `{op:"delete",uid}` 是**有损但合法**的（丢掉 `expect`；`tx` 的 `delete` 只认 `x,y,layer,uid`，`shapez-ai-bridge.js:2426`）。
**对 loop.mjs 设计的影响**：`expect` 是执行前的最后一层身份核对，丢在 loop 里等于放弃「uid 漂移」防线；建议比较后再丢。

### 4. 六个宏：纯函数/ctx 需求、能否喂 verifyRuntime、有无统一 ops 输出
**结论**：全部是同步纯函数、零写操作；全部需要 `ctx`（唯一的 `{entities}` 就够）；**无统一 `records`/`ops` 输出**。
**证据**：
- `grep "export async function" src/agent/macros/` 命中 **0**。
- 无 ctx 时六个宏全部结构化失败（实跑）：
```
connect(no ctx)        precondition_failed  "connect 需要 ctx.entities（obs 的实体表）才能解析 from"
insert_machine(no ctx) precondition_failed  "没有 ctx.entities（obs 实体表）⇒ 无法检查占位，拒绝在盲区放机器"
extend_line(no ctx)    precondition_failed  "没有 ctx.entities…"
remove_run(no ctx)     precondition_failed  "remove_run 需要 ctx.entities…"
replace_run(no ctx)    precondition_failed  "replace_run 需要 ctx.entities…"
trash_unused(no ctx)   precondition_failed  "trash_unused 需要 ctx.entities…"
```
- ctx 形态接受度**不统一**（实跑）：

| ctx 写法 | insert_machine | remove_run | connect | trash_unused |
|---|---|---|---|---|
| `{entities}` | ✓ | ✓ | ✓ | ✓ |
| obs 整体 | ✓ | ✓ | ✓ | ✓ |
| `{obs:{entities}}` | ✓ | ✗ | ✗ | ✗ |
| `{world:{entities}}` | ✓ | ✗ | ✗ | ✗ |
| world `{cells,byUid}` | ✓* | ✓ | ✓ | ✓ |

*但仅限 `place.buildWorld()` 造出来的 world；`connect.buildWorld()` 造出来的同名对象喂 `insert_machine` 会 **抛 TypeError**（见下）。

（place 额外认 `ctx.obs` / `ctx.world.entities`：`place.mjs:262-264`；remove 的 `entitiesOf` 只认两种：`remove.mjs:112-117`；connect 只认两种：`connect.mjs:167-169`。）

**另一个会炸的坑**：两个模块的 `buildWorld` 形状**不一样**——`connect.mjs:160` 返回 `{cells,byUid,byOrigin,entities}`，
`place.mjs:251` 返回 `{…, gaps, region}`。把 `connect.buildWorld()` 的结果当 ctx 喂 `insert_machine` 会**抛 TypeError**
（`place.mjs:733` 读 `world.gaps.length`，`gaps` undefined），**不是结构化的 `ok:false`**：
```
connect.buildWorld -> insert_machine  THROW Cannot read properties of undefined (reading 'length')
connect.buildWorld -> 其余 5 个宏       ok
place.buildWorld   -> 6 个宏全部         ok
```
**对 loop.mjs 设计的影响**：ctx 统一用 `{entities}`（或 obs 整体），**不要**在模块间传 world 对象；任何一处传错会拿到异常而不是错误码。
- `grep "records" src/agent/macros/*.mjs` → **0 命中**。`grep "ops:"` → 0。只有 `remove/replace` 有 `removes[]`，`place/extend_line` 有 `execution:{needs_tx, method, cells, note}` 提示（`place.mjs:770-777`、`:1162-1170`）。
- 喂 `verifyRuntime`（`normalizePlan`）实测：

| 宏 | `normalizePlan(result)` |
|---|---|
| connect | ✓ `source="connect.cells[]"`，n 格 |
| extend_line | ✓ `source="connect.cells[]"`（走的是 `cells[]` 分支，不是注释写的 `execution.cells[]`） |
| replace_run | ✓ `source="macro{placed,removed}"` |
| insert_machine | ✗ throw「无法识别的 plan 形态」 |
| remove_run | ✗ throw |
| trash_unused | ✗ throw |

（`normalizePlan` 的分支见 `verify_runtime.mjs:168-268`；`insert_machine.cells` 只有 `{x,y}` 没有 `building/kind`，`:250-258` 的条件不成立。）
**对 loop.mjs 设计的影响**：loop 必须自己维护「宏输出 → placements/removes」的适配器，且 ctx 建议统一成 `{entities}`（最保守的公共子集）。

### 5. `lintNoBareCoords` 的判据；region 与 `{uid}` 是否豁免
**结论**：部分成立。它只查**顶层键名**与**顶层坐标容器**；`region` 在 `replace_run` 里**是豁免的**（登记为 endpoint），
`{uid}` **不算坐标**（不触发），但**嵌套的裸坐标不受 lint 保护**。
**证据**：`src/agent/macros/contract.mjs:1829-1866`
```js
for (const k of Object.keys(a)) {
    if (FORBIDDEN_ARG_KEYS.includes(k)) v.push(`参数 '${k}' 是裸坐标/裸旋转，公开 ABI 禁止…`);
}
...
const declared = new Set(spec.params.filter(p => p.coordClass === "endpoint" || p.coordClass === "site")
    .map(p => p.name.split(".")[0]));
for (const [k, val] of Object.entries(a)) {
    if (declared.has(k)) continue;
    if (isCoordContainer(val)) v.push(`参数 '${k}' 是坐标容器，但没有在 MACRO_SPECS…声明 coordClass`);
}
```
`FORBIDDEN_ARG_KEYS = ["x","y","r","rv","rot","rotation","rotationVariant","rotation_variant","originalRotation"]`（`:80-82`）。
实跑：
```
lint replace_run {region:[0,0,1,1], building:"belt"}  -> ok:true（region 已登记 endpoint）
lint connect {from:{uid:1}, to:{uid:2}}                -> ok:true（{uid} 不是坐标容器）
lint connect {from:{x:1,y:2}, to:{uid:2}}              -> ok:true  ← 嵌套裸坐标漏过
   但 validateConnectArgs 会拒（bad_type: from 必须在 uid/cell/hub/pending 中恰好给一个）
lint connect {from:{uid:1}, to:{uid:2}, cells:[[0,0]]} -> ok:false（未声明的坐标容器）
```
**对 loop.mjs 设计的影响**：lint 是"顶层形状"检查，不能当成"LLM 没给坐标"的证明；要么补一层递归扫描，要么在提示层禁用坐标。

### 6. `L0-observation` 在 obs 截断时返回什么；全 skipped 会判绿吗
**结论**：截断时返回**唯一一条** `ok:false, undecidable:true` 并**提前 return**（下面的 L1–L3 一条都不跑）。
判定表达式 `checks.every(c => c.ok || c.skipped)` 在**全 skipped 时确实会判绿**——但 `checkLanding` 永不返回 `skipped`
（`grep skipped` 在 `checkLanding` 正文 0 命中），所以"四条全 skip"不可达。
**真正可达的假绿是「L2 skipped + L3 degraded 绿」**（下表实跑）。
**证据**：`src/agent/verify_runtime.mjs:816-831`
```js
if (obs.truncated) {
    checks.push({ name:"L0-observation", ok:false, undecidable:true,
        reason:`obs 被截断（entity_count=${obs.entity_count}）—— 没看到全部实体，任何落地判据都不可靠`, ... });
    return { ok: false, plan: briefNorm(norm, fromFile), checks };   // 只剩 L0
}
```
判定：`:850` `const ok = checks.every(c => c.ok || c.skipped);`（`checkLanding` 的 return 里没有任何 `skipped`，所以这条表达式永远至少有一个真判据）
实跑反例（证明 L2 skipped + degraded 绿 = 整体绿）：
```
plan = [{kind:"wire"|"constant_producer"|"underground_belt"}]（slotsOf 返回 null）
-> L0 ok / L1 ok / L2 ok(skipped "计划里没有可解析槽位的机器") / L3 ok(degraded)  => overall ok:true
```
（`slotsOf` 对这三类返回 `null`，`checkSlots` 里 `evidence.machines===0` 就走 skip，`:582`。）
纯删除计划（`placements:[]`）反而恒红：因为 `:834` 只有 `norm.placements.length` 才调 `debugItems`，
`items=null` → `:626` L3 报 `undecidable:true, ok:false`。**「removes-only 计划永远无法验证绿」**（实测，`debugItems` 调用 0 次）。
**对 loop.mjs 设计的影响**：`ok:true` 里至少要单独检查 `L2.skipped` 与 `L3.degraded`；按 DIRECTION-FINAL 的 L4（删 3 带 + 放 2 物），
若 loop 分成「先删后放」两轮，第一轮（纯删）会被 verify 判红——这是设计约束，不是 bug。

### 7. 不给 `opts.flows` 时 L3 退化成什么；会不会假绿
**结论**：退化为「计划 bbox 外扩 2 格内的断头路检测」，返回 `ok:true + degraded:true`；**会假绿**（已实证）。
**证据**：`src/agent/verify_runtime.mjs:718-732`
```js
const degradedEvidence = { ...evidence, degraded: true,
    degraded_reason: "未给 opts.flows：仅检查计划 bbox 外扩 " + pad + " 格内的断头路" };
...
return {
    name: "L3-flow", ok: true, degraded: true,
    reason: `未给 flows，只检查了 ${JSON.stringify(evidence.scope)} 范围内的断头路（通过）；连通性本身未验证`,
    evidence: degradedEvidence,
};
```
实证：计划放两格**互不相连**的带子（(0,0) 与 (5,5)），`debug_items` 返回 `pathCount:0, paths:[]`：
```
disconnected belts, 0 paths -> ok: true
L0 ok / L1 ok / L2 ok(skipped) / L3 ok(degraded:true)
```
为什么 "0 条路径" 也不红：`:707-713` 只扫 `paths` 里的断头，`paths` 为空 ⇒ `dead_ends` 为空 ⇒ 绿。

**版本注记**：核查开始时（`06160bb`）这行返回的是**裸 `ok:true`（连 `degraded` 都没有）**，
`07928ad` 才补上 `degraded:true` 自曝——但**判绿本身两版一致**，假绿没有被修掉，只是不再隐形。
**对 loop.mjs 设计的影响**：L3 无 flows 时必须当成「未验证」；且 `flows` 的端点必须是 uid/cell 且**落盘后重读**才拿得到——
这使「验证」必须排在 tx 和 obs 之后，不能与 plan 同轮。

### 8. `checkBehavior`（L4）需要什么；读 production 还是 goal；推进多少 tick
**结论**：需要 `opts.behavior`（`shape` 或 `plan.goal` 二选一，`ticks` 默认 2400，`minPerSec` 默认 0）；
读 `production`（**绝对值**，不是增量）；默认推进 2400 tick = 20 游戏秒 @120Hz。
**证据**：`src/agent/verify_runtime.mjs:738-762`
```js
const b = opts.behavior;
if (!b) return { name:"L4-behavior", ok:true, skipped:true, reason:"未请求行为检查（opts.behavior）", evidence:{} };
const shape = b.shape || (plan.goal || null);
if (!shape) return { name:"L4-behavior", ok:false, reason:"行为检查缺目标形状（opts.behavior.shape）", ... };
const ticks = b.ticks === undefined ? 2400 : b.ticks;      // 20 游戏秒 @120Hz
...
const got = (after.produced_total && after.produced_total[shape]) || 0;
const was = (before.produced_total && before.produced_total[shape]) || 0;
...
if (got <= 0 && was <= 0) return { ..., ok:false, reason:`跑完 ${ticks} tick 后 ${shape} 一件都没产出…` };
```
两个坑：
1. `plan.goal` 这条兜底**实际是死的**：`normalizePlan` 的返回值不含 `goal`（`briefNorm` 只带 `source/from_file/placements/removes/anchor`，`:859-867`；实测 `"goal" in normalizePlan(plan) === false`），
   所以 `checkBehavior(norm, …)` 拿到的是归一化后的对象，必须显式给 `behavior.shape`。
2. 它**只判 `got > 0`（全厂历史累计）**，`produced_delta` 只写进 evidence。实测：一条**没有任何产出**的带子计划 +
   老产线已在交 `CuCuCuCu`（before=99, after=99, delta=0, rate=1.65）→ **L4 绿，整体 `ok:true`**。
   对比 `gates.gateG6` 有 80% 阈值 + 贴前基线归因（`gates.mjs:918-1049`，`mustExceed` 逻辑在 `:1012-1021`）。
**对 loop.mjs 设计的影响**：L4 不能当作「这条线在产」的判据；要么自己算 `produced_delta`，要么复用 G6 的基线口径。

### 9. `verifyRuntime` 的 reader 可注入性；现有测试怎么做的
**结论**：成立，完全可离线。测试用 4 个方法的字面量 reader；另有 `FakeGame` 提供带状态的 reader。
**证据**：`src/agent/verify_runtime.mjs:792-794`（注入点）
```js
export async function verifyRuntime(planOrId, opts = {}) {
    const reader = { ...BRIDGE_READER, ...(opts.reader || {}) };
```
`src/agent/verify_runtime.test.mjs:482-487`（测试夹具）
```js
const mkReader = (o, it, prodBefore, prodAfter, steps) => ({
    async obs() { return o; },
    async debugItems() { return it; },
    async production() { return steps.prodCalls++ === 0 ? prodBefore : prodAfter; },
    async step(t) { steps.ticks += t; return { ok: true, advanced: t }; },
});
// 用法：
const r = await verifyRuntime(PLAN, { reader: mkReader(obs, items, { produced_total: {} }, { produced_total: {} }, steps) });
```
另：`src/agent/fake_game.mjs:107-115` 提供 `FakeGame.reader()`（obs/debugItems/production/step 都有状态，`apply(ops)` 能模拟 tx 效果，
但它**不模拟原子性/回滚**，文件头 `:11-15` 与 `:178-181` 明写）。
**对 loop.mjs 设计的影响**：阶段 2 的多轮迭代可以在 `FakeGame` 上跑通；但 `fake_game.apply` 只认 `delete/place` 两种 op（`fake_game.mjs:183-220`），
与真 tx 的 4 种 op 不完全对齐。

### 10. `tx` 支持哪些子 op、上限、是否原子
**结论**：`place / delete / place_path / bulk_delete` 四种（**不含 `paste_blueprint`**）；上限 **2000** 条；**是原子的**（快照 → 执行 → 任一失败整体回滚）。
**证据**：`src/mod/shapez-ai-bridge.js:2905-2913`
```js
txAllowedOps() {
    //   · paste_blueprint           —— 会扣 hub 的货（takeShapeByKey），扣费不可逆，所以不进事务
    return new Set(["place", "delete", "place_path", "bulk_delete"]);
}
```
上限：`:3258-3260` `if (ops.length > 2000) throw …"tx too large (max 2000 ops)"`；空数组在 `:3255-3257` 单独拒。
原子性：`:3298-3352`（快照 `:3298` → 逐 op → 任一 `hardFail` 即 `mustRollback`（`:3342`）→ `rollbackToSnapshot`（`:3350`））。
另有可逆性预检：`:3286-3296`（不可删建筑如 hub/block/constant_producer 在 `place` 时就拒绝整单）。
**对 loop.mjs 设计的影响**：一次 `connect` 的 22 格 ≤2000 没问题；但「先删 3 带 + 放 2 物」必须**同一个 tx**（跨 tx 无原子保证）。

### 11. `tx` 返回结构；失败是否真回滚
**结论**：字段齐全且失败真回滚；但 **`dry_run:true` 时 `ok` 恒为 `false`**（即使全部 op 本可成功），这是最容易误读的一处。
**证据**：`src/mod/shapez-ai-bridge.js:3386-3400`
```js
const ok = !hardFail && !dryRun;
return { ok, op:"tx", applied, requested: ops.length, rolled_back: !!rollbackReport, dry_run: dryRun,
         aborted, failures,
         diff: finalDiff,     // 最终世界 vs 快照（成功回滚 ⇒ 全空）
         net: mustRollback ? netDuringRun : null,   // 执行期间的净变更（"本来会发生什么"）
         verify, rollback, results, belt, snapshot, boundaries, tick, duration_ms };
```
语义：
- `ok` = 没有硬失败 **且** 不是 dry_run（`:3386`）
- `applied` = 实际成功执行的 op 数（`:3314` 递增），`requested` = 请求数
- `failures[] = {index, op, error:{code, code_name, detail, hint}}`（`:3318-3327`）
- `diff = {added:[uid], removed:[uid], modified:[uid]}`（`diffSnapshots`，`:3015-3034`），是**最终世界**相对快照的差
- `rolled_back` 只是"声称"；证据在 `verify.{uid_set_equal, entities_equal, modified, diffs}`（`:3361-3383`，且只在 `mustRollback && verify!==false` 时非 null）
- `results[i].uid` 按 op 下标给出（`:3402-3407`）—— pending→真 uid 的桥接就靠这个
回滚**确实执行**，但有三条不完美（文件自己也写了 `:2884-2903`）：时间不可回滚（`tick_advance`）、
带子路网/在途货不在实体 schema 里（`belt.items_before/after` 报告丢失量）、`block/constant_producer/hub` 不可删。
**对 loop.mjs 设计的影响**：`tx` 的 `dry_run` 不能当"预演成功"用（`ok:false` 是常态），要读 `applied`/`failures`/`net`。

### 12. `place` 的 rv / originalRotation 支持；`actual` 字段
**结论**：成立。`rotationVariant`/`rv` 与 `originalRotation`/`orig` 是**别名对**；返回 `actual:{rotation, rotationVariant, code}` + `mismatch`。
**证据**：`src/mod/shapez-ai-bridge.js:2576-2582`（别名，两个都给且不一致 → 2001）
```js
const rvRaw = this.pickAlias(a, "rotationVariant", "rv");
const origRaw = this.pickAlias(a, "originalRotation", "orig");
```
`:2624-2629`（返回）
```js
requested: { rotation: rotRequested ? rot : null, rotationVariant: rv },
actual: { rotation: actualRotation, rotationVariant: actualRv, code: actualCode },
mismatch,
```
`placeOne` 在有 rv 覆盖时**不再调** `computeOptimalDirectionAndRotationVariantAtTile`（`:2339-2343`），
但注释承认游戏可能重算：`:2596-2598`（"游戏可能拒绝我们给的 rv，或 belt 系统在 entityAdded 里重算邻居"）。
**对 loop.mjs 设计的影响**：rv 必须显式下发且逐格读回 `actual.rotationVariant/code`；`mismatch:true` 是唯一的一手信号。

### 13. `obs` 参数：region 过滤、`max_entities`、截断标志、`layer:"all"`
**结论**：全部成立，但有两个反直觉点：`max_entities` **默认 2000**（不是 50000），`obs.layer` 返回的是**当前渲染层**而非请求层。
**证据**：`src/mod/shapez-ai-bridge.js:1390-1436`（白名单与默认值）
```js
const known = new Set(["region","max_entities","include_hub","include_resources","include_stats","max_resources","layer"]);
...
let maxEntities = p.max_entities === undefined ? 2000 : p.max_entities;
if (!Number.isInteger(maxEntities) || maxEntities < 1 || maxEntities > 50000) throw …;
maxEntities = Math.min(maxEntities, this.settings.max_entities || 50000);   // 默认 20000（:35）
```
- region 过滤：`:1323-1327`（多格建筑按 AABB 相交，`entityIntersectsRegion`）
- 截断：`:1330-1331` `const truncated = list.length > req.max_entities;`；返回 `{entity_count, truncated}`（`:1344-1346`）。
  注意 `entity_count` 是**过滤后**的数量，全量在 `stats.total`（`:1350`）。
- `layer:"all"` 跳过层过滤（`:1297` `if (layer !== "all" && (e.layer||"regular") !== layer) continue;`），
  但回包里的 `layer` 字段是 `root.currentLayer || "regular"`（`:1341`）——**不是**你请求的 `"all"`。
**对 loop.mjs 设计的影响**：`verifyRuntime` 传的 `max_entities:50000` 会被夹到 20000；超过 2 万实体的存档永远 `truncated:true`（L0 恒红）。

### 14. `production` 返回什么；能否读出"最近 N 秒某形状的产量"
**结论**：成立。片长固定 10 游戏秒，最多 100 片 → 最多 1000 秒窗口；按形状给出 total/per_sec/slices。
**证据**：`src/mod/shapez-ai-bridge.js:602-657`
```js
const wantSlices = Number.isInteger(p.slices) && p.slices > 0 ? Math.min(p.slices, 100) : 6;
const sliceSecs = 10; // config.analyticsSliceDurationSeconds（正式版；dev 为 1）
...
return { window_seconds: windowSecs, slice_seconds: sliceSecs, slices_returned: produced.length,
         produced_total: producedSum, produced_per_sec: toRates(producedSum),
         delivered_total: deliveredSum, delivered_per_sec: toRates(deliveredSum),
         stored_delta: storedDelta, produced_slices: produced, delivered_slices: delivered };
```
`window_seconds = wantSlices * 10`。注意：这是**全厂**按形状汇总，不按区域/产线；且最后一"片"仍在累积（`gates.gateG6` 会剔除它，`:937-938`）。
**对 loop.mjs 设计的影响**：要判「这条线的增量」，必须两次采样取差 + 用 `delivered_slices`/`produced_slices` 剔除未满片；`produced_per_sec` 的窗口是"最近 N 片"，不是"最近 N 秒的滑动窗口"。

### 15. `debug_items` 返回什么；能否读出带子链（path）
**结论**：成立。`region` **必填**；返回逐物品位置 + 最多 40 条 path（含 `entityPath` 展开的 `cells` 与 `boundAcceptor`）。
**证据**：`src/mod/shapez-ai-bridge.js:903-907`
```js
debugItems(params) {
    const root = this.requireRoot();
    const region = params.region;
    if (!Array.isArray(region) || region.length !== 4) throw this.rpcError(2001, "invalid_action", "region must be [x0,y0,x1,y1]");
```
`:997-1003`
```js
out.pathCount = paths.length;
out.truncatedPaths = paths.length > 40;
out.paths = paths.slice(0, 40).map(p => ({ cells: (p.entityPath||[]).map(…), itemsOnPath: (p.items||[]).length,
    spacingToFirstItem: …, boundAcceptor: p.boundAcceptor ? … : null }));
```
另有 `out.belts[]`（逐物品：`{cell, path, idx, pos, spacing_to_next, item}`，`:975-995`）、`out.ejectors[]`、`out.pending[]`、`out.counts`。
**对 loop.mjs 设计的影响**：`pathCount > 40` 是常态（L4 存档 161 条带子 → 多条 path），loop 必须处理 `truncatedPaths`，
否则 L2/L3 会拿到被截断的"看不见"证据（`verify_runtime.mjs:584-590` 判 undecidable（L3 在 `:629-631`））。

### 16. `play.mjs` 有没有可复用的 RPC 客户端
**结论**：有实现，但**没有可复用的导出**（模块内私有，10 个文件各写一份）。
**证据**：`src/agent/play.mjs:24-49`
```js
const BASE = (argVal("--url", process.env.SHAPEZ_BRIDGE_URL || "http://127.0.0.1:7777")).replace(/\/+$/, "");
const TOKEN = argVal("--token", process.env.SHAPEZ_BRIDGE_TOKEN || null);

let rpcId = 1;
async function rpc(method, params = {}) {
    const payload = { jsonrpc: "2.0", id: rpcId++, method, params };
    const res = await fetch(`${BASE}/rpc`, {
        method: "POST",
        headers: Object.assign({ "content-type": "application/json", connection: "close" },
            TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
        body: JSON.stringify(payload), signal: AbortSignal.timeout(180000) });
    const body = await res.json();
    if (body.error) { const err = new Error(body.error.message || "rpc error"); err.rpc = body.error; throw err; }
    return body.result;
}
```
没有 `export`。`grep -c "async function rpc"`：`audit/build-line/expect/gates/grow/look/play/process/round3.verify/verify_runtime` **各 1 份**。
`main()` 支持的模式只有 `observe | action <json> | b1 | plan <file.jsonl>`（`:298-346`），无 `--llm`、无 loop。
**对 loop.mjs 设计的影响**：要么新建 `src/agent/rpc.mjs` 统一客户端（顺带消掉 10 份重复），要么在 loop 内再写一份；前者是明显的收敛点。

### 17. 仓库里是否真的没有 LLM 层
**结论**：成立——`src/` 内**零** Anthropic 相关代码。
**证据**：
```
grep -rni "anthropic|ANTHROPIC_API_KEY|api.anthropic.com|LLMClient" src/   → 0 命中
```
全部命中都在文档里：`research/ai-player/designs/llm-layer-DESIGN.md:367-405`（`LLMClient`/`AnthropicClient`/`MockLLMClient`）、
`research/ai-plan/PHASE2-CONTRACT.md:401`（`apiKey = process.env.ANTHROPIC_API_KEY, model = "claude-sonnet-5"`）。
`src/ai/` 只有 `belt-rules / op-templates / world / compiler`，无 `llm.mjs`（`ls src/ai` 确认）。
**对 loop.mjs 设计的影响**：LLM 层从零开始；`LLMClient` 抽象可以直接沿用 design 文档（接口层面无既有实现可冲突）。

### 18. 有没有已存在的 loop / runner / 迭代器
**结论**：**没有** loop；只有若干一次性脚本 + 一个刚提交的离线假游戏。
**证据**：
- `find . -name "loop*.mjs" -o -name "runner*.mjs"` → 0（除 `research/ai-plan/harness/run-all.mjs`，那是**测试聚合器**，不是 agent loop）
- `grep -rn "while" src/agent src/ai | grep -i "verify\|runtim"` → 0
- `grep -rn "transcript" src/` → 只有 `fake_game.mjs:44` 与 `fake_game.test.mjs:180` 的注释（"loop 的 transcript 可以据此…"），**无实现**
- 现存"迭代"只有脚本级的 `for`：`grow.mjs:210-260`（逐矿机逐步执行，失败即 break）、`process.mjs`、`play.mjs:337-345`（逐行执行 jsonl）
- 新增的 `src/agent/fake_game.mjs`（`07928ad`）提供 `FakeGame.reader()` + `apply(ops)` + `setDelivered()`，是 loop 的离线地基
**对 loop.mjs 设计的影响**：`grow/process/build-line` 的失败即停模式**不是** loop（无重生、无验证、无回滚）；但它们展示了"一步一读回"的骨架，可参考其错误处理。

### 19. `gates.mjs` 与 `verifyRuntime` 的重叠/冲突判据
**结论**：**部分重叠、口径不同、两处真冲突**。gates 以 `intent{goal,anchor,entities,removes}` 为输入并驱动整条写流程；verifyRuntime 以 plan 为输入只读世界。
**证据（重叠对照）**：

| 维度 | gates | verifyRuntime | 关系 |
|---|---|---|---|
| 落地 | `gateG4`（`gates.mjs:560-712`）：after 里**新增实体数 === intent.entities.length** + 逐 origin 比 `code`/`rot` | `checkLanding`（`verify_runtime.mjs:348-441`）：逐 placement 在 obs 找同格/同 uid，比 type/code/rot/rv/inDir/outDir | 重叠但**不对等**：G4 能抓「未声明的静默销毁」（`declaredRemovals` 之外的 uid 消失 → 红，`:594-616`），**verifyRuntime 结构上不可能有这项**：它只取**一次** obs（`:812`），没有 before/after 两份快照，所以「哪个既有 uid 消失了」这个概念在它里面根本不存在（它只核对 plan.removes 里的 uid 还在不在，`:416-419`） |
| 连通 | `gateG6b`（`:1051-1206`）：每条 path 有 `boundAcceptor`；**蓝图里每个带格都必须被某条 path 覆盖**；`beltCells===0` 判红（拒绝真空绿） | `checkFlow`（`:609-733`）：无 flows 只扫 bbox 外扩 2 格内的断头；`placements` 为空则 undecidable 红 | **口径冲突**：同一份「什么都没连」的蓝图，G6b 红（uncovered_cells），L3 无 flows 绿（degraded） |
| 槽位 | 无对应项（G6b 只看带子覆盖） | `checkSlots`（`:443-607`）：机器的输入/输出槽是否有上游/去处（obs 邻接 + path 双证） | verifyRuntime 独有 |
| 流向 | `gateG7flow`（`:1358-1494`）：逐格 `prev/next` 方位 === 声明 `inDir/outDir`；`gateG8chains`（`:1495-1690`）：蓝图推链与游戏 path 逐格同序 | `checkLanding` 只比 `inDir/outDir` 与 `(rv,rot)` 推出的 entry/exit（`:398-412`）；**无链划分检查** | 部分重叠；G8 独有的"链同序"无对应 |
| 行为 | `gateG6`（`:918-1049`）：`delivered_slices` 均值 ≥ 理论值 80%，且要**超过贴前基线 + 半阈值**才归因 | `checkBehavior`（`:738-762`）：只要求 `produced_total[shape] > 0`（全厂累计） | **口径冲突**：产能 5% 的线，G6 红、L4 绿 |
| 删除回放 | `gateGDeleteReplay`（`:714-800`）：声明删除的 uid 必须逐 uid 消失，且不能多删 | 无 | gates 独有 |
| 回滚 | `gateGRollbackRestore`（`:831-916`）：回滚后 uid 集合逐字节相等 | 无 | gates 独有 |
| 输入形态 | `normalizeIntent` **强制** `goal/anchor/entities` 三个字段（`:268-272`） | 认 5 种形态（intent/placed/placements/ops/cells） | **纯删除计划 gates 连加载都过不了**（缺 entities）；verifyRuntime 也验不出绿（见 §6） |

**对 loop.mjs 设计的影响**：两套判据不能混用同一个 `ok`；建议 loop 用 `verifyRuntime` 做「世界事实」，用 gates 的 G4/G-dr/G6 口径**补充**三项 verifyRuntime 没有的能力（未声明销毁/删除回放/产能归因），否则会出现「verify 绿但拆了别人产线」。

### 20. LLM 的 key 管理约定
**结论**：**不存在**任何既有约定（无 `.env`、无 key 配置文件、无 key 相关代码）。只有桥接自己的 token 约定。
**证据**：
- `find . -maxdepth 3 -name ".env*"` → 0；根目录无 `config.*`
- 唯一的 key 名字只出现在**设计文档**：`ANTHROPIC_API_KEY`（`llm-layer-DESIGN.md:386`、`PHASE2-CONTRACT.md:401`）
- 仓库既有的"凭据"约定只有桥接 token：`bridge.config.json`（**不存在**，只有 `bridge.config.example.json`，`token: null`）+ CLI `--token` + `SHAPEZ_BRIDGE_TOKEN`（`src/agent/play.mjs:25`、`src/bridge/bridge.mjs:508-512`）
- `.gitignore` 里**没有** `bridge.config.json` / `.env` 条目（只有 `snapshots/`、`*.bak`、`recon/`、`.claude/` 等）
**对 loop.mjs 设计的影响**：需要一并定义 key 的读取位置与"缺 key 时明确失败"的路径；`.env` 若引入必须进 `.gitignore`（当前会误提交）。

### 21. 测试是否真的全绿；实际通过/失败数
**结论**：**能离线跑的全绿，0 失败**；「963 条」在核查开始时成立（= 工作区 gates 400 版），但核查期间 `07928ad` 让 verify_runtime 从 94→99，**当前实为 968**。另 `gates.test` 有 27 条**未提交**断言（400 vs HEAD 373）。
**证据（逐个实跑，均为 `node <file>`）**：

| 套件 | 通过 | 失败 | 备注 |
|---|---|---|---|
| `src/agent/macros/contract.test.mjs` | 32 | 0 | |
| `src/agent/macros/connect.test.mjs` | 40 | 0 | |
| `src/agent/macros/place.test.mjs` | 54 | 0 | |
| `src/agent/macros/remove.test.mjs` | 68 | 0 | |
| `src/agent/macros/build_line.test.mjs` | 60 | 0 | |
| `src/agent/verify_runtime.test.mjs` | **99** | 0 | 核查开始时跑出 94；核查期间工作区被并发提交（`07928ad`）更新，之后为 99。`HEAD` 版本复跑也是 99 |
| `src/agent/gates.test.mjs`（工作区） | **400** | 0 | `HEAD` 版本为 **373**；工作区多 27 条未提交断言（`git diff` 确认） |
| `src/agent/fake_game.test.mjs` | 28 | 0 | `07928ad` 新增，未计入旧账 |
| `src/agent/clock.mock.test.mjs` | 6 | 0 | |
| `src/ai/belt-rules.test.mjs`（node --test） | 17 | 0 | |
| `research/ai-plan/data/op-templates.test.mjs` | 385 | 0 | |
| `research/ai-plan/data/world.test.mjs` | 51 | 0 | |
| `test/blueprint_selftest.mjs` | 12 | 0 | |
| `test/lzstring_interop.mjs` | OK（3 组对拍） | 0 | |
| `test/mod_rpc_selftest.mjs` | 12 | 0 | |
| `test/mod_selftest.mjs` | 87 | 0 | 用 vm + stub，**不连游戏** |
| `src/bridge/selftest.mjs` | 19 | 0 | |
| `src/mcp/selftest.mjs` | 97 | 0 | |
| `src/agent/macros/connect.mjs --self-test` | 210 | 0 | |

关于「963」：**这个数字核查开始时是对的**，构成如下（全部实跑）：
`宏 5 套 32+40+54+68+60 = 254` + `mod_selftest 87 + mod_rpc 12 + bridge 19 + mcp 97 = 215`（小计 469）
+ `verify_runtime 94` + `gates 400`（工作区版本）= **963**。
（`06160bb` 的 `gates.test` 只有 373；工作区那 27 条增量是会前提就已存在的未提交改动。我核对了 `06160bb` 版本的
`verify_runtime.test` = 94、`gates.test` = 373，与工作区分别不同。）
**但核查期间它漂了**：`07928ad` 给 `verify_runtime.test` 加了 5 条（94→99），**当前总数是 968，不是 963**。
口径注意：963 **不含** `belt-rules 17`、`op-templates 385`、`world 51`、`blueprint 12`、`lzstring`、`fake_game 28`、`clock.mock 6`。
另外 `research/ai-plan/harness/run-all.mjs` 一条命令跑 13 组、共 ≈2304 条断言，全绿（含 P1–P8 各包），
这是目前最可辩护的"全绿"陈述。
**对 loop.mjs 设计的影响**：引用 963 时必须写明它排除哪些套件，且当前实际为 968；另注意 `gates.test` 的 400 里有 27 条尚未提交 —— 若以 `HEAD` 建分支会看到 373。

---

## 附：以下三条是我实跑证明的「会咬人」的行为，建议直接写进 loop 的验收夹具

1. **死计划也能全绿**（§7 的脚本）：两格互不相连、什么都没接的带子，`verifyRuntime` 就返回 `ok:true`（L2 skipped + L3 degraded；连 L4 都不需要）。若再造一份「老产线已在交」的 production，L4 也会跟着绿（§8）。
2. **纯删除计划永远验不绿**：`placements:[]` ⇒ `debugItems` 不调用 ⇒ L3 `undecidable` 红（§6）。L4 的正确解是"先删 3 带"，所以 loop 的多轮结构是**被迫的**，不是偏好。
3. **6 个宏里 3 个的输出进不了 verifyRuntime**（§4），且 `connect` 不吃 `pending`（§2）——「宏自由组合」这条设计假设只在一个角上成立。
