# 阶段 2 验收审计（第二轮）

日期：2026-10-29（复审者：独立验收 agent）
基线：`HEAD = a1973ea`（审计期间主线又落了 3 个提交：`7700b7e` 加 baseUrl、`a1973ea` 按真 LLM 结果修三条；本报告对**每个结论**都标了它适用哪一版）
环境：**纯离线**。`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` 均未设置（`env | grep -c '^ANTHROPIC_API_KEY='` = 0）。全程未碰游戏实例。

---

## 一句话结论

**两条修复都真的有效，但都不足以让核心赌注成立——而这一轮新出现了一条比"未证实"更糟的事实：那两条修复所服务的实验，本身就是用答案喂出来的。**

- **A（两条修复）**：都**核实有效**，而且都能用变异测试反向证明（不是 commit message 说了算）。
- **B（新增假绿）**：找到 **6 处**。其中 3 处是这一轮引入或放大的（**prompt 的"看到 3/3"在真实 loop 里不成立**、**实验报告把 `replace_run(belt)` 算成"选中 3/3"**、**实验与生产用的候选宏不是同一份**），3 处是上一轮遗留但这一轮被新事实放大。
- **C（实验有效性）**：**mock 实验的信息量为零**（夹具里写死的就是答案）；**真 LLM 实验做过，但它是"上界/下界错位"的测量**——报告里那句"LLM 看得见 5/5 但选不中 0/5"的结论，被它自己的 `selected_uids` 定义污染了（见 B-3）。
- **E（核心赌注）**：**仍未证实**。与上一轮的差别是：上一轮是"没法测"，现在是"测过了，5 次全败；但那个测量本身有已知偏差，偏差方向对赌注不利"。

---

## A. 两条修复的核实

### A-1 修复①：`pickBeltsForGoal` 重写（`96fbbaf`）

**复现基线**

```
$ git log --oneline -1
a1973ea feat(prompt): 按真 LLM 实验结果修三条（改造引导 / 合法值 / 叙述不过长即拒）

$ node src/agent/experiment-coldstart.mjs
① prompt 里能看到几条正解带子？
    全看到 (3/3) : 1/1
② LLM 选中的带子里有几条是正解？
    全部 3 条    : 1/1
③ 走到 plan 阶段 : 1/1
④ 删除集合精确匹配 : 1/1
  #1 看到 3/3 · 选中 3/3 · plan ok
✓ 结论：LLM 在离线环境下能选中正解并产出精确的删除集合。
EXIT=0
```

**直接验证（不经过实验脚本）**：用 FakeGame + `buildPrompt` + 真实 `diagnose()` 渲染 L4 冷启动，BELTS 段实际输出：

```
## BELTS (12 of 163; 0 referenced by diagnosis)
B63 belt 上游=B69 下游=L3.primary 货=0 段=1
B69 belt 上游=B81 下游=B63 货=0 段=1
B81 belt 上游=B90 下游=B69 货=0 段=1
B90 belt 上游=B97 下游=B81 货=0 段=1
B97 belt 上游=B105 下游=B90 货=0 段=1
B105 belt 上游=B112 下游=B97 货=0 段=1
B112 belt 上游=M3.out 下游=B105 货=0 段=1
B64 belt 上游=B70 下游=L3.primary 货=0 段=1
B70 belt 上游=B82 下游=B64 货=0 段=1
B82 belt 上游=B91 下游=B70 货=0 段=1
B91 belt 上游=B98 下游=B82 货=0 段=1
B98 belt 上游=B106 下游=B91 货=0 段=1
(+151 belts not shown)
```

三条正解（B69/B81/B82）都在，且**并排的两列成对出现**（B81↔B82、B69↔B70、B63↔B64）——这正是 `$bbox_of` 需要的形状。坐标正则 0 命中，uid 数字 0 命中（见 B-1）。

**变异验证**（脚本 `.tmpverify/second/mutate.mjs`，把 `const byGoal = pickBeltsForGoal(...)` 改成 `const byGoal = []`）：

```
$ node .tmpverify/second/mutate.mjs empty
$ node src/agent/loop/prompt.test.mjs
161 通过 / 5 失败
失败项：
  · B69 出现在 BELTS 段（L4 冷启动、无诊断）
  · B81 出现在 BELTS 段（L4 冷启动、无诊断）
  · B82 出现在 BELTS 段（L4 冷启动、无诊断）
  · 并排两条 B81/B82 同时出现（bbox 才覆盖得到整段）
  · 并排两条 B69/B70 同时出现（bbox 才覆盖得到整段）

$ node src/agent/experiment-coldstart.mjs
  #1 看到 0/3 · 选中 3/3 · plan ok
✗ 结论：prompt 里一条正解带子都没出现 —— LLM 不可能选对。这是信息量问题，不是模型问题。
```

