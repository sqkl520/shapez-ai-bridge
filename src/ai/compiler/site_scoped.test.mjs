/**
 * site_scoped.test.mjs —— `siteScoped` 的区域判据。
 *
 * 背景：默认判据是「世界里有任何非 hub 实体就拒」，对真实存档（L12 有 762 个实体）
 * 永远红。但那条闸真正要回答的是「我的新产线会不会压到别人的东西」——
 * 世界别处有 700 台机器与本计划无关。
 *
 * 这两条判据必须**都**被钉住：
 *   · 默认仍然整体判（放松安全闸必须是显式选择，不能悄悄发生）
 *   · siteScoped 只判计划矩形内，且**矩形换算必须对**
 *
 * 换算用的是 anchor = hubWorld − hubLocal。这一条最容易写错，而且错了之后
 * 表现是「看起来在工作，其实判错了地方」—— 比直接报错更危险。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { regionClearReport } from "./compile.mjs";

/* hub 在设计系恒 [-4,-4]（见 compile.mjs），所以 hubLocal=[-4,-4] 时
   anchor = hubWorld − [-4,-4] = hubWorld + [4,4]。
   下面的用例都用这个前提，数值刻意选成能一眼算出来的。 */
const HUB_LOCAL = [-4, -4];

const ent = (type, x, y) => ({ type, x, y });

test("默认：世界上任何非 hub 实体都算脏（整体判据不变）", () => {
    const ctx = { world: { entities: [ent("hub", -2, -2), ent("belt", 500, 500)] } };
    const r = regionClearReport(ctx);
    assert.equal(r.clear, false, "远处的带子也算脏 —— 这是旧的保守判据");
    assert.equal(r.count, 1);
    assert.equal(r.scoped, undefined, "整体判据不该带 scoped 字段");
});

test("siteScoped：只判计划矩形内的实体", () => {
    /* hubWorld=[-2,-2]，hubLocal=[-4,-4] ⇒ anchor=[2,2]。
       计划矩形 rect=[0,0,9,9]（设计系）⇒ 世界系 [2,2,11,11]。
       放一个实体在 (5,5)（矩形内）和一个在 (500,500)（矩形外）。 */
    const ctx = {
        world: { entities: [ent("hub", -2, -2), ent("belt", 5, 5), ent("belt", 500, 500)] },
        siteScoped: true,
    };
    const r = regionClearReport(ctx, [0, 0, 9, 9], [-2, -2], HUB_LOCAL);
    assert.equal(r.clear, false, "矩形内的带子必须算脏");
    assert.equal(r.count, 1, "矩形外的那条不该被数进来");
    assert.deepEqual(r.foreign[0], { type: "belt", x: 5, y: 5 });
    assert.deepEqual(r.scoped.rect, [2, 2, 11, 11], "矩形必须换算到世界系");
});

test("siteScoped：矩形外全是机器也判干净（这是它存在的理由）", () => {
    const entities = [ent("hub", -2, -2)];
    for (let i = 0; i < 100; i++) entities.push(ent("belt", 500 + i, 500));
    const ctx = { world: { entities }, siteScoped: true };
    const r = regionClearReport(ctx, [0, 0, 9, 9], [-2, -2], HUB_LOCAL);
    assert.equal(r.clear, true, "矩形外 100 条带子与这块地无关，必须判干净");
    assert.equal(r.count, 0);
});

test("siteScoped：矩形含边界（rect 是闭区间）", () => {
    /* 世界系矩形 [2,2,11,11]，四条边上的点都必须在界内。 */
    const ctx = {
        world: { entities: [
            ent("hub", -2, -2),
            ent("belt", 2, 2),    // 左上角
            ent("belt", 11, 11),  // 右下角
            ent("belt", 1, 5),    // 左边界外一格
            ent("belt", 12, 5),   // 右边界外一格
        ] },
        siteScoped: true,
    };
    const r = regionClearReport(ctx, [0, 0, 9, 9], [-2, -2], HUB_LOCAL);
    assert.equal(r.count, 2, "闭区间：角上两个在内，边界外两个不在");
    assert.deepEqual(r.foreign.map(f => [f.x, f.y]), [[2, 2], [11, 11]]);
});

test("siteScoped：拿不到 anchor 时退回整体判据（不猜坐标系）", () => {
    /* 没有 hubWorld 就不知道计划落在世界哪里。此时把设计系矩形当世界系用，
       是把两套坐标系混着判 —— 全都会错。必须退回保守的整体判据。 */
    const ctx = { world: { entities: [ent("hub", -2, -2), ent("belt", 500, 500)] }, siteScoped: true };
    const noHub = regionClearReport(ctx, [0, 0, 9, 9], null, HUB_LOCAL);
    assert.equal(noHub.clear, false, "没有 anchor ⇒ 退回整体判据 ⇒ 远处带子仍然算脏");
    assert.equal(noHub.count, 1);
    assert.equal(noHub.scoped, undefined, "退回时不该假装做过区域判据");
});

test("siteScoped：没有世界快照时仍然报「不知道」（snapshot:false）", () => {
    const r = regionClearReport({ siteScoped: true }, [0, 0, 9, 9], [-2, -2], HUB_LOCAL);
    assert.equal(r.clear, true);
    assert.equal(r.snapshot, false, "没给快照 ≠ 干净，必须如实说「不知道」");
});

test("siteScoped：hub 自己永远不算脏（它在矩形内也一样）", () => {
    const ctx = { world: { entities: [ent("hub", 5, 5)] }, siteScoped: true };
    const r = regionClearReport(ctx, [0, 0, 9, 9], [-2, -2], HUB_LOCAL);
    assert.equal(r.clear, true, "hub 在实体表里是常态，算脏会让任何调用恒拒");
});
