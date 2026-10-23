# belt-rules.mjs 独立验证复核

> 验证专家 Agent 对 `src/ai/belt-rules.mjs`（传送带方向规则库）的独立复核。
> 纪律：不轻信"穷举全对"，区分**恒等式**与**可证伪判据**。纯离线，未碰游戏/git。
> 结论：**几何与旋转约定全部正确**，原验证的"自洽"确有其局限，但结论本身站得住。
> 新增可证伪测试 17 条全部通过（`src/ai/belt-rules.test.mjs`）。

---

## 0. 一句话结论

`belt-rules.mjs` 的 `EXIT_LOCAL={0:top,1:left,2:right}`、"入口恒局部 bottom"、
`rotateLocal`（顺时针、y 向下）三条约定，经**上游源码三处独立佐证 + 真实存档邻居拓扑
可证伪判据**确认**正确**。原验证（`validate-belt-rules.mjs`）的恒等式性质确实无法证伪
旋转手性，我补做了能证伪的拓扑对照测试并全部通过。**唯一需要修的是文档措辞**（见 §6），
代码无需改动。

---

## 1. 局部几何：与源码一致吗？——一致（geometry_confirms）

rv0/1/2 的**局部**入口边与出口边，从三处相互独立的上游源码锁定：

| 依据 | 文件:行号 | 内容 | 与 belt-rules 是否一致 |
|---|---|---|---|
| 出口局部表 | `recon/upstream-full/src/js/game/buildings/belt.js:12` | `arrayBeltVariantToRotation = [top, left, right]` | ✅ `EXIT_LOCAL={0:top,1:left,2:right}` 逐字相同 |
| 出口赋值时机 | `belt.js:148`（`updateVariants`） | `entity.components.Belt.direction = arrayBeltVariantToRotation[rotationVariant]` | ✅ rv→Belt.direction 就是这个数组 |
| 入口局部恒 bottom | `recon/upstream-full/src/js/game/components/belt.js:9-12` | `FAKE_BELT_ACCEPTOR_SLOT = { pos:(0,0), direction: bottom }` | ✅ `beltEntry` 一律旋转局部 `bottom` |
| 出口=direction | `components/belt.js:14-36` | `FAKE_BELT_EJECTOR_SLOT_BY_DIRECTION[direction].direction = direction` | ✅ `Belt.direction`（即 EXIT_LOCAL[rv]）就是出口 |
| **物理走货轨迹** | `components/belt.js:101-122`（`transformBeltToLocalSpace`） | top：`y=0.5-progress`（从下往上走，入口 0.5 处=下、出口=上）；right：`(0.5→? , 0.5→-0.5)`；left：`(-0.5→? ,0.5→-0.5)` | ✅ **铁证**：三种 direction 的 item 都**从局部 bottom 端进入、从 EXIT_LOCAL 端离开** |
| code=1+rv | `belt.js:25-43`（`getAllVariantCombinations`） | internalId 1/2/3 ↔ rotationVariant 0/1/2 | ✅ `beltCode = 1 + rv` |
| 局部帧→世界帧 | `belt.js:161-165` | `topDirection=angleToDir(rotation)`、right=+90、bottom=+180、left=+270 | ✅ 与 `rotateLocal`/`angleToDir` 完全同构 |

**关键澄清**：弯带的入与出是**垂直**关系（不是相反）。`components/belt.js:113-116` 的 left/right 轨迹
起点都在 `y=0.5`（局部 bottom）、终点在 `y=-0.5` 且 `x=±0.5`（局部左/右），与 `belt-rules.mjs:32-35`
的注释"入口方向必须直接旋转局部 bottom，不能用 OPP[exit]"完全吻合。`belt.js:161` 的
`computeOptimalDirectionAndRotationVariantAtTile` 里 `rotation+90`（rv1）/`rotation+270`（rv2）
只是**摆放启发式**（根据邻居改写用户拖拽角度），不改变"rv→局部几何"的映射本身。

**判定：geometry_confirms = 一致，无错误。**

---

## 2. 识破穷举验证的局限（原验证确实证明力不足）

原 `validate-belt-rules.mjs` 声称"1906 条 `solveTurn(beltEntry(beltExit))==存档值` 全对"。
经核：

