/**
 * offline_boundary.test.mjs — 钉住「离线能证明什么、不能证明什么」。
 *
 * 这个文件存在的直接原因（2026-11-03）：加 `V-health` 之后，离线跑 L4 官方正解
 * 出现 10 条断言一起变红，而 npm 的全量回归把它报成「loop.test.mjs 挂了」——
 * 真正的原因不是 loop 有 bug，是 V-health 在离线被当成了结论。
 *
 * 那次实测的链条：
 *
 *   L4 正解（把一条 run 换成 cutter+trash）
 *     → 离线 FakeGame.apply 只改实体表，不做 immutable 回写
 *     → flowReachable 算出「到 hub 的带子 140→133」（真机不一定）
 *     → V-health 判 regressive
 *     → strict 红
 *     → OFFLINE_ONLY 永远到不了，HALT.json 的 next_actions 也全错
 *
 * 更根本的一条：**增量施工天然会短暂降低可达率**。这套系统只有 7 个局部宏，
 * 「先拆旧线、下一轮再接新线」是唯一可行的模式。每一步都要求可达率不降，
 * 等于禁止一切施工。
 *
 * 运行：`node --test src/agent/loop/offline_boundary.test.mjs`
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    OFFLINE_UNVERIFIABLE, OFFLINE_VERIFIABLE, classifyChecks, phaseTwoVerdict,
} from "./offline_boundary.mjs";

const chk = (name, ok = true) => ({ name, ok });

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 两张表本身
 * ══════════════════════════════════════════════════════════════════════════ */

test("O1 V-health 在离线不可信表里，且写了理由", () => {
    assert.ok(OFFLINE_UNVERIFIABLE["V-health"], "V-health 必须在 OFFLINE_UNVERIFIABLE 里");
    assert.ok(OFFLINE_UNVERIFIABLE["V-health"].length > 20, "必须给出具体理由，不是占位符");
});

test("O2 L3-flow / L4-behavior / tx-atomicity 仍在表里（不许被顺手删掉）", () => {
    for (const k of ["L3-flow", "L4-behavior", "tx-atomicity"]) {
        assert.ok(OFFLINE_UNVERIFIABLE[k], `缺 ${k} —— 它是离线边界的老祖宗，删了会重开假绿`);
    }
});

test("O3 可信表里不许出现 V-health（两张表必须互斥）", () => {
    assert.ok(!OFFLINE_VERIFIABLE["V-health"]);
    for (const k of Object.keys(OFFLINE_VERIFIABLE)) {
        assert.ok(!OFFLINE_UNVERIFIABLE[k], `${k} 同时在两张表里`);
    }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. classifyChecks 的分流
 * ══════════════════════════════════════════════════════════════════════════ */

test("O4 离线：V-health 判红也**不**进 trustworthy（它的红不构成结论）", () => {
    const r = classifyChecks({ checks: [chk("L1-landing", true), chk("V-health", false)] }, { mode: "mock" });
    assert.ok(r.trustworthy.some(c => c.name === "L1-landing"));
    assert.ok(!r.trustworthy.some(c => c.name === "V-health"), "V-health 不许进可信集合");
    assert.ok(r.untrustworthy.some(c => c.name === "V-health"));
    assert.ok(r.why.some(w => /V-health/.test(w) && /不构成结论/.test(w)));
});

test("O5 live：V-health **进** trustworthy（真机上它才是判据）", () => {
    const r = classifyChecks({ checks: [chk("V-health", false)] }, { mode: "live" });
    assert.ok(r.trustworthy.some(c => c.name === "V-health"));
    assert.equal(r.untrustworthy.length, 0);
    assert.equal(r.ok, true);
});

test("O6 skipped 的检查完全不参与分流", () => {
    const r = classifyChecks({ checks: [{ name: "V-health", ok: true, skipped: true }] }, { mode: "mock" });
    assert.equal(r.trustworthy.length, 0);
    assert.equal(r.untrustworthy.length, 0);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 端到端：离线全绿必须仍然能走到 offline-only
 * ══════════════════════════════════════════════════════════════════════════ */

test("O7 ★ 回归：离线全绿 + V-health 红 ⇒ 仍然 offline-only，不是 none", () => {
    /* 这是那次 10 条断言变红的**最小复现**。
       ⚠️ 必须按**生产路径**调用：`runLoop` 传进 `phaseTwoVerdict` 的是**已过滤**的
       `cls.trustworthy`（loop.mjs 里那一行），不是原始 checks 列表。
       直接传原始列表会让 `classifyChecks` 在 phaseTwoVerdict 内部再算一遍
       untrustworthy（非空）⇒ `cls.ok === false` ⇒ 永远走不到 offline-only，
       而这个失败**只存在于测试里**，与线上行为无关。 */
    const checks = [
        chk("L0-observation", true),
        chk("L1-landing", true),
        chk("L2-slots", true),
        chk("L3-flow", false),          // 离线必然红（paths 不重建）
        chk("V-undeclared-destruction", true),
        chk("A-tx", true),
        chk("V-health", false),         // ★ 新的那条，红 ★
    ];
    const cls = classifyChecks({ checks }, { mode: "mock" });
    assert.ok(!cls.trustworthy.some(c => c.name === "V-health"), "前提：V-health 被判为不可信");
    const v = phaseTwoVerdict({
        mode: "mock",
        strict: { ok: true },           // 忽略 L3 红的 strict 结论（离线不据此判）
        checks: cls.trustworthy,        // ← 与 loop.mjs 的调用方式一致
        goalDelta: 0,
    });
    assert.equal(v.level, "offline-only", `实得 ${v.level}；why=${JSON.stringify(v.why)}`);
    assert.equal(v.achieved, false, "离线永远不许 achieved");
});

test("O7b 反证：若 V-health 被当成可信，同一条链就断在 none（说明这条白名单是必要的）", () => {
    /* 用 live 模式复现「V-health 可信」的情形。
       ⚠️ `phaseTwoVerdict` 内部会再调一次 `classifyChecks(..., {mode: e.mode})`，
       所以 e.mode 必须与「V-health 可信」的那个 mode 一致 —— 否则它又被过滤一遍，
       这个反证就变成了「什么都没验证」。 */
    const cls = classifyChecks({
        checks: [chk("L1-landing", true), chk("V-health", false)],
    }, { mode: "live" });
    const v = phaseTwoVerdict({
        mode: "live", strict: { ok: true }, checks: cls.trustworthy, goalDelta: 0,
    });
    assert.equal(v.level, "none", "可信的 V-health 红必须拦住 offline-only / live");
    assert.ok(v.why.some(w => /可信检查项为红/.test(w)), `why=${JSON.stringify(v.why)}`);
});

test("O8 live 下 V-health 红 ⇒ 不得 offline-only", () => {
    const cls = classifyChecks({ checks: [chk("V-health", false)] }, { mode: "live" });
    const v = phaseTwoVerdict({
        mode: "live", strict: { ok: true }, checks: cls.trustworthy, goalDelta: 10,
    });
    assert.notEqual(v.level, "offline-only", "真机上红就是红，不许降级成 offline-only");
    assert.equal(v.achieved, false);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 理由必须可读
 * ══════════════════════════════════════════════════════════════════════════ */

test("O9 V-health 的不可信理由要点名「增量施工」这个真实原因", () => {
    const why = OFFLINE_UNVERIFIABLE["V-health"];
    assert.match(why, /增量施工|immutable|FakeGame/,
        "理由必须指向具体机制，否则下一个人会以为是随手加的白名单");
});
