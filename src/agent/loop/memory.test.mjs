/**
 * `loop/memory.test.mjs` —— 跨 run 记忆。
 *
 * ## 这个文件守的是什么
 *
 * 8 次 run 里 6 次 `goal_delta = 0`、实体数不变，同一批宏在同一诊断指纹下反复重试 ——
 * 根因是模型每次 run 都从零开始。这个文件钉住记忆的三条硬约束：
 *
 * 1. **必须按 `goal_shape` 分组**：level 5 的 `Cu----Cu` 经验对 level 6 的
 *    `Cu------` 是误导（用户贴图那次正是这个成因）。
 * 2. **净效果与动作的轮次错开一格**：`netEffects[{round:N}]` 描述的是
 *    **round N-1** 那套宏的结果。搞错会教模型一个错误的因果 —— 那比没有记忆更糟。
 * 3. **只有高信息量的结果才记**：`constructive`/`churn` 是绝大多数中间步骤的正常
 *    形态，记下来只会把 prompt 塞满噪音。
 *
 * 运行：`node --test src/agent/loop/memory.test.mjs`
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    MEMORY_VERSION, MAX_ENTRIES_PER_GOAL, MEMORY_FILE,
    extractAttempts, mergeMemory, loadMemory, saveMemory, attemptsForGoal, entryKey, worldKeyOf,
} from "./memory.mjs";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "mem-"));
const NET = (round, kind, extra = {}) => ({ round, kind, why: [`why-${round}-${kind}`], ...extra });
const RC = (round, macros) => ({ round, macros, actionSet: `as-${round}` });

/* ══════════════════════════════════════════════════════════════════════════
 * 1. extractAttempts：记什么
 * ══════════════════════════════════════════════════════════════════════════ */

test("M1 空输入不崩，返回空", () => {
    assert.deepEqual(extractAttempts(), []);
    assert.deepEqual(extractAttempts({ goalShape: "", netEffects: [], roundCalls: [] }), []);
});

test("M2 ★ 轮次错开一格：round 2 的净效果归于 round 1 的宏", () => {
    const out = extractAttempts({
        goalShape: "RuRu----",
        netEffects: [NET(2, "regressive")],
        roundCalls: [RC(1, ["remove_run"]), RC(2, ["connect"])],
    });
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].macros, ["remove_run"],
        "必须是 round 1 的动作 —— round 2 的 connect 还没产生这个结果");
    assert.equal(out[0].action_set, "as-1");
});

test("M3 final:true 的收尾观测不减一（动作与结果同轮）", () => {
    const out = extractAttempts({
        goalShape: "RuRu----",
        netEffects: [NET(3, "regressive", { final: true })],
        roundCalls: [RC(3, ["remove_run"])],
    });
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].macros, ["remove_run"]);
    assert.equal(out[0].action_set, "as-3");
});

test("M3b ★ 收尾观测不许盖掉正式观测（实测过的真 bug）", () => {
    /* loop 的 finally 会补一条 `final:true` 的收尾读数。但 actionSetHash
       只哈希宏名，两轮用同一个宏时 action_set 相同 ⇒ 后写的 inert
       会把前面真实的 regressive 覆盖掉。记忆里就只剩「什么都没做」，
       而它其实把世界改坏了。 */
    const out = extractAttempts({
        goalShape: "RuRu----",
        netEffects: [
            NET(2, "regressive"),
            NET(2, "inert", { final: true }),
        ],
        roundCalls: [RC(1, ["replace_run"])],
    });
    assert.equal(out.length, 1, "同一个动作集只该有一条结论");
    assert.equal(out[0].kind, "regressive", "正式观测优先，不许被 inert 覆盖");
    assert.deepEqual(out[0].why, ["why-2-regressive"]);
});

