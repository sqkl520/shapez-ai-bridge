/**
 * ports_belt_rot.test.mjs — 锁死「带子的端口方向必须由 (rotation_variant, r) 算」。
 *
 * 运行：node --test src/agent/macros/ports_belt_rot.test.mjs
 *
 * ## 这个 bug 是什么（实测，2026-11-01）
 *
 * `portsOf()` 对**带子**走 `mk()` 的通用路径，方向直接读 `machine-spec.json`：
 *
 *     belt.default.ejectors = [{ tile:[0,0], dir:"top" }]
 *     belt.default.acceptors = [{ tile:[0,0], dir:"bottom" }]
 *
 * 这两个 `dir` 是 **r=0 且 rv=0** 的静态快照。带子的真实方向由
 * `beltExit(rv,r)` / `beltEntry(rv,r)` 决定，spec 是静态 JSON，表达不了「随 r/rv 变化」。
 *
 * 半成品世界里的断点 `(1,-6)` 是 r=180 / rv=0：
 *
 *     真实出口 : bottom → (1,-5)
 *     旧 portsOf: top    → (1,-7)   ← 那格反而是**上游**的旧带子
 *
 * `connect` 以 `portsOf(from).eject` 为搜索起点，起点格和方向都错 ⇒ 842 条候选全落在
 * 错误位置、全部撞旧带。修好后 `(1,-5) → (1,-3)` 是 3 格零覆盖的直线。
 *
 * ## 为什么既有 221 条测试全绿
 *
 * 它们只覆盖 r=0 的带子：`beltExit(0,0) = "top"`，与 spec 写死的 top 恰好一致。
 * 唯一「碰巧对」的 r≠0 组合是 r=90 / rv=1（`beltExit(1,90) = "top"`）。
 *
 * ## 入口语义（不是猜的，三条独立证据）
 *
 * `accept.vel` 表示**接进来的带子上的货流方向**（= 朝机器/本带喷的方向），不是本带的入口面。
 * 依据：
 *   ① F3（文件头，实机 14/14 + 12/12）：ejector 的带格 = 槽 + DIRV[dir]；
 *      acceptor 的带格 = 槽 + DIRV[dir]，且「带子 exit = OPP[dir]」——即带子朝机器喷。
 *   ② `mk()` 自己写的就是 `vel = kind === "eject" ? face : OPP[face]`，face=acceptor.dir。
 *   ③ 下游消费者：`connect` 把 `pt.cell / pt.vel` 当 `candidateShapes(S,v0,E,vE)` 的终点格与
 *      末格出货方向（connect.mjs 的 `const E = pt.cell, vE = pt.vel`），`poseChain` 要求
 *      末格 exit === vE。所以 vel 必须是「货流在带子上的方向」。
 *
 * 因此对带子当 acceptor 时：入口面 = `beltEntry(rv,r)`（货从这一面进来），
 * 接进来的带子应占 `本格 + DIRV[入口面]`，其货流方向 `vel = OPP[入口面]`。
 * r=0/rv=0 时入口面=bottom、vel=top，与 spec 完全一致 —— 所以这套推导没有改旧行为。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { portsOf, connect, buildWorld } from "./connect.mjs";
import { ORDER, OPP, DIRV, beltEntry, beltExit } from "../../ai/belt-rules.mjs";

const SPEC = JSON.parse(
    (await import("node:fs")).readFileSync(
        new URL("../../ai/machine-spec.json", import.meta.url), "utf8"));

/** 一条带子的 portsOf 结果（rec 形状与 buildWorld 产出一致） */
const beltRec = (x, y, r, rv) => ({
    uid: 1, type: "belt", x, y, r: r === undefined ? 0 : r,
    rv: rv === undefined ? 0 : rv, variant: "default", w: 1, h: 1,
});

const ejectOf = (x, y, r, rv) => {
    const p = portsOf(beltRec(x, y, r, rv), SPEC).eject;
    assert.equal(p.length, 1, `r=${r} rv=${rv} 应恰好 1 个 ejector`);
    return p[0];
};
const acceptOf = (x, y, r, rv) => {
    const p = portsOf(beltRec(x, y, r, rv), SPEC).accept;
    assert.equal(p.length, 1, `r=${r} rv=${rv} 应恰好 1 个 acceptor`);
    return p[0];
};

