const m=require('./net2.cjs');
const w=require('../../../../src/ai/world.mjs');
const {ents,belts,machines,S}=m;
const seed=43391;
const miners=machines.filter(e=>e.components.Miner).map(e=>{const s=S(e);return {x:s.origin.x,y:s.origin.y,rot:s.rotation,res:w.tileResource(seed,s.origin.x,s.origin.y)};});
// collect all resource cells within bbox of miners expanded by 12
const xs=miners.map(m=>m.x),ys=miners.map(m=>m.y);
const x0=Math.min(...xs)-14,x1=Math.max(...xs)+14,y0=Math.min(...ys)-14,y1=Math.max(...ys)+14;
const cells=new Map();
for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){const r=w.tileResource(seed,x,y);if(r)cells.set(x+','+y,r);}
// connected patches (4-neighbour, same res)
const seen=new Set(), patches=[];
for(const k of cells.keys()){
  if(seen.has(k))continue;
  const r=cells.get(k); const st=[k]; const comp=[];
  seen.add(k);
  while(st.length){const c=st.pop();comp.push(c);const [cx,cy]=c.split(',').map(Number);
    for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]]){const nk=(cx+dx)+','+(cy+dy);if(!seen.has(nk)&&cells.get(nk)===r){seen.add(nk);st.push(nk);}}}
  patches.push({res:r,cells:comp});
}
patches.sort((a,b)=>b.cells.length-a.cells.length);
const minerSet=new Set(miners.map(m=>m.x+','+m.y));
console.log('patches in miner bbox:',patches.length);
let totalMinerOnPatch=0;
for(const p of patches){
  const on=p.cells.filter(c=>minerSet.has(c)).length;
  totalMinerOnPatch+=on;
  const xs2=p.cells.map(c=>+c.split(',')[0]),ys2=p.cells.map(c=>+c.split(',')[1]);
  const bbox='x['+Math.min(...xs2)+'..'+Math.max(...xs2)+'] y['+Math.min(...ys2)+'..'+Math.max(...ys2)+']';
  console.log('  '+(p.res+'          ').slice(0,11)+' cells='+String(p.cells.length).padStart(3)+' miners='+String(on).padStart(2)+' cover='+(100*on/p.cells.length).toFixed(0)+'%  '+bbox);
}
console.log('miners on a patch cell:',totalMinerOnPatch,'of',miners.length);
const offPatch=miners.filter(m=>!cells.has(m.x+','+m.y));
console.log('miners NOT on a patch cell:',offPatch.length,JSON.stringify(offPatch.slice(0,5)));
// total cells by type
const byRes={};
for(const p of patches)byRes[p.res]=(byRes[p.res]||0)+p.cells.length;
console.log('resource cells in bbox by type:',JSON.stringify(byRes));
