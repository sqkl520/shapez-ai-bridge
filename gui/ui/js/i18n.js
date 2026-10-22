/**
 * i18n.js — zh-CN default (navigator.language), switchable, ≥80 keys with
 * full zh + en coverage (DESIGN-PLAN §3.7).
 *
 * `t(key, vars)` interpolates {name} placeholders. Missing keys fall back to
 * the key itself so the UI never renders "undefined".
 */

const DICT = {
    // ── app / chrome ──
    "app.title": { zh: "shapez.io AI 桥接", en: "shapez.io AI Bridge" },
    "app.tagline": { zh: "让 AI 操作你的工厂", en: "Let AI run your factory" },
    "topbar.status.running": { zh: "运行中", en: "Running" },
    "topbar.status.stopped": { zh: "未运行", en: "Stopped" },
    "topbar.status.connected": { zh: "游戏已连接", en: "Game connected" },
    "topbar.status.disconnected": { zh: "等待游戏", en: "Waiting for game" },
    "topbar.lang": { zh: "语言", en: "Language" },
    "topbar.mock_chip": { zh: "演示模式", en: "Demo mode" },
    "topbar.nav.wizard": { zh: "向导", en: "Wizard" },
    "topbar.backend_lost": { zh: "后端已断开", en: "Backend disconnected" },
    "topbar.backend_lost.hint": { zh: "GUI 后端已停止响应。请确认 gui/server.mjs 仍在运行。", en: "The GUI backend stopped responding. Make sure gui/server.mjs is still running." },
    "topbar.reconnect": { zh: "重新连接", en: "Reconnect" },
    "topbar.reconnect.checking": { zh: "正在重连…", en: "Reconnecting…" },
    "common.back": { zh: "返回", en: "Back" },
    "common.next": { zh: "下一步", en: "Next" },
    "common.continue": { zh: "继续", en: "Continue" },
    "common.start": { zh: "开始", en: "Start" },
    "common.skip": { zh: "跳过", en: "Skip" },
    "common.retry": { zh: "重试", en: "Retry" },
    "common.cancel": { zh: "取消", en: "Cancel" },
    "common.confirm": { zh: "确认", en: "Confirm" },
    "common.close": { zh: "关闭", en: "Close" },
    "common.copy": { zh: "复制", en: "Copy" },
    "common.copied": { zh: "已复制", en: "Copied" },
    "common.details": { zh: "查看详情", en: "Details" },
    "common.optional": { zh: "可选", en: "Optional" },
    "common.loading": { zh: "加载中…", en: "Loading…" },

    // ── wizard frame ──
    "wizard.title": { zh: "三步接管你的工厂", en: "Take over your factory in three steps" },
    "wizard.step1": { zh: "欢迎", en: "Welcome" },
    "wizard.step2": { zh: "环境检查", en: "Environment" },
    "wizard.step3": { zh: "安装", en: "Install" },
    "wizard.step4": { zh: "配置", en: "Configure" },
    "wizard.step5": { zh: "启动", en: "Launch" },
    "wizard.step6": { zh: "验证", en: "Verify" },
    "wizard.continue_to_console": { zh: "完成 · 进入控制台", en: "Done · Open console" },
    "wizard.mode_switched": { zh: "已切换演示模式", en: "Demo mode toggled" },

    // ── W1 welcome ──
    "w1.sub": { zh: "安装 Mod → 启动桥接 → 用 AI 指挥生产线。全程图形界面，无需手改文件。", en: "Install the mod, start the bridge, and let AI drive your production lines. All through this window — no file editing." },
    "w1.preview1": { zh: "安装 Mod", en: "Install mod" },
    "w1.preview1.sub": { zh: "一个文件进 mods 目录", en: "One file into the mods folder" },
    "w1.preview2": { zh: "启动桥接", en: "Start bridge" },
    "w1.preview2.sub": { zh: "本地端口，安全环回", en: "Local port, loopback only" },
    "w1.preview3": { zh: "连接 AI", en: "Connect AI" },
    "w1.preview3.sub": { zh: "复制一段 MCP 配置即可", en: "Paste one MCP config snippet" },
    "w1.achievement.title": { zh: "安装 Mod 会禁用 Steam 成就与拼图 DLC", en: "Installing any mod disables Steam achievements and the puzzle DLC" },
    "w1.achievement.body": { zh: "这是 shapez.io 官方对「已装 Mod 存档」的行为，与本项目无关。装卸 Mod 可随时切换；成就判定以存档是否被 Mod 触碰为准。", en: "This is shapez.io's official behavior for modded saves — not specific to this project. You can uninstall at any time; achievement eligibility follows whether a save was touched by a mod." },
    "w1.achievement.files": { zh: "将写入的文件", en: "Files that will be written" },
    "w1.achievement.files.mod": { zh: "mods 目录 / shapez-ai-bridge.js（附 .bak 备份）", en: "mods dir / shapez-ai-bridge.js (with .bak backup)" },
    "w1.achievement.files.config": { zh: "仓库根 / bridge.config.json（仅在你点保存时）", en: "repo root / bridge.config.json (only when you hit save)" },
    "w1.achievement.files.state": { zh: "gui/.gui-state.json（向导进度）", en: "gui/.gui-state.json (wizard progress)" },

    // ── W2 env check ──
    "w2.title": { zh: "环境检查", en: "Environment check" },
    "w2.sub": { zh: "自动检测本机 Node、游戏目录、Mods 目录等。缺什么补什么。", en: "Automatically probes Node, your game folder, mods folder and more." },
    "w2.check.node": { zh: "Node.js 运行时", en: "Node.js runtime" },
    "w2.check.game": { zh: "shapez.io 游戏目录", en: "shapez.io game folder" },
    "w2.check.mods": { zh: "Mods 目录可写", en: "Mods folder writable" },
    "w2.check.mod": { zh: "Mod 安装状态", en: "Mod install state" },
    "w2.check.port": { zh: "桥接端口可用", en: "Bridge port available" },
    "w2.check.browser": { zh: "浏览器", en: "Browser" },
    "w2.check.pending": { zh: "等待检测", en: "Pending" },
    "w2.check.running": { zh: "检测中…", en: "Checking…" },
    "w2.check.pass": { zh: "通过", en: "Pass" },
    "w2.check.fail": { zh: "未通过", en: "Failed" },
    "w2.hint.node": { zh: "未找到 Node.js 20+。到 nodejs.org 安装 LTS 版本后重新检测。", en: "Node.js 20+ not found. Install the LTS from nodejs.org, then re-check." },
    "w2.hint.game": { zh: "未自动找到游戏。可从 Steam 安装，或手动指定目录。", en: "Game folder not found automatically. Install via Steam, or point us at it." },
    "w2.hint.mods": { zh: "Mods 目录不存在或不可写。启动一次游戏会自动创建；仍失败请检查权限。", en: "Mods folder missing or read-only. Launching the game once creates it; if that fails, check permissions." },
    "w2.hint.mod": { zh: "Mod 尚未安装 — 这是后面第三步要做的事，不阻塞。", en: "Mod not installed yet — that is step 3. Not blocking." },
    "w2.hint.port": { zh: "端口 {port} 被 PID {pid} 占用。在配置步换一个端口，或结束该进程。", en: "Port {port} is held by PID {pid}. Pick another port in the configure step, or end that process." },
    "w2.hint.browser": { zh: "没找到 Chrome/Edge — 不影响功能，但「打开目录」等操作可能改用默认浏览器。", en: "Chrome/Edge not found — everything still works, but \"open folder\" actions may fall back to your default browser." },
    "w2.action.steam": { zh: "用 Steam 安装游戏", en: "Install via Steam" },
    "w2.action.manual": { zh: "手动指定路径", en: "Set folder manually" },
    "w2.action.recheck": { zh: "重新检测", en: "Re-check" },
    "w2.action.details": { zh: "为什么？", en: "Why?" },
    "w2.game_dir.placeholder": { zh: "例如 D:\\Steam\\steamapps\\common\\shapez.io", en: "e.g. D:\\Steam\\steamapps\\common\\shapez.io" },
    "w2.game_dir.apply": { zh: "使用此目录", en: "Use this folder" },
    "w2.game_missing_banner": { zh: "未找到游戏目录 — 可以继续装 Mod，但启动与验证步骤稍后需要它。", en: "Game folder not found — you can still install the mod; launch & verify steps need it later." },

    // ── W3 install ──
    "w3.title": { zh: "安装 Mod", en: "Install the mod" },
    "w3.sub": { zh: "把 shapez-ai-bridge.js 复制进游戏的 mods 目录，并保留一份备份。", en: "Copies shapez-ai-bridge.js into the game's mods folder, keeping a backup." },
    "w3.install": { zh: "安装 Mod", en: "Install mod" },
    "w3.installing": { zh: "安装中…", en: "Installing…" },
    "w3.reinstall": { zh: "重新安装", en: "Reinstall" },
    "w3.uninstall": { zh: "卸载 Mod", en: "Uninstall mod" },
    "w3.done.title": { zh: "安装完成", en: "Installed" },
    "w3.done.target": { zh: "目标路径", en: "Target path" },
    "w3.done.sha": { zh: "SHA-256（前 8 位）", en: "SHA-256 (first 8)" },
    "w3.done.backup": { zh: "备份文件", en: "Backup file" },
    "w3.done.no_backup": { zh: "无备份（首次安装）", en: "No backup (first install)" },
    "w3.done.verify": { zh: "再次安装会覆盖并自动备份旧版。", en: "Reinstalling overwrites and backs up the previous version automatically." },
    "w3.fail.title": { zh: "安装失败（exit {code}）", en: "Install failed (exit {code})" },
    "w3.fail.reason": { zh: "常见原因", en: "Common causes" },
    "w3.fail.reason.body": { zh: "mods 目录被占用或只读；杀毒软件锁定文件；游戏正在运行。", en: "Mods folder busy or read-only; antivirus holding the file; game still running." },
    "w3.log": { zh: "查看完整日志", en: "View full log" },
    "w3.no_source": { zh: "仓库缺少 src/mod/shapez-ai-bridge.js — 你可能解压了不完整的 ZIP。请重新完整解压。", en: "Repo is missing src/mod/shapez-ai-bridge.js — your ZIP looks incomplete. Please re-extract the full archive." },
    "w3.restart_note": { zh: "若游戏当前正在运行：稍后需要重启游戏，Mod 才会被加载。", en: "If the game is running right now: restart it later so the mod gets loaded." },

    // ── W4 config ──
    "w4.title": { zh: "配置桥接", en: "Configure the bridge" },
    "w4.sub": { zh: "全部有默认值。端口与令牌非必要不要改。", en: "Everything has defaults. Leave port & token alone unless needed." },
    "w4.port": { zh: "桥接端口", en: "Bridge port" },
    "w4.port.hint": { zh: "AI 与游戏通信的本地端口（1024–65535），仅监听 127.0.0.1。", en: "Local port for AI↔game traffic (1024–65535), bound to 127.0.0.1 only." },
    "w4.port.invalid": { zh: "端口必须是 1024–65535 的整数", en: "Port must be an integer 1024–65535" },
    "w4.token": { zh: "访问令牌（高级）", en: "Access token (advanced)" },
    "w4.token.hint": { zh: "留空即自动生成。≥16 位更安全。", en: "Leave empty to auto-generate. 16+ chars recommended." },
    "w4.token.invalid": { zh: "令牌需为 8–128 个可见 ASCII 字符，或留空", en: "Token must be 8–128 printable ASCII chars, or empty" },
    "w4.read_only": { zh: "只读模式", en: "Read-only mode" },
    "w4.read_only.hint": { zh: "开启后 AI 只能读取工厂状态，不能放置/删除建筑。", en: "When on, AI can read factory state but cannot place/remove buildings." },
    "w4.snapshot_dir": { zh: "快照目录", en: "Snapshot folder" },
    "w4.snapshot_dir.hint": { zh: "AI 截图与存档快照的落盘位置（相对仓库根或绝对路径）。", en: "Where AI screenshots & snapshots land (repo-relative or absolute)." },
    "w4.snapshot_dir.invalid": { zh: "快照目录不能为空", en: "Snapshot folder must not be empty" },
    "w4.log_level": { zh: "日志级别", en: "Log level" },
    "w4.log_level.hint": { zh: "debug 会把每次 RPC 往返写进日志，排查问题时有用。", en: "debug logs every RPC round-trip — handy when troubleshooting." },
    "w4.advanced": { zh: "高级超时设置", en: "Advanced timeouts" },
    "w4.rpc_timeout": { zh: "RPC 超时 (ms)", en: "RPC timeout (ms)" },
    "w4.long_timeout": { zh: "长操作超时 (ms)", en: "Long-operation timeout (ms)" },
    "w4.timeout.invalid": { zh: "必须是 1000–600000 的整数", en: "Must be an integer 1000–600000" },
    "w4.save": { zh: "保存并继续", en: "Save & continue" },
    "w4.saving": { zh: "保存中…", en: "Saving…" },
    "w4.saved": { zh: "配置已保存", en: "Config saved" },
    "w4.use_defaults": { zh: "用默认值", en: "Use defaults" },
    "w4.defaults_hint": { zh: "未保存的修改将被默认值覆盖。", en: "Unsaved changes will be replaced by defaults." },
    "w4.port_busy": { zh: "端口 {port} 被占用", en: "Port {port} is busy" },
    "w4.port_busy.suggest": { zh: "试试 {port}", en: "Try {port}" },
    "w4.warning_weak_token": { zh: "令牌短于 16 位，安全性较弱。", en: "Token shorter than 16 chars — weaker security." },
    "w4.file_status": { zh: "配置文件：{path}", en: "Config file: {path}" },
    "w4.file_missing": { zh: "（尚不存在 — 保存时创建）", en: " (does not exist yet — created on save)" },

    // ── W5 launch ──
    "w5.title": { zh: "启动桥接", en: "Start the bridge" },
    "w5.sub": { zh: "桥接是本机的一个小服务：AI 从它读取游戏状态。", en: "The bridge is a small local service the AI reads game state through." },
    "w5.start": { zh: "启动桥接", en: "Start bridge" },
    "w5.starting": { zh: "启动中…", en: "Starting…" },
    "w5.stop": { zh: "停止桥接", en: "Stop bridge" },
    "w5.running": { zh: "运行中 · 已运行 {uptime}s · 端口 {port}", en: "Running · {uptime}s · port {port}" },
    "w5.launch_game": { zh: "启动 shapez.io", en: "Launch shapez.io" },
    "w5.waiting_game": { zh: "等待游戏连接…", en: "Waiting for the game to connect…" },
    "w5.game_running_restart": { zh: "检测到游戏正在运行：请重启游戏，让刚安装的 Mod 生效。", en: "Game is running: restart it so the freshly installed mod takes effect." },
    "w5.no_game_dir": { zh: "尚未找到游戏目录 — 用 Steam 启动，或回到第二步指定路径。", en: "No game folder yet — launch via Steam, or set the folder back in step 2." },
    "w5.port_busy_title": { zh: "端口被占用（PID {pid}）", en: "Port busy (PID {pid})" },
    "w5.port_busy_change": { zh: "更换端口", en: "Change port" },
    "w5.exited_title": { zh: "桥接进程启动后立即退出", en: "Bridge exited right after start" },
    "w5.show_log": { zh: "展开日志", en: "Show log" },

    // ── W6 verify ──
    "w6.title": { zh: "验证一切就绪", en: "Verify everything works" },
    "w6.sub": { zh: "5 项检查：桥接可达 → 游戏连接 → 世界可读 → RPC → 截图。", en: "Five checks: bridge reachable → game connected → world readable → RPC → screenshot." },
    "w6.run": { zh: "运行冒烟测试", en: "Run smoke test" },
    "w6.running": { zh: "测试运行中…", en: "Smoke test running…" },
    "w6.rerun": { zh: "重新测试", en: "Run again" },
    "w6.success": { zh: "全部通过 — 一切就绪", en: "All passed — you are ready" },
    "w6.fail_bridge": { zh: "桥接不可达 — 回到上一步启动桥接。", en: "Bridge unreachable — go back and start it." },
    "w6.fail_game": { zh: "游戏未进入存档 — 启动游戏并进入一个存档后重试。", en: "Game not in a save — launch the game and enter a save, then retry." },
    "w6.fail_other": { zh: "部分检查失败 — 展开原始响应排查。", en: "Some checks failed — expand the raw response to investigate." },
    "w6.expand_raw": { zh: "展开原始 JSON", en: "Expand raw JSON" },
    "w6.copy_report": { zh: "复制报告", en: "Copy report" },
    "w6.to_console": { zh: "进入控制台", en: "Open console" },

    // ── console / settings placeholders (T4 fills) ──
    "console.title": { zh: "控制台", en: "Console" },
    "console.placeholder": { zh: "控制台由 T4 提供（GUI.mountConsole）。", en: "Console is provided by T4 (GUI.mountConsole)." },
    "settings.title": { zh: "设置", en: "Settings" },
    "settings.placeholder": { zh: "设置视图由 T4 提供（GUI.mountSettings）。", en: "Settings view is provided by T4 (GUI.mountSettings)." },

    // ── log view ──
    "log.level.all": { zh: "全部", en: "All" },
    "log.level.info": { zh: "信息", en: "Info" },
    "log.level.warn": { zh: "警告", en: "Warn" },
    "log.level.error": { zh: "错误", en: "Error" },
    "log.follow": { zh: "跟随", en: "Follow" },
    "log.clear": { zh: "清屏", en: "Clear" },
    "log.download": { zh: "下载", en: "Download" },
    "log.empty": { zh: "暂无日志", en: "No log lines yet" },
    "log.jump": { zh: "跳到日志行 {n}", en: "Jump to log line {n}" },

    // ── toasts / dialogs ──
    "toast.copied": { zh: "已复制到剪贴板", en: "Copied to clipboard" },
    "toast.copy_failed": { zh: "复制失败 — 请手动选择文本", en: "Copy failed — select the text manually" },
    "confirm.title": { zh: "确认操作", en: "Confirm" },
    "confirm.uninstall.body": { zh: "将删除 mods 目录中的 shapez-ai-bridge.js（及其 .bak 备份）；游戏内 mod 设置会保留在 saves 目录。", en: "Will remove shapez-ai-bridge.js (and .bak backups) from the mods folder; in-game mod settings stay in the saves folder." },
    "confirm.reset.body": { zh: "配置将恢复为默认值，未保存的修改丢失。", en: "Config returns to defaults; unsaved changes are lost." },

    // ── signal chain ──
    "chain.game": { zh: "游戏", en: "Game" },
    "chain.mod": { zh: "Mod", en: "Mod" },
    "chain.bridge": { zh: "桥接", en: "Bridge" },
    "chain.ai": { zh: "AI", en: "AI" },

    // ── probe / misc ──
    "misc.unknown_error": { zh: "未知错误", en: "Unknown error" },
    "misc.backend_error": { zh: "后端返回了错误", en: "The backend returned an error" },
};

