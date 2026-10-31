/**
 * recipe.test.mjs — `loop/recipe.mjs` 的 P-a 验收：**等级门控 + 结构化输出 + 缓存**。
 *
 * 为什么有这份测试（`DIAGNOSE-V2-REDTEAM-VERDICT.md` §11「保留下来的」）：
 *   `solveRecipe("Cu----Cu")` 曾经返回 `cutQuad×2 + stack` —— 而 cutQuad 要 **L16**、
 *   stacker 要 **L10**，`Cu----Cu` 是 **L5** 关卡，存档里一台 stacker 都没有。
 *   这段配方**曾经在 prompt 里骗模型**。门控修的就是它。
 *
 * 两条纪律：
 *   1. **测试里永不真 spawn solver** —— 全部用可注入的 `opts.spawn` stub。
 *      stub 的 payload 是 2026-10-30 从 `node research/ai-player/proto/solver.mjs` **实录**的
 *      （不是手搓的"我以为 solver 会这么说"）。唯一例外是最后一条「19 条自测」，
 *      它跑的就是那个自测文件本身（那 19 条本来就要 spawn）。
 *   2. 门控的**数值**不在这里重复一份：从 `compile.mjs` 导入真常量对拍（防漂移）。
 *
 * 运行：`node --test src/agent/loop/recipe.test.mjs`
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
    recipeFor, recipeForCached, clearRecipeCache, recipeCacheSize, flagsForLevel,
    solveRecipe, renderRecipe, recipeBlock, SOLVER_PATH,
    CUTQUAD_MIN_LEVEL, STACKER_MIN_LEVEL, MIXER_MIN_LEVEL, PAINTER_MIN_LEVEL, ROTATER_MIN_LEVEL,
    TUNNEL_MIN_LEVEL, MIN_LEVEL_FOR_MACHINE, OP_TO_MACHINE, RECIPE_CACHE_CAPACITY, DEFAULT_LEVEL,
} from "./recipe.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");

/* ═══════════════════════ 可注入 spawn + 实录 payload ═══════════════════════ */

/**
 * 造一个 `spawnSync` 兼容的 stub，并记录每次调用的 argv。
 * @param {string|Function} stdout 固定字符串，或 `(argv) => string`
 */
function makeSpawn(stdout, { status = 0, stderr = "", error = null, throwThis = null } = {}) {
    const calls = [];
    const fn = (cmd, argv, opts) => {
        calls.push({ cmd, argv: argv.slice(), opts });
        if (throwThis) throw throwThis;
        return {
            status,
            stdout: typeof stdout === "function" ? stdout(argv) : stdout,
            stderr,
            error,
        };
    };
    fn.calls = calls;
    /** 每次调用实际带上的 `--no-*` flag（顺序敏感：门控列表的顺序是契约的一部分）。 */
    fn.flagsOf = i => calls[i].argv.filter(a => a.startsWith("--no-"));
    return fn;
}

const plan = (steps, ops) => JSON.stringify({ target: "x", solved: true, plan: { targetHash: "x", steps, ops, pigments: [] } });
const step = (hash, op, inputs = [], args = {}) => ({ hash, op, args, inputs, parents: inputs.slice(), depth: 0, kind: "shape" });

/* 实录 ①：`solver Cu----Cu --json`（无门控）—— mine + cutQuad×2 + stack。这就是那个 bug。 */
const CU_OPEN = plan(
    [
        step("CuCuCuCu", "mine"),
        step("------Cu", "cutQuad", ["CuCuCuCu"], { quad: 3 }),
        step("Cu------", "cutQuad", ["CuCuCuCu"], { quad: 0 }),
        step("Cu----Cu", "stack", ["------Cu", "Cu------"], { merge: true }),
    ],
    { mine: 1, cutQuad: 2, stack: 1 },
);

/* 实录 ②：`solver Cu----Cu --json --no-cutquad --no-stacker --no-painter --no-mixer`
 *          （L5 的全部门控）—— mine + cut + rotate。这才是 L5 真解。 */
const CU_GATED = plan(
    [
        step("CuCuCuCu", "mine"),
        step("----CuCu", "cut", ["CuCuCuCu"], { half: "left" }),
        step("Cu----Cu", "rotate", ["----CuCu"], { dir: "cw" }),
    ],
    { mine: 1, cut: 1, rotate: 1 },
);

