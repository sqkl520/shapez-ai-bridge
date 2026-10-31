/**
 * goal_levelup.test.mjs — 锁死「升级瞬间不能把成功判成失败」。
 *
 * ## 这个文件存在的原因
 *
 * L4 只要交付 70 个就升级。`checkBehavior` 用
 * `goal.requirement.delivered` 的增量判「有没有交付」：
 *
 *   goalDelta = goalAfter - goalBefore
 *
 * 而 `getCurrentGoalDelivered()` 在升级时**归零**（目标换成了下一关的形状）。
 * 于是实测出现过：
 *
 *   before=69 → 跨过 70 → after=0    ⇒    goalDelta = -69
 *
 * 这条线在「差一点成功」时被正确判绿，在「**真的成功**」的那一刻被判红 ——
 * 把唯一的成功信号翻转成了失败信号。
 *
 * ## 修法
 *
 * 不靠 delta 的正负，改看 **stored_shapes 里目标形状的累计量**。
 * 它是 hub 的权威计数，**升级后不清零**（实测：升级后 `RuRu----` 仍是 71）。
 *
 * `goal_delivered_delta` 在跨关时改为 **null**（不是 0，也不是负数）——
 * 「读到了但不可比」与「读不到」必须区分开，否则下游没法解释。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { checkBehavior } from "./verify_runtime.mjs";

/* ══════════════════════════ 夹具 ══════════════════════════ */

const SHAPE = "RuRu----";

/**
 * 造一个能模拟「升级」的 reader。
 *
 * @param {object} p
 * @param {number|null} p.deliveredBefore   step 之前 goal.requirement.delivered
 * @param {number|null} p.deliveredAfter    step 之后 goal.requirement.delivered（升级后为 0）
 * @param {number|null} p.storedBefore      step 之前 hub.stored_shapes[shape]
 * @param {number|null} p.storedAfter       step 之后 hub.stored_shapes[shape]
 * @param {number} [p.levelBefore]
 * @param {number} [p.levelAfter]
 * @param {object} [p.prodAfter]            覆盖 production() 的返回
 */
function makeReader(p = {}) {
    let stepped = false;
    const shape = p.shape || SHAPE;
    const hub = (delivered, stored, level, reqShape) => ({
        goal: {
            level: level === undefined ? 4 : level,
            requirement: {
                shape: reqShape === undefined ? shape : reqShape,
                required: 70,
                delivered: delivered === null || delivered === undefined ? undefined : delivered,
            },
        },
        hub: {
            stored_shapes: stored === null || stored === undefined
                ? undefined
                : { [shape]: stored, "----RuRu": 4575 },
        },
    });
    return {
        async obs() {
            if (!stepped) return hub(p.deliveredBefore, p.storedBefore, p.levelBefore, p.goalShapeBefore);
            return hub(p.deliveredAfter, p.storedAfter, p.levelAfter, p.goalShapeAfter);
        },
        async production() {
            const base = {
                produced_total: { [shape]: 0 },
                delivered_per_sec: { [shape]: 0 },
                delivered_slices: [{ [shape]: 0 }],
                window_seconds: 60,
            };
            return stepped ? Object.assign(base, p.prodAfter || {}) : base;
        },
        async step() { stepped = true; return { ticks_run: 2400 }; },
    };
}

const BEH = { shape: SHAPE, ticks: 2400 };

/* ══════════════════════════ 1. 升级场景 ══════════════════════════ */

test("升级：delivered 69→0（delta=-69），但 stored 69→71 ⇒ 必须判绿", async () => {
    /* 这就是实测到的那次：第 19 次读数 69，第 20 次跨过 70 后 delivered 归零。
       修复前这里判红（0.5% 的差距把成功翻转成失败）。 */
    const reader = makeReader({
        deliveredBefore: 69, deliveredAfter: 0,          // 升级归零
        storedBefore: 69, storedAfter: 71,               // 累计量不清零
        levelBefore: 4, levelAfter: 5,
        goalShapeBefore: SHAPE, goalShapeAfter: "Cu----Cu",
    });
    const r = await checkBehavior({ goal: SHAPE }, reader, { behavior: BEH });
    assert.equal(r.ok, true, `应判绿，实际红：${r.reason}`);
    const ev = r.evidence;
    assert.equal(ev.level_before, 4);
    assert.equal(ev.level_after, 5);
    assert.equal(ev.level_changed, true);
    assert.equal(ev.target_stored_before, 69);
    assert.equal(ev.target_stored_after, 71);
    assert.equal(ev.delivered_happened, true);
    /* 跨关时 delta 必须为 null（不可比），不能是 -69 */
    assert.equal(ev.goal_delivered_delta, null, "跨关时 delta 必须为 null，不是负数");
});

