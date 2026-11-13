import fs from "fs";
import { buildHandles } from "../../src/agent/loop/handles.mjs";
import { exitCellOf } from "../../src/agent/loop/topology.mjs";
import { slotsOf, beltRvOf } from "../../src/agent/verify_runtime.mjs";
const obs = JSON.parse(fs.readFileSync("research/ai-plan/.obs-live.json", "utf8"));
const h = buildHandles(obs, null);
const hOf = uid => {
    const e = [...h.byHandle.values()].find(x => x.uid === uid);
    return e ? e.handle : "?";
};
const atM = new Map(obs.entities.map(e => [e.x + "," + e.y, e]));
const e = atM.get("35,-9");
console.log("cell (35,-9): " + (e ? hOf(e.uid) + " r=" + e.r + " rv=" + e.rotation_variant : "EMPTY"));
if (e) {
    const s = slotsOf(e.type, e.variant, e.x, e.y, e.r || 0, beltRvOf(e));
    console.log("  exit -> " + JSON.stringify(exitCellOf(e)));
    console.log("  如果改成 r=0（朝下），exit 会是 (35,-10) = B343 的入口格");
}
// slot1 整条链的期望
console.log("");
console.log("slot1 期望链路: M2(38,-12) -> (38,-13) -> (37,-13) -> (37,-12) -> (36,-12) -> (35,-12)[corner UP] -> slot1(35,-13)");
console.log("  实测 (36,-12): " + (atM.get("36,-12") ? hOf(atM.get("36,-12").uid) + " r=" + atM.get("36,-12").r + " rv=" + atM.get("36,-12").rotation_variant : "EMPTY"));
console.log("  实测 (35,-12): " + (atM.get("35,-12") ? hOf(atM.get("35,-12").uid) + " r=" + atM.get("35,-12").r + " rv=" + atM.get("35,-12").rotation_variant : "EMPTY"));
const b259 = atM.get("35,-12");
if (b259) console.log("  B259 exit -> " + JSON.stringify(exitCellOf(b259)));
