/**
 * `memory.e2e.test.mjs` —— 跨 run 记忆在 `runLoop` 里的接线。
 *
 * `memory.test.mjs` 测的是纯函数；这个文件测的是**两次 run 之间真的传下去了**。
 *
 * 钉住四件事：
 *   1. 记忆落在 `runDirRoot`（run 目录的上一级），不是某一次 run 的目录里；
 *   2. run 结束（不管 outcome）都写；
 *   3. 下一次 run 的 prompt 里出现 `## PRIOR ATTEMPTS`，且内容是本目标的；
 *   4. 换了 `goal_shape` 就看不到旧目标的记录。
 *
 * 运行：`node --test src/agent/loop/memory.e2e.test.mjs`
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import FakeGame from "../fake_game.mjs";
import { runLoop, readTranscript } from "../loop.mjs";
import { LLMClient } from "./llm.mjs";
import { MEMORY_FILE, loadMemory } from "./memory.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAVES = path.resolve(HERE, "../../../test/fixtures/saves");
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "mem-e2e-"));

class Scripted extends LLMClient {
    constructor(texts) {
        super();
        this.texts = texts;
        this.n = 0;
        this.bundles = [];
    }
    async propose(bundle) {
        this.bundles.push(bundle);
        const t = this.texts[Math.min(this.n, this.texts.length - 1)];
        this.n++;
        return { text: typeof t === "string" ? t : JSON.stringify(t), usage: null, raw: null };
    }
}

/**
 * ★ 一次 run 必须用**同一个** FakeGame 实例做 reader 与 game ★
 *
 * 写成 `reader: l4().reader(), game: l4()` 会创建两个实例：写面改 A、
 * 读面读 B —— 世界永远不变，每条 netEffect 都是 inert，这些 e2e 用例
 * 实际测的是「什么都没发生」的退化场景。（真踩过：加了这条注释前的版本就这样。）
 */
const mkGame = () => {
    const g = l4();
    return { reader: g.reader(), game: g, g };
};
const l4 = () => FakeGame.fromFiles(path.join(SAVES, "L4-obs.json"), null, { goal: "RuRu----" });

/** L4 官方正解的第一次施工（会真的落盘，产生可记的净效果）。 */
const L4_CALL = {
    macro: "replace_run",
    args: {
        region: { $bbox_of: ["B81", "B82", "B69"] },
        building: ["cutter", { kind: "trash", port: "left", confirm_waste: true }],
    },
};
const PLAN = { say: "swap in a cutter", calls: [L4_CALL] };

const budget = () => ({
    ROUNDS_MAX: 2, LLM_CALLS_MAX: 4, TX_MAX: 2,
    WALL_MS_MAX: 180000, TICKS_MAX: 2400 * 8,
});

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 落盘位置与时机
 * ══════════════════════════════════════════════════════════════════════════ */

test("X1 ★ 记忆落在 runDirRoot（run 目录的上一级）", async () => {
    const root = tmpDir();
    const res = await runLoop({
        ...mkGame(),
        llmClient: new Scripted([PLAN]),
        goal: "RuRu----", mode: "mock", runDir: root, budget: budget(),
    });
    assert.ok(fs.existsSync(path.join(root, MEMORY_FILE)),
        "attempts.json 必须在 runDirRoot 下（它是跨 run 的）");
    assert.ok(!fs.existsSync(path.join(res.run_dir, MEMORY_FILE)),
        "不该落在某一次 run 的目录里");
    assert.equal(res.memory_saved, true);
});

test("X2 run_end 里带 memory_saved / memory_file", async () => {
    const res = await runLoop({
        ...mkGame(),
        llmClient: new Scripted([PLAN]),
        goal: "RuRu----", mode: "mock", runDir: tmpDir(), budget: budget(),
    });
    const end = readTranscript(res.transcript_path).filter(r => r.kind === "run_end").pop();
    assert.equal(end.data.memory_saved, true);
    assert.equal(end.data.memory_file, MEMORY_FILE);
});

test("X3 ★ 即使 outcome=halt（预算耗尽）也写记忆 —— 失败的 run 最有信息量", async () => {
    const root = tmpDir();
    const res = await runLoop({
        ...mkGame(),
        llmClient: new Scripted([PLAN]),
        goal: "RuRu----", mode: "mock", runDir: root, budget: budget(),
    });
    assert.notEqual(res.outcome, "success", "前提：这次 run 不是 success");
    const mem = loadMemory(path.join(root, MEMORY_FILE));
    assert.ok(Object.keys(mem.goals).length > 0, "halt 也要留下经验");
});

