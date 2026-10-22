/**
 * proc-mgr.mjs — 子进程管理 + 日志环形缓冲（DESIGN-PLAN §2.4/§4 T2）
 *
 * 三类子进程：install（powershell install.ps1）、bridge（node src/bridge/bridge.mjs）、
 * smoke（node scripts/smoke_test.mjs）。
 * 每类一个 2000 行环形缓冲，行号 n 单调递增（进程生命周期内单调，不因清屏重置）。
 *
 * 零 npm 依赖：只用 node: 内置模块。
 *
 * ── T2 补充（server.mjs 需要的缺口，不改动已有导出签名）──
 *  - bridge 子进程跟踪：bridgeProc getter / setBridge / clearBridge / bridgeStartedAt
 *  - 外部进程占用探测辅助：isPortOwnedBy(child, port)（bridge 就绪轮询失败时区分 EADDRINUSE）
 *  - shutdown() 现在也会清理 bridge 子进程
 */
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import process from "node:process";

// ─────────────────────────── 常量 ───────────────────────────

export const RING_CAPACITY = 2000;

/** install.ps1 的输出前缀 → level 映射（DESIGN-PLAN §2.4） */
const PS_LEVEL_MAP = { "[OK]": "ok", "[FAIL]": "error", "[INFO]": "info", "[SKIP]": "info", "[NOTE]": "info" };

/** mojibake 启发式：UTF-8 被按 GBK 解读时出现的典型字符（R7） */
const MOJIBAKE_RE = /锟斤拷|锟斤|烫烫烫|屯屯屯|ï¿½|â€|Ã¤|Ã©|Ã¼/;

// ─────────────────────────── 环形缓冲 ───────────────────────────

/** 环形缓冲：固定容量 2000，n 单调递增（从 1 开始）。 */
class RingBuffer {
    constructor(capacity = RING_CAPACITY) {
        this.capacity = capacity;
        this.buf = [];
        this.next_n = 1; // 下一条行的编号
    }

    add({ kind, stream, level, text }) {
        const line = { n: this.next_n++, kind, stream, level, text, ts: Date.now() };
        this.buf.push(line);
        if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
        return line;
    }

    /**
     * 返回 n > since 的行与下一个游标。
     * @param {number} since 上次收到的最大 n（0 = 全部）
     */
    since(since) {
        const s = Number.isInteger(since) && since > 0 ? since : 0;
        const lines = [];
        for (const l of this.buf) {
            if (l.n > s) lines.push(l);
        }
        const next_since = lines.length ? lines[lines.length - 1].n : s;
        return { lines, next_since };
    }

    /** 已缓冲的最新行号（空 = 0） */
    lastN() {
        return this.buf.length ? this.buf[this.buf.length - 1].n : 0;
    }

    clear() {
        // 只清可见行；n 保持单调（前端游标语义不破坏）
        this.buf = [];
    }
}

// ─────────────────────────── level 映射（导出以便测试/复用） ───────────────────────────

/**
 * install 行：按 [OK]/[FAIL]/[INFO]/[SKIP]/[NOTE] 前缀映射。
 * 其余类别：stderr→warn、含 error/fail（不区分大小写）→error，默认 info。
 * @param {string} kind install|bridge|smoke
 * @param {"out"|"err"} stream
 * @param {string} text
 */
export function mapLevel(kind, stream, text) {
    if (kind === "install") {
        const t = (text || "").trimStart();
        for (const prefix of Object.keys(PS_LEVEL_MAP)) {
            if (t.startsWith(prefix)) return PS_LEVEL_MAP[prefix];
        }
    }
    if (/(^|[^a-z])error|fail/i.test(text || "")) return "error";
    if (stream === "err") return "warn";
    return "info";
}

// ─────────────────────────── 字节流 → 行（UTF-8 + mojibake 启发） ───────────────────────────

/**
 * 增量解码器：
 * - UTF-8 解码（StringDecoder 处理跨 chunk 的多字节字符）
 * - mojibake 启发式（R7）：行内出现典型乱码字符时，前缀提示并保留原文
 */
