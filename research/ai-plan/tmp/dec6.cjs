const { decodeSave } = require('../../../recon/decode_full.cjs');
const path = process.env.APPDATA + '/shapez.io/saves/savegame-5c96706563c0b74c4d2ce4c7f8bf7a244392de89.bin';
const r = decodeSave(path);
const tun = r.obj.dump.entities.filter(e => e.components && e.components.UndergroundBelt);
const S = e => e.components.StaticMapEntity;
// 按 code 分 sender(22)/receiver(23)，配对同列/同行同朝向
const sender = tun.filter(e => S(e).code === 22);
const recv = tun.filter(e => S(e).code === 23);
console.log('sender', sender.length, 'receiver', recv.length);
const spans = [];
for (const s of sender) {
  const a = S(s).origin, ar = S(s).rotation;
  let best = null;
  for (const t of recv) {
    const b = S(t).origin, br = S(t).rotation;
    if (br !== ar) continue;
    // rotation 180 = 朝下；180 度的方向向量 (0,1)
    const dir = {0:[0,-1],90:[1,0],180:[0,1],270:[-1,0]}[ar];
    const dx = b.x - a.x, dy = b.y - a.y;
    if (dir[0] !== 0 && Math.sign(dx) !== dir[0]) continue;
    if (dir[1] !== 0 && Math.sign(dy) !== dir[1]) continue;
    if (dx !== 0 && dy !== 0) continue;
    const d = Math.abs(dx + dy);
    if (d > 0 && (!best || d < best.d)) best = { d };
  }
  if (best) spans.push(best.d);
}
const hist = {};
for (const d of spans) hist[d] = (hist[d]||0)+1;
console.log('跨度分布(格):', JSON.stringify(hist));
console.log('最大跨度:', Math.max(...spans));