/* ═══════════════════════════════ 正例（手算的三条） ═══════════════════════════════ */

test("正例 A：r=180 rv=0 的带子（半成品世界的断点 (1,-6)）→ eject=[1,-5] bottom", () => {
    /* 这就是本 bug 的原始现场。旧实现给的是 cell=[1,-7], vel="top"。 */
    assert.equal(beltExit(0, 180), "bottom", "前提：r=180 直带朝下");
    const p = ejectOf(1, -6, 180, 0);
    assert.deepEqual(p.cell, [1, -5], `出口格必须是下方一格；实得 ${JSON.stringify(p.cell)}`);
    assert.equal(p.vel, "bottom", `出口方向必须是 bottom；实得 ${p.vel}`);
});

test("正例 B：r=270 rv=0 → eject 必须是 [x-1,y] / left", () => {
    assert.equal(beltExit(0, 270), "left", "前提：r=270 直带朝左");
    const p = ejectOf(5, 5, 270, 0);
    assert.deepEqual(p.cell, [4, 5]);
    assert.equal(p.vel, "left");
});

test("正例 C：r=90 rv=1（「碰巧对」的那条）→ 仍必须是 top", () => {
    /* beltExit(1,90)="top" 与 spec 写死的 top 相同 —— 这就是它能骗过所有测试的原因。
       修完之后它必须**还是**对，防止「把碰巧对的那类改坏」。 */
    assert.equal(beltExit(1, 90), "top", "前提：rv1 转 90 出口朝上");
    const p = ejectOf(3, 3, 90, 1);
    assert.deepEqual(p.cell, [3, 2]);
    assert.equal(p.vel, "top");
});

/* ═══════════════════════════════ 全家桶：4 r × 3 rv ═══════════════════════════════ */

test("全家桶：r ∈ {0,90,180,270} × rv ∈ {0,1,2} 的 12 种组合，出口全部按 beltExit 算", () => {
    const X = 7, Y = -4;
    const seen = new Set();
    for (const r of [0, 90, 180, 270]) {
        for (const rv of [0, 1, 2]) {
            const p = ejectOf(X, Y, r, rv);
            const ex = beltExit(rv, r);
            const want = [X + DIRV[ex][0], Y + DIRV[ex][1]];
            assert.deepEqual(p.cell, want,
                `r=${r} rv=${rv}: eject.cell 应为 ${want}（exit=${ex}），实得 ${JSON.stringify(p.cell)}`);
            assert.equal(p.vel, ex, `r=${r} rv=${rv}: eject.vel 应为 ${ex}，实得 ${p.vel}`);
            assert.equal(p.face, ex, `r=${r} rv=${rv}: eject.face 应为出口面 ${ex}，实得 ${p.face}`);
            assert.deepEqual(p.slot, [X, Y], "带子的 slot 永远是它自己那一格");
            seen.add(`${r},${rv},${ex}`);
        }
    }
    assert.equal(seen.size, 12, "12 种组合必须全部覆盖（不能有重复即漏项）");
});

test("全家桶：入口（accept）cell = 本格 + DIRV[beltEntry]，vel = OPP[beltEntry]", () => {
    const X = 7, Y = -4;
    for (const r of [0, 90, 180, 270]) {
        for (const rv of [0, 1, 2]) {
            const p = acceptOf(X, Y, r, rv);
            const en = beltEntry(rv, r);
            const want = [X + DIRV[en][0], Y + DIRV[en][1]];
            assert.deepEqual(p.cell, want,
                `r=${r} rv=${rv}: accept.cell 应为 ${want}（entry=${en}），实得 ${JSON.stringify(p.cell)}`);
            assert.equal(p.vel, OPP[en], `r=${r} rv=${rv}: accept.vel 应为 OPP[${en}]=${OPP[en]}，实得 ${p.vel}`);
            assert.equal(p.face, en, `r=${r} rv=${rv}: accept.face 应为入口面 ${en}，实得 ${p.face}`);
        }
    }
});

