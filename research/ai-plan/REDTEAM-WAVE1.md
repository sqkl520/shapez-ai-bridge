# 红队：第一波成果审查

（骨架，逐项填充中）

## 0. 一句话裁决

**第一波的实现是真的，验收数字是真的，但「验收能证明的东西」比它声称的小一圈**：749 条测试全部离线跑（0 条碰游戏），`verifyRuntime` 没写，`connect` 的 71% 里 91% 的成功要以拆掉 296 格既有货路为代价，而 `mod_selftest` 的 3 条 tx 可逆性用例至今**从不执行**——所以"已通过"应当读作"离线自洽已通过"，不是"能在游戏里工作"。

**逐模块**：验收层真过 · 编译器降级部分过（9/12 无回归测试保护）· MCP 部分过（转发真、语义未测）· 宏库部分过（几何真、落地未测）· 事务层部分过（实现真、3 条判据空转）。

## 1. 逐模块裁决（真过/部分过/假绿 + 证据）

### 1.1 事务层 —— **部分过（实现真，测试有 3 条空转）**

**实现是真的。** `opTx`（`src/mod/shapez-ai-bridge.js:3245`）做的是：
预检形状 → `txPrecheckReversible` 问游戏自己 `getIsRemovable` → `snapshotWorld` → 逐条 `performAction`（与单独 act 同路径，刻意不包 immutable）→ 失败则 `rollbackToSnapshot` → 再拍快照 `diffSnapshots` 写进 `verify`。回滚确实是**迭代式**（`MAX_ROUNDS=4`），注释也诚实写了根因：`restoreEntity` 触发 `BeltSystem.updateSurroundingBeltPlacement`，会覆写邻居的 rotation/rv/code，一轮不可能收敛。`rolled_back:true` 只是声称，`verify.uid_set_equal` 才是证据——这个设计取向是对的。

**中途失败会留下什么？** 分三档，实现在注释里也承认了：
1. **实体层**：`verify.uid_set_equal === false` 会如实返回（不假装成功）。有专门测试 `tx: 回滚不收敛 → verify 必须报 false`（第 2042 行）——这条我读到是真的）。
2. **时间**：不可回滚，`tick_advance` 如实报。矿机多挖、带子上的货挪位、hub 多收货，都补不回来。
3. **带子上的在途货**：`BeltPath.items` 不在实体 schema 里，回滚后 `belt.items_before/after` 如实报差值。**这是静默的数据损失，只是被报出来了。**

**但测试数 84 是「87 条声明、84 条真跑」。** `test/mod_selftest.mjs` 有 **87** 个 check 调用点，其中 **3 个忘了 `await`**：

- `:2093` `tx: place_path 也走同一条可逆性预检`
- `:2108` `tx: 可删的建筑不受预检影响（belt 正常通过）`
- `:2116` `delete{uid}: 不可删建筑 → 2002 且 detail 说清是哪类`

`checkAsync` 是 async 函数，不 await 就返回 Promise；模块尾部 `process.exit(0)` 同步执行，这 3 个用例在第一个 `await` 之后就再也不会恢复。我用同构小程序验证过：`checkAsync(...)` 不 await + `process.exit(0)` → 那条 throw 的用例**既不计 pass 也不计 fail**，输出 `pass=0`。所以 87 − 3 = **84**，正好对上报告的数字。**这 3 条恰恰是 tx 可逆性预检和 `delete{uid}` 的核心用例**——正是最该有判别力的三条。

这正是项目已经踩过 3 次的坑（文件第 170 行自己都写了警告），第四次又踩了。

**`verify` 能不能被抓？** 不能通过这 3 条抓，但**能**被 2042 那条抓（变异测试证明 `entities_equal` 会红）。所以 verify 字段本身不是完全裸奔——只是它的两道配套用例空转。

### 1.2 验收层 —— **真过（373 数字对，判据有判别力）**

`node src/agent/gates.test.mjs` → **373 通过 / 0 失败**，与声明一致。整个文件是同步断言（`ok()`/`eq()` 直接计数），没有 async 回调，不存在 mod_selftest 那种假绿通道。

**我做了两道独立变异复核**（在主线程 5/5 之外，另开 `.rt_mut/` 跑）：

| 变异 | 结果 |
|---|---|
| `tx` 的 `verify.uid_set_equal` 与 `entities_equal` 恒 true | **被杀**：2 条 FAIL（`verify 才是证据`、`回滚不收敛`） |

