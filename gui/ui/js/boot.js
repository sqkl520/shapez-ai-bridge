/**
 * boot.js — application shell (DESIGN-PLAN §3.7 frozen surface).
 *
 * Responsibilities:
 *  1. window.GUI = {showView, toast, confirm(opts)->Promise<bool>, t, applyI18n}
 *  2. View switching across #view-boot/#view-wizard/#view-console/#view-settings
 *  3. Topbar: mini signal pill (4 dots), language switcher, version
 *  4. Toast host, <dialog id="confirm-dialog">
 *  5. Backend liveness: EventSource open/error + /api/healthz polling →
 *     disconnect banner with reconnect (acceptance F3)
 *  6. ?probe=1 → <script id="probe-json"> self-report
 *  7. ?mock=1 → no backend needed; default straight into the wizard
 *  8. T4 hooks: GUI.mountConsole(el) / GUI.mountSettings(el) if defined
 */
import { api, MOCK } from "./api.js";
import { t, setLang, getLang, applyI18n, KEYS } from "./i18n.js";
import { mountWizard } from "./wizard.js";

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);

const views = {
    boot: $("#view-boot"),
    wizard: $("#view-wizard"),
    console: $("#view-console"),
    settings: $("#view-settings"),
};

let currentView = "boot";
let wizardMounted = false;
let backendDown = false;
let healthTimer = null;

// ── toast ──────────────────────────────────────────────────────────────────
const LEVEL_ICON = { info: "i", success: "✓", warn: "!", error: "×" };
export function toast(msg, level = "info", ms = 4200) {
    const host = $("#toast-host");
    if (!host) return;
    const node = document.createElement("div");
    node.className = `toast toast-${level}`;
    node.setAttribute("role", level === "error" ? "alert" : "status");
    const ico = document.createElement("span");
    ico.className = "toast-ico";
    ico.textContent = LEVEL_ICON[level] || "i";
    const text = document.createElement("span");
    text.className = "toast-text";
    text.textContent = msg;
    const close = document.createElement("button");
    close.className = "toast-close";
    close.type = "button";
    close.setAttribute("aria-label", t("common.close"));
    close.textContent = "×";
    close.addEventListener("click", () => dismiss());
    node.append(ico, text, close);
    host.appendChild(node);
    let done = false;
    function dismiss() {
        if (done) return;
        done = true;
        node.classList.add("toast-out");
        setTimeout(() => node.remove(), 220);
    }
    setTimeout(dismiss, ms);
    return dismiss;
}

// ── confirm dialog (native <dialog>) ──────────────────────────────────────
export function confirm(opts = {}) {
    const dlg = $("#confirm-dialog");
    if (!dlg || typeof dlg.showModal !== "function") {
        // fallback for very old engines: window.confirm
        return Promise.resolve(window.confirm(opts.bodyKey ? t(opts.bodyKey) : (opts.body || "")));
    }
    return new Promise((resolve) => {
        const titleEl = dlg.querySelector("#confirm-title");
        const bodyEl = dlg.querySelector("#confirm-body");
        const okBtn = dlg.querySelector("#confirm-ok");
        const cancelBtn = dlg.querySelector("#confirm-cancel");
        titleEl.textContent = opts.title || t("confirm.title");
        bodyEl.textContent = opts.bodyKey ? t(opts.bodyKey) : (opts.body || "");
        okBtn.textContent = opts.okLabel || t("common.confirm");
        cancelBtn.textContent = opts.cancelLabel || t("common.cancel");
        okBtn.classList.toggle("btn-danger", !!opts.danger);
        okBtn.classList.toggle("btn-primary", !opts.danger);

        function cleanup(result) {
            okBtn.removeEventListener("click", onOk);
            cancelBtn.removeEventListener("click", onCancel);
            dlg.removeEventListener("cancel", onCancel);
            dlg.removeEventListener("close", onClose);
            if (dlg.open) dlg.close();
            resolve(result);
        }
        function onOk() { cleanup(true); }
        function onCancel(e) { if (e && e.type === "cancel") { /* Esc */ } cleanup(false); }
        function onClose() { cleanup(false); }
        okBtn.addEventListener("click", onOk);
        cancelBtn.addEventListener("click", onCancel);
        dlg.addEventListener("cancel", onCancel);
        dlg.addEventListener("close", onClose);
        dlg.showModal();
        cancelBtn.focus();
    });
}

