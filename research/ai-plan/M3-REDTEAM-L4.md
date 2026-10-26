# M3 红队审查：这套闸能不能挡住 2026-10-26 的 L4 事故

日期：2026-10-27
审查对象：`src/agent/gates.mjs`（1092 行）+ `src/agent/gates.test.mjs`（360 行，声称 52 条全绿）
审查人：红队 Agent（只读，未改任何源文件；未碰游戏写入）

**结论先行：现有 5 道闸里 4 道对该事故假绿（G-1 / G3 / G4 / G6b）；唯一会红的 G6 在 100 游戏秒后才报，且不定位、不回滚。**
根因不是"判据写错"，是**判据的期望值来自编译器自己**：`gates.mjs` 全文从不读 `intent.blueprint`（只把它原样丢给 paste），也从不读 `rotationVariant` / `inDir` / `outDir`。

---

## 0. 证据与复现

本轮所有数字来自三个可复现脚本（均在 `research/ai-plan/`，离线，不连游戏）：

| 脚本 | 作用 | 结果 |
|---|---|---|
| `redteam-l4.mjs` | 把 L4 事故做成夹具，逐闸实跑 | 见 §1 表 |
| `redteam-mutants.mjs` | 对 `gates.test.mjs` 做变异测试 | **存活 17 / 被杀 9 / 共 26** |
| `redteam-newgate.mjs` | 新闸原型 + 必红/必绿用例 | **13 通过 / 0 失败** |

只读实测量（`status` / `obs` / `debug_items` / `production`，未做任何写操作）：
游戏 1.5.6、tick 97184、speed=regular、181 实体、hub 存 `RuRuRuRu:113184 / ----CuCu:47509`、`pathCount=13`、`delivered_slices` 每片 `RuRuRuRu:12`。
`debug_items` 的 `pathCount` 与 region 无关（用 `[-50,0,-30,20]` 与 `[-60,-60,60,60]` 两次实测，`pathCount` 都是 13、paths 完全相同）——这决定了 G6b 的覆盖判据是**全厂口径**，不是"本线口径"。

---

## 1. 逐闸推演

事故的两个可能形态（后文分开说，两者都实测过）：

- **形态 B（贴后被游戏翻转）**：编译器的 intent / blueprint 完全自洽（`rv=1/rot=90/code=2`，in=left/out=top），游戏贴对；之后邻格触发 `_updateSurroundingBelt` 把拐角重算成直带（`rotation=90, rv=0, code=1`）。证实：`research/ai-plan/live/results/orig-flip.json` 的 9 格矩阵里 **3/3 个 PULL 扰动都把拐角翻成了直带**（`after: {"r":0,"rv":0,"code":1}`），且游戏源码会**同时改写 code**（`recon/bundle.js` 内 `m.rotation=y,r.updateVariants(...),m.code=Object(h.getCodeFromBuildingData)(...)`）。
- **形态 C（编译器自己写错且内部矛盾）**：`intent.entities[]` 里 `rot=90 / rv=0 / code=1`（直带几何），但同一对象的 `inDir="left" / outDir="top"`（拐角语义）。`L4-ATTEMPT-LOG.md:41` 记的就是"intent 里写的是 in=left out=top（rv=1）"但"运行时 r=90"——若贴后逐实体核对全过，则世界里的 code 必须等于 intent 的 code，**即 intent 的几何字段本来就是直带**。

