/* siteStage 收到 ctx.world 吗？CLI 只填 worldEntities。用两份输入直接对比。 */
import fs from "node:fs";
import * as C from "file:///D:/Projects/rea/Project%20work/shapez/src/ai/compiler/compile.mjs";
const ents = JSON.parse(fs.readFileSync("D:/Projects/rea/Project work/shapez/research/ai-plan/tmp/diag/world181.json","utf8")).entities;
// 直接调 siteStage：模拟 CLI 路径（world=null, hubLocal=[0,0], hub 给定）
const layout = { placements: [{ nodeId:"n0", kind:"miner", cell:[0,0], footprint:[1,1], rot:0, rv:0 }],
                 occupancy: [], channels: [], lanes: [], conflicts: [], beltCells: [], bbox:[0,0,0,0],
                 hubConnection: null, cornerCount:0, waste:[], dir:"l", stats:{} };
const mk = extra => C.siteStage(layout, { seed:55013, hubDesign:[-4,-4], hubLocal:[0,0], hub:[-2,-2],
  entityRect:[0,0,1,1], ...extra });
console.log("CLI 实际路径（world 未传）:", JSON.stringify(mk({})));
console.log("若传 world（有 181 实体）:", JSON.stringify(mk({ world:{ entities: ents } })));
