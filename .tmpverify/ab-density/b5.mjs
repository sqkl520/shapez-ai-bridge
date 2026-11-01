import fs from 'node:fs';
import { connect } from '../../src/agent/macros/connect.mjs';
const BASE = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
// 找 (-6,-3) 的 belt（就是模型选的那个）
const t = BASE.entities.find(e => e.x === -6 && e.y === -3 && e.type === 'belt');
console.log('target at (-6,-3):', JSON.stringify(t));
if (!t) process.exit(0);
const r = connect({ from: { uid: 10035, port: 'secondary' }, to: { uid: t.uid } }, { entities: BASE.entities });
console.log('ok:', r.ok);
if (!r.ok) {
  console.log('code:', r.error.code);
  console.log('msg:', r.error.message);
  const d = r.error.detail;
  if (d) console.log('detail:', JSON.stringify(d).slice(0, 400));
}
console.log();
// 打印 L7 周围 5x5
console.log('L7 周围:');
for (let y = -6; y <= -1; y++) {
  let row = '';
  for (let x = -10; x <= -4; x++) {
    const e = BASE.entities.find(z => z.x === x && z.y === y);
    row += e ? ({belt:'.',balancer:'B',cutter:'C',hub:'H',miner:'M',trash:'T',underground_belt:'U'}[e.type] || '?') : ' ';
  }
  console.log(`  y=${String(y).padStart(3)} |${row}|`);
}
