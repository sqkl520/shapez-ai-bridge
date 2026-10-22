/**
 * logpanel.js — 日志面板增强层（T4）
 *
 * 职责（与 T3 的 logview.js 配合，不重复实现渲染）：
 *   - createLogViewCompat(el, opts)：优先使用 T3 的 createLogView；文件缺失/抛错时
 *     退回内置简版渲染（本文件唯一渲染实现，供测试与降级）。
 *   - enhanceLogView(el, inner, opts)：包装任意 {append,clear,setFollow} 视图，叠加
 *     级别过滤（all/info/warn/error）、log_ref 定位（滚动+高亮）、下载为 .txt。
 *   - downloadLogText(lines, kind)：把日志行格式化为 .txt 并触发下载（零依赖）。
 *
 * 行对象契约（DESIGN-PLAN §2.4）：{n:int, kind, stream:"out"|"err",
 *   level:"info"|"warn"|"error"|"ok", text:string, ts:int}
 */

const BACKLOG_CAP = 2000; // 与后端环形缓冲一致

/** 级别过滤阈值：info 含 ok（信息类），warn 含 error（severity ≥）。 */
export function levelPasses(level, filter) {
    if (filter === "all" || !filter) return true;
    if (filter === "error") return level === "error";
    if (filter === "warn") return level === "warn" || level === "error";
    if (filter === "info") return level === "info" || level === "ok";
    return true;
}

/* ─────────────────────────── 内置简版渲染（T3 缺失时） ─────────────────────────── */

/**
 * 最小日志视图：append(lines) / clear() / setFollow(b)。
 * DOM：.logp-line[data-n][data-level] > .logp-n(n) + .logp-text
 * @param {HTMLElement} el 滚动容器
 * @param {{maxLines?:number, onFollowChange?:(b:boolean)=>void}} [opts]
 */
export function createFallbackLogView(el, opts = {}) {
    const cap = opts.maxLines || BACKLOG_CAP;
    let follow = true;

    el.addEventListener("scroll", () => {
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        if (atBottom !== follow) {
            follow = atBottom;
            if (typeof opts.onFollowChange === "function") opts.onFollowChange(follow);
        }
    }, { passive: true });

    function scrollToBottom() {
        el.scrollTop = el.scrollHeight;
    }

    return {
        el,
        append(lines) {
            const wasAtBottom = follow;
            const batch = Array.isArray(lines) ? lines : [lines];
            const frag = document.createDocumentFragment();
            batch.forEach((line, i) => {
                const row = document.createElement("div");
                row.className = "logp-line is-enter";
                row.dataset.n = String(line.n);
                row.dataset.level = line.level || "info";
                if (i < 8) row.style.setProperty("--logp-i", String(i));
                const num = document.createElement("span");
                num.className = "logp-n";
                num.textContent = String(line.n);
                const text = document.createElement("span");
                text.className = "logp-text";
                text.textContent = line.text ?? "";
                row.append(num, text);
                frag.appendChild(row);
            });
            el.appendChild(frag);
            while (el.children.length > cap) el.removeChild(el.firstChild);
            if (wasAtBottom) scrollToBottom();
        },
        clear() {
            el.textContent = "";
        },
        setFollow(b) {
            follow = !!b;
            if (follow) scrollToBottom();
        },
        getFollow() {
            return follow;
        },
    };
}

/* ─────────────────────────── 兼容加载器（优先 T3） ─────────────────────────── */

/**
 * 尝试加载 T3 的 createLogView；失败（缺文件/异常）时退回内置简版。
 * @returns {Promise<{view:{append,clear,setFollow}, source:"t3"|"fallback"}>}
 */
export async function createLogViewCompat(el, opts = {}) {
    try {
        const mod = await import("./logview.js");
        if (mod && typeof mod.createLogView === "function") {
            const view = mod.createLogView(el, opts);
            if (view && typeof view.append === "function" && typeof view.clear === "function") {
                return { view, source: "t3" };
            }
        }
    } catch {
        /* 缺文件或构造失败 → 降级 */
    }
    el.textContent = "";
    return { view: createFallbackLogView(el, opts), source: "fallback" };
}

/* ─────────────────────────── 增强包装 ─────────────────────────── */

/**
 * 包装视图：过滤 + 定位 + 下载。
 * @param {HTMLElement} el 滚动容器（外层）
 * @param {{append,clear,setFollow}} inner T3 或简版视图
 * @param {{filter?:"all"|"info"|"warn"|"error", cap?:number}} [opts]
 */
