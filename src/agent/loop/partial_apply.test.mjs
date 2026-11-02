/**
 * 部分执行（`buildTxPlan(..., {partial:true})`）—— 只提交「成功且产物可撤销」的调用。
 *
 * ## 为什么有这个模式
 *
 * 实测（`FIVE-ROUNDS-FINAL.md`，五轮 148 条）：`calls≥4` 时执行率 **0/82**。
 * 根因是 `buildTxPlan` 全有或全无 —— 一条宏失败，整轮 0 op。
 *
 * ## 为什么不是「提交全部成功子集」
 *
 * 红队（`REDTEAM-PARTIAL-APPLY.md`）用实测否掉了那个：
 *   · 52% 的样本里「成功的那一半」是 `trash_unused`，它把 `DEAD_END` 出口**封死**
 *   · **trash / 机器一旦落盘不可撤销** —— `remove_run` 只处理带子
 *   · 提交全部成功子集 = 88 次不可逆写入，只有 45% 是真目标动作
 *
 * 我的变体（`.tmpverify/redteam-partial/reversible.mjs`，177 条）：
 *
 *   A 全有或全无   提交 3.4%   目标动作  6   不可逆  5
 *   B 全部成功子集 提交 71.8%  目标动作 57   不可逆 88
 *   **E 可撤销子集 提交 30.5%  目标动作 54   不可逆  0**  ← 实现的这个
 *
 * E 用 41pp 的提交率换掉 88 次不可逆写入。
 *
 * ## 夹具里的三个真实调用（都在 L4 上实测过）
 *
 * | 名字 | 调用 | 结果 |
 * |---|---|---|
 * | `FAIL_M1` | `connect(M1 → C1.primary)` | `port_already_bound` |
 * | `OK_BELT` | `connect(B10193 → H1)` | ✅ 成功，产物是带子（**可撤销**） |
 * | `OK_CUTTER` | `insert_machine(B136, cutter)` | ✅ 成功，产物 `place:cutter`（**不可撤销**） |
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildTxPlan } from "../loop.mjs";
import { buildHandles } from "./handles.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const OBS = JSON.parse(fs.readFileSync(path.join(REPO, "test/fixtures/saves/L4-obs.json"), "utf8")).result;
const handles = buildHandles(OBS, null);

const plan = (...calls) => ({ say: "test", calls });
const ref = (h) => ({ $ref: h });

/* 失败的：M1 的 out 已经接了 B110，再连一条会饿死旧的 */
const FAIL_M1 = { macro: "connect", args: { from: ref("M1"), to: { $ref: "C1", port: "primary" } }, why: "x" };

/* 成功的、可撤销的：把 B83 接进 hub（产物全是 place:belt）
 * 这组参数是从六轮真实样本里反查出来的（.tmpverify/ab-density/fixture2.mjs）——
 * 不是猜的，是在**当前夹具**上实测成功的。 */
const OK_BELT = { macro: "connect", args: { from: ref("B83"), to: ref("H1") }, why: "x" };

/* 成功的、不可撤销的：在带子上插一台 cutter（产物是机器） */
const OK_CUTTER = { macro: "insert_machine", args: { at: { $ref: "B2", asCell: true }, facing: "top", machine: "cutter" }, why: "x" };

/* ═══════════ 0. 夹具前提自检 ═══════════
 *
 * 这三条断言如果红了，说明夹具变了，下面的测试全部失效 ——
 * 必须先在这里炸，而不是让后面出现「因为前提错了所以通过」的假绿。 */
test("P0 夹具前提：FAIL_M1 失败、OK_BELT 可撤销成功、OK_CUTTER 不可撤销成功", () => {
    const f = buildTxPlan(plan(FAIL_M1), OBS, null, handles);
    assert.equal(f.ok, false, "FAIL_M1 应当失败");
    assert.equal(f.diagnosis.code, "MACRO_REFUSED", `FAIL_M1 应当是 MACRO_REFUSED，实际 ${f.diagnosis.code}`);

    const b = buildTxPlan(plan(OK_BELT), OBS, null, handles);
    assert.equal(b.ok, true, `OK_BELT 应当成功，实际 ${b.diagnosis && b.diagnosis.code}`);
    assert.ok(b.txPlan.ops.length > 0, "OK_BELT 要产 op");
    const bRev = b.txPlan.ops.every(o => o.op === "delete" || (o.op === "place" && ["belt", "underground_belt"].includes(o.building)));
    assert.ok(bRev, `OK_BELT 的 ops 应当可撤销，实际 ${b.txPlan.ops.map(o => o.op + ":" + (o.building || "")).join(",")}`);

    const c = buildTxPlan(plan(OK_CUTTER), OBS, null, handles);
    assert.equal(c.ok, true, `OK_CUTTER 应当成功，实际 ${c.diagnosis && c.diagnosis.code}`);
    const cRev = c.txPlan.ops.every(o => o.op === "delete" || (o.op === "place" && ["belt", "underground_belt"].includes(o.building)));
    assert.equal(cRev, false, "OK_CUTTER 的 ops 应当**不**可撤销（它放机器）");
});