let LANG = (navigator.language || "zh-CN").toLowerCase().startsWith("zh") ? "zh" : "en";
try { const saved = localStorage.getItem("gui.lang"); if (saved === "zh" || saved === "en") LANG = saved; } catch { /* file:// may block */ }

const listeners = new Set();

export function getLang() { return LANG; }

export function setLang(lang) {
    if (lang !== "zh" && lang !== "en") return;
    LANG = lang;
    try { localStorage.setItem("gui.lang", lang); } catch { /* ignore */ }
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    for (const cb of listeners) { try { cb(lang); } catch { /* ignore */ } }
}

export function onLangChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }

export function t(key, vars) {
    const entry = DICT[key];
    let s = entry ? (LANG === "zh" ? entry.zh : entry.en) : key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
}

/** Apply translations to all [data-i18n] and [data-i18n-attr] nodes under root. */
export function applyI18n(root = document) {
    for (const el of root.querySelectorAll("[data-i18n]")) {
        el.textContent = t(el.getAttribute("data-i18n"));
    }
    for (const el of root.querySelectorAll("[data-i18n-placeholder]")) {
        el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder")));
    }
    for (const el of root.querySelectorAll("[data-i18n-aria]")) {
        el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria")));
    }
}

export const KEYS = Object.keys(DICT);
export default { t, setLang, getLang, onLangChange, applyI18n, KEYS };