test("入口语义回归：r=0 rv=0 的推导与 machine-spec 写死的值逐字段一致（证明没改旧行为）", () => {
    /* spec 是 r=0/rv=0 的真值快照。推导结果必须与它相同，否则不是「修 r≠0」而是「改全表」。 */
    const specBelt = SPEC.buildings.belt.variants.default;
    const r0 = beltRec(0, 0, 0, 0);
    const pp = portsOf(r0, SPEC);
    const se = specBelt.ejectors[0];
    const sa = specBelt.acceptors[0];
    const eject0 = pp.eject[0];
    assert.deepEqual(eject0.cell, [DIRV[se.dir][0], DIRV[se.dir][1]]);
    assert.equal(eject0.vel, se.dir);
    assert.equal(eject0.face, se.dir);
    const accept0 = pp.accept[0];
    assert.deepEqual(accept0.cell, [DIRV[sa.dir][0], DIRV[sa.dir][1]]);
    assert.equal(accept0.vel, OPP[sa.dir]);
    assert.equal(accept0.face, sa.dir);
});

/* ═══════════════════════════════ 角色 / 契约形态 ═══════════════════════════════ */

test("带子的端口角色/索引保持 out / primary #0（selectPort 的 auto 依赖「只有一个」）", () => {
    for (const r of [0, 90, 180, 270]) {
        const pp = portsOf(beltRec(0, 0, r, 0), SPEC);
        assert.equal(pp.eject.length, 1);
        assert.equal(pp.accept.length, 1);
        assert.equal(pp.eject[0].role, "out");
        assert.equal(pp.eject[0].index, 0);
        assert.equal(pp.accept[0].role, "primary");
        assert.equal(pp.accept[0].index, 0);
        assert.equal(pp.eject[0].kind, "eject");
        assert.equal(pp.accept[0].kind, "accept");
    }
});

/* ═══════════════════════════════ 反例：机器不受影响 ═══════════════════════════════ */

test("反例·切割机：cutter r=0 的端口与 spec 逐字段一致（两个上出货口 + 一个下入口）", () => {
    /* v1 不支持旋转机器，所以机器的端口**必须**继续来自静态 spec。
       这一条防的是「顺手把 mk() 也改成按旋转算」。 */
    const rec = { uid: 2, type: "cutter", x: 0, y: 0, r: 0, rv: 0, variant: "default", w: 2, h: 1 };
    const pp = portsOf(rec, SPEC);
    assert.deepEqual(
        pp.eject.map(p => [p.slot, p.cell, p.vel, p.face, p.role]),
        [
            [[0, 0], [0, -1], "top", "top", "left"],
            [[1, 0], [1, -1], "top", "top", "right"],
        ]);
    assert.deepEqual(
        pp.accept.map(p => [p.slot, p.cell, p.vel, p.face, p.role]),
        [[[0, 0], [0, 1], "top", "bottom", "primary"]]);
});

test("反例·矿机：miner r=0 仍是 1 个 top 出货口、0 个入口", () => {
    const rec = { uid: 1, type: "miner", x: 0, y: 6, r: 0, rv: 0, variant: "default", w: 1, h: 1 };
    const pp = portsOf(rec, SPEC);
    assert.deepEqual(pp.eject.map(p => [p.cell, p.vel, p.face]), [[[0, 5], "top", "top"]]);
    assert.deepEqual(pp.accept, []);
});

/* ═══════════════════════════════ 护栏：端口非空 && connect 端到端 ═══════════════════════════════ */

test("护栏：r≠0 的带子仍然返回非空端口表（ROTATION_FREE 不能被改回去）", () => {
    for (const r of [90, 180, 270, -90, 450]) {
        const pp = portsOf(beltRec(1, -6, r, 0), SPEC);
        assert.equal(pp.eject.length, 1, `r=${r} 的带子必须有 ejector`);
        assert.equal(pp.accept.length, 1, `r=${r} 的带子必须有 acceptor`);
    }
});

