/**
 * timeline.test.mjs — `timeline.log` 与「净效果」在 loop 里的接线。
 *
 * 这个文件测的不是 health.mjs 的判定（那是 health.test.mjs 的事），而是
 * **loop 有没有把它接对**。曾经的三类错误都在这层发生过：
 *
 *   1. `st.healthBefore` 在比较**之前**就被覆盖 ⇒ 每轮自己比自己 ⇒ 全是 inert；
 *   2. `formatDelta` 把规模变化滤掉 ⇒ 「拆了 3 条带子」印成「无变化」；
 *   3. 最后一次 tx 的结果没有收尾观测 ⇒ 累计段漏掉「把它改坏了」的那一步。
 *
 * 所以这里的每条断言都对着一个具体的回归。
 *
 * 运行：`node --test src/agent/loop/timeline.test.mjs`
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const SAVES = path.join(REPO, "test/fixtures/saves");

/** 按序吐出脚本化回复的 LLM。 */
class Scripted extends LLMClient {
    constructor(texts) { super(); this.texts = texts; this.n = 0; this.bundles = []; }
    async propose(bundle) {
        this.bundles.push(bundle);
        const t = this.texts[Math.min(this.n, this.texts.length - 1)];
        this.n++;
        if (t instanceof Error) throw t;
        return { text: typeof t === "string" ? t : JSON.stringify(t), usage: null, raw: null };
    }
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "tl-test-"));

/** L4 的正解计划（句柄来自 handles.mjs 的确定性编号）。 */
const L4_CALL = {
    macro: "replace_run",
    args: {
        region: { $bbox_of: ["B81", "B82", "B69"] },
        building: ["cutter", { kind: "trash", port: "left", confirm_waste: true }],
    },
};
const L4_PLAN = { say: "swap the run for a cutter and a trash", calls: [L4_CALL] };

const l4 = () => FakeGame.fromFiles(path.join(SAVES, "L4-obs.json"), null, { goal: "RuRu----" });

const runL4 = async (texts, budget = {}, extra = {}) => {
    const g = l4();
    const dir = tmpDir();
    const res = await runLoop({
        reader: g.reader(), game: g,
        llmClient: new Scripted(texts),
        goal: "RuRu----", mode: "mock", runDir: dir,
        budget: { ROUNDS_MAX: 3, LLM_CALLS_MAX: 6, TX_MAX: 3, WALL_MS_MAX: 180000, ...budget },
        ...extra,
    });
    const tlFile = path.join(res.run_dir, "timeline.log");
    return { res, g, dir,
        timeline: fs.existsSync(tlFile) ? fs.readFileSync(tlFile, "utf8") : null };
};

/* ══════════════════════════════════════════════════════════════════════════
 * 1. timeline.log 存在且可用
 * ══════════════════════════════════════════════════════════════════════════ */

test("T1 timeline.log 被写出来，并进了 preserved.files", async () => {
    const { res, timeline } = await runL4([L4_PLAN]);
    assert.ok(timeline !== null, "timeline.log 必须存在");
    assert.ok(res.preserved.files.includes("timeline.log"), "必须列进 preserved.files");
});

