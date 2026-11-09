/**
 * assess.test.mjs —— 产能评估的判据。
 *
 * ## 这个文件为什么存在
 *
 * `assess.mjs` 一直没有测试。后果不是"少了覆盖率"，是**它在真机上直接崩**：
 *
 *   TypeError: Cannot read properties of undefined (reading 'belt')
 *       at upgradeGaps (assess.mjs:95)
 *
 * 原因是升级等级在**两个不同位置**：
 *   · 真机 `obs`（mod 原样返回）→ `obs.goal.upgrade_levels` + `obs.hub.stored_shapes`
 *   · `obsForAssess()` 归一化后 → `obs.upgrades` + `obs.stored`
 *
 * `assess()` / `capacityOf()` 吃**原始** obs，但内部按归一化形态读。
 * 这个 bug 被 `capacityFor()` 挡住了（它先走 `obsForAssess`），
 * 所以所有走那条路的测试都绿 —— 只有直接 `assess(rawObs)` 才炸。
 *
 * 这个文件的第一组测试就是钉这个：**两种 obs 形态必须都能算**。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assess, capacityFor, capacityOf, obsForAssess } from "./assess.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const load = p => JSON.parse(fs.readFileSync(path.join(REPO, p), "utf8")).result;

/* ── 两种 obs 形态的构造 ─────────────────────────────────────────────── */

/** 真机形态：mod 原样返回（goal.requirement / goal.upgrade_levels / hub.stored_shapes / resources） */
const RAW = load("test/fixtures/saves/L6-live-obs.json");

/** 归一化形态：obsForAssess 之后 */
const NORM = obsForAssess(RAW);

/* ══════════════════════════════════════════════════════════════════════════
 * 1. ★ 两种形态都能算（真机崩过的那个）★
 * ══════════════════════════════════════════════════════════════════════════ */

test("A1 ★ 真机形态（goal.upgrade_levels）不崩，且算出升级线", () => {
    /* 这就是 2026-11-09 在真机 level 6 上崩掉的那条路径。 */
    const a = assess(RAW);
    assert.ok(a, "assess(raw) 必须返回对象");
    assert.ok(Array.isArray(a.upgrades), "upgrades 必须是数组");
    assert.ok(a.upgrades.length > 0, `真机形态必须算得出升级线，实际 ${a.upgrades.length} 条`);
    for (const u of a.upgrades) {
        assert.equal(typeof u.line, "string");
        assert.equal(typeof u.tier, "number");
        assert.equal(typeof u.affordable, "boolean");
        assert.ok(Array.isArray(u.missing));
    }
});

test("A2 ★ 归一化形态（obs.upgrades）也算得出，且结论与真机形态一致", () => {
    const a = assess(RAW);
    const b = assess(NORM);
    assert.deepEqual(
        a.upgrades.map(u => [u.line, u.tier, u.affordable]),
        b.upgrades.map(u => [u.line, u.tier, u.affordable]),
        "两种形态必须给出同一组升级结论 —— 否则就是两套真值",
    );
});

test("A3 ★ 两种形态的目标缺口一致", () => {
    const a = assess(RAW).goal;
    const b = assess(NORM).goal;
    assert.deepEqual(a, b, `目标缺口必须一致：${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    assert.equal(a.shape, "Cu------");
    assert.equal(a.required, 270);
});

test("A4 ★ 两种形态的产能瓶颈一致", () => {
    const a = assess(RAW).capacity;
    const b = assess(NORM).capacity;
    assert.equal(a.bottleneck, b.bottleneck, "瓶颈必须一致");
    assert.equal(a.bottleneckMachine, b.bottleneckMachine);
    assert.equal(a.miners.count, b.miners.count);
    assert.equal(a.miners.active, b.miners.active);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 矿格形态（resources 是数组的数组，oreCells 是对象的数组）
 * ══════════════════════════════════════════════════════════════════════════ */

test("A5 ★ 真机 resources（[[x,y,kind]]）也能判「矿机压在矿上」", () => {
    /* 读错形态的后果不是崩，而是**静默判成全部空转** ——
       那会让模型去挪一堆本来没问题的矿机。这类假绿比崩溃更危险。 */
    const a = assess(RAW);
    assert.equal(a.capacity.miners.idle, 0,
        `L6 真机的 4 台矿机都压在矿上，idle 必须是 0，实际 ${a.capacity.miners.idle}`);
    assert.equal(a.capacity.miners.active, 4);
});

test("A6 oreUtilization 两种形态一致，且铜矿利用率极低（用户抱怨的那个数）", () => {
    const a = assess(RAW).oreUtilization;
    const b = assess(NORM).oreUtilization;
    assert.deepEqual(a, b, "矿利用率必须一致");

    const cu = a.find(x => x.kind === "CuCuCuCu");
    assert.ok(cu, `必须有铜矿统计，实际 ${JSON.stringify(a.map(x => x.kind))}`);
    assert.equal(cu.available, 108, "L6 真机铜矿 108 格");
    assert.equal(cu.used, 1, "只用了 1 格 —— 这正是「明明有矿却不用」的量化");
    assert.ok(cu.utilization < 0.05, `铜矿利用率 ${cu.utilization} 应远低于 5%`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. headline 必须说人话且含关键数字
 * ══════════════════════════════════════════════════════════════════════════ */

test("A7 headline 点名瓶颈机器与目标缺口", () => {
    const a = assess(RAW);
    assert.equal(typeof a.headline, "string");
    assert.ok(a.headline.length > 20, "headline 不能是一句话碎片");
    assert.match(a.headline, /cutter/, `瓶颈是 cutter，headline 要点名：${a.headline}`);
    assert.match(a.headline, /Cu------/, `要点名目标形状：${a.headline}`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 缺数据时降级，不编数
 * ══════════════════════════════════════════════════════════════════════════ */

test("A8 没有 resources ⇒ 矿利用率不可信，confidence 要如实降级", () => {
    const noRes = { ...RAW, resources: undefined };
    const a = assess(noRes);
    /* 不许崩，也不许假装"全部空转"是已知事实。 */
    assert.ok(a.capacity, "没有矿格数据也必须给出 capacity（降级而非崩）");
    assert.notEqual(a.capacity.confidence, "ok",
        "没有矿格数据时 confidence 不能是 ok —— 「没读到」与「是 0」必须分开");
});

test("A9 空世界上 assess 不崩（首轮 / 新存档）", () => {
    const empty = { goal: { level: 1, requirement: { shape: "CuCuCuCu", required: 10, delivered: 0 } }, entities: [], resources: [] };
    const a = assess(empty);
    assert.ok(a.goal, "目标缺口仍要算得出");
    assert.equal(a.goal.required, 10);
    assert.equal(a.capacity.miners.count, 0);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. capacityFor 仍然走归一化（回归保护）
 * ══════════════════════════════════════════════════════════════════════════ */

test("A10 capacityFor 与 assess 的 capacity 一致（两条路的结论不许分叉）", () => {
    const direct = assess(RAW).capacity;
    const viaFor = capacityFor(RAW).capacity;
    assert.deepEqual(viaFor, direct,
        "capacityFor 走 obsForAssess，assess 走原始 —— 两者结论必须一致，否则就是两套真值");
});
