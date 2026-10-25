const m=require('./net2.cjs');
const {ents,belts,machines,S}=m;
const byCode={};
for(const e of machines){const c=S(e).code;(byCode[c]=byCode[c]||[]).push(e);}
// 1) ladder rows: same y, balancers at x step 2, >=4
function ladders(arr,step,minN){
  const byRow={};
  for(const e of arr){const s=S(e);(byRow[s.origin.y]=byRow[s.origin.y]||[]).push(s.origin.x);}
  const out=[];
  for(const y in byRow){const xs=byRow[y].sort((a,b)=>a-b);let run=[xs[0]];
    for(let i=1;i<xs.length;i++){if(xs[i]-xs[i-1]===step)run.push(xs[i]);else{if(run.length>=minN)out.push({y:+y,x0:run[0],x1:run[run.length-1],n:run.length});run=[xs[i]];}}
    if(run.length>=minN)out.push({y:+y,x0:run[0],x1:run[run.length-1],n:run.length});}
  return out.sort((a,b)=>b.n-a.n);
}
console.log('== balancer ladders (same y, x step 2, >=4) code4 ==');
const L=ladders(byCode[4],2,4);
for(const l of L)console.log('  y='+l.y+'  x '+l.x0+'..'+l.x1+'  n='+l.n);
console.log('  total ladders',L.length,'balancers in ladders',L.reduce((a,l)=>a+l.n,0),'/',byCode[4].length);
// 2) painter columns (same x, y step 2)
console.log('\n== painter columns (same x, y step 2, >=3) code16/17 ==');
for(const code of [16,17,15]){
  const arr=[...byCode[code]||[]];
  const byCol={};
  for(const e of arr){const s=S(e);(byCol[s.origin.x]=byCol[s.origin.x]||[]).push(s.origin.y);}
  const cols=[];
  for(const x in byCol){const ys=byCol[x].sort((a,b)=>a-b);let run=[ys[0]];
    for(let i=1;i<ys.length;i++){if(ys[i]-ys[i-1]===2)run.push(ys[i]);else{if(run.length>=3)cols.push({x:+x,y0:run[0],y1:run[run.length-1],n:run.length});run=[ys[i]];}}
    if(run.length>=3)cols.push({x:+x,y0:run[0],y1:run[run.length-1],n:run.length});}
  console.log(' code'+code+':');
  for(const c of cols)console.log('   x='+c.x+'  y '+c.y0+'..'+c.y1+'  n='+c.n);
}
// 3) miner rows (same y, step 1 or 2)
console.log('\n== miner rows ==');
const mr=ladders(byCode[7],1,3);
for(const r of mr)console.log('  y='+r.y+'  x '+r.x0+'..'+r.x1+'  n='+r.n);
const mr2=ladders(byCode[7],2,3);
for(const r of mr2)console.log('  (step2) y='+r.y+'  x '+r.x0+'..'+r.x1+'  n='+r.n);
// 4) diagonal structures: miners where x+y constant or x-y constant
console.log('\n== miner diagonals (x+y or x-y constant, >=3) ==');
const diag={};
for(const e of byCode[7]){const s=S(e);const a=s.origin.x+s.origin.y,b=s.origin.x-s.origin.y;(diag['s'+a]=diag['s'+a]||[]).push(s.origin.x);(diag['d'+b]=diag['d'+b]||[]).push(s.origin.x);}
for(const k in diag){const xs=diag[k].sort((a,b)=>a-b);if(xs.length>=3){
  // count consecutive
  let best=1,cur=1;for(let i=1;i<xs.length;i++){if(xs[i]-xs[i-1]===1||xs[i]-xs[i-1]===2)cur++;else cur=1;best=Math.max(best,cur);}
  if(best>=3)console.log('  '+(k[0]==='s'?'x+y='+(+k.slice(1)):'x-y='+(+k.slice(1)))+'  n='+xs.length+' consecutiveRun='+best+'  xs='+xs.join(','));
}}
