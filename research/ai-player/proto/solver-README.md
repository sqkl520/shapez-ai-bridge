# solver-README — 配方求解器原型（可运行、已验证）

> `research/ai-player/proto/solver.mjs`（离线、零依赖、BFS）
> 复用已验证的 `shape-ops.mjs` 代数层（48,433/48,433 与公开求解器一致）。
> **零 export、禁改**（`plan-compiler.md` §3）：消费方一律 `spawnSync(node, [solver.mjs, goal, …])`。

## 用法

```bash
node research/ai-player/proto/solver.mjs CgScScCg                        # level-11 目标
node research/ai-player/proto/solver.mjs CgScScCg --no-cutquad          # 只用 level-11 已解锁的运算
node research/ai-player/proto/solver.mjs ----CuCu                       # level-2 目标
node research/ai-player/proto/solver.mjs CrCrCrCr                       # 纯上色（单颜料）
node research/ai-player/proto/solver.mjs CpCpCpCp                       # 混色（紫 = 红 + 蓝）
node research/ai-player/proto/solver.mjs <target> --json                # 结构化输出
node research/ai-player/proto/solver.mjs <target> --json --replay       # 结构化 + 自证复放
node research/ai-player/proto/solver.mjs <target> --replay              # 人读 + 逐节点复放
```

| flag | 作用 |
|---|---|
| `--resources C,R,S,W` | 可开采的形状（默认全部） |
| `--colors red,green,blue` | 可开采的颜料（默认三原色；混色自动闭包） |
| `--depth N` / `--max-states N` | BFS 预算（默认 7 / 150000） |
| `--no-cutquad` | **L<16 必带**（quad cutter 是 L16 建筑，见下） |
| `--no-rotater/-cutter/-painter/-mixer/-stacker` | 关掉某类运算 |
| `--no-pigments` | **回退旧行为**（paint 不带颜料输入；产物在布局层不可布，仅供对照/回归） |
| `--json` / `--quiet` / `--replay` | 输出形态 / 逐行 / 复放自证 |

退出码：`0` 解出（`--replay` 也过）/ `1` 参数或目标串错误 / `2` 无解 / `3` 解出但**复放失败**（solver 自己有问题）。

## 算法：前向 BFS（不是反向搜索）

**为什么前向**（实测教训）：反向搜索必须"猜切割前的另一半是什么"——猜错就造出错误解或死循环。
前向 BFS 从原料出发枚举所有**可达**形状，遇目标即返回，**不存在猜测**。
公开求解器（TomasSirgedas）同样采用可达表预计算。

**剪枝**：
1. 形状按 hash 去重（保留最短路径）
2. **stack 只配对"象限不重叠"的两个形状** —— 这砍掉了绝大部分组合
3. 深度上限 + 状态上限（可调）

**关键修正**（踩过的坑）：`cutQuad` 是 **L16 才解锁**的建筑变体。
默认全开会用 level-11 拿不到的建筑，产生"**看起来对但造不出来**"的解——
这本身就是"可用性约束必须进求解器"的教训。用 `--no-cutquad` 得到 level-11 合法解。

---

## 1. ★ 颜料是一等节点（v2，2026-10 修订）★

**旧版的问题（P8 集成测试 B-2 精确定位）**：颜料被折进 `paint` 的 `args.color`，plan 里**没有颜料来源**。
但 painter 的 **color 槽是真实输入槽**（GEOMETRY 表1:19 `shape←left`、`color←top`；表3 规则 6
「颜料是**独立物流** —— painter 的 color 从 top 进 → 必须为颜料留垂直通道」；M2a 实机验证两条物流都到位才上色）。
布局层只按形状 DAG 布线 ⇒ color 槽永远空着 ⇒ 上色器堵死（`validate:V4`，输入槽空供料）。
**所有上色目标**（L7 `CrCrCrCr`、L8 `RbRb----`、L9 `CpCpCpCp`、L11 `CgScScCg`…）因此都出不了蓝图。

