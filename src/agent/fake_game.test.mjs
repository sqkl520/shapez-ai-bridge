/**
 * fake_game.test.mjs — 假游戏自己的自测。
 *
 * 为什么假游戏要有测试：它是**所有离线 loop 测试的地基**。地基错了，上面每一层
 * 都会给出"看起来合理"的错误结论。这个仓库已经因为"测试自己没被执行 / 断言恒真"
 * 吃过四次亏（见 gates.mjs 文件头），所以地基必须先钉死。
 *
 * 重点钉三件事：
 *   ① 它读出来的东西与真实 dump 一致（实体数、goal、paths 数）
 *   ② 它的 region/max_entities 过滤与截断标志，和 mod 的语义一致
 *   ③ 它的 apply 只做它声称做的（delete/place），**不假装**做了别的
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import FakeGame from "./fake_game.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
    try { await fn(); pass++; console.log("✓ " + name); }
    catch (e) { fail++; failures.push(name + " → " + (e && e.message || e)); console.log("✗ " + name + " → " + (e && e.message || e)); }
}
async function check(name, fn) {
    const run = (async () => { try { await fn(); pass++; console.log("PASS " + name); }
        catch (e) { fail++; failures.push(name + " → " + (e && e.message || e)); console.log("FAIL " + name + " → " + (e && e.message || e)); } })();
    const handle = { name };
    unconsumed.add(handle);
    return {
        then(f, r) { unconsumed.delete(handle); return run.then(f, r); },
        catch(r) { unconsumed.delete(handle); return run.catch(r); },
        finally(f) { unconsumed.delete(handle); return run.finally(f); },
    };
}
/** 防止「写了 test 却忘了 await」——本仓库已经犯过 4 次。 */
const unconsumed = new Set();

/* ─────────────────── ① 夹具一致性 ─────────────────── */

await t("夹具存在且是真实 dump（不是造的）", () => {
    const l4 = JSON.parse(fs.readFileSync(path.join(HERE, "../../test/fixtures/saves/L4-obs.json"), "utf8"));
    const l5 = JSON.parse(fs.readFileSync(path.join(HERE, "../../test/fixtures/saves/L5-obs.json"), "utf8"));
    const items = JSON.parse(fs.readFileSync(path.join(HERE, "../../test/fixtures/saves/L5-items.json"), "utf8"));
    const a = l4.result || l4, b = l5.result || l5, it = items.result || items;
    /* ★ 两张存档必须能区分 ★
       曾经把 L5 的 dump 复制成 L4-obs.json，于是「L4 冷启动测试」实际跑的是 L5，
       goal 与布局全不同 —— 这是最隐蔽的一类假绿。 */
    assert.equal(a.goal.requirement.shape, "RuRu----", "L4 的目标是 RuRu----");
    assert.equal(a.goal.level, 4);
    assert.equal(b.goal.requirement.shape, "Cu----Cu", "L5 的目标是 Cu----Cu");
    assert.equal(b.goal.level, 5);
    assert.notEqual(a.goal.requirement.shape, b.goal.requirement.shape, "两张夹具的目标相同 —— 大概率是同一个 dump 被复制了两份");
    assert.equal(a.entities.length, 181);
    assert.equal(b.entities.length, 181);
    assert.equal(it.paths.length, 20);
});

await t("L4 冷启动态：(4,-13)(5,-13)(4,-14) 全是带子（未改造）", () => {
    const g = FakeGame.fromFiles(path.join(HERE, "../../test/fixtures/saves/L4-obs.json"), null, { goal: "RuRu----" });
    const at = (x, y) => g.obs.entities.find(e => e.x === x && e.y === y);
    for (const [x, y] of [[4, -13], [5, -13], [4, -14]]) {
        const e = at(x, y);
        assert.ok(e, `(${x},${y}) 应有实体`);
        assert.equal(e.type, "belt", `(${x},${y}) 在 L4 冷启动态必须是带子，实得 ${e.type}`);
        assert.equal(e.uid, { "4,-13": 10209, "5,-13": 10149, "4,-14": 10143 }[`${x},${y}`]);
    }
});

