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

## 主线程裁决记录（01:1x，三条已独立核实 + 广播四包）
- **G7 ✅**（复跑证据：`rotateLocal(top,44/46)`→top/top 截断，`angleToDir(44/46)`→top/right 量化）。**belt-rules 不动**（避免移动靶+波及 1906/1906 验证）；各包入口加象限断言（P2 `assertQuadrantAngle` 模式）。
- **G10 ✅**（spec.rates 对 double/quad 是 charges/s，painterDouble 0.25 实为 0.5 件/s）。**V7 只用表2 items/s 口径**；v1 十 op 恰好同值，换算规则必须写死在注释里。
- **G1 裁决：注册表为权威** —— P0-spec 的"非 belt code=internalId+rv×4（quad painter=22/23/24）"**被证伪**（gBuildingVariants painter 仅 16-19；实机 15 建筑全 rv=0）。v1 硬约束"非 belt 只出 rv=0"维持；belt 是注册表唯一多 rv 家族（1/2/3）。
- **K1 采纳**：hubEntries 归一在 `op-templates.hubEntriesWorld`，P3/P6 不得再抄。

## P2 完成（`afd89ce8`→我验收）
812 断言 + 7 组变异测试（证明断言非空转）+ `--validate` 0 差异。核心已随 `e27ac98` 入库；P2 留下的 NOTES/测试刷新**待主线程提交**（no-commit 规则）。
G3：machine-spec 无 unlockLevel → V10 用 UNLOCK_LEVEL_FALLBACK（已通知 P5）。

## 在跑的包
| 包 | Agent | 状态 |
|---|---|---|
| **P3 placer** | `accfae61`→**死在中途写入**（place.mjs 881 行语法不完整、无测试目录）；重跑 `a95cb396`（首笔=整体替换残骸为语法合法实现） | 第二波（DAG→网格；行式主干+M4 汇合+零拐角） |
| **P4 router** | `ac78c98b` | 第二波（left-edge 车道 + 带朝向 Dijkstra；solveTurn 显式定向；M4 陷阱回归锁） |
| **P5 validator** | `a467fa4a` | 第二波（V1-V10+S1；belt-sim 含机器邻居不动点；变异测试+双实现对拍）——盘上仍薄（25+39 行），落后其他包，继续观察 |
| **P6 emitter** | `a308d900` | 第二波（emit+roundtrip=L1 门；顺序锁；stride=5 NOTES） |
| P0-spec / P0-prior | 完成 | 校验已入库 `8d6ffaf`；prior §8 选型被 P4 采纳 |
| P1 / P2 | **完成并入库** | L0 主线程复跑全绿（P1 46+ / P2 383+51+变异 7 组）→ `e27ac98` `5e4d46a` |
| **P7 live** | `af5b67cf` | **完成**（详见下节）——桥接/游戏已解放 |

## P7 完成（01:44 报告 → 主线程独立核验：8 个 result JSON + LIVE-LOG 收尾 + 只读 obs 实测 2805/L11 ✅）
**桥接与游戏已解放**，世界留在 level-11（uid 审计 extra0/missing0）。T1-T3 + F1/F2 全 pass，全部在新档 `9ac66b0b` 做，旧档从未被贴。

### F1 = mod 缺陷实锤（写入第一批修复）
`belt-silent-overwrite.json`：5 格旧带，paste 覆盖 2 格 → 旧 uid 消失、新 uid 顶上、响应 `failed:[]`、
`raw_keys` 无任何销毁字段 —— **静默毁带零报告**，redteam #3b/R3 预测精确成立。

### F2 = R2 是"活的"（stride=5 由"建议"升级为"增量扩张必需"）
9 形态矩阵扫描：paste 本身 0 drift（immutable 包裹坐实）；但**粘贴后在其输出侧接带（PULL 扰动）时 3 种拐角全部翻向**，
NONE/EJECT 扰动不翻。⇒ V3 生成时不动点**覆盖不了未来的合法扩张**；
而 P0-verify 早已证明全部 419 条实机拐角满足 `rot−orig ∈ {0,+90(rv1),+270(rv2)}` —— **存了 orig 的游戏终态本就不翻**。

