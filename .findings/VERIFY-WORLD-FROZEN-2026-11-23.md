# WORLD_FROZEN 能改变模型行为吗？—— 四个实验的实证

2026-11-23。游戏没连着（`mod_connected: false`），全程离线跑，**没碰游戏**。
输入固定为 `r-20261123151728-52a3`（L12，`CbCbCbRb:CwCwCwCw`，100% 零产出）。
真调 LLM：`gpt-5.6-luna` @ `http://127.0.0.1:15721/responses`（Codex 协议），
`--api-key PROXY_MANAGED`，**未读 `ANTHROPIC_BASE_URL`**。

---

## 一句话

**能。但它改变的是「模型说哪句话」，不是「世界会不会变好」—— 而且它把模型推向了一个必败的动作。**

```
诊断进了 prompt           ✅ 11/12 样本点名 B85-B90（对照 0/12，p<0.0001）
模型的动作因此改变        ✅ remove_run 0/12 → 11/12（p<0.0001）
这些动作能落地吗          ❌ 0/12。B 组全灭；A 组 3/12、C 组 0/12
落地了世界会好吗          ❌ 没有任何一个落地的动作给出正面判词
                            A 组 replace_run(B692) → churn
                            D 组 connect(C8→C3.color) → regressive
                            E 组 remove_run(B522)      → churn
```

并且我在实验中撞到一个**比「这条诊断有没有用」更硬的事实**：

> **`WORLD_FROZEN` 给的 6 个句柄（B85-B90），恰好是 `buildTxPlan` 预演闸门必拒的那一端。**
> 从末端切 ⇒ 上游 159 格立刻变死带子 ⇒ 拒。
> 从源头端（它的 `subject` B522）切 ⇒ **1 op，放行**。
> 诊断自己算出了正确的 subject，却在 `handles` 里把被拒的那一端递给了模型。

---

## 实验设计（五臂，同一份 obs / 同一个 `diagnose()` / 逐字节对齐）

| 臂 | 内容 | prompt 字符 | 带子名额 |
|---|---|---|---|
| **A** 对照组 | 去掉 `WORLD_FROZEN`（真实反事实） | 13574 | 16 |
| **B** 现状 | 仓库原样 | 14114 | 18 |
| **C** 文字消融 | 只删掉那一段文字，**其余与 B 逐字节相同** | 14114 | 18 |
| **D** 指针改根部 | hint 改指 painter `C3.color`（真成因） | 14114 | 18 |
| **E** 指针改源头端 | hint 改指 `B522` + 解释「别从末端切」 | 14114 | 18 |

C 臂存在的原因：**A/B 之间混着两个变量**。实测——

```
A 组的 CANDIDATE MACROS: replace_run, connect, insert_machine, trash_unused, extend_line, remove_machine
                        ↑ 没有 remove_run 卡片！
B/C 组:                 remove_run, replace_run, connect, insert_machine, trash_unused, extend_line
```

`WORLD_FROZEN` 是 `remove_run` 进入候选表的**唯一入口**（`RETRIEVAL_TABLE.WORLD_FROZEN` 权重 9）。
去掉这条诊断，模型连「有 remove_run 这个宏、它怎么拼」都看不到。
所以 C 臂（保留卡片、只删那段话）才是「这句话本身」的效应。

A 与 B 的带子名额也不同（16 vs 18），因为 A 少一条诊断、少占 ~570 字符，截断循环少砍两条。
**A/B 的任何差异都不能单独归因于那句话。** 这是我加 C 臂的原因。

等价性：
- B/C：`user` 字数 14114 = 14114，逐行 diff 只有 DIAGNOSIS 段（`(+N more…)` 与表头计数一并修正），U+3000 补齐。
- B/D、B/E：各只有**一行**不同（`@170`），长度完全相同。

---

## 实验 A｜模型看到这条诊断后，选的动作变了没有

**n=12/臂，0 次调用失败，0 次重跑。**（三臂同轮并发发出，摊平网关漂移；实测 4 并发全 200。）

