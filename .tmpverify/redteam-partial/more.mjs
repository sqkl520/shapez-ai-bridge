import fs from 'node:fs';
import { resolveRefs } from '../../src/agent/loop/coords.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { removeRun, replaceRun, trashUnused } from '../../src/agent/macros/remove.mjs';
import { insertMachine, extendLine } from '../../src/agent/macros/place.mjs';
import { connect } from '../../src/agent/macros/connect.mjs';
const F = { remove_run: removeRun, replace_run: replaceRun, trash_unused: trashUnused, insert_machine: insertMachine, extend_line: extendLine, connect };
const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const handles = buildHandles(OBS, null);
const rows = [];
for (const f of ['', '-v2', '-v3', '-v4', '-v5']) {
  const seen = new Set();
  for (const x of JSON.parse(fs.readFileSync('.tmpverify/ab-real/results' + f + '.json', 'utf8'))) {
    if (!x.parse_ok) continue;
    const k = `${x.arm}#${x.rep}`; if (seen.has(k)) continue; seen.add(k);
    let p; try { p = JSON.parse(String(x.text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()); } catch { continue; }
    if (!p || !Array.isArray(p.calls) || !p.calls.length) continue;
    let calls = p.calls;
    try { const rr = resolveRefs(p, handles, OBS); if (rr && rr.ok === false) continue; if (rr && Array.isArray(rr.calls) && rr.calls.length) calls = rr.calls; } catch { continue; }
    const per = calls.map(c => { const fn = F[String(c.macro || '')]; if (!fn) return { macro: c.macro, ok: false }; let r; try { r = fn(c.args || {}, { entities: OBS.entities }); } catch { return { macro: c.macro, ok: false }; } return { macro: c.macro, ok: !!(r && r.ok === true) }; });
    rows.push(per);
  }
}
const N = rows.length;
const has = (per, m) => per.some(c => c.macro === m && c.ok);
const stat = {
  'connect 成功': rows.filter(p => has(p, 'connect')).length,
  'replace_run 成功': rows.filter(p => has(p, 'replace_run')).length,
  'trash_unused 成功': rows.filter(p => has(p, 'trash_unused')).length,
  'connect 或 replace_run 成功（目标相关）': rows.filter(p => has(p, 'connect') || has(p, 'replace_run')).length,
  '只有 trash/insert 成功（纯清理）': rows.filter(p => !has(p, 'connect') && !has(p, 'replace_run') && (has(p, 'trash_unused') || has(p, 'insert_machine'))).length,
};
console.log('N =', N);
for (const [k, v] of Object.entries(stat)) console.log(`  ${k}: ${v}/${N}  (${(100 * v / N).toFixed(1)}%)`);
/* trash 落盘后不可逆：没有任何宏能删 trash（MACRO_NAMES 六个里 remove_run 只处理带子） */
console.log('\n可删 trash 的宏:', 'none');
