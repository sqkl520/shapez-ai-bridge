import fs from 'node:fs';
import { resolveRefs } from '../../src/agent/loop/coords.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { connect } from '../../src/agent/macros/connect.mjs';
import { slotsOf } from '../../src/agent/verify_runtime.mjs';

const BASE = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const h = buildHandles(BASE, null);
const footprintOf = (uid) => {
    const r = [...h.byHandle.values()].find(v => v.uid === uid);
    return r ? r.cells : [];
};

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

/* 对每个 occupied 失败：目标的**接收端口落点**是否落在源实体占地内 */
let accOnSrc = 0, other = 0;
const ex = [];
for (const plan of plans) {
    let calls;
    try {
        const r = resolveRefs(plan, h, BASE);
        if (r && r.ok === false) continue;
        calls = (r && r.calls && r.calls.length) ? r.calls : plan.calls;
    } catch { continue; }
    for (const c of calls) {
        if (c.macro !== 'connect') continue;
        const res = connect(c.args, { entities: BASE.entities });
        if (res.ok || res.error?.code !== 'occupied') continue;
        const fuid = c.args?.from?.uid, tuid = c.args?.to?.uid;
        const fe = BASE.entities.find(e => e.uid === fuid);
        const te = BASE.entities.find(e => e.uid === tuid);
        if (!fe || !te) continue;
        const srcCells = footprintOf(fuid);
        // 目标实体的 acceptor 落点
        const ts = slotsOf(te.type, te.variant || 'default', te.x, te.y, te.r || 0, te.rotation_variant);
        const accCells = ts ? ts.inputs.map(sl => sl.cell) : [];
        const hit = accCells.some(([x, y]) => srcCells.some(([sx, sy]) => sx === x && sy === y));
        if (hit) { accOnSrc++; if (ex.length < 3) ex.push({ fe, te, accCells, srcCells }); }
        else other++;
    }
}
console.log('occupied 失败中：');
console.log('  目标的 acceptor 落点落在源实体占地内:', accOnSrc);
console.log('  其他:', other);
console.log();
for (const e of ex) {
    console.log(`  ${e.fe.type}(${e.fe.x},${e.fe.y}) cells=${JSON.stringify(e.srcCells)} → ${e.te.type}(${e.te.x},${e.te.y}) acc=${JSON.stringify(e.accCells)}`);
}