| 判据 | A（无诊断） | B（现状） | C（只删文字） | A vs B | C vs B |
|---|---|---|---|---|---|
| `remove_run` 出现 | **0/12** | **11/12** | **0/12** | p<0.0001 * | p<0.0001 * |
| 用到 WF 的句柄 | 0/12 | **11/12** | 0/12 | p<0.0001 * | p<0.0001 * |
| 提到堵点（259/通开/clog…） | 5/12 | 7/12 | 3/12 | p=0.34 | p=0.107 |
| 引用具体数字（259/165/99%） | **0/12** | **0/12** | **0/12** | p=1.0 | p=1.0 |
| `connect` 出现 | 6/12 | 2/12 | 8/12 | p=0.99 | p=1.0 |
| **真能落地**（`buildTxPlan` ok） | **3/12** | **0/12** | **0/12** | p=1.0 | p=1.0 |

（Fisher 精确检验，单尾；`*` = p<0.05。A vs B 是单尾「A 更差」，数值 >1 时已夹到 1。）

### 判据 1：疏通类占比 —— **已经饱和，没有上升空间**

A 组「疏通类（remove_run/connect/replace_run/trash_unused）占比」= **100%**，B = 100%，C = 100%。
三个臂、36 个样本，模型**一次都没选过**「新建」类的动作（insert_machine / extend_line）。

> 这一条判据按任务书设计，但实测证明它测不出差别 —— 因为基线已经满格。
> **真正的变化在「用哪个疏通宏」，不在「疏不疏通」。**

### 判据 2：有没有提到堵点 —— **半是，但从来没说过具体数字**

- 提到「堵 / 通开 / clog / jam / frozen」这类语义：B 7/12、A 5/12、C 3/12。**不显著**（p=0.34 / 0.107）。
- **三个臂、36 个样本，没有任何一次说出 259 / 165 / 99%。** 全部 0/12。

这条很重要：诊断里明明写死了「259 件 / 165 格（99%）」，模型的 `say` / `why` 里一次都没复述。
它读到了（否则不会去点 B85-B90），但**没有把那几个数字用起来做判断**。
这与 `PROGRESS 读数`那次（0/12 提到）形态相同 —— 数字进了 prompt，没进推理。

### 判据 3：选的句柄是不是 B85-B90 —— **是，而且非常干净**

| 臂 | 用到 B85-B90 的样本 | 具体 |
|---|---|---|
| A | 0/12 | 没有任何样本提到这几个句柄 |
| **B** | **11/12** | 11 个样本一字不差地写 `$uids:["B85","B86","B87","B88","B89","B90"]` |
| C | 0/12 | 全部 |
| D | 0/12（改用 C3） | — |
| **E** | 12/12 用 **B522** | — |

也就是说：**这条 hint 的「指路」能力是满分**。模型 11/12 精确照抄了那 6 个句柄。
`hint 必须带句柄` 那次 A/B（2/10→9/10）的成功在这里**复现了**，而且是 11/12。

**但（这是全部结论的核心）那 6 个句柄全是死路** —— 见实验 B。

### 一个副产品：A 组的最优解是 `replace_run(B692)`

A 组 3/12 落地，全部是同一个动作 —— 修 `BELT_HANDOFF_REJECTED`：

```json
{"macro":"replace_run","args":{"region":{"$path_of":["B692"]},"building":"belt","opts":{"facing":"bottom"}}}
```

这条判词是 **churn**（「世界形态变了，但规模、连通性、货量、目标全都没动」）。
B/C 两臂反而 0/12。也就是说：**在没有任何「先通开」的指引时，模型会去修那个它看得见的小红点，并且能落地** ——
只是那个落点对零产出的世界毫无用处。

---

## 实验 B｜把计划真喂给 `buildTxPlan`

`tools/replay-plan.mjs` 重放全部 40 个样本（36 个 + 4 条 20 行探针）：

```
真机（该 run 原本那两轮）  0/2 落地
实验 A/B/C               3/36 落地   （A 3 · B 0 · C 0）
```

**B 组的 11 个 `remove_run`，11/11 被同一条闸门拒掉，拒绝文案逐字相同：**

```
PLAN_REJECTED  预演：死带子 390 → 549（+159），到 hub 的带子 309 → 144
```

### 为什么必拒：闸门对这条带子的两端不对称

我手工扫了 path8（165 格 / 259 件）的各个切片：

| 删哪一段 | 结果 |
|---|---|
| `B85..B90`（**WORLD_FROZEN 给的句柄**） | ❌ 死带子 390→549（+159） |
| `B85` 单独 | ❌ 390→549 |
| `B90` 单独 | ❌ 390→554 |
| `B84`（上游一格） | ❌ 390→548 |
| 末 20 格 | ❌ 390→535 |
| 中段 30 格 | ❌ 390→450 |
| **`B522`（path8 的**第一格**，矿机 M5 的出料口）** | **✅ 1 op** |
| **`B522,B521,B520`（头三格）** | **✅ 3 op** |

