/**
 * console.js — 控制台视图（T4 独占；DESIGN-PLAN §3.6）
 *
 * 挂载点：#console-root → export mountConsole(el)
 * 契约：只用 T3 冻结接口（api.js / logview.js / i18n.js / window.GUI.*）。
 * 缺依赖时降级：动态 import 全部 try/catch，缺失用内置 stub 保证可渲染
 * （配合 ?mock=1 独立开发验证）。
 *
 * 形制：① hero 带（左大数字+右动作）→ ② 信号链带（本页独有形制）
 *      → ③ 左5/右7 非对称分栏（状态卡堆 + 日志控制台）→ 底行快捷。
 *
 * 文案：T3 字典未覆盖 T4 文案 → 本模块自带 zh/en 对（[data-t4zh] 机制），
 * 随 boot.js 的语言切换（GUI.refreshI18n）重绘。
 */

let depsPromise = null;
async function loadDeps() {
    if (depsPromise) return depsPromise;
    depsPromise = (async () => {
        const deps = { api: null, t: (k) => k, toast: () => {}, createLogView: null, logpanel: null, MOCK: false };
        try { const m = await import("./api.js"); deps.api = m.api || m.default; deps.MOCK = !!m.MOCK; } catch { /* stub below */ }
        try { const m = await import("./i18n.js"); if (typeof m.t === "function") deps.t = m.t; } catch { /* keep */ }
        try { const m = await import("./logview.js"); if (typeof m.createLogView === "function") deps.createLogView = m.createLogView; } catch { /* fallback */ }
        try { const m = await import("./logpanel.js"); deps.logpanel = m; } catch { /* 内联兜底渲染 */ }
        const G = (typeof window !== "undefined" && window.GUI) || null;
        if (G && typeof G.toast === "function") deps.toast = G.toast;
        else deps.toast = (msg, level) => console.warn(`[toast:${level || "info"}]`, msg);
        if (!deps.api) deps.api = CONSOLE_STUB;
        return deps;
    })();
    return depsPromise;
}

/* ── 内置 stub（api.js 缺失时的独立兜底演示数据） ── */

const STUB_STATUS_RUNNING = {
    running: true, managed: true, pid: 4242, port: 7777, healthy: true, mod_connected: true,
    uptime_s: 754, in_game: true, game_version: "1.5.6", mod_version: "0.1.0", hub_level: 42,
    paused: false, allow_write: true, last_error: null,
};
const STUB_LOGS = [
    { n: 1, kind: "bridge", stream: "out", level: "info", text: "[bridge] listening on 127.0.0.1:7777", ts: Date.now() - 60000 },
    { n: 2, kind: "bridge", stream: "out", level: "info", text: "[bridge] waiting for game mod connection…", ts: Date.now() - 59000 },
    { n: 3, kind: "bridge", stream: "out", level: "ok", text: "[bridge] mod connected (shapez 1.5.6, protocol 1)", ts: Date.now() - 52000 },
    { n: 4, kind: "bridge", stream: "out", level: "info", text: "[bridge] rpc status → in_game=true level=42", ts: Date.now() - 40000 },
    { n: 5, kind: "bridge", stream: "err", level: "warn", text: "[warn] snapshot dir ./snapshots missing; created", ts: Date.now() - 30000 },
    { n: 6, kind: "bridge", stream: "out", level: "info", text: "[bridge] rpc observe → 2146 entities (sample 5)", ts: Date.now() - 8000 },
];
const STUB_SMOKE = {
    running: false, run_id: 3, exit_code: 0,
    checks: [
        { n: 1, name: "bridge healthy", name_zh: "桥接可达", state: "pass", detail: "mod_connected=true, uptime=754s" },
        { n: 2, name: "mod connected & world loaded", name_zh: "游戏已连接", state: "pass", detail: "game 1.5.6" },
        { n: 3, name: "observation works", name_zh: "世界状态可读取", state: "pass", detail: "entities in world: 2146" },
        { n: 4, name: "place & verify belt", name_zh: "放置传送带", state: "pass", detail: "uid=8, type=belt" },
        { n: 5, name: "delete & confirm", name_zh: "删除并确认", state: "pass", detail: "world restored" },
    ],
    hint: null, finished_at: Date.now() - 120000,
};
const CONSOLE_STUB = {
    bridgeStatus: async () => STUB_STATUS_RUNNING,
    bridgeStart: async () => ({ ok: true, status: STUB_STATUS_RUNNING }),
    bridgeStop: async () => ({ ok: true, stopped: false }),
    logsSince: async (kind, since) => ({ lines: STUB_LOGS.filter((l) => l.n > (since || 0)), next_since: STUB_LOGS.length }),
    smokeStart: async () => ({ ok: true, run_id: 4 }),
    smokeStatus: async () => STUB_SMOKE,
    openTarget: async (target) => { console.warn("[api-stub] openTarget", target); return { ok: true, opened: true }; },
    mcpConfig: async () => ({
        config: { mcpServers: { shapez: { command: "node", args: ["D:/shapez-ai-bridge/src/mcp/server.mjs"], env: { SHAPEZ_BRIDGE_URL: "http://127.0.0.1:7777" } } } },
        claude_desktop_config_path: "C:\\Users\\you\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
    }),
    env: async () => ({
        game: { found: true, dir: "D:\\Steam\\steamapps\\common\\shapez.io", source: "vdf", running: true, exe_ok: true, asar_ok: true, steam_installed: true },
        mods_dir: { path: "C:\\Users\\you\\AppData\\Roaming\\shapez.io\\mods", exists: true, writable: true },
        mod: { installed: true, path: "C:\\Users\\you\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js", sha256_repo: "a1b2c3d4e5f60718293a4b5c6d7e8f90", sha256_installed: "a1b2c3d4e5f60718293a4b5c6d7e8f90", match: true, backup_count: 2 },
        repo: { root: "D:\\shapez-ai-bridge", mod_source_exists: true, mod_version: "0.1.0" },
    }),
    events: { on: () => () => {} },
    version: async () => ({ gui: "0.1.0", mod: "0.1.0" }),
};

