import { rpc, act } from "../live/kit.mjs";
const a = await rpc("obs", { max_entities: 1, include_hub: true }, 60000);
console.log("before:", JSON.stringify(a.hub.stored_shapes));
await act({ op: "step", ticks: 1800 });
const b = await rpc("obs", { max_entities: 1, include_hub: true }, 60000);
console.log("after :", JSON.stringify(b.hub.stored_shapes));
const o = await rpc("obs", { region: [0, -14, 8, 5], max_entities: 200, include_stats: false }, 90000);
console.log(JSON.stringify((o.entities||[]).filter(e=>e.type!=='belt').map(e=>({t:e.type,x:e.x,y:e.y,r:e.r}))));
console.log("belts:", (o.entities||[]).filter(e=>e.type==='belt').map(e=>`(${e.x},${e.y})rv${e.rotation_variant}r${e.r}`).join(' '));