原因是几何的：删末端 ⇒ 上游 165-x 格立刻失去到 hub 的通路 ⇒ 死带子暴涨；
删源头 ⇒ 只断一格，剩下的还是「一条通到 stacker 的静置带子」，闸门不在乎。

而 `WORLD_FROZEN` 的 `handles` 是怎么取的（`semantic.mjs`）：

```js
const endCells = worst.p.cells.slice(-6);   // ← 末 6 格
```

它取的是**最靠近终点的那 6 格**。注释写着「终点那几格是模型真正要动的地方」——
对「清空/改道」这句设想成立，对 `remove_run` **恰好相反**。

### 连「该从哪端切」这件事，诊断自己算对了却没送出去

`WORLD_FROZEN` 的 `subject` 修过一次（2026-11-23，为了躲 `dropInlets` 过滤），
改成了**路径起点**：`subject = B522`。prompt 里也确实渲染成了 `WORLD_FROZEN: B522 (belt)`。

```
1. WORLD_FROZEN [L2/blocker]: B522 (belt); … ; handles B85,B86,B87,B88,B89,B90; hint: …
                                ↑ 对的                          ↑ 被拒的那一端
```

**同一个诊断里，`subject` 是对的，`handles` 是错的。** 模型自然抓了 `handles`（那是唯一能直接塞进
`$uids` 的形态），于是 11/11 次都抓了错的那一端。

这是 `computed-but-never-delivered` 的又一形态，但比之前几次更隐蔽：
不是「算出来没渲染」，而是「**两个字段指向相反的方向，模型只能抓一个**」。

### 实验 D / E：把指针改对，落地率翻不翻？

既然 B 组的失败集中在「抓错端点」，就得做一次指针手术。

**D 臂** —— hint 改指真正的成因（`C3.color`，painter#13552 那个空槽）：

```
n=12，0 次失败。
  选中 C3.color      12/12
  ✅ 真落地           4/12
```

对照 B（0/12）：**选中 0/12 → 12/12，落地 0/12 → 4/12**（Fisher 两尾 p=0.093）。
4 个落地的全是同一条：

```json
{"macro":"connect","args":{"from":{"$ref":"C8","port":"out"},"to":{"$ref":"C3","port":"color"},
 "opts":{"rebind":true,"prefer":"cheapest"}}}
```

剩下 8 个失败的成因不是「选错方向」，而是**选错源头**：

| `from` | 次数 | 结果 |
|---|---|---|
| `B96` | 6 | ❌ `connect:port_already_bound`（那条带子已经被占） |
| `M7` | 2 | ❌ PLAN_REJECTED（铺 73 格，可交付 309→118） |
| **`C8`** | **4** | **✅ 18 ops（全中）** |

**E 臂** —— hint 改指源头端 `B522`，并明说「别从末端切，预演会拒」：

```
n=12，0 次失败。
  用到 B522        12/12
  ✅ 真落地         12/12      ← 满分
```

对照 B（0/12）：**0/12 → 12/12**（p<0.0001）。动作全部是
`remove_run {uids:{$uids:["B522"]}}`（1 op），中间 1 个样本多带了一个 `trash_unused`。

**这一臂是本报告最强的结果**：把句柄换到源头端、并把「为什么不能从末端切」写进 hint，
模型 12/12 一字不差地照做，`buildTxPlan` 12/12 放行。

### 但是 —— 落地 ≠ 世界变好

我把 E 的那 12 个动作（完全相同的 1 op）跑进 `worldHealth` + `classifyNetEffect`：

```
remove_run B522              判词 = churn
  why: 世界形态变了，但规模、连通性、货量、目标全都没动 —— 等价替换
  belts_reaching_hub  309 → 308
  items_on_belts      365 → 365
  belts_dead          390 → 390
  produced            0 → 0

after: B521 上游=无 下游=B520 货=259 段=165
after: M5   输出=out@right(→无)
```

**259 件还躺在 B521..B90 上，只是从矿机那一端断开了。** 世界仍然零产出。

其余几条「落地了」的动作，判词也一样难看：

