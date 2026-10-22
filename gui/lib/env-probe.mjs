/**
 * env-probe.mjs — 环境探测（DESIGN-PLAN §2.1 / §4 T1，方法照抄 WINDOWS-PROBES.md 实测证据）
 *
 * 冻结导出：
 *   probeEnv({gameDir}) -> Promise<EnvReport>
 *   probePort(port)     -> Promise<{busy:boolean, pid:number|null}>
 *   findBrowser()       -> {path:string, kind:"chrome"|"edge"}|null
 *   isGameRunning()     -> Promise<boolean>
 *   sha256File(p)       -> string
 *   findFreePort(from,to) -> Promise<number|null>
 *
 * EnvReport 全部字段必现，无值用 null（§2.1 结构逐字段一致）。
 * 零依赖：只用 node: 内置模块。
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

import { ROOT, MOD_SOURCE, MODS_DIR, SAVES_DIR } from "./paths.mjs";
import { readConfig, readGuiState } from "./config-io.mjs";

// ─────────────────────────── 常量 ───────────────────────────

/** Steam AppID of shapez.io（appmanifest_1318690.acf，WINDOWS-PROBES §1） */
const GAME_APPID = "1318690";
const GAME_DIR_NAME = "shapez.io";
const MOD_FILE_NAME = "shapez-ai-bridge.js";
const MOD_BACKUP_PREFIX = MOD_FILE_NAME + ".bak-";
const MODSETTINGS_PREFIX = "modsettings_shapez-ai-bridge";

/** Node 最低支持版本（package.json engines / DESIGN-PLAN §2.1） */
const NODE_MIN_MAJOR = 20;

/** 实测备用 Steam 库/安装位置（WINDOWS-PROBES §1 备用路径） */
const STEAM_FALLBACK_ROOTS = [
    "D:/Steam",
    "C:/Program Files (x86)/Steam",
];

/** 浏览器候选 6 条：Chrome×3 + Edge×3（R1：探测候选扩到 6 个路径） */
function browserCandidates() {
    const pf = process.env.ProgramFiles || "C:/Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)";
    const lad = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return [
        { path: path.join(pf, "Google", "Chrome", "Application", "chrome.exe"), kind: "chrome" },
        { path: path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"), kind: "chrome" },
        { path: path.join(lad, "Google", "Chrome", "Application", "chrome.exe"), kind: "chrome" },
        { path: path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"), kind: "edge" },
        { path: path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"), kind: "edge" },
        { path: path.join(lad, "Microsoft", "Edge", "Application", "msedge.exe"), kind: "edge" },
    ];
}

// ─────────────────────────── 小工具 ───────────────────────────

/**
 * spawn 一个命令并收集输出（不抛；ENOENT/超时 → code:null）。
 * @returns {Promise<{code:number|null, out:string, err:string}>}
 */
function runCapture(cmd, args, { timeout = 10000, encoding = "utf8" } = {}) {
    return new Promise((resolve) => {
        let done = false;
        let out = "";
        let err = "";
        let child;
        const finish = (code) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ code, out, err });
        };
        const timer = setTimeout(() => {
            try { child && child.kill(); } catch { /* ignore */ }
            finish(null);
        }, timeout);
        try {
            child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        } catch {
            return finish(null);
        }
        child.stdout.on("data", (d) => { out += d.toString(encoding); });
        child.stderr.on("data", (d) => { err += d.toString(encoding); });
        child.on("error", () => finish(null));
        child.on("close", (code) => finish(code));
    });
}

/** 目录内条目名列表；读不了 → 空数组。 */
function readDirNames(dir) {
    try {
        return fs.readdirSync(dir);
    } catch {
        return [];
    }
}

function exists(p) {
    try {
        return fs.existsSync(p);
    } catch {
        return false;
    }
}

