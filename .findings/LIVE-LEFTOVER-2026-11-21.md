# `## LEFTOVER LINES` 真机验证（2026-11-23）

验证对象：commit `4450ef3`（残线识别对 L12 全盲 —— `CgScScCg ×2071` 终于进 prompt）。
目标世界：`7c93b3dd9e949c561e5aa529974973b18c856b45`（level 12）。用户存档 `5c967065…` 未触碰。

---

## 结论（先看这一条）

**这一行确实进了真机 prompt，但模型的行为没有变 —— 而且它做的事恰好是这一行叫它别做的。**

- 三轮问题逐条回答：
  1. `insert_machine` 占比：本次 run **0 / 2 = 0.0%**（历史基线 3.2%）。**n=2，这个数没有统计意义**，不能当作「占比下降」的证据。
  2. 有没有停止修 L11 残线：**没有**。2 / 2 轮都点名 **C4 = L11 那条链的 stacker**（`stacker#14684`，就是 `painter#13552 → stacker#14684 → rotater#14685 → hub` 那条）。
  3. 有没有提到 2071 / leftover / 上一关：**0 次**。`say` 与 `why` 全文里 `2081` / `2071` / `leftover` / `previous level` / `old goal` / `L11` 全部 **0 命中**。
- 更强的证据：**提交前的那个 run 跑的是同一份世界**（实体集合逐条相同），模型产出的调用**几乎逐字相同**。这是一个天然 A/B：

  | | prompt | 模型调用（R1） | 模型调用（R2） |
  |---|---|---|---|
  | `r-20261123135733-fe21`（提交前 21:59） | 18690 字符 | `connect C2 → C4` | `connect C2 → C4 {rebind}` |
  | `r-20261123151728-52a3`（提交后 23:17） | 18800 字符 | `connect C2 → C4` | `connect C2 → C4 {rebind}` |

  两臂**动作完全相同**，只有 `why` 的措辞不同。

- 附带发现：这一段不是白拿的。它占 488 字符，而这些字符是从别的内容里挤出来的 ——
  **第 1 轮挤掉了「没有矿机在挖 w（白颜料）」这条提示**，**第 2 轮把带子表从 13 条压到 3 条**，
  连诊断点名的 `B692` 都看不到了（详见第四节）。

判定：**接线通了，行为没变，还有可量化的副作用。**

---

## 一、环境与身份

| 项 | 值 |
|---|---|
| 桥 | `http://127.0.0.1:7777`，`ok=true mod_connected=true uptime≈5061s` |
| 存档 | `7c93b3dd9e949c561e5aa529974973b18c856b45` ✓（脚本硬校验通过） |
| 游戏 | `in_game=true paused=false level=12 game=1.5.6 mod=0.1.0 allow_write=true` |
| run id | `r-20261123151728-52a3` |
| checkpoint | `live-20261123-151722`（entities=749 skipped=0） |
| 实体数 | 跑前 **749** → 跑后 45s **749**（Δ0；belts 699、machines 49 均不变） |
| tick | 1114201.4 → 1114385.3（Δ183.9，世界在跑，不是冻住的快照） |
| 代码版本 | 跑的是干净 HEAD（工作区里 `loop.mjs` / `constants.mjs` / `semantic.mjs` 的未提交改动 mtime 为 23:45–23:49，**晚于**本次 run 的 23:17；transcript 中不含 `WORLD_FROZEN`，可佐证） |

命令：`bash tools/live-run.sh --goal "CbCbCbRb:CwCwCwCw" --rounds 2 --yes`
退出码 2（`outcome=halt reason=BUDGET_ROUNDS`，正常预算用尽）。

---

## 二、`## LEFTOVER LINES` 段：出现了

**是，出现在本次 prompt 里。** `blocks.leftover_lines_shown = true`。

位置（user 正文，14075 字符）：

| 指标 | 值 |
|---|---|
| 起始偏移 | **3482** / 14075 = **24.7%** |
| 整份 prompt 偏移（system 4725 + 分隔 + 3482） | 8219 / 18812 = **43.7%** |
| 段长 | 488 字符 |
| 前一节 | `## CANDIDATE MACROS (6)`（在 0） |
| 后一节 | `## GOAL`（在 3971） |

