import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(import.meta.url);
const { decodeSave } = require("../../../recon/decode_full.cjs");
const f = path.join(process.env.APPDATA, "shapez.io", "saves", "savegame-5c96706563c0b74c4d2ce4c7f8bf7a244392de89.bin");
const { obj } = decodeSave(f);
const ents = obj.dump.entities;

const at = new Map();
for (const e of ents) {
  const s = e.components?.StaticMapEntity;
  if (s) at.set(s.origin.x + "," + s.origin.y, e);
}

const bal = ents.filter(e => e.components?.StaticMapEntity?.code === 4);
console.log("balancer 总数:", bal.length);

// 看几个样例：它周围 8 邻是什么
const NAMES = {1:"belt",2:"beltL",3:"beltR",4:"BAL",5:"merge",6:"mergeI",7:"miner",8:"minerC",
  9:"cutter",10:"cutQuad",11:"rot",12:"rotCCW",13:"rot180",14:"stack",15:"mix",16:"paint",
  17:"paint2",18:"paintQ",20:"trash",22:"tun-in",23:"tun-out",26:"hub",47:"split",48:"splitI"};
const nm = e => { const c = e?.components?.StaticMapEntity?.code; return c === undefined ? "·" : (NAMES[c] || "c" + c); };

for (const b of bal.slice(0, 4)) {
  const o = b.components.StaticMapEntity.origin;
  const r = b.components.StaticMapEntity.rotation;
  console.log(`\nbalancer @(${o.x},${o.y}) rot=${r}`);
  // 南面两个格子（输入）、北面两个格子（输出）—— 但 rotation 会改变方向
  for (const [dx, dy, label] of [[0,1,"S0"],[1,1,"S1"],[0,-1,"N0"],[1,-1,"N1"],[2,0,"E"],[2,1,"E1"],[-1,0,"W"],[-1,1,"W1"]]) {
    const e = at.get((o.x+dx)+","+(o.y+dy));
    if (e) console.log(`   ${label} (${o.x+dx},${o.y+dy}) = ${nm(e)}`);
  }
}
