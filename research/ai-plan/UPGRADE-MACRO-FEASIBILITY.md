# upgrade 宏可行性（侦察报告）

> 结论先行：**能做，但不是「加一个宏」的量级。**
> bridge/mod 侧的升级 RPC 已经完整可用（含 affordability 判断和成功回执），
> 真正的障碍不在游戏侧，在 loop 的执行通道：`planToTxOps` → `tx` 这条路
> **结构上装不下「不增删实体」的动作**，而这条约束被 5 处独立防线重复加固过。
> 估计 6–10 小时，其中至少一半花在「让 loop 接受零实体变更的一轮」这个边界上，
> 而那个边界正是这个仓库历史上假绿事故最密集的地方。

---

## 1. 结论

| 问题 | 答案 |
|---|---|
| `QUALITY-METRICS.md` 的说法还成立吗？ | **成立**。`MACRO_NAMES` 运行时恰好 6 个，没有升级宏（已用 node 实跑确认，见 §3） |
| 有「买升级」的 RPC 吗？ | **有，且功能完整**（`src/mod/shapez-ai-bridge.js:524` → `:1048`） |
| 它判断「买得起吗」吗？ | **判断**，买不起抛 2002，不静默失败 |
| 返回值能确认买成功了吗？ | **能**，`bought:true` + `spent` + `before`/`after` + `stored` |
| 加宏的工作量 | 6–10 小时 / 8–10 个文件；其中 `planToTxOps`/`loop` 那一段是**结构性障碍**，不是增量改动 |
| 值得做吗 | 值得，但**不要当成「顺手加个宏」**。要么接受它的独立执行通道，要么先明确它不进 tx |

---

## 2. bridge / mod 侧的确切能力（带行号）

### 2.1 先分清两个 `upgrade`（这俩完全无关）

`src/bridge/bridge.mjs:161` 的 `function upgrade(req, socket)` 是 **RFC6455 WebSocket 握手**：

```
161: function upgrade(req, socket) {
162:     const key = req.headers["sec-websocket-key"];
166:     socket.write("HTTP/1.1 101 Switching Protocols\r\n" +
167:         "Upgrade: websocket\r\n" + "Connection: Upgrade\r\n" + ...)
```

它注册在 `server.on("upgrade", ...)`（`:584`），服务的是 `/mod` 与 `/client` 两个 WS 端点（`:597` / `:620`）。
**和游戏升级毫无关系**。真正的游戏升级是一个 JSON-RPC method 名字叫 `upgrade`，走 `/rpc` 的 POST 通道。

### 2.2 真正的升级 RPC

| 环节 | 位置 | 内容 |
|---|---|---|
| 写操作分类（串行化用） | `src/mod/shapez-ai-bridge.js:100-111` | `RPC_WRITE_METHODS` 含 `"upgrade"`（`:106`），注释 `:419` 明写「扣库存、改写 hubGoals」 |
| RPC 分发 | `src/mod/shapez-ai-bridge.js:524-526` | `case "upgrade": result = this.upgrades(params \|\| {});` |
| 实现 | `src/mod/shapez-ai-bridge.js:1048-1105` | `upgrades(params)` |
| 桥转发 | `src/bridge/bridge.mjs:392-403` | `handleClientRpc` 无 method 白名单，直接 `callMod(method, params)` |

**参数**（`:1040-1047` 的注释即契约）：

```js
params: { id?: string, dry_run?: boolean }
// 不给 id  → 纯读：四条升级链的当前档位、下一档要什么、够不够
// 给 id    → 买下一档（dry_run:true 只报告会扣什么，不真买）
```

`id` ∈ `Object.keys(root.gameMode.getUpgrades())` = `belt` / `miner` / `processors` / `painting`
（`recon/upstream-full/src/js/game/modes/regular.js:108/138/175/205`）。

**它确实做了「买得起吗」判断**（`:1079-1088`）：