await t("L5 改造后：(4,-13) 是 cutter、(4,-14) 是 trash", () => {
    const g = FakeGame.fromFiles(path.join(HERE, "../../test/fixtures/saves/L5-obs.json"),
        path.join(HERE, "../../test/fixtures/saves/L5-items.json"), { goal: "Cu----Cu" });
    const at = (x, y) => g.obs.entities.find(e => e.x === x && e.y === y);
    assert.equal(at(4, -13).type, "cutter");
    assert.equal(at(4, -14).type, "trash");
});

await t("assertGoal：拿错存档必须抛（静默换关防线）", () => {
    const g5 = FakeGame.fromFiles(path.join(HERE, "../../test/fixtures/saves/L5-obs.json"), null);
    assert.throws(() => g5.assertGoal("RuRu----"), /夹具目标不符/, "拿 L5 存档当 L4 用却没报错");
    assert.throws(() => FakeGame.fromFiles(path.join(HERE, "../../test/fixtures/saves/L5-obs.json"), null, { goal: "RuRu----" }),
        /夹具目标不符/, "fromFiles 的 goal 选项没有生效");
    // 对的存档不抛
    const g4 = FakeGame.fromFiles(path.join(HERE, "../../test/fixtures/saves/L4-obs.json"), null, { goal: "RuRu----" });
    assert.equal(g4.goal.requirement.shape, "RuRu----");
});

await t("fromFiles 默认夹具可读，且不带 goal 断言时不抛", () => {
    const g = FakeGame.fromFiles();
    assert.equal(g.entityCount, 181);
    assert.equal(g.debugItems().pathCount, 20);
});

/* ─────────────────── ② 读取面语义与 mod 一致 ─────────────────── */

await t("region 过滤：只返回框内实体", () => {
    const g = FakeGame.fromFiles();
    const o = g.observe({ region: [-10, -5, 0, 5] });
    assert.ok(o.entities.length > 0);
    assert.ok(o.entities.every(e => e.x >= -10 && e.x <= 0 && e.y >= -5 && e.y <= 5),
        "框外实体漏进来了：" + JSON.stringify(o.entities.filter(e => e.x < -10 || e.x > 0 || e.y < -5 || e.y > 5).slice(0, 3)));
});

await t("entity_count 是 region 过滤**后**的数量（与 mod 一致）", () => {
    const g = FakeGame.fromFiles();
    const all = g.observe({});
    assert.equal(all.entity_count, 181, "不带 region 时 entity_count = 全量");
    const sub = g.observe({ region: [-10, -5, 0, 5] });
    assert.ok(sub.entities.length < 181);
    assert.equal(sub.entity_count, sub.entities.length,
        "带 region 时 entity_count 必须等于过滤后的数量（mod 的 list.length 语义）");
    assert.equal(sub.stats.total, 181, "stats.total 才是全量（mod 用 all.length）");
});

await t("max_entities 触发 truncated 标志", () => {
    const g = FakeGame.fromFiles();
    const o = g.observe({ max_entities: 10 });
    assert.equal(o.entities.length, 10);
    assert.equal(o.truncated, true, "截断了却没报 truncated —— verify 的 L0 会漏判");
    assert.equal(o.entity_count, 181, "不带 region 时 entity_count 全量");
    assert.equal(o.stats.total, 181);
});

await t("region + max_entities 同时给：entity_count 是 region 后、truncated 看 max", () => {
    const g = FakeGame.fromFiles();
    const o = g.observe({ region: [-10, -5, 0, 5], max_entities: 2 });
    assert.ok(o.entity_count > 2, "entity_count 应是 region 内的总数");
    assert.equal(o.entities.length, 2);
    assert.equal(o.truncated, true);
});

await t("不截断时不报 truncated", () => {
    const g = FakeGame.fromFiles();
    assert.equal(g.observe({ max_entities: 50000 }).truncated, false);
});

await t("stats.by_type 按 type 聚合，与实体表一致", () => {
    const g = FakeGame.fromFiles();
    const o = g.observe({});
    const sum = Object.values(o.stats.by_type).reduce((a, b) => a + b, 0);
    assert.equal(sum, o.entities.length);
    assert.equal(o.stats.by_type.belt, o.entities.filter(e => e.type === "belt").length);
    assert.equal(o.stats.total, o.entities.length);
});

await t("debug_items：pathCount 等于实际返回的 paths 数", () => {
    const g = FakeGame.fromFiles();
    const it = g.debugItems();
    assert.equal(it.pathCount, it.paths.length);
    assert.equal(it.paths.length, 20);
});

