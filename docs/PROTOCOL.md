# shapez.ai Bridge — 协议契约 v1

> 本文件是 Mod / 桥接 / MCP / Agent / 测试 五个组件的**共同接口契约**。
> 任何不一致以本文件为准；改协议 = 改本文件 + 升 `protocol` 号 + 三处同步。
> 证据来源见 `PHASE0-RECON.md`；所有游戏侧 API 引用均出自 `recon/bundle.pretty.js`（美化版 1.5.6）。

## 0. 架构一图

```
┌─ shapez.io (Electron) ─────────────┐          ┌─ 本机进程 ────────────────────────────┐
│ 渲染进程 bundle.js                  │          │ bridge.mjs (Node)                     │
│  ├─ 游戏逻辑 (root)                 │  WS      │  ├─ WS server  /mod   ← 游戏 mod 连接 │
│  └─ shapez-ai-bridge.js (mod)  ─────┼──────────┼──┤ WS upgrade   /client ← 工具/agent  │
│     浏览器原生 WebSocket 客户端       │  127.0.0.1│  ├─ HTTP  /health /status /rpc        │
└────────────────────────────────────┘  :7777    │  └─ 存档快照文件管理                   │
                                                  └──────────┬───────────────────────────┘
                                                             │ stdio / HTTP
                                                  ┌──────────┴──────────┐
                                                  │ mcp/server.mjs       │
                                                  │ agent/play.mjs       │
                                                  └─────────────────────┘
```

**D1 = 方案 B**（外部宿主起服务端，Mod 当 WS 客户端）：渲染进程 `nodeIntegration:false + sandbox:true`，Mod 无 Node 权限【观测】，但原生 WebSocket 恒可用、页面无 CSP【观测】。

## 1. 线路格式

- 传输：WebSocket，默认 `ws://127.0.0.1:7777`，Mod 连 `/mod`，工具/Agent 连 `/client`。
- 编码：**JSON-RPC 2.0**，文本帧。
- **id 空间**：桥接发往 Mod 的请求用整数 id（桥接自己发号）；Mod → 桥接只允许三类消息：
  - `{"jsonrpc":"2.0","method":"hello","params":{...}}`（通知，无 id，连接后立即发）
  - `{"jsonrpc":"2.0","id":N,"result":...}` / `{"jsonrpc":"2.0","id":N,"error":{...}}`（应答）
  - `{"jsonrpc":"2.0","method":"event","params":{"type":...,"data":...}}`（通知）
  Mod 从不主动发请求。工具/Agent 的 id 由桥接重新映射，互不可见。

## 2. 握手与版本

Mod 连接后发送：

```jsonc
{"jsonrpc":"2.0","method":"hello","params":{
  "protocol": 1,
  "mod_version": "0.1.0",
  "game_version": "1.5.6",
  "features": ["observe","act","batch","step","await","blueprint","screenshot","save","new_game"]
}}
```

桥接校验：
- `protocol != 1` → 桥接立即以 `1001` 关闭/回绝（**硬失败，禁止降级**），工具调用返回 `1001` + 双方版本原文。
- `game_version` 与 `compat.json` 的兼容表不匹配 → `1002`，同样硬失败。

桥接随后主动发 `{"method":"status"}` 校准（幂等，可选）。

## 3. 桥接 → Mod 方法（RPC）

| method | params | result | 说明 |
|---|---|---|---|
| `status` | `{}` | StatusResult | 版本/游戏态/tick/速度/只读标记 |
| `obs` | ObsRequest | Observation | 观测（可裁剪） |
| `act` | `{op, ...}` 见 §5 | ActionResult | 单动作 |
| `batch` | `{actions:[Action,...]}` | `{results:[ActionResult,...]}` | 顺序执行，一条 `step/await` 也按序 |
| `screenshot` | `{scale?: 0..1}` | `{png_base64, w, h}` | 全屏 canvas PNG |
| `save_now` | `{}` | `{internal_id, level, last_update}` | 调 `gameState.doSave()` 并等完成 |
| `list_saves` | `{}` | `{saves:[{internal_id, name, level, last_update}...]}` | `savegameMgr` 元数据 |
| `load_save` | `{internal_id}` | `{ok:true}` | 读档并切 InGameState（异步完成，返回后需轮询 status） |
| `new_game` | `{game_mode?: "regularMode"}` | `{ok:true}` | 先回主菜单再开新档（【待验】实现见 §8） |