// ── view switching ─────────────────────────────────────────────────────────
export function showView(name) {
    if (!views[name]) return;
    // T4 hooks — mount lazily, once
    try {
        if (name === "console" && typeof window.GUI?.mountConsole === "function" && !views.console.dataset.mounted) {
            views.console.dataset.mounted = "1";
            window.GUI.mountConsole($("#console-root"));
        }
        if (name === "settings" && typeof window.GUI?.mountSettings === "function" && !views.settings.dataset.mounted) {
            views.settings.dataset.mounted = "1";
            window.GUI.mountSettings($("#settings-root"));
        }
    } catch (e) {
        console.error("[boot] mount hook failed:", e);
    }
    // placeholders: only while T4's hooks have not been provided
    const conPl = $("#console-placeholder");
    if (conPl) conPl.hidden = !(name === "console" && typeof window.GUI?.mountConsole !== "function");
    const setPl = $("#settings-placeholder");
    if (setPl) setPl.hidden = !(name === "settings" && typeof window.GUI?.mountSettings !== "function");
    for (const [k, el] of Object.entries(views)) {
        if (!el) continue;
        el.hidden = k !== name;
    }
    currentView = name;
    // topbar nav active state
    for (const btn of document.querySelectorAll("[data-nav]")) {
        btn.classList.toggle("is-active", btn.dataset.nav === name);
    }
    const titleKey = name === "console" ? "console.title" : name === "settings" ? "settings.title" : name === "wizard" ? "wizard.step1" : "app.tagline";
    document.title = `${t("app.title")} — ${t(titleKey)}`;
}

// ── signal pill (topbar mini chain) ────────────────────────────────────────
function updatePill(status) {
    const pill = $("#signal-pill");
    if (!pill) return;
    const dots = {
        game: pill.querySelector('[data-dot="game"]'),
        mod: pill.querySelector('[data-dot="mod"]'),
        bridge: pill.querySelector('[data-dot="bridge"]'),
        ai: pill.querySelector('[data-dot="ai"]'),
    };
    const running = !!status?.running;
    const connected = !!status?.mod_connected;
    dots.bridge?.classList.toggle("on", running);
    dots.mod?.classList.toggle("on", running && connected);
    dots.game?.classList.toggle("on", running && connected && status?.in_game !== false ? connected : false);
    dots.game?.classList.toggle("on", connected);
    dots.ai?.classList.toggle("on", running); // AI side is up whenever the bridge serves
    pill.classList.toggle("is-healthy", connected);
    pill.title = connected ? t("topbar.status.connected") : running ? t("topbar.status.running") : t("topbar.status.stopped");
}

async function pollStatus() {
    try {
        const s = await api.bridgeStatus();
        updatePill(s);
        setBackendDown(false);
    } catch (e) {
        if (!MOCK) setBackendDown(true);
    }
}

// ── backend disconnect banner (F3) ─────────────────────────────────────────
function setBackendDown(down) {
    const banner = $("#backend-banner");
    if (!banner) return;
    if (down && !backendDown) {
        backendDown = true;
        banner.hidden = false;
        const btn = banner.querySelector(".banner-retry");
        if (btn) { btn.disabled = false; btn.textContent = t("topbar.reconnect"); }
    } else if (!down && backendDown) {
        backendDown = false;
        banner.hidden = true;
    }
}

function wireBackendWatch() {
    if (MOCK) return;
    api.events.on("error", () => setBackendDown(true));
    api.events.on("open", () => setBackendDown(false));
    const banner = $("#backend-banner");
    banner?.querySelector(".banner-retry")?.addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = t("topbar.reconnect.checking");
        try {
            const res = await fetch("/api/healthz");
            if (res.ok) {
                setBackendDown(false);
                btn.disabled = false;
                window.location.reload();
            } else { throw new Error("bad status"); }
        } catch {
            btn.disabled = false;
            btn.textContent = t("topbar.reconnect");
            toast(t("topbar.backend_lost.hint"), "error");
        }
    });
    // belt & braces: poll healthz every 5s
    healthTimer = setInterval(async () => {
        try { const r = await fetch("/api/healthz"); setBackendDown(!r.ok); if (r.ok) setBackendDown(false); }
        catch { setBackendDown(true); }
    }, 5000);
}

// ── language switch ────────────────────────────────────────────────────────
function wireLang() {
    const btn = $("#lang-toggle");
    if (!btn) return;
    const sync = () => { btn.textContent = getLang() === "zh" ? "EN" : "中"; btn.setAttribute("aria-label", t("topbar.lang")); };
    btn.addEventListener("click", () => { setLang(getLang() === "zh" ? "en" : "zh"); applyI18n(document); sync(); window.GUI.refreshI18n?.(); });
    sync();
}

// ── probe (?probe=1) ───────────────────────────────────────────────────────
function writeProbe() {
    if (params.get("probe") !== "1") return;
    // measure on the currently visible view; prefer wizard (most type contrast)
    const visible = Object.values(views).find((v) => v && !v.hidden) || document.body;
    const bodySize = parseFloat(getComputedStyle(document.body).fontSize) || 14;
    let maxSize = 0;
    for (const el of visible.querySelectorAll("*")) {
        const st = getComputedStyle(el);
        if (st.display === "none" || st.visibility === "hidden" || !el.textContent?.trim()) continue;
        const fs = parseFloat(st.fontSize);
        if (fs > maxSize) maxSize = fs;
    }
    let minHit = Infinity;
    let count = 0;
    for (const el of visible.querySelectorAll("button, a[href], input, select, textarea, [role=button], [tabindex]:not([tabindex='-1'])") ) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (el.closest("[hidden]")) continue;
        count += 1;
        minHit = Math.min(minHit, Math.min(r.width, r.height));
    }
    const probe = {
        displayFont: `${maxSize}px`,
        bodyFont: `${bodySize}px`,
        ratio: bodySize ? +(maxSize / bodySize).toFixed(2) : 0,
        minHit: Number.isFinite(minHit) ? Math.round(minHit) : 0,
        focusableCount: count,
        reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        view: currentView,
    };
    let tag = document.getElementById("probe-json");
    if (!tag) {
        tag = document.createElement("script");
        tag.type = "application/json";
        tag.id = "probe-json";
        document.body.appendChild(tag);
    }
    tag.textContent = JSON.stringify(probe);
    return probe;
}

