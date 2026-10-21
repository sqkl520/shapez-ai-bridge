/**
 * shapez-ai-bridge — 桥接服务器（协议 §1/§2/§3/§7/§11）。
 *
 * 职责：在 127.0.0.1 上监听，作为「游戏 mod」与「外部工具/MCP/Agent」之间的中介：
 *
 *   游戏 mod (WS 客户端) ──/mod──┐
 *                                ├── bridge.mjs ── HTTP /rpc, /health, /status
 *   工具 / MCP / Agent ──/client─┘                + WS /client（事件推送）
 *
 * 零 npm 依赖：手写 RFC6455 服务端子集（mod 与 client 都连服务端）。
 * 本实现的核心 WS 解析逻辑与 test/live_bridge.mjs 同源，且已对真实游戏验证。
 *
 * 配置：bridge.config.json（同目录），CLI 参数可覆盖。见 §11.5。
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const PROTOCOL = 1;

// ─────────────────────────── 配置 ───────────────────────────

function loadConfig() {
    const cfg = {
        port: 7777,
        token: null,
        read_only: false,
        snapshot_dir: "./snapshots",
        log_level: "info",
        rpc_timeout_ms: 30000,
        long_timeout_ms: 180000,
    };
    // 1) bridge.config.json（脚本目录 或 仓库根）
    for (const p of [path.join(__dirname, "bridge.config.json"), path.join(ROOT, "bridge.config.json")]) {
        if (fs.existsSync(p)) {
            try {
                Object.assign(cfg, JSON.parse(fs.readFileSync(p, "utf8")));
                break;
            } catch (e) {
                console.error("[bridge] failed to parse " + p + ": " + e.message);
            }
        }
    }
    // 2) CLI 覆盖
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--port" && args[i + 1]) cfg.port = parseInt(args[++i], 10);
        else if (a === "--token" && args[i + 1]) cfg.token = args[++i];
        else if (a === "--read-only") cfg.read_only = true;
        else if (a === "--snapshot-dir" && args[i + 1]) cfg.snapshot_dir = args[++i];
        else if (a === "--config" && args[i + 1]) {
            const p = args[++i];
            try {
                Object.assign(cfg, JSON.parse(fs.readFileSync(p, "utf8")));
            } catch (e) {
                console.error("[bridge] failed to parse " + p + ": " + e.message);
                process.exit(1);
            }
        } else if (a === "--log-level" && args[i + 1]) cfg.log_level = args[++i];
    }
    return cfg;
}

const CFG = loadConfig();
const SNAPSHOT_DIR = path.isAbsolute(CFG.snapshot_dir) ? CFG.snapshot_dir : path.resolve(ROOT, CFG.snapshot_dir);

const LEVELS = { debug: 0, info: 1, warn: 2 };
function log(level, ...a) {
    if (LEVELS[level] < LEVELS[CFG.log_level]) return;
    console.error(`[bridge/${level}]`, ...a);
}
const debug = (...a) => log("debug", ...a);
const info = (...a) => log("info", ...a);
const warn = (...a) => log("warn", ...a);

// 兼容表（游戏版本白名单，硬失败用）
function loadCompat() {
    const p = path.join(ROOT, "compat.json");
    if (fs.existsSync(p)) {
        try {
            return JSON.parse(fs.readFileSync(p, "utf8"));
        } catch (e) {
            warn("compat.json parse failed, using builtin:", e.message);
        }
    }
    return { protocol: 1, mods: { "0.1.x": { game: ["1.5.6"], protocol: 1 } } };
}
const COMPAT = loadCompat();
const SUPPORTED_GAMES = new Set();
for (const k in COMPAT.mods || {}) {
    for (const g of COMPAT.mods[k].game || []) SUPPORTED_GAMES.add(g);
}

// ─────────────────────── 安全：Origin 校验（红队实证过：无校验时任意网页可遥控游戏） ───────────────────────
// 威胁模型：浏览器里的任意网页可以发起 WebSocket（WS 无同源策略）和
// text/plain POST（免 CORS 预检）连到 127.0.0.1:7777，从而遥控游戏。
// 合法调用方只有两类：
//   - 游戏 mod：Electron 渲染进程，页面是 file:// → Origin 为 "file://" 或以 file:// 开头
//   - 本地脚本/MCP/工具：Node 的 WebSocket/fetch 不发 Origin（或发 "null"）
// 因此：拒绝一切 http(s) 来源的 Origin。
function originAllowed(req) {
    const origin = req.headers["origin"];
    if (!origin) return true; // Node 客户端（mod 之外的本地工具）
    if (origin === "null") return true; // file:// 的某些 UA 上报 null
    if (origin.startsWith("file://")) return true; // Electron file:// 页面（游戏 mod）
    return false; // 网页（http/https 来源）——拒绝
}

function rejectBadOrigin(res) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(
        JSON.stringify({
            error: {
                code: 403,
                message: "forbidden_origin: browser pages are not allowed to talk to this bridge",
                data: { code_name: "forbidden_origin", detail: "Only the game mod (file://) and local non-browser clients may connect" },
            },
        })
    );
}

// ─────────────────────── 存档目录与快照 ───────────────────────

function getSavesDir() {
    const roaming =
        process.env.APPDATA ||
        (process.platform === "darwin"
            ? (process.env.HOME || "") + "/Library/Preferences"
            : (process.env.HOME || "") + "/.local/share");
    return path.join(roaming, "shapez.io", "saves");
}
const SAVES_DIR = getSavesDir();

function ensureSnapshotDir() {
    if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
}

// ─────────────────────── 连接状态 ───────────────────────

/** 唯一 mod 连接：{ socket, buffer, fragments, hello, lastSeen, pending: Map<id,{resolve,reject,timer}> } */
let mod = null;
/** 客户端连接（/client 或 HTTP 短连接由请求自身处理） */
const clients = new Set();

