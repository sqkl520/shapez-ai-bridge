# 经验形态 A/B —— 实验设计

> 2026-11-01。**只写设计，不含实现。**
> 目标：回答「四种经验形态里，哪一种能让模型做出更高质量的工厂」，
> 并且把「高质量」定义成**落到世界上的效果**，不是模型说的话。
>
> 判据来源：`QUALITY-METRICS.md`（四层判据）。
> 已有证据：`AB-PROMPT-RESULT.md` 两轮、`.tmpverify/ab-capacity/RESULT.md`。

---

## 0. 先纠正四个前提错误（都是实测查出来的，不是猜）

在写设计之前，必须先说清楚我和任务书对不上的地方。**四处会直接改变实验结论**。

### 0.1 ★ 第二轮的「64%」是**文本判据**，不是世界效果。真实可执行率是 **8.7%**

这是最重要的一条。我用 `loop.mjs` 的**生产路径**（`buildTxPlan`，含 `resolveRefs` →
契约校验 → 真宏 → `planToTxOps` → `namedUids` → `assertProvenance` → token 坐标校验）
把 `results-v2.json` 里那 46 条原始输出**逐条重放**了一遍，把通过的计划用
`FakeGame.apply` 落到世界副本上，再跑 `assess()`：

| 臂 | n（唯一 rep） | `addresses_bottleneck`（第二轮判据，只看文本） | **`buildTxPlan` 通过** | **通过且真提利用率** |
|---|---|---|---|---|
| A2 无 CAPACITY | 23 | 0 (0%) | 0 (0%) | **0 (0%)** |
| B2 有 CAPACITY | 23 | 16 (70%) | 2 (8.7%) | **2 (8.7%)** |

```
A2 拒绝分布  {"LLM_ARGS":7,"MACRO_REFUSED":13,"COORD_PROVENANCE":3}
B2 拒绝分布  {"MACRO_REFUSED":13,"LLM_ARGS":4,"PATH_NOT_RECT":3,"LLM_COORD":1}
```

- 文本判据 0/23 vs 16/23 → `p = 4.95e-07`（**这一条是真的**，CAPACITY 确实改变了模型说的话）
- 世界效果 0/23 vs 2/23 → **`p = 0.489`（完全不显著）**

**结论：CAPACITY 段让模型「说对了」，但没有让它「做成」。** 第二轮报的 64%
是「结构化参数里落了 cutter」，不是「那台 cutter 真的能放下」。

复现：`node .tmpverify/exp-plan/final-pipeline.mjs`。

⇒ 本实验的主判据**必须是世界效果**。把它当次要指标会重复第二轮的错。

### 0.2 ★ `results-v2.json` 里有重复 rep，n 被报大了

| 臂 | 文件里行数 | 唯一 rep | 其中 parse_ok |
|---|---|---|---|
| A2 | 26 | 23 | 23 |
| B2 | 25 | 23 | 23 |

重复来源是「第一次 `max_tokens` 截断 / `fetch failed`，第二次成功」，两条都留在文件里。
`AB-PROMPT-RESULT.md` 第二轮用 `0/26 vs 16/25` 报 `p=2.85e-07`；按唯一 rep 是 `0/23 vs 16/23`，
`p=4.95e-07`。**不影响方向，但 n 的写法必须改。**

⇒ 本实验的 runner 必须把「无效行」写进单独的 `invalid[]`，**绝不混进 n**（见 §6.1）。

### 0.3 ★ 默认预算只剩 **547 字符**，经验块会先挤掉 CAPACITY，再吃掉带子

`loop.mjs:1737` 调 `buildPrompt` 时**只传了** `rounds_left / llm_calls_left / tx_left /
ticks_left / wall_ms_left`，**没有** `in_chars_max` 或 `prompt_tokens_max`。
于是上限恒为 `min(2800 × 3.5, 12000) = 9800` 字符。实测：

```
现状（S1 + 自洽 production + 默认预算）：9168 字符 / 上限 9800 → 余量 547
```

用「把上限压低 X」等价模拟「多一段 X 字符」：

| 经验块字符数 | belts_shown | CAPACITY | 结果 |
|---|---|---|---|
| 0–400 | 12/37 | ✅ | 正常 |
| **489** | 12/37 | ⚠️ 降级成 short | `capacity_downgraded` |
| 600 | 12/37 | ❌ `dropped-for-budget` | 产能诊断消失 |
| 800 | **9/37** | ❌ | 开始吃带子 |
| 1200 | **0/37** | ❌ | 带子全没 |

**任何超过 ~450 字符的经验块，在默认预算下都会把 CAPACITY 段挤掉。**
这时你测的就不是「经验有没有用」，而是「经验 vs 产能诊断哪个更值钱」。

**解法（已实测，且对照臂逐字节不变）**：把 `in_chars_max: 16000, prompt_tokens_max: 4600`
传给 `buildPrompt`。实测 `system` 和 `user` **逐字节相同**（`user === d.user` 为 `true`），
只是余量从 547 变成 6747。

```
node .tmpverify/exp-plan/headroom.mjs
默认       → 合计 9253，上限 9800，余量 547
抬高后      → 合计 9253，上限 16000，余量 6747
system/user 与默认逐字相同: true / true
```

⇒ **这是本实验的前置工作，且是"免费"的**（不改变任何一段文本）。
必须在跑实验前写进 `loop.mjs` 的 `buildPrompt` 调用点，否则所有经验臂都在被预算惩罚。

### 0.4 ★ 端口名格式是 prompt 的**真 bug**：`top:primary` 宏不认

`MACHINES` 段的输出槽渲染成 `dir:role`（`top:primary`），`BELTS` 段的上下游同理
（`上游=M1.out 下游=L2.primary`）。但契约校验器要求裸角色名：

```js
// contract.mjs:579-581
if (!/^[a-z][a-z0-9_]{0,31}$/.test(port)) return fail("bad_type", field, `${field} 角色名必须是小写标识符`)
```

实测：`trash_unused({outlet:{uid:L1, port:"top:secondary"}})` → `bad_type`；
`port:"secondary"` → `ok:true`。

影响面（`results-v2.json`，46 条唯一有效行）：

```
port 提及 72 处，其中带方向前缀（非法）23 处 = 32%
至少含一处非法 port 的行 13/46 = 28%
```

A2 臂 7/23 的行死在这里，B2 臂 4/23。**这是 prompt 教给模型的写法，模型照着抄，然后被宏拒。**

⚠️ 但实测**修掉它并不会提高可执行率**（去掉前缀后 B2 仍然 2/23 —— 它只是把
`LLM_ARGS` 的错误换成了 `trash_unused:occupied`）。所以：

- **本实验不改它**（改了就不是单变量了）；
- 但要作为**独立的工作项**登记，并在结论里注明「有 28% 的样本死在一个已知的 prompt 格式 bug 上」；
- 而且它是形态 (d) 绝好的素材（见 §2.4）。

### 0.5 其它两处小的事实更正