```js
1079: if (before[id].maxed) { return { ok:true, bought:false, reason:"already-maxed", ... }; }
1082: if (!before[id].can_buy) {
1083:     throw this.rpcError(2002, "game_rejected",
1084:         `cannot afford upgrade '${id}' tier ${before[id].level + 1}`,
1085:         "Required: " + JSON.stringify(...));
1086: }
```

`can_buy` 来自游戏自己的 `hubGoals.canUnlockUpgrade(id)`（`:1064`），
后者会逐条比对 `storedShapes` 与 `tierData.required`（`recon/upstream-full/src/js/game/hub_goals.js:289-310`）。
所以**不是**「无条件尝试然后失败」——它在动世界之前就拒绝了。

**返回值**（`:1096-1104`）：

```js
const bought = hubGoals.tryUnlockUpgrade(id);
if (!bought) throw this.rpcError(2002, "game_rejected", "game refused the upgrade (state changed?)");
return { ok:true, op:"upgrade", id, bought:true, spent: required,
         before: before[id], after: after[id], stored: {...hubGoals.storedShapes} };
```

拒绝路径给 `before`/`after`/`stored`，调用方**不必再发一次 obs 去猜**。这一点在注释 `:1045-1046` 里明确写了。

**只读快照**（不给 id，`:1071`）：`{ok, op:"upgrade", upgrades:{每条线: {level, maxed, multiplier, next:{required}, can_buy}}, stored, level}`。

### 2.3 顺带发现的一个真实安全缺口（与本任务相关，建议单独修）

`src/bridge/bridge.mjs:309` 的 `WRITE_METHODS` **不含 `"upgrade"`**：

```js
309: const WRITE_METHODS = new Set(["save_now", "load_save", "new_game", "snapshot_save", "snapshot_load"]);
```

而 `src/mod/shapez-ai-bridge.js` 的 `upgrades()` **也没有调用 `assertWritable`**
（`:1048-1105` 内无 `allow_write` / `read_only` 检查；对比 `performAction` 的每个写 op 都有 `:2478-2500`）。

⇒ **`--read-only` 模式下 `upgrade` 不会被拦**，会真的扣库存、改 `hubGoals`。
`research/ai-plan/live/guard.mjs:593-605` 的活体护栏**是**对的（`p.id !== undefined && p.dry_run !== true` 判 write），
但那是实验脚本的护栏，不是生产 bridge 的护栏。

这不是本任务的必需项，但既然查到了就记在这里：**加宏之前应该先修这个**，
否则「read_only 模式安全」这句话已经有了一个反例。

---

## 3. 当前宏清单（从代码读出来的，不是抄文档）

`src/agent/macros/contract.mjs:1131-1410` 的 `MACRO_SPECS` 有 6 个 key，
`:1413` 的 `MACRO_NAMES = Object.freeze(Object.keys(MACRO_SPECS))` 派生出来。

实跑确认（`node -e "import('./src/agent/macros/contract.mjs')..."`）：

```
MACRO_NAMES: ["connect","insert_machine","remove_run","extend_line","replace_run","trash_unused"]
count: 6
```

| 宏 | 声明行 | 参数 |
|---|---|---|
| `connect` | `contract.mjs:1132` | `from, to, opts.rebind, opts.allow_replace, opts.max_cells, opts.prefer, opts.dry_run` |
| `insert_machine` | `:1202` | `at, facing, machine, opts.replace_belts, opts.dry_run` |
| `remove_run` | `:1262` | `uids, cells, opts.allow_scattered, opts.dry_run` |
| `extend_line` | `:1294` | `from, len, dir, opts.dry_run` |
| `replace_run` | `:1329` | `region, building, opts.dry_run` |
| `trash_unused` | `:1369` | `outlet, opts.confirm_waste, opts.replace_belt, opts.dry_run` |

`build_line` 刻意**不在**里面（`llm.mjs:49` 的注释、`prompt.mjs:187` 的 system prompt 都点名禁它）。
它是个独立的库函数（`src/agent/macros/build_line.mjs:123`），不走宏 ABI —— 这是个有用的先例，见 §5。

