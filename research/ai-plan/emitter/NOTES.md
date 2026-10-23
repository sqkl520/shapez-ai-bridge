# P6 `emitter` — 缺口报告 / 实现口径 / 交主线程的 stride=5 方案

> 本包拥有：`src/ai/compiler/emit.mjs`、`src/ai/compiler/roundtrip.mjs`、`research/ai-plan/emitter/**`
> **一条命令跑完**：`node research/ai-plan/emitter/run-all.mjs` → **285 条断言全绿**
> L1 门本体命令：**`node src/ai/compiler/roundtrip.mjs --test`** → **85/85 全绿，退出码 0**
> 补充件（由 run-all 串起来，也可手工跑）：`node src/ai/compiler/emit.mjs --test`（烟测 7 条）、
> `node research/ai-plan/emitter/probe.mjs`（永不 throw 26 例 + 锚点平移不变性 + chargeMode 口径，15 条）、
> `node research/ai-plan/emitter/probe-p2-argv.mjs`（**缺陷 G-P2-argv-guard 的凭据**，8 条）、
> `node research/ai-plan/emitter/measure-stride5.mjs` + `stride5-hazard.mjs`（**§一的实测数据**）
> 异议（要裁决的）在 `CONTEST.md`（C-1 锚点口径 / C-2 beltIntent 二义 / C-5 hub 三态不一致）。
> 全程离线：零游戏、零网络、零桥接（plan §4 第 2 条）。
> 只读依赖：`src/shared/blueprint.mjs`、`src/shared/lz-string.cjs`、`src/ai/belt-rules.mjs`、
> `src/ai/op-templates.mjs`、`src/ai/compiler/{types,errors}.mjs`。**一个都没改。**

---

## 一、★ 主线程任务：stride=5（把 `originalRotation` 存进蓝图）的治本方案

**这是交给你（主 Agent）的报告，P6 不动 `src/shared/blueprint.mjs`、不动 `src/mod/*`**
（plan §3 禁改清单 + §1.6 决策 D2 + BATCH.md「stride=5 由主线程在批次收敛后自己改」）。

### 1.1 缺口是什么

SZBP1 v1 的 payload 是 `{v:1, gv, w:[minx,miny], e:[code,dx,dy,rot]×n}` —— 每格 **4 列**。
游戏在粘贴之后按 `BeltComponent.originalRotation` 重算带子（`systems/belt.js:160`），而
`compiler-constraints.md:16-19`（C2，红队 #3a，主线程已源码复核 `bridge:1458`）钉死了两件事：

1. `originalRotation` **不可从 (rotation, rv) 反推** —— 同一个 (r,rv) 的「正确 orig」取决于它命中
   `belt.js` 的哪个分支；
2. mod 的粘贴路径 `shapez-ai-bridge.js:1563-1570` 把蓝图里那**唯一一列** `rot` 同时当作
   `rotation` 与 `originalRotation` 交给 `placeOne()`（`bridge:814` 的
   `originalRotation: rot`）。于是 orig 恒等于 rot，真值丢失。

一次性 paste-and-run 被 `performImmutableOperation` 掩盖（粘贴期间不重算）；但**粘贴后在旁边补一格**
（C2 点名 RV-FIX T3 已证实会触发重算）或任何邻域扰动，都会按错的 orig 重算 → 拐角**静默翻向**。
M4 里就有现成的受害者：`(138,93)` 实机 r=270 是个被自动转向过的拐角（ADVERSARIAL:61-71）。

### 1.2 为什么编译器 v1 现在**能**绕过它（三条腿，缺一不可）

1. **P5 的 `V3-belt-fixed-point` 把 (r,rv) 本身逼成不动点**（plan §1.5 / §2.4）。
   如果 `(r,rv)` 就是「含机器邻居下 `computeBelt` 的解」，那么用 `orig=r` 重算得到的还是同一个
   `(r,rv)` → **orig 的错误是惰性的**。这是 plan §1.6 D2 的原话，也是 §6 R1 把 R2 列为
   「R1 的检查顺带覆盖 R2」的理由。
   ⇒ **推论（对 P5 的硬约束）**：V3 的判据必须**逐格**覆盖蓝图内每一根带子、并且邻居必须含机器
   （`beltSim.includesMachineNeighbors === true`）。少一根格子，绕过就不成立。
   P6 已经把 `beltSim.drift.length > 0` 变成**发射前的硬闸**（L1-6.belt-sim-drift → `validate:V3`），
   所以「V3 报了漂移却仍然出蓝图」这条路在发射层被堵住了，不依赖 P8 记得检查。