**改法**：颜料来源成为 step，`inputs` 显式列出，间色展开成 `mix` 节点。

### 1.1 step 形状（新契约）

```jsonc
{ "hash": "CrCrCrCr",          // 形状节点 = shapez shortKey
  "op": "paint",
  "args": { "color": "red" },
  "depth": 1,
  "inputs": ["CuCuCuCu", "color:red"],   // ← 顺序即槽位序：shape、color
  "parents": ["CuCuCuCu", "color:red"],  // ← inputs 的别名（旧消费方兼容；以 inputs 为准）
  "kind": "shape" }
```

`kind` ∈ `"shape" | "pigment"`。槽位序（**与 op-templates 的模板逐字对应**）：

| op | `inputs` 顺序 | 模板依据 |
|---|---|---|
| `mine` / `cutQuad` | `[]` / `[shape]` | — |
| `cut` | `[shape]` | cutter 单输入 |
| `rotate` / `rotateCCW` / `rotate180` | `[shape]` | rotater 下进上出 |
| **`paint`** | **`[shape, pigment]`** | painter：`inputs[0]=left(shape)`、`inputs[1]=top(color)` |
| **`mix`**（颜料节点） | **`[colorA, colorB]`** | mixer：两个 bottom 槽 |
| `stack` | `[lower, upper]` | stacker 左格=下层、右格=上层（GEOMETRY:18 实机确认） |
| **`mineColor`**（颜料节点） | `[]` | 地图上的纯色矿 |

### 1.2 颜料节点的 hash：`color:<name>`

**为什么必须与 shape 空间分开**（三条实测事实，不是偏好）：

1. **形状空间里没有「纯颜料」这一型**：`so.parse("red")` 直接抛错（shape key 每层 8 字符、每象限 `[sub][color]`）。
2. **借用空形状 token 会退化成唯一值**：`"--------"` 是 `parse∘hash` 的**不动点**，而 `"-r-r-r-r"`
   这类「有色空位」被 hash **归一回** `"--------"`（`so.hash(so.parse("-r-r-r-r")) === "--------"`）
   ⇒ 一张图里只能表达**一种**颜料来源，双颜料（L11 的 cyan+green）无解。
3. **游戏里颜料是 `ColorItem`**（`items/color_item.js:28` `getItemType()==="color"`），**不是 ShapeItem**；
   布局层的 `channels[].payload` 契约要 shortKey，两者本就不同型。

⇒ 统一用 **`color:<name>`**（`name ∈ red|green|blue|yellow|purple|cyan|white`）。它不以 `-`/`R`/`C`/`S`/`W`
开头、不含 `:` 分层分隔的 shape 语法，**不可能**与 shape hash 相撞；消费方按 `startsWith("color:")`
一眼识别为 color_item。

### 1.3 混色链显式展开

`cyan = green | blue`，所以 `paint cyan` 前面会有：

```jsonc
{ "hash": "color:blue",  "op": "mineColor", "args": { "color": "blue"  }, "inputs": [], "kind": "pigment" }
{ "hash": "color:green", "op": "mineColor", "args": { "color": "green" }, "inputs": [], "kind": "pigment" }
{ "hash": "color:cyan",  "op": "mix",       "args": { "color": "cyan"  },
  "inputs": ["color:blue", "color:green"], "kind": "pigment" }
```

颜色位域与 `colors.js:61` 同源：`red=1 green=2 blue=4`，混合 = **按位或**
（`yellow=3`、`purple=5`、`cyan=6`、`white=7`）。混色配方固定按**字典序**取 [a,b]（确定性）；
`--no-mixer` 时间色直接不可达（`CpCpCpCp` 会报无解，退出码 2）。

