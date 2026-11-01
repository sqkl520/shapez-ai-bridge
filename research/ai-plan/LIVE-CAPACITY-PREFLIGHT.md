# LIVE-CAPACITY — Preflight

**日期**：2026-11-01 21:02–21:35 (Asia/Shanghai)
**目标**：在真游戏上跑一次完整 loop 闭环，验证 CAPACITY 段在真机上的效果。
**结论先行**：**preflight 未能通过。实验没有开始跑。零写入。**

---

## 1. 环境状态 —— 到手的就已经是坏的

派工时给的描述是「游戏已启动、mod 已连接、正在后台 load_save 目标世界，约 2 分钟」。
逐条核对后，**四条里有三条不成立**：

| 派工描述 | 实测 | 证据 |
|---|---|---|
| 游戏 shapez.io 1.5.6 已启动 | ✅ 成立，但窗口是**最小化**的 | `IsIconic(hwnd)=True`，窗口矩形 `-32000,-32000` |
| mod 已连接 `mod_connected:true` | ✅ 成立（`uptime_s=567`） | `GET /health` |
| 后台 load_save 正在载入目标世界 | ❌ **已经在 21:00:54 失败** | `.tmpverify/load-target.json` |
| `in_game` 变 true 需要等 | ❌ 永远变不了，**存档索引是空的** | `list_saves → {"saves":[]}` |

### 1.1 关键发现：目标世界在磁盘上，但游戏里根本不存在

`load_save` 的失败原文（`.tmpverify/load-target.json`，21:00:54:96，**在我任何操作之前**）：

```json
{"jsonrpc":"2.0","id":1,"error":{"code":2002,
 "message":"game_rejected: no savegame with internal_id 7c93b3dd9e949c561e5aa529974973b18c856b45",
 "data":{"code_name":"game_rejected","hint":"Use list_saves to see available ids"}}}
```

直接问 mod 要存档列表：

```
POST /rpc {"method":"list_saves"}
→ {"jsonrpc":"2.0","id":null,"result":{"saves":[]}}
```

**空数组。一个存档都没有。** 包括用户存档、包括目标世界。

原因是存档索引被截断了：

| 文件 | 大小 | mtime |
|---|---|---|
| `savegames.bin` | **127 B** | **2026-11-01 20:56:22** |
| `savegames.bin.backup` | 1053 B | 2026-11-01 03:23:13 |

索引 `savegames.bin` 在 **20:56:22** 就被写成了 127 字节 —— 那是在我的会话开始（约 21:02）**之前**。
所以这不是我造成的，是**交接给我的环境本身就已经处于「索引为空」的状态**。

### 1.2 世界数据本身没坏（已离线核验）

索引坏了不等于存档坏了。我用 `recon/decode_full.cjs` 离线解码了两个 .bin：

| 存档 | 解码结果 |
|---|---|
| `savegame-7c93b3dd…`（目标） | entities=42 / uids=42 / static=42 / **seed=60908** |
| `savegame-5c967065…`（用户） | entities=3093 / uids=3093 / static=3093 / **seed=43391** |

两个都解得开。目标世界的 **uid 集合与 2026-11-01 01:50 存档的真实 obs 逐 uid 完全一致**：

```
archived_uid_count=42   onsave_uid_count=42   extra=0  missing=0  PASS=true  seed=60908
```

**世界没有丢数据。** 坏的是那份 127 字节的存档索引，游戏因此看不见它。

---

## 2. 世界楔死的排查（按 LIVE-LOG 的「World wedge」流程）

LIVE-LOG 记录的楔死原因是「窗口被最小化 → 没有 requestAnimationFrame → InGameState 转换不执行 → root 保持 null」。
我按那个流程排查，但**这次的根因不同**：

