# 一个我修错了地方的 bug，和它揭示的真实约束

> 2026-11-02。**这一轮的主要产出是一个「我判断错了」的记录。**
> 脚本：`.tmpverify/ab-density/fp.mjs` / `fp3.mjs`

---

## 我发现的东西

`MACRO_REFUSED` 诊断的 `evidence` 里没有任何 `fingerprintOf` 认的字段
（只有 `index` / `macro` / `macro_code` / `field`，而它只读 `handles` / `uids`）。

所以**所有**宏失败算同一个指纹：

```
M1→C1     MACRO_REFUSED   fp=sha256:8458c10d1
M2→C1     MACRO_REFUSED   fp=sha256:8458c10d1
C1→H1     MACRO_REFUSED   fp=sha256:8458c10d1
B130→H1   MACRO_REFUSED   fp=sha256:8458c10d1
```

四种完全不同的失败，一个指纹。

## 我以为这意味着什么

`countFingerprint`（`loop.mjs:1524`）：
- 同一 fingerprint 第 2 次 ⇒ 必须换动作
- 第 3 次 ⇒ `NO_PROGRESS_3X` halt

我推断：**模型试了 3 个不同的修法，会被判成「3 次毫无进展」而停掉。**
这看起来能解释很多事，是个漂亮的发现。

## 实际测试：修了，但没用

给 `evidence` 补上 `handles: [\`${macro}@${macro_code}\`]` 之后：
- 静态检查：**3 种不同失败 → 3 个不同指纹** ✓
- 但 `runLoop` 还是 **第 3 轮 halt**，`llm_calls=2`

## 为什么没用

`runLoop` 每轮轮首**重新跑 `diagnose(ob.obs, …)`** 并覆盖 `st.diagnoses`
（`loop.mjs:1700`）：

```js
let diagnoses = diagnose(ob.obs, ob.items, ob.production, st.lastReport, goal, st.handles, {…});
…
st.diagnoses = diagnoses;
const seenNow = countFingerprint(diagnoses, roundNo);
```

**所以 `MACRO_REFUSED` 根本到不了下一轮的指纹计数** —— 它被上一轮的
`st.diagnoses = [p.diagnosis]`（`loop.mjs:1852`）设进去了，但下一轮一开头就被覆盖。

实测确认（`fp3.mjs`）：

```
[round 1] 传入诊断: PROCESSOR_REQUIRED,NO_PRODUCTION,BELT_HANDOFF_REJECTED
[round 2] 传入诊断: PROCESSOR_REQUIRED,NO_PRODUCTION,BELT_HANDOFF_REJECTED   ← 世界诊断，不是 MACRO_REFUSED
outcome halt reason NO_PROGRESS_3X rounds 3 llm_calls 2
```

`llm_calls=2` 且 `rounds=3` —— 第 3 轮在**轮首**就停了，没花钱。

## 真正掐断多轮重试的是什么

**「世界没变 ⇒ 世界诊断相同 ⇒ 第 3 轮 halt」。**

这是**设计行为**，代码注释写得很清楚：

> 轮首计数：同一世界诊断第 3 次出现 ⇒ **在花掉这一轮的 LLM 调用之前**停；
> 第 2 次则强制换动作。

理由是对的：如果模型连试 3 次世界都没变，继续花 LLM 调用是浪费。

**但它的副作用是：被拒之后想重试，只有 2 次机会，且第 2 次还被剔掉一半候选。**

---

## 这解释了之前所有实验的一个困惑

`ONE-CALL-EXPERIMENT.md` 里，`calls.length` 与成功率的关系是
`calls≥4 → 0/82`。我当时归因于「乘方效应」（N 个调用都要成功）。

**现在有了第二层解释**：就算模型想靠多轮修正，它也**只有 2 次机会**
（第 3 轮 halt）。而 2 次乘以单条成功率 32% ⇒ 约 10% —— 和实测吻合。

⇒ **「允许部分执行」之外，「给模型更多重试机会」也是一条路，而且不需要动原子性。**
但它需要改变「什么算进展」的定义，让「试了不同的东西但世界没变」不算 stall。

---

## 我保留的改动

给 `evidence` 补 `handles` 这件事**本身是对的**，只是它解决的不是我以为的那个问题：
- 它让诊断**可区分**（transcript 可读、按指纹分组时有意义）
- 它**不会**增加重试次数

我在代码注释里把这个区分写清楚了，避免下一个读到的人重蹈我的误判。

---

## 一个需要决策的设计问题

**「同一世界诊断出现 3 次就 halt」这条规则，对「模型在试不同修法」是不公平的。**

两条改法，各有代价：

### A. 把「动作不同」也纳入「有进展」的判据

现在 `countFingerprint` 只看诊断指纹。如果加上「且上一轮的动作集相同」，
那「诊断相同但动作不同」就不算 stall。

**代价**：`actionSetHash` 已经在算（`loop.mjs:281`），改动小。
**风险**：模型可能靠不停换动作无限刷轮次 —— 需要配一个「总轮次上限」兜底（已有 `ROUNDS_MAX`）。

### B. 把 `ROUNDS_MAX` 从 3 提到 6-8

**代价**：更多 LLM 调用。
**风险**：如果没有 A，提高轮次也没用 —— **第 3 轮还是会被 `NO_PROGRESS_3X` 掐断**。

⇒ **A 是 B 的前提。** 我先前的「提高 ROUNDS_MAX」建议单独做是无效的。

---

## 诚实边界

1. **我只测了一个场景**（「连续 3 次不同失败」）。
2. **`llm_calls=2` / `rounds=3` 说明第 3 轮没花钱** ——
   这个设计其实很省，问题不在成本，在「机会太少」。
3. **A 方案的副作用没测**：模型会不会靠换动作刷轮次？需要一个专门的实验。
4. **本轮的核心产出是一个「我判断错了」的记录**，不是一个修复。
   那条 `evidence.handles` 的改动价值有限，但注释澄清了误判，值得保留。
