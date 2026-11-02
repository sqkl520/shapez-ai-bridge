/**
 * 诊断总量上限（PER_CODE 3 / TOTAL 8）会不会把「我造成的断口」压掉？
 * diagnose() 的合并后上限是 loop.mjs:886。这里直接调 diagnose 看真实条数。
 */
import fs from 'node:fs';
import { diagnose } from '../../src/agent/loop.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';
import { removeRun } from '../../src/agent/macros/remove.mjs';

const OBS = JSON.parse(fs.readFileSync('test/fixtures/saves/L4-obs.json', 'utf8')).result;
const d0 = diagnose(OBS, null, null, null, 'RuRu----', buildHandles(OBS, null), {});
console.log('基线 diagnose 条数:', d0.length, JSON.stringify(d0.map(d => [d.code, d.subject.handle])));
console.log('  suppressed_total:', d0[0].evidence.suppressed_total, ' suppressed(per code):', d0.map(d=>d.evidence.suppressed||0).join(','));

/* 删 3 条中段带子（模拟「部分执行把 remove_run 落了、replace_run 没落」的最坏情况） */
const belts = OBS.entities.filter(e => e.type === "belt").slice(0, 3);
const OBS2 = { ...OBS, entities: OBS.entities.filter(e => !belts.some(b => b.uid === e.uid)) };
const d1 = diagnose(OBS2, null, null, null, 'RuRu----', buildHandles(OBS2, null), {});
console.log('\n删 3 条后 diagnose 条数:', d1.length, JSON.stringify(d1.map(d => [d.code, d.subject.handle])));
console.log('  suppressed_total:', d1[0].evidence.suppressed_total);
const handles1 = new Set(d1.map(d => `${d.code}|${d.subject.handle}`));
const lost = d0.filter(d => !handles1.has(`${d.code}|${d.subject.handle}`));
console.log('  被挤出窗口的:', JSON.stringify(lost.map(d => [d.code, d.subject.handle])));