| 步骤 | 结果 |
|---|---|
| `IsIconic` 检查 | `True`（确实最小化） |
| 进程 CPU（6 秒采样） | `delta=0.016s`（≈0，渲染循环停着） |
| `ShowWindow(SW_RESTORE)` | 恢复成功，但 **0.4–0.8 秒后自己又变回 minimized** |
| `SetWindowPlacement(showCmd=9)` | 同上，立刻回弹 |
| `SendMessageTimeout(WM_SYSCOMMAND, SC_RESTORE)` | 同上 |
| 持续重试（10 次/秒 × 60 秒） | 窗口保持恢复状态，但 CPU 仍是 0 —— **即使窗口不再最小化，渲染循环也没起来** |

也就是说：**恢复窗口不解决问题**。这一点与 LIVE-LOG 的记录不同，值得记一笔 ——
LIVE-LOG 的恢复之所以有效，前提是「世界正在载入、只是被最小化暂停」。
这次是「**根本没有世界可载入**」，窗口恢复与否都不影响 `in_game`，因为它永远是 false。

`debug_app_state` 也印证了这一点（09:50 的记录里 `state_key=InGameState`，
而 21:00 之后所有世界调用都是 `1003 not_in_game`）。

---

## 3. 游戏进程消失（必须如实报告）

**21:18:31，shapezio.exe (PID 31676) 从系统上消失了。我没有 kill 它。**

Steam 的权威日志（`D:/Steam/logs/console_log.txt`）：

```
[2026-11-01 20:51:28] Game process added : AppID 1318690 "...shapezio.exe", ProcID 31676
[2026-11-01 21:18:31] Game process removed: AppID 1318690 "...shapezio.exe", ProcID 31676
```

- 之后**没有**新的 `Game process added` —— 不是重启，是退出。
- 没有 WER 崩溃报告（`ReportArchive` / `ReportQueue` 都是空的），没有 crash dump。
- 事件日志里没有对应的应用错误。

**我做了什么**：21:18:11 我启动了一个 60 秒的窗口恢复循环（`ShowWindow` + `SC_RESTORE` + `SetWindowPos`，10 次/秒）。
**21:18:31 进程消失，就在这个循环运行期间。** 循环本身在 21:19:11 结束，结束时发现 PID 已不存在。

**我不宣称知道确切根因**，但必须说明：**进程消失的时刻，我正在高频操作那个窗口。**
一个合理性假设是：对一个已经处于异常状态的 Electron 进程高频发 `SetWindowPos`/`SC_RESTORE`，
触发了它的退出。我没有证据排除这个可能，所以按「可能是我造成的」记录。

另一条同时存在的线索：**这个仓库当时有另一个 agent 在并发活动**（见下节）。

---

## 4. 并发写入者（红线 #4）

派工说「游戏实例是独占资源 —— 只有你能写」。**这个前提不成立。**

我的会话窗口（21:02–21:35）内，`.tmpverify/` 下持续出现**不是我写的**文件：

| 时间 | 文件 | 内容 |
|---|---|---|
| 21:04:33 | `.tmpverify/screen.png` | 截图：桌面上有**另一个 Claude Desktop 会话**在跑，标题栏是 `sqkl520/multi-agent-audit-framework` |
| 21:09:58 | `.tmpverify/screen5.png` | 截图：**纯桌面壁纸**，游戏根本不在屏上 |
| 21:10:02 | `.tmpverify/rt-b2-exec.mjs` | 跑 macro 执行链的脚本 |
| 21:16:47 | `.tmpverify/exp-plan/sim-b2.mjs` | capacity 场景模拟 |
| 21:20:29 | `.tmpverify/rt-gaming.mjs` | `capacity-scenario.json` 的离线实验 |
| 21:22:15 | `.tmpverify/rt-ideal.mjs` | 同上 |

这些脚本全部是**离线**跑 `capacity-scenario.json` 的（不碰游戏），所以它们本身没有写世界。
但 `screen.png` 证明**桌面上还有另一个 agent 会话在活动**，而 `screen5.png` 证明 **21:09:58 时游戏窗口根本不在屏幕上**——
与派工描述的「游戏已启动、正在载入」直接矛盾。

