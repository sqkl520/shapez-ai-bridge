# upgrade 宏 —— 实现方案

> 输入：`UPGRADE-MACRO-FEASIBILITY.md`（侦察报告，下称「侦察」）。
> 本文只回答一个问题：**能不能不改 `planToTxOps`，用一个平行的执行通道把升级接进 loop？**
> 结论：**能，而且应该这么做。** 推荐「runLoop 前置分流」（§2 方案 C）。
> 但侦察报告 §5 / §8 说的那件事没变：**「零实体变更的一轮」是这活真正的工作量**，
> 通道只是入口，不是难点。

---

## 0. 结论速览

| 问题 | 答案 | 证据 |
|---|---|---|
| `planToTxOps` 之前有「非 place/delete 类宏」的分支点吗？ | **没有**。`buildTxPlan` 对 `res.calls` 一视同仁地逐条执行，唯一的宏分类知识在 `planToTxOps` 内部 | `loop.mjs:1188-1248`（无分支）、`planToTxOps.mjs:45-46`（唯一的分类表）、`loop.mjs:1192`（只查名字白名单，不查宏类别） |
| 最小侵入的分流点在哪？ | `loop.mjs:1816`（parse 成功）与 `:1819`（`buildTxPlan`）之间。**在 runLoop 里先按宏类别拆分 calls**，`planToTxOps` 一个字不改 | §2.3 |
| 要改 `planToTxOps` 吗？ | **不要**。而且应该**加一条测试锁住「它继续拒绝 upgrade」**——那是分流写错时唯一的报警器 | §2.5 |
| 一轮只有 upgrade、`ops` 为 0，怎么不判假绿？ | 三个「不许」：不许走 `applyVerdict`、不许走 `strictVerdict`、**不许走 `phaseTwoVerdict`** | §2.6（含 4 张红牌） |
| 升级扣掉的库存能退回吗？ | **不能**，三条独立证据 | §2.7 |
| 最大的坑（侦察报告没提） | **升级会消耗目标形状本身**：`processors T2` 需要 `RuRu----×600`，而 L4 的目标形状就是 `RuRu----`；`goal.delivered = storedShapes[goalShape]`。买它 = **把关卡进度打回去** | §3.2 |
| 五处硬编码 `=== 6` | 1 处保留字面量（但要改形态），4 处派生 | §4 |
| `RETRIEVAL_TABLE` 挤出效应 | **不要在表里加 `upgrade`**。改在候选注入点追加，且放在上限之后 ⇒ 无升级可买时**逐字节无影响** | §5 |
| 总耗时 | **6–8 h**（含测试）；保守变体 5–6 h（但模型不能「只升级」） | §8 |

---

## 1. 先核对侦察报告的几条前提

### 1.1 成立的部分（我独立复验过）

| 侦察的结论 | 我的复验 |
|---|---|
| `planToTxOps` 拒绝 `upgrade`（R4） | 成立：`planToTxOps.mjs:612-613`；`PLACE_MACROS`/`REMOVE_MACROS` 在 `:45-46` |
| 即便塞进 Set 也会在 `collectPlaces` 炸 | 成立：`:223` 的兜底 `不认识宏 "…" 的返回形状` |
| `doApply` 支持 `ctx.apply` 注入、且在 `planToTxOps` **之后**才被调用 | 成立：`loop.mjs:1377-1388`（注入）、`:1924`（调用点）、`:1265`（`planToTxOps` 调用点在它之前 660 行） |
| 4 道「零变更 = 失败」防线 | 成立：`loop.mjs:1279-1285`、`verify_runtime.mjs:463-464`、`verify.mjs:137`、`offline_boundary.mjs:85-125` |
| 白名单三处自动派生 | 成立：`llm.mjs:49`、`prompt.mjs:116`、`coords.mjs:422` |
| `--read-only` 绕过 `upgrade` | 成立：`bridge.mjs:309` 的 `WRITE_METHODS` 不含 `"upgrade"`；mod `upgrades()`（`shapez-ai-bridge.js:1048-1105`）内确实没有 `assertWritable`（对比 `:1167` 的定义与 `:2456` 等调用点） |
| 升级是**全局**的、每条线独立、不是每台机器 | 成立：`hub_goals.js:23`（`upgradeLevels` 是 savegame 字段）、`:171-181`、`rules.mjs:77-92` |
| 倍率**累加**不累乘 | 成立：`hub_goals.js:57-62`、`rules.mjs:151` |
| `already-maxed` 走 `ok:true` + `bought:false` | 成立：`shapez-ai-bridge.js:1079-1081` |

### 1.2 三处要修正 / 补强的

**(a) 侦察 §4.4 的「5 处硬编码 6」是对的，任务书里只列了 4 处 —— 漏了 `contract.test.mjs:384`。**
五处全在（我 grep 过 `MACRO_NAMES.length` / `WHITELIST.length`）：

```
src/agent/macros/contract.mjs:2255          t("宏名齐全", MACRO_NAMES.length === 6)
src/agent/macros/contract.test.mjs:384      eq(MACRO_NAMES.length, 6)
src/agent/loop/llm.test.mjs:65              eq(LLM_MACRO_WHITELIST.length, 6, ...)
src/agent/loop/prompt.test.mjs:136          eq(MACRO_WHITELIST.length, 6, ...)
src/agent/loop_pipeline.test.mjs:227        ok(MACRO_NAMES.length === 6, ...)
```

**(b) 侦察 §4.1 建议给 `upgrade` 加 `expect_tier` 参数 —— 不要加。**
tier 是**从 obs 派生的**（`obs.goal.upgrade_levels[line]` + 1）。让模型传 tier 就是在世界之外开第二份真值：obs 一过期，模型按旧 tier 下单，宏要么照单执行（买错），要么拒单（白花一轮）。参数只留 `line`。

**(c) 侦察漏了一条会直接毁掉 A/B 结论的事实：升级会消耗目标形状。**
见 §3.2。这不是锦上添花的安全检查 —— 它是「买升级」和「推进关卡」在同一份库存上的**资源冲突**，必须先挡住。

---

## 2. 执行通道（核心）

### 2.1 现状：确实没有分支点

`buildTxPlan`（`loop.mjs:1170-1340`）的流程是：

```
② resolveRefs                                   :1178
③ for (res.calls) { validateMacroCall → 真宏 }  :1188-1248   ← 对每条 call 一视同仁
④ planToTxOps(executed, …)                      :1265       ← 唯一的宏分类在它内部
   ├─ !txPlan.ok            ⇒ reject            :1266-1278
   ├─ !txPlan.ops.length    ⇒ reject            :1279-1285
   └─ ops > TX_OPS_MAX      ⇒ reject            :1286-1292
⑤ attachProvenance / assertProvenance           :1299-1317
⑤b verifyMacroTokenCoords                       :1320-1330
```

`③` 里唯一的「分类」是 `:1192` 的 `MACRO_NAMES.includes(c.macro)` —— 那是**名字**白名单，不是宏**类别**。所以：

- 没有「这是 place/delete 类宏 / 这不是」的判断；
- `upgrade` 会一路走到 `④` 被 R4 拒（`planToTxOps.mjs:612`）；
- 拒了以后 `buildTxPlan` 返回 `{ok:false}`，`runLoop` 在 `:1820` 直接 break 回外层。

顺带记一笔：`buildTxPlan` 里有三处**硬编码的候选宏列表**（`:750`、`:1234`、`:1276`），它们不会自动带上 `upgrade`。这不是 bug（那三条是错误提示，不是检索表），但如果你想让 `MACRO_REFUSED` 的候选里出现 `upgrade`，得手工加 —— **建议不加**：一个 `MACRO_REFUSED` 的正确修复动作几乎不会是买升级。

### 2.2 三个候选方案

#### 方案 A：`buildTxPlan` 内部分流

在 `loop.mjs:1188` 之前把 `res.calls` 拆成 `txCalls` / `hubCalls`（按新建的 `HUB_MACROS`），`planToTxOps` 只拿 `txCalls`，`hubCalls` 单独走一遍 validate+宏，结果挂在新字段 `plan.hubOps` 上；`:1279` 的空 ops 拒绝改成 `if (!ops.length && !hubOps.length)`。

- 改动行：`loop.mjs:1188` 前后 + `:1265` + `:1279` + `:1332`（返回值）。5 处，全在一个函数里。
- **对 6 个宏的影响**：`hubCalls` 为空时 `txCalls === res.calls`，`:1188-1248` 的循环体不变 ⇒ 零影响。可证。
- 缺点：`buildTxPlan` 是**被外部测试直接调用的公共函数**（`connect_provenance.test.mjs:114/124/139`、`loop.test.mjs:599/605`），它的返回值形状一变，这些调用方都要重新审一遍「返回里多了个 hubOps 会不会被人误读成 op」。而且 `buildTxPlan` 的文档头（`:1167-1169`）明写「任一步红 ⇒ 零写入」，往它身上加一条「非零写入」的返回值，语义开始打结。

#### 方案 B（保守变体）：不许「只升级」，同轮必须另有一个真改世界的宏

