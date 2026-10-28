import fs from "node:fs";
const o=JSON.parse(fs.readFileSync("D:/Projects/rea/Project work/shapez/research/ai-plan/tmp/diag/obs.json","utf8"));
const es=o.result.entities;
const occ=new Map();
const wOf={miner:2,cutter:2,mixer:2,stacker:2,painter:2,balancer:2};
for(const e of es){
  const w=wOf[e.type]||1, h=1;
  for(let dx=0;dx<w;dx++) for(let dy=0;dy<h;dy++) occ.set(`${e.x+dx},${e.y+dy}`, e.type==="hub"?"H":e.type[0].toUpperCase());
}
const x0=-12,x1=12,y0=-20,y1=6;
let out="    ";
for(let x=x0;x<=x1;x++) out += (x%10===0?String(Math.abs(x/10)%10):" "); out+="\n";
for(let y=y0;y<=y1;y++){
  let line=String(y).padStart(3)+" ";
  for(let x=x0;x<=x1;x++){
    const k=`${x},${y}`;
    if(occ.has(k)) line+=occ.get(k);
    else if((x+y)%2===0) line+="·"; else line+=" ";
  }
  out+=line+"\n";
}
console.log(out);
