# P16 —— 真机验证：4 个 checkpoint RPC + 回滚链路

日期：2026-11-09
前置：P8–P15 全部只有离线验证。这一轮在真游戏里跑通了。

---

## 0. 为什么这一步必须做

这一轮改了 `src/mod/shapez-ai-bridge.js` **279 行**（新增 4 个 RPC）。而
`FakeGame` 不是真游戏 —— 离线只能验证纯逻辑，验证不了「这些 API 在真游戏里存不存在」。

如果 mod 加载时崩了，桥会完全不可用。这是一个**单点失效**。

---

## 1. 部署与加载

```
备份: shapez-ai-bridge.js.bak-predeploy-20261109-163338（263055 字节，11-03 版）
部署: shapez-ai-bridge.js（276828 字节，本轮版）
```

启动桥 → 启动游戏 → `mod_connected: true`。

**第一个信号**：mod 加载成功 = 新增的 279 行没有语法/API 错误。

---

## 2. 4 个 RPC 逐个验证

### `checkpoint_list`（空态）

```json
{"ok":true,"items":[],"total_entities":0,"max_count":8,"max_entities":60000}
```

### `checkpoint_save`

```json
{"ok":true,"name":"smoke-1","entities":136,"skipped":0,"skipped_uids":[],
 "dropped":[],"total_checkpoints":1,"total_entities":136,"tick":142627.49}
```

**136 个实体全部进快照，0 个被跳过** —— 与 `obs` 报告的 136 完全一致。

### `checkpoint_restore`（核心）

受控实验：删 3 条带子 → 恢复。

```json
{"ok":true,"name":"smoke-1",
 "rollback":{"steps":[
    {"step":"delete_modified","uid":10615,"ok":true},
    {"step":"delete_modified","uid":11221,"ok":true},
    {"step":"restore","uid":10512,"ok":true},
    {"step":"restore","uid":10513,"ok":true},
    {"step":"restore","uid":10514,"ok":true},
    {"step":"restore","uid":10615,"ok":true},
    {"step":"restore","uid":11221,"ok":true},
    {"step":"nextUid","ok":true,"from":11262,"to":11262,"reason":"unchanged"}],
  "errors":[],"rounds":2},
 "entities_restored":3,"entities_kept":133,
 "verified":true,"uid_set_equal":true,"geometry_mismatch":0,
 "after":{"entities":136,"expected":136}}
```

值得注意的三点：

1. **两个实体被判定为 `modified`**（10615 / 11221）—— 它们是删除操作**连带**改动的
   （邻居重算）。`rollbackToSnapshot` 用「删了重建」还原它们，这正是它注释里写的设计：
   `modified` 通常是邻居重算改了 code/rv，只有删掉重建才能把 code 也改回去。
2. **`rounds: 2`** —— 两轮就收敛（上限是 4）。
3. **`verified: true` + `geometry_mismatch: 0`** —— 自证通过，不是只信 `rollbackToSnapshot` 的返回值。

独立读回确认：

```
恢复后实体数: 136  带子: 120
被删的三条: 10512@2,-7 | 10513@3,-7 | 10514@4,-7   ← 原 uid、原坐标
```

### `checkpoint_clear` + 错误路径

```json
{"cleared":1,"reason":"explicit"}
→ list: {"items":[],"total_entities":0}

restore 不存在的名字 →
{"code":2004,"message":"not_found: checkpoint \"smoke-1\" not found",
 "data":{"hint":"Available: (none). Checkpoints are cleared by load_save/new_game."}}
```

### `load_save` 的清理

```json
{"ok":true,"op":"load_save","loading":true,"checkpoints_cleared":0}
```

`checkpoints_cleared` 是新增字段，已在真机上返回。

---

## 3. ★ 完整回滚链路（live 模式）★

比单独测 RPC 更重要：验证「`regressive` → 判定 → 真撤销 → 世界复原」这条链。

场景：在目标世界连删两轮**能到 hub 的**带子。

