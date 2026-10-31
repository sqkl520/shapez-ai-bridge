# 实机验证任务简报（LIVE-VERIFY BRIEF）

> 写给所有参与实机验证的 agent。**先读完本文件，再动手。**
> 本文件是主线程写的事实汇总，不是结论。凡是本文件没实测过的东西，一律标了「未验证」。

---

## 0. 用户的要求（原文，不可改写）

> 实机验证吧，实机验证不要在主线程进行，应该交给agent

叠加用户长期有效的多 agent 指令：

> 你有用不完的token，默认大胆使用多Agent，不必为省token而简化。任何非平凡任务：先由规划Agent拆解，
> 再并行调用≥5个专家Agent（执行、检索、批判、红队、验证等），复杂任务≥5个，并允许递归派生子Agent。
> 子Agent必须独立分析、交叉质疑、补充验证；主Agent负责汇总冲突并输出最优解。
> 简单任务可降为"主Agent+审查Agent"。token不是约束，充分探索、充分辩论、充分验证，
> 期间如有agent因任何问题报错，都必须全量重跑，不要有任何缩水和将任务推给主线程，
> 主线程只负责调度agent和整理信息向用户提交信息

---

## 1. 要验证的到底是什么

阶段 2 的 agent 闭环（`src/agent/loop.mjs`）到目前**只在离线假世界上跑过**。

已完成、有据可查的：

| 项 | 证据 |
|---|---|
| 离线冷启动实验「精确匹配 8/10」 | `research/ai-plan/EXPERIMENT-COLDSTART.md` §22，commit `9440695` |
| 2077 条测试全绿 | `npm test` |
| 诊断层接上产线语义 | `genuine` 见 §3 |

**从未验证的（这次要补的）：**

1. `runLoop` 的 `mode:"live"` 分支在**真桥**上能不能跑通
   （`makeBridgeReader()` 的 obs/debugItems/production/step/tx 五个面）
2. LLM 产出的计划 → `planToTxOps` → `tx` → 游戏真的落地
3. `verifyRuntime` 的 L3/L4 在真世界上是真绿还是恒绿
4. 产线贴完之后，**hub 真的收到目标形状**（这是唯一有意义的成功判据）

---

## 2. 环境事实（主线程 2026-10-30 实测）

### 2.1 桥接与游戏

```
bridge PID 42228, 监听 127.0.0.1:7777, uptime > 3.8h
  GET /health  → {"ok":true,"mod_connected":true,"uptime_s":13951}
  POST /rpc status → {"protocol":1,"mod_version":"0.1.0","game_version":"1.5.6",
                      "in_game":false,"features":["observe","act","batch","step","await",
                      "blueprint","screenshot","save","new_game","entity_snapshot","tx",
                      "delete_by_uid"],"allow_write":true,"allow_step":true}
游戏 PID 29468（主线程 2026-10-30 拉起，之前没开）
  路径 D:\Steam\steamapps\common\shapez.io\shapezio.exe
  当前在**主菜单**（in_game:false）
mod: C:\Users\Administrator\AppData\Roaming\shapez.io\mods\shapez-ai-bridge.js
mod 设置: {"ws_url":"ws://127.0.0.1:7777/mod","allow_step":true,"allow_write":true,"max_entities":20000}
```

**端口 8080 是 steamwebhelper，与本任务无关，不要碰。**

### 2.2 代理（LLM）

```
endpoint: http://ddns2.keniis.top:3000
协议:     Anthropic Messages
key:      <REDACTED-API-KEY>
model:    virtual/opus
实测:     POST /v1/messages 返回 200，model 回显 "SCNet-Max"，content 有 text
```

`src/agent/loop/llm.mjs` 的 `AnthropicClient` 支持 `baseUrl` 参数（commit `7700b7e`），
**刻意不读 `ANTHROPIC_BASE_URL`**（本机该变量被 Claude Code 占用）。
`mode:"live"` 的构造在这里：`makeClient({ mode: "live" })`（`loop.mjs` 里 `--llm` 分支）。

⚠️ **未验证**：`makeClient({mode:"live"})` 到底传不传 `baseUrl`。如果它直接 `new AnthropicClient()`
而没接 `--base-url`，那么 `node src/agent/loop.mjs --goal RuRu---- --llm` **会打到官方 API 而不是代理**。
**这是本轮第一个必须查清的事。**

