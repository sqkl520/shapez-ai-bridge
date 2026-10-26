import { rpc } from "./rpc.mjs";
const hub = async () => (await rpc("obs", { include_hub: true, max_entities: 5 })).hub.stored_shapes;
const diff = (a,b) => { const out={}; for (const k of new Set([...Object.keys(a),...Object.keys(b)])) { const d=(b[k]||0)-(a[k]||0); if (d) out[k]=d; } return out; };
for (const ticks of [6000, 6000, 6000]) {
  const a = await hub();
  const t0 = Date.now();
  const s = await rpc("act", { op: "step", ticks });
  const b = await hub();
  const realMs = Date.now()-t0;
  console.log(`step ${ticks} (${(ticks/120).toFixed(1)} game s) wall=${s.wall_ms}ms real=${realMs}ms advanced=${s.ticks_advanced_seconds.toFixed(2)}`);
  console.log("  hub delta:", JSON.stringify(diff(a,b)));
}
// realtime control: 50 game seconds
const a = await hub(); const t0 = Date.now();
await new Promise(r => setTimeout(r, 50000));
const b = await hub();
console.log("realtime 50s hub delta:", JSON.stringify(diff(a,b)), "elapsed wall", Date.now()-t0);