**「只能看不能做」这句话现在还有反作用**：`prompt.mjs:1336-1337` 在 CAPACITY 段短版里写

```js
lines.push(`act: buy ${buyNow.line} T${buyNow.tier} ⇒ ${fmt(buyNow.capacityAfter)}/s`);
```

模型被**明确告知**去 `buy processors T2`，而白名单里没有任何宏能做这件事。
这是 prompt 层在教模型做一个不存在的动作 —— 比「不提」更坏。

---

## 4. 加一个 upgrade 宏要动的位置清单

### 4.1 简单（照现有宏的模子写）

| 位置 | 改动 | 难度 |
|---|---|---|
| `contract.mjs:1131` `MACRO_SPECS` | 加 `upgrade: {...}`：`params: [{name:"line", type:"belt\|miner\|processors\|painting", required:true}, {name:"expect_tier", type:"int?", ...}, {name:"opts.dry_run", ...}]`。还必须补 `summary / preconditions / whenNotToUse / returns / lowerOps / sideEffects / invariants`（`contract.mjs:2264-2268` 的测试断言这五项非空） | 简单 |
| `contract.mjs:1504` `MACRO_VALIDATORS` | 加 `upgrade: validateUpgradeArgs`，并在 `:1069` 附近写这个校验器 | 简单 |
| `contract.mjs:1413` | `MACRO_NAMES` 自动跟着变成 7 个 —— **不需要改**，但会让 5 处硬编码 `=== 6` 的断言变红（见 4.4） | 简单 |
| 新建 `src/agent/macros/upgrade.mjs` | 实现：读 `obs.goal.upgrade_levels` 判断当前档位、读 `obs.hub.stored_shapes` 判断库存、返回零 op 的 MacroResult（信封合法：`{ok:true, cells_planned:0, cells_placed:0, first_mismatch:null}` —— 已实跑确认 `validateMacroResult` 接受零格） | 中等 |
| `loop.mjs:95` `MACRO_FNS` | 加 `upgrade: upgrade`。**不加会直接抛**（`:103-107` 加载期断言 MACRO_NAMES 与 MACRO_FNS 同集合） | 简单 |
| `prompt.mjs:291` `MACRO_EXAMPLES` | 加一条例子。**不加不会抛，但会渲染成 `example: undefined`**（`:383` 用的是 `JSON.stringify(ex)`）—— 静默坏掉，测试也抓不到 | 简单 |
| `constants.mjs:192` `RETRIEVAL_TABLE` | 在 `PROCESSOR_REQUIRED` / 其它产能相关码里加 `["upgrade", N]`。注意 `candidatesFor`（`loop.mjs:495-507`）每码取 top-3、总数上限 6 —— 加进去会**挤掉**现有的 `replace_run`/`insert_machine`/`connect`，这是真调参不是纯加法 | 中等 |

### 4.2 结构性障碍 —— `planToTxOps.mjs`（这是本任务的核心）

**问题不是「升级不是 place/delete」，而是「升级一条 op 都不产生」。**

```js
// planToTxOps.mjs:45-46
const PLACE_MACROS = new Set(["insert_machine", "replace_run", "connect", "extend_line", "trash_unused"]);
const REMOVE_MACROS = new Set(["remove_run", "replace_run"]);

// planToTxOps.mjs:612-614
if (!PLACE_MACROS.has(n.macro) && !REMOVE_MACROS.has(n.macro)) {
    return reject("R4", "unknown_macro", `planToTxOps 不认识宏 "${n.macro}"`);
}
```

实测（喂一个 fake 的 upgrade 宏结果）：

```
planToTxOps -> ok:false, {"code":"PLAN_REJECTED","rule":"R4","kind":"unknown_macro",
                          "message":"planToTxOps 不认识宏 \"upgrade\""}
```

