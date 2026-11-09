# P8 —— 先做度量：世界健康度、run 时间线、净效果判定

日期：2026-11-03
触发：用户贴图 + 「我觉得，应该需要日志输出，以便检查哪里出问题了……反思一下，现在这个架构差在哪里？」

---

## 0. 先认账

上一轮我报「达成 65%」。那是 **level 5** 的 65%。游戏因此升到了 level 6，
目标换成 `------CuCu`，而那条产线还在造 `Cu----Cu`。**新目标 0/270。**

而且那条产线 95% 是我用脚本手搭的，模型只做了最后一次 `connect`。
把那个说成「AI 自主跑通」是错的。

用户看到的「一坨玩意」是真的。复盘数据：

```
实体 136 / 带子 120 / 到不了 hub 的 49（41%）
debug_items：40 条入口带子，0 条有货
8 次 run 里 6 次 goal_delta = 0、实体数不变
```

---

## 1. 根因：没有任何量能区分「做错了」和「什么都没做」

在那个世界里，下面五种情况在 `goal_delta` 口径下**长得完全一样**：

| 发生了什么 | 旧口径 |
|---|---|
| 什么都没做 | 0 |
| 改了一条死带子的朝向 | 0 |
| 拆了 3 条带子又铺回去 | 0 |
| 挪了一台 cutter（切断了整条链） | 0 |
| 把一条死带子挪到另一个地方 | 0 |

模型学不到「刚才那步是错的」，人也看不出问题在哪。

**这是架构缺陷，不是模型不行。**

---

## 2. 做了什么

### 2.1 `src/agent/loop/health.mjs`（新）

一份可 diff 的世界体检快照：

```
L6 Cu------ 0/270 | 实体 136 | 带子 120(16 机器) | 到hub 71/120 59% · 死 49 | 带上货 0
```

字段：

| 类 | 字段 | 说明 |
|---|---|---|
| 目标 | `level` `goal_shape` `required` `delivered` `progress` `stored_goal` `produced_goal` | |
| 规模 | `entities` `belts` `machines` `by_type` | |
| 连通 | `belts_reaching_hub` `belts_dead` `reach_pct` `dead_by_source` | 物理口径（每跳验 `accepts`），走既有 `flowReachable` |
| 流动 | `items_on_belts` `paths_with_items` `paths_total` | 游戏自己数的 `itemsOnPath` |
| 形态 | `shape` | 身份+几何+朝向的哈希，用来区分 churn / inert |

**三条纪律**：
1. 纯函数 —— 不读时钟、不读文件、不 spawn（`diagnose` 的指纹依赖这条）；
2. 读不到的字段是 `null`，**不是 0**（「没读到」与「是 0」在 diff 里结论不同）；
3. 不复制几何真值 —— 可达性一律走 `topology.mjs#flowReachable`。

### 2.2 净效果判定（六档）

| 档位 | 条件 | prompt 里怎么说 |
|---|---|---|
| `positive` | 目标交付涨了 | GOOD — the goal advanced |
| `regressive` | 到 hub 的变少 / 死带子变多 | **BAD — this made the world WORSE** |
| `cleanup` | 死带子变少 / 到 hub 变多 / 带上的货变多，且没长大 | GOOD — the world got cleaner |
| `constructive` | 规模变了，但没坏也没交货 | NEUTRAL — you added things, the goal did not move |
| `churn` | 形态变了，但所有健康指标没动 | WASTE — the world changed but nothing improved |
| `inert` | 形态也没变 | WASTE — the world did not change at all |

`cleanup` 必须与 `constructive` 分开：删一条永远通不到 hub 的带子，
在「实体数」口径下与「什么都没干成」一样，但它**确实改善了世界**。
混在一起，模型学不到「清理是对的」。

`churn` 只能用 `shape` 指纹判 —— 所有指标对「A→B 与 B→A」都不敏感。

### 2.3 `timeline.log`（新，每 run 一份）

```text
── r1  L4  |  RuRu---- 0/70  |  实体 181  |  带子 163(17 机器)  |  到hub 140/163 86% · 死 23  |  带上货 0
    死带子源头 miner×14 balancer×7 cutter×2
    诊断 BELT_HANDOFF_REJECTED×2 DEAD_END×2 CHAIN_UNFED×2 PROCESSOR_REQUIRED×1 NO_PRODUCTION×1 (fp 134748b8f4)
    模型 replace_run
         say: swap the run for a cutter and a trash
    tx   ✓ applied 5/5
── r2  L4  |  RuRu---- 0/70  |  实体 180  |  带子 160(19 机器)  |  到hub 133/160 83% · 死 27  |  带上货 0
      · entities 181→180(-1)  · belts 163→160(-3)  · machines 17→19(+2)  ▼ belts_reaching_hub 140→133(-7)  ▼ belts_dead 23→27(+4)
    净效果: regressive（改坏了） — 到 hub 的带子 140→133；死带子 23→27
    ...
══ 累计（首轮 → 末轮）  · entities 181→180(-1)  ▼ belts_reaching_hub 140→133(-7)  ▼ belts_dead 23→27(+4)
   净效果: regressive（改坏了） — 到 hub 的带子 140→133；死带子 23→27
══ 收尾 outcome=halt reason=BUDGET_ROUNDS 轮 2 · LLM 2 · tx 1
```

**同时**，每步的判定进 `run_end.net_effects`、整次的进 `run_end.run_total`，
`runLoop` 的返回值也带（`net_effects` / `run_total` / `health` / `timeline_path`）。

### 2.4 `## LAST STEP` 进 prompt

`## LAST ROUND` 只说「上一轮调了什么、verify 红在哪」，**不含「世界因此变好还是变坏」**。
这是模型连续几轮把死带子从一处挪到另一处却不知情的直接原因。

