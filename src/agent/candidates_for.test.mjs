/**
 * candidates_for.test.mjs — `candidatesFor()` 的名额分配。
 *
 * ## 为什么需要这个文件（红队指出的「零覆盖」）
 *
 * 这个函数决定模型**能看到哪 6 张宏卡片**。它错了不会让任何东西崩，
 * 只会让某条诊断变得**无解** —— 而那种缺陷只能靠真机跑三轮才看得出来。
 * 2026-11-13 红队确认：`candidatesFor` 在 `src/**\/*.test.mjs` 里**零覆盖**，
 * 也就是说改动它（或改回旧实现）636 个测试全绿。
 *
 * 已实证的两次饥饿：
 *   · 原实现「按顺序取 top-3，凑满 6 个」⇒ 前 2 条诊断就吃满名额；
 *   · 修过一版「每条诊断取一个」⇒ 7 条诊断时，第 7 条（`UPGRADE_AVAILABLE`，
 *     唯一的候选是 `upgrade`）仍然第一轮就出局。
 *
 * 真机后果：prompt 里出现「诊断说去买升级、卡片里却没有 `upgrade` 怎么写」——
 * 模型看得到建议、看不到语法。用户的原话是「AI 不会用更高级的方法提高效率」。
 *
 * 运行：node --test src/agent/candidates_for.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { candidatesFor } from "./loop.mjs";

const d = code => ({ code, candidates: null });
const cap = 6;

test("C1 单条诊断：给出它的候选，不超过 cap", () => {
    const r = candidatesFor([d("MIXER_UNFED")]);
    assert.ok(r.length >= 1 && r.length <= cap, `实得 ${JSON.stringify(r)}`);
    assert.ok(r.includes("connect"), "MIXER_UNFED 的 top 候选是 connect");
});

test("C2 每条诊断都有代表（诊断数 ≤ cap 时）", () => {
    /* 这是「不许有诊断被完全忽略」的基本保证。 */
    const codes = ["MIXER_UNFED", "PROCESSOR_REQUIRED", "NO_PRODUCTION", "ORPHAN_MACHINES"];
    const r = candidatesFor(codes.map(d));
    /* ORPHAN_MACHINES 唯一的候选是 remove_machine —— 它必须在场 */
    assert.ok(r.includes("remove_machine"),
        `ORPHAN_MACHINES 的诊断被整个忽略了：${JSON.stringify(r)}`);
    assert.ok(r.includes("insert_machine"), `PROCESSOR_REQUIRED 被忽略：${JSON.stringify(r)}`);
});

test("★ C3 七条诊断时，第 7 条的**专有**候选不许被饿死", () => {
    /* 真实 level 9 世界（废线 + 孤儿机并存）正好有 7 条诊断，
       `UPGRADE_AVAILABLE` 排最后。旧实现下 `upgrade` 永远进不了前 6。 */
    const codes = [
        "MIXER_UNFED", "PROCESSOR_REQUIRED", "NO_PRODUCTION", "FLOW_UNREACHABLE",
        "DEAD_LINES", "ORPHAN_MACHINES", "UPGRADE_AVAILABLE",
    ];
    const r = candidatesFor(codes.map(d));
    assert.equal(r.length, cap, `名额应当用满 ${cap} 个，实得 ${r.length}`);
    assert.ok(r.includes("upgrade"),
        `★ upgrade 被饿死了 —— 那条诊断这一轮没有任何可执行动作。实得：${JSON.stringify(r)}`);
});

test("★ C4 但紧急的通用宏不许因此被挤掉", () => {
    /* 修 C3 时容易过度修正：只按「稀有度」排会让 upgrade 冲到第一位，
       把「这台 mixer 永远跑不起来」压下去。买升级救不了断掉的产线。 */
    const codes = [
        "MIXER_UNFED", "PROCESSOR_REQUIRED", "NO_PRODUCTION", "FLOW_UNREACHABLE",
        "DEAD_LINES", "ORPHAN_MACHINES", "UPGRADE_AVAILABLE",
    ];
    const r = candidatesFor(codes.map(d));
    assert.ok(r.includes("connect"),
        `connect 是 MIXER_UNFED 的 top 候选，不许因为要给 upgrade 让位就消失：${JSON.stringify(r)}`);
    assert.ok(r.includes("replace_run"),
        `replace_run 是 PROCESSOR_REQUIRED 的 top 候选：${JSON.stringify(r)}`);
    assert.ok(r.indexOf("connect") < r.indexOf("upgrade"),
        `★ upgrade 不许排在 connect 前面 —— 断线比提速更急。实得：${JSON.stringify(r)}`);
});

test("C5 八条诊断时仍然包含 upgrade（多一条不该改变结论）", () => {
    const codes = [
        "MIXER_UNFED", "PROCESSOR_REQUIRED", "NO_PRODUCTION", "FLOW_UNREACHABLE",
        "DEAD_LINES", "ORPHAN_MACHINES", "UPGRADE_AVAILABLE", "DEAD_END",
    ];
    const r = candidatesFor(codes.map(d));
    assert.ok(r.includes("upgrade"), `实得：${JSON.stringify(r)}`);
});

test("C6 输出确定性：同一输入两次调用结果完全相同", () => {
    /* 候选顺序进 prompt，进指纹。不确定 ⇒ NO_PROGRESS_3X 抖动。 */
    const codes = ["MIXER_UNFED", "NO_PRODUCTION", "ORPHAN_MACHINES", "UPGRADE_AVAILABLE"];
    const a = candidatesFor(codes.map(d));
    const b = candidatesFor(codes.map(d));
    assert.deepEqual(a, b);
});

test("C7 未知码 / 空输入不崩", () => {
    assert.deepEqual(candidatesFor([]), []);
    assert.deepEqual(candidatesFor([d("完全没有这个码")]), []);
    assert.ok(Array.isArray(candidatesFor([d("MIXER_UNFED"), d("完全没有这个码")])));
});

test("C8 不重复：同一个宏只出现一次", () => {
    const codes = ["MIXER_UNFED", "NO_PRODUCTION", "PROCESSOR_REQUIRED", "DEAD_END", "CHAIN_UNFED"];
    const r = candidatesFor(codes.map(d));
    assert.equal(new Set(r).size, r.length, `有重复：${JSON.stringify(r)}`);
});
