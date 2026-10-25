const b=require('./graph3.cjs');
const {belts,S,at,obj,machines,byUid}=b;
const rows={};const cols={};
for(const bl of belts){const s=S(bl);rows[s.origin.y]=(rows[s.origin.y]||0)+1;cols[s.origin.x]=(cols[s.origin.x]||0)+1;}
console.log('busiest row-lines (y : belts):');
Object.entries(rows).sort((a,b)=>b[1]-a[1]).slice(0,12).forEach(([y,n])=>console.log('  y='+y+'  belts='+n));
console.log('busiest column-lines (x : belts):');
Object.entries(cols).sort((a,b)=>b[1]-a[1]).slice(0,12).forEach(([x,n])=>console.log('  x='+x+'  belts='+n));
// For corridor rows, count contiguous runs and span
function corridor(yf){
  const xs=belts.map(b=>S(b)).filter(s=>yf(s.origin.y)).map(s=>s.origin.x).sort((a,b)=>a-b);
  const runs=[];let st=xs[0],prev=xs[0];
  for(const x of xs.slice(1)){if(x-prev>1){runs.push([st,prev]);st=x;}prev=x;}
  runs.push([st,prev]);
  return runs.sort((a,b)=>(b[1]-b[0])-(a[1]-a[0]));
}
console.log('\nrow y=-144 belts:',(belts.filter(b=>S(b).origin.y===-144).length));
console.log('  runs:',JSON.stringify(corridor(y=>y===-144).slice(0,10)));
console.log('row y=-143 belts:',(belts.filter(b=>S(b).origin.y===-143).length),'runs',JSON.stringify(corridor(y=>y===-143).slice(0,6)));
console.log('row y=-129 belts:',(belts.filter(b=>S(b).origin.y===-129).length),'runs',JSON.stringify(corridor(y=>y===-129).slice(0,6)));
console.log('row y=1/2 belts:',(belts.filter(b=>S(b).origin.y===1||S(b).origin.y===2).length));
// area utilization
