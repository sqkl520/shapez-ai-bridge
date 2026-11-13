import fs from "fs";
import { buildHandles } from "../../src/agent/loop/handles.mjs";
import { indexOf, at, isBelt, exitCellOf, flowReachable } from "../../src/agent/loop/topology.mjs";
import { slotsOf, beltRvOf } from "../../src/agent/verify_runtime.mjs";

const obs = JSON.parse(fs.readFileSync("research/ai-plan/.obs-live.json", "utf8"));
const h = buildHandles(obs, null);
const idx = indexOf(obs);
const byUid = new Map(obs.entities.map(e => [e.uid, e]));
const atM = new Map(obs.entities.map(e => [e.x + "," + e.y, e]));
const hOf = uid => {
    const e = [...h.byHandle.values()].find(x => x.uid === uid);
    return e ? e.handle : "?";
};
const uidOf = name => {
    const e = [...h.byHandle.values()].find(x => x.handle === name);
    return e ? e.uid : null;
};

// mixer C7 的端口
const c7 = byUid.get(uidOf("C7"));
const s = slotsOf(c7.type, c7.variant, c7.x, c7.y, c7.r || 0, beltRvOf(c7));
console.log("C7 @", c7.x, c7.y);
console.log("  inputs:", JSON.stringify(s.inputs));
console.log("  outputs:", JSON.stringify(s.outputs));
for (const o of s.outputs || []) {
    const e = atM.get(o.cell[0] + "," + o.cell[1]);
    console.log("   out cell", JSON.stringify(o.cell), "->", e ? `${e.type}#${e.uid}(${hOf(e.uid)})` : "空");
}

// C7 的输出往下游追到哪
console.log("\n=== 从 C7 输出追下游 ===");
let cur = atM.get(s.outputs[0].cell[0] + "," + s.outputs[0].cell[1]);
const seen = new Set();
let steps = 0;
while (cur && steps < 80 && !seen.has(cur.uid)) {
    seen.add(cur.uid);
    if (cur.type === "belt") {
        const nx = exitCellOf(cur);
        const n = atM.get(nx[0] + "," + nx[1]);
        if (!n) { console.log(`  ${hOf(cur.uid)}@(${cur.x},${cur.y}) -> 断头 (${nx})`); break; }
        if (n.type !== "belt") { console.log(`  ${hOf(cur.uid)}@(${cur.x},${cur.y}) -> ${n.type}#${n.uid}(${hOf(n.uid)})@(${n.x},${n.y})`); break; }
        cur = n;
    } else {
        console.log(`  ${cur.type}#${cur.uid}(${hOf(cur.uid)})@(${cur.x},${cur.y})`);
        break;
    }
    steps++;
}

// hub 附近能放 mixer 的空地
console.log("\n=== hub 附近（距 hub <= 20）的机器 ===");
const hub = obs.entities.find(e => e.type === "hub");
for (const e of obs.entities) {
    if (e.type === "belt" || e.type === "hub") continue;
    const d = Math.abs(e.x - hub.x) + Math.abs(e.y - hub.y);
    if (d <= 20) console.log(`  ${hOf(e.uid)} ${e.type} @(${e.x},${e.y}) r=${e.r} d=${d}`);
}

// 那条 106 格的线是什么
console.log("\n=== 槽0 的 106 格线，源头 B307 ===");
const b307 = byUid.get(uidOf("B307"));
const b343 = byUid.get(uidOf("B343"));
console.log("B307:", b307 ? `@(${b307.x},${b307.y}) r=${b307.r}` : "无");
console.log("B343:", b343 ? `@(${b343.x},${b343.y}) r=${b343.r}` : "无");
