# Prompt 重建 —— 任务简报

> 2026-11-02。给参与本轮的所有 agent 的事实汇总。
> 凡是本文件没实测过的东西，一律标「未验证」。**能自己跑的就自己跑一遍，不要信转述。**

---

## 0. 用户的要求（原文）

> **Q1**：这几个选项都有道理，要不然都试试看看哪个最好？
> （选项是：(a) 案例库 / (b) 手写玩法心得 / (c) 模型自己复盘 / (d) 别的）
>
> **Q2**：**C**，建的很丑陋也没有调理的绕远路，明明有可以快捷提高产能的方法却没有用
> （Q2 问的是「质量问题表现」，C = 修好了但用了很笨的办法）
>
> **Q3**：立刻做（修观察面）
>
> **Q4**：要求他可以像人一样先探索再动手也可以像有着整套经验的 agent 去闯关，
> 去挑战最高效率的机器

以及更早的一句判断（这是本轮的原动力）：

> 我觉得应该从模型的提示词方面下手，训练 AI 玩这个游戏的能力，总结经验，
> 因为目前我看到的做出来的东西依旧是很低质量的，看起来 LLM 的能力没有被完全完整全部的发挥出来
> 就像一个使用古代信息训练的大模型来问今天的问题一样

---

## 1. 我实测到的三个硬伤（都可复现）

### 硬伤 1：诊断点名的句柄，在句柄表里不存在

模型看到的 prompt（`.tmpverify/half-world/llm-raw/prompt-2.txt`）：

```
## DIAGNOSIS (3)
3. DEAD_END [L2/blocker]: B34 (belt); ... handles B34; candidates trash_unused,extend_line,connect

## BELTS (12 of 34; 2 referenced by diagnosis)
B31 belt 上游=M1.out 下游=L2.primary 货=2 段=1  [not reaching hub]
B32 ...
（没有 B34）
```

**表头声称「2 referenced by diagnosis」，实际只列了 B31。B34 完全不在表里。**

根因（`prompt.mjs:574-607` 的 `pickBelts`）：

```js
const byGoal = pickBeltsForGoal(tbl, all, goalShape, obs);   // 目标走廊优先
const chosen = [];
const push = h => { if (h && !chosen.includes(h) && chosen.length < cap) chosen.push(h); };
for (const h of byGoal) push(h);        // ← 先填满 12 个名额
for (const h of referenced) push(h);    // ← B34 挤不进来
```

`cap = PROMPT_RULES.STATE_BELTS_MAX`（12）。`byGoal` 把 12 个名额吃光后，
`referenced`（诊断点名、包括唯一正确的 B34）一个都进不去。

**表头的 `referenced.length` 是从 `selection.referenced` 算的（=2），
但实际 `chosen` 里没有它们 —— 统计与渲染不一致，是在说谎。**

**后果**：唯一正确的那条诊断指向一个模型看不见的实体。规则 8 还写着
「不要编造句柄，没有的话就在 say 里说」—— 模型能做的只有猜或放弃。
这就是它三轮都去放 cutter、一次都没提「补那 3 格带子」的直接原因。

### 硬伤 2：PRODUCTION 段永远是 unavailable

```
## PRODUCTION
unavailable (obs.production absent) — decide from the diagnosis, do not assume anything is running
```

根因（`prompt.mjs:1027-1030` 的 `renderProduction(obs)`）：读的是 `obs.production`。

但 loop 在 `loop.mjs:1731` 传的是：

```js
buildPrompt({ goal, obs: ob.obs, handles: st.handles, diagnoses, candidates, ... })
```

`ob.production` 是 `observeOnce` **单独读出来的第三个字段**，从来没被塞进 `ob.obs`。

**后果**：模型永远看不到产量/速率/卡在哪。它只能靠诊断的文字描述猜。
这也解释了它为什么反复重试同类动作 —— 它没有「改了之后产量变了吗」这个反馈。

### 硬伤 3：规则编号乱序 + 规则与诊断互相矛盾

规则编号在 prompt 里的实际顺序：

```
1. 2. 3. 4. 5. 11. 12. 6. 7. 8. 9. 10.
```

`11`（`$path_of` vs `$bbox_of`）和 `12`（2 格宽机器）是后插的，插在了 5 和 6 之间。
编号跳跃会让模型以为中间缺了 6 条规则。

**更严重的是语义矛盾**：

