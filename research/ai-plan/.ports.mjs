import fs from "fs";
import { buildHandles } from "../../src/agent/loop/handles.mjs";
import { exitCellOf, exitDirOf } from "../../src/agent/loop/topology.mjs";
import { slotsOf, beltRvOf } from "../../src/agent/verify_runtime.mjs";
const obs = JSON.parse(fs.readFileSync("research/ai-plan/.obs-live.json", "utf8"));
const h = buildHandles(obs, null);
const hOf = uid => {
    const e = [...h.byHandle.values()].find(x => x.uid === uid);
    return e ? e.handle : "?";
};
const atM = new Map(obs.entities.map(e => [e.x + "," + e.y, e]));
for (const n of ["M3", "B307", "B357", "B343", "B304", "B259", "B356"]) {
    const rec = [...h.byHandle.values()].find(x => x.handle === n);
    if (!rec) { console.log(n + " MISSING"); continue; }
    const e = obs.entities.find(x => x.uid === rec.uid);
    const s = slotsOf(e.type, e.variant, e.x, e.y, e.r || 0, beltRvOf(e));
    console.log(n + " " + e.type + " @(" + e.x + "," + e.y + ") r=" + e.r + " rv=" + e.rotation_variant);
    if (s && s.outputs) for (const o of s.outputs) {
        const t = atM.get(o.cell.join(","));
        console.log("   OUT " + o.role + " dir=" + o.dir + " cell=" + JSON.stringify(o.cell) + " -> " + (t ? t.type + "(" + hOf(t.uid) + ")" : "EMPTY"));
    }
    if (s && s.inputs) for (const o of s.inputs) {
        const t = atM.get(o.cell.join(","));
        console.log("   IN  " + o.role + " dir=" + o.dir + " cell=" + JSON.stringify(o.cell) + " <- " + (t ? t.type + "(" + hOf(t.uid) + ")" : "EMPTY"));
    }
}