结论：G3/G4 新增的 `GDeleteReplay` / `GRollbackRestore` 不是摆设，主线程那 5 条变异（`vanished` 恒空、`extraGone` 恒空、`stillAlive` 不报、不比身份、不比内容）方向是对的，我也没找到绕过路径。**这一层我判真过。**

一处**口径瑕疵**：G4 的负例用的是 **belt 朝向反**（正确，L4 事故就在 belt），但**没有一条负例是 r≠0 的机器**——真实存档里 18 台机器**全部 r=0**，而 `connect` v1 明确只支持 r=0（`connect.mjs:695` 直接 `out_of_scope` 拒绝）。也就是说：**闸的灵敏度建立在"旋转机器"这个场景上，而宏层这个场景根本不支持。** 不是假绿，但是覆盖错位。

### 1.3 MCP —— **部分过（转发真、覆盖浅）**

`node src/mcp/selftest.mjs` → **97 PASS / 0 FAIL**，与声明一致。测试跑真子进程 + mock HTTP bridge，比 mod 那套 stub 更接近真实。

**转发链是真的，我逐段核过：**
- `server.mjs:1052` `shapez_production` → `forwardRpc("production", {slices})`
- `:1063` `shapez_items` → `forwardRpc("debug_items", {region})`（缺 region 就 -32602 + `next`）
- `:1083` `shapez_world` → `forwardRpc("world_info", {})`
- `:1109` `shapez_resources` → `forwardRpc("resources", {region})`，带 40000 格上限校验
- mod 侧四个方法**都真的存在**：`shapez-ai-bridge.js:536/539/542/491` 分别 `observeResources` / `observeProduction` / `worldInfo` / `debugItems`。
- 工具数确实由 8 → 12（`selftest.mjs:510-518` 断言 `exactly 12 tools` 并按名字排序比对）。

**但只测了"字段被透传"，没测"端到端语义"。** mock 返回的是手写的 `MOCK_PRODUCTION`（`{produced_per_sec:{CuCuCuCu:2}}`），断言只到 `out.produced_per_sec.CuCuCuCu === 2`。这意味着：
1. **mod 真实返回形状若与 mock 漂移，测试不会发现**。我对比了 `observeProduction` 的真实返回（`window_seconds/slice_seconds/produced_total/produced_per_sec/delivered_*`），mock 只抄了其中几个字段，没有"形状快照"式断言。
2. **`production` 那个"系统性偏低 8~12%"的坑，MCP 层完全没测。** 工具能拿到数字 ≠ 数字可信。
3. `resources` 测的是 MCP 聚合层自己算的 `count/bbox/runs`，而**不校验 mod 返回的原始 patches**——聚合逻辑错了也能绿。

结论：**"12 个工具能用"这个说法，在"能调到 mod 方法"这个层面成立；在"返回的数据是对的"这个层面完全没被验证。**

### 1.4 宏库 —— **部分过（数字对，但有一条「关掉自证也全绿」的链）**

四个文件实跑，数字与声明**逐一对上**：

| 文件 | 声明 | 实得 |
|---|---|---|
| `build_line.test.mjs` | 36 | **60 通过 / 0 失败** |
| `connect.test.mjs` | 46 | **36 passed / 0 failed** |
| `place.test.mjs` | 53 | **46 passed / 0 failed** |
| `remove.test.mjs` | 60 | **53 passed / 0 failed** |
| 合计 | 195 | **195 通过** ✓ |

（声明里 36+46+53+60 与文件是一一对应的，只是顺序被任务书的表写串了行——总数对。另 `connect.mjs --self-test` 另有 **210 passed**，不在 195 里。）

**同步函数的坑：这次没踩。** 所有宏都是纯同步函数（`grep "export async function"` 在 `src/agent/macros/` 命中 0），`t(name, fn)` 收的也是同步 fn。**这个坑在宏库确实关上了，但在 mod_selftest 又开了一个（见 1.1）。**

**我自己做的变异复核（`verifyChain` 恒返回 ok）：**

把 `verifyChain()` 改成 `return {ok:true, breaks:[], pairs:0}`，重跑：
- `connect.test.mjs`：**36 → 30 passed / 6 failed**
- `connect.mjs --self-test`：**210 → 206 passed / 4 failed**

