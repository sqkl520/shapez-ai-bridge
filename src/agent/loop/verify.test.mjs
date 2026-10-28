/**
 * verify.test.mjs — 裁决层的判据，重点是**红队实测出来的那四类假绿**。
 *
 * 每一条负例都对应一个真实事故/实测：
 *   1. `tx.verify === null`（成功 tx 的真实形态）→ 不能抛 TypeError，且判 ok
 *   2. `tx.verify.uid_set_equal === false` + `rolled_back` → hardStop（回滚没洗干净）
 *   3. `ok:true` 但 `diff` 全空 → NO_WORLD_CHANGE（"成功但世界没变"是本项目最常见的假绿）
 *   4. L4 的 `goal_delivered_delta === null` → 红（读不到 hub 计数不许假设它涨了）
 *   5. L3 的 `degraded === true` → 红（有边界的绿不是验证过）
 *   6. `undeclaredDestruction`：before 有 A、after 没有、destroys 不含 A → [A]
 *   7. `verifyRuntime().ok` 为 true 而 `strictVerdict` 必须为 false（skipped 被当绿的形态）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    verifyRound, strictVerdict, applyVerdict, undeclaredDestruction, buildUidMap, worldUidSetHash,
} from "./verify.mjs";
import { planToTxOps } from "./planToTxOps.mjs";
import { replaceRun } from "../macros/remove.mjs";
import { verifyRuntime } from "../verify_runtime.mjs";
import FakeGame from "../fake_game.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAVES = path.resolve(HERE, "../../../test/fixtures/saves");
const L4 = path.join(SAVES, "L4-obs.json");

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label, extra) {
    if (cond && typeof cond.then === "function") {
        fail++; failures.push(label + " [Promise 当布尔]");
        console.log("✗ " + label + "  [cond 是 Promise]");
        return;
    }
    if (cond) { pass++; console.log("✓ " + label); }
    else {
        fail++; failures.push(label);
        console.log("✗ " + label + (extra !== undefined ? "  " + JSON.stringify(extra).slice(0, 500) : ""));
    }
}
const eq = (got, want, label) => ok(got === want, label, { got, want });

function l4Game() {
    return FakeGame.fromFiles(L4, null, { goal: "RuRu----" });
}

/** 一个「成功 tx」的最小真实形态（字段按 bridge:3387-3450 抄，verify 为 null）。 */
function goodTx(over = {}) {
    return {
        ok: true, op: "tx",
        applied: 5, requested: 5,
        rolled_back: false, dry_run: false, aborted: false,
        failures: [],
        diff: { added: [1, 2], removed: [10143, 10149, 10209], modified: [] },
        net: null,
        verify: null,                       // ★ 成功时恒为 null（bridge:3361-3362）★
        rollback: null,
        results: [],
        ...over,
    };
}

/* ═══════════ 1. applyVerdict：红队负例 1/2/3 ═══════════ */

