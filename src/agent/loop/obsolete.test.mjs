/**
 * `loop/obsolete.mjs` + 「目标变更检测」的纯函数测试。
 *
 * ## 这个文件守的是什么
 *
 * 用户贴图那次的直接成因：level 5（`Cu----Cu`）升到 level 6（`Cu------`）之后，
 * 旧产线没拆，变成 41% 到不了 hub 的死带子，模型还在修那条造着上一个 level 形状的线。
 *
 * 两条判据最容易做错：
 *   1. **残线不能靠带子拓扑认**：L4 与 L5 两张正常存档的死带子比例都是 14–17%，
 *      拿 `belts_dead` 当判据会把正常世界判成病态。
 *   2. **换关不能靠 level 认**：同一关的 `required` / `throughput_only` 也会变，
 *      只有 `requirement.shape` 变了才意味着「要造的东西换了」。
 *
 * 运行：`node --test src/agent/loop/obsolete.test.mjs`
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
    findObsoleteLines, findStoredObsolete, describeObsoleteLine, isSanctionedTeardown,
    OBSOLETE_MIN_SHARE, OBSOLETE_MIN_ITEMS,
} from "./obsolete.mjs";
import { detectGoalChange, worldUpdate, mergeMemory, loadMemory, MEMORY_VERSION } from "./memory.mjs";

const prod = (p, d = {}) => ({ produced_total: p, delivered_total: d, window_seconds: 60 });

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 残线：三条判据
 * ══════════════════════════════════════════════════════════════════════════ */

test("V1 ★ 典型残线：造的不是目标、一件没交付、量很大", () => {
    /* 这就是用户贴图那次的形态：产线在造 Cu----Cu，而目标是 Cu------。 */
    const out = findObsoleteLines(prod({ "Cu----Cu": 120, CuCuCuCu: 12 }, { CuCuCuCu: 12 }), "Cu------");
    assert.equal(out.length, 1);
    assert.equal(out[0].shape, "Cu----Cu");
    assert.equal(out[0].produced, 120);
    assert.equal(out[0].delivered, 0);
    assert.equal(out[0].ratio, 0, "交付率 0 = 全白干");
    assert.ok(out[0].share > 0.9);
});

test("V2 造的就是目标 ⇒ 不报", () => {
    assert.deepEqual(findObsoleteLines(prod({ "Cu----Cu": 120 }), "Cu----Cu"), []);
});

test("V3 ★ 有交付 ⇒ 不报（它还有用，哪怕造的不是目标）", () => {
    /* `CuCuCuCu` 常常是配方的中间产物，同时也会进 hub。
       只要它进了 hub 就可能有价值，不能当残线。 */
    assert.deepEqual(findObsoleteLines(prod({ "Cu----Cu": 120 }, { "Cu----Cu": 5 }), "Cu------"), []);
});

test("V4 量太小 ⇒ 不报（一两次调试残渣不是一条线）", () => {
    const tiny = OBSOLETE_MIN_ITEMS - 1;
    assert.deepEqual(findObsoleteLines(prod({ X: tiny }), "G", { minItems: OBSOLETE_MIN_ITEMS }), []);
});

test("V5 占比太小 ⇒ 不报", () => {
    /* 5% 是默认门槛：造 1000 个里面只有 20 个是别的形状，不值得单开一条诊断。 */
    const p = prod({ G: 1000, X: 20 });
    assert.deepEqual(findObsoleteLines(p, "G"), []);
    assert.equal(findObsoleteLines(p, "G", { minShare: 0.01 }).length, 1, "放宽门槛时应报出来");
});

test("V6 ★ 目标读不到 ⇒ 不报（「不知道」不等于「造错了」）", () => {
    /* 本项目的通用纪律：读不到就不判定。空 goal 时报"残线"会让第一次 run 就误伤。 */
    assert.deepEqual(findObsoleteLines(prod({ X: 500 }), ""), []);
    assert.deepEqual(findObsoleteLines(prod({ X: 500 }), null), []);
});