export function enhanceLogView(el, inner, opts = {}) {
    let filter = opts.filter || "all";
    let follow = true;
    const cap = opts.cap || BACKLOG_CAP;
    /** @type {Array<object>} 全量（未过滤）行，供过滤切换与下载 */
    let backlog = [];

    function renderVisible() {
        inner.clear();
        const visible = backlog.filter((l) => levelPasses(l.level, filter));
        if (visible.length) inner.append(visible);
        if (follow) inner.setFollow?.(true);
    }

    return {
        el,
        inner,
        /** 增量追加（过滤后转发给内层视图） */
        append(lines) {
            const batch = Array.isArray(lines) ? lines : [lines];
            backlog.push(...batch);
            if (backlog.length > cap) backlog.splice(0, backlog.length - cap);
            const visible = batch.filter((l) => levelPasses(l.level, filter));
            if (visible.length) inner.append(visible);
        },        /** 全量替换（kind 切换时） */
        replaceAll(lines) {
            backlog = Array.isArray(lines) ? lines.slice(-cap) : [];
            renderVisible();
        },
        /** 清屏（仅视图；后端环形缓冲不受影响） */
        clear() {
            backlog = [];
            inner.clear();
        },
        setFollow(b) {
            follow = !!b;
            inner.setFollow?.(follow);
        },
        getFollow() {
            return follow;
        },
        setFilter(level) {
            if (level === filter) return;
            const wasFollow = follow;
            filter = level;
            renderVisible();
            if (wasFollow) inner.setFollow?.(true);
        },
        getFilter() {
            return filter;
        },
        /** 定位到行号 n：优先内层视图的 jumpTo；否则 DOM 启发定位 + 全量重渲。 */
        locate(n) {
            const target = Number(n);
            if (!Number.isFinite(target)) return false;
            if (typeof inner.jumpTo === "function" && inner.jumpTo(target)) return true;
            if (!levelPasses((backlog.find((l) => l.n === target) || {}).level, filter)) {
                filter = "all";
                renderVisible();
            }
            if (locateLineInDom(el, target)) return true;
            // 不在视图（可能已被清屏或滚出缓冲）→ 若在 backlog 中，整批重渲
            if (backlog.some((l) => l.n === target)) {
                renderVisible();
                return locateLineInDom(el, target);
            }
            return false;
        },
        backlog() {
            return backlog.slice();
        },
    };
}

/* ─────────────────────────── log_ref 定位算法 ─────────────────────────── */

/**
 * 在容器内找到行号 n 的 DOM 节点：多选择器启发（适配 T3 未知结构），
 * 找不到则按文本前缀（行号后跟空白）匹配。命中后居中滚动 + 高亮 2.6s。
 * @returns {boolean}
 */
export function locateLineInDom(el, n) {
    let node =
        el.querySelector(`[data-n="${n}"]`) ||
        el.querySelector(`[data-line="${n}"]`) ||
        el.querySelector(`[data-line-number="${n}"]`) ||
        el.querySelector(`[data-lineno="${n}"]`);

    if (!node) {
        const rx = new RegExp(`^\\s*${n}\\b`);
        for (const child of el.children) {
            const t = (child.textContent || "").trim();
            if (rx.test(t) && t.length < 4000) {
                node = child;
                break;
            }
        }
    }
    if (!node) return false;

    node.scrollIntoView({ block: "center" });
    node.classList.add("is-target");
    // 同时内联兜底（T3 结构可能不带 .logp-line 类）
    const prevOutline = node.style.outline;
    const prevBg = node.style.background;
    node.style.outline = "1px solid var(--accent, #4a97df)";
    node.style.background = "rgba(74, 151, 223, 0.18)";
    setTimeout(() => {
        node.classList.remove("is-target");
        node.style.outline = prevOutline;
        node.style.background = prevBg;
    }, 2600);
    return true;
}

/* ─────────────────────────── 下载 ─────────────────────────── */

/** 格式化行数组为 .txt 文本。 */
export function formatLogText(lines) {
    const pad = Math.max(4, String(lines.length ? lines[lines.length - 1].n : 0).length);
    return lines
        .map((l) => {
            const n = String(l.n).padStart(pad, " ");
            const lv = (l.level || "info").toUpperCase().padEnd(5, " ");
            return `[${n}] ${lv} ${l.stream === "err" ? "E " : "  "}${l.text ?? ""}`;
        })
        .join("\r\n") + "\r\n";
}

/**
 * 触发浏览器下载（Blob + <a download>，零依赖）。
 * @param {Array<object>} lines
 * @param {string} kind bridge|install|smoke
 */
export function downloadLogText(lines, kind = "log") {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const name = `shapez-${kind}-${stamp}.txt`;
    const blob = new Blob(["﻿" + formatLogText(lines)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return name;
}
