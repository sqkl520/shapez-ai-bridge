# 实机验证 —— 第一波结论（离线，零游戏写入）

> 2026-10-30 / 31。全部**离线**得出：读代码、解码存档、合成几何、跑编译器 CLI。
> 游戏实例全程未被写入（仅一次 `load_save` 之外零动作；实际上连读都没跑）。
> 用户存档 `5c967065` 的 sha256 基线已锁定，未变。

---

## 结论 0：这一轮最重要的发现

**阶段 2 的 loop 在真实冷启动场景下，`outcome="success"` 结构上不可达**——
与产线是否真的工作无关。

**只需要一个 bug 就够：**

| 步骤 | 事实 | 证据 |
|---|---|---|
| 1 | `reader.debugItems({})` 缺 `region` | `loop.mjs:377` |
| 2 | mod 的 `debugItems` 要求 `params.region` 是长度 4 的数组，否则抛 2001 | mod `shapez-ai-bridge.js` |
| 3 | 异常被 `catch` 成 `ITEMS_UNAVAILABLE` 诊断，`items` 保持 `null` | `loop.mjs:378-383` |
| 4 | `items=null` ⇒ `checkFlow` 的 `paths=null` ⇒ 返回 `undecidable:true` | `verify_runtime.mjs:625-627` |
| 5 | `strictVerdict` 第 4 条：`L3-flow` 不可判定 ⇒ 判红 | `verify.mjs:307` |
| 6 | `outcome` 永不为 `success` | `loop.mjs:1868` |

**实测确认第 5、6 步**（合成 report 喂给 `strictVerdict`）：
```
场景A (debugItems 失败): false ["L3-flow 不可判定（debug_items 没有返回 paths）"]
```

**为什么 2077 条测试和离线 8/10 都发现不了**：
- `src/agent/fake_game.mjs` 的 `debugItems` **接受 `{}`**（不是 bug，是假世界不需要 region）
- `src/agent/verify_runtime.mjs:908` 的 `BRIDGE_READER` **传了 region** —— 两处 reader 口径不一致
- 所以离线环境永远走「正常」分支

### 另外两个堵点（真实但**不阻断** success，之前我判重了）

- **`V-obs-flow` 对 `adjacent` 形态恒红**：实测 `strictVerdict` **不看** `V-obs-flow`，
  它只查 L0/L1/L2/L3/L4 + undecidable + 未声明销毁。
  实测：`V-obs-flow.ok=false` 时 `strictVerdict.ok = true`。
  ⇒ 这是一条**噪音检查**，会在报告里制造假红，但不影响 `outcome`。
- **`loop` 调不到编译器**：`MACRO_FNS` 只有 6 个宏且双向断言，`build_line` 不在其中。
  这不是 bug，是**架构决定**。但它意味着「编译器修好了极性」对 `runLoop` 零影响。


---

## 结论 1：历史 L4 蓝图三份全部反极性

判据不是追 intent，是追**当时真正贴进游戏的 `.szbp.txt`**。

| 目录 | anchor | cutter origin | left 槽终点 | right 槽终点 | 判定 |
|---|---|---|---|---|---|
| `lvl4`  | `[0,-16]` | `(3,-13)` | **HUB** | **TRASH** | 反 |
| `lvl4b` | `[-1,-17]` | `(2,-14)` | **HUB** | **TRASH** | 反 |
| `lvl4e` | `[1,-17]`  | `(2,-14)` | **HUB** | **TRASH** | 反 |

而 `op-templates.mjs`（commit `98927de` 之后）的判据是 `left=waste / right=product`。

⇒ **产品 `RuRu----` 进了 trash，废料 `----RuRu` 进了 hub。三份全反。**

旁证（物理证据，不是推理）：
- `7c93b3dd`（L4 存档）的 `hubGoals.storedShapes` = `{"CuCuCuCu":12,"----CuCu":686,"RuRuRuRu":2016,"----RuRu":4575}`
  —— 有 `----RuRu` **4575 个**，**没有 `RuRu----`**。
