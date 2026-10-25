import { rpc } from "../live/kit.mjs";
const o = await rpc("obs", { max_entities: 200, include_hub: true, include_stats: true, region: [-10, -14, 10, 6] }, 90000);
console.log("stored:", JSON.stringify(o.hub.stored_shapes));
console.log("entities:", o.stats.total, JSON.stringify(o.stats.by_type));
console.log(JSON.stringify((o.entities||[]).map(e=>({t:e.type,x:e.x,y:e.y,r:e.r,rv:e.rotation_variant}))));