/* ═══════════ 1. 默认行为不变 ═══════════ */
test("P1 `partial` 不传时行为完全不变（失败立刻拒，一条 op 都不生成）", () => {
    const p = buildTxPlan(plan(FAIL_M1, OK_BELT), OBS, null, handles);
    assert.equal(p.ok, false, "全有或全无：应当被拒");
    assert.equal(p.diagnosis.code, "MACRO_REFUSED");
    assert.equal(p.txPlan, undefined, "被拒时不该有 txPlan");
});

test("P2 `partial:false` 与不传等价", () => {
    const a = buildTxPlan(plan(FAIL_M1, OK_BELT), OBS, null, handles);
    const b = buildTxPlan(plan(FAIL_M1, OK_BELT), OBS, null, handles, { partial: false });
    assert.equal(a.ok, b.ok);
    assert.equal(a.diagnosis.code, b.diagnosis.code);
});

/* ═══════════ 2. partial 模式 ═══════════ */
test("P3 ★ `partial:true`：失败的跳过，可撤销的仍被提交", () => {
    const p = buildTxPlan(plan(FAIL_M1, OK_BELT), OBS, null, handles, { partial: true });
    assert.equal(p.ok, true, `应当成功（有可撤销的），实际 ${p.diagnosis && p.diagnosis.code}`);
    assert.equal(p.partial, true, "★ 必须标记 partial:true");
    assert.ok(p.txPlan.ops.length > 0, "要有 op");
    assert.ok(Array.isArray(p.skipped) && p.skipped.length === 1,
        `skipped 应当恰好 1 条（FAIL_M1），实际 ${JSON.stringify(p.skipped)}`);
    assert.equal(p.skipped[0].reason, "macro_failed");
    assert.equal(p.skipped[0].macro, "connect");
});

test("P4 ★ `partial:true`：不可撤销的成功调用被跳过（不是被提交）", () => {
    const p = buildTxPlan(plan(FAIL_M1, OK_CUTTER), OBS, null, handles, { partial: true });
    assert.equal(p.ok, false, "只有不可撤销的成功 ⇒ 应当拒");
    assert.equal(p.diagnosis.code, "NO_REVERSIBLE_CALL",
        `应当是 NO_REVERSIBLE_CALL，实际 ${p.diagnosis.code}`);
    const reasons = (p.diagnosis.evidence || {}).skipped.map(s => s.reason);
    assert.ok(reasons.includes("irreversible"),
        `要能看到 irreversible（cutter），实际 ${JSON.stringify(reasons)}`);
    assert.ok(reasons.includes("macro_failed"),
        `要能看到 macro_failed（M1），实际 ${JSON.stringify(reasons)}`);
});

test("P5 ★★ 混三条：只提交带子那条，机器和失败都进 skipped", () => {
    const p = buildTxPlan(plan(FAIL_M1, OK_BELT, OK_CUTTER), OBS, null, handles, { partial: true });
    assert.equal(p.ok, true, `应当成功，实际 ${p.diagnosis && p.diagnosis.code}`);
    assert.equal(p.partial, true);

    /* ★ 核心断言：提交的 ops 里绝不许出现机器/垃圾桶 ★ */
    const nonBelt = p.txPlan.ops.filter(o => o.op === "place" && !["belt", "underground_belt"].includes(o.building));
    assert.deepEqual(nonBelt, [],
        `★ 提交的 ops 里不许有机器/垃圾桶，实际 ${JSON.stringify(nonBelt)}`);

    /* skipped 要有两条：失败的那条 + 不可撤销的那条 */
    assert.equal(p.skipped.length, 2, `skipped 应当 2 条，实际 ${JSON.stringify(p.skipped)}`);
    const byReason = p.skipped.reduce((m, s) => { m[s.reason] = (m[s.reason] || 0) + 1; return m; }, {});
    assert.equal(byReason.macro_failed, 1);
    assert.equal(byReason.irreversible, 1);
});

test("P6 全部可撤销且全部成功时，partial 应为 false", () => {
    const p = buildTxPlan(plan(OK_BELT), OBS, null, handles, { partial: true });
    assert.equal(p.ok, true);
    assert.equal(p.partial, false,
        "没跳过任何东西 ⇒ partial:false（「用了 partial 模式」不等于「这次是部分执行」）");
    assert.deepEqual(p.skipped, [], "skipped 应当为空");
});

test("P7 全失败时是 NO_REVERSIBLE_CALL（不是抛异常、不是 MACRO_REFUSED）", () => {
    const p = buildTxPlan(plan(FAIL_M1, FAIL_M1), OBS, null, handles, { partial: true });
    assert.equal(p.ok, false);
    assert.equal(p.diagnosis.code, "NO_REVERSIBLE_CALL");
    const reasons = (p.diagnosis.evidence || {}).skipped.map(s => s.reason);
    assert.ok(reasons.every(r => r === "macro_failed"),
        `全是宏失败时 reason 应当都是 macro_failed，实际 ${JSON.stringify(reasons)}`);
});

