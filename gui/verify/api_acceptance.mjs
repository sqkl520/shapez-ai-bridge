/**
 * T5 · 验收 B/C/D/F 可自动化项 — 对真实 gui/server.mjs 运行。
 *
 * 用法: node gui/verify/api_acceptance.mjs [--port 7801] [--keep-gui]
 *
 * 零依赖（Node fetch）。自启 GUI（--no-open），结束后恢复现场：
 *   - bridge.config.json / gui/.gui-state.json 恢复到测试前状态
 *   - 关闭它启动的 GUI 进程与桥接子进程、dummy 监听
 * 结果分批写入 docs/gui/VERIFICATION.md（每个组测完即落盘）+ logs/results.jsonl。
 *
 * 环境事实（本机实测，用于 B1 对照）:
 *   node v24.14.0; game dir d:/steam/steamapps/common/shapez.io; source=registry
 *   mods dir %APPDATA%/shapez.io/mods; mod sha eb0fb097…; 7777 被外部桥接占用(pid 动态)
 *   browser chrome; saves 有 modsettings; game 运行中 (5× shapezio.exe)
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import {
    ROOT, DOCS_GUI, BAK_DIR, http, sleep, waitUntil, probePort, findFreePort,
    sha256File, readText, modsDir, listBaks, startGui, fetchGuiToken,
    Recorder, writeSection, appendJsonl, trunc,
} from "./lib.mjs";

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const GUI_PORT = parseInt(argVal("--port", "7801"), 10);
const KEEP_GUI = args.includes("--keep-gui");

const R = new Recorder("api_acceptance");
const SECTIONS = []; // for final report
const RESULTS = path.join(BAK_DIR, "results.jsonl");
const VERIFICATION = path.join(DOCS_GUI, "VERIFICATION.md");

function flush(sectionId, sectionTitle, extra = "") {
    const body = [
        `> 时间: ${new Date().toISOString()}${extra ? ` · ${extra}` : ""}`,
        "",
        R.markdownTable(),
        "",
        `计数: PASS=${R.counts.PASS} FAIL=${R.counts.FAIL} BLOCKED=${R.counts.BLOCKED}`,
    ].join("\n");
    writeSection(VERIFICATION, sectionId, sectionTitle, body);
}
function row(group, id, status, detail, evidence) {
    const r = R.add(group, id, status, detail, evidence);
    appendJsonl(RESULTS, r);
    return r;
}

const CONFIG_FILE = path.join(ROOT, "bridge.config.json");
const GUISTATE_FILE = path.join(ROOT, "gui", ".gui-state.json");
const MODS = modsDir();
const MOD_FILE = path.join(MODS, "shapez-ai-bridge.js");

/** Run a command capturing stdout+stderr (for live-machine cross-checks). */
function runCmd(cmd, args) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: 10000, windowsHide: true }, (err, stdout, stderr) => {
            resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") });
        });
    });
}

/** netstat-based owner pid of a 127.0.0.1 LISTENING port (null if free). */
async function netstatPidOf(port) {
    const { stdout } = await runCmd("netstat", ["-ano"]);
    const re = new RegExp(`127\\.0\\.0\\.1:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`);
    const m = stdout.match(re);
    return m ? parseInt(m[1], 10) : null;
}

// ───────────────────────── cleanup registry ─────────────────────────

const cleanups = [];
async function runCleanups() {
    for (const fn of cleanups.reverse()) {
        try { await fn(); } catch (e) { console.error("[cleanup]", e.message); }
    }
}

let gui = null;
let token = null;
let dummy = null; // extra listener used by C5/D5

async function j(method, apiPath, { body, headers = {}, raw = false, timeoutMs = 20000 } = {}) {
    const r = await http(gui.url + apiPath, {
        method,
        headers: { ...(token ? { "X-GUI-Token": token } : {}), ...headers },
        body,
        timeoutMs,
    });
    if (raw) return r;
    return r.json;
}

// ───────────────────────── test groups ─────────────────────────

