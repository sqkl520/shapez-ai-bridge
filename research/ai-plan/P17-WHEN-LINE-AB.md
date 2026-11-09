# P17 —— 宏卡片 `when:` 行的 A/B：H1 被证伪，但方向有了

日期：2026-11-09
前置：P15 给 7 个宏补了 `whenToUse`，用预算门控只在高档渲染。P16 §7 把「`when:` 对模型选择的影响」列为未验证，需要 n≥20 的 LLM 实验。这一轮做了。

---

## 1. 先解决一个方法论阻塞

`when:` 原本**只能**由 `prompt_tokens_max >= 4000` 隐式触发：

```js
const whenLinesOn = limits.tokensMax >= 4000;
```

于是「有 `when:`」和「预算更大」永远是同一个变量。而预算更大意味着
**带子更多（0→12）**、**CAPACITY 出现** —— 这两个都不是无关变量。
那样跑出来的任何差异都归因不了。这就是这条实验一直做不了的真实原因，不是"没时间跑"。

**修法**：`resolveLimits` 读一个显式开关 `budget.include_when`（三态）：

```js
const includeWhen = (typeof b.include_when === "boolean") ? b.include_when : null;
// null = 按预算推断（旧行为，逐字节不变）
// true/false = 强制开/关（只用于 A/B）
```

配 `prompt_resource.test.mjs` 的 **R10b** 钉住，含一条关键不变量：
**去掉 `when:` 行后两臂必须逐字节相同，且 `belts_shown` / CAPACITY 出现与否必须一致。**

两臂实测：

```
ON   chars=13793 when=true belts=12/163 cap=true whenChars=731
OFF  chars=13055 when=false belts=12/163 cap=true whenChars=0
差 = 738 字符（全是 when: 行，7 张卡）
```

自检 8 项全过，其中「ON 去掉 `when:` 后与 OFF 逐字节相同」通过 —— 严格单变量成立。

---

## 2. 预注册假设

写在跑之前，跑完照判：

- **H1（主）**：有 `when:` 时 `remove_run` 的占比**上升**。
  理由：P15 观察到 7 张卡里 6 张只有 `whenNotToUse`；P14 §5 进一步推测
  模型在不确定后果时偏好不删。`when:` 给的是「这个宏存在的理由」，理论上该削弱这种规避。
- **H0**：无差别 —— `when:` 只是占预算的装饰。

---

## 3. 结果（n=50/臂，60 条预热 + 40 条扩充，全 100 条成功、零失败）

### 3.1 ★ H1 被证伪 ★

```
remove_run   ON 1/50 = 2.0%   OFF 0/50 = 0.0%   差 2.0 个百分点   Fisher p = 1.0000
```

**不成立。** 而且不是"样本不够所以没测出来"这种模棱两可：
OFF 臂基率是 0%，n=50/臂 能测出 ≥10 个百分点；实测差 2 个百分点。
`when:` 对 `remove_run` 采用率的作用**上限很小**，而这与 P14 的结论一致
（P14 测 `$ore` 提示时 `remove_run` 也是两臂 2/8）。

**两次独立实验、两个不同的 prompt 变量，`remove_run` 采用率都不动。**
这把「模型不愿拆」从"提示词问题"里彻底摘出来了 —— 它不是缺信息，是缺动机。

### 3.2 没有任何宏的选择发生显著变化

```
宏                ON        OFF       Fisher p
connect          22/50     25/50     0.6889
insert_machine   13/50     15/50     0.8240
replace_run      14/50     12/50     0.8200
remove_run        1/50      0/50     1.0000
trash_unused     11/50     10/50     1.0000
remove_machine    4/50      1/50     0.3622
extend_line        0/50      0/50     1.0000
```

七项全不显著。`when:` 行**没有改变模型选哪个宏**。

### 3.3 ★ 但它改变了模型怎么描述问题 ★

这是本轮唯一有信号的地方，**但必须标注为事后探索**（没有预注册）：

