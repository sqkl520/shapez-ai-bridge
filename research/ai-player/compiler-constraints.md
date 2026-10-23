# 编译器硬约束（主线程集成，全部经源码/实验复核）

> 执行包（planner 拆解出的）的提示词**必须携带本文件结论**。
> 来源：红队报告 `redteam-compiler-assumptions.md` + 主线程对上游源码的逐条复核 +
> `review/ADVERSARIAL-REVIEW.md` + 实机事故记录。标注 = 复核方式。

## C1. 粘贴的三态占用不对称（severity 5，红队 #3b；复核：主线程读 logic.js:61-164 ✅）
- 落在**空**格 → 放置成功。
- 落在**既有 belt/wire**（唯一两类 `getIsReplaceable()=true`，belt.js:68/wire.js:122）→
  `freeEntityAreaBeforeBuild` **静默销毁旧带替换**，`applied` 计数照算、`failed` 不含它——**不报告删了什么**。
  （真实事故：研究期间毁过 6 条 level-11 工厂带。）
- 落在**既有机器** → 该格进 `failed`，其余格**照常放置**（部分成功、返回仍 ok:true）。
⇒ **编译器规则**：paste 前必须逐格三态碰撞检查（空/belt-wire/机器，机器用旋转后包围盒）；
**任何非空格 → 整单 abort**（v1 不做 allowOverwrite）；paste 后校验 `applied === 实体总数`，不等即视为失败并回滚。

## C2. SZBP1 不存 originalRotation（红队 #3a；复核：bridge:1458 导出仅 sme.rotation ✅）
游戏事后重算带子以 `originalRotation` 为基准；同一 (rotation,rv) 的"正确 orig"取决于命中 belt.js 哪个分支，**不可从 (r,rv) 反推**。
⇒ 一次性 paste-and-run 被 immutable 掩盖；**粘贴后旁补一格**（RV-FIX T3 已证实会触发重算）或日后邻域扰动可能静默翻向。
**v1 纪律：整块贴、贴后不在其旁补放任何格**；接旧厂用 place_path（不是 paste）。stride=5 改造列为后续项（要过协议版本）。

## C3. wire 层没有 immutable 保护（红队 #2a；复核：`grep immutableOperationRunning systems/wire.js` = 0 命中 ✅）
`updateSurroundingWirePlacement`（wire.js:714-760）连粘贴过程中都会按 originalRotation 重算 wire。
⇒ **v1 范围排除 wire 层**（编译器 ok:false + 上报，不静默降级）。

## C4. 隧道 smartplace 会在 paste 中途删带（红队 #2b；复核：underground_belt.js:39/53-66 ✅）
`onEntityManuallyPlaced` 无 immutable 判断，receiver 放下载体时**删掉它与 sender 之间的带子**；
而我们的 `placeOne` 每格都 dispatch `entityManuallyPlaced`（bridge:821）。
⇒ **v1 范围排除 underground_belt**。（后续若要支持：paste 前设 `enableTunnelSmartplace=false` 或两侧不留带子——均需实机验证。）

## C5. solveTurn 的验证是"自洽"不是"对齐游戏"（红队 #1；主线程补充：已在 22:5x 用邻居拓扑/链闭合做了第二判据，**但机器邻居从未喂给 compute**）
- 单一真源：`src/ai/belt-rules.mjs`（proto 错误副本已删，提交见 log）。
- 编译器产每个带子格后须跑**可布性自检**（见 C6 清单），机器邻居拓扑要用 `machine-spec` 的 acceptor/ejector 表算，不靠游戏自动定向。
- 实机判据（验证包）：单格显式 rv + 矿机预测入口 + trash 预测出口 → 解码存档看 item 流向；覆盖 solveTurn 的 12 组输出。

## C6. 可布性检查清单（编译器 paste 前逐项过，任一失败 = `{ok:false, reason, failingNode, hint}`）
1. 包围盒全空（机器按旋转后 `getTileSpaceBounds`）；
2. 每带子格（含机器邻居）是 computeBelt 不动点，或处于 immutable 一次性 paste 中；
3. 输入流数 ≤ 机器输入槽数（stacker/mixer=2、quad cutter 输出 4 路要有汇合方案，v1 拒绝）；
4. 流不交叉（regular 层同格冲突 → v1 无隧道 ⇒ 换车道或 ok:false）；
5. +y 系机器（cutter/stacker/mixer/rotater）与 +x 系（painter）**不串同一直线**；
6. 颜料独立通道（mixer 产 cyan 等）；
7. 吞吐瓶颈检查（速率表 GEOMETRY-TABLE §表2；stacker=0.25/s）；
8. 多层目标（`:` 分隔）v1 直接 ok:false（布局未验证）；
9. 废槽（cutter 第二输出等）必须有 trash/去向。

## C7. 定位：god-mode（决策已做）
mod 特权路径（`charge:false`、不查 `getIsUnlocked`）**保留**，但：
- 所有"通关/能力"主张必须标注 god-mode；
- **验收阶梯 L3 用 level-2 目标 `----CuCu`**——cutter/trash 在 L1 完成即解锁（levels.js:164+），
  这条验收**天然合法**，不依赖特权；
- `obs`/报告里回报"该建筑当前等级是否已解锁"列为待办工具项（不改 mod，agent 侧用 goal.upgrade/已知表算）。

## C8. 活资源与安全纪律（不变）
游戏+桥接仅实机验证包可用；动世界前 snapshot；远离工厂区且 obs 实查为空；事后**逐 uid 对拍**
（`snapshots/ai-research-base` = 2805 基线）。
