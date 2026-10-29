/**
 * topology.test.mjs — `loop/topology.mjs` 的几何回归（P-a0）。
 *
 * 这个文件测的不是「函数能跑」，而是**三条被实测钉死的几何事实**：
 *
 *   1. 隧道不能用 `beltEntry` / `beltExit`（`slotsOf('underground_belt')` 是 null，
 *      而 `beltExit(1, 0)` 会得到 `"left"` —— 那是弯带语义）。
 *   2. `byCell` 必须是 footprint 级（hub 4×4）。origin 级索引会把 L4 的死端从 2 条误判成 8 条。
 *   3. 机器入口判据是「落点格 == 槽位本体格」。写成 approach 格，L4 的机器类误拒收会从 2 涨到 14。
 *
 * 另外两条是**判据的独立验证**（不是自证）：
 *   · `hubReachable` 与旧 `loop.mjs` 的实现逐 uid 对拍（搬家不能改语义）；
 *   · `accepts()` 与**游戏自己**的 `debug_items.paths[].boundAcceptor` 对拍。
 *
 * 运行：`node --test src/agent/loop/topology.test.mjs`
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beltEntry, beltExit, DIRV, OPP } from "../../ai/belt-rules.mjs";
import { slotsOf } from "../verify_runtime.mjs";
import {
    K, dirOfRotation, rvOf, isTunnel, tunnelIsSender,
    exitDirOf, entryDirOf, exitCellOf, entryCellOf,
    indexOf, at, tunnelPeer, accepts, runEnd, upstreamFed, hubReachable, sourceEntityOf,
} from "./topology.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAVES = path.resolve(HERE, "../../../test/fixtures/saves");
const load = f => JSON.parse(fs.readFileSync(path.join(SAVES, f), "utf8")).result;

const L4 = load("L4-obs.json");
const L5 = load("L5-obs.json");
const L5_ITEMS = JSON.parse(fs.readFileSync(path.join(SAVES, "L5-items.json"), "utf8")).result;

/* ══════════════════════════════════════════════════════════════════════════
 * 1. dirOfRotation —— 纯函数
 * ══════════════════════════════════════════════════════════════════════════ */

test("dirOfRotation：0/90/180/270 → top/right/bottom/left", () => {
    assert.equal(dirOfRotation(0), "top");
    assert.equal(dirOfRotation(90), "right");
    assert.equal(dirOfRotation(180), "bottom");
    assert.equal(dirOfRotation(270), "left");
});

