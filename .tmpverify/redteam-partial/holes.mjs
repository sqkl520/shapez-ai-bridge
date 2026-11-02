/**
 * Q1 的判决点：`noPartialApply` 这条 check 的**形状**决定它有没有用。
 * strictVerdict 只认 name；phaseTwoVerdict 只认「可信检查里 ok===false」。
 * 所以：ok:true / skipped:true / 名字写错 这三种形状都能让它**静默消失**。
 */
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
const judge = (checks, label) => {
  const s = strictVerdict({ checks }, opts);
  const cls = classifyChecks({ checks }, { mode: "live" });
  const v = phaseTwoVerdict({ mode: "live", strict: s, checks: cls.trustworthy, goalDelta: 5 });
  console.log(`${label.padEnd(42)} strict.ok=${String(s.ok).padEnd(5)} achieved=${String(v.achieved).padEnd(5)} level=${v.level}`);
  return v.achieved;
};

judge(base, "全绿（对照）");
judge([...base, { name: "P-partial", ok: false, reason: "3/5 skipped" }], "P-partial ok:false");
judge([...base, { name: "P-partial", ok: true, reason: "3/5 skipped" }], "P-partial ok:true");
judge([...base, { name: "P-partial", ok: false, skipped: true }], "P-partial ok:false + skipped:true");
judge([...base, { name: "P-partial", ok: false, undecidable: true }], "P-partial ok:false + undecidable:true");
judge([...base, { name: "partial", ok: false }], "名字写成 partial");
judge([...base, { ok: false }], "没有 name");
/* classifyChecks 对待 unknown name 的口径 */
console.log('\nclassifyChecks 对 P-partial 的归类:', JSON.stringify(classifyChecks({ checks: [...base, { name: "P-partial", ok: false }] }, { mode: "live" }).trustworthy.map(c => c.name)));
console.log('classifyChecks 对 P-partial(skipped) 的归类:', JSON.stringify(classifyChecks({ checks: [...base, { name: "P-partial", ok: false, skipped: true }] }, { mode: "live" }).trustworthy.map(c => c.name)));
