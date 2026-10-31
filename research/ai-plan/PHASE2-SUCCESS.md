# 阶段 2 闭环 —— 第一个真 success

> 2026-11-01。**loop 在真游戏上、用真 LLM、一轮一次 tx，自己修好了半成品世界。**

---

## 结果

```
outcome = success
reason  = null
level   = live
rounds  = 1
tx_count = 1
verdict = { achieved: true, level: "live", why: [] }      ← why 是空的
```

世界侧独立核对（不看 loop 的话）：

| 项 | 修前 | 修后 |
|---|---|---|
| 实体数 | 42 | **45**（补上 3 格带子） |
| `(1,-5)(1,-4)(1,-3)` | 空 | **三格 belt 都在** |
| `hub.stored_shapes["RuRu----"]` | 0 | **45**（并且在涨） |

复原后回到 42 实体 / delivered 0；用户存档 sha256 全程未变。

---

## 模型实际做了什么

**诊断**（只有两条，都准确）：

```
NO_PRODUCTION   窗口内 RuRu---- 产出 0（delivered 0/70）
DEAD_END        出口方向 bottom 的那一格上没有实体（货会堆在这里）
```

**计划**（真 LLM，`usage {in:860, out:2007}`）：

```json
{"macro":"connect",
 "args":{"from":{"$ref":"B34"},"to":{"$ref":"H1"},
         "opts":{"allow_replace":true,"prefer":"shortest"}},
 "why":"B34 is the product run's dead end; routing it into the hub fixes both
        NO_PRODUCTION and DEAD_END in one move."}
```

**它的 `say` 原文**：

> The kept half already flows out of the cutter's right port toward a run that
> dead-ends at B34, so **connect that belt's outlet into the hub and the delivery
> should start.**

**执行**：`applied: 3/3`，`rolled_back: false`，`diff.added: 3`。

---

## 这一轮修掉的 6 个堵点

按发现顺序。每一个都是「前面修完才露出下一个」。

| # | commit | 堵点 |
|---|---|---|
| 1 | `467913d` | `portsOf` 对带子方向算错（34 条真实带子里 21 条错） |
| 2 | `32262ad` | `connect` 的落盘坐标没有溯源 → `COORD_PROVENANCE` |
| 3 | `bc61642` | `slotsOf` 对带子返回空槽位 + `deriveFlows` 认不出纯带子计划 |
| 4 | `fd542c4` | `semantic.mjs` 八处 `slotsOf` 没传 rv → `PROCESSOR_REQUIRED` 误报 |
| 5 | `0f4d4de` | `provenance` 发给 mod → 2001 unknown field（**我自己引入的回归**） |
| 6 | `2e69971` | 执行面的「没换动作」判定也比了没执行过的宏 |

### 1–4 是同一个病

带子的方向由 `(rotation_variant, r)` 共同决定，而代码里凡是「按机器模板/静态 spec 查带子」
的地方全错。`portsOf`、`slotsOf`、以及所有 `slotsOf` 的调用点，修一处露一处。

这个 bug 能活这么久，是因为**既有测试只覆盖 r=0 的带子**（`beltExit(0,0)="top"`，
与静态 spec 恰好一致）。

### 5 与 6 是我自己的修复引入的

- **5**：加 provenance 只跑了离线测试，而 `FakeGame.apply` 不看字段 ——
  **纯离线测试结构上抓不到「协议字段」问题**。现在有 `wire_ops.test.mjs` 直接盯着
  「发给写面的 ops 长什么样」，并且做过证伪（退回 buggy 版本它必红）。
- **6**：修了「候选剔除」，漏了「执行面判定」这第二处同样的逻辑。

---

## 一个必须记住的方法论教训

**整个「方案 A（让 connect 自动覆盖既有带子）」是错的方案，而我差点做完它。**

我据此派出了契约改造、R13 放行设计、以及一个修复 agent。
是**红队 agent 在实现之前**跑了一个对照实验（用 `beltExit` 真几何重建链路）
才推翻的 —— 它发现「842 条候选全撞」不是搜索能力不足，是**起点算错了**。

修好 `portsOf` 之后，同一个场景 `ok=true, cells=[[1,-5],[1,-4],[1,-3]]` —— **零覆盖**。

> **在为一个「宏做不到 X」设计绕路之前，先验证宏为什么做不到 X。**

这一轮我在「origin 索引 vs footprint 索引」和「没执行的动作算不算试过」
这两类错误上各栽了两次，所以这次不只修代码，都钉成了测试。

---

## 边界（不要跳过）

1. **只测了这一个场景**：半成品世界、单个断点、补 3 格带子、一台 cutter。
2. **只有 n=1 次成功**。不足以说「稳定」。同样的输入再跑可能给出不同计划。
3. **模型这次用了 `opts:{allow_replace:true, prefer:"shortest"}`** ——
   而 `allow_replace` 在当前世界**并不需要**（零覆盖就够）。它多给了一个开关，
   恰好无害（路径上确实没有既有带子）。但换一个世界，这个开关可能造成静默覆盖。
4. **`success` 分支第一次被执行**，它之前的每一条路径都是这次才走到的。
5. **世界是人为构造的**（44 实体方案砍掉 3 格），不是自然产生的存档状态。
6. 冷启动（从只有 hub 的空世界建线）**仍未验证** —— 那是下一轮的靶子。

---

## 测试与提交

```
node --test src/**/*.test.mjs → 291 passed / 0 failed
```

| commit | 内容 |
|---|---|
| `467913d` | `portsOf` 带子方向 |
| `32262ad` | `connect` 溯源 |
| `bc61642` | `slotsOf` + `deriveFlows` 纯带子计划 |
| `fd542c4` | `semantic.mjs` 的 `slotsOf` 调用点 |
| `0f4d4de` | provenance 不发 mod |
| `2e69971` | 执行面 mustChange 判定 |

全部作者 `sqkl520 <sqkl520soap@gmail.com>`，无任何 AI 署名。
