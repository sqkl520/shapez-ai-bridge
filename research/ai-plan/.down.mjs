import fs from "fs";
import { buildHandles } from "../../src/agent/loop/handles.mjs";
import { indexOf, at, exitCellOf } from "../../src/agent/loop/topology.mjs";

const obs = JSON.parse(fs.readFileSync("research/ai-plan/.obs-live.json", "utf8"));
const h = buildHandles(obs, null);
const uidOf = n => {
    const e = [...h.byHandle.values()].find(x => x.handle === n);
    return e ? e.uid : null;
};
const byUid = new Map(obs.entities.map(e => [e.uid, e]));
const atM = new Map(obs.entities.map(e => [e.x + "," + e.y, e]));
const hOf = uid => {
    const e = [...h.byHandle.values()].find(x => x.uid === uid);
    return e ? e.handle : "?";
};

// 从 M6 / M2 各自的输出格往下游追
for (const mn of ["M6", "M2"]) {
    const m = byUid.get(uidOf(mn));
    console.log(`\n=== ${mn} @(${m.x},${m.y}) r=${m.r} 下游 ===`);
    // miner 输出格：按其 r 方向
    const exitCellOfMiner = (e) => {
        const D = [[0, -1], [1, 0], [0, 1], [-1, 0]];
        const r = ((e.r % 360) + 360) % 360;
        const idx = r === 0 ? 0 : r === 90 ? 1 : r === 180 ? 2 : 3;
        return [e.x + D[idx][0], e.y + D[idx][1]];
    };
    let cur = atM.get(exitCellOfMiner(m).join(","));
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
        if (!cur) { console.log("  （输出格是空）"); break; }
        if (seen.has(cur.uid)) { console.log("  (环)"); break; }
        seen.add(cur.uid);
        console.log(`  ${cur.type}#${cur.uid}(${hOf(cur.uid)})@(${cur.x},${cur.y}) r=${cur.r} rv=${cur.rotation_variant}`);
        if (cur.type !== "belt") break;
        const nx = exitCellOf(cur);
        cur = atM.get(nx[0] + "," + nx[1]);
    }
}
