import { rpc } from "../live/kit.mjs";
const o = await rpc("obs", { max_entities: 400, include_stats: true, include_hub: true }, 90000);
console.log("entities:", o.stats.total, JSON.stringify(o.stats.by_type));
console.log("goal:", o.goal.level, o.goal.requirement.shape, o.goal.requirement.delivered + "/" + o.goal.requirement.required);
console.log("stored:", JSON.stringify(o.hub.stored_shapes));
const by = {};
for (const e of o.entities) (by[e.type] = by[e.type] || []).push([e.x, e.y]);
for (const [t, cells] of Object.entries(by)) {
  if (t === "belt") { console.log("belt:", cells.length, "cells, x range", Math.min(...cells.map(c=>c[0])), "..", Math.max(...cells.map(c=>c[0]))); continue; }
  console.log(t + ":", JSON.stringify(cells));
}
