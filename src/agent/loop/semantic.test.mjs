/**
 * semantic.test.mjs — `loop/semantic.mjs` 的验收（P-a 第二块）。
 *
 * 任务书点名的 10 条里，4 条是**负例**（判据必须真的会说"不"）：
 *
 *   1  正  L4：有 `PROCESSOR_REQUIRED{scope:"stream", op:"cut"}`；`site_handles` 含 x=2/3/4 的落点；
 *           **无**任何 subject 为 B135/B136/B137 的码
 *   2  负  L4：**无** `DISCARDED_INTERMEDIATE`（cutter 切的是 Cu，不在 orbit(RuRu----) 里）
 *   3  正  L5：有 `DISCARDED_INTERMEDIATE`，subject=cutter#10902，`one_rotation_from_goal=true`
 *   4  正  L5：有 `WRONG_SHAPE_AT_HUB` 或 `PROCESSOR_REQUIRED{scope:"factory", op:"rotate"}`
 *   5  负  修好后的 L4（删 3 带 + 加 cutter/trash）⇒ **0 条 blocker**（warn 允许）
 *   6  负  `opts.recipe=null` ⇒ 返回 `[]`，不抛
 *   7  负  隧道跨界（L4 B85）⇒ 只出 `SHAPE_UNKNOWN`，不出 `GOAL_SHAPE_STRANDED`
 *   8  正  坐标禁令：所有诊断不含坐标形态
 *   9  正  确定性：同 obs 调两次逐字节相同
 *  10  正  上限：总量 ≤8、每码 ≤3
 *
 * 另有 4 条**比任务书更严格**的：
 *   · `site_cells` 与真宏 `replace_run` 逐格对拍（L4 走廊内 38 个，一个不多一个不少）；
 *   · 配方 level 门控（L5 level 5 下 cutQuad 步骤被剔除，`needs` 里没有它）；
 *   · `WRONG_SHAPE_AT_HUB` 的 `evidence.handles` **只含 hub**（v2 §4 的反回归）；
 *   · 重排句柄编号后语义结论不变（句柄不稳定、判据必须稳定）。
 *
 * 运行：`node --test src/agent/loop/semantic.test.mjs`
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { semanticDiagnoses, beltsCarryingShape } from "./semantic.mjs";
import { buildHandles } from "./handles.mjs";
import { indexOf } from "./topology.mjs";
import { replaceRun } from "../macros/remove.mjs";
import { DIAG_CODES } from "./constants.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAVES = path.resolve(HERE, "../../../test/fixtures/saves");
const load = f => JSON.parse(fs.readFileSync(path.join(SAVES, f), "utf8")).result;

const L4 = load("L4-obs.json");
const L5 = load("L5-obs.json");

const clone = x => JSON.parse(JSON.stringify(x));
const goalOf = obs => obs.goal.requirement.shape;
const handlesOf = obs => buildHandles(obs, null);

/* ══════════════════════════════════════════════════════════════════════════
 * 配方夹具（**手工构造，不 spawn solver**）
 *
 * 两份都是 solver 在对应 level 下的真实输出（`solver.mjs --no-cutquad` / 默认），
 * 逐字段抄过来并冻结 —— 语义层的测试不该为了一个固定数组去跑外部程序：
 * 那会让「同 obs 两次结果不同」重新成为可能（solver 有 200–400ms 的 spawn）。
 * ══════════════════════════════════════════════════════════════════════════ */

/** L4 `RuRu----`：mine(RuRuRuRu) → cut(half=right)。 */
const RECIPE_L4 = Object.freeze({
    ok: true,
    steps: [
        { hash: "RuRuRuRu", op: "mine", args: {}, inputs: [] },
        { hash: "RuRu----", op: "cut", args: { half: "right" }, inputs: ["RuRuRuRu"] },
    ],
});

/** L5 `Cu----Cu`（level 5，**no-cutquad**）：mine → cut(left) → rotate(cw)。 */
const RECIPE_L5 = Object.freeze({
    ok: true,
    steps: [
        { hash: "CuCuCuCu", op: "mine", args: {}, inputs: [] },
        { hash: "----CuCu", op: "cut", args: { half: "left" }, inputs: ["CuCuCuCu"] },
        { hash: "Cu----Cu", op: "rotate", args: { dir: "cw" }, inputs: ["----CuCu"] },
    ],
});

/**
 * L5 夹具**没有** `resources`（dump 时 mod 没开 `include_resources`）。
 *
 * 语义层需要矿图才能知道矿机挖的是什么，所以 L5 的形状类测试必须**显式注入**矿图 ——
 * 否则 8 条矿机流全都 `SHAPE_UNKNOWN`，`DISCARDED_INTERMEDIATE` 根本不可能成立。
 * 注入的值来自实测布局（`DIAGNOSE-SEMANTICS-CONTRACT.md` §13.1）：
 * x=2..5 / y=-8 是四台钌矿机、x=-10..-7 / y=4..5 是四台铜矿机；
 * L5 的 goal 是 `Cu----Cu`，所以这里把 x=2..5 那四台改成铜（同一份几何、换矿种）。
 */
const L5_WITH_ORE = (() => {
    const o = clone(L5);
    const ore = [];
    for (let x = 2; x <= 5; x++) ore.push([x, -8, "CuCuCuCu"]);
    for (const [x, y] of [[-10, 4], [-9, 4], [-8, 5], [-7, 5]]) ore.push([x, y, "CuCuCuCu"]);
    o.resources = ore;
    return o;
})();

const run = (obs, recipe, opts = {}) =>
    semanticDiagnoses(obs, null, goalOf(obs), handlesOf(obs), { recipe, ...opts });

const byCode = (ds, code) => ds.filter(d => d.code === code);
const streamDiags = ds => byCode(ds, "PROCESSOR_REQUIRED").filter(d => d.evidence.scope === "stream");
const factoryDiags = ds => byCode(ds, "PROCESSOR_REQUIRED").filter(d => d.evidence.scope === "factory");

/**
 * 用**真宏**修一次 L4：删 3 条带 + 加 cutetr@(4,-13) + trash@(4,-14)。
 * 落点来自宏自己的规划（不是手抄坐标），删哪些也来自宏的 `removed`。
 */