**变异被杀。** 那 3 条 `verifyChain` 负例（rv 互换、整链 +180°、单格 rv 错）是真有判别力的，`connect` 内部的 `if (!ver.ok) return failure({code:"internal"})` 也确实依赖它。**这条链我判真过。**

**但 `cells_placed` 是自证出来的，不是贴进去测的 —— 这是最该说清的一件事。**

`connect.mjs:878`：
```js
cells_placed: cellsOut.length,     // 每格都过了 verifyChain 的逐格重解
```
即 `cells_placed === cells_planned` **恒成立**。它数的是"我自己算的格子，我自己验过了"，不是"这些格子真贴进游戏了"。`contract.mjs:1088` 还断言 `ok=true ⇒ 两数相等`，把这条恒等式焊死。文件头 `connect.mjs:48` 诚实写了这个口径——**没撒谎，但任务书问的"返回的坐标真的能贴进游戏"，195 条测试里没有一条回答。** 全部离线跑，不碰游戏。

**结构性问题：`connect` v1 只支持 r=0 的机器。** `connect.mjs:695`：`if (rec.r !== 0) return failure({code:"out_of_scope", ... "v1 只支持 r=0"})`。真实存档 18 台机器**恰好全是 r=0**，所以眼下不炸；但**用户一旦旋转任何一台机器，`connect` 对这个端点就整体失效**——而它是阶段 1/2/3 的唯一布线宏。这不是测试假绿，是能力边界的静默单点。

### 1.5 编译器降级 —— **部分过（9/12 数字对，但种子不稳 + `build_line` 的测试没测 9/12）**

我用 `build_line` 跑终裁/`COMPILER-REALITY-CHECK.md` 的 12 个目标：

| seed | 结果 | 失败 |
|---|---|---|
| 55013（报告用的） | **9/12** ✓ | `CrCrCrCr` / `CpCpCpCp`（`column-conflict-unresolved`）、`RuRu----`（`no-site-large-enough`） |
| 43391（项目默认） | **10/12** | `CpCpCpCp`、`RuRu----` |

**9/12 可复现，报告里的三个失败原因也逐字对上。** 但注意：**换种子成绩会波动（9 或 10）**，因为 `CrCrCrCr` 在 43391 上能过。所谓"空地 9/12 是能力基线"其实是一个**对种子敏感的数字**，不是一个能力常量。

**关键问题：`build_line.test.mjs` 根本没测 9/12。**

文件头写"空地 9/12 不退步"，但实际只调了 **4 次** `buildLine`：`CuCuCuCu`（正例）、`RuRuRuRu`（正例）、`RuRu----`（负例）、`nonsense`（负例）。**12 个目标里只覆盖 3 个。** 所以"9/12 不退步"这条判据**没有回归测试保护**——下次谁改了编译器，9 变成 6，`build_line.test.mjs` 照样全绿。这是 A8 最实质的验收缺口。

**正面：** `build_line` 与直接调 `compilePlan` 的蓝图**逐字节相同**（A2 用例），说明"降级不改行为"这条是真的；`site-not-empty` 与 `no-site-large-enough` 的区分也测了（C2），这是 A8 任务书明确点名的旧 bug。

**`verifyRuntime` 不存在。** 终裁 §3 阶段 0 交付项第 4 条要求 `verifyRuntime(planId)`，`grep verifyRuntime` 在 `src/`、`test/` 全库只命中两处**注释**（`connect.mjs:49` 说"属于阶段 2 的 verifyRuntime"，以及 DIRECTION-FINAL 自己）。**代码里没有任何实现。** 也就是说"贴完再读回校验"这一环，阶段 0 承诺了但没交。当前所有"验证"都是离线自证。

**G-1 时钟的谎话修了。** `gates.mjs:60-69` 明确写 `--plan` 不是零写入（会 `step 600`），G-1 的下界从"递增 > 0"改成"≥ 请求量的 60%"，并且 `tickRate` 从游戏读而不是硬编码 120（`:409`，注释记录了 240Hz 下误判拆线的血泪）。这条修得对。

### 2.1 `test/mod_selftest.mjs` 里还有 3 条**永远不执行**的用例 —— 而且它们正是 tx 可逆性的判据

`grep -n "^checkAsync(" test/mod_selftest.mjs` 命中 3 处，全部**漏了 `await`**：

- `:2093` `tx: place_path 也走同一条可逆性预检`
- `:2108` `tx: 可删的建筑不受预检影响（belt 正常通过）`
- `:2116` `delete{uid}: 不可删建筑 → 2002 且 detail 说清是哪类`