test("V7 production 缺失 / 空 ⇒ 不报，不抛", () => {
    for (const p of [null, undefined, {}, { produced_total: null }, { produced_total: {} }]) {
        assert.deepEqual(findObsoleteLines(p, "G"), []);
    }
});

test("V8 多个残线按产出量降序，最多报 maxReport 条", () => {
    const out = findObsoleteLines(prod({ A: 100, B: 300, C: 200 }), "G", { maxReport: 2 });
    assert.deepEqual(out.map(x => x.shape), ["B", "C"]);
});

test("V9 share 的分母是全部产出之和（全部造错时 share=1.0）", () => {
    const out = findObsoleteLines(prod({ X: 50, Y: 50 }), "G");
    assert.equal(out[0].share, 0.5);
    const all = findObsoleteLines(prod({ X: 500 }), "G");
    assert.equal(all[0].share, 1);
});

test("V10 负值 / 非数字的产出被忽略，不参与分母", () => {
    const out = findObsoleteLines({ produced_total: { X: 100, bad: -5, worse: "n/a" } }, "G");
    assert.equal(out.length, 1);
    assert.equal(out[0].share, 1, "坏的项不该进分母");
});

test("V11 describeObsoleteLine 说清三件事：什么形状、多少、交付了多少", () => {
    const line = { shape: "Cu----Cu", produced: 120, delivered: 0, share: 0.91, ratio: 0 };
    const s = describeObsoleteLine(line, "Cu------");
    assert.match(s, /Cu----Cu/);
    assert.match(s, /120/);
    assert.match(s, /91%/);
    assert.match(s, /0 of it ever reached the hub/);
    /* 不含坐标、不含 uid —— 与 prompt 的坐标系防火墙一致 */
    assert.ok(!/\b\d+,\s*-?\d+\b/.test(s));
    assert.ok(!/\buid\b/i.test(s));
});

