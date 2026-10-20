# shapez-ai-bridge

[English](README.md) | **简体中文**

**「AI 可操作接口」for [shapez.io](https://shapez.io)：单文件官方 mod + 零依赖本地桥接 + MCP 服务器。** 观测工厂、放置/删除建筑、确定性快进、搬运蓝图与存档快照，供任意脚本或 MCP 客户端驱动——全部在本机 `127.0.0.1` 上完成。

```
┌─ shapez.io (Electron) ───────────────────┐
│  shapez-ai-bridge.js                    │   mod 是 WebSocket *客户端*
│  （官方单文件 mod，无 Node 权限）      ──┼──▶ ws://127.0.0.1:7777/mod
└─────────────────────────────────────────┘
              │
┌─────────────┴────────────────────────────┐
│  bridge.mjs  (Node，零依赖)              │
│  ├─ WS   /mod     ← 游戏 mod             │
│  ├─ WS   /client  ← 工具 / 事件流        │
│  └─ HTTP /health  /status  /rpc  ← curl  │
└─────────────┬────────────────────────────┘
              │ HTTP 或 stdio
┌─────────────┴──────────┬─────────────────┐
│  mcp/server.mjs        │  agent/play.mjs │
│  8 个 MCP 工具 (Claude…)│  参考 agent     │
└────────────────────────┴─────────────────┘
```

为什么要有独立的桥接进程？shapez.io 的渲染进程是沙箱化的（`nodeIntegration:false`、`sandbox:true`），游戏内 mod 拿不到文件或网络 API——但浏览器原生 `WebSocket` 客户端始终可用。于是 mod 主动连向你机器上的一个小 Node 进程；HTTP API、MCP 服务器和快照文件都归这个进程管。

## 30 秒快速开始

前置条件：**Node.js ≥ 20**、**shapez.io 桌面版 1.5.6**（Steam 版）和一份本仓库检出。

**1. 安装 mod（一行命令）。**

Windows（PowerShell）：
```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```
macOS / Linux：
```bash
bash install.sh
```

**2. 启动桥接（一行命令）。**

```bash
node src/bridge/bridge.mjs
```

**3. 启动 shapez.io，进入一个存档，然后运行：**

```bash
node scripts/smoke_test.mjs
```

预期输出：`SMOKE TEST PASSED (5/5)`（冒烟测试通过）。测试会临时在 hub 附近放置并删除一条传送带以验证写入链路——世界会恢复原状。

## 能做什么

以下 curl 示例基于 bash。Windows PowerShell 里 `curl` 是 `Invoke-WebRequest` 的别名——请改用 `curl.exe`（JSON 用双引号包裹并转义内部引号），或直接用仓库自带脚本。

- **观测**——以 JSON 询问游戏世界状态：带稳定 uid 的实体列表、hub 存量、当前目标、相机、统计。
  ```bash
  curl -s http://127.0.0.1:7777/rpc -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"obs","params":{"max_entities":5,"include_hub":true}}'
  ```
- **动作**——放置/删除建筑、铺设直线路径、设置游戏速度、移动镜头。
  ```bash
  curl -s http://127.0.0.1:7777/rpc -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"act","params":{"op":"place","building":"belt","x":5,"y":5}}'
  ```
- **快进**——同步、确定性地推进 N 个游戏 tick（复用游戏自身 puzzle 校验器的循环），可选附带一次观测。
  ```bash
  curl -s http://127.0.0.1:7777/rpc -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"act","params":{"op":"step","ticks":600,"collect":true}}'
  ```
- **蓝图**——把任意区域导出为可携带的 `SZBP1.*` 字符串，并可在任意位置粘贴回来（默认按游戏规则扣"蓝图形状"材料，`charge:false` 免费）。
  ```bash
  curl -s http://127.0.0.1:7777/rpc -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"act","params":{"op":"export_blueprint","region":[0,0,10,10]}}'
  ```
- **存档快照**——保存游戏并在桥接侧留一份命名副本，随时可还原。
  ```bash
  curl -s http://127.0.0.1:7777/rpc -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"snapshot_save","params":{"name":"before-big-build"}}'
  ```
- **MCP**——以上能力全部包装为 8 个 MCP 工具（`shapez_status`、`shapez_observe`、`shapez_action`、`shapez_batch`、`shapez_screenshot`、`shapez_blueprint`、`shapez_save`、`shapez_load`），供 Claude 等 MCP 客户端使用。
  ```bash
  echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node src/mcp/server.mjs
  ```

完整协议契约（方法、错误码、观测结构）见 [`docs/PROTOCOL.md`](docs/PROTOCOL.md)。

## 兼容矩阵

由 `compat.json` 生成：

| 游戏版本 | mod 版本 | protocol | 状态 |
|---|---|---|---|
| 1.5.6（Steam 构建 `ee2279d5`，Electron 16.2.8） | 0.1.x | 1 | ✅ 支持 — 开发基线 |
| 其他任何版本 | 任意 | 任意 | ❌ **硬失败**（错误码 `1002`）— 禁止降级、无覆盖开关 |

mod 声明了 `minimumGameVersion: 1.5.6`，桥接还会在握手时用游戏上报的版本比对这张表；不匹配则什么都不转发。

## 卸载

删除 mods 目录里的 `shapez-ai-bridge.js` 即可（整个 mod 就是这一个文件）；或运行 `install.ps1 -Uninstall` / `bash install.sh --uninstall`。

## 已知限制

诚实清单，取材自阶段 0 侦察报告（[`PHASE0-RECON.md`](PHASE0-RECON.md)）：

- **安装任何 mod 都会禁用 Steam 成就。** 游戏只在零 mod 时才启用 Steam 层（`if (mods.length === 0) steam.listen()`）。这是 shapez.io 的官方行为，不是本项目的 bug。
- **游戏每次启动都会清空 localStorage**（主进程 `clearCache()` + `clearStorageData()`），因此 mod 没有任何跨会话本地存储。需要持久化的数据只能走 mod 设置文件或存档。
- **shapez.io 1.5.6 没有原生蓝图字符串格式。** 本项目自定义了 `SZBP1.*` 格式（基于游戏自身的 LZ-string 压缩），因此蓝图只能在同版本之间交换——字符串内嵌 `gv`（产出时的游戏版本）字段，粘贴时不匹配会报 `2006`。
- **粘贴蓝图按游戏规则扣"蓝图形状"材料**（regular 模式下为 `CbCbCbRb:CwCwCwCw`）。用 `charge:false` 可免费粘贴。
- **`step` / `await` 快进在渲染线程上同步执行**——大 tick 数会短暂冻结画面。单次 step 上限 20,000 ticks。
- **大规模工厂的观测需要裁剪**（`region` 和/或 `max_entities`）。超限时响应带 `truncated: true` 且始终包含全量 `stats`——绝不静默截断。
- **仅限桌面版**（Windows / macOS / Linux Electron 构建）。shapez.io 移动版与网页版不支持 mod，不适用。

## 故障排查

**「连不上。」**
1. 桥接在运行吗？`curl -s http://127.0.0.1:7777/health` 应返回 `{"ok":true,...}`。「Connection refused」→ 先启动 `node src/bridge/bridge.mjs`。
2. 游戏在运行吗？只有当游戏开着**且 mod 已加载**时，`health` 才会报 `mod_connected:true`。`mod_connected:false` 说明游戏（或 mod）还没就位。
3. mod 放对地方了吗？游戏读取 `%APPDATA%\shapez.io\mods`（Windows）、`~/Library/Preferences/shapez.io/mods`（macOS）、`~/.local/share/shapez.io/mods`（Linux）。必须是**直接放在该目录下的单个 `.js` 文件**（不能是子目录）。游戏启动时会打印 `Loaded N mods`——N 必须 ≥ 1。安装脚本会自动选对目录；`-ModsDir` / `--mods-dir` 可覆盖。
4. 安全软件：拦截 localhost 的防火墙/代理会同时破坏桥接监听与 mod 的 WebSocket。请放行 `node` 访问 `127.0.0.1:7777`；若系统全局强制代理，请把 `127.0.0.1` 加入排除名单。

**「版本不匹配（错误码 1002）。」** 游戏版本不在兼容表里，桥接拒绝握手。这是刻意的硬失败：建筑 code 表与内部 API 都是版本相关的。升级到兼容表（`compat.json`）里包含你游戏构建的 mod/桥接版本即可（或通过 Steam 测试版切回受支持的构建）。没有覆盖开关。

**「观测为空 / 报错。」**
- 错误 `1003 not_in_game` → 你在主菜单或还在加载中。请进入一个存档（或新开一个）；`status` 会显示 `in_game:true`。
- 区域选择：`region:[x0,y0,x1,y1]` 是含边界的包围盒，盒外一律被过滤。省略 `region` 则观测全部实体的包围盒。
- 层（layer）：实体分为 `regular` 与 `wires` 两层，注意观测正确的一层（默认 `regular`）。

**「MCP 客户端里看不到工具。」**
- 客户端配置里的路径必须是**绝对路径**且指向 `src/mcp/server.mjs`。Windows 的 JSON 中用正斜杠（`C:/...`）或转义反斜杠（`C:\\...`）。
- 修改配置后重启 MCP 客户端。
- 单独测试服务器：`echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node src/mcp/server.mjs`——应输出一行 JSON，列出 8 个工具。
- 服务器日志走 stderr 而非 stdout；到客户端的 MCP 日志里查看其 stderr 输出。

## MCP 配置

`mcp-config.example.json`：

```json
{
  "mcpServers": {
    "shapez": {
      "command": "node",
      "args": [
        "C:/path/to/shapez-ai-bridge/src/mcp/server.mjs"
      ],
      "env": {
        "SHAPEZ_BRIDGE_URL": "http://127.0.0.1:7777"
      }
    }
  }
}
```

把路径换成你检出的绝对路径。**Windows 路径在 JSON 里的写法：** 用正斜杠（`C:/Users/you/shapez-ai-bridge/src/mcp/server.mjs`）或转义反斜杠（`C:\\Users\\you\\...`）；单个反斜杠是非法 JSON。`command` 必须能解析到 `node` ≥ 20。若桥接启用了 token（`bridge.config.json`），在 `env` 里加 `"SHAPEZ_BRIDGE_TOKEN": "<token>"`。

## 许可与来源

- 本项目代码为 **MIT** 许可——见 [`LICENSE`](LICENSE)。
- vendored [lz-string](https://github.com/pieroxy/lz-string) 1.4.5（`src/shared/lz-string.cjs`）：© 2013 Pieroxy，**MIT / WTFPL** 双许可——见 [`src/shared/lz-string.LICENSE.txt`](src/shared/lz-string.LICENSE.txt)。它负责压缩蓝图，并与游戏自身的存档压缩算法一致。
- 本仓库**不含任何 shapez.io 游戏代码**。全部集成走游戏官方 mod API（单文件 mod 的 `METADATA`/`Mod`、`ModInterface`、`window.shapez` 模块导出）。shapez.io 版权 © [tobspr Games](https://shapez.io)。

## 开发

目录结构：

| 路径 | 说明 |
|---|---|
| `src/mod/shapez-ai-bridge.js` | 游戏内 mod——单文件，由官方 mod 加载器加载 |
| `src/bridge/bridge.mjs` | 零依赖 Node 桥接：WS `/mod` + `/client`，HTTP `/health` `/status` `/rpc`，快照文件管理 |
| `src/mcp/server.mjs` | MCP stdio 服务器（8 个工具），转发到桥接的 HTTP API |
| `src/agent/play.mjs` | 参考 agent，经 HTTP 驱动桥接 |
| `src/shared/` | vendored lz-string + `SZBP1` 蓝图编解码 |
| `scripts/smoke_test.mjs` | 零依赖端到端冒烟测试 |
| `docs/PROTOCOL.md` | 冻结的协议契约——唯一权威 |
| `compat.json` | 机器可读的兼容矩阵 |
| `test/` | 分层自测（Node 沙箱里的 mod RPC、lz-string 互通、蓝图往返） |
| `recon/` | 阶段 0 逆向产物（仅本地研究用，不随分发） |

运行各层与其自测：

```bash
npm run selftest:bridge   # 桥接层自测
npm run selftest:mcp      # MCP 层自测
npm run smoke             # 端到端冒烟测试（需游戏 + 桥接在运行）
npm run agent             # 参考 agent
node test/mod_rpc_selftest.mjs    # mod RPC 逻辑，在 Node 沙箱中执行
node test/lzstring_interop.mjs    # lz-string 与游戏变体的字节级互通
node test/blueprint_selftest.mjs  # SZBP1 编解码往返
```

**冒烟测试说明：** 默认完全无交互；退出码 `0` = 通过，`1` = 桥接未运行，`2` = 游戏未进入世界，`3` = 其他检查失败。`SHAPEZ_SMOKE_AUTOPLAY=1` 可额外隐藏"临时放置一条传送带"的提示。用 `--url` / `SHAPEZ_BRIDGE_URL` 覆盖桥接地址；用 `--token` / `SHAPEZ_BRIDGE_TOKEN` 携带鉴权。
