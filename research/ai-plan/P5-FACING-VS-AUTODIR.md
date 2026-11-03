# P5：`opts.facing` 做出来了，但它败给游戏自己的自动定向

> 2026-11-03。这一轮的目标是「把铜送进 hub」（上一轮铜已经产出来了）。
> `opts.facing` 这个能力做出来了、验证通过了，**但最终没能修好那条链** ——
> 卡在一个早就记录在案、但我读到时没当回事的事实上。

---

## 一、先做了什么：`replace_run(opts.facing)`

真机上有 4 处 `BELT_HANDOFF_REJECTED`。模型**每一处**都用 `replace_run` 去修
方向错的那条带子，全部失败：

```
(1,-17) 的邻居证据不足以反解方向（入口 top / 出口 未知）
```

把 region 扩到 `[1,-18 .. 1,-16]` 也一样 —— 只要**包含**那一格就必然失败。

宏的判据是对的：只有一侧邻居时，另一侧在 3 个方向里任取一个都能让 `solveTurn`
成立，那是三选一不是唯一解，不能猜。但它让「修一条方向错的带子」变成无解。

所以加了 `opts.facing`：

```json
{"macro":"replace_run","args":{"region":[4,-8,4,-8],"building":"belt","opts":{"facing":"top"}}}
{"macro":"replace_run","args":{"region":[...],"building":"belt","opts":{"facing":{"entry":"bottom","exit":"right"}}}}
```

### 三个我踩过的坑（都写进了测试）

1. **`entry` 必须取 `exit` 的对面。** `belt-rules` 里没有 `entry === exit` 的合法
   形态（那是「直穿」，不是带子）。照抄会解不出任何形态。
2. **`solveTurn()` 对 `entry === exit` 返回 null。** 直线情形要用
   `beltEntry`/`beltExit` 直接找。
3. **`beltEntry`/`beltExit` 返回方向名（`"top"`），不是 0..3。**
   拿数字比会永远不等 —— 这一条让我「四个方向全失败」却看起来像没接上。

修完四个方向精确可控：

```
facing=top    -> r=  0
facing=right  -> r= 90
facing=bottom -> r=180
facing=left   -> r=270
```

---

## 二、然后撞上了真正的问题

我写了个受控实验（`.tmpverify/p5/fix-handoffs.mjs`），手动一处一处修，
验「这个 level 到底能不能通」。结果：

```
第 1 轮：80 处 handoff 问题
  [round1] 2 ops, dry_run 2/2 → 可执行
  [round1] 真跑 ok=true applied=2
第 3 轮：80 处 handoff 问题    ← 数字没变
  [round3] 2 ops, dry_run 2/2 → 可执行
  [round3] 真跑 ok=true applied=2
第 4 轮：80 处 handoff 问题    ← 还是没变
```

**tx 每次都成功，问题数一次都没少。**

### 一路查下来的四个错误（都是我的）

| 症状 | 真因 |
|---|---|
| 扫出 0 处（diagnose 报 3 处） | 我自己重写了判据。权威是 `collectTopologyFacts()` → `accepts(idx, cell, d)`，它把机器端口、隧道、hub 入口全纳入同一条规则 |
| `entry=undefined` | `exitDirOf` 返回**方向名**，不是索引 |
| 修了等于没修（entry 还是错） | `accepts` 的判据是 `beltEntry === OPP[fromDir]` —— 落点要从**来向的反面**收货。我写成了 `entry = dir` |
| 同上，第二次 | 上面那条修了 `formsWithEntry`，但传进宏的 `f.entry` 还是原始 dir。要传 `OPP[p.dir]` |

修完第二个之后，宏离线返回**完全正确**：

```
replace_run({region:[4,-8,4,-8], building:"belt", opts:{facing:{entry:"bottom"}}})
  -> r=0 rv=0 -> entry=bottom exit=top    ✅
planToTxOps 生成的 op:
  {"op":"place","building":"belt","x":4,"y":-8,"r":0,"rotationVariant":0}   ✅
```

**但落盘后读回来是 `r=180`。**

---

## 三、根因：游戏会按邻居强制重算带子方向

这个事实**早就记在仓库里**，我读到过但没当回事：

> `research/ai-plan/AI-CONTROL-STATUS.md:36`
> 「rv 由游戏按邻居自动算，且只在放置那一刻算一次。」

> `research/ai-plan/CONTRACT-MACROS.md:511`
> 「实机事故：`place{r:90}` 得到 `code=1` 直带 —— 游戏按邻居重算覆盖了调用方的意图。」

也就是说：

- 我们在 `replace_run` 里算对了方向 ✅
- `planToTxOps` 生成的 op 也是对的 ✅
- **`tx` 落盘时游戏按邻居重新算了一遍，把我们的意图覆盖掉** ❌

`opts.facing` 在离线层完全正确，在落盘层被游戏否决。这不是我能修的 ——
那是游戏行为。

---

## 四、这条链本身可能也修不好

顺着查下去还发现：那处 `(1,-17) → (1,-16)` 的问题，**真正该改的是接收方**。
而 `entry=bottom` 的三种形态里，`rv=0/rot=0` 会让出口回到源带子 —— **成环**。

也就是说那条链本身结构错误（两条带子互相指向），不是改一格能修的。

---

## 五、这一轮的实际产出

| 产出 | 状态 |
|---|---|
| `replace_run(opts.facing)` | ✅ 能用，9 条测试，3 个变异全部被抓到 |
| 契约层（spec / validator / 白名单 / 提示） | ✅ 完整 |
| 修好那条链 | ❌ 被游戏的自动定向挡住 |
| 铜送进 hub | ❌ 未达成 |

**诚实结论：这一轮做出来的是一个正确的、但在这个游戏里无法直接兑现的能力。**
`opts.facing` 仍然有价值（它让离线规划和审计能表达意图，也让 `dry_run` 的输出
可读），但它不能用来修真实世界 —— 除非找到「落盘时阻止游戏重算」的办法。

---

## 六、下一轮该往哪走

1. **先确认游戏的自动定向到底能不能绕过。** 上游源码
   `recon/upstream-full/src/js/game/systems/belt.js:156-185` 有 `updateVariants`
   的调用链。如果能找到一个「先放带子、再单独改 rv」的两步写法，facing 就能兑现。
   这是最值得先查的一条。
2. **如果绕不过**，那「修方向错的带子」在 shapez 里就是做不到的 ——
   模型该做的是**拆掉重建整段**（`remove_run` + 重新 `connect`），而不是
   `replace_run` 单格修。那要改的是 prompt 与候选池，不是宏。
3. 那条链的**结构性错误**（两条带子互相指向、成环）要单独处理 ——
   它不是一个方向问题。

---

## 七、测试

`replace_facing.test.mjs` 9 条 + 3 个变异：

| 变异 | 变红的用例 |
|---|---|
| `entry` 照抄 `exit` | F2 / F3 / F4 |
| 用数字比方向名 | F2 / F3 / F4 / F5 / F6 |
| 忽略 `facing` | F2 / F3 / F5 / F6 / F7 |

全量 **428/428 通过**。