| 闸 | 事故下的结果 | 是否假绿 | 依据（行号） |
|---|---|---|---|
| **G-1 时钟** | **绿** | 是（信息量为 0） | `gates.mjs:202-264` 只读 `debug_loop` 的 `logic_budget_ms / speed / tick_rate / tick`。事故时时钟健康 ⇒ 必绿。它只保证"读数不是假的"，对"图对不对"零信息。 |
| **G3 净空** | **绿** | 是 | `gates.mjs:281-341`。`dry_run` 只回答"格是否被占、会不会销毁、条目数对不对"。桥的 `dry_run` 分支（`shapez-ai-bridge.js:2336-2420`）**完全不看 `rot`/`rv` 的语义**，只看 `getDimensions()+占用`。反向/直带占同一格 ⇒ 必绿。实测：`redteam-l4.mjs` 形态 A/C 都是 `would_apply=13, blocked=0, destroys=0`。 |
| **G4 落地** | 贴完瞬间 **绿**；形态 C 下**永远绿** | 是 | `gates.mjs:360-461`。比较的字段只有 `addByCell` 的 `(x,y) → code` 与 `got.r`（`:413-431`）。**不读 `rotation_variant`（全文 0 次命中）、不读 `inDir/outDir`（0 次命中）**。形态 C 下期望值自身就是直的 ⇒ `code 1==1`、`rot 90==90` ⇒ 绿。 |
| **G6 行为** | **红**（形状 `RuRu----` 为 0） | **否** —— 唯一会红的闸 | `gates.mjs:482-601`。`intent.goal="RuRu----"`（实测 `tmp/live/l4/RuRu----.intent.json`），成品没出来 ⇒ `:536-548` 判"从未出现"或 `:591` 判"低于阈值"，**ok=false**。但：①要等 `settleTicks 7200 + sampleTicks 4800 = 100 游戏秒`（`:989`、`:1021`）；②只诊断不回滚（`:597` hint 原文"只诊断不回滚"）；③不定位，只会说"形状没出现"。 |
| **G6b 连通** | **绿** | 是 | `gates.mjs:615-744`。见 §3。 |

**所以对事故的判定是：4 假绿 + 1 迟红。** 迟红发生在贴完 100 游戏秒之后，此时线已经贴进存档、矿机已经往 hub 里灌粗料（`RuRuRuRu` 2.9/s），而 `runGates` 只在 G4 失败时回滚（`:960-985`），G6 红不会触发任何回滚。

顺带确认"总产量涨了就绿"这个已被证伪的口径确实还存在：把 `goal` 换成粗产物 `RuRuRuRu`，同一份 production 直接绿——

```
G6 · goal=RuRuRuRu（粗产物，2.9/s）→ ok=true
  {"rate":2.9,"threshold":0.4,"baseline_rate":1.2,"must_exceed":1.4}
```

L4 的真实 `intent.goal` 是 `RuRu----`，所以这条在 L4 没触发；但 `gates.mjs` 没有任何机制阻止调用方传错 goal，且 `:536` 的"形状键从未出现"会被当成 **undecidable**（`ok:false` 但 reason 是"无法判定"），诊断方向会指向"goal 字符串格式不符"，而不是"方向反了"——这正是 `M3-FINAL.md:104` 记过的同一个坑。

---

## 2. 重点审查 G4：期望值来源追溯

### 2.1 G4 读 intent 的哪个字段

`gates.mjs:413-431`（原文）：

```js
    const addedByCell = new Map(added.map(e => [`${e.x},${e.y}`, e]));
    const missing = [], wrongCode = [], wrongRot = [];
    for (const ent of intent.entities || []) {
        const wx = a[0] + ent.dx, wy = a[1] + ent.dy;
        const got = addedByCell.get(`${wx},${wy}`);
        if (!got) { missing.push({ cell: [wx, wy], nodeId: ent.nodeId, kind: ent.kind }); continue; }
        if (got.code !== ent.code) {
            wrongCode.push({ cell: [wx, wy], nodeId: ent.nodeId, want: ent.code, got: got.code });
        }
        const wantR = (ent.rot | 0) % 360;
        const gotR = typeof got.r === "number" ? got.r : (got.rotation | 0);
        if (gotR !== wantR) {
            wrongRot.push({ cell: [wx, wy], nodeId: ent.nodeId, kind: ent.kind, want: wantR, got: gotR });
        }
    }
```

读的是 `intent.entities[i]` 的 **`dx / dy / code / rot`** 四个字段。
**不读** `intent.entities[i].rotationVariant`、`inDir`、`outDir`；`ent.kind` 只用于写进 `wrongRot` 的样本里。
`obs` 侧读 `e.x / e.y / e.code / e.r`（`shapez-ai-bridge.js:1135-1138`：`r: sme.rotation`、`rotation_variant`、`code`）。

### 2.2 粘贴用的值和 G4 的期望值是不是同一个来源

**是。两者都是 `intent`，而 `intent.entities` 与 `intent.blueprint` 是同一份 `plan.entities` 编码出来的。**

粘贴：`gates.mjs:945-949`

```js
    const paste = await rpc("act", {
        op: "paste_blueprint", text: intent.blueprint,
        x: intent.anchor[0], y: intent.anchor[1],
```

期望：`gates.mjs:959` → `gateG4(intent, before, after)` → 上面的 `intent.entities`。

而交接件的两个字段同源（`src/ai/compiler/compile.mjs:1563-1564` + `:1793-1804`）：

