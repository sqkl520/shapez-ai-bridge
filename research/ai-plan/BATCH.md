# 布局编译器执行批次状态（主线程编排账本）

> 规划见 `plan-compiler.md`。此文件是**唯一的调度真相源**：谁在跑、跑什么、下一步发谁。
> 更新时机：每次派发/完成/失败。断线重连后先读这里。

## 地基（已完成，勿重做）
| 件 | 状态 | 提交 |
|---|---|---|
| `src/ai/belt-rules.mjs` | ✅ 1906/1906 穷举 + 1267 链闭合 + 可证伪对照（rv1↔rv2 交换→0；手性取逆→0） | `01af847` `a4e1b3e` |
| `src/ai/belt-rules.test.mjs`（17 条） | ✅ 全绿 | `b099fc2` |
| `research/ai-player/plan-compiler.md`（440 行，P1-P8 包） | ✅ | `b099fc2` |
| `compiler-constraints.md` C1-C8 | ✅ 红队发现已源码复核 | `166fe45` |
| 红队报告 | ✅ 抓到 wire 无 immutable 豁免、隧道 smartplace 删带（两个全新增量） | `166fe45` |
| 删除错误的 proto/belt-rules 副本 | ✅ 单一真源 | — |

**回归基线**：106 条断言（21+7+12+19+47）+ 17 belt 测试；世界 = level-11 **2805 实体**（逐 uid 口径）。

## 关键路径决策（主线程已定）
- **定位 = god-mode**（plan §6 R4 的 blocking question，采纳 plan 默认 B）：
  保留 `charge:false` 与不查解锁；**所有"通关/能力"主张显式标注 god-mode**；
  L3 验收钉在 **level-2 目标 `----CuCu`**（只需 cutter，L1 完成即解锁 ⇒ **两种口径都成立**）。
- **stride=5（originalRotation 入蓝图）由主线程在批次收敛后自己改** `blueprint.mjs`+mod，
  不让并行包碰（plan §2.2.5/§3 禁改清单）。P7 的 F2 实验给这个决策提供证据。
- **v1 范围**：单层 / 无 wire / 无隧道 / 机器 rot 恒 0 / 入度≤2 / 只做全新址。超出 → `ok:false`，不静默降级。

## 在跑的包（更新 01:06）
| 包 | Agent | 状态 |
|---|---|---|
| **P3 placer** | `accfae61` | 第二波（DAG→网格；行式主干+M4 汇合模式+零拐角原则） |
| **P4 router** | `ac78c98b` | 第二波（left-edge 车道 + 带朝向 Dijkstra；solveTurn 显式定向；M4 陷阱回归锁） |
| **P5 validator** | `a467fa4a` | 第二波（V1-V10+S1；belt-sim 独立实现含机器邻居不动点；变异测试+与 belt-rules.test 双实现对拍） |
| **P6 emitter** | `a308d900` | 第二波（emit+roundtrip=L1 门；顺序锁机器→直线→拐角；NOTES 写 stride=5 方案） |
| **P7 live**（独占游戏） | `af5b67cf` | 仍在处置 preflight 失败（new_game 90s 未进世界） |
| P0-spec / P0-prior | 完成 | 校验已入库 `8d6ffaf`；prior §8 选型被 P4 采纳 |
| P1 / P2 | **完成并入库** | L0 主线程复跑全绿（P1 46+ / P2 383+51）→ `e27ac98` |

**待派**：P8 harness（等 P3-P6 落地；L0/L1 用录制 obs 回放，实机只留 results 适配器）。
**主线程挂账**：①stride=5 决策等 P6 NOTES + P7 F2 证据；②`paste dry_run` 等 P7 F1；③CONTEST 裁决：P1 的 merge-belt-intent.json、P3 金样例④与 scope 的张力（已授权 P3 做成拒绝样例）；④ecosystem.md 回填"退火不可复现、改抄 channel routing"修正。

## 活资源警示
P7 的 preflight 失败发生在 `new_game` 之后 —— **收尾行尚未填**（是否回到 level-11 / 2805 未确认）。
P7 仍持有桥接；若它死亡未收尾，由主线程做恢复检查（`save_now` + 离线解码 vs `snapshots/ai-research-base` 逐 uid）。

## 待派（按依赖顺序）
| 包 | 何时发 | 依赖 |
|---|---|---|
| P3 placer | P1+P2 落地后（**可同时发**） | P1 Grid/types、P2 OP_TEMPLATES |
| P4 router | 同上，与 P3 并行 | P1、P2、belt-rules |
| P5 validator | P1+P2 落地后即可（用 fixture 手工构造 LayoutReport，不等 P3/P4 实现） | P1 类型 + 红队 V1-V10 需求单 |
| P6 emitter | P4+P5 产出类型可用后 | P1/P2/P4/P5、shared/blueprint |
| P8 harness | P1-P6 齐（L0/L1 用**录制的 obs 回放**做，不依赖 P7 时序） | P1-P6 |

**活资源**：P7 独占游戏/桥接直至其报告结束。其他包 100% 离线。主线程**不碰桥接**。

## 编排纪律（本网络的现实）
- Agent 静默断流/假完成（39 次调用没写文件）已发生 1 次 → **所有包 prompt 都带「第一笔必须 Write 骨架」**协议。
- 任何包失败 = **全量重跑**（同提示词，不缩水、不接回主线程做）。
- 各包**不 git commit**；主线程统一提交。
- 包间冲突：只有 P1 能进共享工具；发现别人有 bug → 写自己 NOTES.md 点名，不改对方文件。
- result JSON 是判据真源；**文档写 ✅ 而 result pass:false = 违规**（RV-FIX 教训，已进 plan §5）。

## 下一步队列（当前波次回来后）
1. 收 P1 → 立刻发 P3+P4+P5（三条并行）
2. 收 P2 → 校对 `machine-spec.json` 与内嵌表的差异（P2 的 NOTES.md 是真值仲裁材料）
3. 收 P7 → 据 F2 结果决定是否上 stride=5；据 F1 结果把 `paste dry_run` 列入第一批 mod 修复
4. 收 P0-spec/P0-prior → 喂 P2 校验与 P4 选型
5. P6/P8 → L1/L1.5 门 → L3 端到端（新档 `----CuCu`，goal→hub 计数上升，无人工坐标）
6. 全绿后：把 compiler 提交 + 更新 README/docs（面向使用者的"AI 自动建厂"说明）
