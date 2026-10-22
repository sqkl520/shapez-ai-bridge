/**
 * T5 verification shared helpers — zero dependency (Node built-ins only).
 *
 * Used by api_acceptance.mjs / red_team.mjs / dom_gate.mjs / wizard_shots.mjs.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const VERIFY_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(VERIFY_DIR, "..", "..");
export const DOCS_GUI = path.join(ROOT, "docs", "gui");
export const BAK_DIR = path.join(DOCS_GUI, "logs");

export function ensureDirs() {
    fs.mkdirSync(DOCS_GUI, { recursive: true });
    fs.mkdirSync(BAK_DIR, { recursive: true });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitUntil(fn, { timeoutMs = 15000, stepMs = 250, label = "condition" } = {}) {
    const t0 = Date.now();
    for (;;) {
        let v;
        try { v = await fn(); } catch { v = false; }
        if (v) return v;
        if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
        await sleep(stepMs);
    }
}

/** HTTP request returning {status, json, text, headers}. json=null when body isn't JSON.
 *  NOTE: both the fetch AND the body read are guarded — a streaming endpoint (SSE)
 *  resolves headers immediately but holds the body open; the abort then rejects
 *  res.text(), which must come back as netError rather than throw. */
export async function http(url, { method = "GET", headers = {}, body, timeoutMs = 15000 } = {}) {
    const opts = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) {
        opts.body = typeof body === "string" ? body : JSON.stringify(body);
        if (!("content-type" in lower(headers))) opts.headers["Content-Type"] = "application/json";
    }
    let res;
    try {
        res = await fetch(url, opts);
    } catch (e) {
        return { status: 0, json: null, text: String(e.message || e), headers: {}, netError: true };
    }
    let text = "";
    try {
        text = await res.text();
    } catch (e) {
        // aborted mid-body (e.g. SSE stream held open) — surface as netError, keep status
        const h = {};
        try { res.headers.forEach((v, k) => { h[k.toLowerCase()] = v; }); } catch { /* ignore */ }
        return { status: res.status, json: null, text: String(e.message || e), headers: h, netError: true, partial: true };
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    const h = {};
    res.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
    return { status: res.status, json, text, headers: h };
}

function lower(o) {
    const out = {};
    for (const k of Object.keys(o)) out[k.toLowerCase()] = o[k];
    return out;
}

export function probePort(port, host = "127.0.0.1") {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.once("error", () => resolve(true)); // busy
        s.once("listening", () => s.close(() => resolve(false)));
        s.listen(port, host);
    });
}

export async function findFreePort(from, to = from + 60) {
    for (let p = from; p <= to; p++) {
        if (!(await probePort(p))) return p;
    }
    return null;
}

