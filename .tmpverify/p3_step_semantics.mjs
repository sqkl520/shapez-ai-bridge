import { rpc } from "./rpc.mjs";
const prodShape = "----CuCu";
function r(prod){ const sl=prod.delivered_slices.slice(0,-1); return sl.map(s=>s[prodShape]||0); }
// 1) step 1200 -> 10 game seconds
let st = await rpc("status", {}); const t0 = st.tick;
let s = await rpc("act", { op: "step", ticks: 1200 });
let st2 = await rpc("status", {});
console.log(`A step 1200: ticks_run=${s.ticks_run} advanced=${s.ticks_advanced_seconds} tickdelta=${(st2.tick-t0).toFixed(3)} wall=${s.wall_ms}`);
// 2) 3 consecutive small steps
const p_before = await rpc("production",{slices:12});
let prev = (await rpc("status",{})).tick;
for (let i=0;i<3;i++){
  const a = await rpc("act", { op: "step", ticks: 600 });
  const now = (await rpc("status",{})).tick;
  const p = await rpc("production",{slices:12});
  console.log(`B step#${i+1}: ticks_run=${a.ticks_run} req=${a.ticks_requested} advanced=${a.ticks_advanced_seconds.toFixed(3)} tickdelta=${(now-prev).toFixed(3)} slices=${JSON.stringify(r(p))}`);
  prev = now;
}
// 3) slice rotation during one step: check that multiple slices advance
const p0 = await rpc("production",{slices:12});
const s2 = await rpc("act", { op: "step", ticks: 2400 }); // 20 game seconds
const p1 = await rpc("production",{slices:12});
console.log(`C step 2400 wall=${s2.wall_ms} advanced=${s2.ticks_advanced_seconds.toFixed(2)}`);
console.log(`  before slices=${JSON.stringify(r(p0))}`);
console.log(`  after  slices=${JSON.stringify(r(p1))}`);
console.log(`  before produced=${JSON.stringify(p0.produced_slices.slice(-3))}`);
console.log(`  after  produced=${JSON.stringify(p1.produced_slices.slice(-3))}`);