- `beltEntry/beltExit/solveTurn` 都建立**同一个** `rotateLocal`。
- `solveTurn` 的定义（`belt-rules.mjs:42-53`）就是"枚举 (rot,rv) 使 `beltEntry==in && beltExit==out`"，
  因此对任意存档值 `solveTurn(beltEntry(rv,r), beltExit(rv,r))` **必然**返回 `(r,rv)`
  （除非该 (rot,rv) 不是扫描顺序下第一个匹配者，而它是）——这是**恒等式/左逆**，
  **不依赖 rotateLocal 的手性对不对，也不依赖 EXIT_LOCAL 的具体取值对不对**。
  把 `rotateLocal` 改成逆时针、或把 EXIT_LOCAL 的 rv1/rv2 互换，恒等式**照样全对**。
- 原脚本 `[B] 链闭合 1267 对/1 错`（validate-belt-rules.mjs:99-114）这一项**其实是有价值的**
  邻居拓扑判据（用了 `grid.get(邻居)` 的真实 `entryWorld`），但它在 :110 写了一个**自我抵消的
  冗余布尔表达式** `if ((x+dx+exx) === x+dx-(x-(x+dx)) || nEntry===OPP[ex])` —— 左半边
  `x+dx+exx === x+dx` 恒假（除非 exx 恒 0），实际靠右半边 `nEntry===OPP[ex]` 生效，**结论侥幸对**，
  但代码可读性/可信度差，且没有对照组，无法证明 1267 不是"任何错误几何也能凑出的巧合"。

**⇒ 恒等式不能证伪手性，必须换判据。这正是 §3 做的。**

---

## 3. 可证伪判据：邻居拓扑 + 对照组（rotation_direction_verdict）

### 3.1 独立判据的设计前提

存档里每条带子的**最终** `(rotation, rotationVariant)` 是游戏按**正确**局部几何摆放/渲染/走货的结果。
- **下游闭合**：若本带出口世界方向为 `e`，则 `(x+dx(e), y+dy(e))` 上的带子（若存在且真连线）
  其入边世界方向应为 `OPP[e]`。
- **双侧闭合（最强）**：弯带（rv≠0）同时有"上游邻居"（在本带入边方位、且其出口指向本带）
  和"下游邻居"（在本带出口方位、且其入边接本带）时，两个条件必须**同时**成立。

判据成立的前提：(a) 存档是游戏真实产物；(b) 用 y 向下的世界网格坐标；(c) `DIRV` 把方位映射到位移。

### 3.2 实测结果（真实存档快照 `facts/live/world-full.json`，1906 条带子）

> 用同一份存档的**已提交快照**（不带 originalRotation，但 rv/rotation/type/坐标齐全，
> 1906 条带子，单一 regular 层），可在任意机器确定性复现，已写进测试。

| 假设（几何 / 手性） | 下游闭合 | 弯带双侧闭合 | 判定 |
|---|---|---|---|
| **H1 当前实现**（顺时针，EXIT={top,left,right}） | **1267/1268 (99.9%)** | **69/69 (100%)** | ✅ 正确 |
| H2 手性取逆（逆时针） | 1071/1311 (81.7%) | **0/51** | ❌ 崩 |
| H3 交换 rv1↔rv2 | 1110/1290 (86.0%) | **0/24** | ❌ 崩 |
| H4 交换+逆时针 | 1166/1305 (89.3%) | 14/36 | ❌ 差 |
| H5 rv0 出口=bottom（入口出口反向假设） | 157/1314 (11.9%) | 12/69 | ❌ 崩 |

**对照组数字直接证伪了"手性无所谓"的担心**：一旦把旋转取逆或交换 rv1/rv2，
最强的双侧判据从 **69/69 断崖跌到 0/51、0/24**。只有当前实现两侧都 100% 闭合。
1267/1268 不是巧合——它对手性高度敏感。

### 3.3 originalRotation 旁证（对齐 belt.js 分支，独立于手性）

直接从存档 `rotation - originalRotation` 的分布（弯带），对齐 `belt.js:210/216` 的 `+270/+90`：

- rv0（1487 条）：差值 100% = 0（直带从不被启发式改写角度）。
- rv1（223 条）：差值 ∈ {0 (51), **90 (172)**} —— 对应 belt.js:216 `rotation+90, rv1`。
- rv2（196 条）：差值 ∈ {0 (90), **270 (106)**} —— 对应 belt.js:210 `rotation+270, rv2`。

差值只可能是源码里那两个常数，**没有出现 +270 落在 rv1、+90 落在 rv2 的情况**，
从摆放启发式分支侧再次确认 rv1↔left、rv2↔right 的分配方向没反。已固化为测试（依赖本地存档，
无存档时自动 `skip`，不影响快照判据）。

### 3.4 那唯一 1/1268 的不闭合

