import fs from 'node:fs';
import { resolveRefs } from '../../src/agent/loop/coords.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { planToTxOps } from '../../src/agent/loop/planToTxOps.mjs';
import { trashUnused } from '../../src/agent/macros/remove.mjs';
import { connect } from '../../src/agent/macros/connect.mjs';
import { checkLanding } from '../../src/agent/verify_runtime.mjs';
const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const handles = buildHandles(OBS, null);
const x = JSON.parse(fs.readFileSync('.tmpverify/ab-real/results-v6.json', 'utf8'))[0];
let p = JSON.parse(String(x.text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim());
const rr = resolveRefs(p, handles, OBS);
const calls = rr.calls || p.calls;
const F = { connect, trash_unused: trashUnused };
const per = calls.map(c => { const fn = F[c.macro]; try { return fn(c.args || {}, { entities: OBS.entities }); } catch { return null; } });
const okList = []; calls.forEach((c, i) => { if (per[i] && per[i].ok) okList.push({ macro: c.macro, args: c.args, result: per[i] }); });
const tp = planToTxOps(okList, { obs: OBS, items: null });
console.log('okList:', okList.map(c => c.macro), 'ops:', tp.ops.length, 'placements:', tp.placements.length);
const after = { ...OBS, entities: [...OBS.entities, ...tp.placements.map((pl, i) => ({
  uid: 900000 + i, type: pl.kind, x: pl.x, y: pl.y, r: pl.rot || 0, variant: pl.variant || 'default',
  ...(pl.kind === 'belt' ? { rotation_variant: pl.rv, code: 1 + pl.rv } : { code: pl.code }),
}))] };
const l1 = checkLanding({ placements: tp.placements, removes: tp.removes }, after);
console.log('L1:', l1.ok, l1.reason);
console.log('missing', JSON.stringify(l1.evidence.missing.slice(0,3)));
console.log('wrong_rot', JSON.stringify(l1.evidence.wrong_rot.slice(0,3)));