## 4. 观测（Observation）

```jsonc
{
  "protocol": 1, "mod_version": "0.1.0", "game_version": "1.5.6",
  "in_game": true,
  "tick": 20654.28,            // root.time.now() 逻辑秒
  "paused": false, "speed": "regular",   // paused|regular|fast_forward
  "layer": "regular",          // regular|wires
  "camera": {"x": 100, "y": -60, "zoom": 0.5},
  "goal": {
    "level": 10,
    "requirement": {"shape": "CbCbCbRb:CwCwCwCw", "required": 100, "delivered": 37,
                    "progress": 0.37, "throughput_only": false},
    "upgrade_levels": {"belt": 3, "miner": 2, "processors": 2, "painting": 1}
  },
  "hub": {                      // include_hub=true 时
    "stored_shapes": {"CuCuCuCu": 25267, "...": 0},
    "blueprint_cost": 123,      // 当前选区蓝图的成本（有选区时）
    "has_free_paste": false
  },
  "region": [x0, y0, x1, y1],   // 请求的区域（未裁剪时=全图 bbox）
  "entities": [
    {"uid": 10002, "type": "miner", "x": -7, "y": 5, "r": 90, "variant": "default",
     "code": 7, "layer": "regular"}
  ],
  "stats": {"total": 1544, "by_type": {"belt": 724, "miner": 81, "...": 0}},
  "resources": [[x, y, "CuCuCuCu"], ...],   // include_resources=true 时（lower layer，区域裁剪）
  "truncated": false,           // true = 实体超 max_entities 被截断，stats 仍为全量
  "entity_count": 1544
}
```

ObsRequest：
```jsonc
{"region": [x0,y0,x1,y1],      // 可选；缺省 = 全部实体的 bbox
 "max_entities": 2000,         // 硬上限，超出 → truncated:true（不报错）
 "include_hub": true,
 "include_resources": false,
 "include_stats": true}
```

- 实体枚举：按 chunk 增量（`map.getChunk(cx,cy).containedEntitiesByLayer[layer]`），失败回退 `entityMgr.entities` 线性扫描。
- `type` = 建筑 gameId 字符串（运行时由 `code → gBuildingVariants[code].metaInstance.getId()` 映射）。
- `uid` 稳定（存档往返保持【观测】），供多步规划引用。

## 5. 动作（Action）

所有动作是 JSON 对象，`op` 必填。**未知字段 / 未知 op 一律报 `2001`，不静默忽略。**

**删除前先核对**：`bulk_delete` 的 `region` 是**含边界的包围盒**，边界算错一格就会牵连区域外的建筑。
实测中这件事发生过多次（一次误删 42 个真实工厂实体）。**建议：任何非常规删除都先
`{"op":"bulk_delete","region":[...],"dry_run":true}` 拿到 `items` 清单核对，再去掉 `dry_run` 执行。**