2. **不增量施工**：`scope` 写死「全新址」（plan §0 / §2.1），v1 不在既有工厂旁边补格子（C2 的
   「v1 纪律：整块贴、贴后不在其旁补放任何格」）。接旧厂走 `place_path`（不是 paste）。
3. **immutable 粘贴**：粘贴期间的邻居重算被豁免（commit a35a481），所以「一次贴完整块」这个动作本身安全。

三条腿同时成立 = v1 的 paste-and-run 正确。**任何一条断了（尤其是 1，或者将来支持增量对接）
就必须真有 orig 列**，所以 1.3 的方案要提前铺好。

### 1.3 推荐方案：**平行数组**，不要改 stride

两种写法都实测过（`measure-stride5.mjs` / `stride5-hazard.mjs`，同一 lz-string、同一 JSON）：

| 写法 | payload | v1 解码器（现状代码）读它会怎样 |
|---|---|---|
| **v2a** stride=5 | `e:[code,dx,dy,rot,orig]×n`，`v:2` | **2001 显式拒绝**（`payload.v !== 1`）—— 老 mod 直接不干活 |
| v2a' stride=5 但忘了升 v | `e:[...]×5`，`v:1` | **⚠⚠ 静默错位**：n 是 4 的倍数时 `%4` 闸放过去，返回 `10` 个实体（真相 8 格）、`(code,dx,dy,rot)` 逐格滚动错开，mod 会把错位实体**照样盖进世界**。实测 n=1..16 有 **4/16 个规模**静默通过（n=4,8,12,16） |
| **v2b（推荐）** 平行数组 | `e:[code,dx,dy,rot]×n` + `o:[orig]×n`，`v:1` 或 `v:2` | `v:1` → **原样可读**，`o` 被安静忽略（实测 8 格、(code,dx,dy,rot) 与 v1 时代完全一致）；`v:2` → 2001 拒绝 |

**容量增幅**（`measure-stride5.mjs` 的输出，长度 = 压缩后的 URL-safe 字符数）：

| 样本 | n | v1 | v2a（stride=5） | **v2b（平行 o）** |
|---|---|---|---|---|
| P1 金样例 plan-l1 | 8 | 84 | 93 (+10.7%) | 94 (+11.9%) |
| P6 straight fixture | 8 | 84 | 94 (+11.9%) | 99 (+17.9%) |
| P6 corners fixture | 13 | 115 | 130 (+13.0%) | 136 (+18.3%) |
| 合成蛇形带 | 200 | 642 | 796 (**+24.0%**) | 813 (+26.6%) |
| 合成（level-11 工厂量级） | 2000 | 3899 | 4707 (**+20.7%**) | 4950 (+27.0%) |

⇒ **增幅 11–27%，量级完全可接受**（几百格的产线蓝图也就从 ~1KB 涨到 ~1.3KB）。
两种写法的成本基本一样（同一列整数进 JSON），差别全在**兼容性**上。

**为什么选 v2b（平行数组）**：
- 向后兼容是**默认方向**而不是例外：老 v1 解码器读 v2b 文本不掉链子（实测），改 stride 则必须
  靠版本号把老工具挡在门外 —— 而 v2a' 那张行显示「只靠人记得升版本号」是不安全的。
- 回滚成本接近零：`blueprint.mjs` 只是多读一个键；mod 侧只是 `originalRotation: payload.o?.[i] ?? rot`。
- `summarizeBlueprint` 与 `decodeBlueprint` 的返回形状不变（多一个可选字段），P7 的 intent 对拍不受影响。
- 代价：v2b 用 `v:1` 时，**新版** mod 无法从版本号区分「带 o 的 v1」与「纯 v1」——所以
  正确做法是**同时**升 `v:2`（新解码器按 v 白名单取 stride，老解码器见到 v:2 就 2001），
  然后靠「o 缺失 → orig=rot（今天的语义）」保证 v2 老文本可读。实测 D 组（v:2 + 平行数组）
  对 v1 解码器是显式 2001，**不会**静默错位。

### 1.4 落地清单（要动的 4 处，都在禁改清单里 ⇒ 只有你能改）

1. `src/shared/blueprint.mjs:61-68 encodeBlueprint` —— 接受可选 `originalRotations: (number|null)[]`，
   写成 `payload.o`；`payload.v` 升到 2（保持 v 仍接受 1 的读取路径）。
2. `src/shared/blueprint.mjs:29-54 decodeBlueprint` —— 校验改成「按 `payload.v` 白名单决定 stride」
   （v:1 → 4；v:2 → 4 + 可选 `o`），并把 `o` 透出为 `entities[i].orig`。
   **必须**加一条断言：`payload.o` 存在时 `o.length === e.length/4`（长度不符 → 2001，别静默）。
