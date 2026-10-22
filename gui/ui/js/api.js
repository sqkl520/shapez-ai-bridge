/**
 * api.js — GUI HTTP client (frozen contract: DESIGN-PLAN §2 + §3.7).
 *
 * Exports `api` with methods {env, envReprobe, install, uninstall, getConfig,
 * saveConfig, resetConfig, bridgeStart, bridgeStop, bridgeStatus, logsSince,
 * smokeStart, smokeStatus, mcpConfig, openTarget, version, events:{on,off}}.
 * Failures throw ApiError{code,message,hint,status,detail,log_ref}.
 *
 * ?mock=1 switches to a built-in mock — zero backend required, works from
 * file:// as well as http:// (relative imports, no fetch to absent server).
 * Mock delay is intentionally short and deterministic; timers (not
 * Promise.resolve chains) so headless virtual-time-budget captures final state.
 */

const params = new URLSearchParams(location.search);
export const MOCK = params.get("mock") === "1";

const TOKEN = (document.querySelector('meta[name="gui-token"]')?.content || "");
// Same-origin base. When served by gui/server.mjs the page is at "/", so "/api/x"
// resolves to the server. Under file:// fetch() would fail anyway — mock mode is
// the only supported path there and it never calls fetch.
const BASE = "";

export class ApiError extends Error {
    constructor({ code, message, message_en, hint, detail, log_ref, status }) {
        super(message || message_en || code || "request failed");
        this.name = "ApiError";
        this.code = code || "INTERNAL";
        this.message_zh = message || "";
        this.message_en = message_en || "";
        this.hint = hint || "";
        this.detail = detail ?? null;
        this.log_ref = log_ref ?? null;
        this.status = status ?? 0;
    }
}

async function req(method, path, body, opts = {}) {
    let res;
    const headers = {};
    if (TOKEN) headers["X-GUI-Token"] = TOKEN;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    try {
        res = await fetch(BASE + path, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: opts.signal,
        });
    } catch (e) {
        throw new ApiError({
            code: "NETWORK",
            message: "无法连接 GUI 后端（后端可能已停止或未启动）",
            message_en: "Cannot reach the GUI backend",
            hint: "确认 gui/server.mjs 正在运行，然后重试",
            detail: String(e && e.message || e),
            status: 0,
        });
    }
    let json = null;
    try { json = await res.json(); } catch { /* non-JSON body */ }
    if (!res.ok) {
        const err = (json && json.error) || {};
        throw new ApiError({ ...err, status: res.status });
    }
    return json;
}

// ─────────────────────────────────────────────────────────────── mock ──
// Every endpoint returns contract-shaped data (DESIGN-PLAN §2), including
// error-code samples so wizard error paths are demo-able without a backend.

