/**
 * clock.mock.test.mjs — 用假桥测 gateClock 的各分支（不碰真游戏）。
 *
 * 为什么必须离线测：要验证"时钟冻结"的判据，不能真把游戏时钟弄坏 ——
 * 那会让存档永久读不回来（paused/fast-forward 未注册进序列化工厂）。
 * 所以起一个本地 HTTP 假桥，返回各种 debug_loop 响应。
 *
 * 每个假桥场景都带一个"必须绿"的对照（healthy），
 * 否则测不出判据是在真判断还是恒红。
 *
 * 用法：node src/agent/clock.mock.test.mjs
 * 退出码：0 全过 / 1 有失败
 */
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATES = pathToFileURL(path.join(HERE, "gates.mjs")).href;

const scenarios = {
    // 健康的时钟：推进 600 tick 真的走了 5 游戏秒
    healthy: { loop: { tick: 100, speed: "regular", logic_budget_ms: 8 }, after: { tick: 105 }, expect: true },
    // A1 的真实形态：NaN 经 JSON 变成 null
    budget_null: { loop: { tick: 100, speed: "regular", logic_budget_ms: null }, after: { tick: 105 }, expect: false },
    // paused 会让存档读不回来，必须拒
    paused: { loop: { tick: 100, speed: "paused", logic_budget_ms: 0 }, after: { tick: 105 }, expect: false },
    fast_forward: { loop: { tick: 100, speed: "fast_forward", logic_budget_ms: 8 }, after: { tick: 105 }, expect: false },
    // ★ 半冻结：step 请求 600 tick 但只走了 0.01 秒。
    //   旧判据是 `advanced > 0`，环境 tick（0.025/次）就能满足 → 假绿。
    half_frozen: { loop: { tick: 100, speed: "regular", logic_budget_ms: 8 }, after: { tick: 100.01 }, expect: false },
    // 完全没走
    fully_frozen: { loop: { tick: 100, speed: "regular", logic_budget_ms: 8 }, after: { tick: 100 }, expect: false },
};

let pass = 0, fail = 0;
const failures = [];

for (const [name, sc] of Object.entries(scenarios)) {
    let callIdx = 0;
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", c => body += c);
        req.on("end", () => {
            res.setHeader("content-type", "application/json");
            let result = {};
            try {
                const m = JSON.parse(body).method;
                if (m === "debug_loop") {
                    // 第一次返回起点，之后返回推进后的
                    result = callIdx++ === 0 ? sc.loop : { ...sc.loop, ...sc.after };
                } else if (m === "act") {
                    result = { ok: true, op: "step", ticks_run: 600 };
                }
            } catch (e) { /* 忽略 */ }
            res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
        });
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    // gates.mjs 的 BASE 是模块加载时读的环境变量，所以每个场景重新 import
    const prev = process.env.SHAPEZ_BRIDGE_URL;
    process.env.SHAPEZ_BRIDGE_URL = `http://127.0.0.1:${port}`;
    const mod = await import(GATES + "?scenario=" + name);
    const r = await mod.gateClock(600);
    if (prev === undefined) delete process.env.SHAPEZ_BRIDGE_URL; else process.env.SHAPEZ_BRIDGE_URL = prev;
    server.close();

    const got = r.ok === true;
    if (got === sc.expect) {
        pass++;
        console.log(`✓ ${name.padEnd(13)} → ${got ? "GREEN" : "RED"}（符合预期）`);
    } else {
        fail++;
        failures.push(name);
        console.log(`✗ ${name.padEnd(13)} → ${got ? "GREEN" : "RED"}（期望 ${sc.expect ? "GREEN" : "RED"}）: ${r.reason || ""}`);
    }
}

console.log("\n" + "═".repeat(60));
console.log(`clock mock 自测：${pass} 通过 / ${fail} 失败`);
if (fail) for (const f of failures) console.log("  ✗ " + f);
process.exit(fail ? 1 : 0);