{
    /* 负例 1：verify:null 的成功 tx —— 不能抛异常，且判 ok */
    let threw = null, res = null;
    try {
        res = applyVerdict(goodTx(), { requestedOps: 5 });
    } catch (e) { threw = e; }
    ok(threw === null, "负例1：applyVerdict(verify:null) 不抛异常", threw && String(threw.message));
    ok(res && res.ok === true, "负例1：verify:null + 全部真实成功 ⇒ 判 ok（成功路径不能读 verify）", res);
    eq(res && res.hardStop, false, "负例1：正常成功不 hardStop");

    /* 负例 2：回滚 + uid_set_equal=false ⇒ hardStop */
    const rb = goodTx({
        ok: false, applied: 3, rolled_back: true,
        diff: { added: [], removed: [], modified: [] },
        verify: { ran: true, uid_set_equal: false, entities_equal: false, modified: [], diffs: [], diff_truncated: false },
    });
    const r2 = applyVerdict(rb, { requestedOps: 5 });
    ok(r2.ok === false && r2.hardStop === true, "负例2：回滚且 uid_set_equal=false ⇒ hardStop:true", r2);
    ok(r2.why.some(w => /没洗干净/.test(w)), "负例2：why 里点名「回滚没洗干净」", r2.why);

    /* 回滚但洗干净（uid_set_equal=true）：也是失败，但**不是** hardStop */
    const rb2 = goodTx({
        ok: false, rolled_back: true, diff: { added: [], removed: [], modified: [] },
        verify: { ran: true, uid_set_equal: true, entities_equal: true, modified: [], diffs: [], diff_truncated: false },
    });
    const r2b = applyVerdict(rb2, { requestedOps: 5 });
    ok(r2b.ok === false && r2b.hardStop === false, "回滚洗干净 ⇒ 失败但可重试（hardStop:false）", r2b);

    /* 负例 3：ok:true 但 diff 全空 ⇒ NO_WORLD_CHANGE */
    const noop = goodTx({ diff: { added: [], removed: [], modified: [] } });
    const r3 = applyVerdict(noop, { requestedOps: 5 });
    ok(r3.ok === false, "负例3：ok:true + diff 全空 ⇒ 不判 ok", r3);
    ok(r3.why.some(w => /NO_WORLD_CHANGE/.test(w)), "负例3：why 里是 NO_WORLD_CHANGE", r3.why);

    /* diff 只有 removed（纯删除轮）也算世界变了 */
    const onlyRemoved = goodTx({ diff: { added: [], removed: [10143], modified: [] } });
    ok(applyVerdict(onlyRemoved, { requestedOps: 5 }).ok === true, "纯删除的 tx（added 空、removed 非空）算世界变了");

    /* dry_run：loop 从不传，传了就是接错线 */
    const dry = applyVerdict(goodTx({ dry_run: true, ok: false, rolled_back: true, verify: { uid_set_equal: true } }), { requestedOps: 5 });
    ok(dry.ok === false && dry.why.some(w => /dry_run/.test(w)), "tx.dry_run=true ⇒ 失败（dry_run 不能当落盘成功）", dry);

    /* applied ≠ requested */
    const short = applyVerdict(goodTx({ applied: 4 }), { requestedOps: 5 });
    ok(short.ok === false && short.why.some(w => /applied/.test(w)), "applied 4 ≠ requested 5 ⇒ 失败", short);

    /* tx 缺失 */
    const none = applyVerdict(null, { requestedOps: 1 });
    ok(none.ok === false && none.hardStop === true, "tx 返回缺失 ⇒ hardStop（没有结果不是成功）", none);

    /* ★ 反向保险：applyVerdict 的源码里不许出现对 mismatch 的依赖 ★ */
    const src = fs.readFileSync(path.join(HERE, "verify.mjs"), "utf8");
    ok(!/\.mismatch\b/.test(src.replace(/不存在.*mismatch|mismatch.*不存在|没有 `mismatch`/g, "")),
        "实现里不读 results[i].mismatch（bridge:3402-3406 没有这个字段）");
}

/* ═══════════ 2. buildUidMap：只用 results[i].uid ═══════════ */

{
    const tx = { results: [
        { index: 0, op: "delete", ok: true, uid: 10143, applied: true },
        { index: 3, op: "place", ok: true, uid: 10901, applied: true },
        { index: 4, op: "place", ok: false, uid: undefined, applied: undefined },
    ] };
    const m = buildUidMap(tx, { 3: "replace_run:cutter@4,-13", 4: "replace_run:trash@4,-14" });
    eq(m.uidMap["replace_run:cutter@4,-13"], 10901, "buildUidMap 用 results[i].uid 桥接 token → 真 uid");
    eq(m.missing.length, 1, "results[i].uid 缺失的 token 进 missing（不猜）");
    eq(m.coerced.length, 0, "coerced 恒空：mismatch 不存在，GAME_COERCED 只能由 L1 判");
    ok(!("mismatch" in tx.results[0]), "（事实）结果对象上没有 mismatch 字段");
}

/* ═══════════ 3. undeclaredDestruction：负例 7 ═══════════ */

