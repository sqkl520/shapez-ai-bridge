import fs from "fs";
import { buildHandles } from "../../src/agent/loop/handles.mjs";
import { indexOf, at, isBelt, exitCellOf, entryCellOf, exitDirOf, entryDirOf, accepts } from "../../src/agent/loop/topology.mjs";

const obs = JSON.parse(fs.readFileSync("research/ai-plan/.obs-live.json", "utf8"));
const idx = indexOf(obs);
const h = buildHandles(obs, null);
const hOf = uid => {
    const e = [...h.byHandle.values()].find(x => x.uid === uid);
    return e ? e.handle : "?";
};
const uidOf = n => {
    const e = [...h.byHandle.values()].find(x => x.handle === n);
    return e ? e.uid : null;
};
const byUid = new Map(obs.entities.map(e => [e.uid, e]));

// 沿 feed cell 反向走，每步打印 beltValue 的关键判断
const walk = (start, label) => {
    console.log("");
    console.log("=== " + label + " ===");
    const seen = new Set();
    let cur = start;
    for (let i = 0; i < 200; i++) {
        const k = cur[0] + "," + cur[1];
        if (seen.has(k)) { console.log("  loop"); break; }
        seen.add(k);
        const e = at(idx, cur);
        if (!e) { console.log("  (" + k + ") EMPTY -- break here"); break; }
        if (!isBelt(e)) { console.log("  MACHINE " + e.type + "#" + e.uid + "(" + hOf(e.uid) + ")@(" + e.x + "," + e.y + ") r=" + e.r); break; }
        const up = at(idx, entryCellOf(e));
        const upDesc = up ? (isBelt(up) ? "belt(" + hOf(up.uid) + ")" : up.type + "(" + hOf(up.uid) + ")") : "EMPTY";
        let feeds = "-";
        if (up && isBelt(up)) {
            const ex = exitCellOf(up);
            const same = ex[0] === e.x && ex[1] === e.y;
            const acc = accepts(idx, [e.x, e.y], exitDirOf(up)).ok;
            feeds = "same=" + same + " accepts=" + acc;
        }
        console.log("  " + hOf(e.uid) + "@(" + e.x + "," + e.y + ") rv=" + e.rotation_variant + " entry[" + JSON.stringify(entryCellOf(e)) + " " + entryDirOf(e) + "] up=" + upDesc + " " + feeds);
        let feeder = null;
        for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
            const n = at(idx, [cur[0] + dx, cur[1] + dy]);
            if (!n || !isBelt(n)) continue;
            if (exitCellOf(n)[0] === cur[0] && exitCellOf(n)[1] === cur[1]) feeder = n;
        }
        if (!feeder) { console.log("  ^ NO FEEDER (head)"); break; }
        cur = [feeder.x, feeder.y];
    }
};
walk([34, -12], "slot0 feed (34,-12)");
walk([35, -12], "slot1 feed (35,-12)");
