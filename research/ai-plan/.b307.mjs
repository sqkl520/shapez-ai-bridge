import fs from "fs";
import { buildHandles } from "../../src/agent/loop/handles.mjs";
import { exitCellOf } from "../../src/agent/loop/topology.mjs";
import { slotsOf, beltRvOf } from "../../src/agent/verify_runtime.mjs";
const obs = JSON.parse(fs.readFileSync("research/ai-plan/.obs-live.json", "utf8"));
const atM = new Map(obs.entities.map(e => [e.x + "," + e.y, e]));
const h = buildHandles(obs, null);
const hOf = uid => {
    const e = [...h.byHandle.values()].find(x => x.uid === uid);
    return e ? e.handle : "?";
};
for (const k of ["39,-11", "40,-11", "40,-12", "40,-13"]) {
    const e = atM.get(k);
    if (!e) { console.log(k + " EMPTY"); continue; }
    const s = slotsOf(e.type, e.variant, e.x, e.y, e.r || 0, beltRvOf(e));
    console.log(k + ": " + hOf(e.uid) + " r=" + e.r + " rv=" + e.rotation_variant + " code=" + e.code);
    console.log("   slotsOf.outputs = " + JSON.stringify(s && s.outputs));
    try { console.log("   exitCellOf = " + JSON.stringify(exitCellOf(e))); } catch (err) { console.log("   exitCellOf THREW " + err.message); }
}
