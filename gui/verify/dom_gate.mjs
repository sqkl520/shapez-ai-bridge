/**
 * T5 · DOM 静态闸门 — A2 / A4 / A6 (+ A3 accent scan)。
 *
 * 用法: node gui/verify/dom_gate.mjs [--port 7803] [--keep-gui]
 *
 * 步骤:
 *   1. 自启 GUI（--no-open）
 *   2. chrome --headless=new --dump-dom http://127.0.0.1:PORT/?probe=1           → 正常模式 probe JSON
 *   3. chrome --headless=new --force-prefers-reduced-motion --dump-dom "...?probe=1" → 静帧 probe JSON
 *   4. 解析 #probe-json: displayFont/bodyFont/ratio/minHit/focusableCount/reducedMotion
 *      A2: ratio ≥ 4
 *      A4: reduced-motion 下内容完整（probe.json.reducedMotion===true 且 body 文本非空、关键 view 节点在）
 *      A6: minHit ≥ 44
 *   5. 额外扫描 base.css 自定义属性：单一 accent（A3）
 *   6. GET / 的 HTML 里不存在紫渐变关键色（#6366f1/#a855f7）与疑似模板文案
 *   7. 截图: docs/gui/A1-still-reduced-motion.png（静帧）
 *
 * 结果写入 docs/gui/VERIFICATION.md（sec-A）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
    ROOT, DOCS_GUI, BAK_DIR, http, sleep, probePort, startGui, fetchGuiToken,
    Recorder, writeSection, appendJsonl, trunc, ensureDirs,
} from "./lib.mjs";

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = parseInt(argVal("--port", "7803"), 10);
const KEEP_GUI = args.includes("--keep-gui");

const R = new Recorder("dom_gate");
const RESULTS = path.join(BAK_DIR, "domgate.jsonl");
const VERIFICATION = path.join(DOCS_GUI, "VERIFICATION.md");

function row(group, id, status, detail, evidence = "") {
    const r = R.add(group, id, status, detail, evidence);
    appendJsonl(RESULTS, r);
    return r;
}
function flush() {
    const body = [
        `> 时间: ${new Date().toISOString()}`,
        "",
        R.markdownTable(),
        "",
        `计数: PASS=${R.counts.PASS} FAIL=${R.counts.FAIL} BLOCKED=${R.counts.BLOCKED}`,
    ].join("\n");
    writeSection(VERIFICATION, "sec-A", "A 组 · 静态与设计闸门（DOM probe）", body);
}

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

/** Run headless dump-dom, return {dom, stderr, code}.
 *  Window size defaults to the app-window size (WINDOWS-PROBES §4: 1180x780) —
 *  the hero type uses clamp(48px,5vw,64px), so viewport width changes A2's ratio. */
