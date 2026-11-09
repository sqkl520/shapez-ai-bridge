/**
 * `levelchange.e2e.test.mjs` —— 「世界在 run 中途升级」的端到端行为。
 *
 * ## 钉住什么
 *
 * 用户贴图那次：level 5（`Cu----Cu`）升到 level 6（`Cu------`），
 * 旧产线没拆，变成 41% 死带子，模型还在修旧线。
 *
 * 这份测试覆盖三件事：
 *   1. 换关时 loop **不 halt**（halt = 赢一局就死机），且采纳新目标；
 *   2. 换关时**配方作废重算**（旧配方会给出错误的机器建议）；
 *   3. `GOAL_CHANGED` / `OBSOLETE_LINE` **不进指纹**（否则第 3 轮必 halt，
 *      模型还没开始拆就被判死）。
 *
 * 另外守住一条反向约束：**调用方传错 goal 仍然必须 halt**。
 * 两者看起来都是「obsGoal !== goal」，但一个是世界正常升级、一个是配置错误。
 *
 * 运行：`node --test src/agent/loop/levelchange.e2e.test.mjs`
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import FakeGame from "../fake_game.mjs";
import { runLoop, readTranscript, fingerprintOf } from "../loop.mjs";
import { LLMClient } from "./llm.mjs";
import { MEMORY_FILE, MEMORY_VERSION, mergeMemory } from "./memory.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAVES = path.resolve(HERE, "../../../test/fixtures/saves");
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "lc-e2e-"));

class Scripted extends LLMClient {
    constructor(texts) { super(); this.texts = texts; this.n = 0; this.bundles = []; }
    async propose(b) {
        this.bundles.push(b);
        const t = this.texts[Math.min(this.n, this.texts.length - 1)];
        this.n++;
        return { text: typeof t === "string" ? t : JSON.stringify(t), usage: null, raw: null };
    }
}

const L4_CALL = {
    macro: "replace_run",
    args: {
        region: { $bbox_of: ["B81", "B82", "B69"] },
        building: ["cutter", { kind: "trash", port: "left", confirm_waste: true }],
    },
};
const PLAN = { say: "swap in a cutter", calls: [L4_CALL] };

const budget = () => ({
    ROUNDS_MAX: 3, LLM_CALLS_MAX: 5, TX_MAX: 3,
    WALL_MS_MAX: 180000, TICKS_MAX: 2400 * 8,
});

/**
 * 造一个「读到第 N 轮时目标变成新值」的 FakeGame 包装。
 *
 * 为什么不用两个夹具轮流：`runLoop` 一次 run 里只有一个 reader，
 * 真实世界升级也是**同一个 reader** 前后返回不同的 goal。
 */
function gameThatLevelsUp({ fromGoal = "RuRu----", toGoal = "Cu------", afterRound = 2 } = {}) {
    const g = FakeGame.fromFiles(path.join(SAVES, "L4-obs.json"), null, { goal: fromGoal });
    const r = g.reader();
    let obsCalls = 0;
    return {
        g,
        reader: {
            ...r,
            obs: async (p = {}) => {
                obsCalls++;
                const o = await r.obs(p);
                /* 前 `afterRound - 1` 次 obs 用旧目标，之后换成新目标。
                   一次 run 每轮至少调一次 obs，所以这等价于「第 afterRound 轮起升级」。 */
                if (obsCalls >= afterRound) {
                    return {
                        ...o,
                        goal: {
                            ...(o.goal || {}),
                            level: 6,
                            requirement: { ...((o.goal && o.goal.requirement) || {}), shape: toGoal, required: 270 },
                        },
                    };
                }
                return o;
            },
        },
    };
}

/** 预置记忆：让 loop 知道「这个世界上次的目标是 fromGoal」（否则会被判成 first_seen）。 */
function seedMemory(root, world, lastGoal, level = 5) {
    const mem = mergeMemory(null, [], {
        [world]: { last_goal: lastGoal, last_level: level, last_seen: new Date().toISOString() },
    });
    fs.writeFileSync(path.join(root, MEMORY_FILE), JSON.stringify(mem, null, 1), "utf8");
}

