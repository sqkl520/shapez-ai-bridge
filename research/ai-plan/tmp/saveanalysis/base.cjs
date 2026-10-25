const {decodeSave}=require('../../../../recon/decode_full.cjs');
const P=process.env.APPDATA+'/shapez.io/saves/savegame-5c96706563c0b74c4d2ce4c7f8bf7a244392de89.bin';
const {obj}=decodeSave(P);
const ents=obj.dump.entities;
const spec=require('../../../../src/ai/machine-spec.json');
const ORDER=['top','right','bottom','left'];
const DIRV={top:[0,-1],right:[1,0],bottom:[0,1],left:[-1,0]};
const norm=a=>((a%360)+360)%360;
const rotLocal=(d,rot)=>{const steps=(norm(rot)/90)|0;return ORDER[(ORDER.indexOf(d)+steps)%4];};
const EXIT_LOCAL={0:'top',1:'left',2:'right'};
const S=e=>e.components.StaticMapEntity;
const isBelt=e=>S(e).code<=3;
const beltOut=e=>{const s=S(e);return rotLocal(EXIT_LOCAL[s.code-1],s.rotation);};
const beltIn=e=>rotLocal('bottom',S(e).rotation);
// origin-anchored clockwise rotation of local offsets: (x,y) -> (-y, x)
function rotOff(lx,ly,rot){let x=lx,y=ly;const steps=(norm(rot)/90)|0;for(let i=0;i<steps;i++){const nx=-y,ny=x;[x,y]=[nx,ny];}return [x,y];}
const codeToB={}; for(const c of spec.codes) codeToB[c.code]={b:c.building,v:c.variant};
function variant(code){const x=codeToB[code];return x?spec.buildings[x.b].variants[x.v]:null;}
function cells(e){
  const s=S(e);const v=variant(s.code);if(!v)return [[s.origin.x,s.origin.y]];
  const w=v.size[0],h=v.size[1];const out=[];
  for(let ly=0;ly<h;ly++)for(let lx=0;lx<w;lx++){const [rx,ry]=rotOff(lx,ly,s.rotation);out.push([s.origin.x+rx,s.origin.y+ry]);}
  return out;
}
function ejectors(e){const s=S(e);const v=variant(s.code);if(!v||!v.ejectors)return[];const out=[];for(const ej of v.ejectors){const [rx,ry]=rotOff(ej.tile[0],ej.tile[1],s.rotation);out.push({x:s.origin.x+rx,y:s.origin.y+ry,dir:rotLocal(ej.dir,s.rotation)});}return out;}
function acceptors(e){const s=S(e);const v=variant(s.code);if(!v||!v.acceptors)return[];const out=[];for(const a of v.acceptors){const [rx,ry]=rotOff(a.tile[0],a.tile[1],s.rotation);out.push({x:s.origin.x+rx,y:s.origin.y+ry,dir:rotLocal(a.dir,s.rotation)});}return out;}
const at=new Map(); const cellOwner=new Map();
for(const e of ents){const s=S(e);at.set(s.origin.x+','+s.origin.y,e);for(const [x,y] of cells(e)){const k=x+','+y;if(cellOwner.has(k))console.error('CONFLICT',k,cellOwner.get(k),e.uid);cellOwner.set(k,e.uid);}}
const belts=ents.filter(isBelt), machines=ents.filter(e=>!isBelt(e));
module.exports={obj,ents,belts,machines,at,cellOwner,cells,S,beltOut,beltIn,isBelt,ejectors,acceptors,variant,codeToB,DIRV,ORDER,rotLocal,rotOff,spec};