3. `src/mod/shapez-ai-bridge.js:1552-1570 opPasteBlueprint` —— `placeOne(...)` 多传一个
   `originalRotation` 参数；`bridge:814` 的 `originalRotation: rot` 改成
   `originalRotation: originalRotation ?? rot`（保持 `place`/`place_path` 通道的现有行为不变）。
   `opExportBlueprint`（`:1458`）反过来要把 `sme.originalRotation` 写进 `o` —— 现在只读 `sme.rotation`，
   所以「导出的蓝图再贴回别处」也是同一个缺口。
4. `docs/PROTOCOL.md:156-175 §6` —— 补 `o` 字段与 v:2 的版本语义（2006 的口径不变，只看 gv）。

**P6 侧的准备**：`emit.mjs` 把每格的 `rotationVariant`/`rotation` 都写进 `beltIntent`，
一旦容器层支持 orig，发射器只需多填一列（不改顺序锁、不改锚点归一）。**目前 v1 编译器
不需要它**，因为 `entities[].rot` 对带子而言就是世界朝向，而 orig 的缺失由 V3 不动点补偿。

### 1.5 与 P7 的接口
`stride5-hazard.mjs` 的 A 组（静默错位）是 P7 `MOD-GAPS.md` 该盯的**同类**风险实证：
「协议改动只靠版本号做安全边界时，一定要有一个规模让老代码静默接受」。建议 P7 的 F2 实验
（paste 含拐角蓝图 → 旁边 `place` 一格触发重算 → 读回拐角 code 是否变）直接把结论落到
`live/results/*.json`，那份 result 是这个改造要不要提前做的判据（BATCH.md 挂账 ①）。

---

## 二、★ 缺陷上报：P2 的自测守卫会**污染下游包的退出码**（把红灯改成绿灯）

**证据脚本**：`node research/ai-plan/emitter/probe-p2-argv.mjs`（三条全按预期 = 缺陷在位）。

`src/ai/op-templates.mjs:1165-1166`：
```js
if (process.argv.slice(2).includes("--test")) runTests();
if (process.argv.slice(2).includes("--gaps")) console.log(specGapReport().join("\n"));
```
判据只看「argv 里有没有 `--test`」，缺了仓库里其他包都有的那层「**这个文件是不是被直接运行的那一个**」
（`types.mjs:995` / `grid.mjs:494` / `belt-rules.mjs:62` / `lint-imports.mjs:98` 都写了）。
（`node src/ai/op-templates.mjs --test` 自己是 175 条断言、0 失败、exit 0 —— 它自身没问题，
问题是这个守卫会在**别人的**进程里被触发。）实测后果三条，`probe-p2-argv.mjs` 逐条钉住（8/8 按预期）：

1. **夹带输出**：任何下游包 `node <自己> --test`，只要模块图上有静态 import op-templates 的边，
   stdout 就被灌进 **~175 行** P2 自测。人看不出哪条是调用方的。
2. **★ 退出码被覆盖（最严重）**：`runTests()` 结尾**无条件** `process.exitCode = failed ? 1 : 0`。
   实测：调用方先 `process.exitCode = 1`（自己判红），随后延迟装载 P2（动态 import / 懒加载形态）
   → 子进程终态 **exit=0**。P2 的绿灯把调用方的红灯**改成了绿灯**。
   这正是 plan §5 末尾与 ADVERSARIAL:31-40 立的那条纪律（result 是判据真源，绿不得盖过红）
   的反面：**判据真源被一次无关的 import 改写了**。P8 的 `compile.mjs --test` 一旦 import 到 P2
   （一定会，它要用 `OP_TEMPLATES`/`RATES`），它就没法用退出码表达「我的验收失败」。
3. **P6 的规避救不了别人**：`emit.mjs` 的 `loadP2()` 只覆盖「P6 自己动态装载」这一种形状。
   实测入口文件**无论把 `import ... op-templates` 写在 `emit.mjs` 之前还是之后**，都会夹带 175 行 ——
   ESM 的求值由模块图驱动（入口 deps 按声明顺序、深度优先），动态 import 只是等它被求值，
   那条静态边不会经过 P6 的守卫。⇒ **必须由 P2 改守卫**，不能靠各包自觉。

**P6 的规避（不改别人的文件）**：`emit.mjs` 的 `loadP2()` —— 动态 import 期间临时摘掉
`--test`/`--gaps`，装载完原样恢复。实测 `roundtrip.mjs --test` 现在 0 行夹带、退出码归 P6
（probe 第 2/第 4 组：对照实验「只经 emit 的动态装载 → 夹带 0 行」）。

