# P9 —— 回滚：让「改坏了」变得可逆

日期：2026-11-03
前置：P8（度量）已经能**测出**「这一步把世界改坏了」。这一轮让它**可撤销**。

---

## 0. 起点：一个结构性的空洞

`opTx` 内部的快照**只活在一次调用的调用栈里**：
失败或 `dry_run` 时用它回滚，**成功时直接丢弃**。

所以 tx 之间没有任何撤销能力。一旦某个 tx 成功落盘、事后发现把世界改坏了
（实测：到 hub 的带子 140→133），**没有退路**。
用户贴图那次 41% 的带子到不了 hub，就是这么一步步积累出来的。

## 1. 关键发现：mod 里早就有完整的回滚实现

读 `src/mod/shapez-ai-bridge.js` 发现两个已有函数：

| 函数 | 行号 | 能力 |
|---|---|---|
| `snapshotWorld(root)` | 3057 | `entity.serialize()` 存**完整组件状态**（不只几何），含 `nextUid` |
| `rollbackToSnapshot(root, snapshot)` | 3281 | 4 轮迭代收敛、**先删后放**（避免撞格）、`modified` 用「删了重建」（因为 `code` 改不回去）、`restoreNextUid` 回收 uid 发号器 |

`dry_run` 与失败路径一直在用它们。**唯一缺的是「跨 tx 保留快照」**。

这改变了整个方案：不需要写反向 ops 的推导逻辑（那会很脆 —— 恢复不了 `code`/`layer`/组件状态），
只需要把快照存到一个能按名字取的地方。

## 2. 做了什么

### 2.1 mod 侧：四个新 RPC

| RPC | 作用 |
|---|---|
| `checkpoint_save {name?}` | 拍快照存进 `this._checkpoints`，返回实体数/被跳过的数/被淘汰的名字 |
| `checkpoint_restore {name, drop_after?}` | 恢复到该检查点，**自证**是否真的回去了 |
| `checkpoint_list` | 列出所有检查点（不含快照本体，那个太大） |
| `checkpoint_clear` | 全清 |

**三条设计约束**（都是被真实约束逼出来的）：

1. **只存内存，不落盘。** 快照是 `entity.serialize()` 的完整组件状态，
   5000 实体的世界是几十 MB 量级。checkpoint 的语义本来就是「这次会话里的最近几步」，
   不是「存档」。
2. **必须有上限，先进先出。** 默认 8 个；总实体数超过 60000 时也从最旧的开始丢。
   丢的时候**在返回值里说明** —— 让调用方拿到「你要的那个已失效」，
   比拿到「恢复成功但其实是旧世界」安全得多。
3. **`load_save` / `new_game` 必须清空。** 换世界后 uid 指向完全不同的实体，
   拿旧快照恢复就是把两个世界混在一起 —— 这是最危险的一种「恢复成功」
   （返回 `ok:true`，世界却是坏的）。两个返回值都带 `checkpoints_cleared`，
   让「静默失去撤销能力」这件事可见。

**`checkpoint_restore` 的自证**：不只信 `rollbackToSnapshot` 的返回值，恢复后再 diff 一次。
但**只看几何**（`code` / `rotation` / `origin`）—— 组件逐字节比较会让每次成功恢复都报失败，
因为 `Belt.assignedPath` 这类字段一定会被重算。

### 2.2 agent 侧：`loop/rollback.mjs`（判据）

这是最容易设计错的部分。核心矛盾：

> V-health 能测出「这一步改坏了」，但**这套系统只有 7 个局部宏、没有 `build_line`**，
> 所以「先拆旧线、下一轮再接新线」是唯一可行的施工模式 —— 而拆的那一轮**必然** regressive。

实测（L4 官方正解）：

```
第 1 轮 replace_run 把一条 run 换成 cutter+trash
  → 到 hub 的带子 140→133、死带子 23→27
  → classifyNetEffect 判 regressive
  → 但那一步是正解的第一步
```

如果「regressive 就回滚」，它会被撤销，模型永远做不完任何多轮改造。

所以判据是**多信号**的，六档：

| 判定 | 条件 | 撤？ |
|---|---|---|
| `none` | positive / cleanup / churn / inert / 未知档 | 否 |
| `converging` | regressive，但**在边拆边建**（机器 +N） | 否 |
| `converging` | regressive，但**累计仍在变好** | 否 |
| `transient` | regressive，但**这是第一次** | 否（给模型一轮自修） |
| `rolling_back` | 连续 regressive + 累计也差 + 没在建 | **是** |

### 2.3 离线不真撤（重要取舍）

`decideRollback` 在 `mock`/`replay` 下返回 `kind:"rolling_back"` 但 `rollback:false, dry:true`。

