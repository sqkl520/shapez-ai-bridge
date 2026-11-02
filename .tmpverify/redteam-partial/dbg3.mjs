import fs from 'node:fs';
const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json','utf8')).result;
for (const cell of [[9,-14],[-10,-4],[-8,-9]]) {
  const e = OBS.entities.find(x => x.x===cell[0] && x.y===cell[1]);
  console.log(cell, e ? JSON.stringify(e) : 'empty');
}