**恢复**：`sha1sum src/agent/loop/prompt.mjs` = `0cd5fcf9…`（与备份一致），`prompt.test` 回到 166/0，实验回到 3/3。

**结论**：修复真实有效。**但注意实验脚本在这里暴露了一个洞**：变异后 `EXIT=0`（脚本仍判"成功"），因为退出码只看 `exact_match`，不看 `truth_visible`。见 B-4。

### A-2 修复②：红检查项参与判定（`0e34390`）

**题目要求的构造**：

```
$ node .tmpverify/second/a2.mjs
A2-asked
  → level=none achieved=false
  why=["有可信检查项为红，不能算跑通：L1-landing"]
```

`level !== "offline-only"`，修复成立。

**边界扫一遍**（同一脚本）：

| 输入 | level | achieved | 说明 |
|---|---|---|---|
| mock + L1 red | **none** | false | 题目要求的那条 ✅ |
| mock + V-obs-flow red | **none** | false | 上一轮那个真实形态（`strict.ok:true` + 一条红）✅ |
| mock + L3 red | **none** | false | L3 离线不可信，红也不构成结论——but see B-6 |
| mock + 全绿 | offline-only | false | 对的 |
| live + goal+70 + L1 red | **none** | false | "goal 涨了也不能掩盖红"✅ |
| live + goal+70 + 全绿 | live | true | 唯一通往 achieved 的路 ✅ |
| mock + `L1 red 但 skipped:true` | **offline-only** | false | 见 B-6（被 skip 掩盖） |
| mock + `L1 red 但 undecidable:true` | none | false | 对的 |

**变异验证**（把 `if (strictOk && cls.ok && !anyTrustedFail)` 改回 `if (strictOk && cls.ok)`）：

```
$ node src/agent/loop/offline_boundary.mjs
22 通过 / 3 失败
  · strict ok 但有一条可信检查为红 ⇒ why 点名那条红
  · live + goal 涨 + 但有可信检查为红 ⇒ 不达成（不许被 goal 增量掩盖）
  · （第三条）
```

**恢复**：`sha1sum` 与备份一致，25/0 全绿。

**结论**：修复真实有效，且**有独立回归锁**（boundary 自测 25 条里有 5 条直接锁它）。`loop.test.mjs` 里**没有**新加针对它的集成用例（§7 只测了"离线全绿≠达成"和"live+goal 达成"两个端点），但边界层本身的锁足够。

---

## B. 新增假绿排查

### B-1 ⚠️ **最重要的新发现：冷启动 prompt 里的"看到 3/3"在真实 loop 里不成立**

`pickBeltsForGoal` 有三层判据，**第二层（目标原料矿机线）是决定性的一票**：组有 `groupOnRaw=true` 才排第一。它只读 `obs.resources`。

而 **`obs.resources` 在真实 loop 里拿不到**：

- `src/mod/shapez-ai-bridge.js:1359` —— `if (req.include_resources) { out.resources = ... }`；默认 false。
- `src/agent/loop.mjs:299 / 1653 / 1900` —— loop 的 `obs()` **三处都不传 `include_resources`**。真实 mod 会返回**没有 `resources` 字段**的 obs。
- 代码注释也这么说：`prompt.mjs` 的 `targetRawMiners()` 注释写「`obs.resources` **默认不在 obs 里** —— loop 的 observe 调用没带这个参数」。

实测：同一份 L4 存档，只删掉 `obs.resources`、其它完全不变：

```
WITH resources:     truth present 3/3
  B63,B69,B81,B90,B97,B105,B112,B64,B70,B82,B91,B98
WITHOUT resources:  truth present 0/3
  B130,B139,B143,B147,B151,B155,B159,B140,B144,B148,B152,B156
```

再用 `Spy` 客户端**截获真实 `runLoop` 发出的那一份 prompt**（同时模拟 mod 语义：`obs()` 返回不带 `resources`）：

```
## BELTS (12 of 163; 0 referenced by diagnosis)
B130 belt 上游=B139 下游=L7 货=0 段=1
B139 ... B159 belt 上游=M6.out 下游=B155 ...
B140 ... B156 ...
(+151 belts not shown)
truth anywhere: [ [ 'B69', false ], [ 'B81', false ], [ 'B82', false ] ]
```