test("V12 describeObsoleteLine 空输入返回空串（不抛）", () => {
    assert.equal(describeObsoleteLine(null, "G"), "");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 目标变更检测
 * ══════════════════════════════════════════════════════════════════════════ */

const memWith = (world, rec) => ({ version: MEMORY_VERSION, goals: {}, worlds: { [world]: rec } });

test("V13 ★ 第一次见到这个目标 ⇒ first_seen，不是 changed", () => {
    /* 把「第一次」误判成「变更」，会让首次 run 就被告知「去拆旧线」，
       而那时根本没有旧线。 */
    const r = detectGoalChange({ mem: { version: MEMORY_VERSION, goals: {}, worlds: {} }, world: "w1", goalShape: "Cu------" });
    assert.equal(r.changed, false);
    assert.equal(r.first_seen, true);
});

test("V14 ★ 形状变了 ⇒ changed，且带上 from / level", () => {
    const r = detectGoalChange({
        mem: memWith("w1", { last_goal: "Cu----Cu", last_level: 5 }),
        world: "w1", goalShape: "Cu------", level: 6,
    });
    assert.equal(r.changed, true);
    assert.equal(r.from, "Cu----Cu");
    assert.equal(r.to, "Cu------");
    assert.equal(r.level_from, 5);
    assert.equal(r.level_to, 6);
});

test("V15 形状没变 ⇒ 不 changed（哪怕 level 变了）", () => {
    const r = detectGoalChange({
        mem: memWith("w1", { last_goal: "Cu------", last_level: 5 }),
        world: "w1", goalShape: "Cu------", level: 6,
    });
    assert.equal(r.changed, false);
    assert.equal(r.first_seen, false);
});

test("V16 ★ 不同世界互不影响（同一个 goal 不该触发变更）", () => {
    const r = detectGoalChange({
        mem: memWith("w2", { last_goal: "Cu----Cu" }),
        world: "w1", goalShape: "Cu------",
    });
    assert.equal(r.changed, false);
    assert.equal(r.first_seen, true, "w1 没见过");
});

test("V17 形状相同但顺序不同算**不同**目标", () => {
    const r = detectGoalChange({
        mem: memWith("w1", { last_goal: "Cu----Cu" }),
        world: "w1", goalShape: "CuCu----",
    });
    assert.equal(r.changed, true, "Cu----Cu 与 CuCu---- 是两个目标");
});

test("V18 目标读不到 ⇒ 不判定，不抛", () => {
    for (const g of ["", null, undefined]) {
        const r = detectGoalChange({ mem: memWith("w1", { last_goal: "X" }), world: "w1", goalShape: g });
        assert.equal(r.changed, false);
    }
});

test("V19 worldUpdate 同时写 last_goal / last_level / last_seen", () => {
    const u = worldUpdate({ mem: null, world: "w1", goalShape: "Cu------", level: 6, now: "2026-11-04T00:00:00Z" });
    assert.equal(u.w1.last_goal, "Cu------");
    assert.equal(u.w1.last_level, 6);
    assert.equal(u.w1.last_seen, "2026-11-04T00:00:00Z");
    assert.equal(u.w1.previous_goal, undefined, "第一次没有 previous");
});

test("V20 worldUpdate 变更时保留 previous_goal（能回答「从哪来的」）", () => {
    const mem = memWith("w1", { last_goal: "Cu----Cu", last_level: 5 });
    const u = worldUpdate({ mem, world: "w1", goalShape: "Cu------", level: 6 });
    assert.equal(u.w1.last_goal, "Cu------");
    assert.equal(u.w1.previous_goal, "Cu----Cu");
});

test("V21 worldUpdate 目标为空 ⇒ 不动（不把 last_goal 写成空串）", () => {
    assert.deepEqual(worldUpdate({ mem: null, world: "w1", goalShape: "" }), {});
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. ★ worlds 必须活着穿过 load / merge —— 两个静默丢字段的真 bug
 * ══════════════════════════════════════════════════════════════════════════ */

test("V22 ★ mergeMemory 必须保留 worlds（否则换关检测下一轮就失效）", () => {
    /* 实测踩过：`return { version, goals }` 会把 worlds 静默丢掉，
       于是「跨 run 记住上次目标」这一轮刚写、下一轮就被自己的 merge 抹掉，
       而且**不报错**。 */
    const patch = { w1: { last_goal: "Cu------", last_level: 6 } };
    const m1 = mergeMemory(null, [], patch);
    assert.ok(m1.worlds.w1, "第一次 merge 就该有 worlds");
    const m2 = mergeMemory(m1, [], {});
    assert.equal(m2.worlds.w1.last_goal, "Cu------", "二次 merge 不许丢");
});

test("V23 ★ loadMemory 必须返回 worlds（否则读回来永远 undefined）", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "obs-")), "attempts.json");
    const mem = mergeMemory(null, [], { w1: { last_goal: "Cu------", last_level: 6, last_seen: "2026-11-04T00:00:00Z" } });
    fs.writeFileSync(f, JSON.stringify(mem), "utf8");
    const back = loadMemory(f);
    assert.ok(back.worlds && back.worlds.w1, `实得 ${JSON.stringify(back.worlds)}`);
    assert.equal(back.worlds.w1.last_goal, "Cu------");
});

test("V24 worlds 条目被清洗：坏的丢掉、超长截断、非数字 level 丢掉", () => {
    const bad = {
        version: MEMORY_VERSION, goals: {},
        worlds: {
            good: { last_goal: "Cu------", last_level: 6, last_seen: "t" },
            nullish: null,
            str: "not an object",
            emptyish: {},
            weird: { last_goal: "x".repeat(200), last_level: "six" },
        },
    };
    const m = mergeMemory(bad, [], {});
    assert.ok(m.worlds.good);
    assert.ok(!m.worlds.nullish && !m.worlds.str && !m.worlds.emptyish);
    assert.equal(m.worlds.weird.last_goal.length, 64, "超长目标名截断");
    assert.equal(m.worlds.weird.last_level, undefined, "非数字 level 丢掉");
});