| 任务书说 | 实际 |
|---|---|
| `assess.mjs` 有 `capacityFor`(590) 和 `capacityOf`(180) | 对。但 `throughput()` **没有导出**，外部只能通过 `assess().throughput` 拿；`idleMiners` 在 `assess(obs).throughput.idleMiners` |
| 绕路率来自 `assess()`（`QUALITY-METRICS.md` 也这么写） | **错。`assess.mjs` 里没有任何 manhattan 计算。** 它只给 `capacity.path.beltsOnLine`（37）。分母必须实验自己算：`Σ_ miners (|mx−hx| + |my−hy|)` |

绕路率实测（`node .tmpverify/exp-plan/detour.mjs`）：

```
capacity-scenario.json   miners 3  belts 37  manhattanSum 27  →  1.37
test/fixtures/saves/L4-obs.json  miners 8  belts 163 manhattanSum 98 → 1.66
```

⇒ 绕路率**必须由实验自己实现**，而且要明确它是「后置量」（改完之后的世界），不是 prompt 里的量。

### 0.6 一条必须知道的环境事实：`prompt.mjs` 有一个**未提交**的改动

`git status` 显示 `src/agent/loop/prompt.mjs` 是 `M`，且 diff 是：在 `renderCapacity` 里加了

```js
const canBuyUpgrade = false;   // ← 加 `upgrade` 宏并接进 `MACRO_FNS` + `doApply` 后改这里
...
if (up && canBuyUpgrade) { ... }   // 原来是 if (up)
```

⇒ **当前工作区的 CAPACITY 段不再显示「升升级」这条路**。
而第二轮 B2 臂用的是**显示升级路**的版本（`.tmpverify/ab-capacity/prompt-C.txt` 第 127 行
有 `· processors T1 (×1→×1.5) ⇒ 0.75/s — needs SuSuSuSu×500`）。

**这意味着第二轮的 B2 与今天的基线不是同一个 prompt。** 见 §3。

---

## 1. 实验矩阵

### 1.1 三个场景（同一个世界，只改 `goal.upgrade_levels`）

**为什么复用 `capacity-scenario.json` 而不是造新场景**：

1. 第二轮的血教训是**夹具本身坏了**（`[not reaching hub]` 误标 11/12 + production 自相矛盾），
   两个假信号让 82 条样本全废。造新场景 = 重新冒一次这个风险。
2. 现有世界的**世界效果只有 8.7%**（§0.1），不是天花板 —— 有 91% 的头寸可以涨，不需要新几何。
3. 只改 `upgrade_levels` 就能造出**语义完全不同**的产能局面，而我实测过这三个局面都稳定：

| 场景 | 构造 | supply | process | util | bottleneck | `addMachines.add` | CAPACITY 原文（当前 prompt） |
|---|---|---|---|---|---|---|---|
| **S1 供大于求** | 原样（processors=T0） | 1.8/s | 0.5/s | **28%** | `process`(cutter) | **3** | `bottleneck: cutter — 72% of supply is stuck here` + `add 3 cutter (1→4) ⇒ 2/s` |
| **S3 边际** | `processors=T2` | 1.8/s | 1.0/s | **56%** | `process`(cutter) | **1** | `bottleneck: cutter — 44% of supply is stuck here` + `add 1 cutter (1→2) ⇒ 2/s` |
| **S2 已平衡（负对照）** | `processors=T4` | 1.8/s | 2.0/s | **100%** | `supply`(miners) | **null** | `balanced: … — no capacity bottleneck. **Do not add machines for throughput.**` |

**为什么必须有 S2（负对照）**：这是整个设计里最值钱的一格。

- S1/S3 只能证明「经验让它加 cutter」。可是**不加经验的模型也已经在加 cutter**（B2 文本 70%）。
  S1/S3 测不出「它是否学会了判断」，只测「它是否学会了这句话」。
- S2 是**唯一能把「照着经验做」和「按情形做」分开**的场景：在这里加 cutter 是纯浪费
  （`excess_process` 从 0.2/s 涨到 2.2/s）。
- 一个只会「看到 cutter 就加 cutter」的经验，在 S2 上会**暴露成误判上升**。
  这就是任务书 §6 里「模型对经验过敏」的可检测形态。

**S3 的作用**：它要的是**定量**答案（加 1 台，不是 3 台）。用户原话「明明有可以快捷提高产能的方法却没有用」
在 S1 上的正解是「加 3 台」，S3 上是「加 1 台」——一个只会背「加 3 台」的经验在 S3 上会被
`excess_process` 抓住。这是分辨「检索式记忆」和「规则式理解」的位置。

### 1.2 臂

| 臂 | 内容 | 注入位置 | 长度目标 |
|---|---|---|---|
| **C0** | 对照：当前 prompt，**不做任何文本改动**，预算抬到 16000 | — | 0 |
| **P** | 安慰剂：**与经验块等长**的中性文本（把经验句替换成同等字数的通用建议） | 同 a/b/c/d | = a/b/c/d |
| **a** | 案例库：「这个诊断组合 → 上次这么修」 | `## CAPACITY` 之后、`## BELTS` 之前 | ≤ 1600 |
| **b** | 手写玩法心得：shapez 机制事实 | 同上 | ≤ 1600 |
| **c** | 模型自复盘：在 S3 上跑 10 次、让模型写经验，**注入到 S1/S2** | 同上 | ≤ 1600 |
| **d** | 我的方案：**宏报错 → 处方** 的机读对照表（见 §2.4） | 同上 | ≤ 1400 |

**为什么注入在 `## CAPACITY` 之后 / `## BELTS` 之前**（不是随便挑的）：

1. `buildPrompt` 的段序是 `… MACHINES → CAPACITY → BELTS → PRODUCTION → BUDGET → DIAGNOSIS → LAST ROUND → YOUR TURN`。
   `BELTS` 是**唯一可截断段**（`compose()` 里只有它进循环）。经验插在 BELTS 之前，
   意味着「预算不够时先砍带子，不砍经验」——这与 CAPACITY 的位置理由**完全一致**。
2. 经验讲的是「拿诊断怎么办」，紧跟在「诊断的产能解释」之后，是同一决策块的一部分。
3. 不放在 `system`：`SYSTEM_PROMPT` 是模块级常量、字节稳定，`prompt_rules.test.mjs` 有
   「新规则以旧规则全文为前缀」的断言（`prompt.mjs:230-238`）。改 S1 会打红测试，
   而且让「经验」和「规则」混为一谈 —— 那是两个不同的变量。
4. 不放在 `## YOUR TURN` 之前：那里是 recency 最强的位置，放那儿测的会是
   「最后一句说什么」而不是「经验有没有用」。安慰剂臂 P 会证明这一点（同位置、同长度、无内容）。

### 1.3 矩阵与成本

主矩阵（n=25/格）：

| | S1 供大于求 | S2 已平衡（负对照） | S3 边际 | 小计 |
|---|---|---|---|---|
| **C0** 对照 | 25 | 25 | 25 | 75 |
| **P** 安慰剂 | 25 | — | — | 25 |
| **(a)** 案例库 | 25 | 25 | 25 | 75 |
| **(b)** 手写心得 | 25 | 25 | 25 | 75 |
| **(c)** 自复盘 | 25 | 25 | 25 | 75 |
| **(d)** 报错处方 | 25 | 25 | 25 | 75 |
| 小计 | 150 | 125 | 125 | **400** |