| op | 参数 | 语义 | 主要错误 |
|---|---|---|---|
| `noop` | — | 空操作（心跳/对齐用） | — |
| `place` | `building, x, y, r?=0, variant?="default"` | 放一个建筑 | 2001 未知建筑；2002 位置被占/不可放 |
| `place_path` | `building, from:[x,y], to:[x,y], r?` | 轴对齐直线铺满（含端点）；`building="belt"` 时自动按路径方向定旋转 | 同上 + 2001 非轴对齐 |
| `delete` | `x, y, layer?="regular"` | 删一个 | 2002 该位置无建筑 |
| `bulk_delete` | `region:[x0,y0,x1,y1], layer?` | 区域删除（走 `performBulkOperation`） | — |
| `bulk_delete`（`dry_run:true`） | `region, layer?, dry_run:true` | **只报告将删对象，不执行**。返回 `{dry_run:true, would_delete, by_type, items:[{uid,x,y,type,rotation}]}` | — |
| `paste_blueprint` | `text, x, y, charge?="auto"` | 粘贴蓝图（§6）。`charge`:`"auto"`=按游戏规则扣费；`false`=免费（沙盒） | 2001 格式错；2006 蓝图版本不符；2002 位置非法/材料不足 |
| `paste_blueprint`（`dry_run:true`） | `text, x, y, dry_run:true` | **只预检不落地**。返回 `{would_apply, would_delete, destroys:[{uid,cell,type}], blocked:[{cell,occupant,reason,duplicateInPlan}], unknown_code, bbox, charge_preview, count}`。**必用的理由**：真粘贴落在既有 belt/wire 上=静默销毁替换（旧 uid 消失、`failed:[]`、零报告——实机取证 `live/results/belt-silent-overwrite.json`）；落在既有机器上=逐条目拒但其它照放（半建线）。**先 dry_run 核对，再真贴**。局限：plan 内重复只查条目 origin 格（`duplicateInPlan`），多格机器在 plan 内互叠由编译器 V1 保证（蓝图自洽性在发射前，mod 不兜底） | 2001/2006 同左（解码与版本校验在预检之前） |
| `export_blueprint` | `region:[x0,y0,x1,y1]` | 导出该区域为蓝图字符串 | 2001 区域为空 |
| `set_speed` | `speed:"paused"\|"regular"\|"fast_forward"` | 设置游戏速度 | 2001 |
| `step` | `ticks:int(1..20000), collect?:bool` | **无渲染同步快进 N 逻辑 tick**（实现：复刻 puzzle 校验循环 `time.performTicks`）。`collect:true` 返回末尾观测 | 2003 引擎拒绝 |
| `await` | `until:"hub_delivered_increased"\|"level_increased"\|"entities_changed", timeout_ticks:int, chunk?:int=60, collect?:bool` | 快进直到条件满足或超时；返回 `{met, ticks_run, timeout}`。**必有超时** | 2003 |
| `camera` | `x, y, zoom?` | 镜头跳转（观测默认跟相机无关，但截图用） | — |
| `save` | — | = `save_now`（桥接层做快照） | — |
| `load` | `internal_id` | = `load_save` | — |
| `new_game` | `game_mode?` | 新开局（【待验】） | 2003 |

ActionResult：
```jsonc
{"ok": true,
 "op": "place",
 "applied": 1,             // 实际生效数量（批量时）
 "failed": [],             // [{x,y,reason}...] 明细（批量/路径时必有）
 "entity_uid": 10002,      // 单个放置时
 "tick": 20654.28,
 "observation": {...}      // collect:true / 桥接需要时附加
}
```

## 6. 蓝图字符串格式 v2（自建——1.5.6 无原生格式【观测】）

```
SZBP1.<LZString-URI-safe 压缩体>
```

压缩前 JSON：
```jsonc
{"v": 1,                 // 格式版本：1（无 o）或 2（可带 o）。解码器两者都接受。
 "gv": "1.5.6",          // 产出时的游戏版本（code 表兼容性凭据）
 "w": [minx, miny],      // 世界锚点（区域内实体最小角）
 "e": [code,dx,dy,rot,  code,dx,dy,rot, ...],   // 扁平数组，**恒为 stride=4**
 "o": [orig, orig, ...]} // v2 可选：平行数组，逐格 originalRotation，长度必须 === e.length/4
```

- `code` = 游戏内部建筑码（`getCodeFromBuildingData` 产物，含 variant/rotationVariant 信息）【观测】。
  粘贴时经 `getBuildingDataFromCode(code)` 反查，**code 表只在同一游戏版本内保证有效 → `gv` 不匹配报 `2006`**。
- `dx,dy` = 相对锚点；`rot` = 0/90/180/270。
- **`o[i]` = 该格的真实 `originalRotation`**（游戏按它做邻居重算，`systems/belt.js:160`）。缺省/`null` → 回落到 `rot`（= v1 行为）。
  **为什么用平行数组而不是 stride=5**：改 stride 时若忘升版本号，`n % 4 == 0` 的蓝图会被旧解码器**静默**读成错位实体（实测 n=4/8/12/16 中招）并照样盖进世界；平行数组则让旧解码器原样可读（多出的键被忽略），且长度不符能显式报 `2001`。代价：容量 +12~27%（实测 2000 格 3899→4950 字符）。
  **为什么需要它**：`originalRotation` 不可从 `(rotation, rv)` 反推（同一对值命中 `belt.js` 不同分支时 orig 不同）。缺 `o` 时，「导出→贴到别处」或「贴完在拐角旁补一格」都会让拐角**翻向**（实机取证：`research/ai-plan/live/results/orig-flip.json`，9 格矩阵 3 翻 6 不翻，翻的全是 PULL 扰动）。
