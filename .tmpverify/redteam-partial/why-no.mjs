import fs from 'node:fs';
import { buildTxPlan } from '../../src/agent/loop.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const h = buildHandles(OBS, null);
const plans = [];
for (const f of ['', '-v2', '-v3', '-v4', '-v5', '-v6']) {
  const file = `.tmpverify/ab-real/results${f}.json`;
  if (!fs.existsSync(file)) continue;
  for (const x of JSON.parse(fs.readFileSync(file, 'utf8'))) {
    if (!x.parse_ok) continue;
    let p; try { p = JSON.parse(String(x.text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()); } catch { continue; }
    if (p && Array.isArray(p.calls) && p.calls.length) plans.push(p);
  }
}
const hist = {};
for (const plan of plans) {
  const b = buildTxPlan(plan, OBS, null, h, { partial: true });
  if (b.ok) continue;
  if (b.diagnosis.code !== 'NO_REVERSIBLE_CALL') continue;
  const sk = (b.diagnosis.evidence && b.diagnosis.evidence.skipped) || [];
  // 计数：这些计划里有多少条调用
  const key = `calls=${plan.calls.length} skipped=${sk.length}`;
  hist[key] = (hist[key] || 0) + 1;
}
console.log('NO_REVERSIBLE_CALL 的计划里，调用数 vs 被跳过数:');
for (const [k, v] of Object.entries(hist).sort((a,b)=>b[1]-a[1]).slice(0,8)) console.log(`  ${String(v).padStart(3)} × ${k}`);