原文（逐字节）：

```
## LEFTOVER LINES
the hub still holds shapes that no step of the CbCbCbRb:CwCwCwCw recipe produces:
  · CgScScCg ×2081
  · Cu------ ×33532
Those lines are still on the map, still mining and still cutting, and everything they make either clogs a belt or gets thrown away. They also occupy the space a new line needs.
⇒ Prefer removing or converting them over building another parallel run. `remove_run` and `replace_run` work on them; a new `connect` next to them makes the clutter worse.
```

重建方法可信度：prompt 正文没有落盘（transcript 只存 `prompt_chars` 与 `raw_sha`），
所以用 `buildPrompt` 按 `loop.mjs:4183` 的真实参数重建。**重建长度与真机逐字节一致**：

- R1 重建 **18800** == 真机 `prompt_chars: 18800`
- R2 重建 **18808** == 真机 `prompt_chars: 18808`
- 对照：把 `obsoleteLines` 置 null 后分别是 18690 / 18797，正是提交前那个 run 的真机读数

两条判据都成立：`findStoredObsolete` 正确放行（`levelChanged=false` 但 `sawOtherLevelOutput` 命中
`CgScScCg` rank0 且 stored 2081 ≥ 1000），`renderLeftoverLines` 只取 `stored` 证据（窗口证据为空，因为整厂零产出）。

注意：**这一段不带任何句柄**（段内 `[BCMH]\d+` 零命中）。模型读到「该拆」，手上没有可交给
`remove_run` 的对象。同轮的 `OBSOLETE_LINE` 诊断**也没有出现**（`## DIAGNOSIS (8)` 里没有它，因为
`st.goalChanged` 为 null）；带句柄那条路只在换关那一轮才生成。

---

## 三、模型的 tx plan：零写入，两次都被拦截

`tx=0`，世界逐实体完全没变（inert）。两次计划都在 **plan 阶段**被拒，没有任何 op 落到世界上。

| 轮 | 计划 | 结果 |
|---|---|---|
| R1 | `connect {from:{ref:"C2",port:"right"}, to:{ref:"C4",port:"upper"}}` | `✗ NO_REVERSIBLE_CALL` — `connect:target_already_fed` |
| R2 | 同上 + `opts:{rebind:true}` | `✗ PLAN_REJECTED` — 预演死带子 390→567（+177），到 hub 309→141 |

（R1 被拒后它确实读了 hint：R2 加上了 `rebind:true`。所以链路是通的，模型会读反馈。）

### 这两个句柄指的是谁

| 句柄 | uid | 类型 | 格 | 是不是 L11 残线 |
|---|---|---|---|---|
| `C2` | 13544 | cutter | (-5, 9) | 否（本关铜切链） |
| **`C4`** | **14684** | **stacker** | **(-2, 5)** | **是** |

`C4` 就是记忆里那条链的核心：
`painter#13552(C3) → stacker#14684(C4) → rotater#14685(C5) → hub`。

几何与 prompt 自述一致：

- `C4` 下输入 `lower@bottom ← B133`，该段**连续 16 条带子**头部悬空（`B14777@(-5,16)` 上游为空）；
  它的源头是 `C3 painter#13552` 的输出，而 `C3` 的 color 进料格 `(-4,15)` **是空的** ——
  就是 `l12-delivery-zero-root-cause` 记的那个唯一断点。
- `C4` 上输入 `upper@bottom ← B90`，165 格连续带子（含 y=6 那 81 格），
  上面正跑着 **128 件 `ScSc----`**（星形半片；本关目标 `CbCbCbRb:CwCwCwCw` 里一个星形都没有）。
- `C4` 输出 `out@top → B134 → C5 rotater → B135 → H1.primary`，一路直通 hub。

也就是说：**模型两轮都在修同一台 L11 stacker，并且第 2 轮想把 `C2` 切出来的东西怼进它的上口**。
LEFTOVER 段的原话是「Prefer removing or converting them over building another parallel run…
a new `connect` next to them makes the clutter worse」—— 模型做的是**正相反**的那件事。