/* ── 小工具 ── */

function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "dataset") Object.assign(el.dataset, v);
        else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
        else if (k === "text") el.textContent = v;
        else el.setAttribute(k, String(v));
    }
    for (const c of children.flat(4)) {
        if (c === null || c === undefined || c === false) continue;
        el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
}

function getLangSafe() {
    try { return window.GUI?.getLang?.() === "en" ? "en" : "zh"; } catch { return "zh"; }
}
/** zh/en 取词（动态文案用） */
function tr(zh, en) { return getLangSafe() === "en" ? en : zh; }
/** 静态文案挂载：dataset 记录双语，refreshI18n 时统一重刷 */
function t4(el, zh, en) {
    el.dataset.t4zh = zh;
    el.dataset.t4en = en;
    el.textContent = getLangSafe() === "en" ? en : zh;
    return el;
}
function reapplyT4(root) {
    const en = getLangSafe() === "en";
    for (const el of root.querySelectorAll("[data-t4zh]")) {
        const v = en ? el.dataset.t4en : el.dataset.t4zh;
        if (v !== undefined) el.textContent = v;
    }
}

function fmtUptime(s) {
    const t = Number(s);
    if (!Number.isFinite(t) || t < 0) return null;
    const sec = Math.round(t);
    const hh = Math.floor(sec / 3600);
    const mm = Math.floor((sec % 3600) / 60);
    const ss = sec % 60;
    if (hh > 0) return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
    return `${mm}:${String(ss).padStart(2, "0")}`;
}

/** 冒烟退出码 → hint（DESIGN-PLAN §2.5 / E4） */
export function smokeExitHint(exitCode) {
    switch (exitCode) {
        case 0: return null;
        case 1: return tr("桥接未运行或不可达 —— 先启动桥接（退出码 1）", "Bridge unreachable — start the bridge first (exit 1)");
        case 2: return tr("游戏未就绪 —— 启动 shapez.io 并进入存档（退出码 2）", "Game not ready — launch shapez.io and load a save (exit 2)");
        case 3: return tr("后续检查失败 —— 展开日志查看原始响应（退出码 3）", "A later check failed — open the logs for the raw response (exit 3)");
        default: return tr(`冒烟以退出码 ${exitCode} 结束`, `Smoke finished with exit code ${exitCode}`);
    }
}

/* ── 日志视图：优先 T3 createLogView → logpanel 兜底 → 内联最小渲染 ── */

function makeLogView(deps, host) {
    if (deps.createLogView) {
        try {
            const view = deps.createLogView(host, { follow: true });
            if (view && typeof view.append === "function") return view;
        } catch { /* fall through */ }
    }
    if (deps.logpanel && typeof deps.logpanel.createFallbackLogView === "function") {
        try {
            return deps.logpanel.createFallbackLogView(host, {
                onFollowChange: (f) => host.dispatchEvent(new CustomEvent("t4-follow", { detail: f })),
            });
        } catch { /* fall through */ }
    }
    let follow = true;
    let onFollowChanged = null;
    host.addEventListener("scroll", () => {
        const atBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 48;
        if (atBottom !== follow) { follow = atBottom; onFollowChanged?.(follow); }
    }, { passive: true });
    function stick() { host.scrollTop = host.scrollHeight; }
    return {
        append(lines) {
            const batch = Array.isArray(lines) ? lines : [lines];
            const frag = document.createDocumentFragment();
            batch.forEach((line, i) => {
                const row = document.createElement("div");
                row.className = "logp-line";
                row.dataset.n = String(line.n);
                row.dataset.level = line.level || "info";
                if (i < 8) { row.classList.add("is-enter"); row.style.setProperty("--logp-i", String(i)); }
                row.append(
                    h("span", { class: "logp-n", text: String(line.n) }),
                    h("span", { class: "logp-text", text: line.text ?? "" }));
                frag.appendChild(row);
            });
            host.appendChild(frag);
            while (host.children.length > 2000) host.removeChild(host.firstChild);
            if (follow) stick();
        },
        clear() { host.textContent = ""; },
        setFollow(b) { follow = !!b; if (follow) stick(); },
        jumpTo(n) {
            const row = host.querySelector(`[data-n="${n}"]`);
            if (!row) return false;
            row.scrollIntoView({ block: "center" });
            row.classList.add("is-target");
            setTimeout(() => row.classList.remove("is-target"), 2600);
            return true;
        },
        onFollow(fn) { onFollowChanged = fn; },
    };
}

/* ═══════════════════════════ mountConsole ═══════════════════════════ */

