# 宏技能库 ABI 契约（A0）

日期 2026-10-28　状态：**冻结 v1**，供 A1 / A2 / A3 / A4 / A6 / A8 开工
实现：`src/agent/macros/contract.mjs`（类型 + 校验 + 规格，**无实现**）
上游裁决：`DIRECTION-FINAL.md` §3 阶段 0/1

> 本文件是**接口真值**。`contract.mjs` 是本文件的机器可读版；两者冲突时以 `contract.mjs` 为准
> （因为它能跑测试），但要改契约必须两边一起改并说明理由。
> 判据：`node --check src/agent/macros/contract.mjs && node src/agent/macros/contract.mjs`

---

## 0. 一句话定位与三条不可谈判的约束

LLM **是改稿人，不是设计者，也不是算数的人**（DIRECTION-FINAL 开篇）。

所以本契约的第一目标不是「让 LLM 能表达更多」，而是**让 LLM 无法表达错的调用**：

1. **公开参数里不出现算出来的坐标**（路径格、转角、rv、槽位格、footprint 展开格、hub 入口格）。
2. **不出现语义重叠的两个参数**（`r` vs `rotationVariant` 的教训：`place{r:90}` 实机得到过 code=1 直带）。
3. **失败必须是结构化的**，且**不允许「成功但有错位」**（`ok=true` 时 `first_mismatch` 必为 `null`）。

---

## 1. 坐标三分法 —— 本契约最重要的一条

### 1.1 四类参数

| 类 | 定义 | 值从哪来 | 每调用上界 |
|---|---|---|---|
| `endpoint` 端点 | 指名一个**已经存在**的东西（实体 + 槽位） | `obs.entities[].uid`（首选）/ `.x,y`（次选） / 上一宏返回值 | 2 |
| `site` 落点 | 本次要在哪里**新放**一样东西 | obs 的既有实体格（即替换它）或上一宏返回值 | 1 |
| `choice` 离散选择 | 不影响位置、只影响"怎么做"（`facing` / `dir` / `len` / `prefer` / `port`） | 调用方的**意图**，是方位词/整数，不是坐标 | 任意 |
| `computed` 算坐标 | 值取决于世界几何（路径格、转角、rv、槽位格、footprint 展开、旋转 origin、hub 入口格、距离） | — | **0（禁止出现）** |

### 1.2 划线：什么算"端点"，什么算"算坐标"

**判据（一句可机器检查的话）：把一个参数改动 1 格，是在改变"要动哪条东西"，还是在改变"这条东西怎么走"？**

- 改变"要动哪条东西" → `endpoint` / `site`。例：`connect(from,to)` 的 `from`/`to`。
- 改变"这条东西怎么走" → `choice`（意图）或 `computed`（几何）。
- 再加一条**决定性区分**：**合法值取决于世界吗？**
  - `len=4` 不取决于世界（4 就是 4）→ `choice`。
  - `dir="top"` 不取决于世界 → `choice`。
  - `at=[4,-13]` 取决于世界（那格必须真有带子/空）→ `site`。
  - `rv=2`、`path[3]`、`hubEntryCell` 取决于世界 → `computed`，**禁止**。

**"端点"为什么可以是坐标：**

`connect(from, to)` 的 `from`/`to` 是 `[x,y]`，看起来像坐标。但它是**引用**，不是**目的地**：

- 它不是"把带子铺到这里"，而是"从这里那个**已经存在的**东西开始"。
- 宏对它**不做算术**：`from=[4,-13]` 直接解析成 uid 10209 那个实体，不展开、不偏移、不旋转。
- 它必须能在 `obs.entities[]` 里逐字查到。查不到就是 `endpoint_not_found`，**不回退到"最近的东西"**。

反例（**禁止**）：`connect(from, to, path)`、`connect(from, to, waypoints)`、`place{x,y,r}`、
`insert_machine(at, r)`、`connect(from, to, rotationVariant)`。
这四者的共同点：调用方必须先在脑子里跑一遍几何 —— 那正是 43 实体事故（13 个朝向全反）的成因。

### 1.3 为什么 `at` 是 `site` 而不是 `computed`

`insert_machine(at, ...)` 的 `at` 是**唯一**的落点参数，上界 1。它必须是：
- `[x,y]` = 机器 origin（来自 obs 的 `entities[].x/y`，或上一宏返回值），或
- `{cell:[x,y]}` = 机器要占的其中一格（通常是那条带子），宏反解 origin。

**为什么拆成两种形状**：游戏里 `place{x,y,r}` 的 x/y 就是 `origin`；而 `getTileSpaceBounds()`
（`static_map_entity.js:127-141`）在 r=180/270 时让**可见 bbox** 向负方向长，origin 本身不动。
所以「机器占的任意一格」在 r≠0 时可能对应 1~2 个 origin。v1 **不猜**：形状不同，语义不同，
两种形态不得混用。多解 → `ambiguous_site` 并列出候选。

---

## 2. 六个宏的 ABI

统一返回形状见 §3。所有宏的 `opts.dry_run` 都表示「只算不写」，返回同样的信封。

---

### 2.1 `connect(from, to, opts?)`

从 `from` 的 ejector 连一条带到 `to` 的 acceptor。**路径、转角、每格 `(rotation, rotationVariant)`、
失败时的 rip-up，全部在内部完成。**