/* 实录 ③：`solver RuRu---- --json` —— 与带 `--no-cutquad` 时**逐字节相同**（门控不误伤）。 */
const RU_PLAN = plan(
    [
        step("RuRuRuRu", "mine"),
        step("RuRu----", "cut", ["RuRuRuRu"], { half: "right" }),
    ],
    { mine: 1, cut: 1 },
);

/**
 * 忠实复刻 solver 的**分级**行为：`Cu----Cu` 在 cutQuad 被禁时给出 cut+rotate 解，
 * 否则给出 cutQuad+stack 解。其余目标与门控无关。
 *
 * 之所以让 stub 认 flag 而不是每个测试各塞一个固定 payload：
 * 这样「L5 与 L16 的 needs 不同」才是**门控真的生效**的结果，而不是 stub 写死的结果。
 */
const solverStub = (goal, disallowQuad) => {
    if (goal === "Cu----Cu") return disallowQuad ? CU_GATED : CU_OPEN;
    return RU_PLAN;
};
const gatingSpawn = (extra = {}) => {
    const s = makeSpawn(argv => solverStub(argv[1], argv.includes("--no-cutquad")), extra);
    return s;
};

/* ═══════════════════════════ 1. 等级门控 ═══════════════════════════ */

test("门控：L5 的 Cu----Cu 不要 stacker，L16 要（这就是那个真 bug）", () => {
    const s5 = gatingSpawn();
    const r5 = recipeFor("Cu----Cu", { level: 5, spawn: s5 });
    const s16 = gatingSpawn();
    const r16 = recipeFor("Cu----Cu", { level: 16, spawn: s16 });

    assert.equal(r5.ok, true);
    assert.equal(r16.ok, true);

    assert.equal(r5.needs.has("stacker"), false, "L5 的配方不得含 stacker（L16 才解锁）");
    assert.equal(r16.needs.has("stacker"), true, "L16 无门控时才允许出现 stacker");

    /* 双向：L5 必须真的把 --no-stacker/--no-cutquad 传给了 solver，
       而不是"碰巧这个 payload 里没有 stacker"。 */
    assert.deepEqual(s5.flagsOf(0), ["--no-painter", "--no-mixer", "--no-stacker", "--no-cutquad"]);
    assert.deepEqual(s16.flagsOf(0), [], "L16 不该加任何 --no-*");

    assert.deepEqual([...r5.needs.keys()].sort(), ["cutter", "miner", "rotater"]);
    assert.deepEqual(r5.gated, ["--no-painter", "--no-mixer", "--no-stacker", "--no-cutquad"]);
    assert.deepEqual(r16.gated, []);
    assert.equal(r5.level, 5);
    assert.equal(r16.level, 16);
});

test("门控不误伤：RuRu----（L4）在 L4 与 L16 下的 steps 完全相同", () => {
    const s4 = gatingSpawn();
    const s16 = gatingSpawn();
    const r4 = recipeFor("RuRu----", { level: 4, spawn: s4 });
    const r16 = recipeFor("RuRu----", { level: 16, spawn: s16 });

    assert.equal(r4.ok, true);
    assert.equal(r16.ok, true);
    assert.deepEqual(r4.steps, r16.steps, "只做减法：门控不得改变一个本来就不需要高级机器的配方");
    assert.deepEqual([...r4.needs].sort(), [...r16.needs].sort());
    /* 同时确认门控确实生效了（否则上面这条会因为"两边都没门控"而假绿） */
    assert.ok(s4.flagsOf(0).includes("--no-cutquad"));
    assert.deepEqual(s16.flagsOf(0), []);
});

test("flagsForLevel：阈值必须与 compile.mjs 的语义逐档对齐", () => {
    assert.deepEqual(flagsForLevel(1), ["--no-rotater", "--no-painter", "--no-mixer", "--no-stacker", "--no-cutquad"]);
    assert.deepEqual(flagsForLevel(3), ["--no-rotater", "--no-painter", "--no-mixer", "--no-stacker", "--no-cutquad"]);
    assert.deepEqual(flagsForLevel(4), ["--no-painter", "--no-mixer", "--no-stacker", "--no-cutquad"]);
    assert.deepEqual(flagsForLevel(6), ["--no-mixer", "--no-stacker", "--no-cutquad"]);
    assert.deepEqual(flagsForLevel(8), ["--no-stacker", "--no-cutquad"]);
    assert.deepEqual(flagsForLevel(10), ["--no-cutquad"]);
    assert.deepEqual(flagsForLevel(16), []);
    assert.deepEqual(flagsForLevel(99), []);
    /* 非法 level 退回缺省（L4），而不是崩或把门全开 */
    assert.deepEqual(flagsForLevel(undefined), flagsForLevel(DEFAULT_LEVEL));
    assert.deepEqual(flagsForLevel(NaN), flagsForLevel(DEFAULT_LEVEL));
});

