# L12 到底做不做得到：white 的来源、地图原料、现有机器、最少机器清单

2026-11-23。**全程离线**，未连 bridge、未发 tx/act/step、未改 `src/`。
数据源：`research/ai-plan/runs/r-20261123151728-52a3/{obs,items,production}-last.json`
（game_version 1.5.6，`goal.level=12`，`requirement.shape=CbCbCbRb:CwCwCwCw`，
`delivered=0/1000`，`paused=false`，`tick` 冻结在死锁态）。

形状代数一律调 `research/ai-player/proto/shape-ops.mjs`（游戏源码的离线复刻）与
`recon/upstream-full/src/js/game/colors.js` 的真实混色表，**没有一处手推**。
临时脚本已删（`.tmp-search/`）。

---

## 一句话判定

**做得到。** 缺的不是矿，也不是机器种类 —— 缺的是**接线**和**一台 rotater 的变体**。

- 颜色链上 **white 不需要白色矿**（游戏里根本不存在白色矿），它是 `cyan|red = (blue|green)|red`，**两次 mixer**。
- 这个世界的矿完全够：`blue / green / red` 三色颜料矿全有（各 1794 / 1709 / 2362 格），
  `CuCuCuCu`、`RuRuRuRu` 两种形状矿也都在 hub 旁 8～12 格内。
- 现有 **4 台 mixer、3 台 cutter、2 台 painter、1 台 stacker、1 台 rotater** 全都在，
  但**没有一台 mixer 的两槽同时有料**，**唯一的 rotater 是 CW 变体**（CCW 未解锁——不过只用 CW 也能走通，见 §4）。
- 数学上最少需要 **3 台 stacker / 4 台 cutter / 2 台 painter / 2 台 mixer / 2 台 rotater**；
  现有差 **2 台 stacker + 1 台 rotater**（其余可复用）。

**但**：这不是「差 3 台机器」的量级问题，见 §5 的产能算术 —— 单台 stacker 0.25/s、
1000 件 ⇒ 3.3 小时纯堆叠时间，且这一步每轮只推进 40 游戏秒。
**「做得到」是代数与空间意义上的；按当前预算能不能跑完是另一个问题。**

---

## 1. white 怎么来（用真实混色表算出来的）

### 1.1 游戏源码就是按位或

`recon/upstream-full/src/js/game/colors.js:58-75`：

```js
const bitfieldToColor = [
    /* 000 */ c.uncolored, /* 001 */ c.red,  /* 010 */ c.green, /* 011 */ c.yellow,
    /* 100 */ c.blue,      /* 101 */ c.purple, /* 110 */ c.cyan, /* 111 */ c.white,
];
for (let i = 0; i < 1 << 3; ++i) {
    enumColorMixingResults[bitfieldToColor[i]] = {};
    for (let j = 0; j < 1 << 3; ++j) {
        enumColorMixingResults[bitfieldToColor[i]][bitfieldToColor[j]] = bitfieldToColor[i | j];
    }
}
```

mixer 的处理器 `systems/item_processor.js:487-508` 直接查这张表：

```js
const mixedColor = enumColorMixingResults[color1][color2];
let resultColor = color1;
if (mixedColor) { resultColor = mixedColor; }
```

⇒ **混色 = 按位或。white = 111b = red|green|blue。**

### 1.2 用 BFS 从 {red,green,blue} 出发算最短链

调用代码（`node`，直接 import 游戏源码的混色表）：

```js
import { enumColorMixingResults } from "../recon/upstream-full/src/js/game/colors.js";
const base = ["red","green","blue"];
const known = new Set(base);
for (let depth = 1; depth <= 3; depth++) {
  const next = new Map();
  for (const c1 of known) for (const c2 of known) {
    const r = enumColorMixingResults[c1][c2];
    if (!known.has(r) && !next.has(r)) next.set(r, [c1, c2]);
  }
  if (next.has("white")) { console.log(`white 最少 ${depth} 次 mix，最后一对 = ${next.get("white")}`); break; }
  for (const k of next.keys()) known.add(k);
}
```

