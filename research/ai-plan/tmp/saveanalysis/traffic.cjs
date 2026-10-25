const b=require('./graph3.cjs');
const {ents,out,S,byUid,at}=b;
const miners=ents.filter(e=>e.components.Miner).map(e=>e.uid);
const flow=new Map(); // uid -> number of miners whose items can reach it
for(const m of miners){
  const seen=new Set([m]);const q=[m];
  while(q.length){const n=q.pop();for(const o of (out.get(n)||[]))if(!seen.has(o)){seen.add(o);q.push(o);}}
  for(const u of seen)flow.set(u,(flow.get(u)||0)+1);
}
const arr=[...flow.entries()].map(([u,n])=>({u,n,s:S(byUid.get(u))})).sort((a,b)=>b.n-a.n);
console.log('top 25 highest-traffic entities (miners upstream):');
for(const x of arr.slice(0,25))console.log('  '+String(x.n).padStart(3)+' miners -> code'+x.s.code+'@'+x.s.origin.x+','+x.s.origin.y);
// histogram of traffic
const hist={};for(const x of arr){const k=x.n>=80?'80+':x.n>=50?'50-79':x.n>=20?'20-49':x.n>=5?'5-19':'1-4';hist[k]=(hist[k]||0)+1;}
console.log('traffic histogram',JSON.stringify(hist));
// trunk belts: traffic >= 20
const trunk=arr.filter(x=>x.n>=20&&x.s.code<=3);
console.log('belts carrying >=20 miners-worth of flow:',trunk.length);
const tx=trunk.map(x=>x.s.origin.x),ty=trunk.map(x=>x.s.origin.y);
console.log('  their bbox x['+Math.min(...tx)+'..'+Math.max(...tx)+'] y['+Math.min(...ty)+'..'+Math.max(...ty)+']');
const rows={};for(const x of trunk)rows[x.s.origin.y]=(rows[x.s.origin.y]||0)+1;
console.log('  by row:',JSON.stringify(Object.entries(rows).sort((a,b)=>b[1]-a[1]).slice(0,8)));
const cols={};for(const x of trunk)cols[x.s.origin.x]=(cols[x.s.origin.x]||0)+1;
console.log('  by column:',JSON.stringify(Object.entries(cols).sort((a,b)=>b[1]-a[1]).slice(0,8)));
// how much of the hub feed's flow comes from each hub entry
const hub=ents.find(e=>S(e).code===26).uid;
console.log('\nhub feed traffic (miners upstream per entry):');
for(const u of (b.inn.get(hub)||[])){const s=S(byUid.get(u));console.log('  entry belt@'+s.origin.x+','+s.origin.y+'  miners upstream='+(flow.get(u)||0));}
