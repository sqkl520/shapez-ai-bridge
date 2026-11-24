# 邻居重算读数（`reorientedBelts`）的真机验证

2026-11-24。被测代码：`3101b69` 的 `src/agent/loop/verify.mjs#reorientedBelts`
+ `src/agent/loop/prompt.mjs#renderLastRound` 的 `reoriented belts:` 段。

**一句话结论：读数算得对、渲染得对、字节级送达了 —— 但模型不读它。**

具体是：`count > 0` 能真的触发（真机拿到 2 条，逐条与手工对账一致），
prompt 渲染逐字节正确（charOff 7481 / 13335，两处实验各一次），
**但模型在 6 个样本里 0 次提到那两条带子**。而且我测到的四次「读数没出来」，
根因都不是读数坏了 —— 是**没走到那一步**（tx 0），或者我在做实验时自己的模型算错了。

---

## 1. 独占时间段

| 项 | 值 |
|---|---|
| 独占开始 | 2026-11-24 16:55（本地） |
| 独占结束 | 2026-11-24 18:25（本地） |
| 存档 | `7c93b3dd9e949c561e5aa529974973b18c856b45`（实验存档，L12） |
| 用户存档 `5c967065…` | **全程未碰**（每支脚本第一段都是硬门禁：见到即 `exit 9`） |
| 期间其它 agent | 未发现（`/health` 稳定，tick 单调，uptime 连续 68573s→73923s 无重启） |
| 收尾状态 | 已 `checkpoint_restore` 回 `gab-mwuiiaio`：**749 实体、相对会话开始基线 added=[] removed=[]、几何差异 0 处** |

---

## 2. 跑了几次 run

### 2.1 纯 LLM run（按任务要求原样跑 `tools/live-run.sh`）

| # | run id | 退出码 | outcome / reason | rounds | LLM calls | **tx** | verify 记录 |
|---|---|---|---|---|---|---|---|
| 1 | `r-20261124090316-0c8d` | 0（脚本层） | `halt / BUDGET_ROUNDS` | 3 | 4 | **0** | **0 条** |
| 2 | `r-20261124092748-a764` | 0（脚本层） | `halt / BUDGET_ROUNDS` | 3 | 3 | **0** | **0 条** |

两次都是 **tx 0**：模型每轮的计划都在 plan 阶段被整体拒掉，从来没有进过 tx。

被拒的码（逐轮，原文来自 `timeline.log`）：

| run | 轮 | 调用 | 拒绝码 | 真正的嵌套原因（`observed` 原文） |
|---|---|---|---|---|
| 1 | r1 | `connect C2→C4` | `PLAN_REJECTED` | 预演：死带子 390 → 568（+178），到 hub 309 → 138 |
| 2 | r1 | `connect C8→C4` | `NO_REVERSIBLE_CALL` | `connect:target_already_fed` |
| 2 | r2 | `connect` | `NO_REVERSIBLE_CALL` | `connect:target_already_fed` |
| 2 | r3 | `trash_unused` | `NO_REVERSIBLE_CALL` | `trash_unused:out_of_scope` |
| 1 | r3 | `connect` | `NO_REVERSIBLE_CALL` | `connect:ambiguous_port` |

**这条本身就是一次「算出来 ≠ 送到」的复现**：`belt_reorient` 只在 `verifyRound`
之后才有值，而 `verifyRound` 只在 tx 落盘之后才被调用。tx 0 ⇒ transcript 里
**连 `belt_reorient` 这个字段都不存在**（不是 `count:0`，是没有）。

### 2.2 受控真机实验（绕开「模型愿不愿意提」这一层）

因为上面两次拿不到 tx，我改用**直接发真 tx** 的方式验读数本身。
每一环都是真的：真桥、真 tx、真 `verifyRound`、真 `buildPrompt`、真 LLM。
唯一脚本化的是「这一刀想干什么」——而它的输出本来就不进这个读数。