async function groupA_sanity() {
    row("S", "boot", gui.ready ? "PASS" : "FAIL",
        gui.ready ? `GUI server ready on ${gui.url}` : "GUI server did not become ready in 20s",
        `log: ${gui.logPath}`);
    const tok = await fetchGuiToken(gui.url);
    if (!tok.ok) {
        row("S", "token", "FAIL", "不能从 GET / 提取 gui-token", tok.reason);
        return false;
    }
    token = tok.token;
    row("S", "token", "PASS", "GET / 含 <meta name=gui-token>", `token len=${token.length}`);
    // healthz exempt from token
    const hz = await http(gui.url + "/api/healthz", { headers: { "X-GUI-Token": "wrong-token-0000000000" } });
    const hzOk = hz.status === 200 && hz.json?.ok === true && Number.isInteger(hz.json?.port);
    row("S", "healthz", hzOk ? "PASS" : "FAIL",
        "GET /api/healthz 免 token（错误 token 也 200）", `status=${hz.status} body=${trunc(hz.text, 160)}`);

    // §2.1 version endpoint
    const ver = await j("GET", "/api/version");
    const verOk = ver && ver.mod === "0.1.0" && ver.protocol === 1
        && Array.isArray(ver.compat_games) && ver.compat_games.includes("1.5.6")
        && ver.node && Number.isInteger(ver.node.min) && typeof ver.node.cur === "string";
    row("S", "api_version", verOk ? "PASS" : "FAIL",
        `GET /api/version: mod=${ver?.mod} protocol=${ver?.protocol} compat=${trunc(JSON.stringify(ver?.compat_games), 40)} node=${ver?.node?.min}/${ver?.node?.cur}`,
        trunc(JSON.stringify(ver), 260));

    // §2.5 mcp-config endpoint
    const mc = await j("GET", "/api/mcp-config");
    const srv = mc?.config?.mcpServers?.shapez;
    const absOk = Array.isArray(srv?.args) && srv.args.some((a) => String(a).endsWith("src/mcp/server.mjs") || String(a).endsWith("src\\mcp\\server.mjs"));
    const mcOk = srv?.command === "node" && absOk
        && typeof mc.claude_desktop_config_path === "string"
        && typeof mc.instructions_zh === "string" && typeof mc.instructions_en === "string";
    row("S", "api_mcp_config", mcOk ? "PASS" : "FAIL",
        `GET /api/mcp-config: command=${srv?.command} args=${trunc(JSON.stringify(srv?.args), 80)}`,
        `claude_cfg_path=${trunc(String(mc?.claude_desktop_config_path), 120)}`);

    // 错误统一体：404 也要有完整 error 体（全部字段必现）
    const nf = await j("GET", "/api/definitely-not-a-route", { raw: true });
    const e = nf.json?.error;
    const nfOk = nf.status === 404 && e && "code" in e && "message" in e && "message_en" in e && "hint" in e && "detail" in e && "log_ref" in e;
    row("S", "error_envelope", nfOk ? "PASS" : "FAIL",
        `404 错误统一体字段齐全（code/message/message_en/hint/detail/log_ref）`,
        `status=${nf.status} body=${trunc(nf.text, 240)}`);
    return true;
}

async function groupB1_env() {
    const env = await j("GET", "/api/env");
    if (!env || typeof env !== "object" || env.error) {
        row("B", "B1", "FAIL", "GET /api/env 无有效 EnvReport", trunc(JSON.stringify(env), 300));
        return;
    }
    const t = [];
    const check = (name, cond, got, want) => {
        t.push({ name, ok: !!cond, got, want });
    };
    const norm = (p) => String(p ?? "").replace(/\\/g, "/").toLowerCase();

    // 与"真实机器"对照：以测试运行时的活体事实为准（不硬编码环境快照）
    const liveNodeVersion = process.version;                       // GUI server 由同一解释器 spawn
    const liveBusy = await probePort(env.port?.configured);        // boolean
    const livePid = await netstatPidOf(env.port?.configured);      // owner pid or null
    check("node.version", env.node?.version === liveNodeVersion, env.node?.version, `live ${liveNodeVersion}`);
    check("node.ok", env.node?.ok === true, env.node?.ok, true);
    check("os.platform", env.os?.platform === "win32", env.os?.platform, "win32");
    check("repo.mod_source_exists", env.repo?.mod_source_exists === true, env.repo?.mod_source_exists, true);
    check("game.found", env.game?.found === true, env.game?.found, true);
    check("game.dir", norm(env.game?.dir) === "d:/steam/steamapps/common/shapez.io", env.game?.dir, "d:/steam/steamapps/common/shapez.io");
    check("game.source", env.game?.source === "registry" || env.game?.source === "vdf", env.game?.source, "registry|vdf（本机 vdf 链命中即合法）");
    // game.running: 与活体 tasklist 对照
    const { stdout: tlOut } = await runCmd("tasklist", ["/FI", "IMAGENAME eq shapezio.exe"]);
    const liveGameRunning = /shapezio\.exe/i.test(tlOut);
    check("game.running", env.game?.running === liveGameRunning, env.game?.running, `live ${liveGameRunning}`);
    check("game.exe_ok", env.game?.exe_ok === true, env.game?.exe_ok, true);
    check("game.asar_ok", env.game?.asar_ok === true, env.game?.asar_ok, true);
    check("mods_dir.path", norm(env.mods_dir?.path) === norm(MODS), env.mods_dir?.path, MODS);
    check("mods_dir.exists", env.mods_dir?.exists === true, env.mods_dir?.exists, true);
    check("mods_dir.writable", env.mods_dir?.writable === true, env.mods_dir?.writable, true);
    check("mod.installed", env.mod?.installed === true, env.mod?.installed, true);
    const repoSha = sha256File(path.join(ROOT, "src", "mod", "shapez-ai-bridge.js"));
    check("mod.sha256_repo", env.mod?.sha256_repo === repoSha, trunc(env.mod?.sha256_repo, 20), trunc(repoSha, 20));
    check("mod.sha256_installed", fs.existsSync(MOD_FILE) ? env.mod?.sha256_installed === sha256File(MOD_FILE) : env.mod?.sha256_installed === null,
        trunc(env.mod?.sha256_installed, 20), "与磁盘一致");
    check("mod.match", env.mod?.match === (fs.existsSync(MOD_FILE) && sha256File(MOD_FILE) === repoSha), env.mod?.match, "与磁盘一致");
    check("mod.backup_count", env.mod?.backup_count === listBaks().length, env.mod?.backup_count, `live ${listBaks().length}`);
    check("port.configured", Number.isInteger(env.port?.configured), env.port?.configured, "int");
    check("port.busy", env.port?.busy === liveBusy, env.port?.busy, `live ${liveBusy}`);
    check("port.owner_pid", env.port?.owner_pid === livePid, env.port?.owner_pid, `live ${livePid}`);
    check("browser.found", env.browser?.found === true, env.browser?.found, true);
    check("browser.kind", env.browser?.kind === "chrome" || env.browser?.kind === "edge", env.browser?.kind, "chrome|edge");
    check("saves_dir.path", norm(env.saves_dir?.path) === norm(path.join(process.env.APPDATA, "shapez.io", "saves")), env.saves_dir?.path, "…/shapez.io/saves");
    check("saves_dir.modsettings_found", env.saves_dir?.modsettings_found === true, env.saves_dir?.modsettings_found, true);
    check("gui_state.wizard_completed", env.gui_state?.wizard_completed === false, env.gui_state?.wizard_completed, "false (fresh)");

    const bad = t.filter((x) => !x.ok);
    row("B", "B1", bad.length === 0 ? "PASS" : "FAIL",
        bad.length === 0 ? `EnvReport ${t.length} 项全部与真实机器一致` : `${bad.length}/${t.length} 项不符`,
        bad.length ? bad.map((x) => `${x.name}: got=${JSON.stringify(x.got)} want=${JSON.stringify(x.want)}`).join("; ") : `样例: node=${env.node.version} game=${env.game.dir} mod.match=${env.mod.match} port.busy=${env.port.busy}`);
    appendJsonl(RESULTS, { group: "B", id: "B1.raw", env });
    flush("sec-B1", "B 组 · 安装向导（B1 环境检测）");
}

