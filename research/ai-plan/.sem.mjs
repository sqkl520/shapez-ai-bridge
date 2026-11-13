import { slotsOf, beltRvOf } from "../../src/agent/verify_runtime.mjs";
import { entryDirOf } from "../../src/agent/loop/topology.mjs";
// cutter r=0: input slot at (10,10), dir=bottom, cell=(10,11)  [货从下方来]
// 假设上游是 miner @(10,12) r=0 → 输出 cell (10,11) dir=top
const mine = slotsOf("miner", "default", 10, 12, 0, beltRvOf({ r: 0 }));
console.log("miner@(10,12) r=0 outputs =", JSON.stringify(mine.outputs));
const c = slotsOf("cutter", "default", 10, 10, 0, beltRvOf({ r: 0 }));
console.log("cutter@(10,10) r=0 inputs =", JSON.stringify(c.inputs));
console.log("");
console.log("cutter 的 in.dir =", c.inputs[0].dir);
console.log("miner 的 out.dir =", mine.outputs[0].dir);
console.log("=> 若 ejectSlotInto 要 dir === OPP[sl.dir]，则需", mine.outputs[0].dir, "===", "OPP[" + c.inputs[0].dir + "]");
console.log("");
// 带子场景：belt fed by machine
// belt @(10,11) r=180 (朝下? ) 实际先看 entryDirOf
const belt = { type: "belt", x: 10, y: 11, r: 180, rotation_variant: 0, variant: "default" };
console.log("belt@(10,11) r=180 entryDir =", entryDirOf(belt));
console.log("  -> 若下游 cutter 在 (10,10)，货应往上走，entry 应是 bottom(从下来)?");