输出：

```
depth 1: 新颜色 = yellow, purple, cyan
★ white 最少 2 次 mix，最后一对 = cyan + red

能得到 white 的单步输入对（全表，去掉含 white/uncolored 的平凡项）：
  red+cyan  green+purple  yellow+blue
```

⇒ **white 必须两次 mixer，串联**：
`blue + green → cyan`，`cyan + red → white`。（`yellow+blue` 也能到白，但 yellow 本身又是一次
mix，同样是 2 级，路径等价。）

### 1.3 有没有「某种矿直接给 white」—— 没有，而且源码可证

`map_chunk.js:171-178`（`internalGenerateColorPatch`）：

```js
let availableColors = [enumColors.red, enumColors.green];
if (distanceToOriginInChunks > 2) { availableColors.push(enumColors.blue); }
this.internalGeneratePatch(rng, colorPatchSize, COLOR_ITEM_SINGLETONS[rng.choice(availableColors)]);
```

**颜料矿的候选集永久只有 red / green / blue。** 白色、青色、紫色、黄色都不会作为矿生成。
（`hub_goals.js:382` 里 `universalColors = [enumColors.white]` 是**自由模式目标形状的随机配色**，
不是地图矿。mod 自己的注释在 `src/mod/shapez-ai-bridge.js:1520-1540` 也已更正过这个误解，
并点名 `RuRuWuWu` 的 `W` 是 windmill 形状码、不是 white 颜色码。）

### 1.4 完整配方（shape-ops.mjs 实算，逐步）

```
painter#1(CuCuCuCu, blue)                = CbCbCbCb     ✅
cutter(CbCbCbCb) → 出口[0] (q2q3)        = ----CbCb      ✅
rotater CCW(----CbCb)                    = --CbCb--      ✅
cutter(--CbCb--) → 出口[0] (q2)          = ----Cb--      ✅
painter#1'(RuRuRuRu, blue)               = RbRbRbRb      ✅
cutter(RbRbRbRb) → 出口[0]               = ----RbRb      ✅
rotater CW(----RbRb)                     = Rb----Rb      ✅
cutter(Rb----Rb) → 出口[0] (q3)          = ------Rb      ✅
stack(CbCb----, ----Cb--)                = CbCbCb--      ✅
stack(CbCbCb--, ------Rb)                = CbCbCbRb      ✅
painter#2(CuCuCuCu, white)               = CwCwCwCw      ✅
stack(CbCbCbRb, CwCwCwCw)                = CbCbCbRb:CwCwCwCw  ✅ == GOAL
```

更好的写法（**先装配后一次性染色**，省一台 painter 的一道工序）：

```
（铜矿）  cutter → CuCu---- ; cutter → ----CuCu ; rotCW + cutter → ----Cu--
（钌矿）  cutter → RuRu---- ; rotCW + cutter → ------Ru
          stack(RuRu----, ----CuRu) = RuRuCuRu        ← 若走 CW-only 路线见 §4
          ... 装配到 CuCuCuRu，再 paint(blue) 一次 = CbCbCbRb
```

`paint()` 只影响非空象限（`shape_definition.js:609-624`），所以「装配完再喷」与「先喷再装配」
结果相同 —— 我两种都验了。

---

## 2. 地图上有什么（`resources` 全表，11187 条三元组）

`resources_region = [-256,-256,256,256]`（mod 的 `resourceSnapshot` 用 chunk 对齐扫，
`MAX_TILES=40000` 上限不触发；`resources` 数组 11187 条 = **范围内全部矿格，无截断**
——`max_resources` 默认 2000 但该 run 显然传了更大的值，因为 11187 > 2000 且 tiling 完整）。

### 2.1 颜料矿 vs 形状矿