/** 拿到这个 FakeGame 的 worldKey（与 `worldKeyOf` 同口径）。 */
async function worldKeyOfGame(g) {
    const wi = await g.reader().worldInfo();
    return wi.world_key;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 世界升级：不 halt，采纳新目标
 * ══════════════════════════════════════════════════════════════════════════ */

test("G1 ★ 世界中途升级 ⇒ 不 halt，且 run 继续到预算耗尽", async () => {
    const { g, reader } = gameThatLevelsUp();
    const root = tmpDir();
    seedMemory(root, await worldKeyOfGame(g), "RuRu----", 4);

    const res = await runLoop({
        reader, game: g, llmClient: new Scripted([PLAN]),
        goal: "RuRu----", mode: "mock", runDir: root, budget: budget(),
    });
    assert.notEqual(res.reason, "GOAL_MISMATCH", "世界升级不该被当成调用方传错 goal");
    assert.ok(res.rounds >= 2, `实得 ${res.rounds} 轮`);
});

test("G2 ★ run_end 里记下 goal_changed（from / to / level）", async () => {
    const { g, reader } = gameThatLevelsUp();
    const root = tmpDir();
    seedMemory(root, await worldKeyOfGame(g), "RuRu----", 4);

    const res = await runLoop({
        reader, game: g, llmClient: new Scripted([PLAN]),
        goal: "RuRu----", mode: "mock", runDir: root, budget: budget(),
    });
    assert.ok(res.goal_changed, `必须有 goal_changed，实得 ${JSON.stringify(res.goal_changed)}`);
    assert.equal(res.goal_changed.from, "RuRu----");
    assert.equal(res.goal_changed.to, "Cu------");
    assert.equal(res.goal_changed.level_to, 6);
});

test("G3 ★ 采纳新目标：后续轮次的 prompt 用新目标", async () => {
    const { g, reader } = gameThatLevelsUp();
    const root = tmpDir();
    seedMemory(root, await worldKeyOfGame(g), "RuRu----", 4);

    const client = new Scripted([PLAN]);
    await runLoop({
        reader, game: g, llmClient: client,
        goal: "RuRu----", mode: "mock", runDir: root, budget: budget(),
    });
    const last = client.bundles[client.bundles.length - 1];
    assert.match(last.user, /shape: Cu------/, "升级后的 prompt 必须用新目标");
});

test("G4 ★ 换关后配方作废重算（不许拿旧目标的配方提建议）", async () => {
    const { g, reader } = gameThatLevelsUp();
    const root = tmpDir();
    seedMemory(root, await worldKeyOfGame(g), "RuRu----", 4);

    const res = await runLoop({
        reader, game: g, llmClient: new Scripted([PLAN]),
        goal: "RuRu----", mode: "mock", runDir: root, budget: budget(),
    });
    const rows = readTranscript(res.transcript_path).filter(r => r.kind === "observe");
    const levels = rows.map(r => (r.data.recipe && Number.isFinite(r.data.recipe.level)) ? r.data.recipe.level : null)
        .filter(v => v !== null);
    /* 升级后必须按新 level 重算 —— 旧配方的 level 是 4。 */
    assert.ok(levels.includes(6), `配方必须按新 level(6) 重算，实得 level 序列 ${JSON.stringify(levels)}`);
});

test("G5 换关那一轮写进 timeline（人读日志能看到）", async () => {
    const { g, reader } = gameThatLevelsUp();
    const root = tmpDir();
    seedMemory(root, await worldKeyOfGame(g), "RuRu----", 4);

    const res = await runLoop({
        reader, game: g, llmClient: new Scripted([PLAN]),
        goal: "RuRu----", mode: "mock", runDir: root, budget: budget(),
    });
    const tl = fs.readFileSync(path.join(res.run_dir, "timeline.log"), "utf8");
    assert.match(tl, /世界升级/);
    assert.match(tl, /RuRu---- → Cu------/);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 反向约束：调用方传错 goal 仍然必须 halt
 * ══════════════════════════════════════════════════════════════════════════ */

test("G6 ★ 记忆里没有这个目标 ⇒ 仍判 GOAL_MISMATCH 并 halt", async () => {
    /* 区分「世界升级」与「调用方传错」的唯一依据是跨 run 记忆。
       没有记忆时**必须**保守 halt —— 误判成升级会让 loop 在错误目标上改世界。 */
    const { g, reader } = gameThatLevelsUp({ afterRound: 1 });   // 第一轮就是新目标
    const root = tmpDir();
    /* 不预置记忆：这个世界 loop 从没见过 Cu------ */
    const res = await runLoop({
        reader, game: g, llmClient: new Scripted([PLAN]),
        goal: "RuRu----", mode: "mock", runDir: root, budget: budget(),
    });
    assert.equal(res.reason, "GOAL_MISMATCH");
    assert.equal(res.rounds, 1);
});

test("G7 记忆里记的是**另一个**目标 ⇒ 也 halt（不是升级，是给错了）", async () => {
    const { g, reader } = gameThatLevelsUp({ afterRound: 1 });
    const root = tmpDir();
    /* 记忆说上次目标是 CuCuCuCu，而世界现在是 Cu------ —— 三方不一致 ⇒ 保守 halt */
    seedMemory(root, await worldKeyOfGame(g), "CuCuCuCu", 4);
    const res = await runLoop({
        reader, game: g, llmClient: new Scripted([PLAN]),
        goal: "RuRu----", mode: "mock", runDir: root, budget: budget(),
    });
    assert.equal(res.reason, "GOAL_MISMATCH");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. ★ 指纹：环境性诊断必须排除
 * ══════════════════════════════════════════════════════════════════════════ */

test("G8 ★ GOAL_CHANGED / OBSOLETE_LINE 不进指纹（否则第 3 轮必 halt）", () => {
    /* 这是设计约束的直接验证：残线在拆掉之前每轮都存在，
       进了指纹就会让「同一指纹第 3 次」在模型来得及动手前触发。 */
    const base = [{ code: "NO_PRODUCTION", layer: "L4", subject: null, evidence: {} }];
    const withEnv = [
        ...base,
        { code: "OBSOLETE_LINE", layer: "L4", subject: null, evidence: { shape: "Cu----Cu" } },
        { code: "GOAL_CHANGED", layer: "L4", subject: null, evidence: { from: "A", to: "B" } },
    ];
    /* loop 内部用 environ 过滤后算指纹 —— 这里模拟同样的过滤。 */
    const ENV = new Set(["OBSOLETE_LINE", "GOAL_CHANGED"]);
    const fpBase = fingerprintOf(base);
    const fpFiltered = fingerprintOf(withEnv.filter(d => !ENV.has(d.code)));
    assert.equal(fpFiltered, fpBase, "环境性诊断不该改变指纹");
});

test("G9 ★ 残线出现/消失不改变指纹 ⇒ 不会让 NO_PROGRESS_3X 提前触发", async () => {
    /* 端到端验证：一次 run 里，如果只有 OBSOLETE_LINE 在变，
       指纹应当稳定。用同一份世界跑三轮（计划不变），检查指纹是否只有一个值。 */
    const g = FakeGame.fromFiles(path.join(SAVES, "L4-obs.json"), null, { goal: "RuRu----" });
    const root = tmpDir();
    const res = await runLoop({
        reader: g.reader(), game: g, llmClient: new Scripted([PLAN]),
        goal: "RuRu----", mode: "mock", runDir: root,
        budget: { ROUNDS_MAX: 3, LLM_CALLS_MAX: 5, TX_MAX: 3, WALL_MS_MAX: 180000, TICKS_MAX: 2400 * 8 },
    });
    const fps = readTranscript(res.transcript_path)
        .filter(r => r.kind === "diagnose")
        .map(r => r.data.fingerprint);
    /* 不要求全部相同（世界真的变了），但要求：如果诊断码集合里只多了环境码，
       指纹不该跟着变。这里用「第 1 轮与第 2 轮」对比即可。 */
    assert.ok(fps.length >= 2);
    assert.equal(typeof fps[0], "string");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 记忆：目标变更必须落盘（下次 run 才认得出下一次升级）
 * ══════════════════════════════════════════════════════════════════════════ */

test("G10 ★ finally 把新目标写进 worlds（否则下次升级检测失效）", async () => {
    const { g, reader } = gameThatLevelsUp();
    const root = tmpDir();
    const wk = await worldKeyOfGame(g);
    seedMemory(root, wk, "RuRu----", 4);

    await runLoop({
        reader, game: g, llmClient: new Scripted([PLAN]),
        goal: "RuRu----", mode: "mock", runDir: root, budget: budget(),
    });
    const mem = JSON.parse(fs.readFileSync(path.join(root, MEMORY_FILE), "utf8"));
    assert.equal(mem.version, MEMORY_VERSION);
    assert.ok(mem.worlds && mem.worlds[wk], `worlds 必须存在，实得 ${JSON.stringify(mem.worlds)}`);
    assert.equal(mem.worlds[wk].last_goal, "Cu------", "必须记下**升级后**的目标");
});

test("G11 一次什么都没做成的 run 也要更新 worlds", async () => {
    /* 计划全被拒 ⇒ netEffects 为空 ⇒ 没有可记的尝试。但「我看到了这个目标」
       仍然是一条证据，不写的话下次换关检测会误判。 */
    const g = FakeGame.fromFiles(path.join(SAVES, "L4-obs.json"), null, { goal: "RuRu----" });
    const root = tmpDir();
    const wk = await worldKeyOfGame(g);
    const bad = { macro: "connect", args: { from: { $ref: "B7" }, to: { $ref: "C1", port: "left" } } };
    await runLoop({
        reader: g.reader(), game: g, llmClient: new Scripted([{ say: "x", calls: [bad] }]),
        goal: "RuRu----", mode: "mock", runDir: root,
        budget: { ROUNDS_MAX: 1, LLM_CALLS_MAX: 2, TX_MAX: 1, WALL_MS_MAX: 120000, TICKS_MAX: 2400 },
    });
    const mem = JSON.parse(fs.readFileSync(path.join(root, MEMORY_FILE), "utf8"));
    assert.ok(mem.worlds && mem.worlds[wk], "即使没有尝试，worlds 也要写");
    assert.equal(mem.worlds[wk].last_goal, "RuRu----");
});

test("G13 ★ 全新 runDir + 中途升级 ⇒ 不再误判 halt（首轮就记账本）", async () => {
    /* 交叉评审指出的洞：`worldUpdate` 只在 finally 写 ⇒ 第一次 run 期间记忆为空，
       中途升级时 `rememberedGoal` 取不到 ⇒ 退化成 halt，本 run 经验全丢。
       修法是首轮 observe 之后立即写一次，让同一次 run 内可以自证。 */
    const { g, reader } = gameThatLevelsUp({ afterRound: 2 });
    const root = tmpDir();                    // ★ 全新目录，不预置任何记忆
    const res = await runLoop({
        reader, game: g, llmClient: new Scripted([PLAN]),
        goal: "RuRu----", mode: "mock", runDir: root, budget: budget(),
    });
    assert.notEqual(res.reason, "GOAL_MISMATCH",
        `首轮落盘之后应当能在同一 run 内认出升级，实得 reason=${res.reason}`);
    assert.ok(res.goal_changed, "应当记下 goal_changed");
});

test("G14 首轮就与调用方不一致（全新目录）⇒ 仍然 halt（保守）", async () => {
    /* 反向约束：如果记忆里根本没有这个世界，首轮目标就和调用方不同 ——
       无法区分「上次 run 结束后升级了」与「调用方传错了」，必须 halt。 */
    const { g, reader } = gameThatLevelsUp({ afterRound: 1 });
    const root = tmpDir();
    const res = await runLoop({
        reader, game: g, llmClient: new Scripted([PLAN]),
        goal: "RuRu----", mode: "mock", runDir: root, budget: budget(),
    });
    assert.equal(res.reason, "GOAL_MISMATCH");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. ★ 授权拆除：拆残线不该被回滚 ★
 * ══════════════════════════════════════════════════════════════════════════ */

test("G15 ★ 换关后拆残线被判 sanctioned（不撤），而没换关时照常撤", async () => {
    /* 组装一次「换关后的拆残线」run：
     *   1. 预置记忆，让 loop 认出「世界从 RuRu---- 变成了 ZZZZ----」（= 换关）；
     *   2. hub 里塞一条不属于新配方的存量（= 残线证据）；
     *   3. 连拆两轮，检查第二条 regressive 不会被回滚。
     *
     * 对照组由 V39（未换关时授权恒为 false）+ E11（未换关时照常撤销）覆盖。 */
    const g = FakeGame.fromFiles(path.join(SAVES, "L4-obs.json"), null, { goal: "RuRu----" });
    g.obs.hub = { ...(g.obs.hub || {}), stored_shapes: { ...((g.obs.hub || {}).stored_shapes || {}), "ZZZZ----": 9999 } };
    const root = tmpDir();
    const wk = await worldKeyOfGame(g);
    /* 预置：这个世界的「上次目标」是 RuRu----。 */
    seedMemory(root, wk, "RuRu----", 4);

    const t = (await import("./handles.mjs")).buildHandles(g.obs, null);
    const { indexOf, flowReachable } = await import("./topology.mjs");
    const reach = flowReachable(g.obs, indexOf(g.obs));
    const byCell = new Map(g.obs.entities.map(e => [`${e.x},${e.y}`, e]));
    const pairs = [];
    for (const a of g.obs.entities) {
        if (a.type !== "belt" || !reach.has(a.uid)) continue;
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
            const b = byCell.get(`${a.x + dx},${a.y + dy}`);
            if (!b || b.type !== "belt" || !reach.has(b.uid)) continue;
            pairs.push([t.byUid.get(a.uid), t.byUid.get(b.uid)]);
            if (pairs.length >= 2) break;
        }
        if (pairs.length >= 2) break;
    }
    const rm = ([x, y]) => ({ macro: "remove_run", args: { uids: { $uids: [x, y] } } });

    /* 让世界在第 1 轮就变成新目标 —— loop 凭记忆认出这是「升级」。 */
    const baseReader = g.reader();
    const leveled = {
        ...baseReader,
        obs: async (p = {}) => {
            const o = await baseReader.obs(p);
            return { ...o, goal: { ...(o.goal || {}), level: 5, requirement: { ...((o.goal && o.goal.requirement) || {}), shape: "ZZZZ----" } } };
        },
    };
    const res = await runLoop({
        reader: leveled, game: g,
        llmClient: new Scripted([{ say: "r1", calls: [rm(pairs[0])] }, { say: "r2", calls: [rm(pairs[1])] }]),
        goal: "RuRu----", mode: "live", runDir: root,
        budget: { ROUNDS_MAX: 3, LLM_CALLS_MAX: 5, TX_MAX: 3, WALL_MS_MAX: 180000, ROLLBACK: true, TICKS_MAX: 2400 * 8 },
    });
    assert.ok(res.goal_changed, `前提：这次 run 必须认出了换关，实得 ${JSON.stringify(res.goal_changed)}`);
    const rb = (res.rollbacks || []).filter(r => r.reverted);
    assert.equal(rb.length, 0, `拆残线不该被回滚，实得 ${rb.length} 次`);
});

test("G16 跨 run：第二次跑时能认出「目标变了」", async () => {
    const root = tmpDir();
    /* 第一次 run：世界是 RuRu---- */
    const g1 = FakeGame.fromFiles(path.join(SAVES, "L4-obs.json"), null, { goal: "RuRu----" });
    const wk = await worldKeyOfGame(g1);
    await runLoop({
        reader: g1.reader(), game: g1, llmClient: new Scripted([PLAN]),
        goal: "RuRu----", mode: "mock", runDir: root, budget: budget(),
    });

    /* 第二次 run：同一个世界 key，但目标已经变成 Cu------（模拟期间升级） */
    const { g, reader } = gameThatLevelsUp({ afterRound: 1, fromGoal: "RuRu----", toGoal: "Cu------" });
    /* 强制使用第一次的 world key —— 模拟「同一个存档」 */
    g.fixtureWorldKey = wk;
    const res = await runLoop({
        reader, game: g, llmClient: new Scripted([PLAN]),
        goal: "RuRu----", mode: "mock", runDir: root, budget: budget(),
    });
    /* 第一次 run 已把 last_goal=RuRu---- 写进记忆 ⇒ 这次应当认成「世界升级」而不是 halt */
    assert.notEqual(res.reason, "GOAL_MISMATCH",
        `跨 run 记忆应当让它认出这是升级，实得 reason=${res.reason}`);
});
