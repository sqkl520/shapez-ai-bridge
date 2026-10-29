# diagnose 语义化：红队裁决与修正

日期：2026-10-30
输入：`REDTEAM-DIAGNOSE-SEMANTICS.md`（12 条）+ 主线程逐条复核

> **本文件优先于 `DIAGNOSE-SEMANTICS-CONTRACT.md` v1。**
> 红队提了 12 条，我验证了其中最致命的三条，**全部成立**。
> v1 不能直接开工，按本文件修正后再实现。

---

## 0. 复核结果

| 红队指控 | 主线程复核 | 证据 |
|---|---|---|
| **F-1** T3「修好后 0 blocker」按 v1 自己的定义必然失败 | ✅ 成立（逻辑推演，无需实测） | §1 说 `PROCESSOR_REQUIRED` 是「正常断」；§3 又说它是 blocker；T3 要求 blocker=0 |
| **F-2** 排序键与期望相反 | ✅ 成立 | 实测 x=1（主干）有 **32 条**可达带子，是离 hub 最近那一侧；按「到 hub 跳数升序」cutter 会分给主干而不是 x=4 段 |
| **F-3** 接受集漏了 x=2 与 x=3 | ✅ **成立，且比红队说的更严重** | 实测可行位置：x=2 **18 个**、x=3 **10 个**、x=4 **5 个**、x=5 **0 个**。v1 只认 x∈{4,5} ⇒ 把 28 个正解判成失败 |

### F-3 的实测全表（主线程）

```
x=2: y = -30..-26, -22..-10   （18 个位置全部可落 cutter+trash）
x=3: y = -22, -21, -20, -19, -18, -14, -13, -12, -11, -10   （10 个）
x=4: y = -14, -13, -12, -11, -10   （5 个）
x=5: 无                        （cutter 2×1 会伸到 x=6，那里没带子）
```

**x=2 的完整解**（实测 `replace_run` 返回 ok）：
```
region [2,-14,3,-12] → removes [10217,10215,10201]
                      placed cutter@(2,-12) + trash@(2,-13)
```

这是**第十三次同类错误**：判据把正确答案判错。
第十二轮我把"历史正解"当唯一解，这次我把 x 范围写成了 `{4,5}`。

---

## 1. 修正：接受集必须是"物理可行"的，不是"我以为对的"

### 裁决

**判据不再写死任何 x/y 范围，改为运行期枚举 + 结构验证。**

```
接受集 = { 所有 (x, y) 使得 replace_run(region 覆盖 (x,y) 与 (x+1,y) 与 (x,y+1),
                                          building=[cutter, trash(port=left, confirm_waste)])
           返回 ok，且产出的 cutter 产品口能到达 hub }
```

**这个判据是自指的**（用真宏枚举），所以不会像手写范围那样漏。

代价：枚举需要跑几十次宏（每次纯内存，实测 < 1ms）。实验脚本里可接受。

### 为什么不能在契约里写范围

因为**范围取决于世界**。L4 上 x=2 能放、x=5 不能放，原因是：
- x=5 的 cutter 会伸到 `(6,y)`，那里没有带子 ⇒ 宏拒绝
- x=2/x=3 的链也是 `RuRuRuRu`，也汇入 balancer ⇒ 同样有效

**任何写死的范围都是对当前存档的一次过拟合。**

---

## 2. 修正：F-1 —— 「正常断」不能是 blocker

### 问题

v1 自相矛盾：`PROCESSOR_REQUIRED{scope:"stream"}` 同时被称为「正常断」和 `blocker`。

### 裁决

**引入 severity 的第三档语义，但不用新枚举值**（避免动闭集）：

- `PROCESSOR_REQUIRED{scope:"stream"}` → `severity: "warn"`
  语义：这是「**该做的事**」，不是「**坏掉的东西**」。
- `PROCESSOR_REQUIRED{scope:"factory"}` → `severity: "blocker"`
  语义：工厂里根本没有这台机器（buy 不到/没放），这是真的坏。