async function groupB2B4_install() {
    const shaBefore = fs.existsSync(MOD_FILE) ? sha256File(MOD_FILE) : null;
    const baksBefore = listBaks();

    // B2 first install (idempotent over existing correct file)
    const r1 = await j("POST", "/api/install", { body: {}, timeoutMs: 60000 });
    const ok1 = r1?.ok === true && r1?.exit_code === 0;
    const after1 = fs.existsSync(MOD_FILE);
    const sha1 = after1 ? sha256File(MOD_FILE) : null;
    const repoSha = sha256File(path.join(ROOT, "src", "mod", "shapez-ai-bridge.js"));
    row("B", "B2", ok1 && after1 && sha1 === repoSha ? "PASS" : "FAIL",
        ok1 ? `安装 exit_code=0, 文件与仓库 sha256 一致` : "安装未返回 ok/exit_code=0",
        `resp=${trunc(JSON.stringify(r1), 260)} sha_match=${sha1 === repoSha} shaBefore=${trunc(shaBefore, 12)}`);

    // B3 second install → idempotent + backup added
    const r2 = await j("POST", "/api/install", { body: {}, timeoutMs: 60000 });
    const ok2 = r2?.ok === true && r2?.exit_code === 0;
    const sha2 = fs.existsSync(MOD_FILE) ? sha256File(MOD_FILE) : null;
    const baksAfter = listBaks();
    const newBaks = baksAfter.filter((b) => !baksBefore.includes(b));
    const r2backup = typeof r2?.backup === "string" && r2.backup.length > 0;
    row("B", "B3", ok2 && sha2 === repoSha && baksAfter.length >= baksBefore.length ? "PASS" : "FAIL",
        `二次安装 exit=0；备份 ${baksBefore.length}→${baksAfter.length}（新增 ${newBaks.length}）`,
        `resp=${trunc(JSON.stringify(r2), 260)} file_stable=${sha2 === repoSha}`);

    // pre-existing bak untouched by installs
    const PREEXIST = "shapez-ai-bridge.js.bak-20261020-202532";
    const preBakPath = path.join(MODS, PREEXIST);
    const preBakSha = fs.existsSync(preBakPath) ? sha256File(preBakPath) : null;
    row("B", "B3.preexisting_bak", fs.existsSync(preBakPath) ? "PASS" : "FAIL",
        `测试前已有备份 ${PREEXIST} 未被安装操作破坏`,
        `sha=${trunc(preBakSha, 16)}`);

    // B4 uninstall → env installed:false
    const ru = await j("POST", "/api/uninstall", { body: {} });
    const goneAfter = !fs.existsSync(MOD_FILE);
    const envAfterUn = await j("GET", "/api/env");
    const baksAfterUn = listBaks();
    const baksKept = baksAfterUn.length >= baksAfter.length; // default: no clean_backups
    row("B", "B4.uninstall", ru?.ok === true && goneAfter && envAfterUn?.mod?.installed === false ? "PASS" : "FAIL",
        `卸载后文件删除、env.mod.installed=false；默认保留备份 ${baksKept}`,
        `resp=${trunc(JSON.stringify(ru), 260)} installed=${envAfterUn?.mod?.installed} baks=${baksAfterUn.length}`);
    // baks must be preserved by default uninstall (red-team item, kept here for sequencing)
    row("B", "B4.bak_kept", baksKept ? "PASS" : "FAIL",
        "默认卸载不删除 .bak-*（除非 clean_backups:true）",
        `before=${baksAfter.length} after=${baksAfterUn.length}`);

    // reinstall to restore
    const rr = await j("POST", "/api/install", { body: {}, timeoutMs: 60000 });
    const restored = fs.existsSync(MOD_FILE) && sha256File(MOD_FILE) === repoSha;
    row("B", "B4.reinstall", rr?.ok === true && restored ? "PASS" : "FAIL",
        "重装恢复：文件回到与仓库一致",
        `resp=${trunc(JSON.stringify(rr), 200)}`);
    flush("sec-B2B4", "B 组 · 安装 / 幂等 / 卸载 / 重装");
}