**⇒ 在真机上，光这一条（+ 下一条 B-2）就会让 prompt 里一条正解带子都不出现。**

而实验脚本之所以"看到 3/3"，是因为 `FakeGame.observe()` **不看 `include_resources`**，永远把 `resources` 塞进去（实测：`g.observe({})` / `g.observe({include_resources:false})` 都返回 484 格矿）。这是**夹具保真度缺口**，性质与上一轮发现的 P0-③（FakeGame 不写 `code`）完全一样：**离线脚手架比真机多给了信息**。

补充：一份**真实**的冷启动 obs 确实可能带 resources（L4 夹具是从真机 dump 的，里面有 484 格矿），所以"调 `include_resources:true`"是可行修法——但**现在没人调**。这是一个一行修复 + 一条夹具一致性测试的事。

### B-2 冷启动候选宏里没有 `replace_run`（`NO_PRODUCTION` 表）

```
$ node .tmpverify/second/prod_prompt.mjs
PRODUCTION candidates: ["connect","insert_machine","trash_unused"] → cards rendered: ["connect","insert_machine","trash_unused"]
EXPERIMENT candidates: ["replace_run","remove_run","insert_machine"] → cards rendered: ["replace_run","remove_run","insert_machine"]
```

`RETRIEVAL_TABLE.NO_PRODUCTION = [connect 6, insert_machine 4, trash_unused 2]`（`constants.mjs:253-257`）。冷启动第一轮永远得到 `NO_PRODUCTION`，所以**真实 loop 的第一轮永远不会把 `replace_run` 摆给模型**——而 L4 的正解就是 `replace_run`。

`96fbbaf` 修的是"看得见带子"，没修"看得见宏"；`a1973ea` 加了 Rule 10（"优先 replace_run"），但 S2 卡片里仍然没有 `replace_run` 的卡片。

**实测**：用 Spy 截获真实 loop 的 prompt，`cards: ### connect,### insert_machine,### trash_unused`；`system mentions replace_run: true`（Rule 10 里提到名字），但**没有参数卡片**。模型要在没有 params/example 的情况下凭空造 `replace_run` 的 args —— 这与 `96fbbaf` 修之前"看不见带子"是同一类缺陷，只是从 S3 搬到了 S2。

### B-3 ⚠️ 实验的"选中 3/3"是**提到过**，不是**用过**

`experiment-coldstart.mjs:167`：

```js
result.selected_uids = [...mentioned].map(h => handleToUid.get(h)).filter(...);
```

`mentioned` 是对**整个 `parsed.plan.calls` 递归 walk 字符串**得到的——包括 `why`、`say`、以及 `$bbox_of` 里列出的每个句柄。而真正决定删除集合的是宏的 `region`/`uids` + `planToTxOps.destroys`（`exact_match` 用的才是这个，见 `:200-205`）。

**构造反例**（`.tmpverify/second/mention2.mjs`）：一个两调用的计划，第一调用 `replace_run` 作用在 B1/B2/B3（错的），`why` 里写 "not B69/B81/B82"；第二调用 `remove_run` 列出 B69/B81/B82：

```
selected_uids:  [10185,10184,10153, 10143,10209,10149]
selected_truth: [10143,10209,10149]     ← 报"选中 3/3"
plan_ok: false  plan_why: macro:replace_run:precondition_failed
```

**这条正好污染了官方实验报告的结论。** `EXPERIMENT-COLDSTART.md` 写「LLM 看得见 5/5，但选不中 0/5」——但同目录的 `coldstart-live-2026-10-28T18-53-29-562Z.json` 里 **run 3 的 `selected_truth` 是 `[10143,10209,10149]`（3/3）**，它的原文是：

```json
{"macro":"replace_run","args":{"region":{"$bbox_of":["B63","B69","B81","B90","B97","B105","B112"]}, ...}}
```

即：模型把**整条 x=4 列 7 条带子**塞进 region，其中 1 条是正解、6 条不是。`selected_truth` 报 3/3，`plan_why` 是 `precondition_failed`。报告只统计了"0/5"，因为它引用的是另一份（`19-02-00`）5 次记录；但**同一实验的另一批数据里就存在被这个定义抬高的样本**。

另：同一批的 `18-53` run 3 里 `selected_uids` 有 12 个，`selected_truth` 3 个——如果只看 `selected_truth`，会误以为"它挑得很准"。

