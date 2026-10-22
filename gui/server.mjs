#!/usr/bin/env node
// gui/server.mjs — GUI local server (zero dependency). Contract: gui/DESIGN-PLAN.md §2
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import process from "node:process";
import { ROOT, UI_DIR, BRIDGE_CONFIG, MOD_SOURCE, MCP_SERVER } from "./lib/paths.mjs";
import { probeEnv, probePort, findBrowser, sha256File } from "./lib/env-probe.mjs";
import { readConfig, validateConfig, writeConfig, resetConfig, readGuiState, writeGuiState } from "./lib/config-io.mjs";
import { ProcMgr } from "./lib/proc-mgr.mjs";

const GUI_VERSION = "0.1.0";
const argv = process.argv.slice(2);
const argVal = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const NO_OPEN = argv.includes("--no-open");
const START_PORT = parseInt(argVal("--port", "7801"), 10);
const TOKEN = crypto.randomBytes(16).toString("hex");
const MODS_DIR = path.join(process.env.APPDATA || "", "shapez.io", "mods");
const SAVES_DIR = path.join(process.env.APPDATA || "", "shapez.io", "saves");

const mgr = new ProcMgr({
  root: ROOT,
  paths: {
    installScript: path.join(ROOT, "install.ps1"),
    bridgePath: path.join(ROOT, "src", "bridge", "bridge.mjs"),
    smokePath: path.join(ROOT, "scripts", "smoke_test.mjs"),
  },
});

const CODE_HTTP = { BAD_REQUEST:400, INVALID_PARAM:400, CONFIG_INVALID:400, FORBIDDEN_ORIGIN:403, BAD_TOKEN:403,
  NOT_FOUND:404, PORT_BUSY:409, INSTALL_BUSY:409, SMOKE_BUSY:409, CANNOT_STOP_FOREIGN:409,
  INSTALL_FAILED:500, UNINSTALL_FAILED:500, BRIDGE_START_FAILED:500, INTERNAL:500 };
const errBody = (code, zh, en, hint = null, detail = null, log_ref = null) => ({ error: { code, message: zh, message_en: en, hint, detail, log_ref } });
const json = (res, s, o) => { const b = JSON.stringify(o); res.writeHead(s, { "content-type":"application/json; charset=utf-8", "content-length":Buffer.byteLength(b) }); res.end(b); };
const fail = (res, code, zh, en, hint = null, detail = null, log_ref = null) => json(res, CODE_HTTP[code] || 500, errBody(code, zh, en, hint, detail, log_ref));
const readBody = req => new Promise((ok, no) => { let b = ""; req.on("data", c => { b += c; if (b.length > 8*1024*1024) no(new Error("body too large")); }); req.on("end", () => ok(b)); req.on("error", no); });

function originOk(req, port) {
  const o = req.headers.origin;
  if (!o) return true;
  return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
}
const tokenOk = req => req.headers["x-gui-token"] === TOKEN;

const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".css":"text/css; charset=utf-8", ".json":"application/json", ".svg":"image/svg+xml", ".png":"image/png" };
function serveStatic(req, res) {
  let p;
  try { p = decodeURIComponent(req.url.split("?")[0]); } catch { return fail(res, "INVALID_PARAM", "非法路径编码", "bad path encoding"); }
  if (p === "/") p = "/index.html";
  const file = path.resolve(UI_DIR, "." + p);
  if (file !== UI_DIR && !file.startsWith(UI_DIR + path.sep)) return fail(res, "INVALID_PARAM", "非法路径", "bad path");
  let st; try { st = fs.statSync(file); } catch { return fail(res, "NOT_FOUND", "文件不存在", "not found"); }
  if (!st.isFile()) return fail(res, "NOT_FOUND", "不是文件", "not a file");
  let data = fs.readFileSync(file);
  if (p === "/index.html") data = Buffer.from(data.toString("utf8").replace('content=""', `content="${TOKEN}"`));
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "content-length": data.length });
  res.end(data);
}

const sseClients = new Set();
function sseBroadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) { try { c.write(msg); } catch { sseClients.delete(c); } }
}