- 全世界只有「切 `RuRuRuRu`」能产出 `----RuRu`，而这份存档里没有其它 cutter。
- commit `07cc421`（2026-10-25 20:00）的 message 自证：
  「Found by watching the live hub: **RuRu---- still arrived as ----RuRu** after the "fix"」

**输入侧没有断供**：三份 cutter 的 primary 输入格都被 r=0 的带子朝 top 正确喂入。
所以历史 `NO-PRODUCTION` 是 0 而不是缓慢增长——它一个产品都没产过。

---

## 结论 2：当前编译器的极性修对了，但它到不了 loop

`RuRu----` 在 15 个方案上极性全对（5 seed × 3 配置：`--tunnels` / `--miners 3` / `----CuCu`）。
判据不写死坐标，且对 `----CuCu` 断言的是**相反方向**，不会靠「总把 left 判成废料」蒙对。

但「修对了」对本次实机验证的 `runLoop` 路径**零影响**，因为 `build_line` 不在 loop 的宏白名单里。

### 附带发现：`wasteRoles` 是目标无关的常量，这是同一个 bug 的另一面

```
RuRu---- → 产品 right，废料 left
----CuCu → 产品 left ，废料 right
```

`wasteRoles = ["left"]` 写死，导致：

```
trash_unused(cutter.left)   ★ 产品槽（----CuCu 的目标）→ ok=true，没要求 confirm_waste
trash_unused(cutter.right)  废料槽                    → ok=false，precondition_failed
```

即**产品槽可免签销毁，废料槽反而要签字**。

`contract.mjs:1361` 的注释自己写着：
> 「`wasteRoles` 是**半切场景**的约定（'----CuCu' 要的是左列，右列才是废料），
> 不是「这一侧永远没用」—— L4 的 RuRu---- 恰好要右列、丢左列。
> 所以：目标形状决定哪一侧是废料，宏查不出目标，只能要求调用方签字。」

**设计意图是对的，实现把意图破坏了。** 这不影响 L4，但任何 `----CuCu` 类目标都会被它误导。

---

## 结论 3：`--hub -2,-2` 单矿机编不出来，但**有现成的合法解**

真实 L4 存档的 hub：`origin=(-2,-2)`，4×4 覆盖 `x∈[-2,1], y∈[-2,1]`，r=0。

**单矿机（默认配置）**：
```
--hub -2,-2 → ok=false no-site-large-enough   （5 seed × 4 range 全部失败）
--hub -2,-3 → ok=false no-site-large-enough
--hub -3,-2 → ok=true  29 实体 0 隧道
--hub -4,-2 → ok=true  30 实体 0 隧道
```

**★ 但 `--miners 3` 在真实 hub 位置下成功 ★**
```
node src/ai/compiler/cli.mjs --goal "RuRu----" --seed 60908 --hub "-2,-2" --level 4 --miners 3 --json
→ ok=true  44 实体  0 隧道  pasteAt=[1,-19]
→ 极性正确：cutter@(4,-17)
    left  (4,-18) → TRASH@(3,-18)
    right (5,-18) → HUB@(1,-2)
```

**这是本轮最有用的一块**：真实 L4 世界上有一条现成的、L4 合法的（无隧道）、极性正确的方案。
它可以直接用来做**实机阳性对照**——先证明「这个世界的 L4 物理上能出货」，
再去验 loop 能不能自己造出类似的方案。

### 单矿机为什么不行（因果，不是猜测）

插桩 A/B（只改一个变量）：
`connectHub:false` 时成功（trash 落在 (4,-14)/(5,-14)），`connectHub:true` 时失败。
`chHub`（hub 通道）占了 `(4,-14)`，而 `(4,-14)` 正是 cutter 左槽的零拐角直串落点。
`trashCandidates` 只从 k=2 起跳（`place.mjs:1900`），短距直串落点被 hub 通道抢走。