**建议修法**（一处、一行，抄现成的）：
```js
const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly && process.argv.includes("--test")) runTests();
```
（顺带把 `process.exitCode` 的赋值收进同一个守卫内 —— 即使有人以别的方式触发 `runTests()`，
也不该动宿主进程的退出码。更稳的做法：`runTests()` 返回失败数，由守卫决定是否设 exitCode。）

**登记为「开放缺口」而非 P6 已解决**：P6 只保证了自己这条 CLI 干净。

**P6 规避自身的两点副作用（诚实登记）**：
1. `loadP2()` 在装载期间**临时改写全局 `process.argv`**（摘 `--test`/`--gaps`，装完原样恢复）。
   窗口极小且单线程内确定，但若将来有别的模块在**同一个 await 窗口**里读 argv 判行为，
   会读到被摘掉 flag 的版本。P2 改守卫后这段就该整段删掉（搜 `loadP2` 即可）。
2. 装载因此变成**顶层 await**（`emit.mjs` 的模块求值多一个 microtask）。ESM 语义下对调用方透明，
   但意味着 `emit.mjs` 不能在需要「同步 require」的场合使用（本仓库全是 ESM，无影响）。

---

## 三、其它登记项（信息级，不阻塞）

### G-P2-argv-guard
见 §二。

### 锚点口径：plan 的 `dx/dy` 相对 `site.anchor`，蓝图的 `dx/dy` 相对 `w`
plan §2.1 说「`entities[i].dx/dy` 相对 `blueprint` 的锚点 `w=[minx,miny]`… 世界坐标 =
`site.anchor + [dx,dy]`」—— 这两半只有在 `site.anchor === w` 时才同时成立。P1 的
`fixtures/plan-l1.json` 就是这个形状：`site.anchor=[1200,-1396]`、`w=[0,0]`、dx/dy 相对 anchor。

**P6 的口径（写进代码与测试）**：世界格 = `site.anchor + [dx,dy]`（plan §2.1 的后半句 + P7 的
`kit.buildBlueprint`/`pasteAndDiff` 都是这个），发射时把
`w` 归一成**世界格的 min corner**、`dx' = x - minx`（**非负**）。于是：
- `paste_blueprint{x,y}` 直接填 `out.anchor` 就复原设计（与 mod 的 `opExportBlueprint:1467-1477` 同式）；
- `dx',dy' >= 0`，`beltIntent[].x/y` 给出世界坐标，P7 不必自己再算 min；
- **平移不变性**：`site.anchor` 换地方只挪 `w`，`e` 数组逐元素不变 —— L1-3.anchor-translation-invariant +
  `probe.mjs` 的第二组（含 dx/dy 起点非 0、起点为负三种情况）都锁住了。
金样例走这条口径后 `e` 数组与 fixture 自带的蓝图**逐格相同**（L1-1.golden-flat-equal-to-fixture），
只有 `w` 不同（`[1200,-1396]` vs `[0,0]`）—— 这就是「fixture 的 w 记的是相对 anchor 的 min(=0)」，
不是数据错位。建议 plan §2.1 把那句话拆成两行写清（dx/dy 相对 anchor；w = 区域 min corner）。

### `stats.chargeMode` 的归一
入参写 `"auto"` 时，出参 `chargeMode` 钉成 `"false"` 并记 1 条 warning（v1 口径 = god-mode，
plan §2.1 硬规定 + §6 R4）。非法值（如 `"nope"`）由契约直接拒。实测见 `probe.mjs` 第三组。

### 顺序锁的两个方向都要锁（plan §1.6 只写了「测排序函数」）
L1-4 现在有五组断言：入参乱序 → **拒**（strict 是默认）；`orderEntities` 能把乱序排回单调；
排好后再发射 → 出参相位单调；`opts.entityOrder:"reorder"` 的逃生口产出的蓝图与
「先排好再 strict 发射」**逐字节相同**（重排只动次序不动内容，所以不可能排成会堵死的蓝图）；
以及反证「缺省不提供这个口子」。
**给 P3/P4 的话**：顺序不是发射器替你兜的 —— 默认 strict 会在边界上响，因为
「P3 产出机器 + P4 产出带子，两批各按自己内部序」这件事只有你们知道自己排没排对。

