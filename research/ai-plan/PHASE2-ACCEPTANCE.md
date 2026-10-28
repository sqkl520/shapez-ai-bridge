# 阶段 2 验收审计

日期：2026-10-28（审计者：独立验收 agent）
基线：`HEAD = 2b6474d`（工作区另有未提交的 gates.test / mcp / compiler 改动，见 §A-0）
环境：**纯离线**。桥接 `127.0.0.1:7777` 连接被拒（`curl` 返回 `000`，`scripts/smoke_test.mjs` 0/5），游戏未启动。全程未碰游戏实例。

---

## 一句话结论

**部分达成——但核心赌注「宏动作层能把真实存档从 0 抬起来」目前仍是「未证实」，不是「证实」，也不是「证伪」。**

最关键的一条理由：**仓库里唯一能离线全绿的计划，是一个把 `B81/B82/B69` 三个句柄写死在测试夹具里的复盘脚本；而这三个句柄在冷启动 prompt 里根本不出现。**我用 prompt 实际渲染结果枚举了 670 个「只用 prompt 可见句柄 + 只用检索表给的候选宏」的计划，**在未修改的仓库代码上，能走到 verify 且 L1+L2+L3 全绿的是 0 个**。所以阶段 2 到现在证明的是「决策链能走通」，**没有**证明「没人算坐标也能打通」——因为那个"没人算坐标"的正解，是测试作者先看过答案才写出来的。

---

## A. 实测输出

### A-0 复跑前的状态确认

```
$ git log --oneline -1
2b6474d feat(loop): 主状态机完成 + 修掉一处会让 provenance 变成伪证的漏洞

$ git status --porcelain src/
 M src/agent/gates.test.mjs        ← 未提交：+80 行（两条新的负例，见 §B-3 注）
 M src/ai/compiler/cli.mjs         ← 不属于阶段 2
 M src/ai/compiler/compile.mjs
 M src/bridge/selftest.mjs
 M src/mcp/selftest.mjs
 M src/mcp/server.mjs

$ wc -l src/agent/loop.mjs src/agent/loop/*.mjs
  1997 src/agent/loop.mjs        ← 报告说的 1997 行，对
   329 src/agent/loop/constants.mjs     616 coords.mjs    429 handles.mjs   490 llm.mjs
   203 offline_boundary.mjs   655 planToTxOps.mjs   688 prompt.mjs   561 verify.mjs
```

### A-1 六个指定的套件（实跑）

```
$ node src/agent/loop.test.mjs
loop 自测：156 通过 / 0 失败                              exit=0

$ node src/agent/loop_pipeline.test.mjs
loop_pipeline 自测：36 通过 / 0 失败                      exit=0

$ node src/agent/loop/offline_boundary.mjs
offline_boundary 自测：19 通过 / 0 失败                   exit=0

$ node src/agent/coldstart_l4.test.mjs
coldstart_l4 自测：28 通过 / 0 失败                       exit=0

$ node src/agent/verify_runtime.test.mjs
verify_runtime 自测：107 通过 / 0 失败                    exit=0

$ node src/agent/gates.test.mjs
gates 自测：400 通过 / 0 失败                             exit=0
```

**关于"1693 条测试"的说法**：我逐文件实跑并累加，全仓 `*.test.mjs` **共 1771 条通过 / 0 失败**：

| 套件 | 通过 | 套件 | 通过 |
|---|---|---|---|
| gates | 400 | verify_runtime | 107 |
| loop | 156 | loop/handles | 85 |
| loop/prompt | 154 | loop/planToTxOps | 81 |
| loop/llm | 148 | loop/coords | 79 |
| loop/verify | 75 | macro_execution_ops | 75 |
| macros/remove | 68 | macros/build_line | 60 |
| macros/place | 54 | loop/constants | 42 |
| macros/connect | 40 | loop_pipeline | 36 |
| macros/contract | 32 | coldstart_l4 | 28 |
| fake_game | 28 | ai/belt-rules | 17 |
| clock.mock | 6 | **合计** | **1771** |

拆开看：`gates` 的 **27 条来自未提交的工作区改动**（`git show HEAD:src/agent/gates.test.mjs` 跑出来是 **373**）。所以**已提交状态 = 1744 条**，工作区 = 1771 条。**"1693" 这个数我复现不出来**（既不是 1744 也不是 1771）；差 78 条，可能是某次统计口径不同或跨了一个提交。以本表为准。

另：`research/ai-plan/` 下还有 5 个独立套件（op-templates 385、world 51、placer 269、router 207、emitter 303），**不属于阶段 2 的 loop**，未计入上面 1771。

### A-2 我自建的端到端（用**官方** `l4-coldstart` 夹具）

脚本：`.tmpverify/audit/e2e.mjs`（可复跑）。`FakeGame.fromFiles(L4-obs.json, null, {goal:"RuRu----"})` + `MockLLMClient({dir:"test/fixtures/llm", scenario:"l4-coldstart"})`。