### 主线程决策（两条，我的车道，含时序约束）
1. **`paste dry_run:true`**：批准。mod 端逐格预检返回 `{would_apply, destroys:[{uid,cell}], blocked:[...]}`。
2. **SZBP1 v:2（stride=5，payload.v 字段区分版本，**不用长度猜**——len 20 会 /4 /5 双解歧义）**：批准。
   export 写 `sme.originalRotation`；paste 用它 + 现有 rv 覆盖；v:2 遇旧 mod → 2006 硬拒（既有 gv 闸同型）。
   **时序红线：P6 在途，其 round-trip 断言 `e.length/4` —— `blueprint.mjs` 的改动必须等 P3-P6 全部收敛入库后再做**，mod 端 dry_run 可先行（无包 import mod 源，只需守 mod_selftest 常绿）。
3. 孤儿 level-1 存档（3 个，含 p7 用的 9ac66b0b）：暂留，批次结束后一并清理（非 level-11 档，无害）。

**待派**：P8 harness（等 P3-P6 落地；L0/L1 用录制 obs 回放，实机只留 results 适配器）。
**主线程挂账更新**：~~①stride=5 等 P7 F2~~ ✅已裁决批准（等 P3-P6 入库后做）；~~②paste dry_run 等 P7 F1~~ ✅实锤批准（可先行，与 mod_selftest 一起改）；③CONTEST 裁决：P1 的 merge-belt-intent.json、P3 金样例④与 scope 的张力（已授权 P3 做成拒绝样例）、P2 的 K1-K6；④ecosystem 退火修正 ✅ 已回填（`9bd6b3e`）；⑤孤儿存档清理。

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
- **断流累计 6 次**（全部已全量重跑，零缩水、零接回主线程）：求解器×2（600s 超时）、规划①（39 调用没落盘）、prior①（129 调用）、spec①（161 调用，但核心 JSON 已落盘→我入库+重跑只做镜像）、**P3①（新形态：死在中途写入，留下 881 行语法不完整文件——重跑提示词首笔=修复文件，且加了"每段 Edit 后 node --check"纪律）**。
  教训演进：write-first 协议解决了"零产出"，没解决"半截写坏文件"——P3 重跑已补上语法门禁这条。
- 任何包失败 = **全量重跑**（同提示词 + 现场事实更新），不降级。
- 各包**不 git commit**；主线程统一提交。
- 包间冲突：只有 P1 能进共享工具；发现别人 bug → NOTES.md 点名，不改对方文件。
- result JSON 是判据真源；**文档写 ✅ 而 result pass:false = 违规**。

## 下一步队列（当前波次回来后）
1. ~~收 P1 → 发 P3+P4+P5~~ ✅（第二波已发；P3 重跑中）
2. ~~收 P2 → 校对 machine-spec 差异~~ ✅（`5e4d46a`，G1/G7/G10 已裁决）
3. ~~收 P7 → 据 F1/F2 定 dry_run 与 stride=5~~ ✅（`cead281`，双批准+时序锁）
4. ~~收 P0-spec/P0-prior~~ ✅（`8d6ffaf`；G1 证伪其 rv×4 外推，注册表为权威）
5. 收 P3/P4/P5/P6 → 主线程复跑 L0/L1 → 入库 → 发 P8（离线回放口径）
6. P8 + L1.5 全绿后：做 **paste dry_run**（可先行）→ L3 端到端（新档 `----CuCu`，无人工坐标）→ **stride=5**（最后做，改 blueprint.mjs+mod，重跑全套回归）
7. 全绿后：compiler 文档化（README 段 + PROTOCOL v:2/dry_run 条款）+ 孤儿存档清理 + 批次总结
