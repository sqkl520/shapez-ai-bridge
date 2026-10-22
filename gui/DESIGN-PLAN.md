# GUI 实施方案（任务拆解书）

> 状态：已定稿，可执行。5 个 Agent 可并行开工（T3/T4 无依赖，T1/T2 契约已冻结，T5 先写脚本后跑）。
> 辅助材料（必读，勿重复发明）：`gui/ACCEPTANCE.md`、`gui/WINDOWS-PROBES.md`、`gui/DESIGN-TOKENS.md`、
> `docs/CRITIQUE-SUMMARY.md`、`recon/motion-web-refs/{design-slop,motion-tokens,baseline-ui,page-design,components}.md`。

## 0. 技术方向判定：零依赖本地 Web GUI（确认，不推翻）

**结论：`gui/server.mjs`（Node 零依赖）+ `gui/ui/`（无框架单页）+ `--app=` 浏览器窗口，维持原定方向。**

论证（为什么不是 WebView2 / WinForms / Electron）：
1. **Node ≥20 已是硬前置**（README、`engines`、桥接/MCP 都需要）——GUI 零新增运行时；WebView2 运行时在 Win10 非保证存在（需 Evergreen 安装器）；WinForms 过不了样式/动效/焦点环/44px 等闸门，且写 400+ 行换更丑结果。
2. **`.ps1`/`.mjs` 全现成**：GUI 只是它们的进程管理器 + 表单壳，风险最小。
3. **`--app=` 复用系统 Chromium**（本机 Chrome/Edge 均实测存在，`gui/WINDOWS-PROBES.md` §4），无地址栏近似原生窗；渲染引擎与游戏（Electron/Chromium）同源。
4. 纯 HTML/CSS 能过 motion-web 全部闸门（WinForms 不能）。代价仅无托盘/原生通知——窗口即界面，可接受。
**何时该换**：若未来进应用商店或要常驻托盘，再套 WebView2 宿主；第 2 节 HTTP API 原样复用。

## 1. 架构总图

```
┌─ 浏览器 (Chrome/Edge --app=http://127.0.0.1:7801/) ─────────────┐
│  gui/ui/  单页：向导(wizard) / 控制台(console) / 设置(settings)   │
└──────────────┬──────────────────────────────────────────────────┘
        HTTP (同源, 127.0.0.1:7801) + SSE /api/events
┌──────────────┴──────────────────────────────────────────────────┐
│ gui/server.mjs  路由·origin/X-GUI-Token 校验·静态文件·SSE 广播     │
│  ├─ gui/lib/env-probe.mjs   Node/Steam注册表-VDF/mods目录/端口/浏览器/游戏进程 探测 │
│  ├─ gui/lib/proc-mgr.mjs    子进程管理 + 日志环形缓冲(install/bridge/smoke)      │
│  └─ gui/lib/config-io.mjs   bridge.config.json 读/校验/写 + gui/.gui-state.json │
└───┬─────────────────┬───────────────────┬────────────────────────┘
    │ spawn powershell│ spawn node        │ spawn node
    ▼                 ▼                   ▼
install.ps1      src/bridge/bridge.mjs  scripts/smoke_test.mjs
(-Uninstall)     (--port --token ...)   (--url --token)
    │                 ▲ HTTP /health /status /rpc (Origin 无 → 放行)
    ▼                 │
%APPDATA%\shapez.io\mods\shapez-ai-bridge.js ── WS /mod ──► 游戏 shapez.io 1.5.6
```

GUI 自身安全（对齐桥接的 origin 修复）：仅绑 127.0.0.1；所有 `/api/*` 要求 `X-GUI-Token`（启动时 `crypto.randomBytes(16)`，注入 index.html `<meta name="gui-token">`；SSE 因 EventSource 不能带 header，允许 `?token=`）；带 `Origin` 头的请求必须等于 `http://127.0.0.1:<port>` 或 `http://localhost:<port>`，否则 403。

**GUI 端口**：默认 **7801**，被占则 +1 试到 7810，全占报错。启动即打印 URL；用探测到的浏览器 `--app=` 打开（`--no-open` 可关）。`gui/start.cmd`（双击）：

```cmd
@echo off
title shapez-ai-bridge GUI
cd /d "%~dp0.."
node gui\server.mjs
if errorlevel 1 pause
```

