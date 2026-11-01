# LIVE-CAPACITY — Result

**日期**：2026-11-01 21:02–21:35
**任务**：真机跑完整 loop 闭环，验证 CAPACITY 段在真机上的效果。
**结果**：**没跑成。实验未开始。**

---

## 一句话

真机闭环**没有执行**，因为环境在交接给我之前就已经坏了 —— 存档索引被截断，
游戏里一个存档都看不见，目标世界 `load_save` 在 21:00:54（我到达之前）就被游戏拒绝了。
**世界零写入，用户存档 sha256 逐字节未变。**

---

## 1. 跑之前 / 跑之后的 `capacityFor` 对比

**跑之后：不存在，因为没有「跑」。**

| | utilisation | bottleneck | supply | processing |
|---|---|---|---|---|
| 跑之前（2026-11-01 01:50 真实 obs 基线） | **27.8%** | **cutter** | 1.8/s | 0.5/s |
| 跑之后 | **无**（loop 未执行） | — | — | — |

基线数字来自 `.tmpverify/definitive/d0.json` 里一份世界 `7c93b3dd`、seed 60908 的真实 obs
（42 实体）。我核对过它与磁盘上目标存档的 uid 集合**逐 uid 完全一致**（`extra=0 missing=0`），
所以它是可信基线，不是估算值。完整输出见 `LIVE-CAPACITY-PREFLIGHT.md` §6.2。

`capacityFor(obs)` 的其他关键读数：

```
bottleneckDetail : 1 台 cutter 只能处理 0.50/s，而 3 台矿机在产 1.80/s —— 72% 的产出堵在这里
machinesToSaturate: 4   （现有 1 台，需加 3 台）
addMachines      : add 3 cutter (1→4) ⇒ 2/s，enough=true  ← doNow 里唯一可执行的动作
upgrade          : processors T1 ⇒ 0.75/s，affordable=false（缺 500 个 SuSuSuSu）
```

**这是一个 CAPACITY 段本该完美发言的场景**：`confidence:"ok"`，`renderCapacity` 的所有前置条件
（`processCap !== null`、非 balanced）全部满足。它会渲染出：

```
## CAPACITY
supply 1.8/s | processing 0.5/s | 28% utilized
bottleneck: cutter — 72% of supply is stuck here
options:
  · add 3 cutter (1→4) ⇒ 2/s — fills the line
  · processors T1 (×1→×1.5) ⇒ 0.75/s — needs 500 SuSuSuSu
```

但这只是 `renderCapacity` 的**输入可算出来**，不代表模型**在真机上会不会照做**、更不代表照做之后
能不能真的加成。那正是这次要验证、而**没能验证**的东西。

---

## 2. 模型实际执行了什么（tx ops 原文）

**没有任何 tx ops。零。**

`.tmpverify/live/guard.log` 在我整个会话期间**零新增条目** —— 最后一条是
`2026-11-01T12:18:03.640Z`（本地 20:18），早于我的会话开始。
guard 的 `wrapRpc` 是唯一写通道，它没被调用过 = **一个写 RPC 都没发出**。

不是「发了被拒」，是**根本没发**：`runLoop` 的第一步 `reader.obs()` 就撞上
`1003 not_in_game`，连第一轮 prompt 都构造不出来。

---

## 3. loop 说成功了吗 vs 世界真的变好了吗

| | 结论 |
|---|---|
| **loop 的 verdict** | **不存在** —— loop 从未运行，没有 `outcome`、没有 `verdict`、没有 transcript |
| **世界的物理事实** | **未改变** —— 目标世界在磁盘上仍是 42 uid，与基线逐 uid 一致 |

这两件事这次**没有可比较的内容**，因为实验根本没启动。
我拒绝把「没跑」写成「跑成功了」，也拒绝把 `capacityFor` 的静态计算当成实验结论。

关于纪律本身，我注意到派工提醒的「loop 的 verdict 不能当证据」在这次是**无法被检验**的：
没有 verdict 可检验。这一点应该如实归类为「未验证」，而不是「已验证没问题」。