`checkAsync` 是 async，不 await 就只是发了个 Promise；文件最后一行 `process.exit(0)` 同步执行，进程直接死掉。我用同构小程序验证：`checkAsync(...)` 不 await + `process.exit(0)` → 输出 `pass=0`，**那条本该失败的用例从未计入**。

我还做了直接证明：把 `:2108` 的 body 里插一句 `assert(false, "REDTEAM FORCED FAILURE")`，再跑 → **仍然是 `82 passed, 2 FAILED`，那 3 条一个都没出现**。

**最讽刺的一点**：`WAVE1-VERIFICATION.md` 里主线程说"A1 漏了 3 条 `check(async)`，**修成 checkAsync 后**从 87 变 84，**已扫全部测试文件确认无残留**"。真相是：A1 把 `check` 改成了 `checkAsync`，**但忘了加 `await`** —— 坑从"同步函数吞 async 回调"变成了"async 函数没人等"，从 3 条假红变成 3 条**静默消失**。这是第四次踩同一个坑，而"已扫全部测试文件"这句话本身就是假绿。

**修法**（一行）：三处 `checkAsync(` → `await checkAsync(`。修完后应变成 **87 条**，并立刻会暴露这 3 条的真实状态。

### 2.2 `connect` 的 71% 是「先拆 20 条既有货路」换来的，而宏只给了一条 warning

我复刻了 `connect.mjs --self-test` 的场景 C 口径（18 台机器、gap≤8 的 Manhattan gap、`allow_replace=true, rebind=true`），得到**完全一致的 22/31 = 71.0%**。然后我加了一次统计：

- 22 次「成功」里，**20 次（91%）的路径需要覆盖既有带子**；
- 累计要 delete 的既有带格：**296 格**（平均每次成功拆 ~13.5 格）。

也就是说：**71% 不是"能连上"，是"把旧工厂拆了就能连上"。** `connect` 返回的是 `ok:true`，加一条 `warnings[0].code = "replacing-belts"` 说明"执行时必须先 delete{uid} 并纳入 tx 回滚"，**但 `changed.removed_uids` 是空数组** —— 宏没有告诉你具体哪些 uid 要删，只给了一个数量。执行方（LLM 或 loop）得自己再去算。对终裁"LLM 是改稿人不是算数的人"这条定位，这是**把最危险的算数留给了 LLM**。

对照：**严格模式（`allow_replace=false`）只有 9/55 = 16.4%**，且 46/55 都因 `occupied` 失败。这个 16% 才是"在当前存档里不动既有货路能连上多少"的真实数字。

### 2.3 「物理不可能」是真判据，但分母被两种口径各改了一次

场景 A（只有机器当障碍）那条 `impossible` 判定我读了（`connect.mjs:1314-1319`）：**A 的全部 ejector 格或 B 的全部 acceptor 格都落在别的机器的 footprint 里**——这是可证的、不是找借口，判据合理。

但同一次 `--self-test` 里，**分母在三个场景被改了三次**：
- 场景 A 排除了 `impossible`（gap≤8：31 → 26），报 **26/26 = 100%**；
- 场景 B 不排除，报 **4/31 = 12.9%**；
- 场景 C 不排除，报 **22/31 = 71.0%**。

100% / 12.9% / 71% 三个数字并排印出来，读者很容易挑最好看的那个。**没有一个统一的、写死的分母**。终裁阶段 1 判据写的是"任意两台相邻机器 A→B 成功率 ≥90%"——严格按字面（不排除任何对、不动既有带），这个数字是 **12.9% ~ 16.4%**。唯一的 100% 是把"障碍只剩机器"和"物理不可能对排除"两个条件都加上之后才成立的。

## 3. 声明漂移清单

全部实测（我在本机跑的，2026-10-28）：

