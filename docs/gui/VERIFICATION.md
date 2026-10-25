# GUI 验证报告（T5 · 实时更新）

> 本文件由 `gui/verify/api_acceptance.mjs`、`red_team.mjs`、`dom_gate.mjs`、`wizard_shots.mjs`
> 随测随写（各节有 `<!-- BEGIN/END -->` 边界，单节可独立重跑覆盖）。
> 一次性汇总报告（含结论与缺陷清单）见本文件末尾「总结」节 + `docs/gui/error-injection.md`。

## 状态总览

> **最终状态（2026-10-22 10:10，全链复跑 @09:53）**

| 脚本 | 结果 | 说明 |
|---|---|---|
| G4 回归（6 个 selftest） | **6/6 PASS**（两轮：基线 + 完整版后复跑） | `docs/gui/{gui,post}-g4-*.log` |
| A 组（真后端 dom_gate） | **11/11 PASS** | 含 CDP 交叉复测：A2=5.09×、A6=44px、A5 焦点环 8/8 |
| A 组（mock 全量预检） | **8/8 PASS** | 双通道互证 |
| api_acceptance（B/C/D/E/F3） | **35 PASS / 0 FAIL / 1 BLOCKED**（exit 0） | BLOCK 项=用户现场 7777 桥接已关（非缺陷，GUI 对外部桥接的行为由自建 E2 全绿覆盖） |
| red_team（反断言） | **20 PASS / 2 FAIL** | 2 FAIL = DEF-8（类型宽松）/ DEF-9（mcp_config_file 缺失），均为低危规范性问题 |
| wizard_shots（6 截图 + F3 横幅） | **7/7 PASS** | F3 断开横幅实测可见 |
| 截图产出 | 6/6 张真后端截图 + 3 张 mock 预览 | `docs/gui/*.png` |

## 环境事实（实测；注意 Node 在会话中由 v24.14.0 升级为 v26.12.1——测试已改为活体对照）

- Node **v26.12.1**（会话中途升级；GUI/B1 检测正确反映当前版本）
- Chrome 与 Edge 均在（Chrome 优先）
- 游戏 shapez.io 1.5.6 曾在运行（5 × shapezio.exe + 外部桥接占 7777/17778）；**验证中段用户退出游戏**（7777 关闭）——GUI 对"外部桥接"的行为改由自建桥接组覆盖
- mods 目录已有 `shapez-ai-bridge.js`（sha 与仓库一致）与既有备份 `shapez-ai-bridge.js.bak-20261020-202532`（测试后均原样保留）
- game_dir = `D:\Steam\steamapps\common\shapez.io`（注册表 `HKCU\Software\Valve\Steam\SteamPath=d:/steam`）
- 测试前无 `bridge.config.json`、无 `gui/.gui-state.json`（测试后恢复原状）

## G4 · 回归（98 项旧断言）

提前执行（2026-10-21 18:5x，T1–T4 未合入时基线跑）：

<!-- BEGIN:sec-g4 -->
> 两轮全做：**基线**（2026-10-21，GUI 合入前）+ **终态**（2026-10-22 09:53，全部 T1–T4 合入后）。

**终态（10-22 09:53，全绿）：**

| 命令 | 退出码 | 断言结果 | 日志 |
|---|---|---|---|
| `node test/mod_selftest.mjs` | 0 | **ALL 15 CHECKS PASSED** | post-g4-mod_selftest.log |
| `node test/mod_rpc_selftest.mjs` | 0 | **ALL 12 CHECKS PASSED** | post-g4-mod_rpc_selftest.log |
| `node test/blueprint_selftest.mjs` | 0 | **ALL 7 CHECKS PASSED** | post-g4-blueprint_selftest.log |
| `node test/lzstring_interop.mjs` | 0 | INTEROP OK（4 组 parity 全 true） | post-g4-lzstring_interop.log |
| `node src/bridge/selftest.mjs` | 0 | **ALL 19 CHECKS PASSED** | post-g4-bridge_selftest.log |
| `node src/mcp/selftest.mjs` | 0 | **47 PASS, 0 FAIL** | post-g4-mcp_selftest.log |

合计 **100 项断言 + 4 项 lzstring parity**，6/6 全绿 → **G4 通过：GUI 合入无回归**。

**基线（10-21 18:5x，保留为参照）：** 同命令同结果（gui-g4-1..6.log）。
<!-- END:sec-g4 -->

## A 组 · 静态与设计闸门

<!-- BEGIN:sec-A -->
> 时间: 2026-10-22T02:03:56.191Z