test("升级：stored 也读不到时，不许把 delta=-69 判成绿", async () => {
    /* 护栏：修「跨关判红」不能变成「跨关一律判绿」。
       stored 读不到 ⇒ 没有权威证据 ⇒ 必须红。
       （理由措辞不绑定：可能是「没产出」也可能是「读不到证据」，
        两者都成立；这里只断言「判红」这个结论。） */
    const reader = makeReader({
        deliveredBefore: 69, deliveredAfter: 0,
        storedBefore: 69, storedAfter: null,             // hub 没返回 stored_shapes
        levelBefore: 4, levelAfter: 5,
        goalShapeBefore: SHAPE, goalShapeAfter: "Cu----Cu",
    });
    const r = await checkBehavior({ goal: SHAPE }, reader, { behavior: BEH });
    assert.equal(r.ok, false, "stored 读不到时不得判绿");
    /* 但 evidence 必须如实记录「跨关」与「stored 读不到」，供人工判断 */
    assert.equal(r.evidence.level_changed, true);
    assert.equal(r.evidence.target_stored_after, null);
    assert.equal(r.evidence.delivered_happened, false);
});

test("升级：stored 涨了但产出为 0 ⇒ 仍判绿（累计量是权威，产出窗口是辅助）", async () => {
    const reader = makeReader({
        deliveredBefore: 69, deliveredAfter: 0,
        storedBefore: 69, storedAfter: 71,
        levelBefore: 4, levelAfter: 5,
        goalShapeBefore: SHAPE, goalShapeAfter: "Cu----Cu",
    });
    const r = await checkBehavior({ goal: SHAPE }, reader, { behavior: BEH });
    assert.equal(r.ok, true);
});

/* ══════════════════════════ 2. 正常场景不许回归 ══════════════════════════ */

test("未升级：delivered 20→71 ⇒ 绿，delta 仍是 51（正常路径不能变）", async () => {
    const reader = makeReader({
        deliveredBefore: 20, deliveredAfter: 71,
        storedBefore: 20, storedAfter: 71,
        levelBefore: 4, levelAfter: 4,
        goalShapeBefore: SHAPE, goalShapeAfter: SHAPE,
    });
    const r = await checkBehavior({ goal: SHAPE }, reader, { behavior: BEH });
    assert.equal(r.ok, true, `应判绿，实际红：${r.reason}`);
    assert.equal(r.evidence.goal_delivered_delta, 51, "未跨关时 delta 必须保留原值");
    assert.equal(r.evidence.level_changed, false);
});

test("未升级：delivered 与 stored 都不动 ⇒ 必须判红", async () => {
    const reader = makeReader({
        deliveredBefore: 30, deliveredAfter: 30,
        storedBefore: 30, storedAfter: 30,
        levelBefore: 4, levelAfter: 4,
        goalShapeBefore: SHAPE, goalShapeAfter: SHAPE,
    });
    const r = await checkBehavior({ goal: SHAPE }, reader, { behavior: BEH });
    assert.equal(r.ok, false, "什么都没动不许判绿");
    assert.match(String(r.reason), /没有新交付|停滞|没跑起来|交付/);
});

test("未升级：delivered 不动但 stored 涨了 ⇒ 绿（累计量是权威）", async () => {
    /* 这条是新增判据的独立价值：delivered 因为某些原因没动，
       但 hub 的累计量确实涨了 ⇒ 货真的到了。 */
    const reader = makeReader({
        deliveredBefore: 30, deliveredAfter: 30,
        storedBefore: 30, storedAfter: 40,
        levelBefore: 4, levelAfter: 4,
        goalShapeBefore: SHAPE, goalShapeAfter: SHAPE,
    });
    const r = await checkBehavior({ goal: SHAPE }, reader, { behavior: BEH });
    assert.equal(r.ok, true, `stored 涨了应判绿，实际红：${r.reason}`);
});

