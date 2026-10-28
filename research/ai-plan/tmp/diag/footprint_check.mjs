import { validateWorld } from "file:///D:/Projects/rea/Project%20work/shapez/src/ai/compiler/place.mjs";
const world = { entities: [
  { uid:1, type:"cutter", x:-8, y:-11, r:0 },
  { uid:2, type:"balancer", x:8, y:-9, r:0 },
  { uid:3, type:"miner", x:2, y:-8, r:0 },
  { uid:4, type:"belt", x:0, y:0, r:180 },
  { uid:5, type:"hub", x:-2, y:-2, r:0 },
]};
const w = validateWorld(world);
console.log("occupancy count:", w.occupancy.length);
console.log(JSON.stringify(w.occupancy.filter(o=>o.kind!=="hub"), null, 0));
console.log("cutter right half (-7,-11) marked?", w.occupancy.some(o=>o.cell[0]===-7&&o.cell[1]===-11));
console.log("balancer right half (9,-9) marked?", w.occupancy.some(o=>o.cell[0]===9&&o.cell[1]===-9));