- 粘贴 = 对每个实体 `logic.tryPlaceBuilding({building, origin, rotation, originalRotation, rotationVariant, variant})`，包在 `performBulkOperation` + **`performImmutableOperation`** 双层里（后者屏蔽 `systems/belt.js:63` 的邻居重算，否则蓝图里的 rv 会被改写）。
- 扣费（`charge:"auto"` 且 `!gameMode.getHasFreeCopyPaste()`）：`cost = findNiceIntegerValue(4 * n^1.1)`【观测】，从 `getBlueprintShapeKey()` 扣；不足 → `2002`。`paste_blueprint` 支持 `dry_run:true` 预检（见 §5）。
- 压缩算法：**LZString URI-safe 变体**（`compressToEncodedURIComponent` 等价），与游戏存档所用完全一致——npm `lz-string` 实测可解游戏自身产物。实现走 `src/shared/lz-string.cjs`（桥接/测试）与 mod 内嵌副本（mod 必须单文件）。
- 文本仅含 `[A-Za-z0-9+\-$.]` 与 `SZBP1.` 前缀，可安全放进 JSON/剪贴板/对话。

## 7. 错误码

| code | 名称 | 语义 | AI 应对 |
|---|---|---|---|
| -32700..-32603 | JSON-RPC 标准 | 协议级错误 | 修参数/报告 |
| 1001 | protocol_version_mismatch | 协议号不符（硬失败） | 升级组件 |
| 1002 | game_version_mismatch | 游戏版本与兼容表不符（硬失败） | 升级 mod |
| 1003 | not_in_game | 游戏未进入世界（主菜单/加载中） | 等/新开局 |
| 1004 | read_only | 配置了只读模式，写动作被拒 | 换观测动作 |
| 1005 | no_connection | 桥接侧：无 Mod 连接 | 启动游戏 |
| 2001 | invalid_action | **AI 的错**：未知 op/字段/参数越界 | 可重试，修正参数 |
| 2002 | game_rejected | 状态不允许（位置被占、材料不足…） | 重规划 |
| 2003 | mod_error | Mod 内部 bug | 报告 |
| 2004 | timeout | 请求超时 | 重试/检查游戏卡死 |
| 2005 | await_timeout | `await` 条件在窗口内未满足（**不是错误状态**，result 里 `met:false` 也允许；仅桥接侧超时用此码） | 调整策略 |
| 2006 | blueprint_incompatible | 蓝图 `gv` 与当前游戏版本不符 | 重新导出 |

`error.data` 必须含 `{code_name, detail}`；`2001/2002` 还要含 `hint`（修复建议，给 AI 读）。

## 8. 生命周期与边角

- **reconnect**：Mod 断开后每 3s 重连（指数回退至 30s 封顶）；桥接保留最新 hello 做路由，重复 hello（同 game_version）直接替换旧连接。工具调用在有连接但游戏未进入世界时返回 `1003`。
- **心跳**：桥接每 15s 发 WS ping，30s 无 pong 判死并清连接；Mod 侧无特殊处理（浏览器自动回 pong）。
- **只读模式**：桥接侧拦截全部写 op（`place/place_path/delete/bulk_delete/paste_blueprint/set_speed/step/await/save/load/new_game`）→ `1004`；`obs/screenshot/status/list_saves/export_blueprint` 放行。
- **`new_game`（【待验】）**：`root.gameState.saveThenGoToState("MainMenuState")` → 等 `stateEntered` 信号为主菜单 → `app.savegameMgr.createNewSavegame()` → `app.stateMgr.moveToState("InGameState",{savegame, gameModeId})` → 等 `gameStarted`。全程附超时；失败 → `2003`。
- **`step/await` 安全**：单次 `step` 上限 20000 ticks；`await` 总预算 = `timeout_ticks`；快进期间不做渲染相关操作；文档明示会破坏成就（装 mod 本就禁成就）。
- **存档快照（桥接层）**：`save` 工具 = 请求 `save_now` → 桥接把 `%APPDATA%\shapez.io\saves\savegame-<internal_id>.bin` 复制到 `snapshots/<name>.bin`；`load` 工具 = 反向复制 + 请求 `load_save`。快照只在桥接侧，mod 无文件权限。
- **观测体积**：`max_entities` 缺省 2000，上限 20000；超限 → `truncated:true` + 全量 `stats`（永不静默截断）。