/* ═════════════ 2. 防漂移：门限值的真值在 compile.mjs ═════════════ */

test("★ 防漂移：本模块的门限与 compile.mjs 的导出常量逐项相等", async () => {
    const compileMod = await import(pathToFileURL(path.join(REPO, "src/ai/compiler/compile.mjs")).href);

    assert.equal(CUTQUAD_MIN_LEVEL, 16, "quad cutter 是 L16 建筑（human-strategies §2.2）");
    assert.equal(CUTQUAD_MIN_LEVEL, compileMod.CUTQUAD_MIN_LEVEL);

    /* 逐项对拍：compile 的 MIN_LEVEL_FOR_OP 用的是 op 名，本模块用机器名 */
    const opToMachineKey = { rotate: "rotater", paint: "painter", mix: "mixer", stack: "stacker" };
    for (const [op, machine] of Object.entries(opToMachineKey)) {
        assert.equal(
            MIN_LEVEL_FOR_MACHINE[machine], compileMod.MIN_LEVEL_FOR_OP[op],
            `MIN_LEVEL_FOR_MACHINE.${machine} 必须 == compile.mjs MIN_LEVEL_FOR_OP.${op}`,
        );
    }
    assert.equal(ROTATER_MIN_LEVEL, 4);
    assert.equal(PAINTER_MIN_LEVEL, 6);
    assert.equal(MIXER_MIN_LEVEL, 8);
    assert.equal(STACKER_MIN_LEVEL, 10);
    assert.equal(compileMod.MIN_LEVEL_FOR_QUAD, CUTQUAD_MIN_LEVEL);

    /* 隧道：配方层不参与 solver 的 --no-* 映射（它没有对应 flag），但门槛必须与
       op-templates 的唯一真值一致 —— 否则"配方说用隧道"与"编译器拒绝产隧道"会各说一套。 */
    assert.equal(TUNNEL_MIN_LEVEL, 6, "隧道在 levels.js 第 5 关**完成**（level 6）后才解锁");
    assert.equal(MIN_LEVEL_FOR_MACHINE.tunnel, 6);
    const opTemplates = await import(pathToFileURL(path.join(REPO, "src/ai/op-templates.mjs")).href);
    assert.equal(TUNNEL_MIN_LEVEL, opTemplates.TUNNEL_UNLOCKED_LEVEL,
        "MIN_LEVEL_FOR_MACHINE.tunnel 必须 == op-templates.TUNNEL_UNLOCKED_LEVEL");
    assert.equal(opTemplates.UNLOCK_LEVEL_FALLBACK.tunnel, 5,
        "UNLOCK_LEVEL_FALLBACK.tunnel 记的是 levels.js 的**关卡号**（第 5 关），不是可用关卡");
});

test("recipe.mjs 不 import compile.mjs（那是 165ms + 内部 spawnSync，热路径付不起）", async () => {
    const src = fs.readFileSync(path.join(HERE, "recipe.mjs"), "utf8");
    /* 用仓库里**词法级**的 import 收集器（P1 lint 的同一份判据）：
       注释里提到 `compile.mjs` 不算 import —— 头注释正是解释"为什么不 import 它"。 */
    const L = await import(pathToFileURL(path.join(REPO, "research/ai-plan/contract/lint-imports.mjs")).href);
    const specs = L.collectImportSpecifiers(src);
    assert.equal(specs.some(s => /compiler\/compile/.test(s)), false, "recipe.mjs 不得 import compile.mjs");
    /* 零依赖 + 不许持久化：只许 node: 内置，不许 node:fs，不许任何裸包名 */
    for (const sp of specs) {
        assert.ok(sp.startsWith("node:"), `recipe.mjs 只许 import node: 内置，实得 ${sp}`);
    }
    assert.equal(specs.includes("node:fs"), false, "recipe.mjs 不得 import node:fs（缓存不许落盘）");
    assert.equal(/writeFileSync|createWriteStream/.test(src), false);
});