```js
	const final = { ...em.emit.plan, blueprint: em.emit.blueprint, entities: em.emit.entities, ... };
	// writeHandoff:
	const intent = {
	    blueprint: plan.blueprint,        // ← paste 用的
	    anchor: plan.site.anchor,
	    entities: plan.entities,          // ← G4 用的
```

而 `emit.mjs:393-398` 里 `emitted = ordered.map(e => ({...e, code, dx, dy}))`，`emit.mjs:451-457` 用同一份 `emitted` 的 `code/dx/dy/rot` 调 `encodeBlueprint`。**同一批对象。**

结论（这是本次审查最重要的一句）：

> **G4 的期望值和实际粘贴用的值是同一个来源。因此 G4 只能验"游戏有没有把我要求的东西贴准"，永远验不了"我要求的东西对不对"。**
> 编译器把 `rot` 算错时，`intent.entities[].rot` 与 blueprint 里的 `rot` 一起错，G4 拿错的期望值去比游戏里忠实落地的错值 ⇒ 恒绿。

实测（`redteam-newqueries` 之外的直接验证）：

```
# intent.entities 只有一个 belt：rot=90, rv=1, code=1（自相矛盾）, in=left, out=top
G3: true | G4: true
  {"vanished_uids":0,"added_entities":1,"expected_entities":1,
   "missing_entities":0,"wrong_code":0,"wrong_rot":0}
=> intent 声明 in=left/out=top，运行时是朝向 left 的直带（出口 right），G4 全绿
```

### 2.3 G4 还有两个结构性漏洞（与事故直接相关）

**(a) G4 只采一次快照，且采在翻转之前。**
`gates.mjs:945-959`：paste → `snapshot()` → `gateG4`。中间只有一次网络往返。而 `shapez-ai-bridge.js:2505-2508` 把整批放置包在 `performBulkOperation(performImmutableOperation(placeAll))` 里，`performImmutableOperation` 屏蔽 `systems/belt.js` 的 `updateSurroundingBeltPlacement`（桥的注释原话，`shapez-ai-bridge.js:2461-2466`："没有它，蓝图里显式携带的 rotationVariant 会被'邻居派生'结果覆盖"）。也就是说：**粘贴期不翻，翻发生在之后任何一个邻格变动时。**
`gates.mjs:989-1015` 之后再也没有第二次 G4。`live/results/orig-flip.json` 证明翻转是真实且高概率的（9 格矩阵里 3/3 个 PULL 扰动翻向）。

**(b) G4 不校验"新增实体数"等于"期望实体数"。**
`gates.mjs:409-411` 算出 `added`，但只在 `evidence.added_entities` 里记数（`:410`），从不断言。实测：intent 1 台、after 里多出 1 台无关实体（坐标 (50,50)），G4 仍 `ok=true`。`missing` 只覆盖"蓝图里的没贴到"，不覆盖"贴了蓝图以外的东西"。

---

## 3. 重点审查 G6b：判据的精确描述

### 3.1 判据（原文照抄 + 行号）

`gates.mjs:615-651`：

1. 从 `expectedCells(intent)` 里挑出 **`kind === "belt"`** 的格 → `beltCells: Set<"x,y">`（`:617-622`）。**只取 kind，不看 `rot`/`rv`/`code`/`inDir`/`outDir`**（`expectedCells` 在 `:162` 存了 `rot`，G6b 不读）。
2. 对每条 `items.paths[]`，取 `p.cells` 与本蓝图带子格的**交集**：
   - 交集非空 → 这算"我们的 path"；把交集里的格记进 `covered`（`:638-640`）；
   - 若该 path 的 `boundAcceptor` 为假值 → 记为 `deadEnds`（`:641-648`）。
3. 断言三件事（`gates.mjs:666-742`）：
   - `beltCells.size === 0` → 红（真空绿保护，`:666-679`）；
   - `truncated`（`pathCount > paths.length`）→ red + undecidable（`:713-723`）；
   - `deadEnds.length > 0` → 红（`:725-734`）；
   - `uncovered = beltCells - covered` 非空 → 红（`:735-742`）。

**即：`每个带子格都出现在至少一条 path 上` ∧ `该 path 的 boundAcceptor 非空`。**

### 3.2 能发现"带子方向反了"吗

