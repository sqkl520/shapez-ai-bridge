/**
 * Q4 的可计算上界：「只告诉模型哪几条调用失败、让它删掉」能把整轮成功率抬到多少？
 * 这个数不需要 LLM 参与 —— 它只问「删掉失败的那些之后，剩下的计划能不能全绿」。
 * 对照组：现状（一条失败 ⇒ 整轮 0 op）。
 */
import fs from 'node:fs';
import { resolveRefs } from '../../src/agent/loop/coords.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { removeRun, replaceRun, trashUnused } from '../../src/agent/macros/remove.mjs';
import { insertMachine, extendLine } from '../../src/agent/macros/place.mjs';
import { connect } from '../../src/agent/macros/connect.mjs';
const F = { remove_run: removeRun, replace_run: replaceRun, trash_unused: trashUnused,
            insert_machine: insertMachine, extend_line: extendLine, connect };
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
    const per = calls.map(c => { const fn = F[String(c.macro || '')];
      if (!fn) return { ok: false }; try { const r = fn(c.args || {}, { entities: OBS.entities }); return { ok: !!(r && r.ok === true) }; } catch { return { ok: false }; } });
    rows.push({ n: calls.length, fails: per.filter(c => !c.ok).length, oks: per.filter(c => c.ok).length });
  }
}
const N = rows.length;
const dist = {};
for (const r of rows) dist[r.fails] = (dist[r.fails] || 0) + 1;
console.log('样本', N);
console.log('失败条数分布:', JSON.stringify(dist));
const oneFail = rows.filter(r => r.fails === 1).length;
const oneFailWithRestOks = rows.filter(r => r.fails === 1 && r.oks >= 1).length;
console.log(`\n★ 只差一条（删掉它整轮就全绿）: ${oneFail}/${N} = ${(100 * oneFail / N).toFixed(1)}%`);
console.log(`  其中还至少有一条成功（说明「删坏的那条、留好的」确实有东西可留）: ${oneFailWithRestOks}`);
console.log(`\n现状（全有或全无）: 8/${N} = 5.4%`);
console.log(`「已知哪一条坏 + 模型照做」的上界: ${(100 * oneFail / N).toFixed(1)}%（模型必须真的删掉那条且不再引入新错）`);
