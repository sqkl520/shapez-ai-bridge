import { rpc } from "./rpc.mjs";
const shape = "----CuCu";
function summarize(tag, p) {
  const ds = p.delivered_slices.map(s=>s[shape]||0);
  const ps = p.produced_slices.map(s=>s[shape]||0);
  const sumD = ds.reduce((a,b)=>a+b,0), sumP = ps.reduce((a,b)=>a+b,0);
  console.log(tag, "n="+ds.length, "sumDelivered="+sumD, "sumProduced="+sumP);
  console.log("  D tail:", ds.slice(-8).join(","));
  console.log("  P tail:", ps.slice(-8).join(","));
}
let p = await rpc("production", { slices: 100 });
summarize("t0", p);
const t0 = Date.now();
const s = await rpc("act", { op: "step", ticks: 3000 }); // 25s
console.log("step wall", Date.now()-t0, "advanced", s.ticks_advanced_seconds.toFixed(2), "ticks_run", s.ticks_run);
p = await rpc("production", { slices: 100 });
summarize("after step 25s", p);
// now wait real 25s, no step
await new Promise(r=>setTimeout(r,25000));
p = await rpc("production", { slices: 100 });
summarize("after real 25s", p);
