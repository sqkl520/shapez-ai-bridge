# DIAGNOSE 语义化：事实核查（2026-10-29）

> 核查对象：给 `src/agent/loop.mjs:550` 的 `diagnose()` 接「产线语义」这件事。
> 方法：读代码 + 跑真实调用 + 对夹具做受控变异。**没有碰游戏实例**（全部离线，读 `test/fixtures/saves/` 与仓库内 dump）。
> 所有「跑出来的」数字都可以用本文引用的命令复现。

---

## ⚠️ 最危险的四个错误前提（先读这个）

### 前提 A：「`hubReachable` 把正解链滤掉了，所以 diagnose 报不出来」
**不成立 —— 这是当前规划里最贵的一条误判。**

`hubReachable` 在 L4 上的实际结果是 **152/181 实体可达（84%）**，B81/B82/B69 **全都在集合里**。
被滤掉的是 `x=-10` 那条铜线尾巴、两个隧道格、`x=9` 的死端——正是它注释里说的「与 goal 无关的旧线」。

`research/ai-plan/tmp/DIAGNOSE-BASELINE.md` §2 说「L4 带子 163 / 可达 58 / 被滤掉 105，正解三条全在 105 里」。
**那组 58/105 不是 `hubReachable` 的输出**，而是 `src/agent/loop/prompt.mjs:873-896` 里 `obsWorld().toHub` 的输出。
两个函数同名同目的、结果差 2.6 倍，被当成了同一个。核查见 §9。

**后果**：如果按那个前提动手「去掉 `if (!reach.has(e.uid)) continue`」，你会改掉一个**没有在挡路**的过滤器，
而 diagnose 仍然只出 1 条 —— 因为真正的挡路者不是它，是 §12 说的「集合里根本没有可报的东西」。

### 前提 B：「L4 里 x=4/x=5 那条链到不了 hub，这是正常的」
**部分成立，但方向和常见叙述相反。**

B63@(4,-15) **确实到得了 hub**（走 `B63 → L3 → B56 → … → B137 → H1`，54 跳，用 `handles.mjs` 自己算的 desc 图验证）。
到不了 hub 的是 **B65 / B83 / B85 / B92 / B99 / B129 / B138 / B142 / B146 / B150 / B154 / B158** 这 12 条（L4）。
所以「正常的断」这个词用在 x=4 链上是错的 —— 它没断。

### 前提 C：「prompt 里的 RECIPE 段告诉模型这个形状该怎么造，所以它是对的」
**不成立 —— 它建议的机器，当前存档根本买不起。**

`recipe.mjs` 调 solver 时**只传目标串，不传关卡**（`src/agent/loop/recipe.mjs:66`），
而 solver **默认打开 `cutQuad`**（`solver.mjs:444`），虽然 `cutQuad` 是 **L16** 建筑（`compile.mjs:67`）。
实测对当前两个夹具的目标：

```
Cu----Cu (L5) → recipe.mjs 给出: mine, cutQuad×2, stack        ← cutQuad=L16, stack=L10
               合法解应是:      mine, cut                         (solver --no-cutquad 实测)
RuRu---- (L4) → recipe.mjs 给出: mine, cut                     ← 恰好正确
```

`Cu----Cu` 是 **L5**。`recipe.mjs` 却告诉模型「需要 cutter×2, stacker×1」——
这两样在当时都还没有（`obs.goal.upgrade_levels = {belt:1,miner:0,processors:0,painting:0}`）。
按 level 表，L5 时 `rotate`（L4）、`cut`（L1）可用，`stack`（L10）不可用。

对照：编译器侧**做对了** —— `compile.mjs:246-248` 在 `levelForGoal(goal) < 16` 时强制加 `--no-cutquad`。
`recipe.mjs` 没有这道门控，是全仓唯一漏掉它的消费方。

**后果**：RECIPE 段是「do NOT guess, this is computed」的强断言，但它对 L5 给出的是**造不出来的配方**。
如果 diagnose 复用 `solveRecipe()` 来推「应有工序」，它会把一个 L16 才有的四分之一切割
当成 L5 的期望，从而把「没有 cutter」判成缺陷、或建议放一台玩家放不下的机器。

### 前提 D：「`diagnose` 每轮 spawn 一次 solver」
**不必要，而且已经有代价了。** `buildPrompt` **每次调用**都会 `recipeBlock()` → `spawnSync(solver)`
（`src/agent/loop/prompt.mjs:1182`），实测单次 0.6–1.6 s，`LLM_CALLS_MAX=8` ⇒ 一次 run 最坏 8 次。
如果 diagnose 再加一次，是第 9–16 次。而 `RuRu----` 的 solver 内层耗时只有 **3–10 ms** —— 99% 是 node 冷启动开销。

---

### 1. solver 的输入输出契约
**结论**：成立（契约清晰，但与注释有两处不符）。

**证据**：
- 输入：`node research/ai-player/proto/solver.mjs <target> [flags]`（`solver.mjs:424-460`）
- `--json` 输出（`solver.mjs:466-472`）：
  `{ target, solved:boolean, plan:{targetHash, steps[], ops{}, pigments[]}, replay?:{ok,checks,steps}, stats:{expanded,generated,stackPairs,capped}, known:number, ms:number }`
- 每个 `step`（`solver.mjs:298-317`）：`{hash, op, args, depth, inputs[], parents[], kind}`
  - `kind ∈ {"shape","pigment"}`；`inputs` **顺序即槽位序**（README §1.1 有表）
- `plan.pigments[]`（`solver.mjs:329-331`）：`{hash, color, from:"mineColor"|"mix", inputs[]}`

