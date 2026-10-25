const m=require('./net2.cjs');
const {ents,S}=m;
// convention: rotate local offsets about tile (0,0) (origin-anchored), allowing negative offsets
function rotCW(lx,ly,rot){let x=lx,y=ly;for(let i=0;i<rot;i++){const nx=-y,ny=x;[x,y]=[nx,ny];}return [x,y];}
function rotCCW(lx,ly,rot){let x=lx,y=ly;for(let i=0;i<rot;i++){const nx=y,ny=-x;[x,y]=[nx,ny];}return [x,y];}
function test(fn,name){
  const owner=new Map(); const conf=[];
  for(const e of ents){
    const s=S(e); const v=m.variant(s.code); if(!v)continue;
    const w=v.size[0],h=v.size[1]; const rot=((s.rotation%360)+360)%360/90|0;
    for(let ly=0;ly<h;ly++)for(let lx=0;lx<w;lx++){
      const [rx,ry]=fn(lx,ly,rot);
      const k=(s.origin.x+rx)+','+(s.origin.y+ry);
      if(owner.has(k))conf.push({k,a:owner.get(k),b:e.uid,ca:S(m.byUid.get(owner.get(k))).code,cb:s.code}); else owner.set(k,e.uid);
    }
  }
  console.log(name,'conflicts',conf.length,JSON.stringify(conf.slice(0,5)));
  // conflicting by code pair
  const pair={}; for(const c of conf){const k=(c.ca<=3?'belt':'c'+c.ca)+'/'+(c.cb<=3?'belt':'c'+c.cb);pair[k]=(pair[k]||0)+1;}
  console.log('   pairs',JSON.stringify(pair));
}
test(rotCW,'origin-anchored CW');
test(rotCCW,'origin-anchored CCW');
// also test: no conflict if allow machines overlapping belts (belts on machine tiles are legit in shapez? no)