export function sha256File(p) {
    return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

export function readText(p) {
    try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

export function modsDir() {
    return path.join(process.env.APPDATA || "", "shapez.io", "mods");
}

export function listBaks(mods = modsDir()) {
    try {
        return fs.readdirSync(mods).filter((f) => /^shapez-ai-bridge\.js\.bak-/.test(f));
    } catch {
        return [];
    }
}

/** Spawn `node gui/server.mjs` and wait until /api/healthz responds. */
export async function startGui({ port = 7801, extraArgs = [], env = {} } = {}) {
    ensureDirs();
    const logPath = path.join(BAK_DIR, `gui-server-${port}-${Date.now()}.log`);
    const out = fs.createWriteStream(logPath, { flags: "a" });
    const child = spawn(process.execPath, ["gui/server.mjs", "--no-open", "--port", String(port), ...extraArgs], {
        cwd: ROOT,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; out.write(d); });
    child.stderr.on("data", (d) => { stderr += d; out.write(d); });
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    try {
        await waitUntil(async () => {
            const r = await http(`${url}/api/healthz`, { timeoutMs: 2000 });
            return r.status === 200;
        }, { timeoutMs: 20000, label: "gui server ready" });
        ready = true;
    } catch { /* fallthrough */ }
    return {
        port, url, proc: child, logPath,
        get stdout() { return stdout; },
        get stderr() { return stderr; },
        ready,
        async stop(signal = "SIGTERM") {
            if (child.exitCode === null && child.signalCode === null) {
                try { child.kill(signal); } catch { /* ignore */ }
                await waitUntil(() => child.exitCode !== null || child.signalCode !== null, { timeoutMs: 5000, label: "gui exit", stepMs: 100 }).catch(() => {});
            }
            // robustness: if my child's port is still held AND the holder is MY pid, force-kill it.
            // Never kill a listener whose pid differs from the child I spawned (it's not mine).
            for (let attempt = 0; attempt < 2; attempt++) {
                if (!(await probePort(port))) break;
                try {
                    const { execFileSync } = await import("node:child_process");
                    const out = execFileSync("cmd", ["/c", `netstat -ano | findstr ":${port} " | findstr LISTENING`], { encoding: "utf8", timeout: 5000 });
                    const pid = (out.match(/(\d+)\s*$/m) || [])[1];
                    if (pid && child.pid && String(child.pid) === String(pid)) {
                        execFileSync("taskkill", ["/PID", pid, "/F"], { timeout: 5000 });
                    } else if (pid) {
                        console.error(`[lib] port ${port} still held by pid=${pid} (not mine, pid=${child.pid}) — leaving it alone`);
                        break;
                    }
                } catch { /* ignore */ }
                await sleep(500);
            }
            out.end();
        },
    };
}

/** GET / and extract <meta name="gui-token" content="..."> */
export async function fetchGuiToken(url) {
    const r = await http(url + "/");
    if (r.status !== 200) return { ok: false, reason: `GET / -> HTTP ${r.status}`, token: null, html: r.text };
    const m = r.text.match(/<meta\s+name=["']gui-token["']\s+content=["']([^"']+)["']/i)
        || r.text.match(/<meta\s+content=["']([^"']+)["']\s+name=["']gui-token["']/i);
    if (!m) return { ok: false, reason: "gui-token meta tag not found in GET /", token: null, html: r.text };
    return { ok: true, token: m[1], html: r.text };
}

// ───────────────────────────── report writer ─────────────────────────────
//
// A run accumulates rows; writeReport rewrites the marked region in a
// markdown file so partial results survive interruption (分批落盘).

export class Recorder {
    constructor(title) {
        this.title = title;
        this.rows = []; // {group, id, status, detail, evidence}
        this.startedAt = new Date().toISOString();
    }
    add(group, id, status, detail, evidence = "") {
        const row = { group, id, status, detail, evidence, ts: new Date().toISOString() };
        this.rows.push(row);
        const icon = status === "PASS" ? "PASS" : status === "FAIL" ? "FAIL" : "BLOCK";
        console.log(`[${icon}] ${group}/${id} — ${detail}${evidence ? ` | ${trunc(evidence, 220)}` : ""}`);
        return row;
    }
    pass(group, id, detail, evidence) { return this.add(group, id, "PASS", detail, evidence); }
    fail(group, id, detail, evidence) { return this.add(group, id, "FAIL", detail, evidence); }
    block(group, id, detail, evidence) { return this.add(group, id, "BLOCKED", detail, evidence); }
    get counts() {
        const c = { PASS: 0, FAIL: 0, BLOCKED: 0 };
        for (const r of this.rows) c[r.status]++;
        return c;
    }
    markdownTable() {
        const lines = ["| 项 | 结果 | 判据 / 详情 | 证据 |", "|---|---|---|---|"];
        for (const r of this.rows) {
            lines.push(`| ${r.group}/${r.id} | **${r.status}** | ${esc(r.detail)} | ${esc(trunc(r.evidence, 400))} |`);
        }
        return lines.join("\n");
    }
}

export function trunc(s, n) {
    s = String(s ?? "");
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function esc(s) {
    return String(s ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

/**
 * Rewrite `file` replacing the region between markers for `sectionId`.
 * Creates file with an H1 + summary if missing; appends section if new.
 */
export function writeSection(file, sectionId, sectionTitle, body) {
    ensureDirs();
    const BEGIN = `<!-- BEGIN:${sectionId} -->`;
    const END = `<!-- END:${sectionId} -->`;
    const region = `${BEGIN}\n${body}\n${END}`;
    let content = readText(file);
    if (content === null) content = `# ${path.basename(file, ".md")} — T5 live report\n\n> 生成: ${new Date().toISOString()}\n`;
    const b = content.indexOf(BEGIN);
    const e = content.indexOf(END);
    if (b >= 0 && e > b) {
        content = content.slice(0, b) + region + content.slice(e + END.length);
    } else {
        content += `\n\n## ${sectionTitle}\n\n${region}\n`;
    }
    fs.writeFileSync(file, content, "utf8");
}

/** Persistent JSONL of raw results (machine readable). */
export function appendJsonl(file, obj) {
    ensureDirs();
    fs.appendFileSync(file, JSON.stringify(obj) + "\n", "utf8");
}

export function nowIso() {
    return new Date().toISOString();
}