// ── 冒烟状态（server 侧跟踪；ProcMgr 只发事件） ──
const smoke = { exit_code: null, finished_at: null, hint: null, checks: [1,2,3,4,5].map(n => ({ n, name: `检查 ${n}`, name_zh: `检查 ${n}`, state: "pending", detail: "" })) };
const smokePayload = () => ({ running: !!mgr.smoke_proc, run_id: mgr.run_id, exit_code: smoke.exit_code, checks: smoke.checks, hint: smoke.hint, finished_at: smoke.finished_at });

async function bridgeStatus(port) {
  let healthy = false, mod_connected = false, uptime_s = null, rs = null;
  try { const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) }); const j = await r.json(); healthy = !!j.ok; mod_connected = !!j.mod_connected; uptime_s = j.uptime_s ?? null; } catch {}
  if (healthy) { try { const r = await fetch(`http://127.0.0.1:${port}/rpc`, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify({ jsonrpc:"2.0", id:1, method:"status", params:{} }), signal: AbortSignal.timeout(2000) }); const j = await r.json(); rs = j.result || null; } catch {} }
  const managed = !!mgr.bridge_proc;
  return { running: healthy, managed, pid: managed ? mgr.bridge_proc.pid : null, port, healthy, mod_connected, uptime_s,
    in_game: rs?.in_game ?? null, game_version: rs?.game_version ?? null, mod_version: rs?.mod_version ?? null,
    hub_level: rs?.hub_level ?? null, paused: rs?.paused ?? null, allow_write: rs?.allow_write ?? null, last_error: null };
}

