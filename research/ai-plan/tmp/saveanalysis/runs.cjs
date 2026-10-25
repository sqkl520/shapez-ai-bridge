const m=require('./net2.cjs');
const {belts,S,byUid,at}=m;
const ORDER=['top','right','bottom','left'];
const rotLocal=(d,rot)=>{const steps=(((rot%360)+360)%360/90)|0;return ORDER[(ORDER.indexOf(d)+steps)%4];};
const DIRV={top:[0,-1],right:[1,0],bottom:[0,1],left:[-1,0]};
const beltOut=e=>{const s=S(e);return rotLocal(['top','left','right'][s.code-1],s.rotation);};
const beltIn=e=>rotLocal('bottom',S(e).rotation);
// find maximal straight runs
const used=new Set();
const runs=[];
for(const b of belts){
  const s=S(b);
  if(s.code!==1) continue;
  if(used.has(b.uid)) continue;
  const dir=beltOut(b);
  const [dx,dy]=DIRV[dir];
  // walk backwards
  let cx=s.origin.x, cy=s.origin.y, chain=[];
  let guard=0;
  while(guard++<500){
    const prev=at.get((cx-dx)+','+(cy-dy));
    if(!prev||S(prev).code!==1||used.has(prev.uid)) break;
    if(beltOut(prev)!==dir) break;
    cx-=dx; cy-=dy;
  }
  // now cx,cy = start
  chain=[];
  let x=cx,y=cy;
  guard=0;
  while(guard++<500){
    const e=at.get(x+','+y);
    if(!e||S(e).code!==1||used.has(e.uid)||beltOut(e)!==dir) break;
    used.add(e.uid); chain.push(e); x+=dx; y+=dy;
  }
  if(chain.length>=8) runs.push({dir,len:chain.length,x0:cx,y0:cy,x1:x-dx,y1:y-dy});
}
runs.sort((a,b)=>b.len-a.len);
console.log('straight runs >=8 tiles:',runs.length);
console.log('total length in such runs:',runs.reduce((a,r)=>a+r.len,0),'/',belts.filter(b=>S(b).code===1).length);
console.log('\nTop 30 runs:');
for(const r of runs.slice(0,30)) console.log('  '+r.dir.padEnd(6)+' len='+String(r.len).padEnd(4)+' from ('+r.x0+','+r.y0+') to ('+r.x1+','+r.y1+')');
