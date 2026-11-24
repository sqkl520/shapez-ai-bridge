# WORLD_FROZEN 纯警报版在真机上有用、中性，还是有害？

2026-11-24。**游戏是活的**（`mod_connected: true`），全部数据来自**真机 run**，
不是离线快照重放。

存档 `7c93b3dd9e949c561e5aa529974973b18c856b45`（实验存档）。
用户存档 `5c96706563c0b74c4d2ce4c7f8bf7a244392de89` **全程未读写**。

---

## 一句话结论

**中性偏有用 —— 但它有一个此前没人量过的副作用：它挤掉了 `MINER_UNWIRED`。**

模型没有变懒（**0/5 次空 calls**），也没有去拆那条 259 件的带子（**0/5 次**），
hint 里「别从它下手」这句**确实生效了**。但同一时刻有一个更硬的发现：

> `WORLD_FROZEN` 在 RANK 8 占掉 `LIMITS.TOTAL = 8` 里的**最后一格**，
> 于是第一轮还在的 `MINER_UNWIRED`（「9 台矿机踩在矿上、输出口是空的」）
> **每一条 WORLD_FROZEN 出现的轮次都被挤掉**。两次独立 run 都复现（2/2）。

这不是「这条诊断对不对」的问题，是**报警占用了施工单的名额**。

---

## ⚠️ 跑完之后的补充（2026-11-24 08:18，别人改的，我复核）

我的 4 次 run 全部在 **08:02 之前**结束，用的都是 **`WORLD_FROZEN: 8`**（HEAD `3967aa5`）。
**08:18 之后**，另一个 agent 把这行改成了 **`WORLD_FROZEN: 15`**（未提交的工作区改动，
`src/agent/loop.mjs`），并在 `.findings/PLAN-2026-11-24.md` 里引用了本报告的 2/2。

我用**当前工作区代码**在同样三份 obs 上复算，结果是：

```
RANK 8  → 诊断 8 条：…, WORLD_FROZEN, …, CHAIN_UNFED×2        （MINER_UNWIRED 被挤掉）
RANK 15 → 诊断 8 条：…, CHAIN_UNFED×2, MINER_UNWIRED            （WORLD_FROZEN 整条不见）
```

**RANK 15 把这条诊断送进了「永远到不了」的位置。** 在这份世界上，
语义层+结构层稳定产 ≥9 条、`LIMITS.TOTAL=8` 永远先满，
RANK 15（低于 `MINER_UNWIRED` 的 11、`TRASH_OVERGROWN` 的 14）**一次都不渲染**。
`prompt` 里 `WORLD_FROZEN` 出现次数 = **0**，整份文档长度 18710 字符。

也就是说：**为了不让报警挤掉施工单，另一个 agent 把报警直接删了。**
这是「算出来 ≠ 送到」的反面：诊断还在 `diagnose()` 的输出里（`semanticDiagnoses`
直接调用能看到它），但在**合并成 prompt 的那一刻消失**。

**这条我没有真机验证**（改动发生在我收工之后、且我被告知只跑指定的那几次 run）。
我能确认的只有一件事：**在当前工作区的代码上，`WORLD_FROZEN` 到达不了模型。**
如果决策是「让位给施工单」，那正确做法要么是提高 `LIMITS.TOTAL`、
要么给它一个不占编号的呈现位（见文末建议），**不是把它排到 15**。

> 我没有改 `src/`。以上只是复核结果，改动是别人的。

---

## 1. 独占时间段

| 项 | 值 |
|---|---|
| 开工前 `curl /health` | `{"ok":true,"mod_connected":true,"uptime_s":30501}` |
| 第一次写世界 | **2026-11-24 06:27:29**（run #1，实际因 429 未写入） |
| 最后一次写世界 | **2026-11-24 08:02:06**（run #4 结束） |
| 报告时 `curl /health` | `{"ok":true,"mod_connected":true,"uptime_s":37188}`（08:12:42） |
| **独占时间窗** | **2026-11-24 06:21 → 08:13（约 1 小时 52 分）** |

**没有发现别的 agent 在动游戏。** 开工前连续 5 次采样 10 秒，
`tick` 单调平滑推进（1114803 → 1114851，`paused:false`、`speed:regular` 全程不变），
没有窗口切换、没有 pause 抖动。`uptime_s` 从 30501 连续走到 37188，**进程没重启过**。
`/health` 全程 `mod_connected:true`，一次都没抖。

