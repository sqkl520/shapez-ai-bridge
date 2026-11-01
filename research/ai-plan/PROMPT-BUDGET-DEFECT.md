# 真实存档上 CAPACITY 段根本没出现过 —— 预算缺陷

> 2026-11-02。这条比「经验形态」重要：**在真实战场上，我们最强的那个信号是缺席的。**

---

## 现象

`test/fixtures/saves/L4-obs.json` 是**真实 L4 存档**的 obs（181 实体 / 163 条带子 / 7 条诊断）。

用默认预算跑 `buildPrompt`：

```
total chars 9895
belts_shown 0 / 163        ← 一条带子都不显示
CAPACITY    ABSENT (dropped-for-budget)
```

**163 条带子，模型一条都看不到。产能诊断整段消失。**

---

## 根因

`prompt.mjs:78-84` 的 `PROMPT_RULES`：

```js
CHARS_PER_TOKEN: 3.5,
PROMPT_TOKENS_MAX: 2800,     // ← 输入预算 2.8k tok
LLM_IN_CHARS_MAX: 12000,
```

`resolveLimits()`（`prompt.mjs:1215`）：

```js
targetChars = min(PROMPT_TOKENS_MAX × CHARS_PER_TOKEN, LLM_IN_CHARS_MAX)
            = min(2800 × 3.5, 12000) = 9800
```

而 `loop.mjs:1742-1745` 调 `buildPrompt` 时**只传了** 5 个 budget 字段：

```js
budget: {
    rounds_left, llm_calls_left, tx_left, ticks_left, wall_ms_left,
},
```

**没有传 `in_chars_max` / `prompt_tokens_max`。**
于是上限恒为 9800，**无论场景多大**。

真实 L4 存档的 prompt 需要 10593 字符（12 条带子 + CAPACITY）。
⇒ **9800 的预算下，它必然降级。**

---

## 这不是「预算调小了」的问题，顺序有问题

`prompt.mjs:1706-1732` 的分配顺序：

1. 先定带子：**用不含 CAPACITY 的 prompt 跑截断循环**，直到 `s1 + user ≤ targetChars`
2. 量出剩余 `room`
3. `room >= 120` 才尝试 CAPACITY，不够就降级/消失

⇒ **CAPACITY 是最后一个被分配的。预算不够时，它第一个死。**

在这个场景上：163 条带子 + 7 条诊断就把 9800 吃光了，**CAPACITY 连 120 字符都分不到**。

---

## 修复：抬预算，实测有效

`buildPrompt` **本来就支持**覆盖（`resolveLimits` 的 `pick("in_chars_max", ...)`），
只是 loop 没传。

实测（真实 L4 存档）：

| `in_chars_max` | `prompt_tokens_max` | 实际 chars | belts_shown | CAPACITY |
|---|---|---|---|---|
| 12000（默认） | 2800（默认） | 9895 | **0 / 163** | **无** |
| **16000** | **4600** | 10593 | **12 / 163** | **有** |
| 24000 | 7000 | 10593 | 12 / 163 | 有 |
| 40000 | 11500 | 10593 | 12 / 163 | 有 |

**16000 / 4600 就饱和了**（再高不涨），因为 `STATE_BELTS_MAX = 12` 是独立上限。

### 代价

- **system 段逐字节不变**（实测 `base.system === big.system` 为 true）
- **user 段变长**：9895 → 10593（+698 字符）

⇒ 这不是「免费」，但**换来的是 12 条带子可见 + 产能诊断存在**。
对 L4 这种场景，这个交换显然是值得的。

---

## 为什么 2800 这个数不对

`PROMPT_RULES` 的注释说「输入预算 2.8k tok（S1..S6 合计）」。
按 3.5 字符/token，2800 tok = 9800 字符。

而 **163 条带子的场景，光带子表就需要远超 9800 字符**。
`STATE_BELTS_MAX = 12` 已经是「最多列 12 条」的妥协 ——
但如果连 12 条都放不下，那个妥协也没意义。

**这个预算值是在小场景（37 条带子）上调出来的，没在真实场景上验证过。**

---

## 建议的修复（未实施，需要决策）

### 方案 A：在 loop 里显式传更大的预算

```js
budget: {
    rounds_left, ...,
    in_chars_max: 16000,
    prompt_tokens_max: 4600,
},
```

**优点**：一行改动，实测有效，system 不变。
**风险**：真实模型的输入窗口够不够？4600 tok 对现代模型不是问题，
但要确认 LLM 端的 `max_tokens` 设置（当前跑 A/B 用的是 64000，那是**输出**上限）。

### 方案 B：改 `PROMPT_RULES.PROMPT_TOKENS_MAX` 的默认值

**风险**：会影响所有测试的预期值。有几个测试断言了具体的字符数。

### 方案 C：让预算随场景自适应

```
targetChars = max(9800, 估算的必需字符数)
```

**最正确，但最复杂**（要能估「必需」是多少）。

### 我的建议

**先做 A**（低风险、可逆、立即有效），验证真机上的效果，
再考虑要不要改成 C。

⚠️ **但 A 有一个前提没验证**：当前所有 A/B 实验（包括我跑的 `ab-correction`）
用的都是 **37 条带子的小场景**，在那个场景上默认预算够用（`12/37` + CAPACITY full）。
⇒ **我的实验结论不能直接外推到真实存档**，因为真实存档上 CAPACITY 根本不存在。

---

## 这一条对「经验形态」实验的影响

**经验段会第一个挤掉 CAPACITY。**

规划 agent 量化过（在 37 条带子的小场景上）：

| 经验块字符数 | belts_shown | CAPACITY |
|---|---|---|
| 0–400 | 12/37 | 正常 |
| 489 | 12/37 | **降级成 short**（options 两行消失） |
| 600 | 12/37 | **消失** |
| 800 | 9/37 | 消失 + 开始吃带子 |
| 1200 | 0/37 | 消失 + 带子全没 |

⇒ **在真实存档上这个悬崖更靠前**（本来就 0 余量）。

**所以：任何「加经验」的实验，必须先把预算抬上去。否则测的是
「经验 vs 产能诊断哪个值钱」，不是「经验有没有用」。**

---

## 复现

```bash
cd "D:/Projects/rea/Project work/shapez"
node -e "
import('./src/agent/loop/prompt.mjs').then(async prompt=>{
  const fs=await import('node:fs');
  const {buildHandles}=await import('./src/agent/loop/handles.mjs');
  const {diagnose}=await import('./src/agent/loop.mjs');
  const RAW=JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json','utf8'));
  const OBS=RAW.result||RAW;
  const h=buildHandles(OBS,null);
  const d=diagnose(OBS,null,OBS.production||null,null,'RuRu----',h,{});
  const common={goal:{shape:'RuRu----',level:4},obs:OBS,handles:h,diagnoses:d,
                candidates:['connect','insert_machine','replace_run'],lastRound:null};
  for(const [a,b] of [[12000,2800],[16000,4600]]){
    const p=prompt.buildPrompt({...common,budget:{in_chars_max:a,prompt_tokens_max:b}});
    console.log(a+'/'+b, 'chars', p.system.length+p.user.length,
      'belts', p.blocks.belts_shown+'/'+p.blocks.belts_total,
      'cap', p.blocks.s3_capacity?'YES':'NO');
  }
})"
```