```
=== RETURN ===
{ "outcome": "halt", "reason": "MOCK_EXHAUSTED", "level": "none",
  "rounds": 2, "llm_calls": 2, "tx_count": 0, "verdict": null,
  "preserved": { "world_state": "untouched", "last_successful_round": 0 } }

=== TRANSCRIPT ===
{"kind":"run_start","seq":1,"goal":"RuRu----","mode":"mock","dry_run":false}
{"kind":"observe","seq":2,"tick":96919.19,"entity_count":181,"world_hash":"fnv1a64:fd7bc3b920c64dbb:n=181","problems":[]}
{"kind":"diagnose","seq":3,"codes":["NO_PRODUCTION"]}
{"kind":"repair_decide","seq":4}
{"kind":"propose","seq":5,"plan":["replace_run"],"error":null}
{"kind":"plan","seq":6,"ok":false,"rejected":"MACRO_REFUSED","stage":"macro","ops":null}
{"kind":"repair_decide","seq":7}
{"kind":"observe","seq":8,...}                                     ← 世界 hash 完全没变
{"kind":"diagnose","seq":9,"codes":["NO_PRODUCTION"]}
{"kind":"repair_decide","seq":10}
{"kind":"propose","seq":11,"plan":null,"error":"MOCK_EXHAUSTED: ... no fixture for call #2"}
{"kind":"run_end","seq":13,"outcome":"halt","reason":"MOCK_EXHAUSTED","level":"none","achieved":null}
```

**这是官方夹具的真实结论：0 次 tx、世界零写入、什么都没打通。**夹具的 `meta.json` 自己也写了「不要求执行成功」，所以这不是 bug；但**阶段 2 的官方冷启动夹具本身跑不通**，这一点必须被明确记录——它不是"跑通了"的演示件。

### A-3 我自建的端到端（用**能走通**的计划）

脚本：`.tmpverify/audit/e2e2.mjs`。同一存档、同一个 `MockLLMClient`，只是把夹具里的句柄换成 `B81/B82/B69`（= 测试作者先知道的那三个 uid 的句柄），并给 FakeGame 补了两条手写 path（见 §B-1、§B-2 的说明）：

```
=== RETURN ===
{ "outcome": "halt", "reason": "OFFLINE_ONLY", "level": "offline-only",
  "rounds": 1, "llm_calls": 1, "tx_count": 1,
  "verdict": { "achieved": false, "level": "offline-only",
               "why": ["离线（mode!=live）跑通：证明决策链走通，**不构成阶段 2 达成**"] } }

=== TRANSCRIPT ===
run_start → observe → diagnose["NO_PRODUCTION"] → repair_decide → propose
→ plan{ok:true, ops:5, provenance:{tagged:5,untagged:0}}
→ apply{tx_ok:true, applied:5, rolled_back:false, why:[]}
→ verify{checks:[L0:true, L1:true, L2:true, L3:true, V-undeclared:true, V-obs-flow:true, A-tx:true],
         level:"offline-only", achieved:false, goal_delta:0}
→ run_end{outcome:"halt", reason:"OFFLINE_ONLY", level:"offline-only", achieved:false}

=== 最终世界（目标区）===
cutter@(4,-13)  trash@(4,-14)   ← 3 条旧带子 (10209/10149/10143) 已不在
```

**这条链路是真的能跑起来的**：5 个 op、provenance 全挂上、世界真的按计划变了。`offline-only` 这个结论也是诚实的（不是 success）。**它证明的是决策链，不是阶段 2 达成。**

### A-4 CLI

```
$ node src/agent/loop.mjs --goal RuRu---- --mock l4-coldstart --run-dir <tmp>   → exit=2 (halt)
$ node src/agent/loop.mjs --goal RuRu----                                      → exit=1 (必须给 --mock 或 --llm)
$ (unset ANTHROPIC_API_KEY) node src/agent/loop.mjs --goal RuRu---- --llm      → exit=1，报 LLM_NO_API_KEY
$ ANTHROPIC_API_KEY=sk-dummy node src/agent/loop.mjs --goal RuRu---- --llm     → exit=1，obs 读失败 → INTERNAL
```

CLI 的三种退出码（0/2/1）与契约一致，且"不给 mode 就不猜"这条防线是真的。

---

## B. 假绿排查

每条：形态 / 结论 / 证据 / 是否已防住。

### B-1 **离线当达成** —— 防住了，而且这一条我攻不动

- **`run_end.level` 离线时是什么**：`offline-only`；`achieved` 是 `false`。见 A-3 的实际输出。
- **哪个测试断言 `outcome==="success"`**：**一个都没有**。`grep -rn 'outcome, "success"' src/` 在 loop 相关测试里 0 命中；4 处都是 `ok(res.outcome !== "success")`（`loop.test.mjs:349/399/518/687`）。
- **证据**：`offline_boundary.mjs:phaseTwoVerdict` 只在 `mode==="live" && goalDelta>0` 时返回 `level="live"`；`loop.mjs:1706` 的 `if (verdictNow.level === "offline-only")` 显式 halt 并写 `OFFLINE_ONLY`。
- **变异测试**：把 `phaseTwoVerdict` 的返回改成 `{achieved:true, level:"live"}`（`.tmpverify/audit/matrix.mjs` 的 M2）→ **loop 套件 8 条红、boundary 套件 4 条红**。防线不是空的。
- **结论**：这条我攻击不动。