**这是一条真结论**（这个定义本身没错，`exact_match` 也确实是另一个指标），但**报告把它当成了"选中"**，而且**没在报告里说明两者的区别**。

### B-4 实验脚本的退出码只看 `exact_match`，`truth_visible` 红了也返回 0

```
（变异 byGoal=[]）
$ node src/agent/experiment-coldstart.mjs   → EXIT=0，打印 "✗ 结论：一条正解带子都没出现"
```

`process.exit(sum.exact === n && n > 0 ? 0 : 1)` —— `exact` 是"删除集合精确匹配"。变异后 `exact=1`（因为 mock 夹具写死了正确 region），所以退出码仍然是 0，**与人类读到的"✗ 结论"相反**。这是脚本级的假绿：任何 CI/批处理只看退出码就会把这个红读成绿。

另外：`--runs 3` 时 `exact` 只能是 1/3（mock 只有 round-01），`EXIT=1`；`--runs 1` 时 `EXIT=0`。**同一个脚本的"成功"取决于你跑几次**——因为 mock 场景只有一轮。这不是 bug（`MockLLMClient` 第 2 轮正确抛 `MOCK_EXHAUSTED`），但它让"实验通过"这件事完全没有可比性。

### B-5 夹具 `l4-coldstart` 被改成和 `l4-coldstart-oracle` **几乎一样**，让 `loop.test.mjs §11` 变成恒红（而不是上一轮说的"恒绿"）

`96fbbaf` 把 `test/fixtures/llm/l4-coldstart/round-01.json` 从 `B1/B2/B3` 改成 `B69/B81/B82`，并加了 `confirm_waste: true`。**这使 `loop.test.mjs §11`（"官方夹具必须 0 tx、plan 被拒"）在 HEAD 上恒失败**：

```
$ node src/agent/loop.test.mjs        # HEAD 的 loop.test.mjs（自 2b6474d 起未改）
── 11. 官方 l4-coldstart 夹具（句柄指向的不是那个 run） ──
✗ ★ 夹具引用的 B1/B2/B3 不是待改造的带子 ⇒ 0 次 tx  1
✗ 世界一点没动  {"got":180,"want":181}
✗ 0 次 apply
✗ plan 行记了 rejected
TypeError: Cannot read properties of null (reading 'code')   ← 崩在这里
exit=1
```

**这是 HEAD 上 `loop.test.mjs` 的真实状态**（`a1973ea` / `7700b7e` / `96fbbaf` 都没碰这个文件）。我做了对照：把夹具换回 `8cb5d7a` 的版本，同一个 `loop.test.mjs` 156/0 全绿；换回新版本就是上面这样。**⇒ 这一轮把所有测试跑绿的话不成立**：`loop.test.mjs` 现在挂在第一个失败断言上，后面 §12 之后的用例根本没执行（`grep -c '✓'` 从 156 掉到 142，差 14 条）。

`a1973ea` 的 commit message 写"测试 1699 → 1702（llm 158 / prompt 166）"——这两个数字我复现了（158、166），但它**没有提到 loop.test 已经红了**。

**关于"会不会让测试变成同义反复"**：不会，情况比同义反复更糟——它**变成了一个恒红的用例**，而且因为 `prow.data.rejected` 为 null 直接抛异常，**后面的断言全部不执行**。更根本的问题是：`l4-coldstart` 和 `l4-coldstart-oracle` 现在**只差一句 `say` 文案**，两个场景的**区分度为零**。原来那个"引用错误带子 → 宏拒绝"的负例语义，现在只剩 `neg-*` 三个夹具在承担。

### B-6 `phaseTwoVerdict` 对 `skipped:true` 的红仍然放行（`classifyChecks` 直接 `continue`）

```js
for (const c of report.checks) { if (c.skipped) continue; ... }
```

`phaseTwoVerdict({mode:"live", goalDelta:70, checks:[{name:"L1-landing", ok:false, skipped:true}]})` → `{"achieved":true,"level":"live"}`。

这条**当前不可直达**：`verify_runtime` 里只有三处 `skipped:true`，且都是 `ok:true, skipped:true`（L2 纯带子计划 / L3 无 placements / L4 未请求）。但它是"缺字段 ⇒ 放行"的方向，与本轮修掉的那条同源——**上一轮的修法是"红参与判定"，但 `skipped` 是另一条绕过路**。测试（`loop.test` 与 `boundary` 自测）都没有覆盖这条。

