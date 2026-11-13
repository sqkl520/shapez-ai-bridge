import fs from "fs";
import { buildHandles } from "../../src/agent/loop/handles.mjs";
import { indexOf, at, isBelt, exitCellOf, entryCellOf, flowReachable } from "../../src/agent/loop/topology.mjs";

const obs = JSON.parse(fs.readFileSync("research/ai-plan/.obs-live.json", "utf8"));
const idx = indexOf(obs);
const h = buildHandles(obs, null);
const hOf = uid => {
    const e = [...h.byHandle.values()].find(x => x.uid === uid);
    return e ? e.handle : "?";
};
const reach = flowReachable(obs, idx);
const belts = obs.entities.filter(e => e.type === "belt");
const dead = belts.filter(b => !reach.has(b.uid));
console.log("belts=" + belts.length + " reaching_hub=" + (belts.length - dead.length) + " dead=" + dead.length);

// 找出所有「入口格上的带子出口不指向本格」的断点
const bad = [];
for (const b of belts) {
    const en = at(idx, entryCellOf(b));
    if (!en) { bad.push({ b, why: "entry-empty" }); continue; }
    if (!isBelt(en)) continue;   // 机器喂的，不算
    const ex = exitCellOf(en);
    if (ex[0] !== b.x || ex[1] !== b.y) bad.push({ b, why: "neighbor-not-aimed", other: en });
}
console.log("broken breaks: " + bad.length);
for (const x of bad.slice(0, 30)) {
    console.log("  " + hOf(x.b.uid) + "@(" + x.b.x + "," + x.b.y + ") " + x.why + (x.other ? " <- " + hOf(x.other.uid) + "@(" + x.other.x + "," + x.other.y + ") exit to (" + exitCellOf(x.other) + ")" : ""));
}