```jsonc
{
  "op": "connect",
  "from": { "uid": 10001, "port": "out" },       // 或 { "cell": [-10, 4] }
  "to":   { "hub": { "entry": 7 } },             // 或 { "uid": 10042, "port": "left" }
  "opts": { "prefer": "fewest_turns", "allow_replace": false, "max_cells": 2000 }
}
```

| 参数 | 类型 | 必填 | 类 | 说明 |
|---|---|---|---|---|
| `from` | `Endpoint` | ✔ | endpoint | 源端口。`port` 缺省 `"auto"`（仅该实体恰好 1 个 ejector 时合法） |
| `to` | `Endpoint` | ✔ | endpoint | 宿端口。**必须指向已存在实体**；要到空地请先放宿 |
| `opts.rebind` | bool | | | 源端口已被别的接收方占用时是否允许改接（会让旧支路饿死）。默认 `false` |
| `opts.allow_replace` | bool | | | 是否允许覆盖路径上的既有带子（**只覆盖带子，永不覆盖机器**）。默认 `false` |
| `opts.max_cells` | int 1..5000 | | | 路径格数上限，默认 2000。超了说明不是「连一条线」 |
| `opts.prefer` | `shortest`\|`fewest_turns`\|`reuse_existing` | | | 默认 `fewest_turns` |
| `opts.dry_run` | bool | | | 只算不写 |

**Endpoint 形状**（其余五个宏共用）：
```jsonc
{ "uid": 10001, "port": "out" }              // 首选：直接指名
{ "cell": [4, -13], "port": "primary" }      // 次选：实体 origin 格
{ "hub": { "uid": 10000, "entry": 7 } }      // hub：入口索引用 0..15
// port 允许： "auto" | 角色名 "out"|"left"|"right"|"primary"|"lower"|"upper"|"quad0".."quad3"
//            | { "role": "primary", "index": 2 }  | { "entry": 0..15 }（仅 hub）
```
`uid` / `cell` / `hub` **三选一**，多给/不给都是错（不猜，与 `place` 的 rv/orig 别名冲突同族）。
`{entry:n}` 是**索引**不是坐标：把「选哪个 hub 口」降成 0..15 的离散选择，正是 pin assignment 该在宏里做的事。

**前置条件**（违反即失败，运行期必查）：
- `from`/`to` 能在**当前 obs** 解析到唯一实体（uid 优先；`cell` 必须是该实体 origin）。
- `from` 的端口是 ejector；`to` 的端口是 acceptor。
- `from.port` 当前**没有** bound acceptor（已有则需 `rebind=true`，否则 `port_already_bound`）。
- `to.port` 当前**没有**供料方（否则 `target_already_fed`）。
- 路径首格 = `from` 出口格，末格 = `to` 入口格的前一格；两端方向必须与既有实体朝向一致
  （**宏不得为接线而改动机器朝向**）。
- 路径经过的格：空 → 可用；带子 → 仅 `allow_replace=true` 可覆盖并计入 `cost`；机器/hub → `occupied`（整单失败）。
- 路径格数 ≤ `opts.max_cells`。
- mod 支持 `tx` —— 否则 `tx_unavailable`（不做半成）。
- v1 不支持隧道穿越；需要跨线时返回 `no_path`，并在 `error.detail` 里给出被挡的走廊，**而不是偷偷用隧道**。

**何时不该用**（poka-yoke，接口自己劝退）：
1. **宿不存在时**：`connect` 不接受「连到某个空格」。先放宿（机器 / trash / hub）。
2. **要新建一整条产线**（矿机→工序→hub）：那是 `build_line`，会一次规划矿位与工序。
3. **想把一条带的侧面「接进」另一条直线带**：带子只接收同向货流（`BELT-TOPOLOGY-RULES` 规则 1），
   侧向汇入必须让下游带子转向。`connect` 会以 `no_path` / `occupied` 拒绝，**不硬接**。
4. **源端口已经有接收方**（除非你**就是要**抢过来并接受旧支路断流 → 显式 `rebind=true`）。
5. **两台机器紧贴、槽位本来就对齐**（0 格连接）：先 `insert_machine`，再看 `wiring` 即可。

**返回**：`MacroResult` + `{path:[...], turns:int, cost:int, chosen_port:{from,to}}`

**内部调的底层 op**：`obs` → `debug_items`（boundAcceptor 判定）→ 路径规划（Z 形快路径 →
`dijkstraOriented` 放宽）→ 逐格 `place` 或整段 `paste_blueprint`（带显式 rv）→ 读回自证 → 失败即 `tx` 回滚。
**拐角禁止依赖 `place` 猜 rv**（见 §5 假设 B）。

---

### 2.2 `insert_machine(at, facing, machine, opts?)`

放一台机器并朝向 `facing`。footprint 展开、rotation、旋转 origin、槽位世界格全部内部算。

```jsonc
{ "op": "insert_machine",
  "at": [4, -13],                          // 机器 origin（或 { "cell": [4, -13] } 让宏反解）
  "facing": "top",                         // primary output 的**世界喷射方向**
  "machine": { "kind": "cutter", "variant": "default" } }
```

| 参数 | 类型 | 必填 | 类 | 说明 |
|---|---|---|---|---|
| `at` | `[x,y]` \| `{cell:[x,y],part:"any"}` | ✔ | site | 见 §1.3。两种形态语义不同，不混用 |
| `facing` | `top`\|`right`\|`bottom`\|`left` | | choice | **primary output 的世界喷射方向**。旋转不变以外的机器必填 |
| `machine` | `string` \| `{kind,variant}` | ✔ | | 如 `"cutter"` / `{kind:"painter",variant:"mirrored"}` |
| `opts.replace_belts` | bool | | | footprint 内带子是否让位，默认 `true`。机器永不让位 |
| `opts.dry_run` | bool | | | 只算不写 |

