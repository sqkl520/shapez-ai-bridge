/**
 * `loop/rollback.mjs` —— 什么时候该撤销上一步。
 *
 * ## 这个文件守的是什么
 *
 * `V-health` 能测出「这一步把世界改坏了」，但「测出来」到「该撤销」之间隔着一个
 * **现实约束**：这套系统只有 7 个局部宏、没有 `build_line`，所以
 * 「先拆旧线、下一轮接新线」是唯一可行的施工模式 —— 拆的那一轮**必然** regressive。
 *
 * 实测（L4 官方正解 `replace_run` → cutter+trash）：
 *   到 hub 的带子 140→133、死带子 23→27 ⇒ `classifyNetEffect` 判 regressive
 *   但那一步是**正解的第一步**。如果「regressive 就回滚」，它会被撤销，
 *   模型永远做不完任何多轮改造。
 *
 * 所以判据必须是多信号的。本文件把每一条信号都钉住。
 *
 * 运行：`node --test src/agent/loop/rollback.test.mjs`
 */
import test from "node:test";
import assert from "node:assert/strict";

import { decideRollback, netEffectAfterRollback, ROLLBACK_KINDS } from "./rollback.mjs";

const eff = (kind, why = []) => ({ kind, why });
const LIVE = { mode: "live", budget: { ROLLBACK: true } };

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 绝不撤销的四种情况
 * ══════════════════════════════════════════════════════════════════════════ */

test("R1 positive 绝不撤销（哪怕同轮也有破坏）", () => {
    const d = decideRollback({ ...LIVE, netEffect: eff("positive") });
    assert.equal(d.rollback, false);
    assert.equal(d.kind, "none");
    assert.ok(d.why.some(w => /交付/.test(w)));
});

test("R2 cleanup 不撤销（让世界更干净了）", () => {
    const d = decideRollback({ ...LIVE, netEffect: eff("cleanup") });
    assert.equal(d.rollback, false);
    assert.equal(d.kind, "none");
});

test("R3 churn / inert 不撤销（没弄坏东西）", () => {
    for (const k of ["churn", "inert"]) {
        const d = decideRollback({ ...LIVE, netEffect: eff(k) });
        assert.equal(d.rollback, false, k);
        assert.equal(d.kind, "none");
    }
});

test("R4 未知档位不撤销（不许因为解析不了就动世界）", () => {
    const d = decideRollback({ ...LIVE, netEffect: eff("weird-new-kind") });
    assert.equal(d.rollback, false);
    assert.match(d.why.join(" "), /未知档位/);
});

test("R5 budget.ROLLBACK=false 时一律不撤", () => {
    const d = decideRollback({
        mode: "live", budget: { ROLLBACK: false },
        netEffect: eff("regressive"), prevNetEffect: eff("regressive"),
        runTotal: eff("regressive"),
    });
    assert.equal(d.rollback, false);
    assert.match(d.why.join(" "), /ROLLBACK=false/);
});