安慰剂只在 S1 跑：它的作用是「排除长度/新段落的混淆」，而那是**与场景无关**的机制，
一个场景足够；跑三遍是白花钱。

**成本（按第二轮实测 `results-v2.json` 的真实数字）**：

| 项 | 值 | 来源 |
|---|---|---|
| 单次墙钟 p50 / p90 / max | 158 s / 259 s / 305 s | 48 条实测 |
| 单次均值 | 164 s | 同上 |
| output tokens 均值 / max | 22,676 / 45,761 | 同上 |
| `max_tokens` 必须 | **64,000**（32,000 下限，实测 64,000 仍有 1 条截断） | 同上 |
| **400 次调用，并发 2** | **≈ 9.1 小时** | 400×164/2 |
| **output token 合计** | **≈ 9.1 M** | 400×22.7k |
| input token 合计 | ≈ 1.1 M（≈2700/次） | 9168 字符 / 3.5 |
| 含 5% 重跑余量 | ≈ 420 次 / 9.5 h / 9.6 M out | — |

**先跑的筛选矩阵（n=10/格，只用于淘汰，不作结论）**：

| | S1 | S2 | S3 | 小计 |
|---|---|---|---|---|
| C0 + P + a + b + c + d | 60 | 50 | 50 | **160 次 ≈ 3.6 h ≈ 4.1 M out** |

外加：(c) 的**经验生成跑** 10 次（S3，不注入），smoke 20 次。总前置 ≈ 30 次 / 0.7 h。

---

## 2. 四种形态的具体实现

### 2.0 共同的注入契约（所有臂逐字节相同，除经验块）

照抄 `.tmpverify/ab-capacity/v2.mjs` 的做法，**在文本层做手术**：

```js
const base = buildPrompt({ ...同 C0 的入参, budget: { in_chars_max: 16000, prompt_tokens_max: 4600 } });
const i = base.user.indexOf("## BELTS");
const userX = base.user.slice(0, i) + EXP_TEXT + "\n\n" + base.user.slice(i);
```

**必须通过的自检**（写成 `assert`，失败即停，不跑实验）：

1. `base.system` 六臂**逐字节相同**
2. `base.blocks.s3_capacity` 六臂**逐字节相同**
3. `base.blocks.belts_shown` / `belt_total` 六臂**相同**，且 `trimmed_belts === 0`
4. 把经验块删掉后，`userX === base.user`（严格单变量的机器证明）
5. 经验块长度 ∈ [1200, 1700]，且 **P 臂与 a/b/c/d 的长度差 ≤ 40 字符**（±2.5%）
6. `hasCoords(EXP_TEXT) === false`（否则 `V4` 会把整条计划判红）
7. `countMarks(EXP_TEXT, "uid") === 0`

### 2.1 (a) 案例库 —— 「这个诊断组合 → 上次这么修」

**经验从哪来**：不是模型写的，是**运行记录**。每条 = 一次真实运行 + 它的世界效果。

**库的结构**（`research/ai-plan/experience/cases.json`）：

```jsonc
{
  "key": {                       // 检索键 = prompt 里已经有的三个信号，不做语义检索
    "diagnosis_codes": [],        // 排序后的码集合，见 prompt 的 ## DIAGNOSIS
    "bottleneck": "process",      // assess().capacity.bottleneck
    "util_bucket": "low"          // ok | low(<50%) | mid(50-90%) | high(≥90%)
  },
  "action": {                     // 一条真实通过 buildTxPlan 的计划
    "macros": [{"macro":"insert_machine","args":{...}}],
    "executable": true,
    "util_before": 0.28, "util_after": 0.56,
    "excess_process_before": 0, "excess_process_after": 0
  },
  "lesson": "cutter 在 B27 那格插一台、facing=top 即可把处理自 0.5 → 1/s"   // ≤ 90 字符
}
```

**检索规则（确定性，无嵌入模型）**：精确匹配 `diagnosis_codes` 集合 → 其次匹配
`bottleneck` → 再次按 `util_bucket` 排序，取 **top 3**，渲染成 ≤ 1600 字符。

**注入渲染（≤1600 字符，实测过容量）**：

```
## PAST CASES (3 similar states)
1) [no diagnosis | bottleneck=process | util<50%]
   did: insert_machine cutter on a feed belt, facing set explicitly
   result: utilization 28% → 56%, processing 0.5 → 1/s
   note: one machine per round; a second cutter needs the 2-wide pair merged
```

**为什么这么设计**：`bottleneck` 和 `util_bucket` 正是 `capacityFor()` 的输出，
所以 (a) 的检索**天然只命中「同一种产能局面」的案例**，不会在 S2 上把 S1 的处方拿过来用。
这是它与 (b) 的结构性差别：(a) 是按状态检索，(b) 是恒定文本。

**第一次运行的库是空的**（没有历史）。所以 (a) 的两阶段：
- 阶段 0：用 C0 在 S1/S3 各跑 10 次，取其中 `buildTxPlan` 通过的那些做种子案例（≈2 条/场景）；
- 阶段 1 起：(a) 臂才真正有内容。

⚠️ **泄漏控制**：种子必须来自**与测试 rep 不同的、且不注入的**运行。
最干净的做法：种子来自 S3 的跑，测试 S1/S2；S1 的种子只用于 S3。

### 2.2 (b) 手写玩法心得 —— shapez 机制事实

**经验从哪来**：人写。但**每一条都必须可验证**——这是本实验对 (b) 的唯一硬要求。

候选条目（每条都写清了它对应的实测证据）：

| # | 心得 | 证据 |
|---|---|---|
| 1 | `cutter` 是 2×1，输出只有 `left`（废料）/`right`（保留半）；`trash` 只能接 **left** | `op-templates.mjs` 的 `wasteRoles:["left"]`；`LEGAL_VALUES.replace_run` 的自动派生 |
| 2 | `replace_run` 把一段带子换成 `[cutter, trash]` 时，**废料喷口那一格必须在 region 里**；2 格宽的带对不够，要向喷口方向多框一格 | 实测 `precondition_failed: cutter 的 "left" 槽喷口在 (2,-8)，落在 region 之外`，B2 臂 6/23 死在这里 |
| 3 | `insert_machine` 放 `cutter` 时 **`facing` 必填**（2 个输出槽 + 可旋转） | 实测缺 facing → `ambiguous_site`；B2 的 5 条 insert_machine 里 3 条漏了 |
| 4 | `port` 只写**裸角色名**（`primary`/`secondary`/`left`/`right`/`out`），**不写方向前缀** | `contract.mjs:580` 的正则；28% 的样本死在这里 |
| 5 | `$path_of` 的格集必须**填满自己的外接矩形**，拐弯的链要**拆成多次调用** | `coords.mjs` 的 `PATH_NOT_RECT`；B2 臂 3/23 |
| 6 | 供给 > 处理时加处理机器；处理 ≥ 供给时**再加就是浪费**（`excess = process − supply`） | `capacityOf` 的 utilization 口径；S2 的存在理由 |
| 7 | 一行答案是 1–6 个 call；**一个 call 里放不下的改动就下一轮** | `PROMPT_RULES.CALLS_MAX`；实测 3 台 cutter 合并成一次 tx → `plan_conflict: 同一格 (3,-7) 被两个 place 命中` |
| 8 | 加 cutter 之后**必须**再处理它的 `left` 废料口，否则线会堵 | `WASTE_NO_SINK` 诊断；cutter 的 `mustDiscardUnused` |