### B-7 `OFFLINE_UNVERIFIABLE` 的键 `"tx-atomicity"` 不存在于任何真实的 check 名

真实的 check 名是 `A-tx`（`verify.mjs:530`）。`classifyChecks` 按名字查表，所以 `"tx-atomicity"` 这条**永远不会命中**——它在表里是装饰品。后果：**A-tx 在离线时被判为"可信"**，于是离线的 tx 失败会直接进 `trustedFails`。

实测：`phaseTwoVerdict({mode:"mock", checks:[{name:"A-tx", ok:false}]})` → `level:"none"`（被判成"可信检查项红"）。这在方向上偏保守（宁可判红），不是假绿——但它说明**那张表的语义与真实 check 名没有对齐**，而 boundary 自测只断言"三个键在表里"，不检查"这些键是不是真的会出现在 checks 里"。这与上一轮 B-2（"判据引用不存在的字段"）是同一类错误的低配版。

### B-8 已被**攻不动**的（记录在案）

- **uid 泄漏到渲染**：27 个渲染场景（L4/L5 × 有/无诊断 × 有/无 lastRound × 各段）全部 0 命中。`normalizeHandles` 恢复 `uid` 后，渲染只读 `handle/type/desc`，`s3_belts`/`s3_machines`/`s3_hub` 三处都不碰 `uid`。构造了一条 `desc` 里带 `uid=10143` 的脏表，`sanitize()` 正确打 `<uid>` 并计数（`redacted_uids: 1`）。**这条我攻不动。**
- **坐标泄漏**：所有场景 `hasCoords(text) === false`，`blocks.redactions === 0`。**攻不动。**
- **`RegExp('\\b'+h+'\\b')` 会不会把 `B6` 误判成 `B69`**：不会。JS 里 `\b` 在 `B6|9` 之间**不成立**（`9` 是单词字符）。实测 `/\bB6\b/.test("B69")` = false，`/\bB1\b/.test("B12")` = false。但**有另一个误判方向**（见下条）。
- **"可见"≠"在 BELTS 段"**：实验脚本的 `visibleHandles` 是对**整份 prompt**扫的。S1 的系统提示里有 `(H1, C1, B7, T2, L1, M3)` 这些示例句柄，它们**恰好也是**这张存档里真实存在的句柄（B7/C1/L1/T1/T2/M3 都在 L4 表里）。所以脚本的 `visible_handles` 是 57（L4）/64（L5），而 BELTS 段只有 12 条。对**正解三条**不构成误判（它们不在 S1 里），但那个"57 个可见"的指标本身就是虚高的。**这是实验统计口径的缺陷，不是 `pickBeltsForGoal` 的缺陷。**

---

## C. 实验有效性评估（关键：mock vs 真 LLM）

### C-1 mock 实验：信息量为**零**（严格说，是负的）

`test/fixtures/llm/l4-coldstart/round-01.json` 的内容是：

```json
{"calls":[{"macro":"replace_run","args":{"region":{"$bbox_of":["B69","B81","B82"]}, ...}}]}
```

而实验的 `GROUND_TRUTH.must_remove_uids = [10209,10149,10143]` **就是 B81/B82/B69 的 uid**。**夹具 = 答案。** 所以 `exact_match` = true 是**同义反复**：你喂进去的就是你判它对的。

实验脚本自己在注释里承认了 oracle 的性质（"它是上界，不是基线"），但 `experiment-coldstart.mjs` **默认就跑 `l4-coldstart`**（不是 `-oracle`），而 `96fbbaf` 之后这两个夹具只差一句 `say`。**"默认跑就通过"这件事本身就是假绿。** 变异测试已经证明了这一点：把 `pickBeltsForGoal` 变成 `[]`，`exact_match` 仍然是 true（因为夹具不看 prompt，直接吐答案）——**只有 `truth_visible` 这一项会变**。

### C-2 真 LLM 实验：做过，而且**有数据**

这不是"无法验证"，而是"验证过，但测量定义有洞"：

- 环境里**没有** `ANTHROPIC_API_KEY`（现在）。但 `research/ai-plan/experiments/` 里有 **5 份 `coldstart-live-*.json`**，最新一份 `19-02-00-927Z` 是 5 次独立尝试，带完整 `llm_raw`。主线用 `--base-url http://ddns2.keniis.top:3000` 的代理跑的（见 `EXPERIMENT-COLDSTART.md` §1）。
- `src/agent/loop/llm.mjs` 在 `7700b7e` 加了 `baseUrl`，**刻意不读 `ANTHROPIC_BASE_URL`**（本机该变量被 Claude Code 占用）——这个设计是对的。
- 现在**没有 key**，所以**我无法复跑**。要复跑需要：`ANTHROPIC_API_KEY`（官方）或一个 Anthropic-Messages 协议的代理 + `--base-url`。