| 动作 | ops | 判词 | 说明 |
|---|---|---|---|
| `C8.out → C3.color`（D 的落地款） | 18 | **regressive** | 到 hub 带子 309→302、死带子 390→411 |
| `M15.out → C3.color` | 31 | **stalled_growth** | 「结构变了，世界完全没动」 |
| `remove path20`（87 件纯蓝） | 55 | **cleanup** | 唯一一条判词正面的：死带子 390→335、悬空 264→209 |
| `remove_run B522`（E 的落地款） | 1 | **churn** | 见上 |
| `M9(Ru).out → L1.secondary` | 16 | **constructive** | 死带子 390→396 但**悬空 264→126**（唯一一条真改善） |
| `replace_run B692`（A 的落地款） | 2 | **churn** | 纯朝向修正 |

也就是说：**36 个真调 LLM 的样本 + 我手工扫的 ~30 个探针里，没有任何一个动作让这个世界的判词变成
positive / cleanup-with-contribution。** 唯一有正面嫌疑的 `M9 → L1.secondary`（constructive）
是「悬空带子大减」，那也只是把一条本来就死的链接进一条本来就死的链。

---

## 实验 C｜我自己读完整 prompt 之后的判断（第一人称）

参数照 `src/agent/loop.mjs:4216` 的真实调用重建（`job` 的 `buildPrompt` 参数表逐项对上：
`goal / obs / handles / diagnoses / candidates / production / itemsOnBelts / items / lastRound /
runLog / priorAttempts / goalChanged / obsoleteLines / recipe / budget`），
`in_chars_max=24000, prompt_tokens_max=5300`（`loop.mjs` 里那段「4600→5300」注释的取值）。
完整文本见 `.tmp-verify/expA/prompt-B.txt`（14114 + 4725 字符）。

### 这条诊断让我想去做什么

第一反应非常明确：**去删 B85-B90**。原因是这段话的信息密度极高、且指向唯一：

> 「整座工厂零产出。这条带子 259 件（99%），末端那台机器在等另一路料、永远等不到 ——
> `remove_run` 拆掉这条造错形状的死链，或 `connect` 把它改道。」

它做了三件事：(1) 给出全局事实（零产出）、(2) 给出物理证据（259 件 / 99%）、(3) 给出动作 + 句柄。
而且它**排在 DIAGNOSIS 第 1 行**，整个 prompt 里没有第二条诊断能和它竞争「世界最根本的问题」这个位置。

读到这里我的想法是「这条带子占着 165 格、运的是上一关的蓝+星形半片，对新目标一点用没有，拆掉它」。

### 但是读到 BELTS 段，我停下来了

```
B90 belt 上游=B89.out 下游=C4.lower 货=259 段=165
```

`下游=C4.lower` —— B90 是喂 stacker **lower** 槽的那一路，而 stacker 的另一路（upper，来自 B133）**货=0**。

也就是说：**stacker 只差一路料。** 拆掉 B90 等于把唯一的进料也拿走，stacker 从「半饱」变成「全饿」。
这一步在数值上会立刻被 `PLAN_REJECTED` 拒掉（我后来实测：+159 死带子），
但**读 prompt 的那一刻我就该看出来**——诊断说「末端那台机器在等另一路料」，下一句却是「拆掉这条带子」。
**「等另一路料」的解法是补上另一路，不是抽走这一路。**

这是这段 hint 最要命的地方：**它自己描述了病因（缺一路），却给了治标的动作（拆掉另一路）。**

### B85-B90 该交给哪个宏

读完全文，我的判断是：**哪个都不该交。**

- `remove_run`：必被拒（从末端切，上游 159 格失去通路）。实测 12/12 拒。
- `connect`：`下游=C4.lower` 已经被 B90 占着（`target_already_fed`）。实测拒。
- `trash_unused`：`remove.mjs` 的 `port_already_bound` —— 它不接已有下游的带子。实测拒。
- `replace_run`：B90 下面就是 stacker，原地换成机器是 `occupied`。实测拒。
- `insert_machine`：C4 周围是 B133/B90/C5/B134，`ambiguous_site`。实测拒。

**这 6 个句柄在当前的宏集合里没有一个是可执行的。** 这不是模型的错 —— prompt 把六个死路的名字
递到了它手上，并且用「`remove_run` 拆掉…或 `connect` 把它改道」指名推荐了其中两条。

### 那该指向哪里

我手工追了 13 跳（几何逐跳算的，没读坐标也没手推形状代数）：