```
r1: 136 实体 / 120 带子 / 到 hub 71  →  remove_run(B44+B45) → tx ✓ applied 2/2
r2: 134 实体 / 118 带子 / 到 hub 69
    净效果: regressive（到 hub 71→69）
    撤销判定: transient（第一次 ⇒ 给模型一轮自修机会）
    → remove_run(B50+B57) → tx ✓ applied 2/2
r3: 132 实体 / 116 带子 / 到 hub 67
    净效果: regressive（到 hub 69→67）
    撤销判定: rolling_back（连续破坏）→ ✓ 已撤销，世界回到上一轮之前
    撤销后: 134 实体 / 118 带子 / 到 hub 69
```

`rollbacks` 记录：

```json
{"round":3,"decision":"rolling_back","dry":false,"target":"r2",
 "verified":true,"reverted":true,"why":["撤销成功，世界回到了本轮之前"]}
```

最终世界 **134 实体 / 到 hub 69** = 136-2 / 71-2 —— 第 2 轮的删除保留，第 3 轮的被撤销。
**完全符合设计**。

---

## 4. 真机抓到了两个离线抓不到的问题

### 4.1 ★ `findObsoleteLines` 把配方中间产物误报成残线 ★

真机数据（目标 `Cu------` / level 6）：

```
produced_total  = {----CuCu:25, CuCu----:25, Cu----Cu:25, CuCuCuCu:25}
delivered_total = {Cu----Cu:25}
```

第一版报了 `----CuCu` 和 `CuCu----` 两条「残线」。但 `Cu------` 的配方是：

```
CuCuCuCu ─mine→ ----CuCu ─cut→ Cu----Cu ─rotate→ Cu------ ─cut→
```

**`----CuCu` 是必经的中间形态**，它「交付 0」是因为它压根不该交付。
把它报成残线会让模型去拆一条正在正常工作的链。

账本法（`findStoredObsolete`）早就排除了配方闭包，**窗口法漏了**。
修法：`findObsoleteLines` 也接收 `recipe`，闭包里的形状一律不算残线。

修复效果：

```
修复前（无 recipe）: ["----CuCu", "CuCu----"]
修复后（带 recipe）: ["CuCu----"]      ← 只剩真正不在闭包里的
```

### 4.2 回滚会丢带子上的在途货（已知边界的实证）

```
r3 撤销后: 带上货 41
收尾观测:  带上货 40   ← 少了 1
```

这是 `rollbackToSnapshot` 注释里承认的边界（`non_serialized_state`：
`BeltPath.items` 不在实体 schema 里，回滚不保证在途物品）。现在有了具体数据。

**影响评估**：1 件货的损失 vs 保住整条线，代价可以接受。但必须在文档里说清。

---

## 5. 真机世界的完整画像

这次也是对「用户贴图那次」的精确复现：

```
L6 | Cu------ 0/270 | 实体 136 | 带子 120(15 机器) | 到 hub 71/120 59% · 死 49
死带子源头: rotater×39  miner×6  cutter×2  balancer×2
```

**39 条死带子的源头是 rotater** —— level 5 的 `Cu----Cu` 需要 rotate，
而 level 6 的 `Cu------` 不需要。整片 rotater 段作废。

这正是 P11 的 `OBSOLETE_LINE` 要抓的东西，而它现在在真机上算得出正确的证据。

---

## 6. 测试

全量 `node --test --test-concurrency=1 src/agent/` → **559 全绿**（556 + 新增 3）。

新增 `V41–V43` 钉住「配方闭包排除」（真机抓到的误报）。

---

## 7. 结论与剩余风险

### 已验证
- mod 新代码在真游戏里**加载正常**，4 个 RPC 全部可用。
- `checkpoint_restore` 能真正把世界还原（uid、坐标、几何全对）。
- 完整回滚链路（判定 → 撤销 → 复原）在 live 模式工作。
- `OBSOLETE_LINE` 在真机数据上算得出正确证据。

### 未验证
- **跨 run 记忆**在真机上的实际效果（只测了离线）。
- **关卡变更检测**的端到端（需要真有 level 升级发生）。
- **`connect` 自动放宽**在真机上的行为。
- 宏卡片 `when:` 行对模型选择的影响（需要 n≥20 的 LLM 实验）。

### 已知代价
- 回滚会丢带子上的在途货（实测 1 件）。