- 规则 10：「Most real tasks are MODIFICATIONS... **prefer converting that run over adding a parallel one**」
- 诊断 1：「a cutter fits at **0 place(s)** on the goal corridor」+ 候选 `replace_run, insert_machine, connect`

一个说「就地改造」，一个说「没地方放」。

---

## 2. 用户对「质量」的具体描述（这是本轮的靶子）

> **建的很丑陋也没有调理的绕远路，明明有可以快捷提高产能的方法却没有用**

拆开是三件事：

1. **丑** —— 布局差（绕远路、多余的带子、不整齐）
2. **没条理** —— 没有统一的结构
3. **有快捷提产能的方法却没用** —— 让它加 cutter 它不加，让它用 balancer 它不用，
   或者明明能升级机器却不知道

**注意**：这不是「计划被宏拒绝」（那是硬伤 1/2 的后果），
而是「**能跑通了，但产出的东西很差**」。

---

## 3. 现状基线（已实测，可直接引用）

### loop 端到端 14.0 秒

```
LLM          12.30s  87.6%   ← 唯一大头
observe       1.03s   7.3%   ← 其中 ~0.2-0.5s 是 solver，其余 RPC + Node 冷启动
verify        0.30s   2.1%
plan          0.24s   1.7%
其它          0.17s   1.2%
```

模型输出 **2007 tokens，实际 JSON 约 200 字符** —— 绝大部分是 thinking。
`buildPrompt` 稳态只要 **1ms**（首次 221ms 是 JIT 预热）。

### 产线产能：已打满

- 理论上限 **0.500 件/游戏秒**（游戏公式 `2 × processors(1) × 1/4`，瓶颈是单台 cutter）
- 实测 **0.500 件/游戏秒**（101.96 游戏秒产出 51 件）
- **达成率 100%**

⇒ 现在这条线不慢。用户说的「有快捷提产能的方法却没用」指的是
**它不会主动去加 cutter / 用 cutterQuad / 用 balancer 等**，不是算错了速率。

### 已有的一次真 success

`research/ai-plan/PHASE2-SUCCESS.md`：真 loop × 真桥 × 真 LLM，一轮一次 tx，
`connect(B34→H1)` 补 3 格带子，`achieved: true, level: "live", why: []`。

**但那次是「修一个断点」，不是「建一条产线」。** 用户说的「丑陋」是针对后者。

---

## 4. 现有的 prompt 结构（`src/agent/loop/prompt.mjs`，1385 行）

```
=== SYSTEM ===
  你是谁 + 输出格式 + 12 条规则（编号乱序）

=== USER ===
  ## CANDIDATE MACROS (n)     ← 每张卡：summary / params / not when / example / legal values
  ## GOAL                     ← shape / level / required / delivered
  ## RECIPE                   ← solver 算出来的配方（这段质量不错）
  ## HUB                      ← 入口数 + 已接数
  ## MACHINES (n of n)        ← 每台机器的槽位
  ## BELTS (n of m)           ← 带子（有 cap=12，会漏）
  ## PRODUCTION               ← 永远是 unavailable（硬伤 2）
  ## BUDGET                   ← 剩余预算
  ## DIAGNOSIS (n)            ← 诊断
  ## LAST ROUND               ← 上一轮用了什么宏、什么结果
  ## YOUR TURN                ← 输出格式提醒
```

**注意 prompt 里没有任何「效率」「美观」「布局质量」的概念。**
模型被要求「修好」，但没被告知「修好」之外还有「修得好」。

---

## 5. 安全约束

1. 游戏实例独占：同一时刻只允许一个 agent 做写操作
2. 用户存档 `5c96706563c0b74c4d2ce4c7f8bf7a244392de89` 绝不碰；目标是 `7c93b3dd...`
3. 不许 kill / 重启 shapezio
4. 写前必 snapshot，先 dry_run
5. 实机前确认 7777 上跑的是 `src/bridge/bridge.mjs`
6. **本轮大部分工作是纯离线**（改 prompt + 离线评测），不需要碰游戏

---

## 6. 纪律

主线程这一轮在「把推断当事实」上栽过多次。所以：

- **每一项结论必须附「用什么命令测出来的」**
- 没有命令的结论一律标 `未验证`
- **报告必须写「如果我是错的，最可能是哪里错」**

---

## 7. 本轮的边界

主线程只做：写简报、派 agent、汇总结果给用户。
所有设计、实现、评测都由 agent 做。发现与修复必须是不同 agent。