## 2. API 契约（前端/后端对齐的唯一依据，字段名为准）

通用：UTF-8 JSON。请求头 `X-GUI-Token: <token>`（除 GET /api/healthz），写操作 `Content-Type: application/json`（跨源预检天然拦截 + token 双保险）。

错误统一体（**全部字段必现**）：`{"error":{"code","message","message_en","hint","detail","log_ref"}}`；`log_ref`=环形缓冲行号（可空），前端"查看日志"跳转到该行。HTTP 码：400 `BAD_REQUEST|INVALID_PARAM|CONFIG_INVALID`；403 `FORBIDDEN_ORIGIN|BAD_TOKEN`；404 `NOT_FOUND`；409 `PORT_BUSY|INSTALL_BUSY|SMOKE_BUSY|CANNOT_STOP_FOREIGN`；500 `INSTALL_FAILED|UNINSTALL_FAILED|BRIDGE_START_FAILED|INTERNAL`。

### 2.1 环境 / 版本

| Method Path | 请求体 | 响应 200 |
|---|---|---|
| GET `/api/healthz` | — | `{ok:true, gui_version:"0.1.0", uptime_s:int, port:int}`（免 token，供断线重连探测）|
| GET `/api/env` | — | 见下 EnvReport |
| POST `/api/env` | `{game_dir?:string}` | 同 EnvReport；game_dir 传入则校验（含 `shapezio.exe`+`resources/app.asar`）并持久化到 `gui/.gui-state.json`；非法 400 INVALID_PARAM `detail.reason:"not_shapez_dir"` |
| GET `/api/version` | — | `{gui, repo, mod:"0.1.0", protocol:1, compat_games:["1.5.6"], node:{min:20, cur:"v24.14.0"}}` |

**EnvReport**（全部字段必现，无值用 null）：

```ts
{ node:{version:string, ok:boolean, path:string},
  os:{platform:"win32", release:string},
  repo:{root:string, mod_source_exists:boolean, mod_version:"0.1.0"},
  game:{found:boolean, dir:string|null, source:"registry|vdf|fallback|manual"|null,
        running:boolean, exe_ok:boolean, asar_ok:boolean, steam_installed:boolean},
  mods_dir:{path:string, exists:boolean, writable:boolean},
  mod:{installed:boolean, path:string|null, sha256_repo:string, sha256_installed:string|null,
       match:boolean, backup_count:int},
  port:{configured:int, busy:boolean, owner_pid:int|null},
  browser:{found:boolean, path:string|null, kind:"chrome"|"edge"|null},
  saves_dir:{path:string, modsettings_found:boolean},
  gui_state:{wizard_completed:boolean, game_dir_override:string|null} }
```

### 2.2 安装 / 卸载

| Method Path | 请求体 | 响应 |
|---|---|---|
| POST `/api/install` | `{mods_dir?:string}` | 200 `{ok:true, exit_code:0, target:string, sha256:string, backup:string|null, lines_n:int}`；409 INSTALL_BUSY；500 INSTALL_FAILED `{exit_code, log_ref}`。执行 `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1`（**不加 `-NoBackup`**，保留 `.bak-*`，满足验收 B3）|
| POST `/api/uninstall` | `{clean_backups?:true, clean_modsettings?:false}` | 200 `{ok:true, removed:[string], kept_modsettings:boolean, notes:[string]}`。先跑 `install.ps1 -Uninstall`；`clean_backups` 删 mods 目录下 `shapez-ai-bridge.js.bak-*`；modsettings 默认保留并在 notes 里提示（"游戏内 mod 设置残留于 saves 目录"），传 true 才删 |

### 2.3 配置

| Method Path | 请求体 | 响应 |
|---|---|---|
| GET `/api/config` | — | `{config:{port,token,read_only,snapshot_dir,log_level,rpc_timeout_ms,long_timeout_ms}, defaults:{...}, file:{path, exists, valid}, warnings:[string]}`。文件不存在 → 返回默认值不报错（验收 C6）|
| POST `/api/config` | 完整 config 对象 | 200 `{ok:true, config, bridge_restarted:boolean}`（桥接在跑且 port/token 变化 → GUI 自动重启并告知）；400 CONFIG_INVALID `{fields:{"port":"必须为 1024–65535 的整数"}}`，**不写文件** |
| POST `/api/config/reset` | — | 200 `{ok:true, config}`（写回默认值）|