await t("debug_items：region 过滤按「整条 path 有交集」", () => {
    const g = FakeGame.fromFiles();
    const it = g.debugItems({ region: [4, -16, 6, -13] });
    assert.ok(it.paths.length > 0 && it.paths.length < 20, "region 过滤没生效：" + it.paths.length);
    for (const p of it.paths) {
        assert.ok(p.cells.some(([x, y]) => x >= 4 && x <= 6 && y >= -16 && y <= -13), "返回了与 region 无交集的 path");
    }
});

await t("production 形状与 verify 的消费口径一致", () => {
    const g = FakeGame.fromFiles();
    const p = g.observeProduction();
    assert.ok("produced_total" in p);
    assert.ok("produced_per_sec" in p);
    assert.equal(typeof p.window_seconds, "number");
});

await t("step 推进 tick 并返回同一个 tick", () => {
    const g = FakeGame.fromFiles();
    const t0 = g.tick;
    const r = g.step(2400);
    assert.equal(r.advanced, 2400);
    assert.equal(g.tick, t0 + 2400);
    assert.equal(g.observe({}).tick, t0 + 2400, "observe 必须反映 step 后的 tick");
});

await t("每次读取都记进 calls（供 transcript 对账）", () => {
    const g = FakeGame.fromFiles();
    g.observe({}); g.debugItems(); g.observeProduction(); g.step(10);
    assert.deepEqual(g.calls.map(c => c.method), ["obs", "debug_items", "production", "step"]);
});

/* ─────────────────── ③ apply 只做它声称做的 ─────────────────── */

await t("apply delete：按 uid 删，removed 报对", () => {
    const g = FakeGame.fromFiles();
    const uid = g.obs.entities.find(e => e.type === "belt").uid;
    const r = g.apply([{ op: "delete", uid }]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.removed, [uid]);
    assert.equal(g.entityCount, 180);
    assert.equal(g.obs.entities.find(e => e.uid === uid), undefined);
});

await t("apply delete：删不存在的 uid 是幂等成功（与真 tx 一致）", () => {
    const g = FakeGame.fromFiles();
    const r = g.apply([{ op: "delete", uid: 999999 }]);
    assert.equal(r.ok, true);
    assert.equal(r.applied, 1);
    assert.equal(g.entityCount, 181);
});

await t("apply place：新 uid 不与既有冲突", () => {
    const g = FakeGame.fromFiles();
    const maxUid = Math.max(...g.obs.entities.map(e => e.uid));
    const r = g.apply([{ op: "place", building: "belt", x: 50, y: 50, r: 0, rotationVariant: 2 }]);
    assert.equal(r.ok, true);
    assert.ok(r.added[0] > maxUid, `新 uid ${r.added[0]} 应大于既有最大 ${maxUid}（否则并发时会撞）`);
    const e = g.obs.entities.find(x => x.uid === r.added[0]);
    assert.equal(e.type, "belt");
    assert.equal(e.rotation_variant, 2);
});

await t("apply place：rv 两种写法都认", () => {
    const g = FakeGame.fromFiles();
    const r1 = g.apply([{ op: "place", building: "belt", x: 51, y: 51, rotationVariant: 1 }]);
    const r2 = g.apply([{ op: "place", building: "belt", x: 52, y: 52, rv: 2 }]);
    assert.equal(g.obs.entities.find(e => e.uid === r1.added[0]).rotation_variant, 1);
    assert.equal(g.obs.entities.find(e => e.uid === r2.added[0]).rotation_variant, 2);
});

await t("apply 不认识的 op → ok:false（绝不静默忽略）", () => {
    const g = FakeGame.fromFiles();
    const r = g.apply([{ op: "paste_blueprint", blueprint: "xxx" }]);
    assert.equal(r.ok, false, "不认识的 op 被当成成功了 —— 这正是假绿的形态");
    assert.ok(r.failures.length > 0);
});

await t("apply 后 entity_count 跟着更新", () => {
    const g = FakeGame.fromFiles();
    g.apply([{ op: "place", building: "belt", x: 60, y: 60 }]);
    assert.equal(g.obs.entity_count, 182);
    assert.equal(g.observe({}).entity_count, 182);
});

