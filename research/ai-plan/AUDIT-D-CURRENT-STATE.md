# D 方向内部体检：这个项目现在到底能做什么

日期：2026-10-28　存档 `cf469f75`（L5，180 实体，hub `(-2,-2)`，seed 55013）
方法：只读 RPC 实测（未调用任何写 op、未跑 `--apply`）+ 读代码。所有命令可复现。

---

## 1. 能力清单

### 1.1 读：能看到"几何与流量"，看不到"状态与意图"

| 手段 | 实测输出 | 证据 |
|---|---|---|
| `status` | 313 B / 238 ms | `curl -X POST :7777/rpc -d '{"method":"status","params":{}}'` |
| `obs` | 16 个顶层字段；实体 **9** 个字段（uid/type/x/y/r/variant/rotation_variant/code/layer），180 条=**21.8 KB / 234 ms**，约 117 B/实体 | `shapez-ai-bridge.js:1255-1267` |
| `debug_items` | 带子物品 74 条（`cell,path,idx,pos,spacing,item`）、ejector 槽 6 条、`paths` 18 条含 `boundAcceptor` | `:898-1023` |
| `production` | 6 片×10 s=60 s 窗口，produced/delivered/stored_delta + 每片原始计数 | `:597-660` |
| `resources` | `[-30,30]` 内 150 格矿，按 key 聚合 + 每行连续段 | `:720-790` |
| `world_info` | `seed 55013, hub (-2,-2,w4)` | 实测 |
| 另可用 | `debug_loop / debug_log / debug_app_state / game_setting / list_saves / debug_canvas_api` | `:480-546` |

**准确度核对（两次采样间隔 60.3 游戏秒）**：

```
shape     obs.stored 增量   obs 速率   production.delivered_per_sec
RuRuRuRu       +48          0.796             0.700
----CuCu       +30          0.497             0.450
RuRu----       +24          0.398             0.367
```

`production.delivered_per_sec` **系统性偏低 8~12%**，因为 `slice(-wantSlices)` 把"正在累积的
最后一片"也算进分母（`:606`、`:644`）。去掉最后一片后 RuRuRuRu = 0.800，与 obs 增量 0.796 差 0.5%
—— gates 的 G6 正是这么做的（`gates.mjs:562`）。**裸调 production 会低估产能。**

**读不到（确定性缺口）**：
- 建筑内部状态：storage 存量、filter 过滤项、cutter 输入槽、miner 当前矿种 —— `obs` 只有
  几何九元组，`volatileSnapshot()`（`:1969`）只服务 `debug_entity_roundtrip`，**没有对外的读取 RPC**。
- 信号网络的**值**：wire 层能列实体（`obs layer:"wires"` 返回 1 个 `constant_signal`），但值不可见。
- 堵塞原因：只有 `boundAcceptor: null/"yes"`（实测取值只有这两种），没有"被谁堵、堵多满"。
- 带子"意图"：只有 `code/rotation_variant`，没有规划语义。
- **MCP 面更窄**：`server.mjs:264-441` 只注册 8 个工具，`production / debug_items / resources`
  **一个都没转发**。走 MCP 的 LLM 看不见吞吐和带上物品。

### 1.2 写：14 个 op，能放不能改

`act` 的合法 op（错误信息自证）：`noop camera export_blueprint save load new_game step await
set_speed place place_path delete bulk_delete paste_blueprint`（`actionSpecs` `:2415-2435`）。

| op | 自证（返回实际值） | 缺口 |
|---|---|---|
| `place` | `requested/actual/mismatch`（`:2616`），rv 可显式指定 | 只能新建，不能改参数 |
| `paste_blueprint` | `applied/failed/count/cost`，`dry_run` 给 `blocked/destroys` | dry_run 只查占地，不查方向 |
| `delete` | `freed_uid` | **只能按坐标删，不能按 uid**（`opDelete` `:2729`） |
| `bulk_delete` | `applied/failed`，dry_run 列清单 | **只有区域删**，误删风险 |
| `place_path` | `applied/failed/first_uid` | 只支持轴向直线 |
| `step/await` | `ticks_advanced_seconds + diff` | — |

**做不到**：
- 改任何建筑参数（storage 容量、filter 项、constant_signal 值、矿机矿种）——没有 `set_signal` 类 op。
- 按 uid 精确删除。这一点连 gates 自己都写死了：`gates.mjs:1679` hint 原文
  "要么按 uid 逐个删（桥不支持），要么整档恢复"。
