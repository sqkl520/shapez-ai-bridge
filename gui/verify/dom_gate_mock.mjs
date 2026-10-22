/**
 * dom_gate_mock.mjs — A 组全量预检（零后端）。
 *
 * 与 dom_gate.mjs 相同判据，但通过 gui/verify/static-mini.mjs 服务 gui/ui/
 * 并加 ?mock=1（api.js 内置 mock），不依赖 T2 gui/server.mjs。
 * 除 token 相关项外，A2/A3/A4/A5/A6/A1 的证据与真实后端下等价（probe 与 CSS 均与后端无关）。
 *
 * 用法: node gui/verify/dom_gate_mock.mjs [--port 7807]
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
    ROOT, DOCS_GUI, BAK_DIR, http, sleep, probePort, Recorder, writeSection,
    appendJsonl, trunc, ensureDirs, findFreePort,
} from "./lib.mjs";
import { dumpDom, extractProbe, domTextStats, countInlineHidden, findBrowser } from "./dom_gate.mjs";

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = parseInt(argVal("--port", "7807"), 10);

const R = new Recorder("dom_gate_mock");
const RESULTS = path.join(BAK_DIR, "domgate-mock.jsonl");
const VERIFICATION = path.join(DOCS_GUI, "VERIFICATION.md");

function row(group, id, status, detail, evidence = "") {
    const r = R.add(group, id, status, detail, evidence);
    appendJsonl(RESULTS, r);
    return r;
}
function flush() {
    const body = [
        `> 时间: ${new Date().toISOString()} · 模式: mock（static-mini :${PORT}，零后端）`,
        "",
        R.markdownTable(),
        "",
        `计数: PASS=${R.counts.PASS} FAIL=${R.counts.FAIL} BLOCKED=${R.counts.BLOCKED}`,
    ].join("\n");
    writeSection(VERIFICATION, "sec-A-mock", "A 组 · 静态闸门（mock 模式全量预检）", body);
}

async function main() {
    ensureDirs();
    const browser = findBrowser();
    if (!browser) { row("A", "browser", "BLOCKED", "未找到 Chrome/Edge", ""); flush(); process.exit(2); }
    if (await probePort(PORT)) { console.error(`port ${PORT} busy`); process.exit(2); }

    // spawn static-mini
    const mini = spawn(process.execPath, ["gui/verify/static-mini.mjs", "--port", String(PORT)], {
        cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let miniOut = "";
    mini.stdout.on("data", (d) => (miniOut += d));
    await sleep(800);
    const base = `http://127.0.0.1:${PORT}`;
    if ((await http(base + "/")).status !== 200) {
        row("A", "static_mini", "FAIL", "static-mini 未就绪", trunc(miniOut, 200));
        flush(); mini.kill(); process.exit(1);
    }
    row("A", "static_mini", "PASS", `static-mini 服务 gui/ui/ @${PORT}（mock 模式）`, "");

    const url = `${base}/?mock=1&probe=1`;
    try {
        const normal = await dumpDom(browser, url, { waitMs: 4500, width: 1180, height: 780 });
        const reduced = await dumpDom(browser, url, { reducedMotion: true, waitMs: 4500, width: 1180, height: 780 });
        fs.writeFileSync(path.join(BAK_DIR, "dom-mock-full-normal.html"), normal.dom);
        fs.writeFileSync(path.join(BAK_DIR, "dom-mock-full-reduced.html"), reduced.dom);
        const pN = extractProbe(normal.dom);
        const pR = extractProbe(reduced.dom);
        appendJsonl(RESULTS, { group: "A", id: "mock-probe-normal", pN });

        if (!pN) {
            row("A", "probe_json", "FAIL", "?probe=1 未产出 #probe-json",
                `dom_len=${normal.dom.length}`);
        } else {
            row("A", "probe_json", "PASS", "?probe=1 产出 #probe-json（mock 模式）", trunc(JSON.stringify(pN), 260));
        }

        // A2
        const ratioNum = typeof pN?.ratio === "number" ? pN.ratio : parseFloat(pN?.ratio);
        if (Number.isFinite(ratioNum)) {
            row("A", "A2", ratioNum >= 4 ? "PASS" : "FAIL",
                `display/body=${ratioNum}（≥4；@1180×780 应用窗口）`,
                `display=${pN.displayFont} body=${pN.bodyFont}`);
        } else {
            row("A", "A2", "FAIL", "probe 无 ratio", trunc(JSON.stringify(pN), 200));
        }

        // A4
        if (pR) {
            const statsN = domTextStats(normal.dom);
            const statsR = domTextStats(reduced.dom);
            const ratioTxt = statsN.textLen > 0 ? statsR.textLen / statsN.textLen : 0;
            const hiddenInline = countInlineHidden(reduced.dom);
            const okA4 = pR.reducedMotion === true && statsR.textLen > 200 && ratioTxt >= 0.7 && hiddenInline === 0;
            row("A", "A4", okA4 ? "PASS" : "FAIL",
                `reduced-motion: flag=${pR.reducedMotion} 文本 ${statsR.textLen}/${statsN.textLen}（${ratioTxt.toFixed(2)}）内联 opacity:0=${hiddenInline}`,
                `reduced probe=${trunc(JSON.stringify(pR), 200)}`);
        } else {
            row("A", "A4", "FAIL", "reduced-motion 下无 probe-json", "");
        }

        // A6
        const hitNum = typeof pN?.minHit === "number" ? pN.minHit : parseFloat(pN?.minHit);
        if (Number.isFinite(hitNum)) {
            row("A", "A6", hitNum >= 44 ? "PASS" : "FAIL", `minHit=${hitNum}px（≥44）`, `focusable=${pN?.focusableCount}`);
        } else {
            row("A", "A6", "FAIL", "probe 无 minHit", "");
        }
        row("A", "focusable_count", (pN?.focusableCount ?? 0) > 0 ? "PASS" : "FAIL", `focusableCount=${pN?.focusableCount}`, "");
    } catch (e) {
        row("A", "exception", "FAIL", "dom 预检异常", trunc(String(e.stack ?? e), 300));
    }

    // A3 CSS scan（mock 模式与真后端同一套 CSS 文件）
    try {
        const html = (await http(base + "/")).text;
        const cssFiles = [...html.matchAll(/<link[^>]+href=["']([^"']+\.css[^"']*)["']/gi)].map((m) => m[1]);
        const cssInline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
        let css = cssInline;
        for (const f of cssFiles) {
            const r = await http(base + (f.startsWith("/") ? f : "/" + f));
            if (r.status === 200) css += "\n" + r.text;
        }
        const accentDecls = [...css.matchAll(/--accent(?:-hover)?\s*:\s*([^;]+);/gi)].map((m) => m[1].trim());
        const uniqueAccents = [...new Set(accentDecls.map((s) => s.toLowerCase()))];
        const purpleHit = /#6366f1|#a855f7|6366f1|a855f7/i.test(css);
        const multiAccent = uniqueAccents.length > 2;
        row("A", "A3", !purpleHit && !multiAccent ? "PASS" : "FAIL",
            `accent=[${uniqueAccents.join(", ")}] 紫渐变=${purpleHit}`,
            `css_files=${cssFiles.length}`);
        appendJsonl(RESULTS, { group: "A", id: "A3.mock-detail", accentDecls, purpleHit, cssFiles });
    } catch (e) {
        row("A", "A3", "FAIL", "A3 扫描异常", trunc(String(e), 200));
    }

    // A5 focus traversal（CDP）
    try {
        const { CdpSession } = await import("./cdp.mjs");
        const cdp = await CdpSession.launch({ url: `${base}/?mock=1`, width: 1180, height: 780 });
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
        if (!arr.length) row("A", "A5", "BLOCKED", "无可见可聚焦元素", "");
        else row("A", "A5", noRing.length === 0 ? "PASS" : "FAIL",
            `可见可聚焦 ${arr.length} 个，无焦点环 ${noRing.length}`,
            noRing.length ? trunc(JSON.stringify(noRing), 240) : "全部有 outline/box-shadow 焦点样式");
        appendJsonl(RESULTS, { group: "A", id: "A5.mock-detail", arr });
        await cdp.close();
    } catch (e) {
        row("A", "A5", "BLOCKED", `CDP 不可用: ${trunc(String(e.message), 120)}`, "");
    }

    flush();
    try { mini.kill(); } catch { /* ignore */ }
    const c = R.counts;
    console.log(`\n[T5] dom_gate_mock done: PASS=${c.PASS} FAIL=${c.FAIL} BLOCKED=${c.BLOCKED}`);
    process.exitCode = c.FAIL > 0 ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