校验规则：port int 1024–65535 且（空闲或==当前生效值）；token null 或 `/^[\x21-\x7e]{8,128}$/`（<16 位返回 200 但 warnings 警告弱 token）；read_only bool；snapshot_dir 非空 string 无 `\0`；log_level ∈ debug|info|warn；timeouts int 1000–600000。写入位置：仓库根 `bridge.config.json`。

### 2.4 桥接生命周期 / 日志

| Method Path | 请求体 | 响应 |
|---|---|---|
| GET `/api/bridge/status` | — | `{running:boolean, managed:boolean, pid:int|null, port:int, healthy:boolean, mod_connected:boolean, uptime_s:int|null, in_game:boolean|null, game_version:string|null, mod_version:string|null, hub_level:int|null, paused:boolean|null, allow_write:boolean|null, last_error:string|null}`。**兼容外部启动**：health 探测配置端口，健康即 running:true / managed:false |
| POST `/api/bridge/start` | `{}` | 幂等：已在跑 → 200 `{ok:true, already_running:true, status}`；端口被占 → 409 PORT_BUSY `{pid}`；spawn `node src/bridge/bridge.mjs --port N [--token T] [--read-only]` 后轮询 `/health`（500ms×8s）→ 200 `{ok:true, status}`；超时/秒退 → 500 BRIDGE_START_FAILED `{reason:"timeout|exited|EADDRINUSE", log_ref}` |
| POST `/api/bridge/stop` | `{}` | 200 `{ok:true, stopped:boolean}`（未跑=already stopped）；外部非托管进程 → 409 CANNOT_STOP_FOREIGN `{pid, hint:"该桥接由外部终端启动，请在原终端 Ctrl-C"}`。停止：SIGTERM → 2s → `taskkill /pid <pid> /f` |
| GET `/api/logs?kind=install\|bridge\|smoke&since=N` | — | `{lines:[{n:int,kind,stream:"out"|"err",level:"info"|"warn"|"error"|"ok",text:string,ts:int}], next_since:int}`。每 kind 环形缓冲 2000 行，n 单调递增。install 行按 `[OK]/[FAIL]/[INFO]/[SKIP]/[NOTE]` 前缀映射 level |

### 2.5 冒烟 / MCP / 打开

| Method Path | 请求体 | 响应 |
|---|---|---|
| POST `/api/smoke` | `{autoplay?:true}` | 200 `{ok:true, run_id:int}`；409 SMOKE_BUSY。spawn `node scripts/smoke_test.mjs --url http://127.0.0.1:<port> [--token T]`（env `SHAPEZ_SMOKE_AUTOPLAY=1`）|
| GET `/api/smoke/status` | — | `{running, run_id, exit_code:int|null, checks:[{n:1-5, name, name_zh, state:"pending"|"running"|"pass"|"fail", detail:string}], hint:string|null, finished_at:int|null}`。退出码语义映射（来自 smoke_test.mjs）：0 全过；1 桥接不可达 hint"先启动桥接"；2 游戏未就绪 hint"启动游戏并进入存档"；3 后续检查失败 hint"展开日志查看原始响应" |
| GET `/api/mcp-config` | — | `{config:{mcpServers:{shapez:{command:"node", args:[abs路径], env:{SHAPEZ_BRIDGE_URL, SHAPEZ_BRIDGE_TOKEN?}}}}, claude_desktop_config_path:string, instructions_zh, instructions_en}`。abs 路径 = `<repo>/src/mcp/server.mjs`（正斜杠）|
| POST `/api/open` | `{target}` | 200 `{ok:true, opened:true}`；400 INVALID_PARAM。target ∈ `mods_dir\|snapshots_dir\|saves_dir\|repo_root\|mcp_config_file(生成 gui/mcp-config.generated.json 后打开)\|steam_store(steam://store/1318690)\|steam_run(steam://rungameid/1318690)\|readme`。实现：`explorer`/`notepad`/`cmd /c start` detached spawn |

### 2.6 SSE `/api/events?token=<gui-token>`