- 事务/撤销：`serializeEntity/restoreEntity` 原语已提交（3306ade，`:1654/:1693`），但**没有 `tx` op**，
  只能通过写 RPC `debug_entity_roundtrip` 间接摸到，且它只处理单实体。
- 旋转加工机器：实机实验证明 `r=180` 的 cutter 四侧都不收货（`WHY-NO-CUTTER-INSERT.md` §下一步）。
- 解锁等级：`place` 不校验（god mode），storage/filter/wire 现在就能放——但编译器不知道它们的几何。

### 1.3 验证：282 条测试，全部离线

```
node src/agent/gates.test.mjs    → 282 通过 / 0 失败 / 1.9 s
node test/mod_selftest.mjs       →  60 通过 / 0 失败 / 1.8 s
node test/mod_rpc_selftest.mjs   →  12 通过    node src/bridge/selftest.mjs → 19
node src/mcp/selftest.mjs        →  47 通过    node test/blueprint_selftest.mjs → 12
node src/ai/op-templates.test    → 385 通过    node src/ai/belt-rules.test.mjs → 17
```

`gates.mjs` 2095 行、12 个闸函数，`runGates` 接线 9 道（G2' 同源 / G-1 时钟 / G9 世界 / G3 净空 /
G4 落地 / G6 行为 / G6b 连通 / G7 流向 / G8 链划分；G12 截图可选；G10/G11 只能由调用方单独调，
`gates.mjs:42`）。**282 条测试一条都不连游戏**——全部跑在 `http.createServer` 假桥上
（`gates.test.mjs:1086`），零实机回归。真实存在的 `runGates --apply` 全绿记录，我在仓库里没找到一条。

**跑一次的成本**：`--plan` 实测 0.9 s；`--apply` 额外推进 7200+4800 tick，按 M3-ROUND3 实测
50 µs/tick ≈ 0.6 s。钱不是问题。

**诚实提醒**：`gates.mjs:58` 写"`--plan` 零写入"，**这是错的**。G-1 会发
`act {op:"step", ticks:600}`（`:268`），实测 tick 前进 5.042 s。跑 `--plan` 也在推进世界。

**闸抓不到的失败模式**（代码里 9 处 `undecidable`）：
1. G3 只看 `dry_run` 的占地——反向 cutter 与正向 cutter 占同一格（`M3-REVIEW.md` 已认定）。
2. G4 只比 `code` 与 `r`。`rotation_variant` 在 `gates.mjs` 里出现 **0 次**；带子的"语义方向"
   由 G7/G8 补，但它们依赖 `debug_items.paths`。
3. `debug_items.paths` 是**全局**的（region 传 `[100,100,140,140]` 仍返回 `path 0` 的 `(-10,3)` 链），
   且只给前 40 条（`:997`）。超过 40 条 path 时 G6b/G7/G8 一律 `undecidable`。
4. `entityCells()` 对未知建筑**静默退化成 belt 1×1**（`gates.mjs:139`）——实测
   `entityCells('storage',5,5) → [[5,5]]`。补了 storage 之后，闸会拿错几何当真值。
5. G6 采样点只有 t+0 与 t+60 s；60 s 之后才慢慢死的线抓不到。
6. 全链路只验"这条线自洽且产得出目标形状"，**不验成本、不验对既有产线的污染**。

---

## 2. 端到端推演：现在能不能独立玩一关？

**不能。卡点在"编译器只会画空地，而存档不是空地。"**

实测（离线编译 + 只读 dry_run 对拍真实世界）：

```
node src/ai/compiler/cli.mjs --goal <G> --seed 55013 --hub "-2,-2" --no-handoff --json
node src/ai/compiler/cli.mjs ... --world <obs.entities 导出>
```

| 目标 | 不给 --world | 给 --world（真实 180 实体） | 对真实世界 dry_run |
|---|---|---|---|
| CuCuCuCu | ok，9 实体 | **fail** column-conflict | apply 9 / **delete 5** / blocked 0 |
| ----CuCu | ok，22 | **fail** | apply 21 / **delete 14** / blocked 1 |
| Cu----Cu | ok，38 | **fail** | apply 35 / **delete 27** / blocked 3 |
| RuRu---- / CrCrCrCr / CgScScCg | fail | fail | — |