function isDir(p) {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

// ─────────────────────────── sha256File ───────────────────────────

/**
 * 流式 sha256（同步签名，分块读入，不整文件加载）。
 * @param {string} p
 * @returns {string} 小写 hex
 */
export function sha256File(p) {
    const hash = crypto.createHash("sha256");
    const fd = fs.openSync(p, "r");
    try {
        const buf = Buffer.allocUnsafe(64 * 1024);
        for (;;) {
            const n = fs.readSync(fd, buf, 0, buf.length, null);
            if (n <= 0) break;
            hash.update(buf.subarray(0, n));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest("hex");
}

// ─────────────────────────── 端口探测 ───────────────────────────

/**
 * TCP 绑定试探（WINDOWS-PROBES §3）。busy 时用 netstat -ano 反查 LISTENING PID。
 * @param {number} port
 * @returns {Promise<{busy:boolean, pid:number|null}>}
 */
export function probePort(port) {
    return new Promise((resolve) => {
        const s = net.createServer();
        let settled = false;
        const done = (busy) => {
            if (settled) return;
            settled = true;
            resolve(busy);
        };
        s.once("error", () => {
            // EADDRINUSE / EACCES 等一律视为不可绑定（busy）
            s.close(() => {}); // 未监听的 server close 也是安全的
            done(true);
        });
        s.once("listening", () => {
            s.close(() => done(false));
        });
        s.listen(port, "127.0.0.1");
    }).then(async (busy) => {
        if (!busy) return { busy: false, pid: null };
        return { busy: true, pid: await findListeningPid(port) };
    });
}

/**
 * netstat -ano 找占用端口的 LISTENING 行 PID。
 * 行样例：`  TCP    127.0.0.1:7777    0.0.0.0:0    LISTENING    53992`
 * @returns {Promise<number|null>}
 */
async function findListeningPid(port) {
    const { code, out } = await runCapture("netstat", ["-ano"]);
    if (code !== 0 || !out) return null;
    for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
        if (m && Number(m[1]) === port) return Number(m[2]);
    }
    return null;
}

/**
 * 在 [from, to] 内找第一个空闲端口。
 * @param {number} from
 * @param {number} to
 * @returns {Promise<number|null>}
 */
export async function findFreePort(from, to) {
    if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) return null;
    for (let p = from; p <= to; p++) {
        const { busy } = await probePort(p);
        if (!busy) return p;
    }
    return null;
}

// ─────────────────────────── 浏览器 ───────────────────────────

/**
 * 第一个存在的浏览器候选（Chrome 优先于 Edge）。
 * @returns {{path:string, kind:"chrome"|"edge"}|null}
 */
export function findBrowser() {
    for (const c of browserCandidates()) {
        if (exists(c.path)) return { path: c.path, kind: c.kind };
    }
    return null;
}

// ─────────────────────────── 游戏进程 ───────────────────────────

/**
 * tasklist /FI "IMAGENAME eq shapezio.exe"：输出含 shapezio.exe 即运行中（WINDOWS-PROBES §6）。
 * @returns {Promise<boolean>}
 */
export async function isGameRunning() {
    const { out } = await runCapture("tasklist", ["/FI", "IMAGENAME eq shapezio.exe"]);
    return /shapezio\.exe/i.test(out || "");
}

// ─────────────────────────── Steam 游戏目录四级探测链 ───────────────────────────

/**
 * 目录是否真的是 shapez：含 shapezio.exe 与 resources/app.asar（WINDOWS-PROBES §1 验证标志）。
 */
function isShapezDir(dir) {
    return isDir(dir)
        && exists(path.join(dir, "shapezio.exe"))
        && exists(path.join(dir, "resources", "app.asar"));
}

/**
 * 注册表 HKCU\Software\Valve\Steam → SteamPath（实测 "d:/steam"）。
 * @returns {Promise<string|null>}
 */
async function readSteamPathFromRegistry() {
    const { code, out } = await runCapture("reg", ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"]);
    if (code !== 0 || !out) return null;
    const m = out.match(/SteamPath\s+REG_SZ\s+([^\r\n]+)/i);
    if (!m) return null;
    const v = m[1].trim().replace(/[\\/]+$/, "");
    return v.length ? v : null;
}

/**
 * libraryfolders.vdf 抠所有 `"path"  "..."`（含反斜杠转义 unescape），归一为本地分隔符。
 * @returns {string[]}
 */
function readLibraryPaths(steamRoot) {
    const vdf = path.join(steamRoot, "steamapps", "libraryfolders.vdf");
    let raw;
    try {
        raw = fs.readFileSync(vdf, "utf8");
    } catch {
        return [];
    }
    const libs = [];
    const re = /"path"\s+"([^"]+)"/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
        const lib = m[1].replace(/\\\\/g, "\\").trim();
        if (lib) libs.push(lib);
    }
    return libs;
}