带子 (28,71) `r90 rv0`（水平、向东喷），下游 (29,71) `r0 rv0`（竖直、向北走、入边朝下/南）。
即一条**水平线撞上竖直线段的中部**，是两条**独立未连线**的带子路径的 T 型交叉，不是几何错误——
游戏 `logic` 系统本就不会把 (28,71) 的东向 ejector 接到 (29,71) 南向 acceptor。
**文档把它归因为"与地下带重叠"（`belt-rules.mjs:7`、`validate-belt-rules.mjs` 注释）对这条样本并不准确**，
实为正交独立路径交叉（见 §6 文档修订）。

---

## 4. 旋转方向约定（点 4）：全部源码佐证

| 维度 | belt-rules 约定 | 上游源码 | 一致 |
|---|---|---|---|
| 世界 y 轴 | **向下**（`DIRV.top=[0,-1]`） | `core/vector.js:686` `enumDirectionToVector.top = new Vector(0,-1)` | ✅ |
| rotation 增大 | **顺时针**（`rotateLocal` 索引 +steps） | `core/vector.js:40-45` `enumAngleToDirection` 0→top,90→right（top→right 即顺时针） | ✅ |
| 渲染矩阵旋转 | 顺时针 | `core/utils.js:561-573` `rotateFlatMatrix3x3`（索引 `[6,3,0,7,4,1,8,5,2]`）作用于 `generateMatrixRotations` 的 90/180/270（`utils.js:580-595`），是 y-向下坐标系下的**顺时针** | ✅ |
| top/right/bottom/left 角度 | `ORDER=[top,right,bottom,left]`，×90 | `enumDirectionToAngle` `vector.js:30-35` 同值 | ✅ |

三处独立佐证（vector 枚举、vector 单位向量、render 矩阵）互洽，且与 §3 的存档拓扑一致。
**旋转方向约定 = 正确。**

---

## 5. 边界 / 退化 / 自测钩子（self_test_bug）

### 5.1 `solveTurn` 退化（已固化为测试）
- **同向 in==out**：`solveTurn` 第 43 行先 `if (inDir===outDir) return null`，4 个同向对返回 null。✅
  语义正确：单格带子**不可能**做 180° U 型掉头（入口出口反向的直带是 `top/bottom` 这种 in≠out）。
  12 个 in≠out 组合中，4 个是直线（rv0，入出恰好反向）、8 个是直角弯，**全部有唯一解**。
- **无歧义**：对 12 个有效 (in,out) 各扫描 `rv∈{0,1,2}×rot∈{0,90,180,270}`，**恰有 1 个**匹配
  （实测 `MULTISOL: none`）。扫描顺序 rv0→1→2 × rot0→270 不会"撞上非预期那个"。✅
- **180° 掉头**：belt 不可能（见上），返回 null 正确。

### 5.2 归一化（已固化为测试）
- `norm360(-90)=270`、`norm360(450)=90`、`norm360(720)=0`；`beltExit(2,-90)==beltExit(2,270)` 等。✅
- ⚠ **潜在小坑（非 bug，但值得文档化）**：`angleToDir`（`belt-rules.mjs:21`）= `ORDER[norm360(a)/90]`，
  若喂入**非 90 倍数**的角度（如 30），`norm360(30)/90 = 0.333` → `ORDER[0.333] === undefined`。
  `rotateLocal`（:26）同理用 `norm360(rotation)/90 | 0` 有 `|0` 兜底取整，但 `angleToDir` **没有**。
  当前编译器只喂 0/90/180/270，不触发；但若将来传入任意角度，`angleToDir` 会静默返回 `undefined`。
  属**健壮性提示**，见 §6 可选加固建议。

### 5.3 自测钩子文件名判定——**无 bug（正确）**

质疑："自测块判定写的是 `ai/belt-rules.mjs`，但 `belt-rules.test.mjs` import 它时不该触发"。
实测三条：

1. `process.argv[1]` 在 `node src/ai/belt-rules.mjs`、`node ./src/ai/belt-rules.mjs`、
   **在 `src/ai` 目录里 `node belt-rules.mjs`** 三种调用下**都被解析成绝对路径**
   `D:/…/src/ai/belt-rules.mjs`（用探针脚本验证），故 `…endsWith("ai/belt-rules.mjs")`
   恒为真 → **直接运行一定触发自测**（10 条全 ✓，exit 0）。✅
2. 作为模块被 `import`（无论文件名是否叫 `belt-rules.test.mjs`）时，`process.argv[1]` 指向的是
   **入口脚本**而非被 import 的库，故 `endsWith("ai/belt-rules.mjs")` 为假 → **自测不触发**。
   实测：`node src/ai/belt-rules.test.mjs`（直接 import 不跑 node:test）输出里**没有**自测的 ✓ 行。✅
