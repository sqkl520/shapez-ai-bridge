import fs from "fs";
import { buildHandles } from "../../src/agent/loop/handles.mjs";
import { exitCellOf, entryCellOf, exitDirOf, entryDirOf, flowReachable, indexOf } from "../../src/agent/loop/topology.mjs";
const obs = JSON.parse(fs.readFileSync("research/ai-plan/.obs-live.json", "utf8"));
const h = buildHandles(obs, null);
const hOf = uid => {
    const e = [...h.byHandle.values()].find(x => x.uid === uid);
    return e ? e.handle : "?";
};
const atM = new Map(obs.entities.map(e => [e.x + "," + e.y, e]));
const reach = flowReachable(obs, indexOf(obs));

// B307 是 M3 的输出，M3 还喂别的地方吗？
console.log("M3 @(39,-12) r=180, 输出格 (39,-11) = " + hOf(atM.get("39,-11").uid));
console.log("");
console.log("=== M3 之后那 106 格链的有货部分 ===");
// 沿 B307 -> ... 看它最终到哪
let cur = atM.get("39,-11");
const seen = new Set();
const path = [];
while (cur && !seen.has(cur.uid) && path.length < 200) {
    seen.add(cur.uid);
    path.push(hOf(cur.uid) + "@(" + cur.x + "," + cur.y + ")");
    const nx = exitCellOf(cur);
    cur = atM.get(nx[0] + "," + nx[1]);
}
console.log("  长度 " + path.length);
console.log("  末 6 格: " + path.slice(-6).join(" -> "));
console.log("  终点: " + (cur ? cur.type + "(" + hOf(cur.uid) + ")" : "EMPTY"));

// 这条链上有货吗（reach hub）
const beltsOnPath = path.map(p => p.split("@")[0]);
const toHub = beltsOnPath.filter(n => {
    const e = [...h.byHandle.values()].find(x => x.handle === n);
    return e && reach.has(e.uid);
});
console.log("  链上通到 hub 的: " + toHub.length + "/" + beltsOnPath.length);
