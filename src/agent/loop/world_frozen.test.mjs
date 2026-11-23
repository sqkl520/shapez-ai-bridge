/**
 * world_frozen.test.mjs — `WORLD_FROZEN`：整座工厂零产出时的堵点诊断
 *
 * ## 为什么需要它（2026-11-23，567 个快照的统计）
 *
 * 按关卡分组 `produced_total` 是否为空：
 *
 *   level  9   58 个快照，16 个空（28%）   ← 正常
 *   level 12  508 个快照，500 个空（98%） ← 异常
 *
 * 同一存档、同一桥、同一套代码。**只有 L12 是死的。**
 * 而 91.0% 的沉默快照同时满足「零产出」与「带子上有货」—— 世界是载入的，只是不动。
 *
 * 形态（`r-20261123151728-52a3` 实测）：
 *
 *   path8   165 格带子塞了 259 件（98.9%），blue ×131 + ScSc---- ×128
 *   path20   55 格带子塞了 87 件纯蓝颜料，末端 `boundAcceptor = null`
 *
 * ## 三条验收
 *
 * 1. **死世界上必须触发**，且数字对得上（259 件 / 165 格）
 * 2. **活世界上一律不报** —— 满载是这套工厂的常态（50 个在产出的快照里 30 个出口也全堵），
 *    拿「堵」当判据会去修正常的东西
 * 3. **必须带能落地的句柄** —— 一条说不出改哪里的诊断等于没诊断
 *
 * 第 2 条是这次最容易被写错的地方：判据只能是「**全图零产出**」，
 * 不能是「出口堵满」。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { diagnose } from "../loop.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNS = path.resolve(HERE, "../../../research/ai-plan/runs");
const GOAL = "CbCbCbRb:CwCwCwCw";

/** 读一个 run 的三件套。缺任何一个都抛（不 skip —— 缺夹具必须红）。 */
function loadRun(id) {
    const b = path.join(RUNS, id) + path.sep;
    const r = (f) => JSON.parse(fs.readFileSync(b + f, "utf8"));
    return { obs: r("obs-last.json"), items: r("items-last.json"), production: r("production-last.json") };
}

const DEAD_RUN = "r-20261123151728-52a3";

test("★ 死世界上必须触发，且数字要与实测对得上", () => {
    const { obs, items, production } = loadRun(DEAD_RUN);
    /* 前提：这个世界确实是死的（否则这条测试就变成在测别的东西） */
    const produced = production.result && production.result.produced_total !== undefined
        ? production.result.produced_total : production.produced_total;
    assert.equal(Object.keys(produced || {}).length, 0,
        "前提：该快照的 produced_total 必须为空");

    const ds = diagnose(obs, items, production, null, GOAL, null, { recipe: null });
    const wf = ds.find(d => d.code === "WORLD_FROZEN");
    assert.ok(wf, `死世界必须报 WORLD_FROZEN，实得 ${ds.map(d => d.code).join(",")}`);

    /* 数字必须是真的，不是占位符 */
    const worst = wf.evidence && wf.evidence.worst;
    assert.equal(worst.items, 259, "最堵的一条必须是 259 件");
    assert.equal(worst.cells, 165, "那条带子必须是 165 格");
    assert.ok(wf.observed.includes("259"), `observed 里必须出现 259，实得：${wf.observed}`);
    assert.ok(wf.observed.includes("165"), `observed 里必须出现 165，实得：${wf.observed}`);
    assert.ok(wf.observed.includes("blue") && wf.observed.includes("ScSc----"),
        `必须说出堵的是什么货，实得：${wf.observed}`);
});

test("★ 必须带能落地的句柄（否则等于没诊断）", () => {
    const { obs, items, production } = loadRun(DEAD_RUN);
    const ds = diagnose(obs, items, production, null, GOAL, null, { recipe: null });
    const wf = ds.find(d => d.code === "WORLD_FROZEN");
    assert.ok(wf, "前提：必须先报出来");
    assert.ok(Array.isArray(wf.handles) && wf.handles.length >= 1,
        `句柄不能为空，实得 ${JSON.stringify(wf.handles)}`);
    /* 句柄必须是真实存在的带子（照着 prompt 写进 connect/remove_run 能被认出来） */
    for (const h of wf.handles) {
        assert.match(h, /^B\d+$/, `句柄格式应是 B<数字>，实得 ${h}`);
    }
    /* hint 里必须出现「先通开」这一类语义，否则模型会继续去接缺料口 */
    assert.ok(/通开|吃掉|拆掉|改道/.test(wf.hint),
        `hint 必须指向"疏通"而不是"连接"，实得：${wf.hint.slice(0, 120)}`);
});

test("★ 反例：世界还在动的时候一律不报（满载是常态，不是故障）", () => {
    /* L9 时代的快照 —— 那个世界还在产出（`produced_total` 非空），
     * 而它的 ejector 也大多是堵的。两者必须分得开。 */
    const liveRun = "r-20261110143303-686b";
    const { obs, items, production } = loadRun(liveRun);
    const produced = production.result && production.result.produced_total !== undefined
        ? production.result.produced_total : production.produced_total;
    assert.ok(Object.keys(produced || {}).length > 0,
        "前提：这个快照必须还在产出");

    const ds = diagnose(obs, items, production, null, GOAL, null, { recipe: null });
    assert.ok(!ds.some(d => d.code === "WORLD_FROZEN"),
        `世界还在产出时不许报 WORLD_FROZEN，实得 ${ds.map(d => d.code).join(",")}`);
});

test("★ 反例：没有 production 数据时不许猜", () => {
    const { obs, items } = loadRun(DEAD_RUN);
    const ds = diagnose(obs, items, null, null, GOAL, null, { recipe: null });
    assert.ok(!ds.some(d => d.code === "WORLD_FROZEN"),
        "读不到产出窗口 ⇒ 不判定（与语义层其它地方同一条纪律）");
});

test("★ 排序：WORLD_FROZEN 必须排在 NO_PRODUCTION 之前", () => {
    /* 两条都描述零产出，但动作方向相反：
     *   WORLD_FROZEN  → 通开
     *   NO_PRODUCTION → 新建
     * 在满载世界里让模型看到「去新建」是灾难。 */
    const { obs, items, production } = loadRun(DEAD_RUN);
    const ds = diagnose(obs, items, production, null, GOAL, null, { recipe: null });
    const iFrozen = ds.findIndex(d => d.code === "WORLD_FROZEN");
    const iNoProd = ds.findIndex(d => d.code === "NO_PRODUCTION");
    assert.ok(iFrozen >= 0, "前提：WORLD_FROZEN 必须存在");
    assert.ok(iNoProd >= 0, "前提：NO_PRODUCTION 必须存在");
    assert.ok(iFrozen < iNoProd,
        `WORLD_FROZEN 必须排在 NO_PRODUCTION 之前（实得 ${iFrozen} vs ${iNoProd}）`);
});