### 2.3 存档（全部实测解码，`recon/decode_full.cjs`）

| internal_id 前 8 位 | level | seed | 实体数 | 备注 |
|---|---|---|---|---|
| `7c93b3dd` | **4** | 60908 | **1**（只有 hub） | ★ **冷启动目标世界**，2026-10-25 创建 |
| `cf469f75` | 5 | 55013 | 181 | 就是 L4/L5 夹具的来源 |
| `5c967065` | 11 | 43391 | 3093 | **用户的正式存档，不许当试验场** |
| 其余 4 个 | 1 | 各异 | 0 | 空存档 |

`7c93b3dd` 的 `hubGoals`：

```json
{"level":4,
 "storedShapes":{"CuCuCuCu":12,"----CuCu":686,"RuRuRuRu":2016,"----RuRu":4575},
 "upgradeLevels":{"belt":1,"miner":1,"processors":0,"painting":0}}
```

注意 `storedShapes` **没有 `RuRu----`** —— 说明 L4 的目标形状还没交付过，是真冷启动。

⚠️ **未验证**：L4 的 requirement 到底是不是 `RuRu----` / 需要多少个。
离线夹具 `test/fixtures/saves/L4-obs.json` 说 `{"shape":"RuRu----","required":70}`，
但那份夹具是从 `cf469f75`（现在 level 5）早先抓的。**必须实机 obs 确认。**

### 2.4 已有的实机证据（历史，别当结论）

`research/ai-plan/tmp/` 里三份 `play-result.json`：

| 目录 | 存档关卡 | 形状 | anchor | 实体 | readback | 跑了多少 tick | 交付 | 判定 |
|---|---|---|---|---|---|---|---|---|
| `live/l3` | 3 | `RuRuRuRu` | [1,-34] | 107 | 107/107 | 6000 | **23** | **PRODUCING** |
| `lvl4b` | 4 | `RuRu----` | [-1,-17] | 30 | 30/30 | 6000 | **0** | NO-PRODUCTION |
| `lvl4e` | 4 | `RuRu----` | [1,-17] | 28 | 28/28 | 6000 | **0** | NO-PRODUCTION |

这三份是旧的（10-2x），跑的是 `play-level.mjs`（贴**蓝图**，不是走 loop 的 `tx`），
**与本次要验的 `runLoop` 是两条完全不同的路径**。但它们证明了一件重要的事：

> 贴进去 30/30 逐格一致、0 失败 → 产线仍然一个都不出。

这正是 `gates.mjs` 文件头写的那个事故：**几何正确 ≠ 工厂能跑**。

⚠️ **必须查清**：L4 `NO-PRODUCTION` 的根因是什么？是三份旧蓝图本身有 bug，
还是 L4 这个关卡/这台机器上有什么系统性障碍？如果根因是系统性的，
本次实机验证会撞同一堵墙，而且会**误判成 loop 的问题**。

---

## 3. 代码地图（主线程已读过的部分）

```
src/agent/loop.mjs                2167 行  闭环主循环
  runLoop(opts)                  1315     reader/llmClient/goal/mode/budget/dryRun/apply
  makeBridgeReader(baseUrl)      2052     obs/debugItems/production/step/tx 五个面
  runLoopCli(argv)               2089     --goal --mock --llm --dry-run --json --obs --run-dir ...
  成功判据                        1868     verdictNow.achieved → outcome="success"

src/agent/loop/llm.mjs             525    AnthropicClient / makeClient / MockClient
src/agent/loop/prompt.mjs         1385    buildPrompt
src/agent/loop/semantic.mjs       1099    语义诊断（PROCESSOR_REQUIRED 等）
src/agent/loop/structural.mjs      567    结构诊断（DEAD_END 等）
src/agent/loop/recipe.mjs          486    配方 + 等级门控
src/agent/loop/planToTxOps.mjs     702    宏调用 → tx ops
src/agent/loop/verify.mjs          571    verifyRound / applyVerdict
src/agent/loop/offline_boundary.mjs 262   classifyChecks / phaseTwoVerdict
src/agent/verify_runtime.mjs       974    verifyRuntime（L0-L4），有自己的 BRIDGE_READER（85 行）
src/agent/fake_game.mjs            ~250   离线假世界（可注入 reader）
src/agent/gates.mjs               2621   14 道闸，只用游戏运行时当 oracle
src/agent/macros/                          build_line / connect / place / remove
src/bridge/bridge.mjs              799    桥接（零依赖手写 WS）
```

