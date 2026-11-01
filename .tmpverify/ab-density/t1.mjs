import fs from 'node:fs';
import { connect } from '../../src/agent/macros/connect.mjs';
const BASE = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
// balancer 10035 (-8,-3) → belt 10027 (-6,-3)，后者的 acceptor 在 (-7,-3) = balancer 第二格
const r = connect({ from: { uid: 10035, port: 'secondary' }, to: { uid: 10027 } }, { entities: BASE.entities });
console.log('ok:', r.ok, 'code:', r.ok ? null : r.error.code);
if (!r.ok) console.log('msg:', r.error.message);