export function createLineDecoder() {
    const dec = new StringDecoder("utf8");
    let pending = "";
    const decorate = (line) => {
        if (MOJIBAKE_RE.test(line)) {
            return `[乱码检测] 输出疑似编码错乱（可尝试 chcp 65001），原文: ${line}`;
        }
        return line;
    };
    return {
        /** @param {Buffer|string} chunk → string[] 完整行 */
        push(chunk) {
            pending += typeof chunk === "string" ? chunk : dec.write(chunk);
            const out = [];
            let idx;
            while ((idx = pending.indexOf("\n")) !== -1) {
                out.push(decorate(pending.slice(0, idx).replace(/\r$/, "")));
                pending = pending.slice(idx + 1);
            }
            return out;
        },
        /** 进程结束时冲刷残余（无换行的最后一行） */
        flush() {
            pending += dec.end();
            if (!pending) return [];
            const line = decorate(pending.replace(/\r$/, ""));
            pending = "";
            return [line];
        },
    };
}

// ─────────────────────────── 进程管理器 ───────────────────────────

/**
 * ProcMgr — install/bridge/smoke 三类子进程 + 日志缓冲 + 互斥。
 *
 * 事件（`on(type, fn)` 订阅，返回取消函数）：
 *   "log"          (line)  任何新日志行
 *   "install_done" ({ok, exit_code, log_ref})
 *   "smoke_done"   ({ok, exit_code, log_ref, run_id})
 */
export class ProcMgr {
    /**
     * @param {object} opts
     * @param {string} opts.root   仓库根（spawn 的 cwd）
     * @param {object} opts.paths  { installScript, bridgePath, smokePath }（绝对路径）
     * @param {(m:string)=>void} [opts.debug] 可选调试输出
     */
    constructor(opts) {
        this.root = opts.root;
        this.paths = opts.paths;
        this.debug = opts.debug || (() => {});
        /** @type {Record<string, RingBuffer>} */
        this.rings = { install: new RingBuffer(), bridge: new RingBuffer(), smoke: new RingBuffer() };
        this.listeners = new Map();

        /** 当前在跑的 install 子进程（互斥） */
        this.install_proc = null;
        /** 当前在跑的 smoke 子进程（互斥） */
        this.smoke_proc = null;
        /** 当前在跑的 bridge 子进程（server 托管；null = 未托管） */
        this.bridge_proc = null;
        /** bridge 启动时刻（uptime_s 计算用） */
        this.bridge_started_at = null;
        /** smoke 运行序号（单调） */
        this.run_id = 0;
    }

    // ── 事件 ──
    on(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(fn);
        return () => this.listeners.get(type).delete(fn);
    }

    emit(type, payload) {
        for (const fn of this.listeners.get(type) || []) {
            try {
                fn(payload);
            } catch (e) {
                this.debug(`listener error (${type}): ${e.message}`);
            }
        }
    }

    // ── 日志 ──
    /** 写一行日志进指定类别缓冲，广播 "log" */
    log(kind, stream, text, level) {
        const line = this.rings[kind].add({
            kind,
            stream,
            level: level || mapLevel(kind, stream, text),
            text,
        });
        this.emit("log", line);
        return line;
    }

    /** 下一条将被写入的行号（用于捕获本次运行产生的行） */
    nextLineN(kind) {
        return this.rings[kind].next_n;
    }

    /** 已缓冲的最新行号（空 = 0） */
    lastLineN(kind) {
        return this.rings[kind].lastN();
    }

    /** GET /api/logs 的后端；未知 kind 返回 null */
    logsSince(kind, since) {
        const ring = this.rings[kind];
        if (!ring) return null;
        return ring.since(since);
    }