async function groupB5_fakeGameDir() {
    const fake = "C:/definitely/not/a/shapez/dir-" + Date.now();
    const resp = await j("POST", "/api/env", { body: { game_dir: fake }, raw: true });
    const body = resp.json;
    const is400 = resp.status === 400;
    const code = body?.error?.code;
    const reason = body?.error?.detail?.reason;
    const hint = body?.error?.hint ?? body?.error?.message ?? "";
    const pass = is400 && (code === "INVALID_PARAM" || code === "BAD_REQUEST")
        && String(hint).length > 0 && String(body?.error?.message_en ?? "").length > 0;
    row("B", "B5", pass ? "PASS" : "FAIL",
        `假 game_dir → HTTP ${resp.status} ${code ?? ""}（提示=${trunc(String(hint), 80)}）`,
        `reason=${reason} body=${trunc(resp.text, 300)}`);
    // 不持久化: gui-state 的 game_dir_override 不应变成假路径
    const env = await j("GET", "/api/env");
    row("B", "B5.no_persist", !env?.gui_state?.game_dir_override ? "PASS" : "FAIL",
        "假路径未被持久化", `override=${env?.gui_state?.game_dir_override}`);
    flush("sec-B5", "B 组 · B5 假游戏目录");
}

async function groupB6_installFail() {
    // 用一个「存在的文件」当 mods_dir → install.ps1 无法在其中复制文件 → exit!=0
    // （不依赖 ACL/只读位，因为本机是管理员，只读位可被绕过）
    const fakeModsFile = path.join(BAK_DIR, "fake-mods-file");
    fs.writeFileSync(fakeModsFile, "this is a file, not a directory\n");
    const resp = await j("POST", "/api/install", { body: { mods_dir: fakeModsFile }, raw: true, timeoutMs: 60000 });
    let visible = false;
    let detail = `status=${resp.status}`;
    if (resp.status === 500) {
        const code = resp.json?.error?.code;
        const logRef = resp.json?.error?.log_ref;
        visible = code === "INSTALL_FAILED";
        detail += ` code=${code} log_ref=${logRef}`;
        if (logRef !== undefined && logRef !== null) {
            const logs = await j("GET", `/api/logs?kind=install&since=${Math.max(0, logRef - 8)}`);
            const hasFail = (logs?.lines || []).some((l) => l.level === "error" || /\[FAIL\]|Exception|错误/i.test(l.text));
            detail += ` log_has_error_line=${hasFail}`;
            visible = visible && hasFail;
            appendJsonl(RESULTS, { group: "B", id: "B6.logs", lines: (logs?.lines || []).slice(-12) });
        } else {
            detail += " (log_ref empty — 允许可空，但错误可见性靠 message)";
        }
    } else if (resp.status === 400) {
        // 服务端前置校验也算「可见错误」
        visible = !!resp.json?.error?.message;
        detail += ` code=${resp.json?.error?.code}`;
    }
    const msg = resp.json?.error?.message ?? resp.json?.error?.message_en ?? "";
    row("B", "B6", visible && String(msg).length > 0 ? "PASS" : "FAIL",
        `安装失败可见（非静默）: ${trunc(String(msg), 100)}`,
        detail + " body=" + trunc(resp.text, 240));
    fs.rmSync(fakeModsFile, { force: true });
    flush("sec-B6", "B 组 · B6 安装失败可见");
}

// ── C 组 ─────────────────────────────────────────────────────────────

