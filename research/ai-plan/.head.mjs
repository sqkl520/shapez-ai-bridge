import fs from "fs";
import { buildHandles } from "../../src/agent/loop/handles.mjs";
import { exitCellOf, entryCellOf, exitDirOf, entryDirOf } from "../../src/agent/loop/topology.mjs";
const obs = JSON.parse(fs.readFileSync("research/ai-plan/.obs-live.json", "utf8"));
const h = buildHandles(obs, null);
const uidOf = n => {
    const e = [...h.byHandle.values()].find(x => x.handle === n);
    return e ? e.uid : null;
};
const hOf = uid => {
    const e = [...h.byHandle.values()].find(x => x.uid === uid);
    return e ? e.handle : "?";
};
const byUid = new Map(obs.entities.map(e => [e.uid, e]));
const atM = new Map(obs.entities.map(e => [e.x + "," + e.y, e]));

for (const n of ["B307", "B308", "B343", "B304", "B259"]) {
    const e = byUid.get(uidOf(n));
    if (!e) { console.log(n + ": MISSING"); continue; }
    console.log(n + " @(" + e.x + "," + e.y + ") r=" + e.r + " rv=" + e.rotation_variant);
    console.log("   entry=" + JSON.stringify(entryCellOf(e)) + " (" + entryDirOf(e) + ")  exit=" + JSON.stringify(exitCellOf(e)) + " (" + exitDirOf(e) + ")");
    const en = atM.get(entryCellOf(e).join(","));
    console.log("   entry cell has: " + (en ? en.type + "#" + en.uid + "(" + hOf(en.uid) + ")" : "EMPTY"));
    // check if that neighbor actually feeds us
    if (en && en.type === "belt") {
        const ee = exitCellOf(en);
        console.log("   does " + hOf(en.uid) + " exit into us? " + (ee[0] === e.x && ee[1] === e.y) + "  (its exit " + JSON.stringify(ee) + ")");
    }
}