**但有一个相邻的洞**（不是"离线当达成"，是"达成时不看检查项"），见 §B-7。

### B-2 **判据读错字段** —— 逐字段核对后：**全部对得上**（这条也攻不动）

`strictVerdict`（`src/agent/loop/verify.mjs:262-345`）读的每个 evidence 字段，逐个 grep 对照 `verify_runtime.mjs`：

| strictVerdict 读的字段 | 由谁产出 | 存在？ |
|---|---|---|
| `ev.goal_delivered_before` | `checkBehavior` evidence（`verify_runtime.mjs:794`） | ✅ |
| `ev.goal_delivered_after` | 同上 | ✅ |
| `ev.goal_delivered_delta` | 同上 | ✅ |
| `ev.delivered_in_window_after` | 同上 | ✅ |
| `ev.shape` | 同上（`:791`） | ✅ |
| check `L0-observation` | `verify_runtime.mjs:887/894` | ✅ |
| check `L1-landing` | `:426/431/438` | ✅ |
| check `L2-slots` | `:582/586/592/597/604/609` | ✅ |
| check `L3-flow` | `:626/630/688/693/698/722/728` | ✅ |
| check `L4-behavior` | `:760/762/810/815/818` | ✅ |
| `report.error` | `:868/874/882` | ✅ |
| `report.uidDiff` | `verifyRound` 传入（`loop/verify.mjs:541`） | ✅ |

脚本 `.tmpverify/audit/b2.mjs` 可复跑。**没有发现 `produced_delta` / `results[i].mismatch` 那类"引用了不存在的字段"的历史错误复现。**`strictVerdict` 的注释里还专门写了为什么会踩过这两个坑——说明这一轮确实在防它。

一处**次要观察**（不是错，但是弱化）：`ev.shape` 的守卫是 `if (goalShape && ev.shape && ...)`。若 `ev.shape` 缺失则**跳过**形状核对。实际 `checkBehavior` 一定填 `shape`（我实测过，`evshape.mjs`），所以当前不可利用；但这是一个"缺字段 ⇒ 放行"的方向，与项目其它地方"缺字段 ⇒ 判红"的纪律相反。

### B-3 **防线空转** —— 五条全测；**四条抓到、一条抓到但抓不狠**

用 `.tmpverify/audit/matrix.mjs` / `matrix2.mjs` 做变异矩阵（每个变异体跑完立即从 `.tmpverify/audit/bak/` 恢复，恢复后 6 个套件复跑全绿，`git diff src/agent/loop* src/agent/verify_runtime.mjs` 为空）。

| 变异体 | 结果 | 抓它的套件（红条数） |
|---|---|---|
| **M1** `assertNoHumanCoords` → `return {ok:true}` | **抓到** | loop (18)、pipeline (8)、coords (3)；coldstart 0、gates 0 |
| **M2** `phaseTwoVerdict` → `achieved:true, level:"live"` | **抓到** | loop (8)、boundary (4) |
| **M3** `applyVerdict` 的 `rolled_back` 检查 → `if(false)` | **抓到，但只在单元层** | verify.m 单元 (4)；**loop 集成 0** |
| **M4** `deriveFlows` 的 `from===to` 过滤 → 关掉 | **抓到** | planToTxOps (4)；pipeline 0 |
| **M5** `checkBehavior` 的 `deliveredHappened` → `true` | **抓到** | verify_runtime (8)；loop 0 |
| M6（附加）`strictVerdict` 的 goal-null 守卫 → `if(false)` | 抓到 | verify.m (4) |

**注 M1**：`assertNoHumanCoords` 改成恒真后，`coords.test.mjs` 有 3 条红、`pipeline` 8 条红、`loop` 18 条红——**说明坐标禁令有三层独立的锚**，这是好的。但 `coldstart_l4.test.mjs` 和 `gates.test.mjs` **完全没红**（它们本来就不经过 coords 层，这是分工，不是漏洞）。

**注 M3（值得跟进的那一条）**：`applyVerdict` 的 `rolled_back` 分支**只在 `verify.test.mjs` 里被单元测到**。`loop.test.mjs` 里没有任何一个用例让 `apply` 返回 `rolled_back:true`——`grep -n "rolled_back: true" src/agent/loop.test.mjs src/agent/loop_pipeline.test.mjs` → **0 命中**。我手动注入了一个 rollback tx 跑 `runLoop`（`.tmpverify/audit/rollbackpath.mjs`），确认**代码路径是通的**：