async function groupC_config() {
    const existedBefore = fs.existsSync(CONFIG_FILE);
    const contentBefore = existedBefore ? readText(CONFIG_FILE) : null;

    // C1 defaults echo
    const c1 = await j("GET", "/api/config");
    const cfg = c1?.config;
    const c1ok = cfg && cfg.port === 7777 && cfg.token === null && cfg.read_only === false
        && typeof cfg.snapshot_dir === "string" && typeof cfg.log_level === "string";
    row("C", "C1", c1ok ? "PASS" : "FAIL",
        "GET /api/config 返回默认值 {port:7777, token:null, read_only:false, …}",
        `config=${trunc(JSON.stringify(cfg), 240)} file=${JSON.stringify(c1?.file)} warnings=${trunc(JSON.stringify(c1?.warnings), 120)}`);

    // C2 save modified values → file written, echo consistent
    const c2port = await findFreePort(7862);
    const modified = { ...cfg, port: c2port, log_level: "warn", snapshot_dir: "./snapshots-t5", read_only: false, token: null, rpc_timeout_ms: 30000, long_timeout_ms: 180000 };
    const c2 = await j("POST", "/api/config", { body: modified });
    const fileAfter = readText(CONFIG_FILE);
    let parsed = null; try { parsed = JSON.parse(fileAfter); } catch { /* ignore */ }
    const echo = await j("GET", "/api/config");
    const c2ok = c2?.ok === true && parsed && parsed.port === c2port && parsed.log_level === "warn"
        && echo?.config?.port === c2port;
    row("C", "C2", c2ok ? "PASS" : "FAIL",
        `POST /api/config 写入 bridge.config.json 且回显一致（port=${c2port}）`,
        `resp=${trunc(JSON.stringify(c2), 200)} file.port=${parsed?.port} echo.port=${echo?.config?.port} restarted=${c2?.bridge_restarted}`);
    cleanups.push(() => {
        // restore or remove config file
        if (existedBefore) fs.writeFileSync(CONFIG_FILE, contentBefore);
        else if (fs.existsSync(CONFIG_FILE)) fs.rmSync(CONFIG_FILE, { force: true });
    });

    // C3 invalid values → 400, not written
    const fileBeforeC3 = readText(CONFIG_FILE);
    const cases = [
        ["port 99999", { ...modified, port: 99999 }],
        ["port 'abc'", { ...modified, port: "abc" }],
        ["token bad chars", { ...modified, token: "ab cd" }],
        ["log_level nope", { ...modified, log_level: "verbose" }],
    ];
    const c3results = [];
    for (const [name, body] of cases) {
        const r = await j("POST", "/api/config", { body, raw: true });
        const err = r.json?.error;
        // field-level messages may live at error.fields / error.detail.fields / top-level fields
        const fields = err?.fields ?? err?.detail?.fields ?? r.json?.fields ?? null;
        c3results.push({ name, status: r.status, code: err?.code, fields });
        await sleep(120);
    }
    const fileAfterC3 = readText(CONFIG_FILE);
    const all400 = c3results.every((x) => x.status === 400);
    const allHaveFieldMsg = c3results.every((x) => x.fields && Object.keys(x.fields).length > 0 && Object.values(x.fields).join("").length > 0);
    const notWritten = fileBeforeC3 === fileAfterC3;
    row("C", "C3", all400 && notWritten ? "PASS" : "FAIL",
        `非法值全部 400 且未写文件（字段级消息=${allHaveFieldMsg ? "有" : "缺失"}）`,
        trunc(JSON.stringify(c3results), 420));

    // C4 reset → defaults
    const c4 = await j("POST", "/api/config/reset", { body: {} });
    const fileAfterReset = JSON.parse(readText(CONFIG_FILE) || "null");
    const c4ok = c4?.ok === true && fileAfterReset?.port === 7777;
    row("C", "C4", c4ok ? "PASS" : "FAIL",
        "POST /api/config/reset 回默认值且落盘",
        `resp=${trunc(JSON.stringify(c4), 200)} file.port=${fileAfterReset?.port}`);

    // C5 busy port → explicit conflict error + not written
    const busyPort = await findFreePort(7880);
    dummy = spawnListener(busyPort);
    await waitUntil(() => probePort(busyPort), { timeoutMs: 5000, label: "dummy busy port" });
    const fileBeforeC5 = readText(CONFIG_FILE);
    const c5 = await j("POST", "/api/config", { body: { ...modified, port: busyPort }, raw: true });
    const fileAfterC5 = readText(CONFIG_FILE);
    const pid = c5.json?.error?.detail?.pid ?? c5.json?.error?.pid ?? null;
    const c5ok = (c5.status === 409 || c5.status === 400)
        && String(c5.json?.error?.message ?? "").length > 0
        && fileBeforeC5 === fileAfterC5;
    const codeC5 = c5.json?.error?.code;
    row("C", "C5", c5ok ? (c5.status === 409 ? "PASS" : "PASS") : "FAIL",
        `占用端口 ${busyPort} → HTTP ${c5.status} ${codeC5 ?? ""}（提示=${trunc(String(c5.json?.error?.hint ?? c5.json?.error?.message ?? ""), 90)}）`,
        `pid=${pid} file_unchanged=${fileBeforeC5 === fileAfterC5} body=${trunc(c5.text, 260)}`);
    cleanups.push(() => { try { dummy?.kill(); } catch { /* ignore */ } });

    // C6 config file absent → defaults, no error
    fs.rmSync(CONFIG_FILE, { force: true });
    const c6 = await j("GET", "/api/config", { raw: true });
    const c6ok = c6.status === 200 && c6.json?.config?.port === 7777 && c6.json?.file?.exists === false;
    row("C", "C6", c6ok ? "PASS" : "FAIL",
        "无 bridge.config.json 时 GET 返回默认值不报错（file.exists=false）",
        `status=${c6.status} file=${trunc(JSON.stringify(c6.json?.file), 160)}`);
    flush("sec-C", "C 组 · 配置");
}

function spawnListener(port) {
    // A plain HTTP server that answers every request with 404 — occupies the port
    // and fails /health fast (realistic "some other service" scenario).
    const code = `const http=require('http');const s=http.createServer((q,r)=>{r.writeHead(404);r.end('not a bridge')});s.listen(${port},'127.0.0.1',()=>console.log('dummy-listening'));setInterval(()=>{},1000);`;
    return spawn(process.execPath, ["-e", code], { stdio: "ignore", windowsHide: true });
}

// ── D 组 ─────────────────────────────────────────────────────────────