export function dumpDom(browser, url, { reducedMotion = false, waitMs = 2500, width = 1180, height = 780 } = {}) {
    return new Promise((resolve) => {
        const flags = ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--dump-dom", `--virtual-time-budget=${waitMs}`, `--window-size=${width},${height}`];
        if (reducedMotion) flags.push("--force-prefers-reduced-motion");
        const child = spawn(browser, [...flags, url], { stdio: ["ignore", "pipe", "pipe"] });
        let dom = "";
        let err = "";
        child.stdout.on("data", (d) => (dom += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("close", (code) => resolve({ dom, stderr: err, code }));
    });
}

export function extractProbe(dom) {
    // <script type="application/json" id="probe-json">{...}</script>
    const m = dom.match(/<script[^>]*id=["']probe-json["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!m) return null;
    let txt = m[1].trim();
    // tolerate HTML-escaped entities
    txt = txt.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    try { return JSON.parse(txt); } catch { return { parse_error: true, raw: txt.slice(0, 500) }; }
}

/** Crude body-text presence check from dumped DOM (A4). */
export function domTextStats(dom) {
    const stripped = dom
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return { textLen: stripped.length, sample: stripped.slice(0, 200) };
}

/** Count elements stuck at opacity:0 (inline style or computed not possible via dump-dom; check inline+classes heuristics). */
export function countInlineHidden(dom) {
    let n = 0;
    const re = /style=["'][^"']*opacity\s*:\s*0(?:[;"']|\s)/gi;
    while (re.exec(dom)) n++;
    return n;
}

async function main() {
    ensureDirs();
    const browser = findBrowser();
    if (!browser) {
        row("A", "browser", "BLOCKED", "未找到 Chrome/Edge", "");
        flush();
        process.exit(2);
    }
    if (await probePort(PORT)) {
        console.error(`[dom] port ${PORT} busy — abort`);
        process.exit(2);
    }
    const gui = await startGui({ port: PORT });
    if (!gui.ready) {
        row("A", "gui_ready", "FAIL", "GUI server 未就绪", gui.stderr.slice(-400));
        flush();
        process.exit(1);
    }
    const tok = await fetchGuiToken(gui.url);
    row("A", "token_meta", tok.ok ? "PASS" : "FAIL", tok.ok ? "GET / 含 gui-token meta" : tok.reason, "");

    const url = `${gui.url}/?probe=1`;
    try {
        // CDP-based capture — NOT `--dump-dom` CLI: the real page opens an SSE
        // /api/events stream that never closes, and Chrome's virtual-time policy
        // stalls forever waiting on that pending fetch. CDP with real-time waits
        // is immune.
        const { CdpSession } = await import("./cdp.mjs");
        const cdpN = await CdpSession.launch({ url, width: 1180, height: 780 });
        await cdpN.send("Runtime.enable");
        await sleep(3500);
        const domNormal = await cdpN.eval("document.documentElement.outerHTML");
        await cdpN.close();
        const cdpR = await CdpSession.launch({ url, width: 1180, height: 780, reducedMotion: true });
        await cdpR.send("Runtime.enable");
        await sleep(3500);
        const domReduced = await cdpR.eval("document.documentElement.outerHTML");
        await cdpR.close();

        fs.writeFileSync(path.join(BAK_DIR, "dom-normal.html"), domNormal || "");
        fs.writeFileSync(path.join(BAK_DIR, "dom-reduced.html"), domReduced || "");
        const normal = { dom: domNormal || "" };
        const reduced = { dom: domReduced || "" };

        const pN = extractProbe(normal.dom);
        const pR = extractProbe(reduced.dom);
        appendJsonl(RESULTS, { group: "A", id: "probe-normal", pN });
        appendJsonl(RESULTS, { group: "A", id: "probe-reduced", pR });

        if (!pN) {
            row("A", "probe_json", "FAIL", "?probe=1 未产出 #probe-json（T3 契约 §3.7）",
                `dom_len=${normal.dom.length} has_probe_tag=${normal.dom.includes("probe-json")}`);
        } else {
            row("A", "probe_json", "PASS", "?probe=1 产出 #probe-json", trunc(JSON.stringify(pN), 320));
        }

        // A2 scale ratio (tolerate number or numeric string). Measured at app-window size (1180x780);
        // NOTE: at <960px viewports the clamp(48px,5vw,64px) floor yields 3.43x — flagged in report.
        const ratioNum = typeof pN?.ratio === "number" ? pN.ratio : parseFloat(pN?.ratio);
        if (Number.isFinite(ratioNum)) {
            row("A", "A2", ratioNum >= 4 ? "PASS" : "FAIL",
                `display/body 字号比 ${ratioNum}（要求 ≥4；@1180×780 应用窗口）`,
                `displayFont=${trunc(JSON.stringify(pN?.displayFont), 40)} bodyFont=${trunc(JSON.stringify(pN?.bodyFont), 40)}`);
        } else {
            const disp = parseFloat(pN?.displayFont);
            const body = parseFloat(pN?.bodyFont);
            if (disp && body) {
                const ratio = disp / body;
                row("A", "A2", ratio >= 4 ? "PASS" : "FAIL", `fallback 计算 ratio=${ratio.toFixed(2)}（要求 ≥4）`, `display=${disp} body=${body}`);
            } else {
                row("A", "A2", "FAIL", "probe 中无 ratio/displayFont/bodyFont", trunc(JSON.stringify(pN), 200));
            }
        }

        // A4 reduced-motion content complete
        if (pR) {
            const statsN = domTextStats(normal.dom);
            const statsR = domTextStats(reduced.dom);
            const contentRatio = statsN.textLen > 0 ? statsR.textLen / statsN.textLen : 0;
            const rmFlag = pR.reducedMotion === true;
            const hiddenInline = countInlineHidden(reduced.dom);
            const okA4 = rmFlag && statsR.textLen > 200 && contentRatio >= 0.7 && hiddenInline === 0;
            row("A", "A4", okA4 ? "PASS" : "FAIL",
                `reduced-motion: flag=${rmFlag} 文本量 ${statsR.textLen}/${statsN.textLen}（比例 ${contentRatio.toFixed(2)}）内联 opacity:0=${hiddenInline}`,
                `reduced_probe=${trunc(JSON.stringify(pR), 260)}`);
        } else {
            row("A", "A4", "FAIL", "reduced-motion 下无 #probe-json", trunc(reduced.dom.slice(0, 200), 200));
        }

        // A6 min hit target (tolerate numeric string)
        const hitNum = typeof pN?.minHit === "number" ? pN.minHit : parseFloat(pN?.minHit);
        if (Number.isFinite(hitNum)) {
            row("A", "A6", hitNum >= 44 ? "PASS" : "FAIL",
                `minHit=${hitNum}px（主要动作要求 ≥44）`,
                `focusableCount=${pN?.focusableCount}`);
        } else {
            row("A", "A6", "FAIL", "probe 中无 minHit", trunc(JSON.stringify(pN), 200));
        }

        // focusable count sanity
        if (pN && typeof pN.focusableCount === "number") {
            row("A", "focusable_count", pN.focusableCount > 0 ? "PASS" : "FAIL",
                `focusableCount=${pN.focusableCount}`, "");
        }
    } catch (e) {
        row("A", "exception", "FAIL", "dom gate 执行异常", trunc(String(e.stack ?? e), 300));
    }

    // A3 single accent — scan CSS custom properties in served files
    try {
        const indexResp = await http(gui.url + "/");
        const html = indexResp.text || "";
        const cssFiles = [...html.matchAll(/<link[^>]+href=["']([^"']+\.css[^"']*)["']/gi)].map((m) => m[1]);
        const cssInline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
        let css = cssInline;
        for (const f of cssFiles) {
            const u = f.startsWith("http") ? f : gui.url + (f.startsWith("/") ? f : "/" + f);
            const r = await http(u);
            if (r.status === 200) css += "\n" + r.text;
        }
        const accentDecls = [...css.matchAll(/--accent(?:-hover)?\s*:\s*([^;]+);/gi)].map((m) => m[1].trim());
        const uniqueAccents = [...new Set(accentDecls.map((s) => s.toLowerCase()))];
        // purple slop colors anywhere in CSS?
        const purpleHit = /#6366f1|#a855f7|6366f1|a855f7/i.test(css);
        const multiAccent = uniqueAccents.length > 2; // --accent + --accent-hover allowed
        // guard: a scan that found no CSS at all must FAIL, not pass vacuously
        const scanOk = cssFiles.length > 0 && css.length > 500 && uniqueAccents.length > 0;
        row("A", "A3", scanOk && !purpleHit && !multiAccent ? "PASS" : "FAIL",
            scanOk
                ? `accent 声明=[${uniqueAccents.join(", ")}]；紫渐变色命中=${purpleHit}`
                : `A3 扫描无效：css_files=${cssFiles.length} css_len=${css.length} accents=${uniqueAccents.length}（页面/静态资源未取到？）`,
            `css_files=${cssFiles.length} inline_css_len=${cssInline.length} index_status=${indexResp.status}`);
        appendJsonl(RESULTS, { group: "A", id: "A3.detail", accentDecls, purpleHit, cssFiles });
    } catch (e) {
        row("A", "A3", "FAIL", "A3 CSS 扫描异常", trunc(String(e), 200));
    }

    // A2/A6 独立复测（CDP 实测，不信任 T3 自报的 probe 值 — 交叉核对）
    try {
        const { CdpSession } = await import("./cdp.mjs");
        const cdp = await CdpSession.launch({ url: gui.url + "/", width: 1440, height: 960 });
        await cdp.send("Runtime.enable");
        await sleep(2000);
        const measured = await cdp.eval(`(() => {
            const bodySize = parseFloat(getComputedStyle(document.body).fontSize);
            let maxSize = 0, maxEl = null;
            for (const el of document.querySelectorAll('body *')) {
                const st = getComputedStyle(el);
                if (st.display === 'none' || st.visibility === 'hidden') continue;
                const fs = parseFloat(st.fontSize);
                if (fs > maxSize && el.textContent.trim().length > 0) { maxSize = fs; maxEl = el.tagName + '.' + el.className; }
            }
            let minHit = Infinity, minEl = null, count = 0;
            for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role=button], [tabindex]')) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                if (el.closest('[hidden]')) continue;
                count++;
                const m = Math.min(r.width, r.height);
                if (m < minHit) { minHit = m; minEl = el.tagName + '.' + (el.className || '') + ' "' + (el.textContent||'').trim().slice(0,20) + '"'; }
            }
            return { bodySize, maxSize, maxEl, ratio: maxSize / bodySize, minHit: minHit === Infinity ? null : minHit, minEl, count };
        })()`);
        appendJsonl(RESULTS, { group: "A", id: "cdp-measure", measured });
        const mRatio = measured?.ratio;
        const mHit = measured?.minHit;
        row("A", "A2.cdp_crosscheck", Number.isFinite(mRatio)
            ? (mRatio >= 4 ? "PASS" : "FAIL") : "FAIL",
            `CDP 实测 display/body=${Number.isFinite(mRatio) ? mRatio.toFixed(2) : "?"}（body ${measured?.bodySize}px，max ${measured?.maxSize}px @ ${measured?.maxEl}）`,
            "");
        if (mHit !== null && Number.isFinite(mHit)) {
            row("A", "A6.cdp_crosscheck", mHit >= 44 ? "PASS" : (mHit >= 36 ? "FAIL" : "FAIL"),
                `CDP 实测最小命中区 ${mHit.toFixed(0)}×?? px @ ${measured?.minEl}（focusable=${measured?.count}）`,
                mHit >= 44 ? "" : "低于 44（桌面次级可放宽 36，主要动作必须 44 — 人工复核该元素角色）");
        } else {
            row("A", "A6.cdp_crosscheck", "FAIL", "CDP 未测得任何可聚焦元素", "");
        }
        await cdp.close();
    } catch (e) {
        row("A", "A2.cdp_crosscheck", "BLOCKED", `CDP 复测不可用: ${trunc(String(e.message), 120)}`, "");
    }

    // A5: 焦点环检查（CDP：逐个 focus 可见可聚焦元素，检查 outline/box-shadow）
    try {
        const { CdpSession } = await import("./cdp.mjs");
        const cdp = await CdpSession.launch({ url: gui.url + "/", width: 1180, height: 780 });
        await cdp.send("Runtime.enable");
        await sleep(2500);
        const list = await cdp.eval(`(() => {
            const els = [...document.querySelectorAll('button, a[href], input, select, textarea, [role=button], [tabindex]:not([tabindex="-1"])')]
                .filter(e => e.offsetParent !== null && !e.disabled && !e.closest('[hidden]'));
            const out = [];
            for (const el of els.slice(0, 40)) {
                el.focus({ focusVisible: true });
                const st = getComputedStyle(el);
                const visible = (st.outlineStyle !== 'none' && parseFloat(st.outlineWidth) > 0) || (st.boxShadow && st.boxShadow !== 'none');
                out.push({ tag: el.tagName, cls: String(el.className).slice(0,36), label: (el.textContent||'').trim().slice(0,16), visible });
            }
            return out;
        })()`);
        const arr = Array.isArray(list) ? list : [];
        const noRing = arr.filter((x) => !x.visible);
        if (!arr.length) {
            row("A", "A5", "BLOCKED", "A5：无可见可聚焦元素", "");
        } else {
            row("A", "A5", noRing.length === 0 ? "PASS" : "FAIL",
                `可见可聚焦 ${arr.length} 个，无焦点环 ${noRing.length} 个`,
                noRing.length ? trunc(JSON.stringify(noRing), 240) : "全部有 outline/box-shadow 焦点样式");
        }
        appendJsonl(RESULTS, { group: "A", id: "A5.detail", arr });
        await cdp.close();
    } catch (e) {
        row("A", "A5", "BLOCKED", `A5 CDP 遍历不可用: ${trunc(String(e.message), 120)}`, "");
    }

    // A1 screenshot (reduced motion still frame) — CDP capture (SSE-safe), not shot.mjs dump-dom
    try {
        const { CdpSession } = await import("./cdp.mjs");
        const shot = path.join(DOCS_GUI, "A1-still-reduced-motion.png");
        const cdp = await CdpSession.launch({ url: gui.url + "/", width: 1440, height: 960, reducedMotion: true });
        await cdp.send("Runtime.enable");
        await sleep(3000);
        await cdp.screenshot(shot);
        await cdp.close();
        const exists = fs.existsSync(shot);
        row("A", "A1.screenshot", exists ? "PASS" : "FAIL",
            `静帧截图 ${path.basename(shot)}（${exists ? fs.statSync(shot).size + " bytes" : "缺失"}）`, "");
    } catch (e) {
        row("A", "A1.screenshot", "FAIL", "截图异常", trunc(String(e), 200));
    }

    flush();
    if (!KEEP_GUI) await gui.stop();
    const c = R.counts;
    console.log(`\n[T5] dom_gate done: PASS=${c.PASS} FAIL=${c.FAIL} BLOCKED=${c.BLOCKED}`);
    process.exitCode = c.FAIL > 0 ? 1 : 0;
}

// Only run main when invoked directly (so wizard_shots can import helpers).
import { fileURLToPath, pathToFileURL } from "node:url";
const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
    main().catch((e) => { console.error(e); process.exitCode = 1; });
}
