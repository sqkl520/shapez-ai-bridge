import fs from "fs";
import { slotsOf, beltRvOf } from "../../src/agent/verify_runtime.mjs";
import { exitCellOf, exitDirOf } from "../../src/agent/loop/topology.mjs";
import { buildHandles } from "../../src/agent/loop/handles.mjs";

const obs = JSON.parse(fs.readFileSync("research/ai-plan/.obs-live.json", "utf8"));
const byUid = new Map(obs.entities.map(e => [e.uid, e]));
const atM = new Map(obs.entities.map(e => [e.x + "," + e.y, e]));
const h = buildHandles(obs, null);
const uidOf = n => {
    const e = [...h.byHandle.values()].find(x => x.handle === n);
    return e ? e.uid : null;
};
const hOf = uid => {
    const e = [...h.byHandle.values()].find(x => x.uid === uid);
    return e ? e.handle : "?";
};

const mixer = byUid.get(uidOf("C7"));
const s = slotsOf(mixer.type, mixer.variant, mixer.x, mixer.y, mixer.r || 0, beltRvOf(mixer));
for (let i = 0; i < 2; i++) {
    const sl = s.inputs[i];
    const up = atM.get(sl.cell.join(","));
    console.log("");
    console.log("slot " + i + ": cell=" + JSON.stringify(sl.cell) + " slot=" + JSON.stringify(sl.slot) + " dir=" + sl.dir);
    if (!up) { console.log("  feed cell EMPTY"); continue; }
    const ex = exitCellOf(up);
    console.log("  feed belt: " + hOf(up.uid) + "@(" + up.x + "," + up.y + ") r=" + up.r + " rv=" + up.rotation_variant);
    console.log("    exitDir = " + exitDirOf(up));
    console.log("    exitCell = " + JSON.stringify(ex) + "  expect " + JSON.stringify(sl.slot));
    console.log("    aimed = " + (ex && ex[0] === sl.slot[0] && ex[1] === sl.slot[1]));
}