即便把它塞进这两个 Set 里，`collectPlaces`（`:223`）也会因为「不认识返回形状」报错。
**所以「加一个 Set 成员」是不够的。**

更糟的是：即使 `planToTxOps` 放行了，下游还有 **4 道独立的「零变更 = 失败」防线**：

| # | 位置 | 判据 | 对 upgrade 的后果 |
|---|---|---|---|
| 1 | `loop.mjs:1278-1284` | `if (!txPlan.ops.length) reject("PLAN_REJECTED", "ops 为空（空计划不许当成功）")` | **直接判红** |
| 2 | `verify_runtime.mjs:463-464` | `if (!plan.placements.length && !plan.removes.length) return {name:"L1-landing", ok:false, reason:"...真空绿"}` | L1 红 |
| 3 | `loop/verify.mjs:133-138` `applyVerdict` | `if (added.length===0 && removed.length===0) why.push("NO_WORLD_CHANGE：tx 成功但世界没变")` | apply 判红 → `TX_ROLLED_BACK` 分支 |
| 4 | `loop/offline_boundary.mjs:85-125` `phaseTwoVerdict` | 任何 trustworthy 检查红 ⇒ 不算跑通 | 最终判 none |

**这 4 道防线不是冗余，是四条各自被真实事故喂出来的。**
`loop.mjs:1278` 的注释、`verify_runtime.mjs:186` 的「真空绿」注释、
`verify.mjs:101` 的 `NO_WORLD_CHANGE` 条目，都是「一次 tx 什么都没改却被记成成功」的历史。

⇒ **升级不能走 tx 通道。** 这不是「需要多写点代码」，是「这条通道的语义定义就是不接受它」。

### 4.3 替代路径（三条，按推荐度排）

**路径 A（推荐）：非 tx 的「侧通道」，与 place/delete 计划并行**

- reader 加一个方法：`loop.mjs:2238-2261` 的 `makeBridgeReader` 加
  `async upgrade(p) { return call("upgrade", p); }`；
  `verify_runtime.mjs:83-88` 的 `BRIDGE_READER` 保持只读，不扩（它是验证器的读面）。
- plan 阶段：`upgrade` 宏结果**不喂给** `planToTxOps`，而是单独进 `planned.txPlan.sideEffects`
  （新字段），由 loop 在 apply 阶段先执行 `reader.upgrade(...)` 再执行 tx（或反过来）。
- **必须解决的语义问题**：一轮里如果只有 upgrade、没有 place/delete，
  `txPlan.ops` 就是 0 条 —— 上面 4 道防线全红。
  两条出路：
  1. 让 loop 接受「本轮只有 sideEffect」的情形，并把 `apply`/`verify` 的判据换成
     「upgrade 的 `bought===true` 且 `after.level === before.level + 1`」；
  2. **不让 upgrade 单独成轮**：要求同一轮必须还有一个真的改变世界的宏。
     这条更保守，但它把「升级」和「改产线」绑死，模型想「只升个级」就做不到 ——
     而那恰恰是 CAPACITY 段建议的动作。
- verify：`loop/verify.mjs` 加一个新 check（例如 `X-upgrade`），比
  `after.level - before.level === 1` 且 `stored` 的扣减等于 `spent`。
  这个 check 在 mock 模式下**必须判 undecidable**（`offline_boundary.mjs:37-41` 的
  `OFFLINE_UNVERIFIABLE` 加一条），否则离线会假绿。

**路径 B：把 upgrade 做成 `act` 的一个 op**

- mod 的 `actionSpecs()`（`shapez-ai-bridge.js:2420-2442`）加 `upgrade: {fields: Set(["id"])}`，
  `performAction`（`:2447-2505`）加 `case "upgrade"`，
  `RPC_WRITE_OPS`（`:86-99`）加 `"upgrade"`，`txAllowedOps()`（`:2905-2913`）**不要**加。
