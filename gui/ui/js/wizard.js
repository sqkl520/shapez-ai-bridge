/**
 * wizard.js — the product-grade first-run wizard (DESIGN-PLAN §3.5, W1–W6).
 *
 * Owned by T3. Uses only frozen interfaces: api.js methods, i18n t(), and the
 * DOM scaffold from index.html (#view-wizard). Exposes mountWizard(root, ctx)
 * where ctx = {showView, toast, confirm, t}.
 *
 * Layout: vertical step rail (index-styled big numerals) + content panel.
 * Motion: M2 step transition (450ms translate+fade, direction-aware), M6 log
 * arrivals via createLogView, M7 success spring, M8 failure shake — all
 * CSS-driven, collapse under prefers-reduced-motion.
 */
import { api, ApiError } from "./api.js";
import { t, onLangChange } from "./i18n.js";
import { createLogView } from "./logview.js";

const STEPS = [
    { id: "w1", key: "wizard.step1" },
    { id: "w2", key: "wizard.step2" },
    { id: "w3", key: "wizard.step3" },
    { id: "w4", key: "wizard.step4" },
    { id: "w5", key: "wizard.step5" },
    { id: "w6", key: "wizard.step6" },
];

let _uid = 0;
const uid = (p) => `${p}-${++_uid}`;

function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (k === "class") el.className = v;
        else if (k === "html") el.innerHTML = v;
        else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, "");
        else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
        if (c == null) continue;
        el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
}