`text/event-stream`，`retry: 3000`。事件（`event:` 名 + JSON `data:`）：
`log` = 日志行对象（同 2.4 lines 元素）；`bridge_status` = 2.4 status 对象（每 2s 推 + 变化即推）；`smoke_status` = 2.5 对象（变化即推）；`install_done` = `{ok, exit_code, log_ref}`；`toast` = `{level, message, message_en}`。前端 EventSource 断线自动重连；后端崩了 → UI 顶部横幅"后端已断开"+ 重连按钮（验收 F3）。

## 3. 页面与交互设计

### 3.1 与 motion-web 张力的处理（关键设计决策）

motion-web 声称"不适用于 dashboard/admin UI"。**本 GUI 不设计成 dashboard，设计成"单屏仪表（single-screen instrument）+ 产品级向导流程"**（page-design.md §1 的第五种宏观结构：scroll ratio≈1、全部交互、无折叠）。依据 components.md 的裁决原文："**a control surface may be product dialect inside a creative canvas**"——**画布**保持创作（单一 ground、无 nav CTA、无营销头图、大字号对比），**控件**按产品方言做（8px 级状态矩阵、明确 error/pending 态）。这样既不中 A 组闸门（无居中三卡片/无紫渐变/无装饰掩盖），又保住工具可用性。

**至少 5 种不同 section 形状**（过 A3）：① hero 带——左对齐巨大状态数字 + 右对齐主动作（非居中）；② **信号链**——`游戏→Mod→桥接→AI` 横向管线图，节点带活体呼吸点（本页独有形制）；③ 非对称分栏工作区（左 5 控制区 / 右 7 日志控制台）；④ 向导——竖排大号数字步骤轨 + 内容面板（索引式）；⑤ 危险区——左竖线 inset 警示带（非卡片）。

### 3.2 配色与字体（写死，全部来自 `gui/DESIGN-TOKENS.md` 实测值）

单一 ground 深色（`color-scheme: dark`，不做浅色分支——production-polish §5：一个 ground 是合法承诺）：
`--ground:#222428; --surface:#2d2c39; --surface-2:#3c404a; --surface-3:#484c58; --line:#535866;
--text:#e6e8ee; --text-muted:#7d808a; --accent:#4a97df; --accent-hover:#3f87cc;
--ok:#66bb6a; --warn:#ffac0f; --danger:#ef5072; --focus:#4a97df; --r:6px`。
**为什么不是紫渐变**：#6366f1→#a855f7 是 design-slop.md A4 第一 AI 味指征；本配色锚定游戏本体 CSS 实测值（`.styledButton` 背景、链接色），零渐变、零 glow、零 noise——GUI 读起来像"游戏生态的一部分"，而非模板。
字体：`--font-ui:"Segoe UI",system-ui,sans-serif`（正文 14px）；`--font-mono:"Cascadia Mono",Consolas,monospace`（日志 12.5px）；display 数字 **56–72px / 600 / -0.02em**（56÷14=4×，hero 数字 6×，过 A2/A6 字号对比闸门）。间距 4px 基数（4/8/12/16/24/32），圆角仅 6px 一值，阴影仅日志浮层一处。
### 3.3 动效清单（触发 / 时长 token / 缓动 / 目的；全表见 DESIGN-TOKENS.md）

| # | 动效 | 触发 | Token | 目的 |
|---|---|---|---|---|
| M1 | 首启 hero 入场（数字+信号链依次落位）| 仅首次加载一次 | `slow` 700ms + stagger 80ms，`ease-out-expo` | "仪器上电"——全页唯一入场，不泛化(B2) |
| M2 | 向导步骤切换：新面板 `translateY(12px)+fade` | 前进/后退 | `medium` 450ms，`ease-out-expo` | 方向感（前进自下、后退自上）|
| M3 | 按钮按压 `scale(0.98)` | :active | `instant` 90ms | 真实按压感 |
| M4 | hover 变色（无位移无阴影）| :hover（限 `@media (hover:hover)`）| `fast` 160ms | 只声明"这个元素"的状态(B1) |
| M5 | 信号链节点活体呼吸（`scale 1±0.06`，每节点不同频 0.7/0.9/1.1Hz）| 恒定（连接状态为绿时）| ambient | 系统活着(handfeel §6)；reduced-motion → 静态填充点 |
| M6 | 日志行进入 `fade+4px` | 新行 | `fast` 160ms，stagger `tight-grid` 40ms（每批≤8）| 仪表滚动感 |
| M7 | 成功对勾 spring | 冒烟 5/5、安装成功 | `spring-snappy` 350/28 | 全页唯一弹簧（唯一值得的物理时刻）|
| M8 | 失败摇动 `translateX ±4px` ×2 | 主操作失败 | `standard` 300ms | 无剧场感的注意信号 |

