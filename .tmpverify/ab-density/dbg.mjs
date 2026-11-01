import fs from 'node:fs';
import { resolveRefs } from '../../src/agent/loop/coords.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';

const BASE = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const plans = [];
const seen = new Set();
for (const f of ['', '-v2', '-v3', '-v4', '-v5', '-v6']) {
    const file = `.tmpverify/ab-real/results${f}.json`;
    if (!fs.existsSync(file)) continue;
    for (const r of JSON.parse(fs.readFileSync(file, 'utf8'))) {
        if (!r.parse_ok) continue;
        let plan;
        try { plan = JSON.parse(String(r.text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()); } catch { continue; }
        if (!Array.isArray(plan.calls) || !plan.calls.length) continue;
        plans.push(plan);
    }
}
const baseHandles = buildHandles(BASE, null);
const referenced = new Set();
let resolvable = 0;
for (const plan of plans) {
    let calls;
    try {
        const r = resolveRefs(plan, baseHandles, BASE);
        if (r && r.ok === false) continue;
        calls = (r && Array.isArray(r.calls) && r.calls.length) ? r.calls : plan.calls;
    } catch { continue; }
    resolvable++;
    const walk = (v) => {
        if (Array.isArray(v)) { v.forEach(walk); return; }
        if (v && typeof v === 'object') {
            if (typeof v.uid === 'number') referenced.add(v.uid);
            Object.values(v).forEach(walk);
        }
    };
    for (const c of calls) walk(c.args || {});
}
console.log('plans', plans.length, 'resolvable', resolvable, 'referenced uids', referenced.size);

const hub = BASE.entities.find(e => e.type === 'hub');
const deletable = BASE.entities.filter(e => e.type === 'belt' && !referenced.has(e.uid));
console.log('belts total', BASE.entities.filter(e=>e.type==='belt').length);
console.log('deletable belts', deletable.length);
console.log('referenced belts', BASE.entities.filter(e=>e.type==='belt'&&referenced.has(e.uid)).length);