    // ── 通用：把子进程 stdout/stderr 变成日志行 ──
    _pipeToRing(child, kind) {
        for (const [stream, tag] of [["stdout", "out"], ["stderr", "err"]]) {
            const dec = createLineDecoder();
            child[stream].on("data", (chunk) => {
                for (const line of dec.push(chunk)) this.log(kind, tag, line);
            });
            child[stream].on("end", () => {
                for (const line of dec.flush()) this.log(kind, tag, line);
            });
        }
    }

    // ─────────────────────── install ───────────────────────

    get installBusy() {
        return !!this.install_proc;
    }
    get smokeBusy() {
        return !!this.smoke_proc;
    }

    /**
     * 运行 install.ps1（DESIGN-PLAN §2.2 / §4 T2）。
     * GUI 默认不加 -NoBackup（保留 .bak-*，验收 B3）。
     * @param {object} o
     * @param {boolean} [o.uninstall]  加 -Uninstall
     * @param {string}  [o.mods_dir]   加 -ModsDir
     * @returns {Promise<{exit_code:number, lines_n:int, log_ref:int|null}>}
     *          互斥时 reject(err.code_name = "INSTALL_BUSY")
     */
    runInstall({ uninstall = false, mods_dir = null } = {}) {
        if (this.install_proc) {
            const err = new Error("install already running");
            err.code_name = "INSTALL_BUSY";
            return Promise.reject(err);
        }
        const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.paths.installScript];
        if (uninstall) args.push("-Uninstall");
        if (mods_dir) args.push("-ModsDir", String(mods_dir));

        const start = this.nextLineN("install");
        this.log("install", "out", `$ powershell ${["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "install.ps1", ...(uninstall ? ["-Uninstall"] : []), ...(mods_dir ? ["-ModsDir", String(mods_dir)] : [])].join(" ")}`);