**注入渲染**（≤1600 字符）：编号 + 一行一句，不写解释链（解释链会吃光预算）。

**★ 关于「升级比加机器便宜」这条经验：必须排除，且原因不是宏缺失**

任务书说这条会因为「没有 `upgrade` 宏」而看起来没用。**实测比这更硬**：
在 S1 的存档里 `stored_shapes` 是
`{CuCuCuCu:12, ----CuCu:686, RuRuRuRu:2016, ----RuRu:4575, RuRu----:45}` —— **没有 `SuSuSuSu`**。
而 `processors` 线 T1 要 `SuSuSuSu×500`。所以 CAPACITY 原文写的是
`needs SuSuSuSu×500`，即**买不起**。

⇒ 在这三个场景上，「升级更快」**即使有宏也是错的建议**。所以：

1. **(b) 的语料里不放这条**；
2. 在结论里明确标注：「升级路线在本实验的场景上不可负担，且无对应宏 —— 双重排除」；
3. 若坚持要测，单独开 `b-upg` 诊断臂，**不进主家族**（见 §5.3）。

### 2.3 (c) 模型自复盘

**经验从哪来**：让模型自己看 transcript、写教训。

**流程（冻结，必须原样记录）**：

1. 在 **S3** 上跑 10 次（不注入任何经验），得到 10 条 `(prompt, output, buildTxPlan 结果, 世界效果)`。
2. 用一个**单独的、冻结的 review prompt** 把这些喂回去，要求：
   `≤ 8 条，每条 ≤ 120 字符，只写「下次在这个状态下该怎么做」`
3. **发给 review 模型的内容里必须包含机械反馈**：每条输出后面附上 `buildTxPlan` 的
   `code` 与 `observed`（例如 `MACRO_REFUSED: replace_run:precondition_failed — cutter 的 "left"
   槽喷口在 (2,-8)，落在 region 之外`）。否则模型无从知道自己错在哪，写出来的会是
   「我应该更仔细」这种废话 —— 那是**实验失败而非阴性结果**。
4. 产出的 ≤1600 字符文本注入 S1 / S2（**不注入 S3**）。

**泄漏控制**：经验生成在 S3、注入在 S1/S2。S3 的正式测量用**新的一批 rep**，
且注入的文本里不许出现任何来自 S3 测试 rep 的 handle（自检：`EXP_TEXT` 里出现的
`/\b[HBLCMT]\d+\b/g` 集合必须为空）。

**★ 与 (a) 的区别必须说清，否则两个臂会变成同一件事**：
- (a) 是**检索**：不同状态拿不同案例，格式是「状态 → 动作 → 结果」。
- (c) 是**归纳**：一段恒定文本，是模型自己总结的原则。
两者都来自运行记录，但一个是 case-based 一个是 rule-based。这就是要对比的东西。

### 2.4 (d) 我的方案 —— 「宏报错 → 处方」对照表（机读生成）

**为什么这不是 (a)/(b)/(c) 的变体**：它的内容**不是人写的、也不是模型写的**，
而是从**代码里的错误码与 hint** 机械抽取、再按实测频次裁剪出来的。
它测的是：**把编译器本来就写好的错误说明，提前给模型看，值不值。**

**怎么生成（全自动，可复现）**：

1. 从 `contract.mjs` 的 `ERROR_CODES` + 每个宏的 `error.hint` 抽出候选「错误 → 处方」对；
2. 用 §0.1 的 faithful 重放流程，量出每一类错误在 C0 臂上的**实际频次**；
3. 按频次降序，取**能塞进 1400 字符**的前 k 条（预计 5–7 条）；
4. 每条渲染成 `错误码 · 实测 n/23 · 一句话处方`。

预期入选（按我实测的 C0 频次）：

```
MACRO_REFUSED / replace_run:precondition_failed   6/23  →  废料喷口格必须在 region 内，2 格宽带对不够
LLM_ARGS / bad_type (port)                        7/23  →  port 是裸角色名，不写 top:/bottom:
MACRO_REFUSED / trash_unused:occupied             6/23  →  目标喷口格已被带子占，先 remove_run 再收
PATH_NOT_RECT                                     3/23  →  $path_of 必须填满外接矩形，拐弯就拆调用
insert_machine:ambiguous_site                     3/23  →  cutter 必填 facing
connect:target_already_fed                        3/23  →  目标口已有供料，要改接得开 rebind
```

**为什么这个形态值得单独占一格**：它是唯一**内容由代码保证正确**的形态。
如果它比 (b)（人写）和 (c)（模型写）都差，那说明「正确的知识」不是瓶颈，
「模型会不会读」才是 —— 那个结论比任何单个形态的胜出都值钱。

---

## 3. 对照组

### 3.1 基线定义

**C0 = 当前 prompt（干净工作区的那一版）+ 自洽 production + 抬高预算**，在本实验同一批 rep 上**现跑 25 次**。

- 场景 S1 的 C0 是 `capacity-scenario.json` + `produced_total` 补上 `RuRu----:30`
  （与 `delivered 0.5/s` 自洽，`diagnose()` 返回 0 条 —— 已实测）。
- **不使用**第二轮的 B2 数字当对照。

### 3.2 为什么必须用 contemporaneous control（三条理由，都是查出来的，不是原则性口号）

**理由 1：基线 prompt 已经变了。**
第二轮的 B2 臂的 CAPACITY 段**含升级路线**（`.tmpverify/ab-capacity/prompt-C.txt:127`：
`· processors T1 (×1→×1.5) ⇒ 0.75/s — needs SuSuSuSu×500`）。
当前工作区有一个未提交的 `canBuyUpgrade = false`（§0.6），**这一行已经不会渲染**。
拿第二轮的数字当对照 = 拿两个不同的 prompt 比。

**理由 2：第二轮的 64% 与今天的判据不同口径。**
64% 是「结构化参数里落了 cutter」；今天是「`buildTxPlan` 通过且真提利用率」= 8.7%。
用历史数字做对照，等于把**判据的变化**记成**形态的效果**。这是本项目已经踩过的坑
（第一轮 EXCEPTION 的 `p=0.0449` 在 n=20 时变成 `p=1.0000`）。

**理由 3：端点 drift 是不可观测的。** 该模型端点（`virtual/opus` 经第三方网关）不同批次的
输出长度就从 1000 到 8000 tokens 不等（第一轮记录）。跨天比较没有意义。

⇒ **所有比较只在同一批运行内做。** C0 与各形态臂的 rep **按索引配对**（rep 1..25 同一批跑）。

### 3.3 三个对照角色（别混）

| 对照 | 回答的问题 | 不成立时说明什么 |
|---|---|---|
| **C0** | 经验有没有超过"什么都不加" | — |
| **P** 安慰剂（等长中性文本） | 效果是"内容"带来的，还是"prompt 变长/多一段"带来的 | 若 P ≈ 各形态，**所有形态的阳性结果都作废** |
| **S2 场景**（不是臂） | 模型是在判断，还是在背口号 | 若某形态在 S1 涨、S2 也涨（误加机器），它是"过敏"不是"学会" |

