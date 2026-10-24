# P4 router — NOTES.md

接管现场：前任死在最后一公里（128 断言全绿、缺 ⑬）。本包按执行书要求把绿测试当**草稿**重挣：
plan §1.4 验收逐条亲自重跑 + **18 组变异测试**（`node research/ai-plan/router/mutate.mjs`）。
结果：**18/18 变异全部被抓（0 存活）**，主测试 **184 条断言全绿**。

变异过程揪出 **3 个真 bug**（已修，各配一条锁）与 **1 个等价变异陷阱**（记为方法论）。

---

## R-1【已修 · 契约洞】`ok:false` 时 `reason` 可以是 `null`

`routeAll` 原来：

```js
const reason = lane.ok ? (failures.length ? failures[0].reason : null) : lane.reason;
const ok = lane.ok && failures.length === 0 && counter.length === 0;
```

`counter.length > 0`（陷阱 #1 同格对向的产出锁）能让 `ok=false`，但它**不参与 reason 的推导** →
产出 `{ok:false, reason:null}`。`types.mjs:396` 明写「!ok 时 reason 必填（§2.5 枚举）」，
`assertCompiledPlan` 会拒；P8 分诊表（§2.5）拿到 null 无法归因。

- **可达输入**：两条 `channelId` 相同、端点相同而 payload 不同的通道（= P3 的 `ordinal` 撞号）。
  车道阶段按 id 记账看不见重复，route 阶段两股流落在同一批格上 → `counter` 命中。
  实测：`lane.ok=true / failures=0 / counter=15`，`reason=null`。
- **修法**：reason 优先级改为 `lane 判死 > 单通道铺格失败 > counter 回归锁`，
  counter 分支给 `dag-not-placeable:crossing-needs-tunnel`（两股流对向 = 只能隧道分层，
  v1 `scope.tunnels:false` → 显式拒绝），并补 `failingNode`（原来也是 null）。
- **锁**：⑤ 节「同 id 双通道 → counter 分支可达（非死代码）」三连；变异锁 **M-18**。

## R-2【已修 · ⑬ 互逆】未落车道的通道保留 P3 的陈旧 `lane` 数字

`assignLanes` 原来只覆盖「本次分配出行号」的通道，其余原样透传。
P3 若给 `straight` 形态留了 `lane:7`，输出报告就成了
`channels[0].lane===7` 而 `lanes[]===[]` —— **`channels[].lane` ⟺ `lanes[]` 的 row 互逆被破坏**。
`types.assertLayoutReport` 抓不到（它只查 `lanes[].row` 唯一，不反查 channels），
所以这份自相矛盾会流向 P5 的 V4/V6 与 P6 的排序凭据。

- **修法**：未落定车道行一律回写 `lane:null`。
- **锁**：⑬-C「陈旧 lane:7 被回写 null」+ 全局互逆不变式；变异锁 **M-14**。
- **诚实口径**：`place.mjs:823` 现在给非 z/z-col 形态填的是 `lane:null`，
  所以这条**当前不是 P3 的在跑 bug**，是 P4 对契约的加固（P3 一改口径就会被咬到）。

## R-3【已修 · 确定性】`leftEdge` 扫描序用 `localeCompare` 平局 = 跨机器不确定

`const order = [...].sort((a,b)=> a.lo-b.lo || a.hi-b.hi || String(a.id).localeCompare(String(b.id)))`
违反验收 7（确定性）。不是「看着像随机」那么简单：

- `channelIdOf`（lane.mjs:124）生成的 id 含 `#`/`@`/`[` 分隔符。ICU 权重表把这类标点排在
  码点序**之外**，实测 `mA->st#0` vs `mA->st@0`：`localeCompare=+1`，码点序 `-1` —— 结论相反。
- 平局决定的是**谁先占哪条车道行**（first-fit 的顺序语义），不是打印顺序
  → 换机器/换 ICU 会产出不同的 `lanes[]` 与不同的带子格集合，
  P5 的变异测试与 P7 的逐格 diff 直接崩。
- **修法**：改码点序 `cmpId`（`x<y?-1:x>y?1:0`）。
- **锁**：⑫ 节 grep 断言「lane.mjs 不用 localeCompare」+ 同段「#0 抢在 @0 前」的分配对拍；变异锁 **M-16**。

## R-4【方法论 · 等价变异】M-11 的第一版是**假**变异，不是测试失败

原 M-11 摘掉 pre-assigned 分支的 `inBand` 判据（`const inBand = true`），报「存活」。
实测是**等价变异**：出界的 row 必然穿过机器自身占地（竖直腿会经过源机器那一格），
`feasibleLane` 的 occupancy 判据早就把它拒了 → 摘与不摘**同结果**，任何测试都抓不到，
不是永绿断言。已换成真承重的变体（把两侧「前进半平面」同时翻转 → 带子只能倒着走），被抓。