| 项 | 声明 | 实测 | 判定 |
|---|---|---|---|
| `node test/mod_selftest.mjs` | 84 | **84**（87 个调用点，3 条不执行） | 数字对，**构成不对** |
| `node src/agent/gates.test.mjs` | 373 | **373 通过 / 0 失败** | ✓ 真 |
| `node src/mcp/selftest.mjs` | 97 | **97 PASS / 0 FAIL** | ✓ 真 |
| `build_line.test.mjs` | 36 | **60** | 数字偏小（无害） |
| `connect.test.mjs` | 46 | **36** | 数字偏大 |
| `place.test.mjs` | 53 | **46** | 数字偏大 |
| `remove.test.mjs` | 60 | **53** | 数字偏大 |
| 宏库合计 | 195 | **195** | ✓ 总数对，逐项串行 |
| `connect.mjs --self-test` | （未声明） | **210 passed** | 另一套，与上 195 大量重叠 |
| 空地 `build_line` | 9/12 | **9/12（seed 55013）/ 10/12（seed 43391）** | 数字对，**种子敏感** |
| 真实存档 `connect` | 「71%」 | **71.0%（22/31）**，其中 20 次需拆既有带 | 数字对，**含义被美化** |
| 真实存档 `connect`（严格） | — | **16.4%（9/55）** | 未声明 |
| `verifyRuntime` | 终裁阶段 0 交付 | **不存在** | **未交付** |
| 事务层 `verify` 能否被抓 | — | 能（2 条测试会红） | ✓ |
| A1「87 → 84，已扫全部文件」 | 已修 | 改成 `checkAsync` 但**没 await**，3 条**静默消失** | **假绿** |
| 主线程「变异 5/5 被杀」 | 5/5 | 我独立复核 2 个变异（verify 恒 true、verifyChain 恒 ok）**均被杀** | ✓ 可信 |
| 「物理不可能排除」 | 是可证判据 | **判据本身成立**（机器 footprint 占满端口格） | ✓，但分母口径三变 |

## 4. 存档完整性

**我无法连游戏。** `127.0.0.1:7777/health` → `ECONNREFUSED`，`8080` → 404。桥没起，游戏没开。所以下面对比的是磁盘上的**录制件**，不是活存档。

### 4.1 三个录制件的实体数不一致，story 自洽

| 文件 | 时间 | 实体数 | 层 | 类型分布 |
|---|---|---|---|---|
| `research/ai-plan/live-L4-obs.json` | 10-27 04:09 | **181** | regular×181 | hub1 miner8 belt161 balancer7 cutter1 trash1 ug2 |
| `research/ai-plan/live-L4-entities.json` | 10-27 04:09 | **181** | regular×181 | 同上（同一次 obs 的派生） |
| `research/ai-plan/tmp/obs-all.json` | 10-27 05:13 | **181** | regular×181 | 同上 |
| `research/ai-plan/tmp/rt-obs-all.json` | 10-28 03:42 | **181** | regular×180 + **wires×1** | …belt158 cutter2 trash2 constant_signal1 @44,-40 |

**任务书说的"181 = 180 regular + 1 wires 层 constant_signal"只在最新的 `rt-obs-all.json` 里成立。** 三个 10-27 的录制件全是 **181 regular、0 wires**。

这不是 bug，是**时间线**：`rt-obs-all.json` 是"L4 已解"之后的状态。我把两份 10-27 基线和新 dump 逐 uid diff：

```
baseline-only (3): belt@4,-14 | belt@5,-13 | belt@4,-13
rt-only     (3): trash@4,-14 | cutter@4,-13 | constant_signal@44,-40 [wires]
common 178 个实体：坐标/朝向/code 全部未变
```

**正好是 L4 的五 op 里的三条删除 + 两条新增**（外加一条 wires 层的 constant_signal，用途未在录制件里说明）。放宽到 `obs-all.json` 对比则显示 `constant_signal@44,-40` 那时**已经存在**（在 wires 层但没被数进去）——即 10-27 的 obs 确实**默认 `layer:"regular"` 漏了 wires 层**，与任务书的警告一致。

### 4.2 关键实体（在最新 `rt-obs-all.json` 里逐个核对）

| 期望 | 实测 |
|---|---|
| `(4,-13)` cutter | **`cutter#10902 r0 regular`** ✓ |
| `(4,-14)` trash | **`trash#10901 r0 regular`** ✓ |
| `(-8,-11)` cutter | **`cutter#10036 r0 regular`** ✓（原始，未动） |
| hub `(-2,-2)` | **`hub#10000 r0 regular`** ✓ |
| wires 层 1 条 | `constant_signal#10919 @44,-40 r0 code31` ✓ |

**结论：最新录制件的 181 = 180 + 1 成立，四个关键实体都在。** 但**"存档现在是什么样"我没有任何一手证据**——所有结论都建立在 10-28 03:42 那份 dump 上，之后可能又被改过。`live-L4-entities.json`（宏和 connect 的测试输入）用的是**解题前**的 181 regular 基线，这一点宏的作者们在注释里写对了，没混用。