上游 commit `2bdef87` 已承认：
> 「a 2x1 cutter has two outputs on the same row, and the layout layer still has no rule that reserves room for both」

`--miners 3` 之所以能过：cutter 被推到 `y=-17`，左槽下方不再撞 hub 通道。

⚠️ **`--hub -3,-2` / `-4,-2` 那几份在真实游戏里无效**——它们假设 hub 在错误位置，
收集带会落在空地上。只能用来说明「贪心顺序是问题」。


---

## 结论 4：隧道在 L4 未解锁，而编译器看不见这件事

- 游戏侧：`underground_belt.js:178-180` → `isRewardUnlocked(reward_tunnel)`
- `levels.js` 三套关卡表都是 **L5（`Cu----Cu`）完成**才给 `reward_tunnel`
- `hub_goals.js:46-50`：`for (i < level-1) gainedRewards[levels[i].reward]++`
  —— L4 只回填 L1/L2/L3 的奖励，**无 `reward_tunnel`**
- 编译器侧：`recipe.mjs` 的 `MIN_LEVEL_FOR_MACHINE` **没有 tunnel 项**；
  `validate.mjs` 的 V10 只扫 `layout.placements`，隧道不在其中
- 实测 `--level 1 --tunnels --enforce-unlocks` 仍 `ok:true`，V10 报「3 台机器全部在可用集内」，
  而方案含 2 条隧道。`plan.scope.tunnels` 恒 `false`（`compile.mjs:1454` 写死 `{...SCOPE_V1}`）

⇒ **`--tunnels` 编出的 L4 方案，贴进游戏后隧道不会被放置**（或放置后被拒）。
这是编译器的一个独立缺陷：它不知道自己最常用的 L4 解法在 L4 上非法。

---

## 结论 5：代理可通，但 `loop.mjs --llm` 连不上

实测代理返回 200：
```
POST http://ddns2.keniis.top:3000/v1/messages
model=virtual/opus → 回显 "SCNet-Max"，content 有 text
```

但 `runLoopCli` 没有 `--base-url` / `--model` / `--api-key`，
`makeClient({mode:"live"})` → `new AnthropicClient(opts)` → `endpoint` 恒为官方地址。

实测三个 `max_tokens` 档位（同一份 10671 字符 prompt）：

| max_tokens | 结果 |
|---|---|
| 1200（`AnthropicClient` 缺省） | 10 次里 **9 次 `text=""`** 且 `stop_reason=max_tokens`（thinking 吃满），仅 1 次侥幸 |
| 4000 | 1901 tok 正常，但单次 44s，另 1 次撞 280s 超时 |
| 8000 | 3/3 正常，单次 11–29s |

⇒ **即使修好 CLI，缺省的 1200 也会让 9/10 次解析失败**，且这个失败看起来像「模型不会规划」。

---

## 结论 6：「离线 8/10」与「实机 0/2」不是同一件事

| 轴 | 离线 8/10 | 实机 0/2 |
|---|---|---|
| 世界 | `cf469f75` 的 L4 快照，seed **55013**，**181 实体** | `7c93b3dd`，seed **60908**，**1 实体** |
| 起点 | 55 个可行 cutter 落点 | **0 个** |
| 代码路径 | prompt→LLM→parse→宏→`planToTxOps`，**在此返回** | 读磁盘 `.szbp`→`paste_blueprint`→readback→step |
| 判据 | 落点 ∈ 运行期枚举集 + 删除集正确 | hub `stored_shapes` 增量 |
| 时间 | 2026-10-30 | 2026-10-25（早于 `wasteRoles` 修复 4 天） |

**三条路径互不重叠，任何一方推不出另一方。**

但要说清一件事，免得过度否定：**8/10 的 8 个成功都真在钌线上**（模型 10/10 都选了 x=2）。
判据的接受集确实偏宽（55 个落点里 17 个落在铜线上），但**没有在实际样本上造成假绿**。
8/10 的真问题只有一条：**它到 plan 就停，之后的写世界、验世界、交付，一次都没跑过。**