test("dirOfRotation：负角度与超界角度都能归一（不返回 undefined）", () => {
    assert.equal(dirOfRotation(-90), "left");
    assert.equal(dirOfRotation(360), "top");
    assert.equal(dirOfRotation(450), "right");
    /* 轮子是 mod 4 的，所以 -450 与 -90 同余、与 270 同值 —— 这是「归一」而不是「取绝对值」 */
    assert.equal(dirOfRotation(-450), dirOfRotation(-90));
    assert.equal(dirOfRotation(720), "top");
    assert.equal(dirOfRotation(undefined), "top");
    assert.equal(dirOfRotation(null), "top");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 几何事实 1：隧道不能用 beltEntry / beltExit
 * ══════════════════════════════════════════════════════════════════════════ */

test("★ 事实 1：slotsOf('underground_belt') 返回 null（所以不能拿它算槽位）", () => {
    assert.equal(slotsOf("underground_belt", "default", -7, -12, 0), null);
});

test("★ 事实 1：beltExit(rv=1, r=0) === 'left' —— 套到隧道上就是错的", () => {
    /* 这一条是"反例凭证"：如果哪天有人把隧道的方向改成 beltExit，这个断言会在这里先红。 */
    assert.equal(beltExit(1, 0), "left");
    assert.equal(beltEntry(1, 0), "bottom");
});

test("★ 事实 1：隧道的方向只看 r，rotation_variant 是 sender/receiver 位", () => {
    const idx = indexOf(L4);
    const snd = idx.byUid.get(10077);
    const rcv = idx.byUid.get(10078);

    assert.equal(isTunnel(snd), true);
    assert.equal(tunnelIsSender(snd), true, "rv=0 = sender");
    assert.equal(tunnelIsSender(rcv), false, "rv=1 = receiver");

    /* sender@(-7,-12) r=0 → 出口朝 top → (-7,-13) */
    assert.equal(exitDirOf(snd), "top");
    assert.deepEqual(exitCellOf(snd), [-7, -13]);
    assert.equal(entryDirOf(snd), "bottom");

    /* receiver@(-7,-14) r=0 → 出口也朝 top → (-7,-15) = trash#10037 */
    assert.equal(exitDirOf(rcv), "top");
    assert.deepEqual(exitCellOf(rcv), [-7, -15]);
    assert.equal(idx.byUid.get(10037).type, "trash");
});

test("★ 事实 1：tunnelPeer 穿过压在隧道上的带子（空格 continue，带子也 continue）", () => {
    const idx = indexOf(L4);
    const snd = idx.byUid.get(10077);
    /* sender 在 (-7,-12)，receiver 在 (-7,-14)，中间 (-7,-13) 上压着带子 B85 */
    assert.equal(at(idx, [-7, -13]).type, "belt");
    const peer = tunnelPeer(idx, snd);
    assert.ok(peer, "中间隔着一条带子也必须配对成功");
    assert.equal(peer.uid, 10078);
});

test("tunnelPeer：receiver 自身不找 peer；找不到时返回 null", () => {
    const idx = indexOf(L4);
    assert.equal(tunnelPeer(idx, idx.byUid.get(10078)), null, "receiver 不是 sender");
    const orphan = { uid: 999999, type: "underground_belt", variant: "default", x: 100, y: 100, r: 0, rotation_variant: 0 };
    const idx2 = { ent: [orphan], byUid: new Map([[orphan.uid, orphan]]), byCell: new Map([[K([100, 100]), orphan]]) };
    assert.equal(tunnelPeer(idx2, orphan), null, "5 格内没有 receiver ⇒ null");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 几何事实 2：byCell 必须是 footprint 级
 * ══════════════════════════════════════════════════════════════════════════ */

test("★ 事实 2：L4「出口为空的带子」恰好 2 条（10008、10193）", () => {
    const idx = indexOf(L4);
    const dead = idx.ent.filter(e => e.type === "belt" && !at(idx, exitCellOf(e))).map(e => e.uid);
    assert.deepEqual(dead.sort((a, b) => a - b), [10008, 10193]);
});

test("★ 事实 2：用 origin 级索引会把上面那 2 条误判成 8 条", () => {
    /* 这不是"另一种实现"，这是**主线程在这个点上错了三次**的那份实现。
       保留它作为反例：只要 footprint 展开被去掉，这条断言就会红。 */
    const originOnly = new Map(L4.entities.map(e => [K([e.x, e.y]), e]));
    const dead = L4.entities
        .filter(e => e.type === "belt" && !originOnly.has(K(exitCellOf(e))))
        .map(e => e.uid);
    assert.equal(dead.length, 8, "origin 级索引：8 条（错）");
    assert.equal(dead.length - 2, 6, "多出来的 6 条全是「出口落进 hub 占地」的带子");
});

test("★ 事实 2：hub 的 4×4 占地每一格都能查到", () => {
    const idx = indexOf(L4);
    const hub = idx.ent.find(e => e.type === "hub");
    assert.deepEqual([hub.x, hub.y], [-2, -2]);
    for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 4; dx++) {
            const e = at(idx, [hub.x + dx, hub.y + dy]);
            assert.equal(e && e.uid, hub.uid, `hub footprint 内的 (${hub.x + dx},${hub.y + dy}) 必须查到 hub`);
        }
    }
    assert.equal(at(idx, [-1, -2]).uid, hub.uid, "★ (-1,-2) 是 hub 占地内部 —— 正是被漏掉的那一类");
});

test("★ 事实 2：L5 也是 2 条（10008、10193）", () => {
    const idx = indexOf(L5);
    const dead = idx.ent.filter(e => e.type === "belt" && !at(idx, exitCellOf(e))).map(e => e.uid);
    assert.deepEqual(dead.sort((a, b) => a - b), [10008, 10193]);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 几何事实 3：机器入口判据 = 落点格 vs 槽位本体格
 * ══════════════════════════════════════════════════════════════════════════ */

test("★ 事实 3：cutter 的槽位 —— slot 是本体格，cell 是 approach 格（两者差一格）", () => {
    const s = slotsOf("cutter", "default", -8, -11, 0);
    assert.deepEqual(s.inputs[0].slot, [-8, -11], "本体格");
    assert.deepEqual(s.inputs[0].cell, [-8, -10], "approach 格 = 本体格 + DIRV[dir]");
    assert.equal(s.inputs[0].dir, "bottom");
    /* 2×1：右半格的槽位本体格与左半格不同，但 approach 格也不同 */
    assert.deepEqual(s.outputs[1].slot, [-7, -11]);
    assert.deepEqual(s.outputs[1].cell, [-7, -12]);
});

test("★ 事实 3：正确判据下，机器类误拒收 L4 只有 1 条；写错成 approach 格会变 13 条", () => {
    /* ⚠️ 这两个数字与任务书给的「6 vs 1」不一致 —— 我按真几何**重算**了一遍，
       结论是「方向一致（写错会多报一个数量级），但数字是 1 vs 13」。
       差异来源：任务书那一段大概率把「槽位解析不了（`slotsOf` 返回 null）」
       也算成了拒收，而 `accepts()` 对这类实体返回 `opaque:true` 并**主动跳过**。
       这条测试把两个数都钉住，将来谁再改判据必须先面对这两个数字。 */
    const idx = indexOf(L4);
    let correct = 0;
    let wrong = 0;
    for (const e of idx.ent) {
        if (e.type !== "belt") continue;
        const d = exitDirOf(e);
        const L = exitCellOf(e);
        const R = at(idx, L);
        if (!R || R.type === "belt" || R.type === "underground_belt") continue;
        const s = slotsOf(R.type, R.variant, R.x, R.y, R.r || 0);
        if (!s) continue;                             // 槽位解析不了：不计入（与 accepts 的 opaque 同口径）
        /* 正确判据：槽位本体格 == 落点格 */
        const okCorrect = s.inputs.some(sl => sl.slot[0] === L[0] && sl.slot[1] === L[1] && sl.dir === OPP[d]);
        /* 错误判据：拿落点格去比 approach 格（`slot.cell`）—— 2×1 机器上两边都错了一格 */
        const okWrong = s.inputs.some(sl => sl.cell[0] === L[0] && sl.cell[1] === L[1] && sl.dir === OPP[d]);
        if (!okCorrect) correct++;
        if (!okWrong) wrong++;
    }
    assert.equal(correct, 1, "正确判据：1 条（10024 → balancer#10035，来向 right 不在它的 bottom 槽上）");
    assert.equal(wrong, 13, "错误判据：13 条 —— 多出来的 12 条全在 2×1 机器/hub 上");
});

test("★ 事实 3/6：accepts() 点名的误拒收恰好 2 条 —— 10024（→ balancer）与 10030（→ 反向带子）", () => {
    /* ★ 任务书 T6 说「命中 10030 但不命中 10024」，但**真几何不是这样**：
     *
     *   10024@(-9,-3) rv=2 出口 right → 落点 (-8,-3) = balancer#10035 的左半格本体。
     *     balancer 的输入槽在 (x,y+1) 的 bottom 方向 ⇒ 从 right 推来的货**它真的不收**。
     *     （证据：L5-items.json 里这条 path 的 `boundAcceptor` 是 **null**，不是 "yes"。）
     *
     *   10030@(-3,-3) r=90 rv=0 出口 right → 落点 (-2,-3) = B135@(-2,-3) r=180。
     *     带子 r=180 rv=0 的入口是 top、出口是 bottom ⇒ 从 right 推来的货它也**不收**。
     *     （同样：L5-items 里这条 path 的 boundAcceptor 也是 null。）
     *
     * 所以「正确的判据下不误报 balancer」这条**在 L4/L5 上不成立** —— 那一格 balancer
     * 确实接错了。我把这条测试改成钉住**真实结果**，而不是钉住任务书里那个对不上的数字。
     * 如果哪天发现 10024 真的是「可接受的」，那一定是判据或槽位几何变了，必须重新论证。 */
    const idx = indexOf(L4);
    const rejected = [];
    for (const e of idx.ent) {
        if (e.type !== "belt") continue;
        const a = accepts(idx, exitCellOf(e), exitDirOf(e));
        if (!a.ok && a.kind !== "empty") rejected.push([e.uid, a.kind, a.by]);
    }
    assert.deepEqual(rejected, [[10024, "balancer", 10035], [10030, "belt", 10074]]);

    /* 两条都在 L5 的 boundAcceptor 里是 null —— 外部真值佐证 */
    const l5idx = indexOf(L5);
    const bc = new Map();
    for (const p of L5_ITEMS.paths) bc.set(K(p.cells[p.cells.length - 1]), p.boundAcceptor);
    assert.equal(bc.get(K([-9, -3])), null, "10024 那条 path 的接收方是 null");
    assert.equal(bc.get(K([-3, -3])), null, "10030 那条 path 的接收方是 null");

    /* 反向对照：从 top 推进 balancer 的 primary 输口要收 */
    assert.equal(accepts(l5idx, [-8, -2], "top").ok, true);
});

test("★ 事实 3：accepts() 与游戏自己的 boundAcceptor 对拍（L5 全 20 条 path）", () => {
    /* 这是**独立验证**，不是自证：真值来自游戏运行时（`debug_items.paths[].boundAcceptor`）.
       2 条 path 落在 obs 覆盖区外（末格不在 entities[] 里），单独计为「观测缺口」。 */
    const idx = indexOf(L5);
    let agree = 0;
    const outsideObs = [];
    const mismatch = [];
    for (const p of L5_ITEMS.paths) {
        const last = p.cells[p.cells.length - 1];
        const e = at(idx, last);
        if (!e) { outsideObs.push(last); continue; }
        if (e.type !== "belt" && e.type !== "underground_belt") { outsideObs.push(last); continue; }
        const d = exitDirOf(e);
        const pred = accepts(idx, exitCellOf(e), d);
        const truth = p.boundAcceptor !== null;
        if (!!pred.ok === truth) agree++;
        else mismatch.push({ last, truth, pred });
    }
    assert.deepEqual(mismatch, [], "没有任何一条对不上");
    assert.equal(agree, 18, "18/20 一致；剩 2 条是 obs 区域外的 path");
    assert.equal(outsideObs.length, 2, "两条观测缺口（末格 (60,-44)/(61,-47)）");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. runEnd —— 穿过隧道，不在隧道里停
 * ══════════════════════════════════════════════════════════════════════════ */

test("★ T5：cutter#10036 的右口跑链终点是 trash（穿过 sender→receiver），不是 empty 也不是隧道", () => {
    const idx = indexOf(L4);
    const c = idx.byUid.get(10036);
    const s = slotsOf("cutter", "default", c.x, c.y, c.r || 0);
    const right = s.outputs.find(o => o.role === "right");
    const r = runEnd(idx, right.cell, right.dir);
    assert.equal(r.kind, "trash", `终点必须是 trash，实际 ${r.kind}#${r.by}`);
    assert.equal(r.by, 10037);
    assert.equal(r.accepted, true, "trash 什么都收");
    /* 跑链里必须出现 sender 与 receiver 两个 uid —— 证明是「穿过去」而不是「停在隧道口」 */
    assert.ok(r.belts.includes(10077), "跑链经过 sender 10077");
    assert.ok(r.belts.includes(10078), "跑链经过 receiver 10078");
    assert.equal(r.belts[r.belts.length - 1], 10078, "cutter 之后的第一段以 receiver 收尾");
});

test("T5：cutter 的左口跑链终点是 hub（L4）", () => {
    const idx = indexOf(L4);
    const c = idx.byUid.get(10036);
    const s = slotsOf("cutter", "default", c.x, c.y, c.r || 0);
    const left = s.outputs.find(o => o.role === "left");
    const r = runEnd(idx, left.cell, left.dir);
    assert.equal(r.kind, "hub");
    assert.equal(r.by, 10000);
    assert.equal(r.accepted, true);
});

test("runEnd：出口格为空 ⇒ kind=empty、accepted=false", () => {
    const idx = indexOf(L4);
    const b = idx.byUid.get(10008);
    const r = runEnd(idx, exitCellOf(b), exitDirOf(b));
    assert.equal(r.kind, "empty");
    assert.equal(r.accepted, false);
    assert.deepEqual(r.belts, []);
});

test("runEnd：截断保护（maxBelts 很小时 truncated=true，不挂死）", () => {
    const idx = indexOf(L4);
    const b = idx.byUid.get(10059);          // 18 格的竖直长链
    const r = runEnd(idx, [b.x, b.y], "bottom", { maxBelts: 3 });
    assert.equal(r.truncated, true);
    assert.equal(r.kind, "truncated");
    assert.equal(r.belts.length, 3);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 6. upstreamFed / sourceEntityOf
 * ══════════════════════════════════════════════════════════════════════════ */

test("upstreamFed：正常链上为 true；B136(-1,-3) 入口是空格为 false", () => {
    const idx = indexOf(L4);
    assert.equal(upstreamFed(idx, idx.byUid.get(10074)), true, "B135 的上游是 B134");
    assert.equal(upstreamFed(idx, idx.byUid.get(10032)), false, "B136 的入口 (-1,-3) 前一格 (0,-3) 是空格");
});

test("upstreamFed：上游是 meter 时按输出槽方向判（不是「有机器就算供」）", () => {
    const idx = indexOf(L4);
    /* B64@(5,-15) 的入口格是 (-1,-3) 的镜像情形之外的另一类：
       它的上游是 balancer#10085 的 secondary 输出（(5,-17) 朝 top）。
       balancer 的 secondary 输出接上了 → 判 true。 */
    assert.equal(upstreamFed(idx, idx.byUid.get(10151)), true);
    /* B82@(5,-13) 的上游是 B91@(5,-12)，也是 true */
    assert.equal(upstreamFed(idx, idx.byUid.get(10149)), true);
});

test("sourceEntityOf：x=5 支线的源头是矿机 10082（脚底无矿）", () => {
    const idx = indexOf(L4);
    const src = sourceEntityOf(idx, idx.byUid.get(10147));
    assert.equal(src.kind, "miner");
    assert.equal(src.entity.uid, 10082);
});

test("sourceEntityOf：B136 没有源头（none）", () => {
    const idx = indexOf(L4);
    const src = sourceEntityOf(idx, idx.byUid.get(10032));
    assert.equal(src.kind, "none");
    assert.equal(src.entity, null);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 7. hubReachable —— 搬家不能改语义
 * ══════════════════════════════════════════════════════════════════════════ */

/** 旧 `loop.mjs` 的实现（搬家前的逐字副本，只用于对拍）。 */
function legacyHubReachable(obs, idx) {
    const seen = new Set();
    const hub = idx.ent.find(e => e.type === "hub");
    if (!hub) return seen;
    seen.add(hub.uid);
    const q = [hub];
    while (q.length) {
        const e = q.shift();
        const s = slotsOf(e.type, e.variant, e.x, e.y, e.r || 0);
        if (!s) continue;
        for (const sl of s.inputs) {
            let cur = sl.cell;
            let guard = 0;
            let hit = null;
            const passed = [];
            while (guard++ < 512) {
                const c = idx.byCell.get(K(cur));
                if (!c) break;
                if (c.uid === e.uid) break;
                if (c.type === "belt") {
                    passed.push(c.uid);
                    const rv = typeof c.rotation_variant === "number" ? c.rotation_variant : (c.code - 1);
                    const d = beltEntry(rv, c.r || 0);
                    cur = [c.x + DIRV[d][0], c.y + DIRV[d][1]];
                    continue;
                }
                hit = c;
                break;
            }
            for (const u of passed) {
                if (!seen.has(u)) { seen.add(u); const b = idx.byUid.get(u); if (b) q.push(b); }
            }
            if (hit && !seen.has(hit.uid)) { seen.add(hit.uid); q.push(hit); }
        }
    }
    return seen;
}

for (const [name, obs] of [["L4", L4], ["L5", L5]]) {
    test(`hubReachable 与旧实现逐 uid 相同（${name}）`, () => {
        const idx = indexOf(obs);
        const a = [...hubReachable(obs, idx)].sort((x, y) => x - y);
        const b = [...legacyHubReachable(obs, idx)].sort((x, y) => x - y);
        assert.deepEqual(a, b);
        assert.equal(a.length, name === "L4" ? 152 : 146, "存档基线：L4 152 / L5 146");
    });
}

test("hubReachable：没有 hub 时返回空集（不抛）", () => {
    const obs = { entities: [{ uid: 1, type: "belt", x: 0, y: 0, r: 0, rotation_variant: 0, code: 1 }] };
    const s = hubReachable(obs);
    assert.equal(s.size, 0);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 8. indexOf / rvOf 的边界
 * ══════════════════════════════════════════════════════════════════════════ */

test("indexOf：接受整个 obs 返回体（{result:{entities}}）与裸 obs 两种形态", () => {
    const wrapped = { result: L4 };
    const a = indexOf(wrapped);
    const b = indexOf(L4);
    assert.equal(a.ent.length, b.ent.length);
    assert.equal(a.ent.length, 181);
});

test("indexOf：没有 uid 的实体被丢弃（不许产生 undefined 键）", () => {
    const idx = indexOf({ entities: [{ type: "belt", x: 0, y: 0 }, { uid: 5, type: "belt", x: 1, y: 1 }] });
    assert.equal(idx.ent.length, 1);
    assert.equal(idx.byCell.has(K([0, 0])), false);
});

test("rvOf：rotation_variant 缺失时回退 code-1", () => {
    assert.equal(rvOf({ type: "belt", code: 3 }), 2);
    assert.equal(rvOf({ type: "belt", code: 3, rotation_variant: 0 }), 0, "显式 0 优先");
});

test("entryCellOf / exitCellOf：对机器返回 null（它没有单一出入口）", () => {
    const idx = indexOf(L4);
    const hub = idx.ent.find(e => e.type === "hub");
    assert.equal(exitCellOf(hub), null);
    assert.equal(entryCellOf(hub), null);
    assert.equal(exitDirOf(hub), null);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 9. 确定性
 * ══════════════════════════════════════════════════════════════════════════ */

test("确定性：同一份 obs 建两次索引，逐 uid 与逐格完全一致", () => {
    const a = indexOf(L4);
    const b = indexOf(L4);
    assert.deepEqual([...a.byUid.keys()].sort((x, y) => x - y), [...b.byUid.keys()].sort((x, y) => x - y));
    assert.deepEqual([...a.byCell.keys()].sort(), [...b.byCell.keys()].sort());
});

test("确定性：runEnd 对同一条带子两次调用结果相同", () => {
    const idx = indexOf(L4);
    const b = idx.byUid.get(10059);
    const r1 = runEnd(idx, [b.x, b.y], "bottom");
    const r2 = runEnd(idx, [b.x, b.y], "bottom");
    assert.deepEqual(r1, r2);
});