| 类别 | 种类数 | 总格数 |
|---|---|---|
| **颜料矿**（纯色名） | **3** | **5865** |
| **形状矿**（形状串） | **44** | **5322** |

**颜料矿全表：**

| 矿 | 格数 | 距 hub 曼哈顿最近 |
|---|---|---|
| `red` | 2362 | 13 |
| `green` | 1709 | 12 |
| `blue` | 1794 | 44 |

⚠️ **没有 `white` 矿，也没有 `cyan` / `purple` / `yellow` 矿。** 这与 §1.3 的源码结论一致 ——
不是这张图运气不好，是游戏根本不生成。

**形状矿（按距离排序，全 44 种）：**

| 矿 | 格数 | 最近距离 | | 矿 | 格数 | 最近距离 |
|---|---|---|---|---|---|---|
| `RuRuRuRu` | 873 | **8** | | `SuRuCuRu` | 45 | 262 |
| `CuCuCuCu` | 767 | **12** | | `SuCuRuSu` | 33 | 263 |
| `SuSuSuSu` | 224 | 106 | | `RuRuSuCu` | 43 | 263 |
| `SuSuCuCu` | 230 | 174 | | `SuSuSuWu` | 48 | 267 |
| `SuSuRuRu` | 156 | 180 | | `RuRuCuRu` | 38 | 279 |
| `CuCuRuRu` | 318 | 190 | | `RuCuRuCu` | 61 | 297 |
| `RuRuCuCu` | 480 | 193 | | `CuSuCuRu` | 98 | 298 |
| `CuCuSuSu` | 69 | 231 | | `SuRuRuSu` | 46 | 302 |
| `RuRuWuWu` | 178 | 239 | | `RuCuCuRu` | 96 | 313 |
| `RuCuSuRu` | 44 | 248 | | `RuCuCuCu` | 52 | 314 |
| `RuRuSuSu` | 175 | 249 | | `SuRuSuRu` | 64 | 316 |
| `SuCuRuWu` | 40 | 251 | | `RuCuRuRu` | 42 | 317 |
| `RuRuRuCu` | 154 | 254 | | `RuRuRuWu` | 49 | 330 |
| **`CuCuRuCu`** | **114** | **254** | | `CuRuCuRu` | 93 | 331 |
| `SuRuCuRu` | 45 | 262 | | `SuRuRuCu` | 56 | 344 |

（其余 24 种在 346～456 格之间，略。）

### 2.2 关键几何事实

- **观测/施工区**：`region = [-15,-54,90,17]`，7632 格，实际占用 774 格，**空闲 90%**。
- **近距矿只有 3 种**（≤120 格）：`RuRuRuRu`(8) / `CuCuCuCu`(12) / `green`(12) / `red`(13) / `blue`(44) / `SuSuSuSu`(106)。
- **`CuCuRuCu`（= 直接能切出目标底层的混合矿）在 254 格外**。
  最近的矿簇在 `(-10,-248)` 一带（x -15..-8, y≈-248），要铺约 250 格带子。
  **这是「捷径」，不是「必需」** —— 见 §4 的纯近距路线。

---

## 3. 现有机器逐台状态

`stats.by_type = {hub:1, belt:699, balancer:1, miner:17, mixer:4, cutter:3, painter:2, stacker:1, rotater:1, trash:20}`
（`total:749`，与 `entity_count` 一致，无截断）。

判定规则（抄游戏源码 `item_acceptor.js:108-125` + `belt_path.js:236-255`）：
**机器输入槽 `dir=D` ⇒ 货必须朝 `opp(D)` 行进 ⇒ 喂料带子必须 `exit = opp(D)` 且 `exitCell = slot`。**
反过来 `belt_path.js:104-110` 也要求 `ejectSlotWsDirection === beltAcceptingDirection` 才肯收货。

### 3.1 机器清单与每个输入槽

