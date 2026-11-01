# `actionSetHash` 的粒度：防刷 vs 探索

> 2026-11-02。`.tmpverify/ab-density/grind.mjs` 实测。

---

## 现象

`actionSetHash`（`loop.mjs:281`）只 hash **宏名**：

```js
export function actionSetHash(macros) {
    const list = (Array.isArray(macros) ? macros : []).map(String).sort();
    return sha256(list.join(","));
}
```

所以 `connect(M1→H1)` 和 `connect(M2→H1)` 算**同一个动作集**。

实测（`grind.mjs`，每轮换一个 miner、都连 hub，`ROUNDS_MAX=8`）：

```
outcome=halt reason=NO_PROGRESS_3X rounds=4 llm_calls=3
```

**换了 3 次「目标」，但宏名都是 connect ⇒ 动作集相同 ⇒ 第 4 轮 halt。**

---

## 这是好事还是坏事

### 好的一面：防刷

我担心的「模型靠不停换动作无限刷轮次」**没有发生**，而且不是因为 `ROUNDS_MAX` 拦住的
（配置是 8，实际只跑到 4）。是 `actionSetHash` 的粗粒度拦住的。

这个行为是对的：**换个参数值不算换了策略。**
如果 `connect(M1)` 和 `connect(M2)` 都失败，那说明「用 connect 这个思路」不行，
第 3 次还试 `connect(M3)` 确实是停滞。

### 坏的一面：真实探索会被误判

有些情况下「换目标」就是正解：
- 端口 A 被占 ⇒ 换端口 B
- `C1[right]` 是死路 ⇒ `C1[left]` 可能通

实测（`CONNECT-OCCUPIED-DIAGNOSIS.md`）：7 个唯一 `occupied` 里 **4 个是端口选错**，
修法就是「换端口」。而换端口**不改宏名**，所以在当前判据下算 stall。

---

## 该不该改

三个选项：

### A. 不动（当前行为）

**优点**：防刷稳，语义保守（只认「换思路」）。
**缺点**：4/7 的 `occupied` 正解（换端口）在 3 轮内做不完 ——
      但注意，`ROUNDS_MAX=3` 本来也只给 3 轮，这个缺点被预算盖住了。

### B. 把目标也纳入 hash（如 `connect:M1→H1`）

**优点**：换目标算新动作，能给探索更多机会。
**缺点**：模型可以靠不停换参数值无限刷 —— 需要 `ROUNDS_MAX` 真的拦住。

实测 `ROUNDS_MAX` **能**拦住（配置 8 就跑 8）。所以这个选项的风险可控。

### C. 折中：参数变了算「半个新动作」

太复杂，不做。

---

## 我的判断：**先不动**

理由：
1. 当前的粗粒度**防住了刷轮次**，而且是被实测验证的（`grind.mjs`）
2. 换端口的正解需要「知道哪个端口能用」，而那**本来就是 desc 该给的**（我已加图例）
3. 如果模型知道了正确端口，它第一次就该选对，不需要靠 3 轮试错

⇒ **与其放宽动作集判据，不如把端口可用性信息做得更准。**
后者是在源头解决问题，前者是在下游兜底。

---

## 如果将来要改

`actionSetHash` 的调用点只有一处（`countFingerprint`）。改的话：

```js
// 现在
const actKey = actionSetHash(st.lastMacros || []);

// 改成（带目标）
const actKey = actionSetHash(
    (st.lastCalls || []).map(c => `${c.macro}:${JSON.stringify(c.args?.from || c.args?.at || "")}`)
);
```

⚠️ 但 `st.lastMacros` 现在只存宏名字符串（`loop.mjs:1874`：`parsed.plan.calls.map(c => c.macro)`）。
要带目标得先改存整条 call。**这是一个 3 处联动的小改动，不是一行。**

---

## 诚实边界

1. **只测了一种「换目标」的方式**（换 miner 连同一个 hub）。
2. **`ROUNDS_MAX` 能拦住刷轮次这一点只测了一次**（配置 8、实际 4）。
3. **我没有测「换端口」的情况**（那才是 4/7 的正解）。可能 `connect(C1, port:left)` 和
   `connect(C1, port:right)` 也归一个动作集 —— 那是的，因为 hash 只看宏名。