配套教训：断言 band 只写「有界」(`band[0]<=band[1]`) 也抓不到翻转（翻转后仍有界）→
必须钉**字面值** `eq(g.band,[1,9])`。已在 ⑧ 节补。
⇒ 判「永绿」之前先判「可达」：不可达/等价的变异要换靶，不该拿去逼测试加空断言。

## R-5【信息 · 别的包，我不动】

1. **`place.mjs`（P3 重跑者在写，未碰）**：`channels[]` 无 `id` 字段（plan §7.3 只预留
   `slotRole`/`ordinal`），P4 只能用 `from->to#ordinal` 推导 id。**两条通道 `ordinal` 撞号会被
   P4 按同一 id 记账**（R-1 的可达输入就是它）。建议 P3 保证 `ordinal` 在同一 (from,to) 内唯一，
   或直接在 `channels[]` 里给显式 `id`（P1 加字段更干净）。
2. **`types.mjs`**：`assertLayoutReport` 不反查 `channels[].lane ⟺ lanes[]`（见 R-2）。
   加这条交叉一致性断言能把该洞从「P4 自觉」升级成「契约硬闸」，且能同时兜住 P3 的产出。
3. **`emit.mjs`/`roundtrip.mjs`（P6）与 `validate.mjs`/`belt-sim.mjs`（P5）**：目前**没有**任何
   文件 import `route.mjs`/`lane.mjs`（grep 零命中）。P4 的产出形状靠 ⑨ 节
   `assertCompiledEntity` + `entityOrderPhase` 自检，真接线在 P8 —— P8 落地时若发现口径不合，
   回来改 P4，不要就地重算方向。

## R-5b【已修 · v2 契约】vlane 从「默认拒绝」升为「契约一等车道」

**原缺口**：`lanes: Array<{row, channelIds}>` 里没有列字段，所以 `assignLanes` 对任何
**两端都水平**的通道（painter 右出 → hub 左缘，flowOut/goalOut 都是水平）一律判死
（`allowVerticalLane !== true` ⇒ `unresolvedChannels`）。后果：所有上色目标在上色器这一环
就断掉 —— 不是几何无解，是**契约装不下**。

**修法**（`LANE_SCHEMA_VERSION 1 → 2`，常量移到 `types.mjs`）：
- `lanes[]` 条目改成 `{row:number|null, column:number|null, channelIds:string[]}`，**恰一个**非 null；
  两个都给 / 都不给都是契约错（抛 `ContractViolation`，不静默择一）。
- `channels[].lane` 仍只装下标，轴由新增的 `channels[].laneAxis:"row"|"col"|null` 给出；
  **缺省按 `"row"` 读**（v1 报告永远合法），但 P4 的产出总是显式写轴。
- **判重键改成 `(轴, 下标)`**（`types.mjs` 的 lanes 判重、`validate.mjs` 的 V6 两处）。
  这是本次唯一的语义陷阱：row=3 与 column=3 是两条**正交**车道，用裸整数判重会把
  常见形态（收集带列号恰好等于某条水平车道行号）误报成交叉。

**反证**（不是永绿）：把 V6 的键改回裸整数 ⇒ `validator/test.mjs` B25 变红；关掉
`allowVerticalLane` ⇒ `router/test.mjs` ⑧ 的正面断言变红且背面（显式关闭必须判死）变绿。
变异锁 `M-20/21/22` 分别抓「写回丢轴」「关闭开关失效」「列号不进台账」，全部被抓。

## R-6【语义边界（不许越）】

②节 12 组恒等是 `rotateLocal` 的**左逆自洽**（同一套表自己映回自己），
红队 #1(1) 早指出这点。P4 **不据此声称验证了 rv 的物理语义**；
语义判据归 P5 `V3-belt-fixed-point`（含机器邻居的 computeBelt 不动点）与 P7 `L2-paste-corner`（实机）。
测试里那条 `say(true, "⚠️ 语义声明…")` 是**声明**不是断言，故意长绿 —— 它锁的是措辞，不是行为。

## 选型确认（执行书要的 `lane_algorithm`）

`routing-prior-art.md` §8 的选型（left-edge 车道 + 带朝向 Dijkstra，A\* 只兜底）**采纳无异议**，
已按 §8 落地顺序实现：lane.mjs = left-edge 首适（区间闭重叠 + vertical constraint 都算冲突），
route.mjs = 直线快路 + `dijkstraOriented` 兜底，三类不可行分开上报，无 RNG、无迭代优化。
一条补充：§8 支撑 1 说「父子保序 ⇒ 无 vertical constraint」——本实现仍把 C2 留作**显式判据**，
因为换轴（hlane/vlane 并存）时 C1 不再蕴含 C2；⑤ 节有构造样例锁它生效（变异锁 M-9 证明非空转）。