现在：

```text
## LAST STEP
your last change: regressive — BAD — this made the world WORSE
  · 到 hub 的带子 133→112
  · 死带子 27→48
⇒ Repeating a change of this kind will keep making it worse. Pick a different target or a different macro.
```

排在 `## LAST ROUND` **之前**（先结论后细节）。首轮没有 before，整段不出现，不占预算。

### 2.5 `V-health`（新检查项）

这条是拆出来的最重要的东西。

**用户贴图那次的现场证据**：

```
apply:  applied 5/5        ← tx 说成功
L1-landing: ✓              ← 计划确实按请求落盘了
A-tx:       ✓
L3-flow:    ✗
世界:       到 hub 的带子 140→133，死带子 23→27   ← 但世界变糟了
```

每一层都在验「计划是否按请求落盘」，**没有一层验「落盘之后世界是否更差」**。
「在我的视角里全对，在世界的视角里更糟」是一个**结构上允许**的结果。

`V-health` 不看计划，只看 before/after 两份世界的连通性：

- `regressive` 才红；`cleanup` / `constructive` / `churn` / `inert` 都绿
  （没交货的一轮里，清理死带子与加东西都是合理的中间状态，判红会让正确的小步被回退）；
- 不是 `hardStop` —— 一次改坏了应该让 loop 下一轮自己修回来，而现在它有 `## LAST STEP` 知道自己改坏了；
- 算不出来 ⇒ `undecidable`，**不伪造绿**。

**离线不判**（进 `OFFLINE_UNVERIFIABLE`）。两个理由，第二个更重要：

1. 离线的 `afterObs` 来自 `FakeGame.apply()`，它只改实体表、不做 `runGuarded` 的
   immutable 回写，可达率变化不可靠；
2. **增量施工天然会短暂降低可达率。** 这套系统只有 7 个局部宏，
   「先拆旧线、下一轮再接新线」是唯一可行的模式。每一步都要求可达率不许降，
   等于禁止一切施工 —— 而这条判据本来是抓「无谓破坏」的。

⚠️ 这个决定不是拍脑袋：加完 V-health 之后，离线跑 L4 官方正解**10 条断言一起变红**
（`OFFLINE_ONLY` 那整条链失效）。是那个失败逼出了这条边界。

实测效果（同一份 L4 夹具、同一条计划，**live 判据下**）：

```
✗ V-health  这次改动把世界改坏了：到 hub 的带子 140→133；死带子 23→27
hardFails: [ 'L3-flow', 'V-health' ]
why: [..., '有可信检查项为红，不能算跑通：V-health']
```

而在离线，同样的红会被归为 `untrustworthy`，记录进 `## LAST STEP` 与 `timeline.log`，
但**不阻止** `offline-only`。

---

## 3. 顺带暴露的两个 bug（都已修）

1. **`st.healthBefore` 在比较之前就被覆盖** ⇒ 每轮自己比自己 ⇒ timeline 连着几条 `inert`。
   端到端跑第一次就现形了。
2. **`formatDelta` 把规模变化滤掉** ⇒ 「拆了 3 条带子」印成「无变化」。
   比不打印更糟。现在 `entities/belts/machines` 即使没有方向也一定打印。

---

## 4. 测试

| 文件 | 条数 | 钉住什么 |
|---|---|---|
| `loop/health.test.mjs` | 28 | 六档判定的边界；null ≠ 0；浮点尾巴；形状指纹 |
| `loop/timeline.test.mjs` | 15 | 三个回归各一条；LAST STEP 的进出与顺序；transcript 契约未破 |
| `loop/verify.test.mjs` | +8 | V-health 三态（红/绿/undecidable） |
| `loop/offline_boundary.test.mjs` | 10 | V-health 离线不可信；两张表互斥；离线全绿仍能走到 offline-only |

全量 `node --test src/agent/` 已绿（401 → 加上新增后全绿）。

---

## 5. 还没做（架构上仍然缺的）

度量做出来了，但下面这些是**真实存在的架构缺口**，这一轮没有动：

1. **没有跨 run 记忆** —— `grep loadMemory|history|previousRuns` 在 `loop.mjs` 里为空。
   每次 run 都是白纸，模型第 3 轮不知道第 1 轮试过什么。
2. **没有规划层** —— 白名单只有 7 个**局部**宏，`build_line` 被有意排除。
   30 格的线只能靠模型记，产物必然是补丁。
3. **`connect` 撞到第一个冲突就放弃** —— 没有寻路、没有绕行。14 个空 hub 入口它看不见。
4. **没有回滚** —— verify 会报红（现在还会报 `regressive`），但**没有任何东西把坏改动撤销**。
   `LAST STEP` 只是让模型知道自己搞砸了，它下一轮能不能修回来没人保证。
5. **没有关卡变更检测** —— level 5 → 6 之后，旧产线不会被拆除，只会变成 41% 的死带子。
6. **prompt 是切片** —— 模型看 12 条带子，世界有 120 条。这次排查我自己都得写脚本画 ASCII 才看明白。

这六条才是「一坨玩意」的成因。度量只是让它们**第一次变得可测**。

---

## 6. 下一刀该切哪

按「能多快让下一次 run 的结果不一样」排序：

1. **回滚**：`regressive` 已经可判了，`before/after` 两份 obs 都在手上，
   把 `destroyed` 的 uid 与新增实体反推成反向 tx —— 这是**唯一能阻止世界越改越烂**的东西。
2. **跨 run 记忆**：把每次 run 的 `net_effects` + 失败的 `action_set` 落盘，
   下次 run 开头读回来，进 prompt。
3. **关卡变更检测**：`goal_shape` 变了就把旧产线的可达率算出来，
   判成 `OBSOLETE_LINE` 诊断，让模型先拆再建。
