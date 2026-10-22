/**
 * logview.js — reusable log console renderer (frozen §3.7: T4 reuses it).
 *
 * Exports createLogView(el, opts) -> {append(lines), clear(), setFollow(b), setFilter(level), count()}.
 * - Renders into `el` (caller supplies the container; we build the inner list).
 * - opts: { follow=true, max=2000, level="all", onJump? }
 * - append(lines): array of §2.4 line objects {n, kind, stream, level, text, ts}.
 * - level filtering stays client-side; lines keep their DOM node so M6 arrival
 *   animation (160ms fade+4px, stagger 40ms per batch ≤8) applies per append batch.
 * - reduced-motion: CSS collapses arrivals to instant (see base.css).
 * Zero deps; safe under file:// (no dynamic imports, relative nothing to import).
 */
import { t } from "./i18n.js";

export function createLogView(el, opts = {}) {
    const state = {
        follow: opts.follow !== false,
        max: opts.max || 2000,
        level: opts.level || "all",
        n: 0,
        lines: [],
    };

    const wrap = document.createElement("div");
    wrap.className = "logview";
    const scroller = document.createElement("div");
    scroller.className = "logview-scroller";
    scroller.setAttribute("role", "log");
    scroller.setAttribute("aria-live", "polite");
    scroller.tabIndex = 0;
    const empty = document.createElement("div");
    empty.className = "logview-empty";
    empty.textContent = t("log.empty");
    wrap.append(scroller, empty);
    el.appendChild(wrap);

    function nearBottom() {
        return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
    }

    function makeRow(line) {
        const row = document.createElement("div");
        row.className = `logrow lv-${line.level || "info"}`;
        row.dataset.n = String(line.n);
        row.dataset.level = line.level || "info";

        const n = document.createElement("span");
        n.className = "logrow-n";
        n.textContent = String(line.n);
        const time = document.createElement("span");
        time.className = "logrow-ts";
        const d = new Date(line.ts || Date.now());
        time.textContent = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
        const text = document.createElement("span");
        text.className = "logrow-text";
        text.textContent = line.text ?? "";
        row.append(n, time, text);
        return row;
    }

    function matchesFilter(line) {
        return state.level === "all" || (line.level || "info") === state.level;
    }

    function append(lines) {
        if (!lines || !lines.length) return;
        const batch = lines;
        const frag = document.createDocumentFragment();
        let entered = 0;
        for (const line of batch) {
            if (line.n <= state.n && state.lines.some((l) => l.n === line.n)) continue; // dedupe by n
            state.lines.push(line);
            const row = makeRow(line);
            if (!matchesFilter(line)) row.hidden = true;
            // M6: stagger only the first 8 arrivals of a batch
            if (entered < 8) {
                row.style.animationDelay = `${entered * 40}ms`;
                entered += 1;
            } else {
                row.classList.add("no-anim");
            }
            frag.appendChild(row);
            state.n = Math.max(state.n, line.n);
        }
        const shouldStick = state.follow && nearBottom();
        scroller.appendChild(frag);
        // cap DOM growth
        while (scroller.children.length > state.max) scroller.removeChild(scroller.firstChild);
        empty.hidden = scroller.children.length > 0;
        if (shouldStick) scroller.scrollTop = scroller.scrollHeight;
    }

    function clear() {
        scroller.textContent = "";
        state.lines = [];
        // NOTE: state.n intentionally kept — server `since` cursor must not rewind
        // (clear() is a view operation, not a data operation).
        empty.hidden = false;
    }

    function setFollow(b) {
        state.follow = !!b;
        if (state.follow) scroller.scrollTop = scroller.scrollHeight;
    }

    function setFilter(level) {
        state.level = level || "all";
        for (const row of scroller.children) {
            const lvl = row.dataset.level || "info";
            row.hidden = !(state.level === "all" || lvl === state.level);
        }
    }

    /** Scroll to a specific line number (log_ref deep link). Returns true if found. */
    function jumpTo(n) {
        const row = scroller.querySelector(`.logrow[data-n="${n}"]`);
        if (!row) return false;
        row.scrollIntoView({ block: "center" });
        row.classList.add("logrow-jump");
        setTimeout(() => row.classList.remove("logrow-jump"), 1600);
        return true;
    }

    /** Serialize all retained rows for download/export. */
    function toText() {
        return state.lines.map((l) => `[${l.n}] ${l.text}`).join("\n");
    }

    // Reading history or hovering = user intent: pause follow
    scroller.addEventListener("wheel", (e) => { if (e.deltaY < 0) setFollow(false); }, { passive: true });
    scroller.addEventListener("pointerdown", () => setFollow(false));
    scroller.addEventListener("keydown", (e) => {
        if (["ArrowUp", "PageUp", "Home"].includes(e.key)) setFollow(false);
        if (["ArrowDown", "PageDown", "End"].includes(e.key)) {
            setTimeout(() => { if (nearBottom()) state.follow = true; }, 0);
        }
    });

    return { append, clear, setFollow, setFilter, jumpTo, toText, count: () => state.lines.length, el: wrap };
}

export default createLogView;