- 实现：`planToTxOps` 之后，若 `ops.length === 0 && hubOps.length > 0` ⇒ `reject("PLAN_REJECTED", "hub_only_round", …)`，候选里给 `insert_machine` / `replace_run`。
- 改动最小（≈ 15 行），4 道防线**一道都不用动**（因为每轮都真的改了世界）。
- 代价：模型想「只升个级」做不到，而 CAPACITY 段建议的动作恰恰是「只升个级」（`prompt.mjs:1390`）。这等于把 prompt 里的建议和执行的可行性重新焊死 —— 正是当前 `canBuyUpgrade = false` 想解决的那个病，只是换了个位置。
- **只在「时间不够 / 只要打通通道」时用。** 我会把它作为 §8 的降级选项。

#### 方案 C（推荐）：`runLoop` 前置分流，`planToTxOps` 与 `buildTxPlan` 都不动

分流点在 `runLoop` 的 ③+④ 之后、`buildTxPlan` 之前（`loop.mjs:1816-1819` 之间），也就是**离 planToTxOps 最远、离 runLoop 最近**的位置：

```js
/* loop.mjs:1818 之前插入 */
const split = splitHubCalls(parsed.plan);       // 新函数，见下
/* split = { txPlan: llmPlan, hubCalls: [...] } —— txPlan 就是**原对象**，不是拷贝 */

let p = null;
if (split.txPlan) {
    p = buildTxPlan(split.txPlan, ob.obs, ob.items, st.handles);
    if (!p.ok) { …原样… break; }                 // :1820-1846 完全不动
}
const h = split.hubCalls.length ? buildHubPlan(split.hubCalls, ob.obs, st.handles) : null;
if (h && !h.ok) { …同 p.ok === false 的处理（写 plan 行 + settleFailure）… }
if (!p && !h) { /* 不可能：llmPlan.calls 非空 ⇒ 至少一边非空 */ }
planned = { ...(p || { txPlan: EMPTY_TXPLAN }), hubPlan: h };
```

`splitHubCalls(llmPlan)` 的契约（三条，可单测）：

```js
// HUB_MACROS 是这次唯一新增的「宏类别」真值，放在 contract.mjs（宏 ABI 的名字真值所在）
export function splitHubCalls(llmPlan) {
    const calls = (llmPlan && Array.isArray(llmPlan.calls)) ? llmPlan.calls : [];
    const hub = calls.filter(c => c && HUB_MACROS.has(c.macro));
    if (!hub.length) return { txPlan: llmPlan, hubCalls: [] };       // ① 无 hub 调用 ⇒ 原对象原样返回
    const rest = calls.filter(c => !(c && HUB_MACROS.has(c.macro)));
    return {
        txPlan: rest.length ? { ...llmPlan, calls: rest } : null,     // ② 没剩 ⇒ null，不进 buildTxPlan
        hubCalls: hub,
    };
}
```

三条契约：

1. **没有 hub 调用时返回输入对象本身**（不是拷贝）⇒ 下游 `buildTxPlan` 收到的引用与今天一致，`assertNoHumanCoords` 的探针（`loop.test.mjs` 里对 `calls[0].args.at` 的路径断言）逐字不变。
2. **全是 hub 调用时 `txPlan` 为 `null`** ⇒ 完全不进 `buildTxPlan`，于是 `loop.mjs:1279` 的空 ops 拒绝**根本不会被触发**。这是方案 C 相对 A 的关键好处：不需要放松那道防线，只需要**不走到它**。放行「空计划」和「绕开空计划」在代码里是两件完全不同的事。
3. `hubCalls` 里任一条 `macro ∉ MACRO_NAMES` 时，`splitHubCalls` 不负责报错 —— 交给 `buildHubPlan`（它跑 `validateMacroCall`，与 `:1199` 同一条路径），错误码沿用 `LLM_UNKNOWN_MACRO` / `LLM_ARGS`。

`buildHubPlan(hubCalls, obs, handles)` 是 `buildTxPlan` 的**瘦身镜像**（新函数，约 60 行，写在 `loop.mjs` 的 `planToTxOps` 段旁边）：

```
① assertNoHumanCoords({calls: hubCalls}, handles)   // 与 :1174 同源（resolveRefs 内部会再跑一遍）
② resolveRefs({calls: hubCalls}, handles, obs)      // :1178 复用
③ 逐条 validateMacroCall → MACRO_FNS[macro](args, ctx)
   ctx 必须是 { entities, obs, goal, stored, upgrades } —— 见下
④ 拒绝 >1 条 hub 调用（"one irreversible action per round"）
⑤ 返回 { ok:true, hubOps:[{macro,args,result,provenance}], warnings }
```

**`ctx` 的关键缺口**：`buildTxPlan` 传给宏的 ctx 是 `{ entities: o.entities }`（`loop.mjs:1218`），**没有 goal / hub 库存**。升级宏必须知道「现在几档、有多少库存」，所以要么：

- 把 `:1218` 的 ctx 扩成 `{ entities, obs: o, goal: o.goal, hub: o.hub }`（对现有 6 个宏是**纯增量**：`worldFor` 只读 `ctx.entities`/`ctx.obs`/`ctx.region`，`place.mjs:258-275`、`remove.mjs:110-136`、`connect.mjs:165-174` 我逐个看过，没有任何一个读 `ctx.goal`/`ctx.hub`）—— **推荐这个**；
- 或者只在 `buildHubPlan` 里构造富 ctx，`buildTxPlan` 不动。

我推荐后者（**只在 `buildHubPlan` 里给富 ctx**）：改动面更小，而且「place 类宏拿不到库存」这件事本身是对的（它们不该看库存）。

### 2.3 为什么推荐 C 而不是 A

| 判据 | A（buildTxPlan 内分流） | C（runLoop 前置分流） |
|---|---|---|
| 改 `planToTxOps` | 否 | 否 |
| 改 `buildTxPlan` 的返回值形状 | **是**（多一个 `hubOps`） | 否（`planned` 是新对象，`p` 本身不变） |
| 要放松 `loop.mjs:1279` 空 ops 拒绝 | **是** | **否**（走不到） |
| 外部测试受影响 | `connect_provenance.test.mjs` 3 处、`loop.test.mjs` 2 处调用 `buildTxPlan` 的返回被重新审视 | 0（`buildTxPlan` 签名/返回/语义全不变） |
| 分流逻辑可单测 | 难（混在 1100 行函数里） | 易（`splitHubCalls` 是纯函数，3 条契约 3 条断言） |
| 风险 | 「多了一个可以不产生 op 的返回字段」⇒ 后来者容易顺手把它也当 op 送进 tx | 分流是一个**显式分叉**，两条路各有自己的 apply/verify |

`loop.mjs` 自己的注释（`:1164-1165`）写着「**任一步红 ⇒ 零写入**（本函数从头到尾不碰世界；宏都是 dry-run 规划器）」。方案 A 会让这句话变成「除了 hub 那一支」，方案 C 不会。这就是我选 C 的原因。

### 2.4 绝对要保留的一条：`planToTxOps` 继续拒绝 `upgrade`

`planToTxOps.mjs:42-44` 的注释是这次设计的护栏：

> 6 个宏的白名单（与 contract.mjs 的 MACRO_NAMES 同源，但本文件不 import 那份表：
> 这里要的是「翻译器认识哪几种返回形状」，不是「ABI 里有哪些宏」—— **两者会分叉，分叉时必须显式报错**

方案 C 让这个分叉**永久存在且是故意的**。所以：

**新增一条测试**（`planToTxOps.test.mjs` 末尾）：

```js
{
    const r = planToTxOps([{ macro: "upgrade", args: { line: "processors" },
                             result: { ok:true, cells_planned:0, cells_placed:0, first_mismatch:null } }], { obs: {} });
    eq(r.ok, false);
    eq(r.error.rule, "R4");
    eq(r.error.kind, "unknown_macro");
}
```

这条断言的价值不在「骂 upgrade」，在于：**如果哪天有人给 `PLACE_MACROS` 加了 `upgrade`，它会立刻红**，而那正是「upgrade 混进了 tx 通道」的判据。侦察 §4.2 已经实测过 planToTxOps 会拒，但**没有把这件事钉成测试** —— 这是必须补的。

### 2.5 零影响证明（对现有 6 个宏）

逐条列，每条都是可写成测试的断言：

| # | 断言 | 怎么验 |
|---|---|---|
| 1 | `splitHubCalls` 在无 hub 调用时返回**输入对象本身**（`===`） | `ok(splitHubCalls(plan).txPlan === plan)` |
| 2 | `planToTxOps` 的源码零改动 ⇒ 6 个宏的 op 翻译不变 | `git diff --stat src/agent/loop/planToTxOps.mjs` 为空 |
| 3 | `applyVerdict` 源码零改动 | `git diff` 空 + `verify.test.mjs` 75 条不变 |
| 4 | `strictVerdict` 源码零改动 | 同上 |
| 5 | `verifyRound` 源码零改动（hub 轮不调它；混轮传 tx 子计划，与今天传全计划逐字相同） | `git diff` 空 |
| 6 | `RETRIEVAL_TABLE` 零改动 | `git diff` 空 + `constants.test.mjs` 42 条不变 |
| 7 | prompt 在「无升级可买」时逐字节等于今天 | 见 §6.4 的 hashing 断言 |
| 8 | 混轮时 tx 部分与今天的 op 序列逐条相等 | 在混轮测试里断言 `wireOps` 深等于「只喂 tx 调用」的结果 |