test("★ 端到端：r=180 的断点带子 → hub，必须是 3 格零覆盖的 [[1,-5],[1,-4],[1,-3]]", () => {
    /* 半成品世界的合成复刻（hub 在 (-2,-2)，4×4，顶排入口 0..3 在 y=-3）。
       修端口之前这里会因为起点错成 (1,-7) 而全撞旧带。 */
    const ents = [
        { uid: 10538, type: "belt", x: 1, y: -6, r: 180, rotation_variant: 0, code: 1, layer: "regular" },
        { uid: 10536, type: "belt", x: 1, y: -7, r: 180, rotation_variant: 0, code: 1, layer: "regular" },
        { uid: 10000, type: "hub", x: -2, y: -2, r: 0, rotation_variant: 0, code: 26, layer: "regular" },
    ];
    const r = connect({ from: { uid: 10538 }, to: { hub: { uid: 10000 } } }, { entities: ents });
    assert.equal(r.ok, true, `必须零覆盖连通，实得 ${JSON.stringify(r.error)}`);
    assert.deepEqual(r.cells.map(c => [c.x, c.y]), [[1, -5], [1, -4], [1, -3]],
        `路径必须是最初被砍掉的那 3 格；实得 ${JSON.stringify(r.cells.map(c => [c.x, c.y]))}`);
    assert.equal(r.warnings.some(w => w.code === "replacing-belts"), false, "不得覆盖任何旧带");
    assert.equal(r.choice.fromPort.cell[0], 1);
    assert.equal(r.choice.fromPort.cell[1], -5, "fromPort 的起点格必须是真实出口格 (1,-5)");
    assert.equal(r.choice.fromPort.vel, "bottom", "fromPort 的货流方向必须是 bottom");
});

/* ═══════════════════════════════ 范围决策：隧道保持原样 ═══════════════════════════════ */

test("范围决策：underground_belt 不按带子特判（rv 是 sender/receiver 位，不是弯带语义）", () => {
    /* 隧道的 rv 不是「直/左弯/右弯」：beltExit(1,0)="left" 套到隧道上就是错的
       （src/agent/loop/topology.test.mjs 事实 1 已钉死这一点）。
       隧道真正需要的端口来自 spec.rotationVariantSlots（sender 只收 / receiver 只喷），
       而连接语义还要处理「成对 portal」—— 这是独立特性，不在本 bug 的修复范围。
       本测试只锁「没有被顺手喂进 beltEntry/beltExit」这个事实。 */
    const rec = { uid: 9, type: "underground_belt", x: 0, y: 0, r: 0, rv: 1, variant: "default", w: 1, h: 1 };
    const pp = portsOf(rec, SPEC);
    const all = [...pp.eject, ...pp.accept];
    for (const p of all) {
        assert.notEqual(p.vel, beltExit(rec.rv, rec.r), "隧道端口不得使用弯带出口语义");
        assert.notEqual(p.vel, beltEntry(rec.rv, rec.r), "隧道端口不得使用弯带入口语义");
    }
    assert.deepEqual(all, [], "当前实现不给隧道端口（行为未变）");
});

/* ═══════════════════════════════ 世界一致性：buildWorld 的 rv 通道 ═══════════════════════════════ */

test("buildWorld 把 obs 的 rotation_variant 映射到 rec.rv（端口推导的输入）", () => {
    const [rec] = buildWorld([{ uid: 7, type: "belt", x: 0, y: 0, r: 270, rotation_variant: 2 }], SPEC).byUid.values();
    assert.equal(rec.r, 270);
    assert.equal(rec.rv, 2);
    const p = portsOf(rec, SPEC).eject[0];
    assert.equal(p.vel, beltExit(2, 270), "portsOf 必须用 rec.rv，而不是只看 r");
});

/* ═══════════════════════════════ 自证：ORDER 全 12 组合都合法 ═══════════════════════════════ */

test("自证：12 组合的 eject.vel 与 accept.vel 都落在 ORDER 的四个方位里", () => {
    for (const r of [0, 90, 180, 270]) {
        for (const rv of [0, 1, 2]) {
            const pp = portsOf(beltRec(0, 0, r, rv), SPEC);
            assert.ok(ORDER.includes(pp.eject[0].vel));
            assert.ok(ORDER.includes(pp.accept[0].vel));
            assert.ok(ORDER.includes(pp.eject[0].face));
            assert.ok(ORDER.includes(pp.accept[0].face));
        }
    }
});
