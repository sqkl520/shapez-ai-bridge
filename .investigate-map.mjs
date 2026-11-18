import fs from "fs";
import {indexOf,at} from "./src/agent/loop/topology.mjs";
const obs=JSON.parse(fs.readFileSync(".investigate-obs.json","utf8")).result;
const it=JSON.parse(fs.readFileSync(".investigate-items3.json","utf8")).result;
const idx=indexOf(obs);
const items=new Map(); for(const b of it.belts){const k=b.cell.join(","); if(!items.has(k))items.set(k,[]); items.get(k).push(b.item);}
const SYM={belt:"#",hub:"H",trash:"T",balancer:"B",mixer:"M",miner:"m",cutter:"C",painter:"P",stacker:"S",rotater:"R"};
function map(x0,x1,y0,y1,label){
  console.log("\n=== "+label+" ===");
  let hdr="     ";for(let x=x0;x<=x1;x++)hdr+=(x%10===0?"|":" ");
  console.log(hdr);
  for(let y=y0;y<=y1;y++){
    let row=String(y).padStart(4)+" ";
    for(let x=x0;x<=x1;x++){
      const e=at(idx,[x,y]);
      if(!e){row+=".";}
      else { const ii=items.get(x+","+y); row += ii&&ii.length ? "*" : SYM[e.type]; }
    }
    console.log(row);
  }
  let t="     ";for(let x=x0;x<=x1;x++)t+=String(Math.abs(x)%10);
  console.log(t);
  console.log("(* = has items on it)");
}
map(25,45,-56,-34,"EAST CLUSTER (mixers/cutters/trash)");
map(-8,10,-6,18,"WEST CLUSTER (cutter/painter/stacker/rotater)");
