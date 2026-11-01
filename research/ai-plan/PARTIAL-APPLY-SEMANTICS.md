# 部分执行（partial apply）：先定语义，再动代码

> 2026-11-02。用户选择「改 buildTxPlan 允许部分执行」。
> **这份文件只定语义，不含实现。** 实现前必须先过红队。
>
> 为什么这么谨慎：这是本仓库历史上**假绿事故最密集的地方**
> （`L3-METRIC-GAMING.md`、`QUALITY-METRICS.md`、`PHASE2-SUCCESS.md` 都记过）。

---

## 现状：全有或全无

`planToTxOps.mjs:604-621` 的 R1：

```js
if (n.result.ok !== true) {
    return reject("R1", "MACRO_REFUSED", `宏 ${n.macro} 返回 ok:false…`);
}
```

**一条宏失败 ⇒ 一条 op 都不生成。**

实测后果（`FIVE-ROUNDS-FINAL.md`，五轮 148 条去重样本）：

| calls | 样本 | 成功 |
|---|---|---|
| 1 | 2 | 2 (100%) |
| 2 | 19 | 2 (10.5%) |
| 3 | 45 | 4 (8.9%) |
| **4** | 48 | **0** |
| **5** | 33 | **0** |

`calls≤3` 8/66 vs `calls≥4` 0/82，Fisher **p=0.0012**。

⇒ 整轮成功率 ≈ 单条成功率的 N 次方。而模型 146/148 次写 2-5 个调用。

---

## 为什么不能直接改成「跳过失败的」

### 风险 1：判据会失去意义

`verifyRuntime` / `applyVerdict` / `strictVerdict` 的整套判据建立在
**「一次 tx = 一个完整计划」**上。改成语义不同的东西，那些判据全部要重审。

具体来说：
- `applyVerdict` 判 `requestedOps` 与实际 `applied` 是否一致
- `strictVerdict` 要求 `goalDelta > 0` 才算 `achieved`
- `phaseTwoVerdict` 要求 `strict.ok && goalDelta > 0`

如果「5 个调用做了 2 个」也被算成 success，那 `achieved: true` 就不再意味着
「这个计划成立了」。

### 风险 2：`mustChange` / `SAME_FINGERPRINT_MAX` 会失效

现在是「同一指纹第 2 次必须换动作」。如果部分执行算「有进展」，
指纹会变（世界变了）⇒ 模型可能靠不停「做成一点」来绕过硬约束。

### 风险 3：这是「假绿」的经典形状

历史上三次假绿：
1. `dry_run` 显示「108/108 全放、0 阻断」但结构是错的（`PHASE2-FINAL-REPORT.md`）
2. `outcome=success` 但 `hub.stored_shapes` 没涨
3. `synthesized: true` 的骨架节点被下游当成真节点

**「做了 5 个里的 2 个」和这三种是同一类**：报告说「有进展」，但实际没达到目的。

---

## 建议的语义（待红队攻击）

### 原则：**部分执行必须被明确标注，且默认不算成功**

```js
{
    ok: true,                      // 计划能执行
    partial: true,                 // ← 新增：有宏被跳过
    attempted: 5,
    applied: 2,
    skipped: [
        { index: 1, macro: "connect", code: "occupied", hint: "…" },
        { index: 3, macro: "replace_run", code: "precondition_failed" },
    ],
    ops: [...],                    // 只有成功的那 2 个调用的 op
}
```

### 判据侧必须改的三处

#### 1. `applyVerdict` 要区分「全部做到」和「部分做到」

```js
// 现在
const av = applyVerdict(ap.tx, { requestedOps: planned.txPlan.ops.length });

// 应该是
const av = applyVerdict(ap.tx, {
    requestedOps: planned.txPlan.ops.length,
    partial: planned.txPlan.partial === true,
});
```

**`partial === true` 时 `av.ok` 不能是 true。** 它可以是 `av.degraded = true`。

#### 2. `strictVerdict` 对 partial 的处理

现在 `strictVerdict` 要求：
- L0-L4 全绿
- 无 undecidable
- 无未声明破坏

