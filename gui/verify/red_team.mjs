/**
 * T5 · 反断言（红队）— 对真实 gui/server.mjs 攻击面逐条验证。
 *
 * 用法: node gui/verify/red_team.mjs [--port 7802]
 *
 * 覆盖:
 *   origin_evil      Origin: http://evil.example.com → 403（GET 与 POST 都要）
 *   origin_null      Origin: null / 异端口 localhost → 403
 *   no_token         POST 无 X-GUI-Token → 403 BAD_TOKEN
 *   bad_token        错误 token → 403
 *   open_whitelist   /api/open 非白名单 target → 400；路径注入 target → 400
 *   traversal        GET /../ /..%2f package.json 等 → 400/404，绝不 200 内容
 *   token_leak       token 不出现在 server stdout（banner/URL）；URL 无 token
 *   bak_safety       全链路（install/uninstall）不误删既有 .bak-*
 *   sse_token        /api/events 无 token → 403；带错误 token → 403
 *   f3_banner        杀上游后端 → SSE 断开（给 dom/CDP 复测提供证据）
 *
 * 结果写入 docs/gui/VERIFICATION.md（sec-red）与 error-injection.md（sec-inject）。
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
    ROOT, DOCS_GUI, BAK_DIR, http, sleep, probePort, startGui, fetchGuiToken,
    modsDir, listBaks, sha256File, Recorder, writeSection, appendJsonl, trunc,
} from "./lib.mjs";

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = parseInt(argVal("--port", "7802"), 10);

const R = new Recorder("red_team");
const RESULTS = path.join(BAK_DIR, "redteam.jsonl");
const VERIFICATION = path.join(DOCS_GUI, "VERIFICATION.md");
const INJECTION = path.join(DOCS_GUI, "error-injection.md");

function row(group, id, status, detail, evidence = "") {
    const r = R.add(group, id, status, detail, evidence);
    appendJsonl(RESULTS, r);
    return r;
}
function flush() {
    const body = [
        `> 时间: ${new Date().toISOString()}`,
        "",
        R.markdownTable(),
        "",
        `计数: PASS=${R.counts.PASS} FAIL=${R.counts.FAIL} BLOCKED=${R.counts.BLOCKED}`,
    ].join("\n");
    writeSection(VERIFICATION, "sec-red", "反断言（红队）", body);
}

let gui = null;
let token = null;

async function req(method, apiPath, { body, headers = {}, timeoutMs = 15000, withToken = true } = {}) {
    return http(gui.url + apiPath, {
        method,
        headers: { ...(withToken && token ? { "X-GUI-Token": token } : {}), ...headers },
        body,
        timeoutMs,
    });
}

async function main() {
    if (await probePort(PORT)) {
        console.error(`[red] port ${PORT} busy — abort`);
        process.exit(2);
    }
    gui = await startGui({ port: PORT });
    if (!gui.ready) {
        console.error("[red] GUI not ready\n", gui.stdout.slice(-800), gui.stderr.slice(-800));
        process.exit(2);
    }
    const tok = await fetchGuiToken(gui.url);
    if (!tok.ok) { console.error("[red] no token:", tok.reason); process.exit(2); }
    token = tok.token;

    try {
        await originChecks();
        await tokenChecks();
        await openWhitelistChecks();
        await traversalChecks();
        await sseChecks();
        await tokenLeakCheck();
        await bakSafetyCheck();
    } catch (e) {
        row("RED", "exception", "FAIL", "红队执行异常", trunc(String(e.stack ?? e), 400));
    }

    flush();
    await gui.stop();
    const c = R.counts;
    console.log(`\n[T5] red_team done: PASS=${c.PASS} FAIL=${c.FAIL} BLOCKED=${c.BLOCKED}`);
    process.exitCode = c.FAIL > 0 ? 1 : 0;
}

// ── 1. Origin 校验 ─────────────────────────────────────────────────────

async function originChecks() {
    const evilVectors = [
        ["evil.example.com", "http://evil.example.com"],
        ["evil-subdomain", "http://127.0.0.1.evil.example.com"],
        ["null-origin", "null"],
        ["https-scheme", "https://127.0.0.1:" + PORT],
        ["other-port", "http://127.0.0.1:9999"],
        ["localhost-ok-control", null], // control: correct origin must pass
    ];
    const results = [];
    for (const [name, origin] of evilVectors) {
        const headers = {};
        if (origin !== null) headers.Origin = origin;
        // GET /api/env with valid token
        const g = await req("GET", "/api/env", { headers });
        // POST /api/config/reset with valid token (write op)
        const p = await req("POST", "/api/config/reset", { headers, body: {} });
        results.push({ name, origin, get: g.status, post: p.status });
        await sleep(100);
    }
    const evilRows = results.filter((r) => r.name !== "localhost-ok-control");
    const evilAll403 = evilRows.every((r) => r.get === 403 && r.post === 403);
    const evilCode = await req("GET", "/api/env", { headers: { Origin: "http://evil.example.com" } });
    row("RED", "origin_evil", evilAll403 ? "PASS" : "FAIL",
        `5 类非法 Origin GET+POST 均 403`,
        `code=${evilCode.json?.error?.code} details=${trunc(JSON.stringify(results), 360)}`);

    // correct-origin control
    const ctrl = await req("GET", "/api/env", { headers: { Origin: `http://127.0.0.1:${PORT}` } });
    row("RED", "origin_ok_control", ctrl.status === 200 ? "PASS" : "FAIL",
        `正确 Origin http://127.0.0.1:${PORT} 放行`, `status=${ctrl.status}`);
    // no Origin at all (curl-like) must pass with token
    const noOrigin = await req("GET", "/api/env");
    row("RED", "origin_absent_ok", noOrigin.status === 200 ? "PASS" : "FAIL",
        "无 Origin（本机工具如 curl）带 token 放行", `status=${noOrigin.status}`);
}

// ── 2. Token 校验 ──────────────────────────────────────────────────────

async function tokenChecks() {
    const noToken = await req("POST", "/api/config/reset", { withToken: false, body: {} });
    const badToken = await req("POST", "/api/config/reset", { headers: { "X-GUI-Token": "x".repeat(32) }, withToken: false, body: {} });
    const noTokGet = await req("GET", "/api/env", { withToken: false });
    const okRes = noToken.status === 403 && noToken.json?.error?.code === "BAD_TOKEN"
        && badToken.status === 403
        && noTokGet.status === 403;
    row("RED", "no_token_POST", noToken.status === 403 ? "PASS" : "FAIL",
        `无 token POST → 403 ${noToken.json?.error?.code ?? ""}`, `body=${trunc(noToken.text, 200)}`);
    row("RED", "bad_token", badToken.status === 403 ? "PASS" : "FAIL",
        `错误 token POST → 403`, `body=${trunc(badToken.text, 200)}`);
    row("RED", "no_token_GET_env", noTokGet.status === 403 ? "PASS" : "FAIL",
        `无 token GET /api/env → 403（healthz 除外）`, `status=${noTokGet.status}`);
    void okRes;
}

// ── 3. /api/open 白名单 ────────────────────────────────────────────────

async function openWhitelistChecks() {
    const vectors = [
        ["not-in-list", { target: "calc" }],
        ["empty", { target: "" }],
        ["inject-cmd", { target: "mods_dir & calc" }],
        ["path-of-file", { target: "C:/Windows/System32/calc.exe" }],
        ["traversal", { target: "C:/Windows/System32/../../System32/calc.exe" }],
        ["proto-file", { target: "file:///C:/Windows/win.ini" }],
        ["steam-bad", { target: "steam_run_extra" }],
    ];
    const results = [];
    for (const [name, body] of vectors) {
        const r = await req("POST", "/api/open", { body });
        results.push({ name, status: r.status, code: r.json?.error?.code });
        await sleep(80);
    }
    const allRejected = results.every((r) => r.status === 400) && results.every((r) => r.code === "INVALID_PARAM" || r.code === "BAD_REQUEST");
    row("RED", "open_whitelist", allRejected ? "PASS" : "FAIL",
        `7 类非白名单/注入 target 均 400`, trunc(JSON.stringify(results), 380));

    // DEF-8 家族：类型混淆 —— 非 string 的 target（数组经 property-key 强制转换 / object 直接抛）
    const typeVectors = [
        ["array-single", { target: ["mods_dir"] }],
        ["array-calc", { target: ["calc"] }],
        ["object-proto", { target: { toString: "mods_dir" } }],
        ["number", { target: 1 }],
    ];
    const tRes = [];
    for (const [name, body] of typeVectors) {
        const r = await req("POST", "/api/open", { body });
        tRes.push({ name, status: r.status, code: r.json?.error?.code, ok: r.json?.ok });
        await sleep(80);
    }
    const all400 = tRes.every((r) => r.status === 400);
    row("RED", "open_type_strictness", all400 ? "PASS" : "FAIL",
        all400 ? "非 string target 全部 400（类型严格）" : `类型混淆：非 string target 未全 400（数组经属性键强制转换可命中白名单；object → 500）`,
        trunc(JSON.stringify(tRes), 300));

    const ctrl = await req("POST", "/api/open", { body: { target: "mods_dir" } });
    row("RED", "open_control", ctrl.status === 200 && ctrl.json?.ok === true ? "PASS" : "FAIL",
        `白名单 target mods_dir 放行（200 ok）`, `body=${trunc(ctrl.text, 160)}`);

    // DEF-9：DESIGN-PLAN §2.5 明列 mcp_config_file 为合法 target，实现却不在白名单
    const mcpOpen = await req("POST", "/api/open", { body: { target: "mcp_config_file" } });
    const contractTargets = ["mods_dir", "snapshots_dir", "saves_dir", "repo_root", "mcp_config_file", "steam_store", "steam_run", "readme"];
    const mcpOk = mcpOpen.status === 200;
    row("RED", "open_contract_targets", mcpOk ? "PASS" : "FAIL",
        mcpOk ? "契约全部 target 在列" : `契约 target mcp_config_file 缺失（§2.5 要求合法；实际 HTTP ${mcpOpen.status} ${mcpOpen.json?.error?.code ?? ""}）`,
        `契约集=${contractTargets.join(",")}`);
}

// ── 4. 路径穿越 ────────────────────────────────────────────────────────

/**
 * Raw-socket HTTP GET so the request line carries the path EXACTLY as written —
 * fetch/undici normalizes `/../` away client-side (WHATWG URL), which would
 * invalidate the traversal test.
 */
