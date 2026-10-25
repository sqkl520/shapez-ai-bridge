const { decodeSave } = require('../../../recon/decode_full.cjs');
const path = process.env.APPDATA + '/shapez.io/saves/savegame-5c96706563c0b74c4d2ce4c7f8bf7a244392de89.bin';
const r = decodeSave(path);
const ents = r.obj.dump.entities;
console.log('字段:', Object.keys(ents[0]).join(','));
const types = {};
for (const e of ents) { const t = e.$type || e.type || '?'; types[t] = (types[t]||0)+1; }
console.log('类型分布:', JSON.stringify(types).slice(0,600));
