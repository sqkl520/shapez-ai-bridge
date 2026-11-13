import { slotsOf, beltRvOf } from "../../src/agent/verify_runtime.mjs";
import { OPP } from "../../src/ai/belt-rules.mjs";
// M3: miner @(39,-12) r=180 → 输出 cell (39,-11)
const s = slotsOf("miner", "default", 39, -12, 180, beltRvOf({ r: 180 }));
console.log("miner r=180 slots:", JSON.stringify(s.outputs));
const o = s.outputs[0];
console.log("  o.dir=" + o.dir + "  OPP[top]=" + OPP["top"] + "  OPP[bottom]=" + OPP["bottom"]);
console.log("  ejectSlotInto(M3, cell=(39,-11), fromDir=entryDirOf(B307))");
console.log("  B307 r=180 rv=1 -> entryDir = ?");

// 看 cutter 的输入槽 dir 与其被喂的方式
const c = slotsOf("cutter", "default", 10, 10, 0, beltRvOf({ r: 0 }));
console.log("");
console.log("cutter r=0 inputs:", JSON.stringify(c.inputs));
console.log("  in.dir=" + c.inputs[0].dir + " in.cell=" + JSON.stringify(c.inputs[0].cell));
console.log("  如果上游机器在 (10,11)（下方），它输出 dir 应该是?  OPP[" + c.inputs[0].dir + "]=" + OPP[c.inputs[0].dir]);
