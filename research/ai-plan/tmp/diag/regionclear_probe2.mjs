import fs from "node:fs";
import * as C from "file:///D:/Projects/rea/Project%20work/shapez/src/ai/compiler/compile.mjs";
const ents = JSON.parse(fs.readFileSync("D:/Projects/rea/Project work/shapez/research/ai-plan/tmp/diag/world181.json","utf8")).entities;
const layout = { placements: [{ nodeId:"n0", kind:"miner", cell:[0,0], footprint:[1,1], rot:0, rv:0 }],
                 occupancy: [], channels: [], lanes: [], conflicts: [], beltCells: [], bbox:[0,0,0,0],
                 hubConnection: null, cornerCount:0, waste:[], dir:"l", stats:{},
                 meta: { minerResources: { n0: "RuRuRuRu" } } };
const mk = extra => C.siteStage(layout, { seed:55013, hubDesign:[-4,-4], hubLocal:[0,0], hub:[-2,-2],
  entityRect:[0,0,1,1], ...extra });
const a = mk({});
const b = mk({ world:{ entities: ents } });
console.log("CLI 实际路径（siteStage 收到 world=null）:", a.ok, a.reason||"", a.hint?String(a.hint).slice(0,100):"");
console.log("若 siteStage 真收到 world（181 实体）:", b.ok, b.reason||"", b.hint?String(b.hint).slice(0,160):"");
