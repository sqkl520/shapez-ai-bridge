# P6 `emitter` 对 plan-compiler.md 的异议（CONTEST）

> 规则（照 P1 的口径）：发现契约不合理 → **照 plan 实现** + 在此登记，不自行改接口。
> 引用行号均指 `research/ai-player/plan-compiler.md`（2026-10-24 版）。
> 缺口/缺陷类（不是「plan 写错了」而是「仓库事实有坑」）在 `NOTES.md`，不在这里重复。

---

## C-1【要裁决】§2.1 的 `dx/dy` 有两套互斥的定义，P1 的 fixture 证明只能取其一

- **现象**：§2.1 同一行列了两件事：
  `entities: Array<{code, dx, dy, rot, ...}>`（注：字段名 `dx/dy`）**且**
  「`entities[i].dx/dy` 相对 `blueprint` 的锚点 `w=[minx,miny]`…… 世界坐标 = `site.anchor + [dx,dy]`」。
  两句同时成立 ⟺ `site.anchor === w`。而 `fixtures/plan-l1.json` 是
  `site.anchor = [1200,-1396]`、`blueprint.w = [0,0]`、`dx/dy ∈ 0..5`（相对 anchor）——
  即 fixture 只满足**后半句**，`w` 记的其实是「相对 anchor 的 min = 0」。
- **我的实现**：认后半句（世界 = `site.anchor + [dx,dy]`）。理由：这是 P7 唯一能用的口径 ——
  `kit.buildBlueprint()`（`research/ai-plan/live/kit.mjs:413-427`）与 `pasteAndDiff()`（:483-514）
  都是「世界格 = anchor + 相对量」，且 `paste_blueprint{x,y}` 要的正是**世界坐标**；
  mod 的 `opExportBlueprint`（`bridge:1467-1477`）也是「w = 区域 min corner，dx/dy 相对 w」。
  发射时我把 `w` 归一成**世界格的 min corner**、`dx' = x - minx`（非负），
  于是 `paste_blueprint{x: out.anchor[0], y: out.anchor[1]}` 直接复原设计，不需要任何二次推导。
  **入参 dx/dy 起点非 0 / 为负都合法**（实测三种情况，`probe.mjs` 第二组）。
- **代价**：发射产物的 `w` 与 fixture 的 `w` 不同（`[1200,-1396]` vs `[0,0]`），但 `e` 数组
  **逐格相同**（L1-1.golden-flat-equal-to-fixture 就是钉这个的）。所以这不是数据错位，是口径。
- **建议**：把 §2.1 那句拆成两行写死：
  `entities[i].dx/dy 相对 site.anchor（世界 = site.anchor + [dx,dy]）`；
  `blueprint.w = 世界实体的 min corner；蓝图内 dx/dy = 世界 - w`。
  或者更简单：规定 `site.anchor` **恒等于** `w`（= 区域 min corner）—— 那样两套定义自动合一，
  但 P3 选 site 时要按 min corner 报，请主线程定。

## C-2【要裁决】「beltIntent」在 §1.6 与 §2.1 里是两个不同的东西

- **现象**：§2.1 的 `entities[]` 后面注着「`inDir/outDir` ← **beltIntent**（P7 对拍的凭据）」，
  把 beltIntent 说成 `entities` 的一部分；§1.6 又要求「产出 `beltIntent[]`（与蓝图逐格对应）」
  并把字段定为 `{x,y,inDir,outDir,rotation,rotationVariant,code}` —— 用的是 **x/y（世界）** 与
  **rotation**（不是 entities 的 `rot` 与 `dx/dy`）。
  如果 beltIntent 就是 entities，那 §5 的 L1 门第 1 条「逐格断言 `(code,dx,dy,rot)` 与
  `beltIntent` 全等」是**同义反复**（自己等于自己），零信息量。
- **我的实现**：两者都给 —— 出参同时含 `entities`（§2.1 形状）与**独立的**
  `beltIntent[]`（§1.6 形状，`x/y` 世界坐标 + `rotation`，另外**保留** `dx/dy` 并加
  `index`/`kind`/`nodeId`/`instanceIdx`/`isCorner`/`phase`），并保证
  `beltIntent[i]` 与蓝图的**第 i 格**、与 `entities[i]` 三者一一对应
  （`diffCells()` 就是拿解码结果对 `beltIntent` 比，L1-1 因此不是自反断言）。
  P7 的 `pasteAndDiff` 需要的 `{cell:[x,y], rot, rv, code}` 三个字段都在同一条记录里，直接可用。
- **建议**：§2.1 的注释改成「`inDir/outDir` 是 beltIntent 的**来源字段**；beltIntent 由 P6 发射时
  物化成独立表」。定成独立表还有个好处：P7 的 `intent.json` 交接件（§4.6）本来就是独立文件。

## C-3【信息】§1.6 的依赖清单要 P6 依赖 P4/P5 的**实现**，但排序职责本来就悬在中间

- **现象**：§1.6 写「依赖：P1、P2、P4（带子 code）、P5（validator 必须 0 error 才允许发射）」，
  同时 §2.1 又把「entities 顺序 = 机器 → 直线 → 拐角」写成对 `entities[]` 的硬规定，
  而 P6 的任务书要求「排序函数在此实现并测」。可 P3/P4 才是产出那两批格子的主体
  （`layout-merge.mjs:96-127` 的分层就在那儿），P6 只是最后拼扁平表的人。
- **我的实现**：`orderEntities()` 在 P6（稳定分桶，相位取自 P1 的 `entityOrderPhase` 单一真源），
  但**默认不替你兜**：入参非单调 → 直接拒（strict），因为「P3 的机器序 + P4 的带子序」
  只有上游自己知道排没排对，发射器静默重排会把上游 bug 埋掉。
  同时提供显式逃生口 `opts.entityOrder:"reorder"`（重排 + warning，且产出的蓝图与
  「先排好再 strict 发射」**逐字节相同** —— 重排只动次序不动内容，所以不可能排成会堵死的蓝图）。
  L1-4 五组断言把两个方向都锁住了。