**同一颜料被多台上色器共用时只有一个节点**（同一 hash）：`CgScScCg` 的 `cyan`（mix）与 `green`（mine）
各自只出现一次，两台 painter 共享 `color:green` 的矿 —— 消费方可以合并成一台矿机，也可以按扇出布线。

### 1.4 `plan.pigments[]`（新增，消费方可直接用）

```jsonc
"pigments": [
  { "hash": "color:blue",  "color": "blue",  "from": "mineColor", "inputs": [] },
  { "hash": "color:green", "color": "green", "from": "mineColor", "inputs": [] },
  { "hash": "color:cyan",  "color": "cyan",  "from": "mix",       "inputs": ["color:blue", "color:green"] }
]
```

`from` ∈ `mineColor | mix`。**矿位由消费方选**（`world.mjs` 的 `tileResource` 会回报 `"red"/"green"/"blue"`；
seed 43391 的 ±96 格内有 red 280 / green 215 / blue 288 格；实机 dump 里 452/466/493 格）。

---

## 2. 实测结果（全部 `--replay` 复放验证 ✅）

| 目标 | 难度 | 解 | 耗时 | 验证 |
|---|---|---|---|---|
| `CuCuCuCu` | L1（原料直达） | mine ×1 | 1ms | ✅ |
| `----CuCu` | L2（切半） | mine + cut(left) | 2ms | ✅ |
| `RuRu----` | L4（右半） | mine + cut(right) | 3ms | ✅ |
| `CrCrCrCr` | L7（纯上色） | mine + **mineColor(red)** + paint | 3ms | ✅ **含颜料节点** |
| `CpCpCpCp` | L9（混色） | mine + **mineColor×2 + mix(purple)** + paint | 2ms | ✅ **含 mix 节点** |
| **`CgScScCg`** | **L11 真目标** | mine×2 + cut×2 + **mineColor×2 + mix(cyan)** + paint×2 + stack + rotateCW | **875ms** | ✅ **逐步复放通过** |
| **`SrSrSrSr:CyCyCyCy`** | **L15 多层目标** | mine×2 + **mineColor×2 + mix(yellow)** + paint×2 + stack(layers) | **~320ms** | ✅（多层求解可行） |

> 耗时比 v1 略高（L11 从 865ms → 875ms）：颜料对形状 hash **无影响**，BFS 状态数与 v1 完全相同；
> 增量只是 plan 里多了 3 个颜料节点。

### level-11 的合法解（`--no-cutquad`，11 个 step）

```
[d0] mine                    →  SuSuSuSu
[d1] cut right               ← [SuSuSuSu]              →  SuSu----
[d1] mineColor {blue}        →  color:blue
[d1] mineColor {green}       →  color:green
[d1] mix {cyan}              ← [color:blue, color:green] →  color:cyan
[d2] paint cyan              ← [SuSu----, color:cyan]   →  ScSc----
[d0] mine                    →  CuCuCuCu
[d1] cut left                ← [CuCuCuCu]              →  ----CuCu
[d2] paint green             ← [----CuCu, color:green] →  ----CgCg
[d2] stack(merge)            ← [ScSc----, ----CgCg]    →  ScScCgCg
[d3] rotate cw               ← [ScScCgCg]              →  CgScScCg   ✅ 末节点 == 目标
```

**注意**：这条解与主 Agent 手推的 7 步链**不同**（都正确）。BFS 找的是"最浅深度"解。
颜料节点是**旁支**（不影响形状 BFS 的去重键），所以形状部分的解与 v1 逐字相同 —— 这是刻意的：
改的只是「颜料从哪来」的表达，不是搜索策略。

### 多层解（L15 目标）

```
[d0] mine              →  CuCuCuCu
[d0] mineColor {green} →  color:green     [d0] mineColor {red} → color:red
[d0] mix {yellow}      ← [color:green, color:red] → color:yellow
[d1] paint yellow      ← [CuCuCuCu, color:yellow] → CyCyCyCy
[d0] mine              →  SuSuSuSu
[d1] paint red         ← [SuSuSuSu, color:red]    → SrSrSrSr
[d1] stack(layers)     ← [SrSrSrSr, CyCyCyCy]     → SrSrSrSr:CyCyCyCy   ✅
```