        return new Promise((resolve, reject) => {
            let child;
            try {
                child = spawn("powershell", args, {
                    cwd: this.root,
                    stdio: ["ignore", "pipe", "pipe"],
                    windowsHide: true,
                });
            } catch (e) {
                this.log("install", "err", `spawn failed: ${e.message}`, "error");
                return reject(e);
            }
            this.install_proc = child;
            this._pipeToRing(child, "install");

            const settle = (exit_code, err) => {
                this.install_proc = null;
                if (err) {
                    this.log("install", "err", `spawn failed: ${err.message}`, "error");
                    this.emit("install_done", { ok: false, exit_code: -1, log_ref: this.lastLineN("install") });
                    return reject(err);
                }
                const last = this.lastLineN("install");
                const result = { exit_code, lines_n: Math.max(0, last - start + 1), log_ref: last > 0 ? last : null };
                this.emit("install_done", { ok: exit_code === 0, exit_code, log_ref: result.log_ref });
                resolve(result);
            };
            child.on("error", (e) => settle(-1, e));
            child.on("close", (code) => settle(code === null ? -1 : code, null));
        });
    }

    // ─────────────────────── bridge ───────────────────────

    /** 当前托管的 bridge 子进程（server 用；null = 未托管） */
    get bridgeProc() {
        return this.bridge_proc;
    }

    /** bridge 托管进程运行时长（秒）；未托管 → null */
    get bridgeStartedAt() {
        return this.bridge_started_at;
    }

    /** server 记录托管 bridge（bridgeProc 为 null 时清除 started_at） */
    setBridge(child) {
        this.bridge_proc = child;
        this.bridge_started_at = child ? Date.now() : null;
    }

    clearBridge() {
        this.bridge_proc = null;
        this.bridge_started_at = null;
    }

    /**
     * 启动桥接子进程（DESIGN-PLAN §2.4）。就绪轮询由 server 负责。
     * @param {object} o
     * @param {number} o.port
     * @param {string|null} [o.token]
     * @param {boolean} [o.read_only]
     * @returns {{child:import("node:child_process").ChildProcess, pid:number, started_at:number, start_n:int}}
     */
    startBridge({ port, token = null, read_only = false }) {
        const args = [this.paths.bridgePath, "--port", String(port)];
        if (token) args.push("--token", token);
        if (read_only) args.push("--read-only");

        const start = this.nextLineN("bridge");
        this.log("bridge", "out", `$ node src/bridge/bridge.mjs --port ${port}${token ? " --token ***" : ""}${read_only ? " --read-only" : ""}`);

        const child = spawn(process.execPath, args, {
            cwd: this.root,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        this._pipeToRing(child, "bridge");
        return { child, pid: child.pid, started_at: Date.now(), start_n: start };
    }

    /**
     * 停止进程：SIGTERM → 2s → taskkill /pid <pid> /f（§2.4）。
     * @returns {Promise<{stopped:boolean, forced:boolean, exit_code:int|null}>}
     */
    stopProcess(child, { gracefulMs = 2000 } = {}) {
        return new Promise((resolve) => {
            if (!child || child.exitCode !== null || child.signalCode !== null) {
                return resolve({ stopped: true, forced: false, exit_code: child ? child.exitCode : null });
            }
            let done = false;
            const finish = (forced) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve({ stopped: true, forced, exit_code: child.exitCode });
            };
            const timer = setTimeout(() => {
                try {
                    const tk = spawn("taskkill", ["/pid", String(child.pid), "/f"], { windowsHide: true, stdio: "ignore" });
                    tk.on("close", () => finish(true));
                    tk.on("error", () => finish(true));
                } catch {
                    finish(true);
                }
            }, gracefulMs);
            child.once("close", () => finish(false));
            try {
                child.kill("SIGTERM");
            } catch {
                // 已死或权限问题 → 等 taskkill 分支
            }
        });
    }

    // ─────────────────────── smoke ───────────────────────

    /**
     * 运行冒烟测试（DESIGN-PLAN §2.5）。
     * @param {object} o
     * @param {string} o.base_url  如 http://127.0.0.1:7777
     * @param {string|null} [o.token]
     * @returns {{run_id:int, child, promise:Promise<{run_id,exit_code,log_ref}>}}
     *          busy 时返回 {error: Error(code_name="SMOKE_BUSY")}
     */
    runSmoke({ base_url, token = null }) {
        if (this.smoke_proc) {
            const err = new Error("smoke already running");
            err.code_name = "SMOKE_BUSY";
            return { error: err };
        }
        const args = [this.paths.smokePath, "--url", base_url];
        if (token) args.push("--token", token);

        this.run_id += 1;
        const run_id = this.run_id;
        const start = this.nextLineN("smoke");
        this.log("smoke", "out", `$ node scripts/smoke_test.mjs --url ${base_url}${token ? " --token ***" : ""}`);

        const child = spawn(process.execPath, args, {
            cwd: this.root,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            env: { ...process.env, SHAPEZ_SMOKE_AUTOPLAY: "1" },
        });
        this.smoke_proc = child;
        this._pipeToRing(child, "smoke");

        const promise = new Promise((resolve) => {
            const settle = (exit_code) => {
                this.smoke_proc = null;
                const last = this.lastLineN("smoke");
                const result = { run_id, exit_code, log_ref: Math.max(last, start) };
                this.emit("smoke_done", { ok: exit_code === 0, ...result });
                resolve(result);
            };
            child.on("error", (e) => {
                this.log("smoke", "err", `spawn failed: ${e.message}`, "error");
                settle(-1);
            });
            child.on("close", (code) => settle(code === null ? -1 : code));
        });
        return { run_id, child, promise };
    }

    // ─────────────────────── 退出清理 ───────────────────────

    /** 进程退出时尽力清理（server 调用） */
    async shutdown() {
        const jobs = [];
        if (this.install_proc) jobs.push(this.stopProcess(this.install_proc));
        if (this.smoke_proc) jobs.push(this.stopProcess(this.smoke_proc));
        if (this.bridge_proc) jobs.push(this.stopProcess(this.bridge_proc));
        await Promise.allSettled(jobs);
        if (this.bridge_proc) this.clearBridge();
    }
}
