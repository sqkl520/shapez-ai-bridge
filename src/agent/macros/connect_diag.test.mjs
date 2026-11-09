/**
 * connect_diag.test.mjs — `connect` 无解时**诊断文案**的回归测试（P5 / F8）。
 *
 * 运行：node --test src/agent/macros/connect_diag.test.mjs
 *
 * ## 这组测试锁的是什么事故
 *
 * 半成品世界里 `(1,-6) → hub` 的实机报错是：
 *
 *     occupied: 所有候选路径都被挡住；第一处冲突在 (-3,-8)（self-overlap）
 *     tried: 842
 *
 * 而独立实验证明这个场景**有解**：`allow_replace=true` 时 6 格就通了，只覆盖 1 格旧带
 * （uid=10537）。也就是说旧文案把「只要覆盖 1 格带子就能通」报成了「路径自己绕成环」，
 * 调用方（loop）拿到的信息既不是主因、也不指向任何可执行的动作。
 *
 * ## 根因（已在真实数据上验证，见 .tmpverify/p5-probe.mjs）
 *
 * `checkOccupancy` 里 `self-overlap` 的判定在 `belt` 之前，且**一旦命中就 return**。
 * 842 条候选的分布：
 *   撞既有带子（不自交）      686 条  → 1 格 473 / 2 格 207 / 3 格 6
 *   撞带子**且**自交          156 条  → 自交的候选**全部**同时撞带子
 *   纯自交                      0 条
 * 旧实现取 (y,x) 最小的那条 firstConflict，恰好落在自交的那 156 条里 ⇒ 误报。
 *
 * ## 夹具说明（为什么不直接读 probe-obs.json）
 *
 * `.tmpverify/final-half/probe-obs.json` 是**未跟踪**的临时产物（真实存档 181 实体）。
 * 测试不能依赖它存在。下面用最小合成世界复刻同一几何：一条 4 格竖直带 r=180
 * （uid 10536..10538，出口朝 +y），真实出口格 `(1,-5)` 上躺着一条**既有带子** ——
 * 正是「出口那格有旧带」这个形态。实测该夹具（修正后）报 `tried=1354 / minReplace=1`，
 * 与真实存档的结论（撞带子、最少覆盖 1 格）逐条一致，只是候选条数不同。
 * 真实存档那组数字由 `.tmpverify/p5-probe.mjs` 记录，不放进测试。
 *
 * ⚠️ 2026-11-01：旧夹具把挡路带子放在 `(1,-7)` 并称其为「出口正对的那格」。
 * 那其实是 `portsOf` 把带子出口算错的 bug（r=180 的真实出口是 `(1,-5)`，`(1,-7)` 是上游）。
 * `ports_belt_rot` 修好之后这组用例的前提消失（connect 直接零覆盖成功），
 * 所以把挡路带子挪到了真实出口格 `(1,-5)`；要锁的诊断判据一条没变。
 */
import assert from "node:assert/strict";

import { connect } from "./connect.mjs";

/* ── 小夹具 ── */
/* ⚠️ 2026-11-01 夹具修正（ports_belt_rot 修复的连带）：
   旧夹具把挡路带子放在 `(1,-7)`，注释写的是「出口正对的那格」——
   那**正是 `portsOf` 把带子出口算错的 bug 本身**：r=180/rv=0 的带子真实出口是
   bottom → `(1,-5)`，`(1,-7)` 是它**上游**那一格。
   修好 `portsOf` 之后，从 `(1,-6)` 出发会直接走 `(1,-5)/(1,-4)/(1,-3)`，
   根本碰不到 `(1,-7)`，于是这组用例的前提不成立（connect 直接 ok）。
   现在把挡路带子放到**真实**出口格 `(1,-5)` 上（r=0 直带，横着躺在那格），
   要锁的诊断判据（撞带子 / 不误报 self-overlap / minReplace / allow_replace 回滚）
   一条都没变，只是几何校准到了正确的位置。
   真实存档里 `(1,-5)` 本来是空的 —— 这正是修复的意义：半成品世界的断点现在零覆盖就能通。 */
