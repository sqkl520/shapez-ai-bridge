import { gateG6 } from "../src/agent/gates.mjs";
const intent = { goal: "RuRu----" };
const mk = (n, nSlices=6, shape="RuRu----") => ({ slice_seconds: 10, delivered_slices: Array.from({length:nSlices},()=>({[shape]:n})), produced_slices: Array.from({length:nSlices},()=>({[shape]:n})) });
const show = (tag, r) => console.log(tag.padEnd(46), r.ok ? "GREEN" : "RED", "|", r.reason || "", "|", JSON.stringify(r.evidence));

// A: before 1.0/s, after 1.0/s -> must be RED
show("A 贴前1.0 贴后1.0 (target .32)", gateG6(intent, mk(10), mk(10), 0.4));
// A2: before 1.0/s, after 1.0/s, target 1.0 (threshold .8) -> must be RED (baseline above)
show("A2 贴前1.0 贴后1.0 (target 1.0)", gateG6(intent, mk(10), mk(10), 1.0));
// B: before 0, after 1.0 -> GREEN
show("B 贴前0 贴后1.0 (target .32)", gateG6(intent, mk(0), mk(10), 0.4));
// C: before 1.0, after 1.5 -> GREEN if target*0.5=0.16, baseline+0.16=1.16 <=1.5
show("C 贴前1.0 贴后1.5 (target .32)", gateG6(intent, mk(10), mk(15), 0.4));
// C2 with target 1.0: threshold 0.8, must be 1.0+0.4=1.4 -> 1.5 >= 1.4 GREEN
show("C2 贴前1.0 贴后1.5 (target 1.0)", gateG6(intent, mk(10), mk(15), 1.0));
// D: all-empty slices -> undecidable
const empty = { slice_seconds: 10, delivered_slices: Array.from({length:6},()=>({})), produced_slices: [] };
show("D 刚读档全空片", gateG6(intent, empty, empty, 0.4));
// D2: baseline all-empty, after has data -> baseline is 0, should be judged normally
show("D2 基线全空 贴后有, target .32", gateG6(intent, empty, mk(10), 0.4));
// E: old line delivering other shape, new line zero -> RED
const other = { slice_seconds: 10, delivered_slices: Array.from({length:6},()=>({CuCuCuCu:50})), produced_slices: Array.from({length:6},()=>({CuCuCuCu:50})) };
show("E 老线交别的形状", gateG6(intent, other, other, 0.4));
// F: exact boundary: baseline 1.0, target .32 threshold .32, must exceed max(.32, 1.16)
show("F 贴前1.0 贴后1.16 (== 边界)", gateG6(intent, mk(10), {slice_seconds:10, delivered_slices:Array.from({length:6},()=>({"RuRu----":11.6})), produced_slices:[]}, 0.4));
// G: baseline present, after LOWER (line broke) -> must be RED
show("G 贴前1.0 贴后0.5 (退化)", gateG6(intent, mk(10), mk(5), 0.4));
// H: p1 null (no baseline) -> falls back to absolute
show("H 没基线( null ) 贴后1.0", gateG6(intent, null, mk(10), 0.4));
// I: p1 with all-empty / slices<2 -> baseline null fallback
const one = { slice_seconds: 10, delivered_slices: [{ "RuRu----":30 }], produced_slices: [] };
show("I 基线只有1片", gateG6(intent, one, mk(10), 0.4));
// J: after slices has target but only in produced, not delivered
const onlyProduced = { slice_seconds: 10, delivered_slices: Array.from({length:6},()=>({})), produced_slices: Array.from({length:6},()=>({"RuRu----":10})) };
show("J 只 produced 不 delivered", gateG6(intent, mk(0), onlyProduced, 0.4));