---

## 本轮还没做的事

- **零实机写入**。所有结论都来自离线。
- `runLoop` 的 `mode:"live"` 分支**从未执行过**（8 份历史转录的 `tick` / `camera` 与 fixture 逐字节相同，
  说明用的是 FakeGame，不是真桥）。
- `success` 分支是**未验证的代码**。
- 目标世界 `7c93b3dd` 的真实 `goal.requirement.required` 还没实机确认（离线推断是 `RuRu----` / 70）。

---

## 下一步必须先决定的事

**堵点 1（`debugItems` 缺 region）是 loop 自己的 bug，一行改动。**
在修它之前做任何实机跑，`L3-flow` 必然 undecidable，`outcome` 必然是 `halt`，
而 `halt` 的原因会是「验证链判红」，不是「产线不通」——这会又一次把两类问题混为一谈。

所以顺序应该是：

1. **先修堵点 1**（`debugItems` 传 region）—— 一行改动，有实测依据
2. **然后做实机阳性对照**：用 `--miners 3` 那份 44 实体方案直接 `paste_blueprint` 贴进 `7c93b3dd`，
   跑 2400 tick，看 hub 的 `stored_shapes["RuRu----"]` 是否增长。
   **这一步绕开 loop，单独验证「L4 世界 + 正确极性的方案 = 能出货」。**
   如果这一步都失败，那 loop 的一切讨论都没有意义。
3. **然后才跑 loop**

堵点 3（loop 到不了编译器）不是 bug，是**架构决定**——需要在实机验证的设计里明确：
本轮验的到底是「6 个增量宏能不能就地修好一个反极性世界」，
还是「编译器能不能在空地上建一条新线」。**这两件事的可达性完全不同。**


---

## 如果要给出「阶段 2 到底成不成立」的答案

**现在还不能给。**

离线 8/10 证明的是「模型能产出一个**物理可行**的计划」。
它没有证明：
- 计划能落盘（`tx` 从未在真桥跑过）
- 落盘后能验证（**`debugItems` 缺 region ⇒ L3 恒 undecidable ⇒ 永不为 success**）
- 验证绿之后 hub 真能收货（`checkBehavior` 的 delta 在 level-up 时会变负，未实测）

**第一件已在代码层证明是坏的。第二件未测。**


---

## 追加：堵点 B 的独立复核（2026-10-31 10:00）

主线程用 **mod 的真实语义**（`boundAcceptor` = `StaticMapEntity.origin`）重跑了机制实验：

```js
// 几何：cutter(2,-14) → 带子(3,-15) → path → hub(-2,-2)
const items = { pathCount:1, paths:[{cells:[[3,-15],[3,-14]], boundAcceptor:[-2,-2]}] };
checkFlow(plan, obs, items, { flows:[{from:20000, to:20007}] })   // to=带子 → ok=false
checkFlow(plan, obs, items, { flows:[{from:20000, to:10000}] })   // to=hub  → ok=true
```

判红那次，`trail` 里写着：
```
[{ from:20000, path_first:[3,-15], path_last:[3,-14], to:10000, at:[-2,-2] }]
```
**货确实到了 hub，但 `flow.to` 写的是带子 ⇒ 判红。**

⇒ 堵点 B 成立，且与 `boundAcceptor` 的取值无关。

### 顺带确认的一条潜在陷阱（本次不动）

`checkFlow` 的 `byOrigin` **只用 origin 索引**（`verify_runtime.mjs:634-635`）：
```js
for (const e of ent) if (!byOrigin.has(K([e.x, e.y]))) byOrigin.set(K([e.x, e.y]), e);
```
这对 4×4 的 hub 是**对的**，因为 mod 报的 `boundAcceptor` 就是 origin
（`shapez-ai-bridge.js:1017-1020`：`[StaticMapEntity.origin.x, StaticMapEntity.origin.y]`）。