```
措辞                       ON        OFF      p       归一化(/千字符)
dead-end / 死路 / 悬空    24/50     15/50   0.1004    2.32 vs 1.66
backpressure / 回堵 / 堵死 10/50      4/50   0.1478    0.80 vs 0.29
conservative / 保守        0/50      0/50   1.0000    0.00 vs 0.00
```

方向一致、两臂都朝同一边、归一化后差距仍在（排除"ON 答得更长"的解释）。
但 **p=0.10，n=50 不够**。按本轮预注册的判据，这不能算结论。

真实的两臂 say 对比（同一批诊断，几乎同样的推理）：

```
ON  #14  "Two belt runs dead-end and back up the cutter, so nothing gets produced;
          trash those dead ends to let the line flow toward the hub."
OFF #30  "The cutter's output is piling up at dead ends, so nothing reaches the hub;
          route the stalled run at B83 into the hub and clear the other dead end at B129."
```

两块文字说的是同一件事。差别在措辞的**比重**，不在判断。

---

## 4. 为什么会这样：三个候选解释

### 4.1 模型没有逐字读中文 `when:`（证据：一致地弱）

我逐条查过 ON 臂的 30 条（n=30 时）文本里有没有 `when:` 行的独有措辞：

```
"凭空铺一条新路"    (connect 独有)    0/30
"实体数不变"        (trash 独有)      0/30
"比整条拆掉保守"    (trash 独有)      0/30
"离消费者最近"      (insert 独有)     0/30
"没有中间态"        (replace 独有)    0/30
```

一次都没有原样复述。不能据此断言"没读"，但能断言**它没有把 `when:` 当作可引用的依据**。
改变行为需要模型真的用上那条信息；现在的用量测不出来。

### 4.2 `when:` 行本身在制造反向牵引

`trash_unused` 的 `when:` 原话：

> 给一个永远没人要的输出接垃圾桶：…接上 trash 能立刻止住回堵
> （**比整条拆掉保守，实体数不变**）。

这是一句**明确指向 trash 而非 remove_run** 的话。如果我原本的 H1 是对的
（`when:` 削弱删除规避），这一句应该**抵消**它 —— 而它恰好长在 `trash_unused` 上，
也就是 P14/P17 两次实验里模型用得最勤的那个"安全替代"。

事后数据支持这个猜测的方向：`trash_unused` 在 n=30 时 ON 8/30 vs OFF 5/30（call 级 15 vs 7），
n=50 时收敛到 11/50 vs 10/50。**样本一大就消失，说明那是噪音，不是效应。**
所以这条解释我只能给出，不能确认。

### 4.3 P14 §5 的"风险偏好"假设，两次实验都间接支持

P14 说的是：模型只在**能明确说清后果**时才删。P17 给了 `when:`（每个宏的存在理由），
去测能不能让它更敢删 —— 不能。

那说明缺的不是"理由"，而是**对后果的确定感**。要让 `remove_run` 真的被采用，
得让模型**在执行前就知道后果**，而不是给它一句"这个宏是用来删作废线的"。
这正好对应 `dry_run` / 前置校验：`remove_run` 现在会报 `would_disconnect`
并点名会切断谁 —— 但那是**失败时**才报。**成功时它什么都不说。**

这一点可以直接验证，见 §6。

---

## 5. 我哪里想错了

P15 §1 的推理是：

> 模型看到的每张卡都是「这个宏叫什么 + 参数 + 别用它」。只渲染 `whenNotToUse`
> 会造成选择偏差 —— 一张卡如果全是「不要用」，模型就没有理由选它。

**前提是真的**（确实 6/7 张卡只有禁令），**推论是错的**。
"卡上没有理由"不等于"模型因此不选它"。补上理由之后选择分布纹丝不动
（七项全不显著）—— 这说明模型选宏的依据**根本不是卡片上的这些句子**。

那依据是什么？从这一百条 say 看，是**它对局面的判断**：
它读到 `DEAD_END` / `CHAIN_UNFED` 就去找能止住那个的东西，
而 `trash_unused` / `connect` 恰好是"不改变现有结构就能止住"的两个。
`when:` 行没有改变它对局面的判断，于是也没有改变它的选择。

