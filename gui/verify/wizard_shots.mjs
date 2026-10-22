/**
 * T5 · 关键截图（G2）+ F3 后端断开横幅 —— CDP 驱动真实交互。
 *
 * 用法: node gui/verify/wizard_shots.mjs [--port 7804]
 *
 * 产出（docs/gui/）:
 *   01-first-run.png     首启向导 W1（fresh state）
 *   02-env-check.png     向导 W2 环境检查
 *   03-install-done.png  安装完成（点装后的完成态）
 *   04-config.png        配置页（W4 或设置视图）
 *   05-console-logs.png  运行中 + 日志（桥接启动后 console 视图）
 *   06-F3-banner.png     杀后端 → 断开横幅
 *
 * 依赖: T3 冻结接口 window.GUI.showView/confirm/toast（§3.7）。驱动失败处逐级降级
 * （点击文本匹配按钮 → 直接调 api → 仅导航截图），每步尽力而为并记录。
 */
import fs from "node:fs";
import path from "node:path";
import {
    ROOT, DOCS_GUI, BAK_DIR, http, sleep, waitUntil, probePort, startGui, fetchGuiToken,
    Recorder, writeSection, appendJsonl, trunc, readText,
} from "./lib.mjs";
import { CdpSession, waitForGuiHook } from "./cdp.mjs";

const args = process.argv.slice(2);
const argVal = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = parseInt(argVal("--port", "7804"), 10);

const R = new Recorder("wizard_shots");
const RESULTS = path.join(BAK_DIR, "shots.jsonl");
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
    writeSection(VERIFICATION, "sec-shots", "截图与 F3（CDP 交互）", body);
}

const GUISTATE = path.join(ROOT, "gui", ".gui-state.json");
const SHOT = {
    first: path.join(DOCS_GUI, "01-first-run.png"),
    env: path.join(DOCS_GUI, "02-env-check.png"),
    installed: path.join(DOCS_GUI, "03-install-done.png"),
    config: path.join(DOCS_GUI, "04-config.png"),
    console: path.join(DOCS_GUI, "05-console-logs.png"),
    f3: path.join(DOCS_GUI, "06-F3-banner.png"),
};

/** Click first visible element whose text matches re. Returns true if clicked. */
async function clickByText(cdp, re) {
    return cdp.eval(`(() => {
    const rx = new RegExp(${JSON.stringify(re)}, 'i');
    const candidates = [...document.querySelectorAll('button, a, [role=button], .btn, summary, label')];
    const el = candidates.find(e => rx.test((e.textContent||'').trim()) && e.offsetParent !== null && !e.disabled);
    if (!el) return false;
    el.scrollIntoView({block:'center'});
    el.click();
    return true;
  })()`);
}

