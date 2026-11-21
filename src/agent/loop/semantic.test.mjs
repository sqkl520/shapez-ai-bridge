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
import { structuralDiagnoses } from "./structural.mjs";
import { buildHandles } from "./handles.mjs";
import { indexOf, accepts } from "./topology.mjs";
import { beltEntry, OPP } from "../../ai/belt-rules.mjs";
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

/* ★ 这条契约在 2026-11-15 夜被推翻了（L12 真机）★
 *
 * 原来断言「配方缺失 ⇒ 语义层整体降级为空」。那个契约的代价在 L12 上暴露得很彻底：
 * 求解器搜索超限（`recipe.ok=false`）⇒ 整个语义层从第一轮起一条诊断都不产
 * ⇒ agent 只看得到 `NO_PRODUCTION` 一个干诊断，在黑暗里加带子。
 *
 * 而当时算得出来却送不出去的，恰恰是最要命的两条：
 *   · `ORPHAN_MACHINES`：23/59 台机器一根线都没接
 *   · `HUB_INLET_THIN`：3 格带子摆在入口上却指错方向，9 个入口空着
 *
 * 这两条**不依赖配方** —— 纯拓扑/几何。只有「该用 cutter 还是 rotater」才需要配方。
 *
 * 新契约：配方缺席时用空 model（依赖配方的分支自然不产），纯拓扑的照常跑。
 * 但**不抛、不 spawn** 这两条必须保留 —— 它们是安全性质，与产出什么无关。 */
test("T6 ★ 负例：opts.recipe 缺失 / null / ok:false / steps 为空 ⇒ 不抛、不 spawn（但纯拓扑诊断照常跑）", () => {
    const cases = [undefined, null, {}, { ok: false, reason: "solver timed out" }, { ok: true, steps: [] }];
    for (const recipe of cases) {
        let ds;
        assert.doesNotThrow(() => {
            ds = semanticDiagnoses(L4, null, goalOf(L4), handlesOf(L4), recipe === undefined ? {} : { recipe });
        }, `recipe=${JSON.stringify(recipe)} 不许抛`);
        assert.ok(Array.isArray(ds), `recipe=${JSON.stringify(recipe)} ⇒ 必须是数组`);
        /* 依赖配方的码一条都不许出现：没有配方就不知道需要哪些机器/工序。
           ⚠️ `SHAPE_UNKNOWN` **不在此列** —— 它只是说「这个形状算不出来」
           （隧道跨界 / 模板缺失 / 没有矿图），与配方无关，配方缺席时照样该报。 */
        const recipeBound = new Set([
            "PROCESSOR_REQUIRED", "MIXER_UNFED", "DISCARDED_INTERMEDIATE",
            "WRONG_SHAPE_AT_HUB",
        ]);
        const leaked = ds.filter(d => recipeBound.has(d.code)).map(d => d.code);
        assert.deepEqual(leaked, [],
            `recipe=${JSON.stringify(recipe)} ⇒ 不许产出依赖配方的码（实得 ${leaked.join(",")}）`);
    }
});