---

## 4. 判据的机读定义

### 4.0 总原则：**主判据只看世界效果**

`QUALITY-METRICS.md` 的 L1/L2 已无区分度（`PHASE2-SUCCESS.md` 已有 `achieved:true`）。
更关键的是 §0.1：**同一批输出，文本判据 70%、世界判据 8.7%**。
所以：

> **所有主判据 = `buildTxPlan(...).ok` → `FakeGame.apply(ops)` → `assess(新世界)` → 比较。**

**"说了" 只作次要指标，且用 McNemar 单独检验它与"做了"的偏离。**

FakeGame 的诚实边界（它自己的文件头写着）：**只伪造读取面，不伪造 tx**。
所以落盘世界是"近似"的：`place`/`delete` 直接改内存实体表。
对 `capacityOf()`（只按 `type` + `x/y` 做 BFS）与绕路率（带子计数 + 曼哈顿）**足够**；
对"这条带子方向对不对"**不够**。因此：

- **L3（利用率 / 瓶颈）与 L4（excess / idle / 绕路）在本实验中可信**；
- **"工厂是否真的能流"不可信** —— 这一层留给可选的实机验证（§7.5），不在主判据里。

### 4.1 每行必算的量（全部由代码产出，无人工判断）

```jsonc
{
  "arm": "b", "scenario": "S1", "rep": 7,
  // ── 构建期（每行都要，用于查"跑挂了"与预算挤压）──
  "chars": 10800, "sys_chars": 4700, "exp_chars": 1600,
  "belts_shown": 12, "belts_total": 37, "trimmed_belts": 0,
  "capacity_present": true, "capacity_downgraded": false, "capacity_unavailable": null,
  // ── LLM 层 ──
  "stop_reason": "end_turn", "usage": {...}, "ms": 165000, "attempts": 1,
  "parse_ok": true, "parse_error": null, "n_calls": 2,
  // ── 世界效果（★ 主判据）──
  "executable": true, "reject_code": null,
  "util_before": 0.28, "util_after": 0.56, "util_delta": 0.28,
  "excess_process_before": 0.00, "excess_process_after": 0.00,   // = max(0, process − supply)
  "starved_supply_before": 1.30, "starved_supply_after": 0.80,   // = max(0, supply − process)
  "belts_before": 37, "belts_after": 36, "detour_before": 1.37, "detour_after": 1.33,
  "idle_before": 0, "idle_after": 0,
  "process_count_before": 1, "process_count_after": 2,
  // ── 文本层（次要，只用来判"说/做"偏离）──
  "say_capacity": true, "say_add_cutter": true, "say_upgrade": false,
  // ── 错误归因（机制分析用，见 §5.4）──
  "fail_class": null          // 见 §4.6 的闭集
}
```

### 4.2 四个判据的机读定义

#### (1) `处理瓶颈`（任务书的「处理瓶颈」= 主判据的粗粒度版）

```
addressed_bottleneck = executable AND (
    (bottleneck_before == "process" AND util_after >= util_before + 0.05)
 OR (bottleneck_before == "supply"  AND excess_process_after <= excess_process_before + 1e-9)
 OR (util_before >= 0.95            AND excess_process_after <= excess_process_before + 1e-9)
)
```

- 阈值 5 个百分点：一台 cutter 在 S1 上让 28%→56%（实测），二阶噪声远小于 5pp。
- 用 `bottleneck_before` 分派，是因为**同一个动作在不同场景下对错相反**。
- 不用「say 里提到 cutter」（第二轮的 `CAP_RE` 就栽在这里）：`cutter` 在宏卡片和配方段里本来就有。

#### (2) `提产能`

```
improved_capacity = executable AND util_delta >= 0.05
```

只在 S1/S3 有意义。S2 上 `util` 恒 100%（被 `capacityOf` 夹到 1.0），
这一格**必然为 0**，不许拿它当"变差"。

#### (3) `误判`（**分场景定义，方向相反**）

```
wrong_move =
  # 世界级（主要）
  destroys_flowing_belt                       # 删掉的带子原本在 onLine 集合里且下游到 hub
  OR (bottleneck_before == "supply" AND excess_delta > 0)      # S2：供不应求还加处理（= -starved_supply_delta）
  OR (excess_delta > 0.5 AND util_delta <= 0)                  # 任何场景：装了用不上的产能

# 其中 excess_delta = max(0,process−supply)_after − max(0,process−supply)_before
#      starved_supply_delta = max(0,supply−process)_after − max(0,supply−process)_before
#      两者恒反号，所以 S1/S3（供大于求）看 starved_supply 下降，S2（供不应求）看 excess 不涨
  OR (detour_after > 1.20 * detour_before AND util_delta < 0.05)
  OR idle_after > idle_before                                   # 制造了闲置矿机
  # 文本级（次要，与上面分开统计）
  OR says_false_break     # 断言「kept-half 到不了 hub」—— 实测 B8→…→H1 是通的
  OR connect_redundant    # connect 了一对 BFS 已可达的端点
```

`trash_unused` 分两种（第二轮已确立）：指向**带子** = 误判；指向**机器空输出槽** =
`benign_trash`（不解决产能，但那是 `addressed_bottleneck=false` 的事，不是误判）。

#### (4) `绕路率`

```
detour = capacity.path.beltsOnLine / Σ_{miner ∈ obs.entities} (|mx−hx| + |my−hy|)
```

- **不是** `assess()` 提供的（§0.5）。实验自己实现，写成一个纯函数，单测固定在
  `capacity-scenario` = 1.37、`L4-obs` = 1.66 两个已知值上。
- 必须**前/后都算**（`detour_before` / `detour_after`），只报后置值是误导。

### 4.3 「说了」vs「做了」—— 必须分开，且要用统计检验

```
say_capacity  = /(28\s*%|72\s*%|1\.8(\/s)?|0\.5(\/s)?|bottleneck|utiliz|throughput|capacity|supply|processing|starved)/i
                .test(say + why)                        # ← 刻意不含 cutter（第二轮修过）
act_process   = txPlan.ops.some(op =>
                  op.op === "place" && PROCESSORS.includes(op.building))
                || (ops 里有 delete 且同计划里有 PROCESSORS 的 place)
```

然后做 **McNemar 精确检验**，配对 `(say_capacity, act_process)`：

- `b/c` 的 `say_capacity` 高而 `act_process` 低 ⇒ **"说得更好听但做同样的事"**，判该形态失败；
- 两者同涨 ⇒ 真改善；
- `act_process` 高而 `say_capacity` 低 ⇒ 至少不坏（闷头做对）。

`PROCESSORS = ["cutter","rotater","stacker","painter","painterDouble","painterQuad","mixer"]`
直接取自 `assess.mjs:222`，不复制第二份。

### 4.4 质量阶梯（0–4，主判据的序数版）

给统计增加一个更敏感的量（避免二值指标的地板效应，见 §6.3）：

| level | 条件 |
|---|---|
| **4** | `executable` 且 `addressed_bottleneck` |
| **3** | `executable` 且未改善但未变差（`util_delta ∈ [−0.02, 0.05)` 且 `excess_delta ≤ 0`） |
| **2** | 未执行，但**动作方向对**（计划里对正确的机器种类做了操作，死在几何/参数上） |
| **1** | 未执行，且动作方向错（做的是别的机器 / 只动带子 / 只接垃圾桶） |
| **0** | `parse_ok === false` |

