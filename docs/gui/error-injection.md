# GUI 错误注入留证（T5）

> 每项：注入方法 / 期望 / 实测证据。证据来自 `gui/verify/*.mjs` 的原始输出
> （`docs/gui/logs/api_acceptance.out`、`redteam.jsonl` 等）。
> **状态（2026-10-22 10:10 定稿）**：全部项已对完整版 GUI 执行完毕；结果下表。

| 项 | 最终结果 | 证据 |
|---|---|---|
| B5 假游戏目录 | **PASS** | 400 INVALID_PARAM + hint；未持久化 |
| B6 安装失败可见 | **PASS** | INSTALL_FAILED 错误体 + 日志可见 |
| C5 端口占用（config） | **PASS** | 409 PORT_BUSY；文件未写 |
| D5 端口占用（bridge start） | **PASS** | 409 PORT_BUSY |
| E4 冒烟无桥接 | **PASS** | exit_code=1 + hint"先启动桥接" |
| R7 PowerShell 解码 | **PASS（运行时）** | install 日志中文正常（下详） |

## B5 · 假游戏目录

- **注入**：`POST /api/env {"game_dir":"C:/definitely/not/a/shapez/dir-…"}`（目录不存在）
- **期望**：400 `INVALID_PARAM`，message/message_en/hint 齐全；不持久化
- **实测（终态 2026-10-22）**：**PASS** —
  400 `INVALID_PARAM`（hint="选择包含 shapezio.exe 的目录"）；`B5.no_persist` PASS（`gui_state.game_dir_override` 保持 null）。
  （T1 probeEnv 层直测同为无副作用：found=false/source="manual"）
- **证据**：`docs/gui/logs/api_acceptance.out` B/B5、B/B5.no_persist 两行

## B6 · 安装失败可见（不是静默失败）

- **注入**：`POST /api/install {"mods_dir":"…/docs/gui/logs/fake-mods-file"}` 指向一个「普通文件」
  （选此注入而非 ACL 只读：本机为管理员，只读位可被绕过，无法可靠复现）
- **期望**：非 200；`INSTALL_FAILED`（含 exit_code/log_ref）或 400 前置校验；UI 可查看日志
- **实测（终态 2026-10-22）**：**PASS** — 返回错误"安装失败"（INSTALL_FAILED 路径），
  非静默；install 日志缓冲可查（`GET /api/logs?kind=install` 有行）。
- **证据**：`api_acceptance.out` B/B6 行 + `logs/results.jsonl` B6.logs

## C5 · 端口占用冲突（配置保存）

- **注入**：以 `node -e` HTTP dummy 占住空闲端口 P，再 `POST /api/config {port:P}`
- **期望**：409（或 400）；错误信息含 hint；**不写文件**
- **实测（终态 2026-10-22）**：**PASS** —
  409 `PORT_BUSY`（hint="换一个端口，或结束占用进程"）；`bridge.config.json` 内容前后不变。
- **证据**：`api_acceptance.out` C/C5 行

## D5 · 桥接启动失败可见（EADDRINUSE）

- **注入**：占住配置端口后 `POST /api/bridge/start`
- **期望**：409 `PORT_BUSY {pid}`（他进程）或 500 `BRIDGE_START_FAILED`；
- **实测（终态 2026-10-22）**：**PASS** — 409 `PORT_BUSY`（可查 pid；hint 指引换端口）。
- **证据**：`api_acceptance.out` D/D5 行
- **外部桥接分支（R5）**：由 E2 自建外部桥接覆盖 —— `managed:false`、stop → 409 `CANNOT_STOP_FOREIGN`、
  外部进程存活（GUI 决不杀外部进程）。**PASS**（E/E2.stop_foreign_guard 行）

## E4 · 冒烟失败可见（桥接未运行）

- **注入**：`scripts/smoke_test.mjs --url http://127.0.0.1:17799`（无监听端口）+ GUI 层 `/api/smoke`（配置端口无桥接）
- **期望**：退出码 1 + "先启动桥接"人话提示；GUI 层映射到 status.hint
- **实测（工具层 10-21；GUI 层终态 10-22）**：**PASS** —
  工具层：退出码 1；`[1/5] FAIL bridge reachable … 无法连接桥接服务器`；hint `桥接未运行。请先启动: node src/bridge/bridge.mjs`（`smoke-direct-deadport.log`）
  GUI 层：`E4.result` PASS — `exit_code=1`，hint=`先启动桥接`；`E4.port_empty` 对照 PASS（端口确无监听）

## E2（部分）· 有游戏但不在世界的现场证据