---

## 4. 复原是否成功（uid 核对）

**不需要复原 —— 没有任何东西被改过。**

但既然要求 uid 核对，我做了**离线**核对（目标存档 vs 归档真实 obs）：

```
archived_uid_count = 42
onsave_uid_count   = 42
extra = 0
missing = 0
PASS = true
seed = 60908
```

目标世界 `savegame-7c93b3dd…bin` 未被修改：

```
sha256 = 0ed96dd439be9331f136bf92865f2414c108a90560987960e47cdccfd11fad1c
size   = 3164
mtime  = 2026-11-01 03:23:12  （早于我到达）
```

与 `.tmpverify/save-backup-2026-11-01/` 里的备份**逐字节一致**。

`snapshot_load` 从未被调用（那是卡死世界的高危操作），所以 §「恢复后立刻 curl status」这一步不适用。

---

## 5. 用户存档 sha256 是否未变

**未变。逐字节一致。**

用 guard 自己的断言核验（不是我手写的比较逻辑）：

```js
G.assertUserSaveUntouched(G.loadUserSaveBaseline(), G.recordUserSaveFingerprint())
→ USER SAVE UNTOUCHED: OK
```

| | 值 |
|---|---|
| internal_id | `5c96706563c0b74c4d2ce4c7f8bf7a244392de89` |
| sha256 | `f5944ccd9375b12b554d0873b4e6b44c369067b758936d14686ddde4e9fb7115` |
| size | 82716 |
| mtime | 2026-10-28 09:02:12.885Z（**4 天前，未动**） |

与 `guard` 的 `user-save-baseline.json` 记录完全一致。文件名也从未出现在任何 RPC 参数里。

---

## 6. 为什么没跑 —— 三个阻断点

### 阻断点 1（致命）：存档索引被截断，游戏里没有世界

```
POST /rpc {"method":"list_saves"} → {"saves":[]}          ← 一个存档都没有
```

`load_save 7c93b3dd…` 的失败原文，**时间戳 21:00:54，早于我的第一次操作**：

```json
{"code":2002,
 "message":"game_rejected: no savegame with internal_id 7c93b3dd9e949c561e5aa529974973b18c856b45"}
```

`savegames.bin` 只有 **127 字节**，mtime **20:56:22**；它的 `.backup` 是 1053 字节（03:23:13）。
**存档数据没丢**（离线解码：目标世界 42 uid、seed 60908；用户存档 3093 uid、seed 43391，都能正常解开），
丢的是那份索引。游戏因此看不见任何存档，`in_game` 永远是 false。

这解释了为什么「等 2 分钟」不可能有效 —— 那个 `load_save` 是**被拒绝**，不是**在排队**。

### 阻断点 2：窗口楔死，且这次的恢复手法无效

窗口是 `IsIconic=True`（最小化），进程 CPU 6 秒内只有 0.016s（渲染循环停着）。
按 LIVE-LOG 的「World wedge」流程做 `ShowWindow(SW_RESTORE)`：恢复成功，但 **0.4–0.8 秒后自动回弹**。
`SetWindowPlacement`、`SendMessageTimeout(SC_RESTORE)` 同样回弹。
即使保持恢复状态，CPU 依然为 0。

**这次的根因和 LIVE-LOG 记录的不同**：LIVE-LOG 的楔死是「世界正在载入、只是被最小化暂停」，
恢复窗口就能救；这次是「**根本没有世界可载入**」，窗口恢复对 `in_game` 没有任何影响。
这个区别值得更新到 LIVE-LOG —— 照抄旧恢复流程会得到一个「看起来在做诊断、其实在做无用功」的循环。

### 阻断点 3：游戏进程在 21:18:31 退出

Steam 权威日志：

```
[2026-11-01 20:51:28] Game process added : ...shapezio.exe, ProcID 31676
[2026-11-01 21:18:31] Game process removed: ...shapezio.exe, ProcID 31676
```

之后没有新的 `Game process added`（不是重启，是退出）。没有 WER 崩溃报告，没有 crash dump。