**两处注释与实现不符**（都会误导消费方）：
- 文件头 `solver.mjs:34-35` 写「`--depth` 默认 6 / `--max-states` 默认 20000」，实际是 **7 / 150000**（`solver.mjs:450-451`）。
- `stats.expanded` 只在单输入展开里自增（`solver.mjs:193`），stack 配对完全不计入 ⇒ **不能用它估算复杂度**。

**对 diagnose 语义化设计的影响**：`steps[]` 足以回答「这个目标需要哪些工序」，但**回答不了「哪条链上缺哪道工序」** —— 它没有世界坐标，也没有实体身份（见 §13）。

---

### 2. `steps[].op` 的取值与对应机器
**结论**：成立（闭集共 7 个，其中 2 个是颜料节点）。

**证据**（`grep -n 'op: "' research/ai-player/proto/solver.mjs`）：

| op | 机器 | 依据 |
|---|---|---|
| `mine` | miner（采形状矿） | `solver.mjs:315`（`e.from === null` 时兜底成 `"mine"`） |
| `cut` | cutter（半切） | `solver.mjs:151-152` |
| `cutQuad` | cutter（quad 变体，**L16 才解锁**） | `solver.mjs:156-159` + README §0 |
| `rotate` | rotater（`args.dir ∈ cw/ccw/180`） | `solver.mjs:163-165` |
| `paint` | painter（**双输入**：shape + pigment） | `solver.mjs:174` |
| `stack` | stacker（`args.merge` / `args.layers`） | `solver.mjs:229,250` |
| `mineColor` / `mix` | miner（采纯色矿）/ mixer —— **`kind:"pigment"`** | `solver.mjs:120,123` |

**注意**：`recipe.mjs:43,144,161` 里出现的 `paintQuad` **solver 从不产出**（`grep` 只命中 recipe.mjs）。
它是 recipe.mjs 单方面想象的 op，属于死代码，不构成事实错误但会误导读代码的人。

**对 diagnose 语义化设计的影响**：`op → 机器` 是单射且稳定，可以直接用来做「这段链缺哪台机器」的匹配；但 `cut` 与 `cutQuad` 都映射到 cutter、`mine` 与 `mineColor` 都映射到 miner —— **要区分「形状矿」和「颜料矿」必须读 `kind`**，不能只看 op。

---

### 3. 不可解形状的返回形态
**结论**：成立，但**三套不同的失败形态**，`recipe.mjs` 只认其中两套。

**证据**（实测）：
```
RuRu----        --json  → solved:true,  exit 0
CgScScCg        --json  → solved:false, exit 2   (150001 states, capped:true)
CpCpCpCp --no-mixer --json → solved:false, exit 2
XXXX----        --json  → 无 stdout，exit 1，stderr "❌ 无法解析目标形状"
--------:CgCgCgCg --json → 无 stdout，exit 1（见 §4）
```
代码：`solver.mjs:455`（解析失败 exit 1）、`solver.mjs:477,510`（无解 exit 2）、`solver.mjs:472`（replay 失败 exit 3）。

**对 diagnose 语义化设计的影响**：`recipe.mjs:75-91` 只处理 `status!==0 ⇒ ok:false`，
三种失败都归成 `{ok:false, reason}`，**丢掉了「目标本身非法」与「预算不够」的区别**。
diagnose 若据此产出「这个形状造不出来」会是**假论断** —— `capped:true` 只说明搜索没搜完。

---

### 4. 多层 / 上色 / 开关
**结论**：多层与上色都支持；开关齐全；**但 CLI 解析目标串有真 bug**。

**证据**：
- **多层**：`so.parse("SrSrSrSr:CyCyCyCy")` OK，实测 `solved:true, 8 steps`（`solver.mjs:205-255` 的 stack 分支）
- **上色**：`paint` 的 `inputs = [shape, color:<name>]`（`solver.mjs:173-174`），间色展开成 `mix`
- **开关**：`--no-rotater/-cutter/-cutquad/-painter/-mixer/-stacker`（`solver.mjs:442-449`）、`--no-pigments`、`--depth`、`--max-states`、`--resources`、`--colors`
- **CLI bug**：`solver.mjs:430`
  ```js
  const target = args.find(a => !FLAGS.has(a) && !(a.startsWith("--") && a.length > 10));
  ```
  任何**以 `--` 开头且长度 > 10** 的目标串都被当成 flag 丢掉。实测：
  ```
  "--------:CgCgCgCg"  → exit 1（多层目标，首层全空）
  "------Cu:CuCuCuCu"  → exit 1
  "SrSrSrSr:CyCyCyCy"  → exit 0（长度 17 但不以 -- 开头，正常）
  "----CuCu"           → exit 0（长度 8，正常）
  ```

**对 diagnose 语义化设计的影响**：**L4/L5 的目标都不受影响**（`RuRu----` / `Cu----Cu` 不以 `--` 开头）。
但这条一旦被 diagnose 依赖，任何「下层全空」的多层目标都会静默变成 exit 1 → `ok:false` → 被读成「不可解」。

---

### 5. solver 性能（20 次实测）
**结论**：单次 **0.21–0.82 s 墙钟**，其中 **99% 是 node 冷启动**；内层算法 3–97 ms。
不可解目标会跑满状态上限，墙钟到 **2.5–4.4 s**。

**证据**（`node .tmpverify/fc_bench2.mjs`，本机，每次重新 `spawnSync`）：