**只有在"方向反了导致 path 断成两截/断头"时才能。** 它不比较方向——一个格子的 `rv` 从 1（拐角）变成 0（直带），格坐标没变、仍在 path 上，`covered` 不受影响。

**L4 的具体拓扑恰好绕过了它**（`redteam-l4.mjs` 实跑）：

```
G6b-connectivity · 事故拓扑 → ok=true
  {"our_belt_cells":11,"covered_cells":11,"uncovered_cells":0,
   "dead_end_paths":0,"paths_returned":2,"total_path_count":2}
```

因为：
- `(21,-5)` 翻成向东的直带后，它接上了既有工厂那条 82 格绕行，path 一路通到 hub，`boundAcceptor = [-1,0]`（hub 侧）非空 ⇒ 不是死路、也没漏覆盖；
- `(21,-6)` 因为失去上游，退化成**单格 path**，但它的 `boundAcceptor = [21,-7]`（切割机）**非空** ⇒ 也不是死路。

于是两个判据都满足。同一个夹具下健康拓扑也是绿的——**事故与健康无法区分**。

### 3.3 能发现"货流走了错误路径"吗

**不能。** G6b 只做**集合覆盖**，不做**配对**：
- 它不关心某条 path 的**起点**来自哪台机器；
- 它不关心某条 path 的**终点**是不是蓝图指定的下游（只要求"有接收者"）；
- 它不关心两条本该相连的 path 是否被拆成了两条。

而 L4 的核心症状恰恰是"配对错了"：粗料从矿机 → 绕行 → hub，**每一步都有接收者**。

补充一条本轮实测的强证据：`debug_items` 的 `pathCount`/`paths` **与 region 参数无关**（同一个世界里用 `[-50,0,-30,20]` 与 `[-60,-60,60,60]` 两次调用，`pathCount` 都是 13、paths 逐字相同）。所以 `gates.mjs:1005-1012` 费劲按 bbox 算 region 其实只影响 `belts`/`ejectors`（物品视图），**paths 永远是全厂的**。这意味着 G6b 天然无法做"本线"判据——它看到的每条 path 都可能来自隔壁老线。

---

## 4. 新闸设计

### 4.0 为什么要三道而不是一道

事故的两条腿必须分开堵：

- 腿 1：**意图自身错了**（形态 C：`in/out` 文本 vs `rot/rv/code` 几何自相矛盾，或 blueprint 与 entities 不同源）→ 贴前必须判；
- 腿 2：**意图对了、世界被改了**（形态 B：游戏把拐角翻成直带）→ 贴后必须判，而且要判"实际拓扑"而不是"贴得准不准"。

新增三道闸（名字按现有命名续）：

| 闸 | 时机 | oracle | 一句话判据 |
|---|---|---|---|
| **G2' 同源自洽** | 贴前（零写入） | `decodeBlueprint` + `belt-rules` | `intent.entities` 与 `intent.blueprint` 逐格 `(code,rot)` 相等，且每个 belt 的 `code===1+rv`、`(rv,rot)` 反推的 in/out 等于声明的 `inDir/outDir` |
| **G7 逐格流向** | 贴后 t+0 与 t+60s 各一次 | `debug_items.paths[].entityPath` 的**邻接** | 每格的实际前驱/后继方位 == 声明的 `inDir/outDir` |
| **G8 链划分** | 贴后 t+0 与 t+60s 各一次 | 蓝图推导的链 vs 游戏 path | 蓝图推出的每条带子链，必须与游戏里某条 path **逐格同序**；链尾指向的实体必须与蓝图一致 |

G7 抓"某一格方向反了"，G8 抓"整条链路改接到别处"（事故的 82 格绕行）。两者都只看 `debug_items`，不看 `production`，所以**不用等 5 分钟**。

### 4.1 伪代码