### 2.6 「零实体变更的一轮」怎么处理（本次最危险的地方）

先把事实钉死：一轮只有 upgrade 时，

- `txPlan.ops.length === 0`
- `txPlan.placements.length === 0`
- `txPlan.removes.length === 0`
- 世界里的实体 uid 集合**前后完全一样**（`worldUidSetHash` 不变）
- **但 hub 的 `stored_shapes` 变了、`goal.upgrade_levels` 变了**

所以它**不是**「什么都没发生」。这是本轮唯一需要的语义区分，而它必须落在**代码结构**上，不能落在注释上。

#### 新增一个判据函数（不进 `applyVerdict`）

`src/agent/loop/verify.mjs` 里加（纯函数，与 `applyVerdict` 并列）：

```js
/**
 * 一次 hub 写（升级）是否算「干净落盘」。
 * 四条**可证伪**判据，全部来自 mod 的返回值（shapez-ai-bridge.js:1096-1104）：
 *   ① ok === true
 *   ② bought === true            ← already-maxed 也返回 ok:true（:1079-1081），只读 ok 会把满级记成买成功
 *   ③ after.level === before.level + 1
 *   ④ stored 的每个需求形状恰好减少 spent 里的 amount（对账，防「买了但没扣」/「扣了没买」）
 * @returns {{ok:boolean, hardStop:boolean, why:string[]}}
 */
export function hubApplyVerdict(res, { line, expectLevel } = {}) { … }
```

`hardStop` 只在「结果形状不对（缺 before/after/stored）」时为 true（那是 mod 或桥的实现 bug，重试无意义）；`bought:false` / level 没涨 / 对账不平都是 `ok:false` 但 `hardStop:false`（可以下一轮重试或换动作）。

#### 三条不许

| 不许 | 为什么 |
|---|---|
| **不许调 `applyVerdict`** | 它的 ④（`verify.mjs:135-139`）是「`diff.added`/`diff.removed` 全空 ⇒ `NO_WORLD_CHANGE`」。给它一个伪造的 `tx = {ok:true, applied:0, requested:0, diff:{added:[],removed:[]}}` 会**恒红**；而为了让 hub 轮变绿去放松那条判据，就是在拆 4 道防线里最便宜也最救命的一道。这条路**两头都是坑**，所以不要走。 |
| **不许调 `strictVerdict`** | 它第 2 条（`verify.mjs:280-283`）要求 `L1-landing` 绿，而 L1 在 `placements`/`removes` 全空时**明确判红**「真空绿」（`verify_runtime.mjs:463-464`）。同理第 4 条要求 `flowsProvided`。hub 轮天然没有这些。 |
| **不许进 `phaseTwoVerdict`** ★★★ | 见下面的红牌 ①。 |

#### ★ 四张红牌（这四种写法都会让「什么都没变」被判成成功）★

**红牌 ①：让 hub 轮走到 `phaseTwoVerdict`。**
`phaseTwoVerdict`（`offline_boundary.mjs:85-125`）的判据是 `strictOk && cls.ok && !anyTrustedFail`。如果你给 hub 轮传 `strict: {ok:true}` 且 `checks: []`，那么 `classifyChecks({checks:[]})` 返回 `ok:true`（没有不可信项），`anyTrustedFail` 为 false ⇒ **在 `mode !== "live"` 下直接 `level = "offline-only"`**（`offline_boundary.mjs` 里那句 `else if (!live)`）。也就是说：**一次纯升级在 mock 模式下会被记成「离线全绿」**，而这正是 `loop.mjs:2052-2060` 那条 `OFFLINE_ONLY` halt 的落点，transcript 里看起来像「决策链走通了」。
**⇒ hub 轮必须在 `:2009` 之前就分流出去，根本不构造 `phaseTwoVerdict` 的入参。** hub 轮的结论只有一个：`{hub_ok: true|false}`，`level` 保持上一轮的值（初值 `"none"`）。

**红牌 ②：把「`ops` 为空但 hub 有结果」写成 `av.ok === true`。**
即伪造一个空 tx 走 `applyVerdict` 然后手工置 `av.ok = true`。这等同于把 `NO_WORLD_CHANGE` 那道判据改成「有 hub 结果就放行」。将来任何一条别的路径只要能让 `hubOps` 非空（哪怕它没买成），都能拿到绿。

**红牌 ③：用 `hub.bought` 之外的任何字段判成功。**
`ok: true` 但 `bought: false`（满级）是**真实返回**（`shapez-ai-bridge.js:1079-1081`）。判据里只要少了 `bought === true`，「已经是最高档」会被记成「买成功」，而且下一轮模型还会想买（因为 obs 里 `can_buy` 是 false 但 `maxed` 是 true，如果 prompt 没把 maxed 说清楚）。

**红牌 ④：把 hub 轮算进 `st.worldTouched`。**
`preserved.world_state` 是从 `worldTouched`/`lastApplyRolledBack` 推出来的（`loop.mjs:2095`、`:2151`），而 `loop.test.mjs:251` 断言 tx 成功时它是 `"applied"`。如果 hub 轮也置 `worldTouched`，那么「只升级」和「真改了世界」在 `preserved` 里长得一样，而 `preserved.world_state` 是验收脚本读的那个字段。
**⇒ 新增 `st.hubTouched`，`world_state` 加第四个值 `"hub_only"`**（现有关闭集是 `untouched|applied|rolled_back`；无任何代码枚举它 —— 我 grep 过，只有 `loop.test.mjs:251` 断言了 tx 路径的 `"applied"`）。同时 `preserved` 里加 `hub_state: "untouched"|"upgraded"|"failed"`。

#### `runLoop` ⑤ 段的具体形状（改动清单）

在 `loop.mjs:1908` 的 `⑤ apply` 段里，改成两段式（**先 tx 后 hub**，理由见 §2.7）：

```
⑤a  tx 部分（原样，仅在 planned.txPlan.ops.length > 0 时执行）
      :1909-1974 全部不动
⑤b  hub 部分（新增，仅在 planned.hubPlan 存在时执行）
      - 若 ⑤a 失败/回滚/`!av.ok` ⇒ **跳过 ⑤b**，并记 hub:{skipped:"tx_failed"}
      - reader.upgrade 调用（见 §2.8）
      - hubApplyVerdict
      - 写 transcript apply 行：{ kind:"apply", hub:{ line, bought, before_tier, after_tier, spent, why } }
      - 成功 ⇒ st.hubTouched = true；失败 ⇒ 诊断 + settleFailure + continue（不 halt：
        升级买不起/满级是可换动作的失败，不是硬停）
⑥  verify
      - 纯 hub 轮（txPlan.ops 为空）⇒ **不调 verifyRound**，改为：
          · 重新 obs（:2000 那段可以保留，它只读）
          · 写 verify 行：{ checks:[{name:"X-upgrade", …}], level: <上一轮的>, achieved:false }
          · 然后走 :2064 的 repair 决策（做完一轮该有的记账）
      - 混轮 ⇒ 原样调 verifyRound（传 tx 子计划），额外把 X-upgrade 的结果 push 进 checks
```

关于 `X-upgrade` 这个 check 名：它在 `classifyChecks` 里**必须被判为离线不可信**：

```js
// offline_boundary.mjs:37-41 的 OFFLINE_UNVERIFIABLE 加一条
"X-upgrade": "hub.stored_shapes / upgrade_levels 的变更在 FakeGame 里是伪造的；真实扣费与存档语义只能实机验",
```

不加这一条的后果：离线跑出一个绿的 `X-upgrade`，`classifyChecks` 把它算进 `trustworthy`，于是 `phaseTwoVerdict` 在 mock 模式下拿到一个「可信的绿」——再加一条红牌 ① 就凑齐了假绿。

### 2.7 失败怎么回滚（含「库存能不能退」）

**结论：升级不可回滚。** 三条独立证据，缺一条都不够，三条一起才说明「没有补救路径」：

1. **游戏侧没有逆操作。** `hub_goals.js:332-364` 的 `tryUnlockUpgrade` 只做三件事：`storedShapes[shape] -= amount`、`upgradeLevels[id] += 1`、`upgradeImprovements[id] += tierData.improvement`，然后 `upgradePurchased` 广播（`:359`，唯一订阅方是 HUD：`hud/parts/shop.js:208` 等）。**没有任何 `sellUpgrade` / 逆向扣减。**
2. **它进存档，且存档字段会被重算。** `upgradeLevels` 是 `getSchema()` 里的字段（`hub_goals.js:23`），`upgradeImprovements` 在 `deserialize` 里**从 upgradeLevels 重算**（`:53-62`）。所以在内存里手改 `upgradeImprovements` 也没用；而 `storedShapes` 同样是 savegame 字段（`:22`）。一旦游戏自动存档，内存回滚就彻底失效。
3. **tx 的原子性覆盖不到它。** `snapshotWorld` 只拍实体（`shapez-ai-bridge.js:2916`，`entities: Map<uid,payload>`），`txAllowedOps()`（`:2905-2913`）把 op 白名单锁死成 `place|delete|place_path|bulk_delete`，`opTx` 在 `:3256` 还要求「至少一条 op」。所以「把 upgrade 塞进 tx 让 tx 帮我回滚」是**结构性不可行**，不是「多写点代码」。

**能做的三件事（按性价比排）：**