| 目标 | 次数 | 墙钟 min/med/max (ms) | 内层 `ms` 字段 min/med/max |
|---|---|---|---|
| `RuRu----`（L4） | 20 | 298 / 508 / 817 | 3 / 5 / 10 |
| `Cu----Cu`（L5） | 20 | 269 / 506 / 1020 | 17 / 23 / 41 |
| `Cu----Cu --no-cutquad` | 20 | 322 / 727 / 1588 | 34 / 48 / 97 |
| `CgScScCg`（无门控，跑满 150k） | 5 | 3247 / 3713 / 4394 | 2549 / 2979 / 3148 |
| `CgScScCg --no-cutquad` | 5 | 2626 / 2803 / 3350 | 1998 / 2130 / 2243 |

**对照**：裸 `node -e 0` 的 spawn 开销实测 median **325 ms**（同一台机，20 次）。
⇒ **对 L4/L5 这种浅目标，solver 的算法耗时可以忽略，成本全在进程启动。**

**对 diagnose 语义化设计的影响**：真要每轮跑，应该**只跑一次并缓存**（目标形状在 run 内不变），而不是按轮/按诊断条 spawn。

---

### 6. `obs` 的字段与「这条链在造什么」
**结论**：部分成立 —— **实体层面完全没有「在加工什么形状」的信息**。

**证据**：
- L4/L5 的 `entities[]` 字段并集（`test/fixtures/saves/L4-obs.json`）：
  **`uid, type, x, y, r, variant, rotation_variant, code, layer`** —— 就这 9 个。
- 序列化点：`src/mod/shapez-ai-bridge.js:1260-1272` `entityToObs()`，逐字段硬编码，没有矿种/加工物。
- `obs.resources` 是**矿格 → 矿种**的三元组 `[x, y, kind]`（`shapez-ai-bridge.js:1497-1525`），
  能回答「这台矿机脚底下是什么矿」，但**不能**回答「这台 cutter 在切什么」。
- `production` 是 **`Map<shapeShortKey, count>`**（`shapez-ai-bridge.js:605-655`；游戏侧 `history[produced][shapeHash]`，
  见 `recon/bundle.js` `_onItemProduced`）—— **按形状统计，不按链**，无法归因到某条带子。

**对 diagnose 语义化设计的影响**：`obs` 能给出「哪台机器在哪、朝向如何」，但**给不出「这台机器在处理什么形状」**。
所以「这条链是不是本来就该经过 cutter」不能用 obs 判 —— 必须靠「链的几何终点是不是 cutter」这种**结构**判据，
或者靠 §7 的运行时物品数据。

---

### 7. `debug_items.paths[]` 与 `boundAcceptor` 的三种值
**结论**：`boundAcceptor` 的**三种值是 `数组坐标` / `"yes"` / `null`**，但"数组"这一支**几乎永不出现**；
并且 `paths[]` **是游戏自己算的**，不是 mod 拼的 —— 但 mod 在把它序列化时**丢掉了 `.entity`**。

**证据**：
- 序列化（`shapez-ai-bridge.js:1017-1021`）：
  ```js
  boundAcceptor: p.boundAcceptor ? (p.boundAcceptor.entity && p.boundAcceptor.entity.components
      && p.boundAcceptor.entity.components.StaticMapEntity
      ? [ ...origin.x, ...origin.y ] : "yes") : null,
  ```
- **但 `p.boundAcceptor` 是游戏里的一个函数**：`recon/bundle.js:403263`
  `this.boundAcceptor = this.computeAcceptingEntityAndSlot().acceptor`，
  而 `_computeAcceptingEntityAndSlot` 返回 `{entity, acceptor: function}`（`bundle.js:403880-403900`）。
  **函数对象上没有 `.entity` 属性** ⇒ 三目恒走 `"yes"` 分支。
- 实测四个真实 dump 的值分布（全部只有 `null` 与 `"yes"`，**零个数组**）：
  ```
  L5-items.json          {"null":5, "yes":15}
  tmp/di-all.json        {"null":5, "yes":13}
  tmp/di-planA.json      {"null":4, "yes":12}
  .tmpverify/rt/di.json  {"null":5, "yes":13}
  ```
- **三值的语义**：
  | 值 | 含义 | 证据 |
  |---|---|---|
  | `[...]` | 接收方实体 origin 坐标（**理论上的分支，实测从不出现**） | `shapez-ai-bridge.js:1019` |
  | `"yes"` | **有接收方**，但拿不到坐标 | 同上，else 分支 |
  | `null` | **没有接收方**（真死端） | 三目外层 |

- `paths[]` 的结构：`{cells:[[x,y]…], itemsOnPath:n, spacingToFirstItem:s, boundAcceptor}`（`shapez-ai-bridge.js:993-1021`）。
  `cells` 来自 `p.entityPath`（游戏 `BeltPath` 自己的字段，`bundle.js` / `systems/belt.js`），
  `itemsOnPath = p.items.length` —— **是游戏的 BeltPath，不是 mod 拼的**。
  但 mod 做了 `paths.slice(0, 40)` 且 `pathCount` 是**全局**（`shapez-ai-bridge.js:1000-1004`）。

- **另一个必须知道的事实**：L4 的 `debug_items` dump（`research/ai-plan/tmp/di-all.json`，与最接近的 live 快照同源）
  里，**163 条带子有 5 条不在任何 path 里**：
  ```
  underground_belt#10077@(-7,-12), underground_belt#10078@(-7,-14),
  belt#10143@(4,-14), belt#10149@(5,-13), belt#10209@(4,-13)
  ```
  两条是隧道（游戏语义：隧道无 `Belt` 组件，`systems/belt.js` 首行就 return，与 `gates.mjs:1064-1071` 的注释一致）。
  但**另外三条是普通带子**，而且正是 L4 目标区的 B69/B82/B81。
  ⇒ 「不在 paths 里」≠「死端」，它可能只是 `assignedPath` 没重建（`Belt.assignedPath` 不在 schema 里，
  见 `shapez-ai-bridge.js:1581` / `research/ai-plan/AI-ROADMAP.md:86`）。