function repairedL4() {
    const w = clone(L4);
    const r = replaceRun(
        { region: [4, -14, 5, -13], building: ["cutter", { kind: "trash", port: "left", confirm_waste: true }] },
        { entities: w.entities },
    );
    assert.equal(r.ok, true, `前提：真宏必须接受这个落点（${r.ok ? "" : r.error && r.error.code}）`);
    const gone = new Set(r.removed.map(x => x.uid));
    w.entities = w.entities.filter(e => !gone.has(e.uid));
    let next = Math.max(...w.entities.map(e => e.uid)) + 1;
    for (const p of r.placed) {
        w.entities.push({
            uid: next++, type: p.kind, x: p.origin[0], y: p.origin[1], r: 0,
            variant: "default", rotation_variant: 0, code: p.kind === "cutter" ? 9 : 20, layer: "regular",
        });
    }
    return w;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. L4：PROCESSOR_REQUIRED{scope:"stream"} —— 且不碰 hub 入口
 * ══════════════════════════════════════════════════════════════════════════ */

test("T1 ★ L4：PROCESSOR_REQUIRED{scope:stream, op:cut} 存在，severity=warn，need=1 have=1", () => {
    const ds = run(L4, RECIPE_L4, { level: 4 });
    const st = streamDiags(ds);
    assert.equal(st.length, 1, `恰好一条（实际 ${st.length}）`);
    const d = st[0];
    assert.equal(d.evidence.op, "cut");
    assert.equal(d.evidence.machine, "cutter");
    assert.equal(d.evidence.need, 1);
    assert.equal(d.evidence.have, 1, "世界里真的有一台 cutter（它只是不在 Ru 链上）");
    assert.equal(d.severity, "warn", "v2 §2：机器存在、只是不在那条流上 ⇒ 该做的事，不是坏的东西");
    assert.equal(d.severity === "blocker", false, "它**不是** blocker（F-1 的修正）");
});

test("T1 ★ L4：site_handles 是**全部**可行位置，含 x=2 / x=3 / x=4", () => {
    const ds = run(L4, RECIPE_L4, { level: 4 });
    const d = streamDiags(ds)[0];
    const idx = indexOf(L4);
    const xs = new Set(d.evidence.site_cells.map(c => c[0]));
    assert.ok(xs.has(2) && xs.has(3) && xs.has(4),
        `必须含 x=2/3/4（v2 §1：x=2 有 18 个、x=3 有 10 个、x=4 有 5 个；实际 x=${[...xs].sort().join(",")}）`);
    assert.ok(!xs.has(5), "x=5 不可行（cutter 2×1 会伸到 x=6，那里没有带子）");
    /* 每个 site_handle 都必须是**真实句柄**，且指向落点那一格的带子（不是编出来的）。
       `handleUid` 是锚点带（落点 block 里 y 最小的那条）—— 句柄必须能反查回一个真实实体，
       且它的 x 与 site_cell 的 x 差不超过 1（2×1 footprint，见 cutSites 的 `anchor` 选取）。 */
    assert.equal(d.evidence.site_handles.length, d.evidence.site_cells.length,
        "每个落点一个句柄（本来就该一一对应）");
    const tbl = handlesOf(L4);
    d.evidence.site_cells.forEach((c, i) => {
        const h = d.evidence.site_handles[i];
        const e = tbl.byHandle.get(h);
        assert.ok(e, `site_handle ${h} 不是真句柄`);
        assert.equal(e.type, "belt");
        assert.ok(Math.abs(e.x - c[0]) <= 1 && Math.abs(e.y - c[1]) <= 1,
            `${h}@(${e.x},${e.y}) 与落点 (${c.join(",")}) 不在同一个 2×1 块里`);
    });
    /* 至少有一个落点落在 x∈{2,3,4} 的 Ru 走廊上（这是这一条的全部意义） */
    assert.ok(d.evidence.site_cells.some(c => c[0] >= 2 && c[0] <= 4));
    void idx;
});

test("T1 ★ L4：没有任何诊断以 hub 入口带子 B135/B136/B137 为 subject（v2 §4 的核心反回归）", () => {
    const ds = run(L4, RECIPE_L4, { level: 4 });
    const bad = ds.filter(d => ["B135", "B136", "B137"].includes(d.subject && d.subject.handle));
    assert.deepEqual(bad.map(d => d.code), [],
        "这些是 hub 的入口带子：把它们顶到 BELTS 段最前会把模型引去改入口，与目标相反");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 负例：L4 的 cutter 切的是 Cu ⇒ 不许报 DISCARDED_INTERMEDIATE
 * ══════════════════════════════════════════════════════════════════════════ */

test("T2 ★ 负例：L4 无 DISCARDED_INTERMEDIATE（cutter#10036 切的是 CuCuCuCu，不在 orbit(RuRu----)）", () => {
    const ds = run(L4, RECIPE_L4, { level: 4 });
    assert.deepEqual(byCode(ds, "DISCARDED_INTERMEDIATE").map(d => d.subject.handle), [],
        "L4 那台 cutter 切的是铜：----CuCu / CuCu---- 既不在 orbit(RuRu----) 里，也不是 Ru 配方的祖先");
    /* 同一份判据在**修好之后**也不许误报（L4 修好后 cutter 切 Ru 的一半会被丢） */
    const fixed = run(repairedL4(), RECIPE_L4, { level: 4 });
    assert.deepEqual(byCode(fixed, "DISCARDED_INTERMEDIATE").map(d => d.subject.handle), []);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. L5：DISCARDED_INTERMEDIATE
 * ══════════════════════════════════════════════════════════════════════════ */

test("T3 ★ L5：DISCARDED_INTERMEDIATE，subject=cutter#10902，discarded=----CuCu，one_rotation_from_goal=true", () => {
    const ds = run(L5_WITH_ORE, RECIPE_L5, { level: 5 });
    const dis = byCode(ds, "DISCARDED_INTERMEDIATE");
    assert.ok(dis.length >= 1, "L5 的病灶就是「一口扔、一口送」");
    assert.equal(dis[0].subject.uid, 10902, "首条 subject 必须是 cutter#10902");
    assert.equal(dis[0].subject.handle, "C1");
    assert.equal(dis[0].severity, "blocker");
    assert.deepEqual(dis[0].evidence.discarded, ["----CuCu"], "被丢的那口形状");
    assert.deepEqual(dis[0].evidence.sibling, ["CuCu----"], "另一口送去 hub 的形状");
    assert.equal(dis[0].evidence.one_rotation_from_goal, true, "----CuCu 再转一次就是 Cu----Cu");
    assert.equal(dis[0].evidence.discarded_port, "left");
    assert.equal(dis[0].evidence.run_kind, "trash");
    assert.ok(dis[0].evidence.handles.includes("C1"));
    assert.ok(dis[0].evidence.handles.includes("T2"), "垃圾桶句柄要在 evidence 里（模型要知道哪台在销毁）");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. L5：WRONG_SHAPE_AT_HUB 或 factory-level rotate
 * ══════════════════════════════════════════════════════════════════════════ */

test("T4 ★ L5：同时给出 WRONG_SHAPE_AT_HUB（hub 收到 CuCu----）与 PROCESSOR_REQUIRED{scope:factory, op:rotate}", () => {
    const ds = run(L5_WITH_ORE, RECIPE_L5, { level: 5 });

    const fac = factoryDiags(ds);
    assert.ok(fac.length >= 1, "工厂里 0 台 rotater ⇒ 纯计数就能判");
    assert.equal(fac[0].evidence.machine, "rotater");
    assert.equal(fac[0].evidence.need, 1);
    assert.equal(fac[0].evidence.have, 0);
    assert.equal(fac[0].severity, "blocker", "v2 §2：机器根本不存在 ⇒ 真的坏");

    const wh = byCode(ds, "WRONG_SHAPE_AT_HUB");
    assert.equal(wh.length, 1);
    assert.equal(wh[0].subject.handle, "H1");
    /* L5 的 hub 同时收到两个「转一次就是目标」的形状：
     *   ----CuCu（cutter#10036 的左口 → B132 直进 hub）
     *   CuCu----（cutter#10902 的右口 → balancer → B134 进 hub）
     * 两者都在 orbit(Cu----Cu) 里，所以两个都该报。 */
    assert.deepEqual(wh[0].evidence.wrong, ["----CuCu", "CuCu----"]);
    assert.ok(wh[0].evidence.wrong.every(s => s !== "Cu----Cu"), "目标形状本身不算 wrong");
    assert.equal(wh[0].severity, "blocker");
    /* v2 §4：hub_inlets 是独立字段，不参与 referencedHandles */
    assert.ok(wh[0].evidence.hub_inlets.length >= 1);
    assert.ok(wh[0].evidence.hub_inlets.every(x => /^B\d+$/.test(x.handle)));
    assert.match(wh[0].observed, /upstream/i, "必须明确说往上游找，而不是改入口");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 负例：修好后的 L4 ⇒ 0 条 blocker
 * ══════════════════════════════════════════════════════════════════════════ */

test("T5 ★ 负例：L4 修好后 0 条 blocker（warn/info 允许）", () => {
    const fixed = repairedL4();
    const ds = run(fixed, RECIPE_L4, { level: 4 });
    const blockers = ds.filter(d => d.severity === "blocker");
    assert.deepEqual(blockers.map(d => [d.code, d.subject.handle]), [],
        `修好之后不许再有 blocker（会跟正解打架）；实际 ${JSON.stringify(blockers.map(d => d.code))}`);
    /* 但 warn 必须还在：残流（x=5 上半段被 cutter 堵死）确实还运着没切过的原料 */
    const st = streamDiags(ds);
    assert.ok(st.length >= 1, "残流仍应报 warn（不是一刀切掉所有诊断）");
    assert.ok(st.every(d => d.severity === "warn"));
    assert.deepEqual(byCode(ds, "WRONG_SHAPE_AT_HUB").map(d => d.subject.handle), [],
        "修好后 hub 只收 goal（与原料残流），没有「转一次就是目标」的形状");
});

test("T5 对照：修好前后的差异**只在**「cutter 在不在那条流上」这一条，不是状态漂移", () => {
    const before = streamDiags(run(L4, RECIPE_L4, { level: 4 }));
    const after = streamDiags(run(repairedL4(), RECIPE_L4, { level: 4 }));
    assert.equal(before[0].evidence.op, after[0].evidence.op, "两次都是缺 cut");
    assert.ok(after[0].evidence.site_cells.length < before[0].evidence.site_cells.length,
        "修好之后可落点变少（cutter 本体占掉了 (4,-13)/(5,-13) 一带）");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 6. 负例：recipe 缺失 ⇒ []，且不抛
 * ══════════════════════════════════════════════════════════════════════════ */

test("T6 ★ 负例：opts.recipe 缺失 / null / ok:false / steps 为空 ⇒ 返回 []，不抛，不 spawn", () => {
    const cases = [undefined, null, {}, { ok: false, reason: "solver timed out" }, { ok: true, steps: [] }];
    for (const recipe of cases) {
        let ds;
        assert.doesNotThrow(() => {
            ds = semanticDiagnoses(L4, null, goalOf(L4), handlesOf(L4), recipe === undefined ? {} : { recipe });
        }, `recipe=${JSON.stringify(recipe)} 不许抛`);
        assert.deepEqual(ds, [], `recipe=${JSON.stringify(recipe)} ⇒ 语义层整体降级为空`);
    }
});

test("T6 负例：obs.truncated ⇒ 返回 []（世界不完整时语义结论不可信）", () => {
    const o = clone(L4);
    o.truncated = true;
    assert.deepEqual(run(o, RECIPE_L4, { level: 4 }), []);
});

test("★ semantic.mjs 无副作用：源码里没有 readFileSync/writeFileSync/spawnSync/execSync 调用", () => {
    const src = fs.readFileSync(path.join(HERE, "semantic.mjs"), "utf8");
    for (const re of [/\breadFileSync\s*\(/, /\bwriteFileSync\s*\(/, /\bspawnSync\s*\(/, /\bexecSync\s*\(/]) {
        assert.ok(!re.test(src), `semantic.mjs 不许调用 ${re}`);
    }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 7. 负例：隧道跨界 ⇒ 只出 SHAPE_UNKNOWN
 * ══════════════════════════════════════════════════════════════════════════ */

test("T7 ★ 负例：L4 的隧道 B85 只出 SHAPE_UNKNOWN{tunnel}，不出 GOAL_SHAPE_STRANDED", () => {
    const ds = run(L4, RECIPE_L4, { level: 4 });
    const unk = byCode(ds, "SHAPE_UNKNOWN").filter(d => d.evidence.reason === "tunnel");
    assert.equal(unk.length, 1, "按原因聚合成一条（逐条报会吃掉预算）");
    assert.equal(unk[0].subject.handle, "B85", "subject 是隧道 sender");
    assert.equal(unk[0].severity, "info");
    assert.deepEqual(unk[0].candidates, [], "candidates 为空 = 不许喂给 LLM 当行动依据");
    assert.ok(unk[0].evidence.count >= 1);

    const codes = new Set(ds.map(d => d.code));
    assert.ok(!codes.has("GOAL_SHAPE_STRANDED"), "隧道跨界不许升级成「目标形状搁浅」");
    assert.ok(!codes.has("OFF_RECIPE_LINE"), "也不许升级成「不在配方上」");
});

test("T7 负例：**任何** SHAPE_UNKNOWN 都不是 blocker，也不带坐标", () => {
    for (const [name, obs, rec] of [["L4", L4, RECIPE_L4], ["L5", L5, RECIPE_L5]]) {
        for (const d of byCode(run(obs, rec, { level: 5 }), "SHAPE_UNKNOWN")) {
            assert.notEqual(d.severity, "blocker", `${name}: SHAPE_UNKNOWN 永远是 info`);
            assert.equal(d.layer, "L4");
            assert.ok(typeof d.evidence.reason === "string" && d.evidence.reason.length > 0);
        }
    }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 8. 坐标禁令
 * ══════════════════════════════════════════════════════════════════════════ */

test("T8 ★ 所有诊断的 subject/expected/observed/evidence.handles 不含坐标形态", () => {
    const COORD = /\(?\s*-?\d{1,4}\s*,\s*-?\d{1,4}\s*\)?/;
    for (const [name, obs, rec] of [["L4", L4, RECIPE_L4], ["L5+ore", L5_WITH_ORE, RECIPE_L5], ["L5", L5, RECIPE_L5]]) {
        for (const d of run(obs, rec, { level: 5 })) {
            const blob = JSON.stringify({
                subject: d.subject, expected: d.expected, observed: d.observed,
                handles: d.evidence.handles, hub_inlets: d.evidence.hub_inlets, site_handles: d.evidence.site_handles,
            });
            assert.ok(!COORD.test(blob), `${name}/${d.code}: 不许有坐标 —— ${blob.slice(0, 300)}`);
        }
    }
});

test("T8 坐标只允许出现在 evidence.site_cells（独立字段，prompt 不渲染）", () => {
    const ds = run(L4, RECIPE_L4, { level: 4 });
    const d = streamDiags(ds)[0];
    assert.ok(Array.isArray(d.evidence.site_cells) && d.evidence.site_cells.length > 0);
    for (const c of d.evidence.site_cells) {
        assert.ok(Array.isArray(c) && c.length === 2 && c.every(Number.isInteger));
    }
    /* 全部 subject 都是句柄或 uid token，不允许是坐标串 */
    for (const x of ds) {
        if (x.subject.handle === null) assert.match(String(x.subject.token), /^uid:\d+$/);
        else assert.match(x.subject.handle, /^[A-Z]{1,2}\d{1,3}$/);
    }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 9. 确定性
 * ══════════════════════════════════════════════════════════════════════════ */

test("T9 ★ 同一份 obs 调两次 ⇒ 结果逐字节相同", () => {
    for (const [name, obs, rec] of [["L4", L4, RECIPE_L4], ["L5+ore", L5_WITH_ORE, RECIPE_L5]]) {
        const a = JSON.stringify(run(obs, rec, { level: 5 }));
        const b = JSON.stringify(run(obs, rec, { level: 5 }));
        assert.equal(a, b, `${name} 必须确定性`);
    }
});

test("T9 ★ 句柄**重编号**后语义结论不变（句柄不稳定，判据必须稳定）", () => {
    /* 把 uid 整体平移后再建句柄表：句柄名可能变，但「缺 cut」「丢的是 ----CuCu」这类结论不能变。 */
    const shifted = clone(L5_WITH_ORE);
    for (const e of shifted.entities) e.uid += 50000;
    for (const s of (shifted.resources || [])) void s;
    const a = run(L5_WITH_ORE, RECIPE_L5, { level: 5 });
    const b = run(shifted, RECIPE_L5, { level: 5 });
    const key = ds => ds.map(d => [
        d.code, d.severity,
        d.evidence.scope || d.evidence.reason || "",
        d.evidence.op || "",
        (d.evidence.discarded || []).join("|"),
        String(d.evidence.one_rotation_from_goal === true),
    ].join("/"));
    assert.deepEqual(key(b), key(a), "结论与 uid/句柄编号无关");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 10. 上限（v2 §6：每码 ≤3、总量 ≤8）
 * ══════════════════════════════════════════════════════════════════════════ */

test("T10 ★ 总量 ≤8、每码 ≤3，且超限不静默丢弃（首条带 suppressed）", () => {
    for (const [name, obs, rec] of [["L4", L4, RECIPE_L4], ["L5+ore", L5_WITH_ORE, RECIPE_L5]]) {
        const ds = run(obs, rec, { level: 5 });
        assert.ok(ds.length <= 8, `${name}: 总量 ${ds.length} > 8`);
        const per = new Map();
        for (const d of ds) per.set(d.code, (per.get(d.code) || 0) + 1);
        for (const [c, n] of per) assert.ok(n <= 3, `${name}: ${c} 有 ${n} 条 > 3`);
    }
    /* 人为压到 1/1，L5+ore 必然超限 ⇒ 必须记 suppressed，不许静默 */
    const full = run(L5_WITH_ORE, RECIPE_L5, { level: 5 });
    const tight = run(L5_WITH_ORE, RECIPE_L5, { level: 5, limits: { PER_CODE: 1, TOTAL: 1 } });
    assert.equal(tight.length, 1);
    const sup = tight[0].evidence.suppressed;
    assert.ok(Number.isInteger(sup) && sup > 0, "被压掉的条数必须记在首条 evidence.suppressed 上");
    assert.equal(1 + sup, full.length, "suppressed 必须补回完整条数");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 11. 比任务书更严的三条
 * ══════════════════════════════════════════════════════════════════════════ */

test("T11 ★ site_cells 与**真宏** replace_run 逐格对拍（L4 走廊内 38 个，一个不多一个不少）", () => {
    /* 这条是 v2 §1 的落地验证：枚举必须是「物理可行」，不是「我以为对的 x 范围」。
       用真宏在全图扫一遍，再把结果与 semantic 的 site_cells 对拍。
       注意：宏的可行集是 **55** 个（含铜线 17 个）；语义层只列目标原料走廊内的 38 个 ——
       那不是漏，是 v2 §3 的 `inGoalRawCorridor` 过滤（把模型引向铜线正是 F-2 的形态）。 */
    const macroOk = new Set();
    for (let x = -14; x <= 10; x++) {
        for (let y = -44; y <= 8; y++) {
            const r = replaceRun(
                { region: [x, y - 1, x + 1, y], building: ["cutter", { kind: "trash", port: "left", confirm_waste: true }] },
                { entities: L4.entities },
            );
            if (r.ok) macroOk.add(`${x},${y}`);
        }
    }
    const d = streamDiags(run(L4, RECIPE_L4, { level: 4 }))[0];
    const mine = new Set(d.evidence.site_cells.map(c => `${c[0]},${c[1]}`));
    const notFeasible = [...mine].filter(k => !macroOk.has(k));
    assert.deepEqual(notFeasible, [], "语义层列出的每个落点，真宏必须接受");
    /* 走廊内（x>=2）的宏可行点必须**全部**在 site_cells 里 —— 漏一个就是把正解判错 */
    const corridor = [...macroOk].filter(k => Number(k.split(",")[0]) >= 2);
    const missing = corridor.filter(k => !mine.has(k));
    assert.deepEqual(missing, [], `走廊内的可行点必须一个不漏（宏共 ${corridor.length} 个，语义层 ${mine.size} 个）`);
    assert.ok(![...mine].some(k => Number(k.split(",")[0]) < 0), "铜线（x<0）不该出现在 site_cells 里");
});

test("T11 ★ 配方 level 门控：L5 的 cutQuad 步骤被剔除，needs 里不出现（v2 §6 的 T7）", () => {
    /* 未门控的 solver 对 Cu----Cu 会给 cutQuad×2 + stacker×1 —— cutQuad 要 L16。
       语义层如果照单全收，就会在 level 5 上叫模型造 L16 的机器（prompt.mjs 的老 bug）。 */
    const ungated = {
        ok: true,
        steps: [
            { hash: "CuCuCuCu", op: "mine", inputs: [] },
            { hash: "------Cu", op: "cutQuad", args: { quad: 3 }, inputs: ["CuCuCuCu"] },
            { hash: "Cu------", op: "cutQuad", args: { quad: 0 }, inputs: ["CuCuCuCu"] },
            { hash: "Cu----Cu", op: "stack", args: { merge: true }, inputs: ["------Cu", "Cu------"] },
        ],
    };
    const ds = run(L4, ungated, { level: 5 });
    const fac = factoryDiags(ds);
    assert.ok(!fac.some(d => d.evidence.op === "cutQuad"), "level 5 不许要求 cutQuad（要 L16）");
    assert.ok(!fac.some(d => d.evidence.machine === "stacker"), "stacker（L10）同样超等级，也必须被挡住");
    /* 门控是「按等级报」而不是「一律不报」：level 20 上两者都必须出现 —— 否则这条测试
       只是证明了「工厂诊断永远不报」，那是假绿。 */
    const hi = factoryDiags(run(L4, ungated, { level: 20 }));
    assert.ok(hi.some(d => d.evidence.machine === "stacker"), "level 20 应该要求 stacker");
    assert.ok(hi.some(d => d.evidence.op === "cutQuad"), "level 20 应该要求 cutQuad（L16 已解锁）");
});

test("T11 ★ WRONG_SHAPE_AT_HUB 的 evidence.handles **只含 hub**（v2 §4）", () => {
    const ds = run(L5_WITH_ORE, RECIPE_L5, { level: 5 });
    const wh = byCode(ds, "WRONG_SHAPE_AT_HUB")[0];
    assert.ok(wh, "前提：必须有这条诊断");
    assert.deepEqual(wh.evidence.handles, ["H1"], "只放 hub 本身；入口带子放 hub_inlets");
    assert.ok(wh.evidence.hub_inlets.length >= 1, "入口带子必须有地方放（独立字段）");
    /* 反过来钉一次：handles 里不许出现任何 B* */
    assert.ok(!wh.evidence.handles.some(h => /^B\d+$/.test(h)),
        "入口带子进 handles 会被 pickBelts 顶到 BELTS 第 1-3 位，与目标相反");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 12. 工程约束
 * ══════════════════════════════════════════════════════════════════════════ */

test("P-a 产出的每个码都在 DIAG_CODES 闭集里，且 severity ∈ {blocker,warn,info}", () => {
    for (const [name, obs, rec] of [["L4", L4, RECIPE_L4], ["L5+ore", L5_WITH_ORE, RECIPE_L5]]) {
        for (const d of run(obs, rec, { level: 5 })) {
            assert.ok(Object.prototype.hasOwnProperty.call(DIAG_CODES, d.code), `${name}: ${d.code} 不在闭集`);
            assert.ok(["blocker", "warn", "info"].includes(d.severity), `${name}/${d.code}: severity=${d.severity}`);
        }
    }
});

test("P-a 只产出这 5 个码（越界即红：别顺手加了没登记的东西）", () => {
    /* `MIXER_UNFED` 是第 5 个。加它的理由是可测的：`PROCESSOR_REQUIRED` 只数
       「工厂里有几台 mixer」，于是「有一台、但两个 color 槽喂的是同一条线」
       会让诊断彻底消失 —— 而配方要的是两种**不同**的颜料。第 9 关就是这么卡住的。 */
    const OWNED = new Set([
        "PROCESSOR_REQUIRED", "WRONG_SHAPE_AT_HUB", "DISCARDED_INTERMEDIATE",
        "SHAPE_UNKNOWN", "MIXER_UNFED",
    ]);
    for (const [name, obs, rec] of [["L4", L4, RECIPE_L4], ["L5+ore", L5_WITH_ORE, RECIPE_L5]]) {
        for (const d of run(obs, rec, { level: 5 })) {
            assert.ok(OWNED.has(d.code), `${name}: 语义层不许产出 ${d.code}`);
        }
    }
});

test("★ 性能守卫：L4 上 20 次调用 < 2s（纯函数，无 spawn）", () => {
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) run(L4, RECIPE_L4, { level: 4 });
    const ms = Date.now() - t0;
    assert.ok(ms < 2000, `20 次 ${ms}ms —— 超出说明有隐式 IO 或重复建索引`);
});

test("★ 峰值：L4 + L5 的 diagnosis 字段形状与 report 渲染器兼容（subject/expected/observed/evidence/candidates）", () => {
    for (const [obs, rec] of [[L4, RECIPE_L4], [L5_WITH_ORE, RECIPE_L5]]) {
        for (const d of run(obs, rec, { level: 5 })) {
            assert.ok(d.subject && typeof d.subject === "object");
            assert.equal(typeof d.expected, "string");
            assert.equal(typeof d.observed, "string");
            assert.ok(d.evidence && typeof d.evidence === "object");
            assert.ok(Array.isArray(d.evidence.handles));
            assert.ok(Array.isArray(d.candidates));
        }
    }
});

/* ══════════════════════════════════════════════════════════════════════════
 * MIXER_UNFED —— 「机器在了，槽没喂」是 PROCESSOR_REQUIRED 看不见的一类病
 *
 * 真实场景（第 9 关，2026-11-10）：
 *   配方 mix 步的 inputs 是 ["color:blue","color:red"]
 *   世界上有 1 台 mixer，两个 color 槽的上游是**同一条蓝矿线**
 *   ⇒ 数量达标、诊断消失、mix() 永远不跑
 * ══════════════════════════════════════════════════════════════════════════ */

/** 紫色目标的配方（与 solver 在 level 9 的真实输出逐字段一致）。 */
const RECIPE_PURPLE = Object.freeze({
    ok: true,
    steps: [
        { op: "mine", hash: goalOf(L4) === "x" ? "x" : "CuCuCuCu", inputs: [], args: {} },
        { op: "mineColor", hash: "color:blue", inputs: [], args: { color: "blue" } },
        { op: "mineColor", hash: "color:red", inputs: [], args: { color: "red" } },
        { op: "mix", hash: "color:purple", inputs: ["color:blue", "color:red"], args: { color: "purple" } },
        { op: "paint", hash: "CpCpCpCp", inputs: ["CuCuCuCu", "color:purple"], args: { color: "purple" } },
    ],
});

test("M1 ★ 没有 mixer ⇒ 不报 MIXER_UNFED（那是 PROCESSOR_REQUIRED 的活）", () => {
    /* 两份真实存档里都没有 mixer。这条防的是「新码把缺机器也报一遍」，
       那会让同一个问题出两条诊断、白白吃掉预算。 */
    for (const [obs, lvl] of [[L4, 4], [L5, 5]]) {
        const ds = semanticDiagnoses(obs, null, "CpCpCpCp", handlesOf(obs), { recipe: RECIPE_PURPLE, level: lvl });
        assert.equal(byCode(ds, "MIXER_UNFED").length, 0, "没有 mixer 时不该报 MIXER_UNFED");
    }
});

test("M2 ★ 有 mixer 但 color 槽没凑齐两种颜料 ⇒ MIXER_UNFED（blocker）", () => {
    /* 在 L4 上造一台 mixer，两个 color 槽都朝下（r=0 时 feed 格在 slot 下方）。
       只喂**一条**线，另一槽空着 —— 正是真机的形态。 */
    const w = clone(L4);
    let next = Math.max(...w.entities.map(e => e.uid)) + 1;
    const mx = 14, my = -30;                       // 远离既有结构的一块空地
    w.entities.push({
        uid: next++, type: "mixer", x: mx, y: my, r: 0, variant: "default",
        rotation_variant: 0, code: 12, layer: "regular",
    });
    /* 两个 feed 格 = (mx,my+1) 与 (mx+1,my+1) —— mixer r=0 的输入槽 `cell`
       是 slot + DIRV["bottom"] = slot + (0,+1)。`slotsOf` 逐字给出：
       `[{slot:[14,-30],cell:[14,-29]}, {slot:[15,-30],cell:[15,-29]}]`。
       带子放在 feed 格上、exit 朝下（r=180）才喂得进。 */
    w.entities.push({
        uid: next++, type: "belt", x: mx, y: my + 1, r: 180, variant: "default",
        rotation_variant: 0, code: 1, layer: "regular",
    });
    const ds = semanticDiagnoses(w, null, "CpCpCpCp", handlesOf(w), { recipe: RECIPE_PURPLE, level: 9 });
    const mix = byCode(ds, "MIXER_UNFED");
    assert.equal(mix.length, 1, `应当恰好报一条 MIXER_UNFED，实得 ${mix.length}`);
    const d = mix[0];
    assert.equal(d.severity, "blocker");
    assert.equal(d.subject.type, "mixer");
    assert.equal(d.subject.uid, next - 2, "subject 指向那台 mixer");
    assert.deepEqual(d.evidence.want_colors, ["color:blue", "color:red"], "证据里必须写明配方要的两种颜色");
    assert.equal(d.evidence.slot_values.length, 2, "两个槽都要给出各自解到的东西");
    /* ★ 必须能指出「哪个槽、为什么」—— 只说「没喂」对模型没有可执行性 ★
       两槽的状态是**不同**的（一路有带子但没对准、一路压根没有格上东西），
       这正是 M3（两路全空）区分得开的地方。 */
    assert.deepEqual(d.evidence.slot_why, ["belt-not-aimed", "feed-cell-empty"],
        "两个槽的缺口原因必须分别报出，且互不相同");
    assert.ok(d.candidates.includes("connect"), "首要修法是铺线，不是再放一台 mixer");
});

test("M3 反例：两个 color 槽都解不出时，仍报 MIXER_UNFED（不因为是「两路都空」而放过）", () => {
    /* 一台孤零零的 mixer，四周全空。数量对了（have:1），但一个槽都没喂。
       这正是「PROCESSOR_REQUIRED 说够了、而 mix() 永远不跑」的最小形态。 */
    const w = clone(L4);
    let next = Math.max(...w.entities.map(e => e.uid)) + 1;
    w.entities.push({
        uid: next++, type: "mixer", x: -40, y: 40, r: 0, variant: "default",
        rotation_variant: 0, code: 12, layer: "regular",
    });
    const ds = semanticDiagnoses(w, null, "CpCpCpCp", handlesOf(w), { recipe: RECIPE_PURPLE, level: 9 });
    assert.equal(byCode(ds, "MIXER_UNFED").length, 1, "两槽全空也必须报");
});

test("M4 反例：配方**不**需要两种不同颜色时，不报 MIXER_UNFED（不许误伤单输入配方）", () => {
    const single = Object.freeze({
        ok: true,
        steps: [
            { op: "mine", hash: "CuCuCuCu", inputs: [], args: {} },
            { op: "mineColor", hash: "color:blue", inputs: [], args: { color: "blue" } },
            { op: "mix", hash: "color:purple", inputs: ["color:blue"], args: { color: "purple" } },
            { op: "paint", hash: "CpCpCpCp", inputs: ["CuCuCuCu", "color:purple"], args: { color: "purple" } },
        ],
    });
    const w = clone(L4);
    let next = Math.max(...w.entities.map(e => e.uid)) + 1;
    w.entities.push({
        uid: next++, type: "mixer", x: -40, y: 40, r: 0, variant: "default",
        rotation_variant: 0, code: 12, layer: "regular",
    });
    const ds = semanticDiagnoses(w, null, "CpCpCpCp", handlesOf(w), { recipe: single, level: 9 });
    assert.equal(byCode(ds, "MIXER_UNFED").length, 0, "配方只要一种颜色时不该报");
});

test("M5 MIXER_UNFED 已登记进 DIAG_CODES 闭集（否则 loop 的 mkDiag 会抛）", () => {
    assert.ok(Object.prototype.hasOwnProperty.call(DIAG_CODES, "MIXER_UNFED"),
        "新增诊断码必须同时登记 constants.mjs 的 DIAG_CODES");
});

test("M6 ★ evidence.slots 必须给出可直接用的 port 选择器信息（索引 + 槽格 + 缺口原因）", () => {
    /* 第 9 关实测：诊断说「接到另一个 color 槽」，模型写 `port:"color"` ——
       mixer 两个槽的 role 都叫 color ⇒ `ambiguous_port` ⇒ 三连败。
       宏支持 `{role,index}` 与 `{entry:n}`，所以诊断必须把索引交出去。 */
    const w = clone(L4);
    let next = Math.max(...w.entities.map(e => e.uid)) + 1;
    const mx = 14, my = -30;
    w.entities.push({
        uid: next++, type: "mixer", x: mx, y: my, r: 0, variant: "default",
        rotation_variant: 0, code: 12, layer: "regular",
    });
    w.entities.push({
        uid: next++, type: "belt", x: mx, y: my + 1, r: 180, variant: "default",
        rotation_variant: 0, code: 1, layer: "regular",
    });
    const ds = semanticDiagnoses(w, null, "CpCpCpCp", handlesOf(w), { recipe: RECIPE_PURPLE, level: 9 });
    const d = byCode(ds, "MIXER_UNFED")[0];
    assert.ok(d, "应当有 MIXER_UNFED");
    const slots = d.evidence.slots;
    assert.equal(slots.length, 2, "两个 color 槽都要描述");
    assert.deepEqual(slots.map(s => s.index), [0, 1], "索引必须是 0/1 —— 那是 connect 的 port.index");
    assert.ok(slots.every(s => s.role === "color"));
    assert.ok(slots.every(s => Array.isArray(s.slot) && s.slot.length === 2), "每槽都要给槽格坐标");
    assert.ok(slots.every(s => Array.isArray(s.feed_cell) && s.feed_cell.length === 2), "每槽都要给喂料格");
    /* ★ hint 里的选择器**只在槽是空的**时才该出现 ★
     *
     * 本夹具的两条带子紧贴 mixer、`head.len === 0`（它们自己就是流头），
     * 属于「线对准了但源头断」，此时正确动作是去接**线的另一端**，而不是
     * connect 到 mixer 的槽（那会 `target_already_fed`）。
     * 所以这里断言的是「**不**出现反向建议」，见 M13。 */
});

test("M13 ★ 有断头时 hint 不许同时说「connect 到 mixer 槽」（两句自相矛盾）", () => {
    /* 真机 r-20261112175721-48ca：hint 前半说「去线的起点补」，后半说
       「connect 到 index:0」—— 槽 0 上已经压着那条断头线，后者必然
       `target_already_fed`。模型挑了更具体的那句，三轮全撞在上面，
       整轮 run `inert`（0 落盘）。

       正确行为：有断头 ⇒ 只给「接线另一端」这一个方向，
       并且**显式警告**不要 connect 到 mixer 槽。 */
    const w = clone(L4);
    let next = Math.max(...w.entities.map(e => e.uid)) + 1;
    const mx = 14, my = -30;
    w.entities.push({
        uid: next++, type: "mixer", x: mx, y: my, r: 0, variant: "default",
        rotation_variant: 0, code: 12, layer: "regular",
    });
    /* 槽 0 的 feed 格上放一条朝上的带子 —— 它对准了 mixer，但自己就是流头 */
    w.entities.push({
        uid: next++, type: "belt", x: mx, y: my + 1, r: 0, variant: "default",
        rotation_variant: 0, code: 1, layer: "regular",
    });
    const ds = semanticDiagnoses(w, null, "CpCpCpCp", handlesOf(w), { recipe: RECIPE_PURPLE, level: 9 });
    const d = byCode(ds, "MIXER_UNFED")[0];
    assert.ok(d, "应当有 MIXER_UNFED");

    /* 断头存在 ⇒ 必须有「不要 connect 到 mixer 槽」的警告 */
    assert.match(d.hint, /不要.*connect.*port|target_already_fed/,
        `★ 有断头却没警告「别 connect 到 mixer 槽」—— 模型会照做然后撞 target_already_fed。`
        + `实际：${d.hint}`);
    assert.match(d.hint, /另一头|起点|上游/, "必须指向「线的另一端」这个唯一正确方向");
    /* 并且**不许**出现「connect 时写 port:{role,index:N}」那种反向建议 */
    assert.ok(!/connect 时写|connect 时用/.test(d.hint),
        `★ 有断头时还在说「connect 时写 port:{role,index}」= 两句自相矛盾。实际：${d.hint}`);
});

test("M7 ★ 建议的 facing 必须指向 mixer 那一侧（槽朝向的反面，不是照抄槽朝向）", () => {
    /* 第 9 关实测：B198 @(mx,my+2)、mixer 槽 @(mx,my+1)。
     *   - 槽的 `dir` 是 "bottom"（槽在机器下沿朝下）
     *   - 而带子必须 exit **朝上**（top）才能喷进上方那一格
     *
     * 第一版把 `f.dir` 直接写进 hint，等于告诉模型「朝 bottom」——
     * 照做会把货喷到反方向，比不给建议还糟。这条锁住符号。 */
    const w = clone(L4);
    let next = Math.max(...w.entities.map(e => e.uid)) + 1;
    const mx = 14, my = -30;
    w.entities.push({
        uid: next++, type: "mixer", x: mx, y: my, r: 0, variant: "default",
        rotation_variant: 0, code: 12, layer: "regular",
    });
    /* 喂料带子放在 feed 格上，但**朝反了**（r=180 ⇒ exit bottom，喷离 mixer）。 */
    const feedUid = next++;
    w.entities.push({
        uid: feedUid, type: "belt", x: mx, y: my + 1, r: 180, variant: "default",
        rotation_variant: 0, code: 1, layer: "regular",
    });
    const ds = semanticDiagnoses(w, null, "CpCpCpCp", handlesOf(w), { recipe: RECIPE_PURPLE, level: 9 });
    const d = byCode(ds, "MIXER_UNFED")[0];
    assert.ok(d, "应当有 MIXER_UNFED");
    const slot0 = d.evidence.slots[0];
    assert.equal(slot0.why, "belt-not-aimed", "前提：这一槽的带子方向不对");
    assert.deepEqual(slot0.feed_cell, [mx, my + 1]);
    assert.deepEqual(slot0.slot, [mx, my], "槽格在 feed 格的正上方一格");

    /* hint 里建议的面必须是 top（朝上、指向 mixer），不是槽自己的 dir=bottom。 */
    const m = /必须朝 "(\w+)"/.exec(d.hint);
    assert.ok(m, `hint 必须给出可直接抄的朝向，实得：${d.hint}`);
    assert.equal(m[1], "top", `必须朝上才能喷进上方的 mixer 槽；照抄槽的 dir 会得到 bottom（错）`);
});

test("M8 ★ 颜料矿机的输出必须是 color:<name>，不是裸 <name>", () => {
    /* 实机第 9 关：两条喂料带子方向完全正确、确实连着蓝矿机，
       诊断却报 `color slot 0/1: no known incoming pigment`。

       根因是**两套命名撞车**：
         · `obs.resources` 的矿种是裸名：`blue` / `red` / `CuCuCuCu`
         · 配方里的颜料是带前缀的：`color:blue` / `color:red`
       传播引擎原样返回 `"blue"`，而判据找 `v.startsWith("color:")`
       ⇒ 一条都认不出来 ⇒ `beltsCarryingShape(obs, recipe, "color:blue")` 返回 0。

       这条锁住那条分界线：颜料加前缀，形状类（CuCuCuCu/RuRuRuRu）保持裸名。 */
    const w = clone(L4);
    let next = Math.max(...w.entities.map(e => e.uid)) + 1;
    /* 一块真的有 `red` 矿的地面 —— 用 L4 的资源图，找不到就跳过（不编）。 */
    const red = (w.resources || []).find(r => r[2] === "red");
    if (!red) return;                       // 这份夹具没有红矿 ⇒ 这条测不了
    const [rx, ry] = [red[0], red[1]];
    /* 矿机站在红矿上，输出朝上；上方一条带子朝上（把颜料运出去）。 */
    w.entities.push({ uid: next++, type: "miner", x: rx, y: ry, r: 0, variant: "default", rotation_variant: 0, code: 7, layer: "regular" });
    w.entities.push({ uid: next++, type: "belt", x: rx, y: ry - 1, r: 0, variant: "default", rotation_variant: 0, code: 1, layer: "regular" });

    const h = handlesOf(w);
    const rec = Object.freeze({
        ok: true,
        steps: [
            { op: "mine", hash: "CuCuCuCu", inputs: [], args: {} },
            { op: "mineColor", hash: "color:red", inputs: [], args: { color: "red" } },
            { op: "paint", hash: "CpCpCpCp", inputs: ["CuCuCuCu", "color:red"], args: { color: "red" } },
        ],
    });
    const carrying = beltsCarryingShape(w, rec, "color:red", h, { max: 4 });
    assert.ok(carrying.length > 0,
        `★ 红矿机上方那条带子必须被认成「运 color:red」—— 返回 0 说明矿种没加前缀`
        + `（矿种=${JSON.stringify(red[2])}）`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * M9 / M10 —— 「矿上已经有矿机了」必须说出来，且必须按**矿脉**分别数
 *
 * 真实缺陷（第 9 关真机 `r-20261112111044-e5b0`，2026-11-12）：
 *
 *   mixer `C7` 的两个 color 槽都空着。诊断连报 **7 轮**
 *   「先在那片矿区放一台矿机（insert_machine）」，模型照做 7 轮，
 *   蓝矿 19 格上挤了 **7 台矿机**、红矿 3 台，**一次都没接线**。
 *
 *   两个独立的错：
 *     ① `oreHint` 只说「矿在哪」，从不说「那儿已经有矿机了」
 *        ⇒ 模型每轮都以为要从零开始
 *     ② 后来改成数「该矿种上有几台矿机」，但把**不同矿脉**加在一起
 *        ⇒ 最近那片红矿区明明是空的，却报「红矿已有 3 台」
 *
 *   ①② 都会把模型推向「再放一台」，而正确动作分别是「接线」和「在空矿区放一台」。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 造一个带矿图的小世界：mixer 在原点附近，两种矿各一片。 */
function worldWithVeins(veins) {
    const w = clone(L4);
    let next = Math.max(...w.entities.map(e => e.uid)) + 1;
    const mx = 30, my = -30;                       // 离 L4 既有结构足够远
    const uid = () => next++;
    w.entities.push({
        uid: uid(), type: "mixer", x: mx, y: my, r: 0, variant: "default",
        rotation_variant: 0, code: 12, layer: "regular",
    });
    w.resources = [];
    const built = [];
    for (const v of veins) {
        for (const [x, y] of v.cells) w.resources.push([x, y, v.kind]);
        for (let i = 0; i < (v.miners || 0); i++) {
            const [x, y] = v.cells[i];
            w.entities.push({
                uid: uid(), type: "miner", x, y, r: 0, variant: "default",
                rotation_variant: 0, code: 7, layer: "regular",
            });
            built.push([x, y]);
        }
    }
    return { w, built, mixer: [mx, my] };
}

test("M9 ★ 矿上已有矿机时 hint 必须说「别再放」，不能只说「矿在哪」", () => {
    /* 蓝矿一整片 8 格，上面站着 4 台矿机；红矿一片，一台都没有。 */
    const blue = { kind: "blue", cells: [], miners: 4 };
    for (let x = 30; x <= 33; x++) for (let y = -26; y <= -25; y++) blue.cells.push([x, y]);
    const red = { kind: "red", cells: [], miners: 0 };
    for (let x = 20; x <= 23; x++) for (let y = -26; y <= -25; y++) red.cells.push([x, y]);
    const { w } = worldWithVeins([blue, red]);

    const ds = semanticDiagnoses(w, null, "CpCpCpCp", handlesOf(w), { recipe: RECIPE_PURPLE, level: 9 });
    const d = byCode(ds, "MIXER_UNFED")[0];
    assert.ok(d, "应当有 MIXER_UNFED");

    const site = k => d.evidence.ore_reach.find(s => s.pigment === `color:${k}`);
    assert.equal(site("blue").miners, 4, "蓝矿最近那片上有 4 台，必须数出来");
    assert.equal(site("red").miners, 0, "红矿最近那片上是空的");

    /* ★ 核心断言：蓝矿那句必须明确「别再放」，红矿那句必须指向 insert_machine ★ */
    /* ★ 断言的是**语义**，不是某一句具体措辞 ★
     *
     * 有断头时这条诊断走「去接线的另一端」那个分支，它会说
     * 「color:blue 的矿机（M1/M3/M2）输出口是空的，把它接到那条线的起点」——
     * 那**同样**是「别再放矿机了」，只是换了个说法（而且更可执行）。
     * 钉死某一句会把正确行为判红。 */
    assert.match(d.hint, /别再放|矿机已经在了|输出口空着|输出口是空的/,
        `已有矿机的矿种必须让模型知道「那台矿机可以用」，而不是再放一台。实得 hint：${d.hint}`);
    /* 关键：必须点名**已有矿机的句柄**，模型才知道接哪台 */
    assert.ok(d.hint.includes("M1") || d.hint.includes("M3") || d.hint.includes("M2"),
        `必须点名已有矿机的句柄（否则模型不知道接哪台）。实得：${d.hint}`);
    assert.match(d.hint, /一台矿机都没有/,
        "空矿区必须明确说「没有矿机」，否则模型不知道要放");
    assert.match(d.hint, /insert_machine/, "空矿区的动作是 insert_machine，必须点出来");
    assert.ok(d.candidates.includes("insert_machine"), "还有空矿区时 insert_machine 必须留在候选里");
});

test("M10 ★ 矿机计数必须按**矿脉**分开，不能把 44 格外的另一片算进来", () => {
    /* 这正是第 9 关的形态：red 在 (20..23,-26..-25)（近）和 (60..63,-26..-25)（远，有矿机）。
       把两片加在一起会报「红矿已有 4 台」，于是诊断认为红矿只差接线 ——
       而**最近那片其实是空的**，那 4 台在另一片矿区，接不过来。 */
    const blue = { kind: "blue", cells: [], miners: 2 };
    for (let x = 30; x <= 33; x++) for (let y = -24; y <= -23; y++) blue.cells.push([x, y]);
    const redNear = { kind: "red", cells: [], miners: 0 };
    for (let x = 20; x <= 23; x++) for (let y = -24; y <= -23; y++) redNear.cells.push([x, y]);
    const redFar = { kind: "red", cells: [], miners: 4 };
    for (let x = 50; x <= 53; x++) for (let y = -24; y <= -23; y++) redFar.cells.push([x, y]);
    const { w } = worldWithVeins([blue, redNear, redFar]);

    const ds = semanticDiagnoses(w, null, "CpCpCpCp", handlesOf(w), { recipe: RECIPE_PURPLE, level: 9 });
    const d = byCode(ds, "MIXER_UNFED")[0];
    assert.ok(d, "应当有 MIXER_UNFED");
    const red = d.evidence.ore_reach.find(s => s.pigment === "color:red");
    assert.equal(red.miners, 0,
        `最近那片红矿区是空的 ⇒ miners 必须是 0。实得 ${red.miners} `
        + `（把另一片矿区的矿机算进来了 ⇒ 模型会以为红矿只差接线）`);
    assert.equal(red.veins, 2, "两片矿区必须被识别成两条独立的矿脉");
    assert.equal(red.miners_anywhere, 4, "全图的台数仍要如实给出（作为参考）");
    /* 距离必须是**最近那片**的，不是远那片 */
    assert.ok(red.distance < 20, `最近的红矿区应该很近，实得 ${red.distance}`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * M11 / M12 —— 「带子对准了但没货」必须指出**上游断头**
 *
 * 真实缺陷（第 9 关实时 obs，2026-11-12 21:5x）：
 *
 *   mixer C7 的两个 color 槽，喂料带 `B207` / `B208` **方向完全正确**，
 *   也确实被 mixer 接受了 ⇒ `inputSlotValue` 返回 `why: null`。
 *   诊断于是只说 "no known incoming pigment"，模型看不出问题在哪。
 *
 *   真实原因是那条链有 **49 格**，一路开到 `(7,-32)` —— 那里什么都没有，
 *   是个断头。模型围着 mixer 这一端反复调端口，而该修的在 49 格外。
 *
 * 判据：从 feed 格反向走，走到「前一个格没有东西」为止，把
 *   · 走了多少格、
 *   · 源头是什么（空 / 裸带子 / 机器 / 环）
 * 都如实说出来。坐标不进 hint（硬约束），只进 evidence.upstream。
 * ══════════════════════════════════════════════════════════════════════════ */

test("M11 ★ 槽对准但上游断头 ⇒ observed 必须说「线有多长、源头是断的」", () => {
    /* 造一条 6 格的裸带子链，末端接到 mixer 的 color 槽。
       源头那格**没有东西喂它** —— 正是真机 (7,-32) 的形态。 */
    const w = clone(L4);
    let next = Math.max(...w.entities.map(e => e.uid)) + 1;
    const mx = 14, my = -30;
    w.entities.push({
        uid: next++, type: "mixer", x: mx, y: my, r: 0, variant: "default",
        rotation_variant: 0, code: 12, layer: "regular",
    });
    /* 槽 0 的 feed 格是 (mx, my+1)，mixer 要求那条带子**朝上**吐进 (mx, my)。
     *
     * ⚠️ `r=0` 的退出方向是 **top**（见 `beltExit`），不是「右」。第一版
     * 我以为 r=0 朝右、把链往右铺，结果那条带子根本没对准 mixer，
     * 测出来的是 `belt-not-aimed` 而不是「对准了但上游断头」——
     * 测的是一个完全不同的分支（连 validation 都过了但 ability=0 时才发现）。
     *
     * 正确铺法：**同一条竖线的上方**需要那条朝上的带子，而它的上游只能来自
     * 左右相邻格。所以让链横着铺，最右端那格朝上吐进槽里会撞到自己 —— 不行。
     * 改成：feed 格上是一条朝上的带子（r=0），它的上游在左边那些朝右的带子。
     * 但朝右的带子吐向右边，而 feed 格在它们右边 ⇒ 正好接上。 */
    w.entities.push({
        uid: next++, type: "belt", x: mx, y: my + 1, r: 0, variant: "default",
        rotation_variant: 0, code: 1, layer: "regular",   // 朝上吐进 mixer 槽
    });
    for (let k = 1; k <= 5; k++) {
        w.entities.push({
            uid: next++, type: "belt", x: mx - k, y: my + 1, r: 90, variant: "default",
            rotation_variant: 0, code: 1, layer: "regular",   // 朝右，把货推向下一条
        });
    }
    const ds = semanticDiagnoses(w, null, "CpCpCpCp", handlesOf(w), { recipe: RECIPE_PURPLE, level: 9 });
    const d = byCode(ds, "MIXER_UNFED")[0];
    assert.ok(d, "应当有 MIXER_UNFED");

    /* ★ 核心：observed 必须说到「源头断了」，不能只说 no known incoming pigment ★ */
    assert.match(d.observed, /DEAD-ENDS|starts at a bare belt|loops back/,
        `★ observed 必须指出上游断在哪 —— 只说 "no known incoming pigment" `
        + `对模型零信息（它会去调已经被接受的端口）。实际：${d.observed}`);
    assert.match(d.observed, /\d+ tile\(s\) long/, "必须给出上游长度（模型据此判断这是短线还是长支线）");

    /* evidence 里要有结构化数据 */
    assert.ok(Array.isArray(d.evidence.upstream), "evidence.upstream 必须是数组");
    const u0 = d.evidence.upstream[0];
    assert.ok(u0 && typeof u0.len === "number" && u0.len > 0, "槽 0 的上游格数要被量出来");
    assert.ok(["empty", "head", "machine", "loop", "too-long"].includes(u0.head),
        `head 必须是已知类型，实得 ${u0 && u0.head}`);
});

test("M12 ★ 断头信息必须排进 hint 前 180 字符（否则被「矿在哪」挤掉）", () => {
    /* prompt 只渲染 hint 前 180 字。第 9 关实测：`oreHint.text`（「蓝矿 5 格 /
       红矿 44 格」）有 100 多字符，把断头整段挤到 180 字之外，
       模型看到的全是矿的位置，而该修的是 49 格外的断头。 */
    const w = clone(L4);
    let next = Math.max(...w.entities.map(e => e.uid)) + 1;
    const mx = 14, my = -30;
    w.entities.push({
        uid: next++, type: "mixer", x: mx, y: my, r: 0, variant: "default",
        rotation_variant: 0, code: 12, layer: "regular",
    });
    for (let k = 0; k < 6; k++) {
        w.entities.push({
            uid: next++, type: "belt", x: mx + k, y: my + 1, r: 0, variant: "default",
            rotation_variant: 0, code: 1, layer: "regular",
        });
    }
    const ds = semanticDiagnoses(w, null, "CpCpCpCp", handlesOf(w), { recipe: RECIPE_PURPLE, level: 9 });
    const d = byCode(ds, "MIXER_UNFED")[0];
    assert.ok(d, "应当有 MIXER_UNFED");
    const head = d.hint.slice(0, 180);
    assert.match(head, /断的|断了|断头|DEAD-ENDS|dead-end/i,
        `★ 断头必须在前 180 字符里出现，否则 prompt 会把它截掉。实际前 180 字：${head}`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * M14 —— 断头线的**源头句柄**必须送到 prompt 里
 *
 * 真实缺陷（第 9 关 r-20261112184112-017a，2026-11-12）：
 * 模型四轮全在说「我要从空闲矿机接到那条线的源头」—— **它理解对了**。
 * 但四轮四种写法全被拒：target_already_fed / bad_type / occupied / ambiguous_port。
 *
 * 因为它只有句柄、没有坐标，而诊断只说了「上游 49 格」，**没说那一格叫什么**。
 * 模型只能猜，猜法每次不同。
 *
 * 源头那一格其实是**一条带子**（B57），有句柄 —— 只是没人告诉它。
 * ══════════════════════════════════════════════════════════════════════════ */

test("M14 ★ 断头线的源头句柄必须出现在 hint 里（否则模型只能猜着 connect）", () => {
    const w = clone(L4);
    let next = Math.max(...w.entities.map(e => e.uid)) + 1;
    const mx = 14, my = -30;
    w.entities.push({
        uid: next++, type: "mixer", x: mx, y: my, r: 0, variant: "default",
        rotation_variant: 0, code: 12, layer: "regular",
    });
    /* feed 格上那条朝上的带子，它自己就是流头（上游是空地）。 */
    const headUid = next++;
    w.entities.push({
        uid: headUid, type: "belt", x: mx, y: my + 1, r: 0, variant: "default",
        rotation_variant: 0, code: 1, layer: "regular",
    });
    const h = handlesOf(w);
    const ds = semanticDiagnoses(w, null, "CpCpCpCp", h, { recipe: RECIPE_PURPLE, level: 9 });
    const d = byCode(ds, "MIXER_UNFED")[0];
    assert.ok(d, "应当有 MIXER_UNFED");

    const u0 = d.evidence.upstream[0];
    assert.ok(u0 && typeof u0.head_handle === "string" && u0.head_handle.length,
        `★ evidence.upstream 必须带源头句柄。实得：${JSON.stringify(u0)}`);
    assert.match(d.hint, new RegExp(u0.head_handle),
        `★ hint 必须点名源头那一格（${u0.head_handle}）—— `
        + `只说「上游 N 格」模型不知道该指哪。实际：${d.hint}`);
    assert.ok(d.hint.slice(0, 180).includes(u0.head_handle),
        `源头句柄必须在前 180 字里（prompt 只渲染那么多）。实际前 180：${d.hint.slice(0, 180)}`);
});

test("M15 对照：源头是空地（不是带子）时，不许编一个句柄", () => {
    /* 如果那条线的源头格上**什么都没有**，就没有句柄可说。
       这时如实说「最上游那一格」，绝不编一个不存在的句柄 ——
       编了会让模型去 connect 一个不存在的对象。 */
    const w = clone(L4);
    let next = Math.max(...w.entities.map(e => e.uid)) + 1;
    const mx = 14, my = -30;
    w.entities.push({
        uid: next++, type: "mixer", x: mx, y: my, r: 0, variant: "default",
        rotation_variant: 0, code: 12, layer: "regular",
    });
    /* feed 格是空地 —— 这条槽压根没接东西。 */
    const ds = semanticDiagnoses(w, null, "CpCpCpCp", handlesOf(w), { recipe: RECIPE_PURPLE, level: 9 });
    const d = byCode(ds, "MIXER_UNFED")[0];
    assert.ok(d, "应当有 MIXER_UNFED");
    const u0 = d.evidence.upstream[0];
    assert.ok(!u0 || !u0.head_handle, `源头是空地时不该有 head_handle，实得 ${JSON.stringify(u0)}`);
    assert.ok(!/to:\{ref:""\}/.test(d.hint), "不许出现空的 ref");
});

/* ══════════════════════════════════════════════════════════════════════════
 * M16 —— 断头线太长时，正确动作是**抢槽就近接**，不是去修那条长线
 *
 * 真机 r-20261112190707-de26 → r-20261112193013-99fb（第 9 关）：
 *   诊断说「起点是 B57，把它接上」，模型照做，一次铺了 57 格；
 *   下一轮上游从 49 格涨到 **106 格** —— 它接到的地方又是一条新断头。
 *
 * 而真相是：矿机 M2 离 mixer 只有 **5 格**，那条线却有 106 格。
 * 正确动作是 `connect {from:M2, to:C7, port:{role:"color",index:0}, opts:{rebind:true}}`，
 * 5 格搞定（离线实测 len=5/6，两次都 OK）。
 *
 * 判据：断头线长度 > 最近矿机距离 × 3 ⇒ 修线就是绕远路。
 * ⚠️ 用 `some` 不是 `every` —— 第 9 关的形态是 106 格 + 3 格并存，
 * `every` 会因为那个正常的 3 格槽而整条判假（第一版就是这么错的）。
 * ══════════════════════════════════════════════════════════════════════════ */

test("M16 ★ 断头线比矿机距离长一个数量级 ⇒ 建议 rebind 抢槽，不是去修那条线", () => {
    const w = clone(L4);
    let next = Math.max(...w.entities.map(e => e.uid)) + 1;
    const mx = 40, my = -40;
    w.entities.push({
        uid: next++, type: "mixer", x: mx, y: my, r: 0, variant: "default",
        rotation_variant: 0, code: 12, layer: "regular",
    });
    /* 槽 0 的 feed 格上拉一条**很长的**断头线（30 格，全是朝上/朝右的裸带子）。 */
    w.entities.push({
        uid: next++, type: "belt", x: mx, y: my + 1, r: 0, variant: "default",
        rotation_variant: 0, code: 1, layer: "regular",
    });
    for (let k = 1; k <= 30; k++) {
        w.entities.push({
            uid: next++, type: "belt", x: mx - k, y: my + 1, r: 90, variant: "default",
            rotation_variant: 0, code: 1, layer: "regular",
        });
    }
    /* 蓝矿就在 mixer 旁边 3 格，上面站一台矿机 —— 正是「矿机很近、线很长」的形态。 */
    w.resources = [];
    for (let x = mx; x <= mx + 2; x++) for (let y = my - 3; y <= my - 2; y++) w.resources.push([x, y, "blue"]);
    const minerUid = next++;
    w.entities.push({
        uid: minerUid, type: "miner", x: mx, y: my - 3, r: 0, variant: "default",
        rotation_variant: 0, code: 7, layer: "regular",
    });
    /* 红矿远一点，但也要有（配方要两种）。 */
    for (let x = mx; x <= mx + 2; x++) for (let y = my - 10; y <= my - 9; y++) w.resources.push([x, y, "red"]);

    const ds = semanticDiagnoses(w, null, "CpCpCpCp", handlesOf(w), { recipe: RECIPE_PURPLE, level: 9 });
    const d = byCode(ds, "MIXER_UNFED")[0];
    assert.ok(d, "应当有 MIXER_UNFED");

    /* ★ 核心：必须建议 rebind 抢槽，而不是「去修那条长线」 ★ */
    assert.match(d.hint, /rebind/,
        `★ 线比矿机远一个数量级时，正确动作是 rebind 抢槽，不是去修那条线。`
        + `实际 hint：${d.hint}`);
    assert.match(d.hint, /别.{0,6}修.{0,12}线/,
        `必须明确说「别去修那条线」—— 否则模型会像真机那样一路把它铺下去`);
    assert.ok(!/起点是 `B\d+`/.test(d.hint),
        `★ 线太长时**不许**再指「起点是 Bxx」—— 那正是让模型铺 57 格的指令。`
        + `实际：${d.hint}`);
});

test("M17 对照：断头线**短**时，仍应建议接到它的源头（别一律 rebind）", () => {
    /* 线只比矿机远一点点时，「接到它的源头」是对的做法 ——
       rebind 会把一条本来好好的线断掉。这条防止 M16 的收紧做过头。 */
    const w = clone(L4);
    let next = Math.max(...w.entities.map(e => e.uid)) + 1;
    const mx = 40, my = -40;
    w.entities.push({
        uid: next++, type: "mixer", x: mx, y: my, r: 0, variant: "default",
        rotation_variant: 0, code: 12, layer: "regular",
    });
    /* 短链：只有 2 格 */
    w.entities.push({
        uid: next++, type: "belt", x: mx, y: my + 1, r: 0, variant: "default",
        rotation_variant: 0, code: 1, layer: "regular",
    });
    w.entities.push({
        uid: next++, type: "belt", x: mx - 1, y: my + 1, r: 90, variant: "default",
        rotation_variant: 0, code: 1, layer: "regular",
    });
    w.resources = [];
    for (let x = mx; x <= mx + 2; x++) for (let y = my - 3; y <= my - 2; y++) w.resources.push([x, y, "blue"]);
    w.entities.push({
        uid: next++, type: "miner", x: mx, y: my - 3, r: 0, variant: "default",
        rotation_variant: 0, code: 7, layer: "regular",
    });
    for (let x = mx; x <= mx + 2; x++) for (let y = my - 10; y <= my - 9; y++) w.resources.push([x, y, "red"]);

    const ds = semanticDiagnoses(w, null, "CpCpCpCp", handlesOf(w), { recipe: RECIPE_PURPLE, level: 9 });
    const d = byCode(ds, "MIXER_UNFED")[0];
    assert.ok(d, "应当有 MIXER_UNFED");
    assert.match(d.hint, /起点是|另一头/,
        `短线时应当指「接到线的源头」，实得：${d.hint}`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * M18 —— 建议 rebind 时必须同时警告**不要** allow_replace
 *
 * 真机 r-20261112194710-c92a（第 9 关）：模型照 hint 写了
 *   connect {from:M2, to:C7, port:{role:"color",index:0}, opts:{rebind:true}}
 * 并把槽抢了回来 —— 但它自己**又加了** `allow_replace:true`。
 *
 * `allow_replace` 允许宏重铺 feed 格上的带子，于是那两条带子被改成
 * `r=270`（朝左），而 mixer 要的是朝上 ⇒ slot 1 变成 `belt-not-aimed`，
 * 两个槽一起废掉。整轮 `churn`（等价替换），目标没动。
 *
 * 修法：抢槽只需要 `rebind`，绝不能带 `allow_replace`。hint 必须说出来。
 * ══════════════════════════════════════════════════════════════════════════ */
test("M18 ★ 建议 rebind 抢槽时，必须警告不要加 allow_replace", () => {
    const w = clone(L4);
    let next = Math.max(...w.entities.map(e => e.uid)) + 1;
    const mx = 40, my = -40;
    w.entities.push({
        uid: next++, type: "mixer", x: mx, y: my, r: 0, variant: "default",
        rotation_variant: 0, code: 12, layer: "regular",
    });
    /* 长断头线（30 格）—— 触发 rebind 分支 */
    w.entities.push({
        uid: next++, type: "belt", x: mx, y: my + 1, r: 0, variant: "default",
        rotation_variant: 0, code: 1, layer: "regular",
    });
    for (let k = 1; k <= 30; k++) {
        w.entities.push({
            uid: next++, type: "belt", x: mx - k, y: my + 1, r: 90, variant: "default",
            rotation_variant: 0, code: 1, layer: "regular",
        });
    }
    w.resources = [];
    for (let x = mx; x <= mx + 2; x++) for (let y = my - 3; y <= my - 2; y++) w.resources.push([x, y, "blue"]);
    w.entities.push({
        uid: next++, type: "miner", x: mx, y: my - 3, r: 0, variant: "default",
        rotation_variant: 0, code: 7, layer: "regular",
    });
    for (let x = mx; x <= mx + 2; x++) for (let y = my - 10; y <= my - 9; y++) w.resources.push([x, y, "red"]);

    const ds = semanticDiagnoses(w, null, "CpCpCpCp", handlesOf(w), { recipe: RECIPE_PURPLE, level: 9 });
    const d = byCode(ds, "MIXER_UNFED")[0];
    assert.ok(d, "应当有 MIXER_UNFED");
    assert.match(d.hint, /rebind/, "必须建议 rebind");
    /* ★ 核心：必须显式警告不要 allow_replace ★ */
    assert.match(d.hint, /不要.*allow_replace|别加.*allow_replace/,
        `★ 抢槽只能带 rebind —— 加 allow_replace 会重铺 feed 格的带子、`
        + `把朝向改坏（真机 r-20261112194710-c92a 两个槽一起废掉就是因为它）。`
        + `实际 hint：${d.hint}`);
    /* 警告也要尽量靠前（prompt 只渲染 180 字） */
    assert.ok(/allow_replace/.test(d.hint.slice(0, 320)),
        `allow_replace 的警告不能被推到 320 字之后（会被 prompt 截掉）。实际：${d.hint}`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * M19 —— 建议就近抢槽时，必须提醒「两个槽分开接」
 *
 * 真机 r-20261112202028-8e5a（第 9 关）：模型照 hint 写了
 *   connect {from:M2, to:C7, port:{role:"color",index:0}, opts:{rebind:true}}
 * 这次**没加** allow_replace（上一条修复生效了），connect 也成功了。
 *
 * 但 slot 0 那 5 格路正好穿过 slot 1 的喂料格 (35,-12)：
 *   · slot 0 落盘正确（code=3 corner，exitDir=top）✅
 *   · slot 1 被覆盖成 code=1 直线、exit=left ⇒ 货吐回 slot 0 的格子 ❌
 * 两个槽一起废掉，整轮 `churn`。
 *
 * 离线实测：`M6 → slot1` 只要 5 格且能成功 —— 正确做法是**一次接两个不同的矿机**。
 * ══════════════════════════════════════════════════════════════════════════ */
test("M19 ★ 建议抢槽时必须提醒「两个槽分开接、用不同矿机」", () => {
    const w = clone(L4);
    let next = Math.max(...w.entities.map(e => e.uid)) + 1;
    const mx = 40, my = -40;
    w.entities.push({
        uid: next++, type: "mixer", x: mx, y: my, r: 0, variant: "default",
        rotation_variant: 0, code: 12, layer: "regular",
    });
    w.entities.push({
        uid: next++, type: "belt", x: mx, y: my + 1, r: 0, variant: "default",
        rotation_variant: 0, code: 1, layer: "regular",
    });
    for (let k = 1; k <= 30; k++) {
        w.entities.push({
            uid: next++, type: "belt", x: mx - k, y: my + 1, r: 90, variant: "default",
            rotation_variant: 0, code: 1, layer: "regular",
        });
    }
    w.resources = [];
    for (let x = mx; x <= mx + 2; x++) for (let y = my - 3; y <= my - 2; y++) w.resources.push([x, y, "blue"]);
    w.entities.push({
        uid: next++, type: "miner", x: mx, y: my - 3, r: 0, variant: "default",
        rotation_variant: 0, code: 7, layer: "regular",
    });
    for (let x = mx; x <= mx + 2; x++) for (let y = my - 10; y <= my - 9; y++) w.resources.push([x, y, "red"]);

    const ds = semanticDiagnoses(w, null, "CpCpCpCp", handlesOf(w), { recipe: RECIPE_PURPLE, level: 9 });
    const d = byCode(ds, "MIXER_UNFED")[0];
    assert.ok(d, "应当有 MIXER_UNFED");
    assert.match(d.hint, /两个槽|另一个槽|分开接/,
        `★ 必须提醒两个槽要分开接 —— 只接一个的话，路径会穿过另一个槽的喂料格 `
        + `把它覆盖成死线（真机 r-20261112202028-8e5a 两个槽一起废掉）。实际：${d.hint}`);
    /* 这条必须在 prompt 的渲染窗口内 */
    assert.ok(/两个槽|另一个槽/.test(d.hint.slice(0, 220)),
        `「两个槽分开接」必须靠近前面（prompt 只渲染 180 字）。实际前 220：${d.hint.slice(0, 220)}`);
});
/* 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲
 * M20 鈥斺€?`slot_values` 蹇呴』鐪熺殑璇诲埌褰㈢姸浼犳挱鐨勭粨鏋? *
 * 鐪熸満锛堢 9 鍏筹紝2026-11-13锛夛細M6/M2 涓ゅ彴鐭挎満閮藉湪钃濈熆涓娿€佹暣鏉″杺鏂欓摼
 * 姣忚烦 `sameCell` 涓?`accepts` 鍏ㄩ儴閫氳繃銆乣computeOut` 涔熺‘瀹炶繑鍥炰簡 `color:blue`
 * 锛堝姞鏃ュ織纭杩囷細`[beltValue] 12210 => color:blue`锛夛紝
 * 浣?`MIXER_UNFED` 鐨?`slot_values` 鎭掍负 `[null, null]`銆? *
 * 鏍瑰洜锛歚makeShapeEngine` 鍏ㄧ▼鐢?**Set**锛岃€岃繖閲屽啓鐨勬槸 `Array.isArray(f.value)`鈥斺€? * `Array.isArray(new Set(...))` 鎭掍负 false 鈬?涓や釜妲芥案杩滆В鏋愭垚 null
 * 鈬?璇婃柇姘歌繙璇淬€屾簮澶存柇浜嗐€嶁噿 妯″瀷鍙嶅閲嶆帴**宸茬粡鎺ュソ鐨勭嚎**銆? *
 * 杩欐潯 bug 浠?`MIXER_UNFED` 鍐欏嚭鏉ラ偅澶╁氨鍦紝涔嬪墠涓€鐩磋鏇存棭鐨勬柇鐐归伄浣忥細
 *   鈶?`$ore` 閫夐敊鐭匡紙鏀惧埌 44 鏍煎鐨勫彟涓€鐗囷級锛? *   鈶?`computeOut` 鐨?`rot !== 0` 鎶婄熆鏈鸿緭鍑烘帎鏂紱
 *   鈶?`upstreamOf` 璧伴敊閭诲眳锛堜袱涓偦灞呴兘澹扮О鎸囧悜鍚屼竴鏍兼椂涓嶇湅鑷繁鐨勫叆鍙ｆ柟鍚戯級銆? * 鎶婁笂娓稿叏淇ソ涔嬪悗瀹冩墠闇插嚭鏉?鈥斺€?涔熸鍥犱负濡傛锛屽畠鏄渶闅惧畾浣嶇殑涓€灞傘€? * 鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲 */

/* ══════════════════════════════════════════════════════════════════════════
 * M20 —— `slot_values` 必须真的读到形状传播的结果
 *
 * 真机（第 9 关，2026-11-13）：M6/M2 两台矿机都在蓝矿上、整条喂料链
 * 每跳 `sameCell` 与 `accepts` 全部通过、`computeOut` 也确实返回了 `color:blue`
 * （加日志确认过：`[beltValue] 12210 => color:blue`），
 * 但 `MIXER_UNFED` 的 `slot_values` 恒为 `[null, null]`。
 *
 * 根因：`makeShapeEngine` 全程用 **Set**，而这里写的是 `Array.isArray(f.value)` ——
 * `Array.isArray(new Set(...))` 恒为 false ⇒ 两个槽永远解析成 null
 * ⇒ 诊断永远说「源头断了」⇒ 模型反复重接**已经接好的线**。
 *
 * 这条 bug 从 `MIXER_UNFED` 写出来那天就在，之前一直被更早的断点遮住：
 *   ① `$ore` 选错矿（放到 44 格外的另一片）；
 *   ② `computeOut` 的 `rot !== 0` 把矿机输出掐断；
 *   ③ `upstreamOf` 走错邻居（两个邻居都声称指向同一格时不看自己的入口方向）。
 * 把上游全修好之后它才露出来 —— 也正因为如此，它是最难定位的一层。
 * ══════════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════════
 * M20 —— slot_values 必须真的读到形状传播的结果
 *
 * 真机（第 9 关，2026-11-13）：M6/M2 两台矿机都在蓝矿上、整条喂料链
 * 每跳 sameCell 与 accepts 全部通过、computeOut 也确实返回了 color:blue
 * （加日志确认过：beltValue 12210 => color:blue），
 * 但 MIXER_UNFED 的 slot_values 恒为 [null, null]。
 *
 * 根因：makeShapeEngine 全程用 Set，而这里写的是 Array.isArray(f.value) ——
 * Array.isArray(new Set(...)) 恒为 false ⇒ 两个槽永远解析成 null
 * ⇒ 诊断永远说「源头断了」⇒ 模型反复重接已经接好的线。
 *
 * 这条 bug 从 MIXER_UNFED 写出来那天就在，之前一直被更早的断点遮住：
 *   ① $ore 选错矿（放到 44 格外的另一片）；
 *   ② computeOut 的 rot !== 0 把矿机输出掐断；
 *   ③ upstreamOf 走错邻居（两个邻居都声称指向同一格时不看自己的入口方向）。
 * 把上游全修好之后它才露出来 —— 也正因为如此，它是最难定位的一层。
 * ══════════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════════
 * M20 —— slot_values 必须真的读到形状传播的结果
 *
 * 真机（第 9 关，2026-11-13）：M6/M2 两台矿机都在蓝矿上、整条喂料链
 * 每跳 sameCell 与 accepts 全部通过、computeOut 也确实返回了 color:blue
 * （加日志确认过：beltValue 12210 => color:blue），
 * 但 MIXER_UNFED 的 slot_values 恒为 [null, null]。
 *
 * 根因：makeShapeEngine 全程用 Set，而这里写的是 Array.isArray(f.value) ——
 * Array.isArray(new Set(...)) 恒为 false ⇒ 两个槽永远解析成 null
 * ⇒ 诊断永远说「源头断了」⇒ 模型反复重接已经接好的线。
 *
 * 这条 bug 从 MIXER_UNFED 写出来那天就在，之前一直被更早的断点遮住：
 *   ① $ore 选错矿（放到 44 格外的另一片）；
 *   ② computeOut 的 rot !== 0 把矿机输出掐断；
 *   ③ upstreamOf 走错邻居（两个邻居都声称指向同一格时不看自己的入口方向）。
 * 把上游全修好之后它才露出来 —— 也正因为如此，它是最难定位的一层。
 *
 * 几何（r=0 的 exit 是 top=y-1，r=180 的 exit 是 bottom=y+1）：
 *   mixer (mx,my)  两个 color 槽的 feed 格在 (mx,my+1) / (mx+1,my+1)，即**下方**
 *   ⇒ 货要从下往上推 ⇒ 链上每条带子都是 r=0（exit=top）
 *   ⇒ 矿机在更南边 (mx, my+7)，r=180 朝下喂第一条
 * ══════════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════════
 * M20 —— slot_values 必须真的读到形状传播的结果
 *
 * 真机（第 9 关，2026-11-13）：M6/M2 两台矿机都在蓝矿上、整条喂料链
 * 每跳 sameCell 与 accepts 全部通过、computeOut 也确实返回了 color:blue
 * （加日志确认过：beltValue 12210 => color:blue），
 * 但 MIXER_UNFED 的 slot_values 恒为 [null, null]。
 *
 * 根因：makeShapeEngine 全程用 Set，而这里写的是 Array.isArray(f.value) ——
 * Array.isArray(new Set(...)) 恒为 false ⇒ 两个槽永远解析成 null
 * ⇒ 诊断永远说「源头断了」⇒ 模型反复重接已经接好的线。
 *
 * 这条 bug 从 MIXER_UNFED 写出来那天就在，之前一直被更早的断点遮住
 * （$ore 选错矿 / rot !== 0 掐断矿机 / upstreamOf 走错邻居）。
 * 把上游全修好之后它才露出来 —— 也正因为如此，它是最难定位的一层。
 *
 * 夹具用**真机 obs 快照**（test/fixtures/saves/level9-mixer-obs.json）：
 * 那一份里 M6/M2 的喂料链是通的，正是 bug 的现场。
 * 手搓夹具试过两次都失败（r=0 的 exit 是 top 不是 bottom，很容易搞反）。
 * ══════════════════════════════════════════════════════════════════════════ */
test("M20 ★ 蓝矿机喂一条链 ⇒ slot_values 必须是 color:blue（不是 null）", () => {
    const f = path.join(SAVES, "level9-mixer-obs.json");
    if (!fs.existsSync(f)) {
        /* 夹具是一次性快照，不进仓库时跳过并说明原因（不静默假绿）。 */
        console.log("  (skip) 缺 level9-mixer-obs.json 快照 —— 这条测不了");
        return;
    }
    const w = JSON.parse(fs.readFileSync(f, "utf8"));
    const ds = semanticDiagnoses(w, null, "CpCpCpCp", handlesOf(w), { recipe: RECIPE_PURPLE, level: 9 });
    const d = byCode(ds, "MIXER_UNFED")[0];
    assert.ok(d, "快照里应当有 MIXER_UNFED");

    const vals = d.evidence.slot_values;
    assert.ok(Array.isArray(vals), "slot_values 必须是数组");
    assert.equal(vals[0], "color:blue",
        "槽 0 喂的是蓝矿机，必须解析成 color:blue。"
        + " null 说明形状传播的结果没被读到（Set 被当成非数组）。实际：" + JSON.stringify(vals)
        + " observed=" + d.observed);
});

/* ══════════════════════════════════════════════════════════════════════════
 * M21 —— 废线堆成山时必须报 DEAD_LINES
 *
 * 用户 2026-11-13 直接指着屏幕说「这么多废弃的路线都没有拆」。
 * 那一刻的世界：646 条带子里 **403 条到不了 hub**（72%）。
 *
 * V-health 早就在数这个数（「死带子 480」），但它只是个**健康度指标** ——
 * 判红之后既不回滚、也不产生任何可执行动作。这是「测出来了 ≠ 有人去修」。
 *
 * 判据：hubReachable 反推出来的集合就是「能到 hub 的实体」；
 * 不在里面、且下游没有机器在吃的，就是纯废。
 * ⚠️ 聚成**一条**诊断（给总数 + 最密三片），不逐条报 ——
 *    403 条按每码 ≤3 的额度只会出 3 条，模型看不出规模。
 * ══════════════════════════════════════════════════════════════════════════ */
test("M21 ★ 大量带子到不了 hub ⇒ DEAD_LINES（一条，给总数和最密三片）", () => {
    const f = path.join(SAVES, "level9-mixer-obs.json");
    if (!fs.existsSync(f)) { console.log("  (skip) 缺 level9-mixer-obs.json 快照"); return; }
    const w = JSON.parse(fs.readFileSync(f, "utf8"));
    const ds = semanticDiagnoses(w, null, "CpCpCpCp", handlesOf(w), { recipe: RECIPE_PURPLE, level: 9 });
    const dl = byCode(ds, "DEAD_LINES")[0];
    assert.ok(dl, "那份快照有 43% 的带子到不了 hub，必须报 DEAD_LINES。codes=" + ds.map(d => d.code).join(","));
    assert.equal(dl.severity, "warn", "地形问题不该挤掉 blocker");
    assert.ok(dl.evidence.dead_count > 100,
        "必须给出废线总数，实得 " + dl.evidence.dead_count);
    assert.ok(dl.evidence.ratio > 0.3, "必须给出占比，实得 " + dl.evidence.ratio);
    assert.ok(Array.isArray(dl.evidence.patches) && dl.evidence.patches.length > 0,
        "必须给出最密的几片（remove_run 一片一片拆的对象）");
    /* 判据必须能被满足：提示要指向 remove_run */
    assert.ok(dl.candidates.includes("remove_run"), "首要修法是 remove_run");
    assert.match(dl.hint, /remove_run/, "hint 要给出可执行的拆法");
});

test("M22 对照：干净的世界不报 DEAD_LINES（不许把正常世界判成垃圾堆）", () => {
    /* 清理之后 159/159 条带子都能到 hub —— 这时必须闭嘴，
       否则模型会去拆自己的正解。 */
    const f = path.join(SAVES, "level9-clean-obs.json");
    if (!fs.existsSync(f)) { console.log("  (skip) 缺 level9-clean-obs.json 快照"); return; }
    const w = JSON.parse(fs.readFileSync(f, "utf8"));
    const ds = semanticDiagnoses(w, null, "CpCpCpCp", handlesOf(w), { recipe: RECIPE_PURPLE, level: 9 });
    assert.equal(byCode(ds, "DEAD_LINES").length, 0,
        "干净世界不该报 DEAD_LINES。codes=" + ds.map(d => d.code).join(","));
});