test("V25 worlds 数量上限生效（不会无限增长）", () => {
    const patch = {};
    for (let i = 0; i < 20; i++) {
        patch[`w${i}`] = { last_goal: "G", last_seen: `2026-01-${String(i + 1).padStart(2, "0")}` };
    }
    const m = mergeMemory(null, [], patch);
    assert.ok(Object.keys(m.worlds).length <= 8, `实得 ${Object.keys(m.worlds).length} 个`);
});

test("V26 世界目标变更后，旧目标下的尝试记录**仍然保留**（不删历史）", async () => {
    const a = { goal: "Cu----Cu", world: "w1", macros: ["connect"], action_set: "as", kind: "reverted", why: [], ctx: null, ts: "2026-01-01" };
    let m = mergeMemory(null, [a]);
    m = mergeMemory(m, [], { w1: { last_goal: "Cu------" } });
    assert.equal(m.goals["Cu----Cu"].length, 1, "旧目标的经验要留着 —— 它可能再被切回来");
    assert.equal(m.worlds.w1.last_goal, "Cu------");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. ★ 累计账本证据（窗口法的死角）+ 授权拆除
 * ══════════════════════════════════════════════════════════════════════════ */

const recipeOf = steps => ({ ok: true, steps: steps.map(hash => ({ hash })) });

test("V27 ★ 链路：旧线停了（窗口空）⇒ 窗口法报不出，账本法能报", () => {
    /* 用户贴图那次的真实形态：0 条入口带子有货。produced_total 归零，
       `findObsoleteLines` 一条都不报 —— 而那恰恰是最需要诊断的时刻。
       账本（跨关不清零）是那时唯一的证据。 */
    const hub = { stored_shapes: { "RuRu----": 31204, CuCuCuCu: 46 } };
    const recipe = recipeOf(["CuCuCuCu", "----CuCu", "Cu----Cu"]);
    assert.deepEqual(findObsoleteLines({ produced_total: {} }, "Cu------"), [], "窗口法确实报不出");
    const st = findStoredObsolete({ hub, goalShape: "Cu------", recipe, levelChanged: true });
    assert.equal(st.length, 1);
    assert.equal(st[0].shape, "RuRu----");
    assert.equal(st[0].stored, 31204);
});

test("V28 ★ 账本法排除「当前配方的闭包」（中间产物不算旧目标）", () => {
    /* 实测夹具：L5 的 stored 里有 CuCuCuCu / ----CuCu / RuRuRuRu。
       前两个是**当前配方的中间产物**，每次挖矿都会进 hub；
       拿「stored 里有非目标形状」当判据会把任何正常存档判成残线。 */
    const hub = { stored_shapes: { CuCuCuCu: 46, "----CuCu": 87446, RuRuRuRu: 177830, "RuRu----": 31204 } };
    const recipe = recipeOf(["CuCuCuCu", "----CuCu", "Cu----Cu"]);
    const st = findStoredObsolete({ hub, goalShape: "Cu----Cu", recipe, levelChanged: true });
    assert.deepEqual(st.map(x => x.shape).sort(), ["RuRu----", "RuRuRuRu"],
        "只剩真正不属于当前配方闭包的那两个");
});

test("V29 账本法：没有 recipe 时只排除目标本身（更保守，会多报）", () => {
    const hub = { stored_shapes: { A: 100, B: 100 } };
    const st = findStoredObsolete({ hub, goalShape: "A", recipe: null, levelChanged: true });
    assert.deepEqual(st.map(x => x.shape), ["B"]);
});

test("V30 账本法：读不到 hub / 空 goal ⇒ 不报，不抛", () => {
    assert.deepEqual(findStoredObsolete({ hub: null, goalShape: "G" }), []);
    assert.deepEqual(findStoredObsolete({ hub: { stored_shapes: {} }, goalShape: "G" }), []);
    assert.deepEqual(findStoredObsolete({ hub: { stored_shapes: { X: 100 } }, goalShape: "" }), []);
});

test("V31 账本法：量太小不报；按存量降序", () => {
    const hub = { stored_shapes: { small: 3, big: 900, mid: 100 } };
    const st = findStoredObsolete({ hub, goalShape: "G", levelChanged: true }, { minItems: 10 });
    assert.deepEqual(st.map(x => x.shape), ["big", "mid"]);
});

test("V32 ★ isSanctionedTeardown：只删带子 + 有残线证据 ⇒ 是授权拆除", () => {
    const removes = [{ uid: 1, expect: { type: "belt" } }, { uid: 2, expect: { type: "underground_belt" } }];
    assert.equal(isSanctionedTeardown({ removes, obsoleteLines: [{ shape: "X" }], levelChanged: true }), true);
});

test("V33 isSanctionedTeardown：删了机器 ⇒ 不是（机器可能正在被复用）", () => {
    const removes = [{ uid: 1, expect: { type: "belt" } }, { uid: 2, expect: { type: "cutter" } }];
    assert.equal(isSanctionedTeardown({ removes, obsoleteLines: [{ shape: "X" }], levelChanged: true }), false);
});

test("V34 isSanctionedTeardown：没有残线证据 ⇒ 不是（普通施工不走这条豁免）", () => {
    assert.equal(isSanctionedTeardown({ removes: [{ uid: 1, expect: { type: "belt" } }], obsoleteLines: [], levelChanged: true }), false);
    assert.equal(isSanctionedTeardown({ removes: [{ uid: 1, expect: { type: "belt" } }], obsoleteLines: null, levelChanged: true }), false);
});

test("V35 isSanctionedTeardown：没有删除 ⇒ 不是", () => {
    assert.equal(isSanctionedTeardown({ removes: [], obsoleteLines: [{ shape: "X" }], levelChanged: true }), false);
    assert.equal(isSanctionedTeardown({ removes: null, obsoleteLines: [{ shape: "X" }], levelChanged: true }), false);
});

test("V36 isSanctionedTeardown：缺 expect.type 的保守处理（不豁免）", () => {
    assert.equal(isSanctionedTeardown({ removes: [{ uid: 1 }], obsoleteLines: [{ shape: "X" }], levelChanged: true }), false);
});

test("V37 describeObsoleteLine 支持账本条目（stored 而不是 produced）", () => {
    const s = describeObsoleteLine({ shape: "RuRu----", stored: 31204 }, "Cu------");
    assert.match(s, /31204/);
    assert.match(s, /RuRu----/);
    assert.match(s, /earlier goal/);
    assert.ok(!/\b\d+,\s*-?\d+\b/.test(s), "不许带坐标");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. ★ 没有换关 ⇒ 不存在残线（一条误报会废掉整个回滚机制）★
 * ══════════════════════════════════════════════════════════════════════════ */

test("V38 ★ 未换关时账本法一条都不报（即使 stored 里有非配方形状）", () => {
    /* L4 是**正常存档**，但 stored 里有 CuCuCuCu:46 / ----CuCu:47376 ——
       那是更早关卡的遗留物。不要求「确实换过关」就报，会让每个世界都有残线证据。 */
    const hub = { stored_shapes: { CuCuCuCu: 46, "----CuCu": 47376, RuRuRuRu: 112866 } };
    const recipe = recipeOf(["RuRuRuRu", "RuRu----"]);
    assert.deepEqual(findStoredObsolete({ hub, goalShape: "RuRu----", recipe }), [],
        "默认 levelChanged=false ⇒ 不报");
    const st = findStoredObsolete({ hub, goalShape: "RuRu----", recipe, levelChanged: true });
    assert.equal(st.length, 2, "显式换关后才报");
});

test("V39 ★ 授权拆除只认清单，不再要求本次 run 内换关（2026-11-10 推翻）", () => {
    /* 这条原来是「未换关时恒 false」。推翻它的理由是可测的：
     *
     * run 一开始就在第 9 关 ⇒ goalChanged 恒假 ⇒ 模型照 OBSOLETE_LINE 去拆旧线
     * ⇒ 判 regressive ⇒ 连撤两次。系统一边骂它不收拾残局，一边把它收拾的动作撤销掉。
     *
     * 真正该有门槛的是**产生清单**的那一步（findStoredObsolete 仍要求
     * levelChanged，V38 锁着它），而不是消费清单的这一边。 */
    assert.equal(isSanctionedTeardown({
        removes: [{ uid: 1, expect: { type: "belt" } }],
        obsoleteLines: [{ shape: "X" }],
    }), true, "清单非空 + 只拆带子 ⇒ 授权");

    assert.equal(isSanctionedTeardown({
        removes: [{ uid: 1, expect: { type: "belt" } }],
        obsoleteLines: [],
    }), false, "清单为空 ⇒ 不授权");

    assert.equal(isSanctionedTeardown({
        removes: [{ uid: 1 }, { uid: 2, expect: { type: "cutter" } }],
        obsoleteLines: [{ shape: "X" }],
    }), false, "拆了机器 ⇒ 不算拆残线");
});

test("V40 levelChanged 默认值的保守性（undefined / null 都不算换关）", () => {
    const hub = { stored_shapes: { X: 999 } };
    for (const v of [undefined, null, false, 0, "true"]) {
        assert.deepEqual(findStoredObsolete({ hub, goalShape: "G", levelChanged: v }), [],
            `levelChanged=${JSON.stringify(v)} 不该被当成 true`);
    }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 6. ★ 窗口法也必须排除配方闭包（真机实测抓到的误报）★
 * ══════════════════════════════════════════════════════════════════════════ */

test("V41 ★ 配方中间产物不算残线（真机 Cu------ 的 ----CuCu 误报）", () => {
    /* 真机数据（2026-11-09，目标 Cu------ / level 6）：
     *   produced_total = {----CuCu:25, CuCu----:25, Cu----Cu:25, CuCuCuCu:25}
     *   delivered_total = {Cu----Cu:25}
     *   Cu------ 的配方：CuCuCuCu ─mine→ ----CuCu ─cut→ Cu----Cu ─rotate→ Cu------ ─cut→
     *
     * `----CuCu` 是**必经的中间形态**，它「交付 0」是因为它压根不该交付。
     * 报成残线会让模型去拆一条正在正常工作的链。 */
    const prod = { produced_total: { "----CuCu": 25, "CuCu----": 25, "Cu----Cu": 25, CuCuCuCu: 25 }, delivered_total: { "Cu----Cu": 25 } };
    const recipe = { ok: true, steps: [{ hash: "CuCuCuCu" }, { hash: "----CuCu" }, { hash: "Cu----Cu" }, { hash: "Cu------" }] };

    const without = findObsoleteLines(prod, "Cu------");
    assert.equal(without.length, 2, `不传 recipe 时会误报两条，实得 ${JSON.stringify(without.map(x => x.shape))}`);

    const withR = findObsoleteLines(prod, "Cu------", { recipe });
    assert.equal(withR.length, 1, `传了 recipe 只该剩一条，实得 ${JSON.stringify(withR.map(x => x.shape))}`);
    assert.equal(withR[0].shape, "CuCu----", "剩下的必须是真不在闭包里的那个");
});

test("V42 recipe 缺失/不可用时退回旧行为（只排除目标本身）", () => {
    const prod = { produced_total: { G: 100, X: 100 } };
    assert.deepEqual(findObsoleteLines(prod, "G", { recipe: null }).map(x => x.shape), ["X"]);
    assert.deepEqual(findObsoleteLines(prod, "G", { recipe: { ok: false } }).map(x => x.shape), ["X"]);
    assert.deepEqual(findObsoleteLines(prod, "G", {}).map(x => x.shape), ["X"]);
});

test("V43 目标是配方的最后一步时也不会被当残线（闭包含目标）", () => {
    const prod = { produced_total: { "Cu------": 50, "CuCu----": 50 } };
    const recipe = { ok: true, steps: [{ hash: "CuCuCuCu" }, { hash: "Cu------" }] };
    assert.deepEqual(findObsoleteLines(prod, "Cu------", { recipe }).map(x => x.shape), ["CuCu----"]);
});
