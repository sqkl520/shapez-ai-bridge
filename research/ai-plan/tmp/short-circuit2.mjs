/**
 * 第二个独立阻塞点：假设 G4 的 obs 语义被修好（每格一条记录），
 * 看 --apply 能不能绿。用来区分"G4 是唯一问题"还是"后面还有问题"。
 */
import http from "node:http";
import fs from "node:fs";

const intent = JSON.parse(fs.readFileSync(
    "D:/Projects/rea/Project work/shapez/research/ai-plan/tmp/RuRu----.anchor40-60.intent.json", "utf8"));
const a = intent.anchor;

// 与 gate 期望一致：按 footprint 展开，每格一条 obs（现实中游戏不会这样报）
const FOOTPRINT = { hub: [4, 4], miner: [2, 1], cutter: [2, 1], trash: [1, 1], belt: [1, 1] };
let uidSeq = 50000;
const newEntities = [];
for (const e of intent.entities) {
    const wx = a[0] + e.dx, wy = a[1] + e.dy;
    let [w, h] = FOOTPRINT[e.kind] || [1, 1];
    if (e.rot === 90 || e.rot === 270) [w, h] = [h, w];
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) {
        newEntities.push({ uid: uidSeq++, type: e.kind, x: wx + dx, y: wy + dy, r: e.rot | 0, code: e.code, layer: "regular" });
    }
}
const beltCells = intent.entities.filter(e => e.kind === "belt").map(e => [a[0] + e.dx, a[1] + e.dy]);

let tick = 1000, pasted = false, prodCalls = 0;
const oldBelt = { uid: 9001, type: "belt", x: 0, y: 0, r: 0, code: 1, layer: "regular" };

const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
        const { method, params, id } = JSON.parse(body);
        const send = o => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id, result: o })); };
        if (method === "debug_loop") return send({ tick, speed: "regular", logic_budget_ms: 8 });
        if (method === "act") {
            if (params.op === "step") { tick += params.ticks; return send({ ok: true, ticks_run: params.ticks }); }
            if (params.op === "paste_blueprint" && params.dry_run)
                return send({ would_apply: intent.entities.length, would_delete: 0, blocked: [], destroys: [] });
            if (params.op === "paste_blueprint") { pasted = true; return send({ applied: intent.entities.length, count: intent.entities.length, failed: [] }); }
            if (params.op === "bulk_delete") return send({ would_delete: newEntities.length, applied: 0 });
            return send({ ok: true });
        }
        if (method === "obs") {
            const entities = [oldBelt, ...(pasted ? newEntities : [])];
            return send({ entities, entity_count: entities.length, truncated: false, tick,
                goal: { requirement: { shape: intent.goal }, upgrade_levels: {} }, hub: {}, speed: "regular", paused: false });
        }
        if (method === "debug_items")
            return send({ paths: [{ cells: beltCells, itemsOnPath: 5, boundAcceptor: [0, 0] }], pathCount: 1 });
        if (method === "production") {
            prodCalls++;
            // 真实桥语义：window_seconds = slices * 10，恒定
            return send({ window_seconds: params.slices * 10, delivered_per_sec: { [intent.goal]: 5.0 + prodCalls } });
        }
        send({});
    });
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
process.env.SHAPEZ_BRIDGE_URL = `http://127.0.0.1:${server.address().port}`;
const { runGates } = await import("file:///D:/Projects/rea/Project%20work/shapez/src/agent/gates.mjs");

const res = await runGates(intent, { apply: true, probeTicks: 60, settleTicks: 60, sampleTicks: 60 });
console.log("G4 已满足（每格一条 obs）时的完整 --apply 结果：");
console.log("最终 ok =", res.ok, "\n");
for (const r of res.results) console.log(`  ${r.ok ? "✓" : "✗"} ${r.id}` + (r.reason ? `  — ${r.reason}` : ""));
server.close();