```
apply {"tx_ok":false,"rolled_back":true,"uid_set_equal":false,
       "why":["tx.ok=false","tx.rolled_back=true —— 世界已还原","回滚后世界没洗干净（uid 集合不等）→ 硬停"]}
run_end {"outcome":"halt", ...}  → reason TX_ROLLED_BACK
```

所以：**实现是对的，但 loop 层没有回归锁**。哪天有人把 `if (av.hardStop)` 写坏，测试全绿。

### B-4 **测试从没执行（未 await 的 async 断言）** —— 这一代防住了；**上一代有真实前科**

- `loop.test.mjs` / `loop_pipeline.test.mjs` / `coldstart_l4.test.mjs` / `gates.test.mjs` / `loop/*.test.mjs` 的 `ok()` **都有 Promise 守卫**：`if (cond && typeof cond.then === "function") { fail++; ... }`。我用 `await` 检查脚本扫了全部 21 个 `*.test.mjs`，没有找到"定义了就再没被 await 的 async 断言"。
- `fake_game.test.mjs` 更进一步：`check()` 返回一个 **thenable** 并登记到 `unconsumed` 集合，汇总时若有未消费的就直接判红（`fake_game.test.mjs:30-38, 308-320`）。这个防护是**这一轮新加的**，值得表扬。
- **但前科仍在文件里**：`gates.test.mjs:1133` 附近的注释直接写着「变异报告 G9：删掉 `unresolved.push(...)`，373 条全绿」；`gateGDeleteReplay` 的 `unresolved` / `cellMismatch` 两条判据**从来没有独立生效过**（都是被"多删"兜红的）。工作区那 +80 行未提交改动就是补这个洞的（新增 27 条断言，且每条都钉了 evidence 的具体字段）。**这意味着：已提交的 1744 条里有 2 条判据是没有独立锚的。**这不算"测试没执行"，算"测试执行了但没测到点上"。

### B-5 **夹具与断言不符（拿 L5 当 L4）** —— 防住了，且是硬防

- `FakeGame.fromFiles(..., {goal})` 在构造期断言目标形状（`fake_game.mjs:104-111`）。
- 所有直接 import `FakeGame` 的地方**都传了 `{goal}`**：`coldstart_l4:187`、`fake_game.test:61/72/85`、`planToTxOps.test:45`、`verify.test:46`、`loop.mjs:1948`（CLI）、`loop.test:77`、`loop_pipeline:46`。只有 `fake_game.test.mjs` 的十几个纯读取面用例不传——但那些用例**同时读了 L4 与 L5 并对拍**（`:50-53` 断言两者 goal 不同、都是 181 实体），所以不会静默换关。
- 反向也测了：`FakeGame.fromFiles(L5-obs.json, ..., {goal:"RuRu----"})` 必须抛（`fake_game.test.mjs:82`）。
- **一条我差点误报的**：`loop_pipeline.test.mjs:136` 写的是 `const B69 = H.byUid.get(10209), B82 = H.byUid.get(10149), B81 = H.byUid.get(10143)` —— **变量名与真实句柄是错位的**（真实是 B81=10209、B82=10149、B69=10143）。它后面只用这三个变量做"有没有句柄"的存在性断言，**没有用到名字**，所以不构成假绿；但这是一个会误导下一个人的命名 bug。**这不是我攻击不动的点，是它错了但无害。**

### B-6 **`success` 分支是死代码** —— **确认：整个仓库没有任何测试执行过它**

用文件标记插桩（`fs.appendFileSync(process.env.AUDIT_MARK, ...)` 放在 `if (verdictNow.achieved)` 里，`.tmpverify/audit/patch.cjs`）：

```
src/agent/loop.test.mjs        hits=0
src/agent/fake_game.test.mjs   hits=0
src/agent/coldstart_l4.test.mjs hits=0
src/agent/loop_pipeline.test.mjs hits=0

（正对照：我自己构造的 live + goalDelta>0 场景 hits=1，且 outcome="success"）
```

**结论：`outcome==="success"` 这条路径**——包括 `st.lastSuccessfulRound` 的赋值、`run_end` 里 `info === "success"` 时不写 `HALT.json` 的分支、CLI 返回 0 的分支——**在仓库里从未被执行过**。正对照证明插桩是有效的，所以这不是"插桩没生效"。

**这不是 bug，是风险**：`runLoopCli` 的退出码 0、`preserved` 里 `last_successful_round` 的语义、`HALT.json` 的"成功时不写"——这三处行为**只在纸面上存在**。上实机第一次跑通时，它们会**第一次**被真实执行。

### B-7 **我发现的一个真洞（不在任务书列表里，但属于同一族）**

**`phaseTwoVerdict` 用 `checks` 参数只判"可信度"，不判"红绿"。**

`offline_boundary.mjs:phaseTwoVerdict` 里，`checks` 只传给 `classifyChecks`（判断哪些检查在离线不可信），**`ok:false` 的检查项被完全忽略**。判据只看 `strictOk && cls.ok && goalAdvanced`。