**`facing` 的定义写死在这里**（最容易误用）：它是**机器 primary output 喷射的世界方向**。
不是 `place.r`、不是角度、不是输入来向、不是 `rotationVariant`。

- `cutter` 的 primary output 局部在 `top` ⇒ `facing:"top"` 时 `r=0`。
- `painter(default)` 的 primary output 局部在 `right` ⇒ `facing:"right"` 时 `r=0`。

两者 `r` 都是 0 但世界流向不同 —— 这就是「`facing` 不是 `r`」的证明，也是本契约拒绝
`insert_machine(at, r)` 的原因。

**前置条件**：
- `at` 的格必须是 obs 里真实存在的格（带子 / 空 / 上一宏返回值），**不接受凭空算出来的格**。
- `{cell}` 形态下按 `machine+facing` 的 footprint 反解 origin：恰好 1 个 → 采用；>1 → `ambiguous_site` + 候选列表。
- `facing` 缺失且机器四向几何不同（cutter/painter/mixer/stacker/rotater/miner）→ `ambiguous_site`。
  只有 `ROTATABLE=false`（trash/hub）或几何四向等价时才允许省略。
- footprint（按 rotation 展开、按 `getTileSpaceBounds` 的 origin 语义）内每格必须是 空 / 带子（且 `replace_belts=true`）。
- footprint 覆盖任何机器或 hub → `blocked_by_machine`（整单失败，**绝不删机器**）。
- 机器必须在该存档已解锁（查 `op-templates` 的 `unlockLevel`）→ 否则 `precondition_failed`。
- footprint 内的带子必须能被 serialize 快照（`tx`），否则 `tx_unavailable`。

**何时不该用**：
1. **周围没有带子/机器可接**：孤立机器不产不耗，只是占格。新建整条线用 `build_line`。
2. **目标是 trash**（4 边全收、方向无意义）：用 `trash_unused`，它会检查 outlet 是否真的没去处。
3. **想「换一台机器」**：`insert_machine` 不搬机器（uid 会变）。删旧放新必须走显式计划（`removes[]` + `tx`）。
4. **想调整既有机器朝向**：那是删除+重放，会丢运行期状态；朝向错应由 `connect` 的 `no_path` 或 G7/G8 报出来。
5. **需要规划机器周围所有接线**：本宏只保证机器本身与它**已被带子覆盖**的旧拓扑兼容；周围接线用 `connect`。

**返回**：`MacroResult` + `{origin, rotation, cells, removed_uids, wiring:[{slot,cell,dir,status}]}`，
`wiring.status ∈ ok|nothing|mismatch`。`facing` 反解出 r≠0 时，**必须**读回实际槽位邻接并写进 `wiring`；
任一 `mismatch` ⇒ `ok=false`（不静默接受「大概能用」）。

**内部调用的底层 op**：`obs` → `op-templates`（槽位/footprint/ROTATABLE 真值）→ `delete{uid}`（A1）→
`place` → 读回自证 → `tx`（A1）。

---

### 2.3 `remove_run(uids | cells, opts?)`

删掉一段带子。**uid 优先**：`cells` 只是拿不到 uid 时的次选，且必须逐格命中带子。

```jsonc
{ "op": "remove_run", "uids": [10209, 10149, 10143] }
{ "op": "remove_run", "cells": [[4,-13],[5,-13],[4,-14]], "opts": { "allow_scattered": false } }
```

| 参数 | 类型 | 必填 | 类 | 说明 |
|---|---|---|---|---|
| `uids` | `int[]` | 二选一 | endpoint | 要删的带子 uid（来自 obs） |
| `cells` | `[x,y][]` | 二选一 | endpoint | 要删的带子 origin 格（来自 obs），必须逐格命中带子 |
| `opts.allow_scattered` | bool | | | 允许删不连通的多段。默认 `false`（不连通通常是选集错） |
| `opts.dry_run` | bool | | | 只报告不执行 |

**前置条件**：
- 每个 uid/cell 都解析到一个**带子**（belt / underground_belt）。任何一格解析到机器/hub → `not_a_run`，**整单拒绝**。
- 选集在 4-邻接下连通（除非 `allow_scattered=true`）。
- 每条带子都能被 serialize 快照（`tx`），否则 `tx_unavailable` —— **不可恢复的删除一律不做**。
- 必须报告 `affected`：哪些既有机器输出因此变成无去处（`orphaned_outputs`）、哪些带上的物品被丢弃
  （`stranded_items`）。这两项**不阻止**执行，但必须如实出现。

**何时不该用**：
1. **目的是给机器让位**：`insert_machine` 自己处理 footprint 内带子并保持原子性；拆两步会在中间态留下断线。
2. **要清一大片区域**：用 `bulk_delete`（带 `dry_run` 看 `items` 清单），`remove_run` 只用于**指名**的一段。
3. **不确定某格是什么**：先 obs。cells 解析到机器会整单拒绝 —— 这是设计（宁可失败，不可误删）。

**返回**：`MacroResult` + `{removed_uids, removed_cells, stranded_items, orphaned_outputs:[{uid,port,cell,dir}]}`