`prefers-reduced-motion: reduce` → 全部坍缩为即时状态；呼吸点静态；静帧完整可用（A1/A4/B8）。焦点环无过渡（瞬时出现）。

### 3.4 状态矩阵（每个交互组件欠的状态，components.md §2）

| 组件 | default / hover / focus-visible / active / disabled / loading / error / success |
|---|---|
| 主按钮 | 蓝底白字 / `--accent-hover` / 2px 焦点环 offset 3 / scale .98 / 降饱和+not-allowed+"为什么"旁注 / label 原位替换不变宽（"安装中…"）/ 红边+字段级消息 / 对勾图标持续显示 |
| 次按钮 | 透明底 1px 边 / 边框亮 / 环 / .98 / 50% 透明 / 同主 / 同主 / — |
| 表单字段 | 深底 1px 边 / 边亮 / 环 / — / 只读态用于展示路径 / — / 红边+`aria-describedby` 消息（不靠颜色） / 绿边一闪 |
| 检查表行(env) | 图标+文字 / 整行高亮 / 环 / — / — / 转圈"检测中" / 红图标+hint+修复按钮 / 绿图标 |
| 日志面板 | 单色等宽 / — / 行焦点环 / — / — / 顶部细进度条 / 红行 / 绿行 |
| 开关(如 read_only) | 轨道+滑块 / 轨道亮 / 环 / 滑块 .98 / 灰 / — / — / — |
| 全部命中区 | 主操作 ≥44×44，次级 ≥36（桌面），键盘 Tab 顺序=阅读顺序（A5/A6/B1）|

### 3.5 向导精确步骤（首启；完成后不再出现，可从设置重进）

**W1 欢迎**（hero 形制）：左大号"三步接管你的工厂"，右侧三步预览条 + **成就禁用警示卡（安装之前，醒目，先于任何按钮）**："安装任何 mod 会禁用 Steam 成就与拼图 DLC（官方行为）"+ 可展开"将被写入的文件"清单。可点 `[开始]`、`[查看详情]`、语言切换。无失败路径。
**W2 环境检查**：进页自动跑 `GET /api/env`，逐行检查表（Node ✓ / 游戏目录 / mods 目录 / mod 安装态 / 端口 / 浏览器）。失败行：红图标 + 人话 hint + 行动按钮（"用 Steam 安装"→`/api/open steam_store`；"手动指定路径"→输入框 + `POST /api/env`；"重新检测"）。游戏缺失时向导仍可继续（装 mod 不依赖游戏目录），但顶部黄条常显。
**W3 安装**：成就警示卡**常驻本步**；`[安装 mod]` → 内联渐进日志（M6）+ 完成卡（目标路径、sha256 前 8 位、备份文件名、`[卸载]` 次按钮）。失败：错误卡 + exit_code + `[查看完整日志]`（log_ref 定位）+ `[重试]` + hint（"mods 目录只读 → 检查权限或杀软占用"）。**W4 配置**：表单化全部关键项（port/token/read_only/snapshot_dir/log_level + 折叠的高级 timeouts），每字段默认值 + 必填校验 + 一行说明。`[保存并继续]`；字段级错误就地显示且不写文件；`[用默认值]`。端口占用：`POST /api/config` 返回 PORT_BUSY → 就地建议下一个空闲端口。
**W5 启动**：`[启动桥接]` → 状态子步骤：端口探测→spawn→"启动中（滚动日志）"→运行中（`已运行 Ns · 端口 7777`）。随后 `[启动 shapez.io]`（Steam 协议）+ 常驻提示条"等待游戏连接…"（bridge_status 的 mod_connected），附"若游戏已在运行，需**重启游戏**让 mod 生效"（吸收锐评：装完 mod 的生效条件此前没写）。失败：EADDRINUSE → "端口被占用（PID 1234）"+ `[更换端口]`深链回 W4；秒退 → 日志展开。
**W6 验证**：`[运行冒烟测试]` → 5 项检查流式打勾（M6/M7）。0：对勾弹簧 + "完成"[进入控制台]；1：`[桥接未运行]`+[启动桥接]；2："游戏未进入世界"[打开游戏]；3：失败项 + `[展开原始 JSON]` + `[复制报告]` + 日志。本步可 `[跳过]`。