**但**如果将来有人：
- 把 mod 改成报入口格，或
- 用一个自定义 reader 报入口格

那么 `byOrigin.get([1,-2])` 会找不到 hub（origin 是 `(-2,-2)`），
`checkFlow` 会**误判成红**——而 `trail` 里明明显示走到了 hub。
（这正是主线程栽过 4 次的「origin 索引 vs footprint 索引」那一类错误。）

**本次不改**：mod 报 origin，所以现状是对的。登记在此，免得下次有人换 reader 时踩坑。

---

## 堵点 B 修复后的新发现：堵点 D（balancer 的两个输出）

修复 `deriveFlows`（终点从带子下沉到真实体）后，用**带 rv 的真实夹具**重跑
`verifyRound`，结果从 `0/8 reached` 变成 **`5/8 reached`**。

剩下 3 条红的都是 **balancer 的 secondary 输出口**：

```
miner@(3,-6)    → balancer@(2,-8)    via=chain   ← 红
balancer@(2,-8) → balancer@(3,-10)   via=chain   ← 红（两条）
```

**原因**：`checkFlow.reach()` 用 `startAt` 索引 path：

```js
for (const p of paths) {
    const c = (p.cells || [])[0];
    if (c) startAt.set(K(c), p);        // ← 每格只留一条 path
}
```

而 balancer 有**两个输出口**（`primary` / `secondary`），在同一轮里可能各自起一条 path。
`startAt` 是 Map，后写的覆盖先写的 ⇒ 只有一个口能查到 path。

更根本的是：**balancer 的两个输出在游戏里可能汇入同一条 belt path**（取决于摆法），
而 `slotsOf("balancer")` 报两个输出槽。验证器没有「两个槽映射到同一条 path」的概念。

### 这不是修复引入的，是既有局限

修复前是 `0/8`（全部因 `to=带子` 而红），修复后 `5/8`（只有 balancer secondary 红）。
**修复是净改善，但没到 8/8。**

### 对 loop 的实际影响

- **cutter → hub 那条绿了**（最关键的一条，极性正确）
- **cutter → trash 也绿了**
- miner → balancer 部分红

⇒ 冷启动建线时，如果计划里有 balancer，`L3-flow` 仍可能判红。

**这一条需要在下一轮单独修**，方向可能是：
1. `startAt` 改成 `Map<cell, path[]>`，一个格子允许多条 path
2. 或者 `reach()` 在找不到 path 时，退回沿 obs 带子链走（但那要考虑假绿）

**登记在此，本轮不修**（修复 B 已经让情况从 0/8 变 5/8，继续缠下去会让本轮无法收尾）。

---

## region 修复的真桥验证（2026-10-31 11:55，只读）

用**真实桥接**验证 `debugItemsRegion()` 算出来的 region 在真机上被接受：

```
obs → 1 实体（hub），debugItemsRegion(obs) → [-8,-8,4,4]

POST /rpc debug_items {}                    → 2001 "region must be [x0,y0,x1,y1]"   ← 修复前
POST /rpc debug_items {"region":[-8,-8,4,4]} → ok, keys: belts,ejectors,underground,pending,
                                                pathCount,truncatedPaths,paths,counts
                                             pathCount: 0  paths: 0  belts: 0  ejectors: 0
```

- 旧写法在真桥上**确实**抛 2001 —— 与 `LIVE-VERIFY-REPORT.md` §4.1 的判断一致
- 新写法被真桥接受，返回结构完整
- `pathCount: 0` 是对的：这个世界现在只有 hub，没有带子。
  所以 `checkFlow` 之后会走「肯 paths 为空」分支 —— 但那是**世界的真实状态**，不是参数错误。
  （这也说明：`L3-flow` 的 undecidable 有两种成因，必须靠 `ITEMS_UNAVAILABLE` 区分，
  不能只看 `L3-flow` 的颜色。）

**这是本轮唯一一次「修复已在真桥上被验证」的结论。** 堵点 B 的修复仍然只在离线夹具上验证过。