const belt = (uid, x, y, r) => ({ uid, type: "belt", x, y, r: r === undefined ? 180 : r, rotation_variant: 0, code: 1, layer: "regular" });
const hub = (uid, x, y) => ({ uid, type: "hub", x, y, r: 0, layer: "regular" });

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log("ok   " + name); }
    catch (e) { fail++; console.log("FAIL " + name + "\n     " + (e && e.message ? e.message : e)); }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 真实场景复刻：出口那格被旧带占住
 * ══════════════════════════════════════════════════════════════════════════ */

t("真实场景：撞旧带子时 firstConflict 必须指向带子，不得报 self-overlap", () => {
    const ents = [
        belt(10536, 1, -5, 0),        // ★ 出口正对的那格：既有带子
        belt(10538, 1, -6),        // 断点（from）
        hub(10000, -2, -2),
    ];
    const r = connect({ from: { uid: 10538 }, to: { hub: { uid: 10000 } }, opts: { auto_relax: false } }, { entities: ents });

    assert.equal(r.ok, false, "这组几何在没有 allow_replace 时必须失败");
    assert.equal(r.error.code, "occupied");
    assert.ok(r.firstConflict, "firstConflict 必须非空");
    assert.notEqual(r.firstConflict.what, "self-overlap",
        `撞的是旧带子，不是自交；实得 ${JSON.stringify(r.firstConflict)}`);
    assert.equal(r.firstConflict.what, "belt",
        `firstConflict.what 必须是 belt；实得 ${r.firstConflict.what}`);
    assert.equal(r.firstConflict.uid, 10536,
        `firstConflict 必须指那条真挡路的带子（uid=10536）；实得 uid=${r.firstConflict.uid}`);
});

t("真实场景：message 必须说清「撞带子」并且给出「最少覆盖几格」这个可执行结论", () => {
    const ents = [belt(10536, 1, -5, 0), belt(10538, 1, -6), hub(10000, -2, -2)];
    const r = connect({ from: { uid: 10538 }, to: { hub: { uid: 10000 } }, opts: { auto_relax: false } }, { entities: ents });

    assert.match(r.error.message, /撞既有带子/, `message 必须点名「撞既有带子」，实得：${r.error.message}`);
    assert.match(r.error.message, /\d+ 条/, "message 必须给出条数（聚合，不是只报一条）");
    assert.doesNotMatch(r.error.message, /第一处冲突在 .*（self-overlap）/, "不得再出现旧文案");
    assert.match(r.error.hint, /allow_replace/, "hint 必须指出 allow_replace 这条路");
    assert.match(r.error.hint, /最少 1 格/, `hint 必须给出最少覆盖格数，实得：${r.error.hint}`);
});

t("聚合口径：detail.breakdown 把「撞带子」与「自交」分开计数，且 sum === tried", () => {
    const ents = [belt(10536, 1, -5, 0), belt(10538, 1, -6), hub(10000, -2, -2)];
    const r = connect({ from: { uid: 10538 }, to: { hub: { uid: 10000 } }, opts: { auto_relax: false } }, { entities: ents });
    const d = r.error.detail;
    const b = d.breakdown;

    assert.ok(b, "detail.breakdown 必须存在");
    assert.ok(b.beltOnly > 0, "这组夹具至少有撞带子的候选");
    assert.equal(b.beltOnly + b.beltAndSelf + b.selfOnly, b.total,
        `三个分类必须覆盖全部候选：${b.beltOnly}+${b.beltAndSelf}+${b.selfOnly} != ${b.total}`);
    assert.equal(b.total, d.tried, "breakdown.total 必须等于 detail.tried");
    assert.equal(b.minReplace, 1, `覆盖代价最小的那条只需 1 格，实得 ${b.minReplace}`);
    assert.ok(b.beltHist && b.beltHist["1"] > 0, "直方图里必须有「1 格」这一档");
    assert.equal(b.selfOnly, 0,
        "本夹具的自交候选**全部**同时撞带子（这正是旧文案误报的机制）—— selfOnly 应为 0");
});

