const { decodeSave } = require('../../../recon/decode_full.cjs');
const path = process.env.APPDATA + '/shapez.io/saves/savegame-5c96706563c0b74c4d2ce4c7f8bf7a244392de89.bin';
const r = decodeSave(path);
console.log('version', r.version);
console.log('顶层键:', Object.keys(r.obj).join(', '));