**这 5 次的真实结果**（`19-02-00`，`summary.picked_all_truth = 0/5`）：

| # | 看到 | 模型选择 | 结果 |
|---|---|---|---|
| 1 | 3/3 | 空输出（`raw` 是空串） | plan 未成 |
| 2 | 3/3 | `insert_machine(at=B84, machine="rotator")` | 拼错 + 选错位置 |
| 3 | 3/3 | `insert_machine(at=B85, machine="trash", opts.replace_belts)` | 选错位置 |
| 4 | 3/3 | `insert_machine(at=B112, machine="cutter", facing=top)` | **plan ok**（但区域错） |
| 5 | 3/3 | `insert_machine(at=B135, machine="cutter")`，`say` 349 字符 | `LLM_NARRATION` |

**模型 5/5 都选了 `insert_machine`，0/5 想到 `replace_run` 或 `remove_run`。** 这是**真实的基线行为**，报告 §3.1 的结论（"模型从不删东西"）在数据上成立。

**但这个测量有三个已知偏差，方向都对赌注不利**（见 B-1/B-2/B-3）：
1. **真机上 prompt 里可能一条正解带子都没有**（B-1）——所以"看到 5/5"这个前提本身在真机不成立。
2. **候选宏里没有 `replace_run` 的卡片**（B-2）——模型没有理由选它。
3. **`selected_truth` 把"提到过"算成"选中"**（B-3）——方向相反，是**抬高**了成绩。

### C-3 "实验有效性"的裁决

| 问题 | 答案 |
|---|---|
| mock 实验能证明 `pickBeltsForGoal` 修对了吗？ | **能**（变异测试反向证明），但**不能**证明"这个修法在真机上有效"——因为 FakeGame 多给了 `resources`。 |
| mock 实验能证明"宏层能从 0 抬起来"吗？ | **不能**。它证明的是"人先看了答案，把答案写进夹具，链路能走通"。 |
| 真 LLM 实验能证明"LLM 选不中"吗？ | **部分能**。0/5 是真实数据，但那 5 次的 prompt 里**没有 `replace_run` 卡片**，这是喂给模型的输入缺陷，不是模型能力上限。 |
| 现在还能不能复跑？ | **不能**（无 key）。需要 `ANTHROPIC_API_KEY` 或 `--base-url` + 可用代理。 |

---

## D. 达成度分级（对比上一轮）

| 能力 | 上一轮 | 这一轮 | 依据 |
|---|---|---|---|
| 六阶段状态机 | 已证明 | **已证明**（但 loop.test 现在红，见下） | `loop_pipeline` 36/0、`loop.test` 的 §1–§10 仍全绿 |
| run_end 必写 | 已证明 | **已证明** | 同上 |
| 每条 halt 有机器可检原因 | 已证明 | **已证明** | `HALT_REASONS` 闭集 + `gates` 400/0 |
| 坐标禁令 | 已证明 | **已证明**（这一轮又扫了一遍：0 命中） | 变异 M1 历史数据 + 本轮 27 场景 |
| provenance | 已证明 | **已证明** | `loop_pipeline` 36/0 |
| 离线全绿不得读成达成 | 已证明 | **已证明** | 变异 → 12 条红 |
| **红检查项参与判定** | **未做到** | **已证明（本轮 A-2）** | 变异 → 3 条红；`level !== "offline-only"` 复现 |
| **prompt 含"要改哪几条带子"** | **未做到** | **离线已证明 / 真机未证明** | A-1 有效；但 B-1 显示真机 `obs.resources` 缺失时 0/3 |
| `strictVerdict` 字段核对 | 已证明 | **已证明** | 未变 |
| L4 "产出≠交付" 修正 | 已证明 | **已证明** | 未变 |
| `applyVerdict` 回滚硬停 | 单元证明/集成未验证 | **同上一轮**（未补） | `grep -c "rolled_back: true" src/agent/loop.test.mjs` = 0 |
| `success` 分支 | 死代码 | **仍是死代码**（本轮尝试注入也未到达：离线 L3/L4 双红） | `.tmpverify/second/successrun*.mjs` → `level:"none"` |
| FakeGame 写 `code` | 未修 | **仍未修** | `insert_machine` 计划离线 L1 红：`want 9, got null` |
| `makeBridgeReader` / `reader.tx` | 未验证 | **未验证** | 0 测试 |
| `--resume` | 未做 | **未做** | — |
| **实验框架本身的可信度** | （未评估） | **新发现：低**（B-3/B-4/B-5） | 见上 |
| **真 LLM 冷启动** | 未验证 | **已验证一次（0/5），但输入有缺陷** | `coldstart-live-19-02-00` + B-2 |
| **loop.test.mjs 全绿** | 绿（156） | **红（exit=1，§11 崩）** | 见 B-5 |