test("未升级：delivered 涨但 stored 读不到 ⇒ 绿（旧判据保留）", async () => {
    /* 护栏：不能因为引入 stored 就把 delivered 这条腿砍掉。 */
    const reader = makeReader({
        deliveredBefore: 20, deliveredAfter: 71,
        storedBefore: null, storedAfter: null,
        levelBefore: 4, levelAfter: 4,
        goalShapeBefore: SHAPE, goalShapeAfter: SHAPE,
    });
    const r = await checkBehavior({ goal: SHAPE }, reader, { behavior: BEH });
    assert.equal(r.ok, true, `delivered 涨了应判绿，实际 red=${r.reason}`);
});

/* ══════════════════════════ 3. 反极性 / 错形状 ══════════════════════════ */

test("交付了错形状：stored[目标] 不涨、stored[废料] 在涨 ⇒ 必须判红", async () => {
    /* 历史 L4 三次 NO-PRODUCTION 就是这个形态：产品进了 trash、废料进了 hub。
       目标形状 stored 不动 ⇒ 红。这里确认修 C 没有把这个判据弄松。 */
    let stepped = false;
    const reader = {
        async obs() {
            /* 目标形状 RuRu---- 始终 0；废料 ----RuRu 一直在涨 */
            return {
                goal: { level: 4, requirement: { shape: SHAPE, required: 70, delivered: stepped ? 0 : 0 } },
                hub: { stored_shapes: { [SHAPE]: 0, "----RuRu": stepped ? 4600 : 4575 } },
            };
        },
        async production() {
            return {
                produced_total: { [SHAPE]: stepped ? 5 : 0 },
                delivered_per_sec: { [SHAPE]: 0 },
                delivered_slices: [{ [SHAPE]: 0 }],
                window_seconds: 60,
            };
        },
        async step() { stepped = true; return { ticks_run: 2400 }; },
    };
    const r = await checkBehavior({ goal: SHAPE }, reader, { behavior: BEH });
    assert.equal(r.ok, false, "目标形状 stored 不涨，不许判绿");
});

/* ══════════════════════════ 4. 缺证据 ══════════════════════════ */

test("三样证据全读不到 ⇒ 红，且 evidence 如实记为 null", async () => {
    /* 读不到就判红 —— 不许假设它涨了。
       理由措辞不绑定（可能是「没产出」也可能是「读不到证据」），
       但 evidence 必须如实记录读不到，供人工区分「线没跑」和「reader 不给数」。 */
    const reader = makeReader({
        deliveredBefore: null, deliveredAfter: null,
        storedBefore: null, storedAfter: null,
        levelBefore: null, levelAfter: null,
    });
    const r = await checkBehavior({ goal: SHAPE }, reader, { behavior: BEH });
    assert.equal(r.ok, false);
    assert.equal(r.evidence.goal_delivered_before, null);
    assert.equal(r.evidence.goal_delivered_after, null);
    assert.equal(r.evidence.target_stored_before, null);
    assert.equal(r.evidence.target_stored_after, null);
    assert.equal(r.evidence.delivered_happened, false);
});

test("未请求行为检查 ⇒ skipped（不变）", async () => {
    const reader = makeReader({});
    const r = await checkBehavior({ goal: SHAPE }, reader, {});
    assert.equal(r.skipped, true);
    assert.equal(r.ok, true);
});

/* ══════════════════════════ 5. 端到端：跨关不能被下游判红 ══════════════════════════
 *
 * 上面测的是 `checkBehavior` 一个函数。但真正的判据链是三层：
 *
 *   checkBehavior → strictVerdict → phaseTwoVerdict
 *
 * 任何一层退回「delta 必须 > 0」，跨关就会在那一层被杀掉。
 * 这三条测试锁住整条链。
 */