let nextRpcId = 1;

// ─────────────────────── RFC6455 服务端 ───────────────────────

function acceptKey(key) {
    return crypto.createHash("sha1").update(key + GUID).digest("base64");
}

function upgrade(req, socket) {
    const key = req.headers["sec-websocket-key"];
    if (!key) {
        socket.destroy();
        return null;
    }
    socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
            "Upgrade: websocket\r\n" +
            "Connection: Upgrade\r\n" +
            "Sec-WebSocket-Accept: " +
            acceptKey(key) +
            "\r\n\r\n"
    );
    return { socket, buffer: Buffer.alloc(0), fragments: [], hello: null, lastSeen: Date.now(), pending: new Map() };
}

/** 解析并派发入站字节流（客户端 → 服务端：必带掩码） */
function feed(conn, chunk, onText) {
    conn.buffer = Buffer.concat([conn.buffer, chunk]);
    for (;;) {
        const buf = conn.buffer;
        if (buf.length < 2) return;
        const fin = (buf[0] & 0x80) !== 0;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            off = 4;
        } else if (len === 127) {
            if (buf.length < 10) return;
            len = Number(buf.readBigUInt64BE(2));
            off = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (buf.length < off + maskLen + len) return;
        let payload = buf.subarray(off + maskLen, off + maskLen + len);
        if (masked) {
            const mask = buf.subarray(off, off + 4);
            payload = Buffer.from(payload);
            for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        }
        conn.buffer = buf.subarray(off + maskLen + len);
        conn.lastSeen = Date.now();

        if (opcode === 0x8) {
            try {
                conn.socket.end();
            } catch {}
            return;
        }
        if (opcode === 0x9) {
            writeFrame(conn.socket, 0xa, payload);
            continue;
        }
        if (opcode === 0xa) continue;
        if (opcode === 0x0) {
            conn.fragments.push(payload);
            if (fin) {
                const full = Buffer.concat(conn.fragments);
                conn.fragments = [];
                onText(conn, full.toString("utf8"));
            }
            continue;
        }
        if (!fin) {
            conn.fragments = [payload];
            continue;
        }
        if (opcode === 0x1) onText(conn, payload.toString("utf8"));
    }
}

