# P1 `contract` 对 plan-compiler.md 的异议（CONTEST）

> 规则：发现契约不合理 → **照 plan 实现** + 在此登记，不自行改接口（由主线程裁决）。
> 下面每条都标注：① 我现在的实现口径 ② 建议的裁决。
> 引用行号均指 `research/ai-player/plan-compiler.md`（2026-10-24 版）。

---

## C-1【要裁决】§2.1 把 `layout` / `validation` 定成不可空，但 §2.5 有一半的 reason 发生在这两者存在之前

- **现象**：§2.1 的 `CompiledPlan` 里 `layout: LayoutReport`、`validation: ValidatorReport`（无 `|null`）。
  但 §2.5 的 `"no-site-large-enough"`、`"no-resource-in-range"`、`"out-of-scope:multilayer"`、
  `"unlock:machine-not-available"` 都是 **solver / 选矿位（P2）/ 门控** 阶段的失败 ——
  那时 P3 还没作图、P5 还没校验，`layout` 与 `validation` **没有合法值可填**。
  于是「永不 throw 的失败出口」反而要求构造一份假报告，这与 §2.1「绝不产出会堵死的蓝图」的精神相反。
- **我的实现**：按 plan 严格校验（两者必填）；同时提供 `assertCompiledPlan(plan, path, {stages:"nullable"})`
  作为显式逃生口，**默认关**。P8 若要产出早退失败，必须显式带这个 opts，不会静默放宽。
  逃生口**只对 `ok:false` 生效**：`ok:true` 时 `layout`/`validation` 仍必须在场 ——
  绿灯只能是「P3 作过图、P5 过过闸」的结果，否则 `stages` 会变成假的逃生门。
  配套放宽：早退失败的 plan 允许 `stats.bbox === [0,0]`（空实体表的唯一合法表达，
  与 `Grid.bbox()` 对空网格的返回值同口径）；有实体时仍强制 `bbox === entities 的 dx/dy 跨度`。
  `types.mjs --test` 里这三条都有正/反两组断言。
- **建议**：改成 `layout: LayoutReport|null`、`validation: ValidatorReport|null`，并规定
  `ok:false` 且失败阶段早于 P3/P5 时二者为 `null`。改动只在 P1 一处，下游无感。

## C-2【信息】§2.5 的 `"validate:<Vn>"` 是参数化模板，不是字面量枚举值

- **现象**：§2.5 把 `validate:<Vn>` 与另外 16 个字面量并列在同一个「枚举」里。逐字照抄会得到一个
  取值为字符串 `"validate:<Vn>"` 的枚举项 —— 没有任何计划会真的报它。
- **我的实现**：`FAILURE_REASONS` 只收 16 个字面量；`isFailureReason()` 额外接受
  `validate:` + §2.4 的 check id（**短号 `V3` 与全名 `V3-belt-fixed-point` 都放行**），
  另有 `validateReason(checkId)` 生成短号形式。所以枚举总数断言写的是 16（不是 17）。
- **建议**：钉死**规范形式 = `validate:<短号>`**（如 `validate:V3`），全名形式仅作为容错读入。
  否则 P8 的分诊表要同时匹配两种写法，`reason` 的等值比较会在下游静默失效。

## C-3【要裁决】§2.1 的 entities 顺序硬规定与 §2.7 的 plan-l1 样例自相矛盾

- **现象**：§2.1 规定 `entities[]` 顺序 = 蓝图内顺序 = **P3 先机器 → P4 再直线 → 最后拐角**
  （陷阱表 #6 / `layout-merge.mjs:96-127`）。但 §2.7 的 plan-l1 样例顺序是
  `miner → **belt** → cutter → trash` —— 带子插在机器之间，**违反同一条节自己定的硬规定**。
  P3/P4/P6 会把 §2.7 当 golden 直接对拍，于是 §2.1 的断言一上线就红。
- **我的实现**：按 §2.1 的**规则**实现（非单调即报错，可用 `{entityOrder:"off"}` 显式关闭），
  并把我自己的 `fixtures/plan-l1.json` 排成 `miner → cutter → trash → 直线带`（零拐角）。
  样例里的数值（anchor/dy/code）我按 §2.3 D1 与 GEOMETRY 表1 重算过，见 §C-6。
- **建议**：修正 §2.7 样例的顺序（或注明「样例只示意字段形状，顺序以 §2.1 为准」）。
  **这条不裁决的代价很高**：P6 的 roundtrip 断言会拿 §2.7 对拍 P1 的 fixture，两边都对，结果互相指责。

## C-4【信息】§1.1-1 的 occupyRect 判据里 r=90 的两种说法，我按决策 D1 取「默认拒绝」

- **现象**：§1.1-1 先写「2×1 机器 `occupyRect` 在 r=0 时覆盖两格、**r=90 时必须按 origin 位移规则覆盖**
  （GEOMETRY 表1 只在 r=0 定义…）」，随后 §2.3 决策 D1 又写「v1 加工机器**恒 r=0**…旋转需求一律
  通过 belt 拐弯实现」。前一句要求实现一个 P1 拿不到真值的几何（origin 位移在
  `static_map_entity.js:127-141`，且实机未验证）。
