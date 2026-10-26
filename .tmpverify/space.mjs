import { rpc } from "./rpc.mjs";
const o = await rpc("obs", { max_entities: 20000, include_hub: true, region: [-500,-500,500,500] });
console.log("truncated", o.truncated, "count", o.entity_count);
const occ = new Set(o.entities.map(e=>`${e.x},${e.y}`));
// scan for a 12x12 empty block far from entities
outer: for (let by=300; by>=-300; by-=1) {
  for (let bx=-300; bx<=300; bx+=1) {
    let ok=true;
    for (let y=by; y<by+8 && ok; y++) for (let x=bx; x<bx+8; x++) if (occ.has(`${x},${y}`)) { ok=false; break; }
    if (ok) { console.log("free block at", bx, by); break outer; }
  }
}
console.log("world bounds?", JSON.stringify(o.world||null));