test("P8 skipped 的 reason 在闭集里（下游要能按它渲染）", () => {
    const p = buildTxPlan(plan(FAIL_M1, OK_BELT, OK_CUTTER), OBS, null, handles, { partial: true });
    if (!p.ok) return;
    for (const s of p.skipped) {
        assert.equal(typeof s.macro, "string", `缺 macro：${JSON.stringify(s)}`);
        assert.ok(["macro_failed", "irreversible", "not_translatable"].includes(s.reason),
            `reason 不在闭集里：${s.reason}`);
    }
});

/* ═══════════ 3. ★ 判据层：partial 绝不能被算成成功 ═══════════
 *
 * 红队（`REDTEAM-PARTIAL-APPLY.md` §Q2）的核心警告：
 * `verifyRuntime` 结构上不可能知道「原计划有几个调用」—— 部分执行之后
 * `plan` 只含成功的那几项，L1 验的就是那几项，自然全绿。
 *
 * 实测（红队 `greenpath4.mjs`，103 个样本）：
 *   L1 绿 103/103、L2 绿 103/103、V-obs-flow 绿 38/103 —— 全绿 38/103
 * 而那 38 个在 live 下只差 L4（hub 有没有收货），与「计划完不完整」毫无关系。
 *
 * ⇒ **唯一能拦住 `achieved` 的就是 `strictVerdict` 里那条 `PARTIAL_APPLY`。**
 */
test("P9 ★★ `strictVerdict` 对 partial:true 判红，且**不带 skipped**（否则会被静默吞掉）", async () => {
    const { strictVerdict } = await import("./verify.mjs");
    /* 一份「全绿」的 report —— 模拟部分执行后子集全部通过的情况 */
    const greenReport = {
        checks: [
            { name: "L0-observation", ok: true },
            { name: "L1-landing", ok: true },
            { name: "L2-slots", ok: true },
            { name: "L3-flow", ok: true },
            { name: "L4-behavior", ok: true, evidence: { goal_delivered_before: 0, goal_delivered_after: 5, goal_delivered_delta: 5, target_stored_before: 0, target_stored_after: 5, target_stored_delta: 5 } },
        ],
        partial: true,
        skipped: [{ macro: "insert_machine", reason: "irreversible" }],
    };
    const r = strictVerdict(greenReport, {
        mode: "live", goalShape: "RuRu----", flowsProvided: true, hasMachines: false,
    });
    assert.equal(r.ok, false, "★ partial:true 时 strictVerdict 必须判红");
    assert.ok(r.why.some(w => w.includes("PARTIAL_APPLY")),
        `why 里要有 PARTIAL_APPLY，实际 ${JSON.stringify(r.why)}`);

    /* ⚠️ 关键：这条 why 走的是 `why.push`，**不是** report.checks 里的一条 check。
     * 因为 `classifyChecks`（offline_boundary.mjs:63）第一句是 `if (c.skipped) continue;`，
     * 而本项目所有「有意跳过」的 check 都带 skipped:true —— 实现者照抄邻居就会踩中。
     * 红队 holes.mjs 实测：`{ok:false, skipped:true}` → achieved 仍然是 true。
     *
     * 断言方式：partial 那条**不能**出现在 checks 里（那样才可能被 skipped 过滤）。 */
    assert.ok(!greenReport.checks.some(c => c.name === "P-partial"),
        "不许把 partial 做成一条 check —— 它会被 classifyChecks 的 skipped 过滤吞掉");
});

test("P10 对照：partial 为 false / 缺省时，同一份全绿 report 仍然通过", async () => {
    const { strictVerdict } = await import("./verify.mjs");
    const mk = extra => ({
        checks: [
            { name: "L0-observation", ok: true },
            { name: "L1-landing", ok: true },
            { name: "L2-slots", ok: true },
            { name: "L3-flow", ok: true },
            { name: "L4-behavior", ok: true, evidence: { goal_delivered_before: 0, goal_delivered_after: 5, goal_delivered_delta: 5, target_stored_before: 0, target_stored_after: 5, target_stored_delta: 5 } },
        ],
        ...extra,
    });
    const opts = { mode: "live", goalShape: "RuRu----", flowsProvided: true, hasMachines: false };
    assert.equal(strictVerdict(mk({}), opts).ok, true, "缺省（没有 partial 字段）应当通过");
    assert.equal(strictVerdict(mk({ partial: false }), opts).ok, true, "partial:false 应当通过");
    /* 边界：partial:false 但 skipped 非空 —— 不该因为 skipped 而红（那是 partial 的副产物） */
    assert.equal(strictVerdict(mk({ partial: false, skipped: [{ macro: "x", reason: "y" }] }), opts).ok, true,
        "partial:false 时 skipped 不该影响判据");
});
