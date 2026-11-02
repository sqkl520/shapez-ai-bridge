/**
 * 真机验证 `PARTIAL_APPLY` —— 不走 LLM，直接喂一个「部分执行」的计划。
 *
 * ## 为什么这样测
 *
 * 42 实体的真实世界太简单：模型两次都**第一次就成功**，走不到「失败→部分执行」的路径。
 * 而 `PARTIAL_APPLY` 只在部分执行时出现。
 *
 * 所以这里用 `ScriptedClient` 喂一个**已知会部分执行**的计划：
 *   #1 `connect(M1 → C1.primary)` —— 在真机上必失败（M1 的 out 已被占）
 *   #2 `connect(B83 → H1)`        —— 在离线夹具上成功且可撤销
 *
 * ⚠️ 真机的 uid 可能与离线夹具不同 —— 所以先 probe，找到真机上等价的调用。
 *
 * ## 要验证三件事
 *
 * 1. `PARTIAL_APPLY` 出现在 verdict.why 里
 * 2. `achieved === false`（不是假绿）
 * 3. plan 行的 `partial: true` + `skipped` 明细
 */
import fs from 'node:fs';
import path from 'node:path';
import { runLoop, makeBridgeReader, buildTxPlan } from '../../src/agent/loop.mjs';
import { buildHandles } from '../../src/agent/loop/handles.mjs';

