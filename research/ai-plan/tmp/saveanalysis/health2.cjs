const b=require('./graph3.cjs');
const {ents,machines,belts,S,byUid,out,inn,ejectors}=b;
const NM={4:'bal',5:'merg',6:'merginv',7:'miner',9:'cut',11:'rot',15:'mix',16:'paint',17:'paintM',20:'trash',22:'tunIn',23:'tunOut',26:'hub'};
const deg=e=>[ (inn.get(e.uid)||new Set()).size, (out.get(e.uid)||new Set()).size ];
const iso=[],srcOnly=[],sinkOnly=[];
for(const e of machines){
  const [i,o]=deg(e);
  if(i===0&&o===0)iso.push(e); else if(i===0)srcOnly.push(e); else if(o===0)sinkOnly.push(e);
}
const tab=list=>{const c={};for(const e of list)c[NM[S(e).code]||S(e).code]=(c[NM[S(e).code]||S(e).code]||0)+1;return c;};
console.log('isolated machines',iso.length,JSON.stringify(tab(iso)));
console.log('pure sources (no input, has output)',srcOnly.length,JSON.stringify(tab(srcOnly)));
console.log('pure sinks (has input, no output)',sinkOnly.length,JSON.stringify(tab(sinkOnly)));
// dangling: ejector points at empty and no graph out
let dang=0;const dl=[];
for(const e of machines){const c=S(e).code;if(c===22||c===24||c===26)continue;if(!ejectors(e).length)continue;if(!(out.get(e.uid)||new Set()).size){dang++;dl.push(NM[c]+'@'+S(e).origin.x+','+S(e).origin.y);}}
console.log('dangling machines',dang,dl.join(' '));
// belts whose exit is empty
let de=0;for(const bl of belts){if(!(out.get(bl.uid)||new Set()).size)de++;}
console.log('belts exiting into empty',de);
// jam check: belts with items but downstream full? Use item counts per path (max 1/0.63=1.587)
const BP=b.obj.dump.beltPaths;
const over=BP.filter(p=>p.items.length/p.entityPath.length>1.5);
console.log('paths at saturation (>1.5 items/tile):',over.length,'of',BP.length);
const deadPaths=BP.filter(p=>p.items.length>0&&p.token===undefined&&false);
