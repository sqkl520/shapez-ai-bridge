/* offline_boundary 的不可信表里写的是 "tx-atomicity"，而真实 check 名是 "A-tx"。
   查一下这是不是一条既有的口子（对部分执行很关键，因为 A-tx 是放 partial 判据的天然位置）。 */
import { classifyChecks, phaseTwoVerdict, OFFLINE_UNVERIFIABLE } from '../../src/agent/loop/offline_boundary.mjs';
const checks = [
  { name: "L0-observation", ok: true },
  { name: "L1-landing", ok: true },
  { name: "A-tx", ok: false, reason: "applied 2 ≠ requested 5" },
];
const m = classifyChecks({ checks }, { mode: "mock" });
console.log('OFFLINE_UNVERIFIABLE 的键:', Object.keys(OFFLINE_UNVERIFIABLE));
console.log('mock 下 A-tx 的归类:', m.untrustworthy.some(x => x.name === "A-tx") ? "不可信" : "可信（被当真判据）");
const v = phaseTwoVerdict({ mode: "mock", strict: { ok: true }, checks: m.trustworthy, goalDelta: 0 });
console.log('A-tx 红 ⇒ phaseTwoVerdict:', JSON.stringify({ level: v.level, achieved: v.achieved }), v.why.slice(0, 2));
console.log('\n对照：写 "tx-atomicity" 才被当成不可信');
const m2 = classifyChecks({ checks: [{ name: "tx-atomicity", ok: false }] }, { mode: "mock" });
console.log('  tx-atomicity 是否不可信:', m2.untrustworthy.some(x => x.name === "tx-atomicity"));