test("X4 记忆里带 goal 分组、宏名、kind（不是空壳）", async () => {
    const root = tmpDir();
    await runLoop({
        ...mkGame(),
        llmClient: new Scripted([PLAN]),
        goal: "RuRu----", mode: "mock", runDir: root, budget: budget(),
    });
    const mem = loadMemory(path.join(root, MEMORY_FILE));
    const rows = mem.goals["RuRu----"] || [];
    assert.ok(rows.length > 0, `RuRu---- 下必须有记录，实得 ${JSON.stringify(Object.keys(mem.goals))}`);
    assert.ok(rows.every(r => Array.isArray(r.macros) && r.macros.length > 0));
    assert.ok(rows.every(r => typeof r.kind === "string"));
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 第二次 run 真的读到了
 * ══════════════════════════════════════════════════════════════════════════ */

test("X5 ★ 第二次 run 的 prompt 里出现 ## PRIOR ATTEMPTS", async () => {
    const root = tmpDir();

    /* 第 1 次 run：产生记忆 */
    await runLoop({
        ...mkGame(),
        llmClient: new Scripted([PLAN]),
        goal: "RuRu----", mode: "mock", runDir: root, budget: budget(),
    });
    const mem = loadMemory(path.join(root, MEMORY_FILE));
    assert.ok((mem.goals["RuRu----"] || []).length >= 1,
        "前提：至少要有 1 条记录（通常正好是那条 regressive 负例）");

    /* 第 2 次 run：换一个全新世界，但同一个 runDir */
    const client2 = new Scripted([PLAN]);
    await runLoop({
        ...mkGame(), llmClient: client2,
        goal: "RuRu----", mode: "mock", runDir: root, budget: budget(),
    });
    assert.ok(client2.bundles.length > 0);
    const u = client2.bundles[0].user;
    assert.match(u, /## PRIOR ATTEMPTS/, "第二轮的 prompt 必须带历史段");
    assert.match(u, /your own past attempts on THIS goal/);
});

test("X6 PRIOR ATTEMPTS 排在 LAST ROUND 之前（历史不该盖过眼前）", async () => {
    const root = tmpDir();
    await runLoop({
        ...mkGame(),
        llmClient: new Scripted([PLAN]),
        goal: "RuRu----", mode: "mock", runDir: root, budget: budget(),
    });
    const c = new Scripted([PLAN, PLAN]);
    await runLoop({
        ...mkGame(), llmClient: c,
        goal: "RuRu----", mode: "mock", runDir: root, budget: budget(),
    });
    const u = c.bundles.find(b => /## PRIOR ATTEMPTS/.test(b.user));
    if (u) {
        assert.ok(u.user.indexOf("## PRIOR ATTEMPTS") < u.user.indexOf("## LAST ROUND"));
    }
});

test("X7 历史段不含坐标 / uid（与 prompt 的坐标系防火墙一致）", async () => {
    const root = tmpDir();
    await runLoop({
        ...mkGame(),
        llmClient: new Scripted([PLAN]),
        goal: "RuRu----", mode: "mock", runDir: root, budget: budget(),
    });
    const c = new Scripted([PLAN]);
    await runLoop({
        ...mkGame(), llmClient: c,
        goal: "RuRu----", mode: "mock", runDir: root, budget: budget(),
    });
    const u = c.bundles[0].user;
    const i = u.indexOf("## PRIOR ATTEMPTS");
    if (i >= 0) {
        const seg = u.slice(i, u.indexOf("## LAST STEP", i) > i
            ? u.indexOf("## LAST STEP", i) : (u.indexOf("## LAST ROUND", i) > i ? u.indexOf("## LAST ROUND", i) : undefined));
        assert.ok(!/<coord>/.test(seg) && !/<uid>/.test(seg), "历史段不许带坐标/uid 标记");
    }
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. ★ 分组：换目标不许读到旧目标
 * ══════════════════════════════════════════════════════════════════════════ */

test("X8 ★ 换了 goal_shape 之后，prompt 里看不到旧目标的历史", async () => {
    const root = tmpDir();
    await runLoop({
        ...mkGame(),
        llmClient: new Scripted([PLAN]),
        goal: "RuRu----", mode: "mock", runDir: root, budget: budget(),
    });

    /* 直接往记忆里塞一条另一目标的记录，然后问那个目标 —— 用 buildPrompt
       更直接（runLoop 会因 GOAL_MISMATCH 直接 halt，测不到 prompt）。 */
    const { buildPrompt } = await import("./prompt.mjs");
    const { buildHandles } = await import("./handles.mjs");
    const obs = JSON.parse(fs.readFileSync(path.join(SAVES, "L4-obs.json"), "utf8")).result;
    const prior = [{ kind: "reverted", macros: ["remove_run"], why: ["旧目标的负例"], ctx: null }];
    const bundle = buildPrompt({
        goal: "Cu------", obs, handles: buildHandles(obs, null),
        diagnoses: [{ code: "NO_PRODUCTION", layer: "L4", expected: "", observed: "", evidence: {} }],
        candidates: ["connect"], priorAttempts: prior,
        recipe: { ok: true, steps: [], machines: [] },
    });
    /* 传了 priorAttempts 就直接渲染（分组是在 attemptsForGoal 里做的）——
       这条测的是「调用方分组正确时」的形状；下面 X9 测分组本身。 */
    assert.match(bundle.user, /## PRIOR ATTEMPTS/);
    assert.ok(bundle.blocks.prior_attempts_shown);

    /* 同一个 runDir 下，用 `attemptsForGoal` 查新目标必须是空 */
    const { attemptsForGoal } = await import("./memory.mjs");
    const mem = loadMemory(path.join(root, MEMORY_FILE));
    assert.deepEqual(attemptsForGoal(mem, "Cu------"), [],
        "旧关卡的经验绝不能流到新目标 —— 那是用户贴图那次的成因");
});

test("X9 ★ 只有 1 条硬负例时**仍然渲染**（第二次 run 就能看到记忆）", async () => {
    /* 这条是实测逼出来的：第一次 run 结束后记忆里往往**正好只有一条**
       （`regressive`）。若按「至少 2 条」筛掉，第二次 run 完全没有记忆 ——
       等于这个功能在前两轮永远不存在。而负例恰恰是最该被记住的。 */
    const { buildPrompt } = await import("./prompt.mjs");
    const { buildHandles } = await import("./handles.mjs");
    const obs = JSON.parse(fs.readFileSync(path.join(SAVES, "L4-obs.json"), "utf8")).result;
    const one = [{ kind: "regressive", macros: ["replace_run"], why: ["到 hub 的带子 140→133"], ctx: null }];
    const b = buildPrompt({
        goal: "RuRu----", obs, handles: buildHandles(obs, null),
        diagnoses: [], candidates: ["connect"], priorAttempts: one,
        recipe: { ok: true, steps: [], machines: [] },
    });
    assert.match(b.user, /## PRIOR ATTEMPTS/);
    assert.equal(b.blocks.prior_attempts_shown, true);
});

test("X9b 单条弱记录也渲染（第一次 run → 第二次 run 是最需要记忆的时刻）", async () => {
    /* 曾经在这里断言「单条 inert/positive 不出现」来省预算，实测站不住：
       第一次 run 结束后记忆里往往正好只有一条，第二次 run 就完全没有历史 ——
       而 8 次 run 里 6 次 goal_delta=0 的重复失败恰恰发生在这个阶段。
       一段最多 6 行、约 400 字符，比让模型再撞一次已知失败便宜得多。 */
    const { buildPrompt } = await import("./prompt.mjs");
    const { buildHandles } = await import("./handles.mjs");
    const obs = JSON.parse(fs.readFileSync(path.join(SAVES, "L4-obs.json"), "utf8")).result;
    for (const kind of ["inert", "positive", "cleanup", "regressive", "reverted"]) {
        const one = [{ kind, macros: ["connect"], why: ["x"], ctx: null }];
        const b = buildPrompt({
            goal: "RuRu----", obs, handles: buildHandles(obs, null),
            diagnoses: [], candidates: ["connect"], priorAttempts: one,
            recipe: { ok: true, steps: [], machines: [] },
        });
        assert.match(b.user, /## PRIOR ATTEMPTS/, `${kind} 单条也该出现`);
        assert.equal(b.blocks.prior_attempts_shown, true);
    }
});

test("X10 2 条历史时才渲染，且要求「别重复被撤销的动作」", async () => {
    const { buildPrompt } = await import("./prompt.mjs");
    const { buildHandles } = await import("./handles.mjs");
    const obs = JSON.parse(fs.readFileSync(path.join(SAVES, "L4-obs.json"), "utf8")).result;
    const two = [
        { kind: "reverted", macros: ["remove_run"], why: ["到 hub 的带子 140→133"], ctx: { entities: 181, belts_reaching_hub: 140 } },
        { kind: "positive", macros: ["connect"], why: ["交货 +12"], ctx: null },
    ];
    const b = buildPrompt({
        goal: "RuRu----", obs, handles: buildHandles(obs, null),
        diagnoses: [], candidates: ["connect"], priorAttempts: two,
        recipe: { ok: true, steps: [], machines: [] },
    });
    assert.match(b.user, /## PRIOR ATTEMPTS/);
    assert.match(b.user, /remove_run → ROLLED BACK automatically/);
    assert.match(b.user, /connect → delivered/);
    /* 措辞必须是「事实，不是禁令」：记忆里只有宏名、没有当时的目标/句柄，
       写成全局 "don't repeat" 会堵死同一宏在别处的正确用法（红队实测结论）。 */
    assert.match(b.user, /not rules for this one/);
    assert.match(b.user, /check the current diagnosis before repeating it/);
    assert.ok(!/do not repeat/i.test(b.user), "不许出现全局禁令");
    assert.equal(b.blocks.prior_attempts_shown, true);
});