| 组 | ops | tx 结果 | **`belt_reorient.count`** | 手工对账（我自己的 obs 差集） |
|---|---|---|---|---|
| A（单 op） | `place trash @(-13,-7)` | ok 1/1 | **0** | 0 条带子变向 |
| A′（单 op，重跑） | `place trash @(-4,16)` | ok 1/1 | **0** | 0 条 |
| A″（单 op，模型修正后） | `place trash @(31,-41)` | ok 1/1 | **0** | 0 条 |
| **B（双 op）** | `place trash @(31,-45)` + `place trash @(37,-39)` | ok 2/2，`diff.modified=[16638,17348]` | **2** | **2 条：16638、17348** |
| 对照：`act{op:"place"}`（**无 tx 包装**） | `place trash @(37,-54)` | ok | —（不走 verifyRound） | **1 条：16350，与我离线预测逐条一致** |

A 组三次 `count=0` 不是读数坏了，而是**正确**：`tx` 把整批 op 包进
`performImmutableOperation`，而它是**同步**函数、`opTx` 的体是 `async` ——
`await` 一挂起 `immutableOperationRunning` 就被 `finally` 复位，只有第一条 op 受保护
（`.findings/FIX-NEIGHBOR-RECOMPUTE-2026-11-24.md` §1.3 的离线 vm 结论）。
A 组只有一条 op ⇒ 恰好是被保护的那一条 ⇒ 游戏**不会**重算邻居 ⇒ count 必须是 0。
B 组第二条不被保护 ⇒ 真的重算 ⇒ count=2。**这个 A/B 就是那条 vm 结论的真机对证。**

---

## 3. `belt_reorient.count` 的实际值（逐次、逐轮）

| 来源 | 轮 | count | items |
|---|---|---|---|
| 纯 LLM run 1（`…0c8d`） | r1–r3 | **字段不存在**（tx 0，无 verify 记录） | — |
| 纯 LLM run 2（`…a764`） | r1–r3 | **字段不存在**（同上） | — |
| 历史真机 run `r-20261123234341-c6c7` | r3 | **0** | `[]`（delete+place 两条，但 place 无关邻居） |
| 受控 A / A′ / A″ | — | **0 / 0 / 0** | `[]` |
| **受控 B** | — | **2** | 16638→B451、17348→B691 |

`r-20261123234341-c6c7` 是本次会话之前就存在的真机 run（同一存档、L12），
它 tx 真的落了（`applied 2/2`）。它的 `count:0` 也是真的：
那次是 `delete#17410 + place` 在 **(90,-39) 一带**，而它的邻居带子不在重算影响面内。
它同时证明了一件事：**这个读数在真机上早就在跑，不是只在新夹具里成立。**

---

## 4. 渲染进 prompt 了吗（判据 2）—— 是，逐字节

### 4.1 受控 B 组（`gt-ab2` → `prompt-with-reorient.txt`）

- user prompt 长度 **8376** 字符
- `reoriented belts` 段：**line 130，charOff 7481，段长 298 字符**

逐字节（JSON 转义后原样）：

```
"reoriented belts (the game rewrote these — no op asked for it):\n  · B451: in right→right, out left→bottom\n  · B691: in left→left, out bottom→right\n  ⇒ You did not declare these. The game recomputes belts next to anything you place/remove. If one of them was feeding a machine, your change broke it."
```

人读：

```
reoriented belts (the game rewrote these — no op asked for it):
  · B451: in right→right, out left→bottom
  · B691: in left→left, out bottom→right
  ⇒ You did not declare these. The game recomputes belts next to anything you place/remove. If one of them was feeding a machine, your change broke it.
```

句柄与实测的对应：B451 = uid 16638（rv 0→1，`r 270` 不变），
B691 = uid 17348（rv 2→0，`r 90` 不变）—— 与手工 obs 差集**逐条相同**，
与 `diff.modified=[16638,17348]` 也相同。

### 4.2 满配 prompt（带 8 条真诊断 + 6 张宏卡片）

用同一条读数重建（`prompt-B-with.txt`）：

- user **14028** 字符，`reoriented belts` 在 **charOff 13335**
- 段原文与 4.1 逐字节一致（同一份 `reo-real.json`）

### 4.3 发现一个副作用（新，之前没人提过）

**这段是「付费」的，而且付款方式是挤掉带子。**

