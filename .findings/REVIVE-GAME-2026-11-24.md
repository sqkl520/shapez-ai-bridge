# 真机恢复报告 — 从 mod_connected:false 到实验存档 7c93b3dd 已载入

> 2026-11-24 06:06 ~ 06:26（+08:00）。执行 Agent（真机恢复）。
> **结论：恢复成功。只读冒烟 5/5 通过。现在可以跑真机实验了。**

---

## 0. 一句话根因

**游戏根本没在运行；而它起不来的原因是 Steam 客户端没启动** ——
shapez 的主进程在 `greenworks.init()`（`steam.js:31`）抛 `Steam initialization failed. Steam is not running.`，
Electron 弹出模态错误框 `Error`，整个 app 停在崩溃态，mod 无从加载。
**不是 bridge、不是 mod、不是存档、不是 rAF。**

---

## 1. 诊断逐步（每步输出）

### ① 游戏进程在不在？ → 不在

```
$ powershell Get-Process | ? {$_.ProcessName -like '*shapez*'}
（空）
```

旁证：按内存排序的进程表里也没有 shapezio / steam。
这一条先排除了「进程在但 mod 没连」的所有分支。

### ② bridge 日志说了什么？ → 最后一次成功握手在昨天，之后一直 mod=no

`.bridge.log`：

```
[bridge/info] mod connected from 127.0.0.1:3368
[bridge/info] mod ready: game 1.5.6, mod 0.1.0, features [observe,act,...]
...
196:[bridge/alive] 2026-11-23T15:22:31.484Z mod=yes clients=0 crashes=0 rss_mb=70
197:[bridge/info] mod disconnected
...
（此后至今每 30s 一条 mod=no）
```

即游戏在 **2026-11-23T15:22:31Z** 断开后就没再回来。bridge 自身一直健康（rss ~70MB，crashes=0）。

### ③ bridge 在监听吗？ → 在

```
TCP  127.0.0.1:7777  0.0.0.0:0  LISTENING  18480
```

`/health` 返回 `{"ok":true,"mod_connected":false,"uptime_s":28782}` —— 进程活着，只是没有 mod 连上来。

### ④ mod 侧的日志 → 游戏没起来，所以没有 mod 日志

- mod 已安装：`%APPDATA%\shapez.io\mods\shapez-ai-bridge.js`（282919 B，Nov 15 19:54）
- 配置正确：`modsettings_shapez-ai-bridge__0.1.0.json` → `ws_url: ws://127.0.0.1:7777/mod`
- shapez 桌面版不往文件写运行日志；唯一的 `debug.log` 只有一条与本次无关的注册协议错误。

**四步结论：情况 ⑴「游戏根本没启动」。** 于是进入启动流程。

---

## 2. 启动与失败

### 2.1 正常启动（照仓库既有做法）

```
powershell Start-Process 'D:\Steam\steamapps\common\shapez.io\shapezio.exe' \
  -WorkingDirectory 'D:\Steam\steamapps\common\shapez.io'
→ shapezio PID 6968, 06:06:53 起
```

等了 ~3 分钟，`/health` 仍是 `mod_connected:false`。

### 2.2 第一次失败：Electron 模态错误框

```
$ Get-Process shapezio
Id     MainWindowTitle  MainWindowHandle
6968   Error            10489474
```

用 UI Automation 读出对话框文本（原文）：

```
A JavaScript error occurred in the main process
Uncaught Exception:
Error: Steam initialization failed. Steam is not running.
    at EventEmitter.greenworks.init (...\app.asar\node_modules\...\steam\greenworks.js:295:39)
    at Object.init (...\app.asar\steam.js:31:21)
    at Object.<anonymous> (...\app.asar\index.js:384:7)
```

→ **根因确定：Steam 客户端没运行。**
佐证：进程表里只有 `Steam++`（第三方加速器）和 `Steam++.Accelerator`，**没有 `steam.exe`**。

### 2.3 修复