## 9. MCP 工具映射（mcp/server.mjs）

| 工具 | 入参 | 出参 | 等价线协议 |
|---|---|---|---|
| `shapez_status` | `{}` | 连接/游戏/版本/健康 | `status` + 桥接态 |
| `shapez_observe` | ObsRequest | Observation | `obs` |
| `shapez_action` | `{op,...}` | ActionResult | `act` |
| `shapez_batch` | `{actions:[...]}` | results | `batch` |
| `shapez_screenshot` | `{scale?}` | PNG（MCP image content） | `screenshot` |
| `shapez_blueprint` | `{mode:"export"\|"paste", region?/text?, x?, y?, charge?}` | 字符串 / ActionResult | `export_blueprint` / `paste_blueprint` |
| `shapez_save` | `{name?}` | 快照结果 | `save_now` + 文件快照 |
| `shapez_load` | `{name?}` | 载入结果 | 文件还原 + `load_save` |

MCP 错误：把 §7 错误码原样塞进 `isError:true` 的 content 文本（`{"code":2002,"code_name":"game_rejected",...}`），AI 可读可纠。

## 11. 客户端-facing 接口（bridge 对工具/Agent/MCP）

外部工具不直接连 Mod，而是连桥接。桥接提供两种入口，**方法名与 §3 完全一致**（外加两个快照便利方法）：

### 11.1 HTTP（curl 可调试，Agent 用这条）

- `GET /health` → `{"ok":true,"mod_connected":bool,"uptime_s":N}`（永不需要 token）
- `GET /status` → 等价 `status` 的 result（文本 JSON）
- `POST /rpc` → body 为一个 JSON-RPC 请求对象（`{"jsonrpc":"2.0","id":1,"method":"obs","params":{...}}`），响应为标准 JSON-RPC。支持方法：
  `status / obs / act / batch / screenshot / save_now / list_saves / load_save / new_game / snapshot_save / snapshot_load`
- 鉴权：若 `bridge.config.json` 设置了 `token`，除 `/health` 外都必须带 `Authorization: Bearer <token>` 或 `?token=`；否则 401。

### 11.2 WebSocket `/client`（事件推送）

- 客户端可发与 HTTP 相同的 JSON-RPC 请求（id 由客户端自己发号，桥接映射）。
- 桥接推送的通知（无 id）：
  - `{"method":"event","params":{"type":"mod_connected","data":{hello params}}}`（桥接的 hello 副本 + bridge 版本）
  - `{"method":"event","params":{"type":"mod_disconnected","data":{}}}`

### 11.3 快照方法（桥接侧实现，Mod 无文件权限）

- `snapshot_save {name?}`：先调 Mod `save_now` → 复制 `%APPDATA%\shapez.io\saves\savegame-<internal_id>.bin` 到 `snapshots/<name|auto-时间戳>.bin` → `{name, path, internal_id, level}`。
- `snapshot_load {name}`：复制 `snapshots/<name>.bin` 回 saves 目录（覆盖前先备份原文件为 `.pre-restore`）→ 调 Mod `load_save {internal_id}`（从快照文件头解码出 internal_id，或按文件名映射缓存）→ `{ok:true}`。
- 快照目录默认 `./snapshots`，可用 config `snapshot_dir` 改。

### 11.4 只读模式（config `read_only:true`）

桥接在转发前拦截：写方法集合 = `act`（除 `noop`/`camera`/`export_blueprint` 外的全部 op）、`batch`（含任一写 op 时整体拒绝）、`set_speed`、`step`、`await`、`save_now`、`load_save`、`new_game`、`snapshot_save`、`snapshot_load` → 返回 `1004`。`obs / screenshot / status / list_saves` 放行。

### 11.5 桥接配置 `bridge.config.json`（与脚本同目录，不存在则用默认值）

```jsonc
{
  "port": 7777,             // 监听端口，只绑 127.0.0.1
  "token": null,            // null = 不鉴权
  "read_only": false,
  "snapshot_dir": "./snapshots",
  "log_level": "info"       // debug|info|warn
}
```

## 12. 兼容矩阵


| 游戏版本 | mod 版本 | protocol | 状态 |
|---|---|---|---|
| 1.5.6 (ee2279d5) | 0.1.x | 1 | ✅ 本仓库开发基线 |
| 其他 | 任意 | 任意 | ❌ 硬失败（1002） |
