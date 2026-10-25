const m=require('./net2.cjs');
const g=require('./dgraph2.cjs');
const {ents,belts,machines,S,byUid}=m;
const {out,inn}=g;
const ORDER=['top','right','bottom','left'];
function lab(uid){const e=byUid.get(uid);const s=S(e);if(s.code<=3)return 'belt';if(e.components.Miner)return 'MINER';if(s.code>=22&&s.code<=25)return 'tun'+s.code;return {4:'bal',5:'merg',9:'cut',10:'cutq',11:'rot',12:'rotccw',13:'rot180',15:'mix',16:'paint',17:'paintM',20:'trash',26:'HUB'}[s.code]||('code'+s.code);}
// Walk metro-style: from a start entity follow downstream, printing station stops
function metro(uid,label,depth){
  console.log('\n### '+label);
  const seen=new Set();
  function step(cur,indent){
    let n=0;
    while(true){
      if(seen.has(cur)){console.log(indent+'[loop]');return;}
      seen.add(cur);
      const e=byUid.get(cur); const s=S(e);
      if(n===0||s.code>3||n%40===39){
        console.log(indent+lab(cur)+'@'+s.origin.x+','+s.origin.y+(s.code>3?' rot'+s.rotation:''));
      }
      const outs=[...(out.get(cur)||[])];
      if(outs.length===0){console.log(indent+'  (dead end)');return;}
      if(outs.length>1){
        console.log(indent+'  SPLIT ×'+outs.length+':');
        for(const o of outs){const os=S(byUid.get(o));console.log(indent+'   - '+lab(o)+'@'+os.origin.x+','+os.origin.y);}
        return;
      }
      cur=outs[0]; n++;
      if(n>400){console.log(indent+'  ...');return;}
    }
  }
  step(uid,'  ');
}
const hub=ents.find(e=>S(e).code===26).uid;
const hubs=[...inn.get(hub)||[]];
for(const u of hubs){const s=S(byUid.get(u));metro(u,'feed from '+lab(u)+'@'+s.origin.x+','+s.origin.y);}