- **我的实现**：`rotatedFootprint()` 只做纯算术的 **w/h 交换**（这是 r=90 的唯一无争议部分）；
  `occupyRect(..., {rot:90})` 对 `kind=machine` **默认抛 ContractViolation**（消息点名 D1），
  显式 `{allowRotatedMachine:true}` 才按交换后的尺寸落格。
  `rotateLocalSlot({cell},rot≠0)` 一律抛错 —— 带 cell 偏移的旋转需要 P2 的 origin 表，P1 不猜。
  方向换算**只复用** `src/ai/belt-rules.mjs` 的 `rotateLocal`（§1.2 验收 2 的「不许二次实现」）。
- **建议**：如果后续真要支持旋转机器，origin 位移表进 P2，`Grid` 接收一个 `originShift(rot,w,h)` 注入点，
  而不是让 P1 硬编码。现在没有调用方需要它。

## C-5【信息】三态占用有两套词汇，§2.3 与 §1.1 不一致

- **现象**：§1.1 要 `empty | occupied_solid | occupied_replaceable`；§2.3 的
  `LayoutReport.occupancy[].state` 用 `"solid" | "replaceable"`（少 `occupied_` 前缀、也没有 `empty`）。
  同一个概念两个名字，下游做 `===` 比较必错。
- **我的实现**：`grid.mjs` 用 §1.1 的三态全名（`EMPTY/SOLID/REPLACEABLE`）；
  `types.mjs` 的 `OCCUPANCY_STATES` 用 §2.3 的两个词；两者之间由 `Grid.markOccupancy()` 翻译。
  两边都有测试锁住翻译。
- **建议**：统一成一种。我倾向保留 §2.3 的短词进 JSON（外部契约更紧凑），
  把 §1.1 的三态全名限定为 `Grid` 的内部常量。

## C-6【信息】plan-l1 样例的数值经不起形状语义推敲，我按仓库事实重建了它

- **现象**：§2.7 的样例写「`----CuCu`：2 矿机 + 1 cutter + 收集带」，但 `entities` 里只有 **1 台矿机**；
  `layout.bbox: [3,12]` 与 `stats.bbox: [3,12]` 对不上任何一组 dx/dy（样例里 dy 只到 11、dx 恒 0）；
  `stats.beltTiles: 4` 而样例只列了 1 条带子；`trash` 挂在 cutter 之后但 `inDir:"bottom"` 配合
  `dy:5`（cutter 在 dy:8）意味着物流**向下**走 —— 违反 GEOMETRY 表3 规则 1/2（矿机与加工机恒下进上出）。
  另外 P1 任务书把这张图描述成「矿机→直带→**hub 侧口**」，而 plan §2.7 要求「全竖直线、零拐角」：
  竖直上行流在几何上只能进 hub 的**顶/底排**（侧口必须先拐弯）。
- **我的实现**：以仓库已核证事实为准重建 —— 目标 `----CuCu` = CuCuCuCu 切左列：
  `miner(code7) → cutter(code9, 2×1) → 左列 4 条竖直直带 → hub 底排入口(dir=0)`，
  右列 `----` 走 `直带 → trash(code20)`（陷阱表 #7 要求废弃输出必须有去向）。
  **零拐角**、`cornerCount=0`、`stats.bbox=[2,6]` 与 entities 跨度一致、蓝图段是真 `SZBP1.` 串。
  带子 (r,rv) 全部由 `solveTurn` 现算，并与 M4-SUCCESS 的实机拐角值对拍（不一致就让生成脚本抛错）。
- **建议**：主线程把 §2.7 的样例数字替换成 `fixtures/plan-l1.json`（它是可执行且自洽的）。

## C-7【要裁决】§2.4 没有规定 `checks[]` 与 `errors[]` 必须对应

- **现象**：§2.4 里 `checks[].id` 是枚举、`errors[].check` 是裸 `string`，两者不要求互相印证。
  P8 的分诊表（§2.5）按 `reason`/`check` 分流 —— 一条 `status:"fail"` 的 check 若在 `errors[]`
  里没有对应条目，**这个失败会被下游完全看不见**（正是 §7.2 担心的「静默」）。
- **我的实现**（照 plan 的字段，加交叉断言）：
  `status==="fail"` ⇔ `errors[]` 至少一条对应（短号/全名都认）；`status==="pass"` 不得有对应 error；
  `errors[].check` 必须是 §2.4 的 check id；`pass === (errors.length===0)`；
  `pass:false` 时至少一条 `severity:"fatal"`（warn 不得单独让计划失败）；
  `beltSim.drift` 非空时 `V3` 不得为 pass；`shapeReplay[].equal === (expectedHash===actualHash)`。
- **建议**：把 `errors[].check` 的类型收窄成与 `checks[].id` 同一枚举，并规定 fail↔error 一一对应。

## C-8【信息】§2.1 的 typedef 没有 `instanceIdx`，但 §7.1.2 要求现在就加

