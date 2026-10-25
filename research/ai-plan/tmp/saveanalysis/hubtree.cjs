const m=require('./net2.cjs');
const g=require('./dgraph2.cjs');
const {ents,belts,machines,S,byUid}=m;
const {out,inn}=g;
const desc=uid=>{const e=byUid.get(uid);const s=S(e);let t=s.code<=3?'belt':'code'+s.code;if(e.components.Miner)t='MINER';return t+'@'+s.origin.x+','+s.origin.y+' rot'+s.rotation;}
const hub=ents.find(e=>S(e).code===26).uid;
// BFS upstream, print tree with indent
const seen=new Set([hub]);
function walk(uid,depth,prefix){
  if(depth>40)return;
  const ups=[...(inn.get(uid)||[])];
  ups.forEach((u,i)=>{
    const last=i===ups.length-1;
    console.log(prefix+(last?'└─':'├─')+desc(u)+(seen.has(u)&&u!==hub?' [seen]':''));
    if(!seen.has(u)){seen.add(u);walk(u,depth+1,prefix+(last?'   ':'│  '));}
  });
}
console.log('HUB upstream tree:');
walk(hub,0,'');