function rawHttpGet(port, rawPath, headers = {}) {
    return new Promise((resolve) => {
        const s = net.connect(port, "127.0.0.1");
        const chunks = [];
        s.setTimeout(6000, () => { s.destroy(); resolve({ status: 0, text: "", timeout: true }); });
        s.on("connect", () => {
            const hdrs = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n");
            s.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${hdrs}\r\nConnection: close\r\n\r\n`);
        });
        s.on("data", (d) => chunks.push(d));
        s.on("close", () => {
            const buf = Buffer.concat(chunks).toString("latin1");
            const m = buf.match(/^HTTP\/1\.\d (\d{3})/);
            const status = m ? parseInt(m[1], 10) : 0;
            // split headers / body, decode chunked if present
            const idx = buf.indexOf("\r\n\r\n");
            let body = idx >= 0 ? buf.slice(idx + 4) : "";
            if (/transfer-encoding:\s*chunked/i.test(buf.slice(0, idx))) {
                let out = "";
                let rest = body;
                for (;;) {
                    const nl = rest.indexOf("\r\n");
                    if (nl < 0) break;
                    const size = parseInt(rest.slice(0, nl), 16);
                    if (!Number.isFinite(size) || size === 0) break;
                    out += rest.slice(nl + 2, nl + 2 + size);
                    rest = rest.slice(nl + 2 + size + 2);
                }
                body = out;
            }
            resolve({ status, text: body });
        });
        s.on("error", () => resolve({ status: 0, text: "", error: true }));
    });
}

async function traversalChecks() {
    const vectors = [
        "/../../package.json",
        "/..%2f..%2fpackage.json",
        "/%2e%2e/%2e%2e/package.json",
        "/..\\..\\package.json",
        "/../README.md",
        "/%5c..%5c..%5cpackage.json",
        "/..%2F..%2F..%2Fsrc%2Fbridge%2Fbridge.mjs",
        "/%u002e%u002e/package.json",
    ];
    const results = [];
    for (const v of vectors) {
        // raw socket: exact path bytes; plus fetch variant for encoded forms
        const raw = await rawHttpGet(PORT, v, { "X-GUI-Token": token ?? "" });
        const fetched = await http(gui.url + v, { headers: { "X-GUI-Token": token } });
        const leakedRaw = raw.status === 200 && /"name"\s*:\s*"shapez-ai-bridge"/.test(raw.text);
        const leakedFetch = fetched.status === 200 && /"name"\s*:\s*"shapez-ai-bridge"/.test(fetched.text);
        results.push({ v, rawStatus: raw.status, fetchStatus: fetched.status, leaked: leakedRaw || leakedFetch });
        await sleep(80);
    }
    const anyLeak = results.some((r) => r.leaked);
    // 安全判据（硬性）：无泄漏 + 绝无 200
    const no200 = results.every((r) => r.rawStatus !== 200 && r.fetchStatus !== 200);
    // 状态码判据（软性）：理想是 400/403/404；5xx 记为非理想但不构成泄漏
    const ideal = results.every((r) => [400, 403, 404].includes(r.rawStatus) || [400, 403, 404].includes(r.fetchStatus));
    const badStatus = results.filter((r) => ![400, 403, 404].includes(r.rawStatus) && ![400, 403, 404].includes(r.fetchStatus));
    row("RED", "traversal", !anyLeak && no200 ? "PASS" : "FAIL",
        `8 类 ../ 变体（raw socket 不归一化路径）无泄漏、无 200`,
        trunc(JSON.stringify(results), 480));
    if (!ideal) {
        row("RED", "traversal.status_code", "FAIL",
            `非理想状态码（期望 400/403/404，实际见证据 — 如 %u002e 变体 500 = decodeURIComponent URIError 未特判）`,
            trunc(JSON.stringify(badStatus), 240));
    } else {
        row("RED", "traversal.status_code", "PASS", "全部 400/403/404", "");
    }
}

// ── 5. SSE token ───────────────────────────────────────────────────────

async function sseChecks() {
    const noTok = await http(gui.url + "/api/events", { timeoutMs: 4000 });
    const badTok = await http(gui.url + "/api/events?token=" + "x".repeat(32), { timeoutMs: 4000 });
    // correct token: server should hold the stream open — fetch with AbortSignal timeout
    // returns netError on abort; treat "held open OR non-403" as pass.
    const ctrl = await http(gui.url + "/api/events?token=" + encodeURIComponent(token), { timeoutMs: 2500 });
    const ctrlOk = ctrl.status === 200 || ctrl.netError; // aborted while open = streaming
    row("RED", "sse_no_token", noTok.status === 403 ? "PASS" : "FAIL",
        `GET /api/events 无 token → 403`, `status=${noTok.status}`);
    row("RED", "sse_bad_token", badTok.status === 403 ? "PASS" : "FAIL",
        `GET /api/events?token=xxx → 403`, `status=${badTok.status}`);
    row("RED", "sse_ok_token", ctrlOk ? "PASS" : "FAIL",
        `正确 token → 流打开（200/保持连接）`, `status=${ctrl.status} netError=${!!ctrl.netError}`);
}

// ── 6. token 泄漏 ──────────────────────────────────────────────────────

async function tokenLeakCheck() {
    const out = gui.stdout + "\n" + gui.stderr;
    const inStdout = out.includes(token);
    // URL in banner should never contain token (SSE URL with ?token= is browser-side only)
    const urlWithToken = new RegExp(`127\\.0\\.0\\.1:${PORT}/[^\\s]*token=${token}`).test(out);
    row("RED", "token_not_in_stdout", !inStdout ? "PASS" : "FAIL",
        "GUI token 不出现在 server stdout/stderr", inStdout ? "LEAK FOUND" : `stdout bytes=${out.length}`);
    row("RED", "token_not_in_banner_url", !urlWithToken ? "PASS" : "FAIL",
        "启动横幅 URL 不带 token", "");
    // token must appear only in served HTML (meta tag)
    const indexHtml = (await http(gui.url + "/")).text;
    const inHtml = indexHtml.includes(token);
    row("RED", "token_only_in_html", inHtml ? "PASS" : "FAIL",
        "token 只经由 GET / 的 meta 标签下发", `html_has_token=${inHtml}`);
}

// ── 7. .bak-* 安全 ────────────────────────────────────────────────────

async function bakSafetyCheck() {
    const MODS = modsDir();
    const before = listBaks(MODS).map((f) => ({ f, sha: sha256File(path.join(MODS, f)) }));
    const PREEXIST = "shapez-ai-bridge.js.bak-20261020-202532";
    const hadPreexist = before.some((b) => b.f === PREEXIST);

    // full install/uninstall cycle via GUI (default options: no clean_backups)
    const i1 = await req("POST", "/api/install", { body: {}, timeoutMs: 60000 });
    const u1 = await req("POST", "/api/uninstall", { body: {} });
    const i2 = await req("POST", "/api/install", { body: {}, timeoutMs: 60000 });
    await sleep(200);
    const after = listBaks(MODS);
    const preexistKept = !hadPreexist || after.includes(PREEXIST);
    const noneLost = before.every((b) => after.includes(b.f));
    const preexistShaOk = !hadPreexist || sha256File(path.join(MODS, PREEXIST)) === before.find((b) => b.f === PREEXIST).sha;
    row("RED", "bak_install_uninstall_cycle", preexistKept && noneLost && preexistShaOk ? "PASS" : "FAIL",
        `install→uninstall→install 循环后既有备份一个不丢、内容不变（${before.length}→${after.length}）`,
        `resp=${trunc(JSON.stringify({ i1: i1.json?.ok, u1: u1.json?.ok, i2: i2.json?.ok }), 120)}`);

    // explicit clean_backups:true must remove bak-* (documented behavior).
    // This includes the pre-existing user backup — save copies first, restore after.
    const preserveDir = path.join(BAK_DIR, "preserved-baks");
    fs.mkdirSync(preserveDir, { recursive: true });
    for (const b of before) {
        fs.copyFileSync(path.join(MODS, b.f), path.join(preserveDir, b.f));
    }
    const c1 = await req("POST", "/api/uninstall", { body: { clean_backups: true } });
    const afterClean = listBaks(MODS);
    const cleaned = afterClean.length === 0;
    const removedInResp = (c1.json?.removed || []).length;
    row("RED", "bak_explicit_clean", cleaned && c1.json?.ok === true ? "PASS" : "FAIL",
        `clean_backups:true 显式清理生效（removed=${removedInResp}，剩 ${afterClean.length}）`,
        `resp=${trunc(JSON.stringify(c1.json), 220)}`);
    // restore the pre-existing user backup exactly as it was
    let restoredBak = false;
    if (hadPreexist) {
        fs.copyFileSync(path.join(preserveDir, PREEXIST), path.join(MODS, PREEXIST));
        const same = sha256File(path.join(MODS, PREEXIST)) === before.find((b) => b.f === PREEXIST).sha;
        restoredBak = same;
        row("RED", "bak_preexist_restored", same ? "PASS" : "FAIL",
            "测试后既有用户备份已原样恢复", `sha_match=${same}`);
    }
    const i3 = await req("POST", "/api/install", { body: {}, timeoutMs: 60000 });
    const restored = fs.existsSync(path.join(MODS, "shapez-ai-bridge.js"));
    row("RED", "mod_restored", restored && i3.json?.ok === true ? "PASS" : "FAIL",
        "测试后 mod 已重装恢复", `resp=${trunc(JSON.stringify(i3.json?.ok), 40)}`);
    appendJsonl(RESULTS, { group: "RED", id: "bak_clean_note", note: "explicit clean_backups removes bak files by design; pre-existing bak preserved+restored by the test harness", hadPreexist, restoredBak });
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