| 机器 | 位置 | r | 槽状态 | 判定 |
|---|---|---|---|---|
| **cutter#13369** | (84,-16) | 180 | primary ← (84,-17) **空地** | ⛔ 无来料；两个出口 (84,-15)/(83,-15) 也全空地 ⇒ **完全空壳** |
| **cutter#13544** | (-5,9) | 180 | primary ✅ `belt#14834`（8 件 `CuCuCuCu`） | 只有 slot1 出口接走（`belt#14835`），**slot0 出口 (-6,10) 空地** |
| **cutter#16598** | (28,-52) | 90 | primary ✅ `belt#16616` 载 **2 件 `blue`（颜料！）** | 来料是颜料、cutter 只收 `shape` ⇒ **类型不匹配，永远不工作** |
| **painter#13552** | (-5,14) | 90 | shape ✅ `belt#14838`（**0 件**）；color ⛔ (-4,15) **空地** | 缺 color ⇒ `inputsPerCharge:2` 永不满足 ⇒ 不吐货 |
| **painter#14687** | (89,-14) | 270 | shape ⛔ / color ⛔ **两槽全空地**，出口 (89,-16) 也空地 | **完全空壳** |
| **stacker#14684** | (-2,5) | 0 | lower ✅ `belt#14992`（**0 件**）；upper ✅ `belt#14805`（**2 件 `ScSc----`**） | **接线对，但 lower 空 ⇒ 攒不满 2 件 ⇒ 死锁锚点** |
| **rotater#14685** | (-2,3) | 0 | primary ✅ `belt#14999`（0 件） | 接线对；**变体 = CW（`variant:"default"`, code 11）** |
| **mixer#16742** | (-4,1) | 270 | color ⛔ (-3,1) 空地 / color ⛔ (-3,0) 空地 | **两槽全空**；出口接 `belt#14827` |
| **mixer#17294** | (34,-40) | 270 | color ❌ `belt#17410` 出口→(35,-41) 不指向本槽；color ❌ `belt#17648` 出口→(36,-41) | **两槽接线都错（拓扑冲突）** |
| **mixer#17319** | (30,-51) | 90 | color ✅ `belt#17585` / color ✅ `belt#17586`（两槽都 0 件） | **接线对，但上游全空 ⇒ 无料** |
| **mixer#17340** | (36,-41) | 90 | color ✅ `belt#17648` / color ❌ `belt#17410` 出口→(35,-41) | 一槽对一槽错 |
| **balancer#14132** | (-5,-8) | 90 | primary ✅（0 件）/ secondary ⛔ 空地 | 半接 |

### 3.2 逐台核 mixer 的两槽（题目点名要的）

| mixer | 槽0 喂料 | 槽1 喂料 | 两槽都有料？ |
|---|---|---|---|
| #16742 | (-3,1) 空地 | (-3,0) 空地 | **否** |
| #17294 | (35,-40) 带子方向错 | (35,-41) 带子方向错 | **否** |
| #17319 | (29,-51) ✅ 空带 | (29,-50) ✅ 空带 | **否（接线对，没货）** |
| #17340 | (35,-41) ✅ 空带 | (35,-40) 方向错 | **否** |

**4 台 mixer，0 台在两种颜料都到齐的状态下。** 全图带上只有 **`blue` 221 / `green` 4 / `red` 4**
件颜料，且分散在三条互不相通的死链上。

### 3.3 全图货流（699 条带子 = 31 条链，已全量分完）

- **有正确来源（矿机或机器出口）的带子 678/699；21 条无源**（其中 15 条是「相邻带子方向不接」）。
- **跨 path 合并点 = 0**：699 条带子被切成 31 条**互不连通**的链，`path8`、`path20` 等各自独立。
  ⇒ 想把远处那 87 件蓝颜料调头去 mixer，**物理上做不到**（没有合流点）。