> 注：真机恢复 agent 把它跑起来（uptime 约 8.5 小时）之后我接手，我**没有**重启或触碰进程。

---

## 2. 跑了几次 run

| # | run id | 轮数 | 退出码 | halt reason | 有效数据？ |
|---|---|---|---|---|---|
| 1 | `r-20261123222844-7aeb` | 1（目标 2） | 0 | **`LLM_TRANSPORT`** | ❌ 否 |
| 2 | `r-20261123231202-765f` | 2 | 0 | `BUDGET_ROUNDS` | ✅ 是 |
| 3 | `r-20261123234341-c6c7` | 3 | 0 | `BUDGET_ROUNDS` | ✅ 是 |
| 4 | `r-20261123235846-de15` | 3 | 0 | `BUDGET_ROUNDS` | ✅ 是 |

**run #1 作废**：`LLM_TRANSPORT`，三次调用分别 HTTP 429 / 502 / 429
（`CC Switch local proxy … upstream_status: HTTP 429/502`）。
且它**连第 2 轮都没进** —— 而 `WORLD_FROZEN` 按设计只在第 2 轮及以后报
（需要 `tickSincePrev >= 10 秒`），所以那一次即使成功也不可能看到这条诊断。

诊断网关时确认：上游 `ai.furry.vg` 在 Cloudflare 层 524/502，
两个可用模型（`openai/gpt-5.6-luna`、`MiniMax-M2.7-free`）当时都挂。
6 次连采：`429 → 超时 → 200 → 200 → 200 → 200`，恢复后 #2/#3/#4 全部一次跑通。

**有效样本 = 3 个 run / 8 轮 LLM 调用 / 5 轮含 `WORLD_FROZEN`。**

---

## 3. 模型的 `calls` 原文（逐轮）

### run `-765f`（2 轮）

```jsonc
// R1  (WORLD_FROZEN 不在 prompt)
{"say":"Drain the cutter's unused output to prevent upstream blockage.",
 "calls":[{"macro":"trash_unused","args":{"outlet":{"$ref":"C2","port":"right"},"opts":{"confirm_waste":true}},
           "why":"C2 has a free cutter output that is currently stranded."}]}
// → plan 拒: NO_REVERSIBLE_CALL (trash_unused:out_of_scope)

// R2  (WORLD_FROZEN 在 prompt, 第 4 条)
{"say":"Repair the starved stacker by feeding its missing input from the available cutter output.",
 "calls":[{"macro":"connect","args":{"from":{"$ref":"C2","port":"right"},"to":{"$ref":"C4","port":"upper"}},
           "why":"C4 is the upstream blocker and C2 has a free output."}]}
// → plan 拒: NO_REVERSIBLE_CALL (connect:target_already_fed)
```

### run `-c6c7`（3 轮；**唯一落地了真实写入的一次**）

```jsonc
// R1  (无 WORLD_FROZEN)
{"say":"Clear the cutter's stranded output so upstream production can keep flowing.",
 "calls":[{"macro":"trash_unused","args":{"outlet":{"$ref":"C2","port":"right"},"opts":{"confirm_waste":true}},
           "why":"C2 has one free cutter output with no downstream destination."}]}
// → NO_REVERSIBLE_CALL (trash_unused:out_of_scope)

// R2  (有 WORLD_FROZEN)
{"say":"Feed the missing upper input of the root stacker from the available mixer output.",
 "calls":[{"macro":"connect","args":{"from":{"$ref":"C8","port":"out"},"to":{"$ref":"C4","port":"upper"}},
           "why":"C4 is the upstream machine blocking production and needs its second input."}]}
// → NO_REVERSIBLE_CALL (connect:target_already_fed)

// R3  (有 WORLD_FROZEN)
{"say":"修复 B692 到 B699 的带子交接方向，解除一处确定的物流阻塞。",
 "calls":[{"macro":"replace_run",
           "args":{"region":{"$path_of":["B692"]},"building":"belt","opts":{"facing":"bottom"}},
           "why":"B692 当前从 top 来料却推向不接受该方向的 B699。"}]}
// → PLAN ok=true, tx applied 2/2  ← 真机写入，唯一一次落地
```

### run `-de15`（3 轮）

