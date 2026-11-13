import fs from "fs";
import { buildHandles } from "../../src/agent/loop/handles.mjs";
import { indexOf, at, isBelt, exitCellOf, entryCellOf, exitDirOf, entryDirOf, accepts } from "../../src/agent/loop/topology.mjs";
import { slotsOf, beltRvOf } from "../../src/agent/verify_runtime.mjs";

const obs = JSON.parse(fs.readFileSync("research/ai-plan/.obs-live.json", "utf8"));
const idx = indexOf(obs);
const h = buildHandles(obs, null);
const hOf = uid => {
    const e = [...h.byHandle.values()].find(x => x.uid === uid);
    return e ? e.handle : "?";
};
const ore = new Map((obs.resources || []).map(r => [r[0] + "," + r[1], r[2]]));

// 从 B258 反向，找第一个「上游不是带子」的格，看它是不是矿机、能不能 eject
let cur = [34, -12];
for (let i = 0; i < 120; i++) {
    const e = at(idx, cur);
    if (!e) { console.log("EMPTY at " + cur); break; }
    if (!isBelt(e)) {
        console.log("reach MACHINE " + e.type + "#" + e.uid + "(" + hOf(e.uid) + ")@(" + e.x + "," + e.y + ") r=" + e.r);
        console.log("  ore under = " + ore.get(e.x + "," + e.y));
        // ejectSlotInto 检查：该机器的输出槽不指向 cur 就返回 null
        const s = slotsOf(e.type, e.variant, e.x, e.y, e.r || 0, beltRvOf(e));
        console.log("  slots.outputs = " + JSON.stringify(s.outputs));
        console.log("  target cell = " + JSON.stringify(cur));
        const hit = (s.outputs || []).find(o => o.cell[0] === cur[0] && o.cell[1] === cur[1]);
        console.log("  matching output = " + JSON.stringify(hit));
        break;
    }
    let feeder = null;
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        const n = at(idx, [cur[0] + dx, cur[1] + dy]);
        if (!n || !isBelt(n)) continue;
        if (exitCellOf(n)[0] === cur[0] && exitCellOf(n)[1] === cur[1]) feeder = n;
    }
    if (!feeder) { console.log("NO FEEDER at " + cur + " (entity " + hOf(e.uid) + ")"); break; }
    cur = [feeder.x, feeder.y];
}