**新增的红项（本轮发现，上一轮没有）**：
1. **真机 prompt 可能看不到目标**（B-1）——`obs.resources` 缺失导致 0/3。这是**回归**：`96fbbaf` 修好了"有 resources 时"，但把"没 resources 时"的正确性交给了第三层判据，而第三层在 L4 上选出的是 L7 那条无关链。
2. **冷启动候选宏不含正解**（B-2）——上一轮列为 P1 的问题，这一轮**仍在**，且 `a1973ea` 的 Rule 10 只提了名字、没给卡片。
3. **实验统计口径污染结论**（B-3）。
4. **`loop.test.mjs` 红**（B-5）——这是一条硬事实：**HEAD 上 `node src/agent/loop.test.mjs` 非零退出**。
5. **`gates` 偶发红一次**：我第一次跑时 `G4 绿（声明过的消失不再判「销毁」）` 红、exit=1；随后连跑 5 次全绿。未能稳定复现，**无法定性**（可能是 mock bridge 的端口/时序竞态，也可能是我的环境干扰）。记录在案，不当结论。

---

## E. 核心赌注的裁决

> **「宏动作层能把真实存档从 0 抬起来」——仍未证实。**

### 与上一轮的差别

上一轮：**没法测**——因为 prompt 里没有目标，LLM 结构上不可能选对。
这一轮：**测了，失败了**——而且是在三种不同的输入条件下都失败：

| 输入条件 | 数据来源 | 结果 |
|---|---|---|
| mock，prompt 里有目标（有 resources） | `experiment-coldstart` | "通过"——但夹具写死答案，**同义反复** |
| mock，prompt 里没有目标（无 resources） | 本轮变异 | 0/3 可见，`exact` 仍 true（脚本假绿） |
| **真 LLM，prompt 里有目标**（实验脚本构造的候选宏） | `coldstart-live-19-02-00` | **0/5 选中，0/5 精确**，5/5 选 `insert_machine` |
| **真 LLM，真实 loop 的 prompt** | **从未跑过** | 候选宏里没有 `replace_run`；真机上还少 resources |

### 为什么答案**变了**，但结论**没变**

**变了的部分**：上一轮说"LLM 看不到目标，所以无法测"。现在这个借口**不成立了**——在实验脚本的构造下，prompt 里**确实**有 B69/B81/B82，模型**确实**看到了（5/5），但它**5 次都选了 `insert_machine`**。这是一个**真实的、可复现的模型行为**，不是脚手架问题。

**没变的部分**：
1. 那 5 次实验用的候选宏是 `["replace_run","remove_run","insert_machine"]`——**实验脚本自己硬编码的**（`experiment-coldstart.mjs:107`），**不是**真实 loop 会给出的 `["connect","insert_machine","trash_unused"]`。也就是说：**实验测的是"如果给模型 replace_run 卡片，它会不会选"**，答案是不会；而**真实 loop 根本不会给这张卡片**。
2. 5 次里模型一次都没提 `remove_run`——而正解的核心动作是"删三条带子"。这可能是 Rule 10 缺失（`a1973ea` 已补），也可能是模型对"删东西"有系统性偏好回避。**`a1973ea` 之后还没有重跑过**（数据文件停在 `19-02-00`，`a1973ea` 的 commit message 里没有任何新的 live 数据）。
3. **`exact_match` 从未在真 LLM 数据上为 true**。即使把"选中"放宽到 `selected_truth`，也只有 `18-53` run 3 那一次是 3/3——而那一次的区域是 7 条带子（含 6 条错的），`precondition_failed`。

### 一句话裁决

