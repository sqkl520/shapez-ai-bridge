const b=require('./graph3.cjs');
const {obj,ents,belts,machines,S,byUid,at,out,inn,cellOwner,tunnelPairs}=b;
const w=require('../../../../src/ai/world.mjs');
const seed=obj.dump.map.seed;
const NM={4:'balancer',5:'merger',6:'mergerInv',7:'miner',8:'minerChain',9:'cutter',10:'cutterQuad',11:'rotater',12:'rotaterCCW',13:'rotater180',15:'mixer',16:'painter',17:'painterMirror',18:'painterDouble',19:'painterQuad',20:'trash',21:'storage',22:'tunIn',23:'tunOut',24:'tunIn2',25:'tunOut2',26:'hub'};
console.log('=== 1. ENTITY COMPOSITION ===');
const cnt={};for(const e of ents){const c=S(e).code;const k=c<=3?'belt(code'+c+')':(NM[c]||('code'+c));cnt[k]=(cnt[k]||0)+1;}
for(const k of Object.keys(cnt).sort((a,b)=>cnt[b]-cnt[a]))console.log('  '+k.padEnd(16)+cnt[k]);
console.log('  TOTAL',ents.length,'(belts 2107, machines 986)');
const beltCnt=[0,0,0];for(const e of belts){beltCnt[S(e).code-1]++;}
console.log('  belt variants: straight',beltCnt[0],'left-curve',beltCnt[1],'right-curve',beltCnt[2]);
console.log('  belt length equivalent',(beltCnt[0]*1+beltCnt[1]*0.78+beltCnt[2]*0.78).toFixed(1),'tiles');
console.log('  tunnel pairs',tunnelPairs.length,'total span',tunnelPairs.reduce((a,p)=>a+p.dist,0));

console.log('\n=== 2. MINERS ===');
const mn=machines.filter(e=>e.components.Miner).map(e=>{const s=S(e);return {x:s.origin.x,y:s.origin.y,rot:s.rotation,res:w.tileResource(seed,s.origin.x,s.origin.y),code:s.code};});
const byRes={};for(const m of mn)byRes[m.res]=(byRes[m.res]||0)+1;
console.log('  total',mn.length,'by resource',JSON.stringify(byRes));
console.log('  chainable(code8):',mn.filter(m=>m.code===8).length);
// spatial clusters R=6
const clusters=[];
const par=mn.map((_,i)=>i);const find=i=>par[i]===i?i:(par[i]=find(par[i]));const uni=(a,b)=>{a=find(a);b=find(b);if(a!==b)par[a]=b;};
for(let i=0;i<mn.length;i++)for(let j=i+1;j<mn.length;j++)if(Math.max(Math.abs(mn[i].x-mn[j].x),Math.abs(mn[i].y-mn[j].y))<=6)uni(i,j);
const grp={};mn.forEach((m,i)=>{const r=find(i);(grp[r]=grp[r]||[]).push(m);});
const cl=Object.values(grp).sort((a,b)=>b.length-a.length);
console.log('  clusters (Chebyshev<=6):',cl.length);
for(const g of cl){const xs=g.map(m=>m.x),ys=g.map(m=>m.y);const rr={};for(const m of g)rr[m.res]=(rr[m.res]||0)+1;
  console.log('    n='+String(g.length).padStart(2)+'  x['+Math.min(...xs)+'..'+Math.max(...xs)+'] y['+Math.min(...ys)+'..'+Math.max(...ys)+']  '+JSON.stringify(rr));}

console.log('\n=== 3. HUB ===');
const hub=ents.find(e=>S(e).code===26);
const HUBACC=[[0,0,'top'],[1,0,'top'],[2,0,'top'],[3,0,'top'],[0,3,'bottom'],[1,3,'bottom'],[2,3,'bottom'],[3,3,'bottom'],[0,0,'left'],[0,1,'left'],[0,2,'left'],[0,3,'left'],[3,0,'right'],[3,1,'right'],[3,2,'right'],[3,3,'right']];
const DIRV=b.DIRV,OPP={top:'bottom',bottom:'top',left:'right',right:'left'};
let used=0;
for(const [tx,ty,dir] of HUBACC){
  const wx=-2+tx,wy=-2+ty;const [dx,dy]=DIRV[dir];
  const uid=cellOwner.get((wx+dx)+','+(wy+dy));
  let s='EMPTY';
  if(uid!=null){const e=byUid.get(uid);const sc=S(e);if(sc.code<=3&&b.beltOut(e)===OPP[dir]){used++;s='belt@'+(wx+dx)+','+(wy+dy);}else s='blocked code'+sc.code;}
  console.log('  ('+tx+','+ty+') '+dir.padEnd(6)+' -> '+s);
}
console.log('  USED',used,'/16');

console.log('\n=== 4. ROUTE EFFICIENCY (longest paths) ===');
const BP=obj.dump.beltPaths;
const rows=[];
for(const p of BP){if(p.entityPath.length<15)continue;const a=S(byUid.get(p.entityPath[0])),z=S(byUid.get(p.entityPath[p.entityPath.length-1]));
  const actual=p.entityPath.length;const man=Math.abs(a.origin.x-z.origin.x)+Math.abs(a.origin.y-z.origin.y);
  rows.push({actual,man,ratio:actual/Math.max(man,1),a:a.origin,z:z.origin,items:p.items.length});}
rows.sort((x,y)=>y.actual-x.actual);
for(const r of rows)console.log('  len='+String(r.actual).padStart(3)+' manhattan='+String(r.man).padStart(3)+' ratio='+r.ratio.toFixed(2)+'  ('+r.a.x+','+r.a.y+')->('+r.z.x+','+r.z.y+') items='+r.items);

console.log('\n=== 5. SPACE / DENSITY ===');
let cellsUsed=0;for(const [k,v] of cellOwner)cellsUsed++;
const xs=ents.map(e=>S(e).origin.x),ys=ents.map(e=>S(e).origin.y);
const wBox=Math.max(...xs)-Math.min(...xs)+1,hBox=Math.max(...ys)-Math.min(...ys)+1;
console.log('  bbox x['+Math.min(...xs)+'..'+Math.max(...xs)+'] y['+Math.min(...ys)+'..'+Math.max(...ys)+']  = '+wBox+' x '+hBox+' tiles');
console.log('  occupied cells',cellsUsed,'=> fill',(100*cellsUsed/(wBox*hBox)).toFixed(1)+'%');
// connected comps summary
const parent=new Map();
const f2=x=>{let r=x;while(parent.get(r)!==undefined&&parent.get(r)!==r)r=parent.get(r);let c=x;while(parent.get(c)!==undefined&&parent.get(c)!==r){const n=parent.get(c);parent.set(c,r);c=n;}return r;};
const u2=(a,b)=>{a=f2(a);b=f2(b);if(a!==b)parent.set(a,b);};
for(const e of ents)parent.set(e.uid,e.uid);
for(const [a,set] of out)for(const bb of set)u2(a,bb);
const comps=new Map();for(const e of ents){const r=f2(e.uid);if(!comps.has(r))comps.set(r,[]);comps.get(r).push(e);}
const sizes=[...comps.values()].map(c=>c.length).sort((a,b)=>b-a);
console.log('  flow-connected components:',sizes.length,JSON.stringify(sizes));
