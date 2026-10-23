# P3 `placer` — NOTES.md

接管现场：上一任死在中途写入 —— `src/ai/compiler/place.mjs` 是 881 行的**语法不完整文件**
（末尾悬空、被截断）。第一笔操作即用语法完整、可 `node --check` 的骨架整体替换，
之后每段 Edit 后跑 `node --check`，全程盘上文件合法。测试目录 `research/ai-plan/placer/` 新建。

最终：`node research/ai-plan/placer/test.mjs` → **78 断言全绿**（含四张金网格逐字节 +
planChannel 逐形态 + 负例 + 契约 + 裁决落地 G1/G7/G10/K1 + import lint + node --check）。

---

## 一、与 P1 fixtures 对齐的三条口径（N-1，读 report-layout.json / plan-l1.json 逐格核对得到）

这三条不是我自己拍的，是从 P1 已入库的两个 fixture **反推**出来的读法，写死在文件头注释里：

1. **坐标不平移**：`bbox = [maxX-minX+1, maxY-minY+1]`，grid 第 i 行 ↔ `y = minY + i`，**允许负 y**
   （report-layout.json 的 trash 在 y=-1、plan-l1 的 hub 口在 y=-1 —— 若平移原点就逐字节对不上）。
2. `channels[].from/to.cell` = **机器槽位的绝对格**（不是带子格）；且 **slot === outDir/inDir**（= 槽位朝向）。
   带子几何量在内部换算：`first = add(fromCell, outDir)`、`last = add(toCell, inDir)`、`d2 = OPP[inDir]`。
   这条在 test ③ 用 fixture 反向核对（`fixture channels 的 slot 与 outDir/inDir 同值`）。
3. `hubConnection.entry` = `hubEntriesWorld()` 返回的 `cell`（带子末格），`side` = `face`（贴的 hub 边），
   `dir` = 带子流向角。hub 槽格 = `add(entry, ANGLE_DIR[dir])`，其 acceptor 方位 = `side`。

**金网格是本包生成的快照，不是抄 P1 fixture**：P1 的 `plan-l1.json.grid` 是「形状示意」
（plan §2.7 原话，且它的 ROW_H/锚点与本包不同），逐字节对不上是正常的。本包的 G1/G2/G3 是
**当前实现输出的字节锁** —— 一旦几何改动破坏了「全竖直零拐角 / 恰 2 拐角 / 垂直进料通道」，
逐字节断言就变红。M4 语义凭据（'7' 角 → solveTurn r0/rv1、'9' 角 → r270/rv2）单独用 test ② 的
不变式锁死，与 fixture 同源。

## 二、多层（scope.layers）的裁决口径（见 CONTEST C-1，这里是实现口径）

- stacker **单次合成**（2 个非堆叠上游 → 1 个 2 层形状，如 `CuCuSuSu:RuRuCuCu`）是 v1 支持的
  （M4 实机验证过），其输出 hash 含 ':' **合法**（P1 report-layout.json 就这么写）。**不拒**。
  → 早先我误把「hash 含 ':'」当多层拒绝，会误杀 gold ②，已改成只看**结构**。
- 真正越界的是 **堆叠机产物再进堆叠机**（嵌套 stack ⇒ ≥2 合成级）。这是唯一能用 v1 op 集表达、
  又确实超出 `scope.layers:1` 的形态 → `out-of-scope:multilayer`（gold ④ 走这条，见 CONTEST）。

## 三、车道（lane）与 P4 的接缝

- 本包只**选一个可行车道行/列**用于算格与拐角数；真正的 left-edge 分配归 P4（执行书 + routing-prior-art §8）。
  `channels[].lane`：straight/elbow/degenerate = `null`，z/z-col = 数字。每条非空 lane 都同步进 `lanes[]`
  （满足 P4 NOTES R-2 要求的 `channels[].lane ⟺ lanes[].row` 互逆）。
- `ordinal` 在同一 `(from,to)` 内**唯一**（test ② 末「ordinal 唯一」三连锁）：P4 用 `from→to#ordinal`
  派生 channelId（router NOTES R-5），撞号会被 P4 记成同一 id。本包按槽序 index 出 ordinal，天然不撞。
- **两条 Z 撞同一车道行** → 上报 `conflicts[lane-column]` 并保留几何（不静默），加宽 `rowGap/colGap`
  重试清零（test ②「加宽后重试」）。这正是 plan §1.3 验收「同一列被两条通道要求 → 报 conflict 并加宽重试」的落地。

## 四、trash（mustDiscardUnused / 陷阱表 #7）

- 未用输出槽自动接 trash；候选顺序 = ① 直串外推（零拐角优先）② 侧让（撞路时 trash 挪到带子首格垂直侧，
  首格成为 1 拐角，拐角**如实计入 cornerCount**，非静默近似）。每个候选都要「落子 + route」都成立才 commit，
  撞路则快照/回滚换下一候选 —— 绝不留下半成品（C1 整单 abort 精神）。
- **顶层产出优先喂 hub，再轮到 trash**（8.2 在 8.3 前）。顺序颠倒会让同一输出口被 route 两次（一次 hub 一次 trash）
  —— 这是我修掉的**本包真 bug**（曾导致 gold ③ 连 hub 时 hub 16 口全接不上）。

## 五、G7（象限断言）落点

- 所有进本包的角度都过 `assertQuadrantAngle`：`args.angle/rot/rotation/rotationVariant`（脏角 → `out-of-scope:rotated-machine`）、
  `hubEntriesWorld` 的 `dir`（脏 → 结构化抛错）。**刻意不量化不截断**：belt-rules 的 rotateLocal 是截断、
  angleToDir 是量化，语义不同（NOTES G7 的由来）；gold ④ 的 `args.angle:45` 被拒是这条的锁。

## 六、别人包的现场（只点名，不动）

- **op-templates `--test` 夹带（主线程 f7f7a2d 已修，本包从 P3 侧复证）**：本包静态 import op-templates.mjs，
  实测**零夹带输出**；且用探针注入一个红灯后 `process.exitCode=1` 不被洗绿。→ 本包**没有**为夹带写过任何
  输出剔除/计数补偿（grep 全文件确认），符合主线程要求①②。
- **world.mjs `nearestResource` 的 shape 参数**：文档签名写 `shape`，实际接受谓词；本包传 `s => s === want` 可用，
  但 `findResource` 的第二参在 README 里叫 `shape` 却要求 `region` 必给（世界无限）—— 本包已用 `regionAround` 兜住，
  仅作记录，非 bug。