```
# ───────── G2'（贴前，零写入） ─────────
function gateIntentMatchesBlueprint(intent):
    bp = decodeBlueprint(intent.blueprint)              # 现有五闸一次都没 decode 过
    assert count(bp.entities) == count(intent.entities)
    for each cell in normalized(bp) ∩ normalized(intent):
        assert bp.code == intent.code  and  bp.rot == intent.rot
        if intent.kind == "belt":
            assert intent.code == 1 + intent.rotationVariant          # belt-rules:59
            (in, out) = (beltEntry(rv, rot), beltExit(rv, rot))       # belt-rules:37-38
            assert in == intent.inDir  and  out == intent.outDir
    # 任何一条不满足 ⇒ 红。paste 的载荷和 G4 的期望从此钉在同一张图上。

# ───────── G7（贴后，t+0 与 t+60s） ─────────
function gateG7flow(intent, items):
    if items.pathCount > len(items.paths): return UNDECIDABLE      # 与 G6b 同口径
    index = map cell -> (pathIdx, idx)                             # entityPath 是上游→下游序
    for each belt cell c with declared inDir/outDir:
        (pi, ci) = index[c]   or  RED("not_on_any_path")
        if ci > 0:  actualIn = dirOf(c, path[ci-1])                # 从本格指向 prev
        else:
            up = blueprint entity at c + DIRV[inDir]
            if up is belt:  RED("disconnected-from-belt")           # 上游带子不在同一 path 的 prev
            if up is machine and up.outDir != OPP[inDir]: RED(...)
        actualOut = dirOf(c, path[ci+1])            if ci < len-1
                  = dirOf(c, path.boundAcceptor)    if ci == len-1 and acceptor
                  = UNVERIFIABLE                     otherwise
        assert actualIn == inDir and actualOut == outDir
    # 关键：not_on_any_path / disconnected 都算红，不 fail-open

# ───────── G8（贴后，t+0 与 t+60s） ─────────
function gateG8chains(intent, items):
    belts = intent entities with kind == "belt"
    assert 每个 belt 都有 inDir/outDir                                 # 缺就是红，不许 fail-open
    # 1) 从蓝图推链：succ(c) = c + DIRV[outDir]；链头 = 链内没有 pred 的格
    expected = for each head: [c, succ(c), succ(succ(c)), ...] while succ ∈ belts
               + chain 尾指向的实体（exitNode/exitCell）
    # 2) 游戏实际链：所有与本蓝图带子格有交集的 path，按 cells 原序
    actual = [p for p in items.paths if p.cells ∩ belts]
    # 3) 逐链比较（顺序敏感）
    assert multiset(expected.map(join)) == multiset(actual.map(join))
    # 不相等 ⇒ 红，并在 reason 里写清：
    #   "期望链尾 <node>@<cell>，游戏却把这条货流接到了 <tail>（boundAcceptor=<...>），链长 11 → 114"
```

### 4.2 必红用例（已全部实跑通过，见 `redteam-newgate.mjs`：13/13）

| # | 用例 | 期望 | 实测 |
|---|---|---|---|
| 1 | **L4 事故回放**：`(21,-5)` 翻成直带 → 主干接上 82 格绕行进 hub，`(21,-6)` 变断头单格（acceptor=cutter） | G7 红、G8 红；对照：G6b **绿** | G7 `4 处不符`（首处 `j0.out want=top got=right`）；G8 `期望链尾 c0@[21,-7]，游戏却把这条货流接到了 [0,0]（boundAcceptor=[-1,0]），链长 11 → 114`；G6b `ok=true` |
| 2 | **形态 C**：intent 与 blueprint 都写成直带（内部完全自洽），世界也是直带，但货到不了切割机 | G2' 绿（它只能验内部一致性）、**G8 仍红** | G2' `ok=true`；G8 `期望链尾 ?@[22,-5]，实际接到 [0,0]` |
| 3 | **意图自相矛盾**：只把 `intent.entities` 里一个拐角的 `rv` 从 2 改成 0（blueprint 仍是拐角） | G2' 红 | `1 格不一致（code-vs-rv: blueprint=3, wantCode=1, rv=0）` |
| 4 | **声明方向被翻转**：只把 `inDir` 取反（`rot/rv/code` 全不动） | G2' 红 | `(rot,rv) 与声明的 inDir/outDir 不自洽（declared in=top, from_rv_rot in=bottom）` |
| 5 | **矿机出口带子反向**：`f0` 从 `in=bottom/out=top` 改成 `in=top/out=bottom` | G7 红 | `f0.in want=top got=disconnected-from-belt（上游 f1 不在本 path 的 prev）` |
| 6 | **paths 被截断**（`pathCount=55`，回 2 条） | 红 + `undecidable` | 三闸一致 |
| — | **必绿对照**：几何自洽的健康线（每格都用 `solveTurn` 求过 `(rot,rv)`） | 三闸全绿 | G2' / G7 / G8 全 `ok=true`（G7 `checked_in=11 checked_out=11`） |
| — | **必绿对照**：真实 L4 交接件 `tmp/live/l4/RuRu----.intent.json` | G2' 绿（证明这一份交接件确实同源，不是被改过的） | `blueprint_count=122 == intent_count=122`，`field_diff=[]`，`direction_inconsistent=[]` |