```jsonc
// R1  (无 WORLD_FROZEN)
{"say":"Stop the cutter's unused output from blocking its upstream line.",
 "calls":[{"macro":"trash_unused","args":{"outlet":{"$ref":"C2","port":"right"},"opts":{"confirm_waste":true}},
           "why":"C2 has one free cutter output and no downstream consumer."}]}
// → NO_REVERSIBLE_CALL (trash_unused:out_of_scope)

// R2  (有 WORLD_FROZEN)
{"say":"Feed the starved stacker input from the available mixer output.",
 "calls":[{"macro":"connect","args":{"from":{"$ref":"C8"},"to":{"$ref":"C4","port":"upper"},"opts":{"prefer":"cheapest"}},
           "why":"C4 is the upstream blocker and its upper input is the missing feed."}]}
// → NO_REVERSIBLE_CALL (connect:target_already_fed)

// R3  (有 WORLD_FROZEN)
{"say":"Reconnect the stacker's missing upper feed from the cutter's free output.",
 "calls":[{"macro":"connect","args":{"from":{"$ref":"C2","port":"right"},"to":{"$ref":"C4","port":"upper"},"opts":{"rebind":true}},
           "why":"C4 is the upstream blocker and C2 has a free output."}]}
// → PLAN_REJECTED（预演: 死带子 390→567 +177, 到 hub 309→141）
```

**观察**：含警报的 5 轮，模型**每一轮都在追 `MACHINE_STARVED`(C4 stacker) /
`OUTPUT_STRANDED`(C2 cutter) / `BELT_HANDOFF_REJECTED`(B692)** ——
正是 hint 里点名的那两类「成因诊断」。`B522`（警报的主语）**一次都没出现**。

---

## 4. `WORLD_FROZEN` 在 prompt 里的位置与渲染文本

因为 loop 不落盘 prompt 全文，我用 `transcript.jsonl` 里 `diagnose` 记录中的
**逐字节诊断对象**重建了 prompt（`buildPrompt` 同参数、同 budget `5300`）。
重建长度与实际 `prompt_chars` 相差 **-110 / +177 / +185 字符**（±1%），
`## DIAGNOSIS` 段落本身逐字节同源。

**位置**（`r-20261123234341-c6c7` 第 2 轮）：

| 项 | 值 |
|---|---|
| `system` | 4725 字符 |
| `user` | 14009 字符 |
| 合计 | **18734 字符**（实际 `prompt_chars` = 18549） |
| `## DIAGNOSIS (8)` 段起点 | user 第 11025 字符（**78.7%**） |
| `4. WORLD_FROZEN` 行 | user 第 12095 字符（**86.3%**） |
| 在整份文档里的偏移 | **16824 / 18734（89.8%）** |
| 所在段 | `## DIAGNOSIS (8)`（下接 `## LAST ROUND`） |

**渲染文本（逐字节，333 字符）**：

```
4. WORLD_FROZEN [L2/blocker]: B522 (belt); expected 工厂在产出，原料能进、成品能出; observed 整图零产出；4 条带子满载或无处可去，最堵的一条 259 件 / 165 格（100%，blue×132, ScSc----×127）; hint: 整座工厂零产出（这条带子 259 件 / 100% 是淤积最重的一条）。这是**结果**，不是成因 —— 别从它下手：删这条带子只会拆掉受害者，真正堵住的那一端还在，世界仍然零产出。先去修上面那些说"某台机器缺料 / 某条流到不了 hub"的诊断；它们指向的才是成因。这条只在**没有别的线索时**用来确认「全图确实停转」。另有：87 件 / 55 格（末端…
```

注意事项（**送达端的事实**）：

- hint 原文 **211 字符**，但 `prompt.mjs` 对非 `HUB_FED_BY_COLOR`/`HUB_INLET_THIN`
  一律 `clip(…, 180)` ⇒ 渲染后 hint 只有 **186 字符**（含 `hint: ` 前缀）。
  「另有：87 件 / 55 格（末端…」在 **180 字符闸门处被截断**，
  完整后缀 `人接）；3 件 / 2 格；0 件 / 1 格（末端无人接）。` **没有到达模型**。
  （旧账 `hint-truncated-before-arrival` 的又一次复发，但**不影响本轮结论**：
  180 字符里已经把「别从它下手 + 去修上面那些」说完整了。）
- `handles: []`、`candidates: []` 确认生效：该行**没有** `handles`/`candidates` 子句，
  `## CANDIDATE MACROS` 表里 `remove_run` 的存在来自**别的**诊断（`CHAIN_UNFED` /
  `BELT_HANDOFF_REJECTED`），不是这条。

---

## 5. 模型有没有变懒？（用数字回答）

