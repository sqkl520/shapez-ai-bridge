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
let selfTarget = 0, other = 0;
const examples = [];
for (const plan of plans) {
    let calls;
    try {
        const r = resolveRefs(plan, h, BASE);
        if (r && r.ok === false) continue;
        calls = (r && r.calls && r.calls.length) ? r.calls : plan.calls;
    } catch { continue; }
    for (const c of calls) {
        if (c.macro !== 'connect') continue;
        const fuid = c.args?.from?.uid, tuid = c.args?.to?.uid;
        const fe = BASE.entities.find(e => e.uid === fuid);
        const te = BASE.entities.find(e => e.uid === tuid);
        if (!fe || !te) continue;
        const res = connect(c.args, { entities: BASE.entities });
        if (res.ok) continue;
        // 目标是否落在源实体的 footprint 内（用 cells）
        const cells = h.byHandle && [...h.byHandle.values()].find(v => v.uid === fuid)?.cells || [];
        const inSelf = cells.some(([x, y]) => x === te.x && y === te.y);
        if (inSelf) { selfTarget++; if (examples.length < 3) examples.push({ fe, te, args: c.args }); }
        else other++;
    }
}
console.log('connect 失败中：');
console.log('  目标落在源实体自己占地内:', selfTarget);
console.log('  其他:', other);
console.log();
for (const e of examples) {
    console.log(`  ${e.fe.type}(${e.fe.x},${e.fe.y}) → ${e.te.type}(${e.te.x},${e.te.y}) port=${e.args.from?.port}`);
}
