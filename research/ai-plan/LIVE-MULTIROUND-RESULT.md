# 真机多轮测试：「永远 partial」的风险不成立，但暴露了另一件事

> 2026-11-02。真机 level 5 世界（45 实体，目标 `Cu----Cu`），`ROUNDS_MAX=3`、`PARTIAL_APPLY=true`。
> 脚本：`.tmpverify/live-multiround/runner.mjs`

---

## 结果

```
目标形状: Cu----Cu    （level 5，打通 level 4 之后升上来的）
preflight: 45 实体

round 1: partial=false ops=2 calls=[replace_run]      ← 成功提交
round 2: 被拒 NO_REVERSIBLE_CALL  calls=[replace_run]  ← 换了参数，但产物不可撤销
round 3: 被拒 PLAN_REJECTED       calls=[connect]      ← 又换了宏，还是不行

outcome=halt reason=BUDGET_ROUNDS
verdict: achieved=false
why: [
  "L4-behavior 未通过（跑完 2400 tick 后 Cu----Cu 一件都没产出 —— 这条线在游戏里没跑起来）"
]

实体: 45 → 45 (+1 / -1)
stored 后: {..., "RuRu----": 241, "--RuRu--": 88}
```

---

## 三个结论

### 1. ★ 「永远 partial」的风险**不成立**

第 1 轮就是 `partial=false`（完整执行），它的 tx 真的落盘了（`applied: 2`）。

**没有出现「轮轮都提交一点、轮轮都 partial」的情况。**

### 2. ★ `NO_REVERSIBLE_CALL` 在真机上真的触发了

第 2 轮：模型写了一个 `replace_run`，宏**成功了**，但产物是机器/垃圾桶 ⇒ 被跳过 ⇒
一条可撤销的都没有 ⇒ `NO_REVERSIBLE_CALL`。

而**模型第 3 轮换了宏**（`replace_run` → `connect`）——
说明那条诊断的 hint（「换一条只涉及带子的修法」）**起作用了**。

⚠️ 但第 3 轮还是被拒（`PLAN_REJECTED`，R5 同格冲突）。

### 3. 真正的失败不是 partial，是「改产线」这件事本身太难

```
round 1: replace_run → 提交了 2 个 op，但跑完 2400 tick 目标形状一件都没产出
round 2: replace_run → 产物不可撤销
round 3: connect     → R5 同格冲突
```

模型试了三种修法，每一种都有问题。而第 1 轮那个「成功提交」的，
**世界验证下来没有产出**（`Cu----Cu` 0 件）。

⇒ 这是 `L4-behavior` 在做它该做的事：**不认「你以为成功了」，只认「hub 有没有进货」**。

---

## 路上修的一个我自己的 bug（很重要）

第一次跑报 `NO_DIAGNOSIS`（0 条诊断）。查下去发现是**我的 runner 把 goal 硬编码成 `'RuRu----'`**，
而世界已经升到 level 5、目标是 `Cu----Cu`。

`diagnose(obs, items, production, report, goal, handles)` 用 `goal` 找「有没有产线在造它」——
传错 goal ⇒ 它认为「RuRu---- 在造，没问题」⇒ 0 条诊断 ⇒ loop 立刻 halt。

**这个 bug 的形状值得记住**：

> 「NO_DIAGNOSIS」看起来像「世界很健康」，实际是「你问错了问题」。

而且它不是 loop 的 bug —— 是调用方的。但 loop 没有校验
「你给的 goal 和 obs.goal.requirement.shape 一致吗」。**那是一个可以加的防御。**

---

## 关于真机 `snapshot_load` 的一个警告

跑完之后我试图 `snapshot_load` 复原，结果：

- 桥接日志**没有** `snapshot restored` 那一行
- `in_game` 变 false，`tick` 消失
- 游戏进程 CPU delta = 0（渲染循环停了）
- 恢复了窗口（`ShowWindow` + `SetForegroundWindow` + `MoveWindow`）**也没救回来**
- 最后是**重开游戏**才恢复

⇒ **`snapshot_load` 在 loop 跑完之后触发会让世界卡进半加载状态**，
而且 `LIVE-LOG.md` 记录的「恢复窗口」这一招**这次无效**。

这是 `snapshot_load` 走 `load_save` 状态转换的已知风险
（`LIVE-LOG.md` 的 "World wedge"），但之前的记录说恢复窗口能救。**这次不能。**

**建议**：真机实验的复原改用「重开游戏 + `load_save`」，不要用 `snapshot_load`。

---

## 现在的状态

| 项 | 结论 |
|---|---|
| 「永远 partial」风险 | **不成立**（第 1 轮 partial=false） |
| `PARTIAL_APPLY` 判据 | 真机验证过，正确地让 `achieved: false` |
| `NO_REVERSIBLE_CALL` | 真机触发，且模型**换了修法** |
| 能不能打开 `partial: true` | **风险可控**（见下） |
| 真正的瓶颈 | **「改产线」本身太难**，不是原子性 |

---

## 我建议怎么处理 `partial:true`

**可以打开，但要配一条规则**：

> 如果某一轮 `partial: true` **且世界没有任何变化**（`tx.applied === 0` 或 diff 空），
> 那这一轮等于什么都没做 —— 应该按「失败」处理，让它计入 stall 指纹。

现在 `PARTIAL_APPLY` 会让 `achieved: false`，但**不阻止 run 继续**（第 2/3 轮照跑）。
这是对的：partial 的轮次可能为后续轮次铺路（那 2 个 op 真的改了世界）。

⚠️ 但**如果 partial 的 ops 为空**（所有调用都被跳过），那就是纯浪费一轮。

**这个检查我没加。** `NO_REVERSIBLE_CALL` 已经覆盖了「一条都没提交」的情况，
但「提交了但 ops 为空」是另一条路径（`planToTxOps` 返回空 ops ⇒ `PLAN_REJECTED`）。
两条合起来应该够了 —— 需要再确认一次。

---

## 诚实边界

1. **只跑了一次 3 轮的 run**。n=1，不能下统计结论。
2. **round 1 的 `replace_run` 提交了但没产出** —— 我只能说「它没成功」，
   不能说是 partial 导致的（它是 `partial=false`）。
3. **`--RuRu--: 88`** 是新出现的形状（level 5 的中间产物？），我没查它的来源。
4. **世界是 45 实体不是 42** —— 我那次 `snapshot_load` 部分生效了，
   恢复的是「打完 level 4 之后」的状态。这不是我预期的起点，但更适合测「改产线」。