R2 之所以被拒，也说明这条修法本身是错的：`rebind` 会把 `upper` 口从 `B90` 抢走，
那条 165 格活线当场失去去处 —— 模拟给出的 `reach 309 → 141`、`dead 390 → 567` 正是它。

### 这个动作是不是「历史基线」里的那个

`pipeline` 口径（全部 508 个 L12 run / 2314 份计划，只看 `C4|C5|B90|B133|B134|B135` 这一簇）：

| 窗口 | run 数 | 计划数 | 点中 L11 簇的计划 | 占比 |
|---|---|---|---|---|
| 全部 | 508 | 2314 | 569 | 24.6% |
| 2026-11-16 起 | 389 | 1740 | 491 | 28.2% |
| 2026-11-19 起 | 32 | 109 | 69 | 63.3% |
| 2026-11-23（今天 2 个） | 2 | 4 | **4** | **100%** |

「几乎每一轮都在修它」这个基线在最近几天是成立的，而本次 run 是 **2/2 命中**，
即**没有任何退出这条轨道的迹象**。

---

## 四、宏分布：本次 run 与 3.2% 基线

`node tools/macro-census.mjs --last 1`（只统计本次 run）：

| 宏 | 次数 | 占比 |
|---|---|---|
| `connect` | 2 | 100.0% |
| 其余全部（含 `insert_machine` / `extend_line`） | 0 | 0.0% |

- 建设类（`insert_machine` + `extend_line`）：**0.0%**
- 修现有线：**100.0%**

历史基线（`macro-census.mjs` 全量，4225 次 L12 调用）：

| 宏 | 次数 | 占比 |
|---|---|---|
| `connect` | 2505 | 59.3% |
| `replace_run` | 590 | 14.0% |
| `remove_run` | 502 | 11.9% |
| `trash_unused` | 397 | 9.4% |
| **`insert_machine`** | **133** | **3.1%**（文档里写作 3.2%） |
| `remove_machine` | 87 | 2.1% |
| `extend_line` | 11 | 0.3% |

**必须说清楚的口径问题**：本次只有 **2 次**宏调用。用 n=2 去比 3.2% 是没有意义的——
0/2 与 1/2 的差别就能把「占比」推过基线。正确的说法是：
**本次 run 没有任何一次建设动作，但这不能证明 `insert_machine` 占比在下降**；
它和提交前那个 run（也是 0 次建设）完全一样。

---

## 五、模型自述：0 次提到 2071 / leftover / 上一关

transcript 全文（含两轮 `say`、`why`、所有诊断文本）计数：

| 关键词 | 命中 |
|---|---|
| `2081` | 0 |
| `2071` | 0 |
| `leftover`（不分大小写） | 0 |
| `previous level` | 0 |
| `old goal` | 0 |
| `L11` | 0 |
| `stored_shapes` | 0 |

模型的两次自述原文：

```
R1 say: "Feed the starved stacker from the cutter's free output."
   why: "C4 is the upstream blocker and C2 has an available output."
R2 say: "Reconnect the missing stacker input from the cutter output."
   why: "Feed C4's starved upper input from C2."
```

两句话都在讲「把 stacker 喂饱」，一个字都没提形状、存量或上一关。
对照 `## PROGRESS` 那行此前的 0/12，这一次是 **0/2**——方向一致，样本量同样小。

---

## 六、目标产出：没有任何变化

| 指标 | 跑前 | 跑后 45s |
|---|---|---|
| `delivered` | 0 | 0 |
| `required` | 1000 | 1000 |
| `goal_delta` | — | **0**（`run_end.goal_delta`） |
| `produced_total` | `{}` | `{}` |
| `delivered_total` | `{}` | `{}` |
| hub 里 `CbCbCbRb:CwCwCwCw` 件数 | **键不存在**（从未进过 hub） | **键不存在** |
| hub 里 `CgScScCg` | 2081 | **2081**（一件没动） |
| `items_on_belts` | 365 | 365 |
| `belts_deliverable` / `belts_dead` | 309 / 390 | 309 / 390 |

`production-last.json`：`produced_total = {}`，6 个 10 秒切片全空；
18 个 ejector 的 `progress` **全部 = 1**（满载冻结，与 `.findings/WORLD-IS-DEAD-2026-11-23.md` 一致）。
带上确有 365 件货（`blue 221`、`ScSc---- 128`、`CuCuCuCu 8`、`green 4`、`red 4`），
也就是说货在动，只是**一件都到不了 hub**。