| 指标 | 含 `WORLD_FROZEN` 的轮 | 不含的轮 |
|---|---|---|
| 轮次数 | **5** | **7** |
| `calls` 为空的轮 | **0** | **0** |
| `calls` 数量 | 5 轮全部 = **1** | 7 轮全部 = **1** |
| 点到警报主语 `B522` | **0 / 5** | n/a |
| 点到 `MINER_UNWIRED` 的矿机句柄 | **0 / 5**（该诊断已被挤掉） | **0 / 7**（在场时也没点） |
| 输出 token（均） | 399 | 622 |
| prompt 字符（均） | 18528 | 18786 |

**结论：没有变懒。** 含警报的 5 轮全部提出 1 个具体动作，
而且全是朝「成因诊断」的方向（stacker 缺料 / cutter 悬空输出 / B692 方向），
**没有一轮**去碰那条 259 件的带子。

⚠️ 一个需要说清的混杂：**含警报的轮的输出 token 明显更短**（399 vs 622，约 -36%）。
但这**不能归因给警报**——7 个无警报轮里包含两个历史 run 的 4 轮（`52a3` 的 885/591、
`fe21` 的 597/321），去掉它们只看**三个新 run 的第 1 轮**，均值为 653（n=3）。
含警报的 5 轮全部是第 2/3 轮，此时模型已吃过一次 `out_of_scope`/`target_already_fed`
的拒绝，输出自然收窄。样本只有 5 轮、且轮次与警报完全共线，
**这个差我不下结论**。

---

## 6. 世界变化

起点（06:27 基线）与终局（run #4 之后 + 45 秒淌货）：

| 指标 | 起 | 终 | Δ |
|---|---|---|---|
| entities | 749 | 749 | 0 |
| belts | 699 | 699 | 0 |
| machines | 49 | 49 | 0 |
| 到 hub 的带子 | 309 | 309 | 0 |
| 死带子（几何） | 390 | 390 | 0 |
| 带上货 | 361 | 361 | 0 |
| `delivered` | 0 | 0 | 0 |
| `produced_total` | `{}` | `{}` | — |
| `goal_delta` | — | — | **无进展** |

**唯一一次真实写入**（`-c6c7` R3 的 `replace_run(B692, facing=bottom)`，2 ops）：

- 死带子 uid 级归因：**新增 1 条**（uid 17649，源头类型 `none`）、**删掉 1 条**（uid 17410）
- **原有活线变死：0 条** ← 最关键的一条，没有破坏既有产线
- 净效果判词：`churn`（等价替换 —— 规模/连通性/货量/目标全没动）

也就是说：**三次 run、8 轮 LLM、8 个动作提案，只有 1 个落地，
落地的是个等价替换。目标进展仍然是 0。** 这与警报无关 —— 它和三个历史 run
（`52a3` / `fe21` / `765f`）的表现**完全同形**（见下节对照）。

**世界健康度**：`uptime_s` 连续、tick 一直推进、`allow_write:true` 全程未变，
终局 `entities=749`、没有任何活线被改死。**没有把存档弄坏。**

---

## 7. 关键发现（本条最重要）：警报挤掉了 `MINER_UNWIRED`

两次独立 run 都复现同一个事实：

```
R1 诊断（8 条）:
  MACHINE_STARVED, HUB_INLET_THIN, NO_PRODUCTION, BELT_HANDOFF_REJECTED,
  OUTPUT_STRANDED, CHAIN_UNFED, CHAIN_UNFED, MINER_UNWIRED      ← 有它

R2 诊断（8 条，多了 WORLD_FROZEN）:
  MACHINE_STARVED, HUB_INLET_THIN, NO_PRODUCTION, WORLD_FROZEN,
  BELT_HANDOFF_REJECTED, OUTPUT_STRANDED, CHAIN_UNFED, CHAIN_UNFED   ← 它没了
```

- 复现：`r-20261123231202-765f` R2、`r-20261123234341-c6c7` R2+R3、
  `r-20261123235846-de15` R2+R3 —— **2/2 run、5/5 含警报轮次**。
- 机理：`src/agent/loop.mjs:1548` 的 `LIMITS = {PER_CODE:3, TOTAL:8}`，
  合并按 RANK 升序、**先到先占**。`WORLD_FROZEN` 登记在 `RANK: 8`
  （`loop.mjs:1389`），`MINER_UNWIRED` 在 `RANK: 11`（`loop.mjs:1491`）。
  第一轮已有 7 条占位（CHAIN_UNFED×2 不超 PER_CODE），`WORLD_FROZEN`
  正好占掉第 8 格 ⇒ RANK 11 的 `MINER_UNWIRED` **整条消失**。