### 3.6 控制台与控制区（向导后主界面）

顶栏（固定、无高度变化）：logo · 迷你信号链药丸（4 点状态）· 语言切换 · 版本号。
主区：**信号链带**（②）→ **非对称分栏**（③）：左列 = 状态卡堆（桥接卡：大号 uptime 数字 + 启停；游戏卡：运行/连接、game_version、hub_level 大号数字、`[启动游戏]`；Mod 卡：版本 + 安装/shadow 校验；冒烟卡：最近结果），右列 = 日志控制台（级别过滤 all/info/warn/error、跟随开关、清屏视图、下载、log_ref 跳转）。
底行快捷：`[打开快照目录] [复制 MCP 配置] [打开 mods 目录] [文档]`。
设置视图：W4 表单复用 + **危险区带（⑤）**：卸载（确认对话框列出将删/将留项）、重置配置、清理 `.bak-*`。

### 3.7 冻结的 DOM / JS 接口（T3/T4 并行锚点，不许改名）

`gui/ui/index.html` 骨架（T3 拥有）：`#topbar`；`#view-root` 内 `#view-boot`、`#view-wizard`、`#view-console`、`#view-settings`（后三者 hidden 切换）；`#toast-host`；`<dialog id="confirm-dialog">`；`<meta name="gui-token">`；`?probe=1` 时把自检 JSON（displayFont/bodyFont/ratio/minHit/focusableCount/reducedMotion）写入 `<script type="application/json" id="probe-json">`（T5 用 `--dump-dom` 读取，验收 A2/A4/A6）。
`gui/ui/js/api.js`（T3 拥有）导出：`api = {env, envReprobe, install, uninstall, getConfig, saveConfig, resetConfig, bridgeStart, bridgeStop, bridgeStatus, logsSince, smokeStart, smokeStatus, mcpConfig, openTarget, version, events:{on(type,cb)->unsubscribe}}`；失败抛 `ApiError{code,message,hint,status,detail,log_ref}`。
`gui/ui/js/boot.js`（T3）挂 `window.GUI = {showView(name), toast(msg,level), confirm(opts)->Promise<bool>, t(key)}`。
`gui/ui/js/logview.js`（T3）导出 `createLogView(el,opts)->{append(lines),clear(),setFollow(b)}`（T4 复用，不许另写日志渲染）。
`gui/ui/js/i18n.js`（T3）：zh-CN 默认（`navigator.language` 决定，可切换），字典 ≥80 键，zh/en 全齐。
T4 只新增：`gui/ui/css/console.css`、`gui/ui/js/{console,settings,logpanel,wizard-ref? 无}.js`——**不得改 index.html 结构与 base.css 变量名**；需要的挂载点用 `GUI.mountConsole(el)` 式钩子，由 T3 在 boot.js 里预留调用（index.html 中 `#view-console` 内给 T4 一个空 `<div id="console-root">`，`#view-settings` 内 `#settings-root`）。

## 4. 任务拆解（5 个并行 Agent）

依赖关系：**T1/T2/T3/T4 立即并行**（契约本文件已冻结）；**T5 立刻开始写脚本/文档骨架，T2 合入后跑通**。关键路径 = T2 → T5。

### T1 · 环境探测与配置 IO（复杂度 M）
- **独占文件**：`gui/lib/paths.mjs`、`gui/lib/env-probe.mjs`、`gui/lib/config-io.mjs`
- **方法与证据**：Steam 四级探测链、端口探测、浏览器候选、游戏进程——全部照抄 `gui/WINDOWS-PROBES.md`（已实测）。注册表用 `spawn('reg',['query',...])` 解析，不引依赖。
- **冻结导出**（T2 依赖，签名不许变）：
  `paths.mjs`: `ROOT, GUI_DIR, UI_DIR, BRIDGE_CONFIG, GUI_STATE, MOD_SOURCE, MCP_SERVER, SNAPSHOT_DIR_DEFAULT, MODS_DIR, SAVES_DIR`
  `env-probe.mjs`: `probeEnv({gameDir})->Promise<EnvReport>`、`probePort(port)->{busy,pid|null}`、`findBrowser()->{path,kind}|null`、`isGameRunning()->Promise<bool>`、`sha256File(p)->string`、`findFreePort(from,to)->int|null`
  `config-io.mjs`: `readConfig()`、`validateConfig(cfg)->{ok,clean,errors,warnings}`、`writeConfig(cfg)`、`resetConfig()`、`readGuiState()/writeGuiState(patch)`