| 段 | 不带读数 | 带读数 | Δ |
|---|---|---|---|
| `## LAST ROUND` | 87 | 386 | **+299** |
| `## MACHINES (…)` | 1762 | 1585 | −177 |
| `## BELTS` | 16 条 / 1009 字符 | **13 条** / 857 字符 | **−3 条** |

也就是说：在 L12 这个规模上，加上读数会让**带子清单少 3 条**、机器清单少 2 台。
而 prompt 自己的注释写着「带子是模型**唯一能就地改造**的东西」。
这不是 bug（预算确实是硬的），但它是一个**没人量过的代价**，
而且它和「模型不读这段」叠在一起时格外难解释 —— 模型得到 299 字符的警告，
代价是少看 3 条它本来能改的带子。

---

## 5. 模型读到了吗（判据 3）—— **没有**

受控 A/B，同一份世界 / 同一份诊断 / 同一份候选，只差这一段在不在。
每臂 3 个样本，交替提问，网关重试到成功（3 次 504/502 都重试了）。

| 臂 | 提到 B451/B691 | 提到 rewrote/recomput/neighbo/reorient |
|---|---|---|
| 有读数段 | **0/3** | **0/3** |
| 无读数段 | 0/3 | 0/3 |

逐条引原文（`say` 是模型自己的话，`calls` 的宏与参数）：

**有读数段（3 个样本）**
1. `say`: "Feed C4's missing lower input from the free cutter output."
   `why`: "Resolve the stacker's missing lower input and unblock production."
   `calls`: `connect(from,to)`
2. `say`: "Feed the missing lower input of the stacker from the cutter's free output."
   `why`: "C4 is starved on its lower input, and C2 has a free output."
   `calls`: `connect(from,to)`
3. `say`: "Feed C4's missing lower input from the nearby free miner output."
   `why`: "C4 is starved on its lower input, blocking the production chain."
   `calls`: `connect(from,to)`

**无读数段（3 个样本）**
1. `say`: "Feed C4's missing lower input from the free cutter output."
   `why`: "Resolve the stacker's missing lower input and unblock production."
2. `say`: "Feed the missing lower input of the blocked stacker."
   `why`: "C4 is starved on its lower input, and M4 is a nearby free source."
3. `say`: "Feed C4's missing lower input from C2's available cutter output."
   `why`: "Unblocks the starved stacker and gives C2's stranded output a destination."

两臂的输出**几乎逐字相同**，两臂都 0 次提到那两条带子。
唯一一次「读到」的迹象也不成立：另一次单独探测（`probe-llm.mjs`）里模型说
"No macro cards were retrieved, so I cannot safely issue a valid schema-compliant
repair call." —— 那次是我重建的 prompt 缺了宏卡片，不是它在回应读数。

### 5.1 为什么可能读不到（两个可检验的解释，都指向同一处）

1. **那两条带子在 prompt 的其它地方不存在。**
   `grep` 两份 prompt：`B451` / `B691` 只出现在 `reoriented belts` 这两行里，
   `## BELTS` 段里**没有**它们的描述（因为 B 组故意选了死带子，
   而 BELTS 段按诊断相关度选，没选到它们）。
   所以模型看到的是两个**它此前从未见过的句柄**，没有任何上下游/货量/位置上下文。
   与本仓库 `hint-must-carry-handle` 的教训一致 —— 但那次是「没句柄」，这次是
   「**有句柄、没实体**」。
2. **这段的位置在 `## LAST ROUND` 的中段**（charOff 7481 / 13335），
   离 `## YOUR TURN` 还有 700–900 字符。参考 `gap-hint-belongs-in-goal-section`
   （同一句话放第 2500 字符 4 次全忽略、放第 80 字符当场用），
   位置本身就可能足够解释 0/6。

这两条都是**可证伪的**，而且都不需要改 `src/` 就能做：
把 B451/B691 强制塞进 BELTS 段再问一次，或者把这段挪到 `## YOUR TURN` 前面。

---

## 6. `count === 0` 的那些次，是「这个世界不触发」还是「判据漏了」？

分三种情况，**答案是三种都出现过**，必须分开答：

### 6.1 历史 run `r-20261123234341-c6c7` 的 count=0 —— 世界确实不触发