**两处 reader 必须逐字一致**（V2 §5.5 第 5 条）：`loop.mjs:2052` 和 `verify_runtime.mjs:85`。
主线程只肉眼看过签名，**没有实测过它们对真桥的行为是否一致**。

---

## 4. 安全约束（不遵守即失败）

来自 `CLAUDE.md` 与项目记忆，**逐条硬约束**：

1. **游戏实例是独占资源**：同一时刻只允许一个 agent 做**写**操作。
   读（obs/status/debug_items/production/screenshot）可以并发，但**建议也不要**——
   桥接是单进程，实测过并发把状态机搞卡死。
2. **用户的存档 `5c967065`（level 11）不是试验场**。任何 `paste` / `tx` / `delete`
   都不许落到那个世界。实验只在 `7c93b3dd` 或新建存档里做。
3. **动手前备份**：写操作之前先 `snapshot_save`。
4. **先 dry_run**：任何批量写入先 `dry_run:true` 看一眼 `would_apply` / `blocked` / `destroys`。
5. **`gates.mjs` 的 C1**：不许把东西贴到非空地面 —— 替换式贴入会**静默销毁**旧带子
   （实测：`ok:true applied:3 failed:[]`，两条旧带子 uid 消失，mod 不报任何警告）。
6. **`new_game` / `load_save` 是客户端状态转换，靠渲染帧驱动**。窗口最小化 → 帧不跑 →
   `gameStarted` 不触发 → `mod.root` 永远 null → 所有世界调用返回 `1003 not_in_game`，
   而 `status` 仍然正常应答。历史事故：卡了 37 分钟。
   恢复手段：`kit.mjs` 的 `ensureWindowAwake()`（只做 `ShowWindow(SW_RESTORE)`，
   可逆、不杀进程）。**不许 kill / 重启游戏进程**。
7. **`load_save` 实测要 ~2 分钟**才真正进世界，`kit.mjs` 等 360 秒。

---

## 5. 你（agent）必须遵守的纪律

### 5.1 不许「简化模型代替真实现」

主线程在这一类错误上栽过 **4 次**，全部被下游 agent 抓住：

1. 把 L5 的 dump 当 L4 用 → 结论全错
2. 手抄 `hubReachable` 的简化版（没穿过机器）→ 58/163，真值 152/181
3. `byCell` 用 origin 索引而非 footprint 索引 → hub 4×4 漏索引，6 条带子误判死路
4. 以为 footprint 只对 hub 重要 → 实际还有 4 个 2×1 balancer 的第二格

所以：**每一项结论必须附「用什么命令测出来的」**。没有命令的结论一律标 `未验证`。

### 5.2 不许把「看起来对」当「测过」

同样的坑，测量类：

- 「connect 0/160」——只枚举了 cutter/trash/hub，漏了 balancer，真值 27 次成功
- 「10 轮 6/10 → 11 轮 0/10」——数的是 `say` 里有没有出现 hub，不是 `calls.args` 里有没有 hub 入口
- 判据写死坐标（`xs:[4,5]`）→ 把落在 x=2 的正确答案判成失败

**每条判据都要问：如果模型给出另一种同样物理可行的解，我的判据会不会把它判错？**

### 5.3 报告格式

每个 agent 最后一条消息必须是：

```
## 结论（一句话）
## 证据（命令 + 原始输出，可复跑）
## 我没验证的 / 我不确定的
## 如果我是错的，最可能是哪里错
```

第四项**不能空着**。

---

## 6. 这一步的边界

主线程只做三件事：写本简报、派 agent、汇总结果给用户。
**所有实机操作、所有代码阅读、所有判断，都由 agent 做。**

如果你在实机验证中发现 loop 有 bug，**不要直接改代码**——先把 bug 写成带复现命令的报告，
交回主线程，由主线程派修复 agent。这样「发现」和「修复」的手不混在一起。