**对 diagnose 语义化设计的影响**：`acceptorOf()`（`verify_runtime.mjs:320-332`）里那条
「`Array.isArray(p.boundAcceptor)` 优先」的分支**在生产数据上是死代码**，`"yes"` 分支才是常态。
所以「这条链有没有接收方」只能靠**几何外推**（末两格走向）或 obs 邻接 —— 而几何外推在
「带子插进 cutter」时恰好是我们最关心的场景，`verify_runtime.mjs:312-314` 的注释已经点明这一点。

---

### 8. 有没有运行时数据能告诉你「某条带子上现在流的是什么形状」
**结论**：**有，而且很完整** —— `debug_items.belts[]`，但 `loop.mjs` 从来没用过它。

**证据**：
- `shapez-ai-bridge.js:946-991` 逐物品输出：
  ```js
  out.belts.push({ cell:[x,y], path:pi, idx:i, pos:..., spacing_to_next:..., item: key(it) })
  ```
  其中 `key = it.getAsCopyableKey()`（`shapez-ai-bridge.js:910-913`）⇒ **形状 shortKey**。
  物品与格子的映射用「累计距离反算」（`cellAt(dist)`），不是 `items[i] ↔ cells[i]`。
- 机器侧：`out.ejectors.push({cell, slot, item: key(s.item), progress})`（`shapez-ai-bridge.js:928-931`）。
- 实测（`research/ai-plan/tmp/di-all.json`）：
  ```
  belts[]     97 条，item 直方图 {"CuCuCuCu":59,"----CuCu":4,"RuRuRuRu":24,"RuRu----":10}
  ejectors[]  12 条，含 miner@(2,-8) item=RuRuRuRu、balancer@(4,-16) slot1 item=RuRuRuRu
  ```
- **`loop.mjs` 只用 `items.paths`**：`grep -n "belts\|ejectors" src/agent/loop.mjs` → **0 命中**。
  `handles.mjs:406` 的 `货=N` 取自 `path.itemsOnPath`（**整条 path 的物品数**，不是这一格的），
  且 `items=null` 时**全部记 0**（实测 `buildHandles(obs, null)` 的 161 条带子 `货=0` 全命中）。

**对 diagnose 语义化设计的影响**：**这是唯一能直接回答「这条链在造什么」的运行时数据**。
代价是：`belts[]` 只覆盖 `region` 内的格子（`shapez-ai-bridge.js:982` 用 `inR()` 过滤），
而 `loop.mjs:363` 传的是 **`{}`** —— 没有 `region` ⇒ mod 直接抛 `2001 invalid_action`（见文末「补注」节）。

---

### 9. `hubReachable()` 到底怎么算，以及它和 `prompt.mjs` 的 `toHub` 不是一回事
**结论**：**部分成立 —— 现有描述把两个函数混为一谈，且其中一个有真 bug。**

**证据**：

| | `loop.mjs:440 hubReachable` | `prompt.mjs:873 obsWorld().toHub` |
|---|---|---|
| 起点 | hub 实体的**每个输入槽** | 出口格落在 hub **4×4 占地**的带子 |
| 走法 | 从槽格**逐格回退**：`beltEntry` 反推入口格；带子链一直走到非带子实体，然后**继续展开那台机器** | 只走带子：`into.get(cur.x,cur.y)` —— **出口格 → 带子**，**遇到机器就停** |
| 机器 | 会穿过（`hit = c; ... q.push(hit)`，`loop.mjs:470-475`） | **不穿**（`into` 只索引 `view = belts`，`prompt.mjs:860-866`） |
| L4 结果 | **152 实体可达 / 163 条带子里 140 条** | **58 条带子可达 / 105 条不可达** |

- `hubReachable` 的注释（`loop.mjs:428-439`）原文：
  > 为什么要这个过滤器：L4 存档里有 163 条带子，其中大量属于旧产线/装饰性支线。
  > 不过滤时 `OUTPUT_UNROUTED` / `DEAD_END` 会产出十几条与目标形状无关的诊断，
  > 把 prompt 的 S4 段（诊断永不截断）挤满，LLM 只看得到噪音。
  > **这是精度换召回的一次有意识取舍**

- **实测不过滤时的真实数量**（把两处 `if (!reach.has(e.uid)) continue` 打掉，`diagnose` 重跑）：
  ```
  L4 → 5 条：NO_PRODUCTION, SLOT_STARVED:L5, SLOT_STARVED:L6, DEAD_END:B129, DEAD_END:B83
  L5 → 5 条：NO_PRODUCTION, SLOT_STARVED:L5, SLOT_STARVED:L6, DEAD_END:B126, DEAD_END:B80
  ```
  **不是「十几条」，是 2 条死端 + 2 条槽位饥饿。** 注释里的数量估计偏高约 4 倍。
  但方向是对的：那两条 `SLOT_STARVED`（L5/L6 balancer）与 `DEAD_END:(-10,-3)`、`(9,-13)` 确实与目标无关。