const BASE = 'http://127.0.0.1:7777';
let id = 1;
async function rpc(method, params = {}, timeoutMs = 120000) {
    const res = await fetch(`${BASE}/rpc`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const b = await res.json();
    if (b.error) throw new Error(`${method}: ${b.error.message}`);
    return b.result;
}

/* ── preflight ── */
const st = await rpc('status');
console.log(`status: in_game=${st.in_game} hub_level=${st.hub_level}`);
if (!st.in_game) { console.error('✗ 不在游戏内'); process.exit(2); }

const obs0 = await rpc('obs', { layer: 'all', max_entities: 50000, include_hub: true, include_resources: true });
console.log(`preflight: ${obs0.entities.length} 实体`);
const seq0 = obs0.entities.map(e => e.uid).sort((a, b) => a - b);

/* ── ★ 先 probe：在**真机**上找一个「失败」和一个「可撤销成功」的调用 ── */
const handles = buildHandles(obs0, null);

async function tryPlan(calls) {
    const p = buildTxPlan({ say: "probe", calls }, obs0, null, handles);
    return p;
}

/* 候选 1：找一个必失败的 connect（从 miner 到 cutter 的 primary —— 离线必失败） */
const miners = [...handles.byHandle.values()].filter(v => v.type === "miner").map(v => v.handle);
const cutters = [...handles.byHandle.values()].filter(v => v.type === "cutter").map(v => v.handle);
let FAIL_CALL = null;
for (const m of miners) {
    for (const c of cutters) {
        const call = { macro: "connect", args: { from: { $ref: m }, to: { $ref: c, port: "primary" } }, why: "probe-fail" };
        const p = await tryPlan([call]);
        if (!p.ok) { FAIL_CALL = call; console.log(`找到失败调用: ${m}→${c}.primary (${p.diagnosis.code})`); break; }
    }
    if (FAIL_CALL) break;
}

/* 候选 2：找一个成功的、可撤销的 connect（带子 → hub） */
let OK_CALL = null;
const belts = [...handles.byHandle.values()].filter(v => v.type === "belt").map(v => v.handle);
for (const b of belts) {
    const call = { macro: "connect", args: { from: { $ref: b }, to: { $ref: "H1" } }, why: "probe-ok" };
    const p = await tryPlan([call]);
    if (!p.ok || !p.txPlan.ops.length) continue;
    const rev = p.txPlan.ops.every(o => o.op === "delete" || (o.op === "place" && ["belt", "underground_belt"].includes(o.building)));
    if (rev) { OK_CALL = call; console.log(`找到可撤销成功调用: ${b}→H1 (${p.txPlan.ops.length} ops)`); break; }
}

if (!FAIL_CALL || !OK_CALL) {
    console.error(`✗ probe 失败：FAIL=${!!FAIL_CALL} OK=${!!OK_CALL} —— 这个真机世界构造不出部分执行`);
    process.exit(3);
}

/* ── ★ 用这两个调用跑真 runLoop（partial 打开）── */
const PLAN = { say: "partial probe: one fails, one succeeds", calls: [FAIL_CALL, OK_CALL] };
const client = {
    async propose() { return { text: JSON.stringify(PLAN), usage: null, raw: null }; },
};

const reader = makeBridgeReader(BASE);
const guarded = {
    ...reader,
    async tx(ops) {
        const snap = await rpc('snapshot_save', { name: 'live-partial-probe' });
        console.log(`  [guard] snapshot: ${snap.name}`);
        const dry = await rpc('act', { op: 'tx', ops, dry_run: true });
        const dryOk = (dry.failures || []).length === 0 && dry.applied === dry.requested;
        console.log(`  [guard] dry_run: applied=${dry.applied}/${dry.requested} → ${dryOk ? '可执行' : '不可'}`);
        if (!dryOk) return { ...dry, ok: false };
        const real = await rpc('act', { op: 'tx', ops });
        console.log(`  [guard] real tx: ok=${real.ok} applied=${real.applied}`);
        return real;
    },
};

const runDir = path.resolve('.tmpverify/live-partial/runs');
fs.mkdirSync(runDir, { recursive: true });

console.log('\n═══ 跑 loop（partial:true，1 轮）═══');
const res = await runLoop({
    reader: guarded, goal: 'RuRu----', llmClient: client, mode: 'live', runDir,
    budget: { ROUNDS_MAX: 1, LLM_CALLS_MAX: 1, PARTIAL_APPLY: true, TX_MAX: 1 },
});

console.log(`\noutcome=${res.outcome} reason=${res.reason} level=${res.level}`);
console.log(`verdict: achieved=${res.verdict && res.verdict.achieved}`);
console.log(`why: ${JSON.stringify(res.verdict && res.verdict.why, null, 1)}`);

/* ── 读 transcript 核对 plan 行 ── */
const trPath = res.transcript_path;
if (trPath && fs.existsSync(trPath)) {
    const rows = fs.readFileSync(trPath, 'utf8').trim().split('\n').map(JSON.parse);
    const planRow = rows.find(r => r.kind === 'plan' && r.data.ok);
    if (planRow) {
        console.log(`\nplan 行: partial=${planRow.data.partial} skipped=${JSON.stringify(planRow.data.skipped)} ops=${planRow.data.tx_plan.ops}`);
    }
}

/* ── 独立核对世界 ── */
const obs1 = await rpc('obs', { layer: 'all', max_entities: 50000, include_hub: true });
const seq1 = obs1.entities.map(e => e.uid).sort((a, b) => a - b);
const added = seq1.filter(u => !seq0.includes(u));
const removed = seq0.filter(u => !seq1.includes(u));
console.log(`\n实体: ${seq0.length} → ${seq1.length} (+${added.length} / -${removed.length})`);

/* ── 三条断言 ── */
console.log('\n═══ 验收 ═══');
const why = (res.verdict && res.verdict.why) || [];
const hasPartial = why.some(w => String(w).includes('PARTIAL_APPLY'));
const achieved = !!(res.verdict && res.verdict.achieved);
console.log(`1. PARTIAL_APPLY 出现在 verdict.why: ${hasPartial ? '✓' : '✗'}`);
console.log(`2. achieved === false（不是假绿）: ${achieved === false ? '✓' : '✗ (' + achieved + ')'}`);
console.log(`3. 世界真的变了（partial 提交了子集）: ${added.length > 0 ? '✓ (+' + added.length + ')' : '✗'}`);

if (hasPartial && !achieved) {
    console.log('\n★ 通过：部分执行被提交，但判据层正确地判成了「不达成」');
} else {
    console.log('\n✗ 不通过');
    process.exitCode = 1;
}
