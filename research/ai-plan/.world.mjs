import fs from "fs";
import { buildHandles } from "../../src/agent/loop/handles.mjs";
import { indexOf, flowReachable, runEnd } from "../../src/agent/loop/topology.mjs";

const obs = JSON.parse(fs.readFileSync("research/ai-plan/.obs-live.json", "utf8"));
const h = buildHandles(obs, null);
const idx = indexOf(obs);
const byUid = new Map(obs.entities.map(e => [e.uid, e]));
const at = new Map(obs.entities.map(e => [e.x + "," + e.y, e]));
const hOf = uid => {
    const e = [...h.byHandle.values()].find(x => x.uid === uid);
    return e ? e.handle : "?";
};

const hub = obs.entities.find(e => e.type === "hub");
console.log("hub @", hub ? `(${hub.x},${hub.y})` : "无");
console.log("goal:", JSON.stringify(obs.goal && obs.goal.requirement));

for (const t of ["mixer", "painter", "cutter", "rotater", "stacker"]) {
    const list = obs.entities.filter(e => e.type === t);
    if (!list.length) continue;
    console.log(`\n== ${t} (${list.length}) ==`);
    for (const e of list) {
        const d = hub ? Math.abs(e.x - hub.x) + Math.abs(e.y - hub.y) : 0;
        console.log(`  ${hOf(e.uid)} @(${e.x},${e.y}) r=${e.r} 距hub=${d}`);
    }
}

// 到 hub 的带子
const reach = flowReachable(obs, idx);
const belts = obs.entities.filter(e => e.type === "belt");
const ok = belts.filter(b => reach.has(b.uid));
console.log(`\n带子 ${belts.length} 条，通到 hub 的 ${ok.length} 条`);

// Cu 矿机在哪
const ore = new Map((obs.resources || []).map(r => [r[0] + "," + r[1], r[2]]));
console.log("\n== 矿机（按矿种） ==");
const byKind = new Map();
for (const m of obs.entities.filter(e => e.type === "miner")) {
    const k = ore.get(m.x + "," + m.y) || "(无矿)";
    const rec = byKind.get(k) || [];
    rec.push(`${hOf(m.uid)}@(${m.x},${m.y})`);
    byKind.set(k, rec);
}
for (const [k, v] of byKind) console.log(`  ${k}: ${v.join(" ")}`);
