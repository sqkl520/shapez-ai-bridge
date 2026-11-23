# PROGRESS 读数真机验证（2026-11-23）

验证对象：commit `2b94dde`（`## GOAL` 段加一行 `PROGRESS ...`）。
目标世界：`7c93b3dd9e949c561e5aa529974973b18c856b45`（level 12），用户存档未触碰。

## 结论（先看这一条）

**读数确实进了真机 prompt，但它没有改变模型在修什么。**

- 模型的两次 `say` 里，提到「本关目标从未进过 hub / absent / 链不存在」的：**0 / 12 次**
  （真机 2 轮 + 受控 A/B 10 次，两臂合计）。
- 两轮真机都去修 **C4 stacker**——那是 **L11 遗留产线的尾巴**（它的输入带子 `B90`
  上跑的是 `ScSc----`，输出经 `C5 rotater` 直连 hub）。
- 受控 A/B（同一份世界，prompt 仅差这一行）：**两臂动作分布没有可区分差异**，
  两臂 10/10 次都落在 `C2` / `C4` / `B692` 这一小组句柄上。

判定：**读数没生效**。不是「模型不同意」，是**它没把这行读成「所以别修那条线」**。

## 第 1 步：接线是通的（这一层没有 bug）

用新鲜 obs + `debug_items` 重建真机 prompt：

| 字段 | 值 |
|---|---|
| `blocks.progress_shown` | **true** |
| `blocks.s3_goal` | 含 `PROGRESS delivered 0/1000 \| layers: CbCbCbRb absent · CwCwCwCw absent \| pigments on belts: blue 221, white 0 \| this goal has NEVER entered the hub` |
| 带子 | 16 / 699（与关掉读数时**完全一样**） |
| `prior_dropped_for_budget` | false |
| `capacity_unavailable` | **null**（CAPACITY 在） |
| `hub_stored_dropped` | **null**（HUB 存量在） |
| `recipe_capped` | true（`solver search capped`） |

真机那两轮的 `propose.prompt_chars` 是 **18690**，与我带读数的重建**逐字节相等**
⇒ 那行确实在模型读到的文档里。

**关掉 items 的对照组**：`progress_shown=false`，`PROGRESS` 不出现（没有假 `absent`）。
这条门控按设计工作。

### 它挤掉了什么

几乎什么都没挤掉：全量 18690 → 18543，**差 147 字符，带子 16→16 一条没少**，
CAPACITY 与 HUB 存量都还在。

commit message 里「挤掉 3 条带子（10→7）」只在 `r-20261121190439-6190` 那份
**本来就超预算**的世界上出现；我复现到了同样的 9→7，也复现到本次世界的 16→16。
所以在**当前**世界上「读数抢带子」不是一个真问题。

## 第 2 步：模型读了什么、修了什么

真机 `r-20261123135733-fe21`，outcome=`halt`（BUDGET_ROUNDS），**tx_count=0**。

| 轮 | 模型 `say` | 调用 |
|---|---|---|
| 1 | "Feed the missing stacker input from the cutter output." | `connect C2.right → C4.upper` |
| 2 | "Feed the starved stacker from the cutter's free output." | 同上 + `opts.rebind` |

两轮都被计划层拒掉（第 1 轮 `NO_REVERSIBLE_CALL: target_already_fed`；
第 2 轮 `PLAN_REJECTED`：预演死带子 390→567、到 hub 309→141）。

**它修的是哪条链**——这是核心判据：

```
C4 stacker (-2,5)  输入 upper ← B90   货=259 段=165   带上是 ScSc---- ×128 + blue
                   输出 out   → B134 → C5 rotater → B135 → H1(hub)
```

`ScSc----` 是 L11 目标 `CgScScCg` 的碎片；hub 里躺着 `CgScScCg × 2081`，
**2026-11-16 之后 373 个 run 一分没动**（本次仍是 2081）。C4 就是这个冻结集群的尾巴。

它**没有**建 L12 的链，也没有拆这条 L11 的线——它在这条线的中段补一个喂料口。

## 第 3 步：为什么没生效（三个可证伪的机制，都已实测）

### 机制 1：读数给出的是「事实」，而诊断给出的是「句柄 + 动作」

```
PROGRESS 行里的句柄： []
DIAGNOSIS 段里的句柄：C4 C8 C2 M4 H1 B599 B692 B699 B208 B328 B378 B379 M7 M8 M9 M11 M14 M15
```