test("端到端：跨关的 L4 证据 → strictVerdict 必须判绿", async () => {
    const { strictVerdict } = await import("./loop/verify.mjs");
    /* 用真实的 checkBehavior 产出（不是手搓 evidence），
       这样 evidence 的形状变了测试会一起跟着失败。 */
    const reader = makeReader({
        deliveredBefore: 69, deliveredAfter: 0,
        storedBefore: 69, storedAfter: 71,
        levelBefore: 4, levelAfter: 5,
        goalShapeBefore: SHAPE, goalShapeAfter: "Cu----Cu",
    });
    const l4 = await checkBehavior({ goal: SHAPE }, reader, { behavior: BEH });
    assert.equal(l4.ok, true);

    const report = {
        checks: [
            { name: "L0-observation", ok: true },
            { name: "L1-landing", ok: true },
            { name: "L2-slots", ok: true },
            { name: "L3-flow", ok: true },
            l4,
        ],
    };
    const s = strictVerdict(report, {
        mode: "live", goalShape: SHAPE, flowsProvided: true, hasMachines: true, uidDiff: [],
    });
    assert.equal(s.ok, true, `strictVerdict 应判绿，实际红：${JSON.stringify(s.why)}`);
});

test("端到端：跨关但 hub 累计量没涨 → strictVerdict 必须判红", async () => {
    const { strictVerdict } = await import("./loop/verify.mjs");
    /* 护栏：修「跨关判红」不能变成「跨关一律放行」。
       升级了但 hub 里目标形状没多 ⇒ 不是这条线的功劳 ⇒ 红。 */
    const reader = makeReader({
        deliveredBefore: 69, deliveredAfter: 0,
        storedBefore: 71, storedAfter: 71,       // 没涨
        levelBefore: 4, levelAfter: 5,
        goalShapeBefore: SHAPE, goalShapeAfter: "Cu----Cu",
    });
    const l4 = await checkBehavior({ goal: SHAPE }, reader, { behavior: BEH });
    const report = {
        checks: [
            { name: "L0-observation", ok: true }, { name: "L1-landing", ok: true },
            { name: "L2-slots", ok: true }, { name: "L3-flow", ok: true }, l4,
        ],
    };
    const s = strictVerdict(report, {
        mode: "live", goalShape: SHAPE, flowsProvided: true, hasMachines: true, uidDiff: [],
    });
    assert.equal(s.ok, false, "升级但累计量没涨，不许判绿");
});

test("端到端：跨关 → readGoalDelta 取累计账本，phaseTwoVerdict 判 achieved", async () => {
    const { phaseTwoVerdict } = await import("./loop/offline_boundary.mjs");
    /* `readGoalDelta` 在 loop.mjs 里没导出，这里按同一语义复算：
       跨关时取 target_stored_delta。 */
    const reader = makeReader({
        deliveredBefore: 69, deliveredAfter: 0,
        storedBefore: 69, storedAfter: 71,
        levelBefore: 4, levelAfter: 5,
        goalShapeBefore: SHAPE, goalShapeAfter: "Cu----Cu",
    });
    const l4 = await checkBehavior({ goal: SHAPE }, reader, { behavior: BEH });
    const ev = l4.evidence;

    /* 与 loop.mjs:readGoalDelta 的跨关分支逐字同义 */
    const crossed = ev.level_changed === true;
    assert.equal(crossed, true);
    const goalDelta = crossed ? ev.target_stored_delta : ev.goal_delivered_delta;
    assert.equal(goalDelta, 2, "跨关应取 69→71 的累计增量");

    const v = phaseTwoVerdict({
        mode: "live",
        strict: { ok: true },
        checks: [
            { name: "L0-observation", ok: true }, { name: "L1-landing", ok: true },
            { name: "L2-slots", ok: true }, { name: "L3-flow", ok: true }, l4,
        ],
        goalDelta,
    });
    assert.equal(v.achieved, true, `应判达成，why=${JSON.stringify(v.why)}`);
    assert.equal(v.level, "live");
});

test("端到端：跨关但 delta 仍为负数 → 必须不达成（护栏）", async () => {
    const { phaseTwoVerdict } = await import("./loop/offline_boundary.mjs");
    /* 如果有人把跨关的 delta 传成 -69，phaseTwoVerdict 必须拒绝。 */
    const v = phaseTwoVerdict({
        mode: "live",
        strict: { ok: true },
        checks: [{ name: "L0-observation", ok: true }, { name: "L1-landing", ok: true }],
        goalDelta: -69,
    });
    assert.equal(v.achieved, false, "负 delta 不许判达成");
});
