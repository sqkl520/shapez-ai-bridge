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

## 主线程裁决记录（第二批：P6 交来的 CONTEST，02:4x）
- **C-1 批准（发射器口径）**：§2.1 的 dx/dy 双定义互斥，认「**世界 = site.anchor + [dx,dy]**、`w` 归一为世界 min corner」——实机与 P7/mod 都按这个口径；plan §2.1 的"拆两行写死/或 anchor≡w"作为 plan 勘误留批次总结做（改 plan 文档 ≠ 改契约）。
- **C-2 批准**：beltIntent 独立成表、解码↔表比对（同字段自比=同义反复）；plan §5 第 1 条按此读。
- **C-5 主线程处理**：hub kind（code 26）被 P1 契约 7..20 区间拒——**批次收敛时统一修**（P1 入库文件，在途包不许改；选项=去 hub 或改「OP_TEMPLATES 存在的 code」判据）。P6 的 L1-10 记录现状即可。
- **C-3/C-4 知悉**：排序职责 P6 默认 strict 拒、逃生口 `entityOrder:'reorder'` 产字节等价——P3/P4 验收本就有产出顺序要求，一致。**G-P2-argv-guard：主线程亲修 @f7f7a2d**（独立复现 red→green：caller 判红后装载 P2，终态 exit=0）。修复=invokedDirectly 守卫（P1 现成模式）；probe 转 12 条回归锁（含"判红路径零夹带"补强与兄弟模块同标准）；全套回归 106+17+637+289 绿后入库。**教训**：兄弟包交来的缺陷报告，主线程复现后才修——P6 自己没越界改 P2，铁律运转正常。

## 在跑的包
| 包 | Agent | 状态 |
|---|---|---|
| **P3 placer** | ✅ **完成**（主线程复跑验收 `ccb5242`）：78 断言绿、四张金网格逐字节、G1/G7/G10/K1 裁决全落地、ordinal 撞号三连锁（闭合 P4 的 null-reason 路径）| 第二波 |
| **P4 router** | ✅ **完成**（主线程复跑验收 `06d4b7b`）：L0 **184 全绿** + **变异 19/19 全抓 0 存活**；揪修 3 真 bug（reason 可 null / 陈旧 lane 破互逆 / localeCompare 破坏跨机确定性）+ 识别 1 等价变异陷阱 + 语义声明转可证伪锁 | 第二波 |
| **P5 validator** | ✅ **完成**（主线程复跑验收 a76eb17）：171 断言绿、变异 19/19 全抓、双实现对拍 0 差异（belt-sim 槽位法 vs 验证者 OPP 回指法，同一存档 1267/1268+69/69）。**includesMachineNeighbors 恒真**——proto 脚本 82.5% 是欠算（2×2 对照：92.5/86.3、95.8/83.8）。CONTEST 裁决：①hubConnection.entry=**带子末格**（与 P3/P7/mod 三方合流，批次尾回写 plan §2.3 勘误）；②`--plan` 无 intent = **UNDECIDABLE（exit 2 不是绿灯）**→ P8 交接永远带 intent 文件；③kindOf(op) 归 P2 补（P5 有本地 fallback 不阻塞）；④0.78 是弧长不是容量因子，V7 仅在带限时折算（prior-art §7 口径）|
| **P6 emitter** | ✅ **完成**（主线程复跑验证）：L1 门 85/85、run-all 289 断言全绿；顺序锁/永不 throw/锚点归一/平移不变全过。stride=5 报告见其 NOTES：★实测 v:1 原地加列会在 n%4==0 时**绕过 %4 闸静默错位**（8 格被解成 10 实体）→ 方案=**平行数组 o + 升 v:2**；容量增幅 11-27% |
| **P8 harness** | `a59b6c74` | **在跑**（最后一包）：compile.mjs 管线 solver(spawn)→place→route→validate(带 intent)→emit + CLI + 录制回放 L0 + out/ 交接三件套。solver.mjs 零导出→spawn --json 消费；cutQuad 按等级门控 |

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

**待派**：无——P8 是最后一包（在跑）。P8 入库后 → 主线程做收尾三件：**L3 实机端到端**（P7 复活：out/ 交接件 → paste → await，plan §5 L3 判据）→ **stride=5 的 v:2 格式**（P6 设计已批准，最后做+全回归）→ **plan 勘误回写**（entry=带子末格、UNDECIDABLE 交接纪律、退火已在 `9bd6b3e` 修）。
**✅ `paste dry_run` 已做完并实机验证（`97e6637`，03:15）**：mod+协议+4 自测（25 条全绿）；实机对照——同弹药贴工厂密集区报 3 apply/3 destroy/5 block（真 uid），贴空地报 8/8 干净，**dry_run 后世界 2805 零改动**。L3 的 P8/P7 脚本从此必须先 dry_run 核对再真贴（PROTOCOL §5 已写明；其局限：plan 内多格机器互叠归 V1，mod 不兜底）。
**主线程挂账更新**：~~②paste dry_run~~ ✅完成；③CONTEST 裁决增量：C-1/C-2/C-5（hub kind 7..20 区间）已裁决（C-5 批次收敛时统一修 P1 判据）；P6 报的 `op-templates argv 洗灯`缺陷 ✅亲修+回归锁（`f7f7a2d`）；⑤孤儿存档清理待批次尾。

## L0/L1 断言账（各包主线程**亲自复跑**所得，非口头）
contract 92 · data 637+变异 7 组 · router 184+变异 19/19 · validator 171+矩阵 19/19+双实现 0 差 · emitter 289（含 L1 85）· placer 78 · belt-rules 17（17/17）· 既有五套回归 25+7+12+19+47 —— **合计 ≈1480+ 条，全绿**。
P8 在建 `run-all.mjs` 把这张表变成一条命令。

## 旧·待派表（已废弃，留作演进记录）
| 包 | 何时发 | 依赖 |
|---|---|---|
| P3 placer | P1+P2 落地后（**可同时发**） | P1 Grid/types、P2 OP_TEMPLATES |
| P4 router | 同上，与 P3 并行 | P1、P2、belt-rules |
| P5 validator | P1+P2 落地后即可（用 fixture 手工构造 LayoutReport，不等 P3/P4 实现） | P1 类型 + 红队 V1-V10 需求单 |
| P6 emitter | P4+P5 产出类型可用后 | P1/P2/P4/P5、shared/blueprint |
| P8 harness | P1-P6 齐（L0/L1 用**录制的 obs 回放**做，不依赖 P7 时序） | P1-P6 |

**活资源**：P7 独占游戏/桥接直至其报告结束。其他包 100% 离线。主线程**不碰桥接**。

## 编排纪律（本网络的现实）
- **断流累计 7 次**（全部已全量重跑，零缩水、零接回主线程）：求解器×2（600s 超时）、规划①（39 调用没落盘）、prior①（129 调用）、spec①（161 调用，但核心 JSON 已落盘→我入库+重跑只做镜像）、**P3①（死在中途写入，留 881 行语法坏文件→重跑首笔修复，02:2x 已绿）**、**P4①（死在最后一公里：128 断言全绿+缺 ⑬ 测试节；重跑被要求把前任绿测试当草稿——逐断言变异检查揪永绿断言，P2 的 7 组变异是标准）**。
  教训演进：write-first 治"零产出"→ 语法门禁治"半截写坏"→ 现在补第三种门禁：**接手的绿测试必须重新挣得（mutation-check），绿≠真**。
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