async function handleApi(req, res, port) {
  const u = new URL(req.url, "http://x"); const p = u.pathname; const m = req.method;
  if (p === "/api/healthz") return json(res, 200, { ok: true, gui_version: GUI_VERSION, uptime_s: Math.round(process.uptime()), port });
  if (!tokenOk(req)) return fail(res, "BAD_TOKEN", "缺少或错误的 GUI token", "missing/invalid X-GUI-Token", "从页面 meta 标签读取 token");

  if (p === "/api/env" && m === "GET") { const stmo = readGuiState(); return json(res, 200, await probeEnv({ gameDir: stmo.game_dir_override || undefined })); }
  if (p === "/api/env" && m === "POST") {
    let b = {}; try { b = JSON.parse((await readBody(req)) || "{}"); } catch { return fail(res, "BAD_REQUEST", "请求体不是 JSON", "invalid json"); }
    if (b.game_dir) {
      const okDir = fs.existsSync(path.join(b.game_dir, "shapezio.exe")) && fs.existsSync(path.join(b.game_dir, "resources", "app.asar"));
      if (!okDir) return fail(res, "INVALID_PARAM", "该目录不是 shapez.io 安装目录", "not a shapez directory", "选择包含 shapezio.exe 的目录", { reason: "not_shapez_dir", game_dir: b.game_dir });
      writeGuiState({ game_dir_override: b.game_dir });
    }
    return json(res, 200, await probeEnv({ gameDir: b.game_dir || readGuiState().game_dir_override || undefined }));
  }
  if (p === "/api/version") return json(res, 200, { gui: GUI_VERSION, repo: ROOT, mod: "0.1.0", protocol: 1, compat_games: ["1.5.6"], node: { min: 20, cur: process.version } });

  if (p === "/api/install" && m === "POST") {
    if (mgr.install_proc) return fail(res, "INSTALL_BUSY", "安装正在进行", "install busy");
    let b = {}; try { b = JSON.parse((await readBody(req)) || "{}"); } catch { return fail(res, "BAD_REQUEST", "请求体不是 JSON", "invalid json"); }
    try {
      const r = await mgr.runInstall({ mods_dir: b.mods_dir || null });
      if (r.exit_code !== 0) return fail(res, "INSTALL_FAILED", "安装失败", "install failed", "展开日志查看原始输出", { exit_code: r.exit_code }, r.log_ref);
      const target = path.join(b.mods_dir || MODS_DIR, "shapez-ai-bridge.js");
      const sha = fs.existsSync(target) ? sha256File(target) : sha256File(MOD_SOURCE);
      return json(res, 200, { ok: true, exit_code: 0, target, sha256: sha, backup: null, lines_n: r.lines_n });
    } catch (e) { return fail(res, "INSTALL_FAILED", "安装失败", "install failed", null, { message: String(e && e.message || e) }, mgr.lastLineN("install")); }
  }
  if (p === "/api/uninstall" && m === "POST") {
    if (mgr.install_proc) return fail(res, "INSTALL_BUSY", "安装正在进行", "install busy");
    let b = {}; try { b = JSON.parse((await readBody(req)) || "{}"); } catch { return fail(res, "BAD_REQUEST", "请求体不是 JSON", "invalid json"); }
    try { const r = await mgr.runInstall({ uninstall: true }); if (r.exit_code !== 0) return fail(res, "UNINSTALL_FAILED", "卸载失败", "uninstall failed", null, { exit_code: r.exit_code }, r.log_ref); }
    catch (e) { return fail(res, "UNINSTALL_FAILED", "卸载失败", "uninstall failed", null, { message: String(e && e.message || e) }); }
    const removed = [];
    if (b.clean_backups) { try { for (const f of fs.readdirSync(MODS_DIR)) if (f.startsWith("shapez-ai-bridge.js.bak-")) { fs.unlinkSync(path.join(MODS_DIR, f)); removed.push(f); } } catch {} }
    return json(res, 200, { ok: true, removed, kept_modsettings: !b.clean_modsettings, notes: ["游戏内 mod 设置残留于 saves 目录（modsettings_shapez-ai-bridge__*.json）"] });
  }

  if (p === "/api/config" && m === "GET") {
    const exists = fs.existsSync(BRIDGE_CONFIG); let valid = true;
    if (exists) { try { JSON.parse(fs.readFileSync(BRIDGE_CONFIG, "utf8")); } catch { valid = false; } }
    const cfg = readConfig(); const warnings = [];
    if (cfg.__error) warnings.push("bridge.config.json 损坏，已回退默认值：" + cfg.__error);
    return json(res, 200, { config: cfg, defaults: null, file: { path: BRIDGE_CONFIG, exists, valid }, warnings });
  }
  if (p === "/api/config" && m === "POST") {
    let b = {}; try { b = JSON.parse((await readBody(req)) || "{}"); } catch { return fail(res, "BAD_REQUEST", "请求体不是 JSON", "invalid json"); }
    const v = validateConfig(b);
    if (!v.ok) return fail(res, "CONFIG_INVALID", "配置校验失败", "config invalid", null, { fields: v.errors });
    const cur = readConfig();
    if (v.clean.port !== cur.port) { const pr = await probePort(v.clean.port); if (pr.busy) return fail(res, "PORT_BUSY", `端口 ${v.clean.port} 已被占用`, `port ${v.clean.port} is busy`, "换一个端口，或结束占用进程", { port: v.clean.port, pid: pr.pid ?? null }); }
    writeConfig(v.clean);
    return json(res, 200, { ok: true, config: v.clean, bridge_restarted: false });
  }
  if (p === "/api/config/reset" && m === "POST") return json(res, 200, { ok: true, config: resetConfig() });

  if (p === "/api/bridge/status") return json(res, 200, await bridgeStatus(readConfig().port));
  if (p === "/api/bridge/start" && m === "POST") {
    const cfg = readConfig(); const st = await bridgeStatus(cfg.port);
    if (st.running) return json(res, 200, { ok: true, already_running: true, status: st });
    const pr = await probePort(cfg.port);
    if (pr.busy) return fail(res, "PORT_BUSY", `端口 ${cfg.port} 已被占用`, `port ${cfg.port} is busy`, "换一个端口，或结束占用进程", { port: cfg.port, pid: pr.pid ?? null });
    const h = mgr.startBridge({ port: cfg.port, token: cfg.token, read_only: cfg.read_only });
    mgr.setBridge(h.child);
    const t0 = Date.now();
    for (;;) {
      const s = await bridgeStatus(cfg.port);
      if (s.running) return json(res, 200, { ok: true, status: s });
      if (h.child.exitCode !== null) { mgr.setBridge(null); return fail(res, "BRIDGE_START_FAILED", "桥接启动即退出", "bridge exited immediately", "展开日志查看原因", { reason: "exited" }, mgr.lastLineN("bridge")); }
      if (Date.now() - t0 > 8000) { mgr.setBridge(null); return fail(res, "BRIDGE_START_FAILED", "桥接启动超时", "bridge start timeout", "展开日志查看原因", { reason: "timeout" }, mgr.lastLineN("bridge")); }
      await new Promise(r => setTimeout(r, 500));
    }
  }
  if (p === "/api/bridge/stop" && m === "POST") {
    const cfg = readConfig(); const st = await bridgeStatus(cfg.port);
    if (!mgr.bridge_proc) { if (st.running) return fail(res, "CANNOT_STOP_FOREIGN", "该桥接由外部终端启动", "external bridge", "请在原终端 Ctrl-C 停止", { pid: st.pid }); return json(res, 200, { ok: true, stopped: false }); }
    const r = await mgr.stopProcess(mgr.bridge_proc); mgr.setBridge(null);
    return json(res, 200, { ok: true, stopped: true, forced: !!r.forced });
  }

  if (p === "/api/logs") return json(res, 200, mgr.logsSince(u.searchParams.get("kind") || "bridge", parseInt(u.searchParams.get("since") || "0", 10)));

  if (p === "/api/smoke" && m === "POST") {
    const cfg = readConfig();
    for (const c of smoke.checks) { c.state = "pending"; c.detail = ""; }
    smoke.exit_code = null; smoke.finished_at = null; smoke.hint = null;
    const r = mgr.runSmoke({ base_url: `http://127.0.0.1:${cfg.port}`, token: cfg.token });
    if (r && r.error) return fail(res, "SMOKE_BUSY", "冒烟测试正在进行", "smoke busy");
    sseBroadcast("smoke_status", smokePayload());
    return json(res, 200, { ok: true, run_id: mgr.run_id });
  }
  if (p === "/api/smoke/status") return json(res, 200, smokePayload());

  if (p === "/api/mcp-config") {
    const cfg = readConfig();
    const mcpPath = MCP_SERVER.replace(/\\/g, "/");
    return json(res, 200, {
      config: { mcpServers: { shapez: { command: "node", args: [mcpPath], env: { SHAPEZ_BRIDGE_URL: `http://127.0.0.1:${cfg.port}` } } } },
      claude_desktop_config_path: path.join(process.env.APPDATA || "", "Claude", "claude_desktop_config.json"),
      instructions_zh: "把上面的 mcpServers 合并进该文件，然后重启 Claude Desktop",
      instructions_en: "Merge mcpServers above into that file, then restart Claude Desktop",
    });
  }
  if (p === "/api/open" && m === "POST") {
    let b = {}; try { b = JSON.parse((await readBody(req)) || "{}"); } catch { return fail(res, "BAD_REQUEST", "请求体不是 JSON", "invalid json"); }
    if (typeof b.target !== "string") return fail(res, "INVALID_PARAM", "target 必须是字符串", "target must be a string", "允许值: mods_dir, snapshots_dir, saves_dir, repo_root, mcp_config_file, steam_store, steam_run, readme");
    const T = {
      mods_dir: () => ["explorer", [MODS_DIR]],
      snapshots_dir: () => ["explorer", [path.join(ROOT, "snapshots")]],
      saves_dir: () => ["explorer", [SAVES_DIR]],
      repo_root: () => ["explorer", [ROOT]],
      readme: () => ["explorer", [path.join(ROOT, "README.md")]],
      steam_store: () => ["cmd", ["/c", "start", "", "steam://store/1318690"]],
      steam_run: () => ["cmd", ["/c", "start", "", "steam://rungameid/1318690"]],
      mcp_config_file: () => {
        const cfg = readConfig();
        const mcpPath = MCP_SERVER.replace(/\\/g, "/");
        const gen = path.join(ROOT, "gui", "mcp-config.generated.json");
        fs.writeFileSync(gen, JSON.stringify({ mcpServers: { shapez: { command: "node", args: [mcpPath], env: { SHAPEZ_BRIDGE_URL: `http://127.0.0.1:${cfg.port}` } } } }, null, 2));
        return ["explorer", [gen]];
      },
    };
    if (!Object.prototype.hasOwnProperty.call(T, b.target)) return fail(res, "INVALID_PARAM", "未知的打开目标", "unknown open target", "允许值: " + Object.keys(T).join(", "));
    const [cmd, args] = T[b.target]();
    try { spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref(); }
    catch (e) { return fail(res, "INTERNAL", "打开失败", "open failed", null, { message: String(e && e.message || e) }); }
    return json(res, 200, { ok: true, opened: true });
  }
  return fail(res, "NOT_FOUND", "未知 API", "unknown api");
}

