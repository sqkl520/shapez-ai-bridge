/**
 * G-1 时钟闸的**真跑**验证 —— 用本地假桥，绝不碰真游戏的时钟。
 *
 * gates.mjs 在模块加载时读 process.env.SHAPEZ_BRIDGE_URL，
 * 所以先起一个 127.0.0.1 的假 RPC 服务，再 import，就能把各种"坏时钟"喂给它。
 */
import http from "node:http";

let scenario = "healthy";
let fakeTick = 1000;

const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
        const { method, params, id } = JSON.parse(body);
        const reply = obj => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id, result: obj }));
        };
        if (method === "debug_loop") {
            if (scenario === "healthy") return reply({ tick: fakeTick, speed: "regular", logic_budget_ms: 8.3 });
            if (scenario === "budget_null") return reply({ tick: 1000, speed: "regular", logic_budget_ms: null });
            if (scenario === "budget_undef") return reply({ tick: 1000, speed: "regular", time_error: "boom" });
            if (scenario === "paused") return reply({ tick: 1000, speed: "paused", logic_budget_ms: 0 });
            if (scenario === "fast_forward") return reply({ tick: 1000, speed: "fast_forward", logic_budget_ms: 8 });
            if (scenario === "weird_speed") return reply({ tick: 1000, speed: "warp-9", logic_budget_ms: 8 });
            if (scenario === "frozen") return reply({ tick: 1000, speed: "regular", logic_budget_ms: 8 });
            if (scenario === "step_rejected") return reply({ tick: 1000, speed: "regular", logic_budget_ms: 0 });
        }
        if (method === "act") {
            if (scenario === "healthy") fakeTick += params.ticks;
            if (scenario === "step_rejected") {
                res.writeHead(200, { "content-type": "application/json" });
                return res.end(JSON.stringify({
                    jsonrpc: "2.0", id,
                    error: { code: 2002, name: "game_rejected", message: "game logic is paused by an open dialog/overlay; step would not advance" },
                }));
            }
            return reply({ ok: true, op: "step", ticks_run: params.ticks });
        }
        reply({});
    });
});

await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
process.env.SHAPEZ_BRIDGE_URL = `http://127.0.0.1:${port}`;

const { gateClock } = await import(
    "file:///D:/Projects/rea/Project%20work/shapez/src/agent/gates.mjs");

const bar = "─".repeat(64);
for (const s of ["healthy", "budget_null", "budget_undef", "paused",
    "fast_forward", "weird_speed", "frozen", "step_rejected"]) {
    scenario = s;
    let r;
    try { r = await gateClock(30); } catch (e) { r = { thrown: String(e) }; }
    console.log(`\n${bar}\n场景 ${s}`);
    console.log("ok     :", r.ok);
    console.log("reason :", r.reason ?? "(null)");
    console.log("evidence:", JSON.stringify(r.evidence));
    if (r.hint) console.log("hint   :", r.hint);
}
server.close();