function writeFrame(socket, opcode, payload) {
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[1] = len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try {
        socket.write(Buffer.concat([header, payload]));
        return true;
    } catch (e) {
        debug("writeFrame failed:", e.message);
        return false;
    }
}

function sendJson(conn, obj) {
    return writeFrame(conn.socket, 0x1, Buffer.from(JSON.stringify(obj)));
}

// ─────────────────────── 错误工具 ───────────────────────

const ERROR_NAMES = {
    "-32700": "parse_error",
    "-32601": "method_not_found",
    "-32602": "invalid_params",
    1001: "protocol_version_mismatch",
    1002: "game_version_mismatch",
    1003: "not_in_game",
    1004: "read_only",
    1005: "no_connection",
    2001: "invalid_action",
    2002: "game_rejected",
    2003: "mod_error",
    2004: "timeout",
    2005: "await_timeout",
    2006: "blueprint_incompatible",
};

function rpcError(code, detail, hint) {
    const data = { code_name: ERROR_NAMES[code] || "error", detail: detail ?? null };
    if (hint) data.hint = hint;
    const err = new Error((ERROR_NAMES[code] || "error") + ": " + detail);
    err.rpc = { code, message: (ERROR_NAMES[code] || "error") + ": " + detail, data };
    return err;
}

// ─────────────────────── 只读模式（§11.4） ───────────────────────

const WRITE_OPS = new Set([
    "place",
    "place_path",
    "delete",
    "bulk_delete",
    "paste_blueprint",
    "set_speed",
    "step",
    "await",
    "save",
    "load",
    "new_game",
]);
const READ_ONLY_ALLOWED_OPS = new Set(["noop", "camera", "export_blueprint"]);
const WRITE_METHODS = new Set(["save_now", "load_save", "new_game", "snapshot_save", "snapshot_load"]);

function checkReadOnly(method, params) {
    if (!CFG.read_only) return null;
    if (method === "act") {
        const op = params && params.op;
        if (op && !READ_ONLY_ALLOWED_OPS.has(op)) {
            return rpcError(1004, `op '${op}' is blocked by read_only mode`, "Restart the bridge without --read-only to allow writes");
        }
        return null;
    }
    if (method === "batch") {
        const actions = (params && params.actions) || [];
        for (const a of actions) {
            const op = a && a.op;
            if (op && !READ_ONLY_ALLOWED_OPS.has(op)) {
                return rpcError(1004, `batch contains write op '${op}' — blocked by read_only mode`, "Restart the bridge without --read-only to allow writes");
            }
        }
        return null;
    }
    if (WRITE_METHODS.has(method)) {
        return rpcError(1004, `method '${method}' is blocked by read_only mode`, "Restart the bridge without --read-only to allow writes");
    }
    return null;
}

// ─────────────────────── RPC 转发（§3） ───────────────────────

function needsLongTimeout(method, params) {
    if (method === "act" && params && (params.op === "step" || params.op === "await")) return true;
    if (method === "batch" && params && Array.isArray(params.actions)) {
        return params.actions.some(a => a && (a.op === "step" || a.op === "await"));
    }
    return false;
}

/** 把一次 RPC 发给 mod，等响应（Promise） */
function callMod(method, params) {
    return new Promise((resolve, reject) => {
        if (!mod || !mod.hello) {
            reject(rpcError(1005, "No game mod is connected", "Start shapez.io (with the mod installed) and load a savegame"));
            return;
        }
        const id = nextRpcId++;
        const timeoutMs = needsLongTimeout(method, params) ? CFG.long_timeout_ms : CFG.rpc_timeout_ms;
        // Protocol §7: an `await` that runs out of wall-clock budget is a 2005
        // (condition not met — adjust strategy), not a 2004 (something is broken).
        // Also covers a batch whose actions include an await.
        const isAwait =
            (method === "act" && params && params.op === "await") ||
            (method === "batch" && params && Array.isArray(params.actions) && params.actions.some(a => a && a.op === "await"));
        const timer = setTimeout(() => {
            mod.pending.delete(id);
            if (isAwait) {
                reject(rpcError(2005, `await exceeded the bridge's ${timeoutMs}ms budget before its condition was met`, "Not an error state: raise timeout_ticks or adjust the plan"));
            } else {
                reject(rpcError(2004, `mod did not respond to '${method}' within ${timeoutMs}ms`, "The game may be frozen or busy; check the game window"));
            }
        }, timeoutMs);
        mod.pending.set(id, { resolve, reject, timer });
        const ok = sendJson(mod, { jsonrpc: "2.0", id, method, params: params || {} });
        if (!ok) {
            clearTimeout(timer);
            mod.pending.delete(id);
            reject(rpcError(1005, "Failed to write to the mod socket"));
        }
    });
}

