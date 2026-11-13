import fs from "fs";
import { buildHandles } from "../../src/agent/loop/handles.mjs";
import { indexOf, at, isBelt, exitCellOf, entryCellOf } from "../../src/agent/loop/topology.mjs";

const obs = JSON.parse(fs.readFileSync("research/ai-plan/.obs-live.json", "utf8"));
const idx = indexOf(obs);
const h = buildHandles(obs, null);
const hOf = uid => {
    const e = [...h.byHandle.values()].find(x => x.uid === uid);
    return e ? e.handle : "?";
};
const byUid = new Map(obs.entities.map(e => [e.uid, e]));
const atM = new Map(obs.entities.map(e => [e.x + "," + e.y, e]));

// 从 feed cell 反向走，打印每一步的 hOf 与坐标
const walk = (start, label) => {
    console.log(`\n=== ${label} 反向追 ===`);
    const seen = new Set();
    let cur = start;
    for (let i = 0; i < 120; i++) {
        const k = cur[0] + "," + cur[1];
        if (seen.has(k)) { console.log("  (环)"); break; }
        seen.add(k);
        const e = atM.get(k);
        if (!e) { console.log(`  (${k}) 空 —— 断点`); break; }
        const out = exitCellOf(e);
        console.log(`  ${hOf(e.uid)}@(${e.x},${e.y}) r=${e.r} rv=${e.rotation_variant} exit->(${out})`);
        let feeder = null;
        for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
            const n = atM.get((cur[0] + dx) + "," + (cur[1] + dy));
            if (!n || n.type !== "belt") continue;
            const o = exitCellOf(n);
            if (o[0] === cur[0] && o[1] === cur[1]) feeder = n;
        }
        if (!feeder) { console.log("  ↑ 无上游带子（流头）"); break; }
        cur = [feeder.x, feeder.y];
    }
};

walk([34, -12], "slot0 feed (34,-12)");
walk([35, -12], "slot1 feed (35,-12)");