/** Inline SVG icon set — stroke icons, currentColor, zero deps. */
export const icons = {
    check: (cls = "") => `<svg class="ico ${cls}" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8.5l3.5 3.5 7.5-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    cross: (cls = "") => `<svg class="ico ${cls}" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
    spinner: (cls = "") => `<svg class="ico spin ${cls}" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="10 28" stroke-linecap="round"/></svg>`,
    dot: (cls = "") => `<svg class="ico ${cls}" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4" fill="currentColor"/></svg>`,
    warn: (cls = "") => `<svg class="ico ${cls}" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8L15 14H1z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 6v3.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11.6" r="0.9" fill="currentColor"/></svg>`,
    arrow: (cls = "") => `<svg class="ico ${cls}" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9M8.5 3.5L13 8l-4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

function iconEl(name) {
    const span = document.createElement("span");
    span.className = "ico-host";
    span.innerHTML = icons[name]();
    return span;
}

export function mountWizard(root, ctx) {
    const { goto } = ctx; // (view, opts) — from ctx.wizardNav
    let stepIndex = 0;
    let wizardDone = false;
    /** state carried across steps */
    const S = {
        env: null,
        envLoading: false,
        install: null,      // {status:"idle"|"running"|"done"|"fail", result, error}
        config: null,       // {config, defaults, file, warnings}
        configSaving: false,
        configErrors: {},   // field -> message
        bridgeStarting: false,
        bridgeError: null,
        bridgeStatus: null,
        bridgeUnsub: null,
        smoke: null,        // smoke_status payload
        smokeStarting: false,
        smokeRaw: null,
        lang: null,
    };
    let unsubStatus = null; // reserved: only W5 currently subscribes (via S.bridgeUnsub)
    let unsubSmoke = null;
    let installLogView = null;
    let w5LogView = null;
    let heroPlayed = false;

    // ── scaffold ──────────────────────────────────────────────────────────
    root.textContent = "";
    const shell = h("div", { class: "wizard-shell" });

    const rail = h("nav", { class: "wz-rail", "aria-label": "向导步骤" });
    const stepButtons = STEPS.map((step, i) => {
        const b = h("button", {
            class: "wz-steptab", type: "button",
            onclick: () => { if (i <= maxReachable()) go(i); },
        },
            h("span", { class: "wz-stepnum", "data-n": String(i + 1) }),
            h("span", { class: "wz-steplabel", "data-i18n": step.key }),
            h("span", { class: "wz-stepmark" }),
        );
        rail.appendChild(b);
        return b;
    });

    const panel = h("section", { class: "wz-panel", role: "region" });
    const bannerSlot = h("div", { class: "wz-banner-slot" });
    panel.appendChild(bannerSlot);
    const content = h("div", { class: "wz-content" });
    panel.appendChild(content);

    shell.append(rail, panel);
    root.appendChild(shell);

    /** Progress ceiling: user can revisit, not skip ahead past readiness. */
    function maxReachable() {
        if (wizardDone) return STEPS.length - 1;
        if (!S.env) return 0;
        if (!S.install || S.install.status !== "done") return 2;
        if (!S.config) return 2;
        if (!S.bridgeStatus || !S.bridgeStatus.running) return 4;
        return 5;
    }

    function renderRail() {
        stepButtons.forEach((b, i) => {
            b.classList.toggle("is-current", i === stepIndex);
            b.classList.toggle("is-done", i < stepIndex);
            b.disabled = i > maxReachable() && i !== stepIndex;
            b.setAttribute("aria-current", i === stepIndex ? "step" : "false");
            const mark = b.querySelector(".wz-stepmark");
            mark.innerHTML = i < stepIndex ? icons.check() : "";
        });
    }

    let _navDir = 1;
    function go(i) {
        _navDir = i >= stepIndex ? 1 : -1;
        stepIndex = i;
        renderRail();
        renderPanel();
        panel.focus?.();
    }

    // ── reactive helpers ──────────────────────────────────────────────────
    function renderPanel() {
        const step = STEPS[stepIndex];
        content.textContent = "";
        bannerSlot.textContent = "";
        // W5's live bridge-status subscription only makes sense on W5
        if (step.id !== "w5" && S.bridgeUnsub) { S.bridgeUnsub(); S.bridgeUnsub = null; }
        const view = {
            w1: renderW1, w2: renderW2, w3: renderW3,
            w4: renderW4, w5: renderW5, w6: renderW6,
        }[step.id];
        const el = view();
        // M1: hero entrance plays once, on the first time W1 is shown
        if (step.id === "w1" && !heroPlayed) {
            heroPlayed = true;
            el.classList.add("m1");
        }
        el.classList.add("wz-anim");
        if (_navDir < 0) el.classList.add("wz-anim-back");
        content.appendChild(el);
        renderBanner();
        if (window.GUI && window.GUI.applyI18n) window.GUI.applyI18n(el.parentElement?.parentElement || el);
    }

    /** ⑤ warning band: game missing → persistent yellow banner from W2 on. */
    function renderBanner() {
        bannerSlot.textContent = "";
        if (stepIndex >= 1 && S.env && !S.env.game.found) {
            bannerSlot.appendChild(h("div", { class: "wz-warnbanner", role: "status" },
                iconEl("warn"),
                h("span", { "data-i18n": "w2.game_missing_banner" }),
                h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-i18n": "w2.action.steam", onclick: () => api.openTarget("steam_store").catch((e) => ctx.toast(e.message, "error")) }),
            ));
            if (window.GUI && window.GUI.applyI18n) window.GUI.applyI18n(bannerSlot);
        }
    }

    function primaryBtn(labelKey, onClick, opts = {}) {
        const btn = h("button", { class: "btn btn-primary", type: "button" },
            h("span", { class: "btn-label", "data-i18n": labelKey }));
        btn.addEventListener("click", () => onClick(btn));
        if (opts.id) btn.id = opts.id;
        return btn;
    }
    function secondaryBtn(labelKey, onClick, opts = {}) {
        const btn = h("button", { class: "btn btn-secondary", type: "button" },
            h("span", { class: "btn-label", "data-i18n": labelKey }));
        if (onClick) btn.addEventListener("click", () => onClick(btn));
        if (opts.id) btn.id = opts.id;
        return btn;
    }

    /** Run an async action bound to a button: loading label swap (same width via CSS). */
    async function withLoading(btn, loadingKey, fn) {
        const label = btn.querySelector(".btn-label");
        const old = label ? label.getAttribute("data-i18n") : "";
        if (label && loadingKey) { label.setAttribute("data-i18n", loadingKey); label.textContent = t(loadingKey); }
        btn.classList.add("is-loading");
        btn.setAttribute("aria-busy", "true");
        try {
            const r = await fn();
            return r;
        } finally {
            btn.classList.remove("is-loading");
            btn.removeAttribute("aria-busy");
            if (label && loadingKey) { label.setAttribute("data-i18n", old); label.textContent = t(old); }
        }
    }

    function shake(el) {
        el.classList.remove("shake");
        void el.offsetWidth; // restart animation
        el.classList.add("shake");
    }

    function errorCard(err, { retry, showLog } = {}) {
        const card = h("div", { class: "wz-errorcard", role: "alert" },
            h("div", { class: "wz-errorcard-head" }, iconEl("cross"),
                h("strong", null, err.code ? `${err.code}` : t("misc.backend_error")),
                h("span", { class: "wz-errorcard-msg" }, err.message || err.message_en || "")),
        );
        if (err.hint) card.appendChild(h("p", { class: "wz-errorcard-hint" }, `→ ${err.hint}`));
        const actions = h("div", { class: "wz-errorcard-actions" });
        if (showLog) actions.appendChild(secondaryBtn("w3.log", () => showLog()));
        if (retry) actions.appendChild(secondaryBtn("common.retry", () => retry()));
        if (actions.children.length) card.appendChild(actions);
        return card;
    }

    function failShakeAndToast(target, e) {
        shake(target);
        ctx.toast(e instanceof ApiError ? e.message : t("misc.unknown_error"), "error");
    }

    // ── W1 · Welcome ──────────────────────────────────────────────────────
    function renderW1() {
        const wrap = h("div", { class: "wz-step wz-w1" });
        const left = h("div", { class: "w1-left" },
            h("h1", { class: "w1-title", "data-i18n": "wizard.title" }),
            h("p", { class: "w1-sub", "data-i18n": "w1.sub" }),
        );
        const right = h("div", { class: "w1-right" });
        // three-step preview — editorial numbered list (not cards)
        for (const n of [1, 2, 3]) {
            right.appendChild(h("div", { class: "w1-preview-row" },
                h("span", { class: "w1-preview-num" }, String(n)),
                h("span", { class: "w1-preview-body" },
                    h("strong", { "data-i18n": `w1.preview${n}` }),
                    h("span", { "data-i18n": `w1.preview${n}.sub` })),
            ));
        }

        // Achievement warning — BEFORE any primary button, per §3.5 W1.
        const warnCard = h("div", { class: "w1-achievement", role: "note" },
            h("div", { class: "w1-achievement-head" },
                iconEl("warn"),
                h("strong", { "data-i18n": "w1.achievement.title" })),
            h("p", { "data-i18n": "w1.achievement.body" }),
        );
        const filesId = uid("files");
        const filesBtn = h("button", { class: "btn btn-ghost btn-sm", type: "button", "aria-expanded": "false", "aria-controls": filesId },
            h("span", { "data-i18n": "w1.achievement.files" }),
        );
        const files = h("ul", { class: "w1-files", id: filesId, hidden: true },
            h("li", { class: "mono", "data-i18n": "w1.achievement.files.mod" }),
            h("li", { class: "mono", "data-i18n": "w1.achievement.files.config" }),
            h("li", { class: "mono", "data-i18n": "w1.achievement.files.state" }),
        );
        filesBtn.addEventListener("click", () => {
            files.hidden = !files.hidden;
            filesBtn.setAttribute("aria-expanded", String(!files.hidden));
        });
        warnCard.append(filesBtn, files);

        const actions = h("div", { class: "w1-actions" },
            primaryBtn("common.start", () => go(1), { id: "w1-start" }),
            secondaryBtn("common.details", () => { warnCard.scrollIntoView({ block: "nearest" }); warnCard.classList.add("w1-achievement-flash"); setTimeout(() => warnCard.classList.remove("w1-achievement-flash"), 1700); }),
        );
        left.append(warnCard, actions);
        wrap.append(left, right);
        return wrap;
    }

    // ── W2 · Environment check ────────────────────────────────────────────
    const CHECKS = [
        { id: "node", key: "w2.check.node" },
        { id: "game", key: "w2.check.game" },
        { id: "mods", key: "w2.check.mods" },
        { id: "mod", key: "w2.check.mod" },
        { id: "port", key: "w2.check.port" },
        { id: "browser", key: "w2.check.browser" },
    ];
    const ROW_STATE = { pending: "pending", running: "running", pass: "pass", fail: "fail" };

    function envChecks(env) {
        if (!env) return Object.fromEntries(CHECKS.map((c) => [c.id, { state: "pending" }]));
        const modsOk = env.mods_dir.exists && env.mods_dir.writable;
        return {
            node: env.node.ok
                ? { state: "pass", detail: `${env.node.version}` }
                : { state: "fail", detail: t("w2.hint.node") },
            game: env.game.found
                ? { state: "pass", detail: env.game.dir }
                : { state: "fail", detail: t("w2.hint.game"), soft: true },
            mods: modsOk
                ? { state: "pass", detail: env.mods_dir.path }
                : { state: "fail", detail: t("w2.hint.mods") },
            // mod presence is not required at this stage — orange, not red
            mod: env.mod.installed
                ? { state: "pass", detail: env.mod.path || "" }
                : { state: "pending", detail: t("w2.hint.mod") },
            port: env.port.busy
                ? { state: "fail", detail: t("w2.hint.port", { port: env.port.configured, pid: env.port.owner_pid ?? "?" }) }
                : { state: "pass", detail: `127.0.0.1:${env.port.configured}` },
            browser: env.browser.found
                ? { state: "pass", detail: `${env.browser.kind}` }
                : { state: "pending", detail: t("w2.hint.browser") },
        };
    }

    function renderW2() {
        const wrap = h("div", { class: "wz-step" });
        wrap.append(
            h("h2", { class: "wz-h", "data-i18n": "w2.title" }),
            h("p", { class: "wz-sub", "data-i18n": "w2.sub" }),
        );
        const table = h("div", { class: "w2-table", role: "table" });
        const rowEls = {};
        for (const c of CHECKS) {
            const row = h("div", { class: "w2-row", role: "row" },
                h("span", { class: "w2-ico" }, iconEl("dot")),
                h("span", { class: "w2-label", "data-i18n": c.key }),
                h("span", { class: "w2-detail mono" }),
                h("span", { class: "w2-action" }),
            );
            rowEls[c.id] = row;
            table.appendChild(row);
        }
        wrap.appendChild(table);

        const manualBox = h("div", { class: "w2-manual", hidden: true });
        const manualInput = h("input", { class: "input", type: "text", "data-i18n-placeholder": "w2.game_dir.placeholder", spellcheck: "false", id: uid("gamedir") });
        const manualErr = h("p", { class: "field-msg", hidden: true });
        const applyBtn = secondaryBtn("w2.game_dir.apply", async (btn) => {
            manualErr.hidden = true;
            await withLoading(btn, "common.loading", async () => {
                try {
                    S.env = await api.envReprobe({ game_dir: manualInput.value.trim() });
                    renderPanel();
                } catch (e) {
                    manualErr.textContent = e.hint || e.message;
                    manualErr.hidden = false;
                    manualInput.setAttribute("aria-invalid", "true");
                    manualInput.setAttribute("aria-describedby", manualErr.id || (manualErr.id = uid("gd-msg")));
                }
            });
        });
        manualBox.append(
            h("label", { class: "field-label", for: manualInput.id, "data-i18n": "w2.action.manual" }),
            h("div", { class: "w2-manual-row" }, manualInput, applyBtn),
            manualErr,
        );

        const actions = h("div", { class: "wz-actions" });
        const recheckBtn = secondaryBtn("w2.action.recheck", (btn) => withLoading(btn, "common.loading", () => loadEnv(true)));
        const nextBtn = primaryBtn("common.next", () => go(2));
        nextBtn.disabled = !(S.env && S.env.node.ok);
        recheckBtn.id = "w2-recheck";
        actions.append(recheckBtn, nextBtn);
        wrap.append(manualBox, actions);

        function paint() {
            const checks = envChecks(S.env);
            for (const [id, row] of Object.entries(rowEls)) {
                const c = checks[id] || { state: "pending" };
                row.classList.remove("is-pending", "is-running", "is-pass", "is-fail");
                row.classList.add(`is-${c.state}`);
                row.querySelector(".w2-ico").innerHTML = c.state === "running" ? icons.spinner()
                    : c.state === "pass" ? icons.check()
                    : c.state === "fail" ? icons.cross()
                    : icons.dot();
                row.querySelector(".w2-detail").textContent = c.detail || "";
                const act = row.querySelector(".w2-action");
                act.textContent = "";
                if (id === "game" && c.state === "fail") {
                    act.append(
                        secondaryBtn("w2.action.steam", () => api.openTarget("steam_store").catch((e) => failShakeAndToast(act, e))),
                        h("button", { class: "btn btn-ghost btn-sm", type: "button", "data-i18n": "w2.action.manual", onclick: () => { manualBox.hidden = false; manualInput.focus(); } }),
                    );
                }
                if (id === "port" && c.state === "fail") {
                    act.append(secondaryBtn("common.details", () => go(3)));
                }
                if (id === "mods" && c.state === "fail") {
                    act.append(secondaryBtn("w2.action.details", () => ctx.toast(t("w2.hint.mods"), "warn")));
                }
            }
            nextBtn.disabled = !(S.env && S.env.node.ok);
            if (window.GUI && window.GUI.applyI18n) window.GUI.applyI18n(wrap);
        }

        if (!S.env) {
            loadEnv(false).then(() => { paint(); renderBanner(); });
        }
        paint();
        return wrap;
    }

    async function loadEnv(force) {
        if (S.envLoading) return;
        S.envLoading = true;
        try {
            S.env = force ? await api.envReprobe({}) : await api.env();
        } catch (e) {
            ctx.toast(e.message, "error");
        } finally {
            S.envLoading = false;
        }
    }

    // ── W3 · Install ──────────────────────────────────────────────────────
    function renderW3() {
        const wrap = h("div", { class: "wz-step" });
        wrap.append(
            h("h2", { class: "wz-h", "data-i18n": "w3.title" }),
            h("p", { class: "wz-sub", "data-i18n": "w3.sub" }),
        );

        // achievement warning persists on this step (§3.5 W3)
        wrap.appendChild(h("div", { class: "w1-achievement is-compact", role: "note" },
            h("div", { class: "w1-achievement-head" }, iconEl("warn"),
                h("strong", { "data-i18n": "w1.achievement.title" })),
        ));

        if (S.env && S.env.game.running) {
            wrap.appendChild(h("p", { class: "wz-note", "data-i18n": "w3.restart_note" }));
        }
        if (S.env && !S.env.repo.mod_source_exists) {
            wrap.appendChild(h("div", { class: "wz-errorcard", role: "alert" }, iconEl("cross"), h("span", { "data-i18n": "w3.no_source" })));
        }

        const logBox = h("div", { class: "w3-logbox", hidden: true });
        const statusSlot = h("div", { class: "w3-status" });
        const actions = h("div", { class: "wz-actions" });

        const installBtn = primaryBtn("w3.install", (btn) => doInstall(btn));
        installBtn.id = "w3-install";
        if (S.env && !S.env.repo.mod_source_exists) installBtn.disabled = true;
        actions.appendChild(installBtn);

        const uninstallBtn = secondaryBtn("w3.uninstall", async () => {
            const ok = await ctx.confirm({ bodyKey: "confirm.uninstall.body", danger: true });
            if (!ok) return;
            try {
                await api.uninstall({ clean_backups: true });
                S.install = null;
                if (S.env) { S.env.mod.installed = false; S.env.mod.match = false; }
                ctx.toast(t("w3.uninstall"), "success");
                paint();
            } catch (e) { failShakeAndToast(actions, e); }
        });
        uninstallBtn.classList.add("w3-uninstall");
        uninstallBtn.hidden = true;

        function setBtnLabel(btn, key) {
            const label = btn.querySelector(".btn-label");
            if (!label) return;
            label.setAttribute("data-i18n", key);
            label.textContent = t(key);
        }

        function paint() {
            statusSlot.textContent = "";
            actions.hidden = false;
            const st = S.install || { status: "idle" };
            uninstallBtn.hidden = !(st.status === "done");
            installBtn.hidden = false;
            if (st.status === "running") {
                actions.hidden = true;
                logBox.hidden = false;
            } else if (st.status === "done") {
                const r = st.result;
                const card = h("div", { class: "w3-donecard", role: "status" },
                    h("div", { class: "w3-done-head" }, iconEl("check"), h("strong", { "data-i18n": "w3.done.title" })),
                    h("dl", { class: "w3-kv" },
                        h("dt", { "data-i18n": "w3.done.target" }), h("dd", { class: "mono" }, r.target || ""),
                        h("dt", { "data-i18n": "w3.done.sha" }), h("dd", { class: "mono" }, (r.sha256 || "").slice(0, 8) || "—"),
                        h("dt", { "data-i18n": "w3.done.backup" }), h("dd", { class: "mono" }, r.backup || t("w3.done.no_backup")),
                    ),
                    h("p", { class: "wz-note", "data-i18n": "w3.done.verify" }),
                );
                card.querySelector(".ico-host")?.classList.add("spring-pop");
                statusSlot.appendChild(card);
                installBtn.disabled = false;
                setBtnLabel(installBtn, "w3.reinstall");
            } else if (st.status === "fail") {
                const err = st.error;
                const card = errorCard(err, {
                    retry: () => { S.install = null; paint(); doInstall(installBtn); },
                    showLog: () => { logBox.hidden = false; }
                });
                card.appendChild(h("p", { class: "wz-note" },
                    h("strong", { "data-i18n": "w3.fail.reason" }), " ",
                    h("span", { "data-i18n": "w3.fail.reason.body" })));
                statusSlot.appendChild(card);
                shake(card);
                installBtn.disabled = false;
                setBtnLabel(installBtn, "w3.install");
            } else {
                setBtnLabel(installBtn, "w3.install");
            }
            if (window.GUI && window.GUI.applyI18n) window.GUI.applyI18n(statusSlot);
            const next = wrap.querySelector(".w3-next");
            if (next) next.disabled = !(S.install && S.install.status === "done");
        }

        async function doInstall(btn) {
            S.install = { status: "running" };
            logBox.hidden = false;
            logBox.textContent = "";
            installLogView = createLogView(logBox, { follow: true });
            paint();
            const unsub = api.events.on("log", (line) => {
                if (line.kind === "install" && installLogView) installLogView.append([line]);
            });
            try {
                const result = await withLoading(btn, "w3.installing", () => api.install({}));
                // pull any lines missed before SSE connected
                try {
                    const tail = await api.logsSince("install", 0);
                    if (installLogView && tail.lines.length) {
                        installLogView.clear();
                        installLogView.append(tail.lines);
                    }
                } catch { /* not fatal */ }
                S.install = { status: "done", result };
                if (S.env) { S.env.mod.installed = true; S.env.mod.match = true; }
                ctx.toast(t("w3.done.title"), "success");
            } catch (e) {
                S.install = { status: "fail", error: e };
                try {
                    const tail = await api.logsSince("install", 0);
                    if (installLogView && tail.lines.length) { installLogView.clear(); installLogView.append(tail.lines); }
                } catch { /* ignore */ }
            } finally {
                unsub();
                paint();
            }
        }

        const nextBtn = primaryBtn("common.continue", () => go(3));
        nextBtn.classList.add("w3-next");
        nextBtn.disabled = !(S.install && S.install.status === "done");
        actions.append(uninstallBtn, nextBtn);

        wrap.append(statusSlot, logBox, actions);
        paint();
        return wrap;
    }

    // ── W4 · Config ───────────────────────────────────────────────────────
    const FIELD_DEFS = [
        { name: "port", type: "number", key: "w4.port", hint: "w4.port.hint", validate: (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1024 && n <= 65535 ? null : "w4.port.invalid"; } },
        { name: "token", type: "text", key: "w4.token", hint: "w4.token.hint", optional: true, validate: (v) => (v === "" || /^[\x21-\x7e]{8,128}$/.test(v)) ? null : "w4.token.invalid" },
        { name: "snapshot_dir", type: "text", key: "w4.snapshot_dir", hint: "w4.snapshot_dir.hint", validate: (v) => (v && !v.includes("\0")) ? null : "w4.snapshot_dir.invalid" },
        { name: "log_level", type: "select", key: "w4.log_level", hint: "w4.log_level.hint", options: ["debug", "info", "warn"] },
    ];
    const ADV_FIELDS = [
        { name: "rpc_timeout_ms", type: "number", key: "w4.rpc_timeout", validate: (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1000 && n <= 600000 ? null : "w4.timeout.invalid"; } },
        { name: "long_timeout_ms", type: "number", key: "w4.long_timeout", validate: (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1000 && n <= 600000 ? null : "w4.timeout.invalid"; } },
    ];

    function renderW4() {
        const wrap = h("div", { class: "wz-step" });
        wrap.append(
            h("h2", { class: "wz-h", "data-i18n": "w4.title" }),
            h("p", { class: "wz-sub", "data-i18n": "w4.sub" }),
        );

        const form = h("form", { class: "w4-form", novalidate: true });
        const fieldEls = {};

        if (!S.config) {
            form.appendChild(h("p", { class: "wz-note", "data-i18n": "common.loading" }));
            wrap.appendChild(form);
            api.getConfig().then((cfg) => { S.config = cfg; renderPanel(); }).catch((e) => {
                form.textContent = "";
                form.appendChild(errorCard(e, { retry: () => renderPanel() }));
            });
            return wrap;
        }

        const cfg = S.config;
        for (const f of FIELD_DEFS) {
            fieldEls[f.name] = mkField(f, cfg.config[f.name] ?? "");
            form.appendChild(fieldEls[f.name].container);
        }
        for (const f of ADV_FIELDS) fieldEls[f.name] = mkField(f, cfg.config[f.name] ?? "");

        // read_only toggle — the whole row is one ≥44px button containing label + switch visual
        const roId = uid("ro");
        const sw = h("button", { type: "button", role: "switch", class: "switch", id: roId, "aria-checked": String(!!cfg.config.read_only), "aria-labelledby": roId + "-label" },
            h("span", { class: "switch-thumb" }));
        const ro = h("div", { class: "w4-toggle-row" },
            h("div", { class: "w4-toggle-text" },
                h("span", { class: "field-label", id: roId + "-label", "data-i18n": "w4.read_only" }),
                h("p", { class: "field-hint", "data-i18n": "w4.read_only.hint" })),
            sw,
        );
        sw.addEventListener("click", () => { sw.setAttribute("aria-checked", sw.getAttribute("aria-checked") === "true" ? "false" : "true"); });
        ro.querySelector(".w4-toggle-text").addEventListener("click", () => sw.click());
        form.appendChild(ro);

        const adv = h("details", { class: "w4-advanced" },
            h("summary", { "data-i18n": "w4.advanced" }),
        );
        for (const f of ADV_FIELDS) adv.appendChild(fieldEls[f.name].container);
        form.appendChild(adv);

        const fileNote = h("p", { class: "wz-note mono" });
        fileNote.textContent = t("w4.file_status", { path: cfg.file.path });
        if (!cfg.file.exists) fileNote.textContent += t("w4.file_missing");
        form.appendChild(fileNote);
        for (const w of cfg.warnings || []) form.appendChild(h("p", { class: "wz-note warn" }, w));

        const actions = h("div", { class: "wz-actions" });
        const saveBtn = primaryBtn("w4.save", (btn) => doSave(btn));
        saveBtn.id = "w4-save";
        const defaultsBtn = secondaryBtn("w4.use_defaults", async () => {
            const ok = await ctx.confirm({ bodyKey: "confirm.reset.body", danger: true });
            if (!ok) return;
            try {
                const r = await api.resetConfig();
                S.config = { ...S.config, config: r.config, file: { ...S.config.file, exists: true } };
                renderPanel();
                ctx.toast(t("w4.saved"), "success");
            } catch (e) { failShakeAndToast(actions, e); }
        });
        actions.append(saveBtn, defaultsBtn);
        form.appendChild(actions);

        async function doSave(btn) {
            S.configErrors = {};
            let bad = false;
            const out = {};
            for (const f of [...FIELD_DEFS, ...ADV_FIELDS]) {
                const fe = fieldEls[f.name];
                const v = f.type === "select" ? fe.input.value : fe.input.value.trim();
                const errKey = f.validate ? f.validate(v) : null;
                setFieldError(fe, errKey);
                if (errKey) bad = true;
                out[f.name] = f.type === "number" ? Number(v) : v;
            }
            out.read_only = sw.getAttribute("aria-checked") === "true";
            out.token = out.token === "" ? null : out.token;
            if (bad) { shake(form); form.querySelector('[aria-invalid="true"]')?.focus(); return; }
            await withLoading(btn, "w4.saving", async () => {
                try {
                    const r = await api.saveConfig(out);
                    S.config = { ...S.config, config: r.config, file: { ...S.config.file, exists: true } };
                    ctx.toast(r.bridge_restarted ? t("w4.saved") + " · bridge restarted" : t("w4.saved"), "success");
                    if (S.bridgeStatus?.running) S.bridgeStatus = await api.bridgeStatus().catch(() => S.bridgeStatus);
                    go(4); // "Save & continue" — advance to W5
                } catch (e) {
                    shake(saveBtn);
                    if (e.detail && e.detail.fields) {
                        for (const [name, msg] of Object.entries(e.detail.fields)) {
                            const fe = fieldEls[name];
                            if (fe) setFieldError(fe, null, msg);
                        }
                    }
                    if (e.code === "PORT_BUSY") {
                        const card = errorCard(e, { retry: () => doSave(saveBtn) });
                        const suggestBtn = secondaryBtn("w4.port_busy.suggest", () => {
                            const cur = Number(fieldEls.port.input.value) || 7777;
                            fieldEls.port.input.value = String(cur + 1);
                            setFieldError(fieldEls.port, null);
                        });
                        suggestBtn.querySelector(".btn-label").textContent = t("w4.port_busy.suggest", { port: (Number(fieldEls.port.input.value) || 7777) + 1 });
                        card.querySelector(".wz-errorcard-actions")?.prepend(suggestBtn);
                        form.insertBefore(card, actions);
                        shake(card);
                    } else {
                        ctx.toast(e.message, "error");
                    }
                }
            });
        }

        function mkField(f, value) {
            const id = uid(f.name);
            const msgId = uid(f.name + "-msg");
            const hintId = uid(f.name + "-hint");
            const container = h("div", { class: "field" });
            container.appendChild(h("label", { class: "field-label", for: id },
                h("span", { "data-i18n": f.key }),
                f.optional ? h("span", { class: "field-optional", "data-i18n": "common.optional" }) : null));
            let input;
            if (f.type === "select") {
                input = h("select", { class: "input", id });
                for (const o of f.options) input.appendChild(h("option", { value: o }, o));
                input.value = value;
            } else {
                input = h("input", { class: "input", type: f.type, id, spellcheck: "false", value: String(value ?? ""), "aria-describedby": hintId });
            }
            container.appendChild(input);
            if (f.hint) container.appendChild(h("p", { class: "field-hint", id: hintId, "data-i18n": f.hint }));
            const msg = h("p", { class: "field-msg", id: msgId, hidden: true, role: "alert" });
            container.appendChild(msg);
            return { container, input, msg, msgId };
        }

        function setFieldError(fe, errKey, literal) {
            const text = errKey ? t(errKey) : literal;
            if (text) {
                fe.msg.textContent = text;
                fe.msg.hidden = false;
                fe.input.setAttribute("aria-invalid", "true");
                fe.input.setAttribute("aria-describedby", fe.msgId);
                fe.container.classList.add("has-error");
            } else {
                fe.msg.hidden = true;
                fe.input.removeAttribute("aria-invalid");
                fe.container.classList.remove("has-error");
            }
        }

        wrap.appendChild(form);
        return wrap;
    }

    // ── W5 · Launch ───────────────────────────────────────────────────────
    function renderW5() {
        const wrap = h("div", { class: "wz-step" });
        wrap.append(
            h("h2", { class: "wz-h", "data-i18n": "w5.title" }),
            h("p", { class: "wz-sub", "data-i18n": "w5.sub" }),
        );

        const statusSlot = h("div", { class: "w5-status" });
        const noteSlot = h("div", { class: "w5-notes" });
        const logBox = h("div", { class: "w3-logbox", hidden: true });
        const actions = h("div", { class: "wz-actions" });

        const startBtn = primaryBtn("w5.start", (btn) => doStart(btn));
        startBtn.id = "w5-start";
        const gameBtn = secondaryBtn("w5.launch_game", () => api.openTarget("steam_run").catch((e) => failShakeAndToast(actions, e)));
        gameBtn.id = "w5-launch-game";
        actions.append(startBtn, gameBtn);

        async function doStart(btn) {
            S.bridgeError = null;
            S.bridgeStarting = true;
            logBox.hidden = false;
            logBox.textContent = "";
            w5LogView = createLogView(logBox, { follow: true });
            const unsub = api.events.on("log", (line) => { if (line.kind === "bridge" && w5LogView) w5LogView.append([line]); });
            try {
                await withLoading(btn, "w5.starting", () => api.bridgeStart());
                S.bridgeStatus = await api.bridgeStatus().catch(() => null);
                const tail = await api.logsSince("bridge", 0).catch(() => ({ lines: [] }));
                if (w5LogView && tail.lines.length) { w5LogView.clear(); w5LogView.append(tail.lines); }
            } catch (e) {
                S.bridgeError = e;
                logBox.hidden = false;
                const tail = await api.logsSince("bridge", 0).catch(() => ({ lines: [] }));
                if (w5LogView && tail.lines.length) { w5LogView.clear(); w5LogView.append(tail.lines); }
            } finally {
                S.bridgeStarting = false;
                unsub();
                paint();
            }
        }

        async function doStop() {
            try {
                await api.bridgeStop();
                S.bridgeStatus = await api.bridgeStatus().catch(() => null);
            } catch (e) {
                failShakeAndToast(actions, e);
            }
            paint();
        }

        function paint() {
            statusSlot.textContent = "";
            noteSlot.textContent = "";
            const st = S.bridgeStatus;
            const running = !!(st && st.running);

            if (running) {
                const up = st.uptime_s ?? 0;
                statusSlot.appendChild(h("div", { class: "w5-runbadge spring-pop", role: "status" },
                    iconEl("check"),
                    h("span", null, t("w5.running", { uptime: up, port: st.port })),
                    st.managed === false ? h("span", { class: "pill pill-warn" }, "external") : null,
                ));
                startBtn.hidden = true;
                let stopBtn = actions.querySelector(".w5-stop");
                if (!stopBtn) {
                    stopBtn = secondaryBtn("w5.stop", doStop);
                    stopBtn.classList.add("w5-stop");
                    actions.prepend(stopBtn);
                }
            } else {
                startBtn.hidden = false;
                actions.querySelector(".w5-stop")?.remove();
                if (S.bridgeError) {
                    const e = S.bridgeError;
                    const card = errorCard(e, {
                        retry: () => doStart(startBtn),
                        showLog: () => { logBox.hidden = false; },
                    });
                    if (e.code === "PORT_BUSY") {
                        card.appendChild(h("p", { class: "wz-note" }, e.hint || ""));
                        card.appendChild(secondaryBtn("w5.port_busy_change", () => go(3)));
                    }
                    statusSlot.appendChild(card);
                    shake(card);
                }
            }

            // waiting-for-game persistent note
            if (running) {
                const connected = !!st.mod_connected;
                noteSlot.appendChild(h("div", { class: `w5-waitnote ${connected ? "is-ok" : ""}` },
                    iconEl(connected ? "check" : "spinner"),
                    h("span", null, connected ? t("topbar.status.connected") : t("w5.waiting_game")),
                ));
                if (S.env && S.env.game.running) {
                    noteSlot.appendChild(h("p", { class: "wz-note warn", "data-i18n": "w5.game_running_restart" }));
                }
                if (S.env && !S.env.game.found) {
                    noteSlot.appendChild(h("p", { class: "wz-note warn", "data-i18n": "w5.no_game_dir" }));
                }
            }

            const nextBtn = wrap.querySelector(".w5-next");
            if (nextBtn) nextBtn.disabled = !running;
            if (window.GUI && window.GUI.applyI18n) window.GUI.applyI18n(wrap);
        }

        const nextBtn = primaryBtn("common.continue", () => go(5));
        nextBtn.classList.add("w5-next");
        actions.appendChild(nextBtn);

        // live subscription for this step (replaced on each W5 render, released on leave)
        S.bridgeUnsub?.();
        S.bridgeUnsub = api.events.on("bridge_status", (s) => { S.bridgeStatus = s; paint(); });
        // initial status fetch
        api.bridgeStatus().then((s) => { S.bridgeStatus = s; paint(); }).catch(() => paint());

        wrap.append(statusSlot, noteSlot, logBox, actions);
        paint();
        return wrap;
    }

    // ── W6 · Verify ───────────────────────────────────────────────────────
    function renderW6() {
        const wrap = h("div", { class: "wz-step" });
        wrap.append(
            h("h2", { class: "wz-h", "data-i18n": "w6.title" }),
            h("p", { class: "wz-sub", "data-i18n": "w6.sub" }),
        );

        const list = h("div", { class: "w6-checks", role: "list" });
        const rawBox = h("div", { class: "w6-raw", hidden: true });
        const hintSlot = h("div", { class: "w6-hint" });
        const actions = h("div", { class: "wz-actions" });

        const runBtn = primaryBtn("w6.run", (btn) => doRun(btn));
        runBtn.id = "w6-run";
        const skipBtn = secondaryBtn("common.skip", () => finish());
        const expandBtn = secondaryBtn("w6.expand_raw", () => { rawBox.hidden = !rawBox.hidden; });
        expandBtn.hidden = true;
        const copyBtn = secondaryBtn("w6.copy_report", async () => {
            const text = JSON.stringify(S.smokeRaw, null, 2);
            try { await navigator.clipboard.writeText(text); ctx.toast(t("toast.copied"), "success"); }
            catch { ctx.toast(t("toast.copy_failed"), "warn"); }
        });
        copyBtn.hidden = true;
        actions.append(runBtn, skipBtn, expandBtn, copyBtn);

        let checkRowEls = [];

        /** Find the run poller; restarted whenever a smoke run starts. */
        let smokePoll = null;
        function startPolling() {
            if (smokePoll) return;
            smokePoll = setInterval(async () => {
                try {
                    const st = await api.smokeStatus();
                    S.smoke = st;
                    S.smokeRaw = st;
                    paintChecks();
                    if (!st.running) { clearInterval(smokePoll); smokePoll = null; }
                } catch { clearInterval(smokePoll); smokePoll = null; }
            }, 700);
        }

        function paintChecks() {
            list.textContent = "";
            checkRowEls = [];
            const checks = S.smoke ? S.smoke.checks : [];
            for (const c of checks) {
                const row = h("div", { class: `w6-row is-${c.state}`, role: "listitem" },
                    h("span", { class: "w2-ico" }),
                    h("span", { class: "w6-name" }, c.name_zh || c.name),
                    h("span", { class: "w6-detail mono" }, c.detail || ""),
                );
                row.querySelector(".w2-ico").innerHTML =
                    c.state === "pass" ? icons.check()
                    : c.state === "fail" ? icons.cross()
                    : c.state === "running" ? icons.spinner()
                    : icons.dot();
                if (c.state === "pass") row.querySelector(".ico-host")?.classList.add("spring-pop");
                list.appendChild(row);
                checkRowEls.push(row);
            }
            if (!checks.length) {
                for (let i = 1; i <= 5; i++) {
                    list.appendChild(h("div", { class: "w6-row is-pending", role: "listitem" },
                        h("span", { class: "w2-ico" }, iconEl("dot")),
                        h("span", { class: "w6-name" }, `#${i}`),
                        h("span", { class: "w6-detail mono" })));
                }
            }
            // outcome
            hintSlot.textContent = "";
            const st = S.smoke;
            if (st && !st.running && st.finished_at != null) {
                if (st.exit_code === 0) {
                    const done = h("div", { class: "w6-success spring-pop", role: "status" },
                        iconEl("check"),
                        h("span", { "data-i18n": "w6.success" }),
                        primaryBtn("w6.to_console", () => finish(), { id: "w6-to-console" }),
                    );
                    hintSlot.appendChild(done);
                    runBtn.hidden = true;
                    skipBtn.hidden = true;
                } else if (st.exit_code === 1) {
                    hintSlot.appendChild(h("div", { class: "w6-hintline", role: "alert" },
                        iconEl("warn"), h("span", { "data-i18n": "w6.fail_bridge" }),
                        secondaryBtn("w5.start", () => go(4))));
                } else if (st.exit_code === 2) {
                    hintSlot.appendChild(h("div", { class: "w6-hintline", role: "alert" },
                        iconEl("warn"), h("span", { "data-i18n": "w6.fail_game" }),
                        secondaryBtn("w5.launch_game", () => api.openTarget("steam_run").catch(() => {}))));
                } else {
                    hintSlot.appendChild(h("div", { class: "w6-hintline", role: "alert" },
                        iconEl("warn"), h("span", { "data-i18n": "w6.fail_other" })));
                }
                if (st.exit_code !== 0) {
                    runBtn.hidden = false;
                    runBtn.querySelector(".btn-label").setAttribute("data-i18n", "w6.rerun");
                }
                expandBtn.hidden = st.exit_code === 0;
                copyBtn.hidden = st.exit_code === 0;
            }
            rawBox.textContent = S.smokeRaw ? JSON.stringify(S.smokeRaw, null, 2) : "";
            if (window.GUI && window.GUI.applyI18n) window.GUI.applyI18n(wrap);
        }

        async function doRun(btn) {
            try {
                await withLoading(btn, "w6.running", async () => {
                    const r = await api.smokeStart({ autoplay: false });
                    S.smokeRaw = r;
                    startPolling();
                });
            } catch (e) {
                failShakeAndToast(actions, e);
            }
        }

        unsubSmoke?.();
        unsubSmoke = api.events.on("smoke_status", (st) => {
            S.smoke = st;
            S.smokeRaw = st;
            paintChecks();
        });
        if (S.smoke && S.smoke.running) startPolling();

        wrap.append(list, hintSlot, rawBox, actions);
        paintChecks();
        return wrap;
    }

    function finish() {
        wizardDone = true;
        ctx.toast(t("wizard.continue_to_console"), "success");
        goto("console");
        window.GUI?.onWizardComplete?.();
    }

    // ── initial render ───────────────────────────────────────────────────
    renderRail();
    renderPanel();

    // re-render labels on language switch
    const unsubLang = onLangChange(() => { renderPanel(); });

    // cleanup: the wizard lives for the whole session; release by returning a teardown
    return function teardown() {
        unsubLang();
        S.bridgeUnsub?.();
        unsubSmoke?.();
    };
}

export default mountWizard;