**内部调用的底层 op**：`obs` → `debug_items`（在途物品/settled）→ `delete{uid}`（A1）→ `tx`（A1）。

---

### 2.4 `extend_line(from, len, dir?)`

从一段带子的**末端**（或机器输出口）沿 `dir` 再接 `len` 格。首格位置由 `from` 的出口算。

```jsonc
{ "op": "extend_line", "from": { "uid": 10209 }, "len": 4, "dir": "top" }
```

| 参数 | 类型 | 必填 | 类 | 说明 |
|---|---|---|---|---|
| `from` | `Endpoint` | ✔ | endpoint | 既有带子末端，或机器输出口 |
| `len` | int 1..500 | ✔ | choice | 新增格数（不含 `from` 自身） |
| `dir` | Face | | choice | 世界方向；缺省沿用 `from` 当前出口（直行）。给不同方向 = 一个 90° 转弯 |
| `opts.dry_run` | bool | | | 只算不写 |

**前置条件**：
- `from` 解析到唯一实体；若是带子，它必须是**末端**（`boundAcceptor === null`）。
- `from` 若是机器，必须是输出槽且该槽当前无接收方。
- `dir` 与 `from` 当前出口夹角 ∈ {0°, 90°}；180° 掉头 → `precondition_failed`（带子做不到同格掉头）。
- 路径上 `len` 格必须全空（**不提供 `allow_replace`** —— 需要覆盖就用 `connect` 或 `replace_run`）。
- `len` ≤ 与最近障碍的距离；否则 `occupied` 并给出首个被挡格。

**何时不该用**：
1. **目标是一个具体的东西**：`extend_line` 只保证「延长了」，不保证「接上了」。要接到某处用 `connect`。
2. **需要拐两个弯**：一次只允许一个 90° 转向；多段请分多次调用（每次 `from` = 上次返回的 `terminal`）。
3. **为绕过障碍**：那是布线，用 `connect`。

**返回**：`MacroResult` + `{added_uids, cells, terminal:{cell,exit}, terminal_orphaned}`
`terminal_orphaned=true` **必须**出现在返回值里 —— 不许静默留下死端。

**内部调用的底层 op**：`obs` → `debug_items` → 路径格逐格 `place`（或 `paste_blueprint` 带 rv）→ `tx`（A1）。

---

### 2.5 `replace_run(region, building, opts?)`

把 `region` 内的带子**原位换成另一种建筑**，保持每格 entry/exit 拓扑。**本版仅支持 `building="belt"`。**

```jsonc
{ "op": "replace_run", "region": [3,-14,5,-12], "building": "belt" }
```

| 参数 | 类型 | 必填 | 类 | 说明 |
|---|---|---|---|---|
| `region` | `[x0,y0,x1,y1]` | ✔ | endpoint | 闭区间包围盒。逐格校验：**全部**必须是带子 |
| `building` | `string`\|`{kind,variant}` | ✔ | | 本版只接受 `"belt"` |
| `opts.dry_run` | bool | | | 只报告不执行 |

**为什么本版只支持 belt**：它的真实用途是**修复被游戏重算坏的 rv**（`_updateSurroundingBelt` 反复翻带）。
换成隧道需要 sender/receiver 成对建模（v1 范围外），换成机器要展开 footprint（那是 `insert_machine`）。
传了就明确报 `unsupported_building`，**不静默降级**（静默降级正是 paste 静默覆盖旧带那次事故的形态）。

**前置条件**：
- `region` 内**每一格**都是带子（belt / underground_belt）；含机器/hub/空格 → `not_a_run` 或 `precondition_failed`，
  并列出前 5 个反例。
- **`region` 内带子数必须 === region 面积**；不等说明框选偏了
  （PROTOCOL §5 记录过一次误删 42 个真实实体）。
- 目标 `building` 在支持矩阵内（只有 belt）。
- 替换会销毁旧 uid 并产生新 uid —— 必须有 `tx` 与快照，否则 `tx_unavailable`。

**何时不该用**：
1. **想删除带子**：用 `remove_run`（replace 不减少实体数，用错会留下「换了个 uid 的同样的带子」）。
2. **想把带子换成机器**：用 `insert_machine`（replace 保持 1×1 拓扑，不展开 footprint）。
3. **想铺隧道**：v1 明确不支持，会报 `unsupported_building`。
4. **`region` 框不准**：先 `bulk_delete dry_run` 看 items，或用 `remove_run(uids)` 精确指名。

**返回**：`MacroResult` + `{replaced_uids, removed_uids, added_uids, mismatched:[{cell,field,requested,actual}]}`

**内部调用的底层 op**：`obs` → `belt-rules.solveTurn` → `delete{uid}` → `place`/`paste_blueprint` → `tx`（A1）。

---

### 2.6 `trash_unused(outlet, opts?)`

给一个**没有去处**的输出槽接垃圾桶：在 `outlet` 的喷射方向落一格 `trash`（1×1，四边全收）。

```jsonc
{ "op": "trash_unused", "outlet": { "uid": 10206, "port": "left" }, "opts": { "confirm_waste": true } }
```

| 参数 | 类型 | 必填 | 类 | 说明 |
|---|---|---|---|---|
| `outlet` | `Endpoint` | ✔ | endpoint | 输出端口。单输出实体可 `port:"auto"`；多输出（cutter 2 / quad 4）**必须点名** |
| `opts.confirm_waste` | bool | | | 该端口不在模板 `wasteRoles` 里时，必须显式确认「这一路确实是废料」。默认 `false` → 拒绝 |
| `opts.replace_belt` | bool | | | 喷口下一格若是带子是否让位。默认 `false` |
| `opts.dry_run` | bool | | | 只报告不执行 |

