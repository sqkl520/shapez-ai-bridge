import { rpc } from "./rpc.mjs";
const log = (...a) => console.log(...a);
const B = -300, BY = 300;  // empty block base
async function clean(region){ try{ await rpc("act",{op:"bulk_delete",region}); }catch(e){} }
async function place(building,x,y,r,variant){ return rpc("act",{op:"place",building,x,y,r,...(variant?{variant}:{})}); }
async function del(x,y){ try{ await rpc("act",{op:"delete",x,y}); }catch(e){} }

/* ---- 0) confirm orientation semantics live: where does a rot=180 cutter actually occupy? ---- */
async function occupancyOf(building, x, y, r, variant) {
  // decide by trying to place a belt on candidate cells and seeing which are rejected
  const cand = [[x+1,y],[x-1,y],[x,y+1],[x,y-1],[x,y]];
  const res = {};
  const p = await place(building,x,y,r,variant);
  for (const [cx,cy] of cand) {
    try { await place("belt",cx,cy,0); res[`${cx},${cy}`] = "free"; await del(cx,cy); }
    catch(e) { res[`${cx},${cy}`] = "OCCUPIED"; }
  }
  await del(x,y);
  return { uid: p.entity_uid, res };
}

const cases = [
  ["cutter",0,0,"rot0"],["cutter",0,90,"rot90"],["cutter",0,180,"rot180"],["cutter",0,270,"rot270"],
  ["painter",0,180,"painter180"],["balancer",0,90,"balancer90"],
];
let cx = B;
for (const [b,_,r,label] of cases) {
  const o = await occupancyOf(b, cx, BY, r);
  log(label.padEnd(12), JSON.stringify(o.res));
  cx += 6;
}