**多层求解已打通**（`stack` 的分层语义如实实现）。**未解的是多层的"布局"**——
需要多级 stacker 串联（每个 stacker 吃两个输入产出一层），几何复杂度仍是 SYNTHESIS §5.2 的最大项。

---

## 3. ★ 给 P3（布局）/ P8（编排）的消费契约 ★

> 这一节是**接口**，不是建议。P8 的 op 映射表与 P3 的布线都按这里改。

### 3.1 识别颜料节点
```js
const isPigment = h => typeof h === "string" && h.startsWith("color:");
const colorOf   = h => h.slice("color:".length);       // "color:cyan" → "cyan"
```
`kind === "pigment"` 是冗余但更方便的判据（两者必须一致；不一致 = solver bug）。

### 3.2 映射到编译器 op
| solver `op` | 编译器 op（P2 `ALL_TEMPLATES`） | 机器 / code | 槽位（`inputs` 顺序） |
|---|---|---|---|
| `mineColor` | **`mine`**（矿机，采 color_item） | miner / 7 | `[]` |
| `mix`（pigment） | **`mix`** | mixer / 15 | `[colorA, colorB]` → 模板 `bottom, bottom` |
| `paint` | `paint` | painter / 16 | `[shape, pigment]` → 模板 `left, top` |

- **`mineColor` 不需要新 op**：它就是一台矿机，只是采的是纯色矿格。
  P2 的 `tileResource(seed,x,y)` 直接返回 `"red"/"green"/"blue"`，所以矿位校验用 `colorOf(hash)` 比对即可。
- **`mix` 的 output 是 pigment 而非 shape**：`payload` 用 `color:<name>`，**不要**塞进 shortKey 语法。

### 3.3 `channels[].payload` 该怎么表示 color_item（**契约缺口的落地方式**）

现状：`LayoutReport.channels[].payload` 被 P1 的 `checkShortKeyGrammar` 强制为 shapez shortKey
（`types.mjs:597`），而颜料节点不是形状。**两种落法，任选其一，但必须显式**：

**(A) 推荐 —— payload 仍是短串，但允许 `color:<name>` 这一族**：
```
{ from: {nodeId:"pig", cell:[x,y], slot:"top", outDir:"top"},
  to:   {nodeId:"n2", cell:[x,y], slot:"top", inDir:"top"},
  payload: "color:cyan" }          // ← 以 "color:" 开头 = ColorItem
```
需要 P1 的 `checkShortKeyGrammar` 放行 `color:` 前缀（或加一个 `payloadKind:"shape"|"color"` 字段）。
**这是最小改动**：`payload` 的类型仍是 string，现有逐格 diff / R-5 的 channelId 推导都不受影响。

**(B) 结构化 —— `payload:{kind:"color", color:"cyan"}`**：更干净，但要改 `payload` 的类型、
P3/P4/P5/P6 全部读 payload 的地方（`channelIdOf`、V5 的候选集、S1 的 `ops.parse(payload)`）。
S1 必须**跳过**颜料通道（它不是形状重放的对象）。

无论选 (A) 还是 (B)：**P5 的 V4 必须把 painter 的 color 槽算作「已供料」**，否则旧行为下
「输入槽空供料」的 fail 会继续出现 —— 那不是 bug，是它一直缺的东西。

### 3.4 布线要求（P3/P4）
1. **painter 必须有 2 条输入通道**：`shape`（进 left）+ `color`（进 top）。缺任一条 → 上色器堵死。
2. **mixer 必须有 2 条输入通道**（两个 bottom）+ 1 条输出（top）。混色链是 `mineColor → mix → paint`。
3. **同一颜料 hash 可由多台上色器共享**：`CgScScCg` 的 `color:green` 同时喂 `paint cyan`（经 mix）与
   `paint green`。v1 布局无扇出模板（P3 会判 `crossing-needs-tunnel`）⇒ 消费方应**复制矿机**
   （每个消费者一台，各自独立矿位），而不是扇出。
