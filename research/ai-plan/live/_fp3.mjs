import { computeBelt } from "../../../src/ai/compiler/belt-sim.mjs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { decodeSave } = require("../../../recon/decode_full.cjs");
const d = decodeSave(process.env.APPDATA + "/shapez.io/saves/savegame-5c96706563c0b74c4d2ce4c7f8bf7a244392de89.bin");
const BELT = new Set([1,2,3]);
const g = new Map();
for (const e of (d.obj.dump.entities||[])) { const s=e.components?.StaticMapEntity; if(!s) continue; g.set(s.origin.x+","+s.origin.y,{code:s.code,r:s.rotation,orig:s.originalRotation,belt:BELT.has(s.code)}); }
const OFFS={top:[0,-1],right:[1,0],bottom:[0,1],left:[-1,0]};
const OPP={top:'bottom',bottom:'top',left:'right',right:'left'};
const ORDER=['top','right','bottom','left'];
const nz=a=>((a%360)+360)%360;
const belts=[...g.entries()].filter(([,v])=>v.belt);
let tot=0, fp=0, flex=0;
for (const [k,v] of belts) {
  const [x,y]=k.split(",").map(Number);
  const ns=[];
  for (const [dir,[dx,dy]] of Object.entries(OFFS)) {
    const nb=g.get((x+dx)+","+(y+dy)); if(!nb||!nb.belt) continue;
    const nbExit={0:'top',1:'left',2:'right'}[nb.code-1];
    const worldExit=ORDER[(ORDER.indexOf(nbExit)+(nz(nb.r)/90))%4];
    if (worldExit===OPP[dir]) ns.push({toDirection:OPP[dir]});
  }
  // 只统计**有带邻居**的格（否则本就无信息）
  if (!ns.length) continue;
  tot++;
  const got=computeBelt({ rotation: nz(v.orig), neighbors: ns });
  if (got.rotation===nz(v.r) && got.rotationVariant===v.code-1) fp++; else flex++;
}
console.log(`有带邻居的带子 ${tot} | 真实 orig 复现真实 (r,rv): ${fp} (${(fp/tot*100).toFixed(1)}%) | 不能: ${flex}`);

// 关键问题：真实工厂里存在"P7-F2 那种拓扑"的拐角吗？
// 拓扑：拐角 (rot,rv) 且左邻朝右喷（PULL）。逐个找。
let pullCorners=0; const ex=[];
for (const [k,v] of belts) {
  if (v.code===1) continue;                     // 只看拐角
  const [x,y]=k.split(",").map(Number);
  const left=g.get((x-1)+","+(y));              // 左邻
  if (left && left.belt) {
    const le={0:'top',1:'left',2:'right'}[left.code-1];
    const lw=ORDER[(ORDER.indexOf(le)+(nz(left.r)/90))%4];
    if (lw==='right') { pullCorners++; if(ex.length<4) ex.push({at:k,corner:{r:v.r,rv:v.code-1,orig:v.orig},left:{r:left.r,rv:left.code-1}}); }
  }
}
console.log(`真实工厂里"左邻朝右喷"的拐角: ${pullCorners} 个`);
for(const e of ex) console.log("  ", JSON.stringify(e));