实测分布（C0/B2 在 S1，n=23，`node .tmpverify/exp-plan/ladder.mjs`）：

```
A2（无 CAPACITY）  {1: 23}                                 均值 1.00
B2（有 CAPACITY）  {1: 7, 2: 14, 4: 2}                     均值 1.87  sd 0.80
```

**这个分布是设计的关键输入**：B2 有 14 条落在 level 2 —— 方向对了、几何错了。
**经验若能把这 14 条推成 4，均值从 1.87 到 3.5，是最可能出现的大效应。**

### 4.5 归因时不许做的事

- 不许把 `addresses_bottleneck`（第二轮的文本判据）当 `addressed_bottleneck` 的近义词。
  两者在 B2 上差 **16 vs 2**（§0.1）。
- 不许在 S2 上把 `improved_capacity == false` 算成失败。
- 不许把 `invalid`（跑挂/截断/解析失败）混进 n，也不许静默丢弃 ——
  **`invalid_rate` 本身是次要指标**（一个把模型搞崩的经验是负面结果）。

### 4.6 失败归因闭集（用于 §5.4 的机制分析）

| code | 含义 | 谁的锅 |
|---|---|---|
| `PARSE` | `parseLlmPlan` 失败 | 模型 |
| `LLM_COORD` | 输出里带字面坐标（V4） | 模型 / prompt |
| `LLM_ARGS` | 契约校验失败（如 `port:"top:primary"`） | **prompt**（§0.4） |
| `PATH_NOT_RECT` | `$path_of` 未填满外接矩形 | 模型（可被经验教） |
| `MACRO_REFUSED:prereq` | 宏 precondition（如废料喷口出界） | **模型（可被经验教）** |
| `MACRO_REFUSED:occupied` | 路径/喷口被占 | 模型（可被经验教） |
| `MACRO_REFUSED:ambiguous` | 少参数（如缺 facing） | 模型（可被经验教） |
| `TX:*` | `planToTxOps` 拒绝（如 `destroys_not_named`） | 实现/模型 |
| `COORD_PROVENANCE` | 溯源失败 | 实现 bug |

**这张表是 (a)/(c)/(d) 的直接靶子**：它们想消灭的就是 `LLM_ARGS` / `PATH_NOT_RECT` /
`MACRO_REFUSED:*` 这三类。如果某形态在这三类上没动静，那它"提产能"的机制就不成立 ——
即使总命中率涨了，也要怀疑是采样噪声。

---

## 5. 统计方法

### 5.1 检验选择与理由

| 判据 | 检验 | 为什么 |
|---|---|---|
| **主判据 `addressed_bottleneck`**（二值） | **Fisher 精确检验**（双侧） | n=25/格，期望频数 < 5（8.7% 基线 → 期望 2），卡方不可用。仓库已有自检过的实现：`.tmpverify/ab-prompt/stats.mjs`（6 组教科书值） |
| **质量阶梯**（序数 0–4） | **置换检验**（10,000 次，双侧，按 `rep` 配对） | 阶梯不是等距的；置换检验不假设分布，且能配对。Mann-Whitney 作交叉验证（应给出同量级 p） |
| **说/做偏离** | **McNemar 精确检验** | 配对二值；这是唯一能区分"说了"与"做了"的检验 |
| **失效类别**（§4.6） | 每类单独 Fisher，**Holm 校正，标为探索性** | 一次比 8 类 = 8 次比较，不校正必假阳性 |
| 比例区间 | **Wilson 95% CI**（仓库已有） | 小 n 下 Wald CI 会越界；第一轮就撞过一次 |

### 5.2 多重比较：**不做 6 对两两比**

任务书提醒的「四形态两两比 = 6 对」是对的，但本设计**不采用两两比**：

- 设计是 **4 个形态各自 vs 同一个对照 C0**（`m = 4`），不是 6 对两两。
  这与"两两比"的差别不是修辞：`m=4` 的 Holm 在 α=0.05 下最严的判定阈值是 `0.0125`。
- 场景内做 Holm（`m=4`）；**跨场景不合并**（三个场景的基线率不同，合并 = Simpson 悖论）。
- 若有人真的要做 6 对两两，`m=6`，最严阈值 `0.0083` —— 在 n=25 下基本不可能达到，
  那就等于宣布"这个设计测不出形态之间的差异"，只能说"某个形态优于对照"。
- **α = 0.05，Holm（不是 Bonferroni）**：Holm 严格更有效，且同样控制 FWER。

### 5.3 主/次家族（**必须预注册，跑之前定死**）

| 家族 | 内容 | 校正 |
|---|---|---|
| **主** | 4 形态 × S1 的 `addressed_bottleneck`（Fisher） | Holm, m=4 |
| **主** | 4 形态 × S1 的 `ladder`（置换） | Holm, m=4 |
| 次 | 4 形态 × S3 的同上 | Holm, m=4，**标注"次要"** |
| 次 | 4 形态 × S2 的 `wrong_move` / `excess_delta` | Holm, m=4，**标注"次要"** |
| 次 | P vs C0（S1） | 单次，不校正，但**是全实验的否决闸**：P 显著 ⇒ 全盘重做 |
| 探索 | `fail_class` 分布、`say/act` McNemar、`invalid_rate` | 报告 p，**不声称显著** |

**为什么主家族只在 S1**：S1 是唯一有第二轮机理支撑的场景，且它的基线率（8.7%）
既不在天花板也不在地板。S2/S3 是新造的，先当次要。

### 5.4 功效：**这个实验只能看见大效应，必须提前说出来**

按实测基线分布（`B2 = {1:7, 2:14, 4:2}`，`mean 1.87, sd 0.80`）做置换检验模拟
（`node .tmpverify/exp-plan/power2.mjs`）：

| n/格 | 半数样本升 0.5 档 | 升 1 档 | 升 1.5 档 |
|---|---|---|---|
| 10 | 1% | 4% | 19% |
| 12 | 5% | 8% | 20% |
| 15 | 4% | 11% | 38% |
| 20 | 5% | 15% | 53% |
| **25** | **13%** | **23%** | **57%** |

二值主判据（基线 8.7%）：

| n/格 | 8.7%→25% | →35% | →50% |
|---|---|---|---|
| 20 | 5% | 18% | 54% |
| 25 | 9% | 30% | 72% |
| 30 | 13% | 39% | 82% |

**读法（必须写进最终报告）**：

- n=25 能可靠看见的是「半数样本升 1.5 档」这种**大效应**（57%）。
- 「升 1 档」的功效只有 23% —— 即使有真实效果，**七成概率会报成阴性**。
- 因此：**阴性结果只能说"没检测到"，不能说"无效"**。
- 要看见中等效应需要 n≈60（升 0.5 档 12%、升 1 档 75%）—— 那是另一个预算量级（≈ 20 h）。
- 这也说明为什么 §7 要允许"先 n=10 筛选、只把有希望的形态推到 n=25"：
  400 次全部跑满只为给三个形态买 23% 的功效是不划算的。