那次是真 tx（`applied 2/2`），但 `delete#17410` 在 (90,-39) 一带、
`place` 落点无关。我用复刻的游戏算法（下节）算过：那个落点的影响面里
没有带子，读数给 0 是**正确**的。

### 6.2 我自己的 A / A′ / A″ 三次 count=0 —— 判据没漏，是 immutable 在起作用

这三次我都同时做了**手工 obs 差集**（不经 `reorientedBelts`），
结果都是「0 条带子变向」—— 与读数一致。所以不是判据漏，
是**游戏真的没重算**（op[0] 被 `performImmutableOperation` 护住）。
这与 §2.2 的 B 组（第二条 op、count=2）构成完整对照。

### 6.3 但我确实**漏过一次** —— 漏的是我的离线预测器，不是 `reorientedBelts`

这一点必须写清楚，否则会误导下一个读这份报告的人：
第一次 A/B 我用自写的「游戏重算复刻器」挑落点，预测「会翻 4 条」，
真机实测 0 条。我当时的判断是「读数坏了」。**错了 —— 是我的复刻器错了三处**：

| # | 我的错 | 正确做法 | 源码位置 |
|---|---|---|---|
| 1 | 用**当前** `rotation` 当基准 | 游戏传的是 **`originalRotation`** | `systems/belt.js:157` |
| 2 | 按 **3×3** 找触发源 | 只扫**正交四邻**（`abs(dx)+abs(dy)!==1 → continue`） | `logic.js:398-402` |
| 3 | ejector/acceptor 的方位记成 `d`（从自己指向邻居） | 记成 **`OPP[d]`**（从邻居指向自己）—— 差 180° | `logic.js:436-462` |

修完三处之后，复刻器对 699 条带子做 **fixpoint 自检：696 条复现现状、0 条不符**
（另 3 条反解不出 `originalRotation`，29 条有多解）。然后再用它挑落点，
`act{op:"place"}` 的实测与预测**逐条一致**（uid 16350，rv 2→0）。

这条教训与 `check-own-metric-before-concluding` 同族：**读数说 0 的时候，
先证明「0 是对的」，再怀疑读数。** 我第一版直接把它当成了读数缺陷。

---

## 7. 六个判据的总表

| 判据 | 结果 | 证据 |
|---|---|---|
| 1. `reorientedBelts()` 算得出东西 | **✅ 能**（真机 count=2，B 组） | `gt-ab2` 的 verifyRound 输出；`diff.modified=[16638,17348]` 与 items **逐条相同** |
| 2. 渲染进 prompt | **✅ 能**，逐字节正确 | charOff 7481 / 13335，两处；段原文见 §4.1 |
| 3. 模型读到了 | **❌ 没有**（0/3 vs 0/3） | §5 的 6 条原文 |
| 4. 读数本身可信（不误报/不漏报） | **✅ 可信** | A 组 3 次 count=0 与手工差集一致；B 组 count=2 与手工差集一致；4 次全部吻合 |
| 5. tx 0 时字段缺席（不是 0） | **✅ 符合设计**，但会误导复盘 | `…0c8d` / `…a764` 的 transcript 里没有 verify 记录 |
| 6. 离线 13 条测试 | **✅ 13/13 通过** | `node --test src/agent/loop/reorient.test.mjs` |

---

## 8. 一句话结论

**「送达但没用」。**

读数本身是**对的**（真机 count=2 与手工差集逐条吻合，A/B 两次都吻合），
也**真的送到了**（prompt 字节级可验，两处偏移都记在 §4）。
但模型**不读它**：6 个样本、两臂对照、0 次提到被改向的带子。

而「模型为什么读不到」有两个**现成的、可测的**怀疑点，
它们和本仓库已经记过的两条缺陷是同一族：

- **有句柄、没实体**：B451/B691 在整个 prompt 里只出现在那两行警告里，
  `## BELTS` 段没有它们的任何描述。模型看到两个陌生名字，没有可依据的东西。
- **位置太深**：charOff 7481 / 13335，离 `## YOUR TURN` 还有 700–900 字符。
  `gap-hint-belongs-in-goal-section` 记过同一句话「放第 2500 字符 4 次全忽略、
  放第 80 字符当场就用」。