两种模式互为死角：
- **不给 `--world`**：3/6（`CuCuCuCu`/`----CuCu`/`Cu----Cu`）能在 hub 旁排出图，但落点压着现有产线，
  `dry_run` 显示会销毁 5/14/27 个既有实体，G3 判红。这就是 `gates.mjs --plan` 真实跑出来的结果：
  `✗ G3-clearance 3 处被阻断，首处 [-8,-3]`。
- **给 `--world`**：0/6。`regionClear()`（`compile.mjs:1156-1160`）要求"世界里除 hub 外一个实体都没有"
  ——我实测放一条 **300 格外的**带子就让编译失败（`world-far` 用例）。v1 明确不做增量对接
  （`plan §6 R2`）。所以"hub 钉死 + 有旧工厂"这个**唯一真实场景**必然失败。

结论链：
`归档事实 → obs/resources/world_info` → `编译` → **失败或压旧线** → `手工蓝图 + dry_run + paste`
→ `G3/G4/G7/G8/G6` → 可验证。

可玩的路径只剩一条：**人先想好几何，写成 SZBP1 蓝图，AI 负责 dry_run/paste/验证**。
`L4-E2E-RESULT.md` 记的"打通 L4"正是这条：**+2 个实体、手写坐标**，不是编译器产物。
编译器在真实存档上的历史成绩是 **0/6**。

当前存档自身的病也治不了：4 台铜矿机里 `(-10,*)`、`(-9,*)` 两条竖直带各堵 12/11 个物品，
`boundAcceptor=null`（`debug_items` 实测），而 `delete` 不能按 uid、`bulk_delete` 会误伤旧线，
回滚准入校验（`gates.mjs:1674-1680`）在混合区直接拒绝。**AI 看见了这个洞，但没有工具去补。**

---

## 3. 投入产出

139 次提交 / 8 天（10-20→10-28）。按目录：`src/ai` 37、`src/mod` 26、`src/agent` 21、
`research` 94、`docs` 8。`research/ai-plan` 单独 79 次提交、5,392 行 markdown（约 1.7 万字）。
代码 28,010 行，测试 5,547 行。

**花得最多**：布局编译器（`src/ai/compiler` 12,036 行，31 次提交）。产出：空地上能排出
3 种单线，真实存档 0/6。**这是最大的沉没成本**，但它的失败被 `--world` 的"全有或全无"策略
保护住了（不会假绿成"贴上去"）。

**产出能复用的**：
- `obs/debug_items/production/resources` 四个读数 + 语义修正（`production` 含尾片、`paths` 全局）
  —— 这些是**实打实的能力**，有 bug 修复记录，可独立于编译器使用。
- `dry_run` + 12 道闸 + 282 条离线测试：防的是"贴完才发现方向反了"。价值已被 L4 事故与
  红队三轮验证（`M3-FINAL.md`：8 闸→5 闸、判据只认运行时）。
- `place` 的 `requested/actual/mismatch` 自证、写操作串行链、`debug_app_state` 的加载根因诊断。

**已废弃/被推翻的方向**：
- `L4-BUILD-SPEC.md`（43/45 实体方案）→ 被 +2 实体方案取代，文件头自认。
- `WHY-NO-CUTTER-INSERT.md` "插不进去"→ 只对一半（`x=2..5` 向上段可以插）。
- "切割机两槽各出一半"→ 错，是"输入 1 出 2"（`AI-CONTROL-GAPS.md` 附录）。
- 默认 seed 43391 → 本存档是 55013，之前所有"编译成功"在本档上不成立（`L4-SEED-FINDING.md`）。
- 8 道闸设计 → 6 个批判 agent 推翻（`M3-REVIEW.md`）。
- `research/ai-player/`（20 次提交，10-23~24）→ 转向 `ai-plan`，事实基座留用，设计未落地。
- `BATCH.md` 旧派工表、`--site` 参数（实测 `--site 60,60` 与默认 anchor 完全相同，无效）。

---

## 4. 一句话结论

**它现在是一个优秀的"仪表盘 + 检查单"，不是一个能开飞机的自动驾驶**：能精确测量工厂、
能在动手前说"这一贴会拆掉 27 个旧实体"、能在贴错后当场回滚；但它的规划器只在空地上会画图，
真实存档里 0/6。项目的真实水平 ≈ **一个能读会验、不会建的资深质检员**。

最该修的不是再写一道闸，而是让编译器接受"世界不干净"——`regionClear` 那一条
就把 100% 的真实场景挡在门外；以及补上 `delete_uid`，否则连眼前这两条堵死的铜带都修不了。
