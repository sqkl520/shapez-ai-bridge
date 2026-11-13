import fs from "fs";
import { buildHandles } from "../../src/agent/loop/handles.mjs";
const obs = JSON.parse(fs.readFileSync("research/ai-plan/.obs-live.json", "utf8"));
const h = buildHandles(obs, null);
const hOf = uid => {
    const e = [...h.byHandle.values()].find(x => x.uid === uid);
    return e ? e.handle : "?";
};
const cell = new Map();
for (const e of obs.entities) {
    if (e.type !== "belt" && e.type !== "underground_belt") continue;
    const k = e.x + "," + e.y;
    if (!cell.has(k)) cell.set(k, []);
    cell.get(k).push(e);
}
console.log("duplicate cells (belt):");
for (const [k, list] of cell) {
    if (list.length > 1) {
        console.log("  " + k + ": " + list.map(e => e.type + "#" + e.uid + "(" + hOf(e.uid) + ") r=" + e.r).join("  "));
    }
}
console.log("");
console.log("total belts:", obs.entities.filter(e => e.type === "belt" || e.type === "underground_belt").length);
console.log("unique cells:", cell.size);
// 检查 (34,-11) 附近
for (const k of ["34,-11", "34,-10", "34,-12", "35,-11", "35,-12"]) {
    const l = cell.get(k) || [];
    console.log(k + ": " + (l.length ? l.map(e => e.type + "#" + e.uid + "(" + hOf(e.uid) + ") r=" + e.r + " rv=" + e.rotation_variant).join("  ") : "EMPTY"));
}