/**
 * Steam 四级链（WINDOWS-PROBES §1）：
 *   注册表 SteamPath → libraryfolders.vdf 各库 → appmanifest_1318690.acf → common/shapez.io
 * 备用硬编码路径殿后。source 记 registry/vdf/fallback/manual。
 * @param {string|null} manualDir 用户手动指定（已归一）；非 null 时优先且不回落
 * @returns {Promise<{found:boolean, dir:string|null, source:"registry"|"vdf"|"fallback"|"manual"|null, steam_installed:boolean}>}
 */
async function locateGame(manualDir) {
    // 0) 手动指定优先（§2.1：game_dir 传入则校验）
    if (manualDir) {
        const ok = isShapezDir(manualDir);
        return {
            found: ok,
            dir: manualDir, // 即使无效也回显用户给的路径，便于前端提示
            source: "manual",
            steam_installed: await detectSteamInstalled(),
        };
    }

    // 1) 注册表
    const steamPath = await readSteamPathFromRegistry();

    if (steamPath) {
        // 2) + 3) vdf 各库 → acf → common
        for (const lib of readLibraryPaths(steamPath)) {
            const acf = path.join(lib, "steamapps", `appmanifest_${GAME_APPID}.acf`);
            if (!exists(acf)) continue;
            const gdir = path.join(lib, "steamapps", "common", GAME_DIR_NAME);
            if (isShapezDir(gdir)) {
                return { found: true, dir: gdir, source: "vdf", steam_installed: true };
            }
        }
        // 注册表 SteamPath 自身作为一个库（无 vdf 或 vdf 未命中时）
        const direct = path.join(steamPath, "steamapps", "common", GAME_DIR_NAME);
        if (isShapezDir(direct)) {
            return { found: true, dir: direct, source: "registry", steam_installed: true };
        }
    }

    // 4) 备用硬编码
    for (const root of STEAM_FALLBACK_ROOTS) {
        const gdir = path.join(root, "steamapps", "common", GAME_DIR_NAME);
        if (isShapezDir(gdir)) {
            return { found: true, dir: gdir, source: "fallback", steam_installed: true };
        }
    }

    return { found: false, dir: null, source: null, steam_installed: await detectSteamInstalled() };
}

async function detectSteamInstalled() {
    const steamPath = await readSteamPathFromRegistry();
    const roots = steamPath ? [steamPath, ...STEAM_FALLBACK_ROOTS] : [...STEAM_FALLBACK_ROOTS];
    return roots.some((r) => exists(r) && isDir(r));
}

// ─────────────────────────── mod 版本（从 mod 源文件读，不硬编码） ───────────────────────────

/** METADATA 块里的 version（如 "0.1.0"）；读不到回落 "0.1.0"。 */
function readModVersion() {
    try {
        const src = fs.readFileSync(MOD_SOURCE, "utf8");
        const m = src.match(/METADATA\s*=\s*\{[\s\S]*?version:\s*"([^"]+)"/);
        if (m) return m[1];
    } catch { /* fallthrough */ }
    return "0.1.0";
}