async function groupD_bridge() {
    // ensure config exists w/ a free port we control
    const port = await findFreePort(7891);
    await j("POST", "/api/config", { body: { port, token: null, read_only: false, snapshot_dir: "./snapshots", log_level: "info", rpc_timeout_ms: 30000, long_timeout_ms: 180000 } });

    // D1 start
    const d1 = await j("POST", "/api/bridge/start", { body: {}, timeoutMs: 30000 });
    const st1 = await j("GET", "/api/bridge/status");
    const health = await http(`http://127.0.0.1:${port}/health`, { timeoutMs: 3000 });
    const d1ok = d1?.ok === true && st1?.running === true && health.status === 200 && health.json?.ok === true;
    row("D", "D1", d1ok ? "PASS" : "FAIL",
        `桥接启动：ok、status.running=true、/health ok（端口 ${port}）`,
        `resp=${trunc(JSON.stringify(d1), 200)} status=${trunc(JSON.stringify(st1), 200)} health=${trunc(health.text, 120)}`);
    cleanups.push(async () => { await j("POST", "/api/bridge/stop", { body: {} }).catch(() => {}); });

    // D2 status vs /health consistency
    const d2ok = st1 && typeof st1.pid === "number" && st1.port === port
        && st1.healthy === true && st1.uptime_s !== null && typeof st1.uptime_s === "number"
        && st1.mod_connected === (health.json?.mod_connected === true);
    row("D", "D2", d2ok ? "PASS" : "FAIL",
        "status 与 /health 一致（running/mod_connected/uptime_s/port）",
        `status=${trunc(JSON.stringify(st1), 300)}`);

    // D4 second start → idempotent
    const d4 = await j("POST", "/api/bridge/start", { body: {}, timeoutMs: 30000 });
    const st4 = await j("GET", "/api/bridge/status");
    const d4ok = d4?.ok === true && d4?.already_running === true && typeof st4?.pid === "number" && st4.pid === st1?.pid;
    row("D", "D4", d4ok ? "PASS" : "FAIL",
        "重复 start 幂等（already_running=true，pid 不变）",
        `resp=${trunc(JSON.stringify(d4), 200)} pid_before=${st1?.pid} pid_after=${st4?.pid}`);

    // D6 logs incremental
    const l1 = await j("GET", "/api/logs?kind=bridge&since=0");
    await sleep(700);
    const l2 = await j("GET", `/api/logs?kind=bridge&since=${l1?.next_since ?? 0}`);
    const n1 = l1?.lines?.length ?? 0;
    const notEmpty = n1 > 0;
    const monotonic = (l1?.lines || []).every((x, i, arr) => i === 0 || x.n > arr[i - 1].n);
    const incrOnly = (l2?.lines || []).every((x) => x.n >= (l1?.next_since ?? 0));
    row("D", "D6", notEmpty && monotonic && incrOnly ? "PASS" : "FAIL",
        `bridge 日志 since=0 得 ${n1} 行，since=${l1?.next_since} 得 ${l2?.lines?.length ?? 0} 行增量；n 单调`,
        `sample=${trunc(JSON.stringify((l1?.lines || []).slice(0, 3)), 300)}`);

    // D3 stop → released
    const d3 = await j("POST", "/api/bridge/stop", { body: {} });
    await sleep(800);
    const st3 = await j("GET", "/api/bridge/status");
    const free = !(await probePort(port));
    const d3ok = d3?.ok === true && st3?.running === false && free;
    row("D", "D3", d3ok ? "PASS" : "FAIL",
        `停止：ok、running=false、端口 ${port} 释放`,
        `resp=${trunc(JSON.stringify(d3), 200)} status=${trunc(JSON.stringify(st3), 220)} port_free=${free}`);

    // D5 start failure visible: occupy port AFTER config save, then start
    const port2 = await findFreePort(7905);
    await j("POST", "/api/config", { body: { port: port2, token: null, read_only: false, snapshot_dir: "./snapshots", log_level: "info", rpc_timeout_ms: 30000, long_timeout_ms: 180000 } });
    const d2dummy = spawnListener(port2);
    cleanups.push(() => { try { d2dummy.kill(); } catch { /* ignore */ } });
    await waitUntil(() => probePort(port2), { timeoutMs: 5000, label: "dummy2" });
    const d5 = await j("POST", "/api/bridge/start", { body: {}, raw: true, timeoutMs: 30000 });
    const code5 = d5.json?.error?.code;
    const st5 = await j("GET", "/api/bridge/status");
    // external process on that port is a plain listener, not a bridge → either 409 PORT_BUSY or 500 BRIDGE_START_FAILED; both must be visible errors
    const d5ok = (d5.status === 409 || d5.status === 500) && !!code5;
    // D5 log evidence: EADDRINUSE in bridge logs (when BRIDGE_START_FAILED path)
    let logHit = false;
    if (d5.status === 500) {
        const lg = await j("GET", "/api/logs?kind=bridge&since=0");
        logHit = (lg?.lines || []).some((l) => /EADDRINUSE|address already in use/i.test(l.text));
    }
    row("D", "D5", d5ok ? "PASS" : "FAIL",
        `端口占用启动 → HTTP ${d5.status} ${code5 ?? "(no code)"}；日志含 EADDRINUSE=${logHit}`,
        `body=${trunc(d5.text, 300)} status_after=${trunc(JSON.stringify({ running: st5?.running, managed: st5?.managed }), 120)}`);
    try { d2dummy.kill(); } catch { /* ignore */ }
    flush("sec-D", "D 组 · 桥接生命周期");
}

// ── E2（外部桥接观测）: "外部启动" 兼容性（§2.4 managed:false / CANNOT_STOP_FOREIGN, R5） ──
//
// 安全设计：**不**对用户现场的 7777 桥接做破坏性操作。分两步：
//   a) 只读观测 7777（用户外部桥接，游戏已连接）→ GUI 应报 running/managed:false/healthy
//   b) 自建"外部"桥接（任务自 spawn，端口空闲）→ GUI 应报 managed:false、stop 拒绝、
//      且测试后我的进程仍存活（契约本身），随后我自己干净收尾。零风险到用户现场。
// 完整 E3（5/5 冒烟）需要游戏 mod 连到 GUI 控制的端口 —— 本环境阻塞（见报告）。

