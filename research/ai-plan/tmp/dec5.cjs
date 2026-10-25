const { decodeSave } = require('../../../recon/decode_full.cjs');
const path = process.env.APPDATA + '/shapez.io/saves/savegame-5c96706563c0b74c4d2ce4c7f8bf7a244392de89.bin';
const r = decodeSave(path);
const ents = r.obj.dump.entities;
// components 的键就是组件名
const compCount = {};
for (const e of ents) for (const c of Object.keys(e.components||{})) compCount[c] = (compCount[c]||0)+1;
console.log('组件分布:', JSON.stringify(compCount));
const tun = ents.filter(e => e.components && e.components.UndergroundBelt);
console.log('隧道数', tun.length);
for (const t of tun.slice(0,5)) console.log(JSON.stringify(t));