/** 客户端 facing：只读检查 → 快照特殊方法 → 转发 */
async function handleClientRpc(method, params) {
    const ro = checkReadOnly(method, params);
    if (ro) throw ro;

    if (method === "snapshot_save") return await snapshotSave(params || {});
    if (method === "snapshot_load") return await snapshotLoad(params || {});
    if (method === "health") {
        return { ok: true, mod_connected: !!(mod && mod.hello), uptime_s: Math.round(process.uptime()) };
    }
    return await callMod(method, params);
}

// ─────────────────────── 快照（§11.3） ───────────────────────

/**
 * 校验快照名（红队实证：未过滤时 `..\` 可穿越目录、在快照目录外读写任意文件）。
 * 只允许字母数字、点、下划线、连字符与空格；上限 100 字符；不允许路径分隔符。
 * 返回 null 表示非法。
 */
function sanitizeSnapshotName(name) {
    if (typeof name !== "string") return null;
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 100) return null;
    if (trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\")) return null;
    if (trimmed.includes(":")) return null; // drive letters / NTFS streams
    if (!/^[A-Za-z0-9 ._-]+$/.test(trimmed)) return null;
    return trimmed;
}

/** 解析并确认路径确实落在期望目录内（纵深防御：即使名字通过了白名单，也要 resolve 校验） */
function resolveInsideDir(dir, filename) {
    const base = path.resolve(dir);
    const full = path.resolve(base, filename);
    if (full !== base && !full.startsWith(base + path.sep)) return null;
    return full;
}

async function snapshotSave(p) {
    ensureSnapshotDir();
    const res = await callMod("save_now", {});
    const internalId = res.internal_id;
    if (!internalId) {
        throw rpcError(2003, "save_now did not return internal_id", "Check game logs; the save interface may not be ready");
    }
    const src = path.join(SAVES_DIR, `savegame-${internalId}.bin`);
    if (!fs.existsSync(src)) {
        throw rpcError(2003, `savegame file not found: ${src}`, "The bridge and the game must run on the same machine/user account");
    }
    const ts = new Date();
    const stamp =
        ts.getFullYear() +
        String(ts.getMonth() + 1).padStart(2, "0") +
        String(ts.getDate()).padStart(2, "0") +
        "-" +
        String(ts.getHours()).padStart(2, "0") +
        String(ts.getMinutes()).padStart(2, "0") +
        String(ts.getSeconds()).padStart(2, "0");
    const rawName = p.name === undefined || p.name === null ? `auto-${stamp}-lv${res.level ?? "?"}` : p.name;
    const name = sanitizeSnapshotName(rawName);
    if (!name) {
        throw rpcError(2001, "invalid snapshot name", "Use letters, digits, spaces, dot, underscore or hyphen (max 100 chars; no path separators)");
    }
    const dst = resolveInsideDir(SNAPSHOT_DIR, `${name}.bin`);
    if (!dst) throw rpcError(2001, "snapshot name resolves outside the snapshot directory");
    fs.copyFileSync(src, dst);
    const sidecar = {
        name,
        internal_id: internalId,
        level: res.level ?? null,
        saved_at: ts.toISOString(),
        game_version: (mod && mod.hello && mod.hello.game_version) || null,
    };
    fs.writeFileSync(resolveInsideDir(SNAPSHOT_DIR, `${name}.json`), JSON.stringify(sidecar, null, 2));
    info(`snapshot saved: ${name} (${internalId}, lv${res.level})`);
    return { ok: true, name, path: dst, internal_id: internalId, level: res.level ?? null };
}

