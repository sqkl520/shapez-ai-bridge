const b=require('./graph3.cjs');
const {ents,machines,S,at,cellOwner}=b;
const blocks={
 'Cu S-block':[96,112,-192,-172],
 'Su pyramid':[155,180,-162,-148],
 'Cu 4-row+painters':[92,125,-146,-128],
 'mixer row east':[124,156,-140,-132],
 'green east A':[204,236,-146,-130],
 'green east B':[203,235,-146,-130],
 'green/blue NE':[203,236,-146,-128],
 'Ru factory':[0,66,-14,4],
 'blue zigzag':[45,62,-2,14],
 'Cu vertical':[-12,20,76,104],
 'red+cu painters':[-12,4,77,105],
 'red mixers west':[-30,0,104,128],
 'Cu col east of hub':[6,20,76,104],
 'early factory':[-10,30,-12,20],
 'mixer lab':[0,38,38,76],
 'blue miners west':[2,8,-12,-6],
 'Cu block 2 (x8-26,y100)':[6,28,98,106],
};
// compute empty margin in each direction from block bbox using occupied cells
const occ=new Set(cellOwner.keys());
function margin(x0,x1,y0,y1,dx,dy){
  let d=0;
  for(let step=1;step<200;step++){
    let any=false;
    if(dx===1)for(let y=y0;y<=y1;y++)if(occ.has((x1+step)+','+y)){any=true;break;}
    if(dx===-1)for(let y=y0;y<=y1;y++)if(occ.has((x0-step)+','+y)){any=true;break;}
    if(dy===1)for(let x=x0;x<=x1;x++)if(occ.has(x+','+(y1+step))){any=true;break;}
    if(dy===-1)for(let x=x0;x<=x1;x++)if(occ.has(x+','+(y0-step))){any=true;break;}
    if(any)return step-1;
    d=step-1;
  }
  return 199;
}
console.log('free margin around each block (tiles until next occupied cell):');
for(const [n,[x0,x1,y0,y1]] of Object.entries(blocks)){
  const L=margin(x0,x1,y0,y1,-1,0),R=margin(x0,x1,y0,y1,1,0),U=margin(x0,x1,y0,y1,0,-1),D=margin(x0,x1,y0,y1,0,1);
  console.log('  '+n.padEnd(26)+' left='+String(L).padStart(3)+' right='+String(R).padStart(3)+' up='+String(U).padStart(3)+' down='+String(D).padStart(3));
}
// Machine-to-machine gap distribution: distance from each machine to nearest other machine
const ms=machines.map(e=>S(e).origin);
const grid=new Map();
for(const p of ms)grid.set(p.x+','+p.y,p);
const gaps=[];
for(const p of ms){
  let best=99;
  for(let r=1;r<=6;r++){
    let found=false;
    for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){if(Math.max(Math.abs(dx),Math.abs(dy))!==r)continue;if(grid.has((p.x+dx)+','+(p.y+dy))){found=true;break;}}
    if(found){best=r;break;}
  }
  gaps.push(best);
}
const hist={};for(const g of gaps){const k=g>=5?'5+':g;hist[k]=(hist[k]||0)+1;}
console.log('nearest-other-machine distance (Chebyshev):',JSON.stringify(hist));
