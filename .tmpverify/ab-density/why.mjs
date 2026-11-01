import fs from 'node:fs';
import { resolveRefs } from '../../src/agent/loop/coords.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { connect } from '../../src/agent/macros/connect.mjs';

const BASE = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const baseHandles = buildHandles(BASE, null);

const plans = [];
for (const f of ['', '-v2', '-v3', '-v4', '-v5', '-v6']) {
    const file = `.tmpverify/ab-real/results${f}.json`;
    if (!fs.existsSync(file)) continue;
    for (const r of JSON.parse(fs.readFileSync(file, 'utf8'))) {
        if (!r.parse_ok) continue;
        let plan;
        try { plan = JSON.parse(String(r.text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()); }
        catch { continue; }
        if (!Array.isArray(plan.calls) || !plan.calls.length) continue;
        plans.push(plan);
    }
}

// 只看 connect 的失败，按 from 实体类型 + 错误码分类
const stats = {};
const samples = {};
for (const plan of plans) {
    let calls;
    try {
        const r = resolveRefs(plan, baseHandles, BASE);
        if (r && r.ok === false) continue;
        calls = (r && Array.isArray(r.calls) && r.calls.length) ? r.calls : plan.calls;
    } catch { continue; }
    for (const c of calls) {
        if (c.macro !== 'connect') continue;
        const res = connect(c.args || {}, { entities: BASE.entities });
        if (res.ok) continue;
        const code = res.error && res.error.code || '?';
        // from 实体的类型
        const fromUid = c.args && c.args.from && c.args.from.uid;
        const fe = BASE.entities.find(e => e.uid === fromUid);
        const key = `${code} | from=${fe ? fe.type : '?'}`;
        stats[key] = (stats[key] || 0) + 1;
        if (!samples[key]) samples[key] = { args: c.args, msg: String(res.error && res.error.message).slice(0, 120) };
    }
}
console.log('connect 失败分类（共 ' + Object.values(stats).reduce((a,b)=>a+b,0) + ' 次）:\n');
for (const [k, v] of Object.entries(stats).sort((a, b) => b[1] - a[1])) {
    console.log(String(v).padStart(3), '×', k);
    if (v >= 4 && samples[k]) console.log('      ', samples[k].msg);
}
