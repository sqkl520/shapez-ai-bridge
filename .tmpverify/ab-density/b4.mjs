import fs from 'node:fs';
import { connect } from '../../src/agent/macros/connect.mjs';
const BASE = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
// L7 = uid 10035 在 (-8,-3)，占 (-8,-3) 和 (-7,-3)
// secondary ejector 应该在 (-7,-3) 朝 top ⇒ 出货落点 (-7,-4)
// 看看连到 (-6,-3) 的 belt 时，宏说第一处冲突在哪
const r = connect({ from: { uid: 10035, port: 'secondary' }, to: { uid: 10033 } }, { entities: BASE.entities });
console.log('ok:', r.ok);
if (!r.ok) {
  console.log('code:', r.error.code);
  console.log('msg:', r.error.message);
  console.log('detail:', JSON.stringify(r.error.detail, null, 1).slice(0, 500));
}
console.log();
// 目标 belt 10033 在哪？
const t = BASE.entities.find(e => e.uid === 10033);
console.log('target 10033:', JSON.stringify(t));