- **`toHub` 的 bug**（`prompt.mjs:881-894`）：
  ```js
  const into = new Map();   // "x,y" → 出口落在这里的带子
  for (const b of view) { const [x,y] = exitCell(b); ... into.get(k).push(b); }
  while (frontier.length) {
      const cur = frontier.pop();
      for (const b of into.get(`${cur.x},${cur.y}`) || []) { ... }   // ← 用 cur 的**原点格**
  }
  ```
  它找的是「出口落在我**占的那一格**」的带子，而不是「出口落在我**入口格**」的带子。
  对直带（`entry` 与 `origin` 同格）恰好等价；**对弯带 / 有 footprint 的机器就错**。
  正确写法应是 `into.get(entryCell(cur))`。实测把传播改成「出口 → 入口格」后：
  ```
  58（当前 buggy） → 28（修正后）
  ```
  ⇒ 这个 bug 让它**偏乐观**（58 比 28 多标了 30 条「能到 hub」）。

- **`toHub` 与真值的偏差**（用 `handles.mjs` 自己的 desc 图遍历做独立真值）：
  ```
  L4：163 条带子，真值可达 151，toHub 说可达 58
      FALSE "[not reaching hub]" 标记：94 条
      B63 / B69 / B81 / B64 / B82 / B70 全部被标成 [not reaching hub]，而它们**都到得了 hub**
  ```
  （`B63 → L3 → B56 → B52 → … → B137 → H1`，54 跳，实测打印见 §13 的验证脚本）

**对 diagnose 语义化设计的影响**：
1. **`diagnose` 用的不是 `toHub`，是 `hubReachable`** —— 这两者在 L4 上差 2.6 倍，任何「L4 有 105 条到不了 hub」的推理都建立在错的函数上。
2. `prompt.mjs` 的 BELTS 段 `[not reaching hub]` 标记**有 94 条是错的**（L4），而它正是第八~十二轮实验里「让模型排除 hub 环」的依据。
3. 补注：`hubReachable` 的注释说它「与 `verify.mjs#obsReach` 同向」—— 但 `obsReach` 是**下游方向**（`verify.mjs:186` 的注释写的是「从一台实体出发…能到达的 uid 集合」），
   而 `hubReachable` 是**上游方向**。两者方向相反，「同向」是笔误。

---

### 10. `diagnose()` 对 L4 的实际输出
**结论**：**只有 1 条，且它与「这条链在造什么」完全无关。**

**证据**（`node .tmpverify/fc_diagjson.mjs`，`diagnose(L4obs, null, null, null, "RuRu----", handles)`）：
```json
[
  {
    "code": "NO_PRODUCTION",
    "layer": "L4",
    "severity": "blocker",
    "subject": { "handle": "H1", "type": "hub", "uid": 10000 },
    "expected": "有产线在造 RuRu----",
    "observed": "production 不可用，无法确认任何产线在造目标形状",
    "evidence": { "handles": ["H1"], "uids": [10000], "stage": "initial", "goal": "RuRu----" },
    "candidates": ["connect", "insert_machine", "trash_unused"],
    "hint": "首轮没有 report：这是「目标形状没有产线在造」的初始诊断，不是对某条 check 的复述。"
  }
]
```
- 传入 `production = {window_seconds:60, produced_total:{}}` 时，只有 `observed` 变成
  `"窗口内 RuRu---- 产出 0（delivered 0/70）"`，**仍然只有 1 条**。
- 传入真实的 `items`（L5-items，见 §11）也**不变**：`diagnose` 里 `it` 只用于
  `buildHandles(o, it)`（`loop.mjs:556`），此后**再没被解引用过**（`awk 'NR>=550 && NR<=830 && /it\./'` → 0 命中）。

**对 diagnose 语义化设计的影响**：当前 diagnose 在 L4 上是**结构盲**的 —— 它根本不看带子/机器。
所有「给它接上产线语义」的工作都是从零开始，不是「改一个过滤器」。

---

### 11. `diagnose()` 对 L5 的实际输出
**结论**：与 L4 **逐字同构**，只换目标串。

**证据**（`diagnose(L5obs, L5items, null, null, "Cu----Cu", handles)`）：
```json
[
  {
    "code": "NO_PRODUCTION", "layer": "L4", "severity": "blocker",
    "subject": { "handle": "H1", "type": "hub", "uid": 10000 },
    "expected": "有产线在造 Cu----Cu",
    "observed": "production 不可用，无法确认任何产线在造目标形状",
    "evidence": { "handles": ["H1"], "uids": [10000], "stage": "initial", "goal": "Cu----Cu" },
    "candidates": ["connect", "insert_machine", "trash_unused"],
    "hint": "首轮没有 report：这是「目标形状没有产线在造」的初始诊断，不是对某条 check 的复述。"
  }
]
```
- **L5 已经是被改造过的存档**：`cutter#10902@(4,-13)` + `trash#10901@(4,-14)`（`test/fixtures/saves/L5-obs.json`
  `entities`），而 L4 的同一位置是 3 条带子。diagnose 对这两种截然不同的世界给出**同一条诊断**。
- L5 的 160 条带子里，`hubReachable` 覆盖 133 条；`toHub` 仍报 58 条可达。

**对 diagnose 语义化设计的影响**：这是「语义化」最直接的验收用例 ——
**同一份 diagnose 对「待改造」与「已改造」给出相同输出，说明它没有任何产线语义**。

---

### 12. 现在有没有代码/数据能回答「B63@(4,-15) 到不了 hub 是不是问题」
**结论**：**不成立 —— 因为 B63 到得了 hub。这个问题本身建立在一个假事实之上。**

**证据**（`node .tmpverify/fc_b63h.mjs`，用 `handles.mjs` 自己算的 desc 图）：
```
B63(belt) > L3(balancer) > B56(belt) > B52 > B48 > B44 ... B128 > B137 > H1(hub)
```
54 跳全程连通。`prompt.mjs` 的 BELTS 段却把它标成 `[not reaching hub]`（实测见 §9）。