async function main() {
    // snapshot state so the wizard stays fresh after our run
    const stateBefore = fs.existsSync(GUISTATE) ? readText(GUISTATE) : null;
    const CONFIG = path.join(ROOT, "bridge.config.json");
    const configBefore = fs.existsSync(CONFIG) ? readText(CONFIG) : null;
    const restoreState = () => {
        if (stateBefore === null) { if (fs.existsSync(GUISTATE)) fs.rmSync(GUISTATE, { force: true }); }
        else fs.writeFileSync(GUISTATE, stateBefore);
        if (configBefore === null) { if (fs.existsSync(CONFIG)) fs.rmSync(CONFIG, { force: true }); }
        else fs.writeFileSync(CONFIG, configBefore);
    };

    if (await probePort(PORT)) { console.error(`[shots] port ${PORT} busy — abort`); process.exit(2); }
    const gui = await startGui({ port: PORT });
    if (!gui.ready) { row("S", "ready", "FAIL", "GUI 未就绪", gui.stderr.slice(-300)); flush(); process.exit(1); }
    const tok = await fetchGuiToken(gui.url);

    let cdp = null;
    try {
        cdp = await CdpSession.launch({ url: gui.url + "/", width: 1440, height: 960 });
        await cdp.send("Page.enable");
        await cdp.send("Runtime.enable");
        const hookOk = await waitForGuiHook(cdp);
        row("SHOT", "hook", hookOk ? "PASS" : "FAIL",
            hookOk ? "window.GUI 钩子存在（T3 §3.7 契约）" : "window.GUI 钩子缺失（T3 契约违约）", "");

        // ---- 01 first run (wizard W1) ----
        // ensure fresh wizard: clear state & reload
        if (hookOk) {
            await cdp.eval(`(() => { try { localStorage.clear(); } catch {} return true; })()`);
        }
        await cdp.navigate(gui.url + "/", { waitMs: 2500 });
        await sleep(1200);
        await cdp.screenshot(SHOT.first);
        const w1Text = await cdp.eval(`(document.querySelector('#view-wizard')||document.body).innerText.slice(0,400)`);
        row("SHOT", "01-first-run", fs.existsSync(SHOT.first) ? "PASS" : "FAIL",
            "首启向导静帧", trunc(String(w1Text).replace(/\n+/g, " / "), 240));
        appendJsonl(RESULTS, { group: "SHOT", id: "01.text", text: w1Text });

        // ---- 02 env check (W2): click[开始/下一步/继续] then wait env ----
        let clicked = await clickByText(cdp, "开始|继续|下一步|安装|start|begin");
        if (!clicked) clicked = await clickByText(cdp, "详情|下一步|next");
        await sleep(2500); // env check runs async
        await cdp.screenshot(SHOT.env);
        const w2Text = await cdp.eval(`(document.body).innerText.slice(0, 600)`);
        row("SHOT", "02-env-check", fs.existsSync(SHOT.env) ? "PASS" : "FAIL",
            `环境检查步（clicked=${clicked}）`, trunc(String(w2Text).replace(/\n+/g, " / "), 260));

        // ---- 03 install done (W3): find install button and click; wait for done ----
        // Prefer API-direct to make it deterministic; UI state will follow SSE.
        const token = tok.token;
        const instResp = await http(gui.url + "/api/install", {
            method: "POST", headers: { "X-GUI-Token": token }, body: {}, timeoutMs: 60000,
        });
        await sleep(1500);
        // try to advance wizard to the install step first, so the completion card is visible
        for (let i = 0; i < 4; i++) {
            const c = await clickByText(cdp, "安装|下一步|继续|install");
            if (!c) break;
            await sleep(1600);
        }
        await cdp.screenshot(SHOT.installed);
        row("SHOT", "03-install-done", fs.existsSync(SHOT.installed) ? "PASS" : "FAIL",
            `安装完成态（api install ok=${instResp.json?.ok}）`, `exit_code=${instResp.json?.exit_code}`);

        // ---- 04 config view ----
        if (hookOk) {
            const shown = await cdp.eval(`(() => { try { window.GUI.showView('settings'); return true; } catch (e) { return String(e); } })()`);
            await sleep(1200);
            if (shown !== true) {
                // fallback: wizard step navigation
                await clickByText(cdp, "配置|设置|config|settings");
                await sleep(1000);
            }
        }
        await cdp.screenshot(SHOT.config);
        const cfgText = await cdp.eval(`(document.body).innerText.slice(0, 400)`);
        row("SHOT", "04-config", fs.existsSync(SHOT.config) ? "PASS" : "FAIL",
            "配置页静帧", trunc(String(cfgText).replace(/\n+/g, " / "), 220));

        // ---- 05 console + logs: start bridge (auto-configured port), show console ----
        // Configure GUI bridge to a free port first (7777 is externally owned!)
        const { findFreePort } = await import("./lib.mjs");
        const freeP = await findFreePort(7896);
        await http(gui.url + "/api/config", {
            method: "POST", headers: { "X-GUI-Token": token },
            body: { port: freeP, token: null, read_only: false, snapshot_dir: "./snapshots", log_level: "info", rpc_timeout_ms: 30000, long_timeout_ms: 180000 },
        });
        const startResp = await http(gui.url + "/api/bridge/start", {
            method: "POST", headers: { "X-GUI-Token": token }, body: {}, timeoutMs: 30000,
        });
        await sleep(2500); // let SSE push logs
        if (hookOk) {
            await cdp.eval(`(() => { try { window.GUI.showView('console'); return true; } catch (e) { return String(e); } })()`);
        }
        await sleep(2000);
        await cdp.screenshot(SHOT.console);
        const conText = await cdp.eval(`(document.body).innerText.slice(0, 500)`);
        row("SHOT", "05-console-logs", fs.existsSync(SHOT.console) ? "PASS" : "FAIL",
            `console+日志（bridge start ok=${startResp.json?.ok}）`, trunc(String(conText).replace(/\n+/g, " / "), 240));

        // ---- 06 F3: kill GUI backend while page open → banner ----
        // stop the bridge gracefully first so no orphan process is left
        await http(gui.url + "/api/bridge/stop", { method: "POST", headers: { "X-GUI-Token": token }, body: {} }).catch(() => {});
        await sleep(600);
        // close SSE from server side by killing server; page must show disconnect banner
        await gui.stop();
        // wait for EventSource error + banner logic (retry 3000 → give it ~9s)
        let bannerSeen = false;
        try {
            await waitUntil(async () => {
                const txt = await cdp.eval(`document.body.innerText`);
                return /断开|已停止|重连|disconnect|offline|lost/i.test(txt);
            }, { timeoutMs: 12000, stepMs: 500, label: "F3 banner" });
            bannerSeen = true;
        } catch { bannerSeen = false; }
        await cdp.screenshot(SHOT.f3);
        const f3Text = await cdp.eval(`document.body.innerText.slice(0, 300)`);
        row("F", "F3", bannerSeen && fs.existsSync(SHOT.f3) ? "PASS" : "FAIL",
            bannerSeen ? "杀后端后 UI 出现断开提示（横幅）" : "杀后端后 12s 内未见断开提示文案",
            `body_text=${trunc(String(f3Text).replace(/\n+/g, " / "), 240)}`);
    } catch (e) {
        row("SHOT", "exception", "FAIL", "截图流程异常", trunc(String(e.stack ?? e), 400));
    } finally {
        try { await cdp?.close(); } catch { /* ignore */ }
        // GUI may already be stopped (F3) — stop if still alive
        try { await gui.stop(); } catch { /* ignore */ }
        // bridge child cleanup: if bridge still running under a dead GUI, stop it by port
        restoreState();
    }

    flush();
    const c = R.counts;
    console.log(`\n[T5] wizard_shots done: PASS=${c.PASS} FAIL=${c.FAIL} BLOCKED=${c.BLOCKED}`);
    console.log(`[T5] shots in ${DOCS_GUI}`);
    process.exitCode = c.FAIL > 0 ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