- **现象**：§2.1 的 `entities[]` 字段表里没有 `instanceIdx`；§7.1-2 的缓解措施写
  「现在就写成 `nodeId:string + instanceIdx:number`（默认 0）」。两处不一致。
- **我的实现**：`instanceIdx` **可缺省**，缺省即 0（校验时补默认值并在返回对象里带上），
  取值必须 `>=0` 整数。§2.7 样例本身也带 `"instanceIdx": 0`，所以按「有该字段」读更安全。
- **建议**：把 `instanceIdx` 正式写进 §2.1 的 typedef（v1 恒 0，v1.1 多行才有意义）。

## C-9【信息】`bbox` 的定义在「锚点跨度」与「占地跨度」之间有歧义

- **现象**：§2.1 `stats.bbox`、§2.3 `layout.bbox`、§1.6 P6 的「bbox 与 LayoutReport.bbox 一致」——
  三处都叫 bbox，但 2×1 机器（cutter/stacker/painter/mixer）的**锚点格跨度** ≠ **实际占地跨度**
  （stacker 双格：锚点 dx=0 与下一台机器锚点 dx=1 跨度 2，但占地是 2 格 → 恰好相等；
  而 `summarizeBlueprint` 用的是 dx/dy 跨度，即锚点口径，`src/shared/blueprint.mjs:79-89`）。
- **我的实现**：统一取 **entities 的 dx/dy 跨度**（与 `summarizeBlueprint` 同口径），
  并断言 `stats.bbox === layout.bbox === entities 跨度`。`Grid.bbox()` 是「已占格」口径，
  两者不同层次（Grid 不知道实体表的锚点语义），文档里已写明。
- **建议**：主线程确认 P6 的 L1 门用哪一种。若 P6 要「实际占地」，需要 P2 的 footprint 表参与，
  那时 `Grid.bbox()` 才是唯一正确出处（我已提供）。

## C-10【信息】§2.6 的 `replaceableBeltCells` 是 `Set`，落不了 JSON；且它的数据来源没定义

- **现象**：§2.6 写 `replaceableBeltCells: Set<string>`，但同一节说「P1 定义、P8 采集」——
  P8 采集的结果要过文件（§4.6 的文件交接），`Set` 无法序列化。
  另外没写清楚：obs 的 `entities[]` 里 `type==="belt"` 的格**是否恒等于** replaceableBeltCells。
- **我的实现**：`worldStateToJSON()`（Set → 按 y,x 排序的数组）与 `normalizeWorldState()`（数组 → Set）
  成对提供，round-trip 有测试。并加了交叉断言：`entities` 里每个 `type==="belt"` 的格都必须出现在
  `replaceableBeltCells` 中（否则 P5 的 V2 无判据、C1 的「静默毁带」闸形同虚设）。
  wire 也是 `getIsReplaceable()=true`（constraints C1），但 v1 范围排除 wire（C3），所以这里只认 belt。
- **建议**：如果 P8 的采集实现是**只填规划区内的带格**（分 region 读、`max_entities` 2000 截断），
  我的断言会偏严 —— 请裁决「全图」还是「区内」；我倾向前者（V2 只需要规划区，但多一条无成本的完整性检查更稳）。

## C-11【流程，不是接口】并行包的 commit 会互相夹带未完成的文件

- **现象**：本次执行期间观察到 `research/ai-plan/contract/make-fixtures.mjs`（P1 独占、仍在编辑中）
  被别的包的 commit（8d6ffaf）夹带提交，工作树里同时存在 P2/P7 在写的文件。
  §3 的所有权矩阵只约束「谁写」，没约束「谁提交」。
- **影响**：中间态（我一开始写的骨架版 `--test` 是 `process.exitCode=1` 的桩）会进入主线历史，
  跑 `node src/ai/compiler/*.mjs --test` 的第三方会看到红的退出码。
- **建议**：主线程统一「只提交自己 paths 的 `git add <file>`」，或给每个包一个 `git commit -- <自己路径>`
  的模板。这条与 §3 的冲突仲裁规则并列，成本很低。

---

## 我没有异议、但想记录下来的两处（省下游重新论证）

1. **`scope` 是契约的一部分**（§2.1）：我把 `SCOPE_V1 = {layers:1, wires:false, tunnels:false,
   rotatedMachines:false, maxFanIn:2}` 做成 P1 导出的冻结常量，并且 `scope` 的**任何**偏离都算
   ContractViolation（而不是 ok:false）—— 因为「scope 被改成 true 却仍然产出蓝图」正是 §0 明令禁止的
   静默近似；调用方要表达「这个需求超出范围」应走 `ok:false + reason="out-of-scope:*"`。
2. **带子的 (r,rv) 与 inDir/outDir 互为充要**：`assertCompiledEntity` 里我用
   `beltEntry(rv,r)===inDir && beltExit(rv,r)===outDir` 直接反查（等价 `solveTurn` 恒等），
   所以「写错 rv」或「写错方向」都过不了 P1 这一关 —— 这比 plan §1.4 验收 2 的「自洽」判据更靠前，
   P4/P5 可以放心假设 entities 里的带子方向已经自洽。