/* ═══════════════════ 3. 结构化输出：closure / raw / needs ═══════════════════ */

test("closure 与 raw：RuRu---- 的闭包含 raw 与 goal，raw 恰好 {RuRuRuRu}", () => {
    const r = recipeFor("RuRu----", { spawn: makeSpawn(RU_PLAN) });

    assert.equal(r.ok, true);
    assert.ok(r.closure instanceof Set);
    assert.ok(r.raw instanceof Set);
    assert.ok(r.closure.has("RuRuRuRu"), "闭包必须含原料 hash");
    assert.ok(r.closure.has("RuRu----"), "闭包必须含目标 hash");
    assert.equal(r.closure.size, 2);
    assert.deepEqual([...r.raw], ["RuRuRuRu"], "raw = 所有 op==='mine' 的 hash，恰好一个");
    /* 目标 hash 不在 raw 里（它不是 mine 出来的） */
    assert.equal(r.raw.has("RuRu----"), false);
});

test("needs 计数：RuRu---- → {miner:1, cutter:1}", () => {
    const r = recipeFor("RuRu----", { spawn: makeSpawn(RU_PLAN) });
    assert.ok(r.needs instanceof Map);
    assert.deepEqual(Object.fromEntries(r.needs), { miner: 1, cutter: 1 });
});

test("needs 计数：cutQuad 也算 cutter（同一种机器，两台）", () => {
    const r = recipeFor("Cu----Cu", { level: 16, spawn: makeSpawn(CU_OPEN) });
    assert.deepEqual(Object.fromEntries(r.needs), { miner: 1, cutter: 2, stacker: 1 });
});

test("needs：颜料节点（mineColor/mix）也映射到机器；raw 只收形状 mine", () => {
    /* 实录：`solver CgScScCg --json --no-cutquad` 的 steps 骨架（颜料是一等节点） */
    const payload = plan(
        [
            step("SuSuSuSu", "mine"),
            step("SuSu----", "cut", ["SuSuSuSu"], { half: "right" }),
            { hash: "color:blue", op: "mineColor", args: { color: "blue" }, inputs: [], parents: [], depth: 1, kind: "pigment" },
            { hash: "color:green", op: "mineColor", args: { color: "green" }, inputs: [], parents: [], depth: 1, kind: "pigment" },
            { hash: "color:cyan", op: "mix", args: { color: "cyan" }, inputs: ["color:blue", "color:green"], parents: ["color:blue", "color:green"], depth: 1, kind: "pigment" },
            step("ScSc----", "paint", ["SuSu----", "color:cyan"], { color: "cyan" }),
            step("CuCuCuCu", "mine"),
            step("----CuCu", "cut", ["CuCuCuCu"], { half: "left" }),
            step("----CgCg", "paint", ["----CuCu", "color:green"], { color: "green" }),
            step("ScScCgCg", "stack", ["ScSc----", "----CgCg"], { merge: true }),
            step("CgScScCg", "rotate", ["ScScCgCg"], { dir: "cw" }),
        ],
        { mine: 2, cut: 2, mineColor: 2, mix: 1, paint: 2, stack: 1, rotate: 1 },
    );
    const r = recipeFor("CgScScCg", { level: 11, spawn: makeSpawn(payload) });

    assert.equal(r.ok, true);
    /* miner: 2 形状矿 + 2 颜料矿 = 4；mixer: 1 */
    assert.deepEqual(Object.fromEntries(r.needs), {
        miner: 4, cutter: 2, mixer: 1, painter: 2, stacker: 1, rotater: 1,
    });
    /* raw 只认形状 mine —— 颜料 hash 不是形状原料 */
    assert.deepEqual([...r.raw].sort(), ["CuCuCuCu", "SuSuSuSu"]);
});

test("ops 与 steps 是 solver 原样（不重写、不排序）", () => {
    const r = recipeFor("RuRu----", { spawn: makeSpawn(RU_PLAN) });
    assert.deepEqual(r.steps, JSON.parse(RU_PLAN).plan.steps);
    assert.deepEqual(r.ops, { mine: 1, cut: 1 });
});