- 好处：避开宏 ABI 的 7 个必填字段。
- 坏处：**4 道零变更防线一道都没绕开**（因为 op 0 条和 op 1 条但 tx 无 diff 是同一件事）。
  所以路径 B 并不能省掉 4.2 的活，只是换了入口。**不推荐单独走这条。**

**路径 C：不动 loop，只修 prompt（最小可行）**

- 把 `prompt.mjs:1336-1337` 那句 `act: buy ... T2` 改成条件渲染：
  只有白名单里真有能买升级的宏时才渲染。否则渲染成
  `upgrade ready (processors T2, ×2.0) — but no macro can buy it; add cutters instead`。
- 工作量：**30 分钟，1 个文件**。
- 它不给模型新能力，但它**停止教模型做一个不存在的动作**。
  `QUALITY-METRICS.md:121` 自己给的另一个选项就是「在 A/B 结论里明确标注这个限制」——
  路径 C 是那条路的代码化版本。

### 4.4 测试要动的位置（5 处硬编码 `6`）

| 位置 | 断言 |
|---|---|
| `contract.mjs:2255` | `t("宏名齐全", MACRO_NAMES.length === 6)` |
| `contract.test.mjs:384` | `eq(MACRO_NAMES.length, 6)` |
| `llm.test.mjs:65` | `eq(LLM_MACRO_WHITELIST.length, 6, "白名单恰好 6 个宏")` |
| `prompt.test.mjs:136` | `eq(MACRO_WHITELIST.length, 6, "白名单 6 个")` |
| `loop_pipeline.test.mjs:227` | `ok(MACRO_NAMES.length === 6, ...)` |

`llm.mjs:49` 的 `LLM_MACRO_WHITELIST = MACRO_NAMES` **确实是自动派生**的（确认了，不用改）；
`prompt.mjs:116` 的 `MACRO_WHITELIST = MACRO_NAMES` 同理；`coords.mjs:422` 的
`MACRO_NAMES.includes(macro)` 检查也自动跟着扩。**这三处白名单不需要手工维护** —— 这点任务书里问对了。

`contract.test.mjs` 里还有一条「每个校验器拒绝未知参数」的用例表（`:388-400`），
新宏要往那张表里加一行，否则它不会被覆盖。

---

## 5. `planToTxOps` 那个环节的明确判断

**升级塞不进现有 tx 通道。** 判据不是「`txAllowedOps()` 白名单里没有 upgrade」
（那只是 `shapez-ai-bridge.js:2905-2913` 的 op 级白名单，且它的注释已经说明了为什么
`paste_blueprint` 都进不去：**扣费不可逆**）—— 真正的原因是

> **升级不产生任何 tx op，而这条流水线的每一步都把「零 op」定义成失败。**

具体链条（每一环都有独立代码）：

```
planToTxOps  → ops[]                         （升级产出 0 条）
loop.mjs:1278  空 ops ⇒ PLAN_REJECTED
applyVerdict   added/removed 全空 ⇒ NO_WORLD_CHANGE
checkLanding   placements/removes 全空 ⇒ 真空绿
phaseTwoVerdict 任一可信检查红 ⇒ 不算跑通
```

**替代路径**：路径 A（§4.3）—— 给 loop 一条**明确命名的非 tx 执行面**
（`reader.upgrade` + 新增 `X-upgrade` 检查 + 在 `offline_boundary.mjs` 里标成离线不可信），
并且**显式允许**「本轮 txPlan.ops 为 0 但 sideEffects 非空」这一种情形。

写的时候必须把 `loop.mjs:1278` 那条拒绝改成
`if (!ops.length && !(sideEffects && sideEffects.length)) reject(...)` ——
**只放行这一种**，别放行「什么都没做」。那个区别就是本仓库历史上所有假绿的来源。

---

## 6. 游戏侧的事实（`src/agent/rules.mjs`）