- **现场（10-21）**：外部桥接 7777，游戏 shapez.io 1.5.6 运行中（mod 已连接），但停在主菜单
- **实测（2026-10-21）**：`smoke_test.mjs --url http://127.0.0.1:7777` →
  **退出码 2**（语义=游戏未就绪），`[2/5] FAIL world loaded — 尚未进入世界`，
  hint `请先在 shapez.io 中加载或新建一个存档（进入世界），然后重跑本测试`。
  退出码语义（0 全过/1 桥接不可达/2 游戏未就绪/3 后续检查失败）与
  DESIGN-PLAN §2.5 完全一致。日志：`docs/gui/logs/smoke-direct-7777.log`
- **注意（10-22）**：验证期间用户关闭了该外部桥接（游戏退出）→ 7777 只读观测项 BLOCKED（非缺陷）。
  GUI 对"外部桥接"的完整行为改由 E2 自建桥接组验证：`managed:false`、健康即 `running:true`、
  stop → 409 CANNOT_STOP_FOREIGN 且不杀进程 —— **4/4 PASS**。
- **未覆盖**：E3 冒烟 5/5（需游戏在世界内）+ E1 游戏连接后的 UI 状态 —— 需人工 runbook（gui/README.md）。


## R7 · PowerShell 中文输出解码

- **注入**：不注入（无法人为制造 GBK 流）；以真实安装/失败日志检查解码链
- **期望**：日志中中文正常显示（无 `锟斤拷`/`ï¿½`），证明 UTF-8 解码正确
- **实测（终态 2026-10-22）**：**PASS（运行时）** — B6 注入的 install 日志经
  `GET /api/logs?kind=install` 回读，中文完整："[提示] 全新安装（无同名 mod）。" 与
  PowerShell 原文 "未能找到路径…" 均无乱码（见 results.jsonl B6.logs）。
- **附注（观察级）**：PowerShell 的 Copy-Item 错误原文经 stderr 回传后 level 标为 `warn`
  （proc-mgr 的 mapLevel 对含 error 词元的行本应 error；此处原文行不含 error 字样）——
  实际 UI 中"安装失败"总状态正确（B6 PASS），仅个别行的着色可再调优。与既有 OBS-2 同源。

## 反断言（红队）证据

见 `docs/gui/VERIFICATION.md` 的「反断言（红队）」节 —— 由
`gui/verify/red_team.mjs` 落盘（origin 403 / token 403 / open 白名单 / 路径穿越 /
token 不进 stdout / .bak-\* 安全 / SSE token）。

---

## 静态审阅观察（T2 `gui/lib/proc-mgr.mjs`，已实测复核）

> 以下为低危体验层观察，非功能缺陷，不计 FAIL。

### OBS-1 · Windows 下桥接"优雅停止"分支不触发（信息级）

`stopProcess()` 先 `child.kill("SIGTERM")` 再 2s 后 taskkill。实测（Node v24 本机）：

```
child closed. code= null signal= SIGTERM handler ran? false
```

即 Windows 上 Node 的 `child.kill('SIGTERM')` 走 TerminateProcess，**不会**执行子进程的
`process.on('SIGTERM')` 处理器 → 桥接的 "shutting down..." 优雅退出日志不会出现，
`{forced:true}` 分支几乎总是走 taskkill。功能结果正确（进程确实停止、端口释放），
仅"优雅退出"的实际语义与代码意图不完全一致。DESIGN-PLAN §2.4 本身也写明
「SIGTERM → 2s → taskkill」双保险，判定为**符合设计、非缺陷**。

### OBS-2 · `mapLevel` 子串启发过宽（显示级）

实测：

| 输入（kind=bridge, stream=out） | 结果 | 评价 |
|---|---|---|
| `"failsafe engaged"` | `error` | 误报（"fail" 子串命中 "failsafe"） |
| `"no errors here"` | `error` | 误报（"errors" 命中 `error`） |
| `"EADDRINUSE: address already in use"`（stderr） | `warn` | 漏报（真正的启动失败应为 error；因规则先匹配 `error|fail` 失败后落 stderr→warn） |

影响：日志面板级别着色在个别行上不准（不影响过滤可用性 —— 文本内容正确、级别可再用
`all` 查看）。建议（不阻塞）：规则改为词边界 `/[\b\s_-]error[\b\s_-]|^fail|\[fail\]/i` 类似形式，
或对已知关键串（EADDRINUSE/ECONNREFUSED）显式提级。

### OBS-3 · `logsSince` 未知 kind 返回 null（契约一致）

`GET /api/logs?kind=bogus` 后端返回 null —— server 应映射为 400。待 server 落盘后在
api_acceptance 复核（未测）。
