import fs from 'node:fs';
import { resolveRefs } from '../../src/agent/loop/coords.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { planToTxOps } from '../../src/agent/loop/planToTxOps.mjs';
import { removeRun, replaceRun, trashUnused } from '../../src/agent/macros/remove.mjs';
import { insertMachine, extendLine } from '../../src/agent/macros/place.mjs';
import { connect } from '../../src/agent/macros/connect.mjs';
import { checkLanding } from '../../src/agent/verify_runtime.mjs';
const F = { remove_run: removeRun, replace_run: replaceRun, trash_unused: trashUnused, insert_machine: insertMachine, extend_line: extendLine, connect };
const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const handles = buildHandles(OBS, null);
const raw = JSON.parse(fs.readFileSync('.tmpverify/ab-real/results-v6.json', 'utf8')).slice(0, 6);
let shown = 0;
for (const x of raw) {
  let p; try { p = JSON.parse(String(x.text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()); } catch { continue; }
  let calls = p.calls;
  try { const rr = resolveRefs(p, handles, OBS); if (rr && rr.ok === false) continue; if (rr && Array.isArray(rr.calls) && rr.calls.length) calls = rr.calls; } catch { continue; }
  const per = calls.map(c => { const fn = F[c.macro]; if (!fn) return null; try { return fn(c.args || {}, { entities: OBS.entities }); } catch { return null; } });
  const okList = []; calls.forEach((c, i) => { if (per[i] && per[i].ok === true) okList.push({ macro: c.macro, args: c.args, result: per[i] }); });
  if (!okList.length || okList.length === calls.length) continue;
  const tp = planToTxOps(okList, { obs: OBS, items: null }); if (!tp || !tp.ok) continue;
  /* 用 verify 自己的口径：placements 带 uid=null，按 origin 匹配 */
  const after = { ...OBS, entities: [...OBS.entities, ...tp.placements.map((pl, i) => ({
    uid: 900000 + i, type: pl.kind, x: pl.x, y: pl.y, r: pl.rot || 0, variant: pl.variant || 'default',
    ...(pl.rv !== null && pl.rv !== undefined ? { rotation_variant: pl.rv, code: 1 + pl.rv } : (typeof pl.code === 'number' ? { code: pl.code } : {})),
  }))] };
  const l1 = checkLanding({ placements: tp.placements, removes: tp.removes }, after);
  if (!l1.ok && shown < 3) {
    shown++;
    console.log('placements 样例:', JSON.stringify(tp.placements.slice(0, 2)));
    console.log('L1 失败:', l1.reason);
    console.log('missing:', JSON.stringify(l1.evidence.missing.slice(0, 2)), 'wrong_code:', JSON.stringify(l1.evidence.wrong_code.slice(0, 2)));
    console.log('');
  }
}