/* ═════════════════════════════ 4. 缓存 ═════════════════════════════ */

test("缓存命中：同 goal+level 调 3 次，spawn 只被调用 1 次", () => {
    clearRecipeCache();
    const s = makeSpawn(RU_PLAN);

    const a = recipeForCached("RuRu----", { level: 4, spawn: s });
    const b = recipeForCached("RuRu----", { level: 4, spawn: s });
    const c = recipeForCached("RuRu----", { level: 4, spawn: s });

    assert.equal(s.calls.length, 1, "三次调用只许 spawn 一次");
    assert.equal(a.ok, b.ok, c.ok);
    assert.deepEqual([...a.closure], [...c.closure]);
    assert.equal(recipeCacheSize(), 1);
});

test("缓存隔离：不同 level 不共享（spawn 被调 2 次）", () => {
    clearRecipeCache();
    const s = gatingSpawn();

    const l5 = recipeForCached("Cu----Cu", { level: 5, spawn: s });
    const l16 = recipeForCached("Cu----Cu", { level: 16, spawn: s });

    assert.equal(s.calls.length, 2, "level 是 key 的一部分");
    assert.equal(l5.needs.has("stacker"), false);
    assert.equal(l16.needs.has("stacker"), true);
    assert.equal(recipeCacheSize(), 2);
});

test("失败也缓存：solved:false 调 2 次，spawn 仍只 1 次", () => {
    clearRecipeCache();
    /* 实录：solver 不可解时打印合法 JSON 并 `exit(2)`（proto/solver.mjs:283） */
    const unsolvable = JSON.stringify({ target: "RuRuRuRu:RuRuRuRu", solved: false, plan: null, stats: { capped: true } });
    const s = makeSpawn(unsolvable, { status: 2 });

    const a = recipeForCached("RuRuRuRu:RuRuRuRu", { level: 16, spawn: s });
    const b = recipeForCached("RuRuRuRu:RuRuRuRu", { level: 16, spawn: s });

    assert.equal(a.ok, false);
    assert.equal(b.ok, false);
    assert.equal(s.calls.length, 1, "失败必须缓存（不可解目标每次重跑都是组合爆炸）");
    assert.equal(a.reason, b.reason);
    assert.match(a.reason, /unreachable/);
});

test("缓存返回**副本**：调用方改 needs/closure 不会污染后面的命中", () => {
    clearRecipeCache();
    const s = makeSpawn(RU_PLAN);

    const a = recipeForCached("RuRu----", { level: 4, spawn: s });
    a.needs.set("stacker", 99);
    a.closure.add("POISON");

    const b = recipeForCached("RuRu----", { level: 4, spawn: s });
    assert.equal(s.calls.length, 1);
    assert.equal(b.needs.has("stacker"), false, "缓存里的 needs 不得被上一次调用改动");
    assert.equal(b.closure.has("POISON"), false, "缓存里的 closure 不得被上一次调用改动");
});

test("LRU：超过容量后淘汰最久未用的（容量上限 8）", () => {
    clearRecipeCache();
    assert.equal(RECIPE_CACHE_CAPACITY, 8);

    const s = makeSpawn(RU_PLAN);
    const goals = ["A1A1----", "A2A2----", "A3A3----", "A4A4----", "A5A5----", "A6A6----", "A7A7----", "A8A8----"];
    for (const g of goals) recipeForCached(g, { level: 4, spawn: s });
    assert.equal(recipeCacheSize(), 8);

    /* 摸一下最早那个，让它变成"最近使用" */
    recipeForCached(goals[0], { level: 4, spawn: s });
    /* 再塞第 9 个 → 该淘汰的应是 goals[1]（现在最久未用） */
    recipeForCached("A9A9----", { level: 4, spawn: s });
    assert.equal(recipeCacheSize(), 8);

    const before = s.calls.length;
    recipeForCached(goals[0], { level: 4, spawn: s });
    assert.equal(s.calls.length, before, "goals[0] 应仍在缓存里");
    recipeForCached(goals[1], { level: 4, spawn: s });
    assert.equal(s.calls.length, before + 1, "goals[1] 应已被淘汰（LRU，不是 FIFO）");
});

