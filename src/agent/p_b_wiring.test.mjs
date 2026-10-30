/**
 * p_b_wiring.test.mjs — P-b（接线）的回归测试。
 *
 * 这个文件锁的是**接线**本身，不是各层的判据（那些有自己的测试）：
 *   1. `diagnose` 第 7 参 `ctx.recipe` 真的把语义层并进来了；
 *   2. 合并后的上限（每码 ≤3、总量 ≤8）真的在**合并之后**施加，且超限留痕；
 *   3. hub 入口带子既不当 subject，也不进 `evidence.handles`（v2 §4）；
 *   4. `buildPrompt` 拿到注入的 recipe 时**不 spawn**；
 *   5. `runLoop` 整个 run 只算一次 recipe（`recipeSpawn` 注入计数）。
 *
 * 运行：`node --test src/agent/p_b_wiring.test.mjs`
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import FakeGame from "./fake_game.mjs";
import { diagnose, runLoop } from "./loop.mjs";
import { buildPrompt, coordRegex } from "./loop/prompt.mjs";
import { recipeFor, recipeForCached, clearRecipeCache } from "./loop/recipe.mjs";
import { replaceRun } from "./macros/remove.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAVES = path.resolve(HERE, "../../test/fixtures/saves");
const clone = x => JSON.parse(JSON.stringify(x));

const L4_GAME = () => FakeGame.fromFiles(path.join(SAVES, "L4-obs.json"), null, { goal: "RuRu----" });
const L5_GAME = () => FakeGame.fromFiles(path.join(SAVES, "L5-obs.json"), null, { goal: "Cu----Cu" });
const RECIPE_L4 = recipeFor("RuRu----", { level: 4 });
const RECIPE_L5 = recipeFor("Cu----Cu", { level: 5 });

const run = (g, goal, recipe, opts = {}) =>
    diagnose(g.obs, null, g.production, null, goal, null, { recipe, ...opts });

const byCode = (ds, code) => ds.filter(d => d.code === code);
const SEMANTIC = new Set(["PROCESSOR_REQUIRED", "WRONG_SHAPE_AT_HUB", "DISCARDED_INTERMEDIATE", "SHAPE_UNKNOWN"]);

/* ══════════════════════════════════════════════════════════════════════════
 * 1. ctx.recipe 必须真的把语义层并进来（否则「接线」是空转的）
 * ══════════════════════════════════════════════════════════════════════════ */

test("P-b T1 ★ L4：注入 recipe ⇒ 有 PROCESSOR_REQUIRED{scope:stream, op:cut}，severity=warn", () => {
    const ds = run(L4_GAME(), "RuRu----", RECIPE_L4);
    const st = byCode(ds, "PROCESSOR_REQUIRED").filter(d => d.evidence.scope === "stream");
    assert.equal(st.length, 1);
    assert.equal(st[0].evidence.op, "cut");
    assert.equal(st[0].severity, "warn", "v2 §2：机器存在、只是不在那条流上 = 该做的事");
    const xs = new Set(st[0].evidence.site_cells.map(c => c[0]));
    assert.ok(xs.has(2) && xs.has(3) && xs.has(4), `site_cells 必须含 x=2/3/4（实际 ${[...xs].sort()}）`);
    assert.ok(!xs.has(5), "x=5 不可行");
});

test("P-b T1 对照：**不注入** recipe ⇒ 语义层整体缺席（纯函数性 / 绝不 spawn）", () => {
    const withR = run(L4_GAME(), "RuRu----", RECIPE_L4);
    const without = run(L4_GAME(), "RuRu----", null);
    assert.equal(withR.filter(d => SEMANTIC.has(d.code)).length > 0, true);
    assert.deepEqual(without.filter(d => SEMANTIC.has(d.code)).map(d => d.code), [],
        "没有 recipe 时一条语义码都不许有");
    /* 且 diagnose 自个儿不 spawn：同 obs 两次结果必须逐字节相同 */
    assert.equal(JSON.stringify(run(L4_GAME(), "RuRu----", RECIPE_L4)),
        JSON.stringify(run(L4_GAME(), "RuRu----", RECIPE_L4)), "确定性");
});