- **验收**：`node --input-type=module -e "import('./gui/lib/env-probe.mjs').then(m=>m.probeEnv({}))"` 输出与真实机器一致（对照验收 B1：node 版本、d:/steam 游戏目录、mods 目录、mod  sha256 匹配、7777 空闲、Chrome 存在）。

### T2 · API 服务与进程管理（复杂度 L）
- **独占文件**：`gui/server.mjs`、`gui/lib/proc-mgr.mjs`、`gui/start.cmd`
- **内容**：第 2 节全部 endpoint；静态文件服务（`gui/ui/`，防路径穿越）；SSE 广播；X-GUI-Token/Origin 校验；子进程管理（spawn 参数、就绪轮询、SIGTERM→taskkill、日志环形缓冲+level 映射）；gui 端口 7801 递增；`--no-open`；启动打印 URL + 自动 `--app=` 打开。
- **严令**：只调用 T1 冻结签名；桥接子进程参数 = `--port/--token/--read-only`（其余走 config 文件）；smoke 加 `--url/--token` 与环境 `SHAPEZ_SMOKE_AUTOPLAY=1`；install 的 spawn 用 `-NoProfile -ExecutionPolicy Bypass -File`，UTF-8 解码（install.ps1 已自设 UTF-8 输出）。
- **验收**：验收矩阵 B/C/D/F 组全绿（用 curl/Node fetch 手工跑一遍再交 T5）。

### T3 · 前端外壳 + 向导（复杂度 L）
- **独占文件**：`gui/ui/index.html`、`gui/ui/css/base.css`、`gui/ui/css/wizard.css`、`gui/ui/js/{boot,api,i18n,wizard,logview}.js`
- **内容**：3.1–3.5、3.7 全部；设计 token 落为 CSS 自定义属性；动效 M1–M8；状态矩阵；reduced-motion 分支；`?probe=1` 自检；`GUI.*` 钩子与 T4 挂载点。
- **验收**：向导在无游戏（W2 黄条）与有游戏两种路径都能走到 W6；`node gui/shot.mjs http://127.0.0.1:7801/ docs/gui/01-wizard.png --reduced-motion` 静帧过 design-slop §A 自查（三卡片/紫渐变/字号对比 4×）。

### T4 · 前端控制台 + 设置 + 日志（复杂度 M）
- **独占文件**：`gui/ui/css/console.css`、`gui/ui/js/{console,settings,logpanel}.js`
- **内容**：3.6；复用 `createLogView` 与 `api.js`；信号链呼吸点（M5，reduced-motion 静态）；冒烟 5 项检查视图；MCP 配置复制（`navigator.clipboard` + 失败回退选中文本）；危险区。
- **验收**：桥接启动/停止/日志增量/冒烟流式在真实后端上手动过一遍；无 game 时游戏卡显示"未运行"+ 指引而非报错（E1）。

### T5 · 验证与红队 + 文档打包（复杂度 M，T2 合入后执行）
- **独占文件**：`gui/verify/*.mjs`、`gui/README.md`、`docs/gui/*`（截图）
- **内容**：
  1. `gui/verify/api_acceptance.mjs`：对运行中的 GUI 跑验收 B/C/D/F 全部可自动化项（Node fetch，零依赖），输出 PASS/FAIL 表 + 退出码。
  2. `gui/verify/dom_gate.mjs`：`chrome --headless=new --dump-dom ".../?probe=1"`（正常 + `--force-prefers-reduced-motion`）解析 `#probe-json` 判 A2/A4/A6；截图 A1 静帧。
  3. 错误注入（验收 B5/B6/C5/D5/E4）：只读目录安装、假 game_dir、占端口启动、桥接未跑时冒烟——逐条留证。
  4. **反断言**（红队）：GUI 后端不接受 `Origin: evil.example.com`（403）；无 token 的 POST 拒绝；`/api/open` 只认白名单 target；路径穿越（`../`）打开/快照目标被拒。
  5. 杀后端进程复测 F3（UI 横幅）。
  6. `gui/README.md`（启动说明/配置说明/常见错误）+ `docs/gui/` ≥4 张关键截图（首启/安装完成/配置/运行中+日志）。