{
    const before = { entities: [{ uid: 1 }, { uid: 2 }, { uid: 3 }] };
    const after = { entities: [{ uid: 1 }, { uid: 3 }] };
    eq(JSON.stringify(undeclaredDestruction(before, after, [])), "[2]",
        "负例7：before 有 2、after 没有、destroys 不含 2 ⇒ [2]");
    eq(JSON.stringify(undeclaredDestruction(before, after, [2])), "[]",
        "声明了 2 就 不算未声明销毁");
    eq(JSON.stringify(undeclaredDestruction(before, after, [1, 2, 3])), "[]", "全部声明 ⇒ 空");
    eq(JSON.stringify(undeclaredDestruction(before, { entities: [{ uid: 1 }] }, [3])), "[2]",
        "只声明 3 时，消失的 2 仍是未声明（不许部分匹配就放过）");
    /* 新增不算销毁 */
    eq(JSON.stringify(undeclaredDestruction({ entities: [{ uid: 1 }] }, { entities: [{ uid: 1 }, { uid: 9 }] }, [])), "[]",
        "新增实体不算销毁");
    /* obs 被 result 包着也要认（真桥的响应形态） */
    eq(JSON.stringify(undeclaredDestruction({ result: before }, { result: after }, [])), "[2]",
        "兼容 {result:{entities}} 包装形态");
}

/* ═══════════ 4. strictVerdict：负例 4/5/6 + 逐条规则 ═══════════ */

/** 构造一份「全绿」的 checks（用于在单条规则上做消融）。 */
function greenChecks(over = {}) {
    const base = {
        "L0-observation": { name: "L0-observation", ok: true, evidence: {} },
        "L1-landing": { name: "L1-landing", ok: true, evidence: {} },
        "L2-slots": { name: "L2-slots", ok: true, evidence: {} },
        "L3-flow": { name: "L3-flow", ok: true, evidence: {} },
        "L4-behavior": {
            name: "L4-behavior", ok: true,
            evidence: {
                shape: "RuRu----", ticks: 2400,
                produced_window_before: 0, produced_window_after: 12,
                delivered_in_window_before: 0, delivered_in_window_after: 12,
                goal_delivered_before: 0, goal_delivered_after: 12, goal_delivered_delta: 12,
            },
        },
    };
    for (const [k, v] of Object.entries(over)) {
        if (v === null) delete base[k]; else base[k] = { ...(base[k] || {}), ...v };
    }
    return Object.values(base);
}

const LIVE = { mode: "live", goalShape: "RuRu----", flowsProvided: true, hasMachines: true };