test("clearRecipeCache 清空（测试隔离靠它）", () => {
    clearRecipeCache();
    const s = makeSpawn(RU_PLAN);
    recipeForCached("RuRu----", { level: 4, spawn: s });
    assert.equal(recipeCacheSize(), 1);
    clearRecipeCache();
    assert.equal(recipeCacheSize(), 0);
    recipeForCached("RuRu----", { level: 4, spawn: s });
    assert.equal(s.calls.length, 2);
});

test("缓存 key 含 goal：不同目标不串味", () => {
    clearRecipeCache();
    const s = gatingSpawn();
    const a = recipeForCached("RuRu----", { level: 4, spawn: s });
    const b = recipeForCached("Cu----Cu", { level: 4, spawn: s });
    assert.equal(s.calls.length, 2);
    assert.deepEqual([...a.closure], ["RuRuRuRu", "RuRu----"]);
    assert.deepEqual([...b.closure].sort(), ["----CuCu", "Cu----Cu", "CuCuCuCu"]);
});

/* ═══════════════════════════ 5. 降级路径 ═══════════════════════════ */

test("降级：spawn 抛错 ⇒ ok:false + reason，不抛", () => {
    const s = makeSpawn(null, { throwThis: new Error("ENOENT: no such file") });
    let r;
    assert.doesNotThrow(() => { r = recipeFor("RuRu----", { spawn: s }); });
    assert.equal(r.ok, false);
    assert.match(r.reason, /spawn failed.*ENOENT/);
    /* 失败时叶子字段可以缺，但 level/gated 这些元信息仍要在（方便调用方记日志） */
    assert.equal(r.level, 4);
    assert.deepEqual(r.gated, flagsForLevel(4));
    assert.equal(r.steps, undefined);
});

test("降级：res.error（超时）⇒ ok:false，reason 带 spawn error", () => {
    const s = makeSpawn("", { error: Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }) });
    const r = recipeFor("RuRu----", { spawn: s });
    assert.equal(r.ok, false);
    assert.match(r.reason, /spawn error/);
});

test("降级：非 JSON 输出 ⇒ ok:false", () => {
    const r = recipeFor("RuRu----", { spawn: makeSpawn("Error: boom\n") });
    assert.equal(r.ok, false);
    assert.match(r.reason, /not JSON/);
});

test("降级：空 goal ⇒ ok:false，且根本不 spawn", () => {
    const s = makeSpawn(RU_PLAN);
    const r = recipeFor("", { spawn: s });
    assert.equal(r.ok, false);
    assert.equal(s.calls.length, 0);
});

test("solved:true 却非零退出 ⇒ ok:false（solver 自相矛盾不许静默吞）", () => {
    const r = recipeFor("RuRu----", { spawn: makeSpawn(RU_PLAN, { status: 3 }) });
    assert.equal(r.ok, false);
    assert.match(r.reason, /self-contradictory/);
});

/* ═══════════════ 6. 既有接口行为不许变（冻结面） ═══════════════ */

test("solveRecipe 行为不变：不带门控、status!==0 先判退出码", () => {
    /* 旧行为：status 非 0 ⇒ 直接 `solver exited N`，哪怕 stdout 是合法 solved:true JSON。
       recipeFor 走 tolerateUnsolvable 才先解析 —— 两条路径刻意不同，这条测试锁住它。 */
    const s = makeSpawn(RU_PLAN, { status: 2 });
    const r = solveRecipe("RuRu----", { spawn: s });
    assert.equal(r.ok, false);
    assert.match(r.reason, /^solver exited 2$/);
    assert.deepEqual(s.flagsOf(0), [], "solveRecipe 不得加任何 --no-*（行为冻结）");

    const okSpawn = makeSpawn(RU_PLAN);
    const ok = solveRecipe("RuRu----", { spawn: okSpawn });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.steps, JSON.parse(RU_PLAN).plan.steps);
    assert.deepEqual(ok.ops, { mine: 1, cut: 1 });
    assert.deepEqual(ok.pigments, []);
});