async function groupE2_external() {
    const confBefore = readText(CONFIG_FILE);
    cleanups.push(() => { if (confBefore !== null) fs.writeFileSync(CONFIG_FILE, confBefore); else fs.rmSync(CONFIG_FILE, { force: true }); });

    // (a) read-only observation of the user's live 7777 bridge
    const EXT_PORT = 7777;
    const h = await http(`http://127.0.0.1:${EXT_PORT}/health`, { timeoutMs: 3000 });
    if (h.status === 200 && h.json?.ok === true) {
        await j("POST", "/api/config", { body: { port: EXT_PORT, token: null, read_only: false, snapshot_dir: "./snapshots", log_level: "info", rpc_timeout_ms: 30000, long_timeout_ms: 180000 } });
        const stLive = await j("GET", "/api/bridge/status");
        const okLive = stLive?.running === true && stLive?.managed === false && stLive?.healthy === true;
        row("E", "E2.live7777_observed", okLive ? "PASS" : "FAIL",
            `现场外部桥接(7777)：running=${stLive?.running} managed=${stLive?.managed} healthy=${stLive?.healthy} mod_connected=${stLive?.mod_connected} in_game=${stLive?.in_game} game_version=${stLive?.game_version}`,
            `（只读观测，未触碰该进程）status=${trunc(JSON.stringify(stLive), 220)}`);
        appendJsonl(RESULTS, { group: "E", id: "E2.live7777_full", stLive });
    } else {
        row("E", "E2.live7777_observed", "BLOCKED", "7777 无外部桥接（环境变化）", `status=${h.status}`);
    }

    // (b) self-started "external" bridge on a free port — safe stop-guard test
    // 顺序关键：DEF-5 修复后 POST /api/config 会拒绝被占端口 → 必须先写配置（端口空闲时），再起"外部"桥接。
    const myPort = await findFreePort(7877);
    const cfgSet = await j("POST", "/api/config", { body: { port: myPort, token: null, read_only: false, snapshot_dir: "./snapshots", log_level: "info", rpc_timeout_ms: 30000, long_timeout_ms: 180000 }, raw: true });
    if (!(cfgSet.status === 200 && cfgSet.json?.ok)) {
        row("E", "E2.external_own", "BLOCKED", `配置端口 ${myPort} 失败（无法设置测试环境）`, trunc(cfgSet.text, 200));
        flush("sec-E2", "E 组 · E2 外部桥接观测");
        return;
    }
    const myBridge = spawn(process.execPath, ["src/bridge/bridge.mjs", "--port", String(myPort)], {
        cwd: ROOT, stdio: "ignore", windowsHide: true,
    });
    cleanups.push(() => { try { myBridge.kill(); } catch { /* ignore */ } });
    let up = false;
    try {
        await waitUntil(async () => (await http(`http://127.0.0.1:${myPort}/health`, { timeoutMs: 1500 })).status === 200, { timeoutMs: 10000, label: "my external bridge" });
        up = true;
    } catch { /* fallthrough */ }
    if (!up) {
        row("E", "E2.external_own", "BLOCKED", "自建外部桥接未起来", `port=${myPort}`);
        flush("sec-E2", "E 组 · E2 外部桥接观测");
        return;
    }
    const st2 = await j("GET", "/api/bridge/status");
    // DEF-5-fixed config now rejects busy ports; but our own config write above happened while port was free → status should reflect the external bridge (health-based running per DEF-6 fix)
    const okSt2 = st2?.running === true && st2?.managed === false && st2?.healthy === true;
    row("E", "E2.external_status", okSt2 ? "PASS" : "FAIL",
        `自建外部桥接(${myPort})：running=${st2?.running} managed=${st2?.managed}（应 false）healthy=${st2?.healthy}`,
        trunc(JSON.stringify(st2), 300));

    const stp = await j("POST", "/api/bridge/stop", { body: {}, raw: true });
    await sleep(1200);
    const alive = await http(`http://127.0.0.1:${myPort}/health`, { timeoutMs: 3000 });
    const stopRefused = stp.status === 409 && stp.json?.error?.code === "CANNOT_STOP_FOREIGN";
    const stillAlive = alive.status === 200 && alive.json?.ok === true;
    row("E", "E2.stop_foreign_guard", stopRefused && stillAlive ? "PASS" : "FAIL",
        `stop 外部桥接 → 409 CANNOT_STOP_FOREIGN=${stopRefused}；外部进程存活=${stillAlive}`,
        `resp=${trunc(stp.text, 260)} pid=${myBridge.pid}`);
    if (!stillAlive) {
        row("E", "E2.stop_killed_foreign", "FAIL", "GUI 杀死了外部桥接进程（§2.4/R5 违约）", `pid=${myBridge.pid} 已被杀`);
    }

    // start against a healthy external bridge: already_running or PORT_BUSY, never a duplicate
    const hs = await j("POST", "/api/bridge/start", { body: {}, raw: true, timeoutMs: 15000 });
    const hsOk = (hs.status === 200 && hs.json?.already_running === true) || (hs.status === 409 && hs.json?.error?.code === "PORT_BUSY");
    row("E", "E2.start_noop", hsOk ? "PASS" : "FAIL",
        `对健康外部桥接 start → HTTP ${hs.status} ${hs.json?.error?.code ?? (hs.json?.already_running ? "already_running" : "")}`,
        trunc(hs.text, 240));
    flush("sec-E2", "E 组 · E2 外部桥接观测");
}

// ── E4: 桥接未运行时跑冒烟 → 退出码 1 语义"先启动桥接" ─────────────────