// ─────────────────────────── EnvReport 组装 ───────────────────────────

/**
 * 全量环境探测（§2.1 EnvReport；全部字段必现，无值 null）。
 * @param {{gameDir?:string|null}} [opts] gameDir 手动指定时优先（校验 shapezio.exe+app.asar）
 * @returns {Promise<object>} EnvReport
 */
export async function probeEnv(opts = {}) {
    const guiState = readGuiState();
    // 手动目录：显式参数 > .gui-state.json 里持久化的覆盖（§2.1 POST /api/env 持久化）
    const manualRaw = (opts.gameDir !== undefined && opts.gameDir !== null && opts.gameDir !== "")
        ? String(opts.gameDir)
        : guiState.game_dir_override;
    const manualDir = manualRaw ? path.resolve(manualRaw) : null;

    const cfg = readConfig();

    // 并行跑互不依赖的探测
    const [game, gameRunning, portProbe, browserSat] = await Promise.all([
        locateGame(manualDir),
        isGameRunning(),
        probePort(cfg.port),
        Promise.resolve(findBrowser()),
    ]);

    // repo
    const modSourceExists = exists(MOD_SOURCE);

    // mods 目录
    const modsDirExists = isDir(MODS_DIR);
    let modsDirWritable = false;
    if (modsDirExists) {
        try {
            fs.accessSync(MODS_DIR, fs.constants.W_OK);
            modsDirWritable = true;
        } catch { /* 只读或不可访问 */ }
    }

    // mod 安装态
    const installedPath = path.join(MODS_DIR, MOD_FILE_NAME);
    const modInstalled = exists(installedPath);
    let shaRepo = null;
    if (modSourceExists) {
        try { shaRepo = sha256File(MOD_SOURCE); } catch { shaRepo = null; }
    }
    let shaInstalled = null;
    if (modInstalled) {
        try { shaInstalled = sha256File(installedPath); } catch { shaInstalled = null; }
    }
    const modMatch = !!(shaRepo && shaInstalled && shaRepo === shaInstalled);
    const backupCount = readDirNames(MODS_DIR).filter((n) => n.startsWith(MOD_BACKUP_PREFIX)).length;

    // saves 目录
    const modsettingsFound = readDirNames(SAVES_DIR).some((n) => n.startsWith(MODSETTINGS_PREFIX));

    const major = parseInt(process.versions.node, 10);

    return {
        node: {
            version: process.version,
            ok: Number.isInteger(major) && major >= NODE_MIN_MAJOR,
            path: process.execPath,
        },
        os: {
            platform: process.platform,
            release: os.release(),
        },
        repo: {
            root: ROOT,
            mod_source_exists: modSourceExists,
            mod_version: readModVersion(),
        },
        game: {
            found: game.found,
            dir: game.dir,
            source: game.source,
            running: gameRunning,
            exe_ok: game.found ? exists(path.join(game.dir, "shapezio.exe")) : false,
            asar_ok: game.found ? exists(path.join(game.dir, "resources", "app.asar")) : false,
            steam_installed: game.steam_installed,
        },
        mods_dir: {
            path: MODS_DIR,
            exists: modsDirExists,
            writable: modsDirWritable,
        },
        mod: {
            installed: modInstalled,
            path: modInstalled ? installedPath : null,
            sha256_repo: shaRepo,
            sha256_installed: shaInstalled,
            match: modMatch,
            backup_count: backupCount,
        },
        port: {
            configured: cfg.port,
            busy: portProbe.busy,
            owner_pid: portProbe.pid,
        },
        browser: {
            found: !!browserSat,
            path: browserSat ? browserSat.path : null,
            kind: browserSat ? browserSat.kind : null,
        },
        saves_dir: {
            path: SAVES_DIR,
            modsettings_found: modsettingsFound,
        },
        gui_state: {
            wizard_completed: guiState.wizard_completed,
            game_dir_override: guiState.game_dir_override,
        },
    };
}
