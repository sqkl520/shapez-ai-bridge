import { rpc, rateOf } from "./rpc.mjs";
const shape = process.argv[2] || "----CuCu";
const N = 8, gapMs = 8000;
for (let i = 0; i < N; i++) {
  const p = await rpc("production", { slices: 6 });
  const st = await rpc("status", {});
  const r = rateOf(p, shape);
  console.log(`t=${new Date().toISOString().slice(11,19)} tick=${st.tick.toFixed(2)} rate=${r.rate} counts=[${r.counts}]`);
  if (i < N - 1) await new Promise(r => setTimeout(r, gapMs));
}