async function snapshotLoad(p) {
    ensureSnapshotDir();
    const name = sanitizeSnapshotName(p.name);
    if (!name) {
        throw rpcError(2001, "snapshot_load requires a valid 'name'", "Letters, digits, spaces, dot, underscore, hyphen only");
    }
    const sidecarPath = resolveInsideDir(SNAPSHOT_DIR, `${name}.json`);
    const binPath = resolveInsideDir(SNAPSHOT_DIR, `${name}.bin`);
    if (!sidecarPath || !binPath) throw rpcError(2001, "snapshot name resolves outside the snapshot directory");
    if (!fs.existsSync(sidecarPath) || !fs.existsSync(binPath)) {
        throw rpcError(2003, `snapshot '${name}' not found in ${SNAPSHOT_DIR}`, "Run snapshot_save first, or check the name");
    }
    let sidecar;
    try {
        sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
    } catch (e) {
        throw rpcError(2003, `snapshot sidecar '${name}.json' is corrupted: ${e.message}`);
    }
    // sidecar 的 internal_id 同样要过滤：快照文件可能来自不可信来源
    const internalId = sidecar.internal_id;
    if (typeof internalId !== "string" || !/^[A-Za-z0-9_-]{4,80}$/.test(internalId)) {
        throw rpcError(2003, `snapshot sidecar '${name}.json' has an invalid internal_id`);
    }
    const dst = resolveInsideDir(SAVES_DIR, `savegame-${internalId}.bin`);
    if (!dst) throw rpcError(2001, "resolved savegame path is invalid");
    if (fs.existsSync(dst)) {
        // 带时间戳的备份：连续 restore 不会互相覆盖（红队发现单槽位 .pre-restore 会丢原始档）
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        fs.copyFileSync(dst, `${dst}.pre-restore-${stamp}`);
    }
    fs.copyFileSync(binPath, dst);
    await callMod("load_save", { internal_id: internalId });
    info(`snapshot restored: ${name} -> ${internalId}`);
    return { ok: true, name, internal_id: internalId, loading: true };
}

// ─────────────────────── HTTP 服务 ───────────────────────

function authorized(req) {
    if (!CFG.token) return true;
    const h = req.headers["authorization"];
    if (h === `Bearer ${CFG.token}`) return true;
    const u = new URL(req.url, "http://localhost");
    return u.searchParams.get("token") === CFG.token;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let b = "";
        req.on("data", d => {
            b += d;
            if (b.length > 32 * 1024 * 1024) reject(new Error("body too large"));
        });
        req.on("end", () => resolve(b));
        req.on("error", reject);
    });
}

const server = http.createServer(async (req, res) => {
    const send = (status, obj) => {
        const body = typeof obj === "string" ? obj : JSON.stringify(obj);
        res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
        res.end(body);
    };

    if (req.method === "GET" && req.url.startsWith("/health")) {
        return send(200, { ok: true, mod_connected: !!(mod && mod.hello), uptime_s: Math.round(process.uptime()) });
    }

    if (!authorized(req)) {
        return send(401, { error: { code: 401, message: "unauthorized: provide Authorization: Bearer <token>" } });
    }

    // 拒绝浏览器页面（http/https 来源）。text/plain POST 可免 CORS 预检，
    // 因此不能在 handler 里才拦——这里是最早的关口。
    if (!originAllowed(req)) {
        return rejectBadOrigin(res);
    }

    if (req.method === "GET" && req.url.startsWith("/status")) {
        try {
            const result = await handleClientRpc("status", {});
            return send(200, result);
        } catch (e) {
            if (e.rpc) return send(200, { error: e.rpc });
            return send(200, { error: { code: 2003, message: String(e) } });
        }
    }

    if (req.method === "POST" && req.url.startsWith("/rpc")) {
        let rpcReq;
        try {
            rpcReq = JSON.parse(await readBody(req));
        } catch (e) {
            return send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error: " + e.message } });
        }
        try {
            const result = await handleClientRpc(rpcReq.method, rpcReq.params || {});
            return send(200, { jsonrpc: "2.0", id: rpcReq.id ?? null, result });
        } catch (e) {
            if (e.rpc) return send(200, { jsonrpc: "2.0", id: rpcReq.id ?? null, error: e.rpc });
            warn("rpc", rpcReq.method, "failed:", e);
            return send(200, {
                jsonrpc: "2.0",
                id: rpcReq.id ?? null,
                error: { code: 2003, message: "mod_error: " + String(e && e.message ? e.message : e), data: { code_name: "mod_error", detail: String(e) } },
            });
        }
    }

    send(404, { error: { code: 404, message: "not found. Endpoints: GET /health, GET /status, POST /rpc" } });
});

