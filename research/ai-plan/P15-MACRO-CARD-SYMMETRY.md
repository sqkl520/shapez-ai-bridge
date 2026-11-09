# P15 —— 宏卡片的信息对称：`when:` 行与偏好指令的移除

日期：2026-11-04
前置：P14 的实验发现「`remove_run` 少与 `$ore` 提示无关」，转而查卡片本身的表述。

---

## 1. 根因：卡片只有禁令，没有用途；另有一段定向偏好

两处结构性问题，都在 prompt 侧：

### 1.1 7 个宏里只有 `remove_run` 有 `whenToUse`

```
remove_run       whenToUse: 2   whenNotToUse: 3
connect          whenToUse: 0   whenNotToUse: 5
insert_machine   whenToUse: 0   whenNotToUse: 5
replace_run      whenToUse: 0   whenNotToUse: 5
trash_unused     whenToUse: 0   whenNotToUse: 3
extend_line      whenToUse: 0   whenNotToUse: 3
remove_machine   whenToUse: 0   whenNotToUse: 3
```

而 `renderCard` 只渲染 `whenNotToUse[0]`。所以模型看到的每张卡都是
「这个宏叫什么 + 参数 + **别用它**」。

### 1.2 `## MACRO PREFERENCE` 是一段**定向偏好**

原文：

```
Prefer replace_run / insert_machine / extend_line over connect: connect must find a
path and will not route through machines, so it often fails `occupied`.
```

这不是信息，是叫模型少用 `connect` —— 而 `connect` 是**唯一**能「凭空铺一条新路」的宏
（另外四个都要求端点已存在）。

而且那半句「often fails occupied」已经被 P12 的自动放宽推翻了。

实测（`.tmpverify/ore-ab/`，16 样本）：`replace_run` 10 次 / `connect` 6 次 /
`remove_run` 4 次。分布被这类句子压得很偏。

---

## 2. 三个改动

### 2.1 给 6 个宏补 `whenToUse`

每个宏 1–2 条，措辞基于实测场景。例如 `remove_run`：

> **拆掉一条已经作废的线**：某个矿机脚下没矿、某段带子通向垃圾场、
> 某个形状已经不在当前目标里 —— 这些带子永远不会再产货，留着只会占格子和干扰诊断。

`insert_machine`：

> **把一台机器放到矿上**：`at: {"$ore":"Ru"}` 会解析到离消费者最近的钌矿格 ——
> 这是唯一能给矿机指定矿位的写法。

### 2.2 `replace_run` 的代价表述对等

原来它唯一提到删除的那条是「想删除带子时不要用：remove_run（belt 模式的 replace
不减少实体数，用错会留下一条「换了个 uid 的同样的带子」）」——

**只说了 replace 的"无效"风险，没说它的"破坏"风险**。而两者其实是同一档：
机器模式下它删掉被 footprint 覆盖的带，belt 模式下它同样改掉原有拓扑。

现在第一条改成：

> **同样会切断下游**：换拓扑、展开 footprint 删带，都会让原本接在那些格上的下游断供 ——
> 与 remove_run 的代价同档，别以为「replace 不删东西所以更安全」。

### 2.3 删掉定向偏好

`## MACRO PREFERENCE` 缩成 `## CALL SHAPE`，只留对所有宏一视同仁的那条：

```
The whole plan is rejected if ANY call fails — so N calls = N chances to fail.
Prefer one call that solves the top blocker over several speculative ones.
```

「哪个宏能干什么」交给每张卡的 `when:` 行 —— 那里说比这里准，也不重复。

---

## 3. ★ 预算门控：`when:` 只在高预算下渲染 ★

这是本轮最费劲的部分，也是一次**真回归**的教训。

### 问题

`when:` 每卡 +58 字符 × 3 卡 = +174。而 `prompt_capacity.test.mjs` 的 D1 守着

> 插入 CAPACITY 不减少 `belts_shown`

CAPACITY 的余量窗口只有 **120 字符**。+174 吃掉它 ⇒ 带子从 11 掉到 **7** ⇒ D1 变红。

**那是真回归**：带子是**操作对象**（模型少了它就无对象可改），卡片描述是辅助。
按「加信息不许让已有信息变少」这条纪律，`when:` 必须让位。

### 走过的弯路（都记下来，别再犯）

1. 先试 `when` 190 / `not when` 170 ⇒ 多 1200 字符，直接把 L4-live 顶过 targetChars。
2. 收到 105/105 ⇒ 仍 +480。
3. 把 `when:` 和 `not when:` 合并成一行 55/95 ⇒ 每卡仍 +58。
4. 中性化 `MACRO PREFERENCE` 省下 ~70 ⇒ 不够。

**结论：在这个夹具的预算里，`when:` 和 CAPACITY 的带子名额不可兼得。**

### 最终方案

`when:` 只在 `prompt_tokens_max >= 4000` 时渲染：

```js
const whenLinesOn = limits.tokensMax >= 4000;
const s2 = renderCards(candidates, { includeWhen: whenLinesOn });
```

- 默认档（2800 tok）：渲染与加字段之前**逐字节相同**，D1/D2/B6 全不受影响；
- 生产档（4600 tok）：`when:` 出现，模型拿得到「该用」这个新信息。

`blocks.when_lines_shown` 记录它进没进 prompt（与 CAPACITY 同口径）。

实测：

```
默认 9800      when: 行 0 · 卡片段 1133
生产 16000/4600 when: 行 2 · 卡片段 1348
```

### ⚠️ 顺带抓到一个静默 bug

`names.map(renderCard)` —— `Array.map` 会把 `(item, index, array)` 三个参数
依次传进去，于是 `opts` 收到的是**索引数字**，`opts.includeWhen` 永远
`undefined`，`when:` 行**静默消失**且不报错。

必须写 `names.map((n) => renderCard(n, opts))`。

---

## 4. 测试

| 文件 | 条数 | 钉住什么 |
|---|---|---|
| `prompt_resource.test.mjs` | +4 (R9–R12) | 默认档不渲染 `when:`；生产档渲染；7 个宏都有 `whenToUse`；偏好指令已删 |
| `prompt_budget.test.mjs` | B6 改写 | 原断言「两档渲染完全相同」在小场景上本来就不成立（5 张卡 3040 字符，默认档装不下资源行）。改成断言真正该成立的：system 相同、只增不减、资源行不倒退 |
| `contract.test.mjs` | 锚点更新 | `replace_run.whenNotToUse[0]` 换了，锚点跟着换成 `cut-upstream-feeds` / `would-disconnect` |

全量 `node --test --test-concurrency=1 src/agent/` → **556 全绿**。

---

## 5. 没验证的部分（诚实边界）

**这些改动还没有跑 LLM 实验。** 上一轮（P14）的实验装置已删，且那次的
样本量本身就说明不了问题（n=8，Wilson 区间全重叠）。

所以现在只能说：卡片的信息结构对称了、偏好指令没了、默认档行为没变。
**不能说「宏选择分布会因此改善」** —— 那需要每组 n≥20 的重跑。

要验证的话，实验设计已经在 P14 §6 写好了：
给两臂「完全等价的两种修法」（一种 `replace_run`、一种 `remove_run`），
看模型选哪个、`why` 说什么。