export function mountConsole(rootEl) {
    let disposed = false;
    const cleanups = [];
    const S = {
        status: null, env: null, smoke: null,
        smokeSpringShown: false,
        logKind: "bridge", filter: "all", follow: true, lastN: 0,
    };

    const depsP = loadDeps();

    rootEl.textContent = "";
    const main = h("div", { class: "con-main" });
    rootEl.appendChild(main);

    /* ① hero 带 */
    const heroState = h("div", { class: "con-hero-state is-idle", text: "—" });
    const heroSub = h("div", { class: "con-hero-sub" });
    const heroAction = h("button", { class: "con-btn is-primary", type: "button" });
    t4(heroAction, "启动桥接", "Start bridge");
    const heroOpenGame = h("button", { class: "con-btn is-secondary", type: "button" });
    t4(heroOpenGame, "启动游戏", "Launch game");
    const hero = h("div", { class: "con-hero" },
        h("div", { class: "con-hero-left" },
            h("div", { class: "con-hero-kicker", text: "shapez.io · AI bridge" }),
            heroState, heroSub),
        h("div", { class: "con-hero-actions" }, heroOpenGame, heroAction));
    main.appendChild(hero);

    /* ② 信号链带（M5 呼吸点：四节点不同频 0.7/0.9/1.1Hz） */
    const NODES = [
        { key: "game", zh: "游戏", en: "Game", freq: "07" },
        { key: "mod", zh: "Mod", en: "Mod", freq: "09" },
        { key: "bridge", zh: "桥接", en: "Bridge", freq: "11" },
        { key: "ai", zh: "AI", en: "AI", freq: "07" },
    ];
    const nodeEls = {};
    const chain = h("div", { class: "con-chain", role: "img", "aria-label": "signal chain: game -> mod -> bridge -> ai" });
    NODES.forEach((n, i) => {
        if (i > 0) chain.appendChild(h("span", { class: "con-chain-link" }));
        const state = h("div", { class: "con-chain-state", text: "—" });
        const node = h("div", { class: "con-chain-node is-off", dataset: { freq: n.freq }, "data-node": n.key },
            h("span", { class: "con-chain-dot-wrap" }, h("span", { class: "con-chain-dot" })),
            t4(h("div", { class: "con-chain-label" }), n.zh, n.en),
            state);
        nodeEls[n.key] = { node, state };
        chain.appendChild(node);
    });
    main.appendChild(chain);

    /* ③ 非对称分栏 左5 / 右7 */
    const left = h("div", { class: "con-col-left" });
    const right = h("div", { class: "con-col-right" });
    main.appendChild(h("div", { class: "con-split" }, left, right));

    /* ── 左列：桥接卡（大号 uptime 56–72px + 启停） ── */
    const brUptime = h("div", { class: "con-big is-idle", text: "—" }, h("span", { class: "con-big-unit", text: "uptime" }));
    const brBadge = h("span", { class: "con-card-badge" });
    const brKv = h("dl", { class: "con-kv" });
    const brStart = h("button", { class: "con-btn is-primary", type: "button" });
    t4(brStart, "启动", "Start");
    const brStop = h("button", { class: "con-btn is-secondary", type: "button", disabled: true });
    t4(brStop, "停止", "Stop");
    const brCard = h("div", { class: "con-card", "data-card": "bridge" },
        h("div", { class: "con-card-head" }, t4(h("span", { class: "con-card-title" }), "桥接服务", "BRIDGE"), brBadge),
        brUptime, brKv,
        h("div", { class: "con-card-actions" }, brStart, brStop));
    left.appendChild(brCard);

    /* ── 左列：游戏卡（无游戏 = 指引，不是报错 —— E1） ── */
    const gameBadge = h("span", { class: "con-card-badge" });
    const hubWrap = h("div", { class: "con-big is-idle", text: "—" }, h("span", { class: "con-big-unit", text: "hub" }));
    const gameKv = h("dl", { class: "con-kv" });
    const gameGuide = h("div", { class: "con-card-row" });
    const gameLaunch = h("button", { class: "con-btn is-primary", type: "button" });
    t4(gameLaunch, "启动游戏", "Launch game");
    const gameCard = h("div", { class: "con-card", "data-card": "game" },
        h("div", { class: "con-card-head" }, t4(h("span", { class: "con-card-title" }), "游戏", "GAME"), gameBadge),
        hubWrap, gameKv, gameGuide,
        h("div", { class: "con-card-actions" }, gameLaunch));
    left.appendChild(gameCard);

    /* ── 左列：Mod 卡 ── */
    const modBadge = h("span", { class: "con-card-badge" });
    const modKv = h("dl", { class: "con-kv" });
    const modCard = h("div", { class: "con-card", "data-card": "mod" },
        h("div", { class: "con-card-head" }, t4(h("span", { class: "con-card-title" }), "Mod", "MOD"), modBadge),
        modKv);
    left.appendChild(modCard);

    /* ── 左列：冒烟卡（5 项检查视图 + M7 spring） ── */
    const smokeBadge = h("span", { class: "con-card-badge" });
    const smokeSummary = h("div", { class: "con-smoke-summary" });
    const smokeList = h("div", { class: "con-smoke-list" });
    const smokeHint = h("div", { class: "con-smoke-hint", hidden: true });
    const smokeRun = h("button", { class: "con-btn is-primary", type: "button" });
    t4(smokeRun, "运行冒烟测试", "Run smoke test");
    const smokeCard = h("div", { class: "con-card", "data-card": "smoke" },
        h("div", { class: "con-card-head" }, t4(h("span", { class: "con-card-title" }), "冒烟测试", "SMOKE"), smokeBadge),
        smokeSummary, smokeList, smokeHint,
        h("div", { class: "con-card-actions" }, smokeRun));
    left.appendChild(smokeCard);

    /* ── 右列：日志控制台 ── */
    const logHost = h("div", { class: "con-log-body" });
    const filterBar = h("div", { class: "con-filter", role: "group", "aria-label": "log level filter" });
    const FILTERS = [["all", "全部", "all"], ["info", "info", "info"], ["warn", "warn", "warn"], ["error", "error", "error"]];
    const filterBtns = {};
    for (const [key, zh, en] of FILTERS) {
        const b = h("button", { type: "button", "aria-pressed": String(key === "all"), "data-filter": key });
        t4(b, zh, en);
        b.addEventListener("click", () => setFilter(key));
        filterBtns[key] = b;
        filterBar.appendChild(b);
    }
    const followSw = h("span", { class: "con-sw" });
    const followLabel = t4(h("span", {}), "跟随", "Follow");
    const followBtn = h("button", { class: "con-toggle", type: "button", "aria-pressed": "true" }, followLabel, followSw);
    followBtn.addEventListener("click", () => {
        S.follow = !S.follow;
        followBtn.setAttribute("aria-pressed", String(S.follow));
        logView?.setFollow?.(S.follow);
    });
    const kindSel = h("select", { class: "con-kindsel", "aria-label": "log category" });
    for (const [k, zh, en] of [["bridge", "桥接", "Bridge"], ["install", "安装", "Install"], ["smoke", "冒烟", "Smoke"]]) {
        kindSel.appendChild(t4(h("option", { value: k }), zh, en));
    }
    kindSel.addEventListener("change", () => switchKind(kindSel.value));
    const kindSelWrap = h("span", { class: "con-kindsel-wrap" }, kindSel);
    const clearBtn = h("button", { class: "con-iconbtn", type: "button" });
    t4(clearBtn, "清屏", "Clear");
    const dlBtn = h("button", { class: "con-iconbtn", type: "button" });
    t4(dlBtn, "下载", "Download");
    const logPanel = h("div", { class: "con-logpanel" },
        h("div", { class: "con-log-head" },
            t4(h("span", { class: "con-log-title" }), "日志", "LOG"),
            kindSelWrap, filterBar,
            h("span", { class: "con-spacer" }),
            followBtn, clearBtn, dlBtn),
        logHost);
    right.appendChild(logPanel);

    /* ── 底行快捷 ── */
    const QUICK = [
        ["snapshots_dir", "打开快照目录", "Open snapshots"],
        ["__mcp_copy", "复制 MCP 配置", "Copy MCP config"],
        ["mods_dir", "打开 mods 目录", "Open mods dir"],
        ["readme", "文档", "Docs"],
    ];
    const quickbar = h("div", { class: "con-quickbar" });
    for (const [target, zh, en] of QUICK) {
        const b = t4(h("button", { class: "con-btn is-secondary", type: "button", "data-target": target }), zh, en);
        b.addEventListener("click", () => onQuick(target, b));
        quickbar.appendChild(b);
    }
    main.appendChild(quickbar);

    /* ── 日志视图 ── */

    let logView = null;
    depsP.then((deps) => {
        if (disposed) return;
        logView = makeLogView(deps, logHost);
        if (typeof logView.onFollow === "function") {
            logView.onFollow((f) => {
                S.follow = f;
                followBtn.setAttribute("aria-pressed", String(f));
            });
        }
        refreshLogs(true);
        if (deps.api?.events?.on) {
            cleanups.push(deps.api.events.on("log", (line) => {
                if (disposed || !line || line.kind !== S.logKind) return;
                if (line.n <= S.lastN) return;
                S.lastN = Math.max(S.lastN, line.n);
                appendLines([line]);
            }));
            cleanups.push(deps.api.events.on("bridge_status", (s) => { if (!disposed) applyStatus(s); }));
            cleanups.push(deps.api.events.on("smoke_status", (st) => { if (!disposed) applySmoke(st); }));
        }
        deps.api.bridgeStatus().then((s) => { if (!disposed) applyStatus(s); }).catch(() => applyStatus(null));
        deps.api.smokeStatus().then((st) => { if (!disposed) applySmoke(st); }).catch(() => {});
        deps.api.env().then((e) => { if (!disposed) applyEnv(e); }).catch(() => {});
        // mock 模式无 SSE log 事件（T3 mockPushLog 不 emit）→ 轮询补增量；
        // 真实后端由 SSE 推送，无需轮询。
        if (deps.MOCK) {
            const iv = setInterval(() => { if (!disposed) refreshLogs(false); }, 1800);
            cleanups.push(() => clearInterval(iv));
        }
    });

    /* ── 交互 ── */

    async function doBridgeStart(btn) {
        const deps = await depsP;
        setBusy(btn, true);
        try {
            const r = await deps.api.bridgeStart();
            deps.toast(tr("桥接已启动", "Bridge started"), "success");
            applyStatus(r?.status || (await deps.api.bridgeStatus().catch(() => S.status)));
            refreshLogs(false);
        } catch (e) {
            shake(btn);
            deps.toast(e.message || String(e), "error");
            if (e.log_ref) locateLog(e.log_ref, "bridge");
            applyStatus(S.status);
        } finally {
            setBusy(btn, false);
        }
    }
    async function doBridgeStop(btn) {
        const deps = await depsP;
        setBusy(btn, true);
        try {
            await deps.api.bridgeStop();
            deps.toast(tr("桥接已停止", "Bridge stopped"), "info");
            applyStatus(await deps.api.bridgeStatus().catch(() => null));
            refreshLogs(false);
        } catch (e) {
            shake(btn);
            deps.toast(e.message || String(e), "error");
            applyStatus(S.status);
        } finally {
            setBusy(btn, false);
        }
    }
    async function doSmokeRun(btn) {
        const deps = await depsP;
        setBusy(btn, true);
        try {
            await deps.api.smokeStart({ autoplay: true });
            S.smokeSpringShown = false;
            pollSmoke();
        } catch (e) {
            shake(btn);
            deps.toast(e.message || String(e), "error");
        } finally {
            setBusy(btn, false);
        }
    }

    heroAction.onclick = () => (S.status?.running ? doBridgeStop(heroAction) : doBridgeStart(heroAction));
    brStart.onclick = () => doBridgeStart(brStart);
    brStop.onclick = () => doBridgeStop(brStop);
    smokeRun.onclick = () => doSmokeRun(smokeRun);
    heroOpenGame.onclick = openGame;
    gameLaunch.onclick = openGame;
    clearBtn.onclick = () => logView?.clear?.();
    dlBtn.onclick = () => downloadLog();

    function openGame() {
        depsP.then((deps) => deps.api.openTarget("steam_run").catch((e) => deps.toast(e.message || String(e), "error")));
    }

    async function onQuick(target, btn) {
        const deps = await depsP;
        if (target !== "__mcp_copy") {
            try { await deps.api.openTarget(target); } catch (e) { shake(btn); deps.toast(e.message || String(e), "error"); }
            return;
        }
        setBusy(btn, true);
        try {
            const r = await deps.api.mcpConfig();
            const text = JSON.stringify(r.config, null, 2);
            let ok = false;
            try {
                if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); ok = true; }
            } catch { ok = false; }
            if (ok) deps.toast(tr("MCP 配置已复制到剪贴板", "MCP config copied to clipboard"), "success");
            else fallbackCopy(text, deps);
        } catch (e) {
            shake(btn);
            deps.toast(e.message || String(e), "error");
        } finally {
            setBusy(btn, false);
        }
    }

    function fallbackCopy(text, deps) {
        const existing = right.querySelector(".con-copyfallback");
        if (existing) existing.remove();
        const ta = h("textarea", { rows: "10", readonly: true, "aria-label": "MCP config JSON" });
        ta.value = text;
        const close = h("button", { class: "con-btn is-secondary", type: "button" });
        t4(close, "关闭", "Close");
        close.onclick = () => wrap.remove();
        const wrap = h("div", { class: "con-copyfallback" },
            t4(h("div", { class: "set-hint" }), "剪贴板不可用 —— 已为你全选，按 Ctrl+C 复制：", "Clipboard unavailable — text selected, press Ctrl+C:"),
            ta, close);
        right.appendChild(wrap);
        ta.focus();
        ta.select();
        try {
            if (document.execCommand("copy")) deps.toast(tr("已复制", "Copied"), "success");
            else deps.toast(tr("请按 Ctrl+C 复制选中文本", "Press Ctrl+C to copy"), "warn");
        } catch { deps.toast(tr("请按 Ctrl+C 复制选中文本", "Press Ctrl+C to copy"), "warn"); }
    }

    /* ── 状态应用 ── */

    function applyStatus(s) {
        S.status = s || null;
        const running = !!s?.running;
        const connected = !!s?.mod_connected;
        const healthy = !!s?.healthy;
        const inGame = connected && s?.in_game !== false;

        heroState.textContent = connected ? tr("运行中", "Running") : running ? tr("已启动", "Started") : tr("未启动", "Stopped");
        heroState.className = `con-hero-state ${connected ? "is-ok" : running ? "is-warn" : "is-idle"}`;
        heroSub.textContent = connected
            ? tr(`游戏 ${s.game_version || "?"} · hub Lv ${s.hub_level ?? "?"} · 端口 ${s.port}`,
                 `game ${s.game_version || "?"} · hub Lv ${s.hub_level ?? "?"} · port ${s.port}`)
            : running ? tr(`等待游戏连接… 端口 ${s.port}`, `Waiting for the game… port ${s.port}`)
                      : tr("桥接未运行 —— 启动后 AI 可操作游戏", "Bridge stopped — start it so AI can act");

        if (running) t4(heroAction, "停止桥接", "Stop bridge");
        else t4(heroAction, "启动桥接", "Start bridge");
        heroAction.classList.toggle("is-primary", !running);
        heroAction.classList.toggle("is-secondary", running);
        heroOpenGame.hidden = inGame;

        // 信号链
        const states = {
            game: { live: inGame, warn: running && !inGame, text: inGame ? tr(`运行中 ${s.game_version || ""}`, `running ${s.game_version || ""}`).trim() : running ? tr("未运行 / 未连接", "off / not linked") : tr("未知", "unknown") },
            mod: { live: connected, warn: running && !connected, text: connected ? tr(`已连接 v${s.mod_version || "?"}`, `linked v${s.mod_version || "?"}`) : running ? tr("等待连接", "waiting") : tr("未连接", "off") },
            bridge: { live: running && healthy, warn: running && !healthy, text: running ? `healthy :${s.port}` : tr("未运行", "off") },
            ai: { live: running, warn: false, text: running ? tr("可接入", "ready") : tr("离线", "offline") },
        };
        for (const key of Object.keys(nodeEls)) {
            const { node, state } = nodeEls[key];
            const st = states[key];
            node.className = `con-chain-node ${st.live ? "is-live" : st.warn ? "is-warnstate" : "is-off"}`;
            state.textContent = st.text;
        }
        const links = chain.querySelectorAll(".con-chain-link");
        const liveArr = [states.game.live, states.mod.live, states.bridge.live, states.ai.live];
        links.forEach((l, i) => l.classList.toggle("is-hot", liveArr[i] && liveArr[i + 1]));

        // 桥接卡
        const up = fmtUptime(s?.uptime_s);
        brUptime.textContent = "";
        brUptime.classList.toggle("is-idle", !running);
        if (up !== null && running) {
            brUptime.append(up, h("span", { class: "con-big-unit", text: "uptime" }));
        } else {
            brUptime.append("—", h("span", { class: "con-big-unit", text: "uptime" }));
        }
        brBadge.textContent = connected ? tr("运行 · 已连游戏", "running · linked")
            : running ? (s.managed ? tr("运行中", "running") : tr("运行（外部启动）", "running (external)"))
            : tr("已停止", "stopped");
        brBadge.className = `con-card-badge ${connected ? "is-ok" : running ? "is-warn" : ""}`;
        brKv.textContent = "";
        kv(brKv, tr("端口", "Port"), String(s?.port ?? "—"));
        kv(brKv, "PID", s?.pid ? String(s.pid) : "—");
        kv(brKv, tr("管理模式", "Managed"), running ? (s.managed ? tr("GUI 托管", "by GUI") : tr("外部启动（停止需回原终端）", "external (stop in its terminal)")) : "—");
        kv(brKv, tr("健康", "Health"), running ? (healthy ? "healthy" : "unhealthy") : "—");
        if (s?.last_error) kv(brKv, tr("最近错误", "Last error"), s.last_error);
        brStart.disabled = running;
        brStop.disabled = !running || !s?.managed;
        brStop.title = running && !s?.managed ? tr("外部启动的桥接请在原终端 Ctrl-C 停止", "This bridge was started externally — Ctrl-C in its terminal") : "";

        // 游戏卡
        const g = S.env?.game;
        gameBadge.textContent = inGame ? tr("已连接（存档中）", "linked (in save)")
            : g?.running ? tr("运行中 · 等待 Mod", "running · waiting for mod")
            : tr("未运行", "not running");
        gameBadge.className = `con-card-badge ${inGame ? "is-ok" : g?.running ? "is-warn" : ""}`;
        const hub = s?.hub_level;
        hubWrap.textContent = "";
        if (hub !== null && hub !== undefined) {
            hubWrap.classList.remove("is-idle");
            hubWrap.append(String(hub), h("span", { class: "con-big-unit", text: "hub Lv" }));
        } else {
            hubWrap.classList.add("is-idle");
            hubWrap.append("—", h("span", { class: "con-big-unit", text: "hub Lv" }));
        }
        gameKv.textContent = "";
        const verText = s?.game_version
            ? s.game_version
            : g?.found ? (g?.running ? tr("已安装（运行中）", "installed (running)") : tr("已安装（未运行）", "installed (idle)")) : g ? tr("未安装", "not installed") : "—";
        kv(gameKv, tr("版本", "Version"), verText);
        kv(gameKv, tr("安装目录", "Install dir"), g?.dir || tr("未找到", "not found"));
        kv(gameKv, tr("状态", "State"), inGame ? tr("已连接", "linked") : g?.running ? tr("运行中，未连接 Mod", "running, mod not linked") : g ? tr("未运行", "not running") : "—");
        if (s?.paused !== null && s?.paused !== undefined) kv(gameKv, tr("暂停", "Paused"), s.paused ? tr("是", "yes") : tr("否", "no"));
        gameGuide.textContent = "";
        if (!inGame) {
            if (g && !g.found) {
                gameGuide.append(tr("未找到 shapez.io。", "shapez.io not found. "));
                const b = h("button", { class: "con-btn is-secondary", type: "button" });
                t4(b, "用 Steam 安装", "Install via Steam");
                b.onclick = () => depsP.then((d) => d.api.openTarget("steam_store").catch(() => {}));
                gameGuide.appendChild(b);
            } else if (g && !g.running) {
                gameGuide.append(tr("游戏未运行 —— 点「启动游戏」通过 Steam 打开；装完 Mod 后需重启游戏才会生效。",
                    "Game not running — use “Launch game”. After installing the mod, restart the game for it to load."));
            } else if (g && g.running) {
                gameGuide.append(tr("游戏在运行但 Mod 未连接 —— 若刚安装完，请重启游戏；然后进入一个存档。",
                    "Game running but mod not linked — restart the game if you just installed, then load a save."));
            } else {
                gameGuide.append(tr("等待环境信息…", "Waiting for environment info…"));
            }
        }
        gameLaunch.hidden = inGame;

        // Mod 卡
        const m = S.env?.mod;
        if (m) {
            modBadge.textContent = m.installed
                ? (m.match ? tr("已安装 · 与仓库一致", "installed · matches repo") : tr("已安装 · 与仓库不一致", "installed · differs from repo"))
                : tr("未安装", "not installed");
            modBadge.className = `con-card-badge ${m.installed ? (m.match ? "is-ok" : "is-warn") : "is-err"}`;
            modKv.textContent = "";
            kv(modKv, tr("版本", "Version"), S.env?.repo?.mod_version || "—");
            kv(modKv, tr("安装路径", "Path"), m.path || "—");
            kv(modKv, "sha256", m.installed
                ? (m.match ? `${String(m.sha256_repo || "").slice(0, 12)}… ${tr("（一致）", "(match)")}` : `${String(m.sha256_installed || "?").slice(0, 12)}… ≠ ${tr("仓库", "repo")}`)
                : "—");
            kv(modKv, tr("备份文件", "Backups"), m.backup_count ? `${m.backup_count} × .bak-*` : tr("无", "none"));
            if (connected && s?.mod_version) kv(modKv, tr("运行中 Mod", "Mod in game"), `v${s.mod_version} (protocol 1)`);
        } else {
            modKv.textContent = "";
            kv(modKv, tr("状态", "State"), tr("等待环境信息…", "waiting for env…"));
        }
    }

    function kv(dl, key, val) {
        dl.append(h("dt", { text: key }), h("dd", { text: String(val) }));
    }

    function applyEnv(e) {
        S.env = e || null;
        applyStatus(S.status);
    }

    /* ── 冒烟 ── */

    function renderSmokeList(checks, springAll) {
        smokeList.textContent = "";
        for (const c of checks) {
            const ico = h("span", { class: "con-smoke-ico", text: c.state === "pass" ? "✓" : c.state === "fail" ? "✕" : c.state === "running" ? "◌" : "·" });
            if (c.state === "pass" && springAll) ico.classList.add("is-spring");
            smokeList.appendChild(h("div", { class: "con-smoke-row", dataset: { state: c.state } },
                ico,
                h("span", { class: "con-smoke-name", text: `${c.n}. ${getLangSafe() === "en" ? (c.name || c.name_zh) : (c.name_zh || c.name)}` }),
                h("span", { class: "con-smoke-detail", text: c.detail || "" })));
        }
    }

    function applySmoke(st) {
        if (!st) return;
        const prev = S.smoke;
        S.smoke = st;
        const checks = Array.isArray(st.checks) ? st.checks : [];
        const passed = checks.filter((c) => c.state === "pass").length;
        const failed = checks.filter((c) => c.state === "fail").length;
        const hasRun = st.exit_code !== null && st.exit_code !== undefined || st.running || checks.some((c) => c.state !== "pending");

        smokeBadge.textContent = st.running ? tr("运行中…", "running…")
            : !hasRun ? tr("未运行", "not run")
            : st.exit_code === 0 ? tr("5/5 通过", "5/5 passed")
            : `${passed}/5 · ${tr("退出码", "exit")} ${st.exit_code}`;
        smokeBadge.className = `con-card-badge ${!st.running && st.exit_code === 0 && passed === 5 ? "is-ok" : st.running ? "is-warn" : failed || (st.exit_code !== null && st.exit_code !== 0) ? "is-err" : ""}`;

        smokeSummary.textContent = "";
        if (hasRun) {
            smokeSummary.append(
                h("span", { text: st.running ? tr(`检查中 ${passed}/5`, `running ${passed}/5`) : tr(`${passed}/5 通过`, `${passed}/5 passed`) }));
            if (st.finished_at) smokeSummary.append(h("span", { class: "con-muted", text: new Date(st.finished_at).toLocaleTimeString() }));
        } else {
            smokeSummary.append(h("span", { class: "con-muted", text: tr("尚无运行记录 —— 需要桥接运行 + 游戏进入存档", "No runs yet — needs a live bridge and the game in a save") }));
        }

        // M7 spring：一次从「非完成 → 5/5 完成」时弹一次对勾（全页唯一弹簧）
        const wasComplete = !!(prev && !prev.running && prev.exit_code === 0);
        const isComplete = !st.running && st.exit_code === 0 && passed === 5;
        let springNow = false;
        if (isComplete && !wasComplete && !S.smokeSpringShown) {
            springNow = true;
            S.smokeSpringShown = true;
        }
        renderSmokeList(checks, springNow);

        const hintText = st.running ? null
            : st.hint || (st.exit_code !== null && st.exit_code !== undefined ? smokeExitHint(st.exit_code) : null);
        smokeHint.hidden = !hintText;
        smokeHint.textContent = hintText || "";

        smokeRun.disabled = !!st.running;
    }

    function pollSmoke() {
        if (disposed) return;
        depsP.then((deps) => {
            deps.api.smokeStatus().then((st) => {
                if (disposed) return;
                applySmoke(st);
                if (st?.running) setTimeout(pollSmoke, 700);
            }).catch(() => {});
        });
    }

    /* ── 日志 ── */

    /** T3 createLogView 自带 setFilter（精确级别匹配）；本层接管过滤以给出
     *  severity 语义（warn ⊇ error、info ⊇ ok）：T3 视图保持 all 基态，
     *  行可见性由 applyDomFilter 统一切换。简版视图走 append 预过滤 + 整批重渲。 */
    function viewCanFilter() { return !!(logView && typeof logView.setFilter === "function" && logHost.querySelector(".logrow")); }

    function appendLines(lines) {
        if (!logView) return;
        const toAdd = viewCanFilter() ? lines : lines.filter((l) => filterPass(l.level));
        if (toAdd.length) logView.append(toAdd);
        if (viewCanFilter() && S.filter !== "all") applyDomFilter();
    }

    function applyDomFilter() {
        for (const row of logHost.querySelectorAll(".logrow, .logp-line")) {
            row.hidden = !filterPass(row.dataset.level || "info");
        }
    }

    function filterPass(level) {
        const lv = level || "info";
        if (S.filter === "all") return true;
        if (S.filter === "error") return lv === "error";
        if (S.filter === "warn") return lv === "warn" || lv === "error";
        if (S.filter === "info") return lv === "info" || lv === "ok";
        return true;
    }

    function setFilter(key) {
        S.filter = key;
        for (const [k, b] of Object.entries(filterBtns)) b.setAttribute("aria-pressed", String(k === key));
        if (viewCanFilter()) {
            logView.setFilter("all"); // 基态全显，再叠加 severity 过滤
            applyDomFilter();
            logView.setFollow?.(S.follow);
        } else {
            refreshLogs(true);
        }
    }

    async function refreshLogs(reset) {
        const deps = await depsP;
        if (disposed || !logView) return;
        try {
            if (reset) {
                logView.clear?.();
                S.lastN = 0;
                const r = await deps.api.logsSince(S.logKind, 0);
                S.lastN = r.next_since || 0;
                appendLines(r.lines || []);
            } else {
                const r = await deps.api.logsSince(S.logKind, S.lastN);
                S.lastN = r.next_since || S.lastN;
                appendLines(r.lines || []);
            }
        } catch { /* 后端不可达 → 保持现状（断开横幅由 T3 处理） */ }
    }

    function switchKind(kind) {
        if (kind === S.logKind) return;
        S.logKind = kind;
        refreshLogs(true);
    }

    function locateLog(n, kind) {
        const target = Number(n);
        if (!Number.isFinite(target)) return;
        depsP.then(async (deps) => {
            if (kind && kind !== S.logKind) {
                S.logKind = kind;
                kindSel.value = kind;
                await refreshLogs(true);
            }
            let ok = logView?.jumpTo?.(target);
            if (!ok) {
                await refreshLogs(true);
                ok = logView?.jumpTo?.(target);
            }
            deps.toast(ok ? tr(`已定位到日志第 ${target} 行`, `Jumped to log line ${target}`) : tr(`日志中未找到第 ${target} 行（可能已被清屏或滚出缓冲）`, `Log line ${target} not found (cleared or scrolled out)`), ok ? "info" : "warn");
        });
    }

    function downloadLog() {
        const rows = [...logHost.querySelectorAll("[data-n]")];
        if (!rows.length) {
            depsP.then((deps) => deps.toast(tr("当前没有可下载的日志", "No log lines to download"), "warn"));
            return;
        }
        const text = rows.map((r) => `[${r.dataset.n}] ${r.textContent.replace(/^\s*\d+[\s:]*[\d:]*\s*/, "")}`).join("\r\n") + "\r\n";
        const blob = new Blob(["﻿" + text], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = h("a", { href: url, download: `shapez-${S.logKind}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt` });
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
    }

    /* ── 通用小状态 ── */

    function setBusy(btn, busy) {
        if (!btn) return;
        btn.classList.toggle("is-loading", !!busy);
        if (busy) btn.disabled = true;
        else {
            btn.disabled = false;
            // 让状态机重新裁决 disabled（如运行中时"启动"应保持禁用）
            if (btn === brStart || btn === brStop || btn === smokeRun) applyStatus(S.status);
            if (btn === smokeRun && S.smoke) applySmoke(S.smoke);
        }
    }
    function shake(btn) {
        btn.classList.remove("con-shake");
        void btn.offsetWidth;
        btn.classList.add("con-shake");
        setTimeout(() => btn.classList.remove("con-shake"), 350);
    }

    /* 语言切换重绘（boot.js 在 setLang 后调 GUI.refreshI18n） */
    try {
        window.GUI = window.GUI || {};
        const prevRefresh = window.GUI.refreshI18n;
        const myRefresh = () => {
            try { prevRefresh?.(); } catch { /* ignore */ }
            if (disposed) return;
            reapplyT4(rootEl);
            applyStatus(S.status);
            applySmoke(S.smoke);
        };
        window.GUI.refreshI18n = myRefresh;
        cleanups.push(() => { if (window.GUI?.refreshI18n === myRefresh) window.GUI.refreshI18n = prevRefresh; });
    } catch { /* ignore */ }

    return {
        dispose() {
            disposed = true;
            for (const fn of cleanups) { try { fn?.(); } catch { /* ignore */ } }
        },
    };
}

export default mountConsole;
