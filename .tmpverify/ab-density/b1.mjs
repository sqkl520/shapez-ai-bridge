import fs from 'node:fs';
import { resolveRefs } from '../../src/agent/loop/coords.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { connect } from '../../src/agent/macros/connect.mjs';

const BASE = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const h = buildHandles(BASE, null);
const plans = [];
for (const f of ['', '-v2', '-v3', '-v4', '-v5', '-v6']) {
    const file = `.tmpverify/ab-real/results${f}.json`;
    if (!fs.existsSync(file)) continue;
    for (const r of JSON.parse(fs.readFileSync(file, 'utf8'))) {
        if (!r.parse_ok) continue;
        let p; try { p = JSON.parse(String(r.text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()); } catch { continue; }
        if (Array.isArray(p.calls) && p.calls.length) plans.push(p);
    }
}
let n = 0;
for (const plan of plans) {
    let calls;
    try {
        const r = resolveRefs(plan, h, BASE);
        if (r && r.ok === false) continue;
        calls = (r && r.calls && r.calls.length) ? r.calls : plan.calls;
    } catch { continue; }
    for (const c of calls) {
        if (c.macro !== 'connect') continue;
        const fromUid = c.args && c.args.from && c.args.from.uid;
        const fe = BASE.entities.find(e => e.uid === fromUid);
        if (!fe || fe.type !== 'balancer') continue;
        const res = connect(c.args || {}, { entities: BASE.entities });
        if (res.ok || (res.error && res.error.code !== 'occupied')) continue;
        if (n++ < 4) {
            const toUid = c.args && c.args.to && c.args.to.uid;
            const te = BASE.entities.find(e => e.uid === toUid);
            console.log(`--- #${n} ---`);
            console.log('  from:', fe.type, `(${fe.x},${fe.y})`, 'port=' + (c.args.from.port || '(none)'));
            console.log('  to  :', te ? te.type + ` (${te.x},${te.y})` : 'uid ' + toUid);
            console.log('  err :', String(res.error.message).slice(0, 110));
        }
    }
}
