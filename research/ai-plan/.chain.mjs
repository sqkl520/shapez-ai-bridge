import fs from "fs";
import { buildHandles } from "../../src/agent/loop/handles.mjs";
import { indexOf, at, isBelt, exitCellOf } from "../../src/agent/loop/topology.mjs";
import { slotsOf, beltRvOf } from "../../src/agent/verify_runtime.mjs";

const obs = JSON.parse(fs.readFileSync("research/ai-plan/.obs-live.json", "utf8"));
const h = buildHandles(obs, null);
const hOf = uid => {
    const e = [...h.byHandle.values()].find(x => x.uid === uid);
    return e ? e.handle : "?";
};
const byUid = new Map(obs.entities.map(e => [e.uid, e]));
const atM = new Map(obs.entities.map(e => [e.x + "," + e.y, e]));
const ore = new Map((obs.resources || []).map(r => [r[0] + "," + r[1], r[2]]));

// M6 的位置与朝向
for (const mn of ["M6", "M2"]) {
    const e = byUid.get([...h.byHandle.values()].find(x => x.handle === mn).uid);
    console.log(mn + " @(" + e.x + "," + e.y + ") r=" + e.r + " ore=" + ore.get(e.x + "," + e.y));
}

// 沿 M6 的链看每一格
const trace = (startCell, label) => {
    console.log("");
    console.log("=== " + label + " ===");
    let cur = atM.get(startCell.join(","));
    const seen = new Set();
    for (let i = 0; i < 20 && cur; i++) {
        if (seen.has(cur.uid)) { console.log("  (loop)"); break; }
        seen.add(cur.uid);
        console.log("  " + cur.type + "#" + cur.uid + "(" + hOf(cur.uid) + ")@(" + cur.x + "," + cur.y + ")");
        if (cur.type !== "belt") break;
        const nx = exitCellOf(cur);
        cur = atM.get(nx[0] + "," + nx[1]);
    }
};
trace([36, -9], "M6 downstream from (36,-9)");
trace([38, -13], "M2 downstream from (38,-13)");