- 关键链：
  - `(-9,2)→cutter#13544`：13 格，8 件 `CuCuCuCu`，**源头空地（矿机没接进来）**。
  - `painter#13552→stacker#14684.lower`：16 格，**0 件**。
  - `miner#16204→stacker#14684.upper`：165 格，259 件（`blue` 131 + `ScSc----` 128），**堵死**。
  - `miner#16614→mixer#17340.color`：55 格，87 件 `blue`，`boundAcceptor=null` ⇒ **死库存**。
  - `stacker#14684→rotater#14685→hub`：1+1 格，**0 件**。

### 3.4 18 个 ejector 全部 `progress=1`（满载冻结）

`items.ejectors` 18 条，**18/18 `progress=1`** —— 机器都做好了下一件，吐不出去。
其中 **11 台矿机的输出格是空地**（矿机在挖、但没人接）：#16586/#16587/#16597/#17119/#17121/
#17122/#17287/#17644/#17120 全部，外加 #16615(green) 和 #17644(CuCuCuCu)。

⇒ 「17 台矿机」里**真正接着带子的只有 6 台**（#15044/46/13 红、#16204 蓝、#16614 蓝、#16234 绿、#12445 红）。

---

## 4. 最少要造什么：机器清单

### 4.1 solver 结果（按要求跑，未手推）

```
$ node research/ai-player/proto/solver.mjs "CwCwCwCw" --colors red,green,blue --max-states 400000
目标: CwCwCwCw
  [d0] mine  →  CuCuCuCu
  [d0] mineColor {"color":"blue"}   [d0] mineColor {"color":"green"}
  [d0] mix {"color":"cyan"}  ← [blue, green]
  [d0] mineColor {"color":"red"}
  [d0] mix {"color":"white"} ← [cyan, red]
  [d1] paint {"color":"white"} ← [CuCuCuCu, color:white] → CwCwCwCw
运算计数: mine×1 mineColor×3 mix×2 paint×1
```

```
$ node research/ai-player/proto/solver.mjs "CbCbCbRb" --colors red,green,blue --max-states 400000
❌ 无法构造 CbCbCbRb（深度 7，状态上限 400000）
   已知形状 400001，生成 52800，配对 396385
   （触到状态上限，可加 --max-states 或 --depth）
```

⚠️ **capped ≠ impossible**。收窄到只用本图近距离真有的原料后，它 **200ms 内就解出来了**：

```
$ node research/ai-player/proto/solver.mjs "CbCbCbRb" --colors blue --resources C,R --no-cutquad --max-states 200000 --depth 8
  [d0] mine → RuRuRuRu        [d1] cut {"half":"right"} → RuRu----
  [d0] mine → CuCuCuCu        [d1] cut {"half":"left"}  → ----CuCu
  [d1] stack  ← [RuRu----, ----CuCu]  → RuRuCuCu
  [d2] rotate {"dir":"ccw"}   → RuCuCuRu
  [d3] cut {"half":"left"}    → ----CuRu
  [d1] cut {"half":"right"} → CuCu----
  [d3] stack ← [----CuRu, CuCu----] → CuCuCuRu
  [d4] paint {"color":"blue"} → CbCbCbRb
运算计数: mine×2 cut×4 stack×2 rotate×1 mineColor×1 paint×1
```

`--no-cutquad` 是因为 **cutQuad 是 L16 才解锁**（`modes/levels.js:285` 的 `reward_cutter_quad`），
而当前 `level=12`。这台机器 **不能假设它可用**。

### 4.2 只要 CW 的等价路线（现有唯一的 rotater 就是 CW）

solver 给了 CCW，但 `rotateCCW` 需要另一台变体（code 12）。我用 shape-ops 验证了
**纯 CW 也能走通**（全部实测 ✅，见 §1 的调用）：