**我必须如实说：21:18:11 我启动了一个 60 秒的窗口恢复循环（10 次/秒）。21:18:31 进程消失，
就在这个循环运行期间。** 我不知道确切根因，但没有证据能排除「高频窗口操作触发了那个已处于异常
状态的 Electron 进程的退出」。按「可能是我造成的」记录，不推给别的因素。

我没有重启它（红线 #2），而是停下来报告。

---

## 7. 另一件必须报告的事：并发写入者

派工说「游戏实例是独占资源 —— 只有你能写」。**这个前提不成立。**

- `.tmpverify/screen.png`（21:04:33）截图显示桌面上**另一个 Claude Desktop 会话**在活动；
- `.tmpverify/screen5.png`（21:09:58）是一张**纯桌面壁纸** —— 21:09:58 时游戏窗口根本不在屏上；
- 21:10–21:22 期间 `.tmpverify/` 下持续出现不是我写的脚本（`rt-b2-exec.mjs`、`exp-plan/sim-b2.mjs`、
  `rt-gaming.mjs`、`rt-ideal.mjs`），全部是**离线**跑 `capacity-scenario.json` 的；
- `node scripts/watch.mjs`（PID 30840，20:55 启动）不属于本仓库，属于 `D:/Projects/Overwatch/`。

好消息：这些离线脚本没有碰世界（guard.log 零写入可证）。坏消息：**「独占」的前提是假的**，
而 `screen5.png` 直接推翻了派工描述里「游戏已启动、正在载入」这一条。

---

## 8. 关于「无 CAPACITY 对照臂」—— 调研结论

虽然没跑，但按要求读了代码，把可行性结论留下来（省下一轮重复调研）：

- `buildPrompt` 签名：`buildPrompt({goal, obs, handles, diagnoses, candidates, lastRound, budget, production, recipe})`。
- CAPACITY 段在**函数体内部**无条件通过 `capacityFor(obs)` 计算，`renderCapacity(...)` 的结果直接
  拼进 `compose()`。**没有任何开关参数**（没有 `includeCapacity` 之类）。
- `runLoop` 在第 1730 行调用**模块级 import** 的 `buildPrompt`，`opts` 里没有注入点。

所以干净的做法只有一条：runner 里自己包一个 `buildPrompt`，渲染完后把 `## CAPACITY` 开头的段整段删掉，
再替换 `loop.mjs` 的模块绑定。**这需要模块级替换，不是传参能解决的。**
按派工要求「不要为了凑两个臂去改 `src/` 的代码」，正确做法是在 runner 层做，
但这一轮没走到那一步，所以**没有实测结论**。

---

## 9. 恢复需要什么（仅供决策，我没做）

游戏进程已不在，任何修复都无法立即验证，所以我没有动手。恢复路径大致是：

1. 重建 `savegames.bin` 索引（或用 03:23 的 1053 字节 `.backup` —— **但那是 18 小时前的**，
   之后新增过的存档条目会丢，需要核对）；
2. 重启游戏（需要授权 —— 红线 #2 禁止我这样做）；
3. 载入目标世界，重新 preflight，确认 `capacityFor` 与 §1 的基线一致；
4. 那时才能开始跑 loop。

**建议**：在动手修索引之前，先确认这 18 小时里有没有别的存档被创建（否则用旧 backup 会丢条目）。
`.tmpverify/save-backup-2026-11-01/` 里有全部 7 个 .bin 的副本，可以据此重建。

---

## 10. 原始证据

`research/ai-plan/LIVE-CAPACITY-RAW/`：

- `evidence-load-target-error.json` —— 21:00:54 的 `load_save` 拒绝原文
- `evidence-shot-error.json` —— `1003 not_in_game` 原文
- `evidence-bridge-cc.log` —— 桥接日志（含 `mod disconnected`）
- `evidence-desktop-2109.png` —— 21:09:58 的截图，证明游戏不在屏上

会话期间**没有**产生 obs / transcript / tx 日志 —— 因为 loop 从未运行。
我不留空文件假装跑过。
