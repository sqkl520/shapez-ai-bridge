# 根因报告暴露的三处代码缺陷（尚未修复）

2026-11-23。来自 `.findings/ROOTCAUSE-COLOR-SLOT-2026-11-23.md`。
**三处都仍然存在于当前代码里。** 记录在这里防止遗忘。

---

## 背景：一个动作如何冻住整座工厂

```
2026-11-15 12:11:25   最后一个有产出的快照
2026-11-15 12:14:35   insert_machine(trash) @(-3,-8)
                      tx_plan 只声明 destroys:[15021] + placements:1
                      但 tx 落地后，两格**无关**的带子方向被游戏重算改了：
                        belt#14953@(-3,-7)  出口 bottom → right   （不再接竖列，拐向 hub）
                        belt#15019@(-2,-7)  入口 top    → left
                      apply 只报 added:1 removed:1，那两格翻转**零记录**
2026-11-15 12:19:51   全图产出归零（此后 508 个 L12 快照 produced_total 恒为 {}）
2026-11-15 14:11:27   remove_run 删掉 belt#14975 + belt#14976（painter 的 color 供料口）
                      ← 格子到这里才变空，比停产晚 1 小时 52 分
```

**「格子空」是「供料断」的后果。** 追「格子何时空」会追到第 14 步；
真正让 painter 停工的是第 3 步那个「放垃圾桶」。

---

## 缺陷 1｜`insert_machine` 静默改邻居方向，且不回报

**位置**：`src/agent/macros/place.mjs`（`orphaned_downstream` 那段），
配合 `src/mod/shapez-ai-bridge.js:2535` 的注释。

**现状**：`placeOne` 的注释**已经写清楚**了这件事：

> ⚠️ 邻居重算（本文件外，游戏侧）：`BeltSystem.updateSurroundingBeltPlacement`
> 挂在 `entityAdded` 上，每放一格都会把**周围一圈**的带子按邻居重算 rv 并覆写 code。
> 本 op 的 mismatch 只比对**放置那一刻**的读回值。

但 `orphaned_downstream` 只检查**被替换那条带子的直接下游**（`15021 → 15020`），
**不检查被重算的邻居**。实证：那次 tx 的 warnings 是

```
["replacing_belts","input_not_fed","input_belt_wrong_direction",
 "input_belt_wrong_direction","orphaned_downstream","wiring_mismatch","FLOW_UNVERIFIED"]
```

**没有一条提到 `14953` 或 `15019`。**

**为什么重要**：这是「算出来 ≠ 送到」的形态——代码知道会发生，注释写了，
但那条信息**从没进过模型眼前**。而它造成了一次不可逆的供应链坍塌。

**可能的修法**（需要评估代价）：
- `insert_machine` 的 `apply` 之后读回周围一圈的 `rv`，与放置前快照比对，
  变化的那几格作为 `neighbor_rewired` warning 返回。
- 或：把 `insert_machine` 也包进 `performImmutableOperation`（mod 侧有豁免机制，
  `belt.js:169`）。但注释说那是 `paste_blueprint` 用的，改这个宏的行为面很大。

---

## 缺陷 2｜`CHAIN_UNFED` 把「机器槽的供料带」和「矿机的死链」混在一个 `uids` 里

**位置**：`src/agent/loop/structural.mjs` 的 `CHAIN_UNFED`。

那次的诊断原文：

```json
{
  "code": "CHAIN_UNFED",
  "subject": {"handle": "M15", "type": "miner", "uid": 15103},
  "observed": "M15 脚底下没有矿（矿机被架空，永远不出货），它馈着的 2 条链因此全是死的",
  "evidence": {
    "handles": ["M15", "B342", "B341"],
    "uids": [15103, 14975, 14976],
    "barren_miner": true,
    "chain_belts": 2
  },
  "candidates": ["remove_run", "replace_run", "insert_machine"]
}
```

**三分之二是对的**：`M15@(-3,14)` 脚下确实没矿（最近的矿在 `(-10,10)`，距离 11）。

**但被一起列进 `uids` 的那两格带子，不是「它的死链的尾巴」——
它们正是 painter#13552 的 color 供料口。** 诊断自己不知道这件事，
而 `candidates` 第一条就是 `remove_run`。

**为什么重要**：`barren_miner: true` 这个证据把「矿机空转」的正确结论
传播成了「它下游的 2 格也该拆」的错误结论。那 2 格在 12:19 之前**是有货的**
（`items-last` 里 `(-4,15)` 上有 2 件 `green`），是前一步砍断它之后才变成死带的。

**可能的修法**：`uids` 里区分「矿机自己」与「它下游的带子」，
后者只在**确实没有任何机器在等它**时才算死链。
判据：那条带子的末端是不是某个机器的输入槽，而那台机器是否还活着。

---

## 缺陷 3｜`health` 把供应链塌陷记成 `cleanup`（正向）

**位置**：`src/agent/loop/health.mjs` + `classifyNetEffect`。

那天的 14 步拆除里，`dcb5` 的累计净效果是：

```
cleanup（改善但不是交货）— 死带子 169→161
```

而模型的 `say` 是：

> "deleting dead runs is the only cleanup the diagnosis supports this round"
> "Only cleanup has ever helped in this world"

**判据当时确实在奖励这个动作。** 每拆一格，死带子就少一条，
`classifyNetEffect` 就判一次 `cleanup`（正向）。

**为什么重要**：这条链是被**一格一格**拆掉的。每一步单独看都是「死带子减少 = 好」，
合起来是一次不可逆的坍塌。没有任何一层能看见「你在拆一条供应链」。

**可能的修法**：`cleanup` 需要附加判据——被删的带子末端是否有活着的机器在等它。
如果有，那不是 cleanup，是 `regressive`。

---

## 优先级建议

| 缺陷 | 可修性 | 影响 |
|---|---|---|
| 1（邻居重算不回报） | 中（要改 mod 读回） | **直接造成了这次事故** |
| 3（塌陷记成 cleanup） | 低（纯判据） | 让 agent 一路拆到 0 的诱因 |
| 2（`uids` 混两类） | 低（纯判据） | 把错误结论传播到具体施工 |

三处**互相独立**，可以分开修。