| # | 做法 | 收益 | 成本 |
|---|---|---|---|
| 1 | **顺序：tx 先、hub 后。** tx 失败/回滚 ⇒ 根本不发 upgrade | 消除「升级买了、世界却没改」这一整类半成品 | 0（顺序而已） |
| 2 | **一轮最多一条 hub op**（`buildHubPlan` ④ 里断言） | 「这一轮花了什么」永远只有一个答案；transcript 可人工对账 | 0 |
| 3 | **买之前的 dry-run 探针**（`upgrade{id, dry_run:true}`，`shapez-ai-bridge.js:1091-1093`） | 只能在「规划期」用：把「会不会买得起」从「猜」变成「问」。**注意：dry_run 不省任何风险**（读与写之间库存会变），所以它**不能**替代 `hubApplyVerdict` | 低，但会多一次 RPC |

**明确写出来：不要再说「loop 会自动回滚」。** `loop.mjs:40` 的文件头已经写了「不自动回滚」，本文要补的是它的**推论**：既然升级不可回滚，那么「先做不可逆的事、再做可逆的事」这个顺序就是**必须**的，不是优化项。

### 2.8 桥与 reader 的接线（3 行）

```js
// loop.mjs:2272-2278 makeBridgeReader 里加一行
async upgrade(p) { return call("upgrade", p); },
```

`verify_runtime.mjs` 的 `BRIDGE_READER`（`:83-88` 附近）**不动** —— 它是验证器的读面，不该有写能力。

`doApply` 旁边加一个同形状的：

```js
async function doHubApply(ctx, hubOps) {   // 与 doApply（:1377-1388）同构，注入顺序也一样
    try {
        if (typeof ctx.hubApply === "function") return { r: await ctx.hubApply(hubOps, ctx) };
        if (ctx.reader && typeof ctx.reader.upgrade === "function") return { r: await ctx.reader.upgrade(hubOps[0].args) };
        if (ctx.game && typeof ctx.game.upgrade === "function") return { r: ctx.game.upgrade(hubOps[0].args), fake: true };
        return { r: null, error: "没有可用的 hub 写面" };
    } catch (e) {
        // 2002 cannot afford / 2001 unknown id / 1003 无世界 —— **全部**要转成结构化结果，
        // 不许让一次「买不起」把整个 run 变成 error。
        return { r: null, error: `upgrade 抛异常：${e && e.message ? e.message : e}`, rpc: e && e.rpc ? e.rpc : null };
    }
}
```

`LoopOpts` 加 `hubApply`（与 `apply` 并列，测试注入用，`loop.mjs:1394-1408` 的 JSDoc 同步加）。

### 2.9 预算记账

`st.txCount++`（`:1910`）**也应该为 hub op 计数**，但另记 `st.hubCount`：

- 理由：`BUDGET.TX_MAX = 6`（`constants.mjs:151`）语义是「一 run 最多几次**写**」。升级是写。不计数 ⇒ 模型可以在一轮里反复升级（最多 3 轮 × 若干条）。
- 但 transcript 与验收要能分清「6 次 tx」和「6 次 upgrade」⇒ `run_end` 加 `hub_count`。
- `constants.test.mjs:142` 断言 `TX_MAX === 6`，不改值。

### 2.10 一个必须知道的副作用：升级不改变失败指纹

我实跑验过：

```
diagnose(L4-obs) 与 diagnose(同 obs + upgrade_levels 调高 + stored 增加) → 逐字节相同
fingerprintOf 两者 → 相同
```

原因：`diagnose`（`loop.mjs:561`）只读 `obs.goal.requirement` 的 `required/delivered`、实体、拓扑、配方；**不读 `hub.stored_shapes` 也不读 `goal.upgrade_levels`**（我 grep 过：`semantic.mjs` / `structural.mjs` / `topology.mjs` 里都没有 `stored`/`upgrade`）。

后果：**一轮成功升级以后，下一轮的世界指纹不变**。于是：

- 第 2 轮 `countFingerprint`（`:1524-1562`）会看到同一个 fp 的第 2 次 ⇒ `mustChange = true` ⇒ 候选里剔掉 `upgrade`（`:1543`）+ 模型被要求换动作；
- 第 3 轮 ⇒ `NO_PROGRESS_3X` halt。

这个行为**恰好是我们想要的**（一次升级之后不该一直升级），但它必须写进文档、钉成测试，否则下一个人会以为是 bug 去「修」它。
**不要为此改 `fingerprintOf` 的输入** —— 那会改变全部历史指纹的语义，是个跨模块的破坏性改动。

---

## 3. `upgrade` 宏本身

### 3.1 契约条目（`contract.mjs`）

```js
// HUB_MACROS：本次唯一新增的「宏类别」真值。放在 contract.mjs，
// 因为「哪些宏不产生实体 op」是 ABI 的性质，不是 loop 的实现细节。
// loop.mjs 的分流、prompt.mjs 的 canBuyUpgrade 闸门、测试全部派生自它 —— 三处不许各写一份。
export const HUB_MACROS = Object.freeze(new Set(["upgrade"]));
```

`MACRO_SPECS.upgrade`（追加在 `trash_unused` 之后，`contract.mjs:1410` 附近）：照侦察 §4.1 的清单补齐七项必填（`preconditions` / `whenNotToUse` / `returns` / `lowerOps` / `sideEffects` / `invariants`，`contract.mjs:2264` 的测试会查）。要点：

- `params: [{ name:"line", type:"belt|miner|processors|painting", required:true }]` —— **只有这一个参数**（§1.2b）。枚举值从 `rules.mjs` 的 `UPGRADES` 的 key 派生，不手抄。
- `lowerOps: ["obs（读 goal.upgrade_levels + hub.stored_shapes）", "upgrade{id}（mod RPC，不产生 tx op）"]`
- `sideEffects: ["hub.stored_shapes 减少（不可逆）", "goal.upgrade_levels 增加（进存档）", "不增删任何实体", "可能减少 goal.requirement.delivered（见下）"]`
- `invariants: ["执行前后实体 uid 集合恒等", "返回只报告，不改世界（真写由 loop 的 hub 通道做）"]`

**关键设计决定：宏只做「校验 + 计划」，不做写。** 与现有 6 个宏完全同构（`loop.mjs:1218` 的注释：宏都是 dry-run 规划器，`buildTxPlan` 从头到尾不碰世界）。所以 `upgrade.mjs` 的返回值是 `{ok:true, cells_planned:0, cells_placed:0, first_mismatch:null, plan:{line, from_tier, to_tier, required, affordable, blocked}}`，**真正的 RPC 在 apply 阶段由 `doHubApply` 发**。

这一点很重要：如果宏自己去买，那么「plan 阶段被后面的宏拒掉」时钱已经花了（`loop.mjs:1150-1160` 的 R1「一条宏失败 ⇒ 一条 op 都不生成」会变成空话）。

### 3.2 ★ 必须挡的一件事：升级会消耗目标形状 ★

`hub_goals.js:171-181`：

```js
getCurrentGoalDelivered() {
    if (this.currentGoal.throughputOnly) { … }
    return this.getShapesStored(this.currentGoal.definition);   // = storedShapes[goalShape]
}
```

而 `tryUnlockUpgrade` 会 `storedShapes[requirement.shape] -= requirement.amount`（`:348-354`），`canUnlockUpgrade` 的前提就是「账上有」（`:302-308`）。

⇒ **如果某个升级线的下一档需求里包含当前目标形状，买它就会把 `goal.delivered` 打回去。**

这不是理论问题：

- L4 目标 `RuRu----`（`test/fixtures/saves/L4-obs.json` 的 `goal.requirement.shape`）；
- `processors` T2 的需求是 `SuSuSuSu×1200 + RuRu----×600`（`rules.mjs:189`）。

同一份库存同时是「关卡进度」和「升级货币」。在当前 L4 夹具上买不到（因为挡着 requires 70，delivered 到 70 就换关），但**只要 `goal.required > 该形状的升级需求量`，这个坑就成立**，而这在后面的关卡完全可能出现（`required` 在自由模式是 `min(200, 4+(level-27)*0.25)`，故事关是 `levels[i].required`）。

这条一旦踩中，后果是**双重**的：

1. `goal.delivered` 下降 ⇒ `checkBehavior` 的 `target_stored_delta` 为负（`verify_runtime.mjs:933-934`）⇒ `storedOk` 为 false（`verify.mjs:329`）⇒ L4 判红；
2. `readGoalDelta`（`loop.mjs:2188-2209`）返回负数 —— 它有三处 `Math.max(0, …)`，但 `:2204` 那条返回的是 `d` 原值。

**⇒ 在 `upgrade.mjs` 里加一条前置条件（`precondition_failed`）：**

```js
// 目标形状是这次升级的货币 ⇒ 买它等于自己把进度打回去。拒。
const goalShape = ctx.goal && ctx.goal.requirement && ctx.goal.requirement.shape;
if (goalShape && next.required.some(r => r.shape === goalShape)) {
    return failure("upgrade", {
        code: "precondition_failed", field: "line",
        message: `upgrade ${line} T${tier} 需要 ${goalShape}×${n}，而它正是当前目标形状`
               + `（goal.delivered 就是 storedShapes["${goalShape}"]，买了会把进度打回去）`,
        hint: "先完成当前关卡目标，或换一条不消耗目标形状的升级线。",
    });
}
```