### P2 的 reason 与 §2.5 的枚举不一致（已处理，仍建议裁决）
`SpecError` 的**默认** reason 是 `"validate:V8-scope"`（`op-templates.mjs:62`），而 §2.5 的规范形式
（P1 的 `validateReason()`）是短号 `"validate:V8"`。两者都过 `isFailureReason()`，但是**不同的字符串**；
P8 的分诊表若做 `reason === "validate:V8"` 的等值比较就会漏掉从 P2 透传上来的那批。
**P6 的处置**：`specReason()` 无条件把长号折成短号（`normalizeP2Reason()` 是它的导出版，
L1-5.reason-normalized-to-short-form 用 P2 真实抛出的错误对象验：
`validate:V8-scope → validate:V8`，而 `out-of-scope:rotated-machine` 原样透传不被改写）。
实测 `op-templates.mjs` 的 12 处 `new SpecError` 里**只有 `opByName()`** 走长号（P6 不调它），
所以正常路径碰不到；但**默认参数**意味着 P2 以后新增的抛错会随手带出长号 ⇒ 归一而不是赌上游。
**建议主线程**：钉死规范形式 = 短号（P1 CONTEST C-2 已提过这条，一并裁决），并把
`op-templates.mjs:62` 的默认值从 `validate:V8-scope` 改成 `validate:V8`（或 emit:mismatch）。

### 双 code 源交叉校验（belt 族）
belt 格的 code 走两个入口对拍：`beltCode(rv)`（`belt-rules.mjs:59`，1906/1906 实机，**权威**）与
`codeFor("belt", variant, rot, rv)`（P2 的解码器，内部也调 `beltCode`）。发射时两者必须同值，
否则 `emit:code-mismatch`。目前是同一条公式的两个入口，**测不出语义错**，但能在 P2 的
`RV_ALLOWED`/公式改动时立刻炸出漂移 —— 留着当回归哨。

### v1 硬约束 rv≠0 的透传路径（验收第 3 条）
`gatePlan` 的闸门顺序是刻意的：A `plan.ok` → B `validation.pass` → **C P2 的硬断言** → D §2.1 契约。
C 必须在 D 之前：P1 的契约会把「非 belt rv=1」报成泛泛的 `ContractViolation`（→
`emit:mismatch`），而 §2.5 的分诊表要的是 P2 给的 `out-of-scope:rotated-machine`。实测
（L1-5 组）：`machine-rv1` / `machine-rot90` → `out-of-scope:rotated-machine`（gate=code-mismatch）；
`belt-rv3`、belt/机器手填 code → `emit:mismatch`。**没有任何一条**是本包另立的判据 ——
rv 真值仍然只有 P2 的 `RV_ALLOWED` 一个源（H2）。

### emitPlan 永不 throw（plan §0 的顶层签名要求）
`probe.mjs` 用 26 个畸形入参（14 个顶层 + 12 个 entity 级）钉这条：全部返回
`{ok:false, blueprint:null, beltIntent:[]}`，0 次 throw。非契约类异常（程序 bug）**故意不吞**，
让它响 —— 只有 P1 的 `ContractViolation` 与 P2 的 `SpecError` 会被归一成结构化失败。

### fixture 的漂移（plan §7.2 已经预告，这里确认口径）
本包的 fixture 是**手工构造**的（P3 place / P4 route / P5 validate 在写 P6 时是骨架），
`validation` 段是形状正确的**占位报告**（checks 全 pass、evidence 写明「真判据在 P5」），
`beltSim.tilesChecked` 等于蓝图里的带子格数。P8 落地后需要补的那条 diff 断言建议写成：
「对同一 goal，P3+P4+P5 的真产物与 P6 fixture 的 `entities`/`layout.bbox`/`cornerCount`
逐字段比，差异必须显式白名单」。不补这条，L1 门绿灯会为一张真产物根本不会产出的蓝图说话。
本包的 `buildCompiledPlan()` 是导出的（`roundtrip.mjs`），P8 可以直接拿它做 fixture 生成器复用。

### 交接件（P8 §4.6 的 `harness/out/*`）
P6 的出参已经按那两个文件的形状给齐：
- `.szbp.txt` ← `out.blueprint`（实测只含 `[A-Za-z0-9+\-$.]`，可安全塞 JSON，`probe.mjs` 第五组）
- `.intent.json` ← `{ anchor: out.anchor, hub, chargeMode: out.chargeMode, beltIntent: out.beltIntent }`
  （JSON 往返实测通过）。`beltIntent[]` 与蓝图**逐格对应**（同一 index），P7 的
  `pasteAndDiff` 需要的 `{cell:[x,y], rot, rv, code}` 三个字段都在同一条记录里。
写文件本身归 P8（P6 不碰 `harness/`）。
