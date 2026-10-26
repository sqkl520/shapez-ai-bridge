import { rpc, rateOf } from "./rpc.mjs";
const shape = process.argv[2] || "----CuCu";
const before = await rpc("production", { slices: 6 });
const st0 = await rpc("status", {});
console.log("BEFORE", JSON.stringify(rateOf(before, shape)), "tick", st0.tick.toFixed(2));
for (const ticks of [7200, 4800]) {
  const t0 = Date.now();
  const s = await rpc("act", { op: "step", ticks });
  console.log(`step ${ticks}: ticks_run=${s.ticks_run} advanced_seconds=${s.ticks_advanced_seconds} wall_ms=${s.wall_ms} real_ms=${Date.now()-t0}`);
  const p = await rpc("production", { slices: 6 });
  console.log("  prod", JSON.stringify(rateOf(p, shape)), "slices", JSON.stringify(p.delivered_slices));
  console.log("  diff", JSON.stringify(s.diff));
}
const st1 = await rpc("status", {});
console.log("AFTER tick", st1.tick.toFixed(2), "delta", (st1.tick - st0.tick).toFixed(2));