{
    /* 基准：全绿 ⇒ 绿 */
    const r = strictVerdict({ checks: greenChecks() }, LIVE);
    ok(r.ok === true, "基准：全绿 + live ⇒ strict 绿", r.why);
    eq(r.why.length, 0, "基准：why 为空");

    /* 负例 4：goal_delivered_* 为 null ⇒ 红（不是绿） */
    const nullGoal = strictVerdict({ checks: greenChecks({
        "L4-behavior": { evidence: {
            shape: "RuRu----",
            produced_window_before: 0, produced_window_after: 12,        // ← 产出了，但读不到 hub
            delivered_in_window_before: 0, delivered_in_window_after: 12,
            goal_delivered_before: null, goal_delivered_after: null, goal_delivered_delta: null,
        } },
    }) }, LIVE);
    ok(nullGoal.ok === false, "负例4：L4 的 goal_delivered_delta=null ⇒ strict 红", nullGoal.why);
    ok(nullGoal.why.some(w => /goal_delivered_\* 为 null/.test(w)), "负例4：why 点名读不到 hub 计数", nullGoal.why);

    /* 更狠的一版：null 但 produced_window_after > 0（废料侧在产）—— 仍然必须红 */
    const wasteOnly = strictVerdict({ checks: greenChecks({
        "L4-behavior": { evidence: {
            shape: "RuRu----", produced_window_after: 99, delivered_in_window_after: 0,
            goal_delivered_before: null, goal_delivered_after: null, goal_delivered_delta: null,
        } },
    }) }, LIVE);
    ok(wasteOnly.ok === false, "负例4b：有产出但读不到交付 ⇒ 红（不许把「线在转」读成「关卡在推进」）", wasteOnly.why);

    /* L4 有值但 delta=0 且窗口=0 ⇒ 红 */
    const noDelta = strictVerdict({ checks: greenChecks({
        "L4-behavior": { evidence: {
            shape: "RuRu----", produced_window_after: 40,
            delivered_in_window_after: 0,
            goal_delivered_before: 7, goal_delivered_after: 7, goal_delivered_delta: 0,
        } },
    }) }, LIVE);
    ok(noDelta.ok === false, "L4：delta=0 且窗口交付=0 ⇒ 红（有产出无交付）", noDelta.why);

    /* live 下 L4 skipped ⇒ 红 */
    const skip = strictVerdict({ checks: greenChecks({ "L4-behavior": { skipped: true, ok: true, evidence: {} } }) }, LIVE);
    ok(skip.ok === false && skip.why.some(w => /skipped/.test(w)), "live 下 L4 skipped ⇒ 红", skip.why);

    /* live 下 L4 缺失 ⇒ 红 */
    const miss = strictVerdict({ checks: greenChecks({ "L4-behavior": null }) }, LIVE);
    ok(miss.ok === false && miss.why.some(w => /L4-behavior 缺失/.test(w)), "live 下 L4 缺失 ⇒ 红", miss.why);

    /* 形状不符（测错对象）⇒ 红 */
    const wrongShape = strictVerdict({ checks: greenChecks({
        "L4-behavior": { evidence: { shape: "CuCu----", goal_delivered_before: 0, goal_delivered_after: 5, goal_delivered_delta: 5 } },
    }) }, LIVE);
    ok(wrongShape.ok === false && wrongShape.why.some(w => /不是目标/.test(w)), "L4 测的形状 ≠ 目标形状 ⇒ 红", wrongShape.why);

    /* 负例 5：L3 degraded ⇒ 红 */
    const deg = strictVerdict({ checks: greenChecks({ "L3-flow": { degraded: true, ok: true, reason: "未给 flows" } }) }, LIVE);
    ok(deg.ok === false, "负例5：L3 degraded=true ⇒ strict 红", deg.why);
    ok(deg.why.some(w => /降级/.test(w)), "负例5：why 点名降级", deg.why);

    /* flowsProvided=false ⇒ 红（即使 L3 是 ok:true/degraded:true 的形态） */
    const noFlows = strictVerdict({ checks: greenChecks() }, { ...LIVE, flowsProvided: false });
    ok(noFlows.ok === false && noFlows.why.some(w => /FLOW_UNVERIFIED|未提供显式 flows/.test(w)),
        "flowsProvided=false ⇒ 红（FLOW_UNVERIFIED 不是通过）", noFlows.why);

    /* L3 undecidable ⇒ 红 */
    const und = strictVerdict({ checks: greenChecks({ "L3-flow": { undecidable: true, ok: false, reason: "paths 截断" } }) }, LIVE);
    ok(und.ok === false && und.why.some(w => /不可判定/.test(w)), "L3 undecidable ⇒ 红", und.why);

    /* L2 skipped 但计划里有机器 ⇒ 红 */
    const l2skip = strictVerdict({ checks: greenChecks({ "L2-slots": { skipped: true, ok: true } }) }, { ...LIVE, hasMachines: true });
    ok(l2skip.ok === false && l2skip.why.some(w => /L2-slots skipped/.test(w)), "L2 skipped 且有机器 ⇒ 红（纯带子计划才允许 skipped）", l2skip.why);

    /* L2 skipped 且确认没有机器 ⇒ 允许 */
    const l2skipOk = strictVerdict({ checks: greenChecks({ "L2-slots": { skipped: true, ok: true } }) }, { ...LIVE, hasMachines: false });
    ok(l2skipOk.ok === true, "L2 skipped 且 hasMachines=false ⇒ 允许（纯带子计划）", l2skipOk.why);

    /* L1 红 ⇒ 红 */
    const l1bad = strictVerdict({ checks: greenChecks({ "L1-landing": { ok: false, reason: "1 处计划与世界不符" } }) }, LIVE);
    ok(l1bad.ok === false && l1bad.why.some(w => /L1-landing 未通过/.test(w)), "L1 红 ⇒ strict 红", l1bad.why);

    /* L0 undecidable ⇒ 红（截断） */
    const l0 = strictVerdict({ checks: greenChecks({ "L0-observation": { ok: false, undecidable: true, reason: "obs 被截断" } }) }, LIVE);
    ok(l0.ok === false && l0.why.some(w => /L0-observation 不可判定/.test(w)), "L0 被截断 ⇒ strict 红", l0.why);

    /* 未声明销毁 ⇒ 红 */
    const ud = strictVerdict({ checks: greenChecks() }, { ...LIVE, uidDiff: [10150] });
    ok(ud.ok === false && ud.why.some(w => /UNDECLARED_DESTRUCTION/.test(w)), "uidDiff 非空 ⇒ 红（硬停的判据）", ud.why);

    /* 非 live：允许 L4 skipped */
    const mock = strictVerdict({ checks: greenChecks({ "L4-behavior": { skipped: true, ok: true } }) }, { ...LIVE, mode: "mock" });
    ok(mock.ok === true, "非 live：L4 skipped 允许（离线没有产线）", mock.why);

    /* 非 live 但 L4 跑了且失败 ⇒ 仍红（不许「反正离线」放过） */
    const mockBad = strictVerdict({ checks: greenChecks({ "L4-behavior": { ok: false, skipped: false, reason: "没交付" } }) }, { ...LIVE, mode: "mock" });
    ok(mockBad.ok === false, "非 live 但 L4 跑了且失败 ⇒ 红（skipped 与失败不是一回事）", mockBad.why);

    /* checks 缺失 ⇒ 红 */
    ok(strictVerdict(null, LIVE).ok === false, "report 缺失 ⇒ 红（没有检查不是通过）");
    /* verifyRuntime 的 error ⇒ 红 */
    ok(strictVerdict({ checks: [], error: { code: "obs_failed", message: "x" } }, LIVE).ok === false,
        "verifyRuntime.error ⇒ 红");
}