并且 **`assess.mjs` 的 `nextActions` 里那条 `buy-upgrade`（`assess.mjs:353`）也要过同一个判据**，否则 prompt 会建议一个宏会拒的动作 —— 这正是 `7effd1e`「两处『教模型做不可能的事』」修的病。为了让 prompt 与宏共用一份真值：把这个判据导出成 `upgradeBlockedByGoal(line, obs)`（放 `upgrade.mjs`），`prompt.mjs` 里 `import` 它（`prompt.mjs` 已经 import 了 `place.mjs`，同一类依赖）。

### 3.3 `already-maxed` 的表达位置

`shapez-ai-bridge.js:1079-1081` 返回 `{ok:true, bought:false, reason:"already-maxed"}`，不抛错。侦察 §8.2 说「`MacroResult` 信封里没有地方放 `bought`」。

我的处理：**`bought` 不进 `MacroResult` 信封。** 理由：

- 计划期（`upgrade.mjs`）**知道** `maxed`（`obs.goal.upgrade_levels[line]` vs `UPGRADES[line].length`，规则表在 `rules.mjs:176`）。满级应该在计划期就拒：`precondition_failed: line "processors" 已满级（T3）`。这样 `bought:false` 根本不该在正常情况下出现。
- 如果还是出现了（obs 过期 / 别人动过存档），那是**执行期**的事，由 `hubApplyVerdict` 判（`bought === true` 那条），诊断走 `MACRO_REFUSED`。
- ⇒ 一条新 `WARNING_CODES` 条目都不需要，一条新 `ERROR_CODES` 条目也不需要（`precondition_failed` 够用）。信封扩展字段虽然能塞（`validateMacroResult:1772` 只校验 required），但**能不扩就不扩** —— 信封每多一个可选字段，下游就多一个「要不要读它」的问题。

### 3.4 `FakeGame` 需要升级能力（离线验证的前提）

`fake_game.mjs` 的 `reader()`（`:107-114`）只有 `obs/debugItems/production/step`，没有 `upgrade`；`apply()`（`:218-260`）只认 `delete`/`place`。所以**离线现在无法验升级**，必须扩：

```js
// FakeGame 加一个方法，**语义逐字对齐 mod 的 upgrades()**（shapez-ai-bridge.js:1048-1105）
upgrade(p) {
    // p.id === undefined ⇒ 只读快照（与 mod :1071 同形状）
    // p.id 给 ⇒ 买下一档：
    //   - maxed      ⇒ { ok:true, bought:false, reason:"already-maxed", before, after }  ← 不抛
    //   - 买不起      ⇒ throw { rpc:{ code:2002, name:"game_rejected" } }                ← 抛
    //   - 成功        ⇒ { ok:true, bought:true, spent, before, after, stored }
    // 数值一律来自 rules.mjs 的 UPGRADES（**不许在本文件里抄第二份成本表**）
}
```

三条纪律（`fake_game.mjs:1-20` 的头注释已经立了规矩：「只伪造读取面，不伪造判据」）：

1. 成本表从 `rules.mjs` 的 `UPGRADES` 取 —— 那张表有 `verifyRules()`（`rules.mjs:348-400`）拿源码逐档对账，是唯一的成本真值。
2. **返回值形状、`bought` 语义、2002 的抛出时机，逐字抄 mod**（`fake_game.mjs` 的注释里已经因为 `resources` 与 region 两处跟真机不一致踩过两次坑，`observe` 那段长注释就是那次事故的产物）。
3. `reader()` 里加上 `upgrade`，并且 `X-upgrade` 在 `OFFLINE_UNVERIFIABLE` 里（§2.6）—— **FakeGame 有升级能力 ≠ 离线能验升级**。前者是「让离线链路能跑」，后者是「离线结论可信」，两者必须分开。

---

## 4. 五处硬编码 `=== 6`

先给判据（这是分行的唯一依据）：

> **这条断言要证明什么？**
> (a) 「白名单是派生出来的，不是第二份表」⇒ 它应该**派生**，字面量是纯噪声；
> (b) 「ABI 的大小是一次有意识的决定」⇒ 它应该**保留字面量**，因为字面量就是那个「意识」。

| 位置 | 现状 | 判断 | 理由 |
|---|---|---|---|
| `contract.mjs:2255` | `t("宏名齐全", MACRO_NAMES.length === 6)` | **保留字面量，但换形态** | 这是 ABI 的 tripwire，属于 (b)。但改成派生会变成 `MACRO_NAMES.length === Object.keys(MACRO_SPECS).length` —— **恒真，等于删掉**。更好的写法是钉名字而不是钉数量：`eq([...MACRO_NAMES].sort().join(","), "connect,extend_line,insert_machine,remove_run,replace_run,trash_unused,upgrade")` —— 数量是副产品，**改名**也会被抓到。 |
| `contract.test.mjs:384` | `eq(MACRO_NAMES.length, 6)` | **删掉** | 它上一行就是 `eq(Object.keys(MACRO_VALIDATORS).sort(), [...MACRO_NAMES].sort())`（`contract.test.mjs:382`），那条**已经**能抓住「加了宏忘了写校验器」。数量断言不提供任何它抓不到的信息，只提供每次加宏都要改一行的负担。属于 (a)。 |
| `llm.test.mjs:65` | `eq(LLM_MACRO_WHITELIST.length, 6, ...)` | **改派生 / 删** | 下一行 `ok(LLM_MACRO_WHITELIST.every((n,i) => n === MACRO_NAMES[i]))`（`:66`）**精确证明了派生**（逐项且同序），长度是它的推论。属于 (a)。建议直接删，把 `"白名单恰好 6 个宏"` 的语义并进那句的 label。 |
| `prompt.test.mjs:136` | `eq(MACRO_WHITELIST.length, 6, "白名单 6 个")` | **改派生** | 上一行 `ok(MACRO_WHITELIST.every(n => MACRO_NAMES.includes(n)))`（`:135`）只证了 ⊆，**没证 =**。所以这里保留一条断言是有价值的，但应该证**相等**而不是数量：`eq(MACRO_WHITELIST.length, MACRO_NAMES.length)`，或者 `deepEqual([...MACRO_WHITELIST].sort(), [...MACRO_NAMES].sort())`。属于 (a) 的变体：**保留断言，换判据**。 |
| `loop_pipeline.test.mjs:227` | `ok(MACRO_NAMES.length === 6, "白名单恰好 6 个（contract.mjs 的断言）", …)` | **删掉** | label 自己写着「contract.mjs 的断言」—— 它就是在 pipeline 测试里复述别人的断言。跨文件的重复断言不是防御，是**两处都要改**的技术债。属于 (a)。 |

**净结果：留 1 条（换成名字清单形态），删 2 条，改 2 条。** 新增宏时只需要动 1 处。

**额外发现（顺手记）**：`contract.mjs:2154` 起的那段自测（含 `:2255`）**没有任何测试文件去跑它** —— 我 grep 过 `spawnSync`/`execFileSync`，`contract.test.mjs` 是纯 import，不 spawn。所以那条 tripwire 目前**只在人工执行 `node src/agent/macros/contract.mjs` 时生效**（我实跑过，输出「全部通过」）。这削弱了「保留字面量」的价值。两个选项：
(i) 什么都不做，但在注释里写明「本自测不在 CI 里」；
(ii) 在 `contract.test.mjs` 末尾加一行 spawn 断言（约 8 行）。
我倾向 (ii)，但它是独立的小改动，可以单列（§8 的 S7 里，30 分钟）。

---

## 5. `RETRIEVAL_TABLE` 的调参风险 —— 不要在表里加 `upgrade`

### 5.1 机制确认（实测数字）

`candidatesFor`（`loop.mjs:494-505`）：

```js
for (const d of diagnoses)              // 按诊断顺序
    for (const c of (RETRIEVAL_TABLE[d.code] || []).slice(0, 3))   // 每码 top-3
        if (!seen.includes(c.macro)) seen.push(c.macro);
        if (seen.length >= 6) return seen;                          // 全局上限 6
```

我在 L4 真实夹具上跑了 `diagnose` 得到 7 条诊断（`NO_PRODUCTION` ×1、`BELT_HANDOFF_REJECTED` ×2、`DEAD_END` ×2、`CHAIN_UNFED` ×2），代入真表中的权重后：

| 场景 | 当前候选 | 若在 `NO_PRODUCTION` 加 `upgrade@6` |
|---|---|---|
| L4 冷启动（7 条诊断） | `replace_run, insert_machine, connect, trash_unused, extend_line`（**5 个**，没满 6） | `replace_run, upgrade, insert_machine, connect, trash_unused, extend_line`（6 个，`remove_run`@3 被挤掉——它本来也不在） |
| 只有 `PROCESSOR_REQUIRED` | `replace_run, insert_machine, connect` | `replace_run, upgrade, insert_machine` ← **`connect` 被挤掉** |

第二行是这个问题的真身：**在「需要一台工序机」的诊断下，模型会先看到「买升级」，而看不到「接线」**。而 `PROCESSOR_REQUIRED{scope:"factory"}` 的正确修法是**先放机器再接线**（`constants.mjs:305-309` 的注释自己写了「factory：先要有一台机器（insert_machine），再接线」）。