test("R6 撤销次数到上限后不再撤（防止在撤销里打转）", () => {
    const d = decideRollback({
        ...LIVE, rolledBackCount: 3,
        netEffect: eff("regressive"), prevNetEffect: eff("regressive"),
        runTotal: eff("regressive"),
    });
    assert.equal(d.rollback, false);
    assert.match(d.why.join(" "), /已撤销 3 次/);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. ★ 施工 vs 破坏 ★ 这一组是核心
 * ══════════════════════════════════════════════════════════════════════════ */

test("R7 ★ 边拆边建（机器 +N）⇒ 判 converging，不撤", () => {
    /* 这是 L4 正解的形态：replace_run 破坏旧 run 同时放下 cutter+trash。
       如果这条判错，模型连第一轮正解都做不完。 */
    const d = decideRollback({
        ...LIVE,
        netEffect: eff("regressive", ["到 hub 的带子 140→133", "结构变了（机器 +2 带子 -10），但目标没动"]),
        prevNetEffect: eff("regressive"),
        runTotal: eff("regressive"),
    });
    assert.equal(d.rollback, false);
    assert.equal(d.kind, "converging");
    assert.ok(d.why.some(w => /施工/.test(w)));
});

test("R8 hadWorkThisRound=true 同样算施工（不靠字符串匹配）", () => {
    const d = decideRollback({
        ...LIVE, hadWorkThisRound: true,
        netEffect: eff("regressive", ["死带子 23→27"]),
        prevNetEffect: eff("regressive"),
        runTotal: eff("regressive"),
    });
    assert.equal(d.rollback, false);
    assert.equal(d.kind, "converging");
});

test("R9 累计仍在变好 ⇒ 不撤（单步破坏是必要代价）", () => {
    const d = decideRollback({
        ...LIVE,
        netEffect: eff("regressive", ["死带子 23→27"]),
        prevNetEffect: eff("regressive"),
        runTotal: eff("cleanup", ["死带子 40→27"]),
    });
    assert.equal(d.rollback, false);
    assert.equal(d.kind, "converging");
    assert.ok(d.why.some(w => /累计仍在变好/.test(w)));
});

test("R10 第一次 regressive ⇒ transient，给模型一轮自修", () => {
    const d = decideRollback({
        ...LIVE,
        netEffect: eff("regressive", ["死带子 23→27"]),
        prevNetEffect: null,
        runTotal: eff("regressive"),
    });
    assert.equal(d.rollback, false);
    assert.equal(d.kind, "transient");
    assert.ok(d.why.some(w => /第一次/.test(w)));
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 该撤的情形
 * ══════════════════════════════════════════════════════════════════════════ */

test("R11 ★ 连续 regressive + 累计也差 + 没在建 ⇒ 撤", () => {
    const d = decideRollback({
        ...LIVE,
        netEffect: eff("regressive", ["到 hub 的带子 133→112", "死带子 27→48"]),
        prevNetEffect: eff("regressive"),
        runTotal: eff("regressive", ["到 hub 的带子 140→112"]),
    });
    assert.equal(d.kind, "rolling_back");
    assert.equal(d.rollback, true, "live 模式下要真撤");
    assert.ok(!d.dry, "live 不该带 dry 标记（调用方据此判断世界是否真动了）");
    assert.ok(d.why.some(w => /连续破坏/.test(w)));
});

test("R12 破坏 +=+ 交替时，只有 regressive 的那次算数", () => {
    /* prev 是 churn（不是 regressive）⇒ 不算连续 ⇒ transient */
    const d = decideRollback({
        ...LIVE,
        netEffect: eff("regressive", ["死带子 23→27"]),
        prevNetEffect: eff("churn"),
        runTotal: eff("regressive"),
    });
    assert.equal(d.kind, "transient");
    assert.equal(d.rollback, false);
});

test("R13 累计是 positive 时不撤 —— 哪怕连续 regressive", () => {
    /* 「整体在交货，但最近两步在拆东西」= 正常迭代，不该被撤。 */
    const d = decideRollback({
        ...LIVE,
        netEffect: eff("regressive", ["死带子 50→60"]),
        prevNetEffect: eff("regressive"),
        runTotal: eff("positive", ["delivered +30"]),
    });
    assert.equal(d.rollback, false);
    assert.equal(d.kind, "converging");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 离线：判定但不执行
 * ══════════════════════════════════════════════════════════════════════════ */

test("R14 ★ 离线即使三条都成立，也只判定不执行（dry:true）", () => {
    /* 理由：FakeGame 的 apply 不做 immutable 回写，离线算出来的可达率不可靠。
       基于不可靠判据撤销世界比不撤销更危险。 */
    const d = decideRollback({
        mode: "mock",
        netEffect: eff("regressive", ["死带子 27→48"]),
        prevNetEffect: eff("regressive"),
        runTotal: eff("regressive"),
        budget: { ROLLBACK: true },
    });
    assert.equal(d.kind, "rolling_back", "判定仍然要做（否则测试覆盖不到这段逻辑）");
    assert.equal(d.rollback, false, "但世界不动");
    assert.equal(d.dry, true);
    assert.equal(d.evidence.mode, "mock");
});

test("R15 replay 与 mock 同样处理", () => {
    const d = decideRollback({
        mode: "replay",
        netEffect: eff("regressive", []),
        prevNetEffect: eff("regressive"),
        runTotal: eff("regressive"),
    });
    assert.equal(d.rollback, false);
    assert.equal(d.dry, true);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 撤销之后的记账
 * ══════════════════════════════════════════════════════════════════════════ */

test("R16 撤销成功 ⇒ 记成 reverted（不是 inert）", () => {
    /* 「我改坏了然后撤了」与「我什么都没做」是两件事：前者证明这个动作是错的。 */
    const d = decideRollback({
        ...LIVE,
        netEffect: eff("regressive", []), prevNetEffect: eff("regressive"),
        runTotal: eff("regressive"),
    });
    const after = netEffectAfterRollback(d, { ok: true, verified: true });
    assert.equal(after.kind, "reverted");
    assert.equal(after.reverted, true);
});

test("R17 撤销失败 ⇒ 保留 regressive（破坏还在，如实记）", () => {
    const d = decideRollback({
        ...LIVE,
        netEffect: eff("regressive", []), prevNetEffect: eff("regressive"),
        runTotal: eff("regressive"),
    });
    const after = netEffectAfterRollback(d, { ok: false, verified: false, why: ["uid 集合未恢复"] });
    assert.equal(after.kind, "regressive");
    assert.equal(after.reverted, false);
    assert.ok(after.why.join(" ").includes("uid 集合未恢复"));
});

test("R18 判定了但没真撤（离线）⇒ 仍是 regressive，不许记成 reverted", () => {
    const d = decideRollback({
        mode: "mock",
        netEffect: eff("regressive", []), prevNetEffect: eff("regressive"),
        runTotal: eff("regressive"),
    });
    const after = netEffectAfterRollback(d, null);
    assert.equal(after.kind, "regressive");
    assert.equal(after.reverted, false);
    assert.ok(after.why.some(w => /离线/.test(w)));
});

test("R19 没判定要撤时，netEffectAfterRollback 返回 null（别乱改写记账）", () => {
    assert.equal(netEffectAfterRollback({ kind: "none" }, null), null);
    assert.equal(netEffectAfterRollback({ kind: "transient" }, null), null);
    assert.equal(netEffectAfterRollback(null, null), null);
});

test("R20 六种判定都在枚举里（新增档位必须同时补枚举）", () => {
    for (const k of ["none", "transient", "converging", "rolling_back"]) {
        assert.ok(ROLLBACK_KINDS.includes(k), `缺 ${k}`);
    }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 6. 纯函数性与稳健性
 * ══════════════════════════════════════════════════════════════════════════ */

test("R21 纯函数：同一输入两次调用结果相同", () => {
    const args = {
        ...LIVE,
        netEffect: eff("regressive", ["死带子 27→48"]),
        prevNetEffect: eff("regressive"),
        runTotal: eff("regressive"),
    };
    assert.deepEqual(decideRollback(args), decideRollback(args));
});

test("R22 缺 netEffect 时不崩、不撤", () => {
    const d = decideRollback({ ...LIVE });
    assert.equal(d.rollback, false);
    assert.equal(d.kind, "none");
});

test("R23 完全无参数也不崩", () => {
    const d = decideRollback();
    assert.equal(d.rollback, false);
    assert.equal(d.kind, "none");
});

test("R24 evidence 里带上全部判据输入（读日志的人能复核）", () => {
    const d = decideRollback({
        ...LIVE,
        netEffect: eff("regressive", ["死带子 27→48"]),
        prevNetEffect: eff("regressive"),
        runTotal: eff("regressive", ["到 hub 140→112"]),
        rolledBackCount: 1,
    });
    assert.equal(d.evidence.net, "regressive");
    assert.equal(d.evidence.prev, "regressive");
    assert.equal(d.evidence.total, "regressive");
    assert.equal(d.evidence.rolled_back_count, 1);
    assert.equal(d.evidence.mode, "live");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 7. ★ 授权拆除：系统叫它拆的，不许反过来撤销它 ★
 * ══════════════════════════════════════════════════════════════════════════ */

test("R25 ★ sanctionedTeardown ⇒ 即使三条撤销条件全中也不撤", () => {
    /* 这是实测确认过的一个反向激励：
       OBSOLETE_LINE 让模型拆残线 → 拆的正是那些能到 hub 的带子 →
       判 regressive → 连续第二次被判 rolling_back → 系统把拆除撤销。
       等于「照着系统的话做，系统再把你的动作撤销」。 */
    const d = decideRollback({
        ...LIVE,
        netEffect: eff("regressive", ["到 hub 的带子 140→138"]),
        prevNetEffect: eff("regressive"),
        runTotal: eff("regressive"),
        sanctionedTeardown: true,
    });
    assert.equal(d.kind, "sanctioned");
    assert.equal(d.rollback, false);
    assert.ok(d.why.some(w => /残线/.test(w)));
    assert.equal(d.evidence.sanctioned, true);
});

test("R26 sanctionedTeardown 只对 regressive 生效（其它档位走各自的判定）", () => {
    /* positive 仍然优先 —— 拆完还交货了，那当然不撤。 */
    const d = decideRollback({ ...LIVE, netEffect: eff("positive"), sanctionedTeardown: true });
    assert.equal(d.kind, "none");
    assert.match(d.why.join(" "), /交付/);
});

test("R27 sanctioned 只在「确实 regressive」时出现（inert 不是拆除的代价）", () => {
    const d = decideRollback({ ...LIVE, netEffect: eff("inert"), sanctionedTeardown: true });
    assert.equal(d.kind, "none", "inert 与拆除无关");
});

test("R28 五档判定都在枚举里（新增 sanctioned）", () => {
    for (const k of ["none", "transient", "converging", "sanctioned", "rolling_back"]) {
        assert.ok(ROLLBACK_KINDS.includes(k), `缺 ${k}`);
    }
});