/* ─────────────────── ④ 诚实边界 ─────────────────── */

await t("clone() 是深拷贝：改副本不影响原件", () => {
    const g = FakeGame.fromFiles();
    const c = g.clone();
    c.apply([{ op: "delete", uid: g.obs.entities[0].uid }]);
    assert.equal(c.entityCount, 180);
    assert.equal(g.entityCount, 181, "clone 不是深拷贝 —— 用例会互相污染");
});

await t("setDelivered 同时更新 goal 和 production", () => {
    const g = FakeGame.fromFiles();
    g.setDelivered("Cu----Cu", 170);
    assert.equal(g.goal.requirement.delivered, 170);
    assert.equal(g.goal.requirement.progress, 1);
    assert.equal(g.observeProduction().produced_total["Cu----Cu"], 170);
});

await t("reader() 返回的四个方法都能直接喂 verifyRuntime", async () => {
    const g = FakeGame.fromFiles();
    const r = g.reader();
    for (const k of ["obs", "debugItems", "production", "step"]) {
        assert.equal(typeof r[k], "function", `reader 缺 ${k}`);
        await r[k](k === "step" ? 1 : {});
    }
});

/* ─────────────────── ⑤ 与 verifyRuntime 的联调 ─────────────────── */

await check("联调：空计划必须被 verifyRuntime 判红（真空绿防线）", async () => {
    const { verifyRuntime } = await import("./verify_runtime.mjs");
    const g = FakeGame.fromFiles();
    const r = await verifyRuntime({ placements: [] }, { reader: g.reader() });
    assert.equal(r.ok, false, "空计划被判绿 —— verifyRuntime 的真空绿防线失效了");
});

await check("联调：真实宏的计划 → 落盘假 apply → verifyRuntime 转绿", async () => {
    const { verifyRuntime } = await import("./verify_runtime.mjs");
    const { replaceRun } = await import("./macros/remove.mjs");
    const g = FakeGame.fromFiles();
    const plan = replaceRun(
        { region: [2, -12, 5, -11], building: ["cutter", { kind: "trash", port: "left", confirm_waste: true }] },
        { entities: g.obs.entities },
    );
    assert.equal(plan.ok, true, "宏拒绝了：" + JSON.stringify(plan.error && plan.error.code));
    const before = await verifyRuntime(plan, { reader: g.reader() });
    assert.equal(before.ok, false, "还没落盘就绿了 —— 这是最严重的一类假绿");
    assert.equal(before.checks.find(c => c.name === "L1-landing").ok, false);
    const ops = [
        ...(plan.removes || []).map(r => ({ op: "delete", uid: r.uid })),
        ...(plan.placed || []).map(p => ({ op: "place", building: p.kind, x: p.origin[0], y: p.origin[1], r: p.rotation, rotationVariant: p.rotationVariant || 0 })),
    ];
    const ap = g.apply(ops);
    assert.equal(ap.ok, true);
    const after = await verifyRuntime(plan, { reader: g.reader() });
    assert.equal(after.ok, true, "落盘后仍红：" + JSON.stringify(after.checks.filter(c => !c.ok).map(c => c.name + ":" + c.reason)));
});

await check("联调：obs 截断时 verifyRuntime 的 L0 必须判不可判定", async () => {
    const { verifyRuntime } = await import("./verify_runtime.mjs");
    const g = FakeGame.fromFiles();
    const truncating = { ...g.reader(), obs: async () => g.observe({ max_entities: 5 }) };
    const r = await verifyRuntime({ placements: [{ kind: "belt", x: -10, y: 3, rot: 0, rv: 0 }] }, { reader: truncating });
    assert.equal(r.ok, false);
    assert.equal(r.checks[0].undecidable, true);
});

/* ─────────────────── 汇总 ─────────────────── */

function assertNoUnconsumedChecks() {
    if (unconsumed.size) {
        fail += unconsumed.size;
        for (const h of unconsumed) failures.push(h.name + " → 定义了从未被 await（thenable 未被消费）");
        console.log(`FAIL ${unconsumed.size} 条 check 定义了但没被 await —— 它们从未执行`);
    }
}

assertNoUnconsumedChecks();
console.log(`\nfake_game 自测：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log("失败项："); for (const f of failures) console.log("  ✗ " + f); }
process.exit(fail ? 1 : 0);