还有一个**新测出来的代价**，之前没人量过：
这段 +299 字符，在 L12 上会**挤掉 3 条带子**（BELTS 段 16→13 条）。
而带子是模型唯一能就地改造的东西。

**没有改任何 `src/` 文件。** 世界已完全复原（749 实体、0 几何差异）。

---

## 9. 复现路径（方法，脚本已按约束删除）

按任务硬约束，`.tmp-reorient-live/` 下的临时脚本跑完就删了。下面把**重新做一遍**
所需的全部信息写全 —— 都是「调哪几个真函数 + 注意哪几个坑」，不依赖那些文件。

### 9.1 纯 LLM run（证明「没走到那一步」）

```bash
bash tools/live-run.sh --goal "CbCbCbRb:CwCwCwCw" --rounds 3 --yes
# 读 research/ai-plan/runs/r-<id>/transcript.jsonl：
#   有 verify 记录吗？没有 ⇒ tx 0 ⇒ belt_reorient 字段根本不存在（不是 0）
```

### 9.2 受控 A/B（真 tx + 真 verifyRound + 真 buildPrompt）

关键是要**绕开 plan 管道的 V1 规则**（`coords.mjs`：LLM 不许写字面坐标，
只认 `$ref`/`$uids`/…）。所以不要走 `runLoop`，直接：

```js
import { makeBridgeReader } from "src/agent/loop.mjs";
import { verifyRound } from "src/agent/loop/verify.mjs";
import { buildPrompt } from "src/agent/loop/prompt.mjs";
import { buildHandles } from "src/agent/loop/handles.mjs";

const reader = makeBridgeReader("http://127.0.0.1:7777");
const beforeObs = await reader.obs({});                 // 与 loop 的 obs 同参数
const tx = await reader.tx([
  { op: "place", building: "trash", x: inertX, y: inertY, r: 0 },   // op[0]：被 immutable 护住
  { op: "place", building: "trash", x: targX,  y: targY,  r: 0 },   // op[1]：不被护住 ← 关键
]);
const report = await verifyRound({
  reader, beforeObs, tx, handles: buildHandles(beforeObs, items),
  txPlan: { placements: [...], removes: [], destroys: [], flows: [] },
  uidMap: {}, mode: "live", goalShape: "CbCbCbRb:CwCwCwCw", flows: [],
  behavior: false,        // ★ 关掉：step(2400) 会额外改世界，干扰归因
});
report.reoriented          // ← 判据 1
```

然后拿 `report.reoriented` 填进 `lastRound.belt_reorient` 交给 `buildPrompt`
（**真的** `buildPrompt`，budget 用生产值 `in_chars_max:24000 / prompt_tokens_max:5300`），
在 `user` 里 `indexOf("reoriented belts")` 拿偏移 —— 判据 2。

### 9.3 复刻器必须修的三处（**这是本次最容易踩的坑**）

想离线预测「放一格会翻哪几条」，三处不修就全错（我第一次就是这么得到 0 条的）：

| # | 错 | 对 | 源码 |
|---|---|---|---|
| 1 | 用当前 `rotation` 当基准 | 用 **`originalRotation`**（从 obs 反解：哪个 origRot 能复现当前 `(r,rv)`） | `systems/belt.js:157` |
| 2 | 3×3 找触发源 | 只扫**正交四邻** | `logic.js:398-402` |
| 3 | 方位记 `d`（自己→邻居） | 记 **`OPP[d]`**（邻居→自己） | `logic.js:436-462` |

自检判据（不碰游戏就能验模型）：用「当前邻居集 + 反解出的 origRot」复算一遍，
结果必须**等于现状**。本世界 699 条带子：修好后 **696 条复现、0 条不符**；
三处没修时会有几十条「本来就该变」，于是把「不可变保护」误判成「读数坏了」。

### 9.4 判据 3 的 A/B

把两份 prompt（有段 / 无段）交替喂真 LLM，各 3 个样本，检查回答里有没有
被改向带子的句柄。**必须带重试**：本次 6 次调用里 3 次撞 504/502。