---

## 6. 失败模式与预案（7 种，每种有检测手段）

### 6.1 跑挂了 / 输出无效，且被静默计入 n

**症状**：`stop_reason=max_tokens` 且 `text` 为空 → 被记成 `LLM_NOT_JSON`（第二轮实测踩过两次，
当时的 `results-v2.json` 里就有 2 条）；`fetch failed` 重试成功但两条都留档（n 因此虚高，§0.2）。

**检测**（每行落盘即判，runner 内）：
```
invalid = err != null
       || stop_reason === "max_tokens"
       || parse_ok === false
       || text === ""
```
`invalid_rate` 按臂统计，**并作为次要指标报出**（把模型搞崩的经验是负面结果）。

**预案**：
- 无效行进 `invalid[]`，**不进 n**；
- 同一 `rep` 最多重跑 2 次（指数退避 2s/8s，只对 `429|TIMEOUT|TRANSPORT|5xx|ECONN` 重试）；
- 2 次后仍无效 → 记 `EXHAUSTED`；
- **若某臂有效 rep < 25，该格整格作废并在报告里明说**，不许降到 22 就跟 25 比；
- 硬闸：`max_tokens=64000`。实测 64000 下仍有 1/25 截断 ⇒ 必须有这个重跑机制。

### 6.2 prompt 变长挤掉带子表 / CAPACITY

**症状**：经验块 > ~450 字符时 CAPACITY 被降级或丢弃；> ~600 时开始砍带子；> 1200 带子归零（§0.3）。

**检测**（构建期，不是事后）：
```js
assert(chars <= 16000);
assert(belts_shown === 12 && trimmed_belts === 0);   // 与 C0 逐项相等
assert(capacity_present === true && capacity_downgraded === false);
```
任一条失败 ⇒ **不跑这一格，直接报错退出**（不改文本凑长度）。

**预案**：
- 前置工作：把 `in_chars_max: 16000, prompt_tokens_max: 4600` 传进
  `loop.mjs:1737` 的 `buildPrompt` 调用（§0.3，已实测对照臂逐字节不变）；
- 经验块硬上限 1600 字符（占 6747 余量的 24%，留足余量）；
- 若某形态表达不下，**截断它而不是截断 prompt**，并把 `exp_chars` 记下来用于灵敏度分析。

### 6.3 场景太简单（天花板）或太难（地板）

**天花板**：S2 的 CAPACITY 直接写着 `Do not add machines for throughput`，
所以「不加机器」很可能是**照抄**而非判断。若 C0 在 S2 上的 `wrong_move` 已经 < 10%，
S2 就测不出"过敏"，只能测出"会不会读英文"。

**地板**：**这是本实验最现实的风险** —— C0 在 S1 的世界级命中率实测只有 **8.7%**（§0.1）。
8.7% 的基线意味着一次改善要被看见，效应必须很大（§5.4）。

**检测**：**形态臂开跑之前**，先把 C0 在三个场景上各跑 25 次，得到基线表：

| 判定 | 阈值 | 动作 |
|---|---|---|
| 天花板 | C0 的 `addressed_bottleneck` ≥ 80% 或 `wrong_move` ≤ 10% | 该场景**降为次要**，不参与主家族 |
| 地板 | C0 的 `addressed_bottleneck` ≤ 2% 且 `ladder` 均值 ≤ 1.2 | 主判据改用 `ladder`，并在报告首行声明"二值判据在此场景无功效" |
| 健康 | 其余 | 正常 |

**预案**：因为预判到 S1 可能贴地板，**主判据预注册为 `ladder`（序数）**，
二值的 `addressed_bottleneck` 作次要 —— 序数能区分 level 1 和 2，
而 8.7% 的二值把这 14 条 level-2 全归成 0。

### 6.4 「说得更好听，但做同样的事」

**症状**：`say_capacity` 涨、`act_process` 不涨。第二轮的 B2 已经有点这个味道（§0.1）。

**检测**：
- 主判据用世界效果，天然免疫；
- 再加 **McNemar 配对检验**：`(say=0,act=1)` vs `(say=1,act=0)` 的 b/c 格。
  若某形态 `c` 显著 > `b`，判该形态为"话术改善"，**在报告里单列，不算阳性**。
- 附加：统计 `say` 里出现的**具体 handle**（`/\b[HBLCMT]\d+\b/g`）。
  一个真的在照着 prompt 干活的经验，`say` 里应该出现它教过的 handle 类型；全是空话则没有。

### 6.5 模型对经验"过敏"（过度套用）

**症状**：在 S2（供不应求）上也开始加 cutter；或在 S1 上加了 3 台变 1 台不该加的时候也加。

**检测**：
- **S2 就是为此存在的**：`excess_delta > 0` 的比率；
- 具体量：`excess_after − excess_before`。S2 基线 `excess = 2.0 − 1.8 = 0.2`；
  加一台 cutter 就变成 `4.0 − 1.8 = 2.2`。**+2.0/s 的纯浪费，一个数字就看出来**；
- 交叉表：`S1 改善 × S2 误加`。理想形态落在 (改善, 不误加) 格；
  过敏形态落在 (改善, 也误加)。**只看 S1 会把过敏误判成成功。**

**预案**：若某形态在 S1 涨、S2 的 `excess_delta > 0` 也涨，结论写成
**「该形态学到的是口号，不是判断」**，即使它在 S1 显著。

### 6.6 长度/新段落混淆（不是内容的功劳）

**症状**：任何"多一段文字"都会让模型更认真，与内容无关。

**检测**：**P 臂**（§1.2）。同位置、等长（±40 字符）、内容替换为通用建议。
若 `P` 与 C0 无差异 且 某形态显著 ⇒ 内容的功劳，成立。
若 `P` 也显著 ⇒ **所有阳性结果作废**，必须重设计（换位置，或改成短经验 ≤300 字符）。

**预案**：这是**否决闸**，必须先于主分析判定。

### 6.7 跨臂污染（顺序/漂移）

**症状**：同一端点、连续 400 次调用，早上的样本与下午的样本分布不同。第一轮记录过
"同一条 prompt 输出 1000–8000 tokens 不等"。

**检测**：
- 每个 `rep` 内**随机化臂顺序**（`v2.mjs` 已有这个模式）；
- 落盘 `ts`，事后做 **C0 臂的 `ladder` ~ 调用序号 的秩相关**。
  `|ρ| > 0.4` 且 p < 0.05 ⇒ 有漂移；
- 记录 `usage.output_tokens` 的按小时均值，突变 > 2 倍 ⇒ 端点换了后端。

**预案**：漂移显著 ⇒ 用**分块随机化**重跑受影响的 rep；不许用"时间"做协变量调整
（那是事后拟合）。

---

## 7. 执行顺序

### 7.1 阶段 −1：冻结与前置（**不做完不许跑**）

1. **清理工作区**：`src/agent/loop/prompt.mjs` 有一个未提交的 `canBuyUpgrade=false` 改动（§0.6）。
   要么提交、要么还原 —— **实验期间 `prompt.mjs` 必须与某个 commit 逐字节对应**。
2. **记录指纹**：`md5sum` 落盘 `prompt.mjs` / `assess.mjs` / `contract.mjs` / 三个场景 JSON，
   写进实验报告的头部。中途任何一项变了 ⇒ 整批作废。
