/**
 * settings.js — 设置视图（T4 独占；DESIGN-PLAN §3.6/§3.5 W4）
 *
 * 挂载点：#settings-root → export mountSettings(el)
 * 契约：api.getConfig/saveConfig/resetConfig/uninstall/env，window.GUI.confirm/toast。
 * 缺依赖时同 console.js：try/catch 动态 import + 内置 stub，保证可渲染。
 *
 * 形制：窄列表单（与 console 全宽形成差异）+ 折叠 timeouts + ⑤ 危险区带
 * （左竖线 inset 警示带，非卡片）。
 */

let depsPromise = null;
async function loadDeps() {
    if (depsPromise) return depsPromise;
    depsPromise = (async () => {
        const deps = { api: null, t: (k) => k, toast: () => {}, confirm: null };
        try { const m = await import("./api.js"); deps.api = m.api || m.default; } catch { /* stub */ }
        try { const m = await import("./i18n.js"); if (typeof m.t === "function") deps.t = m.t; } catch { /* passthrough */ }
        const G = (typeof window !== "undefined" && window.GUI) || null;
        if (G && typeof G.toast === "function") deps.toast = G.toast;
        else deps.toast = (msg, level) => console.warn(`[toast:${level || "info"}]`, msg);
        if (G && typeof G.confirm === "function") deps.confirm = G.confirm;

        if (!deps.api) deps.api = SETTINGS_STUB;
        return deps;
    })();
    return depsPromise;
}

/* ── 内置 stub（api.js 缺失时的独立开发兜底） ── */

const DEFAULT_CONFIG = {
    port: 7777, token: null, read_only: false, snapshot_dir: "./snapshots",
    log_level: "info", rpc_timeout_ms: 30000, long_timeout_ms: 180000,
};

const SETTINGS_STUB = {
    async getConfig() {
        return {
            config: { ...DEFAULT_CONFIG },
            defaults: { ...DEFAULT_CONFIG },
            file: { path: "D:\\shapez-ai-bridge\\bridge.config.json", exists: false, valid: true },
            warnings: [],
        };
    },
    async saveConfig(cfg) { return { ok: true, config: { ...cfg }, bridge_restarted: false }; },
    async resetConfig() { return { ok: true, config: { ...DEFAULT_CONFIG } }; },
    async uninstall() { return { ok: true, removed: ["C:\\…\\mods\\shapez-ai-bridge.js"], kept_modsettings: true, notes: ["游戏内 mod 设置残留于 saves 目录"] }; },
    async env() {
        return { mod: { installed: true, path: "C:\\Users\\you\\AppData\\Roaming\\shapez.io\\mods\\shapez-ai-bridge.js", sha256_repo: "a1b2c3…", sha256_installed: "a1b2c3…", match: true, backup_count: 2 }, mods_dir: { path: "C:\\Users\\you\\AppData\\Roaming\\shapez.io\\mods", exists: true, writable: true } };
    },
};

/* ── 小工具（与 console.js 独立，避免跨文件耦合） ── */

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

function shake(el) {
    el.classList.remove("con-shake");
    void el.offsetWidth;
    el.classList.add("con-shake");
    setTimeout(() => el.classList.remove("con-shake"), 350);
}

/* ── 前端预校验（与后端 §2.3 同规则；后端仍会独立校验） ── */

export const validators = {
    port(v) {
        if (!/^\d+$/.test(String(v).trim())) return "端口必须是 1024–65535 的整数";
        const n = Number(v);
        if (n < 1024 || n > 65535) return "端口必须是 1024–65535 的整数";
        return null;
    },
    token(v) {
        const s = String(v ?? "");
        if (s === "") return null; // 空 = 不启用
        if (s.length < 8 || s.length > 128) return "令牌需为 8–128 个可见 ASCII 字符，或留空";
        if (!/^[\x21-\x7e]+$/.test(s)) return "令牌需为 8–128 个可见 ASCII 字符（不允许空格/中文），或留空";
        return null;
    },
    snapshot_dir(v) {
        const s = String(v ?? "");
        if (!s.trim()) return "快照目录不能为空";
        if (s.includes("\0")) return "快照目录包含非法字符";
        return null;
    },
    log_level(v) {
        if (!["debug", "info", "warn"].includes(String(v))) return "日志级别必须是 debug / info / warn";
        return null;
    },
    rpc_timeout_ms(v) { return validators._timeout(v); },
    long_timeout_ms(v) { return validators._timeout(v); },
    _timeout(v) {
        if (!/^\d+$/.test(String(v).trim())) return "必须是 1000–600000 的整数";
        const n = Number(v);
        if (n < 1000 || n > 600000) return "必须是 1000–600000 的整数";
        return null;
    },
};