第三行（L4 实测）：候选从 5 → 6。**看起来无损**，但这是因为 L4 有 4 种诊断码提供了足够的多样本。**单码场景才是常态**（`PROCESSOR_REQUIRED`、`NO_PRODUCTION` 单独出现时），那里必然挤掉一个。

### 5.2 结论：`RETRIEVAL_TABLE` 一个字不改

理由不是「怕挤掉」，而是**判据用错了维度**：

`RETRIEVAL_TABLE` 的语义是「**这个诊断码**该用哪些宏修」。而「该不该买升级」**不是一个诊断的产物** —— `diagnose()`（`loop.mjs:561`）里没有任何一条读 `hub.stored_shapes` 或 `goal.upgrade_levels`（我 grep 过），所以**没有任何诊断码能表达「这里缺产能、而且买得起升级」**。硬把 `upgrade` 挂到 `PROCESSOR_REQUIRED` 下，等于借用一条不相干的码来传递信息 —— 这正是 `constants.mjs:180-190` 头注释里点名批评的那类错误（「静态表只有一个维度（诊断码），表达不了这层」）。

### 5.3 改法：在**候选注入点**追加，且放在上限之后

```js
// loop.mjs:1727 附近
const cands = st.candidatesOverride || withUpgradeCard(candidatesFor(diagnoses), ob.obs);

/** 有「买得起、且不消耗目标形状」的升级时，把 upgrade 卡片追加到**上限之后**。 */
function withUpgradeCard(list, obs) {
    if (!HUB_MACROS.has("upgrade")) return list;                 // 宏没接进来 ⇒ 恒等于原列表
    let info;
    try { info = capacityFor(obs); } catch { return list; }       // 产能算炸了不许影响候选
    const ok = (info.options && info.options.doNow || [])
        .some(a => a.action === "buy-upgrade") && !upgradeBlockedByGoal(…);
    if (!ok) return list;
    return list.includes("upgrade") ? list : [...list, "upgrade"];  // 追加，不参与 6 的上限
}
```

为什么「放在上限之后」是决定性的：

- **无升级可买时（也就是今天的 L4 夹具现状）返回值与输入逐字节相同** ⇒ 现有一切 prompt 测试、一切 A/B 结论**不受影响**。这不是口头保证，是 `return list` 这个分支。
- 我实测过 L4 夹具的 `capacityFor(obs).options.doNow`：`[{action:"add-machines", kind:"cutter", from:1, to:6, add:5}]` —— **只有加机器**（因为 `processors` T1 的 `SuSuSuSu×500` 一件都没有，`affordable:false`，`assess.mjs:529-535` 不会把它放进 `doNow`）。所以**在当前夹具上这条注入永远是 no-op**。
- 上限从 6 变 7（含 upgrade）这件事，对 `candidatesFor` 的 6 上限**没有任何影响** —— 上限仍然管着表内候选。

还有一个细节：`countFingerprint`（`:1543`）的「必须换动作」也调 `candidatesFor`（不带 obs）。那里**不加** upgrade 卡片是对的：如果模型上一轮已经用了 upgrade，这一轮就该换别的；如果上一轮没用，那 override 里没有 upgrade 也只意味着「这一轮别急着买」——保守。

### 5.4 prompt 预算：不是约束（实测）

| 卡片数 | `user` 长度 | 带子显示 | CAPACITY |
|---|---|---|---|
| 3 | 6564 | 12/163 | 有 |
| 5 | 7188 | 12/163 | 有 |
| 6 | 7550 | 12/163 | 有 |

单卡成本 ≈ **300 字符**（6→5 差 362，5→3 差 312/卡）。7 张 ≈ 7850，离 `targetChars = 16000` 还有一倍余量，且带子名额（12/163）已是 `STATE_BELTS_MAX` 上限、CAPACITY 也在。**⇒ 不存在「加一张卡把带子挤没」的风险。** `PROMPT_RULES` 里没有任何「卡片数上限」的常量（`renderCards` 只数 `names.length`，`prompt.mjs:433-446`），所以也不会有断言炸。

---

## 6. prompt 侧

### 6.1 `MACRO_EXAMPLES`（`prompt.mjs:291`）

```js
upgrade: { macro: "upgrade", args: { line: "processors" } },
```

三条必须遵守（每条都能被现有测试机制抓住）：

1. **不带 tier**。理由同 §1.2b：tier 从 obs 派生。示例里出现 `tier` 会教模型传一个不存在的参数（`renderCard` 的 `params:` 行会列 `line:…`，模型照着抄 tier 就 `unknown_field`）。
2. **不带任何数字**。`assertNoHumanCoords` 的 V4 只看 `x,y` 形态的字符串（`coords.mjs:193`），`line:"processors"` 安全；但如果示例写成 `{line:"belt", tier:2}`，那个 `2` 本身不触发 V1/V2（单个数不是坐标），**却会让 copy 出来的调用被 `validateMacroCall` 拒**。所以「不带数字」是自己加的纪律，不是工具能保证的。
3. 不加进 `LEGAL_VALUES`（`prompt.mjs:374`）也行，但更好是加一条：`upgrade: () => \`line ∈ {${Object.keys(UPGRADES).join(" | ")}}   (each line is bought one tier at a time; do not pass a tier)\`` —— 值从 `rules.mjs` 的 `UPGRADES` 派生，与 `insert_machine` 的 `SUPPORTED_BUILDINGS` 同一条纪律（`prompt.mjs:374-380` 的注释）。

### 6.2 `canBuyUpgrade` 闸门（`prompt.mjs:1383`）

现在是：

```js
const canBuyUpgrade = false;   // ← 加 `upgrade` 宏并接进 `MACRO_FNS` + `doApply` 后改这里
```

改成**派生自接线事实**，而不是布尔常量：

```js
/* 判据不再是「MACRO_NAMES 里有没有 upgrade 这个字符串」（那是猜名字），
   而是「loop 的执行面有没有一条能承载它的 hub 通道」—— 也就是 HUB_MACROS。
   HUB_MACROS 同时是三处的真值：loop.mjs 的分流、doHubApply 的兜底、这里。
   ⇒ 三处不可能分叉。 */
const canBuyUpgrade = HUB_MACROS.has("upgrade");
```

`:1338-1347` 那段长注释要**改写成新的理由**（旧理由「没有任何宏能买升级」已经不成立了），而不是删掉 —— 它记录的是一个真实事故（教模型做不存在的动作），下一个改这里的人需要知道为什么这条闸门存在。

### 6.3 CAPACITY 段的措辞（`prompt.mjs:1390` / `:1395-1407`）

现在：

```js
lines.push(`act: buy ${buyNow.line} T${buyNow.tier} ⇒ ${fmt(buyNow.capacityAfter)}/s`);
```

问题：`buy … T2` 读起来像一个参数 `tier`。而宏的参数只有 `line`。改成把 tier 降级成**说明**、把参数形态摆出来：

```js
// short 版
lines.push(`act: upgrade ${buyNow.line} (T${buyNow.tier - 1}→T${buyNow.tier}) ⇒ ${fmt(buyNow.capacityAfter)}/s`
         + `   args: {"line":"${buyNow.line}"}`);
// full 版的 roads 里
roads.push(`${up.line} T${tier-1}→T${tier} (×${from}→×${to}) ⇒ ${fmt(up.capacityAfter)}/s — ${short}`);
```

一句话概括：**把「买什么」和「怎么下单」分开写**。现在的措辞把两者混在一起，模型只能猜参数名。

顺带把「已经买不到（满级）」也说出来 —— 现在 `capacityOptions`（`assess.mjs:474-545`）在 `nextMul <= curMul` 时返回 `upgrade: null`（`:511-522`），所以满级天然不渲染，这点不用改。

### 6.4 prompt 侧必须钉的两条断言

1. **宏未接线时逐字节等于今天**：把 `HUB_MACROS` 置空（测试里用一份 `Object.freeze(new Set())` 的替身跑 `renderCapacity`），断言输出与 HEAD 的快照相等。或者更简单：断言 `canBuyUpgrade === false` 时 `renderCapacity` 的输出里 `doesNotMatch(/upgrade|buy /i)`（与 `prompt_capacity.test.mjs:115-116` 的现有断言同形，**那两条断言不用改，它们会在宏接线后变红 —— 那是正确行为，届时按注释「等宏做好了把这条改回去」改成正面断言**）。
2. **有升级可买 + 已接线时**：`renderCapacity` 里出现 `upgrade processors (T1→T2)` 且**不出现** `tier` / `T2 ⇒` 这种「看起来像参数」的形态。

---

## 7. 验证计划

### 7.1 必须新增的测试（按「能抓住什么」排序）

新建文件 `src/agent/loop/upgrade_channel.test.mjs`（走 `node:test`，与 `prompt_budget.test.mjs` 同风格）：