- 我把两边重建出来核对过：
  `WITH alarm → MINER_UNWIRED present=false` / `WITHOUT alarm → present=true`，
  其余 7 条**逐条相同**。

**这不是「这条诊断的内容对不对」，是「一条纯警报占用了可施工诊断的名额」。**

但要说清**影响的量级**：`MINER_UNWIRED` 在**它自己在场的时候也从未被采纳**
（7/7 轮，含两个历史 run `52a3` / `fe21`，模型一次都没点 `M7–M15`）。
所以这次挤出**当前没有造成可测的行为损失** —— 它是**潜在**风险，不是已发生的坏结果。
若哪天模型开始采纳 `MINER_UNWIRED`（"矿机就位只差接线"是本关最可行的一步），
这个名额冲突就会变成真损失。

> 附带（顺带发现，未单独实验）：RANK 8 也是 `FLOW_UNVERIFIED` 的档位。
> 语义注释里写的「排在全部可行动诊断之后」与 `MINER_UNWIRED:11` 的实际顺序矛盾 ——
> RANK 8 其实**排在** RANK 11 之前。

---

## 8. 对照的效力（必须说清）

| 对照 | 有 `WORLD_FROZEN`? | 可比性 |
|---|---|---|
| `r-20261123151728-52a3`（2 轮） | ❌ 无 | 代码**早于**该诊断（WORLD_FROZEN 首个 commit `eb3c79d` 是 11-24 00:14，该 run 是 11-23 23:19） |
| `r-20261123135733-fe21`（2 轮） | ❌ 无 | 同上 |
| 本报告 3 个 run 的第 1 轮 | ❌ 无 | **同一份代码、同一份 obs、同一模型**，唯一差别是第几轮 |
| 本报告 3 个 run 的第 2/3 轮 | ✅ 有 | — |

**效力分级**：

- **同一 run 内的 R1 vs R2 是效力最高的对照**：同一份 obs、同一套宏、同一模型、
  prompt 只差 `WORLD_FROZEN` 一行 + `MINER_UNWIRED` 一行 + `## LAST ROUND` 段。
  但它**不干净**：R2 多了一段 `## LAST ROUND`（"上一轮 trash_unused 被
  `out_of_scope` 拒"），那本身就会改变模型行为 —— 所以 R1→R2 的行为变化
  **不能单独归因给警报**。
- **与 `52a3`/`fe21` 的跨 run 对照效力有限**：那两个 run 的 prompt 里
  **没有** `WORLD_FROZEN`，但也有别的差异（`MINER_UNWIRED` 在不在、
  `BELT_HANDOFF_REJECTED` 有没有、`prompt_chars` 18690–18808 vs 18505–18549）。
  **它们的价值在于**：证明了「模型在这种死世界上，不管有没有警报，
  都是提 1 个 connect / trash_unused、然后被闸门拒」这个**行为基线**。
  三个新 run 在第 1 轮（无警报）时**复刻了这个基线**（3/3 提 `trash_unused`）。

也就是说：**警报没有改变"做什么"，只改变了"第几轮"** ——
无警报的第 1 轮 = 撞 `trash_unused` 闸门；含警报的第 2/3 轮 = 撞 `connect` /
`replace_run` 闸门。**闸门在一次都没放行（除 c6c7 R3 的 churn）**。

---

## 9. 一句话结论

**中性偏有用。**

- **有用的一面**：「别从它下手」**生效了**。5/5 含警报轮次，模型全部转向
  成因诊断（stacker 缺料 / cutter 悬空 / B692 方向），**0/5** 去碰那条 259 件的带子。
  这正是这条 hint 想达到的效果 —— 把注意力从受害者转到凶手。
- **中性的一面**：它**没有让模型变懒**（0/5 空 calls），也**没有让世界变好**
  （唯一落地的动作是 `churn`）。但**有没有它都一样糟** —— 三个历史 run
  在无警报的情况下同样 0 落地。所以它**既不是解药，也不是毒药**。
- **有害的一面（唯一硬证据，且是结构性的）**：它在 `LIMITS.TOTAL=8` 里
  **挤掉了 `MINER_UNWIRED`**（2/2 run、5/5 轮复现）。当前没造成可测损失
  （`MINER_UNWIRED` 在场时也 0 采纳），但它把一条**可施工**的诊断
  换成了**不可施工**的警报 —— 这是名额分配问题，不是文案问题。

