import { rpc } from "./rpc.mjs";
const mk = p => (p.delivered_slices||[]).map(s => JSON.stringify(s));
// baseline
let p0 = await rpc("production", { slices: 8 });
console.log("t0 slices:", mk(p0).join(" "));
// 12 game seconds via step (1200 ticks)
let s = await rpc("act", { op: "step", ticks: 1440 });  // 12s
let p1 = await rpc("production", { slices: 8 });
console.log("after step1440 (12s):", mk(p1).join(" "));
console.log("advanced", s.ticks_advanced_seconds.toFixed(2));
// 25 game seconds
s = await rpc("act", { op: "step", ticks: 3000 });
let p2 = await rpc("production", { slices: 8 });
console.log("after step3000 (25s):", mk(p2).join(" "));
console.log("advanced", s.ticks_advanced_seconds.toFixed(2));
