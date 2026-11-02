# 打开 `partial` 的最终结果 + 一个环境阻塞

> 2026-11-02 / 11-03。这一轮做了「打开 `partial: true` 并真机验证」。
> **代码侧完成；真机侧遇到一个未解决的环境问题。**

---

## ✅ 完成了什么

### 1. `BUDGET.PARTIAL_APPLY` 默认改为 `true`

理由与风险写在 `constants.mjs` 那段完整注释里。想关掉：
`budget: { PARTIAL_APPLY: false }`（P12 测试钉住了这条）。

### 2. A/B 抓出并修掉两个真判据漏洞

| 漏洞 | 现象 | 修法 |
|---|---|---|
| **筛选条件错** | `if (partialMode && executed.length < res.calls.length)` —— 只有存在失败调用时才筛可撤销性。于是「全部成功」的计划（单条 `insert_machine`）跳过筛选直接提交 `place:cutter`，`partial` 标记还是 false | 条件只剩 `partialMode` |
| **修完漏洞 1 之后单条 `insert_machine` 一律被拒** | 那会让模型**永远无法加机器**，而它是产能修复的主力宏 | 区分 (a) 全成功+都不可撤销 ⇒ 完整提交、`partial:false`；(b) 有失败+剩下的都不可撤销 ⇒ 拒绝 |

### 3. A/B 的判据本身也修了

上一版把「完整执行里的不可逆」和「部分执行里的不可逆」混在一起报漏洞 ⇒ **假警报**。
正确判据：

| 情况 | 判定 |
|---|---|
| `partial:false` + 不可逆 | **合法**（计划是完整的，只是撤不回来） |
| `partial:true` + 不可逆 | **真漏洞**（已经跳过东西了，不该再夹带不可逆） |

### 4. 测试

**351 条全过**（新增 P11-P14）。

⚠️ 全量跑时有偶发超时（单次 50 秒，某些测试卡 5 秒阈值），重跑即过。不是真失败。

---

## 真机结果：三次 run，partial 一次都没触发

世界：level 5，目标 `Cu----Cu`，`delivered 0/170`，45 实体。

| run | 提交轮次 | partial 轮次 | 结果 |
|---|---|---|---|
| 1 | 1（`insert_machine`，2 ops） | **0** | `Cu----Cu` 零产出 |
| 2（A/B 基线） | 1（同上） | **0** | 同上 |
| **3（最终）** | **2**（`connect` 18 ops + `replace_run` 2 ops） | **0** | 仍然零产出 |

### ★ 「永远 partial」的风险完全不成立

不仅不成立，是**反过来的**：打开之后，模型每次提交的都是**完整执行**。

原因：模型的计划要么全成功（单条 `insert_machine` / `connect`），
要么有失败但剩下的也不可撤销 ⇒ `NO_REVERSIBLE_CALL` 拒绝。
「全成功但部分不可撤销」这个夹在中间的情况**在实际样本里没出现**。

### 第三次 run 是最有信息量的

```
round 1: connect      → 18 ops 提交（铺了 18 格带子）
round 2: connect      → 被拒 PLAN_REJECTED
round 3: replace_run  → 2 ops 提交（换了个修法）

实体: 45 → 63 (+18)
outcome = halt / NO_PROGRESS
achieved = false
```

**模型确实在换修法**（`connect` → `replace_run`），不是重复同一个。但目标形状还是零产出。

### 事后查产线：模型把 cutter 绕过去了

```
produced_total:  {"RuRuRuRu": 68}
delivered_total: {"RuRuRuRu": 66}
stored_delta:    {"RuRuRuRu":54, "----RuRu":0, "RuRu----":0}
```

**整条线只产整块 `RuRuRuRu`，完全没有切割。** 两个半块产出都是 0。

而 run 之前 `stored` 里 `RuRu----: 241`、`--RuRu--: 317` 都在，说明之前是有切割的。