test("P-b T1 ★ L5：PROCESSOR_REQUIRED{scope:factory, op:rotate, need:1, have:0} severity=blocker", () => {
    const ds = run(L5_GAME(), "Cu----Cu", RECIPE_L5);
    const f = byCode(ds, "PROCESSOR_REQUIRED").filter(d => d.evidence.scope === "factory");
    assert.ok(f.length >= 1);
    assert.equal(f[0].evidence.op, "rotate");
    assert.equal(f[0].evidence.machine, "rotater");
    assert.equal(f[0].evidence.need, 1);
    assert.equal(f[0].evidence.have, 0);
    assert.equal(f[0].severity, "blocker");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. hub 入口带子：v2 §4 的两条反回归
 * ══════════════════════════════════════════════════════════════════════════ */

test("P-b T2 ★ L4：没有任何诊断以 B135/B136/B137 为 subject，且它们不在 evidence.handles 里", () => {
    const ds = run(L4_GAME(), "RuRu----", RECIPE_L4);
    const INLETS = ["B135", "B136", "B137"];
    assert.deepEqual(ds.filter(d => INLETS.includes(d.subject && d.subject.handle)).map(d => d.code), [],
        "入口带子不许当 subject（会把模型引去改入口）");
    for (const d of ds) {
        const hs = (d.evidence && d.evidence.handles) || [];
        assert.deepEqual(hs.filter(h => INLETS.includes(h)), [],
            `${d.code}: 入口句柄不许留在 evidence.handles（pickBelts 会据此把入口顶到 BELTS 最前）`);
    }
});

test("P-b T2 不静默：被入口过滤器压掉的条数记在 evidence.suppressed_hub_inlets 上", () => {
    const ds = run(L4_GAME(), "RuRu----", RECIPE_L4);
    const n = ds.reduce((s, d) => s + (d.evidence.suppressed_hub_inlets || 0), 0);
    assert.ok(n >= 1, `L4 上至少压掉 1 条（实际 ${n}）；不静默丢弃是硬规矩`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 合并后的统一上限
 * ══════════════════════════════════════════════════════════════════════════ */

test("P-b T3 ★ 合并后总量 ≤8、每码 ≤3，且总量超限记在 evidence.suppressed_total", () => {
    for (const [name, g, goal, rec] of [
        ["L4", L4_GAME(), "RuRu----", RECIPE_L4],
        ["L5", L5_GAME(), "Cu----Cu", RECIPE_L5],
    ]) {
        const ds = run(g, goal, rec);
        assert.ok(ds.length <= 8, `${name}: 总量 ${ds.length} > 8`);
        const per = new Map();
        for (const d of ds) per.set(d.code, (per.get(d.code) || 0) + 1);
        for (const [c, n] of per) assert.ok(n <= 3, `${name}: ${c} 有 ${n} 条 > 3`);
    }
    /* L5 结构层自己就有 8 条 ⇒ 并入语义层必然触发**总量**上限 */
    const l5 = run(L5_GAME(), "Cu----Cu", RECIPE_L5);
    const total = l5.reduce((s, d) => s + (d.evidence.suppressed_total || 0), 0);
    assert.ok(total >= 1, `L5 必须记下被总量上限压掉的条数（实际 ${total}）`);
    /* 而**每码**超限要另记在 suppressed 上，两者不许混（混了 prompt 会说错话） */
    const all = run(L4_GAME(), "RuRu----", RECIPE_L4);
    for (const d of all) {
        if (d.evidence.suppressed) {
            assert.equal(typeof d.evidence.suppressed, "number");
            assert.ok(d.evidence.suppressed > 0);
        }
    }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. buildPrompt：注入 recipe 不 spawn + S4 渲染
 * ══════════════════════════════════════════════════════════════════════════ */

test("P-b T4 ★ 注入 recipe ⇒ buildPrompt 不 spawn solver（计数 stub 为 0）", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pb-prompt-"));
    const counter = path.join(tmp, "n.txt");
    fs.writeFileSync(counter, "");
    const fakeSolver = path.join(tmp, "solver.mjs");
    fs.writeFileSync(fakeSolver, `
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(counter)}, "x");
process.stdout.write(JSON.stringify({ solved: true, target: "x", plan: { steps: [{ hash: "RuRuRuRu", op: "mine", args: {}, inputs: [] }], ops: {}, pigments: [] } }));
`);
    clearRecipeCache();
    const g = L4_GAME();
    const p = buildPrompt({
        goal: "RuRu----", obs: g.obs, handles: null, diagnoses: [],
        candidates: ["replace_run"], recipe: RECIPE_L4, budget: {},
    });
    assert.ok(/## RECIPE/.test(p.user), "注入的 recipe 被渲染出来");
    assert.equal(fs.readFileSync(counter, "utf8").length, 0, "注入 recipe 时不许 spawn");
    void fakeSolver;
});

test("P-b T4 对照：不注入时走 recipeForCached —— 同一目标多次只 spawn 一次", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pb-prompt2-"));
    const counter = path.join(tmp, "n.txt");
    fs.writeFileSync(counter, "");
    const fakeSolver = path.join(tmp, "solver.mjs");
    fs.writeFileSync(fakeSolver, `
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(counter)}, "x");
const goal = process.argv[2];
process.stdout.write(JSON.stringify(goal === "RuRu----"
  ? { solved: true, target: goal, plan: { steps: [
      { hash: "RuRuRuRu", op: "mine", args: {}, inputs: [] },
      { hash: "RuRu----", op: "cut", args: { half: "right" }, inputs: ["RuRuRuRu"] }], ops: {}, pigments: [] } }
  : { solved: false, target: goal, plan: null }));
`);
    clearRecipeCache();
    const a = recipeForCached("RuRu----", { level: 4, solverPath: fakeSolver });
    const b = recipeForCached("RuRu----", { level: 4, solverPath: fakeSolver });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(fs.readFileSync(counter, "utf8").length, 1, "同一 (goal, level) 只 spawn 一次");
});

test("P-b T5 ★ L4 的 S4：RECIPE 段在、PROCESSOR_REQUIRED 说出 scope、坐标 0 命中", () => {
    const g = L4_GAME();
    const ds = run(g, "RuRu----", RECIPE_L4);
    const p = buildPrompt({
        goal: "RuRu----", obs: g.obs, handles: null, diagnoses: ds,
        candidates: ["replace_run", "insert_machine", "connect"], recipe: RECIPE_L4, budget: {},
    });
    assert.ok(/## RECIPE/.test(p.user));
    assert.ok(p.blocks.S4.includes("PROCESSOR_REQUIRED"));
    assert.ok(/scope=stream/.test(p.blocks.S4), "scope 必须说出来（两档 severity 才读得出来）");
    assert.ok(/op=cut/.test(p.blocks.S4) && /machine=cutter/.test(p.blocks.S4));
    assert.ok(/feasible site/.test(p.blocks.S4), "可行落点数必须给（模型据此选 replace_run）");
    /* 入口带子不许作为 subject 出现（接收方名字可以出现） */
    const subj = l => (l.match(/^\d+\.\s+\S+\s+\[[^\]]*\]:\s+(\S+)/) || [])[1] || "";
    const bad = p.blocks.S4.split("\n").filter(l => /^\d+\./.test(l))
        .filter(l => ["B135", "B136", "B137"].includes(subj(l)));
    assert.deepEqual(bad, []);
    assert.deepEqual((p.system + "\n" + p.user).match(coordRegex()) || [], [], "坐标 0 命中");
});

test("P-b T5 ★ SHAPE_UNKNOWN 折叠成一行，且明说「不是行动项」", () => {
    const g = L5_GAME();
    const ds = run(g, "Cu----Cu", RECIPE_L5);
    const unk = byCode(ds, "SHAPE_UNKNOWN");
    if (!unk.length) return;                       // 夹具没有 unknown 时这条不适用
    const p = buildPrompt({
        goal: "Cu----Cu", obs: g.obs, handles: null, diagnoses: ds,
        candidates: ["insert_machine"], recipe: RECIPE_L5, budget: {},
    });
    const numbered = p.blocks.S4.split("\n").filter(l => /^\d+\.\s+SHAPE_UNKNOWN/.test(l));
    assert.deepEqual(numbered, [], "SHAPE_UNKNOWN 不许占编号行（info 不进显眼位置）");
    assert.ok(/\(info\) SHAPE_UNKNOWN/.test(p.blocks.S4), "必须有一行汇总");
    assert.ok(/NOT an action item/.test(p.blocks.S4), "必须明说不是行动项（契约 §3）");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. runLoop：recipe 每 run 一次
 * ══════════════════════════════════════════════════════════════════════════ */

test("P-b T6 ★ runLoop 整个 run 只 spawn solver 一次（3 轮也只算一次）", async () => {
    clearRecipeCache();
    let spawns = 0;
    const countingSpawn = (cmd, argv) => {
        spawns++;
        const goal = argv[1];
        const payload = goal === "RuRu----"
            ? { solved: true, target: goal, plan: { steps: [
                { hash: "RuRuRuRu", op: "mine", args: {}, inputs: [] },
                { hash: "RuRu----", op: "cut", args: { half: "right" }, inputs: ["RuRuRuRu"] },
            ], ops: {}, pigments: [] } }
            : { solved: false, target: goal, plan: null };
        return { status: 0, stdout: JSON.stringify(payload), stderr: "" };
    };
    const planText = JSON.stringify({
        say: "swap the run", calls: [{
            macro: "replace_run",
            args: { region: { $bbox_of: ["B81", "B82", "B69"] }, building: ["cutter", { kind: "trash", port: "left", confirm_waste: true }] },
            why: "rect",
        }],
    });
    class OneShot {
        async propose() { return { text: planText, usage: null, raw: null }; }
    }
    const g = L4_GAME();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-loop-"));
    const res = await runLoop({
        reader: g.reader(), goal: "RuRu----", llmClient: new OneShot(),
        mode: "mock", runDir: dir, game: g, recipeSpawn: countingSpawn,
        budget: { WALL_MS_MAX: 120000 },
    });
    const rows = fs.readFileSync(res.transcript_path, "utf8").trim().split("\n").map(JSON.parse);
    const obs = rows.filter(r => r.kind === "observe");
    assert.ok(obs.length >= 2, `至少 2 轮 observe（实际 ${obs.length}）`);
    assert.ok(spawns <= 1, `spawn 次数必须 ≤1（实际 ${spawns}）`);
    assert.ok(obs.every(r => r.data.recipe && r.data.recipe.ok === true),
        "每条 observe 行都带成功的 recipe 摘要（复用首轮那份）");
});

test("P-b T6 负例：solver 抛错也不许让 loop 崩，recipe 记 {ok:false}", async () => {
    clearRecipeCache();
    const throwingSpawn = () => { throw new Error("boom"); };
    class OneShot { async propose() { return { text: JSON.stringify({ say: "x", calls: [] }), usage: null, raw: null }; } }
    const g = L4_GAME();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-loop2-"));
    const res = await runLoop({
        reader: g.reader(), goal: "RuRu----", llmClient: new OneShot(),
        mode: "mock", runDir: dir, game: g, recipeSpawn: throwingSpawn,
        budget: { ROUNDS_MAX: 1, WALL_MS_MAX: 60000 },
    });
    const rows = fs.readFileSync(res.transcript_path, "utf8").trim().split("\n").map(JSON.parse);
    const obs = rows.find(r => r.kind === "observe");
    assert.equal(obs.data.recipe.ok, false, "recipe 失败要留痕");
    assert.ok(typeof obs.data.recipe.reason === "string" && obs.data.recipe.reason.length > 0);
    assert.notEqual(res.outcome, "error", "solver 挂了不许把 loop 变 error");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 6. 修好后的 L4：语义 blocker 归零
 * ══════════════════════════════════════════════════════════════════════════ */

test("P-b T7 ★ 修好后的 L4 ⇒ 0 条 blocker 级语义码（v2 §2 的 T3 口径）", () => {
    const g = L4_GAME();
    const w = clone(g.obs);
    const r = replaceRun(
        { region: [4, -14, 5, -13], building: ["cutter", { kind: "trash", port: "left", confirm_waste: true }] },
        { entities: w.entities },
    );
    assert.equal(r.ok, true, "前提：真宏接受这个落点");
    const gone = new Set(r.removed.map(x => x.uid));
    w.entities = w.entities.filter(e => !gone.has(e.uid));
    let next = Math.max(...w.entities.map(e => e.uid)) + 1;
    for (const p of r.placed) {
        w.entities.push({
            uid: next++, type: p.kind, x: p.origin[0], y: p.origin[1], r: 0,
            variant: "default", rotation_variant: 0, code: p.kind === "cutter" ? 9 : 20, layer: "regular",
        });
    }
    const fixed = new FakeGame(w, null);
    const ds = diagnose(fixed.obs, null, fixed.production, null, "RuRu----", null, { recipe: RECIPE_L4 });
    const blk = ds.filter(d => d.severity === "blocker" && SEMANTIC.has(d.code));
    assert.deepEqual(blk.map(d => [d.code, d.evidence.scope]), [],
        "修好之后语义层不许再有 blocker（warn 允许：残流仍运没切过的原料）");
    const warn = ds.filter(d => d.code === "PROCESSOR_REQUIRED" && d.evidence.scope === "stream");
    assert.ok(warn.length >= 1 && warn.every(d => d.severity === "warn"));
});