模型这一层的唯一输出是 `{"macro":..., "args":{...句柄...}}`（system 里 RULE 4/5：
不能写坐标、只能点句柄）。`PROGRESS` 说「这条链不存在」，但**没有一个东西可以让
它指过去**；而 `MACHINE_STARVED` 说「从 C4 开始接它的缺料口」，是可以直接落地的。

这与项目里已有的教训同族（`hint-must-carry-handle`：A/B 实测 2/10→9/10）——
**读数这次漏掉的正是句柄**。

### 机制 2：`absent` 这个词本身有歧义，而同一行里没有消歧

`CbCbCbRb absent` 与 `CwCwCwCw absent` 读起来像「这一层缺货」，也可以读成
「这条链压根没建」。模型选了更省事的那种解读：缺货 ⇒ 去把喂料补上。
**同一个 prompt 里，只有 `hub stored` 那行（第 187 行，97.4% 处）暗示了「旧关的东西还在」，
而它出现在 `## YOUR TURN` 之后、`## CALL SHAPE` 之前**——离决策点只有 202 字符，
但它说的是「存量」，不是说「所以这条你现在修的线是废的」。

### 机制 3（结构性，最重要）：项目**已经有**识别残线的机器，但它对这一关全盲

`src/agent/loop/obsolete.mjs` 就是为「旧线在造上一个目标」写的，两条入口都实测开关：

| 入口 | 本次世界的实测结果 |
|---|---|
| `findObsoleteLines`（60s 产出窗口） | `[]` —— `produced_total = {}`，窗口里什么都没产 |
| `findStoredObsolete`（hub 账本） | `[]` —— **`levelChanged !== true` 直接返回空** |

就算把 `levelChanged` 强行设成 true，它报的是
`CrCrCrCr×41662` / `Cu------×33532` ——**按库存降序取前 2**，
而 `CgScScCg×2081` 排**第 8**，永远进不了候选。

而 `levelChanged` 在本 run 是 `null`：loop 只在「调用方传的 goal == 记忆里的 last_goal
且 != 世界当前目标」时才认为换关（`loop.mjs:3925`）。我们是**显式传 goal**，
所以这条判据永远不触发。

⇒ **PROGRESS 想说的这件事，本该由 obsolete 层用「可操作的句柄」说出来，
但那一层有三个独立原因同时够不到它。** 把同一句话塞进 PROGRESS，
只补上了「说」，没补上「指向」。

## 第 2'：受控 A/B（同一世界，只差这一行，n=5/臂）

两臂 prompt 逐字节相等，只差那 147 字符（脚本里断言过：

```
isolation verified: arm B == arm A minus exactly that one line
```

| | 臂 A（有 PROGRESS） | 臂 B（无） |
|---|---|---|
| 可用样本 | 5/5 | 5/5 |
| 提到目标链/`absent`/`NEVER` | **0/5** | **0/5** |
| 提到旧链（`ScSc`/`obsolete`/past level） | **0/5** | **0/5** |
| 句柄分布 | `C2`×5, `C4`×1, `B692`×1 | `C2`×3, `C4`×2, `B692`×2, `B699`×1 |
| 动作 | `trash_unused C2`×3, `connect C2→C4`×1, 混合×1 | `connect C2→C4`×2, handoff 修法×2, `trash_unused C2`×1 |

两臂都在修同一组句柄，都在修 L11 尾巴附近。**没有证据说这行改变了决策。**
（样本小，只能证伪「有显著效果」，不能证伪「在更大 n 下有弱效果」——
但方向是「零提到」，不是「提到但不采纳」，这一类通常不是 n 的问题。）

## 第 4 步：世界变没变

`delivered`：0 → 0。目标形状在 hub 里的存量：**一直不存在**。

| 指标 | 基线 | 跑完（含 60s 淌货） |
|---|---|---|
| entities / belts / machines | 749 / 699 / 49 | 749 / 699 / 49 |
| 到 hub 的带子 | 309 | 309 |
| 死带子（几何） | 390 | 390 |
| 带上货 | 364 | 365 (Δ+1，货运残差，非拓扑) |
| `CgScScCg` 在 hub | 2081 | **2081** |

死带子 uid 级归因：**原有活线变死 0 条 / 新铺 0 条 / 死→活 0 条 / 删掉 0 条**。

⇒ **世界完全 inert（拓扑零写入）**。不需要回滚。

顺带：本次世界哈希 `fnv1a64:29e287862a2c403a:n=749` 与 2026-11-21 的
`r-20261121190439-6190` **逐字节相同**——这两天世界一次都没变。

