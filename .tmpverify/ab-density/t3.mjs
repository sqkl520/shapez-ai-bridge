import fs from 'node:fs';
import { connect } from '../../src/agent/macros/connect.mjs';
const E = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result.entities;
// balancer 10035 (-8,-3)，secondary 落点 (-7,-4)
// belt 10027 (-6,-3) 的 accept 落点 (-7,-3) → 那是 balancer 的第二格
const r = connect({ from: { uid: 10035, port: 'secondary' }, to: { uid: 10027 } }, { entities: E });
console.log('code:', r.ok ? 'OK' : r.error.code);
console.log('msg :', r.ok ? '-' : r.error.message);
console.log('hint:', r.ok ? '-' : r.error.hint);