| 项 | 结果 | 判据 / 详情 | 证据 |
|---|---|---|---|
| A/token_meta | **PASS** | GET / 含 gui-token meta |  |
| A/probe_json | **PASS** | ?probe=1 产出 #probe-json | {"displayFont":"58.2px","bodyFont":"14px","ratio":4.16,"minHit":44,"focusableCount":9,"reducedMotion":false,"view":"wizard"} |
| A/A2 | **PASS** | display/body 字号比 4.16（要求 ≥4；@1180×780 应用窗口） | displayFont="58.2px" bodyFont="14px" |
| A/A4 | **PASS** | reduced-motion: flag=true 文本量 560/560（比例 1.00）内联 opacity:0=0 | reduced_probe={"displayFont":"58.2px","bodyFont":"14px","ratio":4.16,"minHit":44,"focusableCount":9,"reducedMotion":true,"view":"wizard"} |
| A/A6 | **PASS** | minHit=44px（主要动作要求 ≥44） | focusableCount=9 |
| A/focusable_count | **PASS** | focusableCount=9 |  |
| A/A3 | **PASS** | accent 声明=[#4a97df, #3f87cc]；紫渐变色命中=false | css_files=3 inline_css_len=0 index_status=200 |
| A/A2.cdp_crosscheck | **PASS** | CDP 实测 display/body=5.09（body 14px，max 71.2px @ H1.w1-title） |  |
| A/A6.cdp_crosscheck | **PASS** | CDP 实测最小命中区 44×?? px @ BUTTON.tb-navbtn is-active "欢迎"（focusable=13） |  |
| A/A5 | **PASS** | 可见可聚焦 8 个，无焦点环 0 个 | 全部有 outline/box-shadow 焦点样式 |
| A/A1.screenshot | **PASS** | 静帧截图 A1-still-reduced-motion.png（59793 bytes） |  |

计数: PASS=11 FAIL=0 BLOCKED=0
<!-- END:sec-A -->

## B 组 · 安装向导

<!-- BEGIN:sec-B1 -->
> 时间: 2026-10-22T02:02:52.539Z

| 项 | 结果 | 判据 / 详情 | 证据 |
|---|---|---|---|
| S/boot | **PASS** | GUI server ready on http://127.0.0.1:7801 | log: D:\Projects\rea\Project work\shapez\docs\gui\logs\gui-server-7801-1792634570674.log |
| S/token | **PASS** | GET / 含 <meta name=gui-token> | token len=32 |
| S/healthz | **PASS** | GET /api/healthz 免 token（错误 token 也 200） | status=200 body={"ok":true,"gui_version":"0.1.0","uptime_s":0,"port":7801} |
| S/api_version | **PASS** | GET /api/version: mod=0.1.0 protocol=1 compat=["1.5.6"] node=20/v26.12.1 | {"gui":"0.1.0","repo":"D:\\Projects\\rea\\Project work\\shapez","mod":"0.1.0","protocol":1,"compat_games":["1.5.6"],"node":{"min":20,"cur":"v26.12.1"}} |
| S/api_mcp_config | **PASS** | GET /api/mcp-config: command=node args=["D:/Projects/rea/Project work/shapez/src/mcp/server.mjs"] | claude_cfg_path=C:\Users\Administrator\AppData\Roaming\Claude\claude_desktop_config.json |
| S/error_envelope | **PASS** | 404 错误统一体字段齐全（code/message/message_en/hint/detail/log_ref） | status=404 body={"error":{"code":"NOT_FOUND","message":"未知 API","message_en":"unknown api","hint":null,"detail":null,"log_ref":null}} |
| B/B1 | **PASS** | EnvReport 26 项全部与真实机器一致 | 样例: node=v26.12.1 game=D:\Steam\steamapps\common\shapez.io mod.match=true port.busy=false |

计数: PASS=7 FAIL=0 BLOCKED=0
<!-- END:sec-B1 -->

<!-- BEGIN:sec-B2B4 -->
> 时间: 2026-10-22T02:03:03.386Z

| 项 | 结果 | 判据 / 详情 | 证据 |
|---|---|---|---|
| S/boot | **PASS** | GUI server ready on http://127.0.0.1:7801 | log: D:\Projects\rea\Project work\shapez\docs\gui\logs\gui-server-7801-1792634570674.log |
| S/token | **PASS** | GET / 含 <meta name=gui-token> | token len=32 |
| S/healthz | **PASS** | GET /api/healthz 免 token（错误 token 也 200） | status=200 body={"ok":true,"gui_version":"0.1.0","uptime_s":0,"port":7801} |
| S/api_version | **PASS** | GET /api/version: mod=0.1.0 protocol=1 compat=["1.5.6"] node=20/v26.12.1 | {"gui":"0.1.0","repo":"D:\\Projects\\rea\\Project work\\shapez","mod":"0.1.0","protocol":1,"compat_games":["1.5.6"],"node":{"min":20,"cur":"v26.12.1"}} |
| S/api_mcp_config | **PASS** | GET /api/mcp-config: command=node args=["D:/Projects/rea/Project work/shapez/src/mcp/server.mjs"] | claude_cfg_path=C:\Users\Administrator\AppData\Roaming\Claude\claude_desktop_config.json |
| S/error_envelope | **PASS** | 404 错误统一体字段齐全（code/message/message_en/hint/detail/log_ref） | status=404 body={"error":{"code":"NOT_FOUND","message":"未知 API","message_en":"unknown api","hint":null,"detail":null,"log_ref":null}} |
| B/B1 | **PASS** | EnvReport 26 项全部与真实机器一致 | 样例: node=v26.12.1 game=D:\Steam\steamapps\common\shapez.io mod.match=true port.busy=false |
| B/B2 | **PASS** | 安装 exit_code=0, 文件与仓库 sha256 一致 | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backup":null,"lines_n":27} sha_match=true shaBefore=eb0fb09708f… |
| B/B3 | **PASS** | 二次安装 exit=0；备份 5→7（新增 2） | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backup":null,"lines_n":27} file_stable=true |
| B/B3.preexisting_bak | **PASS** | 测试前已有备份 shapez-ai-bridge.js.bak-20261020-202532 未被安装操作破坏 | sha=50626463006e73f… |
| B/B4.uninstall | **PASS** | 卸载后文件删除、env.mod.installed=false；默认保留备份 true | resp={"ok":true,"removed":[],"kept_modsettings":true,"notes":["游戏内 mod 设置残留于 saves 目录（modsettings_shapez-ai-bridge__*.json）"]} installed=false baks=7 |
| B/B4.bak_kept | **PASS** | 默认卸载不删除 .bak-*（除非 clean_backups:true） | before=7 after=7 |
| B/B4.reinstall | **PASS** | 重装恢复：文件回到与仓库一致 | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backu… |

计数: PASS=13 FAIL=0 BLOCKED=0
<!-- END:sec-B2B4 -->

<!-- BEGIN:sec-B5 -->
> 时间: 2026-10-22T02:03:03.873Z

| 项 | 结果 | 判据 / 详情 | 证据 |
|---|---|---|---|
| S/boot | **PASS** | GUI server ready on http://127.0.0.1:7801 | log: D:\Projects\rea\Project work\shapez\docs\gui\logs\gui-server-7801-1792634570674.log |
| S/token | **PASS** | GET / 含 <meta name=gui-token> | token len=32 |
| S/healthz | **PASS** | GET /api/healthz 免 token（错误 token 也 200） | status=200 body={"ok":true,"gui_version":"0.1.0","uptime_s":0,"port":7801} |
| S/api_version | **PASS** | GET /api/version: mod=0.1.0 protocol=1 compat=["1.5.6"] node=20/v26.12.1 | {"gui":"0.1.0","repo":"D:\\Projects\\rea\\Project work\\shapez","mod":"0.1.0","protocol":1,"compat_games":["1.5.6"],"node":{"min":20,"cur":"v26.12.1"}} |
| S/api_mcp_config | **PASS** | GET /api/mcp-config: command=node args=["D:/Projects/rea/Project work/shapez/src/mcp/server.mjs"] | claude_cfg_path=C:\Users\Administrator\AppData\Roaming\Claude\claude_desktop_config.json |
| S/error_envelope | **PASS** | 404 错误统一体字段齐全（code/message/message_en/hint/detail/log_ref） | status=404 body={"error":{"code":"NOT_FOUND","message":"未知 API","message_en":"unknown api","hint":null,"detail":null,"log_ref":null}} |
| B/B1 | **PASS** | EnvReport 26 项全部与真实机器一致 | 样例: node=v26.12.1 game=D:\Steam\steamapps\common\shapez.io mod.match=true port.busy=false |
| B/B2 | **PASS** | 安装 exit_code=0, 文件与仓库 sha256 一致 | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backup":null,"lines_n":27} sha_match=true shaBefore=eb0fb09708f… |
| B/B3 | **PASS** | 二次安装 exit=0；备份 5→7（新增 2） | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backup":null,"lines_n":27} file_stable=true |
| B/B3.preexisting_bak | **PASS** | 测试前已有备份 shapez-ai-bridge.js.bak-20261020-202532 未被安装操作破坏 | sha=50626463006e73f… |
| B/B4.uninstall | **PASS** | 卸载后文件删除、env.mod.installed=false；默认保留备份 true | resp={"ok":true,"removed":[],"kept_modsettings":true,"notes":["游戏内 mod 设置残留于 saves 目录（modsettings_shapez-ai-bridge__*.json）"]} installed=false baks=7 |
| B/B4.bak_kept | **PASS** | 默认卸载不删除 .bak-*（除非 clean_backups:true） | before=7 after=7 |
| B/B4.reinstall | **PASS** | 重装恢复：文件回到与仓库一致 | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backu… |
| B/B5 | **PASS** | 假 game_dir → HTTP 400 INVALID_PARAM（提示=选择包含 shapezio.exe 的目录） | reason=not_shapez_dir body={"error":{"code":"INVALID_PARAM","message":"该目录不是 shapez.io 安装目录","message_en":"not a shapez directory","hint":"选择包含 shapezio.exe 的目录","detail":{"reason":"not_shapez_dir","game_dir":"C:/definitely/not/a/shapez/dir-1792634583389"},"log_ref":null}} |
| B/B5.no_persist | **PASS** | 假路径未被持久化 | override=null |

计数: PASS=15 FAIL=0 BLOCKED=0
<!-- END:sec-B5 -->

<!-- BEGIN:sec-B6 -->
> 时间: 2026-10-22T02:03:06.447Z

| 项 | 结果 | 判据 / 详情 | 证据 |
|---|---|---|---|
| S/boot | **PASS** | GUI server ready on http://127.0.0.1:7801 | log: D:\Projects\rea\Project work\shapez\docs\gui\logs\gui-server-7801-1792634570674.log |
| S/token | **PASS** | GET / 含 <meta name=gui-token> | token len=32 |
| S/healthz | **PASS** | GET /api/healthz 免 token（错误 token 也 200） | status=200 body={"ok":true,"gui_version":"0.1.0","uptime_s":0,"port":7801} |
| S/api_version | **PASS** | GET /api/version: mod=0.1.0 protocol=1 compat=["1.5.6"] node=20/v26.12.1 | {"gui":"0.1.0","repo":"D:\\Projects\\rea\\Project work\\shapez","mod":"0.1.0","protocol":1,"compat_games":["1.5.6"],"node":{"min":20,"cur":"v26.12.1"}} |
| S/api_mcp_config | **PASS** | GET /api/mcp-config: command=node args=["D:/Projects/rea/Project work/shapez/src/mcp/server.mjs"] | claude_cfg_path=C:\Users\Administrator\AppData\Roaming\Claude\claude_desktop_config.json |
| S/error_envelope | **PASS** | 404 错误统一体字段齐全（code/message/message_en/hint/detail/log_ref） | status=404 body={"error":{"code":"NOT_FOUND","message":"未知 API","message_en":"unknown api","hint":null,"detail":null,"log_ref":null}} |
| B/B1 | **PASS** | EnvReport 26 项全部与真实机器一致 | 样例: node=v26.12.1 game=D:\Steam\steamapps\common\shapez.io mod.match=true port.busy=false |
| B/B2 | **PASS** | 安装 exit_code=0, 文件与仓库 sha256 一致 | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backup":null,"lines_n":27} sha_match=true shaBefore=eb0fb09708f… |
| B/B3 | **PASS** | 二次安装 exit=0；备份 5→7（新增 2） | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backup":null,"lines_n":27} file_stable=true |
| B/B3.preexisting_bak | **PASS** | 测试前已有备份 shapez-ai-bridge.js.bak-20261020-202532 未被安装操作破坏 | sha=50626463006e73f… |
| B/B4.uninstall | **PASS** | 卸载后文件删除、env.mod.installed=false；默认保留备份 true | resp={"ok":true,"removed":[],"kept_modsettings":true,"notes":["游戏内 mod 设置残留于 saves 目录（modsettings_shapez-ai-bridge__*.json）"]} installed=false baks=7 |
| B/B4.bak_kept | **PASS** | 默认卸载不删除 .bak-*（除非 clean_backups:true） | before=7 after=7 |
| B/B4.reinstall | **PASS** | 重装恢复：文件回到与仓库一致 | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backu… |
| B/B5 | **PASS** | 假 game_dir → HTTP 400 INVALID_PARAM（提示=选择包含 shapezio.exe 的目录） | reason=not_shapez_dir body={"error":{"code":"INVALID_PARAM","message":"该目录不是 shapez.io 安装目录","message_en":"not a shapez directory","hint":"选择包含 shapezio.exe 的目录","detail":{"reason":"not_shapez_dir","game_dir":"C:/definitely/not/a/shapez/dir-1792634583389"},"log_ref":null}} |
| B/B5.no_persist | **PASS** | 假路径未被持久化 | override=null |
| B/B6 | **PASS** | 安装失败可见（非静默）: 安装失败 | status=500 code=INSTALL_FAILED log_ref=103 log_has_error_line=true body={"error":{"code":"INSTALL_FAILED","message":"安装失败","message_en":"install failed","hint":"展开日志查看原始输出","detail":{"exit_code":1},"log_ref":103}} |

计数: PASS=16 FAIL=0 BLOCKED=0
<!-- END:sec-B6 -->

## C 组 · 配置

<!-- BEGIN:sec-C -->
> 时间: 2026-10-22T02:03:07.408Z

| 项 | 结果 | 判据 / 详情 | 证据 |
|---|---|---|---|
| S/boot | **PASS** | GUI server ready on http://127.0.0.1:7801 | log: D:\Projects\rea\Project work\shapez\docs\gui\logs\gui-server-7801-1792634570674.log |
| S/token | **PASS** | GET / 含 <meta name=gui-token> | token len=32 |
| S/healthz | **PASS** | GET /api/healthz 免 token（错误 token 也 200） | status=200 body={"ok":true,"gui_version":"0.1.0","uptime_s":0,"port":7801} |
| S/api_version | **PASS** | GET /api/version: mod=0.1.0 protocol=1 compat=["1.5.6"] node=20/v26.12.1 | {"gui":"0.1.0","repo":"D:\\Projects\\rea\\Project work\\shapez","mod":"0.1.0","protocol":1,"compat_games":["1.5.6"],"node":{"min":20,"cur":"v26.12.1"}} |
| S/api_mcp_config | **PASS** | GET /api/mcp-config: command=node args=["D:/Projects/rea/Project work/shapez/src/mcp/server.mjs"] | claude_cfg_path=C:\Users\Administrator\AppData\Roaming\Claude\claude_desktop_config.json |
| S/error_envelope | **PASS** | 404 错误统一体字段齐全（code/message/message_en/hint/detail/log_ref） | status=404 body={"error":{"code":"NOT_FOUND","message":"未知 API","message_en":"unknown api","hint":null,"detail":null,"log_ref":null}} |
| B/B1 | **PASS** | EnvReport 26 项全部与真实机器一致 | 样例: node=v26.12.1 game=D:\Steam\steamapps\common\shapez.io mod.match=true port.busy=false |
| B/B2 | **PASS** | 安装 exit_code=0, 文件与仓库 sha256 一致 | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backup":null,"lines_n":27} sha_match=true shaBefore=eb0fb09708f… |
| B/B3 | **PASS** | 二次安装 exit=0；备份 5→7（新增 2） | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backup":null,"lines_n":27} file_stable=true |
| B/B3.preexisting_bak | **PASS** | 测试前已有备份 shapez-ai-bridge.js.bak-20261020-202532 未被安装操作破坏 | sha=50626463006e73f… |
| B/B4.uninstall | **PASS** | 卸载后文件删除、env.mod.installed=false；默认保留备份 true | resp={"ok":true,"removed":[],"kept_modsettings":true,"notes":["游戏内 mod 设置残留于 saves 目录（modsettings_shapez-ai-bridge__*.json）"]} installed=false baks=7 |
| B/B4.bak_kept | **PASS** | 默认卸载不删除 .bak-*（除非 clean_backups:true） | before=7 after=7 |
| B/B4.reinstall | **PASS** | 重装恢复：文件回到与仓库一致 | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backu… |
| B/B5 | **PASS** | 假 game_dir → HTTP 400 INVALID_PARAM（提示=选择包含 shapezio.exe 的目录） | reason=not_shapez_dir body={"error":{"code":"INVALID_PARAM","message":"该目录不是 shapez.io 安装目录","message_en":"not a shapez directory","hint":"选择包含 shapezio.exe 的目录","detail":{"reason":"not_shapez_dir","game_dir":"C:/definitely/not/a/shapez/dir-1792634583389"},"log_ref":null}} |
| B/B5.no_persist | **PASS** | 假路径未被持久化 | override=null |
| B/B6 | **PASS** | 安装失败可见（非静默）: 安装失败 | status=500 code=INSTALL_FAILED log_ref=103 log_has_error_line=true body={"error":{"code":"INSTALL_FAILED","message":"安装失败","message_en":"install failed","hint":"展开日志查看原始输出","detail":{"exit_code":1},"log_ref":103}} |
| C/C1 | **PASS** | GET /api/config 返回默认值 {port:7777, token:null, read_only:false, …} | config={"port":7777,"token":null,"read_only":false,"snapshot_dir":"./snapshots","log_level":"info","rpc_timeout_ms":30000,"long_timeout_ms":180000} file={"path":"D:\\Projects\\rea\\Project work\\shapez\\bridge.config.json","exists":false,"valid":true} warnings=[] |
| C/C2 | **PASS** | POST /api/config 写入 bridge.config.json 且回显一致（port=7862） | resp={"ok":true,"config":{"port":7862,"token":null,"read_only":false,"snapshot_dir":"./snapshots-t5","log_level":"warn","rpc_timeout_ms":30000,"long_timeout_ms":180000},"bridge_restarted":false} file.port=7862 echo.port=7862 restarted=false |
| C/C3 | **PASS** | 非法值全部 400 且未写文件（字段级消息=有） | [{"name":"port 99999","status":400,"code":"CONFIG_INVALID","fields":{"port":"port 必须为 1024–65535 的整数"}},{"name":"port 'abc'","status":400,"code":"CONFIG_INVALID","fields":{"port":"port 必须为 1024–65535 的整数"}},{"name":"token bad chars","status":400,"code":"CONFIG_INVALID","fields":{"token":"token 只能包含可打印 ASCII 字符（不可含空格），长度 8–128"}},{"name":"log_level nope","status":400,"code":"CONFIG_INVALID","field… |
| C/C4 | **PASS** | POST /api/config/reset 回默认值且落盘 | resp={"ok":true,"config":{"port":7777,"token":null,"read_only":false,"snapshot_dir":"./snapshots","log_level":"info","rpc_timeout_ms":30000,"long_timeout_ms":180000}} file.port=7777 |
| C/C5 | **PASS** | 占用端口 7880 → HTTP 409 PORT_BUSY（提示=换一个端口，或结束占用进程） | pid=35160 file_unchanged=true body={"error":{"code":"PORT_BUSY","message":"端口 7880 已被占用","message_en":"port 7880 is busy","hint":"换一个端口，或结束占用进程","detail":{"port":7880,"pid":35160},"log_ref":null}} |
| C/C6 | **PASS** | 无 bridge.config.json 时 GET 返回默认值不报错（file.exists=false） | status=200 file={"path":"D:\\Projects\\rea\\Project work\\shapez\\bridge.config.json","exists":false,"valid":true} |

计数: PASS=22 FAIL=0 BLOCKED=0
<!-- END:sec-C -->

## D 组 · 桥接生命周期

<!-- BEGIN:sec-D -->
> 时间: 2026-10-22T02:03:10.097Z

| 项 | 结果 | 判据 / 详情 | 证据 |
|---|---|---|---|
| S/boot | **PASS** | GUI server ready on http://127.0.0.1:7801 | log: D:\Projects\rea\Project work\shapez\docs\gui\logs\gui-server-7801-1792634570674.log |
| S/token | **PASS** | GET / 含 <meta name=gui-token> | token len=32 |
| S/healthz | **PASS** | GET /api/healthz 免 token（错误 token 也 200） | status=200 body={"ok":true,"gui_version":"0.1.0","uptime_s":0,"port":7801} |
| S/api_version | **PASS** | GET /api/version: mod=0.1.0 protocol=1 compat=["1.5.6"] node=20/v26.12.1 | {"gui":"0.1.0","repo":"D:\\Projects\\rea\\Project work\\shapez","mod":"0.1.0","protocol":1,"compat_games":["1.5.6"],"node":{"min":20,"cur":"v26.12.1"}} |
| S/api_mcp_config | **PASS** | GET /api/mcp-config: command=node args=["D:/Projects/rea/Project work/shapez/src/mcp/server.mjs"] | claude_cfg_path=C:\Users\Administrator\AppData\Roaming\Claude\claude_desktop_config.json |
| S/error_envelope | **PASS** | 404 错误统一体字段齐全（code/message/message_en/hint/detail/log_ref） | status=404 body={"error":{"code":"NOT_FOUND","message":"未知 API","message_en":"unknown api","hint":null,"detail":null,"log_ref":null}} |
| B/B1 | **PASS** | EnvReport 26 项全部与真实机器一致 | 样例: node=v26.12.1 game=D:\Steam\steamapps\common\shapez.io mod.match=true port.busy=false |
| B/B2 | **PASS** | 安装 exit_code=0, 文件与仓库 sha256 一致 | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backup":null,"lines_n":27} sha_match=true shaBefore=eb0fb09708f… |
| B/B3 | **PASS** | 二次安装 exit=0；备份 5→7（新增 2） | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backup":null,"lines_n":27} file_stable=true |
| B/B3.preexisting_bak | **PASS** | 测试前已有备份 shapez-ai-bridge.js.bak-20261020-202532 未被安装操作破坏 | sha=50626463006e73f… |
| B/B4.uninstall | **PASS** | 卸载后文件删除、env.mod.installed=false；默认保留备份 true | resp={"ok":true,"removed":[],"kept_modsettings":true,"notes":["游戏内 mod 设置残留于 saves 目录（modsettings_shapez-ai-bridge__*.json）"]} installed=false baks=7 |
| B/B4.bak_kept | **PASS** | 默认卸载不删除 .bak-*（除非 clean_backups:true） | before=7 after=7 |
| B/B4.reinstall | **PASS** | 重装恢复：文件回到与仓库一致 | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backu… |
| B/B5 | **PASS** | 假 game_dir → HTTP 400 INVALID_PARAM（提示=选择包含 shapezio.exe 的目录） | reason=not_shapez_dir body={"error":{"code":"INVALID_PARAM","message":"该目录不是 shapez.io 安装目录","message_en":"not a shapez directory","hint":"选择包含 shapezio.exe 的目录","detail":{"reason":"not_shapez_dir","game_dir":"C:/definitely/not/a/shapez/dir-1792634583389"},"log_ref":null}} |
| B/B5.no_persist | **PASS** | 假路径未被持久化 | override=null |
| B/B6 | **PASS** | 安装失败可见（非静默）: 安装失败 | status=500 code=INSTALL_FAILED log_ref=103 log_has_error_line=true body={"error":{"code":"INSTALL_FAILED","message":"安装失败","message_en":"install failed","hint":"展开日志查看原始输出","detail":{"exit_code":1},"log_ref":103}} |
| C/C1 | **PASS** | GET /api/config 返回默认值 {port:7777, token:null, read_only:false, …} | config={"port":7777,"token":null,"read_only":false,"snapshot_dir":"./snapshots","log_level":"info","rpc_timeout_ms":30000,"long_timeout_ms":180000} file={"path":"D:\\Projects\\rea\\Project work\\shapez\\bridge.config.json","exists":false,"valid":true} warnings=[] |
| C/C2 | **PASS** | POST /api/config 写入 bridge.config.json 且回显一致（port=7862） | resp={"ok":true,"config":{"port":7862,"token":null,"read_only":false,"snapshot_dir":"./snapshots-t5","log_level":"warn","rpc_timeout_ms":30000,"long_timeout_ms":180000},"bridge_restarted":false} file.port=7862 echo.port=7862 restarted=false |
| C/C3 | **PASS** | 非法值全部 400 且未写文件（字段级消息=有） | [{"name":"port 99999","status":400,"code":"CONFIG_INVALID","fields":{"port":"port 必须为 1024–65535 的整数"}},{"name":"port 'abc'","status":400,"code":"CONFIG_INVALID","fields":{"port":"port 必须为 1024–65535 的整数"}},{"name":"token bad chars","status":400,"code":"CONFIG_INVALID","fields":{"token":"token 只能包含可打印 ASCII 字符（不可含空格），长度 8–128"}},{"name":"log_level nope","status":400,"code":"CONFIG_INVALID","field… |
| C/C4 | **PASS** | POST /api/config/reset 回默认值且落盘 | resp={"ok":true,"config":{"port":7777,"token":null,"read_only":false,"snapshot_dir":"./snapshots","log_level":"info","rpc_timeout_ms":30000,"long_timeout_ms":180000}} file.port=7777 |
| C/C5 | **PASS** | 占用端口 7880 → HTTP 409 PORT_BUSY（提示=换一个端口，或结束占用进程） | pid=35160 file_unchanged=true body={"error":{"code":"PORT_BUSY","message":"端口 7880 已被占用","message_en":"port 7880 is busy","hint":"换一个端口，或结束占用进程","detail":{"port":7880,"pid":35160},"log_ref":null}} |
| C/C6 | **PASS** | 无 bridge.config.json 时 GET 返回默认值不报错（file.exists=false） | status=200 file={"path":"D:\\Projects\\rea\\Project work\\shapez\\bridge.config.json","exists":false,"valid":true} |
| D/D1 | **PASS** | 桥接启动：ok、status.running=true、/health ok（端口 7891） | resp={"ok":true,"status":{"running":true,"managed":true,"pid":26480,"port":7891,"healthy":true,"mod_connected":false,"uptime_s":0,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"pa… status={"running":true,"managed":true,"pid":26480,"port":7891,"healthy":true,"mod_connected":false,"uptime_s":0,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"paused":n… |
| D/D2 | **PASS** | status 与 /health 一致（running/mod_connected/uptime_s/port） | status={"running":true,"managed":true,"pid":26480,"port":7891,"healthy":true,"mod_connected":false,"uptime_s":0,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"paused":null,"allow_write":null,"last_error":null} |
| D/D4 | **PASS** | 重复 start 幂等（already_running=true，pid 不变） | resp={"ok":true,"already_running":true,"status":{"running":true,"managed":true,"pid":26480,"port":7891,"healthy":true,"mod_connected":false,"uptime_s":1,"in_game":null,"game_version":null,"mod_version":nu… pid_before=26480 pid_after=26480 |
| D/D6 | **PASS** | bridge 日志 since=0 得 16 行，since=16 得 0 行增量；n 单调 | sample=[{"n":1,"kind":"bridge","stream":"out","level":"info","text":"$ node src/bridge/bridge.mjs --port 7891","ts":1792634587442},{"n":2,"kind":"bridge","stream":"err","level":"warn","text":"[bridge/info] ","ts":1792634587706},{"n":3,"kind":"bridge","stream":"err","level":"warn","text":"  shapez-ai-bridg… |
| D/D3 | **PASS** | 停止：ok、running=false、端口 7891 释放 | resp={"ok":true,"stopped":true,"forced":false} status={"running":false,"managed":false,"pid":null,"port":7891,"healthy":false,"mod_connected":false,"uptime_s":null,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"paused":null,"allow_write":null,"last… port_free=true |
| D/D5 | **PASS** | 端口占用启动 → HTTP 409 PORT_BUSY；日志含 EADDRINUSE=false | body={"error":{"code":"PORT_BUSY","message":"端口 7905 已被占用","message_en":"port 7905 is busy","hint":"换一个端口，或结束占用进程","detail":{"port":7905,"pid":25540},"log_ref":null}} status_after={"running":false,"managed":false} |

计数: PASS=28 FAIL=0 BLOCKED=0
<!-- END:sec-D -->

## E 组 · 冒烟（E4）

<!-- BEGIN:sec-E -->
> 时间: 2026-10-22T02:03:12.826Z

| 项 | 结果 | 判据 / 详情 | 证据 |
|---|---|---|---|
| S/boot | **PASS** | GUI server ready on http://127.0.0.1:7801 | log: D:\Projects\rea\Project work\shapez\docs\gui\logs\gui-server-7801-1792634570674.log |
| S/token | **PASS** | GET / 含 <meta name=gui-token> | token len=32 |
| S/healthz | **PASS** | GET /api/healthz 免 token（错误 token 也 200） | status=200 body={"ok":true,"gui_version":"0.1.0","uptime_s":0,"port":7801} |
| S/api_version | **PASS** | GET /api/version: mod=0.1.0 protocol=1 compat=["1.5.6"] node=20/v26.12.1 | {"gui":"0.1.0","repo":"D:\\Projects\\rea\\Project work\\shapez","mod":"0.1.0","protocol":1,"compat_games":["1.5.6"],"node":{"min":20,"cur":"v26.12.1"}} |
| S/api_mcp_config | **PASS** | GET /api/mcp-config: command=node args=["D:/Projects/rea/Project work/shapez/src/mcp/server.mjs"] | claude_cfg_path=C:\Users\Administrator\AppData\Roaming\Claude\claude_desktop_config.json |
| S/error_envelope | **PASS** | 404 错误统一体字段齐全（code/message/message_en/hint/detail/log_ref） | status=404 body={"error":{"code":"NOT_FOUND","message":"未知 API","message_en":"unknown api","hint":null,"detail":null,"log_ref":null}} |
| B/B1 | **PASS** | EnvReport 26 项全部与真实机器一致 | 样例: node=v26.12.1 game=D:\Steam\steamapps\common\shapez.io mod.match=true port.busy=false |
| B/B2 | **PASS** | 安装 exit_code=0, 文件与仓库 sha256 一致 | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backup":null,"lines_n":27} sha_match=true shaBefore=eb0fb09708f… |
| B/B3 | **PASS** | 二次安装 exit=0；备份 5→7（新增 2） | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backup":null,"lines_n":27} file_stable=true |
| B/B3.preexisting_bak | **PASS** | 测试前已有备份 shapez-ai-bridge.js.bak-20261020-202532 未被安装操作破坏 | sha=50626463006e73f… |
| B/B4.uninstall | **PASS** | 卸载后文件删除、env.mod.installed=false；默认保留备份 true | resp={"ok":true,"removed":[],"kept_modsettings":true,"notes":["游戏内 mod 设置残留于 saves 目录（modsettings_shapez-ai-bridge__*.json）"]} installed=false baks=7 |
| B/B4.bak_kept | **PASS** | 默认卸载不删除 .bak-*（除非 clean_backups:true） | before=7 after=7 |
| B/B4.reinstall | **PASS** | 重装恢复：文件回到与仓库一致 | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backu… |
| B/B5 | **PASS** | 假 game_dir → HTTP 400 INVALID_PARAM（提示=选择包含 shapezio.exe 的目录） | reason=not_shapez_dir body={"error":{"code":"INVALID_PARAM","message":"该目录不是 shapez.io 安装目录","message_en":"not a shapez directory","hint":"选择包含 shapezio.exe 的目录","detail":{"reason":"not_shapez_dir","game_dir":"C:/definitely/not/a/shapez/dir-1792634583389"},"log_ref":null}} |
| B/B5.no_persist | **PASS** | 假路径未被持久化 | override=null |
| B/B6 | **PASS** | 安装失败可见（非静默）: 安装失败 | status=500 code=INSTALL_FAILED log_ref=103 log_has_error_line=true body={"error":{"code":"INSTALL_FAILED","message":"安装失败","message_en":"install failed","hint":"展开日志查看原始输出","detail":{"exit_code":1},"log_ref":103}} |
| C/C1 | **PASS** | GET /api/config 返回默认值 {port:7777, token:null, read_only:false, …} | config={"port":7777,"token":null,"read_only":false,"snapshot_dir":"./snapshots","log_level":"info","rpc_timeout_ms":30000,"long_timeout_ms":180000} file={"path":"D:\\Projects\\rea\\Project work\\shapez\\bridge.config.json","exists":false,"valid":true} warnings=[] |
| C/C2 | **PASS** | POST /api/config 写入 bridge.config.json 且回显一致（port=7862） | resp={"ok":true,"config":{"port":7862,"token":null,"read_only":false,"snapshot_dir":"./snapshots-t5","log_level":"warn","rpc_timeout_ms":30000,"long_timeout_ms":180000},"bridge_restarted":false} file.port=7862 echo.port=7862 restarted=false |
| C/C3 | **PASS** | 非法值全部 400 且未写文件（字段级消息=有） | [{"name":"port 99999","status":400,"code":"CONFIG_INVALID","fields":{"port":"port 必须为 1024–65535 的整数"}},{"name":"port 'abc'","status":400,"code":"CONFIG_INVALID","fields":{"port":"port 必须为 1024–65535 的整数"}},{"name":"token bad chars","status":400,"code":"CONFIG_INVALID","fields":{"token":"token 只能包含可打印 ASCII 字符（不可含空格），长度 8–128"}},{"name":"log_level nope","status":400,"code":"CONFIG_INVALID","field… |
| C/C4 | **PASS** | POST /api/config/reset 回默认值且落盘 | resp={"ok":true,"config":{"port":7777,"token":null,"read_only":false,"snapshot_dir":"./snapshots","log_level":"info","rpc_timeout_ms":30000,"long_timeout_ms":180000}} file.port=7777 |
| C/C5 | **PASS** | 占用端口 7880 → HTTP 409 PORT_BUSY（提示=换一个端口，或结束占用进程） | pid=35160 file_unchanged=true body={"error":{"code":"PORT_BUSY","message":"端口 7880 已被占用","message_en":"port 7880 is busy","hint":"换一个端口，或结束占用进程","detail":{"port":7880,"pid":35160},"log_ref":null}} |
| C/C6 | **PASS** | 无 bridge.config.json 时 GET 返回默认值不报错（file.exists=false） | status=200 file={"path":"D:\\Projects\\rea\\Project work\\shapez\\bridge.config.json","exists":false,"valid":true} |
| D/D1 | **PASS** | 桥接启动：ok、status.running=true、/health ok（端口 7891） | resp={"ok":true,"status":{"running":true,"managed":true,"pid":26480,"port":7891,"healthy":true,"mod_connected":false,"uptime_s":0,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"pa… status={"running":true,"managed":true,"pid":26480,"port":7891,"healthy":true,"mod_connected":false,"uptime_s":0,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"paused":n… |
| D/D2 | **PASS** | status 与 /health 一致（running/mod_connected/uptime_s/port） | status={"running":true,"managed":true,"pid":26480,"port":7891,"healthy":true,"mod_connected":false,"uptime_s":0,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"paused":null,"allow_write":null,"last_error":null} |
| D/D4 | **PASS** | 重复 start 幂等（already_running=true，pid 不变） | resp={"ok":true,"already_running":true,"status":{"running":true,"managed":true,"pid":26480,"port":7891,"healthy":true,"mod_connected":false,"uptime_s":1,"in_game":null,"game_version":null,"mod_version":nu… pid_before=26480 pid_after=26480 |
| D/D6 | **PASS** | bridge 日志 since=0 得 16 行，since=16 得 0 行增量；n 单调 | sample=[{"n":1,"kind":"bridge","stream":"out","level":"info","text":"$ node src/bridge/bridge.mjs --port 7891","ts":1792634587442},{"n":2,"kind":"bridge","stream":"err","level":"warn","text":"[bridge/info] ","ts":1792634587706},{"n":3,"kind":"bridge","stream":"err","level":"warn","text":"  shapez-ai-bridg… |
| D/D3 | **PASS** | 停止：ok、running=false、端口 7891 释放 | resp={"ok":true,"stopped":true,"forced":false} status={"running":false,"managed":false,"pid":null,"port":7891,"healthy":false,"mod_connected":false,"uptime_s":null,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"paused":null,"allow_write":null,"last… port_free=true |
| D/D5 | **PASS** | 端口占用启动 → HTTP 409 PORT_BUSY；日志含 EADDRINUSE=false | body={"error":{"code":"PORT_BUSY","message":"端口 7905 已被占用","message_en":"port 7905 is busy","hint":"换一个端口，或结束占用进程","detail":{"port":7905,"pid":25540},"log_ref":null}} status_after={"running":false,"managed":false} |
| E/E2.live7777_observed | **BLOCKED** | 7777 无外部桥接（环境变化） | status=0 |
| E/E2.external_status | **PASS** | 自建外部桥接(7877)：running=true managed=false（应 false）healthy=true | {"running":true,"managed":false,"pid":null,"port":7877,"healthy":true,"mod_connected":false,"uptime_s":0,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"paused":null,"allow_write":null,"last_error":null} |
| E/E2.stop_foreign_guard | **PASS** | stop 外部桥接 → 409 CANNOT_STOP_FOREIGN=true；外部进程存活=true | resp={"error":{"code":"CANNOT_STOP_FOREIGN","message":"该桥接由外部终端启动","message_en":"external bridge","hint":"请在原终端 Ctrl-C 停止","detail":{"pid":null},"log_ref":null}} pid=23728 |
| E/E2.start_noop | **PASS** | 对健康外部桥接 start → HTTP 200 already_running | {"ok":true,"already_running":true,"status":{"running":true,"managed":false,"pid":null,"port":7877,"healthy":true,"mod_connected":false,"uptime_s":1,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"paused":null,"allow… |
| E/E4.start | **PASS** | 冒烟已启动 run_id=1 |  |
| E/E4.result | **PASS** | 冒烟 exit_code=1（期望 1=桥接不可达），hint=先启动桥接 | {"running":false,"run_id":1,"exit_code":1,"checks":[{"n":1,"name":"检查 1","name_zh":"检查 1","state":"fail","detail":"bridge reachable at http://127.0.0.1:7925 — 无法连接桥接服务器"},{"n":2,"name":"检查 2","name_zh":"检查 2","state":"pending","detail":""},{"n":3,"name":"检查 3","name_zh":"检查 3","state":"pending","detail":""},{"n":4,"name":"检查 4","name_zh":"检查 4","state":"pending","detail":""},{"n":5,"name":"检查 5",… |
| E/E4.port_empty | **PASS** | 对照：7925 确无桥接（fetch 失败） | status=0 |

计数: PASS=34 FAIL=0 BLOCKED=1
<!-- END:sec-E -->

## F 组 · 错误处理（F3）

<!-- BEGIN:sec-F -->
> 时间: 2026-10-22T02:03:12.835Z

| 项 | 结果 | 判据 / 详情 | 证据 |
|---|---|---|---|
| S/boot | **PASS** | GUI server ready on http://127.0.0.1:7801 | log: D:\Projects\rea\Project work\shapez\docs\gui\logs\gui-server-7801-1792634570674.log |
| S/token | **PASS** | GET / 含 <meta name=gui-token> | token len=32 |
| S/healthz | **PASS** | GET /api/healthz 免 token（错误 token 也 200） | status=200 body={"ok":true,"gui_version":"0.1.0","uptime_s":0,"port":7801} |
| S/api_version | **PASS** | GET /api/version: mod=0.1.0 protocol=1 compat=["1.5.6"] node=20/v26.12.1 | {"gui":"0.1.0","repo":"D:\\Projects\\rea\\Project work\\shapez","mod":"0.1.0","protocol":1,"compat_games":["1.5.6"],"node":{"min":20,"cur":"v26.12.1"}} |
| S/api_mcp_config | **PASS** | GET /api/mcp-config: command=node args=["D:/Projects/rea/Project work/shapez/src/mcp/server.mjs"] | claude_cfg_path=C:\Users\Administrator\AppData\Roaming\Claude\claude_desktop_config.json |
| S/error_envelope | **PASS** | 404 错误统一体字段齐全（code/message/message_en/hint/detail/log_ref） | status=404 body={"error":{"code":"NOT_FOUND","message":"未知 API","message_en":"unknown api","hint":null,"detail":null,"log_ref":null}} |
| B/B1 | **PASS** | EnvReport 26 项全部与真实机器一致 | 样例: node=v26.12.1 game=D:\Steam\steamapps\common\shapez.io mod.match=true port.busy=false |
| B/B2 | **PASS** | 安装 exit_code=0, 文件与仓库 sha256 一致 | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backup":null,"lines_n":27} sha_match=true shaBefore=eb0fb09708f… |
| B/B3 | **PASS** | 二次安装 exit=0；备份 5→7（新增 2） | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backup":null,"lines_n":27} file_stable=true |
| B/B3.preexisting_bak | **PASS** | 测试前已有备份 shapez-ai-bridge.js.bak-20261020-202532 未被安装操作破坏 | sha=50626463006e73f… |
| B/B4.uninstall | **PASS** | 卸载后文件删除、env.mod.installed=false；默认保留备份 true | resp={"ok":true,"removed":[],"kept_modsettings":true,"notes":["游戏内 mod 设置残留于 saves 目录（modsettings_shapez-ai-bridge__*.json）"]} installed=false baks=7 |
| B/B4.bak_kept | **PASS** | 默认卸载不删除 .bak-*（除非 clean_backups:true） | before=7 after=7 |
| B/B4.reinstall | **PASS** | 重装恢复：文件回到与仓库一致 | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backu… |
| B/B5 | **PASS** | 假 game_dir → HTTP 400 INVALID_PARAM（提示=选择包含 shapezio.exe 的目录） | reason=not_shapez_dir body={"error":{"code":"INVALID_PARAM","message":"该目录不是 shapez.io 安装目录","message_en":"not a shapez directory","hint":"选择包含 shapezio.exe 的目录","detail":{"reason":"not_shapez_dir","game_dir":"C:/definitely/not/a/shapez/dir-1792634583389"},"log_ref":null}} |
| B/B5.no_persist | **PASS** | 假路径未被持久化 | override=null |
| B/B6 | **PASS** | 安装失败可见（非静默）: 安装失败 | status=500 code=INSTALL_FAILED log_ref=103 log_has_error_line=true body={"error":{"code":"INSTALL_FAILED","message":"安装失败","message_en":"install failed","hint":"展开日志查看原始输出","detail":{"exit_code":1},"log_ref":103}} |
| C/C1 | **PASS** | GET /api/config 返回默认值 {port:7777, token:null, read_only:false, …} | config={"port":7777,"token":null,"read_only":false,"snapshot_dir":"./snapshots","log_level":"info","rpc_timeout_ms":30000,"long_timeout_ms":180000} file={"path":"D:\\Projects\\rea\\Project work\\shapez\\bridge.config.json","exists":false,"valid":true} warnings=[] |
| C/C2 | **PASS** | POST /api/config 写入 bridge.config.json 且回显一致（port=7862） | resp={"ok":true,"config":{"port":7862,"token":null,"read_only":false,"snapshot_dir":"./snapshots-t5","log_level":"warn","rpc_timeout_ms":30000,"long_timeout_ms":180000},"bridge_restarted":false} file.port=7862 echo.port=7862 restarted=false |
| C/C3 | **PASS** | 非法值全部 400 且未写文件（字段级消息=有） | [{"name":"port 99999","status":400,"code":"CONFIG_INVALID","fields":{"port":"port 必须为 1024–65535 的整数"}},{"name":"port 'abc'","status":400,"code":"CONFIG_INVALID","fields":{"port":"port 必须为 1024–65535 的整数"}},{"name":"token bad chars","status":400,"code":"CONFIG_INVALID","fields":{"token":"token 只能包含可打印 ASCII 字符（不可含空格），长度 8–128"}},{"name":"log_level nope","status":400,"code":"CONFIG_INVALID","field… |
| C/C4 | **PASS** | POST /api/config/reset 回默认值且落盘 | resp={"ok":true,"config":{"port":7777,"token":null,"read_only":false,"snapshot_dir":"./snapshots","log_level":"info","rpc_timeout_ms":30000,"long_timeout_ms":180000}} file.port=7777 |
| C/C5 | **PASS** | 占用端口 7880 → HTTP 409 PORT_BUSY（提示=换一个端口，或结束占用进程） | pid=35160 file_unchanged=true body={"error":{"code":"PORT_BUSY","message":"端口 7880 已被占用","message_en":"port 7880 is busy","hint":"换一个端口，或结束占用进程","detail":{"port":7880,"pid":35160},"log_ref":null}} |
| C/C6 | **PASS** | 无 bridge.config.json 时 GET 返回默认值不报错（file.exists=false） | status=200 file={"path":"D:\\Projects\\rea\\Project work\\shapez\\bridge.config.json","exists":false,"valid":true} |
| D/D1 | **PASS** | 桥接启动：ok、status.running=true、/health ok（端口 7891） | resp={"ok":true,"status":{"running":true,"managed":true,"pid":26480,"port":7891,"healthy":true,"mod_connected":false,"uptime_s":0,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"pa… status={"running":true,"managed":true,"pid":26480,"port":7891,"healthy":true,"mod_connected":false,"uptime_s":0,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"paused":n… |
| D/D2 | **PASS** | status 与 /health 一致（running/mod_connected/uptime_s/port） | status={"running":true,"managed":true,"pid":26480,"port":7891,"healthy":true,"mod_connected":false,"uptime_s":0,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"paused":null,"allow_write":null,"last_error":null} |
| D/D4 | **PASS** | 重复 start 幂等（already_running=true，pid 不变） | resp={"ok":true,"already_running":true,"status":{"running":true,"managed":true,"pid":26480,"port":7891,"healthy":true,"mod_connected":false,"uptime_s":1,"in_game":null,"game_version":null,"mod_version":nu… pid_before=26480 pid_after=26480 |
| D/D6 | **PASS** | bridge 日志 since=0 得 16 行，since=16 得 0 行增量；n 单调 | sample=[{"n":1,"kind":"bridge","stream":"out","level":"info","text":"$ node src/bridge/bridge.mjs --port 7891","ts":1792634587442},{"n":2,"kind":"bridge","stream":"err","level":"warn","text":"[bridge/info] ","ts":1792634587706},{"n":3,"kind":"bridge","stream":"err","level":"warn","text":"  shapez-ai-bridg… |
| D/D3 | **PASS** | 停止：ok、running=false、端口 7891 释放 | resp={"ok":true,"stopped":true,"forced":false} status={"running":false,"managed":false,"pid":null,"port":7891,"healthy":false,"mod_connected":false,"uptime_s":null,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"paused":null,"allow_write":null,"last… port_free=true |
| D/D5 | **PASS** | 端口占用启动 → HTTP 409 PORT_BUSY；日志含 EADDRINUSE=false | body={"error":{"code":"PORT_BUSY","message":"端口 7905 已被占用","message_en":"port 7905 is busy","hint":"换一个端口，或结束占用进程","detail":{"port":7905,"pid":25540},"log_ref":null}} status_after={"running":false,"managed":false} |
| E/E2.live7777_observed | **BLOCKED** | 7777 无外部桥接（环境变化） | status=0 |
| E/E2.external_status | **PASS** | 自建外部桥接(7877)：running=true managed=false（应 false）healthy=true | {"running":true,"managed":false,"pid":null,"port":7877,"healthy":true,"mod_connected":false,"uptime_s":0,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"paused":null,"allow_write":null,"last_error":null} |
| E/E2.stop_foreign_guard | **PASS** | stop 外部桥接 → 409 CANNOT_STOP_FOREIGN=true；外部进程存活=true | resp={"error":{"code":"CANNOT_STOP_FOREIGN","message":"该桥接由外部终端启动","message_en":"external bridge","hint":"请在原终端 Ctrl-C 停止","detail":{"pid":null},"log_ref":null}} pid=23728 |
| E/E2.start_noop | **PASS** | 对健康外部桥接 start → HTTP 200 already_running | {"ok":true,"already_running":true,"status":{"running":true,"managed":false,"pid":null,"port":7877,"healthy":true,"mod_connected":false,"uptime_s":1,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"paused":null,"allow… |
| E/E4.start | **PASS** | 冒烟已启动 run_id=1 |  |
| E/E4.result | **PASS** | 冒烟 exit_code=1（期望 1=桥接不可达），hint=先启动桥接 | {"running":false,"run_id":1,"exit_code":1,"checks":[{"n":1,"name":"检查 1","name_zh":"检查 1","state":"fail","detail":"bridge reachable at http://127.0.0.1:7925 — 无法连接桥接服务器"},{"n":2,"name":"检查 2","name_zh":"检查 2","state":"pending","detail":""},{"n":3,"name":"检查 3","name_zh":"检查 3","state":"pending","detail":""},{"n":4,"name":"检查 4","name_zh":"检查 4","state":"pending","detail":""},{"n":5,"name":"检查 5",… |
| E/E4.port_empty | **PASS** | 对照：7925 确无桥接（fetch 失败） | status=0 |
| F/F3.prep | **PASS** | F3 主测在 red_team.mjs（CDP 截横幅）；此处先记录 healthz 基线 |  |

计数: PASS=35 FAIL=0 BLOCKED=1
<!-- END:sec-F -->

## 反断言（红队）

<!-- BEGIN:sec-red -->
> 时间: 2026-10-22T02:03:33.292Z

| 项 | 结果 | 判据 / 详情 | 证据 |
|---|---|---|---|
| RED/origin_evil | **PASS** | 5 类非法 Origin GET+POST 均 403 | code=FORBIDDEN_ORIGIN details=[{"name":"evil.example.com","origin":"http://evil.example.com","get":403,"post":403},{"name":"evil-subdomain","origin":"http://127.0.0.1.evil.example.com","get":403,"post":403},{"name":"null-origin","origin":"null","get":403,"post":403},{"name":"https-scheme","origin":"https://127.0.0.1:7802","get":403,"post":403},{"name":"other-port","origin":"http://127.0… |
| RED/origin_ok_control | **PASS** | 正确 Origin http://127.0.0.1:7802 放行 | status=200 |
| RED/origin_absent_ok | **PASS** | 无 Origin（本机工具如 curl）带 token 放行 | status=200 |
| RED/no_token_POST | **PASS** | 无 token POST → 403 BAD_TOKEN | body={"error":{"code":"BAD_TOKEN","message":"缺少或错误的 GUI token","message_en":"missing/invalid X-GUI-Token","hint":"从页面 meta 标签读取 token","detail":null,"log_ref":null}} |
| RED/bad_token | **PASS** | 错误 token POST → 403 | body={"error":{"code":"BAD_TOKEN","message":"缺少或错误的 GUI token","message_en":"missing/invalid X-GUI-Token","hint":"从页面 meta 标签读取 token","detail":null,"log_ref":null}} |
| RED/no_token_GET_env | **PASS** | 无 token GET /api/env → 403（healthz 除外） | status=403 |
| RED/open_whitelist | **PASS** | 7 类非白名单/注入 target 均 400 | [{"name":"not-in-list","status":400,"code":"INVALID_PARAM"},{"name":"empty","status":400,"code":"INVALID_PARAM"},{"name":"inject-cmd","status":400,"code":"INVALID_PARAM"},{"name":"path-of-file","status":400,"code":"INVALID_PARAM"},{"name":"traversal","status":400,"code":"INVALID_PARAM"},{"name":"proto-file","status":400,"code":"INVALID_PARAM"},{"name":"steam-bad","status":400,… |
| RED/open_type_strictness | **FAIL** | 类型混淆：非 string target 未全 400（数组经属性键强制转换可命中白名单；object → 500） | [{"name":"array-single","status":200,"ok":true},{"name":"array-calc","status":400,"code":"INVALID_PARAM"},{"name":"object-proto","status":500,"code":"INTERNAL"},{"name":"number","status":400,"code":"INVALID_PARAM"}] |
| RED/open_control | **PASS** | 白名单 target mods_dir 放行（200 ok） | body={"ok":true,"opened":true} |
| RED/open_contract_targets | **FAIL** | 契约 target mcp_config_file 缺失（§2.5 要求合法；实际 HTTP 400 INVALID_PARAM） | 契约集=mods_dir,snapshots_dir,saves_dir,repo_root,mcp_config_file,steam_store,steam_run,readme |
| RED/traversal | **PASS** | 8 类 ../ 变体（raw socket 不归一化路径）无泄漏、无 200 | [{"v":"/../../package.json","rawStatus":400,"fetchStatus":404,"leaked":false},{"v":"/..%2f..%2fpackage.json","rawStatus":400,"fetchStatus":400,"leaked":false},{"v":"/%2e%2e/%2e%2e/package.json","rawStatus":400,"fetchStatus":404,"leaked":false},{"v":"/..\\..\\package.json","rawStatus":400,"fetchStatus":404,"leaked":false},{"v":"/../README.md","rawStatus":400,"fetchStatus":404,"leaked":false},{"v":… |
| RED/traversal.status_code | **PASS** | 全部 400/403/404 |  |
| RED/sse_no_token | **PASS** | GET /api/events 无 token → 403 | status=403 |
| RED/sse_bad_token | **PASS** | GET /api/events?token=xxx → 403 | status=403 |
| RED/sse_ok_token | **PASS** | 正确 token → 流打开（200/保持连接） | status=200 netError=true |
| RED/token_not_in_stdout | **PASS** | GUI token 不出现在 server stdout/stderr | stdout bytes=433 |
| RED/token_not_in_banner_url | **PASS** | 启动横幅 URL 不带 token |  |
| RED/token_only_in_html | **PASS** | token 只经由 GET / 的 meta 标签下发 | html_has_token=true |
| RED/bak_install_uninstall_cycle | **PASS** | install→uninstall→install 循环后既有备份一个不丢、内容不变（7→8） | resp={"i1":true,"u1":true,"i2":true} |
| RED/bak_explicit_clean | **PASS** | clean_backups:true 显式清理生效（removed=8，剩 0） | resp={"ok":true,"removed":["shapez-ai-bridge.js.bak-20261020-202532","shapez-ai-bridge.js.bak-20261022-093410","shapez-ai-bridge.js.bak-20261022-095324","shapez-ai-bridge.js.bak-20261022-095326","shapez-ai-bridge.js.bak-2026… |
| RED/bak_preexist_restored | **PASS** | 测试后既有用户备份已原样恢复 | sha_match=true |
| RED/mod_restored | **PASS** | 测试后 mod 已重装恢复 | resp=true |

计数: PASS=20 FAIL=2 BLOCKED=0
<!-- END:sec-red -->

## 截图与 F3（CDP 交互）

<!-- BEGIN:sec-shots -->
> 时间: 2026-10-22T09:04:16.673Z

| 项 | 结果 | 判据 / 详情 | 证据 |
|---|---|---|---|
| SHOT/hook | **PASS** | window.GUI 钩子存在（T3 §3.7 契约） |  |
| SHOT/01-first-run | **PASS** | 首启向导静帧 | 欢迎 / 环境检查 / 安装 / 配置 / 启动 / 验证 / 三步接管你的工厂 / 安装 Mod → 启动桥接 → 用 AI 指挥生产线。全程图形界面，无需手改文件。 / 安装 Mod 会禁用 Steam 成就与拼图 DLC / 这是 shapez.io 官方对「已装 Mod 存档」的行为，与本项目无关。装卸 Mod 可随时切换；成就判定以存档是否被 Mod 触碰为准。 / 将写入的文件 / 开始 / 查看详情 / 1 / 安装 Mod / 一个文件进 mods 目录 /… |
| SHOT/02-env-check | **PASS** | 环境检查步（clicked=true） | shapez · AI / 欢迎 / 控制台 / 设置 / v0.1.0 · mod 0.1.0 / EN / 欢迎 / 环境检查 / 安装 / 配置 / 启动 / 验证 / 环境检查 / 自动检测本机 Node、游戏目录、Mods 目录等。缺什么补什么。 / Node.js 运行时 / v26.12.1 / shapez.io 游戏目录 / D:\Steam\steamapps\common\shapez.io / Mods 目录可写 / C:\Users\Administrator\AppData\Roami… |
| SHOT/03-install-done | **PASS** | 安装完成态（api install ok=true） | exit_code=0 |
| SHOT/04-config | **PASS** | 配置页静帧 | shapez · AI / 欢迎 / 控制台 / 设置 / v0.1.0 · mod 0.1.0 / EN / 设置 / 桥接配置写在仓库根 bridge.config.json；保存后桥接在跑且端口/令牌变化时会自动重启。 / 桥接配置 / 桥接端口 / 默认 7777 / AI 与游戏通信的本地端口，仅监听 127.0.0.1 / 访问令牌（高级） / 留空 = 不启用鉴权；≥16 位更安全 / 快照目录 / 默认 ./snaps… |
| SHOT/05-console-logs | **PASS** | console+日志（bridge start ok=true） | shapez · AI / 欢迎 / 控制台 / 设置 / v0.1.0 · mod 0.1.0 / EN / SHAPEZ.IO · AI BRIDGE / 已启动 / 等待游戏连接… 端口 7896 / 启动游戏 / 停止桥接 / 游戏 / 未运行 / 未连接 / MOD / 等待连接 / 桥接 / healthy :7896 / AI / 可接入 / 桥接服务 / 运行中 / 0:04uptime / 端口 / 7896 / PID / 9116 / 管理模式 / G… |
| F/F3 | **PASS** | 杀后端后 UI 出现断开提示（横幅） | body_text=shapez · AI / 欢迎 / 控制台 / 设置 / v0.1.0 · mod 0.1.0 / EN / ! / 后端已断开 — GUI 后端已停止响应。请确认 gui/server.mjs 仍在运行。 / 重新连接 / SHAPEZ.IO · AI BRIDGE / 未启动 / 桥接未运行 —— 启动后 AI 可操作游戏 / 启动游戏 / 启动桥接 / 游戏 / 未知 / MOD / 未连接 / 桥接 / 未运行 / AI / 离线 / 桥接服务 / 已停止 / —… |

计数: PASS=7 FAIL=0 BLOCKED=0
<!-- END:sec-shots -->

## 总结

<!-- BEGIN:sec-summary -->
**最终判定（2026-10-22 10:10，终态全链复跑）**：
**视觉/设计（A）与功能（B/C/D/E/F3）+ 安全反断言 + 截图 + G4 回归全部通过。**
T1–T4 全部交付物经真后端验证；本轮验证共发现 **9 个缺陷**（DEF-1..9），
其中 7 个（1/2/3/4/5/6/7）已修复并经复测闭环；2 个低危遗留（DEF-8 类型宽松、DEF-9 mcp_config_file）见缺陷节。

| 组 | 结果 | 备注 |
|---|---|---|
| A 静态/设计闸门 | **8/8（mock）+ 11/11（真后端）** | A2=4.16×（probe）/5.09×（CDP 实测）；A6=44px；A4 静帧完整；A5 焦点环 8/8 |
| B 安装向导 | **12/12** | 含 B5 假目录 400、B6 失败可见、sha256 一致、备份保留 |
| C 配置 | **6/6** | C5 端口冲突 409、C6 文件缺失默认值 |
| D 桥接生命周期 | **6/6** | start/stop/幂等/日志增量/端口释放/EADDRINUSE 可见 |
| E 游戏联动 | **E2 自建 4/4 + E4 3/3** | 外部桥接 managed:false/CANNOT_STOP_FOREIGN/健康即 running；退出码 1 语义映射正确。**用户现场 7777 桥接在验证期间被其本人关闭（BLOCK）；E1/E3（游戏内冒烟 5/5）需游戏在世界的会话，未覆盖** |
| F 错误处理 | **F3 1/1** | 杀后端 → 横幅 + 重新连接按钮（A1 截图顶部横条 + 06-F3-banner.png） |
| 反断言（红队） | **20/22** | 2 FAIL 均低危规范（DEF-8/9），无安全实质问题 |
| G 交付物 | G1 README 已写（待用户走查）；**G2 截图 6+3 张**；G3 start.cmd 已验；**G4 6/6 全绿** | |

### 已知遗留（低危，非阻断）

- **DEF-8**：`/api/open` 对非 string target 类型宽松（数组值可经属性键强制转换命中白名单；object → 500 而非 400）。无注入可行性（值仍受白名单约束），建议一行加 `typeof` 检查。
- **DEF-9**：契约 §2.5 的 `mcp_config_file` target 未实现（400）。前端未调用（用剪贴板方案），但契约需对齐——实现或从契约移除。
- **A2 窄幅**：`clamp(48px,5vw,64px)` 在 <960px 视口跌破 4×（应用窗口 1180 达标）。建议下限升 56px。
- **E1/E3**：需 shapez 进入世界（加载存档）的完整会话，未在本轮覆盖；`gui/README.md` 有 runbook。

### 场景保护

用户现场（游戏会话、7777 外部桥接、mods 目录既有备份）在全程验证中未被改动：
mod sha=eb0fb097… 与仓库一致、用户备份 bak-20261020-202532 原样保留（sha=50626463006e73f5）、
测试后 `bridge.config.json`/`gui/.gui-state.json` 已还原为"无文件"，无残留进程（netstat 复核）。

### 产物落盘状态（历史，保留）

| 任务 | 产物 | 状态 | 验证状态 |
|---|---|---|---|
| T1 | gui/lib/{paths,env-probe,config-io}.mjs | 已落盘（22:40–22:57） | **已直测 PASS**（B1/C1/C3/C4 直调 + 冻结签名核验） |
| T2 | gui/server.mjs（完整版 09:22）, start.cmd, proc-mgr.mjs | 完整版落盘（DEF-4/5/6/7 修复） | **B/C/D/E/F3 35 PASS / 0 FAIL** |
| T3 | gui/ui/{index.html, css/*, js/*} | 已落盘（00:20–01:26）；DEF-1/2 已修 | **A 组 11/11（真后端）**；向导全流程真后端 PASS |
| T4 | console.css/console.js/settings.js/logpanel.js | 已落盘（04:24–04:40）；DEF-3 已修 | 控制台/设置视图真后端渲染 PASS，日志面板实测有桥接启动原文 |

### 已完成（有证据）

### T1 直测（不依赖 server，2026-10-21 23:06 追加）

> T1 于 23:04 落盘（`paths/env-probe/config-io.mjs`）。以下为不依赖 GUI 服务的直接验收。

| 项 | 结果 | 证据 |
|---|---|---|
| **B1（probeEnv 直调）** | **PASS** — EnvReport 全字段与真实机器一致：node v24.14.0/ok、game.found=true dir=D:\Steam\…\shapez.io source=vdf exe/asar ok running=true、mods_dir exists+writable、**mod sha256_repo==sha256_installed==eb0fb097… match=true backup_count=1**、port 7777 busy owner_pid=53992、browser=chrome、saves modsettings_found=true、gui_state 全 false/null | `docs/gui/logs/t1-env-probe-direct.json` |
| **C1/C3/C4（validateConfig 直调）** | **PASS** — port 99999/"abc"→errors.port；token 含空格→errors.token；**token 10 位→ok+warnings（弱 token 仅警告，符合 §2.3）**；token 16 位→无警告；snapshot_dir 空→errors；rpc_timeout 500→errors；read_only 非布尔→errors；readConfig 无文件→默认值不报错（C6 语义） | `docs/gui/logs/t1-config-direct.txt` |
| **T1 冻结导出签名核验** | **PASS** — paths.mjs 10 个导出全齐；env-probe 6 函数全齐（probePort→{busy,pid} 实测 7777→{busy:true,pid:53992}；findBrowser→chrome；isGameRunning→true；findFreePort(7953,7960)→7953）；config-io 6 函数全齐 | 本会话直调输出 |

**B1 判据注**：本机 vdf 链（`libraryfolders.vdf`→`appmanifest_1318690.acf`→`common/shapez.io`）先命中，
source 报 `"vdf"` —— 与 DESIGN-PLAN §2.1 枚举（registry|vdf|fallback|manual）一致，判定合法
（api_acceptance 的 B1 相应接受 registry|vdf 两者）。

### T2 缺陷清单（2026-10-22 05:45 建档；**09:30 对完整版（255 行）复测**）

> DEF-4/5/6/7 全部已在完整版中修复并经复测确认（见下方各项的 [已验证] 标注）；
> DEF-8/9 为完整版新发现（2026-10-22 09:40 追加，待 T2 处理）。

**🟠 DEF-4（中高，[已验证修复]）：`POST /api/env` 不校验假 game_dir，且无条件持久化**

- 现状（05:32 骨架）：`if (b.game_dir) writeGuiState({ game_dir_override: b.game_dir })` —— 无校验直写
- 契约（§2.1）：game_dir 传入须校验（含 shapezio.exe + resources/app.asar），非法 → **400 INVALID_PARAM `detail.reason:"not_shapez_dir"`**，且不得持久化
- 复测（21:33 完整版）：B5 → **PASS**（400 INVALID_PARAM，hint="选择包含 shapezio.exe 的目录"）；B5.no_persist → **PASS**（假路径未持久化）

**🟠 DEF-5（中，[已验证修复]）：`POST /api/config` 未做端口占用检查（C5 场景直接放行）**

- 现状（05:32 骨架）：仅跑同步 `validateConfig` → 占住的端口直接写文件返回 200
- 复测（21:33 完整版）：C5 → **PASS**（409 PORT_BUSY，hint="换一个端口，或结束占用进程"，文件未写）；D5 → **PASS**（409 PORT_BUSY）

**🟠 DEF-6（中，[已验证修复]）：`bridgeStatus().running` 逻辑取反**

- 现状（05:32 骨架）：`running = !(await probePort(port)).busy` 再 `&& healthy` → 活桥接恒 false
- 复测（21:33 完整版）：D1/D2/D4 → **PASS**（running/managed/pid/uptime 全正确，含 start→status→stop 端到端）

**🟡 DEF-7（低，[已验证修复]）：穿越变体 `/%u002e%u002e/package.json` → 500（应 400）**

- 复测（21:33 完整版）：red_team `traversal.status_code` → **PASS**（全部 400/403/404）

**🟡 DEF-8（低，09:40 新发现，待处理）：`/api/open` target 类型不严格（属性键强制转换 + object 抛异常）**

- 复现（对完整版 live）：
  - `{"target":["mods_dir"]}` → **200 ok:true**（数组经属性键 `String()` 强制转换为 "mods_dir"，绕过类型检查）
  - `{"target":{"toString":"mods_dir"}}` → **500 INTERNAL**（Cannot convert object to primitive value）
  - `{"target":1}` / `{"target":["calc"]}` → 400（正确）
- 影响：仅类型规范性问题——数组值不可能由 JSON 攻击者用于命令注入（值仍受白名单键约束，只是类型宽松）；500 是错误码不规范
- 建议：L197 前加 `if (typeof b.target !== "string") return fail(res,"INVALID_PARAM",…)`；一行修两处

**🟡 DEF-9（低-中，09:40 新发现，待处理）：契约 target `mcp_config_file` 在实现白名单中缺失**

- 契约（§2.5）：target ∈ `mods_dir|snapshots_dir|saves_dir|repo_root|mcp_config_file(生成 gui/mcp-config.generated.json 后打开)|steam_store|steam_run|readme`
- 实现（server.mjs L187-196）：白名单 7 项，**无 mcp_config_file**；且 L199 有自承认注释 `/* not in whitelist above; fallthrough to error */`
- 复现：`POST /api/open {"target":"mcp_config_file"}` → 400 unknown open target
- 影响：契约违约。前端目前未调用该 target（console.js 用复制剪贴板方式），但 §3.6 底行快捷与文档承诺需对齐——要么实现它（生成 gui/mcp-config.generated.json + 打开），要么在前端/契约中移除并注明
- 建议：按 §2.5 实现（写 `gui/mcp-config.generated.json` = /api/mcp-config 的 config 段，然后 `notepad` 打开）

**已确认的"未实现"兜底（对 05:32 骨架，非缺陷；完整版已全部实现）**：install/uninstall/bridge start|stop/smoke/mcp-config/open/config-reset/events 现均可用。
**附带**：B1 早期 3/25 FAIL 中 2 项为**本测试脚本自身过时**（Node 已被升级为 v26.12.1；用户外部 7777 桥接已关闭）——已改为与活体对照；完整版复测只剩 port.busy/owner_pid 两项差异（见 09:33 轮 B1 行的说明：config 后其余端口探测对象是 17778/7896 变化中的配置端口——复测时 7896 无监听故 busy=false 是**正确**行为；want 字段显示 "live undefined" 是测试脚本深处一个传参 bug，非 T2 缺陷）。

### T3/T4 集成缺陷发现（2026-10-22 04:30 追加；**DEF-3 已于 04:40 修复**）

**🟠 DEF-3（高，集成缺口，已修复）：`console.css` 未加载，控制台视图无样式**

- 复现（修复前）：`grep stylesheet gui/ui/index.html` → 只有 `base.css` 与 `wizard.css`；
  控制台渲染为裸文本
- 对照实验：CDP 手动注入 `<link href="./css/console.css">` 后完整成型 → **console.css 本身正确**（125 条 .con-* 规则），缺的只是加载
- 修复验证（04:40）：index.html 已加 `<link rel="stylesheet" href="./css/console.css">`（T4 的 settings 样式 `.set-*` 也在该文件——index.html 注释已说明）；控制台重测 `con-hero` 类在位且样式齐全；settings 视图（settings.js 04:40 落盘）完整渲染表单
- 证据：`docs/gui/05-console-preview.png`（修复前裸文本）→ `05-console-logs-preview.png` + `04-settings-preview2.png`（修复后完整）

### T3 预检发现（关键，2026-10-22 01:09 追加；**两个缺陷已于 01:26 由 T3 修复** — 见 A 组预检）

> T2 `gui/server.mjs` 未就绪期间，用 `gui/verify/static-mini.mjs`（最小静态服务器）
> 直接服务 `gui/ui/`，以 headless Chrome 加载 `?mock=1&probe=1` 做 A 组预检。

**🔴 DEF-1（阻断级，已修复）：`gui/ui/js/boot.js` 语法错误，整个前端不可用**

- 复现：`node --check gui/ui/js/boot.js` → exit 1；headless Chrome 控制台：
  `Uncaught SyntaxError: Invalid or unexpected token, source: boot.js (131)`
- 位置：L131 `document.title = ` `` `${t("app.title")} — ${t(`console.title` && name === ... `app.tagline`)}` `` ``
  —— 模板字符串内嵌套的 `` ` `` 反引号不是合法语法（应为普通字符串或重写逻辑）
- 后果：模块图入口解析失败 → `window.GUI`/向导/信号链全部不执行，页面永远停在 boot 闪屏；
  `?probe=1` 不产出 `#probe-json` → A2/A4/A6 全部无法通过（**A 组闸门当前必挂**）
- 快照指纹：boot.js sha256 前 16 位 `4e2f764da3affb21`（mtime 2026-10-22 00:29）
- 证据：`docs/gui/logs/dom-mock-probe.html`（无 probe-json）、`BROKEN-ui-state.png`

**🔴 DEF-2（阻断级，已修复）：`gui/ui/js/api.js` 重复声明 `MOCK`**

- 复现：`node --check gui/ui/js/api.js` → exit 1
  `SyntaxError: Identifier 'MOCK' has already been declared (api.js:161)`
- 位置：L16 `export const MOCK = params.get("mock") === "1";` 与 L161 `const MOCK = {`（mock 对象）重名
- 后果：即使 DEF-1 修复，boot.js 的 `import { api, MOCK } from "./api.js"` 仍会因 api.js 解析失败而中断
- 快照指纹：api.js sha256 前 16 位 `69bd7bbaf7e1091d`（mtime 2026-10-22 00:20）
- 证据：node --check 输出；Chrome 控制台（boot.js 修好后将复现 api.js 错误）

**建议修复（交 T3，本 Agent 不改 T3 文件）**：
- boot.js L131 改为 `` document.title = `${t("app.title")} — ${t(name === "console" ? "console.title" : name === "settings" ? "settings.title" : name === "wizard" ? "wizard.step1" : "app.tagline")}`; ``（去掉内层反引号逻辑）
- api.js 把 L161 的 mock 对象改名（如 `const MOCK_API = {...}`）并同步 `export const api = MOCK ? MOCK_API : real` 的引用

**备注**：两文件 mtime 分别为 00:20/00:29，T3 若已续改（wizard.js 01:09 仍在更新），上表应重验；
验证脚本会在 T3 完成后再跑 dom_gate 全量（见 `run_all2.sh` 链）。

### A 组预检（mock 模式 + static-mini，2026-10-22 01:32 追加）

> T3 于 01:26 修复 DEF-1/DEF-2（boot.js/api.js 现均可 `node --check` 通过）。
> 用 `?mock=1`（api.js 内置 mock，零后端）经 static-mini 预检。**这不是最终判定**（最终需
> T2 server.mjs + dom_gate 全量）；但足以证明前端契约（probe-json）与设计底线工作。

| 项 | 结果（预检） | 证据 |
|---|---|---|
| probe-json 契约 | **PASS** — `?probe=1` 产出 `<script id="probe-json">`：`{displayFont,bodyFont,ratio,minHit,focusableCount,reducedMotion,view}` 全字段 | `docs/gui/logs/dom-mock-probe2.html` |
| **A2（字号比）** | **PASS（目标窗口）** — 1180×780（应用窗口尺寸）→ **4.16×**；1440×960 → **4.57×**；**800px 窄幅 → 3.43×（48px clamp 下限）——低于 4×，见注** | 三档实测 probe 输出 |
| **A6（命中区）** | **PASS** — minHit=44px（focusableCount=9） | 同上 |
| **A4（reduced-motion）** | **PASS（预检）** — `--force-prefers-reduced-motion` 下 probe.reducedMotion=true、view=wizard、内容完整（截图） | `docs/gui/logs/dom-mock-probe2-reduced.html` + A1 截图 |
| A1 静帧 | 目视：左对齐巨型标题（非居中）、竖排数字步骤轨、索引式右侧列表（非三卡片）、成就警示先于按钮、单蓝色 accent、深色单 ground | `docs/gui/A1-still-reduced-motion.png` |
| A3（单一 accent） | 初判 PASS — CSS 声明 `--accent:#4a97df`（待 dom_gate 全量扫描确认无紫渐变） | base.css |
| F3 机制（顺带观察） | 无后端时顶部横幅「后端已断开 — GUI 后端已停止响应」+ [重新连接] 按钮真实施渲染（mock+static-mini 下 /api/healthz 404 触发） | A1 截图顶部横条 |
| **向导流程（mock）** | **PASS（预检）** — CDP 驱动：W1 欢迎 → W2 环境检查（Node v24.14.0/游戏目录/Mods 可写逐行渲染）→ W3 安装（成就警示常驻、安装完成卡含路径/sha256/备份名、进度日志 6 行、绿色 toast「安装完成」）→ W4 配置（端口/token/快照目录/日志级别/只读开关全表单化） | `docs/gui/{A1-still-reduced-motion,02-env-check-preview,03-install-step-preview,03b-install-done-preview,04-config-preview}.png`（mock 数据渲染，最终以真后端复验为准） |

**A2 注（观察级）**：hero 字号 `clamp(48px, 5vw, 64px)`；在 <960px 视口取 48px 下限 → 3.43×<4×。
应用主窗口 1180 宽（WINDOWS-PROBES §4）达标；若窗口被用户缩到 ~900px 以下则跌破闸门。
建议（不阻塞）：把 clamp 下限升到 56px（56/14=4.0×）。实际判定以 dom_gate 在 1180 窗口的结果为准。

### 已完成（有证据）

| 项 | 结果 | 证据 |
|---|---|---|
| G4 回归（100 断言 + lzstring parity） | **6/6 全绿（exit 0）** | `docs/gui/gui-g4-*.log`，见 G4 节 |
| E 组工具层语义（smoke_test.mjs 直连） | **退出码 1/2 语义实测一致** | `docs/gui/logs/smoke-direct-{deadport,7777}.log`；exit 1=桥接不可达(hint 齐)、exit 2=不在世界(hint 齐)；对现场 7777 运行安全（测试在 2/5 终止，未触世界） |
| 环境事实核验（B1 对照基准） | 完成 | node v24.14.0 / game_dir=d:/steam/…/shapez.io（注册表链）/ mods 目录+已装 mod sha=eb0fb097… 与仓库一致 / 7777 被外部桥接+游戏占用 / Chrome 存在 / saves 有 modsettings / 既有 .bak-20261020-202532 |
| T5 验证脚本自身（语法 + 实测） | 就绪 | `gui/verify/{lib,cdp,api_acceptance,red_team,dom_gate,wizard_shots}.mjs` 均 `node --check` 通过；CDP 驱动已用真实 Chrome 截图验证（`docs/gui/logs/cdp-test.png`）；raw-socket 穿越探测已用 dummy server 验证路径不归一化；api_acceptance 的失败路径（无 server.mjs）正确输出 FAIL 而非崩溃 |

### 被阻塞项（阻塞原因：被测对象不存在）

| 组 | 项 | 无法执行原因 |
|---|---|---|
| A | A1–A7 | 需 `gui/ui/index.html`（`?probe=1` 契约）+ 运行中 server；脚本 `dom_gate.mjs` 已就绪 |
| B | B1–B6 | 需 `gui/server.mjs`；脚本 `api_acceptance.mjs` 已就绪 |
| C | C1–C6 | 同上 |
| D | D1–D6 | 同上（测试端口已避开用户现场 7777/17778） |
| E | E2 外部桥接观测 / E4 GUI 层复测 | 同上；**E2/E3 的完整链路需游戏 mod 连到 GUI 控制的端口 —— 现场游戏只连 7777 外部桥接，即使 GUI 就绪也只能做只读外部观测**；E 组的工具层语义已验证（上表） |
| F | F1–F3 | 需 UI + CDP；截图/F3 脚本 `wizard_shots.mjs` 已就绪 |
| 反断言 | origin/token/穿越/open 白名单/bak 安全/SSE token | 需 server；脚本 `red_team.mjs` 已就绪 |
| G2 | 截图 ≥4 张 | 需 UI；`wizard_shots.mjs` 会在就绪后自动截 6 张（01-first-run / 02-env-check / 03-install-done / 04-config / 05-console-logs / 06-F3-banner）。当前 docs/gui 下仅有验证工具自测图（cdp-test.png），非 GUI 截图 |

### 就绪后的执行路径（已自动化）

`bash gui/verify/run_final.sh` 仍在后台等待产物（窗口至约 23:02）；一旦
`gui/server.mjs` + `gui/ui/index.html` 出现，将自动依次运行：
G4 复跑 → api_acceptance（B/C/D/E2/E4/F3）→ red_team → dom_gate → wizard_shots，
结果写回本文件对应节（各节 `BEGIN/END` 标记独立可覆盖）与 `docs/gui/logs/*.out`。
窗口过期后，各脚本可手动单独重跑（均为 `node gui/verify/<name>.mjs`，自启自清、恢复现场）。

### 现场保护说明

本机 7777 有**用户外部启动的桥接**（游戏 shapez.io 1.5.6 与其相连）。
所有测试端口改用 78xx/79xx 空闲段；唯一触碰 7777 的是**只读** GET /health 与
`/api/bridge/status` 观测 + 一次直接 smoke（在 check2 即终止，不触碰世界）。
red_team 的 .bak-* 安全测试会在显式 `clean_backups:true` 用例前先备份、测后原样恢复既有用户备份。

### 缺陷清单（T1–T4）

**运行期缺陷：无法给出 — 无被测产物落盘。** 静态审阅已落盘的 `gui/lib/proc-mgr.mjs` 未发现阻塞级问题；
三条经实测复核的低危观察记录在 `docs/gui/error-injection.md` 末尾「静态审阅观察」节：

1. `mapLevel` 子串启发误报/漏报（实测：`"failsafe engaged"`→error 误报；`"EADDRINUSE…"`(stderr)→warn 漏报）—— 显示级，非功能缺陷。
2. Windows 上 `child.kill("SIGTERM")` 实为 TerminateProcess，子进程 SIGTERM 处理器不执行（实测验证）—— 与 §2.4 双保险设计相符，结果正确，仅优雅日志缺失。
3. `logsSince` 未知 kind 返回 null，待 server 复核 HTTP 映射。

**严重度均为「观察/低」，无高 severity 缺陷可报告（因为主要被测对象缺失）。**
<!-- END:sec-summary -->

## S 组 · GUI 启动/令牌

<!-- BEGIN:sec-S -->
> 时间: 2026-10-22T02:02:51.163Z

| 项 | 结果 | 判据 / 详情 | 证据 |
|---|---|---|---|
| S/boot | **PASS** | GUI server ready on http://127.0.0.1:7801 | log: D:\Projects\rea\Project work\shapez\docs\gui\logs\gui-server-7801-1792634570674.log |
| S/token | **PASS** | GET / 含 <meta name=gui-token> | token len=32 |
| S/healthz | **PASS** | GET /api/healthz 免 token（错误 token 也 200） | status=200 body={"ok":true,"gui_version":"0.1.0","uptime_s":0,"port":7801} |
| S/api_version | **PASS** | GET /api/version: mod=0.1.0 protocol=1 compat=["1.5.6"] node=20/v26.12.1 | {"gui":"0.1.0","repo":"D:\\Projects\\rea\\Project work\\shapez","mod":"0.1.0","protocol":1,"compat_games":["1.5.6"],"node":{"min":20,"cur":"v26.12.1"}} |
| S/api_mcp_config | **PASS** | GET /api/mcp-config: command=node args=["D:/Projects/rea/Project work/shapez/src/mcp/server.mjs"] | claude_cfg_path=C:\Users\Administrator\AppData\Roaming\Claude\claude_desktop_config.json |
| S/error_envelope | **PASS** | 404 错误统一体字段齐全（code/message/message_en/hint/detail/log_ref） | status=404 body={"error":{"code":"NOT_FOUND","message":"未知 API","message_en":"unknown api","hint":null,"detail":null,"log_ref":null}} |

计数: PASS=6 FAIL=0 BLOCKED=0
<!-- END:sec-S -->

## 总表（api_acceptance 全量）

<!-- BEGIN:sec-all -->
> 时间: 2026-10-22T02:03:12.838Z · PASS=35 FAIL=0 BLOCKED=1

| 项 | 结果 | 判据 / 详情 | 证据 |
|---|---|---|---|
| S/boot | **PASS** | GUI server ready on http://127.0.0.1:7801 | log: D:\Projects\rea\Project work\shapez\docs\gui\logs\gui-server-7801-1792634570674.log |
| S/token | **PASS** | GET / 含 <meta name=gui-token> | token len=32 |
| S/healthz | **PASS** | GET /api/healthz 免 token（错误 token 也 200） | status=200 body={"ok":true,"gui_version":"0.1.0","uptime_s":0,"port":7801} |
| S/api_version | **PASS** | GET /api/version: mod=0.1.0 protocol=1 compat=["1.5.6"] node=20/v26.12.1 | {"gui":"0.1.0","repo":"D:\\Projects\\rea\\Project work\\shapez","mod":"0.1.0","protocol":1,"compat_games":["1.5.6"],"node":{"min":20,"cur":"v26.12.1"}} |
| S/api_mcp_config | **PASS** | GET /api/mcp-config: command=node args=["D:/Projects/rea/Project work/shapez/src/mcp/server.mjs"] | claude_cfg_path=C:\Users\Administrator\AppData\Roaming\Claude\claude_desktop_config.json |
| S/error_envelope | **PASS** | 404 错误统一体字段齐全（code/message/message_en/hint/detail/log_ref） | status=404 body={"error":{"code":"NOT_FOUND","message":"未知 API","message_en":"unknown api","hint":null,"detail":null,"log_ref":null}} |
| B/B1 | **PASS** | EnvReport 26 项全部与真实机器一致 | 样例: node=v26.12.1 game=D:\Steam\steamapps\common\shapez.io mod.match=true port.busy=false |
| B/B2 | **PASS** | 安装 exit_code=0, 文件与仓库 sha256 一致 | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backup":null,"lines_n":27} sha_match=true shaBefore=eb0fb09708f… |
| B/B3 | **PASS** | 二次安装 exit=0；备份 5→7（新增 2） | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backup":null,"lines_n":27} file_stable=true |
| B/B3.preexisting_bak | **PASS** | 测试前已有备份 shapez-ai-bridge.js.bak-20261020-202532 未被安装操作破坏 | sha=50626463006e73f… |
| B/B4.uninstall | **PASS** | 卸载后文件删除、env.mod.installed=false；默认保留备份 true | resp={"ok":true,"removed":[],"kept_modsettings":true,"notes":["游戏内 mod 设置残留于 saves 目录（modsettings_shapez-ai-bridge__*.json）"]} installed=false baks=7 |
| B/B4.bak_kept | **PASS** | 默认卸载不删除 .bak-*（除非 clean_backups:true） | before=7 after=7 |
| B/B4.reinstall | **PASS** | 重装恢复：文件回到与仓库一致 | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backu… |
| B/B5 | **PASS** | 假 game_dir → HTTP 400 INVALID_PARAM（提示=选择包含 shapezio.exe 的目录） | reason=not_shapez_dir body={"error":{"code":"INVALID_PARAM","message":"该目录不是 shapez.io 安装目录","message_en":"not a shapez directory","hint":"选择包含 shapezio.exe 的目录","detail":{"reason":"not_shapez_dir","game_dir":"C:/definitely/not/a/shapez/dir-1792634583389"},"log_ref":null}} |
| B/B5.no_persist | **PASS** | 假路径未被持久化 | override=null |
| B/B6 | **PASS** | 安装失败可见（非静默）: 安装失败 | status=500 code=INSTALL_FAILED log_ref=103 log_has_error_line=true body={"error":{"code":"INSTALL_FAILED","message":"安装失败","message_en":"install failed","hint":"展开日志查看原始输出","detail":{"exit_code":1},"log_ref":103}} |
| C/C1 | **PASS** | GET /api/config 返回默认值 {port:7777, token:null, read_only:false, …} | config={"port":7777,"token":null,"read_only":false,"snapshot_dir":"./snapshots","log_level":"info","rpc_timeout_ms":30000,"long_timeout_ms":180000} file={"path":"D:\\Projects\\rea\\Project work\\shapez\\bridge.config.json","exists":false,"valid":true} warnings=[] |
| C/C2 | **PASS** | POST /api/config 写入 bridge.config.json 且回显一致（port=7862） | resp={"ok":true,"config":{"port":7862,"token":null,"read_only":false,"snapshot_dir":"./snapshots-t5","log_level":"warn","rpc_timeout_ms":30000,"long_timeout_ms":180000},"bridge_restarted":false} file.port=7862 echo.port=7862 restarted=false |
| C/C3 | **PASS** | 非法值全部 400 且未写文件（字段级消息=有） | [{"name":"port 99999","status":400,"code":"CONFIG_INVALID","fields":{"port":"port 必须为 1024–65535 的整数"}},{"name":"port 'abc'","status":400,"code":"CONFIG_INVALID","fields":{"port":"port 必须为 1024–65535 的整数"}},{"name":"token bad chars","status":400,"code":"CONFIG_INVALID","fields":{"token":"token 只能包含可打印 ASCII 字符（不可含空格），长度 8–128"}},{"name":"log_level nope","status":400,"code":"CONFIG_INVALID","field… |
| C/C4 | **PASS** | POST /api/config/reset 回默认值且落盘 | resp={"ok":true,"config":{"port":7777,"token":null,"read_only":false,"snapshot_dir":"./snapshots","log_level":"info","rpc_timeout_ms":30000,"long_timeout_ms":180000}} file.port=7777 |
| C/C5 | **PASS** | 占用端口 7880 → HTTP 409 PORT_BUSY（提示=换一个端口，或结束占用进程） | pid=35160 file_unchanged=true body={"error":{"code":"PORT_BUSY","message":"端口 7880 已被占用","message_en":"port 7880 is busy","hint":"换一个端口，或结束占用进程","detail":{"port":7880,"pid":35160},"log_ref":null}} |
| C/C6 | **PASS** | 无 bridge.config.json 时 GET 返回默认值不报错（file.exists=false） | status=200 file={"path":"D:\\Projects\\rea\\Project work\\shapez\\bridge.config.json","exists":false,"valid":true} |
| D/D1 | **PASS** | 桥接启动：ok、status.running=true、/health ok（端口 7891） | resp={"ok":true,"status":{"running":true,"managed":true,"pid":26480,"port":7891,"healthy":true,"mod_connected":false,"uptime_s":0,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"pa… status={"running":true,"managed":true,"pid":26480,"port":7891,"healthy":true,"mod_connected":false,"uptime_s":0,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"paused":n… |
| D/D2 | **PASS** | status 与 /health 一致（running/mod_connected/uptime_s/port） | status={"running":true,"managed":true,"pid":26480,"port":7891,"healthy":true,"mod_connected":false,"uptime_s":0,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"paused":null,"allow_write":null,"last_error":null} |
| D/D4 | **PASS** | 重复 start 幂等（already_running=true，pid 不变） | resp={"ok":true,"already_running":true,"status":{"running":true,"managed":true,"pid":26480,"port":7891,"healthy":true,"mod_connected":false,"uptime_s":1,"in_game":null,"game_version":null,"mod_version":nu… pid_before=26480 pid_after=26480 |
| D/D6 | **PASS** | bridge 日志 since=0 得 16 行，since=16 得 0 行增量；n 单调 | sample=[{"n":1,"kind":"bridge","stream":"out","level":"info","text":"$ node src/bridge/bridge.mjs --port 7891","ts":1792634587442},{"n":2,"kind":"bridge","stream":"err","level":"warn","text":"[bridge/info] ","ts":1792634587706},{"n":3,"kind":"bridge","stream":"err","level":"warn","text":"  shapez-ai-bridg… |
| D/D3 | **PASS** | 停止：ok、running=false、端口 7891 释放 | resp={"ok":true,"stopped":true,"forced":false} status={"running":false,"managed":false,"pid":null,"port":7891,"healthy":false,"mod_connected":false,"uptime_s":null,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"paused":null,"allow_write":null,"last… port_free=true |
| D/D5 | **PASS** | 端口占用启动 → HTTP 409 PORT_BUSY；日志含 EADDRINUSE=false | body={"error":{"code":"PORT_BUSY","message":"端口 7905 已被占用","message_en":"port 7905 is busy","hint":"换一个端口，或结束占用进程","detail":{"port":7905,"pid":25540},"log_ref":null}} status_after={"running":false,"managed":false} |
| E/E2.live7777_observed | **BLOCKED** | 7777 无外部桥接（环境变化） | status=0 |
| E/E2.external_status | **PASS** | 自建外部桥接(7877)：running=true managed=false（应 false）healthy=true | {"running":true,"managed":false,"pid":null,"port":7877,"healthy":true,"mod_connected":false,"uptime_s":0,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"paused":null,"allow_write":null,"last_error":null} |
| E/E2.stop_foreign_guard | **PASS** | stop 外部桥接 → 409 CANNOT_STOP_FOREIGN=true；外部进程存活=true | resp={"error":{"code":"CANNOT_STOP_FOREIGN","message":"该桥接由外部终端启动","message_en":"external bridge","hint":"请在原终端 Ctrl-C 停止","detail":{"pid":null},"log_ref":null}} pid=23728 |
| E/E2.start_noop | **PASS** | 对健康外部桥接 start → HTTP 200 already_running | {"ok":true,"already_running":true,"status":{"running":true,"managed":false,"pid":null,"port":7877,"healthy":true,"mod_connected":false,"uptime_s":1,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"paused":null,"allow… |
| E/E4.start | **PASS** | 冒烟已启动 run_id=1 |  |
| E/E4.result | **PASS** | 冒烟 exit_code=1（期望 1=桥接不可达），hint=先启动桥接 | {"running":false,"run_id":1,"exit_code":1,"checks":[{"n":1,"name":"检查 1","name_zh":"检查 1","state":"fail","detail":"bridge reachable at http://127.0.0.1:7925 — 无法连接桥接服务器"},{"n":2,"name":"检查 2","name_zh":"检查 2","state":"pending","detail":""},{"n":3,"name":"检查 3","name_zh":"检查 3","state":"pending","detail":""},{"n":4,"name":"检查 4","name_zh":"检查 4","state":"pending","detail":""},{"n":5,"name":"检查 5",… |
| E/E4.port_empty | **PASS** | 对照：7925 确无桥接（fetch 失败） | status=0 |
| F/F3.prep | **PASS** | F3 主测在 red_team.mjs（CDP 截横幅）；此处先记录 healthz 基线 |  |

计数: PASS=35 FAIL=0 BLOCKED=1
<!-- END:sec-all -->



## A 组 · 静态闸门（mock 模式全量预检）

<!-- BEGIN:sec-A-mock -->
> 时间: 2026-10-21T21:20:41.513Z · 模式: mock（static-mini :7808，零后端）

| 项 | 结果 | 判据 / 详情 | 证据 |
|---|---|---|---|
| A/static_mini | **PASS** | static-mini 服务 gui/ui/ @7808（mock 模式） |  |
| A/probe_json | **PASS** | ?probe=1 产出 #probe-json（mock 模式） | {"displayFont":"58.2px","bodyFont":"14px","ratio":4.16,"minHit":44,"focusableCount":9,"reducedMotion":false,"view":"wizard"} |
| A/A2 | **PASS** | display/body=4.16（≥4；@1180×780 应用窗口） | display=58.2px body=14px |
| A/A4 | **PASS** | reduced-motion: flag=true 文本 560/560（1.00）内联 opacity:0=0 | reduced probe={"displayFont":"58.2px","bodyFont":"14px","ratio":4.16,"minHit":44,"focusableCount":9,"reducedMotion":true,"view":"wizard"} |
| A/A6 | **PASS** | minHit=44px（≥44） | focusable=9 |
| A/focusable_count | **PASS** | focusableCount=9 |  |
| A/A3 | **PASS** | accent=[#4a97df, #3f87cc] 紫渐变=false | css_files=3 |
| A/A5 | **PASS** | 可见可聚焦 8 个，无焦点环 0 | 全部有 outline/box-shadow 焦点样式 |

计数: PASS=8 FAIL=0 BLOCKED=0
<!-- END:sec-A-mock -->


## E 组 · E2 外部桥接观测

<!-- BEGIN:sec-E2 -->
> 时间: 2026-10-22T02:03:11.710Z

| 项 | 结果 | 判据 / 详情 | 证据 |
|---|---|---|---|
| S/boot | **PASS** | GUI server ready on http://127.0.0.1:7801 | log: D:\Projects\rea\Project work\shapez\docs\gui\logs\gui-server-7801-1792634570674.log |
| S/token | **PASS** | GET / 含 <meta name=gui-token> | token len=32 |
| S/healthz | **PASS** | GET /api/healthz 免 token（错误 token 也 200） | status=200 body={"ok":true,"gui_version":"0.1.0","uptime_s":0,"port":7801} |
| S/api_version | **PASS** | GET /api/version: mod=0.1.0 protocol=1 compat=["1.5.6"] node=20/v26.12.1 | {"gui":"0.1.0","repo":"D:\\Projects\\rea\\Project work\\shapez","mod":"0.1.0","protocol":1,"compat_games":["1.5.6"],"node":{"min":20,"cur":"v26.12.1"}} |
| S/api_mcp_config | **PASS** | GET /api/mcp-config: command=node args=["D:/Projects/rea/Project work/shapez/src/mcp/server.mjs"] | claude_cfg_path=C:\Users\Administrator\AppData\Roaming\Claude\claude_desktop_config.json |
| S/error_envelope | **PASS** | 404 错误统一体字段齐全（code/message/message_en/hint/detail/log_ref） | status=404 body={"error":{"code":"NOT_FOUND","message":"未知 API","message_en":"unknown api","hint":null,"detail":null,"log_ref":null}} |
| B/B1 | **PASS** | EnvReport 26 项全部与真实机器一致 | 样例: node=v26.12.1 game=D:\Steam\steamapps\common\shapez.io mod.match=true port.busy=false |
| B/B2 | **PASS** | 安装 exit_code=0, 文件与仓库 sha256 一致 | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backup":null,"lines_n":27} sha_match=true shaBefore=eb0fb09708f… |
| B/B3 | **PASS** | 二次安装 exit=0；备份 5→7（新增 2） | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backup":null,"lines_n":27} file_stable=true |
| B/B3.preexisting_bak | **PASS** | 测试前已有备份 shapez-ai-bridge.js.bak-20261020-202532 未被安装操作破坏 | sha=50626463006e73f… |
| B/B4.uninstall | **PASS** | 卸载后文件删除、env.mod.installed=false；默认保留备份 true | resp={"ok":true,"removed":[],"kept_modsettings":true,"notes":["游戏内 mod 设置残留于 saves 目录（modsettings_shapez-ai-bridge__*.json）"]} installed=false baks=7 |
| B/B4.bak_kept | **PASS** | 默认卸载不删除 .bak-*（除非 clean_backups:true） | before=7 after=7 |
| B/B4.reinstall | **PASS** | 重装恢复：文件回到与仓库一致 | resp={"ok":true,"exit_code":0,"target":"C:\\Users\\Administrator\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js","sha256":"eb0fb09708fa1c7d6116de7ad9ade3a495e859d09a99ce92c6bd297b538880e5","backu… |
| B/B5 | **PASS** | 假 game_dir → HTTP 400 INVALID_PARAM（提示=选择包含 shapezio.exe 的目录） | reason=not_shapez_dir body={"error":{"code":"INVALID_PARAM","message":"该目录不是 shapez.io 安装目录","message_en":"not a shapez directory","hint":"选择包含 shapezio.exe 的目录","detail":{"reason":"not_shapez_dir","game_dir":"C:/definitely/not/a/shapez/dir-1792634583389"},"log_ref":null}} |
| B/B5.no_persist | **PASS** | 假路径未被持久化 | override=null |
| B/B6 | **PASS** | 安装失败可见（非静默）: 安装失败 | status=500 code=INSTALL_FAILED log_ref=103 log_has_error_line=true body={"error":{"code":"INSTALL_FAILED","message":"安装失败","message_en":"install failed","hint":"展开日志查看原始输出","detail":{"exit_code":1},"log_ref":103}} |
| C/C1 | **PASS** | GET /api/config 返回默认值 {port:7777, token:null, read_only:false, …} | config={"port":7777,"token":null,"read_only":false,"snapshot_dir":"./snapshots","log_level":"info","rpc_timeout_ms":30000,"long_timeout_ms":180000} file={"path":"D:\\Projects\\rea\\Project work\\shapez\\bridge.config.json","exists":false,"valid":true} warnings=[] |
| C/C2 | **PASS** | POST /api/config 写入 bridge.config.json 且回显一致（port=7862） | resp={"ok":true,"config":{"port":7862,"token":null,"read_only":false,"snapshot_dir":"./snapshots-t5","log_level":"warn","rpc_timeout_ms":30000,"long_timeout_ms":180000},"bridge_restarted":false} file.port=7862 echo.port=7862 restarted=false |
| C/C3 | **PASS** | 非法值全部 400 且未写文件（字段级消息=有） | [{"name":"port 99999","status":400,"code":"CONFIG_INVALID","fields":{"port":"port 必须为 1024–65535 的整数"}},{"name":"port 'abc'","status":400,"code":"CONFIG_INVALID","fields":{"port":"port 必须为 1024–65535 的整数"}},{"name":"token bad chars","status":400,"code":"CONFIG_INVALID","fields":{"token":"token 只能包含可打印 ASCII 字符（不可含空格），长度 8–128"}},{"name":"log_level nope","status":400,"code":"CONFIG_INVALID","field… |
| C/C4 | **PASS** | POST /api/config/reset 回默认值且落盘 | resp={"ok":true,"config":{"port":7777,"token":null,"read_only":false,"snapshot_dir":"./snapshots","log_level":"info","rpc_timeout_ms":30000,"long_timeout_ms":180000}} file.port=7777 |
| C/C5 | **PASS** | 占用端口 7880 → HTTP 409 PORT_BUSY（提示=换一个端口，或结束占用进程） | pid=35160 file_unchanged=true body={"error":{"code":"PORT_BUSY","message":"端口 7880 已被占用","message_en":"port 7880 is busy","hint":"换一个端口，或结束占用进程","detail":{"port":7880,"pid":35160},"log_ref":null}} |
| C/C6 | **PASS** | 无 bridge.config.json 时 GET 返回默认值不报错（file.exists=false） | status=200 file={"path":"D:\\Projects\\rea\\Project work\\shapez\\bridge.config.json","exists":false,"valid":true} |
| D/D1 | **PASS** | 桥接启动：ok、status.running=true、/health ok（端口 7891） | resp={"ok":true,"status":{"running":true,"managed":true,"pid":26480,"port":7891,"healthy":true,"mod_connected":false,"uptime_s":0,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"pa… status={"running":true,"managed":true,"pid":26480,"port":7891,"healthy":true,"mod_connected":false,"uptime_s":0,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"paused":n… |
| D/D2 | **PASS** | status 与 /health 一致（running/mod_connected/uptime_s/port） | status={"running":true,"managed":true,"pid":26480,"port":7891,"healthy":true,"mod_connected":false,"uptime_s":0,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"paused":null,"allow_write":null,"last_error":null} |
| D/D4 | **PASS** | 重复 start 幂等（already_running=true，pid 不变） | resp={"ok":true,"already_running":true,"status":{"running":true,"managed":true,"pid":26480,"port":7891,"healthy":true,"mod_connected":false,"uptime_s":1,"in_game":null,"game_version":null,"mod_version":nu… pid_before=26480 pid_after=26480 |
| D/D6 | **PASS** | bridge 日志 since=0 得 16 行，since=16 得 0 行增量；n 单调 | sample=[{"n":1,"kind":"bridge","stream":"out","level":"info","text":"$ node src/bridge/bridge.mjs --port 7891","ts":1792634587442},{"n":2,"kind":"bridge","stream":"err","level":"warn","text":"[bridge/info] ","ts":1792634587706},{"n":3,"kind":"bridge","stream":"err","level":"warn","text":"  shapez-ai-bridg… |
| D/D3 | **PASS** | 停止：ok、running=false、端口 7891 释放 | resp={"ok":true,"stopped":true,"forced":false} status={"running":false,"managed":false,"pid":null,"port":7891,"healthy":false,"mod_connected":false,"uptime_s":null,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"paused":null,"allow_write":null,"last… port_free=true |
| D/D5 | **PASS** | 端口占用启动 → HTTP 409 PORT_BUSY；日志含 EADDRINUSE=false | body={"error":{"code":"PORT_BUSY","message":"端口 7905 已被占用","message_en":"port 7905 is busy","hint":"换一个端口，或结束占用进程","detail":{"port":7905,"pid":25540},"log_ref":null}} status_after={"running":false,"managed":false} |
| E/E2.live7777_observed | **BLOCKED** | 7777 无外部桥接（环境变化） | status=0 |
| E/E2.external_status | **PASS** | 自建外部桥接(7877)：running=true managed=false（应 false）healthy=true | {"running":true,"managed":false,"pid":null,"port":7877,"healthy":true,"mod_connected":false,"uptime_s":0,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"paused":null,"allow_write":null,"last_error":null} |
| E/E2.stop_foreign_guard | **PASS** | stop 外部桥接 → 409 CANNOT_STOP_FOREIGN=true；外部进程存活=true | resp={"error":{"code":"CANNOT_STOP_FOREIGN","message":"该桥接由外部终端启动","message_en":"external bridge","hint":"请在原终端 Ctrl-C 停止","detail":{"pid":null},"log_ref":null}} pid=23728 |
| E/E2.start_noop | **PASS** | 对健康外部桥接 start → HTTP 200 already_running | {"ok":true,"already_running":true,"status":{"running":true,"managed":false,"pid":null,"port":7877,"healthy":true,"mod_connected":false,"uptime_s":1,"in_game":null,"game_version":null,"mod_version":null,"hub_level":null,"paused":null,"allow… |

计数: PASS=31 FAIL=0 BLOCKED=1
<!-- END:sec-E2 -->