async function main() {
  let port = START_PORT;
  // Scan from the requested port upward (10 tries). Relative ceiling so that
  // `--port 7811` (or any other base) works, not just the 7801 default range.
  const PORT_MAX = START_PORT + 9;
  for (; port <= PORT_MAX; port++) { if (!(await probePort(port)).busy) break; }
  if (port > PORT_MAX) { console.error(`[gui] no free port in ${START_PORT}-${PORT_MAX}`); process.exit(1); }

  mgr.on("log", l => {
    sseBroadcast("log", l);
    if (l.kind === "smoke") {
      const mm = /\[(\d)\/5\]\s+(PASS|FAIL|SKIP)\s+(.*)/.exec(l.text);
      if (mm) { const i = +mm[1] - 1; if (smoke.checks[i]) { smoke.checks[i].state = mm[2] === "PASS" ? "pass" : (mm[2] === "SKIP" ? "pending" : "fail"); smoke.checks[i].detail = String(mm[3]).slice(0, 140); sseBroadcast("smoke_status", smokePayload()); } }
    }
  });
  mgr.on("install_done", d => sseBroadcast("install_done", d));
  mgr.on("smoke_done", d => {
    smoke.exit_code = d.exit_code; smoke.finished_at = Date.now();
    smoke.hint = d.exit_code === 0 ? null : d.exit_code === 1 ? "先启动桥接" : d.exit_code === 2 ? "启动游戏并进入存档" : "展开日志查看原始响应";
    sseBroadcast("smoke_status", smokePayload());
  });

  const server = http.createServer(async (req, res) => {
    try {
      if (!originOk(req, port)) return fail(res, "FORBIDDEN_ORIGIN", "拒绝该来源", "forbidden origin");
      if (req.url.startsWith("/api/events")) {
        const q = new URL(req.url, "http://x");
        if (q.searchParams.get("token") !== TOKEN && req.headers["x-gui-token"] !== TOKEN) return fail(res, "BAD_TOKEN", "缺少 token", "missing token");
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write("retry: 3000\n\n"); sseClients.add(res);
        const tick = setInterval(async () => { try { sseBroadcast("bridge_status", await bridgeStatus(readConfig().port)); } catch {} }, 2000);
        req.on("close", () => { clearInterval(tick); sseClients.delete(res); });
        return;
      }
      if (req.url.startsWith("/api/")) return await handleApi(req, res, port);
      return serveStatic(req, res);
    } catch (e) { console.error("[gui] handler error:", e); fail(res, "INTERNAL", "内部错误", "internal error", null, { message: String(e && e.message || e) }); }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`[gui] shapez-ai-bridge GUI on http://127.0.0.1:${port}/  (token injected into index.html)`);
    if (!NO_OPEN) {
      const b = findBrowser();
      if (b) spawn(b.path, [`--app=http://127.0.0.1:${port}/`, "--window-size=1180,780"], { detached: true, stdio: "ignore" }).unref();
      else console.log("[gui] no browser found — open the URL manually");
    }
  });
  const bye = async () => { try { await mgr.shutdown(); } catch {} server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
  process.on("SIGINT", bye); process.on("SIGTERM", bye);
}
main();