`loop.mjs:1668` 因此依赖 `report.strict`（`strictVerdict`）来承载"有没有红"。但 `strictVerdict` **不读** `A-tx`、`V-obs-flow`、`V-undeclared-destruction` 之外的某些项（它读 L0–L4 + 任何 `undecidable`；`A-tx` 和 `V-obs-flow` 的 `ok:false` 不进 `why`）。

**实测（`.tmpverify/audit/vobsreal4.mjs`，注入一个"V-obs-flow 必红"的 reader）**：

```
outcome: success   level: live   achieved: true
checks: L0:true L1:true L2:true L3:true L4:true V-undeclared:true V-obs-flow:FALSE A-tx:true
hardFails: ["V-obs-flow"]
```

**`runLoop` 写出了 `outcome:"success"`，而同一行 verify 里有一条红。** `hardFails` 被算出来、被写进 transcript，**但没有参与 `achieved` 的判定**（`loop.mjs:1672` 算，`:1696` 只看 `verdictNow.achieved`）。

同类还有 `A-tx`：`phaseTwoVerdict({mode:"live", strict:{ok:true}, checks:[...A-tx:false], goalDelta:70})` → `achieved:true`（`.tmpverify/audit/atxgap.mjs`）。`strictVerdict` 确实不看 `A-tx`；它在 apply 阶段另有 `av.hardStop` 会先 halt，所以**当前不可直达**——但这是"恰好被另一条路挡住"，不是"判据完整"。

**严重度**：中。真实运行时 `V-obs-flow` 红意味着"obs 里的带子链走不通"，这在真实世界通常伴随 L3 也红（L3 读 paths，V-obs-flow 读 obs 几何），两条同时错才会露出这个洞。但它确实是「一条红 + achieved=true」这种最不该出现的形态。

---

## B-x 另外三条我攻击过、但**攻击不动**的

1. **坐标禁令的三层分工**（parse 只判语法 / coords 判字面坐标 / provenance 复核落盘值）：`loop_pipeline.test.mjs` 有一条**对照实验**（`skipCoords` 后同一输入不再被拦），证明这条防线不是"因为别的层拦了所以看起来有效"。这一条我攻不动。
2. **`verifyMacroTokenCoords`**（`loop.mjs:929`，本轮新增的 ⑤b 层）：`coords.mjs` 的 `macro:` 标签只校验"token 在不在集合里"，不校验"token 里的坐标与 op 的 (x,y) 是否一致"。loop 在自己的适配层补了这条。我实测把 `place.x` 加 1 → 红，且报出 `op在5 / token说4`。这一条我攻不动。
3. **`applyVerdict` 不读 `tx.verify` 当成功证据**：成功时 `tx.verify` 是 `null`（真 tx 的行为，`bridge:3361`），失败时才有。代码里显式注释了这一点，且 `fakeTx` 也恒返 `verify:null` 来对齐。这一条我攻不动。

---

## C. 达成度分级表

| 能力 | 状态 | 依据 |
|---|---|---|
| 六阶段状态机（observe→diagnose→propose→apply→verify→repair） | **已证明** | `loop.test.mjs` 156 条；transcript 9 种 kind、seq 连续、run_end 必写；我复跑全绿 |
| run_end 必写（含异常路径） | **已证明** | `loop.test.mjs` §2 注入 verify 阶段异常 → `run_end` 仍写出、`level:"none"`、`preserved.files` 齐全 |
| 每条 halt 有机器可检原因 | **已证明** | `HALT_REASONS = DIAG_CODES + OFFLINE_ONLY + DRY_RUN`，测试断言不重不漏；`DIAGNOSE_CODES` 闭集 |
| 坐标禁令（LLM 输出里不许有字面坐标） | **已证明** | 变异 M1 → 三套件共 29 条红；对照实验证明不是空的 |
| provenance（每条落盘坐标可溯源） | **已证明** | `loop_pipeline`：5 条 op 全 tagged、0 untagged；把 x+1 → `COORD_PROVENANCE` 红；三种来源闭集 |
| 离线全绿**不得**读成达成 | **已证明** | 变异 M2 → 12 条红；4 处 `outcome !== "success"` 断言；`phaseTwoVerdict` 的 `level` 三态 |
| 预算与"同一指纹 3 次"停手 | **已证明** | `loop.test.mjs` §5/§6（ROUNDS_MAX=1 → `BUDGET_ROUNDS`；同码 3 次 → halt） |
| `strictVerdict` 的字段全部真实存在 | **已证明** | §B-2 的逐字段表，12/12 对得上 |
| L4 判据的"产出≠交付"修正 | **已证明** | 变异 M5 → verify_runtime 8 条红（含旧 bug 回归用例） |
| `deriveFlows` 不自环 | **已证明** | 变异 M4 → planToTxOps 4 条红 |
| `applyVerdict` 的回滚硬停 | **已实现，单元证明，集成未验证** | verify.test 4 条；loop 层 0 条（我手动注入确认代码通，但没有回归锁） |
| **prompt 里含"要改哪几条带子"的信息** | **未做到（这是核心缺口）** | 见 §E。161 条带子只列 12 条，B69/B81/B82 排第 68/80/81 位，**prompt 里一个都不出现** |
| 检索（retrieve） | **未做：第一版是静态表** | 无 `retrieve.mjs`；`RETRIEVAL_TABLE` 是 `code → [macro,...]` 的硬编码表；冷启动首轮给的是 `connect/insert_machine/trash_unused`——**不含 `replace_run`**（即不含 L4 的正解宏） |
| `success` 分支 | **已实现，从未执行** | §B-6 插桩 0 命中；正对照 1 命中 |
| `--resume` | **未做（显式声明）** | `loop.mjs:1752` `resume: null` + note；CLI 无此参数 |
| 真桥读取面 `makeBridgeReader` | **未验证** | 全仓 0 个测试 import 它；桥接离线，无法实测 |
| `reader.tx` 写面 | **未验证** | `loop.test.mjs` 里 0 处 `reader.tx`；全部走 `game.apply`（fakeTx） |
| 实机跑通 L4 | **未做** | 桥接离线；本次审计未碰游戏 |
| 连续 5 次独立尝试 ≥3 次成功（阶段 2 判据 3） | **未做** | 需要真 LLM + 真游戏；离线无法完成 |
| LLM 真调用（`AnthropicClient`） | **未验证** | 只有 fakeFetch 的单元测（`llm.test.mjs:181-192`）；无真实录制件（`find -name "round-01.txt"` → 0） |