- **买一级要付什么**：`UPGRADES`（`rules.mjs:176-199`），每条线每档是 `{shape, amount}[]`。
  例：`processors` T1 = `SuSuSuSu × 500`；T2 = `SuSuSuSu × 1200` **加** `RuRu---- × 600`；
  T3 = T1+T2 的 carry-over 再加 `CgScScCg × 3500`。
  **carry-over 是真的**：`regular.js:255-262` 每档 `unshift` 前面所有档，
  只有标 `excludePrevious` 的档跳过。`accumulateTiers`（`rules.mjs:330-343`）复刻了这个算法，
  并且 `verifyRules`（`:372-395`）会拿源码逐档对账。
  ⚠️ 那条注释（`:161-167`）记着一个真实事故：这张表曾经**漏了 carry-over 和 ×2.5**，
  导致 `upgradeGaps` 把买不起的升级判成 affordable。**加宏时不要重新实现这套成本计算，
  直接复用 `assess.mjs` 的 `upgradeGaps`**（`:92-113`）。
- **全局还是每条线独立**：**全局**。`hubGoals.upgradeLevels` 是 hub 上的一个
  `{line: level}` 映射（`hub_goals.js:23`、`:95`、`:106`），四条线
  `belt` / `miner` / `processors` / `painting`。**不是每条带子/每台机器独立升级**。
  机器吃哪条线的倍率由 `MACHINE_UPGRADE_LINE`（`rules.mjs:77-92`）映射
  （cutter/rotater/stacker → processors；painter 系/mixer → painting）。
- **有没有「买到顶」判断**：**有，两层**。
  - 游戏：`canUnlockUpgrade` 第一条就是 `if (currentLevel >= tiers.length) return false`
    （`hub_goals.js:294-297`）。
  - mod：`maxed: lvl >= tiers.length`（`shapez-ai-bridge.js:1061`），
    且 `maxed` 时走**成功返回** `{bought:false, reason:"already-maxed"}`（`:1079-1081`）
    —— 注意它**不是**抛错，调用方必须读 `bought` 而不是只看有没有抛。
- **倍率是累加不是累乘**：`UPGRADE_MULTIPLIERS = [1, 1.5, 2, 3, 4, 6, 7, 8]`（`rules.mjs:151`），
  `hub_goals.js:57-62` 是 `totalImprovement += tiers[i].improvement`。
  把 `fixedImprovements` 当「每档 ×1.5」会得到 1, 1.5, 2.25… —— 是错的。

---

## 7. 工作量估计

| 方案 | 文件数 | 估时 | 说明 |
|---|---|---|---|
| **C：只修 prompt（停止教模型做不存在的动作）** | 1 | **~30 min** | 无新能力，但消除了当前 prompt 的误导。建议**无论如何先做这个** |
| **A：完整 upgrade 宏 + 非 tx 侧通道** | 8–10 | **6–10 h** | contract / upgrade.mjs / loop.mjs / planToTxOps / verify.mjs / offline_boundary / prompt / mcp 或 mod + 5 处测试 |
| B：做成 `act` op | 6–8 | 5–8 h | 省不了 4.2 的活，不推荐 |
| （额外）修 `--read-only` 绕过 upgrade | 1–2 | ~30 min | `bridge.mjs:309` + mod `upgrades()` 加 `assertWritable`；独立于宏，**建议先修** |

### 必须在真机上先验证的前提（不是可选）

1. **`upgrade` 在目标世界上是否真的可用**：`7c93b3dd`（level 4、1 实体）大概率没有任何
   `stored_shapes`，任何升级都 `can_buy:false`。要么换一个有库存的世界，要么先跑产线攒料。
   **不要用 `5c967065`（用户 level-11 存档）做这个实验** —— guard 会拦，而且不该拦不住。
2. **`dry_run:true` 的返回是否与真买一致**：`shapez-ai-bridge.js:1091-1093` 的 dry_run
   路径提前返回，不调 `tryUnlockUpgrade`。要确认 `would_spend` 与真买的 `spent` 相等
   （代码看是同一个 `required`，但没实机对过）。
