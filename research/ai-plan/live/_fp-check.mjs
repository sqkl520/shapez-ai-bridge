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
let tot=0, fp=0, flex=0; const bad=[];
for (const [k,v] of g) { if(!v.belt) continue; tot++;
  const [x,y]=k.split(",").map(Number);
  const ns=[];
  for (const [dir,[dx,dy]] of Object.entries(OFFS)) {
    const nb=g.get((x+dx)+","+(y+dy)); if(!nb||!nb.belt) continue;
    const nbExit={0:'top',1:'left',2:'right'}[nb.code-1];
    const worldExit=ORDER[(ORDER.indexOf(nbExit)+(nz(nb.r)/90))%4];
    if (worldExit===OPP[dir]) ns.push({toDirection:OPP[dir]});
  }
  const got=computeBelt({ rotation: nz(v.orig), neighbors: ns });
  if (got.rotation===nz(v.r) && got.rotationVariant===v.code-1) fp++;
  else { flex++; if(bad.length<6) bad.push({at:k,real:{r:v.r,rv:v.code-1,orig:v.orig},sim:got,ns:ns.length}); }
}
console.log(`真实带子 ${tot} | 真实 orig 能复现真实 (r,rv): ${fp} | 不能（终态非不动点）: ${flex}`);
for(const b of bad) console.log("  ", JSON.stringify(b));