---

## 七、死带子归因（`tools/live-diff.mjs`）

```
死带子 uid 级归因（几何口径）
  归因
    原有活线变死 : 0 条
    新铺的死带子 : 0 条
    死 → 活      : 0 条
    删掉的死带子 : 0 条
    → 原有活线一条没死
```

`dead_by_source`：`mixer 167 / cycle 123 / miner 86 / none 12 / cutter 2`。
整次 run 结论 `inert` —— 两次计划都没落地，所以「没改坏」是**因为它什么都没改**，
不能读成「这个动作是安全的」。

---

## 八、副作用：LEFTOVER 段挤掉了两处更要紧的内容

这是本次验证里唯一一个「有变化」的地方，而且方向是负的。用同一份 obs 跑
`buildPrompt`，只切 `obsoleteLines` 一个变量：

### 第 1 轮（18800 vs 18690，净 +110 字符）

段本身 488 字符，但它只换来 +110，差额 378 字符是别处被砍掉的：

| 被砍掉的内容 | 字符 | 为什么要紧 |
|---|---|---|
| `⇒ goal needs colors [bw]; all of them exist as ore` | 50 | 目标的两种颜料 |
| `⇒ b: blue×1794` | 14 | |
| `⇒ w: RuRuWuWu×178` | 17 | |
| `⇒ ⚠️ 没有矿机在挖 w（共 17 台，见上表）… 只能靠 mixer 混，不能挖。` | 92 | **本关目标 `CwCwCwCw` 正需要白颜料**，而白颜料没有矿、必须级联 mixer 混出来 |
| `stored (past levels stay here; …): CgScScCg×2081 Cu------×33532 …` | 200 | `## HUB stored` 整段消失（`hub_stored_dropped = "dropped-for-budget"`），信息与 LEFTOVER 部分重叠 |

### 第 2 轮（18808 vs 18797，净 +11 字符）

| | 有 LEFTOVER | 无 LEFTOVER |
|---|---|---|
| 带子表 | **3 / 699**（`0 of 4 referenced shown`） | **13 / 699**（`1 of 4 referenced shown`） |
| 诊断点名的 `B692`（`BELT_HANDOFF_REJECTED`） | **不在表里** | 在表里 |

也就是说第 2 轮里，模型为了读那段 488 字符的残线清单，**丢掉了 10 条带子，
其中包括唯一一条被诊断点名、且正被要求修的带子**。

单看这两轮的读数，LEFTOVER 段的净收益是负的：它给了一个**没有句柄、不可施工**的提示，
代价是白颜料缺口与带子表。

---

## 九、基础设施异常（如实记录）

- 无。桥、存档、网关、checkpoint、45 秒淌货全部正常。
- 过程记录：跑分析脚本时 C: 盘写满（`No space left on device`，剩余 413MB → 659MB 摆动），
  我把临时脚本从 `%TEMP%` 移到 `D:/tmp-leftover-probe` 才继续。**这只影响我的分析脚本位置**，
  与 run 本身无关；脚本已全部删除。
- 唯一的「失败」是实验本身的两次 plan 拒绝，原始报错：

```
R1  ✗ 未落地 [plan] NO_REVERSIBLE_CALL  调用 connect
    1 个调用里 0 条可撤销（connect:target_already_fed）
    跳过的调用 connect:target_already_fed

R2  ✗ 未落地 [plan] PLAN_REJECTED  调用 connect
    预演：死带子 390 → 567（+177），到 hub 的带子 309 → 141；这一步是 15 条 op
```

---

## 十、一句话汇总

`## LEFTOVER LINES` **确实进了 prompt**（3482 字符处，`CgScScCg ×2081` 原文可见），
但模型**两轮都还在修 C4 —— 就是那条残线的 stacker**，`say` 里 0 次提到存量或上一关，
世界零写入、目标零进展。同一份世界的提交前 run 给出**相同的两次调用**，是这次 A/B 最硬的证据。
并且这段 488 字符是从「白颜料没有矿」和「带子表 13→3 条」里挤出来的。