test("renderRecipe / recipeBlock 输出与改动前一致（金样本逐字）", () => {
    const r = solveRecipe("RuRu----", { spawn: makeSpawn(RU_PLAN) });
    const txt = renderRecipe(r);
    assert.equal(txt, [
        "## RECIPE (how the goal shape is made — computed, do NOT guess)",
        "The toolchain already solved how to build this shape. Follow it instead of guessing which machines to add.",
        '  RuRuRuRu  ⇐  mine   [mine it]',
        '  RuRu----  ⇐  cut(half="right") from RuRuRuRu   [cut it with a cutter]',
        "⇒ machines this shape needs: miner×1, cutter×1",
        "⇒ it does NOT need: rotater, stacker, painter — no such step appears above. Do not add them.",
    ].join("\n"));

    const blk = recipeBlock("RuRu----", { spawn: makeSpawn(RU_PLAN) });
    assert.equal(blk.text, txt);
    assert.equal(blk.reason, null);
});

test("renderRecipe 对颜料节点不数 mineColor/mix（旧渲染口径冻结）", () => {
    /* 与上面 needs 的完整映射是**两套口径**，有意为之：渲染器输出是模型的既有输入，
       把颜料矿算进 miner×N 会改动已交付的 prompt 文本。 */
    const payload = plan(
        [
            step("SuSuSuSu", "mine"),
            { hash: "color:green", op: "mineColor", args: { color: "green" }, inputs: [], parents: [], depth: 1, kind: "pigment" },
            step("RgRgRgRg", "paint", ["SuSuSuSu", "color:green"], { color: "green" }),
        ],
        { mine: 1, mineColor: 1, paint: 1 },
    );
    const r = solveRecipe("RgRgRgRg", { spawn: makeSpawn(payload) });
    const txt = renderRecipe(r);
    assert.match(txt, /machines this shape needs: miner×1, painter×1/);
    assert.equal(/miner×2/.test(txt), false);
    /* 但结构化 needs 认颜料矿 */
    const st = recipeFor("RgRgRgRg", { spawn: makeSpawn(payload) });
    assert.equal(st.needs.get("miner"), 2);
});

/* ═════════════ 7. 真 solver 的对照（不 spawn，只读源码里的 flag 表） ═════════════ */

test("solver 真的认这 5 个 flag（防「我给了一个它不认识的 --no-xxx」）", () => {
    const src = fs.readFileSync(SOLVER_PATH, "utf8");
    for (const f of ["--no-rotater", "--no-painter", "--no-mixer", "--no-stacker", "--no-cutquad"]) {
        assert.ok(src.includes(`"${f}"`), `solver.mjs 的 FLAGS 必须含 ${f}`);
    }
    /* 门限方向：flag 名 → solver 的 ops.* 开关名（compile.mjs 的 argv 拼法同源） */
    assert.ok(/cutQuad:\s*!flag\("--no-cutquad"\)/.test(src));
    assert.ok(/stack:\s*!flag\("--no-stacker"\)/.test(src));
    assert.ok(/mixer:\s*!flag\("--no-mixer"\)/.test(src));
});

test("OP_TO_MACHINE 覆盖 solver 的全部形状 op（漏一个会让 needs 静默少算）", () => {
    for (const op of ["mine", "cut", "cutQuad", "rotate", "paint", "paintQuad", "stack"]) {
        assert.ok(OP_TO_MACHINE[op], `OP_TO_MACHINE 缺 ${op}`);
    }
    assert.equal(OP_TO_MACHINE.cutQuad, "cutter", "cutQuad 是 cutter 的变体，不是新机器");
    assert.equal(OP_TO_MACHINE.mineColor, "miner");
    assert.equal(OP_TO_MACHINE.mix, "mixer");
});

/* ═══════════════════ 8. 原有 19 条自测仍然全绿 ═══════════════════ */

test("recipe.mjs 自带 19 条自测全绿（真 solver；唯一会在测试里 spawn 的一条）", () => {
    const r = spawnSync(process.execPath, [path.join(HERE, "recipe.mjs")], {
        encoding: "utf8", cwd: REPO, timeout: 120000,
    });
    const out = (r.stdout || "") + (r.stderr || "");
    const m = out.match(/recipe 自测：(\d+) 通过 \/ (\d+) 失败/);
    assert.ok(m, `自测没打印汇总行：${out.slice(-400)}`);
    assert.equal(m[2], "0", `自测有失败：\n${out.split("\n").filter(l => l.startsWith("✗")).join("\n")}`);
    assert.equal(m[1], "19", "原有 19 条自测必须全部保留");
    assert.equal(r.status, 0);
});
