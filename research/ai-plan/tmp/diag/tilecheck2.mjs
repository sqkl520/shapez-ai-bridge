import { tileResource } from "file:///D:/Projects/rea/Project%20work/shapez/src/ai/world.mjs";
import fs from "node:fs";
const o=JSON.parse(fs.readFileSync("D:/Projects/rea/Project work/shapez/research/ai-plan/tmp/diag/obs.json","utf8"));
const realMiners=o.result.entities.filter(e=>e.type==="miner").map(e=>[e.x,e.y]);
for (const seed of [43391,55013]) {
  let hit=0, hitCu=0;
  const detail=[];
  for (const [x,y] of realMiners) {
    const r=tileResource(seed,x,y);
    if (r) hit++;
    detail.push(`${x},${y}=${r||"-"}`);
  }
  console.log(`seed ${seed}: ${hit}/${realMiners.length} 命中`, detail.join(" "));
}
// scan 8x8 region for Ru under each seed
for (const seed of [43391,55013]) {
  const cells=[];
  for(let x=-16;x<=16;x++)for(let y=-20;y<=10;y++){if(tileResource(seed,x,y)==="RuRuRuRu")cells.push([x,y]);}
  console.log(`seed ${seed}: Ru cells in [-16..16]x[-20..10] = ${cells.length}:`, JSON.stringify(cells.slice(0,30)));
}