- T3 改成：**修好后，`blocker` 级语义码 = 0，`warn` 级允许存在**。

### 为什么这样分

- `scope:"stream"`：机器存在，只是不在那条流上 ⇒ **计划能修**，不是缺陷
- `scope:"factory"`：机器根本不存在 ⇒ **需要先有机器**，是真缺陷

---

## 3. 修正：F-2 —— 排序键不能用"到 hub 跳数"

### 问题

v1 的排序键 `(能否到 hub 降序, 形状已知降序, 到 hub 跳数升序, 链头句柄升序)`
会让 cutter 分配给**离 hub 最近的主干**（x=1，32 条带子），而不是目标链。

这正是 v1 §11 自己警告的「按拓扑就近」——却写成了规格。

### 裁决

排序键改为：

```
(canReachHub 降序,
 inGoalRawCorridor 降序,        ← 新增，且优先级高于跳数
 shapeKnown 降序,
 hopsFromMiner 升序,            ← 从矿机起算，不是从 hub
 chainHeadHandle 升序)
```

`inGoalRawCorridor` = 「这条流的源头是脚底下为配方 raw 的矿机」。
L4 上：x=2/x=3/x=4/x=5 的 Ru 链都在走廊内；x=1 的铜主干不在（它源自 `Cu` 矿机）。

**这直接修掉了 F-2**：主干不在走廊里，排在所有 Ru 链之后。

---

## 4. 修正：F-4 —— `WRONG_SHAPE_AT_HUB` 会把 hub 入口顶到 BELTS 最前

### 问题（红队实测）

v1 §5 的 `WRONG_SHAPE_AT_HUB` 的 `evidence.handles` 含 `B135/B136/B137`。
而 `pickBelts` 先放 `referencedHandles(diagnoses)` ⇒ 那三条会被顶到 BELTS **第 1–3 位**，
与「阻止模型改 hub 入口」的目标**相反**。

### 裁决

`WRONG_SHAPE_AT_HUB` 的 `evidence.handles` **只放 hub 本身**，不放入口带子。
入口带子放 `evidence.hub_inlets`（一个独立字段，不参与 `referencedHandles`）。

并在 prompt 的 S4 里加一句（由码本身携带）：

> `hub receives RuRuRuRu and ----CuCu, but the goal needs RuRu----.
>  The fix is upstream: a missing process step on the line that FEEDS the hub, not at the inlet.`

最后半句是关键的——它**明确告诉模型往上游找**。

---

## 5. 修正：F-5 —— 隧道不是"停住"

### 问题

v1 §0 F3 写「右口 → 隧道 → **停住**」。
红队实测：`sender 10077 → receiver 10078 → 喷口(-7,-15) = trash#10037`。

**产品被销毁，不是停住。**

### 裁决

修正事实描述。这不改变 F3 的结论（"送错"而非"断"），但改变了机制：
产品进的是 trash，不是卡住。

---

## 6. 修正：F-7 —— 诊断条数会挤掉 BELTS 与 RECIPE

### 问题（红队实测）

用真 `buildPrompt`：
- v1 §1 字面的 13 条诊断 → BELTS 只剩 **2 条**、**RECIPE 被丢**
- T4 的 19 条 → `over_token_budget=true`、**0 条带子**
- v1 §5 的 5 条刚好把 **B82** 挤出 12 个名额

根因之一：`prompt.mjs:1207` 缩带子时把 `goalAndRecipe` 换成 `s3Goal`，**recipe 永久丢失**。

### 裁决

1. **诊断数量硬上限：每码 ≤3 条，总量 ≤8 条**（不是 12）。
   超出部分不静默丢弃，在首条 `evidence.suppressed` 记数量。
2. **recipe 段永不因为带子截断而丢失** —— 修 `prompt.mjs:1207` 的 bug。
3. 加测试：任何诊断组合下，BELTS 段必须 ≥10 条、RECIPE 段必须存在。

---

## 7. 修正：F-8 —— 句柄重编号会让指纹抖动（反向）

### 问题