1. 启动 Steam 客户端：
   ```
   powershell Start-Process 'D:\Steam\Steam.exe' -ArgumentList '-noreactlogin'
   → steam PID 15304
   ```
2. 对卡住的错误框**正常关闭**（`WM_CLOSE`，绝不 `Stop-Process -Force` / `taskkill`）：
   ```
   PostMessage(hwnd, 0x0010 /*WM_CLOSE*/, 0, 0)
   ```
   关闭后 Electron 自行拉起渲染进程；主窗口标题变成 `shapez`，游戏进入主菜单。

### 2.4 mod 连上

```
[bridge/info] mod connected from 127.0.0.1:2965
[bridge/info] mod ready: game 1.5.6, mod 0.1.0, features [observe,act,batch,step,await,
              blueprint,screenshot,save,new_game,entity_snapshot,tx,delete_by_uid]
```

`/health` → `{"ok":true,"mod_connected":true,...}`

---

## 3. 载入实验存档（唯一允许的目标）

先做只读核对再动手：

- `list_saves` 中 `7c93b3dd…` 存在且 `level: 12`；用户存档 `5c967065…` 是 `level: 11`，两者分离。
- 离线解码存档头：`7c93b3dd…` → `hubGoals.level = 12`，`stats` 正常。
- `savegames.bin` 索引里 `7c93b3dd…` 排第一，已正确登记。
- 载入前把目标存档拷到 `.tmp-smoke/target-before-load.bin` 留证。

`debug_app_state`（载入前）：`state_key=MainMenuState, app_error_occurred=false, page_visible=true`。

载入：

```
POST /rpc {"method":"load_save","params":{"internal_id":"7c93b3dd9e949c561e5aa529974973b18c856b45"}}
→ {"ok":true,"op":"load_save","loading":true,"checkpoints_cleared":0}
```

未触发已知的 rAF 卡死。载入后 `debug_app_state`：

```
state_key           : InGameState
ingame_stage        : s10_gameRunning
root_present        : true
savegame.internal_id: 7c93b3dd9e949c561e5aa529974973b18c856b45   ← 硬门禁通过
app_error_occurred  : false
page_visible/focused: true / true
```

---

## 4. 只读冒烟（全部只读；未发 tx/act/step/place/delete/save/new_game）

### `/health`
```json
{"ok":true,"mod_connected":true,"uptime_s":30640}
```

### `status`
```json
{"protocol":1,"mod_version":"0.1.0","game_version":"1.5.6","in_game":true,
 "features":["observe","act","batch","step","await","blueprint","screenshot","save",
             "new_game","entity_snapshot","tx","delete_by_uid"],
 "allow_write":true,"allow_step":true,
 "tick":1114774.12,"paused":false,"speed":"regular","hub_level":12}
```

### `obs`（max_entities:50, layer:regular）
- `entity_count: 749`，`truncated: true`（按 max_entities 截断）
- 实体类型分布：`hub 1, cutter 3, painter 2, stacker 1, rotater 1, belt 699, balancer 1, miner 17, mixer 4, trash 20`
- hub 在 `(-2,-2)`，uid 10000，code 26
- `goal.requirement`: `{"shape":"CbCbCbRb:CwCwCwCw","required":1000,"delivered":0,"progress":0}` → **level 12 目标**

### 附加只读佐证
- `world_info`: seed `60908`，hub `(-2,-2)` — 与缓存中「seed 按存档而异」一致（不是默认 43391）
- `production`: 时间窗内 produced/delivered 全 0、stored_delta 全 0 —— 世界当前不产出（与既有 L12 结论「交付恒为 0」吻合，是观察，不是本次操作造成的）
- `screenshot`（只读渲染）: 768×432 PNG，`drew: [mapBackground, beltItems, mapForeground, hub]`；肉眼可见传送带/矿机/机器/hub 正常绘制 → 渲染链真的活着
- tick 两次采样 1114689 → 1114700（4s 内推进）→ 游戏在真实运行，不是冻屏