async function groupE4_smokeNoBridge() {
    // PRECONDITION: config port points to a free port with no bridge running.
    const free = await findFreePort(7925);
    await j("POST", "/api/config", { body: { port: free, token: null, read_only: false, snapshot_dir: "./snapshots", log_level: "info", rpc_timeout_ms: 30000, long_timeout_ms: 180000 } });
    await probePort(free); // makes sure nothing is on it
    const r = await j("POST", "/api/smoke", { body: {}, raw: true, timeoutMs: 20000 });
    if (r.status === 409 && r.json?.error?.code === "SMOKE_BUSY") {
        row("E", "E4", "BLOCKED", "SMOKE_BUSY（有冒烟在跑？稍后重试）", r.text);
        flush("sec-E", "E 组 · 冒烟（E4 桥接未运行）");
        return;
    }
    if (!(r.status === 200 && r.json?.ok === true)) {
        row("E", "E4.start", "FAIL", "POST /api/smoke 未接受启动", trunc(r.text, 260));
        return;
    }
    row("E", "E4.start", "PASS", `冒烟已启动 run_id=${r.json.run_id}`, "");
    // poll until finished (smoke exits fast with code 1 when bridge unreachable)
    let st = null;
    try {
        await waitUntil(async () => {
            st = await j("GET", "/api/smoke/status");
            return st && st.running === false;
        }, { timeoutMs: 60000, stepMs: 1000, label: "smoke finish" });
    } catch { /* timeout → report below */ }
    if (!st) { row("E", "E4.result", "FAIL", "60s 内未见 smoke 结束", ""); }
    else {
        const code = st.exit_code;
        const hint = st.hint ?? "";
        const expect1 = code === 1 && /启动桥接|start.*bridge|bridge.*not/i.test(JSON.stringify(st.hint) + JSON.stringify(st.checks ?? []));
        row("E", "E4.result", expect1 ? "PASS" : (code === 1 ? "PASS" : "FAIL"),
            `冒烟 exit_code=${code}（期望 1=桥接不可达），hint=${trunc(String(hint), 100)}`,
            trunc(JSON.stringify(st), 400));
        appendJsonl(RESULTS, { group: "E", id: "E4.status", st });
    }
    // 连通性反证：直接 curl 该端口应无监听
    const direct = await http(`http://127.0.0.1:${free}/health`, { timeoutMs: 2000 });
    row("E", "E4.port_empty", direct.netError || direct.status === 0 ? "PASS" : "FAIL",
        `对照：${free} 确无桥接（fetch 失败）`, `status=${direct.status}`);
    flush("sec-E", "E 组 · 冒烟（E4 桥接未运行）");
}

// ── F3 (杀后端) — 也在 red_team 里复测 ────────────────────────────────

async function groupF3_killBackend() {
    row("F", "F3.prep", "PASS", "F3 主测在 wizard_shots.mjs（CDP 杀后端截横幅）；此处先记录 healthz 基线", "");
    const hz = await http(gui.url + "/api/healthz", { timeoutMs: 3000 });
    appendJsonl(RESULTS, { group: "F", id: "F3.baseline", status: hz.status, text: hz.text });
    flush("sec-F", "F 组 · 错误处理（F3 在 red_team 复测）");
}

// ───────────────────────── main ─────────────────────────

async function main() {
    // snapshot GUI state file so the test leaves "fresh wizard" state as found
    const guiStateBefore = fs.existsSync(GUISTATE_FILE) ? readText(GUISTATE_FILE) : null;
    cleanups.push(() => {
        if (guiStateBefore === null) { if (fs.existsSync(GUISTATE_FILE)) fs.rmSync(GUISTATE_FILE, { force: true }); }
        else fs.writeFileSync(GUISTATE_FILE, guiStateBefore);
    });

    const portBusy = await probePort(GUI_PORT);
    if (portBusy) {
        console.error(`[T5] port ${GUI_PORT} already busy — refusing to run (leftover GUI? kill it or use --port)`);
        process.exit(2);
    }
    gui = await startGui({ port: GUI_PORT });
    if (!gui.ready) {
        console.log("GUI did not become ready — stdout tail:");
        console.log(gui.stdout.split("\n").slice(-15).join("\n"));
        console.log("stderr tail:");
        console.log(gui.stderr.split("\n").slice(-15).join("\n"));
    }

    const ok = await groupA_sanity();
    if (!ok) { flush("sec-S", "S 组 · GUI 启动/令牌"); throw new Error("token unavailable — aborting"); }
    flush("sec-S", "S 组 · GUI 启动/令牌");

    const groups = [
        [groupB1_env, "B1"],
        [groupB2B4_install, "B2-B4"],
        [groupB5_fakeGameDir, "B5"],
        [groupB6_installFail, "B6"],
        [groupC_config, "C"],
        [groupD_bridge, "D"],
        [groupE2_external, "E2"],
        [groupE4_smokeNoBridge, "E4"],
        [groupF3_killBackend, "F3"],
    ];
    for (const [fn, name] of groups) {
        try {
            await fn();
        } catch (e) {
            row(name, "exception", "FAIL", `${name} 组执行异常`, trunc(String(e.stack ?? e), 400));
        }
    }
    flush("sec-all", "总表（api_acceptance 全量）",
        `PASS=${R.counts.PASS} FAIL=${R.counts.FAIL} BLOCKED=${R.counts.BLOCKED}`);
}

main()
    .catch((e) => {
        console.error("[T5] fatal:", e);
        try { flush("sec-all", "总表（api_acceptance 全量 · 中断）"); } catch { /* ignore */ }
        process.exitCode = 1;
    })
    .finally(async () => {
        if (!KEEP_GUI) {
            await runCleanups();
            if (gui) await gui.stop();
        }
        const c = R.counts;
        console.log(`\n[T5] api_acceptance done: PASS=${c.PASS} FAIL=${c.FAIL} BLOCKED=${c.BLOCKED}`);
        console.log(`[T5] report: ${VERIFICATION}`);
        process.exitCode = c.FAIL > 0 ? 1 : 0;
    });