4. **颜料矿选址**：`mineColor` 节点要落在 `tileResource(seed,x,y) === colorOf(hash)` 的格子上；
   纯色矿是**成片**的（seed 43391 ±96 格：red 280 / green 215 / blue 288），不愁找不到。

### 3.5 实测：新 plan 喂给当前 P3 会走到哪一步（把契约缺口钉成事实）

把 `CgScScCg` 的新 plan **原样**（`mineColor`→`mine`、`mix` 保持）喂给当前入库的 `place()`：

| 做法 | 结果 | 含义 |
|---|---|---|
| 颜料节点 hash 用 `"--------"`（占位） | ❌ `out-of-scope:multilayer`（`steps[N].hash 期望唯一`） | 空形状只能有一个 ⇒ **不能**借用 shape token（§1.2 理由 2 的运行时证据） |
| 颜料节点 hash 用 `"color:<name>"`（**新契约**） | DAG 构建**通过**，然后 ❌ `dag-not-placeable:crossing-needs-tunnel`（`扇出 2 > 1`） | `color:` 能无摩擦穿过 P3 的 hash/语法检查；剩下的只是 P3 既有的「无扇出模板」限制 ⇒ 按 §3.4-3 **复制矿机**即可 |

⇒ 结论：**P3 不需要认识新 op**（`mineColor` 就是 `mine`），只需要 (a) 允许 `color:` 作节点 hash、
(b) painter 的 color 槽参与 `channels[]`（§3.3）、(c) 遇到共享颜料时复制矿机。P8 的 op 映射表
加三行：`mineColor → mine`、`mix → mix`、`paint.inputs[1]` 走颜料通道。

---

## 4. 复放（自证）：`--replay`

解能出来 ≠ 解能复放（M4 教训：文档说 ✅、结果 JSON `pass:false`）。`--replay` 用 **shape-ops 把整条 plan 从头算一遍**：

1. 每个形状节点：op 作用在 `inputs` 的形状上，`hash` 必须等于声明值；
2. 每个颜料节点：`mineColor` → `color:<name>`；`mix` → 两个上游颜色的**位域或**必须等于声明颜色；
3. `paint` 的第 2 输入必须是 pigment 节且颜色与 `args.color` 一致；
4. 依赖序：任何 `inputs` 必须**先于**该节点出现；
5. 末节点 `hash === plan.targetHash`。

失败时退出码 **3**（区别于「无解」的 2）。实现见 `solver.mjs` 的 `replayPlan()`（紧邻 CLI 上方）。

**附录：可跑的复放脚本**（**独立于 solver**，只吃 `--json` 输出；实测 4 个目标全部 `REPLAY OK`）

不新建文件 —— 直接管道给 `node --input-type=module -e`（在 `research/ai-player/proto/` 下跑，因为要 `import "./shape-ops.mjs"`）：