**真正到不了 hub 的 12 条（L4）**：
```
B65 B83 B85 B92 B99 B129 B138 B142 B146 B150 B154 B158
```
（用同一 desc 图遍历，`node .tmpverify/fc_truth.mjs`）

**「缺的具体是什么信息」**：
不是「缺语义」，是缺**三样具体的计算**：
1. **穿越机器的可达性**：`hubReachable` 已经做了（它穿机器），`prompt.toHub` 没做。这是**已有代码**，不是缺能力。
2. **「那台机器在做什么」**：obs 没有（§6）。要判「这条链本来就该先经过 cutter」只能靠
   **`obs.entities` 里链的终点是不是 `cutter` 类型** —— 这是**类型判断**，不是形状判断。
   L4 里 x=4 链的终点是 `L3 balancer`（不是 cutter），所以「它本来就该先经过 cutter」在 L4 上**不成立**；
   该结论只在 L5 成立（`cutter#10902@(4,-13)` 已经在那儿了）。
3. **「这条链上有没有目标形状的货」**：`debug_items.belts[].item`（§8）有，但 `loop.mjs` 从未请求/使用。

**对 diagnose 语义化设计的影响**：把「B63 到不了 hub」当作设计前提会做出一个**处理不存在问题**的诊断。
L4 该报的是「x=4 链是通的、但没有目标形状的货」；
L5 该报的是「**C1 的右列输出（`CuCu----`）被直接送进 hub，而目标 `Cu----Cu` 还缺一次 `rotateCCW`**」——
后者是当前 diagnose 最该有、却完全没有的那条。两者都需要 §8 的 `belts[].item` 与 cutter 的**槽位—半列映射**
（`facts/GEOMETRY-TABLE.md:15`），而 `belts[]` 现在被 `debug_items({})` 的调用方式挡住了（见文末「补注」）。

---

### 12b. 一条额外的关键事实：`cutHalf` 的槽位语义
**结论**：成立 —— 这是判「正常的断 vs 病态的断」唯一可直接依赖的代数事实。

**证据**：
- `shape-ops.mjs:103`：`cutHalf = shape => [filterQuads(shape,[BL,TL]), filterQuads(shape,[TR,BR])]`
  ⇒ `[0]` = **左列**、`[1]` = **右列**（`shape-ops.mjs:165-169` 的自测逐字断言，且与 `manager.js:92` 同序）。
- `facts/GEOMETRY-TABLE.md:15`：cutter 的 `(0,0) top` 出**左列**、`(1,0) top` 出**右列**（✅ M1b 实机验证）。
- 实测（本机 `shape-ops.mjs`）：`cutHalf(CuCuCuCu)` → `----CuCu` / `CuCu----`；
  `rotateCCW(CuCu----)` → `Cu----Cu`（= L5 目标）。

**对 diagnose 语义化设计的影响**：这让「正常的断」有了**可计算的定义**：
> 若一条链的末端是 cutter，且它的**某一列输出槽**当前没有下游（或接去了 trash），
> 而目标形状的配方里**该半列正是下一步的输入**，那么这条「断」是**正常且必要的**。

反过来，**若某一列输出接去了 trash 而那半列是目标所必需** —— 那是**病态**（L5 正是此例）。

---

### 13. `recipe.mjs` 的 `steps[]` 能不能直接回答这个问题
**结论**：**不能直接回答，而且拿它硬套会答错 —— L5 就是现成的反例。**

**先说不成立的部分**：step 的字段是 `{hash, op, args, depth, inputs, parents, kind}`（`solver.mjs:298-317`），
`hash` 是**形状 shortKey**（如 `RuRu----` / `color:red`），**不是实体**。`recipe.mjs:119-169` 的 `renderRecipe`
只输出形状级别的句子，自测甚至专门断言「渲染结果不含坐标形态」（`recipe.mjs:207`）。
⇒ **steps 里没有世界坐标，也没有实体身份**，它答不了「`B63@(4,-15)` 该怎么办」。

**L4 的推演**（答案是对的，但信息量比看上去少）：
```
solver 对 RuRu----  → steps = [ {hash:"RuRuRuRu",    op:"mine"},
                                 {hash:"RuRu----",   op:"cut", args:{half:"right"}, inputs:["RuRuRuRu"]} ]
```
能告诉你：需要 1 台 miner + 1 台 cutter，不需要 rotater/stacker/painter。
**不能**告诉你：cutter 该放哪、世界里已有什么。
实际世界：`C1#10036@(-8,-11)` 是一台 cutter（在铜线上，下游直达 hub），`M3#10081@(4,-8)` 矿种 `RuRuRuRu`。
⇒ 缺的不是「知道该有哪些工序」，而是「**把工序期望与世界沿链的实际类型序列对齐**」。

**L5 的推演（这里 recipe 直接给出错误答案）**：
```
recipe.mjs 对 Cu----Cu → mine, cutQuad×2, stack      ← 默认参数（cutQuad=L16，当前 L5）
solver --no-cutquad   → mine, cut(left), rotate(cw)  ← 这才是 L5 合法的
```
两者**完全不同**：一个说「2 台 cutter + 1 台 stacker」，另一个说「1 台 cutter + 1 台 rotater」。
而存档现状是 —— `C1#10902@(4,-13)` **已经有 cutter 了**，`T2#10901@(4,-14)` 是 trash：