**建议（供决策，不是我去改）**：给 `WORLD_FROZEN` 一个**不占诊断名额**的
呈现形式（例如并进 `## CAPACITY` 段做一行「全图停转」的事实陈述，
或用 `evidence` 里的 `suppressed` 走汇总），让 `MINER_UNWIRED` 留在第 8 格。
理由：警报的价值是「确认全图停转」这个**背景事实**，它不需要一个编号，
而 `MINER_UNWIRED` 是**动作入口**，它需要。

⚠️ 这个建议**不包含**「把它排到 RANK 15」。08:18 的那次改动正是这么做的，
而我在当前工作区上复算的结果是：**RANK 15 下这条诊断在 prompt 里出现 0 次**。
排到 15 不是「降低优先级」，是「删除」——它比原来挤掉 `MINER_UNWIRED` 更远离设计意图
（设计意图是「没有别的线索时用来确认全图停转」，而它现在在**任何**情况下都不出现）。
要让它在「没有别的线索时」真能出现，`LIMITS.TOTAL` 必须在它之前没被填满 ——
而这在 L12 这种世界上永远不成立。

---

## 附：本次真机操作的边界（自证）

- 存档身份每次跑前由 `tools/live-run.sh` 硬校验：
  `7c93b3dd9e949c561e5aa529974973b18c856b45`（4 次 dry/真跑全部通过）。
- **没有** `kill` / `Stop-Process` / `taskkill`；**没有**重启游戏（`uptime_s` 连续）。
- **没有** `git stash` / `commit` / `push` / `checkout` / `reset`。
- **没有**读 `ANTHROPIC_BASE_URL`（`live-run.sh` 内部 unset，我另起探针时也只打
  `http://127.0.0.1:15721/responses`，没读该环境变量）。
- **没有**改 `src/` 下任何文件（全部离线重建脚本都在 `.tmp-liveverify/`）。
- 临时文件在 `.tmp-liveverify/` 与 `.tmp-lv2/`，已删（重建产物与探针响应）。
- checkpoint 已拍：`live-20261123-222811` / `live-20261123-230951` /
  `live-20261123-234222` / `live-20261123-235815`（未回滚 —— 世界没被弄坏）。

### ⚠️ 并发改动（必须记下，否则数据会被误读）

我跑 run 期间，**工作区里有人在改 `src/`**（不是我）：

| 文件 | 改动时刻 | 是否影响本报告的量 |
|---|---|---|
| `src/agent/loop.mjs` | 07:01（belt_reorient 读数）；**08:18**（`WORLD_FROZEN: 8→15`） | **08:18 的那次影响重大**（见上节） |
| `src/agent/loop/prompt.mjs` | 07:15（`## LAST ROUND` 新增 `reoriented belts` 段） | 不影响：`belt_reorient` 在我 3 个 run 里只有 1 次出现，`count:0` → 该段**不渲染** |
| `src/agent/loop/semantic.mjs` | 07:24（WORLD_FROZEN 内加截断感知文案） | **已验证不影响**：5 轮含警报的 `observed` **逐字节相同**（都是非截断分支） |
| `src/agent/loop/structural.mjs` / `verify.mjs` | 08:03 / 08:05 | 不影响本轮诊断集合（3 个 run 的诊断码完全一致） |

**逐项核过**：

1. **`WORLD_FROZEN` 的渲染文本在 5/5 轮里逐字节相同** ——
   `整图零产出；4 条带子满载或无处可去，最堵的一条 259 件 / 165 格（100%，blue×132, ScSc----×127）`。
   说明 07:24 那次 semantic 改动走的是**非截断分支**，文案没变（`pathsTruncated=false`、
   `pathCount=32=shownPaths`）。
2. **RANK / `LIMITS` 在 08:18 之前未被改过**（`git diff` 里 `WORLD_FROZEN: 15` 是 `+` 行，
   HEAD 是 `WORLD_FROZEN: 8`）。我的 4 次 run 全部在 08:02 前结束 ⇒ **全部用 RANK 8**。
3. 第 2/3 轮的 `## LAST ROUND` 段可能因 07:15 的改动**多了**一行 reoriented（实际
   `count:0` ⇒ 没多），所以 R1 vs R2 的可比性不受影响。

**结论**：第 5/7/8/9 节的测量对**当前 HEAD（`3967aa5`，RANK 8）**成立。
对**当前工作区**（RANK 15），第 7 节的结论反转：`MINER_UNWIRED` 回来了，
但 `WORLD_FROZEN` 彻底不到达。
