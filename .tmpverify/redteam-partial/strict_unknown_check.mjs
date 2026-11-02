/* 关键判据验证：strictVerdict 对**不认识的 check 名**是 fail-open 还是 fail-closed？ */
import { strictVerdict } from '../../src/agent/loop/verify.mjs';
import { phaseTwoVerdict, classifyChecks } from '../../src/agent/loop/offline_boundary.mjs';

const base = [
  { name: "L0-observation", ok: true },
  { name: "L1-landing", ok: true },
  { name: "L2-slots", ok: true },
  { name: "L3-flow", ok: true },
  { name: "L4-behavior", ok: true, evidence: { goal_delivered_delta: 5, goal_delivered_before: 0, goal_delivered_after: 5 } },
];
const opts = { mode: "live", goalShape: "RuRu----", flowsProvided: true, hasMachines: true, uidDiff: [] };

const a = strictVerdict({ checks: base }, opts);
console.log('全绿 strict.ok:', a.ok, a.why);

const b = strictVerdict({ checks: [...base, { name: "P-partial", ok: false, reason: "3 of 5 calls skipped" }] }, opts);
console.log('加一条 P-partial:false ⇒ strict.ok:', b.ok, '  why:', b.why);
const cls = classifyChecks({ checks: [...base, { name: "P-partial", ok: false }] }, { mode: "live" });
const v = phaseTwoVerdict({ mode: "live", strict: { ok: b.ok }, checks: cls.trustworthy, goalDelta: 5 });
console.log('  phaseTwoVerdict:', JSON.stringify({ achieved: v.achieved, level: v.level }), v.why);

const c = strictVerdict({ checks: [...base, { name: "P-partial", ok: false, undecidable: true }] }, opts);
console.log('把 P-partial 标成 undecidable:true ⇒ strict.ok:', c.ok, '  why:', c.why.slice(0,2));

/* 反向：una 完全不传 partial 字段（undefined）—— 若实现写成 `if (opts.partial === true)`，默认放行 */
const d = strictVerdict({ checks: base }, { ...opts, partial: undefined });
console.log('opts.partial = undefined ⇒ strict.ok:', d.ok, '（fail-open 的话这是绿的）');