// ─────────────────────── WS 升级路由 ───────────────────────

server.on("upgrade", (req, socket, head) => {
    const url = req.url.split("?")[0];
    if (!authorized(req)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
    }
    if (!originAllowed(req)) {
        // 恶意网页向量：WS 无同源策略，必须在这里拦
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
    }
    if (url === "/mod") {
        const conn = upgrade(req, socket);
        if (!conn) return;
        // 替换旧的 mod 连接
        if (mod && mod.socket !== socket) {
            info("replacing previous mod connection");
            try {
                mod.socket.end();
            } catch {}
            for (const { reject, timer } of mod.pending.values()) {
                clearTimeout(timer);
                reject(rpcError(1005, "mod connection replaced by a newer one"));
            }
            mod.pending.clear();
        }
        mod = conn;
        info(`mod connected from ${socket.remoteAddress}:${socket.remotePort}`);
        socket.on("data", d => feed(conn, d, onModText));
        socket.on("close", () => onModClose(conn));
        socket.on("error", e => debug("mod socket error:", e.message));
        if (head && head.length) feed(conn, head, onModText);
        return;
    }
    if (url === "/client") {
        const conn = upgrade(req, socket);
        if (!conn) return;
        clients.add(conn);
        info(`client connected from ${socket.remoteAddress}:${socket.remotePort}`);
        // 立即把当前 mod 状态推给新客户端
        if (mod && mod.hello) {
            sendJson(conn, { jsonrpc: "2.0", method: "event", params: { type: "mod_connected", data: mod.hello } });
        }
        socket.on("data", d => feed(conn, d, onClientText));
        socket.on("close", () => {
            clients.delete(conn);
            debug("client disconnected");
        });
        socket.on("error", e => debug("client socket error:", e.message));
        if (head && head.length) feed(conn, head, onClientText);
        return;
    }
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
});

// ─────────────────────── mod 消息处理 ───────────────────────

function onModText(conn, text) {
    let msg;
    try {
        msg = JSON.parse(text);
    } catch (e) {
        warn("bad JSON from mod:", text.slice(0, 200));
        return;
    }
    // hello（协议 §2）
    if (msg.method === "hello") {
        const p = msg.params || {};
        if (p.protocol !== PROTOCOL) {
            warn(`protocol mismatch: mod=${p.protocol} bridge=${PROTOCOL} — closing mod connection (hard fail)`);
            sendJson(conn, {
                jsonrpc: "2.0",
                method: "event",
                params: { type: "rejected", data: { reason: "protocol_version_mismatch", mod_protocol: p.protocol, bridge_protocol: PROTOCOL } },
            });
            setTimeout(() => {
                try {
                    conn.socket.end(Buffer.from([0x03, 0xe8])); // close code 1000 退化处理
                } catch {}
                try {
                    conn.socket.destroy();
                } catch {}
            }, 50);
            conn.rejected = rpcError(1001, `mod protocol=${p.protocol} but bridge protocol=${PROTOCOL}`, "Update the mod or the bridge so both use protocol 1");
            return;
        }
        if (!SUPPORTED_GAMES.has(p.game_version)) {
            warn(`game version mismatch: mod=${p.game_version} supported=${[...SUPPORTED_GAMES].join(",")} — closing (hard fail)`);
            try {
                conn.socket.destroy();
            } catch {}
            conn.rejected = rpcError(1002, `game version ${p.game_version} is not in compat.json (${[...SUPPORTED_GAMES].join(", ")})`, "Update the mod for your game version");
            return;
        }
        conn.hello = p;
        info(`mod ready: game ${p.game_version}, mod ${p.mod_version}, features [${(p.features || []).join(",")}]`);
        broadcastEvent("mod_connected", p);
        return;
    }
    // RPC 响应
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const pending = conn.pending.get(msg.id);
        if (!pending) {
            debug("response for unknown/stale id", msg.id);
            return;
        }
        conn.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error !== undefined) {
            // 透传 mod 的 error（含 code/data）
            const err = new Error(msg.error.message || "mod error");
            err.rpc = msg.error;
            pending.reject(err);
        } else {
            pending.resolve(msg.result);
        }
        return;
    }
    debug("unhandled mod message:", text.slice(0, 200));
}

