const m=require('./net2.cjs');
const {ents,machines,belts,S,spec,rotLocal}=m;
// Try all 4 rotation conventions for 2x1 (and general) footprint, count conflicts
const rotFactories={
  cw:(lx,ly,w,h,rot)=>{let x=lx,y=ly,cw=w,ch=h;for(let i=0;i<rot;i++){const nx=ch-1-y,ny=x;[x,y]=[nx,ny];[cw,ch]=[ch,cw];}return [x,y];},
  ccw:(lx,ly,w,h,rot)=>{let x=lx,y=ly,cw=w,ch=h;for(let i=0;i<rot;i++){const nx=y,ny=cw-1-x;[x,y]=[nx,ny];[cw,ch]=[ch,cw];}return [x,y];},
};
function footprintsConv(conv){
  const owner=new Map(); const conflicts=[];
  for(const e of ents){
    const s=S(e); const v=m.variant(s.code); if(!v)continue;
    const w=v.size[0],h=v.size[1]; const rot=((s.rotation%360)+360)%360/90|0;
    let bw=w,bh=h; if(rot%2===1){bw=h;bh=w;}
    for(let ly=0;ly<h;ly++)for(let lx=0;lx<w;lx++){
      const [rx,ry]=rotFactories[conv](lx,ly,w,h,rot);
      const k=(s.origin.x+rx)+','+(s.origin.y+ry);
      if(owner.has(k))conflicts.push({k,a:owner.get(k),b:e.uid}); else owner.set(k,e.uid);
    }
  }
  return {owner,conflicts};
}
for(const conv of ['cw','ccw']){
  const {conflicts}=footprintsConv(conv);
  console.log(conv,'conflicts',conflicts.length,JSON.stringify(conflicts.slice(0,6)));
}
// Also test: origin is center-ish for odd rotations? test (origin at top-left of rotated bbox) is what cw does.