```
C3(painter) 的 shape 槽 ← B107 ← B106 ← B105 ← B104 ← C2(cutter)
C2 的 primary ← B103 ← B102 ← … ← B96 ← B95 ← B94 ← B93 ← B92 ← B91 ← 【空地 (-9,3)】
C3 的 color 槽 ← 【空】
C3 的 out → B118 → … → B133 → C4.lower   ← 16 格竖列，全空
C4.upper ← B90（259 件）
C4.out → B134 → C5(rotater) → B135 → H1.primary   ← 到 hub 的唯一形状路
```

**这条链从头到尾没有源头。** painter 既没有 shape（C2 那条链的起点是空地），也没有 color。
它一件都喷不出来，于是那条 16 格竖列永远是空的，stacker 永远只来一路，C4 永远不吐货，
到 hub 的那条路永远是 0 —— 而 259 件就在 upper 那一路原地堵着。

B85-B90 上的 259 件是**这个死锁的症状**，不是成因。真正的第一步应该是：
**给 C3 接一路 shape + 一路 color**，或者干脆承认这条 L11 遗留线没救、整条拆掉重铺。

### 照它说的做，世界会变好吗

**不会。而且会变差。**

- 照 hint 做（删 B85-B90）⇒ 被闸门拒掉，浪费一轮；
- 侥幸落地（E 臂那种从源头切）⇒ 判词 `churn`，259 件还在，零产出不变；
- 照 D 那种改指根部（`C8 → C3.color`）⇒ 判词 `regressive`（死带子 390→411）——
  因为 C8 的输出本来是喂 C2 那条链的，夺走它等于同时弄哑 C2。

唯一一条判词正面的（`remove path20` = cleanup）诊断**从来没提过**：那 55 格 / 87 件纯蓝
在 hint 里只以「另有：87 件 / 55 格（末端无人接）」出现在**第 180 字符之后**，
被 `clip(180)` 截掉了 —— 而那是这个死世界里**唯一有正向判词**的动作。

> **诊断把唯一有效的动作截断了，把必败的动作放在了第一句。**

### 一个我必须诚实承认的事

如果我是模型，看到「259 件 / 165 格 / 99%」这种数字，我会想：「这条带子占了全世界 1/4 的带子，
而且运的是上一关的东西 —— 这条线该整个退役。」

但 `buildTxPlan` 会告诉我**整条 165 格一起拆更糟**（可交付 309→144，-53%，PLAN_REJECTED）。
也就是说：**这个世界当前不存在一条「模型读得懂、闸门也放行、世界真的变好」的路径** ——
至少在我扫过的 ~30 个动作里没有。

这不是「WORLD_FROZEN 不好」。这是「**这个世界已经坏到诊断层修不动**」。
`.findings/DEADLOCK-CHAIN-2026-11-23.md` §五第 2 条早写过一句话：
「拆掉它是对的，但拆掉之后 stacker 也失去唯一进料，整条链彻底停」。
今天的三次真调 LLM 只是把这句话变成了数字。

---

## 三个实验的结论是否一致

**不一致，而且不一致的方式本身是结论。**

| 问题 | 实验 A（选中） | 实验 B（落地） | 实验 C（人读） | 一致？ |
|---|---|---|---|---|
| 这条诊断能改变模型的选择吗 | **是**（remove_run 0/12→11/12，p<0.0001） | — | **是**（我读完也想删） | ✅ 一致 |
| 改变的幅度有多大 | 满分（11/12 精确照抄句柄） | — | 满分 | ✅ 一致 |
| 这些动作能落地吗 | — | **否**（0/12） | **否**（我会踩同一个坑，然后被拒） | ✅ 一致 |
| 落地了世界会变好吗 | — | **否**（churn / regressive / stalled_growth） | **否** | ✅ 一致 |

**A 与 B 的矛盾是「选中 vs 落地」这条旧教训的第五次复发，但这次有一个新成分：**

```
select-vs-land-gap (2026-11-21):  选中 9/10，落地 1/10
                              ⇒ 归因：模型选了"对的端点"，但路径撞了

本次:                          选中最优端点 11/12，落地 0/12
                              ⇒ 归因：**诊断给的句柄本身不可执行**
```

差别在于责任归属。上一轮是「模型选对了、宏算不出来」；这一轮是「**诊断指错了、模型完美地照做**」。
E 臂证明了后者：只要指针改对（B522 而不是 B85-B90），落地率就从 0/12 跳到 12/12 ——
**同一份 obs、同一个模型、同一套宏，只换了一个句柄。**