---

## D. 上实机的前置条件（按优先级）

### P0 —— 不做的话，实机跑一次只是烧钱

**① 让 prompt 能看到"要改的地方"。**
- **为什么必须**：现在 prompt 只列 12/161 条带子（按句柄顺序补足），L4 要改的三条在第 68/80/81 位，**一条都不出现**。首轮诊断 `NO_PRODUCTION` 只点名 `H1`（hub），于是 `referencedHandles` 抓不到任何带子，12 个名额全被 `B1..B15` 占满（都是另一条产线的远端）。我枚举了 670 个"只用 prompt 可见句柄"的计划，**148 个能过 plan，没有一个能让 L1+L2+L3 全绿**（`.tmpverify/audit/realgreen.mjs` / `feasible.mjs`）。
- **不做会怎样**：真 LLM 只能从 58 个可见句柄里挑，**结构上不可能**产出 L4 的正解；loop 会稳定地 halt 在 BUDGET 上，而我们会误读成"LLM 能力不够"。
- **怎么验证做完**：新增一条断言——「给定 L4 冷启动，prompt 里必须出现那三条待改造带子的句柄（B69/B81/B82）」，或更强的：「至少一条『能把 L4 打通』的计划，其所有句柄都在 prompt 里」。可以在 `loop_pipeline.test.mjs` 里写：枚举式地断言"存在性"（存在一个 prompt-可见计划能全绿），而不是只测一个写死的计划。
- **工作量**：1–2 人日。可能的修法：按"诊断相关机器 → 其上下游带子"扩展（`L3 balancer@(4,-16)` 的输入就是 `B63/B64`，离改造点一格）；或按"出口断头/无产线的 hub 入口反向追溯"。

**② 让"达到"必须所有 check 都绿（补 §B-7 的洞）。**
- **为什么必须**：我实测过 `outcome:"success"` + `verify.V-obs-flow:false` 同时出现。上实机时若 `V-obs-flow`（obs 版连通性，独立于 L3 的第二证据）红而其它绿，`runLoop` 会宣称成功。
- **怎么验证做完**：`phaseTwoVerdict` 的入参应为 `{strict, allChecks}` 且对 `ok===false && !skipped` 的项一律不达成；或在 `loop.mjs:1696` 前加 `if (hardFails.length) → 不 success`。加一条注入式测试（像我 `.tmpverify/audit/vobsreal4.mjs` 那样）。
- **工作量**：0.5 人日。

**③ FakeGame 必须写 `code`（离线保真度）。**
- **为什么必须**：`fake_game.apply` 只写 `rotation_variant`，从不写 `code`（`fake_game.mjs:202-214`）。而 `planToTxOps` 会给 `insert_machine`/`trash_unused` 的 placement 挂 `code`（`planToTxOps.mjs:171`、`:211`）。于是**所有用这两个宏的计划，离线 L1 必红**（`wrong_code: want 9, got null`）。反过来，`replace_run` 的 machine placement 是 `code:null`，所以**它恰好不受影响**——这就是为什么只有那条写死 B81/B82/B69 的计划能全绿。这不是"离线近似"，这是**离线对宏的偏好**：它系统性地惩罚 `insert_machine`、偏爱 `replace_run`。
- **实测**（`.tmpverify/audit/feasible2.mjs`）：给 FakeGame 补上 `code`（cutter=9/trash=20/balancer=4）后，同一批 148 个可行计划里 **78 个 L1+L2+L3 全绿**；不补则 **0 个**。
- **不做会怎样**：任何"离线 A 方案可行、B 方案不可行"的结论都可能是脚手架造成的。上实机前的所有方法比较都会带这个偏差。
- **怎么验证做完**：`fake_game.test.mjs` 加一条「apply 一个 cutter 后 `code === 9`」；并重跑枚举，确认"全绿计划数"不再因宏种类而系统性倾斜。
- **工作量**：0.5 人日。

