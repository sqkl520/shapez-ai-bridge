import fs from 'node:fs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
const BASE = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const h = buildHandles(BASE, null);
for (const k of ['L1','L6']) {
  const r = h.byHandle.get(k);
  if (!r) continue;
  console.log(k, `(${r.x},${r.y}) cells=`, JSON.stringify(r.cells));
  console.log('  desc:', r.desc);
}
// 10035 的句柄
const m = [...h.byHandle.values()].find(v => v.uid === 10035);
console.log('uid 10035 的句柄:', m && m.handle, 'cells=', JSON.stringify(m && m.cells));