```
C1 cutter 输入=bottom(←B87) 输出=top:left(→T2 trash) / top:right(→B69)
```
按 GEOMETRY 表（`facts/GEOMETRY-TABLE.md:15`，✅ 实机验证）：
cutter 左列槽出 `cutHalf[0]`，右列槽出 `cutHalf[1]`。实测对 `CuCuCuCu`：
```
左列 = ----CuCu      右列 = CuCu----      目标 = Cu----Cu
右列再 rotateCCW → Cu----Cu   ✅
```
⇒ **L5 真正缺的是 rotater（`rotateCCW`），不是 cutter**；而 `C1` 的右列输出现在**直接进了带子 B69 → hub**，
左列输出进了 trash。**一台把目标形状的右半列当废料扔掉的 cutter，正接在 hub 通路上。**

这个结论 `steps[]` **单独给不出来**（它没有「C1 在哪、它的右列槽接去哪」），
但 `steps[] + obs` **合起来给得出** —— 而且是当前 diagnose 完全没做的事。

**对 diagnose 语义化设计的影响**：
- `steps[]` 只能当「应有工序的**多重集**」，且**必须先按关卡门控**（见 §15 / 前提 C）。
- 真正有诊断价值的判据是「**链的末端机器 + 它的输出槽去向**」，这需要 `obs.entities` + `slotsOf`，
  和 `recipe.mjs` 无关。
- L5 这个例子说明：**「到不了 hub」根本不是判据**（C1 到得了 hub，B69 也到得了），
  真正的病态是「**目标形状的必经中间产物被送进了废料口**」。这条只有同时知道
  「cutter 左/右槽各出哪个半列」+「哪个槽接去了 trash/hub」才能判 —— 前者在 `shape-ops.cutHalf`，
  后者在 `slotsOf` + obs。

---

### 14. 每轮 spawn 一次的代价
**结论**：单独看可接受，**叠加到现有 buildPrompt 上就不可接受了**。

**证据**：
- `buildPrompt` **已经**每次调用都 spawn 一次 solver（`src/agent/loop/prompt.mjs:1182` → `recipeBlock()` → `recipe.mjs:66`）。
  实测 `buildPrompt` 单次 **631–1578 ms**（6 次，含 spawn）。
- 预算：`BUDGET.LLM_CALLS_MAX = 8`（`src/agent/loop/constants.mjs:128`），`ROUNDS_MAX = 3`。
  ⇒ 现有基线已经是**最坏 8 次 spawn / run**。
- 再加 diagnose 的「每轮一次」：`rounds` 最多 3 ⇒ +3 次。但 diagnose 在**每个 observe 之后**调用
  （`loop.mjs:1460`），且内层 LLM 重试环不重新 observe（`loop.mjs:1496-1560` 的注释），**所以是 3 次不是 8 次**。
- 最坏墙钟：加 3 × 0.82 s ≈ **+2.5 s / run**（当前 `WALL_MS_MAX = 15 min`，占比可忽略）。
- **但真正的风险是不可解目标**：`CgScScCg` 这类目标单次 3.3–4.4 s，`--no-cutquad` 也 2.6–3.4 s。
  如果 diagnose 对**任意**目标形状调用（比如从 hub 里猜出来的形状），一次 run 可能到 **+13 s**。

**对 diagnose 语义化设计的影响**：**成本不是瓶颈，但重复调用是浪费**。
目标形状在一个 run 内不变 ⇒ 应当**在 run 开始时算一次并缓存**，而不是按轮 spawn。
现有 `buildPrompt` 每轮重算同一个目标，本身就是一个可修的浪费（8 次里 7 次是重复的）。

---

### 15. solver 的已知错误与限制
**结论**：**注释/README 与实现有 4 处不一致**，其中 2 处会导致消费方误判。

**证据**：

| # | 问题 | 位置 | 性质 |
|---|---|---|---|
| 1 | 注释写 `--depth` 默认 6 / `--max-states` 默认 20000，实际 **7 / 150000** | `solver.mjs:34-35` vs `solver.mjs:450-451` | 文档错误 |
| 2 | CLI 目标解析把「以 `--` 开头且长度 >10」的目标串当 flag 丢掉 | `solver.mjs:430` | **真 bug**（多层目标 `--------:X` 全中） |
| 3 | `stats.expanded` 不含 stack 展开，不能用它估复杂度 | `solver.mjs:193`（只在单输入循环里自增） | 指标误导 |
| 4 | README §2 的性能表把 `CgScScCg`（L11）列为「875ms ✅ 逐步复放通过」，但**没写用了哪个 flag**；实测默认参数（`cutQuad` 开）下 **`solved:false`、`capped:true`、150001 状态**，必须加 `--no-cutquad` 才解得出 | `solver-README.md:140` vs 实测 | 文档未标注前提，易被读成「默认即可解」 |

- README 明确的能力边界（`solver-README.md:319-332`）：
  - 多层**布局** ❌ 未做
  - 颜料**布线** ⚠️ 待 P3/P4
  - 吞吐优化（最少机器数）❌ 未做（只保证「最浅深度」）
  - `--no-cutquad` 「**L<16 必带**」（`solver-README.md:25`）

- **`recipe.mjs` 没有做这个门控**（`recipe.mjs:66` 只传 `goalShape` 与 `--json`）：
  实测 `solveRecipe("Cu----Cu")` 返回 `cutQuad × 2`，而 `Cu----Cu` 是 **level 5**，`cutQuad` 是 **L16** 建筑
  （`src/ai/compiler/compile.mjs:67` `CUTQUAD_MIN_LEVEL = 16`）。
  ⇒ **prompt 的 RECIPE 段会建议模型使用 L5 拿不到的建筑。**
  对照：编译器侧 `solveGoal()` 正确加了门控（`compile.mjs:246-248`），`recipe.mjs` 没有。