第 2 条是这套设计里最重要的：**形态 C 下 G2' 会绿、G4 会绿、G6b 会绿，只有 G8 红**，因为它比的是"游戏的链划分"和"蓝图应当产生的链划分"——两个不同来源。

### 4.3 落地成本与新风险（诚实记录）

- **G2'**：纯离线，零成本，可以在 `--plan`（不 `--apply`）阶段跑。风险：真实交接件里 `intent.entities` 的 `dx/dy` 与 blueprint 的 `dx/dy` 差一个平移，必须各自归一（原型已按 `min corner` 归一，真实 L4 交接件验证通过）。
- **G7/G8**：`debug_items` 的 `paths` 是**全厂**的（本轮实测，`pathCount` 与 region 无关），所以必须靠 `blueprint 带子格 ∩ path.cells` 挑"自己的 path"——这和 G6b 现有做法一致，但会引入"隔壁老线恰好经过本格"的串扰。原型用"整条 path 的格子序列"比对来消解（串扰会体现为链划分不等，报红而不是假绿），但**在密集老工厂里可能假红**，需要实机调一次。
- **`entityPath` 的顺序**：原型假设 `cells` 是上游→下游。实机核对（`tmp/gatecheck/items.json` 的 path0 `[-10,3] → [-10,-3]`，配 `(-10,4)` 的矿机、`(-10,3)` 的竖直带）成立；但这只是 1 条 path 的证据，落地前应再用 2~3 条含拐角的 path 核一次（`live/results/orig-flip.json` 的 `pasteAndDiff` 里已有现成夹具）。
- **`debug_items` 在 t+0 是否已有 path**：`_addEntityToPaths` 挂在 `entityAdded` 上、不受 `immutableOperationRunning` 屏蔽（被屏蔽的只有 `_updateSurroundingBelt`），所以理论上有；但未实测。建议 G7/G8 跑两次（paste 后立刻 + settle 后），任何一次红即红，且把两次的 `pathCount` 差异记进 evidence —— **这本身就是翻转检测**。

---

## 5. 现有 52 条测试的质量问题

### 5.1 方法

复制 `src/agent/gates.mjs` 到 `research/ai-plan/.redteam/gates.mut.mjs`，**每次只改一处判据**（把某个 `if` 变恒假、把期望值换成别的字段、把增量集合换成全集……），再跑同一套 `gates.test.mjs`（只改 import 路径）。
**mutant 存活 = 这套测试抓不到这个错 = 该判据在测试里没有 revisit。**

结果：**26 个 mutant 里 17 个存活。** 9 个被杀的反向对照说明套件不是全瞎。

```
存活 17 / 被杀 9 / 共 26
```

（完整清单与逐条原因见 `redteam-mutants.mjs` 输出；下面只列与事故/L4 相关的。）

### 5.2 恒真 / 无效断言

**(1) 「cutter 只有 origin 一条 obs 时也要绿」与「全部到位 → 绿」是同一个夹具。**
`gates.test.mjs:118-124` 的 `goodAfter` 与 `:159-167` 的 `cutterOriginOnly` 去掉注释、空白、变量名后**逐字相同**（已用脚本比对，`identical after normalization: true`）。`M3-FINAL.md:134-139` 把它当作"专门留的回归锁"，实际上它是把同一条断言写了两遍。
变异验证：`G4e-新增集合退化为「after 有东西」`（`added` → `after` 全量）**存活**——因为这批夹具的 `after` 恰好就是 `before + added`。

**(2) 「朝向不符必须红」的夹具，期望值也是 0。**
`gates.test.mjs:30-40` 的共享夹具里，**每一条 `ent` 的 `rot` 和 `rotationVariant` 都是 0**。唯一的朝向反例（`:173-179`）是 `want=0 / got=90` 的 cutter。
于是两个 mutant 存活：
- `G4a-期望 rot 恒 0`（把 `wantR = ent.rot` 改成 `wantR = 0`）→ **52/52 全绿**；
- `G4b-期望 rot 取 rv`（改成 `wantR = ent.rotationVariant`）→ **52/52 全绿**。

也就是说：**"G4 会读 `intent.rot`"这件事，测试从来没有证明过。**