```
（铜 @12 格）  C1 cut(CuCuCuCu) 出口[1] → CuCu----
              R1 CW(CuCu----)        → --CuCu--
              C2 cut(--CuCu--)[0]    → ----Cu--
（钌 @8 格）  C3 cut(RuRuRuRu) 出口[1] → RuRu----
              R2 CW(----RuRu)        → Ru----Ru
              C4 cut(Ru----Ru)[0]    → ------Ru
              S1 stack(CuCu----, ----Cu--)  = CuCuCu--
              S2 stack(CuCuCu--, ------Ru)  = CuCuCuRu
              P1 paint(blue)                = CbCbCbRb
（铜再取一份）P2 paint(white)               = CwCwCwCw
              S3 stack(CbCbCbRb, CwCwCwCw)  = GOAL
```

⚠️ 注意 cutter 槽序 —— 记忆里有过「源码推理 vs 真机相反」的事故
（`cutter-slot-order-live-wins`：真机 slot0=后半、slot1=前半）。上面写的是
**shape-ops 语义下的 `cutHalf(...)[i]`**；落到真机接线时要按 `ejectors` 的
`slot`+`item` 实测对，不要照抄下标。

### 4.3 机器清单（目标 1000 件）

| 工序 | 数量 | 现有 | 差 |
|---|---|---|---|
| cutter（半切） | **4** | 3（#13544/#16598/#13369，其中 #53369 是空壳、#16598 来料类型错） | **+1**（3 台里只有 1 台能用） |
| rotater（CW 变体） | **2** | 1（#14685，CW） | **+1** |
| stacker | **3** | 1（#14684） | **+2** |
| painter | **2** | 2（#13552/#14687，都在但都缺 color 槽） | 0（接线） |
| mixer（cyan→white 两级） | **2** | 4（**0 台可用**） | 0（接线/补料） |
| miner | 4 台（2 铜 + 1 钌 + 2 颜料）、**加 white 链要 3 色各 1** | 17（**11 台输出格空地**） | 0（接线） |

**做 white 那条支线只用 1 台 painter + 2 台 mixer + 3 台颜料矿机**（红绿蓝各一）。
世界里有 6 台蓝矿机、3 台绿矿机、4 台红矿机 ⇒ **颜料矿机够，且有余**。

### 4.4 捷径（可选，不推荐）

`CuCuRuCu` 矿（114 格，最近 254 格）染色后 CW 一次就是底层 `CbCbCbRb`（实测 ✅）。
这样 **只要 1 台 stacker（做二层）+ 1 台 painter + 1 台 cutter**。
代价：约 250 格带子 + 一台矿机要挪 254 格。在 90% 空闲的施工区里铺得下，
但会立刻撞上 §5 的门。

---

## 5. 一句话判定 + 缺什么

### 判定：**做得到**（代数成立、原料够、空间够、机器种类够）。

**缺的三样，按重要性排序：**

1. **接线**（不是机器）。4 台 mixer 没有一台两槽有料；2 台 painter 的 color 槽都是空地；
   11 台矿机的输出格是空地；31 条链之间 **0 个合并点**。
   这一项是**当前 100% 的阻塞**。
2. **2 台 stacker + 1 台 rotater**（真正的机器缺口）。
   3 台 stacker 才能做完「两段叠一层 + 盖顶」；1 台 rotater 不够两条支线同时用。
3. **产能**。见下。

### 缺不缺矿？不缺。缺不缺空间？不缺。

- 颜料矿：red/green/blue 共 5865 格，最近 12～44 格。white **必须混、不需要矿**。
- 形状矿：`CuCuCuCu`(12)/`RuRuRuRu`(8) 近在 hub 旁 —— 目标的两层**只用这两种**就够。
- 空间：施工区 90% 空闲。

### 但产能是硬墙（和 `GOAL-IS-OUT-OF-BUDGET.md` 一致，我复核了升级后的数字）

`upgrade_levels = {belt:1, miner:2, processors:0, painting:1}` ⇒
`upgradeImprovements = {belt:1.5, miner:2, processors:1, painting:1.5}` ⇒

