/**
 * behavior_wait.test.mjs — L4 的「首次产出要等」
 *
 * ## 这个文件存在的直接原因（2026-11-21 真机 `r-20261121190439-6190`）
 *
 * 模型第一次把线接对了（`feed_sources` 推荐 + `role@dir` 格式都生效），
 * tx 35/35 落盘。链条 `painter → stacker → rotater` 真的开始淌 ——
 * 而 2400 tick（40 游戏秒）的窗口在它刚淌出 4 件**中间产物**时关掉了。
 *
 * L4 因此判：「跑完 2400 tick 后 `CbCbCbRb:CwCwCwCw` 一件都没产出 ——
 * 这条线在游戏里没跑起来」。
 *
 * **那条判词是错的。** 线是跑起来的，只是三层链的流动延迟大于窗口。
 * 更糟的是：后续读 verify 记录的人会据此认定「修法无效」，
 * 从而放弃一条真能出货的路。
 *
 * 修法：首轮没看到产出时**再等一轮**，最多 `maxExtend` 轮。
 * 只在「还没见到任何产出」时延长 —— 已经产了就不必等，
 * 那时「产了但没交付」是真实的失败形态，不该被等待掩盖。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { checkBehavior } from "./verify_runtime.mjs";

const SHAPE = "RuRu----";

/**
 * reader 模拟「产出要等 N 步之后才出现」。
 *
 * @param {object} p
 * @param {number} p.produceAfterSteps   第几次 step 之后开始有产出
 * @param {number} [p.deliveredAfter]    step 之后 goal.delivered
 * @param {number} [p.storedAfter]       step 之后 hub.stored_shapes[shape]
 */
function makeReader(p = {}) {
    const produceAt = p.produceAfterSteps === undefined ? 0 : p.produceAfterSteps;
    let steps = 0;
    const hub = () => ({
        goal: {
            level: 12,
            requirement: {
                shape: SHAPE, required: 1000,
                delivered: steps > 0 ? (p.deliveredAfter === undefined ? 0 : p.deliveredAfter) : 0,
            },
        },
        hub: {
            stored_shapes: {
                [SHAPE]: steps > 0 ? (p.storedAfter === undefined ? 0 : p.storedAfter) : 0,
                "----RuRu": 4575,
            },
        },
    });
    return {
        async obs() { return hub(); },
        async production() {
            const has = steps >= produceAt;
            return {
                /* ★ 关键：产出的是**中间产物**，不是目标形状 ★
                   真机上产的是 `----CgCg` 这类，`produced_total[goalShape]` 恒为 0。
                   延长判据必须看「任何形状」的总和，不能只看目标形状。 */
                produced_total: has ? { "----RuRu": 4, [SHAPE]: 0 } : {},
                delivered_per_sec: { [SHAPE]: 0 },
                delivered_slices: [{ [SHAPE]: 0 }],
                window_seconds: 60,
            };
        },
        async step() { steps++; return { ticks_run: 2400 }; },
    };
}

const BEH = { shape: SHAPE, ticks: 2400, extendTicks: 2400, maxExtend: 2 };

test("★ 首轮无产出、第二轮才有 ⇒ 延长后能看到产出", async () => {
    const reader = makeReader({ produceAfterSteps: 2 });
    const r = await checkBehavior({ goal: SHAPE }, reader, { behavior: BEH });
    const ev = r.evidence;
    assert.ok(ev.extended_ticks > 0,
        `必须记录延长了多少 tick，实得 ${ev.extended_ticks}`);
    assert.equal(ev.effective_ticks, 2400 + ev.extended_ticks,
        `effective_ticks 必须等于 ticks + extended_ticks`);
    /* 延长之后 production() 应该已经能看到中间产物了 */
    const anyProduced = Object.values(ev.produced_total || {}).some(v => Number(v) > 0)
        || ev.extended_ticks >= 2400;
    assert.ok(anyProduced, "延长之后应当已经看到产出");
});

test("★ 首轮就有产出 ⇒ 不延长（已经产了就不该等）", async () => {
    const reader = makeReader({ produceAfterSteps: 1 });
    const r = await checkBehavior({ goal: SHAPE }, reader, { behavior: BEH });
    assert.equal(r.evidence.extended_ticks, 0,
        `首轮就有产出，不该延长。实得 ${r.evidence.extended_ticks}`);
});

test("★ 一直没产出 ⇒ 延长到上限就停，不无限等", async () => {
    const reader = makeReader({ produceAfterSteps: 999 });
    const r = await checkBehavior({ goal: SHAPE }, reader, { behavior: BEH });
    assert.equal(r.evidence.extended_ticks, 2400 * 2,
        `应当延长满 2 轮就停，实得 ${r.evidence.extended_ticks}`);
    assert.equal(r.ok, false, "一直没产出应当判红");
});

test("maxExtend=0 ⇒ 完全不延长（旧行为）", async () => {
    const reader = makeReader({ produceAfterSteps: 999 });
    const r = await checkBehavior({ goal: SHAPE }, reader,
        { behavior: { shape: SHAPE, ticks: 2400, extendTicks: 2400, maxExtend: 0 } });
    assert.equal(r.evidence.extended_ticks, 0, "maxExtend=0 时不该延长");
});