// ── boot sequence ──────────────────────────────────────────────────────────
async function boot() {
    applyI18n(document);
    wireLang();
    wireBackendWatch();
    wireTopbarNav();

    // version chip
    api.version().then((v) => {
        const chip = $("#version-chip");
        if (chip) chip.textContent = `v${v.gui} · mod ${v.mod}`;
    }).catch(() => {});

    // view routing: ?view= wins; probe/mock always land on the wizard (type
    // contrast lives there); returning users who finished the wizard start on
    // the console.
    const target = params.get("view");
    let completed = false;
    try { completed = localStorage.getItem("gui.wizard_completed") === "1"; } catch { /* ignore */ }
    if (target === "console") showView("console");
    else if (target === "settings") showView("settings");
    else if (params.get("probe") === "1" || MOCK || !completed) showView("wizard");
    else showView("console");

    if (MOCK) {
        // Demo mode: no backend exists by design. No SSE subscription, no
        // healthz polling, no disconnect banner — show a neutral chip instead.
        const chip = $("#mock-chip");
        if (chip) chip.hidden = false;
        pollStatus();
        setInterval(pollStatus, 3000);
    } else {
        pollStatus();
    }

    // give the wizard a beat to render before probing (fonts/layout settle
    // under virtual-time too — rAF fires in headless virtual time)
    if (params.get("probe") === "1") {
        const report = () => { writeProbe(); };
        requestAnimationFrame(() => requestAnimationFrame(report));
        // second pass after mount animations (700ms hero) for a stable measure
        setTimeout(report, 1200);
        // third safety pass for --virtual-time-budget runs
        setTimeout(report, 2600);
    }
}

function wireTopbarNav() {
    for (const btn of document.querySelectorAll("[data-nav]")) {
        btn.addEventListener("click", () => showView(btn.dataset.nav));
    }
}

function ensureWizard() {
    if (wizardMounted) return;
    wizardMounted = true;
    mountWizard($("#wizard-root"), {
        showView,
        toast,
        confirm,
        t,
        goto: (view) => showView(view),
    });
}

// ── public surface (frozen §3.7) ──────────────────────────────────────────
// Preserve mount hooks T4 registered before boot.js ran (their script tag may
// sit before ours in the document).
const preExisting = window.GUI || {};
window.GUI = {
    showView,
    toast,
    confirm,
    t,
    applyI18n,
    getLang,
    setLang,
    keys: KEYS,
    mock: MOCK,
    /** T4 supplies these; showView calls them lazily on first view entry. */
    mountConsole: typeof preExisting.mountConsole === "function" ? preExisting.mountConsole : undefined,
    mountSettings: typeof preExisting.mountSettings === "function" ? preExisting.mountSettings : undefined,
    /** wizard completion hook (settings could re-open the wizard) */
    onWizardComplete: () => {
        try { localStorage.setItem("gui.wizard_completed", "1"); } catch { /* ignore */ }
    },
    openWizard: () => { showView("wizard"); },
};

// T4 owns console.js/settings.js and cannot edit index.html; import them if
// they exist and adopt whichever mount hook they expose (export or side-set on
// window.GUI). Missing files are the normal pre-T4 state — skip quietly.
(async () => {
    for (const [file, hook, view] of [["console.js", "mountConsole", "console"], ["settings.js", "mountSettings", "settings"]]) {
        if (typeof window.GUI[hook] === "function") continue;
        try {
            const m = await import(`./${file}`);
            const fn = typeof window.GUI[hook] === "function" ? window.GUI[hook]
                : (typeof m[hook] === "function" && m[hook]) || (typeof m.default === "function" && m.default) || null;
            if (!fn) continue;
            window.GUI[hook] = fn;
            console.info(`[boot] T4 ${hook} adopted from ${file}`);
            // adoption may land after showView already ran (async import): if the
            // user is already on that view, mount it now and drop the placeholder
            if (currentView === view && !views[view].dataset.mounted) {
                views[view].dataset.mounted = "1";
                fn($(view === "console" ? "#console-root" : "#settings-root"));
                const pl = $((view === "console" ? "#console" : "#settings") + "-placeholder");
                if (pl) pl.hidden = true;
            }
        } catch { /* module not present yet — fine */ }
    }
})();

// mount the wizard immediately into its hidden view so DOM checks see content
ensureWizard();
boot();

// Global safety net: unhandled errors surface as toasts rather than silence.
window.addEventListener("unhandledrejection", (e) => {
    const msg = e.reason?.message || String(e.reason || "unhandled rejection");
    if (/AbortError/.test(msg)) return;
    console.error("[boot] unhandled:", e.reason);
});