3. **前置改动（唯一允许的代码改动）**：`loop.mjs:1737` 的 `buildPrompt` 调用加
   `in_chars_max: 16000, prompt_tokens_max: 4600`。验收标准：**C0 臂的 `system`/`user`
   与改动前逐字节相同**（已实测为 `true`）。
4. **独立工作项（不在本实验内）**：端口名格式 bug（§0.4）。**登记，不改**。

### 7.2 阶段 0：夹具与工装（≈30 次调用 / 0.7 h）

1. 三个场景 JSON（S1/S2/S3）。S2/S3 只改 `goal.upgrade_levels`，由脚本生成并落盘。
2. 六个臂的 prompt 构造 + §2.0 的 7 条自检。
3. 世界效果判据：给 `results` 行算 §4.1 全部字段。**单测**：
   - 黄金动作 `insert_machine(cutter@B27, facing=top)` 必须 `executable && util 28%→56%`
     （已实测通过，`node .tmpverify/exp-plan/ttest.mjs`）；
   - 绕路率在 `capacity-scenario` 必须等于 1.37。
4. **Smoke（每臂每场景 n=3，8 臂 × 1 场景 ≈ 20 次）**：验证 7 条自检、`max_tokens` 截断率、
   实际延迟（经验块会让 thinking 更长，p50 可能从 158 s 涨到 200 s+，**必须重测**）。

### 7.3 阶段 1：基线与筛选（≈160 次 / 3.6 h）

1. **C0 在 3 个场景各 25 次**（先跑，因为它同时是 §6.3 的工况检查）。
2. 按 §6.3 判定每个场景是天花板/地板/健康，**在跑形态之前**定下主家族。
3. **P + a/b/c/d 在 3 个场景各 10 次**（筛选）。
4. **只做两件事**：① 判定 P 臂闸（§6.6）；② 按 §7.6 的规则淘汰。
   **筛选阶段的 p 值一律不作结论。**

### 7.4 阶段 2：确认（≈250 次 / 5.5 h）

1. 通过筛选的形态在 S1/S2/S3 各补齐到 25（按 rep 索引配对）。
2. 按 §5.3 的主家族做预注册检验。
3. 报告：主家族 + 次家族 + 探索性 + **强制附上 §5.4 的功效表与 §6 的失败模式检查结果**。

### 7.5 阶段 3（可选，不阻塞）：实机验证

只验证「模拟世界里 `executable=true` 的计划，在真游戏里能不能落盘」。
- **只许写 `7c93b3dd9e949c561e5aa529974973b18c856b45`**；`5c967065…` 绝不碰；
- 游戏实例独占，**串行**，一次一个；
- 它不是主判据的一部分：主判据在阶段 2 已经定型。它只回答"FakeGame 的近似有没有骗我们"。

### 7.6 提前停：什么时候允许，什么时候不允许

**允许提前停（只在这三条同时成立时）**：

1. **结构破损**：该形态任一自检失败（§2.0 的 7 条），或 `invalid_rate ≥ 3×` C0，或
   `exp_chars > 1700` 无法在预算内表达。⇒ 立刻停，改设计。
2. **方向反了**：筛选阶段的 P 臂显著（§6.6）。⇒ 停全实验，重设计。
3. **杜撰性失败**：筛选 n=10 后，该形态的 `ladder` 均值 **≤ C0 均值**，
   **且** 它在 §4.6 的三类可教错误（`LLM_ARGS`/`PATH_NOT_RECT`/`MACRO_REFUSED:prereq`）上
   的合计频次 **≥ C0 的 0.9 倍**（即"教了也没减少"）。⇒ 该形态淘汰，不再投 n=25。

**不允许提前停的情形**：

- **不许因为 p > 0.05 就停**。n=10 时 §5.4 说得很清楚：真效应也常报成阴性。
- **不许因为"看起来有希望"就提前宣布成功**。成功只由阶段 2 的预注册检验判定。
- **不许把某一形态在 S1 上的成功外推到 S2/S3**（§6.5：那正是"过敏"的形状）。
- **不许中途改经验文本**。若真想改，那是新的一格，重新计数（新的 `rep` 起点），
  并作为一个新形态报告，不与原形态合并。

**停一条的代价必须写进报告**：`淘汰 = 未检测到改善`，不是 `无效`。

---

## 8. 复现脚本（本设计期间用来核实前提的，可直接跑）

```bash
cd "D:/Projects/rea/Project work/shapez"

node .tmpverify/exp-plan/headroom.mjs        # §0.3 预算余量（547 → 6747，对照臂逐字节不变）
node .tmpverify/exp-plan/final-pipeline.mjs  # §0.1 文本 70% vs 世界 8.7%（主判据的依据）
node .tmpverify/exp-plan/ladder.mjs          # §4.4 质量阶梯的实测分布
node .tmpverify/exp-plan/power2.mjs          # §5.4 功效模拟（用实测分布）
node .tmpverify/exp-plan/detour.mjs          # §0.5 绕路率（不在 assess.mjs 里）
node .tmpverify/exp-plan/ttest.mjs           # 黄金动作过全流程（executable + 28%→56%）
node .tmpverify/exp-plan/multiround.mjs      # 多轮：28% → 56% → 83% → 100%
node .tmpverify/exp-plan/final-arms.mjs      # 基线臂的段长/段序/余量
node .tmpverify/exp-plan/scen3b.mjs          # S1/S2/S3 三个场景的 assess 差
node .tmpverify/exp-plan/portfix.mjs         # §0.4 端口格式 bug 的影响面
node .tmpverify/exp-plan/spotcheck.mjs       # 端口 bug 的原始样本
```

---

## 9. 最后：这份设计最可能错在哪

1. **最可能：主判据（FakeGame 世界效果）与真游戏不一致。**
   `FakeGame.apply` 只做 place/delete，不重算带子朝向、不模拟 tx 的原子性。
   `capacityOf()` 只按 `type` + `x/y` 做 BFS，所以**利用率是可算的**；但"这条线真的通吗"算不出来。
   如果模型的计划在模拟里 `executable` 而在真游戏里落不下去，本实验会系统性高估所有臂。
   **这是 §7.5 存在的全部理由。**

2. **次可能：三个场景其实是同一个场景。**
   S1/S2/S3 只差 `upgrade_levels`。如果"经验"实际学到的是"这台存档的 cutter 在哪"，
   三个场景会一起涨，看起来像"泛化"。**缓解**：报告里必须给出**每个场景的绝对值**，
   不许只给合并后的比率。

3. **第三：n=25 的功效只有 23%（升 1 档）。**
   即使某个形态真的有用，也很可能报阴性。**这是设计的已知局限，不是执行失误** ——
   报告首行必须写这句。

4. **(b) 的语料是我写的，可能写得太好。**
   我按实测错误频次挑的 8 条，正好覆盖了 §4.6 里三类"可教错误"。这会让 (b) 不公平地占优。
   **缓解**：(a)/(c)/(d) 的内容也必须覆盖同一批错误（(d) 天然如此，(c) 靠机械反馈保证），
   并在报告里列出每个形态**实际覆盖了哪几类**。