**仍未证实。** 这一轮把"信息量"这一层修好了（`pickBeltsForGoal` 有效、变异可证），但**又暴露出两层的输入缺陷**：真机上 `obs.resources` 缺失（使修复在真机失效），以及候选宏里没有正解（使模型没有理由选它）。**"LLM 能不能在冷启动下选对"这个问题，到现在还没有在"真实 loop 的输入"上被测量过一次。**

在此之前，唯一一次"全绿"仍然是**人先看了答案写进夹具**的那一次。

---

## F. 建议的下一步（按"能否改变结论"排序）

1. **修 B-1（一行）**：`loop.mjs` 的三处 `obs()` 加 `include_resources: true, max_resources: 20000`；`FakeGame.observe()` 改成尊重 `include_resources`（默认 false，与 mod 一致）；加一条测试断言"loop 发出的 obs 参数包含 include_resources"和"FakeGame 不传时不返回 resources"。**不做这条，所有关于 prompt 的结论在真机都不成立。**
2. **修 B-2（改表）**：`RETRIEVAL_TABLE.NO_PRODUCTION` 加 `replace_run`（权重 ≥ connect），或让 `pickBeltsForGoal` 选出"并排汇入同一机器的一段"时把 `replace_run` 塞进候选。**不做这条，真 LLM 实验测的是"没有工具时的能力"，不是"有工具时的能力"。**
3. **修 B-5（测试）**：`loop.test.mjs §11` 已经与夹具语义脱节。要么把 `l4-coldstart` 恢复成"错误带子"的负例、把正确带子留给 `-oracle`；要么改 §11 的断言。**当前 HEAD 上 `loop.test.mjs` 是红的，这不该出现在任何"测试全绿"的陈述里。**
4. **修 B-3（实验）**：`selected_truth` 改名 `mentioned_truth`，并另加 `acted_truth`（从 `txp.destroys` 取）。报告里的"选中"一律用 `acted_truth`。
5. **修 B-4（脚本）**：退出码改成 `truth_visible == 3 && exact == n`；`--runs` 在 mock 模式下强制 ≤ 1 并在 JSON 里写明 `mock: true`。
6. **重跑真 LLM**（需要 key 或代理）：`node src/agent/experiment-coldstart.mjs --llm --runs 5 --model <model>`，把 `--base-url` 指向可用代理。**这是唯一能改变 E 节结论的动作。**
7. **（可延后）** FakeGame 写 `code`（上一轮 P0-③）与 loop 层回滚回归锁（上一轮 P1-④）。

---

## 附：复现清单

所有脚本在 `.tmpverify/second/`（未入库，随审计产出）：

| 脚本 | 用途 |
|---|---|
| `leak.mjs` / `probe2.mjs` / `leak_diag.mjs` / `leak_diag2.mjs` / `leak_last.mjs` | uid / 坐标泄漏扫描（27 场景） |
| `a2.mjs` / `a2b.mjs` | `phaseTwoVerdict` 的 9 种输入矩阵 |
| `mutate.mjs` | 变异 `pickBeltsForGoal → []`（带回滚） |
| `mut_a2.mjs` | 变异 `phaseTwoVerdict` 的红检查项判据 |
| `nores.mjs` / `nores_vis.mjs` / `realprompt_nores.mjs` | **B-1 复现**：有/无 `obs.resources` 的 BELTS 段对比 |
| `prod_prompt.mjs` / `rule10.mjs` | **B-2 复现**：生产 vs 实验候选宏卡片 |
| `mention_inflate.mjs` / `mention2.mjs` | **B-3 复现**：提到 ≠ 选中 |
| `realprompt_sniff.mjs` | 截获真实 `runLoop` 发出的 prompt |
| `wsnotrim.mjs` / `full_loop_insert.mjs` | 纯 `remove_run` / `insert_machine` 走完整 loop |
| `l5.mjs` / `l5diag.mjs` / `l5bbox.mjs` / `judge.mjs` | L5 上的 `pickBeltsForGoal` 输出与判据特异性 |
| `successrun*.mjs` | 尝试触发 `success` 分支（未到达） |

**工作区状态**：审计结束后 `sha1sum src/agent/loop/prompt.mjs` = `0cd5fcf9…`、`offline_boundary.mjs` = `ab07d6ee…`、`test/fixtures/llm/l4-coldstart/round-01.json` = `6b0bc10f…`，均与备份一致；`git status --porcelain -- src/agent/loop src/agent/loop.mjs` 为空。除本节提到的既有改动（`gates.test.mjs` 等）外，**未留下代码改动**。