### 硬门禁复核
载入的是 **`7c93b3dd9e949c561e5aa529974973b18c856b45`**，不是 `5c967065…`。
用户存档 `5c967065…` 的 sha256 前后一致（`f5944ccd…`），**从未被读写**。

---

## 5. 一个需要如实说明的副作用：游戏自己在写这个存档

发现 `.findings` 写盘时，目标存档文件 `savegame-7c93b3dd….bin` 的 sha256 变了：
`bd1655a1…`（载入前）→ `a5b6ce09…`（06:22:34），`.bin.backup` 也同步更新（06:21:34）。

原因：**游戏自身的自动存档**（约 60s 一次），不是我发的 `save` —— 本次全程未调用 `save_now`。

已用离线解码逐项比对「载入前副本」与「自动存档后的现文件」：

| 项 | 载入前 | 现文件 | 结论 |
|---|---|---|---|
| 实体数 | 749 | 749 | 相同 |
| level | 12 | 12 | 相同 |
| beltPaths | 32 | 32 | 相同 |
| 实体 code 序列 | — | — | **完全一致** |
| hub storedShapes | — | — | **逐键完全一致**（含 `CbCbCbCb:6`、`CgScScCg:2081` 等） |

即：**只是重新序列化，语义零变化**。这符合游戏「自动存档会覆写同一 internal_id」的既定行为
（`.bin.backup` 就是它每次写盘前留的上一个版本）。留证副本仍在 `.tmp-smoke/target-before-load.bin`。

> 若后续实验要求「存档字节不许动」，需要在实验前先 `game_setting` 关掉自动存档，或实验结束时用
> 副本回填。这属于实验编排问题，不是本次恢复的问题。

---

## 6. 独占声明

- **我独占游戏实例的时间段：2026-11-24 06:06:53 起，至本报告结束。** 期间无其他 agent 操作游戏。
- 全程未：`Stop-Process -Force` / `taskkill` / `kill`；修改游戏安装目录；读写 `5c967065…`；
  发任何 tx/act/step/place/delete/save/new_game；git 写操作。

---

## 7. 复现（下次游戏掉线照这个走）

```bash
# 0) 先确认 Steam 客户端在跑（这次就是栽在这）
powershell -Command "Get-Process steam -ErrorAction SilentlyContinue"
#    空 → 先启动它，再启动游戏；否则 shapez 主进程会抛 Steam initialization failed 并卡在 Error 框

powershell Start-Process 'D:\Steam\Steam.exe' -ArgumentList '-noreactlogin'
sleep 15

# 1) 启动游戏
powershell -Command "Start-Process -FilePath 'D:\Steam\steamapps\common\shapez.io\shapezio.exe' -WorkingDirectory 'D:\Steam\steamapps\common\shapez.io'"

# 2) 等 mod（约 10s）
until curl -s http://127.0.0.1:7777/health | grep -q '"mod_connected":true'; do sleep 2; done

# 3) 载入实验存档（只这个 id）
curl -s -X POST http://127.0.0.1:7777/rpc -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"load_save","params":{"internal_id":"7c93b3dd9e949c561e5aa529974973b18c856b45"}}'

# 4) 确认
curl -s -X POST http://127.0.0.1:7777/rpc -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"debug_app_state","params":{}}'
#    → ingame_stage=s10_gameRunning, root_present=true, savegame.internal_id=7c93b3dd…
```

**下次故障排查的第一问应该是「`steam.exe` 在不在」，而不是「mod 连上了吗」。**
这次的错误框标题只写 `Error`，进程名 `shapezio` 看起来还在，很容易误判成「游戏起来了只是 mod 挂了」。

---

## 8. 终态

```
mod_connected : true
in_game       : true
hub_level     : 12
存档 id       : 7c93b3dd9e949c561e5aa529974973b18c856b45
ingame_stage  : s10_gameRunning
渲染          : 截图可见传送带/矿机/机器/hub
tick          : 推进中
```

**现在可以跑真机实验了。**