这是一条更可操作的教训：**要让模型换动作，先让它的诊断结论变，
而不是往卡片上加说明。**

---

## 6. 下一步（按价值排序）

1. **`remove_run` 成功时的后果陈述**（最直接，能验证 §4.3）。
   现在它只在失败时报 `would_disconnect`。改成**成功后也报**
   「拆了 N 条，会切断这些下游 / 释放这些格」，并把它带进下一轮的 prompt。
   如果 §4.3 对，这会让模型在**下一次**更敢删 —— 与"卡片加理由"是两件事。
   这个改动小、可测、能复用 `analyzeRemoval` 已有结果。

2. **别再调 `when:` 行了。** 它现在是有效的（P15 的目标达成：7 张卡都说得出来路了），
   但它的作用**不在选择层面**。再调是空转。

3. 若仍要追 §3.3 那个措辞框架效应，需要 **n≈200/臂**
   （把 24% vs 30% 的差异从 p=0.10 压到 <0.05）。按本轮 ~50ms/样本的实测成本，
   约 20 分钟。但在拿到 §6.1 的结果之前不值得投 —— 因为它只影响措辞，不影响动作。

---

## 6.1 已实施：`removal-is-clean`（本轮就做了）

上面第 1 条做完了。发现的是一个比预想更尖锐的缺口：

**`remove_run` 在"拆得干净"时什么都不说。**

```
拆会断链的线 → warnings: ["would-disconnect", "stranded-items-unknown"]
拆干净的线   → warnings: ["stranded-items-unknown"]        ← 只有一条「不知道」
```

`stranded-items-unknown` 说的是「在途物品数无法离线确定」，那是**另一个话题**。
关于「这一刀安不安全」，返回里一个字都没有。

于是模型下一轮看到的世界是：「我删了 3 格」+「世界少了 3 条带子」。
它**没有依据**判断自己刚才那一步是成功还是闯祸。这正是 §4.3 说的确定感缺口。

修法：`would_disconnect` 为空时补一条正向陈述，两者互斥。

```
removal-is-clean: 这 3 格拆除不会让任何下游失去供料，也不会留下孤立输出：
                  每个被删格的相邻方要么也在删除集里，要么该方向本来就是空的。
```

格数从 `picked.length` 现算，不写死。

### 一个意外的副产品

**在 L4 夹具里根本找不到这种情形。** 实测：

```
L4 的 5 个连通段（尺寸 28/23/7/100/3），逐段尝试整段删除 —— 5 段全部会断东西。
逐格尝试前 60 条带子 —— 0 条是零后果的。
```

所以只能拿合成世界测（一条 3 格悬空带）。这本身是有效信息：
`removal-is-clean` **在健康世界里从不出现**，只在真有死路时出现 —— 正是想要的。
反过来说，L4 那个世界没有可安全拆除的冗余，它的问题是**缺连接**而不是**多带子**。

### 测试

`remove.test.mjs` 新增 3 项（75 项全过）：

- 拆悬空线必须报 `removal-is-clean`，且措辞要正面陈述后果；
- 与 `would-disconnect` **互斥**（有断链时不许同时说"干净"）；
- 措辞随实际删格数变化（1 格 vs 3 格必须不同）。

`contract.mjs` 的 `WARNING_CODES` 闭集登记了它，`contract.test.mjs` 的
`IMPL_WARNING_CODES` 同步加上 —— 这条闭集的作用就是防止"实现偷偷发一个契约里没有的码"。

全量 `node --test --test-concurrency=1 src/agent/` → **559 全绿**。

---

## 6.2 更要紧的发现：宏的 warnings **从来没进过 prompt**

做 6.1 的时候顺手查了 `removal-is-clean` 会不会真的到模型眼前 —— 结果发现
**所有**宏 warnings 都到不了：

