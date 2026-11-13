import fs from "fs";
import { buildHandles } from "../../src/agent/loop/handles.mjs";
import { exitCellOf, entryCellOf } from "../../src/agent/loop/topology.mjs";
const obs = JSON.parse(fs.readFileSync("research/ai-plan/.obs-live.json", "utf8"));
const h = buildHandles(obs, null);
const hOf = uid => {
    const e = [...h.byHandle.values()].find(x => x.uid === uid);
    return e ? e.handle : "?";
};
const atM = new Map(obs.entities.map(e => [e.x + "," + e.y, e]));
const uidOf = n => {
    const e = [...h.byHandle.values()].find(x => x.handle === n);
    return e ? e.uid : null;
};
// 从 B307 沿出口走到底 = 那条旧链
const chain = [];
let cur = atM.get("39,-11");
const seen = new Set();
while (cur && !seen.has(cur.uid) && chain.length < 300) {
    seen.add(cur.uid);
    chain.push({ h: hOf(cur.uid), x: cur.x, y: cur.y, uid: cur.uid });
    if (cur.type !== "belt") break;
    const nx = exitCellOf(cur);
    if (!nx) break;
    cur = atM.get(nx[0] + "," + nx[1]);
}
console.log("B307 chain length = " + chain.length);
console.log("  head: " + chain.slice(0, 4).map(c => c.h + "@(" + c.x + "," + c.y + ")").join(" "));
console.log("  tail: " + chain.slice(-4).map(c => c.h + "@(" + c.x + "," + c.y + ")").join(" "));
console.log("  uids: " + chain.map(c => c.uid).join(","));

// 这些格上有混进来的别的链吗（即在别的链上也被引用）
const cells = new Set(chain.map(c => c.x + "," + c.y));
console.log("");
console.log("chain touches cells: " + cells.size);