**(3) 「朝向只查 cutter」和「朝向跳过 belt」都存活。**
`G4c`（`ent.kind === "cutter" && gotR !== wantR`）与 `G4d`（`ent.kind !== "belt" && ...`）都是 **52/52 绿**。
L4 的反向发生在 **belt** 上，而套件里唯一的朝向反例是 cutter —— **回归锁锁错了实体类型**。`gates.mjs:422-425` 的注释甚至写着"这正是 A2（方向反了）的形态"，但夹具里 A2 的那个实体是 cutter，不是 belt。

**(4) 「boundAcceptor 缺失（undefined）→ 红（不许 fail-open）」是假锁。**
`gates.test.mjs:276-282` 的夹具：
```js
const undefAcceptor = { paths: [{ cells: [[10, 11]], itemsOnPath: 0 }] };
```
而共享 intent 有 **2 格**带子（`:30-40` 的 `b0@(10,11)` 与 `b1@(11,11)`）。这条 path 只覆盖 1 格。
即便把 `if (!p.boundAcceptor)` 改成 `if (p.boundAcceptor === null)`（即真正 fail-open），它**仍然红**——红在 `uncovered`（`gates.mjs:735`），不是 dead-end：

```
MUTANT (=== null), test fixture  → ok=false, reason="1 格带子没出现在任何路径上", dead_ends=0
MUTANT (=== null), 全覆盖夹具    → ok=true   ← 真正的 fail-open
```

`G6b-b` mutant **存活**。这条"回归锁"从写下的那天起就没有测到它声称的判据。

### 5.3 看起来覆盖了、实际没覆盖

**(5) 主流程 `runGates` 零覆盖 —— 三条 mutant 全存活。**
`gates.test.mjs:16` 只 import 了 6 个纯函数，**没有一条测试调用 `runGates`**。于是：
- `FLOW-a`（把 `gateG4(intent, before, after)` 改成 `(intent, after, before)`）→ 52/52 绿；
- `FLOW-b`（把 `gateG6(intent, baselineProd, prod2, …)` 的基线与采样对调）→ 52/52 绿；
- `FLOW-c`（把 `debug_items` 的 region 从 bbox 改回写死的 `[-80,-80,80,80]`）→ 52/52 绿。

`FLOW-c` 尤其刺眼：这是 **M3-ROUND3.md 第 7 条明确修过的 bug**，修完没有留任何回归锁。M3-ROUND3.md:174-178 自己写下的结论（"真正失效的地方在主流程怎么调这些函数"），第二轮总结里自己写下的教训，在第三轮的测试里没有落实。

**(6) G3 的三条判据里两条零覆盖。**
- `G3a-自叠不报`（关掉 `gates.mjs:296`）→ 存活。测试只在 `expectedCells` 层验证了 `collisions` 非空（`:73-75`），**没有一条测试调用 `gateG3` 传一份自叠蓝图**。
- `G3b-未知 code 不报`（关掉 `gates.mjs:309`）→ 存活。52 条里没有任何一条构造 `unknown_code`。

**(7) G6 的绝对阈值分支不可达。**
`G6a`（关掉 `gates.mjs:591` 的 `after.rate < target`）→ 存活。原因：所有夹具的 `p1` 都带 6 片（`:304-310`、`:318`、`:325`、`:340`），`baselineRate` **永不为 null**，所以 `gates.mjs:575-589` 的基线分支永远先返回，`:591` 是死代码。
真实调用路径里 `baselineProd` 可能是 `null`（`gates.mjs:916` 的 `catch`），那时才会走 `:591`——**这条路径零测试**。

**(8) G6 的"排除最后一片"不可见。**
`G6c`（`slice(0, n-1)` → `slice(0)`）→ 存活。夹具的 `mkSlices` **每片计数都相同**（`:304-308`），所以排不排最后一片，平均值一模一样。M3-ROUND3.md 第 2 条花了整节讲"时间片轮转/放大"，测试却用了一个对这个 bug 完全不敏感的夹具。

**(9) `expectedRateOf` 零覆盖。**
`G6e`（去掉 `INPUT_FACTOR` 二进一折算，`gates.mjs:859/889`）→ 存活。这个函数**没有 export**，也没有任何测试间接打过，而它是 G6 的阈值来源。M3-FINAL.md:83 把它列为"高"严重度的已修 bug，但没有任何锁。

