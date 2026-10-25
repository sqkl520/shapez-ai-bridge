const b=require('./graph3.cjs');
const {ents,machines,belts,S,byUid,out,inn,obj}=b;
const NM={4:'bal',7:'miner',9:'cut',11:'rot',15:'mix',16:'paint',17:'paintM',20:'trash',22:'tunIn',23:'tunOut',26:'hub'};
const kind=e=>{const c=S(e).code;if(c<=3)return 'belt';if(c===22||c===24)return 'tunIn';if(c===23||c===25)return 'tunOut';return NM[c]||('c'+c);};
const edges={};
for(const [a,set] of out){const ea=byUid.get(a);for(const t of set){const eb=byUid.get(t);const k=kind(ea)+'->'+kind(eb);edges[k]=(edges[k]||0)+1;}}
console.log('top edge types:');
for(const [k,v] of Object.entries(edges).sort((x,y)=>y[1]-x[1]).slice(0,22))console.log('  '+k.padEnd(22)+v);
// miners directly into balancers
let m2b=0,m2belt=0,m2tun=0,m2nothing=0;
for(const m of machines.filter(e=>e.components.Miner)){
  const o=[...(out.get(m.uid)||[])];
  if(!o.length){m2nothing++;continue;}
  for(const t of o){const k=kind(byUid.get(t));if(k==='bal')m2b++;else if(k==='belt')m2belt++;else if(k==='tunIn')m2tun++;}
}
console.log('\nminer outputs: ->balancer',m2b,'->belt',m2belt,'->tunnel',m2tun,'->dangling',m2nothing);
// painters directly into balancers
let p2b=0,p2belt=0;
for(const m of machines.filter(e=>S(e).code===16||S(e).code===17)){
  for(const t of (out.get(m.uid)||[])){const k=kind(byUid.get(t));if(k==='bal')p2b++;else if(k==='belt')p2belt++;}
}
console.log('painter outputs: ->balancer',p2b,'->belt',p2belt);
// how many balancers have >=1 direct machine input
let balFromMachine=0;
for(const m of machines.filter(e=>S(e).code===4)){
  const i=[...(inn.get(m.uid)||[])];
  if(i.some(u=>kind(byUid.get(u))!=='belt'))balFromMachine++;
}
console.log('balancers with at least one direct machine/tunnel input:',balFromMachine,'/',machines.filter(e=>S(e).code===4).length);
// tunnels per factory: how many tunnels are used for perpendicular crossing vs long haul
const pairs=b.tunnelPairs;
const vert=pairs.filter(p=>p.dir==='top'||p.dir==='bottom').length;
console.log('tunnels vertical',vert,'horizontal',pairs.length-vert,'avg span',(pairs.reduce((a,p)=>a+p.dist,0)/pairs.length).toFixed(2));
