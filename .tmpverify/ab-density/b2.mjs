import fs from 'node:fs';
import { connect } from '../../src/agent/macros/connect.mjs';
const BASE = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
// balancer 10035 在 (-8,-3)，2x1 占 (-8,-3) 和 (-7,-3)
// 试各种 to 目标，看能不能连上
const targets = BASE.entities.filter(e => e.type === 'belt').slice(0, 20);
let ok = 0;
for (const t of targets) {
    const r = connect({ from: { uid: 10035, port: 'secondary' }, to: { uid: t.uid } }, { entities: BASE.entities });
    if (r.ok) { ok++; console.log('OK → belt', t.uid, `(${t.x},${t.y})`); }
}
console.log('20 个目标里成功', ok);
// 用 allow_replace
let ok2 = 0;
for (const t of targets) {
    const r = connect({ from: { uid: 10035, port: 'secondary' }, to: { uid: t.uid }, opts: { allow_replace: true } }, { entities: BASE.entities });
    if (r.ok) ok2++;
}
console.log('加 allow_replace 后成功', ok2);