/* ═══════════ 5. 变异锚点：skipped 被当绿的形态 ═══════════ */

{
    /* verifyRuntime 的 ok = checks.every(c => c.ok || c.skipped)。构造一份这样的报告：
       L2 slots skipped（纯带子计划）+ L3 degraded（无 flows）⇒ verifyRuntime.ok === true。
       strictVerdict 必须判红：带着「跳过的 L2」与「降级的 L3」的绿不是绿。 */
    const g = l4Game();
    /* 挑一条真实存在的带子作为 placement，让 L1 绿（否则绿不起来，测不到这条） */
    const belt = g.obs.entities.find(e => e.type === "belt");
    const rep = await verifyRuntime(
        { placements: [{ kind: "belt", x: belt.x, y: belt.y, rot: belt.r, rv: belt.rotation_variant, code: belt.code }], removes: [] },
        { reader: g.reader() },
    );
    eq(rep.ok, true, "（事实）L2 skipped + L3 degraded 时 verifyRuntime.ok === true（skipped 被 every 当绿）");
    const l2 = rep.checks.find(c => c.name === "L2-slots");
    const l3 = rep.checks.find(c => c.name === "L3-flow");
    ok(l2 && l2.skipped === true, "（事实）L2-slots 是 skipped");
    ok(l3 && l3.degraded === true, "（事实）L3-flow 是 degraded");
    const s = strictVerdict(rep, { mode: "live", flowsProvided: false, hasMachines: false, uidDiff: [] });
    ok(s.ok === false, "★ strictVerdict 必须独立于 verifyRuntime.ok：同一份报告 strict 判红", s.why);
    ok(s.why.some(w => /降级/.test(w)), "★ 该红理由是 L3 降级（而不是别的偶然原因）", s.why);
}

/* ═══════════ 6. verifyRound 端到端（FakeGame + 真宏 + 真 planToTxOps） ═══════════ */

