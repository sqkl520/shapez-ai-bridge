import { rpc } from "./rpc.mjs";
const region = [-12,-36,14,8];
function cnt(d){ return {paths: d.paths.length, items: d.paths.reduce((a,p)=>a+(p.itemsOnPath||0),0), acc: d.paths.filter(p=>p.boundAcceptor!==null).length}; }
let items = await rpc("debug_items", { region });
console.log("before:", JSON.stringify(cnt(items)));
let s = await rpc("act", {op:"step", ticks:600});   // 5s
items = await rpc("debug_items", { region });
console.log("after step 5s (600):", JSON.stringify(cnt(items)), "adv", s.ticks_advanced_seconds);
s = await rpc("act", {op:"step", ticks:600});
items = await rpc("debug_items", { region });
console.log("after step 5s more:", JSON.stringify(cnt(items)), "adv", s.ticks_advanced_seconds);
await new Promise(r=>setTimeout(r,5000));
items = await rpc("debug_items", { region });
console.log("after real 5s:", JSON.stringify(cnt(items)));
