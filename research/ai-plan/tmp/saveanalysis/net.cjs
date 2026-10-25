const {decodeSave}=require('../../../../recon/decode_full.cjs');
const P=process.env.APPDATA+'/shapez.io/saves/savegame-5c96706563c0b74c4d2ce4c7f8bf7a244392de89.bin';
const {obj}=decodeSave(P);
const ents=obj.dump.entities;
const ORDER=['top','right','bottom','left'];
const DIRV={top:[0,-1],right:[1,0],bottom:[0,1],left:[-1,0]};
const OPP={top:'bottom',bottom:'top',left:'right',right:'left'};
const norm=a=>((a%360)+360)%360;
const rotLocal=(d,rot)=>{const steps=(norm(rot)/90)|0;return ORDER[(ORDER.indexOf(d)+steps)%4];};
const EXIT_LOCAL={0:'top',1:'left',2:'right'};
const S=e=>e.components.StaticMapEntity;
const isBelt=e=>S(e).code<=3;
const beltOut=e=>{const s=S(e);return rotLocal(EXIT_LOCAL[s.code-1],s.rotation);};
const beltIn=e=>rotLocal('bottom',S(e).rotation);
const at=new Map();
const belts=[],machines=[];
for(const e of ents){const s=S(e);at.set(s.origin.x+','+s.origin.y,e);(s.code<=3?belts:machines).push(e);}

// footprint helpers from spec
const spec=require('../../../../src/ai/machine-spec.json');
const codeToB={}; for(const c of spec.codes) codeToB[c.code]={b:c.building,v:c.variant};
function variant(code){const x=codeToB[code];return x?spec.buildings[x.b].variants[x.v]:null;}
function footprint(e){
  const s=S(e); const v=variant(s.code);
  const w=v.size[0], h=v.size[1];
  const rot=norm(s.rotation)/90|0;
  // rotate size
  const swap=rot%2===1;
  const bw=swap?h:w, bh=swap?w:h;
  return {x:s.origin.x,y:s.origin.y,w:bw,h:bh};
}
// ejector world dirs of a machine
function ejectors(e){
  const s=S(e); const v=variant(s.code); if(!v||!v.ejectors) return [];
  const out=[];
  const fp=footprint(e);
  for(const ej of v.ejectors){
    // local tile -> world tile given rotation
    const [lx,ly]=ej.tile;
    let wx,wy;
    const rot=(norm(s.rotation)/90|0);
    // rotate local coords in a w0 x h0 box
    const w0=v.size[0], h0=v.size[1];
    let rx=lx, ry=ly;
    for(let i=0;i<rot;i++){ const nx=ry, ny=w0-1-rx; rx=nx; ry=ny; }
    wx=s.origin.x+rx; wy=s.origin.y+ry;
    out.push({x:wx,y:wy,dir:rotLocal(ej.dir,s.rotation)});
  }
  return out;
}
function acceptors(e){
  const s=S(e); const v=variant(s.code); if(!v||!v.acceptors) return [];
  const out=[]; const w0=v.size[0];
  for(const a of v.acceptors){
    const [lx,ly]=a.tile; let rx=lx, ry=ly;
    const rot=(norm(s.rotation)/90|0);
    for(let i=0;i<rot;i++){ const nx=ry, ny=w0-1-rx; rx=nx; ry=ny; }
    out.push({x:s.origin.x+rx,y:s.origin.y+ry,dir:rotLocal(a.dir,s.rotation)});
  }
  return out;
}
module.exports={obj,ents,belts,machines,at,S,beltOut,beltIn,isBelt,ejectors,acceptors,footprint,variant,codeToB,DIRV,OPP,rotLocal,spec};