**而 A 的 3/12 落地 vs B 的 0/12 落地，靠 Fisher 单尾**（p 设计成单尾「A 更差」）**看不出**（p=1.0）。
只有两尾才 0.22 —— 不显著。**不能声称「WORLD_FROZEN 让落地率变差」**；
能说的只是**「它把 3/12 的那点落地机会也挤掉了」**（方向与先验相反，样本不足以判定）。

### 为什么 C 是这次最要紧的一臂

如果只看 A vs B，结论会是「WORLD_FROZEN 让模型从 connect 转向 remove_run」。
那句话技术上没错，但它会引出一个**错误的修法**：去调 hint 措辞，让它别推 remove_run。

C 臂证明：**只删掉那段文字（保留候选卡、保留带子表、长度完全相等），remove_run 就从 11/12 掉到 0/12。**
所以这句话的效力是真的、独立的，可以量。问题不在「它太会说服模型」，而在**它说服模型去做一件必败的事**。

---

## 附：`buildTxPlan` 的拒绝不是随机噪声

36 个实验样本的拒绝码分布：

```
connect:target_already_fed     11
PLAN_REJECTED（预演闸门）       14
trash_unused:out_of_scope       7
connect:occupied                1
```

A 与 C 两臂合计 14 个 `connect`，其中 **13 个目标是 `C4.upper`**（只有 1 个是 B699）。
`connect:target_already_fed` 在 36 个样本里出现 11 次，就是这一批的主要结局。
模型从 MACHINES 段读到 `C4 stacker 输入=lower@bottom(←B133)/upper@bottom(←B90)`，
又从 BELTS 段读到 `B90 … 下游=C4.lower`，于是推断「lower 有两路、upper 一定空着」，去喂 upper ——
而 upper 其实已经被 B90 占着。

> `MACHINE_STARVED` 说「stacker#14684 缺 [-2,6]」（lower 槽），
> 而 prompt 的 BELTS 段把 B90 描成 `下游=C4.lower`。
> 模型读到「lower 已有 B90」⇒ 「缺的必然是另一路」⇒ 喂 `upper` ⇒ `target_already_fed`。

**这两条诊断之间的矛盾，是 A/C 两臂里那 13 个 `connect C4.upper` 全部落空的直接原因。**
（C 臂 8 个 connect 里 8 个指向 C4.upper；A 臂 6 个 connect 里 5 个指向 C4.upper。）
`MACHINE_STARVED` 的 `missing_cells` 是 `[-2,6]`（lower 槽的 approach 格），
而 `handles.mjs` 给 B133 的 desc 也是 `下游=C4.lower` —— **两路都被标成 lower**。

我顺手查了这个：`slotRoleAt` 在机器同侧有两个进料槽时，用 `find` 取**第一个同向槽**：

```js
const hit = list.find(sl => sl.dir === facingDir);   // handles.mjs:624
```

stacker 的 lower/upper 都在 `dir=bottom`，所以 `lower,upper` 里永远返回 `lower`。
全库扫 60 个最近 run / 41353 条带子：喂「同侧多槽机器」的 285 条里，**59 条 role 被标错**。
本 run 的 `B90` 就在其中（`B90 → C4.lower`，真值是 `upper`）。

这条与 WORLD_FROZEN 无关，但它是一条**独立可修的缺陷**，而且它恰好是这个样本里
A/C 两臂 12 次失败的直接成因。我没有改 `src/`（任务书禁止），记在这里。

---

## 该怎么修（不越权改代码，只给判据）

### 1. `WORLD_FROZEN.handles` 必须同时给两端

现在 `handles = endCells.slice(-6)`。应改为：

```
handles: [...headCells.slice(0,3), ...endCells.slice(-3)]   // 源头端 + 末端
hint:    明说 "从源头端（B522 那一端）切；从末端切会让上游 N 格失去通路，预演会拒"
```

验收判据（必须跑到 `buildTxPlan`）：
- `remove_run {uids:[B522]}` ⇒ `ok === true`
- `remove_run {uids:[B85..B90]}` ⇒ `ok === false`

E 臂已经把这条修法的收益量出来了：**0/12 → 12/12 落地。**

### 2. hint 的第一句不能是「拆掉这条带子」