3. 结论：**判定逻辑正确，没有"该静默却触发"或"该触发却静默"的 bug**。
   唯一**真实**问题不在 src/ai 的这份：仓库里曾有 `research/ai-player/proto/belt-rules.mjs` 副本，
   其自测钩子判定（同样匹配 `ai/belt-rules.mjs`）对 `proto/` 目录下的文件**永不匹配**——
   即那份 proto 副本直接运行时**自测被静默跳过**（我实测 proto 副本 `node …/proto/belt-rules.mjs` 无自测输出）。
   该副本在复核期间已被主线程移除（`src/ai/belt-rules.mjs` 为唯一权威份），此隐患**随之消失**，
   仅作"为什么用绝对路径/endsWith 要小心目录前缀"的历史记录。

---

## 6. 修改建议（代码无需改；文档与可选健壮性）

**A. 代码：无需修改。** `src/ai/belt-rules.mjs` 几何、手性、code、退化、归一、自测钩子全部正确。

**B. 文档措辞修正（建议主线程定夺，我没动源码）：**
- `src/ai/belt-rules.mjs:7` 注释"1 错（离群：与地下带重叠）"——该离群样本实为**两条正交独立带子的
  T 型交叉**（(28,71)→(29,71)），与地下带无关。建议改为"1 对不闭合：正交独立路径的 T 型交叉，非连线"。

**C. 可选健壮性加固（非必须，当前无调用方触发）：**
若想让 `angleToDir` 对任意角度更稳，可加 `|0`/取整兜底（与 `rotateLocal` 对齐）。精确 diff 建议：

```diff
- export const angleToDir = a => ORDER[norm360(a) / 90];
+ export const angleToDir = a => ORDER[((norm360(a) / 90) | 0)];   // 与 rotateLocal 一致的取整兜底
```
（注意：这会把 30→top（0.33→0）、但 89→top 而非 right；若语义应是"最近档位"则应 `Math.round`。
当前仅 90 倍数输入，二者等价。建议**保持现状**或加一行注释声明"输入必须是 0/90/180/270"。）

---

## 7. 新增测试清单（new_tests_added，全在 `src/ai/belt-rules.test.mjs`，node:test）

16 通过 + 1 条件跳过（无本地存档时）。原验证只覆盖了恒等式；以下均可证伪：

1. `DIRV` 对齐 enumDirectionToVector（y 向下）。
2. `angleToDir`/`dirToAngle` 对齐 enumAngleToDirection。
3. `rotateLocal` 顺时针手性（top--90→right）。
4. `EXIT_LOCAL` 逐字对齐 arrayBeltVariantToRotation。
5. `beltCode = 1+rv`。
6. 入口恒 bottom、出口按 EXIT_LOCAL 旋转（含 rv 无关入口）。
7. **solveTurn 12 个 in≠out 全表 + 回代自洽**。
8. solveTurn 同向（=180°掉头）→ null。
9. solveTurn **无歧义**（每对恰 1 解，扫描顺序无关）。
10. 归一化负/超界 rotation。
11. **存档完整性护栏**：rv 分布 == {0:1487,1:223,2:196}。
12. ★ **邻居拓扑下游闭合 == 1267/1268**（真实快照，可证伪）。
13. ★ **弯带双侧闭合 == 69/69**（最强独立判据）。
14. ★ **对照：交换 rv1↔rv2 → 双侧崩到 <20**（证伪 rv 分配）。
15. ★ **对照：手性取逆 → 双侧 == 0/51**（证伪旋转手性）。
16. ★ **相对判据：当前实现严格优于两个对照组**。
17. originalRotation 旁证（rv1∈{0,90}、rv2∈{0,270}，对齐 belt.js 分支）——无存档时 skip。

**运行**：`node --test src/ai/belt-rules.test.mjs`（已实跑，17 pass / 0 fail）。

---

## verdict

**correct** —— `src/ai/belt-rules.mjs` 的方向约定（rv0/1/2 局部入出边、EXIT_LOCAL、
入口恒 bottom、rotateLocal 顺时针、y 向下、code=1+rv）经源码三处独立佐证 + 真实存档
邻居拓扑可证伪判据（含交换 rv1/rv2 与逆时针两个对照组，均显著劣于当前实现）确认**正确**。
原"穷举恒等式"验证确有证明力局限，但该局限不影响结论；已补做能证伪的测试。
**仅文档一处措辞（地下带→正交 T 型交叉）建议修正，代码不需改。**
