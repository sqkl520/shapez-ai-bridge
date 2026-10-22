/**
 * Minimal zero-dependency CDP driver (Node ≥22 native WebSocket).
 * Used to drive headless Chrome for interactive screenshots and DOM checks.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findFreePort, sleep, waitUntil } from "./lib.mjs";

export function findBrowser() {
    const candidates = [
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return null;
}

export class CdpSession {
    constructor() { this.ws = null; this.nextId = 1; this.pending = new Map(); this.child = null; this.profileDir = null; }

    static async launch({ url = "about:blank", width = 1280, height = 800, reducedMotion = false, extraArgs = [] } = {}) {
        const browser = findBrowser();
        if (!browser) throw new Error("no Chrome/Edge found");
        const port = await findFreePort(9333, 9399);
        if (!port) throw new Error("no free CDP port in 9333-9399");
        const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "t5-cdp-"));
        const flags = [
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--hide-scrollbars",
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${profileDir}`,
            `--window-size=${width},${height}`,
            "--remote-allow-origins=*",
        ];
        if (reducedMotion) flags.push("--force-prefers-reduced-motion");
        flags.push(...extraArgs, url);
        const child = spawn(browser, flags, { stdio: ["ignore", "pipe", "pipe"] });
        const s = new CdpSession();
        s.child = child;
        s.profileDir = profileDir;
        s.port = port;
        await waitUntil(async () => {
            const r = await fetch(`http://127.0.0.1:${port}/json/list`).catch(() => null);
            if (!r || r.status !== 200) return false;
            s.tabs = await r.json();
            return s.tabs.some((t) => t.type === "page");
        }, { timeoutMs: 15000, label: "cdp endpoint", stepMs: 300 });
        const tab = s.tabs.find((t) => t.type === "page");
        await s.connect(tab.webSocketDebuggerUrl);
        return s;
    }

    async connect(wsUrl) {
        this.ws = new WebSocket(wsUrl);
        this.ws.addEventListener("message", (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
                else resolve(msg.result);
            } else if (msg.method && this._eventHandlers?.has(msg.method)) {
                for (const cb of this._eventHandlers.get(msg.method)) cb(msg.params);
            }
        });
        await new Promise((resolve, reject) => {
            this.ws.addEventListener("open", resolve, { once: true });
            this.ws.addEventListener("error", (e) => reject(new Error("ws error")), { once: true });
        });
    }

    on(method, cb) {
        if (!this._eventHandlers) this._eventHandlers = new Map();
        if (!this._eventHandlers.has(method)) this._eventHandlers.set(method, new Set());
        this._eventHandlers.get(method).add(cb);
        return () => this._eventHandlers.get(method).delete(cb);
    }

    send(method, params = {}) {
        const id = this.nextId++;
        const payload = JSON.stringify({ id, method, params });
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(payload);
            setTimeout(() => {
                if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
            }, 30000).unref?.();
        });
    }

    async eval(expression, { awaitPromise = true } = {}) {
        const r = await this.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
        if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ""}`);
        return r.result?.value;
    }

    async navigate(url, { waitMs = 1500 } = {}) {
        await this.send("Page.navigate", { url });
        await sleep(waitMs);
    }

    async screenshot(file) {
        const r = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(r.data, "base64"));
        return file;
    }

    async close() {
        try { this.ws?.close(); } catch { /* ignore */ }
        try { this.child?.kill(); } catch { /* ignore */ }
        await sleep(400);
        try { fs.rmSync(this.profileDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

/** Wait until `window.GUI && window.GUI.showView` exists (T3 boot.js hook). */
export async function waitForGuiHook(cdp, timeoutMs = 8000) {
    try {
        await waitUntil(() => cdp.eval("!!(window.GUI && typeof window.GUI.showView === 'function')"), { timeoutMs, label: "window.GUI" });
        return true;
    } catch {
        return false;
    }
}