/* ═══════════════════════════ mountSettings ═══════════════════════════ */

export function mountSettings(rootEl) {
    let disposed = false;
    const depsP = loadDeps();
    const S = {
        cfg: null,        // {config, defaults, file, warnings}
        env: null,
        dirty: false,
    };

    rootEl.textContent = "";
    const main = h("div", { class: "set-main" });
    rootEl.appendChild(main);

    /* ── 头（与 console hero 不同的形制：标题 + 动作，窄列） ── */
    const headActions = h("div", { class: "set-head-actions" });
    const main2 = h("div", { class: "set-head" },
        h("div", {},
            h("h2", { text: "设置" }),
            h("p", { class: "set-sub", text: "桥接配置写在仓库根 bridge.config.json；保存后桥接在跑且端口/令牌变化时会自动重启。" })),
        headActions);
    main.appendChild(main2);

    /* ── 表单区 ── */
    const formSection = h("div", { class: "set-section" });
    formSection.appendChild(h("div", { class: "set-section-title", text: "桥接配置" }));
    const grid = h("div", { class: "set-grid" });
    formSection.appendChild(grid);
    main.appendChild(formSection);

    const fields = {}; // name -> {wrap, input, err, hint, validator, get, set}

    function mkField(name, label, hint, opts = {}) {
        const id = `set-f-${name}`;
        const input = opts.select
            ? h("select", { id, class: "input" })
            : h("input", { id, class: "input" + (opts.mono ? " mono" : ""), type: "text", autocomplete: "off", spellcheck: "false" });
        if (opts.select) for (const o of opts.select) input.appendChild(h("option", { value: o, text: o }));
        const err = h("div", { class: "set-error", id: id + "-err" });
        const wrap = h("div", { class: "set-field" },
            input,
            hint ? h("div", { class: "set-hint", text: hint }) : null,
            err);
        input.setAttribute("aria-describedby", id + "-err");
        const lbl = h("label", { class: "set-label", for: id },
            label,
            h("span", { class: "set-default", text: opts.defaultLabel || "" }));
        grid.append(lbl, wrap);
        const f = { wrap, input, err, validator: opts.validator || null, name };
        input.addEventListener("input", () => {
            S.dirty = true;
            validateField(f);
            syncDirtyUI();
        });
        input.addEventListener("change", () => { if (opts.select) { S.dirty = true; validateField(f); syncDirtyUI(); } });
        fields[name] = f;
        return f;
    }

    function validateField(f) {
        if (!f.validator) return true;
        const msg = f.validator(f.input.value);
        const bad = !!msg;
        f.wrap.classList.toggle("has-error", bad);
        f.input.setAttribute("aria-invalid", String(bad));
        f.err.textContent = msg || "";
        return !bad;
    }

    mkField("port", "桥接端口", "AI 与游戏通信的本地端口，仅监听 127.0.0.1", { validator: validators.port, defaultLabel: "" });
    mkField("token", "访问令牌（高级）", "留空 = 不启用鉴权；≥16 位更安全", { validator: validators.token, mono: true });
    mkField("snapshot_dir", "快照目录", "相对仓库根或绝对路径；AI 快照保存在此", { validator: validators.snapshot_dir, mono: true });
    mkField("log_level", "日志级别", "桥接输出详细程度", { select: ["debug", "info", "warn"], validator: validators.log_level });

    /* read_only —— 整行 role="switch"（复用 base.css .switch；≥44px） */
    {
        const swLabel = h("div", { class: "set-switch-text", id: "set-f-read_only-label" },
            h("strong", { text: "只读模式" }),
            h("span", { text: "开启后 AI 只能读取工厂状态，不能放置/删除建筑" }));
        const sw = h("button", { class: "switch", type: "button", role: "switch", "aria-checked": "false", id: "set-f-read_only", "aria-labelledby": "set-f-read_only-label" },
            h("span", { class: "switch-thumb" }));
        sw.addEventListener("click", () => {
            sw.setAttribute("aria-checked", String(sw.getAttribute("aria-checked") !== "true"));
            S.dirty = true; syncDirtyUI();
        });
        const row = h("div", { class: "set-switch-row" }, swLabel, sw);
        swLabel.addEventListener("click", () => sw.click());
        const lbl = h("div", { class: "set-label" });
        grid.append(lbl, row);
        fields.read_only = { wrap: row, input: sw, err: null, validator: null, name: "read_only", isSwitch: true };
    }

    /* 折叠的 timeouts */
    {
        const body = h("div", { class: "set-details-body" });
        const details = h("details", { class: "set-details" },
            h("summary", {}, "高级超时设置", h("span", { class: "set-default", text: "一般无需改动" })),
            body);
        grid.append(h("div", {}), details);
        // 在 details body 内部再建两个字段
        const mkInner = (name, label, hint) => {
            const id = `set-f-${name}`;
            const input = h("input", { id, class: "input mono", type: "text", autocomplete: "off", spellcheck: "false" });
            const err = h("div", { class: "set-error", id: id + "-err" });
            const wrap = h("div", { class: "set-field" }, input, h("div", { class: "set-hint", text: hint }), err);
            body.append(h("label", { class: "set-label", for: id }, label), wrap);
            const f = { wrap, input, err, validator: validators._timeout, name };
            input.addEventListener("input", () => { S.dirty = true; validateField(f); syncDirtyUI(); });
            fields[name] = f;
        };
        mkInner("rpc_timeout_ms", "RPC 超时 (ms)", "普通请求（observe/act 等）的等待上限");
        mkInner("long_timeout_ms", "长操作超时 (ms)", "冒烟/批量等长操作的等待上限");
    }

    /* 表单动作 + 文件位置提示 + warnings */
    const fileLine = h("div", { class: "set-fileline" });
    const warnBox = h("div", { class: "set-warnbox", hidden: true });
    const saveBtn = h("button", { class: "con-btn is-primary", type: "button", text: "保存" });
    const resetBtn = h("button", { class: "con-btn is-secondary", type: "button", text: "重置为默认值" });
    const actions = h("div", { class: "set-actions" }, saveBtn, resetBtn);
    formSection.append(fileLine, warnBox, actions);

    saveBtn.addEventListener("click", () => doSave(saveBtn));
    resetBtn.addEventListener("click", () => doReset(resetBtn));

    function syncDirtyUI() {
        saveBtn.disabled = !S.dirty;
        saveBtn.title = S.dirty ? "" : "没有未保存的修改";
    }
    syncDirtyUI();

    /* ── ⑤ 危险区带（inset 警示带，非卡片） ── */
    const dangerSection = h("div", { class: "set-section" });
    dangerSection.appendChild(h("div", { class: "set-danger" },
        h("div", { class: "set-danger-title", text: "危险区" }),
        dangerRow("卸载 Mod", "从 mods 目录删除 shapez-ai-bridge.js；可选择同时清理 .bak-* 备份与游戏内 mod 设置。", "卸载…", () => doUninstall()),
        dangerRow("重置配置", "把 bridge.config.json 恢复为默认值（端口 7777、无令牌、非只读）。", "重置…", () => doResetDanger()),
        dangerRow("清理 .bak-* 备份", "删除 mods 目录中的历史备份文件；最近一次备份也会被删。", "清理备份…", () => doCleanBackups())));
    main.appendChild(dangerSection);

    function dangerRow(title, desc, btnLabel, onClick) {
        const btn = h("button", { class: "con-btn is-danger", type: "button", text: btnLabel });
        btn.addEventListener("click", () => onClick(btn));
        const row = h("div", { class: "set-danger-row" },
            h("div", { class: "set-danger-txt" }, h("strong", { text: title }), h("span", { text: desc })),
            btn);
        return row;
    }

    /* ── 数据加载 ── */

    depsP.then(async (deps) => {
        if (disposed) return;
        try {
            S.cfg = await deps.api.getConfig();
            fillForm(deps);
        } catch (e) {
            warnBox.hidden = false;
            warnBox.textContent = `读取配置失败：${e.message || e}`;
        }
        deps.api.env().then((e) => { S.env = e; paintDanger(deps); }).catch(() => paintDanger(deps));
    });

    function fillForm(deps) {
        const c = S.cfg.config || {};
        const d = S.cfg.defaults || DEFAULT_CONFIG;
        fields.port.input.value = String(c.port ?? d.port);
        fields.token.input.value = c.token ?? "";
        fields.snapshot_dir.input.value = String(c.snapshot_dir ?? d.snapshot_dir);
        fields.log_level.input.value = String(c.log_level ?? d.log_level);
        fields.read_only.input.setAttribute("aria-checked", String(!!c.read_only));
        fields.rpc_timeout_ms.input.value = String(c.rpc_timeout_ms ?? d.rpc_timeout_ms);
        fields.long_timeout_ms.input.value = String(c.long_timeout_ms ?? d.long_timeout_ms);

        // 默认值回显（label 右侧的 mono 小字）
        fields.port.wrap.parentElement.querySelector(`label[for="set-f-port"] .set-default`)?.replaceChildren(document.createTextNode(`默认 ${d.port}`));
        fields.snapshot_dir.wrap.parentElement.querySelector(`label[for="set-f-snapshot_dir"] .set-default`)?.replaceChildren(document.createTextNode(`默认 ${d.snapshot_dir}`));
        fields.log_level.wrap.parentElement.querySelector(`label[for="set-f-log_level"] .set-default`)?.replaceChildren(document.createTextNode(`默认 ${d.log_level}`));

        const f = S.cfg.file || {};
        fileLine.textContent = f.exists ? `配置文件：${f.path}` : `配置文件：${f.path}（尚不存在 — 保存时创建）`;
        const warnings = [...(S.cfg.warnings || [])];
        if (typeof c.token === "string" && c.token.length > 0 && c.token.length < 16) warnings.push("令牌短于 16 位，安全性较弱。");
        warnBox.hidden = !warnings.length;
        warnBox.textContent = warnings.join(" · ");
        S.dirty = false;
        syncDirtyUI();
    }

    function collectForm() {
        return {
            port: Number(fields.port.input.value.trim()),
            token: fields.token.input.value.trim() === "" ? null : fields.token.input.value.trim(),
            read_only: fields.read_only.input.getAttribute("aria-checked") === "true",
            snapshot_dir: fields.snapshot_dir.input.value.trim(),
            log_level: fields.log_level.input.value,
            rpc_timeout_ms: Number(fields.rpc_timeout_ms.input.value.trim()),
            long_timeout_ms: Number(fields.long_timeout_ms.input.value.trim()),
        };
    }

    function validateAll() {
        let ok = true;
        for (const f of Object.values(fields)) {
            if (!validateField(f)) ok = false;
        }
        return ok;
    }

    /* ── 动作 ── */

    async function doSave(btn) {
        const deps = await depsP;
        if (!validateAll()) {
            deps.toast("有字段未通过校验，未保存", "error");
            // 聚焦第一个错误字段
            for (const f of Object.values(fields)) {
                if (f.wrap.classList.contains("has-error")) { f.input.focus(); break; }
            }
            return;
        }
        btn.classList.add("is-loading");
        btn.disabled = true;
        try {
            const r = await deps.api.saveConfig(collectForm());
            S.cfg = { ...S.cfg, config: r.config, file: { ...(S.cfg?.file || {}), exists: true, valid: true } };
            S.dirty = false;
            syncDirtyUI();
            // 成功一闪（field.is-success）
            for (const f of Object.values(fields)) {
                if (f.isSwitch || !f.err) continue;
                f.wrap.classList.add("has-success");
                setTimeout(() => f.wrap.classList.remove("has-success"), 900);
            }
            deps.toast(r.bridge_restarted ? "配置已保存，桥接已自动重启" : "配置已保存", "success");
            fileLine.textContent = `配置文件：${S.cfg.file.path}`;
        } catch (e) {
            shake(btn);
            if (e.code === "CONFIG_INVALID" && e.detail?.fields) {
                for (const [name, msg] of Object.entries(e.detail.fields)) {
                    const f = fields[name];
                    if (!f) continue;
                    f.wrap.classList.add("has-error");
                    f.input.setAttribute("aria-invalid", "true");
                    if (f.err) f.err.textContent = String(msg);
                }
                deps.toast("配置未通过后端校验，未写入文件", "error");
            } else if (e.code === "PORT_BUSY") {
                const cur = Number(fields.port.input.value) || 7777;
                fields.port.wrap.classList.add("has-error");
                fields.port.input.setAttribute("aria-invalid", "true");
                fields.port.err.textContent = `${e.message || "端口被占用"}——试试 ${cur + 1}`;
            } else {
                deps.toast(e.message || String(e), "error");
            }
        } finally {
            btn.classList.remove("is-loading");
            btn.disabled = !S.dirty;
        }
    }

    async function doReset(btn) {
        const deps = await depsP;
        const ok = deps.confirm
            ? await deps.confirm({ title: "重置配置", body: "把配置恢复为默认值并写入文件？未保存的修改将丢失。", danger: true, okLabel: "重置" })
            : window.confirm("把配置恢复为默认值并写入文件？");
        if (!ok) return;
        btn.classList.add("is-loading");
        try {
            const r = await deps.api.resetConfig();
            S.cfg = { ...(S.cfg || {}), config: r.config, file: { ...(S.cfg?.file || {}), exists: true, valid: true } };
            fillForm(deps);
            deps.toast("已恢复默认值", "success");
        } catch (e) {
            shake(btn);
            deps.toast(e.message || String(e), "error");
        } finally {
            btn.classList.remove("is-loading");
        }
    }

    function doResetDanger() {
        doReset(resetBtn);
    }

    /* 卸载：确认对话框列出将删/将留项（§3.6 危险区） */
    async function doUninstall(btn) {
        const deps = await depsP;
        const modPath = S.env?.mod?.path || "（mods 目录中的 shapez-ai-bridge.js）";
        const bakCount = S.env?.mod?.backup_count ?? 0;
        const willDel = [
            "已安装的 mod 文件", modPath,
            "（重启游戏后）游戏内加载的该 mod",
        ];
        const willKeep = [
            "其他 mod 文件", "游戏存档（saves 目录）",
            bakCount ? `历史备份 .bak-*（${bakCount} 个，除非勾选清理）` : "（无历史备份）",
            "游戏内 mod 设置（除非勾选删除）",
        ];
        // 复选框先建为变量：对话框 cleanup 会还原 body（节点脱离 DOM，但变量仍可读 .checked）
        const cbBackups = h("input", { type: "checkbox", id: "un-cb-backups" });
        const cbModsettings = h("input", { type: "checkbox", id: "un-cb-modsettings" });
        const ok = await customConfirm(deps, {
            title: "卸载 AI 桥接 Mod？",
            okLabel: "卸载",
            danger: true,
            body: h("div", {},
                h("p", { text: "AI 将无法再操作游戏，直到重新安装。清单如下：" }),
                h("div", { class: "set-confirm-cols" },
                    h("div", { class: "set-confirm-col is-del" },
                        h("h4", { text: "将被删除" }),
                        h("ul", {}, willDel.map((t) => h("li", { text: t })))),
                    h("div", { class: "set-confirm-col is-keep" },
                        h("h4", { text: "将被保留" }),
                        h("ul", {}, willKeep.map((t) => h("li", { text: t }))))),
                h("label", { class: "set-checkline" }, cbBackups,
                    h("span", { text: "同时清理 mods 目录中的 .bak-* 备份（不可恢复）" })),
                h("label", { class: "set-checkline" }, cbModsettings,
                    h("span", { text: "同时删除游戏内 mod 设置（saves 目录中的 modsettings.bin）" }))),
        });
        if (!ok) return;
        const cleanBackups = !!cbBackups.checked;
        const cleanModsettings = !!cbModsettings.checked;
        if (btn) { btn.classList.add("is-loading"); btn.disabled = true; }
        try {
            const r = await deps.api.uninstall({ clean_backups: cleanBackups, clean_modsettings: cleanModsettings });
            deps.toast(`已卸载（删除 ${r.removed?.length ?? 0} 个文件）${r.kept_modsettings ? "；游戏内设置保留" : ""}`, "success");
            S.env = await deps.api.env().catch(() => S.env);
            paintDanger(deps);
        } catch (e) {
            if (btn) shake(btn);
            deps.toast(e.message || String(e), "error");
        } finally {
            if (btn) { btn.classList.remove("is-loading"); btn.disabled = false; }
        }
    }

    /* 清理 .bak-*：契约没有独立端点 → 复用 uninstall 的 clean_backups:true
       （只删备份；install.ps1 -Uninstall 对不存在的 mod 是幂等的 no-op，后端 removed 会列出删掉的文件） */
    async function doCleanBackups(btn) {
        const deps = await depsP;
        const n = S.env?.mod?.backup_count;
        const ok = await customConfirm(deps, {
            title: "清理 .bak-* 备份？",
            okLabel: "清理",
            danger: true,
            body: h("div", {},
                h("p", { text: `将删除 mods 目录中的 ${n ?? ""} 个 shapez-ai-bridge.js.bak-* 备份文件（不可恢复）。` }),
                h("p", { class: "set-fileline", text: S.env?.mods_dir?.path || "" }),
                h("p", { text: "当前已安装的 mod 文件不受影响。" })),
        });
        if (!ok) return;
        if (btn) { btn.classList.add("is-loading"); btn.disabled = true; }
        try {
            const r = await deps.api.uninstall({ clean_backups: true, clean_modsettings: false });
            const removedBaks = (r.removed || []).filter((p) => /\.bak-/.test(p));
            deps.toast(removedBaks.length ? `已清理 ${removedBaks.length} 个备份文件` : "没有可清理的备份文件", "success");
            S.env = await deps.api.env().catch(() => S.env);
            paintDanger(deps);
        } catch (e) {
            if (btn) shake(btn);
            deps.toast(e.message || String(e), "error");
        } finally {
            if (btn) { btn.classList.remove("is-loading"); btn.disabled = false; }
        }
    }

    /** 自定义确认对话框：复用 T3 的 <dialog id="confirm-dialog"> 骨架，body 允许富节点。
     *  T3 的 confirm() 只收纯文本 body，这里是 T4 需要的"将删/将留"清单版。 */
    function customConfirm(deps, opts) {
        const dlg = document.getElementById("confirm-dialog");
        if (!dlg || typeof dlg.showModal !== "function") {
            return Promise.resolve(window.confirm(opts.title || "确认？"));
        }
        return new Promise((resolve) => {
            const titleEl = dlg.querySelector("#confirm-title");
            const bodyEl = dlg.querySelector("#confirm-body");
            const okBtn = dlg.querySelector("#confirm-ok");
            const cancelBtn = dlg.querySelector("#confirm-cancel");
            const prevTitle = titleEl.textContent;
            const prevBody = bodyEl.innerHTML;
            const prevOkClasses = okBtn.className;
            titleEl.textContent = opts.title || "确认操作";
            bodyEl.innerHTML = "";
            bodyEl.append(opts.body || "");
            bodyEl.classList.remove("confirm-body"); // 允许富内容不被 muted 小字压住
            bodyEl.classList.add("confirm-body-rich");
            okBtn.textContent = opts.okLabel || "确认";
            cancelBtn.textContent = "取消";
            okBtn.classList.toggle("btn-danger", !!opts.danger);
            okBtn.classList.toggle("btn-primary", !opts.danger);

            function cleanup(result) {
                okBtn.removeEventListener("click", onOk);
                cancelBtn.removeEventListener("click", onCancel);
                dlg.removeEventListener("cancel", onCancel);
                dlg.removeEventListener("close", onClose);
                if (dlg.open) dlg.close();
                titleEl.textContent = prevTitle;
                bodyEl.innerHTML = prevBody;
                bodyEl.classList.add("confirm-body");
                bodyEl.classList.remove("confirm-body-rich");
                okBtn.className = prevOkClasses;
                resolve(result);
            }
            function onOk() { cleanup(true); }
            function onCancel() { cleanup(false); }
            function onClose() { cleanup(false); }
            okBtn.addEventListener("click", onOk);
            cancelBtn.addEventListener("click", onCancel);
            dlg.addEventListener("cancel", onCancel);
            dlg.addEventListener("close", onClose);
            dlg.showModal();
            cancelBtn.focus();
        });
    }

    /* 危险区按钮的短状态（比如"未安装"时禁用卸载） */
    function paintDanger(deps) {
        const installed = !!S.env?.mod?.installed;
        const bakCount = S.env?.mod?.backup_count ?? 0;
        const rows = dangerSection.querySelectorAll(".set-danger-row");
        // rows[0] 卸载 / rows[1] 重置 / rows[2] 清理备份
        const unBtn = rows[0]?.querySelector("button");
        const bakBtn = rows[2]?.querySelector("button");
        if (unBtn) {
            unBtn.disabled = !installed;
            unBtn.title = installed ? "" : "当前没有已安装的 mod";
        }
        if (bakBtn) {
            bakBtn.disabled = !bakCount;
            bakBtn.title = bakCount ? "" : "没有 .bak-* 备份";
        }
    }

    return {
        dispose() { disposed = true; },
    };
}

export default mountSettings;