红队实测：一次修复后 **96/181** 个句柄重编号（`C1` 从旧 cutter 换到新 cutter）。

而 v1 §4 说「evidence 里放窗口计数会让指针抖动」——
实际上 `fingerprintOf` 只取 `code/subject/handles/uids`，
**真正会抖动的是 handles**（因为编号会变），不是窗口计数。

### 裁决

`fingerprintOf` 里 **`handles` 改用 `uids`**（uid 稳定，句柄不稳定）。

这条是**对现有实现的修改**，需要单测：同一份世界、两次编号不同 ⇒ 指纹相同。

---

## 8. 修正：F-9 —— 「零 node: import」与「复用 slotsOf」不可兼得

### 问题

`diag_semantics.mjs` 要求「零 `node:` import」，但 `slotsOf` 来自 `verify_runtime.mjs`，
后者 import 了 `node:fs`。

### 裁决

放弃「零 node: import」这条**形式约束**，改为**实质约束**：

> `diag_semantics.mjs` **不许有副作用**（不读文件、不 spawn、不写）。
> 允许 import `node:` 内置模块的类型/纯函数，但不许调用任何有副作用的 API。

**可测试**：`grep -E "readFileSync|writeFileSync|spawnSync|execSync" diag_semantics.mjs` 必须为空。

---

## 9. 修正：F-10 —— `PROCESSOR_REQUIRED` 字段名三处不一致

### 问题

`op` vs `kind`；`scope:"factory"` 不在 §3 的触发条件里。

### 裁决

统一为：
```js
{ code:"PROCESSOR_REQUIRED",
  evidence:{ op:"cut"|"rotate"|"stack"|"paint",     // ← 统一叫 op
             machine:"cutter"|"rotater"|...,         // ← 机器种类
             need:int, have:int,
             scope:"stream"|"factory" } }
```
触发条件补上 `scope:"factory"`（工厂里该类机器数量 < need）。

---

## 10. 修正：F-12 —— 行为基线 6/10 已被撤回

v1 §8 的成功线「touched hub inlet 从 6/10 降到 ≤1/10」基于一个**已被撤回**的数字
（真实是 1/10）。「降到 ≤1/10」等于「零改善也算成功」。

### 裁决

改用**新的行为指标**（可测且不依赖我那个错误的计数）：

> **`selected_correct_bucket`**：模型选中的带子里，有多少条落在"物理可行的改造位置"上
> （用 §1 的运行期枚举定义接受集）。

基线（第十二轮 10 次 `coldstart-live-2026-10-29T10-51-46-960Z.json`）：
**2/10 结构正确**（按旧判据）。

成功线：**≥6/10**，且正/负对照都必须通过。

---

## 11. 保留下来的（红队也攻不动的）

| 项 | 理由 |
|---|---|
| `diagnose` 保持纯函数 | 两次调用指纹相同（红队实测） |
| recipe 预计算 + 注入 | F1 性能成立（红队复测 median 230ms） |
| `--no-cutquad` 等级门控 | 是真 bug（`Cu----Cu` 现在输出 L16 的 cutQuad） |
| `shapeAt(B63) = RuRuRuRu` | 成立 |
| T3 是最便宜的证伪手段 | 方法论成立（只是判据要修） |

---

## 12. 修改后的实施顺序

1. **P-a0（最小可验证）**：只做「结构层重写」（`STRUCTURAL-DIAGNOSE-DESIGN.md` 那套），
   **不碰语义层**。验收 = 基线文档的 5 条必要条件。
   - 理由：结构层是语义层的地基，而且它的判据更硬（纯拓扑，不依赖配方）
2. **P-a（语义层）**：在 P-a0 绿之后再加配方闭包 + 作业分配
3. **P-b（prompt）**：修 F-7 的 recipe 丢失 bug + 诊断上限
4. **P-c（实验）**：新行为指标 + 运行期枚举的接受集

**关键**：P-a0 先做，因为它能独立验证，且不需要 solver。
如果 P-a0 的 5 条必要条件过不了，语义层做什么都没用。