**为什么 `port` 被收紧**：切割机两个输出一个是要的、一个是废料，选错边就把产品销毁了。
`"auto"` 仅在该实体**恰好 1 个** ejector 时合法，否则 `ambiguous_port` 并列出候选 role。

**⚠️ `wasteRoles` 的语义边界（写清楚以免误用）**：`wasteRoles` 是**半切场景**的约定
（要 `----CuCu` 时左列是产品、右列才是废料），**不是「这一侧永远没用」**。
L4 的 `RuRu----` 恰好要右列、丢左列 —— 与 `wasteRoles` 相反。
所以：**目标形状决定哪一侧是废料，宏查不出目标，只能要求调用方签字**（`confirm_waste=true`）。

**前置条件**：
- `outlet` 解析到唯一实体与**唯一** ejector 槽（`auto` 仅在恰好 1 个时合法）。
- 该槽当前 `boundAcceptor === null`（已有接收方 → `port_already_bound`，**绝不抢**）。
- 喷口下一格必须空，或 `replace_belt=true` 且为带子；机器/hub → `occupied`。
- 该槽 role ∈ 模板 `wasteRoles` 可直接执行；否则必须 `confirm_waste=true`。

**何时不该用**：
1. **输出要接 hub 或下游工序**：那是 `connect`。
2. **只是想暂时缓冲/合流**：trash 是**永久销毁**，用 balancer。
3. **端口已经接了东西**：先 `remove_run` 拆掉，并想清楚为什么它会空转。

**返回**：`MacroResult` + `{trash_uid, cell, replaced_belt_uid?}`

**内部调用的底层 op**：`obs` → `debug_items`（boundAcceptor）→ `op-templates`（wasteRoles/slot 表）→
`place` → `delete{uid}`（`replace_belt` 时）→ `tx`（A1）。

---

## 3. 统一返回信封

六个宏**只有一个**返回形状。DIRECTION-FINAL 钉死了前四个字段，这里补全其余：

```jsonc
{
  "ok": true,                       // 整体成败（tx 下等价于「全部做成」）
  "macro": "connect",
  "cells_planned": 12,              // 计划**写**的世界格数（新增+替换+删除），不是实体数
  "cells_placed": 12,               // 读回与计划**一致**的格数
  "first_mismatch": null,           // 或 {cell, field, requested, actual}
  "changed": { "added_uids": [...], "removed_uids": [...] },
  "warnings": [],                   // [{code, cell?, detail, hint?}]，不阻断
  "error": null,                    // ok=false 时必须非 null，code ∈ ERROR_CODES
  "tick": 20654.28,
  "dry_run": false
}
```

**三条硬语义**（`validateMacroResult()` 会机器检查）：
1. `ok=true` ⇒ `first_mismatch === null`。**不允许「成功了但有错位」。**
2. `ok=true` ⇒ `cells_placed === cells_planned`。不等就是半成，必须 `ok=false`。
3. `ok=false` ⇒ `error !== null`。**失败必须结构化**（DIRECTION-FINAL 阶段 2 判据 4）。

`first_mismatch` 比的是**读回的 code / rotation / rotation_variant**，不是「有没有东西」。
只比存在性会让「放歪了的带子」通过 —— 正是 P7 F1/F2 记录的静默事故。

**错误码闭集**（`ERROR_CODES`，调用方按 code 分支，不按 message 分支）：

| code | 含义 |
|---|---|
| `unknown_field` / `missing_field` / `bad_type` / `bad_arity` | 参数结构错（含被禁的裸坐标键） |
| `endpoint_not_found` / `endpoint_not_a_port` / `ambiguous_port` | 端点解析失败 |
| `ambiguous_site` | 落点反解出多个合法摆法（不猜） |
| `port_already_bound` / `target_already_fed` | 端口已占用 |
| `no_path` | 现有障碍下几何不可行（**不是参数错**） |
| `occupied` / `blocked_by_machine` | 目标格被占；机器永不让位 |
| `not_a_run` / `run_not_contiguous` | 选集不是带子 / 不连通 |
| `unsupported_building` / `out_of_scope` | 超出 v1 支持矩阵 |
| `tx_unavailable` | 无事务能力 → 拒绝执行，而不是半做 |
| `precondition_failed` / `partial_apply` | 前置条件不满足 / 事务层失职 |
| `verification_failed` | 落地后读回与计划不一致 |
| `internal` | 宏实现内部错误（出现即 bug） |

---

## 4. `intent` schema 扩展：`removes[]`

### 4.1 为什么用 uid 而不是坐标

1. `delete{x,y}` 在 181 实体存档上误删过一次 42 个实体（PROTOCOL §5）—— 坐标错一格就牵连邻里。
2. uid 在存档往返后**稳定**（PROTOCOL §4），是唯一的精确身份。
3. `restoreEntity(payload)` 的载荷里带 uid；坐标无法恢复被删实体的 uid，
   会让 `G-rollback-restore` 的「uid 集合逐字节相等」**不可达**（A1 `3306ade` 已交付原语）。

### 4.2 形状

