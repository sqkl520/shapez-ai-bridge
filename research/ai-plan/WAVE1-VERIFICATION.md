# 第一波成果：独立验收

日期：2026-10-28
红队 agent 跑 40 分钟无产出，已停止。这份是我自己做的验收。

---

## 变异测试：判据是否真的锁住

| 被变异 | 结果 |
|---|---|
| GDeleteReplay：`vanished` 恒空 | 被杀 ✓ |
| GDeleteReplay：`extraGone` 恒空（不多删的检查） | 被杀 ✓ |
| GDeleteReplay：`stillAlive` 不报（声明删的还在） | 被杀 ✓ |
| GRollbackRestore：身份不比（只看数量） | 被杀 ✓ |
| GRollbackRestore：内容不比（格/类型） | 被杀 ✓ |

**5/5 被杀，0 存活。** 两道新闸的判据是真的。

---

## 抓到的一处假绿（已修）

A1 的报告说它修了"async 回调传给同步 check"的问题，但**漏了 3 条**：

```js
check("tx: place_path 也走同一条可逆性预检", async () => { ... });
```

同步 `check` 拿到 async 回调会立刻打印 PASS —— Promise 里的断言根本不执行。
复现：

```js
check('x', async () => { throw new Error('永远不会被捕获'); });
→ PASS x    （然后进程崩溃在别处）
```

修成 `checkAsync` 后，真实条数从声称的 **87 变成 84** —— 之前有 3 条是虚构的。

已扫全部测试文件确认无残留。

---

## 一个重要的语义澄清：相邻带子的正确关系是 `exit(a) === OPP[entry(b)]`

我原以为相邻带子是"上游出口 == 下游入口"。**错。**

用铜线实机数据验证：

```
上游 (-8,-13) r0 code3: entry=bottom exit=right
下游 (-7,-13) r90 code1: entry=left   exit=right

aExit === bEntry        ? false   ← 我原来的理解
aExit === OPP[bEntry]   ? true    ← 正确
```

原因：`beltEntry` 返回的是"货从哪个方向**进来**"，所以下游的入口方向（left）
正好是上游出口方向（right）的反向。

`connect.mjs:592` 用的是 `aExit !== OPP[bEntry]`，**正确**。
`gates.mjs` 的 G7 用另一种口径（"实际前驱方位 vs 声明的 inDir"），也是对的，
两者不是同一个量。

---

## connect 的可用性边界

| 场景 | 成功率 |
|---|---|
| 仅机器为障碍（gap≤8） | **26/26 = 100%** ✓ |
| 真实世界 + 允许替换 | 22/31 = 71% |
| 真实世界 + 不允许替换 | 4/31 = 12.9% |

71% 的失败多数是「端口已被既有带子接走」的**正确拒绝** —— 宏在保护既有货流。
但这暴露了能力边界：**`connect` 只能做"加法"**。

真实改造场景大量是「从带子中间切开插机器」「把一段带子改道」，
这些需要 `remove_run` / `replace_run` / `trash_unused`，它们还没实现。

---

## 存档完整性

```
总实体 181
  balancer|regular 7      belt|regular 158      cutter|regular 2
  hub|regular 1           miner|regular 8       trash|regular 2
  underground_belt|regular 2   constant_signal|wires 1
```

关键实体：
- `(4,-13)` cutter ✓
- `(4,-14)` trash ✓
- `(-8,-11)` cutter ✓
- `(-2,-2)` hub ✓

目标 `Cu----Cu`、库存数据完整。**A1 误放 constant_producer 后写的清理脚本确实成功了。**

---

## 对终裁核心赌注的判断

终裁的核心赌注是「宏动作层能把真实存档从 0 抬起来」。这轮数据说明：

**部分支持，但还不能判定。**

- ✅ 几何能力达标（100%）
- ✅ 契约层明确禁掉了踩过的坑（禁止 `x/y/r/rv` 作为公开参数）
- ⚠️ 但只有 1/6 个宏实现了，且它只能做加法
- ❌ 6 个宏齐活之前，无法在真实场景验证"宏能不能表达一次完整改造"

**终裁自己写的判据是「L4 五 op 用 ≤5 个宏调用重写并通过运行时验证」。这个还没做。**