| 机器 | 实际速率 |
|---|---|
| belt | 3.0 /s |
| miner | 0.8 /s |
| painter | **0.5 /s**（2×1.5/6） |
| mixer | 0.6 /s（2×1.5/5） |
| cutter | 0.5 /s |
| **stacker** | **0.25 /s** ← 最窄 |
| rotater | 2 /s |

1000 件：3 次 stacker 串行 = **200 分钟**；即使 3 台各管一段也要 **66.7 分钟**。
每轮只推进 40 游戏秒 ⇒ **≥100 轮满额**（而实测这个 run `tx_count=0`）。

⇒ **「能不能做」和「这套预算能不能跑完」是两个问题。** 这条链存在不等于它会被建出来。

---

## 6. 反证：我的结论可能在哪儿错

**最可能推翻「做得到」的观察：**

1. **`cutter` 的 slot 语义。** 我用的是 `shape-ops.mjs` 的 `cutHalf()` 下标，
   而记忆 `cutter-slot-order-live-wins` 明确记录过**真机 slot0 = 后半、slot1 = 前半，
   与源码推理相反**。如果真机上「出口[1]」不是我以为的那一半，§4 的 4 台 cutter 路线要重排
   （但**不会变成不可能** —— 两个出口都在，只是走线换一边，可能要多切一次）。
   **检验方式**：读任意一台 cutter 的 `items.ejectors` 的 `{slot, item}`，两次就定案。

2. **`--no-cutquad` 的必要性。** 我按 `levels.js:285` 判定 cutQuad 是 L16 奖励、
   L12 不可用。如果这个存档的 `gainedRewards` 里意外有 `reward_cutter_quad`
   （比如从别的关跳关/作弊存档），那 cutter 可以少一半、路线会短。
   **检验方式**：`obs` 里 cutter 实体的 `code` —— code 10 是 quad 变体，
   现有 3 台全是 code 9 ⇒ 这个观察**不成立**，我的判定是对的。

3. **`CuCuRuCu` 那条捷径的可行性。** 我按「254 格曼哈顿」算，但真实布线路由要绕过
   已有的 699 条带子和 20 个 trash，实际长度会更大。若那条路被完全挡死，
   §4.4 的捷径作废 —— 但 §4.2 的纯近距路线不依赖它，**判定不变**。

4. **`region` 只覆盖 [-15,-54,90,17]，而矿表覆盖 [-256,256]。**
   `obs.stats` 基于**全量实体**（mod 的 `statsByType` 在区域过滤前统计，见
   `observe()` 的注释「stats 永远基于全量」），`entity_count=749` 与 `total=749` 一致 ⇒
   **机器数量是全图的，不是窗口内的**。这一条我核过源码，不构成风险。

5. **最该警惕的一条：我把「机器种类够」当成了「做得到」。**
   如果 1000 件的产能门槛在预算内根本过不去（§5），那「做得到」是个
   在工程上无意义的答案。**这才是最可能被推翻的地方** —— 推翻它的观察是
   「跑满 100+ 轮满额 tx」，而实测是 0。

---

## 附：本次核验用到的调用（可复现）

```bash
node research/ai-player/proto/solver.mjs "CwCwCwCw" --colors red,green,blue --max-states 400000
node research/ai-player/proto/solver.mjs "CbCbCbRb" --colors red,green,blue --max-states 400000        # capped
node research/ai-player/proto/solver.mjs "CbCbCbRb" --colors blue --resources C,R --no-cutquad --depth 8  # 200ms 解出
```

形状代数全部走 `shape-ops.mjs`（`parse/hash/cutHalf/rotateCW/rotateCCW/stack/paint`）；
混色表直接 `import` 游戏源码 `colors.js` 的 `enumColorMixingResults`。
槽位几何走 `src/agent/verify_runtime.mjs` 的 `slotsOf` + `src/ai/op-templates.mjs` 的模板，
判定规则对照 `item_acceptor.js:108-125`、`belt_path.js:104-110 / 236-255`、`item_ejector.js:78-135`。
