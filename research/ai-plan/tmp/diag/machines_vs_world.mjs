/* 构造一个"矿机必然压在旧矿机上"的最小实验：
   旧世界在 (4,-6) 放一台矿机；新计划的矿机也会在 (4,-6)。
   若 Grid 不灌世界占位，place() 不会报错。 */
import { place } from "file:///D:/Projects/rea/Project%20work/shapez/src/ai/compiler/place.mjs";
const steps = [
  { id:"n0", op:"mine", hash:"RuRuRuRu", depth:0, args:{}, inputs:[], kind:"shape" },
  { id:"n1", op:"cut", hash:"RuRu----", depth:1, args:{half:"right"}, inputs:["RuRuRuRu"], kind:"shape" },
];
const base = {
  steps, site:{x:-2,y:-2}, hub:{x:-2,y:-2}, seed:55013, range:96, demandPerSec:0, instanceIdx:0,
};
const world = { entities: [
  { uid: 10000, type:"hub", x:-2, y:-2, r:0 },
  { uid: 10001, type:"miner", x:4, y:-6, r:0 },   // 与新矿机同格
  { uid: 10002, type:"belt", x:4, y:-7, r:0 },
], seed: 55013, replaceableBeltCells: [] };
const r1 = place({ ...base });
const r2 = place({ ...base, world });
console.log("无 world:", r1.ok !== false ? "ok（预期：V9 失败）" : r1.reason);
console.log("有 world:", r2.ok !== false ? "ok（!! 压在旧矿机上却通过）" : r2.reason);
if (r2.ok !== false) {
  const p = r2.placements.find(x=>x.nodeId==="n0");
  console.log("  新矿机落点:", JSON.stringify(p && p.cell));
  console.log("  旧矿机:", "4,-6");
}
