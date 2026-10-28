import { place } from "file:///D:/Projects/rea/Project%20work/shapez/src/ai/compiler/place.mjs";
const steps = [
  { id:"n0", op:"mine", hash:"RuRuRuRu", depth:0, args:{}, inputs:[], kind:"shape" },
  { id:"n1", op:"cut", hash:"RuRu----", depth:1, args:{half:"right"}, inputs:["RuRuRuRu"], kind:"shape" },
];
const base = { steps, site:{x:-2,y:-2}, hub:{x:-2,y:-2}, seed:55013, range:96, demandPerSec:0, instanceIdx:0 };
// 旧世界里矿机正好占住新矿机的位置，但**不提供** Ru 资源冲突（用 Cu 更明显）
function tryOne(label, mpos, mtype="miner") {
  const world = { entities: [
    { uid:10000, type:"hub", x:-2, y:-2, r:0 },
    { uid:10001, type:mtype, x:mpos[0], y:mpos[1], r:0 },
  ], seed:55013, replaceableBeltCells:[] };
  const r = place({ ...base, world });
  console.log(label, "=>", r.ok !== false ? "ok" : r.reason,
    r.ok===false ? JSON.stringify(r.failingNode)+" "+String(r.hint).slice(0,80) : "");
}
// 新矿机在 (4,-6)（seed 55013 的 Ru 格）
tryOne("旧机器压在 (4,-6)（= 新矿机格）", [4,-6]);
tryOne("旧机器压在 (4,-5)（= 新矿机输出格）", [4,-5]);
tryOne("旧机器压在 (5,-6)", [5,-6]);
tryOne("旧机器压在 (4,-9)（切割机上方）", [4,-9]);