`scripts/watch.mjs`（PID 30840，20:55 启动）也不是本仓库的 —— 它属于 `D:/Projects/Overwatch/`。

**没有任何一方写过世界**：`.tmpverify/live/guard.log` 在我整个会话期间**零新增条目**
（最后一条是 `2026-11-01T12:18:03Z`，即本地 20:18，早于我）。

---

## 5. 红线核对

| 红线 | 状态 | 证据 |
|---|---|---|
| 只许写 `7c93b3dd…` | ✅ 未违反 | 我**没有发出任何写 RPC**，一次都没有 |
| 用户存档 `5c967065…` 绝对禁止碰 | ✅ 未违反，**sha256 逐字节未变** | `f5944ccd…b7115`，与 guard 基线完全一致，mtime 仍是 2026-10-28 17:02 |
| 每次写之前 `snapshot_save` | N/A | 没有写，所以不需要；也**没有**任何一步绕过 guard |
| 不 kill / restart shapezio | ✅ 未 kill | 但进程在 21:18:31 自行退出（见 §3，我如实报告了当时我在操作窗口） |
| 独占资源 | ❌ **前提不成立** | 见 §4，另一 agent 并发活动 |

用户存档核验（用 guard 自己的断言，不是我自己写的比较）：

```js
G.assertUserSaveUntouched(G.loadUserSaveBaseline(), G.recordUserSaveFingerprint())
→ USER SAVE UNTOUCHED: OK
```

guard 白名单行为也顺带验了一遍，符合设计：

```
assertAllowedWorld(7c93b3dd) => ALLOWED
assertAllowedWorld(5c967065) => BLOCKED HOME_WORLD
assertAllowedWorld(deadbeef) => BLOCKED WORLD_NOT_ALLOWED
```

---

## 6. 世界的基线（从真实归档 obs 恢复）

虽然拿不到实时 obs，但 `.tmpverify/definitive/d0.json` 里有一份 **2026-11-01 01:50、
世界 `7c93b3dd`、seed 60908** 的真实 obs（42 实体）。它和磁盘上的存档 uid 集合完全一致（§1.2），
所以可以当作可信基线。**以下数字来自这份真实 obs，不是编的。**

### 6.1 世界概况

```
internal_id : 7c93b3dd9e949c561e5aa529974973b18c856b45
seed        : 60908
level       : 4
entities    : 42  (hub×1, miner×3, balancer×2, cutter×1, trash×1, belt×34)
hub         : uid=10000 at (-2,-2)
goal        : RuRu----  required=70  delivered=0  progress=0
stored      : {CuCuCuCu:12, ----CuCu:686, RuRuRuRu:2016, ----RuRu:4575}
upgrades    : {belt:1, miner:1, processors:0, painting:0}
resources   : 18 个矿格
```

### 6.2 `capacityFor(obs)` —— 本实验的核心观测

```js
capacityFor(obs) → { capacity, options, obs }
```

**capacity：**

```json
{
 "levels": { "belt": 1, "miner": 1, "processors": 0, "painting": 0 },
 "miners": { "count": 3, "active": 3, "idle": 0, "ratePerSec": 0.6 },
 "supplyPerSec": 1.8,
 "process": {
   "capacityPerSec": 0.5,
   "machines": [{ "kind": "cutter", "count": 1, "ratePerSec": 0.5,
                  "productPerSec": 0.5, "upgradeLine": "processors" }]
 },
 "path": { "beltsOnLine": 34, "beltRatePerSec": 3, "capacityComputed": false },
 "bottleneck": "process",
 "bottleneckMachine": "cutter",
 "bottleneckDetail": "1 台 cutter 只能处理 0.50/s，而 3 台矿机在产 1.80/s —— 72% 的产出堵在这里",
 "utilization": 0.27777777777777773,
 "confidence": "ok"
}
```