test("M3c 没有正式观测时，收尾读数才补位", () => {
    const out = extractAttempts({
        goalShape: "RuRu----",
        netEffects: [NET(3, "inert", { final: true })],
        roundCalls: [RC(3, ["connect"])],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "inert");
    assert.deepEqual(out[0].macros, ["connect"]);
});

test("M3d ★ 收尾观测比正式观测**更硬**时必须采用（不能无脑跳过 final）", () => {
    /* 交叉质疑 Agent 抓到的：如果 final 一律跳过，会丢掉
       「正式 inert、收尾却 regressive」这种更硬的结论。 */
    const out = extractAttempts({
        goalShape: "RuRu----",
        netEffects: [
            NET(2, "inert"),
            NET(2, "regressive", { final: true }),
        ],
        roundCalls: [RC(1, ["replace_run"])],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "regressive");
});

test("M4 constructive / churn 不记（噪音）", () => {
    const out = extractAttempts({
        goalShape: "Cu----Cu",
        netEffects: [NET(2, "constructive"), NET(3, "churn"), NET(4, "positive")],
        roundCalls: [RC(1, ["replace_run"]), RC(2, ["insert_machine"]), RC(3, ["connect"])],
    });
    assert.equal(out.length, 1, "只有 positive 该留下");
    assert.equal(out[0].kind, "positive");
});

test("M5 没有对应宏的净效果不记（没有动作就无从学习）", () => {
    const out = extractAttempts({
        goalShape: "Cu----Cu",
        netEffects: [NET(2, "regressive")],
        roundCalls: [],                       // 计划被拒，一条 op 都没执行
    });
    assert.deepEqual(out, []);
});

test("M6 五种有价值的结果都记", () => {
    const kinds = ["reverted", "regressive", "inert", "positive", "cleanup"];
    const netEffects = kinds.map((k, i) => NET(i + 2, k));
    const roundCalls = kinds.map((_, i) => RC(i + 1, [`m${i}`]));
    const out = extractAttempts({ goalShape: "Cu----Cu", netEffects, roundCalls });
    assert.equal(out.length, kinds.length);
    assert.deepEqual(out.map(e => e.kind), kinds);
});

test("M7 ★ rollback 的权威高于 netEffects 的 kind", () => {
    /* rollbacks 里记了 round 2 撤销成功，即使 netEffects 说 inert，
       也要记成 reverted —— 那才是发生过的事。 */
    const out = extractAttempts({
        goalShape: "Cu----Cu",
        netEffects: [NET(2, "inert")],
        roundCalls: [RC(1, ["remove_run"])],
        rollbacks: [{ round: 2, reverted: true, verified: true }],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "reverted");
});

test("M8 未验证的撤销不算数（不许把失败的撤销记成负例）", () => {
    const out = extractAttempts({
        goalShape: "Cu----Cu",
        netEffects: [NET(2, "regressive")],
        roundCalls: [RC(1, ["remove_run"])],
        rollbacks: [{ round: 2, reverted: false, verified: false }],
    });
    assert.equal(out[0].kind, "regressive");
});

test("M9 ctx 只带三个标量，不带 uid / 坐标 / 整个快照", () => {
    const out = extractAttempts({
        goalShape: "Cu----Cu",
        netEffects: [NET(2, "regressive")],
        roundCalls: [RC(1, ["remove_run"])],
        health: {
            entities: 181, belts_reaching_hub: 140, belts_dead: 23,
            by_type: { belt: 163 }, shape: "w:abc", stored: { "Cu----Cu": 5 },
        },
    });
    const c = out[0].ctx;
    assert.deepEqual(Object.keys(c).sort(), ["belts_dead", "belts_reaching_hub", "entities"]);
    assert.ok(!("by_type" in c) && !("shape" in c) && !("stored" in c));
});

test("M10 why 截 2 条、每条 160 字符（不许把整段诊断塞进记忆）", () => {
    const long = "x".repeat(400);
    const out = extractAttempts({
        goalShape: "Cu----Cu",
        netEffects: [{ round: 2, kind: "regressive", why: [long, "b", "c"] }],
        roundCalls: [RC(1, ["remove_run"])],
    });
    assert.equal(out[0].why.length, 2);
    assert.equal(out[0].why[0].length, 160);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. mergeMemory：分组、去重、淘汰
 * ══════════════════════════════════════════════════════════════════════════ */

test("M11 ★ 按 goal 分组：Cu----Cu 的记录不会出现在 Cu------ 下", () => {
    const a = extractAttempts({
        goalShape: "Cu----Cu", netEffects: [NET(2, "reverted")], roundCalls: [RC(1, ["remove_run"])],
    });
    const b = extractAttempts({
        goalShape: "Cu------", netEffects: [NET(2, "positive")], roundCalls: [RC(1, ["connect"])],
    });
    let mem = mergeMemory(null, a);
    mem = mergeMemory(mem, b);
    assert.equal(mem.goals["Cu----Cu"].length, 1);
    assert.equal(mem.goals["Cu------"].length, 1);
    assert.equal(attemptsForGoal(mem, "Cu------")[0].kind, "positive");
    assert.equal(attemptsForGoal(mem, "Cu----Cu")[0].kind, "reverted");
});

test("M12 版本不符的旧记忆被丢弃（不读错形状）", () => {
    const old = { version: 999, goals: { "Cu----Cu": [{ bogus: true }] } };
    const mem = mergeMemory(old, []);
    assert.deepEqual(mem.goals, {});
    assert.equal(mem.version, MEMORY_VERSION);
});

test("M13 同 key 的条目替换而不是累加", () => {
    const e1 = { goal: "G", macros: ["a"], action_set: "k", kind: "inert", why: [], ctx: null, ts: "2026-01-01" };
    const e2 = { ...e1, kind: "reverted", ts: "2026-01-02" };
    const mem = mergeMemory(null, [e1, e2]);
    assert.equal(mem.goals.G.length, 1);
    assert.equal(mem.goals.G[0].kind, "reverted");
});

test("M14 不同 key 的条目各自保留", () => {
    const mk = (m, k) => ({ goal: "G", macros: [m], action_set: `as-${m}`, kind: k, why: [], ctx: null, ts: "2026-01-01" });
    const mem = mergeMemory(null, [mk("a", "inert"), mk("b", "positive"), mk("c", "reverted")]);
    assert.equal(mem.goals.G.length, 3);
});

test("M15 ★ 超过上限时按价值淘汰：reverted 留、inert 先走", () => {
    const mk = (i, kind) => ({
        goal: "G", macros: [`m${i}`], action_set: `as-${i}`, kind,
        why: [], ctx: null, ts: `2026-01-${String(i + 1).padStart(2, "0")}`,
    });
    const many = [];
    for (let i = 0; i < MAX_ENTRIES_PER_GOAL + 5; i++) {
        many.push(mk(i, i === 0 ? "reverted" : "inert"));
    }
    const mem = mergeMemory(null, many);
    assert.equal(mem.goals.G.length, MAX_ENTRIES_PER_GOAL);
    assert.ok(mem.goals.G.some(e => e.kind === "reverted"), "唯一的 reverted 必须留下");
});

test("M16 分组之间互不影响（一个 goal 超限不会删别的 goal）", () => {
    const mk = (g, i) => ({ goal: g, macros: [`m${i}`], action_set: `as-${g}-${i}`, kind: "inert", why: [], ctx: null, ts: "2026-01-01" });
    const many = [];
    for (let i = 0; i < MAX_ENTRIES_PER_GOAL + 3; i++) many.push(mk("G1", i));
    many.push(mk("G2", 0));
    const mem = mergeMemory(null, many);
    assert.equal(mem.goals.G1.length, MAX_ENTRIES_PER_GOAL);
    assert.equal(mem.goals.G2.length, 1);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. load / save
 * ══════════════════════════════════════════════════════════════════════════ */

test("M17 文件不存在 ⇒ 空记忆，不抛", () => {
    const m = loadMemory(path.join(tmpDir(), "nope.json"));
    assert.deepEqual(m, { version: MEMORY_VERSION, goals: {}, worlds: {} });
});

test("M18 坏 JSON ⇒ 空记忆，不抛", () => {
    const f = path.join(tmpDir(), "bad.json");
    fs.writeFileSync(f, "{ not json", "utf8");
    assert.deepEqual(loadMemory(f), { version: MEMORY_VERSION, goals: {}, worlds: {} });
});

test("M19 ★ 版本不符 ⇒ 空记忆（字段变了不要读错形状）", () => {
    const f = path.join(tmpDir(), "old.json");
    fs.writeFileSync(f, JSON.stringify({ version: 0, goals: { G: [{ kind: "reverted" }] } }), "utf8");
    assert.deepEqual(loadMemory(f).goals, {});
});

test("M20 往返：save → load 内容一致", () => {
    const f = path.join(tmpDir(), MEMORY_FILE);
    const e = { goal: "G", macros: ["a"], action_set: "k", kind: "reverted", why: ["x"], ctx: null, ts: "2026-01-01" };
    const mem = mergeMemory(null, [e]);
    assert.equal(saveMemory(f, mem), true);
    assert.deepEqual(loadMemory(f), mem);
});

test("M21 save 是原子的（写成功后不留 .tmp 文件）", () => {
    const d = tmpDir();
    const f = path.join(d, MEMORY_FILE);
    saveMemory(f, { version: MEMORY_VERSION, goals: {}, worlds: {} });
    assert.deepEqual(fs.readdirSync(d), [MEMORY_FILE]);
});

test("M22 save 失败返回 false，不抛", () => {
    const f = path.join(tmpDir(), "does-not-exist", "sub", MEMORY_FILE);
    /* 指向一个文件当作目录：mkdir 会失败 */
    const blocker = path.join(tmpDir(), "blocker");
    fs.writeFileSync(blocker, "x", "utf8");
    assert.equal(saveMemory(path.join(blocker, "sub", MEMORY_FILE), {}), false);
    void f;
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. attemptsForGoal：给 prompt 的那几条
 * ══════════════════════════════════════════════════════════════════════════ */

test("M23 ★ 负例优先：reverted 排在 positive 前面", () => {
    const mk = (k, ts) => ({ goal: "G", macros: ["a"], action_set: `as-${k}`, kind: k, why: [], ctx: null, ts });
    const mem = mergeMemory(null, [
        mk("inert", "2026-03-03"), mk("positive", "2026-03-02"), mk("reverted", "2026-03-01"),
    ]);
    const out = attemptsForGoal(mem, "G");
    assert.deepEqual(out.map(e => e.kind), ["reverted", "positive", "inert"]);
});

test("M24 同价值取最新的", () => {
    const mk = ts => ({ goal: "G", macros: ["a"], action_set: `as-${ts}`, kind: "inert", why: [], ctx: null, ts });
    const mem = mergeMemory(null, [mk("2026-01-01"), mk("2026-03-01"), mk("2026-02-01")]);
    assert.equal(attemptsForGoal(mem, "G")[0].ts, "2026-03-01");
});

test("M25 ★ excludeActionSets 只剔弱记录；硬负例必须保留（本轮重用时最该看见它）", () => {
    /* 红队实测指出：如果把「本 run 已用过的动作集」无差别剔除，
       模型第 2 轮重用一个上次被撤销过的宏时，那条最该出现的负例反而消失，
       `## LAST ROUND` 又不讲跨 run 结论 —— 等于记忆在最需要的时候失效。 */
    const hard = { goal: "G", macros: ["a"], action_set: "as-1", kind: "reverted", why: [], ctx: null, ts: "2026-01-01" };
    const weak = { goal: "G", macros: ["b"], action_set: "as-1", kind: "inert", why: [], ctx: null, ts: "2026-01-01" };
    const mem = mergeMemory(null, [hard, weak]);
    const out = attemptsForGoal(mem, "G", { excludeActionSets: ["as-1"] });
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "reverted");
});

test("M26 limit 生效", () => {
    const many = [];
    for (let i = 0; i < 10; i++) {
        many.push({ goal: "G", macros: [`m${i}`], action_set: `as-${i}`, kind: "inert", why: [], ctx: null, ts: `2026-01-${String(i + 1).padStart(2, "0")}` });
    }
    const mem = mergeMemory(null, many);
    assert.equal(attemptsForGoal(mem, "G", { limit: 3 }).length, 3);
});

test("M27 不存在的 goal ⇒ 空（不拿别的目标的经验来凑）", () => {
    const e = { goal: "Cu----Cu", macros: ["a"], action_set: "as-1", kind: "reverted", why: [], ctx: null, ts: "2026-01-01" };
    const mem = mergeMemory(null, [e]);
    assert.deepEqual(attemptsForGoal(mem, "Cu------"), []);
    assert.deepEqual(attemptsForGoal(mem, ""), []);
    assert.deepEqual(attemptsForGoal(null, "Cu----Cu"), []);
});

test("M28 entryKey 稳定，且**不含 kind**（同一次尝试只留最新结论）", () => {
    const e = { goal: "G", macros: ["a", "b"], action_set: "as", kind: "inert" };
    assert.equal(entryKey(e), entryKey({ ...e }));
    /* kind 不进 key：否则「同一次尝试，上次 inert、这次 reverted」会变成两条矛盾记录 */
    assert.equal(entryKey(e), entryKey({ ...e, kind: "reverted" }));
    /* 但换了目标或动作，就是另一次尝试 */
    assert.notEqual(entryKey(e), entryKey({ ...e, goal: "H" }));
    assert.notEqual(entryKey(e), entryKey({ ...e, action_set: "as2" }));
});

test("M29 ★ 同一次尝试结论变化 ⇒ 保留最硬的结论，不出现互相矛盾的两条", () => {
    const base = { goal: "G", macros: ["remove_run"], action_set: "as", why: [], ctx: null };
    const mem = mergeMemory(null, [
        { ...base, kind: "regressive", ts: "2026-01-01" },
        { ...base, kind: "reverted", ts: "2026-01-02" },
    ]);
    assert.equal(mem.goals.G.length, 1, "同一次尝试不该有两条结论");
    assert.equal(mem.goals.G[0].kind, "reverted", "最硬的结论胜出");
});

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 红队修法：世界隔离 / 消毒 / 内层损坏 / 负例保护
 * ══════════════════════════════════════════════════════════════════════════ */

test("M30 worldKeyOf：真机优先用 seed，离线用 world_key，残缺 obs 不抛", () => {
    assert.equal(worldKeyOf({ seed: 43391 }, null), "seed:43391");
    assert.equal(worldKeyOf({ world_key: "fixture:L4-obs.json" }, null), "fixture:L4-obs.json");
    const fb = worldKeyOf(null, { goal: { level: 4 }, entities: [{ uid: 1, type: "hub" }] });
    assert.equal(fb, "hubuid:1|L4");
    assert.ok(worldKeyOf(null, { entities: [] }).startsWith("unknown"));
});

test("M31 ★ 世界隔离：不同 seed 的同目标经验互不串味", () => {
    const mk = (w, k) => ({ goal: "G", world: w, macros: ["remove_run"], action_set: "as", kind: k, why: [], ctx: null, ts: "2026-01-01" });
    const mem = mergeMemory(null, [mk("seed:1", "reverted"), mk("seed:2", "positive")]);
    assert.equal(mem.goals.G.length, 2, "不同世界不该被去重（key 里要含 world）");
    const a = attemptsForGoal(mem, "G", { world: "seed:1", worldStrict: true });
    assert.equal(a.length, 1);
    assert.equal(a[0].kind, "reverted");
    const b = attemptsForGoal(mem, "G", { world: "seed:2", worldStrict: true });
    assert.equal(b.length, 1);
    assert.equal(b[0].kind, "positive");
});

test("M32 worldStrict=false 时额外允许 unknown 记录", () => {
    const e = { goal: "G", world: "unknown", macros: ["a"], action_set: "as", kind: "inert", why: [], ctx: null, ts: "2026-01-01" };
    const mem = mergeMemory(null, [e]);
    assert.equal(attemptsForGoal(mem, "G", { world: "seed:1" }).length, 1);
    assert.equal(attemptsForGoal(mem, "G", { world: "seed:1", worldStrict: true }).length, 0);
});

test("M33 ★ 内层畸形条目（合法 JSON + 正确版本）不许把 run 打崩", () => {
    const f = path.join(tmpDir(), MEMORY_FILE);
    fs.writeFileSync(f, JSON.stringify({
        version: MEMORY_VERSION,
        goals: { G: [null, "string", { macros: "x", why: {} }, { goal: "G", kind: "inert", macros: null }] },
    }), "utf8");
    const mem = loadMemory(f);
    assert.deepEqual(mem.goals.G, [], "坏条目必须被逐条丢掉");
    assert.deepEqual(attemptsForGoal(mem, "G"), []);
    /* 好条目与坏条目混在一起时，好条目仍要留下 */
    fs.writeFileSync(f, JSON.stringify({
        version: MEMORY_VERSION,
        goals: { G: [null, { goal: "G", kind: "reverted", macros: ["remove_run"], why: ["x"], ctx: null, ts: "2026-01-01" }] },
    }), "utf8");
    assert.equal(loadMemory(f).goals.G.length, 1);
});

test("M34 ★ why 出闸消毒：uid / 坐标不许写进记忆文件", () => {
    const out = extractAttempts({
        goalShape: "G", world: "seed:1",
        netEffects: [{ round: 2, kind: "regressive", why: [
            `restore 失败 uid 10143 at (5,-3), "uid":10086, "x":5,"y":-3`,
        ] }],
        roundCalls: [RC(1, ["remove_run"])],
    });
    const w = out[0].why.join(" ");
    assert.ok(!/\b\d{4,}\b/.test(w), `不该有 uid 数字，实得：${w}`);
    assert.ok(!/5\s*,\s*-3/.test(w), `不该有裸坐标，实得：${w}`);
    assert.ok(!/"x"\s*:/.test(w), `不该有 JSON 坐标，实得：${w}`);
});

test("M35 ★ 硬负例不许被后来的弱结论抹掉（红队实测的真 bug）", () => {
    const base = { goal: "G", world: "seed:1", macros: ["remove_run"], action_set: "as", why: [], ctx: null };
    let mem = mergeMemory(null, [{ ...base, kind: "reverted", ts: "2026-01-01" }]);
    mem = mergeMemory(mem, [{ ...base, kind: "inert", ts: "2026-01-02" }]);
    assert.equal(mem.goals.G.length, 1);
    assert.equal(mem.goals.G[0].kind, "reverted", "最硬的负例必须留着");
    assert.equal(mem.goals.G[0].last_kind, "inert", "但也要记下最近一次结论");
    assert.equal(mem.goals.G[0].n, 2, "累计次数");
});

test("M36 ★ 宏名顺序不同但 action_set 相同 ⇒ 同一个 key（不产生矛盾条目）", () => {
    const e1 = { goal: "G", macros: ["a", "b"], action_set: "same", kind: "reverted", why: [], ctx: null, ts: "2026-01-01" };
    const e2 = { ...e1, macros: ["b", "a"], kind: "inert", ts: "2026-01-02" };
    const mem = mergeMemory(null, [e1, e2]);
    assert.equal(mem.goals.G.length, 1);
    assert.equal(mem.goals.G[0].kind, "reverted");
});

test("M37 extractAttempts 带 world 字段（落盘后能按世界隔离）", () => {
    const out = extractAttempts({
        goalShape: "G", world: "seed:777",
        netEffects: [NET(2, "regressive")],
        roundCalls: [RC(1, ["remove_run"])],
    });
    assert.equal(out[0].world, "seed:777");
});