function onModClose(conn) {
    if (mod === conn) {
        info("mod disconnected");
        for (const { reject, timer } of conn.pending.values()) {
            clearTimeout(timer);
            const e = conn.rejected || rpcError(1005, "mod disconnected");
            reject(e);
        }
        conn.pending.clear();
        mod = null;
        broadcastEvent("mod_disconnected", {});
    }
}

// ─────────────────────── /client 消息处理 ───────────────────────

function onClientText(conn, text) {
    let msg;
    try {
        msg = JSON.parse(text);
    } catch (e) {
        sendJson(conn, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        return;
    }
    if (msg.id === undefined) return; // 通知，忽略
    // 映射 id：客户端 id 可以是任意 JSON 值，mod 侧统一用整数；用闭包回传原 id
    const clientId = msg.id;
    handleClientRpc(msg.method, msg.params || {})
        .then(result => sendJson(conn, { jsonrpc: "2.0", id: clientId, result }))
        .catch(e => {
            const err = e.rpc || { code: 2003, message: "mod_error: " + String(e && e.message ? e.message : e), data: { code_name: "mod_error", detail: String(e) } };
            sendJson(conn, { jsonrpc: "2.0", id: clientId, error: err });
        });
}

function broadcastEvent(type, data) {
    const msg = JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type, data } });
    for (const c of clients) {
        writeFrame(c.socket, 0x1, Buffer.from(msg));
    }
}

// ─────────────────────── 心跳（§8） ───────────────────────

setInterval(() => {
    if (!mod) return;
    // 向 mod 发 WS ping
    writeFrame(mod.socket, 0x9, Buffer.alloc(0));
    // 45s 无流量判死
    if (Date.now() - mod.lastSeen > 45000) {
        warn("mod silent for >45s, dropping connection");
        try {
            mod.socket.destroy();
        } catch {}
        // onModClose 会清理
    }
}, 15000).unref();

// ─────────────────────── 启动 ───────────────────────

server.listen(CFG.port, "127.0.0.1", () => {
    const banner = [
        "",
        "  shapez-ai-bridge  •  bridge running",
        "  ─────────────────────────────────────────────",
        `  Mod endpoint   : ws://127.0.0.1:${CFG.port}/mod     (game mod connects here)`,
        `  Client WS      : ws://127.0.0.1:${CFG.port}/client  (tools/agents, events)`,
        `  HTTP           : http://127.0.0.1:${CFG.port}/health | /status | POST /rpc`,
        `  Read-only      : ${CFG.read_only}`,
        `  Token          : ${CFG.token ? "(set)" : "(none)"}`,
        `  Snapshots      : ${SNAPSHOT_DIR}`,
        `  Saves dir      : ${SAVES_DIR}`,
        `  Supported game : ${[...SUPPORTED_GAMES].join(", ") || "(compat.json missing)"}`,
        "  ─────────────────────────────────────────────",
        "  Next: start shapez.io (mod installed) and load a savegame.",
        "        Then: node scripts/smoke_test.mjs",
        "",
    ].join("\n");
    info(banner);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
function shutdown() {
    info("shutting down...");
    try {
        if (mod) mod.socket.end();
        for (const c of clients) c.socket.end();
    } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
}