- **建议**：把这条写进 P3/P4 的验收（「你们的 entities 拼接序必须单调，P6 会拒非单调的入参」），
  省得 P8 接上时才发现上游一路在指望 P6 兜。

## C-4【信息】§5 的 L1 门第 5 条「三金样例全过」需要澄清是哪一个「金样例集」

- **现象**：§2.7 定义了三个共享 fixture（`plan-l1.json` / `report-layout.json` /
  `report-validator.json`），但只有 `plan-l1.json` 是完整 `CompiledPlan`（另两个分别是
  `LayoutReport` 与 `ValidatorReport`，**没有 entities/blueprint**，无法单独「过 L1 门」）。
  而 P1 另外产出了 `research/ai-plan/contract/merge-belt-intent.json` ——
  那张才是带拐角、且拐角 `(r,rv,code)` 直接来自实机期望值（M4-SUCCESS:18-21）的表。
- **我的实现**：三个共享 fixture **全部用上**，形态各异，另加 `merge-belt-intent.json` 作第四张：
  - `plan-l1.json` → 原样发射 + 回推全等（L1-1.golden-*，含与自带蓝图的对拍、零拐角、cost、chargeMode）；
  - `report-layout.json` → `assertLayoutReport` 读通 + 用它的 `placements` 造机器 entities 发射一遍
    （L1-3.golden-layout-*）；
  - `report-validator.json`（pass:false）→ 作为**反例**塞进一个 ok:true 的 plan，
    验证「validation 不过 → blueprint:null + reason=`validate:V2`（它的第一条 fatal）」
    （L1-6.validation-fail）—— 这张 fixture 的正确用法就是被拒；
  - `merge-belt-intent.json` + `report-layout.json` → 28 格（24 带子、2 实机拐角）原样发射，
    按**世界坐标**对拍 `live_expectations` 的 `(r,rv,code)`，并验 `bbox === LayoutReport.bbox`、
    `cornerCount` 一致、链闭合（L1-*.golden-merge-*，10 条）。
- **建议**：§2.7 给「三金样例」加一句各自的可消费形态；`merge-belt-intent.json` 若要长期当
  golden，建议主线程决定它搬进 `fixtures/`（P6 只读，不搬）。

## C-5【要裁决】`ENTITY_KINDS` 含 hub，但 `assertCompiledEntity` 把非 belt 的 code 限死在 7..20 —— hub=26 发不出来

- **现象**：§2.1 的 kind 枚举里有 `hub`，P2 侧也是齐全的（`SAVE_CODES["hub|default"]=26`、
  `templateForBuildingCode(26).kind==="hub"`、`isV1Emittable("hub")===true`，NOTES 里 P2 自己还
  特意写了「hub 不在 v1 op 枚举里但允许 emit（它是终点）」）。但 P1 的
  `types.mjs:298-300` 有一条：非 belt 实体 `code` 必须在 **7..20**。hub 的真码是 26 ⇒
  **契约先把 kind:"hub" 的 entity 判死**，根本走不到发射。实测：
  `契约违反 plan.entities[8].code: 期望 非 belt 实体用建筑码 7..20，实得 26`。
  同一条 7..20 也会挡住 balancer=4 / 隧道=22（那两个本来就该拒，属于 P5 的 `V8-scope` 口径）。
- **我的实现**：**不改 P1 的文件**（所有权在 P1，plan §3 冲突仲裁）。P6 的行为是
  「kind=hub 的入参 → 由契约给出结构化的 emit:mismatch 拒绝，gate=emit:contract-violation」。
  也就是说 P6 现在**事实上**不接受 hub 进蓝图，但这是 P1 那条 7..20 决定的，不是我加的规则。
  机器 code 的反查（§2.2 迁移路径 5）我照办了：`templateForBuildingCode(code).kind === entity.kind`
  + `codeFor(building,variant,0,0) === code`，不依赖游戏侧。
- **建议（二选一，请主线程定）**：
  (a) 从 `ENTITY_KINDS` 去掉 `hub`（它就是既有世界，plan-l1 也把它放在 `layout.occupancy`）——
      契约的 7..20 就自洽了；或
  (b) 把 `types.mjs:298` 的取值域改成「`OP_TEMPLATES` 里存在的 code」（7..20 ∪ {26}），
      并明确「允许但 P5 的 V1/V2 会 warn：贴一份 hub 到已有 hub 旁边」。
  现在这种「类型允许、契约禁止、P2 说可以」的三态最容易在 P8 接线时炸。

---

## 附：我照 plan 做、没有自行放宽的地方（给主线程省一次复核）

- 不改 `src/shared/blueprint.mjs` / `src/mod/*` / `src/ai/belt-rules.mjs`（stride=5 只出报告，§一）。
- 不 import P3/P4/P5/P8 的实现（只 import P1 的类型 + P2 的 code 真值 + belt-rules + shared 容器层）；
  fixture 手工构造 + 消费 P1 的真产物。
- belt code 只经 `beltCode(rv)`，机器 code 只经 `codeFor(building,variant,0,0)`，无手填常量。
- `validation.pass===true && ok===true` 双查；任何不过 → `blueprint:null` + `beltIntent:[]` +
  §2.5 reason + `failingNode{nodeId,cell,check}`（26 个畸形入参实测 0 throw，`probe.mjs`）。
- 零依赖、零网络、零游戏；`node src/ai/compiler/roundtrip.mjs --test` 退出码 0（83/83）。
