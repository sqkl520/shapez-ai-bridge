# P12 —— connect 的两个缺口：自动放宽 与 覆盖后果

日期：2026-11-04
触发：用户问「下一步」，我给的是「connect 的路径搜索 —— 撞到第一个冲突就放弃」。
**实测后发现那个判断是错的**，真缺口在别处。

---

## 0. 先推翻自己的判断

我以为 `connect` 的问题是「路径算法太弱」。实测结果：

```
candidateShapes([0,0],"right",[8,0],"right")   → 1037 条候选，长度 9..15
candidateShapes([0,0],"right",[8,6],"left")    → 1307 条候选，长度 15..21
```

`MAX_TURNS = 6` 的 DFS 枚举 + 同向腿整数拆分全枚举 + `budget = 曼哈顿 + 8`。
**算法不弱，几千条候选。** 它甚至已经能绕：

```
空路径:            OK 11 格
竖直墙(y=-3..3):   OK 11 格      ← 绕过去了
长墙(y=-8..8):     OK 11 格      ← 也绕过去了
机器墙(不可覆盖):  occupied      ← 正确拒绝
```

真正的问题在**撞上带子墙之后**：

```
密墙 x=6, y=-10..10（带子）:
  occupied — 340 条候选全部被挡住：撞既有带子 291 条（1 格 212 条 / 2 格 32 条 / …）
```

**212 条只差 1 格。** 宏自己算得出「覆盖 1 格就能通」，却只把这句写进 `hint`，
让模型下一轮再调一次。

而真实数据（`.tmpverify/ab-real/results-v*.json`，1405 次调用）：

```
connect 373 | trash_unused 229 | replace_run 118 | insert_machine 6 | remove_run 2
```

`opts.allow_replace` 极少出现 —— **模型不照做**。这条能力形同不存在。

---

## 1. 改动一：撞带子时自动放宽（但留痕）

`connect` 在返回 `occupied` 之前，若「撞的全是带子」且调用方没开 `allow_replace`，
**自己用 `allow_replace: true` 重试一次**。

### 为什么这是安全的

`connect` 是**只读规划**宏（`dry_run: true`），它不写世界。真正的写入由调用方按返回值组 tx。
所以「试一次」不产生副作用 —— 调用方仍可忽略结果、换端口重来。

### 为什么必须留痕（这是原测试守的东西）

原有一条用例叫「踩旧带子且未给 allow_replace，必须 occupied（**不许静默**铺上去）」。
那条禁令仍然有效，只是形式变了 —— 现在通过**三处**留痕：

| 通道 | 内容 |
|---|---|
| `auto_relaxed` | 机器可读：`{allow_replace, reason, tried, min_replace}` |
| `warnings[].code === "hub-entry-chosen"` | 人读：「这不是 hint，是**已替你做的选择**」 |
| `changed.removed_uids` + `consequences.replaced_uids` | 确实覆盖了谁 |

另加 `opts.auto_relax: false` 可以显式关掉（默认 `true`）。
它与 `allow_replace` 分开：前者是「别自作主张」，后者是「我允许覆盖」。

---

## 2. 改动二：覆盖既有带子必须报后果

`connect` 过去只说 `replacing-belts: 3 格` —— **没说那 3 格是谁的命脉**。

`replace_run` 早就有这个分析（`analyzeRemoval` + `would_disconnect`），`connect` 一直没有。

### 为什么不能直接复用 `remove.mjs`

它已经 `import { buildWorld, portsOf } from "./connect.mjs"`。反向 import 会成环，
而这两个文件都在模块顶层建常量表（`SHAPE_NAME` / `RV_*`）—— 环上的顶层 const
初始化顺序不可靠，那类 bug 只在某些入口顺序下出现，极难复现。

所以写了一个**本文件负担得起**的轻量版 `analyzeReplacedBelts`：顺着被覆盖带子的
**出口格**走一格，看谁原本在那里接货。这正好回答唯一重要的问题：
**它原本供着的下游会不会饿死？**

实测：

```
覆盖 uid=2@(5,4) → 下游 uid=3@(5,5) 会饿死
consequences.would_disconnect: [{kind:"starved-belt", uid:3, cell:[5,5],
  why:"(5,4) uid=2 被覆盖后，下游 (5,5) uid=3 再没有供料方"}]
warnings: ["replacing-belts", "replace-would-disconnect"]
```

两条新 warning 码进 `contract.mjs` 的闭集：
`replace-would-disconnect`（有后果）与 `replace-consequences-unknown`（分析失败）。
**后者不等于没有后果** —— 不许把它读成安全。

---

## 3. 顺带修掉的一个既存缺陷

`changed.removed_uids` 一直是 `[]`。

而契约（`contract.mjs` 的 `replacing-belts` 条目）写得很明确：

> 「把 `changed.removed_uids` 里的每个 uid 纳入 tx 的 destroys
>  （这是**唯一规范通道**，不要解析 detail 的格数）」

也就是说：即使 `allow_replace` 覆盖了 5 格旧带子，调用方从规范通道读到的也是
「什么都没销毁」⇒ 覆盖永远进不了 tx 的 destroys ⇒ **没有回滚**。

这不是我这轮引入的，是一直就错的。现在按 uid 升序填入。

---

## 4. 三个踩到的坑

1. **`world.cells` 的记录没有坐标** —— 只有 `{uid, type, isAnchor}`。
   第一版写 `cell: [nx.x, nx.y]` 得到 `[null, null]`，报告里出现一对空坐标。
   要用 `outCell`（刚算出来的那格）。
2. **`buildWorld` 的 rec 字段是 `rv`**，不是 obs 的 `rotation_variant`。
3. **`validateConnectArgs` 把 `allow_replace` 归一成布尔**，丢失了「没给」的信息。
   所以 `allow_replace: false` 也会触发自动放宽（`!opts.allow_replace` 为真）。
   这也是为什么要单独的 `auto_relax` 开关 —— **表达「别替我放宽」需要另一个字段**。

---

## 5. 测试

| 文件 | 条数 | 钉住什么 |
|---|---|---|
| `macros/connect.test.mjs` | 42 | 原有一条「不许静默」改写成「自动放宽但三处留痕」 |
| `macros/connect_diag.test.mjs` | 13（+5） | 自动放宽 / 撞机器不放宽 / 覆盖后果 / 下游也被覆盖不算切断 / 没覆盖不给字段 |

全量 `node --test src/agent/`：**556 全绿**。

诊断类的那 4 条改成显式 `auto_relax: false` —— 它们测的是 `occupied` 的**诊断质量**，
必须让路径真的走到失败分支才测得到。

---

## 6. 仍未解决

1. **`remove_run` 采用率 2/1405**。即使给了候选卡片（`remove_run: 8`）模型也不拆。
   这是**提示词层面**的问题，不是检测或算法层面。
2. **`connect` 不会主动避开「会切断主供料路」的走法** —— 现在只是报告后果，
   仍然挑最短/最少转角的那条。要不要把 `would_disconnect` 计入 `scoreOf` 是另一个决定，
   需要先有数据说明「模型看到警告会不会改主意」。