## 一处需要单独记的可观测性问题

commit 声称有两处可观测性：`blocks.progress_shown` / `blocks.progress_ledger`。
实测：这两个字段**只存在于 `buildPrompt` 的返回值里，没有任何地方把它写进 transcript**。
`propose` 事件只记 `prompt_chars / tokens_estimate / raw_sha / plan`。

⇒ 真机跑完之后，**无法从 run 产物判断那行有没有出现**（只能靠 `prompt_chars`
反推，正如我这次做的 18690 == 重建值）。这正是
`computed-but-never-delivered` 记过的那类缺陷：「算出来」不等于「送到」，
而这里的「送到」指的是「送到事后的排查者眼前」。

## 建议（按代价排序，都不是「再调措辞」）

1. **给读数配一个句柄**（最便宜，沿用 `hint-must-carry-handle` 的已验证做法）。
   把「本关目标从未进过 hub」接到**具体的那条线**上，例如
   `PROGRESS ... | the ribbon at C4 is carrying ScSc---- (L11's goal), not this one`。
   没有句柄的事实，在这一层等于没有。

2. **修 obsolete 层的三个盲点**，让「该拆的线」由有句柄的诊断说出来，
   而不是让 PROGRESS 去兼职：
   - `findStoredObsolete` 的 `levelChanged` 门在「显式传 goal」时恒假；
   - 按库存降序取前 2 会漏掉真正相关的形状（`CgScScCg` 第 8）；
   - 窗口证据在旧线停转后恒空（这是 obsolete.mjs 自己注释里就写过的已知限制）。

3. **把 `progress_shown` / `progress_ledger` 落进 transcript**，否则下次验证
   还得靠 `prompt_chars` 反推。

4. **不要**因为「这轮没生效」去加预算或改措辞。本次读数在**位置**上已经对了
   （`## GOAL` 段，总长 18.9% 处，紧跟 `shape:`/`delivered`），
   缺的是**可操作性**，不是可见度。

## 单元测试与真机的关系

`src/agent/loop/progress_ledger.test.mjs` 的 5 条**全部通过、0 skip**（本次实测），
覆盖的正是我这次在真机上核过的那三件事：

- 三态（`absent` / `alive` / `present-stuck`）分开
- 两层分别判
- 不许挤掉带子（16→16）

但**它们通过这件事，恰好不构成「读数有效」的证据** —— 那 5 条测的是「渲染对不对」，
而这次的失败发生在「渲染对了之后模型拿它做什么」。这是本项目
`computed-but-never-delivered` 的另一面：不是没送到，是送到了但不可执行。
**没有一条单测能覆盖「读完这句话之后模型改不改动作」**，只能真机 A/B。

## 复现（脚本是临时的，跑完已删；步骤可原样手敲）

```
bash tools/start-bridge.sh
powershell -ExecutionPolicy Bypass -Command "Start-Process 'D:\Steam\steamapps\common\shapez.io\shapezio.exe'"
#   → 约 15s mod 连上，status.in_game=false（主菜单）
# 加载实验存档：load_save { internal_id: "7c93b3dd…" }，同时循环 ensureWindowAwake
#   （loop.mjs / kit.mjs 的 waitInGame 那套；注意 load_save 中途会 ECONNRESET，属正常重连）
bash tools/live-run.sh --dry-run --yes
bash tools/live-run.sh --rounds 2 --yes
node tools/probe-live-prompt.mjs --run r-20261123135733-fe21   # 复算 blocks / s3_goal
```

第 1 步的 `blocks` 复算与受控 A/B 都是**一次性脚本**，方法已写在上面：
用 `makeBridgeReader` 取新鲜 obs/items/production → `buildHandles` → `diagnose` →
`buildPrompt`（带/不带 `items`），A/B 则把那一行从 `user` 里删掉后断言与
`buildPrompt(budget-without-items)` 逐字节相等，再各调 5 次 `AnthropicClient`。

环境备注：本次开始时桥与游戏都已停（桥心跳停在 11:49Z），按 `start-bridge.sh`
+ `Start-Process` 拉起（全程未 kill 进程）。网关 `127.0.0.1:15721` 是
CC Switch 代理到 "S3 AI"，单次 30–55s，**约 50% 概率 504**，A/B 必须内置重试。
`.tmp-verify/` **不在 .gitignore 里**（`.tmp-live/` 才是第 94 行的条目）——
派 agent 往这里写脚本时要么手动清，要么先加 ignore。