t("正例对照：同几何 + allow_replace ⇒ 必须能通，且只覆盖 1 格", () => {
    const ents = [belt(10536, 1, -5, 0), belt(10538, 1, -6), hub(10000, -2, -2)];
    const r = connect({ from: { uid: 10538 }, to: { hub: { uid: 10000 } }, opts: { allow_replace: true } }, { entities: ents });

    assert.ok(r.ok, `allow_replace=true 时必须能连上，实得 ${JSON.stringify(r.error)}`);
    const w = r.warnings.find(x => x.code === "replacing-belts");
    assert.ok(w, "必须给出 replacing-belts 警告");
    assert.match(w.detail, /1 格/, `应报出覆盖 1 格旧带，实得：${w.detail}`);
    const onBelt = r.cells.filter(c => c.x === 1 && c.y === -5);
    assert.equal(onBelt.length, 1, "选中的路径必须真的经过那格旧带");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 「撞机器」与「撞带子」必须能区分（两者修法不同）
 * ══════════════════════════════════════════════════════════════════════════ */

t("撞机器：firstConflict.what 是机器类型（不是 belt），hint 不得再推销 allow_replace", () => {
    const ents = [
        { uid: 1, type: "miner", x: 0, y: 8, r: 0 },
        { uid: 2, type: "cutter", x: 0, y: 0, r: 0 },
        { uid: 3, type: "balancer", x: 0, y: 4, r: 0 },
    ];
    const r = connect({ from: { uid: 1 }, to: { uid: 2, port: "primary" } }, { entities: ents });
    if (r.ok) {
        // 允许绕行成功；那就不该有 occupied 诊断可断言
        assert.ok(!r.cells.some(c => c.y === 4 && (c.x === 0 || c.x === 1)), "不得踩 balancer footprint");
        return;
    }
    assert.equal(r.error.code, "occupied");
    assert.equal(r.firstConflict.what, "balancer", `撞的是机器，实得 ${r.firstConflict.what}`);
    assert.equal(r.firstConflict.uid, 3);
    const b = r.error.detail.breakdown;
    assert.equal(b.beltOnly, 0, "本夹具没有既有带子，beltOnly 必须是 0");
    assert.match(r.error.hint, /机器/, `hint 必须点明机器不可覆盖，实得：${r.error.hint}`);
    assert.doesNotMatch(r.error.hint, /传 opts\.allow_replace=true 即可/,
        "撞机器时不得暗示 allow_replace 能解决");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 反例：真的自环的路径仍要被识别（不能把自交当正常）
 * ══════════════════════════════════════════════════════════════════════════ */

t("纯自交（世界里没有任何带子）：必须仍然 occupied + what=self-overlap", () => {
    /* 这三个夹具来自 connect.test.mjs「占用检查·自重叠」那一组：
       端点贴得极近、绕行空间被自己封死，只剩自己折回来的走法。
       世界里只有 miner + trash，**一格带子都没有** —— 所以自交是唯一的原因。 */
    const cases = [
        { name: "miner(-3,-3) → trash(-4,-4) primary#1", m: [-3, -3], t: [-4, -4], port: { role: "primary", index: 1 } },
        { name: "miner(-3,-3) → trash(-2,-4) primary#3", m: [-3, -3], t: [-2, -4], port: { role: "primary", index: 3 } },
        { name: "miner(-3,-2) → trash(-4,-3) primary#1", m: [-3, -2], t: [-4, -3], port: { role: "primary", index: 1 } },
    ];
    for (const c of cases) {
        const ents = [
            { uid: 1, type: "miner", x: c.m[0], y: c.m[1], r: 0 },
            { uid: 2, type: "trash", x: c.t[0], y: c.t[1], r: 0 },
        ];
        const r = connect({ from: { uid: 1 }, to: { uid: 2, port: c.port } }, { entities: ents });
        assert.equal(r.ok, false, `${c.name}：自交路径必须被拒 —— 自交不是「另一种可接受的路」`);
        assert.equal(r.error.code, "occupied", `${c.name}：错误码必须是 occupied`);
        assert.equal(r.firstConflict.what, "self-overlap",
            `${c.name}：世界里一格带子都没有，冲突只能是自交；实得 ${r.firstConflict.what}`);
        assert.equal(r.error.detail.breakdown.beltOnly, 0,
            `${c.name}：没有带子挡路，beltOnly 必须是 0`);
        assert.ok(r.error.detail.breakdown.selfOnly > 0,
            `${c.name}：selfOnly 必须 > 0`);
        assert.match(r.error.hint, /allow_replace 帮不上/,
            `${c.name}：纯自交时 hint 必须明说 allow_replace 没用，实得：${r.error.hint}`);
        assert.equal(r.cells, null, `${c.name}：拒绝时不得带回路径（自交的 cells 不许漏出去）`);
    }
});

t("自交与撞带子同时存在时，两者都要被记下来（不是二选一）", () => {
    /* 夹具同第 1 组：那 156 条候选既自交又撞带子。判据：
       breakdown 里 beltAndSelf > 0 —— 旧实现遇到自交就 return，这个数根本统计不出来。 */
    const ents = [belt(10536, 1, -5, 0), belt(10538, 1, -6), hub(10000, -2, -2)];
    const r = connect({ from: { uid: 10538 }, to: { hub: { uid: 10000 } }, opts: { auto_relax: false } }, { entities: ents });
    const b = r.error.detail.breakdown;
    assert.ok(b.beltAndSelf > 0,
        `必须能统计出「既自交又撞带子」的候选；实得 beltAndSelf=${b.beltAndSelf}`);
});

t("成功返回的路径仍然不得有重复格（自交判据没被放宽）", () => {
    const ents = [belt(10536, 1, -5, 0), belt(10538, 1, -6), hub(10000, -2, -2)];
    const r = connect({ from: { uid: 10538 }, to: { hub: { uid: 10000 } }, opts: { allow_replace: true } }, { entities: ents });
    assert.ok(r.ok, JSON.stringify(r.error));
    const seen = new Set();
    for (const c of r.cells) {
        const k = `${c.x},${c.y}`;
        assert.ok(!seen.has(k), `成功路径不得有重复格（${k}）—— 自交判据被放宽了`);
        seen.add(k);
    }
});


/* ══════════════════════════════════════════════════════════════════════════
 * ★ 2026-11-04 两个新能力：自动放宽 + 覆盖后果 ★
 * ══════════════════════════════════════════════════════════════════════════ */

const beltOf = (uid, x, y, r = 90) => ({ uid, type: 'belt', variant: 'default', x, y, r, rotation_variant: 0, code: 1 });
const cutterOf = (uid, x, y) => ({ uid, type: 'cutter', variant: 'default', x, y, r: 0, rotation_variant: 0, code: 5 });

t('自动放宽：被既有带子全挡住时，宏自己用 allow_replace 重试并成功', () => {
    /* 实测（.tmpverify/connect/）：654 条候选全被挡，其中只差 1-2 格。
       改前只把这句话写进 hint，等模型下一轮再调；改后宏自己试一次。 */
    const ents = [cutterOf(1, 0, 0), cutterOf(2, 12, 0)];
    for (let y = -6; y <= 6; y++) ents.push(beltOf(1000 + y + 10, 6, y));   // 密不透风的墙
    const r = connect({ from: { uid: 1, port: 'left' }, to: { uid: 2 } }, { entities: ents });
    assert.equal(r.ok, true, '应当自动放宽并成功，实得 ' + JSON.stringify(r.error));
    assert.ok(r.auto_relaxed, '必须给 auto_relaxed（机器可读的留痕）');
    assert.equal(r.auto_relaxed.allow_replace, true);
    assert.equal(r.auto_relaxed.reason, 'all-candidates-blocked-by-belts');
    assert.ok(r.auto_relaxed.tried > 0, '必须报有多少条候选全被挡住');
    assert.ok(r.auto_relaxed.min_replace >= 1, '必须报最少要覆盖几格');
    assert.ok(r.warnings.some(w => w.code === 'hub-entry-chosen'), '必须有人读的留痕');
    assert.ok(r.changed.removed_uids.length >= 1, '必须报出覆盖了哪些 uid（规范通道）');
});

t('自动放宽：被**机器**挡住时不放宽（机器永不可覆盖）', () => {
    const ents = [cutterOf(1, 0, 0), cutterOf(2, 12, 0), cutterOf(99, 6, 0)];
    for (let y = -6; y <= 6; y++) if (y !== 0) ents.push(cutterOf(1000 + y + 10, 6, y));
    const r = connect({ from: { uid: 1, port: 'left' }, to: { uid: 2 } }, { entities: ents });
    assert.equal(r.ok, false, '机器挡路时必须失败');
    assert.equal(r.error.code, 'occupied');
    assert.equal(r.auto_relaxed, undefined, '机器不可覆盖 ⇒ 不该自动放宽');
});

t('覆盖后果：被覆盖的带子原本在给下游供料 ⇒ 必须报 replace-would-disconnect', () => {
    /* 路径会覆盖 uid=2@(5,4)，而它朝下供着 uid=3@(5,5)。 */
    const ents = [cutterOf(10, 0, 3), cutterOf(11, 12, 3),
                  beltOf(1, 5, 3, 180), beltOf(2, 5, 4, 180), beltOf(3, 5, 5, 180)];
    const r = connect({ from: { uid: 10, port: 'left' }, to: { uid: 11 }, opts: { allow_replace: true } }, { entities: ents });
    assert.equal(r.ok, true);
    assert.ok(r.consequences, '覆盖了带子就必须给 consequences');
    assert.ok(r.consequences.replaced_uids.includes(2));
    const disc = r.consequences.would_disconnect;
    assert.equal(disc.length, 1, '必须报出 1 处切断，实得 ' + JSON.stringify(disc));
    assert.equal(disc[0].kind, 'starved-belt');
    assert.equal(disc[0].uid, 3);
    assert.deepEqual(disc[0].cell, [5, 5], '坐标必须是真的（不是 null,null）');
    assert.ok(r.warnings.some(w => w.code === 'replace-would-disconnect'));
});

t('覆盖后果：下游也被一起覆盖 ⇒ 不算切断（一起拆不是饿死）', () => {
    const ents = [cutterOf(10, 0, 3), cutterOf(11, 12, 3),
                  beltOf(1, 5, 3, 180), beltOf(2, 5, 4, 180)];
    const r = connect({ from: { uid: 10, port: 'left' }, to: { uid: 11 }, opts: { allow_replace: true } }, { entities: ents });
    assert.equal(r.ok, true);
    assert.deepEqual(r.consequences.would_disconnect, [], '两条都被覆盖 ⇒ 没有谁被饿死');
});

t('覆盖后果：没覆盖任何带子 ⇒ 不给 consequences 字段', () => {
    const ents = [cutterOf(1, 0, 0), cutterOf(2, 12, 0)];
    const r = connect({ from: { uid: 1, port: 'left' }, to: { uid: 2 } }, { entities: ents });
    assert.equal(r.ok, true);
    assert.equal(r.consequences, undefined);
    assert.deepEqual(r.changed.removed_uids, [], '没覆盖就不该报销毁');
});

/* ── 汇总 ── */
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