理由：`FakeGame.apply()` 只能改实体表，不做 `runGuarded` 的 immutable 回写
（真 tx 里游戏会按邻居重算带子方向）。**离线算出来的可达率不可靠** ——
这正是 `V-health` 进 `OFFLINE_UNVERIFIABLE` 的同一个理由。

基于不可靠的判据撤销世界，比不撤销更危险。离线仍然**判定**（测试能覆盖逻辑），
但不执行。

### 2.4 撤销之后

三件事，缺一不可：

1. **记成 `reverted`**（不是 `inert`）。「我改坏了然后撤了」与「我什么都没做」是两件事，
   前者证明这个动作是错的（该进跨 run 记忆）。
2. **重新 observe + 重新诊断**，留下 `WORLD_REVERTED` 标记。带着「坏世界」的诊断继续用它做决策会错。
3. **prompt 里说清「已经替你撤了，别去修」**：

```
## LAST STEP
your last change: reverted — UNDONE — your last change was rolled back automatically
  · 撤销成功，世界回到了本轮之前
⇒ The world is back to how it was BEFORE that change. Do NOT try to repair it —
  nothing is broken. The action you picked was judged harmful; choose a different one.
```

---

## 3. 三个踩过的坑（都在端到端第一次跑就现形）

### 坑 1：`healthBefore` 没重置 ⇒ 撤销被算成「模型又加了带子」

撤销把世界退回到上一轮 tx 之前，但第一次实现只更新了 `healthNow`。
下一轮算出 `177→179(+2) 带子 +2` ⇒ `constructive`，
时间线上看起来像模型又加了两条带子。**那是假的**：世界只是被我们还原了。

修：撤销后 `healthNow` 与 `healthBefore` **两个都**重读。

### 坑 2：撤销后的反馈退化成 `inert` ⇒ 模型会重复同一个动作

撤销那一轮直接 `continue`（不问 LLM），模型第一次看到反馈是在**下一轮**。
而那一轮的 `roundNetEffect` 必然是 `inert`（世界确实没再变）。
若照实传，模型得到「我上一轮什么也没干」—— 而真相是「你干了，被否了」。

修：加 `st.revertedPending`，让 `reverted` 的观感存活一轮，不被 inert 覆盖。

### 坑 3：`WORLD_REVERTED` 没进 `DIAG_CODES` ⇒ 直接抛异常

新增诊断码必须同时进三处：`DIAG_CODES`、`RETRIEVAL_TABLE`、以及自检。

---

## 4. 测试

| 文件 | 条数 | 钉住什么 |
|---|---|---|
| `test/mod_checkpoint.test.mjs` | 20 | 4 个 RPC 注册；`load_save`/`new_game` 清空；restore 走 `runGuarded`；自证只看几何；上限与淘汰；沙箱里真实跑 save/list/clear |
| `src/agent/loop/rollback.test.mjs` | 24 | 六档判据的每个边界；施工 vs 破坏；离线 dry；撤销后记账 |
| `src/agent/loop/rollback.e2e.test.mjs` | 11 | 检查点在 tx **之前**存；live 真撤销；世界真的回来（实体数 + 可达率）；`reverted`→`inert`；prompt 措辞 |

全量：`node --test src/agent/` 411 → **445 全绿**（+34）。

---

## 5. 仍然不做的（明确记录）

1. **不撤销状态类改动。** hub 库存、`productionAnalytics`、机器内部缓冲都不在实体 schema 里，
   obs 反推不出来。mod 的 `boundaries` 字段已经如实说明这一点
   （`non_serialized_state`）。
2. **不保证 uid 稳定。** `restoreNextUid` 只在回收区间没有活实体时才退发号器。
   大多数情况下 uid 保持，但**不是保证** —— 句柄由 `handles.mjs` 按 (y,x) 重新编号，
   所以即使 uid 变了，坐标没变的话句柄也不变。
3. **不做跨 run 撤销。** 检查点是内存里的，run 结束就没了。
   「撤销上一次 run」需要落盘快照，那是另一个量级的问题（磁盘、过期、与存档的一致性）。
4. **不做主线程等待 Agent 的阻塞**：这一轮的多 Agent 在这个环境里持续零输出
   （三次尝试、九个 Agent，只有两个有产出），所以关键事实是主线程直接读代码确认的。

---

## 6. 下一步

按「能多快让下一次 run 结果不一样」排：

1. **跨 run 记忆**：`runs/<id>/net_effects` + `rollbacks` 已经落了盘，
   下次 run 开头按 `goal_shape` 读回来，进 prompt 一段 `## PRIOR ATTEMPTS`。
   这样「同一个动作被撤销过」能变成先验知识，而不是每次重新踩。
2. **关卡变更检测**：`goal_shape` 变了就把旧产线的可达率算出来，判 `OBSOLETE_LINE`，
   让模型先拆再建。
3. **`connect` 的路径搜索**：撞到第一个冲突就放弃是「一坨玩意」的直接成因之一。