| # | 断言 | 抓住什么 |
|---|---|---|
| U1 | `planToTxOps` 对 `upgrade` 返回 `R4/unknown_macro` | 分流写错 / 有人给 `PLACE_MACROS` 加了 upgrade |
| U2 | `splitHubCalls({calls:[connect…]})` 返回**同一个对象引用** | 「无 hub 调用时行为不变」的证据 |
| U3 | 纯 upgrade 计划：`res.tx_count === 0`、`res.hub_count === 1`、`outcome !== "success"`、`level !== "offline-only"` | ★ 红牌 ①：hub 轮不许被记成离线全绿 |
| U4 | 纯 upgrade 计划在 **mock** 模式下：`verify` 行里 `X-upgrade` 带 `undecidable`（或干脆不在 `checks` 里），且 `phaseTwoVerdict` 没被调用过（用 spy 包一层） | 红牌 ① + `OFFLINE_UNVERIFIABLE` 有没有真的生效 |
| U5 | `hubApplyVerdict({ok:true, bought:false, reason:"already-maxed"})` ⇒ 红 | 红牌 ③：`ok:true` 不等于买成功 |
| U6 | `hubApplyVerdict({ok:true, bought:true, before:{level:1}, after:{level:1}})` ⇒ 红（level 没涨） | 「返回说自己买了，但世界没变」—— 与 `NO_WORLD_CHANGE` 同类，但是 hub 侧的 |
| U7 | `hubApplyVerdict` 在 `stored` 扣减与 `spent` 不等时 ⇒ 红 | 对账（防「扣了但没买」/「买了但没扣」） |
| U8 | 混轮（`[replace_run, upgrade]`）：tx 成功 ⇒ hub 被调用 1 次；tx 失败/回滚 ⇒ **hub 被调用 0 次** | 「先 tx 后 hub」的顺序真的生效（用注入的 `hubApply` spy 数调用次数） |
| U9 | `upgrade.mjs` 在「下一档需求包含当前目标形状」时返回 `precondition_failed`，且**没有发任何 RPC** | §3.2 |
| U10 | 一轮成功升级后，下一轮的 `fingerprintOf(diagnose(...))` 与上一轮**相同**，且 `countFingerprint` 会让 `mustChange` 为 true（第 2 次） | §2.10 的行为被钉住（防有人去「修」它） |
| U11 | `withUpgradeCard(list, L4_obs)` 在 L4 夹具上返回**同一个数组**（没有升级可买） | 「当前夹具上零影响」 |
| U12 | `withUpgradeCard` 在「买得起且安全」的 obs 上返回 `[...list, "upgrade"]`，且 `list` 的 6 个成员位置不变 | 追加而非插队 |

各测试文件的小改动：

| 文件 | 改动 |
|---|---|
| `planToTxOps.test.mjs` | +U1（1 条） |
| `contract.test.mjs` | 删 `:384`；`:388-400` 的「每个校验器拒绝未知参数」表**加一行** `upgrade: { line: "processors" }`（否则新宏不被覆盖，`contract.test.mjs:394` 的循环只跑表里的宏） |
| `loop.test.mjs` | `preserved.world_state` 多一个合法值 `"hub_only"`；`RUN_KINDS` 不变（复用 `apply` kind，`:177` 的 9 种断言不用动） |
| `prompt_capacity.test.mjs` | `:115-116` 两条 `doesNotMatch` 在宏接线后改成正面断言（注释已经预告了这一步） |
| `offline_boundary.mjs` 自测 | 无需改：`:252` 是 `["L3-flow","L4-behavior","tx-atomicity"].every(k => k in OFFLINE_UNVERIFIABLE)`，加 `X-upgrade` 仍绿。**但建议顺手加一条**：`t("X-upgrade 也在不可信表里", "X-upgrade" in OFFLINE_UNVERIFIABLE)` —— 否则这个「离线必须判不可信」的约定只能靠代码读出来 |
| 5 处计数 | 按 §4 的表处理 |

### 7.2 离线能不能验

**能验的（FakeGame 扩了 upgrade 之后）：**

- 决策链：`splitHubCalls` → `buildHubPlan` → `doHubApply` → `hubApplyVerdict` → `settleFailure`/记账 全链路。
- 幂等/拒绝路径：满级、买不起、goal-shape 冲突。
- 「零实体变更的一轮不被判绿」这条 —— **这是本次最重要的离线可验结论**，因为它只依赖 `runLoop` 自己的记账和 `phaseTwoVerdict` 的调用时机，不依赖世界。

**不能验的：**

- 真实扣费（`tryUnlockUpgrade` 的实际扣减）与档位写入存档。
- `upgradePurchased` 信号（`hub_goals.js:359`）会不会推关卡目标。侦察 §7-4 提了这条；我查了订阅方，只有 `hud/parts/shop.js:208`、`hud/parts/building_placer_logic.js:131`、`hud/parts/pinned_shapes.js:69`、`achievement_provider.js:478` —— **都是 HUD / 成就，没有一条动 `currentGoal`**。所以「升级推进关卡」这个担心可以降级为「不会」，但**仍需实机确认一次**（因为 `hud/parts/pinned_shapes.js` 的 `updateShapesAfterUpgrade` 我看不到实现）。
- dry_run 的 `would_spend` 与真买 `spent` 是否相等（代码上是同一个 `required`，`:1094` vs `:1097`，但没实机对过）。

### 7.3 真机能不能验

**现在不能。** 三条硬阻塞：

1. **存档索引坏了**（`research/ai-plan/SAVEGAME-INDEX-DEFECT.md`，commit `8a22265`）：`savegames.bin` 被截断成 127 字节空索引，`list_saves` 返回空，`load_save` 2002。⇒ **进不了世界**。
2. **进不了世界 ⇒ `requireRoot()` 抛 1003**（`shapez-ai-bridge.js:1179` 附近的 `requireRoot`），所以 `upgrade` RPC **连只读快照都拿不到**。**不是说「现在还能读不能写」，是读写都不可用。**
3. **`snapshot_load` 也走 `load_save`**（`bridge.mjs:473-519`，`8a22265` 的 commit message 明确写了），⇒ 所有依赖 snapshot 的安全网一起失效。**在这条修好之前，任何实机写入都不该做。**

**索引修好之后，`upgrade` 的第一个实机目标不是 L4**：`7c93b3dd`（唯一允许写、level 4）的存档内容是 `storedShapes {CuCuCuCu:12, ----CuCu:686, RuRuRuRu:2016, ----RuRu:4575}`、`upgradeLevels {belt:1, miner:1, processors:0, painting:0}`（离线解码结果，`SAVEGAME-INDEX-DEFECT.md`）。对照 `rules.mjs:176-197`：

| 线 | 下一档需求 | 够吗 |
|---|---|---|
| `miner` T2 | `RuRuRuRu×740 + Cu------×800` | `RuRuRuRu` 够（2016），`Cu------` **0** ⇒ 买不起 |
| `belt` T2 | `CuCuCuCu×75 + --CuCu--×500` | 都不够 |
| `processors` T1 | `SuSuSuSu×500` | 0 ⇒ 买不起 |
| `painting` T1 | `RbRb----×600` | 0 ⇒ 买不起 |

⇒ **`7c93b3dd` 上也买不起任何升级。** 要实机验，必须先在目标世界上跑产线攒料（`----CuCu:686` 是废料，`-------` 缺口靠 `cutter` 造），或者找/建一个够料的世界。**这意味着实机验证的排期不可能早于「索引修复 + 一次攒料 run」。**

**能做的实机探针（不写、只读，索引修好后立刻可用）**：

```bash
node -e "fetch('http://127.0.0.1:7777/rpc',{method:'POST',headers:{'content-type':'application/json'},
 body:JSON.stringify({jsonrpc:'2.0',id:1,method:'upgrade',params:{}})}).then(r=>r.json()).then(x=>console.log(JSON.stringify(x,null,1)))"
```

它返回的四条线快照（`shapez-ai-bridge.js:1071`）可以直接和 `rules.mjs` 的 `UPGRADES` 对账 —— 那就把「成本表对不对」也实机核了一遍（侦察 §6 说不要重新实现成本计算，这条探针正是「用游戏自己的数对账」）。

### 7.4 顺手必修（独立于本任务，30 分钟）

`--read-only` 绕过 `upgrade`（侦察 §2.3）。在**动手加宏之前**修，两条独立防线：

```js
// bridge.mjs:309
const WRITE_METHODS = new Set(["save_now", "load_save", "new_game", "snapshot_save", "snapshot_load", "upgrade"]);
```

但桥侧的白名单只能拦「方法名」，拦不住「只读模式 + 传了 id」和「只读模式 + 只有 dry_run」的区别。所以第二道在 mod：

```js
// shapez-ai-bridge.js upgrades() 内，参数校验之后：
if (params.id !== undefined && params.dry_run !== true) this.assertWritable("upgrade");
```

（`research/ai-plan/live/guard.mjs:593-605` 的谓词 `p.id !== undefined && p.dry_run !== true` 是**对的**，直接抄它 —— 但那是实验脚本的护栏，不是生产护栏，这就是差异所在。）

---

## 8. 工作量分解（按「能独立验证的最小步」）

依赖关系：S0 独立；S1 → S2 → S3 → S4 → S6；S5 与 S2 并行；S7 收尾。