{
    const g = l4Game();
    /* ★ 必须先拍一份**独立的** before 快照 ★
       FakeGame.apply 是**原地**修改 `g.obs.entities`（没有事务、没有快照），
       所以 `const before = g.obs` 得到的引用会在 apply 之后跟着变 —— 于是
       `undeclaredDestruction(before, after)` 自己比自己，恒为空。
       这不是本模块的 bug，是 FakeGame 的诚实边界（它不伪造 tx 语义）；
       真 tx 的 before 来自 apply 之前的一次 obs 读取，天然是独立副本。
       这里用 structuredClone 模拟那一次读取。 */
    const before = structuredClone(g.obs);
    const r = replaceRun(
        { region: [4, -14, 5, -13], building: ["cutter", { kind: "trash", port: "left", confirm_waste: true }] },
        { entities: g.obs.entities },
    );
    ok(r.ok, "前置：L4 的 replace_run 规划成功", r.error);
    const plan = planToTxOps([{ macro: "replace_run", result: r }], { obs: before });
    ok(plan.ok, "前置：planToTxOps 成", plan.error);

    /* 模拟 tx：FakeGame.apply 只改内存，不给 uid —— 手工按 op 下标造 results，检验桥接 */
    const applied = g.apply(plan.ops);
    ok(applied.ok && applied.applied === 5, "前置：FakeGame 模拟 5 个 op 落盘", applied);
    /* FakeGame 的 added 顺序 = place 的执行顺序，与 ops 里的 place 下标一致 */
    const placeIdxs = plan.ops.map((o, i) => (o.op === "place" ? i : -1)).filter(i => i >= 0);
    const results = plan.ops.map((o, i) => {
        if (o.op === "delete") return { index: i, op: "delete", ok: true, uid: o.uid, applied: true };
        const k = placeIdxs.indexOf(i);
        return { index: i, op: "place", ok: true, uid: applied.added[k], applied: true };
    });
    const tx = goodTx({
        applied: applied.applied, requested: plan.ops.length,
        diff: { added: applied.added, removed: applied.removed, modified: [] },
        results,
    });

    const { uidMap } = buildUidMap(tx, plan.pendingByOp);
    eq(Object.keys(uidMap).length, 2, "桥接出 2 个 token → uid", uidMap);

    const round = await verifyRound({
        reader: g.reader(),
        txPlan: plan,
        uidMap,
        beforeObs: before,
        mode: "mock",                    // 离线：L4 不请求（skipped），strict 允许
        goalShape: "RuRu----",
        flows: plan.flows,
        tx,
        behavior: false,
    });

    ok(round.checks.length >= 3, "verifyRound 产出了 checks（verifyRuntime + 附加判据）", round.checks.map(c => c.name));
    ok(round.apply && round.apply.ok === true, "verifyRound 的 apply 裁决为 ok（成功 tx + verify:null 不崩）", round.apply);
    eq(JSON.stringify(round.uidDiff), "[]", "uidDiff 为空（删的 3 条都在 destroys 里）");
    ok(round.evidence.before_hash && round.evidence.after_hash, "evidence 记了两份 obs 的 hash", round.evidence);
    ok(round.evidence.before_hash !== round.evidence.after_hash, "hash 不同（世界确实变了）");
    eq(round.evidence.flows_resolved, plan.flows.length, "flows 全部解析成真 uid", round.evidence);

    /* L1 必须绿：cutter/trash 真的在计划的位置上，3 条带子真的没了 */
    const l1 = round.checks.find(c => c.name === "L1-landing");
    ok(l1 && l1.ok === true, "L1-landing 绿（宏的计划在 FakeGame 里真的落地了）", l1 && l1.reason);

    /* V-obs-flow：cutter.left → trash 这一条在 obs 里走通 */
    const vf = round.checks.find(c => c.name === "V-obs-flow");
    ok(vf && vf.ok === true, "V-obs-flow 绿（不依赖 debug_items 的连通证据）", vf && vf.reason);

    /* mock 模式 + FakeGame 无 L4 的 items dump ⇒ L3 拿不到任何真几何：
       实测在 L4 上它是 **undecidable**（没有 paths）或 **unreached**（paths 里没有新机器的链）。
       两种都必须让 strict 红 —— 「离线跑通 ≠ 阶段 2 达成」的机器化表达。 */
    ok(round.strict.ok === false, "mock + 无 debug_items ⇒ strict 红（degraded/undecidable/unreached 都不是通过）", round.strict.why);
    ok(round.strict.why.some(w => /L3-flow/.test(w)), "strict 的理由点名 L3-flow", round.strict.why);
    ok(round.ok === false, "round.ok 与 strict 一致（不允许 ok=true 而 strict=false）");
}