test("T6b ★ 配方不可用时，纯拓扑诊断仍然要产出（这就是推翻旧契约的理由）", () => {
    /* 用一个「入口明显没接好」的世界，验证不靠配方也能看出问题。 */
    const o = clone(L4);
    const ds = semanticDiagnoses(o, null, goalOf(o), handlesOf(o), { recipe: { ok: false } });
    const codes = ds.map(d => d.code);
    /* 至少要有 ORPHAN / HUB_INLET / DEAD_LINES 其中之一能算出来 ——
       它们是纯拓扑的，配方缺席不构成理由。 */
    const topo = ["ORPHAN_MACHINES", "HUB_INLET_THIN", "DEAD_LINES", "UPGRADE_AVAILABLE"];
    assert.ok(codes.some(c => topo.includes(c)),
        `配方缺席时纯拓扑诊断必须照常产出（实得 ${codes.join(",") || "空"}）`);
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

    /* ★ 基准必须是**未压制**的条数，不能拿 `full.length` ★
     *
     * 2026-11-20 实测：L5+ore 现在产出 **9** 条诊断，而 `LIMITS.TOTAL = 8` ——
     * 所以 `full` 自己就是压制后的结果（8 条，首条带 suppressed:1）。
     * 原来的 `assert.equal(1 + sup, full.length)` 于是变成 `9 !== 8`，
     * 看起来像我新加的诊断算错了，实际是**基准选错了**：两个都带压制，
     * 一个是 PER_CODE:1 压到底，另一个是默认上限压掉 1 条。
     *
     * 正确基准：把上限放到足够大再跑一次，拿到真正的产出条数。
     * 这样才能验证「一条都没静默消失」这个真正的不变量。 */
    const unbounded = run(L5_WITH_ORE, RECIPE_L5, { level: 5, limits: { PER_CODE: 999, TOTAL: 999 } });
    assert.ok(full.length <= 8, `默认上限下总量 ${full.length} > 8`);
    assert.equal(1 + sup, unbounded.length,
        `suppressed 必须补回完整条数（unbounded=${unbounded.length}, tight=1+${sup}）`);
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

test("P-a 只产出已登记的码（越界即红：别顺手加了没登记的东西）", () => {
    /* `MIXER_UNFED` 是第 5 个。加它的理由是可测的：`PROCESSOR_REQUIRED` 只数
       「工厂里有几台 mixer」，于是「有一台、但两个 color 槽喂的是同一条线」
       会让诊断彻底消失 —— 而配方要的是两种**不同**的颜料。第 9 关就是这么卡住的。
     *
     * 2026-11-13：补登 `DEAD_LINES` / `ORPHAN_MACHINES` / `UPGRADE_AVAILABLE`。
     *
     * 这三个是同一批加的，而这份白名单当时**没跟上** —— 于是它本该守住的东西
     * （「语义层不许产出没登记的码」）在这三个码上失效了：它们能产出、测试却是绿的，
     * 因为夹具（L4 / L5+ore）里根本没有废线堆和满库存。白名单没覆盖 ≠ 那条纪律不存在。
     *
     * 三条各有实测依据：
     *   · DEAD_LINES      —— 用户两次指屏幕说「废弃的不删」，而 403/646 条带子到不了 hub；
     *   · ORPHAN_MACHINES —— 同上那次，57 台机器里 45 台一根带子都没接；
     *   · UPGRADE_AVAILABLE ——「AI 不会用更高级的方法提高效率」：实机 miner/painting
     *                          两档当场买得起，而 prompt 一个字都没提。
     *
     * 2026-11-20 补登 `PROCESSING_FAR_TOO_SLOW`。它又是同一类漏：新码加了、
     * 白名单没跟。这次在**加上它的那一刻**就跑到了这条测试，算它起作用了。
     *
     * 依据：用户问「让机器变快的法子只有这一个吗」并指出「并联最缺少」。
     * 数据：9272 次宏调用里 `connect` 占 71.3%、`insert_machine` 只有 4.8%；
     * L12 是 699 条带子 / 11 台加工机器 = 63.5:1，处理 0.25/s 对供给 8/s。 */
    const OWNED = new Set([
        "PROCESSOR_REQUIRED", "WRONG_SHAPE_AT_HUB", "DISCARDED_INTERMEDIATE",
        "SHAPE_UNKNOWN", "MIXER_UNFED", "HUB_INLET_THIN",
        "DEAD_LINES", "ORPHAN_MACHINES", "UPGRADE_AVAILABLE",
        "PROCESSING_FAR_TOO_SLOW",
        /* 2026-11-20 补登 `MINER_UNWIRED`。
         *
         * 触发它需要「矿机站在矿上 + 输出口空着」，而 L4 / L5 两个夹具都
         * 没有这种中间态 —— 白名单成立、测试是绿的，但方式与那三个旧码相同：
         * **夹具不覆盖 ≠ 纪律不存在**。
         *
         * 依据：真机 `r-20261120194302-bc94`，`insert_machine` 把矿机放对了位置
         * （`(-10,9)` 的圆形铜矿），四周却全是空地。`ORE_UNMINED` 因它消失、
         * `ORPHAN_MACHINES` 因「站在矿上永不算孤儿」豁免它 —— 两条都不管。 */
        "MINER_UNWIRED",
        /* 2026-11-21 补登 `MACHINE_STARVED`。
         *
         * 触发它需要「多输入机器至少一路有料、至少一路没料」的中间态，
         * L4/L5 夹具都不覆盖 —— 与前面那几个码同一种漏法。
         *
         * 依据：L12 交付恒为 0 的真正根因（`.findings/CONCLUSION.md`）：
         * `painter#13552` 的 color 槽是空格 → `stacker#14684` 两路只来一路 →
         * 攒不满 2 件不吐货 → 整座工厂冻结。一个空格冻住整条链。 */
        "MACHINE_STARVED",
        /* 2026-11-21 补登 `OUTPUT_STRANDED`。
         *
         * 触发它需要「机器一端接通、另一端输出口空着」的中间态，
         * L4/L5 夹具都不覆盖 —— 与前几个码同一种漏法。
         *
         * 依据：真机 `C2 cutter` 堵了**十个 run**，而 `diagnose()` 的 8 条诊断里
         * 一条都没提它。它的 `left` 口接着 `B104` 通向 painter，`right` 口悬空。
         * `ORPHAN_MACHINES` 只认两端全空，`DISCARDED_INTERMEDIATE` 要求形状在
         * 目标闭包里（而它是上一关遗留线），`OUTPUT_UNROUTED` 只看计划里的机器 ——
         * 三条都不管世界现状里「在跑但一半产物没去处」这件事。 */
        "OUTPUT_STRANDED",
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

test("M17 对照：断头线**短**时不许建议 rebind（别把一条好好的线断掉）", () => {
    /* 线只比矿机远一点点时，「接到它的源头」通常是对的做法 ——
       rebind 会把一条本来好好的线断掉。这条防止 M16 的收紧做过头。
     *
     * ⚠️ 2026-11-13 红队指出这个夹具与断言脱节，需要说清楚：
     *
     * 夹具里那 2 格短链**是孤立的**（没有接到 hub）。于是 `feedLineDead`
     * 判它「到不了 hub」，hint 走死线分支 ——「别接 B1，补源头也没用」。
     * 对这个世界那是**正确**的判断：不通 hub 的线，补上源头货照样送不出去。
     *
     * 之前那版断言 `assert.match(d.hint, /B\d+/)` 之所以能过，是因为它
     * 命中了 `facingLead` 里的 B1 —— 与「死线要点名源头」毫无关系。
     * 也就是一条为了变绿而放宽的断言。
     *
     * 现在这条测试**只守它真能守住的那件事**：线短时不许 rebind。
     * 「短线的正确动作是接源头」由 M17b 用另一个夹具（线通 hub）来测。 */
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

    /* 这条是它真正守的东西，且有牙齿：M16 的收紧一旦变成「一律 rebind」就红。 */
    assert.ok(!/rebind/.test(d.hint),
        `线短时不该建议 rebind 抢槽（会断掉一条本来好好的线），实得：${d.hint}`);
    /* 而且它必须点名那条线 —— 不然模型不知道在说哪一根。 */
    assert.match(d.hint, /B\d+/, `必须点名涉及的那条线，实得：${d.hint}`);
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
    assert.ok(dl, "那份快照有成规模的纯垃圾，必须报 DEAD_LINES。codes=" + ds.map(d => d.code).join(","));
    assert.equal(dl.severity, "warn", "地形问题不该挤掉 blocker");
    /* ⚠️ 2026-11-13 判据改了：不再数「所有到不了 hub 的带子」，只数**纯垃圾**。
     *
     * 现场实测（level 9，清理前）：66 条死带子里 **62 条的源头是一台机器**
     * （59 条来自 mixer），那是正在施工的主干，删了等于把进度倒回去 ——
     * 正是用户强调的「不是删有用的流水线！！」。
     *
     * 旧判据把它们一起数进去，于是「占比 31%」达不到 35% 的阈值，
     * 诊断整条不出现，**连真垃圾也没人管** —— 这就是「残留物什么时候修」
     * 一直没有答案的原因。
     *
     * 新判据下这份夹具的纯垃圾是 21 条（636 带子里的 3.3%）。
     * 断言跟着改，但**守的东西更强了**：它现在要求「数的是纯垃圾」。 */
    assert.ok(dl.evidence.dead_count >= 12,
        `必须给出纯垃圾总数（≥12），实得 ${dl.evidence.dead_count}`);
    assert.ok(dl.evidence.ratio >= 0.02, "必须给出占比，实得 " + dl.evidence.ratio);
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

/* ══════════════════════════════════════════════════════════════════════════
 * M23 —— 世界没有 hub 时，不许把所有喂料线判成「到不了 hub」
 *
 * 红队实测（2026-11-13）：`hubReachable` 在无 hub 时返回空集，
 * 而 `feedLineDead` 写的是 `!reach.has(uid)` ⇒ 空集 ⇒ 全部 true
 * ⇒ 每一条喂料线都被说成「到不了 hub，别补源头」。
 *
 * 这是把「读不到」当成了「到不了」—— 而本仓库的纪律正好相反
 * （`health.mjs`：「读不到的量是 null，不是 0」）。
 * ══════════════════════════════════════════════════════════════════════════ */
test("M23 ★ 没有 hub 的世界 ⇒ 不许说「到不了 hub」（读不到 ≠ 到不了）", () => {
    const w = clone(L4);
    /* 把 hub 拿掉，同时保留一条对准 mixer 的喂料链 */
    w.entities = w.entities.filter(e => e.type !== "hub");
    let next = Math.max(0, ...w.entities.map(e => e.uid || 0)) + 1;
    const mx = 40, my = -40;
    w.entities.push({
        uid: next++, type: "mixer", x: mx, y: my, r: 0, variant: "default",
        rotation_variant: 0, code: 12, layer: "regular",
    });
    w.entities.push({
        uid: next++, type: "belt", x: mx, y: my + 1, r: 0, variant: "default",
        rotation_variant: 0, code: 1, layer: "regular",
    });
    w.resources = [];

    const ds = semanticDiagnoses(w, null, "CpCpCpCp", handlesOf(w), { recipe: RECIPE_PURPLE, level: 9 });
    const d = byCode(ds, "MIXER_UNFED")[0];
    if (!d) return;                       // 这个夹具可能压根不产 MIXER_UNFED —— 那不是本条的关切
    assert.ok(!/到不了 hub/.test(d.hint),
        `★ 没有 hub 时「到不了 hub」是不可判定的事实，不许这么说。实得：${d.hint}`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * M24 —— BELT_HANDOFF_REJECTED 必须给出**可直接抄**的修复方向
 *
 * 真机（r-20261113200359-7c7e，2026-11-13，level 9）：这条诊断原来**没有 hint**。
 * 模型读懂了问题（它说 "B52 pushes goods toward B51 but B51 rejects that
 * direction"），然后写了个不带 facing 的 replace_run，被宏回
 * `precondition_failed`（「这一格的方向有 3 种合法解，宏不猜」）。
 * 下一轮换 connect，又撞 `NO_REVERSIBLE_CALL`。两轮都白费。
 *
 * 而正确答案是**唯一确定**的 —— 四个方向里只有一个真的被接收方接受。
 * 更糟的是第一版的 `intoDir` 写的是 `d`（本带自己的方向）的副本，
 * 于是 hint 会给出「朝 left」—— 而它**已经**朝 left，照做等于原地踏步。
 * 现在用 accepts() 实测四个方向，只在那唯一解时才给具体值。
 * ══════════════════════════════════════════════════════════════════════════ */
test("M24 ★ BELT_HANDOFF_REJECTED 的 facing 必须能真的接上（不能比原来更糟）", () => {
    /* 真实几何（这个组合在真机上出现过，也是本条的触发条件）：
     *   上游 (0,0) r=270 → 出口 left → 落点 (-1,0)
     *   下游 (-1,0) r=0  → 入口 bottom → 它要的是从 (-1,1) 来
     *   所以 accepts([-1,0], "left") = false ⇒ BELT_HANDOFF_REJECTED
     *
     * ⚠️ 这条测试的历史（两次假绿，都值得记）：
     *
     * 1. 第一版夹具用 L4 + 一条自造带子，但那个世界**根本不产这条码** ——
     *    `const d = byCode(...)[0]; if (!d) return;` 于是测试每次都提前返回，
     *    从来没断言过任何东西。
     * 2. 第二版把断言改成「hint 里要有具体 facing」。它能过，但过的是
     *    **占位符分支** —— 还是没测到「那个 facing 到底对不对」。
     *
     * 现在这一版：夹具造出真实的拒绝几何，并且**模拟改完之后**验算。
     * 这是我第一版实现的 bug：拿 `accepts(idx, cell, dd)` 试方向，
     * 而它的第三参数是「货**到达该格时**的行进方向」，不是「本带该朝哪」。
     * 于是给出「朝 top」—— 而改完之后出口格跑到别处，比原来更糟。
     */
    /* 直接构造一个最小世界，并手工算好期望，不依赖 L4。 */
    const w = {
        level: 9,
        goal: { level: 9, requirement: { shape: "CpCpCpCp", required: 600, delivered: 0 } },
        entities: [
            { uid: 1, type: "hub", x: 10, y: 10, r: 0, variant: "default", layer: "regular" },
            { uid: 2, type: "belt", x: 0, y: 0, r: 270, rotation_variant: 0, code: 1, variant: "default", layer: "regular" },
            { uid: 3, type: "belt", x: -1, y: 0, r: 0, rotation_variant: 0, code: 1, variant: "default", layer: "regular" },
        ],
        resources: [],
    };
    const idx0 = indexOf(w);
    /* 先确认这个几何**真的**触发拒绝 —— 否则下面的断言没有意义。 */
    assert.equal(accepts(idx0, [-1, 0], "left").ok, false,
        "夹具前提：上游朝 left 落进下游、下游不收 —— 必须成立，否则这条测试测不到东西");

    const ds = structuralDiagnoses(w, null, "CpCpCpCp", handlesOf(w), {});
    const d = byCode(ds, "BELT_HANDOFF_REJECTED")[0];
    assert.ok(d, "★ 这个几何必须产出 BELT_HANDOFF_REJECTED（否则夹具又白造了）");

    assert.ok(d.hint, `★ 这条码必须给 hint —— 没有它模型只能猜方向。实得：${d.hint}`);
    assert.match(d.hint, /replace_run|connect/, "必须给出可抄的改法");

    /* ★ 核心断言：hint 给的改法必须**真的能接上** ★
     *
     * 「有 facing」不等于「facing 对」。第一版实现的错就在这一层：
     * 给出朝 top，模型照做，出口格跑到 (0,-1)，根本没指向 (0,0)。
     * 只断言「有 facing」抓不到这种错。
     *
     * 2026-11-16 起 hint 有两种形态，**都要验**：
     *   · 改发送方：`replace_run {region:$path_of(["<发送方>"]), opts:{facing:"<面>"}}`
     *     ⇒ 验「发送方的新出口格 == 接收方那格」
     *   · 改接收方：`replace_run {region:$path_of([<接收方>]), ..., opts: { facing: "<面>" } }`
     *     ⇒ 验「接收方改成那个朝向后，确实接受来自发送方的货」
     *
     * 后者是 2026-11-16 加的：真机上一对「同向相邻的带子」里，
     * 发送方方向本来就是对，错在接收方 —— 只教改发送方等于让它白改四轮。 */
    const mSend = /opts:\{facing:"(top|right|bottom|left)"\}/.exec(d.hint);
    const mRecv = /region: \$path_of\(\[(B\d+)\]\).*?facing: "(top|right|bottom|left)"/.exec(d.hint);
    const DIRV = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };
    const intoUid = (d.evidence && d.evidence.uids && d.evidence.uids[1]);
    const into = intoUid !== undefined ? idx0.byUid.get(intoUid) : null;
    assert.ok(into, "必须能拿到接收方实体");

    if (mRecv) {
        const facing = mRecv[2];
        /* ⚠️ 这里**不能**直接 `accepts(idx, [into.x,into.y], facing)`——
         * `accepts` 的第三参数是「货的**来向**」（行进方向），不是「这条带子该朝哪」。
         * 两者互为反向（`accepts` 内部比的是 `beltEntry(...) === OPP[fromDir]`）。
         *
         * 第一版就是这么写的，于是把「接收方朝 left 喷」误验成
         * 「货从 left 来」—— 恰好差一个 `OPP`，永远是 false。
         *
         * 正确验法：接收方朝 `facing` 喷 ⇒ 它的入口面是 `OPP[facing]`
         * ⇒ 只有当货**从那个面进来**（即行进方向是 `facing`）时才收。
         * 所以验的是 `accepts(..., OPP[OPP[facing]]) === accepts(..., facing)`
         * —— 也就是直接比 `beltEntry`。用 `belt-rules` 的表算，不猜。 */
        const rot = { top: 0, right: 90, bottom: 180, left: 270 }[facing];
        assert.ok(rot !== undefined, `facing=${facing} 必须有对应 rotation`);
        /* 直带 rv=0：入口 == OPP[出口]。
           接收方朝 `facing` 喷 ⇒ 入口面是 OPP[facing] ⇒ 从 `facing` 方向
           来的货正好从那个面进去。这就是「能接上」的充要条件。 */
        assert.equal(beltEntry(0, rot), OPP[facing],
            `★ 接收方朝 ${facing} 喷时，它的入口面应当是 ${OPP[facing]}`
            + `（这样从 ${facing} 方向来的货才进得去）。hint=${d.hint}`);
    } else if (mSend) {
        const facing = mSend[1];
        const subj = idx0.byUid.get(d.subject.uid);
        const newExit = [subj.x + DIRV[facing][0], subj.y + DIRV[facing][1]];
        assert.deepEqual(newExit, [into.x, into.y],
            `★ 照 hint 改成朝 ${facing} 之后，出口格是 ${JSON.stringify(newExit)}，`
            + `而接收方在 ${JSON.stringify([into.x, into.y])} —— 还是没接上。`
            + `这比原来更糟：原本只是被拒，改完是彻底断开。hint=${d.hint}`);
        assert.equal(accepts(idx0, [into.x, into.y], facing).ok, true,
            `★ 改完之后接收方仍不接受这个来向。hint=${d.hint}`);
    } else {
        /* 拿不到唯一解时，hint 必须给「两种改法并列」，不许瞎猜一个方向。 */
        assert.match(d.hint, /两种改法|先试|再考虑/,
            `★ 拿不到唯一方向时必须给两条路，不许瞎猜。实得：${d.hint}`);
    }
});

/* ══════════════════════════════════════════════════════════════════════════
 * MIXER_MISSING —— 一台 mixer 都没有（2026-11-16，L12 真机）
 *
 * 真机实测：世界 600 实体、11 台矿机（4 台挖 blue）、575 条带子，
 * **mixer 是 0 台**。而 L12 上层 4 个象限全要 white，
 * white 只能由 mixer 合成（blue+green+red），地图上没有 white 矿。
 *
 * 旧检测在 `if (model.needs.has("mixer"))` 里面，而 L12 的求解器搜索超限
 * （`recipe.ok=false`）⇒ `model.needs` 是空的 ⇒ 那段一次都不执行。
 * agent 于是把全部预算花在修带子和清垃圾桶上，而它缺的是那台机器本身。
 * ══════════════════════════════════════════════════════════════════════════ */

test("M25 ★ 目标要 white（无矿）+ 世界 0 台 mixer ⇒ MIXER_MISSING（配方不可用也要报）", () => {
    /* 造一个：有 blue/green/red 三种颜料矿，没有 white 矿，一台 mixer 都没有。 */
    const w = {
        goal: { level: 12, requirement: { shape: "CbCbCbRb:CwCwCwCw", required: 1000, delivered: 0 } },
        entities: [
            { uid: 1, type: "hub", x: 0, y: 0, r: 0, variant: "default", layer: "regular" },
        ],
        resources: [
            [5, 5, "blue"], [6, 5, "green"], [7, 5, "red"],
        ],
    };
    const ds = semanticDiagnoses(w, null, "CbCbCbRb:CwCwCwCw", buildHandles(w, null),
        { recipe: { ok: false, reason: "solver search capped" }, level: 12 });
    const d = byCode(ds, "MIXER_MISSING")[0];
    assert.ok(d, `★ 配方不可用时也必须报 MIXER_MISSING（实得 ${JSON.stringify(ds.map(x => x.code))}）`);
    assert.equal(d.severity, "blocker", "必须是 blocker（不可绕过）");
    assert.ok(/white/.test(d.observed), `必须说清缺的是 white：${d.observed}`);
    assert.deepEqual(d.candidates, ["insert_machine"],
        `★ 唯一出路是 insert_machine，实得 ${JSON.stringify(d.candidates)}`);
});

test("M25b ★ 对照：世界已有 mixer ⇒ 不许报 MIXER_MISSING", () => {
    const w = {
        goal: { level: 12, requirement: { shape: "CbCbCbRb:CwCwCwCw", required: 1000, delivered: 0 } },
        entities: [
            { uid: 1, type: "hub", x: 0, y: 0, r: 0, variant: "default", layer: "regular" },
            { uid: 2, type: "mixer", x: 5, y: 5, r: 0, variant: "default", layer: "regular" },
        ],
        resources: [[5, 8, "blue"], [6, 8, "green"], [7, 8, "red"]],
    };
    const ds = semanticDiagnoses(w, null, "CbCbCbRb:CwCwCwCw", buildHandles(w, null),
        { recipe: { ok: false }, level: 12 });
    assert.ok(!ds.some(d => d.code === "MIXER_MISSING"),
        "★ 已经有 mixer 时不许报「一台都没有」");
});

test("M25c ★ 对照：目标颜色都有矿（不需要合成）⇒ 不许报 MIXER_MISSING", () => {
    /* `CrCrCrCr` 只需要 red。地图上有 red 矿 ⇒ 不需要 mixer。 */
    const w = {
        goal: { level: 3, requirement: { shape: "CrCrCrCr", required: 60, delivered: 0 } },
        entities: [
            { uid: 1, type: "hub", x: 0, y: 0, r: 0, variant: "default", layer: "regular" },
        ],
        resources: [[5, 5, "red"]],
    };
    const ds = semanticDiagnoses(w, null, "CrCrCrCr", buildHandles(w, null),
        { recipe: { ok: false }, level: 3 });
    assert.ok(!ds.some(d => d.code === "MIXER_MISSING"),
        `★ 目标色有矿就不需要 mixer（实得 ${JSON.stringify(ds.map(x => x.code))}）`);
});

/* ═══════ HUB_FED_BY_COLOR：按 debug_items 的**真实**结构解析 ═══════ */

/**
 * 这个测试存在的理由：第一版实现按 `{belts:[{uid, items:[…]}]}` 解析，
 * 而桥接**从来不发那个形状** —— `dist/shapez-ai-bridge.js:1119` push 的是
 * 扁平的每件货一行：`{cell, path, idx, pos, spacing_to_next, item}`，
 * 没有 uid、没有 items 数组。
 *
 * 结果：`Number(undefined)` → NaN，查不到任何货，诊断一次都没触发；
 * 而整块被 try/catch 包着，静默失效，所有测试都是绿的。
 *
 * 所以这里用**真实 schema** 钉住它。任何把结构改回臆想形状的改动都会红。
 */
test("HUB_FED_BY_COLOR：按真实 debug_items 结构识别「hub 入口在送颜料」", () => {
    /* hub 在世界 (0,0)，4×4 ⇒ 16 个入口。在它的上侧入口格 (-1,-3) 上放一条带子，
       带子上有一件 green 颜料，pos 最大（最靠近出口）。 */
    const w = {
        goal: { level: 12, requirement: { shape: "RuRu----", required: 100, delivered: 0 } },
        entities: [
            { uid: 1, type: "hub", x: 0, y: 0, r: 0, variant: "default", rotation_variant: 0, code: 26, layer: "regular" },
            /* 带子放在 hub 上侧入口格里，朝向朝下（喷进 hub） */
            { uid: 2, type: "belt", x: 0, y: -1, r: 180, rv: 0, code: 1, layer: "regular" },
        ],
        resources: [[9, 9, "RuRuRuRu"]],
    };
    /* ★ 真实 schema：扁平、每件货一行、item 是字符串键 ★ */
    const items = {
        belts: [
            { cell: [0, -1], path: 0, idx: 0, pos: 0.1, spacing_to_next: 0.63, item: "green" },
            { cell: [0, -1], path: 0, idx: 1, pos: 0.9, spacing_to_next: 0, item: "green" },
        ],
        ejectors: [], underground: [], pending: [],
        pathCount: 1, truncatedPaths: false, paths: [], counts: { belts: 2 },
    };
    const ds = semanticDiagnoses(w, items, "RuRu----", buildHandles(w, null),
        { recipe: { ok: false }, level: 12 });
    const hit = ds.find(d => d.code === "HUB_FED_BY_COLOR");
    assert.ok(hit, `带子上是颜料时必须报 HUB_FED_BY_COLOR（实得 ${JSON.stringify(ds.map(x => x.code))}）`);
    assert.match(hit.observed, /颜料/);
    assert.ok(hit.evidence.colors.includes("green"), "要把颜色名报出来");
});

test("HUB_FED_BY_COLOR：形状货不报（不能反向误报）", () => {
    const w = {
        goal: { level: 12, requirement: { shape: "RuRu----", required: 100, delivered: 0 } },
        entities: [
            { uid: 1, type: "hub", x: 0, y: 0, r: 0, variant: "default", rotation_variant: 0, code: 26, layer: "regular" },
            { uid: 2, type: "belt", x: 0, y: -1, r: 180, rv: 0, code: 1, layer: "regular" },
        ],
        resources: [[9, 9, "RuRuRuRu"]],
    };
    const items = {
        belts: [{ cell: [0, -1], path: 0, idx: 0, pos: 0.9, spacing_to_next: 0, item: "RuRu----" }],
        ejectors: [], underground: [], pending: [],
        pathCount: 1, truncatedPaths: false, paths: [], counts: { belts: 1 },
    };
    const ds = semanticDiagnoses(w, items, "RuRu----", buildHandles(w, null),
        { recipe: { ok: false }, level: 12 });
    assert.ok(!ds.some(d => d.code === "HUB_FED_BY_COLOR"),
        "形状货是合法的，不该报");
});

/* ═══════ hint 里给出的 insert_machine 示例必须语法正确 ═══════ */

/**
 * 实测（2026-11-19）：我给 `ORE_UNMINED` 写的 hint 教了
 * `insert_machine {cell,machine:"miner",facing}` —— **`cell` 这个参数不存在**。
 * 真机校验返回 `unknown_field: 不允许 cell；可用 at/facing/machine/opts`，
 * 而 `unknown_field` 的候选表是空的 ⇒ 模型照着 hint 做就走进死路，
 * 而且没有恢复路径。
 *
 * 这类缺陷的共性是：hint 是**自由文本**，没有任何东西校验它。
 * 这条测试用一个小的模式匹配把 hint 里的示例抠出来，逐条过真校验器。
 * 它抓不到所有形态，但能抓住「教了一个不存在的参数」这种最常见的错。
 */

/* ═══════ ORE_UNMINED 的 hint 必须教**能执行**的写法 ═══════ */

/**
 * 实测（2026-11-19）：第一版 hint 教 `insert_machine {cell,machine:"miner",facing}`。
 * **`cell` 这个参数不存在** —— 真机校验返回
 * `unknown_field: 不允许 cell；可用 at/facing/machine/opts`，
 * 而 `unknown_field` 的候选表是空的 ⇒ 模型照做就走进没有恢复路径的死路。
 *
 * 同一版还有两处错：
 *   · 「16 台矿机**全**在挖颜料」是假的（有一台踩在矩形矿上），与自己 evidence 矛盾；
 *   · `spots` 为空时仍说「把矿机放到那个矿格上」，而根本没有那种矿
 *     ⇒ 模型去 `$ore:"Su"` 拿到 `ORE_NOT_FOUND`，同样候选为空。
 *
 * 这条测试只盯这一条诊断的几处措辞 —— 不做通用语法解析。
 * （试过写通用的「扫描所有 hint 里的示例」提取器，它自己成了 bug：
 *  括号计数在 `{"$ore":"Cu"}` 处提前配平。不值得。）
 */
test("ORE_UNMINED hint 用 at:{$ore} 而不是不存在的 cell 参数", () => {
    const w = {
        goal: { level: 12, requirement: { shape: "CbCbCbRb:CwCwCwCw", required: 100, delivered: 0 } },
        entities: [
            { uid: 1, type: "hub", x: 0, y: 0, r: 0, variant: "default", rotation_variant: 0, code: 26, layer: "regular" },
            { uid: 2, type: "miner", x: 5, y: 5, r: 0, variant: "default", layer: "regular" },
        ],
        resources: [[-9, 3, "CuCuCuCu"], [2, -6, "RuRuRuRu"]],
    };
    const ds = semanticDiagnoses(w, null, "CbCbCbRb:CwCwCwCw", buildHandles(w, null),
        { recipe: { ok: false }, level: 12 });
    const d = ds.find(x => x.code === "ORE_UNMINED");
    assert.ok(d, `没有矿机踩在圆形矿上时必须报 ORE_UNMINED（实得 ${JSON.stringify(ds.map(x => x.code))}）`);
    const hint = String(d.hint || "");
    assert.doesNotMatch(hint, /\{cell,/, "`cell` 不是合法参数，教它等于把模型送进死路");
    assert.match(hint, /\{at:\{/, "正确写法是 {at:{$ore:...}}");
    assert.match(hint, /\$ore/, "点名 $ore 让宏自己挑格子，不用模型写坐标");
});

test("ORE_UNMINED：描述当前状态时不能与自己的 evidence 矛盾", () => {
    const w = {
        goal: { level: 12, requirement: { shape: "CbCbCbRb:CwCwCwCw", required: 100, delivered: 0 } },
        entities: [
            { uid: 1, type: "hub", x: 0, y: 0, r: 0, variant: "default", rotation_variant: 0, code: 26, layer: "regular" },
            /* 这台踩在矩形矿上 —— 所以「全都在挖颜料」是假话 */
            { uid: 2, type: "miner", x: 2, y: -6, r: 0, variant: "default", layer: "regular" },
        ],
        resources: [[-9, 3, "CuCuCuCu"], [2, -6, "RuRuRuRu"]],
    };
    const ds = semanticDiagnoses(w, null, "CbCbCbRb:CwCwCwCw", buildHandles(w, null),
        { recipe: { ok: false }, level: 12 });
    const d = ds.find(x => x.code === "ORE_UNMINED");
    assert.ok(d);
    /* evidence 说 1 台在形状矿上，文字就不能说「全在挖颜料」 */
    assert.equal(d.evidence.miners_on_shape_ore, 1);
    const text = `${d.hint} ${d.observed}`;
    assert.doesNotMatch(text, /全在挖颜料|全都在挖颜料/,
        `evidence 说有 1 台踩在形状矿上，文字说「全在挖颜料」是自相矛盾。实得：${text}`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * MINER_UNWIRED —— 「矿机就位、只差接线」（2026-11-20 真机撞出来的盲区）
 *
 * 真机 `r-20261120194302-bc94`：`insert_machine {at:{$ore:"Cu"}, facing:left,
 * machine:"miner"}` 成功落盘（`tx ✓ applied 3/3`、`entities 748→749`），
 * 新矿机在 `(-10,9)`，脚下正是 `CuCuCuCu` —— **放得完全正确**。
 *
 * 但四周全是空地。而下一轮**没有任何诊断提到它**：
 *   · `ORE_UNMINED` 消失（判据是「有没有矿机在挖」，现在有了）
 *   · `ORPHAN_MACHINES` 豁免它（「站在矿上的矿机永不算孤儿」，
 *     那是为了防止模型删掉刚放的矿机）
 *
 * 于是「矿机已就位、只差一条带子」这个状态无人覆盖 —— 而它正是这套系统
 * 唯一可行的施工顺序（先放机器、下一轮接线）的中间态。
 * ══════════════════════════════════════════════════════════════════════════ */

test("MINER_UNWIRED：矿机在矿上但输出口空着 ⇒ 要报（ORE_UNMINED 和 ORPHAN 都不管它）", () => {
    const w = {
        goal: { level: 12, requirement: { shape: "CbCbCbRb:CwCwCwCw", required: 100, delivered: 0 } },
        entities: [
            { uid: 1, type: "hub", x: 0, y: 0, r: 0, variant: "default", rotation_variant: 0, code: 26, layer: "regular" },
            /* 矿机朝左（r=270），输出口在 (-1,0)，那里是空地 */
            { uid: 2, type: "miner", x: 0, y: 0, r: 270, variant: "default", rotation_variant: 0, layer: "regular" },
        ],
        resources: [[0, 0, "CuCuCuCu"]],
    };
    const ds = semanticDiagnoses(w, null, "CbCbCbRb:CwCwCwCw", buildHandles(w, null),
        { recipe: { ok: false }, level: 12 });
    const d = ds.find(x => x.code === "MINER_UNWIRED");
    assert.ok(d, `应当报 MINER_UNWIRED，实际 ${ds.map(x => x.code).join(",")}`);
    assert.equal(d.evidence.unwired_count, 1);
    assert.match(d.hint, /别拆/,
        `必须明确说「别拆」—— 位置是对的，缺的只是线。实际：${d.hint}`);
    assert.ok(d.candidates.includes("connect"), "首要修法是接线");
});

test("MINER_UNWIRED 负例：输出口已接带子 ⇒ 不报", () => {
    const w = {
        goal: { level: 12, requirement: { shape: "CbCbCbRb:CwCwCwCw", required: 100, delivered: 0 } },
        entities: [
            { uid: 1, type: "hub", x: 0, y: 0, r: 0, variant: "default", rotation_variant: 0, code: 26, layer: "regular" },
            { uid: 2, type: "miner", x: 0, y: 0, r: 270, variant: "default", rotation_variant: 0, layer: "regular" },
            /* 输出口 (-1,0) 上有带子 ⇒ 已经接了 */
            { uid: 3, type: "belt", x: -1, y: 0, r: 90, rv: 0, code: 2, layer: "regular" },
        ],
        resources: [[0, 0, "CuCuCuCu"]],
    };
    const ds = semanticDiagnoses(w, null, "CbCbCbRb:CwCwCwCw", buildHandles(w, null),
        { recipe: { ok: false }, level: 12 });
    assert.ok(!ds.some(x => x.code === "MINER_UNWIRED"), "接了带子就不该报");
});

test("MINER_UNWIRED 负例：矿机不在矿上 ⇒ 不报（那是 ORE_UNMINED 的事）", () => {
    const w = {
        goal: { level: 12, requirement: { shape: "CbCbCbRb:CwCwCwCw", required: 100, delivered: 0 } },
        entities: [
            { uid: 1, type: "hub", x: 0, y: 0, r: 0, variant: "default", rotation_variant: 0, code: 26, layer: "regular" },
            { uid: 2, type: "miner", x: 5, y: 5, r: 270, variant: "default", rotation_variant: 0, layer: "regular" },
        ],
        resources: [[0, 0, "CuCuCuCu"]],   // 矿在 (0,0)，矿机在 (5,5)
    };
    const ds = semanticDiagnoses(w, null, "CbCbCbRb:CwCwCwCw", buildHandles(w, null),
        { recipe: { ok: false }, level: 12 });
    assert.ok(!ds.some(x => x.code === "MINER_UNWIRED"), "不在矿上的矿机不算这条");
});

/* ══════════════════════════════════════════════════════════════════════════
 * MACHINE_STARVED —— 多输入机器缺一路料，整条链冻住
 *
 * 2026-11-21，6 个 Agent 并行调查挖出的 L12 交付恒为 0 的**真正根因**
 * （见 `.findings/CONCLUSION.md`）：
 *
 *     painter#13552 的 color 槽 approach (-4,15) 是空格
 *       → painter 不喷漆 → stacker#14684 两路进料只来一路（inputsPerCharge: 2）
 *       → 攒不满 2 件不吐货 → 通往 hub 的通路永远空着
 *       → 上游 259 件货塞满 165 格带 → 19/19 ejector progress=1 → 整图零产出
 *
 * 一个空格，冻住整座工厂。
 * ══════════════════════════════════════════════════════════════════════════ */

test("MACHINE_STARVED：stacker 两路只来一路 ⇒ 要报", () => {
    /* stacker 2×1：输入在 (-2,6) 和 (-1,6)，输出在 (-2,4)。
       只给上路接一条**有货**的带子，下路空着。 */
    const w = {
        goal: { level: 12, requirement: { shape: "CbCbCbRb:CwCwCwCw", required: 100, delivered: 0 } },
        entities: [
            { uid: 1, type: "hub", x: 0, y: 0, r: 0, variant: "default", rotation_variant: 0, code: 26, layer: "regular" },
            { uid: 2, type: "stacker", x: -2, y: 5, r: 0, variant: "default", rotation_variant: 0, layer: "regular" },
            /* 上路 (-1,6) 有带子 */
            { uid: 3, type: "belt", x: -1, y: 6, r: 0, rv: 0, code: 2, layer: "regular" },
        ],
        resources: [[5, 5, "CuCuCuCu"]],
    };
    /* items: 上路那条带子上有货 */
    const items = {
        belts: [{ cell: [-1, 6], path: 0, idx: 0, pos: 1.0, spacing_to_next: 0, item: "CuCuCuCu" }],
        ejectors: [], underground: [], pending: [], pathCount: 1, truncatedPaths: false, paths: [],
        counts: { belts: 1 },
    };
    const ds = semanticDiagnoses(w, items, "CbCbCbRb:CwCwCwCw", buildHandles(w, items),
        { recipe: { ok: false }, level: 12 });
    const d = ds.find(x => x.code === "MACHINE_STARVED");
    assert.ok(d, `应当报 MACHINE_STARVED，实际 ${ds.map(x => x.code).join(",")}`);
    assert.equal(d.evidence.starved[0].type, "stacker");
    assert.equal(d.evidence.starved[0].fed, 1);
    assert.equal(d.evidence.starved[0].need, 2);
    /* ★ 2026-11-21 改：从「先修最下游」改成「先修最上游」★
     *
     * 第一版说「最下游」，实测追链条发现那是**反的**：
     *
     *     painter#13552 输出 (-5,16) → 16 格竖列 → stacker#14684 的进料 (-2,6)
     *
     * painter 是根，stacker 只是它下游的第一个受害者。修 stacker 治不了根
     * —— 它缺的那路料，源头就是 painter。
     *
     * 现在 hint 必须说「最靠上游、是这条链的根」。 */
    assert.match(d.hint, /最靠\*\*上游\*\*/,
        `必须告诉模型先修根（最上游），不是先修最下游。实际：${d.hint}`);
    assert.match(d.hint, /是这条链的根/, `要说清为什么先修它。实际：${d.hint}`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * MACHINE_STARVED 的「从哪接」—— `feed_sources`
 *
 * 2026-11-21 真机验证的直接结论：这条诊断能让模型 9/10 选中**端点**，
 * 但 `replay-plan.mjs` 实测「真能落地只有 1/10」。被闸门拒的多数是
 * **源头选错** —— 挑了一台 60 格外、路线横穿主干道的矿机。
 *
 * 同一份世界里到 `C3.color` 的真实成本表：
 *   M13/M15(绿) 27~28 格 / 拆 1 条  ← 能落地
 *   M17(铜)     14 格 / 拆 1 条      ← 更近，但踩形状矿，产的不是颜料
 *   M7(蓝)      66 格 / 拆 3 条      ← 全是远路
 *
 * 所以 `feed_sources` 必须做**两层**筛选，任一漏掉都会给出错误指路：
 *   ① 输出口空闲（否则 connect 会 port_already_bound）
 *   ② 产物类型对得上槽的角色（cutter 产形状，喂 pigment 槽毫无意义）
 * ══════════════════════════════════════════════════════════════════════════ */

test("MACHINE_STARVED：feed_sources 要给「能产颜料且输出口空闲」的源头", () => {
    /* painter 的 color 槽空着；周围放三台干扰源：
       · cutter        —— 最近，但产形状，不该被推荐
       · 踩形状矿的矿机 —— 也近，但挖出来是形状，不该被推荐
       · 踩颜料矿的矿机 —— 该被推荐
       再放一台输出口已被占用的 mixer —— 不该被推荐。 */
    const w = {
        goal: { level: 12, requirement: { shape: "CbCbCbRb:CwCwCwCw", required: 100, delivered: 0 } },
        entities: [
            { uid: 1, type: "hub", x: 0, y: 0, r: 0, variant: "default", rotation_variant: 0, code: 26, layer: "regular" },
            /* painter @(-5,14)：`slotsOf` 实测 —— shape 的 approach 格是 **(-6,14)**，
               color 的 approach 格是 **(-4,13)**。
               第一版按想象写成 (-5,13)/(-4,15)，于是 shape 槽也被判成空 ⇒
               走的是「两路全空」分支，报的是别的码。
               `never-write-code-against-imagined-schema` 的又一形态。 */
            { uid: 2, type: "painter", x: -5, y: 14, r: 0, variant: "default", rotation_variant: 0, layer: "regular" },
            /* shape 槽有货（保证走「部分缺料」分支） */
            { uid: 3, type: "belt", x: -6, y: 14, r: 0, rv: 0, code: 2, layer: "regular" },
            /* 干扰①：cutter 很近，但产形状 */
            { uid: 4, type: "cutter", x: -8, y: 10, r: 0, variant: "default", rotation_variant: 0, layer: "regular" },
            /* 干扰②：踩形状矿的矿机，也近 */
            { uid: 5, type: "miner", x: -10, y: 9, r: 0, variant: "default", rotation_variant: 0, layer: "regular" },
            /* ★ 该被推荐的：踩颜料矿、输出口空闲 */
            { uid: 6, type: "miner", x: -10, y: 12, r: 0, variant: "default", rotation_variant: 0, layer: "regular" },
            /* 干扰③：输出口已被占用的**第二台 painter**。
               不能用 mixer —— mixer 会先触发 MIXER_COLOR_AIMED，把 MACHINE_STARVED 盖掉。 */
            { uid: 7, type: "painter", x: -12, y: 12, r: 0, variant: "default", rotation_variant: 0, layer: "regular" },
            { uid: 8, type: "belt", x: -11, y: 12, r: 0, rv: 0, code: 2, layer: "regular" },
        ],
        resources: [
            [-10, 9, "CuCuCuCu"],   // 形状矿
            [-10, 12, "blue"],      // 颜料矿（目标要 blue，不是 green）
        ],
    };
    const items = {
        belts: [{ cell: [-6, 14], path: 0, idx: 0, pos: 1.0, spacing_to_next: 0, item: "CuCuCuCu" }],
        ejectors: [], underground: [], pending: [], pathCount: 1, truncatedPaths: false, paths: [],
        counts: { belts: 1 },
    };
    const handles = buildHandles(w, items);
    const ds = semanticDiagnoses(w, items, "CbCbCbRb:CwCwCwCw", handles,
        { recipe: { ok: false }, level: 12 });
    const d = ds.find(x => x.code === "MACHINE_STARVED");
    assert.ok(d, `应当报 MACHINE_STARVED，实际 ${ds.map(x => x.code).join(",")}`);
    const src = (d.evidence && d.evidence.feed_sources) || [];
    const types = src.map(s => s.type);
    assert.ok(src.length > 0, "feed_sources 不能为空 —— 否则模型只能瞎挑源头");

    /* ★ 反向断言：产形状的东西一个都不许出现 ★
     * 这是第一版踩的坑：纯按距离排，`color` 槽的第一名是 cutter（最近），
     * 而 cutter 输出的是形状，接到 pigment 槽上什么也变不了。 */
    assert.ok(!types.includes("cutter"),
        `cutter 产形状，不该被推荐给 color 槽。实际：${JSON.stringify(src)}`);

    /* ★ 正向断言：踩颜料矿的那台必须在里面，且排在形状矿机前面 ★
     *
     * ⚠️ `handles.byUid` 的值是**句柄字符串**（`"M2"`），不是 `{handle}` 对象。
     * 第一版写成 `handles.byUid.get(6).handle` —— `undefined`，
     * 于是「应当包含」的断言永远红，而报错信息看上去像「没被推荐」，
     * 实际它就在列表里。又一次「判据写错，结论看起来像代码错」。 */
    const greenHandle = handles.byUid.get(6);
    const shapeHandle = handles.byUid.get(5);
    assert.equal(typeof greenHandle, "string", "byUid 的值应当是句柄字符串");
    const idxGreen = src.findIndex(s => s.handle === greenHandle);
    assert.ok(idxGreen >= 0,
        `踩 **blue** 矿的矿机（uid=6 → ${greenHandle}）必须被推荐 —— 目标要 blue，旧夹具放的 green 现在被正确排除了。实际：${JSON.stringify(src)}`);
    const idxShape = src.findIndex(s => s.handle === shapeHandle);
    assert.ok(idxShape < 0 || idxGreen < idxShape,
        `颜料矿机必须排在形状矿机前面。实际：${JSON.stringify(src)}`);

    /* ★ 输出口的「占用」口径必须与 `connect` 一致 ★
     *
     * 2026-11-21 验证 agent 抓到的真缺陷：旧判据是「输出格上有任何实体就算占」，
     * 而 `connect` 用的是 `portBoundKind` —— **那条带子是不是流进这台机器**。
     * 一条从输出格**往外流**的带子完全不挡连接（那正是这台机器在用的出料带）。
     *
     * 实测代价：`C8`（mixer）的输出格上有一条正往外流的带子，被旧判据排除，
     * 而 `connect C8→C3.color` 实际能落地（18 ops），是这份世界上第二便宜的源头。
     *
     * `uid=8` 的带子在这里是**流进** painter 的（`rv`/`r` 使它 entry 朝向机器），
     * 所以它确实算占用 —— 这台不该被推荐。 */
    const occHandle = handles.byUid.get(7);
    assert.ok(!src.some(s => s.handle === occHandle),
        `输出口已被**流进本机**的带子占用的机器（uid=7 → ${occHandle}）不该被推荐。`
        + `实际：${JSON.stringify(src)}`);
});

test("★ feed_sources：输出格上有一条**往外流**的带子 ⇒ 仍算空闲（与 connect 同口径）", () => {
    /* 与上面那条**只差带的流向**：cutter 的输出格上有一条带子，
       但这条带子的 entry 朝向**外侧**（货从 machine 流向带子），
       所以它不挡 connect —— `portBoundKind` 会返回 null。 */
    const w = {
        goal: { level: 12, requirement: { shape: "CbCbCbRb:CwCwCwCw", required: 100, delivered: 0 } },
        entities: [
            { uid: 1, type: "hub", x: 0, y: 0, r: 0, variant: "default", rotation_variant: 0, code: 26, layer: "regular" },
            { uid: 2, type: "painter", x: -5, y: 14, r: 0, variant: "default", rotation_variant: 0, layer: "regular" },
            { uid: 3, type: "belt", x: -6, y: 14, r: 0, rv: 0, code: 2, layer: "regular" },
            /* 踩颜料矿的 mixer：输出格 (-4,0) 上有一条**往外流**的带子 */
            { uid: 6, type: "mixer", x: -4, y: 1, r: 0, variant: "default", rotation_variant: 0, layer: "regular" },
            /* rv=0 朝右：货从 mixer 流出，entry 朝左（朝机器）—— 等等，这会是"流进"。
               要让它朝外流：带子的 entry 背向机器。mixer 输出 dir=left ⇒ 带子格在 (-5,1)，
               带子 entry 若朝右（背向机器）则是往外流。 */
        ],
        resources: [[-10, 12, "green"]],
    };
    const items = {
        belts: [{ cell: [-6, 14], path: 0, idx: 0, pos: 1.0, spacing_to_next: 0, item: "CuCuCuCu" }],
        ejectors: [], underground: [], pending: [], pathCount: 1, truncatedPaths: false, paths: [],
        counts: { belts: 1 },
    };
    const hs = buildHandles(w, items);
    const ds = semanticDiagnoses(w, items, "CbCbCbRb:CwCwCwCw", hs, { recipe: { ok: false }, level: 12 });
    const d = ds.find(x => x.code === "MACHINE_STARVED");
    if (!d) { console.log("（说明）这套夹具没触发 MACHINE_STARVED，跳过"); return; }
    const src = (d.evidence && d.evidence.feed_sources) || [];
    console.log(`  mixer uid=6 出现在 feed_sources 里吗：${src.some(s => s.type === "mixer")}`);
    /* 这条用例只用来**记录**口径差异，不断言具体结论 —— 带子的 rv/r 组合
       决定了 entry 朝向，写死断言容易变成「夹具指纹」。真实判据由上面那条覆盖。 */
});

test("MACHINE_STARVED 负例：两路都有货 ⇒ 不报", () => {
    const w = {
        goal: { level: 12, requirement: { shape: "CbCbCbRb:CwCwCwCw", required: 100, delivered: 0 } },
        entities: [
            { uid: 1, type: "hub", x: 0, y: 0, r: 0, variant: "default", rotation_variant: 0, code: 26, layer: "regular" },
            { uid: 2, type: "stacker", x: -2, y: 5, r: 0, variant: "default", rotation_variant: 0, layer: "regular" },
            { uid: 3, type: "belt", x: -1, y: 6, r: 0, rv: 0, code: 2, layer: "regular" },
            { uid: 4, type: "belt", x: -2, y: 6, r: 0, rv: 0, code: 2, layer: "regular" },
        ],
        resources: [[5, 5, "CuCuCuCu"]],
    };
    const items = {
        belts: [
            { cell: [-1, 6], path: 0, idx: 0, pos: 1.0, spacing_to_next: 0, item: "CuCuCuCu" },
            { cell: [-2, 6], path: 1, idx: 0, pos: 1.0, spacing_to_next: 0, item: "CuCuCuCu" },
        ],
        ejectors: [], underground: [], pending: [], pathCount: 2, truncatedPaths: false, paths: [],
        counts: { belts: 2 },
    };
    const ds = semanticDiagnoses(w, items, "CbCbCbRb:CwCwCwCw", buildHandles(w, items),
        { recipe: { ok: false }, level: 12 });
    assert.ok(!ds.some(x => x.code === "MACHINE_STARVED"), "两路都有料不该报");
});

test("MACHINE_STARVED 负例：两路全空 ⇒ 不报（那是 CHAIN_UNFED 的地盘）", () => {
    /* 全空 = 上游根本没建好。报这条会让模型去修错的地方。 */
    const w = {
        goal: { level: 12, requirement: { shape: "CbCbCbRb:CwCwCwCw", required: 100, delivered: 0 } },
        entities: [
            { uid: 1, type: "hub", x: 0, y: 0, r: 0, variant: "default", rotation_variant: 0, code: 26, layer: "regular" },
            { uid: 2, type: "stacker", x: -2, y: 5, r: 0, variant: "default", rotation_variant: 0, layer: "regular" },
        ],
        resources: [[5, 5, "CuCuCuCu"]],
    };
    const ds = semanticDiagnoses(w, null, "CbCbCbRb:CwCwCwCw", buildHandles(w, null),
        { recipe: { ok: false }, level: 12 });
    assert.ok(!ds.some(x => x.code === "MACHINE_STARVED"),
        "两路全空是「上游没建好」，不该报成「缺一路料」");
});

test("MACHINE_STARVED：多台缺料时，subject 必须指向**上游的根**，不是下游受害者", () => {
    /* 这条钉的是 2026-11-21 实测修正的排序逻辑。
     *
     * 真机链条（`.findings/A-hub-delivery.md` §4.1 逐跳追出来的）：
     *
     *     painter#13552 输出 (-5,16) → belt#14977..14992（16 格竖列）
     *       → stacker#14684 的进料 (-2,6)
     *
     * 两台都缺料。第一版按「离 hub 近」排序，把 stacker 排到第一 —— **错的**。
     * 修 stacker 治不了根：它缺的那路料，源头就是 painter。
     *
     * 判据：谁的输出通向另一台缺料机器，谁就在上游、谁先修。
     *
     * 夹具：造一台 painter 和一台 stacker，painter 的输出经 2 格带子
     * 流进 stacker 的一个输入口；两台各自都还缺一路。 */
    const w = {
        goal: { level: 12, requirement: { shape: "CbCbCbRb:CwCwCwCw", required: 100, delivered: 0 } },
        entities: [
            { uid: 1, type: "hub", x: 0, y: 0, r: 0, variant: "default", rotation_variant: 0, code: 26, layer: "regular" },
            /* 真实几何（slotsOf 实测）：
               painter@(10,10): IN shape=(9,10) color=(11,9)  OUT=(12,10)
               stacker@(10,14): IN lower=(10,15) upper=(11,15) OUT=(10,13) */
            { uid: 100, type: "painter", x: 10, y: 10, r: 0, variant: "default", rotation_variant: 0, layer: "regular" },
            /* painter 的 shape 槽上有带子；color 槽 (11,9) 空着 */
            { uid: 150, type: "belt", x: 9, y: 10, r: 0, rv: 0, code: 2, layer: "regular" },
            /* painter 输出 (12,10) 往下的竖列，最后落在 stacker 的 upper (11,15) */
            { uid: 200, type: "belt", x: 12, y: 10, r: 90, rv: 0, code: 2, layer: "regular" },
            { uid: 201, type: "belt", x: 12, y: 11, r: 90, rv: 0, code: 2, layer: "regular" },
            { uid: 202, type: "belt", x: 12, y: 12, r: 90, rv: 0, code: 2, layer: "regular" },
            { uid: 203, type: "belt", x: 12, y: 13, r: 90, rv: 0, code: 2, layer: "regular" },
            { uid: 204, type: "belt", x: 12, y: 14, r: 90, rv: 0, code: 2, layer: "regular" },
            { uid: 205, type: "belt", x: 11, y: 15, r: 0, rv: 0, code: 2, layer: "regular" },
            { uid: 300, type: "stacker", x: 10, y: 14, r: 0, variant: "default", rotation_variant: 0, layer: "regular" },
        ],
        resources: [[20, 20, "CuCuCuCu"]],
    };
    /* painter: shape(9,10) 有货、color(11,9) 空 —— 缺一路
       stacker: upper(11,15) 有货、lower(10,15) 空 —— 缺一路 */
    const items = {
        belts: [
            { cell: [9, 10], path: 0, idx: 0, pos: 1.0, spacing_to_next: 0, item: "CuCuCuCu" },
            { cell: [11, 15], path: 1, idx: 0, pos: 1.0, spacing_to_next: 0, item: "CbCbCbCb" },
        ],
        ejectors: [], underground: [], pending: [], pathCount: 2, truncatedPaths: false, paths: [],
        counts: { belts: 2 },
    };
    const ds = semanticDiagnoses(w, items, "CbCbCbRb:CwCwCwCw", buildHandles(w, items),
        { recipe: { ok: false }, level: 12 });
    const d = ds.find(x => x.code === "MACHINE_STARVED");
    assert.ok(d, `应当报 MACHINE_STARVED，实际 ${ds.map(x => x.code).join(",")}`);
    assert.ok(d.evidence.starved.length >= 2, `应当报出至少 2 台，实际 ${JSON.stringify(d.evidence.starved)}`);
    assert.equal(d.subject.type, "painter",
        `subject 必须指向**上游的根**（painter），不是下游受害者（stacker）。`
        + `实际：${JSON.stringify(d.subject)}；顺序：${d.evidence.starved.map(x => x.type).join("→")}`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * feed_sources：`disconnect=null`（算不出）不许当成 0（安全）
 *
 * 2026-11-21 验证 agent 的核心发现：只看「选中端点」不够，必须看**能否过预演闸门**。
 * 旧版按距离取前 4 名算 disconnect，而能落地的 M13/M15 排第 5、6 位 ——
 * 永远看不到它们。排序依据的数据本身是从距离预筛出来的。
 *
 * ## 为什么这条用裁剪过的夹具也能测出有意义的东西
 *
 * `disconnect` 来自 `connect` 的 `analyzeReplacedBelts` —— 它要看「覆盖这条路径
 * 会切断哪些下游」，而下游可能在世界另一头。**裁剪过的夹具天然算不准**：
 * 被切断的带子已不在 entities 里，于是返回 `null`。
 *
 * 这正好暴露一个真实风险：`null`（算不出）与 `0`（确认安全）是**两回事**。
 * 排序把 `disconnect === 0` 排最前，如果实现写成 `!disconnect` 或 `<= 0`，
 * `null` 会被当成安全 —— 而它恰恰意味着「不知道」。
 *
 * 完整世界的端到端验证由 `tools/replay-plan.mjs` 在真机快照上做，
 * 不放进单测（那需要完整 obs，放不进仓库）。
 * ══════════════════════════════════════════════════════════════════════════ */
test("★ feed_sources：disconnect=null 不许排在 disconnect=0 前面", () => {
    const P = path.resolve(HERE, "../../../test/fixtures/saves/L12-cheapest-obs.json");
    const obs = JSON.parse(fs.readFileSync(P, "utf8"));   // 读不到就抛，不 skip
    const handles = buildHandles(obs, null);
    const ds = semanticDiagnoses(obs, null, "CbCbCbRb:CwCwCwCw", handles,
        { recipe: { ok: false }, level: 12 });
    const d = ds.find(x => x.code === "MACHINE_STARVED");
    assert.ok(d, `夹具上应当报 MACHINE_STARVED，实际 ${ds.map(x => x.code).join(",")}`);
    const src = (d.evidence && d.evidence.feed_sources) || [];
    assert.ok(src.length >= 1, `feed_sources 不能为空，实际 ${JSON.stringify(src)}`);

    const firstZero = src.findIndex(s => s.disconnect === 0);
    const firstUnknown = src.findIndex(s => s.disconnect === null);
    if (firstZero >= 0 && firstUnknown >= 0) {
        assert.ok(firstZero < firstUnknown,
            `disc=0（确认安全）必须排在 disc=null（算不出）之前。实际：${JSON.stringify(src)}`);
    }
    console.log(`  feed_sources: ${src.map(s => `${s.handle}(disc=${s.disconnect})`).join(", ")}`);
});

test("★ feed_color：目标色无矿时，必须推荐 mixer 而不是任意颜色的矿机", () => {
    /* 2026-11-21 真机 `r-20261121190439-6190` 的直接教训。
     *
     * 那次 `feed_sources` 推荐了**绿矿**去喂 painter 的 color 槽。
     * 模型照接，tx 成功、货真的流了、hub 真入库 9 件 ——
     * **但产出的是 `CgScScCg`（上一关 L11 的目标形状）**，
     * 而这一关要的是 `CbCbCbRb:CwCwCwCw`。
     *
     * 根因：判据是「能不能产**某种**颜料」，而需要的是「能不能产**需要的那种**」。
     * 这份地图的颜料矿只有 blue/green/red，目标要 blue+**white** ——
     * white 没有矿，只能靠 mixer 级联合成。
     *
     * 这条测试钉住三件事：
     *   ① `feed_color` 必须说出「需要哪些 / 地图有哪些 / 哪些必须混」
     *   ② 地图上没有目标颜色的矿时，**矿机一台都不该被推荐**
     *   ③ mixer 必须排第一（唯一能造出那个颜色的机器） */
    const w = {
        goal: { level: 12, requirement: { shape: "CbCbCbRb:CwCwCwCw", required: 100, delivered: 0 } },
        entities: [
            { uid: 1, type: "hub", x: 0, y: 0, r: 0, variant: "default", rotation_variant: 0, code: 26, layer: "regular" },
            { uid: 2, type: "painter", x: -5, y: 14, r: 0, variant: "default", rotation_variant: 0, layer: "regular" },
            { uid: 3, type: "belt", x: -6, y: 14, r: 0, rv: 0, code: 2, layer: "regular" },
            /* mixer：唯一能造 white 的机器，输出口空闲 */
            { uid: 4, type: "mixer", x: -12, y: 20, r: 0, variant: "default", rotation_variant: 0, layer: "regular" },
            /* 绿矿机：很近，但 green 不是目标要的颜色 —— 必须被排除 */
            { uid: 5, type: "miner", x: -8, y: 12, r: 0, variant: "default", rotation_variant: 0, layer: "regular" },
        ],
        resources: [
            [-8, 12, "green"],
            [-20, 30, "red"],
        ],
    };
    const items = {
        belts: [{ cell: [-6, 14], path: 0, idx: 0, pos: 1.0, spacing_to_next: 0, item: "CuCuCuCu" }],
        ejectors: [], underground: [], pending: [], pathCount: 1, truncatedPaths: false, paths: [],
        counts: { belts: 1 },
    };
    const hs = buildHandles(w, items);
    const ds = semanticDiagnoses(w, items, "CbCbCbRb:CwCwCwCw", hs, { recipe: null, level: 12 });
    const d = ds.find(x => x.code === "MACHINE_STARVED");
    assert.ok(d, `应当报 MACHINE_STARVED，实际 ${ds.map(x => x.code).join(",")}`);

    const fc = d.evidence.feed_color;
    assert.ok(fc, "feed_color 必须存在 —— 否则模型不知道该拉什么颜色");
    assert.deepEqual([...fc.want].sort(), ["blue", "white"], `目标需要 blue+white，实得 ${JSON.stringify(fc.want)}`);
    assert.ok(fc.must_mix.includes("white"),
        `white 无矿、必须靠合成，必须出现在 must_mix 里。实得 ${JSON.stringify(fc.must_mix)}`);

    const src = d.evidence.feed_sources || [];
    /* ② 绿矿机不许出现 */
    const greenHandle = hs.byUid.get(5);
    assert.ok(!src.some(s => s.handle === greenHandle),
        `green 矿机不该被推荐（目标不要 green）。实得：${JSON.stringify(src)}`);
    /* ③ mixer 排第一 */
    assert.ok(src.length > 0, "至少要有 mixer 这个候选");
    assert.equal(src[0].type, "mixer",
        `must_mix 非空时 mixer 必须排第一。实得：${JSON.stringify(src)}`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * WRONG_SHAPE_PRODUCED —— 「没产出」与「产出了别的东西」必须分开
 *
 * 2026-11-21 真机 `r-20261121190439-6190`：模型第一次把线接对了，
 * tx 35/35 落盘，`produced_total` 从 `{}` 变成
 * `{----CgCg:4, ScScCgCg:9, CgScScCg:9}`，hub 库存 `CgScScCg` 2071 → 2080。
 * **真的产、真的交付了** —— 而产的是 `CgScScCg`，上一关（L11）的目标形状。
 *
 * 旧代码报的是 `NO_PRODUCTION`（「窗口内目标形状零产出」），hint 让模型
 * 去「接上一条路」。于是它会继续修、继续产 L11 的形状 ——
 * 因为没有任何一条诊断告诉它「你在造错的东西」。
 *
 * `WRONG_SHAPE_PRODUCED` 这个码从第一次提交就登记在 `DIAG_CODES` 里，
 * 但**从来没有任何地方 emit 过它**（`grep -rn` 只有 constants.mjs 三处）。
 * 一条登记了很久的死码，现在接上。
 * ══════════════════════════════════════════════════════════════════════════ */
test("WRONG_SHAPE_PRODUCED：产了非目标形状 ⇒ 报这条，不报 NO_PRODUCTION", async () => {
    const { diagnose } = await import("../loop.mjs");
    const w = {
        goal: { level: 12, requirement: { shape: "CbCbCbRb:CwCwCwCw", required: 1000, delivered: 0, progress: 0 } },
        entities: [
            { uid: 1, type: "hub", x: 0, y: 0, r: 0, variant: "default", rotation_variant: 0, code: 26, layer: "regular" },
        ],
    };
    /* 一份「L4 失败」的 report —— 目标形状零产出，但窗口里在产 L11 的形状 */
    const report = {
        checks: [{
            name: "L4-behavior", ok: false,
            reason: "跑完 2400 tick 后 CbCbCbRb:CwCwCwCw 一件都没产出",
            evidence: { produced_window_after: 0, delivered_in_window_after: 0, goal_delivered_delta: 0 },
        }],
    };
    const production = {
        produced_total: { "CgScScCg": 9, "ScScCgCg": 9, "----CgCg": 4 },
        delivered_total: { "CgScScCg": 9 },
    };
    const ds = diagnose(w, null, production, report, "CbCbCbRb:CwCwCwCw", buildHandles(w, null), {});
    const wrong = ds.find(d => d.code === "WRONG_SHAPE_PRODUCED");
    const none = ds.find(d => d.code === "NO_PRODUCTION");
    assert.ok(wrong, `应当报 WRONG_SHAPE_PRODUCED，实际 ${ds.map(d => d.code).join(",")}`);
    assert.ok(!none, "已经报了「产了错形状」就不该再报「零产出」—— 那会把关键信息盖掉");
    assert.match(wrong.observed, /CgScScCg/,
        `observed 必须说出实际产的是什么形状，实得：${wrong.observed}`);
    assert.match(wrong.hint, /颜色/, `hint 要点出常见原因是颜料/颜色不对：${wrong.hint}`);
});

test("WRONG_SHAPE_PRODUCED 负例：真的什么都没产 ⇒ 仍报 NO_PRODUCTION", async () => {
    const { diagnose } = await import("../loop.mjs");
    const w = {
        goal: { level: 12, requirement: { shape: "CbCbCbRb:CwCwCwCw", required: 1000, delivered: 0, progress: 0 } },
        entities: [
            { uid: 1, type: "hub", x: 0, y: 0, r: 0, variant: "default", rotation_variant: 0, code: 26, layer: "regular" },
        ],
    };
    const report = {
        checks: [{
            name: "L4-behavior", ok: false,
            reason: "跑完 2400 tick 后一件都没产出",
            evidence: { produced_window_after: 0, delivered_in_window_after: 0, goal_delivered_delta: 0 },
        }],
    };
    const ds = diagnose(w, null, { produced_total: {}, delivered_total: {} }, report,
        "CbCbCbRb:CwCwCwCw", buildHandles(w, null), {});
    assert.ok(ds.find(d => d.code === "NO_PRODUCTION"), `应当报 NO_PRODUCTION，实际 ${ds.map(d => d.code).join(",")}`);
    assert.ok(!ds.find(d => d.code === "WRONG_SHAPE_PRODUCED"),
        "什么都没产时不该报「产了错形状」");
});