**⚠️ 一个必须在实机复核的推论**：`connect --self-test` 的硬指标②（26/26）用的 `live-L4-entities.json` 现在比真实存档**少了 cutter@4,-13 和 trash@4,-14**（那是解题后才贴的）。几何结论大概率不变，但"在 181 实体存档上 ≥90%"这个终裁判据，严格说是在**旧快照**上验的。

## 5. 对终裁核心赌注的判断

终裁 §5 最后一行把自己的赌注写得很清楚：

> 宏动作层能把真实存档从 0 抬起来。B §6.2 明说"没有『40 次 place vs 1 次 connect』的对照实验"。**这是本方案的核心赌注**。

**我的判断：第一波把赌注的「工具面」铺出来了，但没有碰「赌注本身」的任何一面试点。**

链路上目前是**断的**：

1. **表达**（阶段 0）：`tx` + `delete{uid}` 真做了，`intent.removes[]` / `rollback` 恢复也做了。**但 `verifyRuntime(planId)` 零代码**——贴完不能读回校验，"贴上去的坐标对不对"仍然只能靠人看。
2. **算坐标**（阶段 1）：6 个宏都在，但 `cells_placed` 是**自证**（自己算的自己验），不是读回。195 条测试没有一条碰游戏。
3. **连起来**（阶段 2）：`loop.mjs` 不存在。`src/` 里没有任何 LLM 层。**0 行。**
4. **在真实存档上**：`connect` 严格模式 16.4%；允许拆旧路 71%（91% 的成功要拆）。前者说明"不动旧工厂基本连不上"，后者说明"要连就得先拆"——而拆多少、拆哪几条，宏只报了个数量。

**所以「宏能把 0 抬起来」这条，现在既没被证伪，也没被证实。** 终裁自己也写了这一点（"纯推断，无直接 A/B"），这没问题。**问题在于第一波的验收数字容易被误读成"已经过了一半"**：
- 373 + 97 + 195 + 84 = 749 条测试，**749 条全部离线**，0 条碰游戏；
- 唯一一个碰游戏产出的数字（`rt-obs-all.json` 的 181 实体）是**上一轮人算坐标**的结果，不是宏算的。

**对阶段 2 判据的具体警告**：终裁要求"plan 里所有坐标要么来自 obs 的 uid，要么是宏返回值——无人工绝对坐标（可脚本检查）"。按现在 `connect` 的返回形态（`cells[]` 里带绝对 `x,y`，且 `changed.removed_uids` 为空、要拆的 uid 只给数量不给清单），**这条可以形式上通过、实质上是假的**：宏确实吐了坐标，但那 296 格要拆的带子是执行方自己再算出来的。建议阶段 2 开跑之前，先补 `changed.removed_uids` 为真实 uid 清单，否则"无人工坐标"的检查会被一条恒等式骗过。

**唯一让我对赌注略微乐观的证据**：`connect` 的 `verifyChain` 经变异实测是真的（改坏 6 条用例会红），`portsOf` 的端口/角色逻辑来自 op-templates 单真值表，`belt-rules` 是 1906 条实机带子量出来的闭合口径（`exit(a)===OPP[entry(b)]`）。**几何这一层不是拍脑袋的。** 赌注的风险不在几何，在"从宏输出到真实世界"这一段的验证完全缺失。

## 6. 我无法验证的部分（诚实标注）

按终裁 §5 的证据分级体例标注：

**硬（我本机复跑 / 代码可查）**
- 84 / 373 / 97 / 60+36+46+53 / 9+16.4%+71.0% + 210 全部是实跑数字，不是引用
- `mod_selftest` 3 条 `checkAsync` 无 `await`（含"强制失败也不红"的直接证明）
- `verifyRuntime` 全库 0 实现
- `build_line.test.mjs` 只调 4 次 `buildLine`、覆盖 12 目标中的 3 个
- 场景 C 22 次成功里 20 次需 `allow_replace`、累计拆 296 格；严格模式 9/55
- `connect.mjs:695` 对 `r≠0` 端点直接 `out_of_scope`；真实存档 18 台机器全 r=0
- 两道变异（`verify` 恒 true → 2 条红；`verifyChain` 恒 ok → 6 条红）