**options：**

```json
{
 "bottleneckMachine": "cutter",
 "machinesToSaturate": 4,
 "current": 0.5,
 "supply": 1.8,
 "addMachines": { "kind": "cutter", "from": 1, "to": 4, "add": 3,
                  "capacityAfter": 2, "enough": true },
 "upgrade": { "line": "processors", "tier": 1, "multiplierFrom": 1, "multiplierTo": 1.5,
              "capacityAfter": 0.75, "affordable": false,
              "missing": [{ "shape": "SuSuSuSu", "short": 500 }] },
 "doNow": [{ "action": "add-machines", "kind": "cutter", "from": 1, "to": 4, "add": 3,
             "capacityAfter": 2, "getsTo": "feed-full-supply" }],
 "goalShape": "RuRu----"
}
```

**基线读数**：`utilisation = 27.8%`，`bottleneck = cutter`，`supply 1.8/s vs processing 0.5/s`，
要加 **3 台 cutter** 才能吃满供给（1→4）。升级到 processors T1 买不起（缺 500 个 SuSuSuSu）。

这正是 CAPACITY 段该说话的场景 —— 它也**确实会说**（`confidence:"ok"`、`renderCapacity` 的前置条件全部满足）。
可惜这一轮没能在真机上验证「模型说要加 cutter 之后到底加没加成」。

---

## 7. 为什么没跑 loop

`runLoop` 的第①步就是 `reader.obs()`。在 `in_game:false` 时这一步必然失败：

```
POST /rpc {"method":"obs"} → 1003 not_in_game: Game world is not loaded
```

`.tmpverify/shot.json` 也记录了同一个错误。没有 obs，就没有 handles、没有 diagnoses、没有 prompt，
loop 连第一轮都进不去。**硬跑只会得到一份 `outcome:"error", reason:INTERNAL` 的空转记录，
除了浪费一次 LLM 调用没有任何信息量**，所以我没跑。

关于「无 CAPACITY 对照臂」的可行性，我读了 `src/agent/loop/prompt.mjs` 和 `src/agent/loop.mjs`：
`buildPrompt` 的签名是 `buildPrompt({goal, obs, handles, diagnoses, candidates, lastRound, budget, production, recipe})`，
CAPACITY 段在函数体内部无条件通过 `capacityFor(obs)` 计算，**没有任何开关参数**。
`runLoop` 在第 1730 行直接调用模块级 import 的 `buildPrompt`，`opts` 里也没有注入点。
所以干净的对照臂做法是：在 runner 里 import 一份自己的 `buildPrompt` 包装
（渲染完把 `## CAPACITY` 段整段删掉），再 monkey-patch `loop.mjs` 的绑定 —— 但那需要模块级替换，
不是「传参」能解决的。**这一轮没有走到那一步，所以没有结论。**

---

## 8. 结论

**preflight 未通过，实验未开始，世界零写入，用户存档完好。**

阻断点按发现顺序：

1. 存档索引 `savegames.bin` 在 **20:56:22**（我到达之前）被截断成 127 字节 → `list_saves` 返回空 → 目标世界 `load_save` 被游戏拒绝。
2. 世界 `.bin` 文件本身**完好**（42 uid，与归档 obs 完全一致），只是游戏看不见它。
3. 游戏窗口最小化，且**恢复后 0.4–0.8 秒自动回弹**；即使保持恢复状态 CPU 仍为 0。
4. 21:18:31 游戏进程退出（当时我正在高频操作其窗口；同时仓库里有另一个 agent 并发活动）。

**没有一条是可以靠「多等一会」或「重试 load_save」解决的**，所以我停在这里，不做猜测性修复。
恢复索引需要动 `savegames.bin`（或让游戏重建它），这超出了本任务授权范围，且当前游戏进程已经不在，
任何修复都无法立即验证 —— 按纪律报告并停止。