```bash
cd research/ai-player/proto
node solver.mjs CgScScCg --no-cutquad --json > /tmp/p.json
node --input-type=module -e '
import fs from "node:fs";
import * as so from "./shape-ops.mjs";
const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const plan = j.plan || j;                       // 接受 solver --json 的整体或 plan 本身
const BITS = { red: 1, green: 2, blue: 4, yellow: 3, purple: 5, cyan: 6, white: 7 };
const NAME = Object.fromEntries(Object.entries(BITS).map(([k, v]) => [v, k]));
const done = new Map();
let bad = 0;
for (const st of plan.steps) {
  for (const h of st.inputs) if (!done.has(h)) { console.log(`✗ ${st.hash}: 上游 ${h} 未先出现`); bad++; }
  if (st.kind === "pigment") {
    const color = st.op === "mineColor" ? st.args.color
      : NAME[st.inputs.map(h => BITS[done.get(h).color]).reduce((a, b) => a | b, 0)];
    done.set(st.hash, { color });
    if (`color:${color}` !== st.hash) { console.log(`✗ ${st.hash}: 算得 color:${color}`); bad++; }
    continue;
  }
  const P = st.inputs.map(h => done.get(h).shape);
  let out;
  if (st.op === "mine") out = so.parse(st.hash);
  else if (st.op === "cut") out = so.cutHalf(P[0])[st.args.half === "left" ? 0 : 1];
  else if (st.op === "cutQuad") out = so.cutQuad(P[0])[st.args.quad | 0];
  else if (st.op === "rotate") out = st.args.dir === "ccw" ? so.rotateCCW(P[0]) : st.args.dir === "180" ? so.rotate180(P[0]) : so.rotateCW(P[0]);
  else if (st.op === "paint") out = so.paint(P[0], st.args.color);
  else if (st.op === "stack") out = so.stack(P[0], P[1]);
  else { console.log(`✗ ${st.hash}: 未知 op ${st.op}`); bad++; continue; }
  done.set(st.hash, { shape: out });
  if (so.hash(out) !== st.hash) { console.log(`✗ ${st.hash}: 算得 ${so.hash(out)}`); bad++; }
}
const last = plan.steps[plan.steps.length - 1];
if (!last || last.hash !== plan.targetHash) { console.log(`✗ 末节点 ${last && last.hash} ≠ 目标 ${plan.targetHash}`); bad++; }
console.log(bad ? `REPLAY FAILED (${bad})` : `REPLAY OK (${plan.steps.length} steps → ${plan.targetHash})`);
process.exit(bad ? 1 : 0);
' /tmp/p.json
```

实测输出：

```
CrCrCrCr            → REPLAY OK (3 steps → CrCrCrCr)
CgScScCg            → REPLAY OK (11 steps → CgScScCg)
CpCpCpCp            → REPLAY OK (5 steps → CpCpCpCp)
SrSrSrSr:CyCyCyCy   → REPLAY OK (8 steps → SrSrSrSr:CyCyCyCy)
```

> 更省事的是直接用内置开关：`node solver.mjs <goal> --no-cutquad --replay`（同一套判据，实现见 `replayPlan()`）。

---

## 5. 能力边界（诚实清单）

| 项 | 状态 |
|---|---|
| 单层形状（level 1-11 全部目标） | ✅ 已解 |
| **多层形状求解**（`SrSrSrSr:CyCyCyCy`，L15） | ✅ 解出（`stack` 分层语义如实实现） |
| 多层**布局** | ❌ **未做**（SYNTHESIS §5.2 最大未解项的另一半） |
| **颜料作为一等节点**（`mineColor` / `mix` / `paint` 双输入） | ✅ **v2 已修**（本文 §1；P8 的 B-2 缺口） |
| 颜料**布线**（painter color 槽、mixer 双输入） | ⚠️ **待 P3/P4**（本文 §3 是契约；布局层还没实现） |
| 吞吐优化（最少机器数） | ❌ 未做（当前只保证"最浅深度"） |
| 与公开表的代数一致性 | ✅ `validate-vs-public-solver.mjs` 对代数层 100% |

**性能注**：单层目标的瓶颈是"互补合并"分支（半形状 × 半形状的组合）。
多层反而快，因为"完整形状叠完整形状"不经过那个爆炸路径。

## 6. 待办

1. **布局层接颜料**（P3/P4）：painter color 槽、mixer 双输入、`mineColor` 矿位 —— 契约见 §3。
2. 吞吐感知求解（`--min-machines`：按机器速率给代价函数，找瓶颈最少的解）。
3. 多层布局（求解可过，布局待 M 系列扩展）。
