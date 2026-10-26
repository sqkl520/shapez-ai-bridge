/**
 * 用假桥跑完整 runGates(--apply)，观察闸之间的短路关系。
 *
 * 假桥刻意**忠实模拟真实游戏**的 obs 语义：每台建筑只报一条记录（原点），
 * 多格机器（cutter 2×1）不额外报第二格。
 * 这是我从真实游戏 obs 里实测到的行为（cutter@-8,-11 右格没有 obs 条目）。
 *
 * 目的：证明 G4 在这种真实语义下必定红，从而 G6b / G6 根本不会被执行。
 */
import http from "node:http";
import fs from "node:fs";

const intent = JSON.parse(fs.readFileSync(
    "D:/Projects/rea/Project work/shapez/research/ai-plan/tmp/RuRu----.anchor40-60.intent.json", "utf8"));

const a = intent.anchor;
let tick = 1000;
let pasted = false;
let uidSeq = 50000;

// 贴前就存在的旧带子
const oldBelt = { uid: 9001, type: "belt", x: 0, y: 0, r: 0, code: 1, layer: "regular" };

// 真游戏语义：每台机器一条 obs 记录，坐标 = 原点
const newEntities = intent.entities.map(e => ({
    uid: uidSeq++, type: e.kind, x: a[0] + e.dx, y: a[1] + e.dy,
    r: e.rot | 0, code: e.code, layer: "regular",
}));

const beltCells = intent.entities.filter(e => e.kind === "belt" || e.kind === "underground_belt")
    .map(e => [a[0] + e.dx, a[1] + e.dy]);

const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
        const { method, params, id } = JSON.parse(body);
        const send = obj => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id, result: obj }));
        };
        if (method === "debug_loop") return send({ tick, speed: "regular", logic_budget_ms: 8 });
        if (method === "act") {
            if (params.op === "step") { tick += params.ticks; return send({ ok: true, ticks_run: params.ticks }); }
            if (params.op === "paste_blueprint" && params.dry_run) {
                return send({ would_apply: intent.entities.length, would_delete: 0, blocked: [], destroys: [] });
            }
            if (params.op === "paste_blueprint") { pasted = true; return send({ applied: intent.entities.length, count: intent.entities.length, failed: [] }); }
            if (params.op === "bulk_delete") return send({ would_delete: 0, applied: 0 });
            return send({ ok: true });
        }
        if (method === "obs") {
            const entities = [oldBelt, ...(pasted ? newEntities : [])];
            return send({
                entities, entity_count: entities.length, truncated: false, tick,
                goal: { requirement: { shape: intent.goal }, upgrade_levels: {} },
                hub: {}, speed: "regular", paused: false,
            });
        }
        // 完全健康的连通 & 产量（用来证明只有 G4 在挡）
        if (method === "debug_items") {
            return send({ paths: [{ cells: beltCells, itemsOnPath: 5, boundAcceptor: { x: 0, y: 0, type: "hub" } }] });
        }
        if (method === "production") {
            const w = params.slices * 10;
            return send({ window_seconds: w, delivered_per_sec: { [intent.goal]: 5.0 } });
        }
        send({});
    });
});

await new Promise(r => server.listen(0, "127.0.0.1", r));
process.env.SHAPEZ_BRIDGE_URL = `http://127.0.0.1:${server.address().port}`;

const { runGates } = await import(
    "file:///D:/Projects/rea/Project%20work/shapez/src/agent/gates.mjs");

console.log(`intent: goal=${intent.goal} 实体数=${intent.entities.length} `
    + `(miner=${intent.entities.filter(e => e.kind === "miner").length}`
    + ` cutter=${intent.entities.filter(e => e.kind === "cutter").length})`);
console.log("假桥：连通全好、产量 5.0/s（远超阈值），唯一的问题是 obs 语义与真实游戏一致\n");

const res = await runGates(intent, { apply: true, probeTicks: 60, settleTicks: 60, sampleTicks: 60 });
console.log("最终 ok =", res.ok);
console.log("执行到的闸：");
for (const r of res.results) {
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.id}` + (r.reason ? `  — ${r.reason}` : ""));
}
const ran = new Set(res.results.map(r => r.id));
console.log("\nG6b 是否被执行:", ran.has("G6b-connectivity"));
console.log("G6  是否被执行:", ran.has("G6-behavior"));
server.close();
