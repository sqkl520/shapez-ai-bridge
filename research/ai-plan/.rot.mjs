import { slotsOf, beltRvOf } from "../../src/agent/verify_runtime.mjs";
// 对 miner / cutter / mixer / painter 各测 4 个旋转，看 slotsOf 是否给出不同几何
for (const type of ["miner", "cutter", "mixer", "painter", "rotater", "stacker"]) {
    const rows = [];
    for (const r of [0, 90, 180, 270]) {
        let s = null;
        try { s = slotsOf(type, "default", 10, 10, r, beltRvOf({ r })); } catch (e) { rows.push(r + ":THROW"); continue; }
        if (!s) { rows.push(r + ":null"); continue; }
        const outs = (s.outputs || []).map(o => o.dir + "@" + o.cell.join(",")).join("|");
        const ins = (s.inputs || []).map(o => o.dir + "@" + o.cell.join(",")).join("|");
        rows.push(r + " out[" + outs + "] in[" + ins + "]");
    }
    console.log("== " + type);
    for (const r of rows) console.log("   " + r);
}