| 步 | 改什么 | 怎么验（具体命令） | 估时 |
|---|---|---|---|
| **S0** | `bridge.mjs:309` + mod `upgrades()` 加 `assertWritable` | `node src/bridge/selftest.mjs`；`node src/mod/... selftest`（若有）；手动：`--read-only` 下 `upgrade{id}` 返回 1004 | 30 min |
| **S1** | `contract.mjs`：`HUB_MACROS`、`MACRO_SPECS.upgrade`、`validateUpgradeArgs`、`MACRO_VALIDATORS.upgrade`；`loop.mjs:95` 加 `MACRO_FNS.upgrade` | `node src/agent/macros/contract.test.mjs`（32→~36 条）；`node src/agent/macros/contract.mjs`（自测）；`node -e "import('./src/agent/macros/contract.mjs').then(m=>console.log(m.MACRO_NAMES))"` 应含 `upgrade` | 1 h |
| **S2** | 新建 `src/agent/macros/upgrade.mjs`（校验 + 计划，零写；含 §3.2 的 goal-shape 闸门与满级闸门） | 新建 `upgrade.test.mjs`：满级 / 买不起 / goal-shape 冲突 / 正常四条；`node src/agent/macros/upgrade.test.mjs` | 1 h |
| **S3** | `loop.mjs`：`splitHubCalls` + `buildHubPlan`（约 85 行，含 §2.5 的 3 条契约） | `node src/agent/loop.test.mjs` 155 条不变（这是零影响的证据）；新测试 U2 | 1.5 h |
| **S4** | `loop.mjs`：`doHubApply`、`:1819` 前后的分流接线、`:1908` 的两段式、`:2009` 前的 hub 轮分流、`st.hubTouched`/`st.hubCount`、`world_state:"hub_only"`；`verify.mjs`：`hubApplyVerdict`；`offline_boundary.mjs`：`X-upgrade` 入 `OFFLINE_UNVERIFIABLE` | `node src/agent/loop/verify.test.mjs`（75 条不变）；新测试 U3/U4/U5/U6/U7/U8/U10 | 2 h |
| **S5** | `fake_game.mjs`：`upgrade()` + `reader().upgrade`（成本表取自 `rules.mjs`） | `node src/agent/fake_game.test.mjs`；新断言：满级返回 `bought:false` **不抛**、买不起抛 2002（形状与 mod 逐字对齐） | 1 h |
| **S6** | `prompt.mjs`：`MACRO_EXAMPLES.upgrade`、`LEGAL_VALUES.upgrade`、`canBuyUpgrade` 派生、CAPACITY 措辞、`withUpgradeCard`；`loop.mjs:1727` 接线 | `node src/agent/loop/prompt.test.mjs`（193 条）；`node src/agent/loop/prompt_capacity.test.mjs`；`node src/agent/loop/prompt_budget.test.mjs`（6 条，**必须全绿** —— 它是「CAPACITY 不许被挤掉」的唯一防线）；新测试 U11/U12 | 1 h |
| **S7** | 5 处计数按 §4 处理；`contract.test.mjs` 校验器表加 `upgrade` 行；`planToTxOps.test.mjs` 加 U1；可选：把 `contract.mjs` 自测接进测试 | 全量：`node src/agent/macros/contract.test.mjs && node src/agent/loop.test.mjs && node src/agent/loop/planToTxOps.test.mjs && node src/agent/loop/verify.test.mjs && node src/agent/loop/prompt.test.mjs && node src/agent/loop/prompt_capacity.test.mjs && node src/agent/loop/prompt_budget.test.mjs && node src/agent/loop/llm.test.mjs && node src/agent/loop_pipeline.test.mjs && node src/agent/loop/constants.test.mjs` | 1 h |
| **S8** | 实机探针脚本（只读）：读 `upgrade{}` 快照 + 与 `rules.UPGRADES` 对账 | 索引修好后才可跑；见 §7.3 | 30 min（阻塞） |

**小计：8.5 h（含 S0 与 S8）。不含 S0/S8（都是与本任务正交的独立项）：7.5 h。**

**降级选项（时间不够时）**：
- **只做 S1+S2+S3+S5+S7**（不做 prompt 注入、不做 capacity 措辞）≈ **4.5 h**。通道通了、能测，但**模型看不到卡片** ⇒ 只有手写计划能触发。**不建议单独发布**：一个模型不知道存在的能力等于没做，而 `renderCapacity` 那条 `canBuyUpgrade=false` 的注释会变成新的谎言。
- **走方案 B（同轮必须另有 tx）**：省掉 S4 里「hub 轮不走 `phaseTwoVerdict`」那半段的语义设计（≈ 1 h）+ U3/U4/U10，≈ **5.5 h**。代价：模型不能「只升级」。

### 与侦察报告「6–10 小时」的对照

侦察 §7 给 6–10 h / 8–10 个文件。我的估计是 **6–8 h（不含 S0/S8）**，落在它的下沿。省下来的部分与加回去的部分基本抵消：

| 侦察假设 | 本方案 | 差 |
|---|---|---|
| 要动 `planToTxOps`（加 Set 成员 + `collectPlaces` 分支持 + 让零 op 通过 `:1279`） | **一个字不动**（方案 C 绕开 ∉ 放松） | **−1.5 h** |
| 要改 `verify.mjs` 的 `applyVerdict` 判据（放行 `diff` 全空） | 不动 `applyVerdict`，新增独立的 `hubApplyVerdict` | **−0.5 h**（且更安全） |
| 要把 `RETRIEVAL_TABLE` 的候选机制调参（上限 / top-3） | 不调表，改在注入点追加 | **−0.5 h** |
| 没算 `FakeGame` 的升级能力（离线验不了） | 必须做（S5） | **+1 h** |
| 没有 goal-shape 与库存的冲突分析（§3.2） | 必须做 + 一条前置条件 + prompt 侧共用判据 | **+1 h** |
| 没有 `hubApplyVerdict` 的四条可证伪判据 | 必须做 | **+0.5 h** |

净差 ≈ **−0.5 h**。所以：**侦察的 6–10 h 是准的**，「零实体变更」那一段是不可压缩的成本（我估它在总工时里占 ~3 h：S4 的 2 h + U3/U4/U10 的设计与写）。想把它压到 3 h 以下的方案，只可能是牺牲 §2.6 的红牌 ①（让 hub 轮进入 `phaseTwoVerdict`）—— 那是拿本仓库历史上最贵的一类事故去换时间。

---

## 9. 剩余风险（按「踩中概率 × 后果」排）

| # | 风险 | 后果 | 缓解 |
|---|---|---|---|
| 1 | **有人后来把 hub 轮接进 `phaseTwoVerdict`**，理由「它就一个检查，不绿看不出成功」 | mock 模式下纯升级轮被记成 `offline-only`（红牌 ①）。这是本仓库最贵的一类假绿 | U3/U4 两条断言 + `OFFLINE_UNVERIFIABLE` 里的 `X-upgrade` + `loop.mjs` 里那段的注释写明「这不是遗漏」 |
| 2 | **升级消耗目标形状**（§3.2）而没人想到 | `goal.delivered` 下降 ⇒ `target_stored_delta` 为负 ⇒ L4 判红，且模型会以为「升级让情况变糟」 | 宏的前置条件（`precondition_failed`）+ prompt 侧同一判据 + U9 |
| 3 | **实机排期**：索引没修好 ⇒ 无法验证扣费与存档语义 | 「宏能跑」只在离线成立。离线跑绿 ≠ 实机成立（`offline_boundary.mjs` 的头注释就是讲这件事） | S8 只做只读探针；在索引修好 + `7c93b3dd` 攒够料之前，**不要**对外宣称「upgrade 可用」 |
| 4 | `already-maxed` 的 `ok:true`（侦察 §8.2） | 满级被记成买成功；模型反复尝试 | 计划期就用 obs 判满级并拒 ⇒ 这个分支正常情况下到不了；`hubApplyVerdict` 的 `bought===true` 是第二道；U5 |
| 5 | 升级改变 prompt 但**不改变失败指纹**（§2.10） | 行为正确但反直觉，下一个人容易去「修」`fingerprintOf` | U10 + 文档 |
| 6 | `FakeGame.upgrade` 与 mod 语义漂移 | 离线全绿、实机失败（`fake_game.mjs` 里已经因为 `resources` 与 region 踩过两次） | 成本表取自 `rules.mjs`（有 `verifyRules()` 对账）；返回值形状逐字抄 `shapez-ai-bridge.js:1048-1105`；`X-upgrade` 离线判不可信 |
| 7 | 混轮半成品：tx 成功、hub 失败 | 世界改了、料没花；或（若顺序反过来）料花了、世界没改 | 顺序固定 `tx → hub`；`buildHubPlan` 拒 >1 条 hub op；transcript 记 `hub:{skipped:"tx_failed"}`；U8 |

---

## 10. 一句话总结

**推荐方案 C（runLoop 前置分流）**：把 `upgrade` 从 `planToTxOps` 的输入里**拿掉**，而不是让它学会认识 `upgrade`。
`planToTxOps`、`buildTxPlan`、`applyVerdict`、`strictVerdict`、`verifyRound`、`RETRIEVAL_TABLE` **全部零改动** —— 六条「零影响」都是 `git diff` 能证的，不是论述。
真正的成本在「一轮只有 hub 写」的语义上：**三个不许**（不许 `applyVerdict` / 不许 `strictVerdict` / 不许 `phaseTwoVerdict`）+ 四条可证伪判据 + 一个 `X-upgrade` 离线不可信标记。
最大的风险不是技术，是**有人觉得「让它也走一遍判据更统一」** —— 那一步会把本仓库最贵的一类假绿重新焊回主路径。