⇒ **模型那 18 格带子把产线改成了「绕过 cutter 直连 hub」。**
它不是「改坏了」，是改成了一个只产整块的新产线 —— 与目标 `Cu----Cu` 毫无关系。

**`achieved: false` 不是 partial 的锅，是模型改错了方向。**

---

## ❌ 一个未解决的环境阻塞

跑完第三次 run 之后我试图 `snapshot_load` 复原，世界卡住了：

```
load_save: 状态切到了 InGameState，但 world 没有建起来（root 仍为空）
in_game: false
主窗口进程 CPU delta = 0.031s/5s   ← 渲染循环停了
```

### 试过的恢复办法

| 办法 | 结果 |
|---|---|
| `ShowWindow(SW_RESTORE)` | 无效 |
| 置顶**全部 7 个窗口**（`SetWindowPos TOPMOST`） | 有效过一次（`in_game: true`），第二次无效 |
| `MoveWindow` 改尺寸 | 发现窗口被压成 **136×39**，改成 1600×1000 后 CPU 只涨 0.031 |
| `ShowWindow(SW_MAXIMIZE)` | 窗口到 2566×1446，CPU 仍只涨 0.031 |
| 重启游戏 + `load_save` | 载入成功过一次，再 `snapshot_load` 又卡 |

### 判断

**根因是 Electron 渲染循环停了，不是窗口尺寸或遮挡** —— 因为窗口已经最大化、
可见、CPU 也在涨一点点（0.031s/5s），但 `gameStarted` 就是不派发。

这与 `LIVE-LOG.md` / `MOD-GAPS.md` §6 记录的是同一类问题，
但**这次比记录中的更顽固**（恢复窗口、重启、最大化都无效）。

### 现在的状态

- **世界数据完好**：63 实体，level 5，存档文件 3575 字节
- **索引完好**：7 条
- **快照完好**：`pre-final-partial.bin`（3113 字节，45 实体）
- **游戏能载入但不能跑 loop**（`in_game` 反复变 false）

**代码侧的所有工作都已提交并测试通过；世界需要人工介入才能继续。**

---

## 这一轮的净收益

| 项 | 状态 |
|---|---|
| `partial` 默认打开 | ✅ 完成，351 测试通过 |
| 两个判据漏洞 | ✅ 修了（A/B 抓出来的） |
| A/B 判据的假警报 | ✅ 修了 |
| 「永远 partial」风险 | ✅ 排除（实测反向：全是完整执行） |
| partial 到底有没有用 | ❌ **没回答** —— 三次 run 一次都没触发 |
| 真机复原流程 | ❌ 卡住，需要人工 |

---

## 下一步（按优先级）

### P0：修真机复原流程

现在 `snapshot_load` 会让世界卡死。**这是所有后续真机实验的前提。**

两个方向：
1. 不用 `snapshot_load`，改成「先 `snapshot_save`，跑完用 `load_save` 载入快照对应的存档文件」
2. 或者查清楚 `gameStarted` 为什么不派发（可能要在 mod 里加一个 ready 探测）

### P1：让 partial 真的被触发

三次 run 都是完整执行。要测 partial 的效果，需要一个**「有失败调用 + 剩余可撤销」**的场景。

可以人为构造（像 `live-partial/verify.mjs` 那样 probe 出两个调用），
那样能验证 partial 在真机上提交子集之后、后续轮次能不能接着做。

### P2：回到真正的瓶颈

`FOUR-ROUNDS-FINAL.md`、`CONNECT-OCCUPIED-DIAGNOSIS.md`、这次又指了一遍：

**模型的瓶颈是「理解产线拓扑并做正确的空间改造」。**

第三次 run 里它把产线改成「绕过 cutter 直产整块」——这不像是「不会用宏」，
更像是**它没有「目标形状需要切」这个概念**。而 RECIPE 段本该告诉它这件事。

⇒ **下一步值得查：RECIPE 段在真机 prompt 里有没有正确渲染。**
（离线测过，真机没测过。）