3. **`already-maxed` 是不是终态**：返回 `ok:true` + `bought:false`。
   如果 loop 的判据写成「`ok===true` ⇒ 成功」，满级会被记成成功购买。
4. **升级是否会推进/重置关卡目标**：`hub_goals.js:356` 有 `upgradePurchased` 信号。
   `verify.mjs` 的 `readGoalDelta`（`loop.mjs:2171-2192`）已经处理了「跨关时 delivered 归零」，
   但那是针对 step 跨关写的，**升级触发的那条没验证过**。

---

## 8. 最大的不确定性

1. **「零 op 但成功」这个语义能不能被安全引入**。
   这是唯一一个我无法从代码里读出答案的问题 —— 4 道防线存在的原因各不相同，
   要放行必须先证明「放行的只是 upgrade，不是一切空计划」。
   我倾向路径 A 的保守变体：**要求同轮必须另有一个真正改变世界的宏**，
   代价是模型不能「只升级」。这个取舍需要产品决策，不是工程决策。

2. **`already-maxed` 返回 `ok:true` 的歧义**。
   `bought:false` 是唯一的判别位，而 `MacroResult` 信封（`contract.mjs:1549-1566`）
   里**没有地方放它** —— 塞进 `warnings`（要新增 `WARNING_CODES` 条目）还是塞进
   顶层扩展字段（信封允许扩展字段，`validateMacroResult:1772` 只校验 required，不拒绝多余键），
   这个选择会影响下游怎么读。我没找到既有先例。

3. **`RETRIEVAL_TABLE` 的挤出效应**。
   `candidatesFor`（`loop.mjs:495-507`）每码 top-3、总数 ≤6。加 `upgrade` 到
   `PROCESSOR_REQUIRED` 必然挤掉 `replace_run`(8) / `insert_machine`(6) / `connect`(3) 之一。
   挤掉哪个、挤掉后 A/B 的结论还成不成立 —— 需要真跑，不是读代码能定的。

---

## 附：本报告每条结论的证据位置

| 结论 | 证据 |
|---|---|
| bridge 的 `upgrade` 是 WS 握手 | `src/bridge/bridge.mjs:161-176`、`:584`、`:597`、`:620` |
| 真升级 RPC 存在且完整 | `src/mod/shapez-ai-bridge.js:524-526`、`:1048-1105` |
| 有 affordability 判断 | `:1064`（`canUnlockUpgrade`）、`:1082-1088`（2002 抛出）、`hub_goals.js:289-310` |
| 返回值可判成功 | `:1096-1104`（`bought` / `spent` / `before` / `after` / `stored`） |
| 当前恰好 6 个宏 | `contract.mjs:1131-1410`、`:1413` + node 实跑 |
| `planToTxOps` 拒绝 upgrade | `planToTxOps.mjs:45-46`、`:612-614`、`:223` + node 实跑 |
| 4 道零变更防线 | `loop.mjs:1278`、`verify_runtime.mjs:463-464`、`verify.mjs:133-138`、`offline_boundary.mjs:85-125` |
| 白名单自动派生 | `llm.mjs:49`、`prompt.mjs:116`、`coords.mjs:422` |
| 5 处硬编码 6 | `contract.mjs:2255`、`contract.test.mjs:384`、`llm.test.mjs:65`、`prompt.test.mjs:136`、`loop_pipeline.test.mjs:227` |
| 升级是全局的 | `hub_goals.js:23/95/106`、`rules.mjs:77-92` |
| 买到顶的判断 | `hub_goals.js:294-297`、`shapez-ai-bridge.js:1061`、`:1079-1081` |
| 倍率是累加 | `rules.mjs:151`、`hub_goals.js:57-62` |
| carry-over 成本 | `rules.mjs:176-199`、`:330-343`、`regular.js:255-262` |
| `--read-only` 绕过 upgrade | `bridge.mjs:309`（缺 `"upgrade"`）、mod `:1048-1105`（无 `assertWritable`） |