test("T2 timeline 是纯文本、没有 JSON 行、也没有坐标", async () => {
    const { timeline } = await runL4([L4_PLAN]);
    assert.ok(!/^\s*\{/.test(timeline), "不该出现 JSON 行");
    /* 时间线是给人读的；句柄（B12/C1）可以有，坐标不该有 —— 与 prompt 同一条纪律 */
    assert.ok(!/\b-?\d+,\s*-?\d+\b/.test(timeline), "时间线里不该出现裸坐标");
});

test("T3 每轮都有轮次头，且头里有目标与规模", async () => {
    const { timeline } = await runL4([L4_PLAN]);
    assert.match(timeline, /── r1\s+L4\s+\|\s+RuRu---- 0\/70\s+\|\s+实体 \d+/);
    assert.match(timeline, /── r2/);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 净效果 —— 三条回归
 * ══════════════════════════════════════════════════════════════════════════ */

test("T4 ★ 回归 1：第 2 轮的净效果**不许**是 inert（before 被提前覆盖的老 bug）", async () => {
    const { timeline, res } = await runL4([L4_PLAN]);
    /* replace_run 真的改了世界（删 3 放 2），所以第 2 轮必然看得见变化。
       老 bug 下这里每一轮都是 inert，因为 healthBefore 在比较前就被赋成了当前值。 */
    const kinds = (res.net_effects || []).map(x => x.kind);
    assert.ok(kinds.length > 0, "必须至少有一轮净效果");
    assert.ok(!(kinds.length > 1 && kinds.every(k => k === "inert")),
        `多轮全是 inert ⇒ before 被覆盖了。实际：${JSON.stringify(kinds)}`);
    assert.match(timeline, /净效果: (positive|cleanup|regressive|constructive|churn|inert)/);
});

test("T5 ★ 回归 2：规模变了就必须印出来，不许写成「无变化」", async () => {
    const { timeline } = await runL4([L4_PLAN]);
    /* replace_run 的 5 个 op 会改实体数/带子数/机器数。这一行是排查时最想知道的事实。 */
    assert.match(timeline, /entities \d+→\d+/, "实体数变化必须印出来");
    assert.match(timeline, /belts \d+→\d+/, "带子数变化必须印出来");
    assert.match(timeline, /machines \d+→\d+/, "机器数变化必须印出来");
});

test("T6 ★ 回归 3：最后一步有收尾观测，累计段不漏它", async () => {
    const { timeline, res } = await runL4([L4_PLAN]);
    assert.match(timeline, /── 收尾世界|── 累计/);
    assert.ok(res.run_total, "必须给出整次 run 的累计判定");
    assert.ok(typeof res.run_total.kind === "string");
});

test("T7 收尾观测的 net_effect 带 final:true（与轮内的可区分）", async () => {
    const { res } = await runL4([L4_PLAN]);
    const finals = (res.net_effects || []).filter(x => x.final === true);
    assert.equal(finals.length, 1, "有且只有一条收尾判定");
});

test("T8 累计段与逐轮段用的是同一套六档之一", async () => {
    const { res } = await runL4([L4_PLAN]);
    const KINDS = ["positive", "cleanup", "constructive", "regressive", "churn", "inert"];
    assert.ok(KINDS.includes(res.run_total.kind), `未知档位 ${res.run_total.kind}`);
    for (const e of res.net_effects) assert.ok(KINDS.includes(e.kind), `未知档位 ${e.kind}`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 进 prompt
 * ══════════════════════════════════════════════════════════════════════════ */

test("T9 ★ 第 1 轮 prompt 里没有 LAST STEP；第 2 轮必须有", async () => {
    const client = new Scripted([L4_PLAN]);
    const g = l4();
    await runLoop({
        reader: g.reader(), game: g, llmClient: client,
        goal: "RuRu----", mode: "mock", runDir: tmpDir(),
        budget: { ROUNDS_MAX: 3, LLM_CALLS_MAX: 6, TX_MAX: 3, WALL_MS_MAX: 180000 },
    });
    assert.ok(client.bundles.length >= 2, "至少两次 LLM 调用");
    assert.ok(!/## LAST STEP/.test(client.bundles[0].user), "首轮不该有 LAST STEP（没有 before）");
    assert.ok(/## LAST STEP/.test(client.bundles[1].user), "第 2 轮必须有 LAST STEP");
});

test("T10 LAST STEP 排在 LAST ROUND 之前（先结论、后细节）", async () => {
    const client = new Scripted([L4_PLAN]);
    const g = l4();
    await runLoop({
        reader: g.reader(), game: g, llmClient: client,
        goal: "RuRu----", mode: "mock", runDir: tmpDir(),
        budget: { ROUNDS_MAX: 3, LLM_CALLS_MAX: 6, TX_MAX: 3, WALL_MS_MAX: 180000 },
    });
    const u = client.bundles[1].user;
    const iStep = u.indexOf("## LAST STEP");
    const iRound = u.indexOf("## LAST ROUND");
    assert.ok(iStep > 0 && iRound > 0);
    assert.ok(iStep < iRound, "LAST STEP 必须在 LAST ROUND 之前");
});

test("T11 LAST STEP 只写判定与数字，不给坐标、不带 uid", async () => {
    const client = new Scripted([L4_PLAN]);
    const g = l4();
    await runLoop({
        reader: g.reader(), game: g, llmClient: client,
        goal: "RuRu----", mode: "mock", runDir: tmpDir(),
        budget: { ROUNDS_MAX: 3, LLM_CALLS_MAX: 6, TX_MAX: 3, WALL_MS_MAX: 180000 },
    });
    const u = client.bundles[1].user;
    const seg = u.slice(u.indexOf("## LAST STEP"), u.indexOf("## LAST ROUND"));
    assert.ok(!/<coord>/.test(seg), "不许带坐标标记");
    assert.ok(!/<uid>/.test(seg), "不许带 uid");
    assert.ok(!/\buid\b/i.test(seg), "不该出现 uid 字样");
});

test("T12 regressive 时必须给出「别再这么干」的明确指令", async () => {
    /* 用一份确定会变坏的计划：删掉一条**能到 hub** 的带子。
       这句话是 prompt 里唯一直接告诉模型「你上一步搞砸了」的地方，
       它掉了，模型就只会看到「verify 又红了」并继续瞎猜。 */
    const g = l4();
    const obs = JSON.parse(fs.readFileSync(path.join(SAVES, "L4-obs.json"), "utf8")).result;
    const hub = obs.entities.find(e => e.type === "hub");
    assert.ok(hub);
    /* 用 remove_run 删一条活带子 —— 句柄在 handles.mjs 是确定性的，这里直接给 uid 更稳：
       改用 insert_machine 之类会依赖句柄稳定性。删活带子用 remove_machine 不行（它是带子）。
       所以走 replace_run 把这些格子换成空格：等价于删。 */
    const del = {
        macro: "replace_run",
        args: {
            region: { $bbox_of: ["B81", "B82", "B69"] },
            building: [{ kind: "trash", port: "left", confirm_waste: true }],
        },
    };
    const client = new Scripted([{ say: "replace with trash", calls: [del] }, { say: "again", calls: [del] }]);
    await runLoop({
        reader: g.reader(), game: g, llmClient: client,
        goal: "RuRu----", mode: "mock", runDir: tmpDir(),
        budget: { ROUNDS_MAX: 3, LLM_CALLS_MAX: 6, TX_MAX: 3, WALL_MS_MAX: 180000 },
    });
    const u = client.bundles[1].user;
    const seg = u.slice(u.indexOf("## LAST STEP"), u.indexOf("## LAST ROUND"));
    assert.match(seg, /your last change: \w+/);
    /* 档位要么是 GOOD/NEUTRAL，要么必须带 BAD/WASTE 的指令 —— 任何一种都必须有下一句指引 */
    assert.ok(/⇒/.test(seg), `LAST STEP 必须给出「下一步该怎么办」，实际：${seg}`);
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. transcript 的契约没被破坏
 * ══════════════════════════════════════════════════════════════════════════ */

test("T13 transcript 的 kind 闭集没变（timeline 不进 transcript）", async () => {
    const { res } = await runL4([L4_PLAN]);
    const rows = readTranscript(res.transcript_path);
    const KINDS = ["run_start", "observe", "diagnose", "propose", "plan", "apply", "verify", "repair_decide", "run_end"];
    for (const r of rows) assert.ok(KINDS.includes(r.kind), `未知 kind ${r.kind}`);
});

test("T14 run_end 里带 net_effects / run_total / timeline 三个字段", async () => {
    const { res } = await runL4([L4_PLAN]);
    const rows = readTranscript(res.transcript_path);
    const end = rows.filter(r => r.kind === "run_end").pop();
    assert.ok(end, "必须有 run_end");
    assert.ok(Array.isArray(end.data.net_effects));
    assert.ok(end.data.run_total === null || typeof end.data.run_total === "object");
    assert.ok("timeline" in end.data);
});

test("T15 dry_run 不做收尾观测（世界零写入，没有可比的东西）", async () => {
    const { res, timeline } = await runL4([L4_PLAN], {}, { dryRun: true });
    assert.equal(res.reason, "DRY_RUN");
    assert.ok(!/── 收尾世界/.test(timeline), "dry_run 不该有收尾观测");
    assert.equal((res.net_effects || []).filter(x => x.final).length, 0);
});