```
src/agent/loop.mjs:2863   }, warnings: planned.warnings,   ← 只写进 transcript 的 plan 事件
src/agent/loop.mjs:1647   warnings: (txPlan.warnings || []).map(w => w && w.code)
                                                            ← 这是 txPlan 层的，不是宏返回的
```

`grep -rn "warnings" src/agent/loop/prompt.mjs` → **零结果**。
也就是说 `would-disconnect` 从 P4 就有了、`rv-drift` 从 P5 就有了，
**它们一次都没进过 prompt**，只躺在 `--runs` 目录的 transcript 里。

这不是"少加一段"，而是**两条通路断了**：

1. `planned` 里没有携带宏级 warnings（`planned.warnings` 是 txPlan 的）；
2. `lastPlanSummary` 里没有这个字段，`renderLastRound` 也没渲染它。

修法：

```js
// loop.mjs —— 从 executed[].result.warnings 收集，保留 detail（hint 太占地方）
macro_warnings: executed.flatMap(ex =>
    ((ex.result && ex.result.warnings) || [])
        .filter(w => w && w.code)
        .map(w => ({ macro: ex.macro, code: w.code, detail: w.detail || null }))
)
// lastPlanSummary（只在 continue 路径 —— success / offline_only 都 break 出去了）
macro_warnings: planned.macro_warnings || []
```

```js
// prompt.mjs —— renderLastRound 新增一段
consequences of last round's calls:
  · remove_run: removal-is-clean — 这 3 格拆除不会让任何下游失去供料，…
```

三个渲染纪律：

- **排除 `stranded-items-unknown`**。它每轮都出现（宏零写操作 ⇒ 拿不到 `debug_items`），
  与"这一刀安不安全"无关。渲染它只会淹没真正的结论。
- 每条 `detail` 截 150 字符，最多 3 条 —— 预算是硬的。
- 只在 `continue` 路径填。`success` / `offline_only` 都 `break` 出去了，下一轮不存在。

`prompt_diag_hint.test.mjs` 新增 3 项（H8b/H8c/H8d）钉住这条接线。

### 这个发现改变了 6.1 的意义

我原以为 6.1 只是"补一条警告"。实际上 `removal-is-clean` 之前，
**所有**宏观测到的后果都对模型不可见。这解释了 P17 §3.3 那个措辞效应为什么这么弱：
模型不是在读"后果"，它是在**从世界状态自己反推**后果 ——
而世界状态只告诉它「少了 3 条带子」，不告诉它「少得对不对」。

这意味着 [[vhealth-no-rollback]] 记的那个缺口（"能测出改坏了，但没有东西撤销它"）
其实还有一层：**模型连"改坏了"这个判定本身都看不到**。
回滚链路（P9）是机器在用的，不是模型在用的。

### 全量回归

`node --test --test-concurrency=1 src/agent/` → **562 全绿**（559 + 3）。

---

## 7. 数据位置

- `.tmpverify/when-ab/ab.mjs` —— 实验装置（含 8 项自检，自检不进就先停）
- `.tmpverify/when-ab/stats.mjs` —— Fisher + Wilson（含 5 项自检）
- `.tmpverify/when-ab/results.json` —— 100 条原始记录（含全文与 thinking）
- `.tmpverify/when-ab/results-n30.json` —— 前 60 条快照
- `.tmpverify/when-ab/run.log` / `run2.log` —— 两轮日志

### 统计实现踩的坑（记下来）

第一版手写的 Fisher 参数化错了（`d2 = c - (a-i)`），把 24/50 vs 15/50 报成 **p=0.94**。
统计量算错比结论错更危险 —— 它不崩、只安静地给一个"没有差异"的假象。
现在按定义实现并加了 5 项自检（教科书例子 / 行交换对称 / 极端对照）。

其中一项自检**我自己的期望值写错过**：`[[10,20,30,40]]` 我写"期望 0.0012"，
实际是 33% vs 43%，本来就没差异。那是把"数字看着大"误当成"差异大"。
已改成断言 p>0.2 并写明理由 —— 自检自己也会骗人，得让它把期望说清。