原文「末端那台机器在等另一路料、永远等不到 —— `remove_run` 拆掉这条…」，
把病因（缺另一路）和动作（拆这一路）写反了。

应改成「**它的下游 stacker 缺另一路料**，先补那一路；这条带子清掉是第二步」。
但要注意：D 臂证明「先补那一路」的落地率只有 4/12（源头选择错了），
所以这一条**单独改不足以翻转落地率** —— 它的价值是把模型从「必败的删除」挪到「可能成的连接」。

### 3. `clip(180)` 把唯一有效的动作截掉了

hint 原文 241 字符，渲染 180。第 180 字符之后是：

```
…另有：87 件 / 55 格（末端无人接）；3 件 / 2 格；0 件 / 1 格（末端无人接）。
```

`remove path20`（87 件纯蓝，`boundAcceptor=null`）是**唯一一个判词正面（cleanup）**的动作，
而它整条被截掉了。`WORLD_FROZEN` 是 `blocker` 级 + 排第 1，应当进 `CAP_WIDE`（400）那一档
（现在只有 `HUB_FED_BY_COLOR` / `HUB_INLET_THIN` 在那一档，`prompt.mjs:2967`）。

### 4. `slotRoleAt` 的同向多槽歧义（与本诊断无关，但同源）

`list.find(sl => sl.dir === facingDir)` 在 stacker/painter 这类同侧双槽机器上必错。
应比较 `sl.slot` 与实体实际格，或从 `dnCell` 反查。全库 59/285 受影响。
本 run 的 `B90 → C4.lower`（真 `upper`）是 A/C 两臂那 13 个 `connect C4.upper` 全部落空的直接成因。

---

## 附录：逐样本明细

### A 组

| # | 宏 | 落地 | 拒绝码 / 备注 |
|---|---|---|---|
| 1 | connect | FAIL | NO_REVERSIBLE_CALL connect:target_already_fe |
| 2 | replace_run | OK 2 | - |
| 3 | replace_run | OK 2 | - |
| 4 | connect | FAIL | NO_REVERSIBLE_CALL connect:target_already_fe |
| 5 | connect | FAIL | NO_REVERSIBLE_CALL connect:target_already_fe |
| 6 | trash_unused | FAIL | NO_REVERSIBLE_CALL trash_unused:out_of_scope |
| 7 | connect | FAIL | NO_REVERSIBLE_CALL connect:occupied / 1 个调用里 |
| 8 | connect | FAIL | PLAN_REJECTED / 预演：能真正交付的形状带子 309 → 111（-198 |
| 9 | trash_unused | FAIL | NO_REVERSIBLE_CALL trash_unused:out_of_scope |
| 10 | trash_unused | FAIL | NO_REVERSIBLE_CALL trash_unused:out_of_scope |
| 11 | replace_run | OK 2 | - |
| 12 | connect | FAIL | NO_REVERSIBLE_CALL connect:target_already_fe |

### B 组

| # | 宏 | 落地 | 拒绝码 / 备注 |
|---|---|---|---|
| 1 | remove_run | FAIL | PLAN_REJECTED / 预演：死带子 390 → 549（+159），到 hub |
| 2 | remove_run | FAIL | PLAN_REJECTED / 预演：死带子 390 → 549（+159），到 hub |
| 3 | remove_run+trash_unused | FAIL | PLAN_REJECTED / 预演：死带子 390 → 549（+159），到 hub |
| 4 | remove_run | FAIL | PLAN_REJECTED / 预演：死带子 390 → 549（+159），到 hub |
| 5 | remove_run | FAIL | PLAN_REJECTED / 预演：死带子 390 → 549（+159），到 hub |
| 6 | remove_run | FAIL | PLAN_REJECTED / 预演：死带子 390 → 549（+159），到 hub |
| 7 | remove_run+trash_unused | FAIL | PLAN_REJECTED / 预演：死带子 390 → 549（+159），到 hub |
| 8 | remove_run | FAIL | PLAN_REJECTED / 预演：死带子 390 → 549（+159），到 hub |
| 9 | remove_run | FAIL | PLAN_REJECTED / 预演：死带子 390 → 549（+159），到 hub |
| 10 | connect | FAIL | NO_REVERSIBLE_CALL connect:target_already_fe |
| 11 | remove_run | FAIL | PLAN_REJECTED / 预演：死带子 390 → 549（+159），到 hub |
| 12 | remove_run+connect | FAIL | PLAN_REJECTED / 预演：死带子 390 → 549（+159），到 hub |