**partial 时应该多一条：`noPartialApply`。** 因为「只做了一部分」意味着
计划没有完整实现，即使世界看起来变好了。

#### 3. `phaseTwoVerdict` 的 `achieved`

```js
// 现在
achieved: strict.ok && goalDelta > 0

// 应该是
achieved: strict.ok && goalDelta > 0    // strict.ok 里已经含 noPartialApply
```

⇒ 只要 `strictVerdict` 加了那条，`phaseTwoVerdict` 不用改。

---

## 三个必须先回答的问题

### Q1：部分执行的 tx 要不要提交？

**选项 A：提交**（成功的那些真的落盘）
- 优点：真的推进了世界
- 缺点：如果后续轮次失败，世界停在「半成品」状态

**选项 B：不提交**（只报告可做哪些）
- 优点：世界干净
- 缺点：等于没做，执行率还是 0

**我倾向 A**，但要求：**下轮必须有「完成剩余部分」的能力**。
否则部分执行只是把世界改成半成品就停手。

⚠️ 而这需要 `ROUNDS_MAX` 够用 —— 第一个改动（动作集计数）刚让重试成为可能。

### Q2：跳过的宏，它的「意图」要不要进下一轮的诊断？

如果不进，模型不知道自己漏了什么。
如果进，就是我在 `MACRO_REFUSED` 上已经做的事（hint 到 prompt）。

**应该是进**，而且必须带 `hint`（那个宏已经算出了解法）。

### Q3：怎么防止「部分执行」变成刷分工具？

**必须有一条硬约束**：

> **部分执行的那一轮，`improved` 字段必须是 `false` 或 `null`，不能是 `true`。**

现在 `improved` 恒为 `null`（`loop.mjs:1626` 的注释说「第一版不做」）。
如果将来要做，部分执行的轮次不能算改进。

---

## 实施顺序（如果红队通过）

| 步骤 | 内容 | 验证 |
|---|---|---|
| 1 | `planToTxOps` 加 `partial` 参数，默认 `false`（**保持现有行为**） | 现有 331 条测试全绿 |
| 2 | `planToTxOps` 在 `partial: true` 时跳过失败调用，返回 `skipped[]` | 新增测试：5 个调用 2 个失败 ⇒ ops 只含 3 个成功的 |
| 3 | `applyVerdict` 加 `partial` 判据 | 新增测试：`partial:true` ⇒ `av.ok === false` |
| 4 | `strictVerdict` 加 `noPartialApply` | 新增测试：partial 的 run **不**是 `achieved` |
| 5 | `loop.mjs` 传 `partial: true` | 端到端测试 |
| 6 | 跳过的宏的 hint 进下一轮诊断 | 复用 `prompt_diag_hint.test.mjs` 的模式 |

**每一步都要能独立回退。** 1-4 步不改行为（默认 `partial:false`），
第 5 步才真正打开。

---

## 我要求红队攻击的点

1. **「部分执行」会不会让 `achieved: true` 变成假绿？** 给出一个具体的失败序列。
2. **跳过的宏留在世界里的「半成品」会不会让下一轮误判？**
   比如 `remove_run` 成功但配对的 `replace_run` 失败 ⇒ 那条带子被删了但机器没放。
3. **`mustChange` / 指纹计数 会不会被部分执行绕开？**
   现在动作集计数已经让「换动作」不算 stall，部分执行又让世界变了 ——
   两条叠加会不会让模型无限续命？
4. **我应该先做哪一个**：部分执行，还是先让「跳过的宏」进下一轮诊断？
   （后者风险低得多，而且可能不需要改原子性）

---

## 诚实边界

1. **这份文件只是语义设计，没有代码。**
2. **我倾向「先做低风险的那半」**：让跳过的宏进诊断 + 提示模型「这轮只做了一半」，
   而不动原子性。如果那样执行率还是上不去，才值得冒险改 `planToTxOps`。
3. **Q1 的「提交」选项有一个我还没想清楚的后果**：
   如果模型做了 2/5 之后 halt（预算用尽），世界就停在半成品。
   这比「什么都没做」更糟吗？**我不知道，需要实测。**