```jsonc
{
  "goal": "RuRu----",
  "anchor": [4, -13],
  "entities": [ /* 不变，仍是整张蓝图 + anchor */ ],
  "removes": [
    { "uid": 10209, "expect": { "type": "belt", "x": 4, "y": -13 }, "reason": "让位给切割机左格" },
    { "uid": 10149, "expect": { "type": "belt", "x": 5, "y": -13 } },
    { "uid": 10143, "expect": { "type": "belt", "x": 4, "y": -14 } }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `uid` | int ≥ 0 | ✔ | `obs.entities[].uid` |
| `expect` | `{type, x, y, r?}` | ✔ | **必填**。执行前逐字段核对 |
| `reason` | string | | 人读的理由，进日志/诊断，不参与判定 |
| `optional` | bool | | `true` = 不存在时跳过而不判红（幂等重跑）。缺省 `false` |

**`expect` 为什么必填**：它是「写 intent 时的 obs 快照」与「执行时的世界」之间的一致性校验。
没有它，一个过期的 intent 会删掉新长出来的、同坐标的别的东西。

**`deletableTypes`**：`belt / underground_belt / balancer / cutter / rotater / stacker / mixer / painter / trash`。
`hub` **永不可删**（`getIsRemovable=false`）—— 指向它多半是 uid 抄错了，直接拒绝。

**校验函数**：
- `validateIntentRemoves(intent)` → 结构层（不查世界）。缺省返回 `[]`，向后兼容现有全部 intent。
- `checkRemovesAgainstObs(removes, entities)` → 存在性/一致性（A2 的 `G-remove-preflight` 调它）。
  返回 `missing` / `mismatched`（逐字段 diff）。

### 4.3 门控怎么校验它

执行顺序 **先删后贴**：

```
preflight → tx.begin → removes → paste → tx.commit → verify
```

理由：粘贴的 footprint 可能是刚被删掉的格子。反过来做，`dry_run` 会把「我要腾的位置」报成 `blocked`，
计划永远无法通过 G3。

| 闸 | 判据 |
|---|---|
| **G3**（改语义，不砍） | `dryRun.destroys[].uid ⊆ removes[].uid`。**未声明的销毁 → 红**：「销毁必须在计划里声明且可恢复」 |
| **G-delete-replay**（新增） | `vanished_uids === removes.filter(r=>!r.optional).map(r=>r.uid)` —— **集合相等，非子集**。声明了却还在 = 静默 no-op，下游 G6b 会拿一条其实还堵着的线判「连通」，是假绿的新入口 |
| **G4**（改语义） | `vanished_uids ⊆ removes[].uid`；`added_entities === entities.length` |
| **G-rollback-restore**（新增） | 回滚后 uid 集合 === 执行前 uid 集合（**逐字节**） |

`removes` 缺省为空数组 ⇒ 现有 13 个 harness intent 与全部旧计划**无需改动**即通过（向后兼容）。

### 4.4 已知局限（A2 必须写进 gate，不许假装没有）

G3 的 `dry_run` 发生在 `tx.begin` **之前**，而 `removes` 在 tx 内执行。两者之间世界仍可能变。
所以 `dry_run` 的结论是「**当时**成立」，执行时的真值由 `G-delete-replay` 用删除后的 obs 复核，
**不靠这份预检**。

---

## 5. 能力矩阵：哪些结论是实机的、哪些还是假设

这一节存在的理由：这个项目最大的成本不是写错代码，是**把假设当结论用**。
`WHY-NO-CUTTER-INSERT.md` 的「旋转机器不可用」曾让 L4 的正确解法被判死。

| key | 主张 | 状态 | 影响宏 |
|---|---|---|---|
| `machine_place_sets_rv` | `place{building,x,y,r}` 能可靠产生指定 `(rotation, rv)` 的带子 | **assumed** | connect / extend_line / replace_run / insert_machine |
| `rotated_machine_slots` | r≠0 加工机器的槽位 = 局部槽位旋转，世界格 = origin + rotate(localCell)，origin 不位移 | **observed**（见下） | insert_machine |
| `hub_16_entries` | hub 16 入口 = `hubEntriesWorld()` 表 | **observed** | connect |
| `trash_accepts_four_sides` | trash 四边全收，r 恒 0 | **live-verified** | trash_unused |

### 5.1 `machine_place_sets_rv` 是 assumed —— 这条最要命

`BELT-TOPOLOGY-RULES` 规则 2 实测：`place` 的 rv 由游戏按邻居**猜**，且拐角只在放置那一刻算一次；
`place{r:90}` 曾得到 `code=1` 直带（`AI-CONTROL-STATUS §2`）。

⇒ **`connect` / `extend_line` 的拐角不得依赖 `place` 猜**：必须用 `paste_blueprint` 携带显式
`code=1+rv`（emit 路径，已实机验证 immutable 粘贴不改 rv），或 `place` 后读回 `code` 自证并重试。
这是宏实现里最容易写错、也最容易「看起来绿」的一处。

### 5.2 `rotated_machine_slots` 是 observed —— 且与一份旧结论冲突

用 `research/ai-player/facts/live/world-full.json`（level-11，2805 实体）复算：

- `r≠0` 的 cutter **16 台，15 台**输入口正对一条 feeding belt；
- `r≠0` 的 painter **44 台，输入口 73/88 命中**（其余是地下带/balancer，未计入）；
- `r≠0` 的 mixer **23 台，输出口 23/23** 都有接收方。

反证对照：换成「绕 bbox 中心旋转」的换算，cutter 只剩 **6/16** 命中。

**这与 `WHY-NO-CUTTER-INSERT.md` 的「`r≠0` 的加工机器在 1.5.6 上根本不收货」直接冲突。**
该文档的结论来自一次受控实验（`r=180` 的 cutter 无产出），那份实验本身可能有问题
（例如把它放在了一个上游本来就没货的位置）。

**处置**（已写进 `CAPABILITY_ASSUMPTIONS`）：
- A3/A4 实现时，`facing` 反解出 r≠0 就**先照上式算**，但**落地后必须读回槽位/连接自证**；
  自证失败即 `verification_failed`，**不许**降级成「大概能用」。
- A9 用受控实验（独立存档、最小复现）裁定上面那条冲突，结果回写本表。
- **在裁定之前，不要在任何文档里写「支持旋转机器」** —— 状态是 `observed`，不是 `live-verified`。

---

## 6. 反模式清单（不该出现在宏 ABI 里的东西）

每条都说明**为什么**、**我们踩过的哪个坑**、**替代做法**。

### AP-1　`place{x, y, r, rotationVariant}` 这种让 LLM 算每格的签名

**为什么错**：
- `r`（rotation 角度）与 `rotationVariant`（带子形态位 0 直/1 左弯/2 右弯）语义**正交**，
  却并列在同一个签名里。调用方无法从名字判断该给哪个。
- 实机事故：`place{r:90}` 得到 `code=1` 直带 —— 游戏按邻居重算覆盖了调用方的意图
  （`AI-CONTROL-STATUS §2`、`BELT-TOPOLOGY-RULES` 规则 2）。
- 学术侧：网格空间推理随规模掉 42.7%；我们自己的 43 实体方案 13 个朝向全反（`L4-PLAN-A-REVIEW`）。

**替代**：`connect(from,to)` 只给两个端点；`insert_machine(at,facing,machine)` 只给
「哪一格」+「朝哪喷」+「什么机器」。`(rotation, rv)` 由宏从 `from/to` 的邻接反解。

### AP-2　一个大而全的 `build_factory` / `build_line(goal, site)` 当主入口

**为什么错**：
- SkillsBench：*focused skills with at most three modules outperform larger or exhaustive bundles*
  （`RESEARCH-B §3.2`）。单任务最多加载 3 个宏。
- `build_line` 内部要一次决定矿位、工序、车道、hub 入口 —— 那是**设计**，而 LLM 的角色是**改稿**。
- 它还会把已经验证过的 9/12 空地能力绑在一个不可降级的大动作上：一旦失败，
  调用方拿不到「哪一段坏了」。

**替代**：`build_line` **保留但不进公开 ABI 主路径**（A8 只把它包成 `connect` 的空地兜底）。
公开面是 6 个小宏，可组合、可单独重试、失败可定位。

### AP-3　要求 LLM 传 `rotationVariant`

**为什么错**：
- rv 是**带子形态位**，语义是「这个拐角往哪边弯」，它由 `(入口方向, 出口方向)` **唯一决定**
  （`belt-rules.solveTurn`，1906 条实机带子验证）。让调用方填等于让他重算一遍几何。
- 更糟：`place` 的 rv 会被游戏改写（AP-1），所以传了也不一定生效 —— **这是假控制**。
- `place` 已有的别名合并（`rotationVariant`/`rv`）就是为了兜这个坑，那是补丁不是设计。

**替代**：rv 从不出现在公开参数里；它由 `from/to` 的邻接 + `solveTurn` 反解，
并在落地后**读回 `code === 1+rv` 自证**（`first_mismatch` 报它）。

### AP-4　把「选哪个 hub 入口」做成坐标参数

**为什么错**：`hubEntryCell:[x,y]` 逼调用方查 16 入口表并算偏移 —— 那是 pin assignment，应该在宏里。

**替代**：`port:{entry:0..15}`。索引是**离散选择**，宏负责把它映射成世界格。
（`op-templates.hubEntriesWorld()` 是唯一真值源。）

### AP-5　`delete{x,y}` 式的「按格删」当作删除原语

**为什么错**：坐标错一格就牵连邻里（误删 42 实体）；且无法恢复 —— 坐标里没有 uid，
`restoreEntity` 无法还原原来的身份。

**替代**：`remove_run(uids)` 首选；`cells` 是次选且逐格校验。
intent 层用 `removes[{uid, expect}]`（§4）。

### AP-6　接受「大 region + 尽量删」的宽容语义

**为什么错**：`replace_run` / `bulk_delete` 的 region 边界算错一格就是灾难。
宽容语义（「跳过不是带子的格」「删到哪算哪」）会把错误**变成静默部分成功**。

**替代**：`replace_run` 要求 `region 内带子数 === region 面积`；不等即失败并报偏差。
`remove_run` 要求「全部是带子」，一格机器就整单拒绝。

### AP-7　把 `dry_run` 做成「调用方必须记得用」

**为什么错**：REDTEAM-E 的原话 —— *README 只说 paste 前要 dry_run，等于把这一步的代价转嫁给调用方*。
`paste_blueprint` 落在既有 belt 上是**静默销毁替换**（旧 uid 消失、`failed:[]`、零报告）。

**替代**：`tx` 是**默认**行为，不是可选项。没有 `tx` 能力时宏直接 `tx_unavailable` 拒绝执行。
`dry_run` 只是"提前看计划"的便利，**不是安全机制**。

### AP-8　`ok:true` 里夹带 `warnings` 式的「部分成功」

**为什么错**：`ok=true` + `first_mismatch != null` 这种组合会让调用方二选一地误读。
项目的静默事故（paste 覆盖旧带、拐角被翻向）全是"响应说成功、世界不是那样"。

**替代**：`ok` 是**全或无**（`cells_placed === cells_planned`）；诊断信息走 `warnings`（不阻断）
或 `error`（阻断）。`validateMacroResult()` 机器检查这条。

### AP-9　把「名字」当契约（`goal:"RuRu----"` 之类）

**为什么错**：宏参数里出现目标形状名，看起来人读友好，但它不是几何。
`RuRu----` 要哪一列是废料，取决于**目标**而不是形状名 —— 这正是 `wasteRoles` 语义边界（§2.6）踩的坑。

**替代**：宏参数只收**几何/实体引用**；目标语义留在 `intent.goal`，由裁决层（A2/A6）解释。

### AP-10　六个宏之外的「顺手加一个」

**为什么错**：`DIRECTION-FINAL` §1.2 的库容量是 8–12 个、单任务 ≤3；现在定 6 个是**故意留白**，
给阶段 4（技能库自增长）留位置。先加会破坏「≤3 模块」的检索前提。

**替代**：新需求先问「能不能用现有 6 个组合表达」。不能，再按 `MACRO_SPECS` 的形状新增，
且必须同时给出 `preconditions` / `whenNotToUse` / `returns` / `lowerOps`（`contract.mjs` 的自测会查）。

---

## 6.5 L4 的可表达性证明（阶段 1 判据 1 的预演）

L4 的唯一已知正确解是「删 3 带 + 放 1 切割机 + 1 垃圾桶」（`L4-PLAN-A0.md`）。
用本契约表达，**3 个宏调用**（≤5，达标），且**没有一个裸坐标是 LLM 算的**：

```jsonc
[
  { "op": "remove_run",     "uids": [10209, 10149, 10143] },          // uid 来自 obs，格是 (4,-13)(5,-13)(4,-14)
  { "op": "insert_machine", "at": [4, -13], "facing": "top",          // origin 来自上一句删掉的位置
                            "machine": { "kind": "cutter", "variant": "default" } },
  { "op": "trash_unused",   "outlet": { "uid": "??", "port": "left" }, // uid = insert_machine 返回的 machine uid
                            "opts": { "confirm_waste": true } }
]
```

- `remove_run` 的 3 个 uid 直接来自 `obs.entities[]`（`L4-PLAN-A0.md` 的表里记的 10209/10149/10143）。
- `insert_machine` 的 `at` 是**上一句刚腾出来的格**（origin 形态，宏不做算术）。
- `trash_unused` 的 `outlet.uid` 是**上一宏返回值**（`changed.added_uids[0]`），不是人抄的。
- 切割机两个输出哪边是废料（`RuRu----` 要右列、丢左列）由 ops 的 `confirm_waste` **签字**，
  不是由 `wasteRoles` 替调用方决定（§2.6 的语义边界）。

`contract.mjs` 对这三条做结构校验 → 全绿；`connect` 在这条路径上**一次都不需要**
（机器紧贴既有带子，槽位本就对齐）—— 这正好印证 `DIRECTION-FINAL` §6 的反向预测：
**如果 `connect` 单独就能让 L4 通过，阶段 3 可降级**。L4 不是那个指标任务。

---

## 7. 给下游 agent 的接口清单

| Agent | 从本契约拿什么 | 不要做什么 |
|---|---|---|
| **A1** 事务层 | `RETURN_ENVELOPE`、`ERROR_CODES.tx_unavailable/partial_apply`、`REMOVES_SPEC.order` | 不要改宏 ABI；`delete{uid}` 的返回要能填进 `changed.removed_uids` |
| **A2** 验收层 | `REMOVES_SPEC`（G3/G4/replay/rollback 四条规则）、`validateIntentRemoves`、`checkRemovesAgainstObs` | 不要把 `removes` 做成必填（缺省 `[]`，向后兼容） |
| **A3** `connect` | `CONNECT_SPEC`、§5.1（rv 必须自证）、`Endpoint` 形状 | 不要在公开参数里加 `path`/`waypoints`/`rv` |
| **A4** 其余 4 宏 | 对应 SPEC + §2.6 的 wasteRoles 边界 + §5.2 的旋转假设 | 不要把 `trash_unused` 做成「随便找个输出接垃圾桶」 |
| **A6** loop | `validateMacroCall`（校验入口）、`validateMacroResult`（自检）、`openAssumptionsFor`（降置信度） | 不要在 loop 里自己拼坐标；坐标只能来自 obs uid 或宏返回值 |
| **A8** 编译器降级 | §AP-2：`build_line` 不进公开主路径，只做 `connect` 的空地兜底 | 不要让 `build_line` 再当入口 |

---

## 8. 验收（A0 自身）

```bash
node --check src/agent/macros/contract.mjs    # 语法
node src/agent/macros/contract.mjs            # 45 条自测（全绿）
```

自测覆盖：六个宏的正/反例（含裸坐标被拒、`facing` 传角度被拒、`uid+cell` 同时给被拒、
`removes` 缺 `expect` 被拒）、`lintNoBareCoords`、返回信封的三条硬语义、
「每个宏都有 preconditions/whenNotToUse/returns/lowerOps」、「没有任何 computed 类公开参数」。