### P1 —— 实机前应该补上的回归锁

**④ loop 层的回滚路径测试。**
- **为什么必须**：`applyVerdict` 的 `rolled_back` 硬停只在单元层有锁。loop 层 0 条（§B-3 注 M3）。
- **怎么验证**：`loop.test.mjs` 加一个用例，`apply: async () => ({ok:false, rolled_back:true, verify:{uid_set_equal:false}, ...})`，断言 `outcome:"halt"`、`reason:"TX_ROLLED_BACK"`、`HALT.json` 写出。
- **工作量**：0.2 人日（我已有可复用的脚本 `.tmpverify/audit/rollbackpath.mjs`）。

**⑤ `success` 分支的首次执行测试。**
- **为什么必须**：§B-6 证明它从未被执行。上实机第一次成功时，`run_end` 不写 `HALT.json`、CLI 返回 0、`preserved.last_successful_round` 这些行为**第一次**生效——出错也没有前例可参。
- **怎么验证**：用 FakeGame + 注入 `setDelivered`（`fake_game.mjs:230` 已有这个方法）+ `mode:"live"` 跑一次 success，断言 `run_end.outcome==="success"`、`level:"live"`、**`HALT.json` 不存在**、`preserved.last_successful_round === rounds`。
- **工作量**：0.5 人日。

**⑥ `makeBridgeReader` / `reader.tx` 的合约测试。**
- **为什么必须**：这两个是实机唯一的读写面，全仓 0 个测试。`makeBridgeReader.obs` 的参数必须与 `verify_runtime.mjs` 的 `BRIDGE_READER` 逐字一致（`loop.mjs:1878` 的注释这么写，但没有测试守）。两处口径不同 = 两份世界，而 `undeclaredDestruction` 靠两份 obs 的 uid 差集。
- **怎么验证**：用本地 HTTP 假桥（`gates.test.mjs` 已有 `withMockBridge` 的模式）断言两个 reader 发出的 params 逐字相等；断言 `tx` 走 `act{op:"tx",ops}` 且读 `results[i].uid`。
- **工作量**：1 人日。

**⑦ FakeGame 的 `code` 之外，还有 `paths` 的手写脚手架要正视。**
- **为什么必须**：`loop.test.mjs:87` 的 `readerWithRebuiltPaths` 手写了两条 path（`[[4,-14]]→trash`、`[[5,-14],[5,-15]]→balancer@4,-16`）。离线 L3 全绿**完全依赖它**（我实测：去掉 → L3 红；换成错误路径 → L3 红）。这本身是诚实的（注释里写了），但它意味着**那条"全绿"是人工喂进去的**，不是 FakeGame 推出来的。
- **怎么验证 / 修**：要么让 FakeGame 自己按 `belt-rules` 重算 paths（工作量半天），要么在任何引用这条链路的结论里强制标注"依赖手写 paths"。
- **工作量**：0.5–1 人日。

### P2 —— 实机必需，但可以在第一次 dry-run 之后

**⑧ 真 LLM 的一轮录制。** 现在没有任何 `round-01.txt` / `*.meta.json` 的真实录制件。第一次实机前至少用 `AnthropicClient({recordDir})` 录一轮，之后所有复跑都走 `ReplayLLMClient`（已实现，`llm.mjs:336`）。否则"同一个失败是模型的问题还是 prompt 的问题"无法区分。**0.5 人日**。

**⑨ `--resume` 或等价的人工续跑流程。** 现在显式 `null`。上实机后一次 halt 就要重跑整轮（含 LLM 成本）。**1 人日**，可推后。

**⑩ 实机前置的一次只读验证。** 用 `makeBridgeReader` 对真实存档跑 `obs` + `debug_items` + `production`，确认：
- L4 存档的 `paths.length` 是否 > 40（若是，L3 永久 undecidable，`PATHS_TRUNCATED` 会直接 halt）；
- 那三条待改造带子在真实存档上的句柄编号**是否与夹具一致**（夹具是 dump 快照，实体顺序可能与在线不同）。

**0.5 人日**。这一条不做，P0-① 的修法可能照着错误的句柄编号去优化。

---

## E. 核心赌注的裁决

> 「宏动作层能把真实存档从 0 抬起来」——**仍未证实**。

### 为什么不是"证实"

判据是「冷启动 + 没人算坐标 → L4 打通」。现在的证据链是：