### C 组

| # | 宏 | 落地 | 拒绝码 / 备注 |
|---|---|---|---|
| 1 | connect | FAIL | NO_REVERSIBLE_CALL connect:target_already_fe |
| 2 | connect | FAIL | NO_REVERSIBLE_CALL connect:target_already_fe |
| 3 | trash_unused | FAIL | NO_REVERSIBLE_CALL trash_unused:out_of_scope |
| 4 | connect | FAIL | PLAN_REJECTED / 预演：死带子 390 → 567（+177），到 hub |
| 5 | trash_unused | FAIL | NO_REVERSIBLE_CALL trash_unused:out_of_scope |
| 6 | trash_unused | FAIL | NO_REVERSIBLE_CALL trash_unused:out_of_scope |
| 7 | connect | FAIL | PLAN_REJECTED / 预演：能真正交付的形状带子 309 → 111（-198 |
| 8 | connect | FAIL | NO_REVERSIBLE_CALL connect:target_already_fe |
| 9 | connect | FAIL | NO_REVERSIBLE_CALL connect:target_already_fe |
| 10 | trash_unused | FAIL | NO_REVERSIBLE_CALL trash_unused:out_of_scope |
| 11 | connect | FAIL | NO_REVERSIBLE_CALL connect:target_already_fe |
| 12 | connect | FAIL | NO_REVERSIBLE_CALL connect:target_already_fe |

### D 组（hint 指 C3.color）

| # | 宏 | 落地 | from |
|---|---|---|---|
| 1 | connect | FAIL | B96 |
| 2 | connect | FAIL | B96 |
| 3 | connect | FAIL | M7 |
| 4 | connect | FAIL | M7 |
| 5 | connect | FAIL | B96 |
| 6 | connect | FAIL | B96 |
| 7 | connect | FAIL | B96 |
| 8 | connect | FAIL | B96 |
| 9 | connect | OK 18 | C8 |
| 10 | connect | OK 18 | C8 |
| 11 | connect | OK 18 | C8 |
| 12 | connect | OK 18 | C8 |

### E 组（hint 指 B522）

| # | 宏 | 落地 |
|---|---|---|
| 1 | remove_run | OK 1 |
| 2 | remove_run | OK 1 |
| 3 | remove_run | OK 1 |
| 4 | remove_run | OK 1 |
| 5 | remove_run | OK 1 |
| 6 | remove_run | OK 1 |
| 7 | remove_run | OK 1 |
| 8 | remove_run | OK 1 |
| 9 | remove_run | OK 1 |
| 10 | remove_run | OK 1 |
| 11 | remove_run+trash_unused | OK 1 |
| 12 | remove_run | OK 1 |

---

## 原始数据在哪

跑的时候在 `.tmp-verify/`（任务书要求跑完删掉，**已删**）：
`expA/{A,B,C}-NN.json` 36 个、`expD/D-NN.json` 12 个、`expE/E-NN.json` 12 个，
每个含模型 `raw` 原文；三个 `prompt-X.txt` 是各臂的完整 prompt。
**逐样本的宏 / 落地 / 拒绝码已经全部抄进上方附录**，这是删目录后唯一还留在仓库里的证据。

要重跑：`.findings/VERIFY-WORLD-FROZEN-2026-11-23.md` 里三个实验的设计（臂的构造、
`U+3000` 补齐规则、Fisher 的两尾/单尾口径、判据正则）都写全了，照着重写脚本即可；
`tools/exp-feed-sources.mjs` 与 `tools/exp-chain-hint.mjs` 是两个可以直接抄的骨架
（前者有三道等价闸、后者有 `padToRendered` 的补齐逻辑）。

### 调用失败 / 重跑记录

| 臂 | n | 失败 | 重跑 |
|---|---|---|---|
| A | 12 | 0 | 0 |
| B | 12 | 0 | 0 |
| C | 12 | 0 | 0 |
| D | 12 | 0 | 0 |
| E | 12 | 0 | 0 |

**全部 60 次真调 LLM，0 次 401/503/超时/非 JSON。没有缩水样本量，没有整组作废重跑。**

（首轮冒烟时出现过一次 `p` 计算 > 1 的 bug —— 是 Fisher 的 `logFact` 对负数返回 0。
已改成 `logChoose` + 支撑集约束，上面所有 p 值都是修后版本算的。）