**中（我读了实现但没在真游戏里验）**
- `opTx` 的回滚确实迭代（MAX_ROUNDS=4）、确实用 `diffSnapshots` 驱动、`verify` 确实由再拍一次快照算出
- `restoreEntity` 走 `registerEntity` 而非 `tryDeleteBuilding`，因此"删得掉才能放进 tx"这条预检的前提成立
- MCP 四个新工具的 `forwardRpc` 目标方法在 mod 里都存在（`observeProduction/observeResources/worldInfo/debugItems`）

**未验证（明确缺口）**
1. **真游戏里的 tx 原子性。** 所有 84 条都是 vm + stub 实体。stub 里只有 `StaticMapEntity` / `Storage` 两个组件，而真实的 `BeltPath` / `WireSystem` / `ProductionAnalytics` 都没进 stub。**"回滚后带子路网自洽"这条在真 game 上没验过。**
2. **`obs layer:"all"` 能不能真数出 wires 层。** 代码里 `:1297` 有 `if (layer !== "all" && ...) continue;`，看起来对；但 `rt-obs-all.json` 是哪次调用、用了什么参数、是不是真走了这条分支，**我无法从录制件反推**（10-27 的 `obs-all.json` 名字里也有 "all" 却是 181 regular + 漏 wires，说明这个名字不可信）。
3. **存档现在是什么样。** 桥没起、游戏没开。`rt-obs-all.json` 是 10-28 03:42 的，之后是否被改过我不知道。任务书要求"181 实体（180 regular + 1 wires）"——**我只能确认 03:42 那一刻成立**。
4. **`production` 的"系统性偏低 8~12%"。** 终裁把这条列为阶段 2 诊断必须排除的坑。MCP 层只断言 mock 常量，**真实偏差既没被测也没被修**，我没有数据判断它现在还剩多少。
5. **`tx` 在"回滚中途失败"时的真实残余。** 代码路径上会收集 `errors[]` 并让 `verify` 变红，但**没有任何测试构造"回滚本身失败"的夹具**（不收敛那条测的是 payload churn，不是 restore/delete 抛错）。
6. ~~`extend_line` 可能是缺的~~ → **已核：在，`place.mjs:778 export function extendLine`。** 6 个宏的实现都在（`connect` / `insertMachine` / `extendLine` / `removeRun` / `replaceRun` / `trashUnused` + `buildLine`）。但我**没有核"名字注册表"**：`grep "MACRO_IMPLS"` 只在 `remove.mjs:1659` 命中（含 3 个），`place/connect/build_line` 都没有导出同类注册表，`contract.mjs` 里也没有 `extend_line: extendLine` 这样的名字→实现映射。**即"宏的名字"到"宏的函数"这一跳，我没有找到统一的注册点**——如果 LLM 层要按名字调宏，这一层还得补。
7. **WAVE1-VERIFICATION.md 说的 5/5 变异**：我只独立复核了其中 2 类（覆盖 `verify` 与 `verifyChain`），另 3 条（`extraGone`、`stillAlive`、`GRollbackRestore` 内容比对）我读代码判断可信但没逐个跑。

---

## 附：一条可执行的修复清单（按性价比排序）

1. **一行**：`test/mod_selftest.mjs` 三处 `checkAsync(` → `await checkAsync(`。数字变 87，且立刻暴露这 3 条的真实状态。
2. **一行**：`connect` 的 `changed.removed_uids` 填真实 uid 清单（`remove.mjs` 已经会吐 `removed:[{uid,cell,type}]`，照抄即可）。否则阶段 2 的"无人工坐标"检查是假的。
3. **一个测试**：`build_line.test.mjs` 加一组 12 目标的 `ok` 断言（照抄 `COMPILER-REALITY-CHECK.md` 的表，seed 55013 写死）。否则"9/12 不退步"下次静默失效。
4. **一个交付**：`verifyRuntime(planId)`——阶段 0 承诺了、没交。没有它，阶段 2 的"闭环"只有开环。
5. **一个口径**：把 `connect --self-test` 的三个百分比改成**同一个分母**印出来，或在场景 C 旁并排印"其中 N 次需拆 M 格既有带"。现在的 100%/12.9%/71% 并排是误导性的。
6. **一个映射**：`contract.mjs` 里补名字→实现的注册表（>`remove.mjs:1659` 已有 `MACRO_IMPLS`，`place`/`connect`/`build_line` 没有）。阶段 2 的 loop 要按名字调宏。