**全 11 个官方关卡的实测（`node .tmpverify/fc_levels.mjs`）**：

```
CuCuCuCu    L1   ok=true  ops=mine
----CuCu    L2   ok=true  ops=mine,cut
RuRuRuRu    L3   ok=true  ops=mine
RuRu----    L4   ok=true  ops=mine,cut
Cu----Cu    L5   ok=true  ops=mine,cutQuad,cutQuad,stack  ⚠ 用了 L16 的 cutQuad + L10 的 stack
Cu------    L6   ok=true  ops=mine,cutQuad                ⚠ 用了 L16 的 cutQuad
CrCrCrCr    L7   ok=true  ops=mine,mineColor,paint
RbRb----    L8   ok=true  ops=mine,cut,mineColor,paint
CpCpCpCp    L9   ok=true  ops=mine,mineColor,mineColor,mix,paint
ScScScSc    L10  ok=true  ops=mine,mineColor,mineColor,mix,paint
CgScScCg    L11  ok=false solver exited 2                 ⚠ 默认预算下无解
```

⇒ **11 个目标里 3 个有问题**：L5/L6 拿到超等级配方，L11 直接无解。
`solver --no-cutquad` 对 `Cu----Cu` 的真实合法解是 `mine → cut(left)`（2 步，不需要 rotater/stacker）。

**对 diagnose 语义化设计的影响**：如果 diagnose 复用 `solveRecipe()`，它会拿到**未经等级门控**的工序集。
L4 恰好无害（`RuRu----` 在两种模式下都是 `mine+cut`），但**L5 恰好是当前两个夹具之一**，
它会被推成「需要 cutter×2 + stacker×1」——一个世界造不出来、且与存档现状（已有一台 cutter）对不上的期望。

---

### 补注：一个会挡住 §8/§7 的调用错误

`loop.mjs:363`：
```js
out.items = unwrapItems(await reader.debugItems({}));
```
而 mod 端（`src/mod/shapez-ai-bridge.js:903-906`）：
```js
debugItems(params) {
    const root = this.requireRoot();
    const region = params.region;
    if (!Array.isArray(region) || region.length !== 4) {
        throw this.rpcError(2001, "invalid_action", "region must be [x0,y0,x1,y1]");
    }
```
**`{}` 不含 `region` ⇒ 必然抛错。** 用 mock bridge 复现（`node .tmpverify/fc_di.mjs`）：
```
debugItems({}) THREW: debug_items: invalid_action: region must be [x0,y0,x1,y1]
```
`verify_runtime.mjs:908` 传的是 `{ region }`（正确）；只有 `loop.mjs:363` 传了 `{}`。

**影响**：在真桥上，`loop.mjs` 的 `out.items` 恒为 `null`，随后触发 `ITEMS_UNAVAILABLE`（`loop.mjs:382-387`），
`buildHandles(obs, null)` 于是把 163 条带子的 `货=` 全记 0（实测见 §8）。
`FakeGame.debugItems(p = {})` 不校验 `region`（`src/agent/fake_game.mjs:168-189`），
**所以所有离线测试都不会暴露这个 bug** —— 这正是「mock 全绿、实机全红」的经典形状。

---

## 附：本文用到的复现脚本

全部在 `.tmpverify/`，只读夹具、不连游戏：

| 脚本 | 验证什么 |
|---|---|
| `fc_diagjson.mjs` | §10/§11 的完整 diagnose JSON（L4/L5，有/无 items/production） |
| `fc_bench2.mjs` | §5 的 20 次 solver 计时 |
| `fc_tohub2.mjs` / `fc_mislabel2.mjs` | §9 的 `toHub` bug 与 94 条误标 |
| `fc_b63h.mjs` / `fc_truth.mjs` | §12 的 B63 到 hub 的 54 跳链、真值可达集 |
| `fc_sweep.mjs` | 161 条带子逐条删除的扫描（`DEAD_END` **0 次**触发，见下） |
| `fc_di.mjs` | §补注 的 `debugItems({})` 复现 |
| `fc_recipe_level.mjs` | §15 的 `recipe.mjs` 缺等级门控 |

### 另一个不变量（值得写进设计约束）

对 L4 的 **161 条带子逐条删除**（每次只删一条，重跑完整的 `diagnose`）：
```
codes observed: {"NO_PRODUCTION": 161, "SLOT_STARVED": 2, "DEAD_END": 0}
```
**`DEAD_END` 一次都没触发。** 原因：`DEAD_END` 的判据是「这条带子可达 hub 且出口格为空」，
而 `hubReachable` 的可达性**正是从 hub 沿带子反向走出来的** —— 一条出口为空的带子，
在下游方向上不可能把货送到 hub，也就不可能出现在反向可达集里。
⇒ **在带子链内部，「可达」与「有下游」在拓扑上互斥**（除非中间隔了机器，那时出口不会为空）。

同理，删除 **15 台机器中的任意一台**，`diagnose` 也**只**输出 `NO_PRODUCTION`（`fc_sweep2.mjs`）。
唯一的例外是让 balancer 的两条输入同时空掉（`fc_filter.mjs` 的第二个用例）——
那才触发 `SLOT_STARVED`。

**这是「一律加了 `reach` 过滤之后诊断恒空」的结构性原因之一**，且它与 §12 的「正解链本来就在集合里」是**两个独立的问题**：
- 可达集包含正解链（152/181）⇒ 过滤器不是罪魁；
- 可达集里没有「出口为空」的带子 ⇒ `DEAD_END` 在结构上几乎不可能触发。