const MOCK_STATE = {
    running: false, pid: null, startedAt: 0,
    modConnected: false, installed: true,
    smokeRunId: 0,
    config: {
        port: 7899, token: null, read_only: false, snapshot_dir: "./snapshots",
        log_level: "info", rpc_timeout_ms: 30000, long_timeout_ms: 180000,
    },
    // Query-param error injection, e.g. ?mock_error=install_failed
    errorMode: params.get("mock_error") || "",
    // ?mock_no_game=1 simulates a machine without shapez.io (W2 yellow banner path)
    noGame: params.get("mock_no_game") === "1",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (n) => Math.floor(Math.random() * n);

const MOCK_LOGS = { n: 0, lines: [] };
function mockPushLog(kind, level, text) {
    MOCK_LOGS.n += 1;
    MOCK_LOGS.lines.push({ n: MOCK_LOGS.n, kind, stream: level === "error" ? "err" : "out", level, text, ts: Date.now() });
}

const MOCK_ENV = () => {
    const e = {
        node: { version: "v24.14.0", ok: true, path: "C:\\Program Files\\nodejs\\node.exe" },
        os: { platform: "win32", release: "10.0.19045" },
        repo: { root: "D:\\shapez-ai-bridge", mod_source_exists: true, mod_version: "0.1.0" },
        game: { found: true, dir: "D:\\Steam\\steamapps\\common\\shapez.io", source: "vdf", running: false, exe_ok: true, asar_ok: true, steam_installed: true },
        mods_dir: { path: "C:\\Users\\you\\AppData\\Roaming\\shapez.io\\mods", exists: true, writable: true },
        mod: { installed: true, path: "C:\\Users\\you\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js", sha256_repo: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90", sha256_installed: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90", match: true, backup_count: 1 },
        port: { configured: MOCK_STATE.config.port, busy: false, owner_pid: null },
        browser: { found: true, path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", kind: "chrome" },
        saves_dir: { path: "C:\\Users\\you\\AppData\\Roaming\\shapez.io\\saves", modsettings_found: true },
        gui_state: { wizard_completed: false, game_dir_override: null },
    };
    if (MOCK_STATE.noGame) {
        e.game = { found: false, dir: null, source: null, running: false, exe_ok: false, asar_ok: false, steam_installed: true };
    }
    return e;
};

const MOCK_STATUS = () => {
    if (!MOCK_STATE.running) {
        return { running: false, managed: false, pid: null, port: MOCK_STATE.config.port, healthy: false, mod_connected: false, uptime_s: null, in_game: null, game_version: null, mod_version: null, hub_level: null, paused: null, allow_write: null, last_error: null };
    }
    const up = Math.max(0, Math.round((Date.now() - MOCK_STATE.startedAt) / 1000));
    return {
        running: true, managed: true, pid: 4242, port: MOCK_STATE.config.port, healthy: true,
        mod_connected: MOCK_STATE.modConnected || up > 6,
        uptime_s: up, in_game: MOCK_STATE.modConnected || up > 6, game_version: "1.5.6", mod_version: "0.1.0",
        hub_level: MOCK_STATE.modConnected || up > 6 ? 12 : null, paused: false, allow_write: true, last_error: null,
    };
};

const MOCK_SMOKE_CHECKS = [
    { n: 1, name: "bridge reachable", name_zh: "桥接可达", state: "pending", detail: "" },
    { n: 2, name: "game connected", name_zh: "游戏已连接", state: "pending", detail: "" },
    { n: 3, name: "world state readable", name_zh: "世界状态可读取", state: "pending", detail: "" },
    { n: 4, name: "rpc round-trip", name_zh: "RPC 往返", state: "pending", detail: "" },
    { n: 5, name: "screenshot grab", name_zh: "截图抓取", state: "pending", detail: "" },
];
let MOCK_SMOKE = { running: false, run_id: 0, exit_code: null, checks: MOCK_SMOKE_CHECKS.map((c) => ({ ...c })), hint: null, finished_at: null };

function mockStartSmoke() {
    MOCK_SMOKE = { running: true, run_id: MOCK_STATE.smokeRunId, exit_code: null, checks: MOCK_SMOKE_CHECKS.map((c) => ({ ...c, state: "pending" })), hint: null, finished_at: null };
    emit("smoke_status", MOCK_SMOKE);
    const steps = [
        [300, 0], [900, 1], [1500, 2], [2100, 3], [2900, 4],
    ];
    for (const [t, i] of steps) {
        setTimeout(() => {
            if (MOCK_SMOKE.run_id !== MOCK_STATE.smokeRunId) return;
            MOCK_SMOKE.checks[i].state = "pass";
            MOCK_SMOKE.checks[i].detail = "ok";
            emit("smoke_status", MOCK_SMOKE);
        }, t);
    }
    setTimeout(() => {
        if (MOCK_SMOKE.run_id !== MOCK_STATE.smokeRunId) return;
        MOCK_SMOKE.running = false;
        MOCK_SMOKE.exit_code = 0;
        MOCK_SMOKE.finished_at = Date.now();
        emit("smoke_status", MOCK_SMOKE);
    }, 3400);
}

let _mockPump = null;
function mockPumpStatus() {
    if (_mockPump) return;
    _mockPump = setInterval(() => {
        if (!MOCK_STATE.running) { clearInterval(_mockPump); _mockPump = null; return; }
        emit("bridge_status", MOCK_STATUS());
    }, 2000);
}

function mockError(code) {
    const catalog = {
        PORT_BUSY: { status: 409, error: { code: "PORT_BUSY", message: `端口 ${MOCK_STATE.config.port} 已被进程占用`, message_en: "Port busy", hint: "在配置中换一个空闲端口", detail: { pid: 8123 }, log_ref: null } },
        INSTALL_FAILED: { status: 500, error: { code: "INSTALL_FAILED", message: "安装脚本以非零状态退出 (exit 1)", message_en: "Install script failed", hint: "mods 目录只读？检查权限或杀软占用", detail: { exit_code: 1 }, log_ref: 17 } },
        BRIDGE_START_FAILED: { status: 500, error: { code: "BRIDGE_START_FAILED", message: "桥接进程启动后立即退出", message_en: "Bridge exited right after start", hint: "展开日志查看原因", detail: { reason: "exited" }, log_ref: 23 } },
        CONFIG_INVALID: { status: 400, error: { code: "CONFIG_INVALID", message: "配置无效", message_en: "Config invalid", hint: "按字段提示修正", detail: { fields: { port: "必须为 1024–65535 的整数" } }, log_ref: null } },
        CANNOT_STOP_FOREIGN: { status: 409, error: { code: "CANNOT_STOP_FOREIGN", message: "该桥接由外部终端启动", message_en: "Bridge started externally", hint: "请在原终端 Ctrl-C 停止", detail: { pid: 991 }, log_ref: null } },
    };
    const m = catalog[code] || catalog.INTERNAL || { status: 500, error: { code: "INTERNAL", message: "内部错误", message_en: "Internal error", hint: "", detail: null, log_ref: null } };
    return Promise.reject(new ApiError({ ...m.error, status: m.status }));
}

const MOCK_API = {
    async env(body) {
        await sleep(420);
        const e = MOCK_ENV();
        if (body && body.game_dir) {
            if (!/[\\/]shapez/i.test(body.game_dir)) {
                throw new ApiError({ code: "INVALID_PARAM", message: "该目录不像 shapez.io 安装目录", message_en: "Not a shapez.io dir", hint: "应包含 shapezio.exe 与 resources/app.asar", detail: { reason: "not_shapez_dir" }, log_ref: null, status: 400 });
            }
            e.game.dir = body.game_dir; e.game.source = "manual";
            e.game.found = true; e.game.exe_ok = true; e.game.asar_ok = true;
        }
        e.port.configured = MOCK_STATE.config.port;
        return e;
    },
    // POST /api/env — same shape as env(); validates + persists game_dir
    async envReprobe(body) { return MOCK_API.env(body); },
    async install() {
        mockPushLog("install", "info", "[INFO] shapez-ai-bridge install.ps1");
        await sleep(180);
        if (MOCK_STATE.errorMode === "install_failed") {
            const burst = [
                [240, "info", "[INFO] checking mods dir…"],
                [420, "error", "[FAIL] Cannot write to mods directory (access denied)"],
                [600, "note", "[NOTE] 备份目录不可写"],
            ];
            for (const [t, lvl, txt] of burst) {
                await sleep(t === 240 ? 60 : 160);
                mockPushLog("install", lvl, txt);
            }
            return mockError("INSTALL_FAILED");
        }
        const burst = [
            [0, "info", "[INFO] Source: src/mod/shapez-ai-bridge.js"],
            [120, "ok", "[OK] mods dir writable"],
            [260, "info", "[INFO] Backup: shapez-ai-bridge.js.bak-20261021-220114"],
            [420, "ok", "[OK] Copied shapez-ai-bridge.js (sha256 a1b2c3d4…)"],
            [560, "ok", "[OK] Install complete"],
        ];
        for (const [t, lvl, txt] of burst) {
            await sleep(t === 0 ? 60 : 140);
            mockPushLog("install", lvl, txt);
        }
        MOCK_STATE.installed = true;
        return { ok: true, exit_code: 0, target: "C:\\Users\\you\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js", sha256: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90", backup: "shapez-ai-bridge.js.bak-20261021-220114", lines_n: 5 };
    },
    async uninstall(body) {
        await sleep(500);
        return { ok: true, removed: ["C:\\Users\\you\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js"], kept_modsettings: !(body && body.clean_modsettings), notes: ["游戏内 mod 设置残留于 saves 目录"] };
    },
    async getConfig() {
        await sleep(200);
        return {
            config: { ...MOCK_STATE.config },
            defaults: { port: 7777, token: null, read_only: false, snapshot_dir: "./snapshots", log_level: "info", rpc_timeout_ms: 30000, long_timeout_ms: 180000 },
            file: { path: "D:\\shapez-ai-bridge\\bridge.config.json", exists: false, valid: true },
            warnings: ["配置文件不存在，已回落到默认值"],
        };
    },
    async saveConfig(cfg) {
        await sleep(380);
        if (MOCK_STATE.errorMode === "config_invalid") return mockError("CONFIG_INVALID");
        if (MOCK_STATE.errorMode === "port_busy") return mockError("PORT_BUSY");
        MOCK_STATE.config = { ...MOCK_STATE.config, ...cfg };
        return { ok: true, config: { ...MOCK_STATE.config }, bridge_restarted: false };
    },
    async resetConfig() {
        await sleep(300);
        MOCK_STATE.config = { port: 7777, token: null, read_only: false, snapshot_dir: "./snapshots", log_level: "info", rpc_timeout_ms: 30000, long_timeout_ms: 180000 };
        return { ok: true, config: { ...MOCK_STATE.config } };
    },
    async bridgeStart() {
        await sleep(650);
        if (MOCK_STATE.errorMode === "port_busy") return mockError("PORT_BUSY");
        if (MOCK_STATE.errorMode === "start_failed") {
            mockPushLog("bridge", "error", "[err] Error: listen EADDRINUSE :::7899");
            return mockError("BRIDGE_START_FAILED");
        }
        if (MOCK_STATE.running) return { ok: true, already_running: true, status: MOCK_STATUS() };
        MOCK_STATE.running = true;
        MOCK_STATE.startedAt = Date.now();
        mockPushLog("bridge", "info", `[bridge] listening on 127.0.0.1:${MOCK_STATE.config.port}`);
        mockPushLog("bridge", "info", "[bridge] waiting for game mod connection…");
        mockPumpStatus();
        return { ok: true, status: MOCK_STATUS() };
    },
    async bridgeStop() {
        await sleep(420);
        if (MOCK_STATE.errorMode === "foreign") return mockError("CANNOT_STOP_FOREIGN");
        const was = MOCK_STATE.running;
        MOCK_STATE.running = false; MOCK_STATE.modConnected = false;
        emit("bridge_status", MOCK_STATUS());
        return { ok: true, stopped: was };
    },
    async bridgeStatus() { await sleep(120); return MOCK_STATUS(); },
    async logsSince(kind, since) {
        await sleep(60);
        const lines = MOCK_LOGS.lines.filter((l) => l.kind === kind && l.n > (since || 0));
        return { lines, next_since: MOCK_LOGS.n };
    },
    async smokeStart() {
        await sleep(280);
        if (MOCK_SMOKE.running) throw new ApiError({ code: "SMOKE_BUSY", message: "冒烟测试已在运行", message_en: "Smoke already running", hint: "", detail: null, log_ref: null, status: 409 });
        MOCK_STATE.smokeRunId += 1;
        mockStartSmoke();
        return { ok: true, run_id: MOCK_STATE.smokeRunId };
    },
    async smokeStatus() { await sleep(80); return JSON.parse(JSON.stringify(MOCK_SMOKE)); },
    async mcpConfig() {
        await sleep(200);
        return {
            config: { mcpServers: { shapez: { command: "node", args: ["D:/shapez-ai-bridge/src/mcp/server.mjs"], env: { SHAPEZ_BRIDGE_URL: `http://127.0.0.1:${MOCK_STATE.config.port}` } } } },
            claude_desktop_config_path: "C:\\Users\\you\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
            instructions_zh: "将以下 JSON 合并进 Claude Desktop 配置后重启 Claude Desktop。",
            instructions_en: "Merge this JSON into your Claude Desktop config and restart it.",
        };
    },
    async openTarget(target) {
        await sleep(240);
        const allowed = ["mods_dir", "snapshots_dir", "saves_dir", "repo_root", "mcp_config_file", "steam_store", "steam_run", "readme"];
        if (!allowed.includes(target)) throw new ApiError({ code: "INVALID_PARAM", message: "未知目标", message_en: "Unknown target", hint: "", detail: null, log_ref: null, status: 400 });
        return { ok: true, opened: true };
    },
    async version() {
        await sleep(120);
        return { gui: "0.1.0", repo: "0.1.0", mod: "0.1.0", protocol: 1, compat_games: ["1.5.6"], node: { min: 20, cur: "v24.14.0" } };
    },
};

// ─────────────────────────────────────────────────────────── real API ──

const real = {
    env: () => req("GET", "/api/env"),
    envReprobe: (body) => req("POST", "/api/env", body || {}),
    install: (body) => req("POST", "/api/install", body || {}),
    uninstall: (body) => req("POST", "/api/uninstall", body || {}),
    getConfig: () => req("GET", "/api/config"),
    saveConfig: (cfg) => req("POST", "/api/config", cfg),
    resetConfig: () => req("POST", "/api/config/reset", {}),
    bridgeStart: () => req("POST", "/api/bridge/start", {}),
    bridgeStop: () => req("POST", "/api/bridge/stop", {}),
    bridgeStatus: () => req("GET", "/api/bridge/status"),
    logsSince: (kind, since) => req("GET", `/api/logs?kind=${encodeURIComponent(kind)}&since=${since || 0}`),
    smokeStart: (body) => req("POST", "/api/smoke", body || {}),
    smokeStatus: () => req("GET", "/api/smoke/status"),
    mcpConfig: () => req("GET", "/api/mcp-config"),
    openTarget: (target) => req("POST", "/api/open", { target }),
    version: () => req("GET", "/api/version"),
};

// ───────────────────────────────────────────────────────────── events ──

const EVENTS = { on, off };

let _es = null;
const _subs = new Map(); // type -> Set<cb>

function ensureES() {
    if (MOCK || _es) return;
    if (typeof EventSource === "undefined") return;
    const q = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : "";
    try {
        _es = new EventSource(`/api/events${q}`);
        for (const type of ["log", "bridge_status", "smoke_status", "install_done", "toast", "open"]) {
            _es.addEventListener(type, (ev) => {
                let data = null;
                try { data = JSON.parse(ev.data); } catch { data = ev.data; }
                emit(type, data);
            });
        }
        _es.onopen = () => emit("open", {});
        _es.onerror = () => emit("error", {});
    } catch { _es = null; }
}

function on(type, cb) {
    if (!_subs.has(type)) { _subs.set(type, new Set()); if (!MOCK) ensureES(); }
    _subs.get(type).add(cb);
    return () => off(type, cb);
}
function off(type, cb) { _subs.get(type)?.delete(cb); }
function emit(type, data) { for (const cb of _subs.get(type) || []) { try { cb(data); } catch { /* subscriber bug must not break others */ } } }

export const api = MOCK
    ? { ...MOCK_API, events: EVENTS, mock: true }
    : { ...real, events: EVENTS, mock: false };

/** Test/demo hook: flip mock error injection at runtime (wizard "尝试失败路径" affordance). */
export function setMockError(mode) { MOCK_STATE.errorMode = mode || ""; }

export default api;
