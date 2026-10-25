const b=require('./graph3.cjs');
const {obj,ents,belts,machines,S,byUid,at,cellOwner}=b;
// coarse overview: each char is a 3x3 block, dominant feature
const minX=-32,maxX=234,minY=-192,maxY=130,BLK=4;
const rows=[];
for(let y=minY;y<=maxY;y+=BLK){
  let line='';
  for(let x=minX;x<=maxX;x+=BLK){
    let cnt={belt:0,miner:0,machine:0,resource:0};
    for(let dy=0;dy<BLK;dy++)for(let dx=0;dx<BLK;dx++){
      const e=at.get((x+dx)+','+(y+dy));
      if(e){const c=S(e).code;if(c<=3)cnt.belt++;else if(e.components.Miner)cnt.miner++;else cnt.machine++;}
    }
    let c='.';
    if(cnt.miner>=1&&cnt.belt+cnt.machine>0)c='M';
    else if(cnt.miner>=1)c='m';
    else if(cnt.machine>=3)c='#';
    else if(cnt.machine>=1)c='x';
    else if(cnt.belt>=4)c='=';
    else if(cnt.belt>=1)c='-';
    line+=c;
  }
  rows.push(String(y).padStart(5)+' '+line);
}
const hdr='      '+Array.from({length:Math.ceil((maxX-minX+1)/BLK)},(_,i)=>String(((minX+i*BLK)%100+100)%100).padStart(2,'0')).join('');
console.log('coarse map (1 char = 4x4 tiles; M=miner+belts m=bare miner #=3+machines x=machine -=belt ==belt-dense)');
console.log(hdr);
console.log(rows.join('\n'));
console.log('\nx axis: starts at x='+minX+', each char +'+BLK);