**(10) 几何断言只数个数，不查坐标。**
`GEO-180/270 不向负方向长`（`gates.mjs:124-125` 改成 `dx0=dy0=0`）→ 存活。
`gates.test.mjs:43-48` 只断言 `entityCells(...).length`，而 180/270 只改坐标不改条数。`gates.mjs:111-116` 注释写着"这一点实测核对过"，但测试不锁坐标。
这也意味着 **M3-ROUND3.md 第 1 条那个"修了个寂寞"的 bug（`ox=-1` 时跳错格）如果复现，这套测试抓不到**——它只会在 `blocked` 的格数上体现，而套件不测 `blocked` 的具体格。

**(11) `before.truncated` 分支零覆盖。**
`G4h`（关掉 `gates.mjs:378`）→ 存活。套件只测了 `after.truncated`（`:186-195`），贴前截断那条分支（`:378-385`）无人问津。

**(12) 另有 4 条基于"52 条"的观测**
- 套件里 `ok()/eq()` 共 53 处调用点（`grep -o` 得 55 次，含 2 处函数定义），实际执行 52 条。这个数字本身没问题，但 `M3-FINAL.md:151` 写"49 条"、`M3-ROUND3.md:123` 写"50 条"、现在 52 —— **文档里的数字和实际不同步**，说明"全绿"这个结论被引用时没人复跑。
- `G3c`（`!==` 改成 `<`）**被杀**，但杀死它的是 `gates.test.mjs:103` 那条"若把 would_apply 当格数（5）→ 红"的断言——它名义上测的是单位口径，实际顺手挡住了"多贴"的方向。属于偶然有效。
- `gateG3` 把 `dryRun.would_delete` 记录下来（`gates.mjs:288`）却**从不断言**。实测：`destroys=[]` 但 `would_delete=7` 时 G3 绿。真实桥里两者同源（`shapez-ai-bridge.js:2403/2417`：`wouldDeleteUids = new Set(destroys.map(...))`），所以只在伪造输入时暴露；但一个闸把字段读进 evidence 却不判，读 evidence 的人会以为它判了。
- `gateG4` 的 `evidence.expected_entities` 与 `added_entities` 都记录了，也不做相等断言（见 §2.3b）。

---

## 6. 直接回答任务里的四个问题

**Q1 逐闸结果：** 见 §1 表。G-1/G3/G4/G6b 假绿，G6 迟红。

**Q2 G4 的期望值来源：** `intent.entities[]`（`gates.mjs:415`），与 paste 用的 `intent.blueprint`（`:946`）同源于 `plan.entities`（`compile.mjs:1563-1564`、`:1793-1804`；注：工作区行号，该文件在本轮审查期间被其他人改过，HEAD 版本对应行少 23 行）。**是的，是同一个来源。G4 只能验"贴得准不准"，验不了"贴得对不对"。** 且 G4 不读 `rotationVariant`、不读 `inDir/outDir`，只在 paste 后采一次快照——因此它同时漏掉两种形态（编译器自错 / 贴后被翻）。

**Q3 G6b 判据：** `每个 belt 格都出现在某条 path 上 ∧ 该 path 的 boundAcceptor 非空`（`gates.mjs:637-651` + `:725-742`）。不比较方向，只做集合覆盖，不关心 path 的起点/终点是谁。事故里 `(21,-5)` 翻成直带后接上 82 格绕行、`(21,-6)` 变成有 acceptor 的单格 path——两条判据都满足 ⇒ 绿。

**Q4 新闸核心判据一句话：**
> **把"蓝图推导出的带子链划分"与"游戏运行时 `beltPaths` 的链划分"逐格同序比对（G8），并逐格比较实际前驱/后继方位与声明的 `inDir/outDir`（G7）；再用 `decodeBlueprint` 断言 paste 的载荷与 G4 的期望是同一张图（G2'）。三者都只读 `debug_items` / blueprint，贴完立刻可判。**

---

## 7. 附：本轮创建的文件（均未修改任何源文件）

- `research/ai-plan/redteam-l4.mjs` — L4 事故夹具，逐闸实跑
- `research/ai-plan/redteam-mutants.mjs` — 26 个 mutant 的变异测试
- `research/ai-plan/redteam-newgate.mjs` — G2'/G7/G8 原型 + 13 条必红/必绿用例
- `research/ai-plan/.redteam/` — 变异测试的临时副本（`gates.base.mjs` / `gates.mut*.mjs` / `test.mut.mjs`），可删