1. `coldstart_l4.test.mjs` 证明了 **`replace_run($bbox_of([B81,B82,B69]))` 能产出正确的 5 个 op**。这是真结论，但它证明的是**宏层**，不是**闭环**——因为 `B81/B82/B69` 是测试作者从"已知答案"反查出来的（`loop.test.mjs:126` 的注释直言「句柄来自 handles.mjs 的确定性编号」）。
2. `loop.test.mjs` 的"全绿"用的是同一个写死的计划（`L4_PLAN`）。
3. **官方的 `l4-coldstart` 夹具——本该是"冷启动"的演示件——跑出 0 tx、0 变化**（§A-2）。它引用 `B1/B2/B3`，而那三个句柄指向 `(1,-34)(2,-34)(1,-33)`，是另一条产线上的转弯带，不是待改造的 `(4,-13)(5,-13)(4,-14)`。
4. 我给 prompt 做信息量审计：**冷启动第一轮，prompt 里没有 B69/B81/B82 中的任何一个**（`.tmpverify/audit/prompt2.mjs`）。而且首轮候选宏是 `connect/insert_machine/trash_unused`——**`replace_run` 不在里面**（`RETRIEVAL_TABLE.NO_PRODUCTION`，`constants.mjs:253`）。
5. 我做了存在性枚举：670 个"只用 prompt 可见句柄 + 只用候选宏"的计划，**148 个能过 plan 阶段，0 个能让 L1+L2+L3 全绿**。**在现有仓库代码上，"从可见信息到达成"这条路是死的。**

**所以：闭环从未在"信息不足"的条件下被跑通过一次。** 所有"全绿"的实证，输入里都带着答案。

### 为什么也不是"证伪"

有三条反向证据，说明这个赌注**可能**是对的，只是还没被正确测量：

1. **宏层本身是硬的**：`replace_run` 在 L4 上产出 5 op、`bbox_of` 的并集含 footprint、`verifyMacroTokenCoords` 能抓"标签没变值变了"。这些是独立于 prompt 的质量。
2. **`connect` 的"零成功"结论已被自己推翻**：`macro_execution_ops.test.mjs` 现在报"正确枚举角色名后 23 种组合成功、10 条直达 hub"，并明确写了「我最初只枚举三类机器 → 那是枚举范围太窄造成的错误结论」。这说明这个项目有能力自我纠错。
3. **P0-③ 的实验**：把 FakeGame 的 `code` 补上之后，同一批 148 个计划里 **78 个离线全绿**。也就是说，"可见句柄下无解"**部分**是脚手架造成的（见下）。

### 关键区分（这是本审计最重要的一条）

当我把 FakeGame 修得像真游戏（写 `code`）之后，"可见句柄下有没有解"的答案变了：

| 条件 | 可行计划 | 离线全绿计划 |
|---|---|---|
| 仓库现状（FakeGame 不写 `code`） | 148 | **0** |
| 补上 `code` | 148 | **78** |

但这 78 个里**绝大多数是 `insert_machine trash@Bxx` 这种"把垃圾桶插在矿机出口上"的退化计划**——它在离线能让 L1/L2/L3 全绿（因为 `insert_machine` 的 placement 只判 type/pos/rv/code，而 `trash` 没有带子所以不查链），**在真游戏里不可能让 `RuRu----` 的交付增加**。这正是 `offline_boundary.mjs` 说的"L4 不能离线判"要防的东西——它防住了（那些计划在离线只能到 `offline-only`，永远到不了 `success`），但它也说明：**"离线全绿"这个信号本身区分不出"通了"和"插了个垃圾桶"**。

所以结论是双层的：
- **宏动作层有能力**（这是阶段 1 的成果，已被证明）；
- **闭环能不能在信息不足时选对宏**——**这一层从未被测量过**，因为 prompt 不给信息、候选宏不含正解、FakeGame 又偏好 `replace_run`。

### 一句话裁决

**仍未证实。** 阶段 2 完成的是**决策链的机器**（六阶段、判据、防线、transcript——这些都真实、可复跑、经得起变异），**没有**完成**决策链在冷启动上的第一次真实运行**：喂给它的信息里没有答案，它就被证明走不通；喂给它的信息里有答案，它就能走通。这两件事之间的那一步，就是阶段 2 的全部内容，而那一步还没走。

### 建议的下一步（最小可证伪实验）

不要先上实机烧钱。先在**离线**做这个实验：

1. 修 P0-③（FakeGame 写 `code`）+ P0-①（prompt 能看到目标带子）；
2. 用**真 LLM**（`AnthropicClient` + `recordDir`）跑 5 次冷启动，每次只用 `FakeGame`（零风险）；
3. 数「5 次里有几次产出让 L1+L2+L3 全绿的计划」。

这个实验**不需要游戏**，成本是一点点 API 费用，但它能直接回答核心赌注：**如果 5 次里 ≥3 次 LLM 能选中那三条带子，宏层就是可用的；如果 0 次，那问题在 prompt 的信息组织，不在宏，也不在模型。**这个答案，比现在任何一条"全绿"的测试都值钱。