/* ═══════════ 7. verifyRound：未声明销毁必须浮出来（用真函数而非构造） ═══════════ */

{
    const g = l4Game();
    const before = structuredClone(g.obs);      // 独立的 apply 前快照（FakeGame 原地改，见上一节注释）
    const plan = {
        placements: [], removes: [], destroys: [10209], ops: [{ op: "delete", uid: 10209 }], flows: [],
    };
    /* 世界被删了两个、计划只声明了一个 */
    g.apply([{ op: "delete", uid: 10209 }, { op: "delete", uid: 10149 }]);
    const tx = goodTx({ applied: 2, requested: 1, diff: { added: [], removed: [10209, 10149], modified: [] }, results: [] });
    const round = await verifyRound({
        reader: g.reader(), txPlan: plan, uidMap: {}, beforeObs: before,
        mode: "mock", flows: [], tx, behavior: false,
    });
    eq(JSON.stringify(round.uidDiff), JSON.stringify([10149]),
        "verifyRound 自己算出「谁被多删了」（uidDiff 只有 10149）", round.uidDiff);
    const chk = round.checks.find(c => c.name === "V-undeclared-destruction");
    ok(chk && chk.ok === false, "V-undeclared-destruction 判红", chk);
    ok(round.strict.why.some(w => /UNDECLARED_DESTRUCTION/.test(w)), "strict 里带 UNDECLARED_DESTRUCTION", round.strict.why);
    ok(round.ok === false, "round.ok=false（硬停形态）");
}

/* ═══════════ 8. verifyRound 的输入拒收（不许「没读到」= 通过） ═══════════ */

{
    const g = l4Game();
    const bad1 = await verifyRound({ reader: g.reader(), txPlan: null, beforeObs: g.obs, mode: "mock" });
    ok(bad1.ok === false && bad1.strict.why.length > 0, "txPlan 缺失 ⇒ 拒收", bad1.strict.why);
    const bad2 = await verifyRound({ reader: g.reader(), txPlan: { placements: [], removes: [] }, beforeObs: null, mode: "mock" });
    ok(bad2.ok === false && /beforeObs/.test(bad2.strict.why.join()), "beforeObs 缺失 ⇒ 拒收（算不出未声明销毁就别判绿）", bad2.strict.why);
    const bad3 = await verifyRound({ reader: null, txPlan: { placements: [], removes: [] }, beforeObs: g.obs, mode: "mock" });
    ok(bad3.ok === false && /reader/.test(bad3.strict.why.join()), "reader 缺失 ⇒ 拒收", bad3.strict.why);
}

/* ═══════════ 9. worldUidSetHash：只对账，不当判据 ═══════════ */

{
    const a = { entities: [{ uid: 1 }, { uid: 2 }] };
    const b = { entities: [{ uid: 2 }, { uid: 1 }] };
    const c = { entities: [{ uid: 1 }] };
    eq(worldUidSetHash(a), worldUidSetHash(b), "hash 与实体顺序无关（稳定）");
    ok(worldUidSetHash(a) !== worldUidSetHash(c), "uid 集合变了 hash 就变");
    ok(/^fnv1a64:/.test(worldUidSetHash(a)), "hash 带算法前缀（可辨认，不是裸十六进制）");
}

/* ═══════════ 汇总 ═══════════ */

console.log(`\nverify 自测：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log("失败项："); for (const f of failures) console.log("  ✗ " + f); }
process.exit(fail ? 1 : 0);