- **验收**：验收矩阵 A–F 组全绿或明确标注"需游戏运行，runbook 见 gui/README.md"（E2）；G 组自检。

## 5. 验收清单（用户 6 条 → 可勾选测试）

| 用户要求 | 测试项 | 期望 | 谁来测 |
|---|---|---|---|
| ① 安装简化 | W1–W3 全程 | 双击 start.cmd → 点三次鼠标完成安装；环境缺失项有提示+修复按钮（B1/B2/B5）| T3 自查 + T5 api_acceptance |
| ② 配置简化 | W4 | 全部关键项表单化、默认值回显、字段级校验、保存/重置、零手改文件（C1–C6）| T5 |
| ③ 界面优美 | A1–A7 | 静帧过 design-slop §A；字号比 ≥4×；单一 accent；焦点环；44px；reduced-motion 可用 | T5 + 人工复核 |
| ④ 错误处理 | F1–F3 + B5/B6/D5 | 每个错误有人话提示 + "查看日志"（log_ref 定位）+ 修复建议 | T5 错误注入 |
| ⑤ 交付物 | G1–G3 | gui/README.md 可照做；start.cmd 双击可跑；docs/gui/ ≥4 截图 | T5 |
| ⑥ 新用户 3 步 | 端到端走查 | 下载 ZIP→解压→双击→（点安装/启动）≤3 次点击到"运行中"；成就警示在安装前 | T5 + 人工“陌生人走查” |
| 回归 | G4 | 98 项旧断言 + 3 基准不受影响（`node test/*.mjs`、`npm run selftest:*`）| T5 |

## 6. 风险清单

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 用户机器无 Chrome/Edge 或检测失败 | 探测候选扩到 6 个路径（Program Files 两档 + LocalAppData）；都失败 → 不 `--app=` 打开，打印 URL + `start http://...` 走默认浏览器；再不行提示手动复制 URL（GUI 后端永远可用）|
| R2 | GUI 端口 7801–7810 全被占 | 报错并给出占用 PID（netstat 解析）；`--port N` 覆盖参数；文档写死 |
| R3 | 杀软/防火墙拦截（node 监听、ps1 执行、localhost 环回）| spawn/listen 的 EACCES/EPERM 捕获为专门错误码 + 中文指引（"允许 node 在防火墙；排除 127.0.0.1 代理"，来自 README 排查节）；install.ps1 已用 `-ExecutionPolicy Bypass` |
| R4 | 游戏运行中装 mod → 用户以为没生效 | env 探测 `game.running`；W3 成功后与 W5 常驻提示"需重启游戏生效"；W5 等待连接条同时显示该提示 |
| R5 | 7777 被外部桥接/别的进程占用 | start 前 `probePort`+owner_pid；外部桥接 → status 显示 managed:false、stop 拒绝并指引原终端（CANNOT_STOP_FOREIGN）；他人进程 → PORT_BUSY + 一键换端口深链 |
| R6 | 后端崩溃/SSE 断线，用户对着死页面操作 | EventSource 自动重连 + `/api/healthz` 轮询；断线横幅"后端已断开"+重连按钮（F3 有专项测试）；所有写操作失败均有 toast |
| R7 | PowerShell 输出中文乱码 | install.ps1 已自设 `[Console]::OutputEncoding=UTF8`；proc-mgr 固定 utf8 解码并有 mojibake 启发式检测（出现 `锟斤拷` → 提示设 `chcp 65001` 并附原文）|
| R8 | 首次运行下载的 ZIP 不完整（无 src/mod）| env 报告 `repo.mod_source_exists:false` → W3 按钮禁用 + 提示"请重新完整解压 ZIP"（对应锐评 C 的"拿不到仓库"教训，Release 分发须含全仓库）|

**时间预算**：各任务建议 2–3h agent 工作量；关键路径 T2→T5 合计 ≤6h；本文件即每一行的最终依据，Agent 间争议以本文件 + 验收矩阵的"可自动化复现优先"仲裁原则裁决。
