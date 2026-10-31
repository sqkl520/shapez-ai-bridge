/**
 * prompt_production.test.mjs — PRODUCTION 段的验收（不连游戏、零 rpc）。
 *
 * ## 这个文件为什么存在
 *
 * `renderProduction` 的判据一直是对的，但**它读错了地方**：
 *
 *   prompt.mjs   `const p = obs && obs.production;`
 *   loop.mjs     `buildPrompt({ goal, obs: ob.obs, … })`
 *                `observeOnce()` 把 production 读成了 `ob.production`（与 `ob.obs` 并列的
 *                第三个字段），**从来没有塞进 `ob.obs`**。
 *
 * 后果是模型每一轮、每个存档都看见同一句：
 *
 *   ## PRODUCTION
 *   unavailable (obs.production absent) — decide from the diagnosis, do not assume anything is running
 *
 * 模型永远不知道产线现在到底产不产、产多快。旧测试 `prompt.test.mjs` 没抓到它，因为它
 * 手工把 production **拼进 obs**（`{...L5, production: {...}}`）—— 那正是 loop 不做的事。
 * 单模块测试自己造了个真实调用方不提供的形状，于是恒绿。
 *
 * 所以本文件除了正/反例外，还钉一条**接线**用例（`loop` 真的把 production 送到 prompt 里），
 * 那是这个 bug 唯一能被抓住的地方。
 *
 * 运行：`node --test src/agent/loop/prompt_production.test.mjs`
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPrompt } from "./prompt.mjs";
import { runLoop } from "../loop.mjs";
import FakeGame from "../fake_game.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");

const L5 = JSON.parse(fs.readFileSync(path.join(REPO, "test/fixtures/saves/L5-obs.json"), "utf8")).result;

/** production 的**真实**形态 —— 抄自 `src/mod/shapez-ai-bridge.js:642-654` 的返回值。 */
const REAL_PRODUCTION = {
    window_seconds: 60,
    slice_seconds: 10,
    slices_returned: 6,
    produced_total: { "Cu----Cu": 120 },
    produced_per_sec: { "Cu----Cu": 2 },
    delivered_total: { "Cu----Cu": 90 },
    delivered_per_sec: { "----CuCu": 1.5 },
    stored_delta: { "Cu----Cu": 30 },
    produced_slices: [{ "Cu----Cu": 20 }, { "Cu----Cu": 20 }, { "Cu----Cu": 20 },
        { "Cu----Cu": 20 }, { "Cu----Cu": 20 }, { "Cu----Cu": 20 }],
    delivered_slices: [{ "----CuCu": 15 }, { "----CuCu": 15 }, { "----CuCu": 15 },
        { "----CuCu": 15 }, { "----CuCu": 15 }, { "----CuCu": 15 }],
};

const opts = over => ({
    goal: L5.goal.requirement.shape,
    obs: L5,
    handles: null,
    diagnoses: [],
    candidates: ["connect"],
    lastRound: null,
    budget: { rounds_left: 3, llm_calls_left: 4, tx_left: 3 },
    production: REAL_PRODUCTION,
    ...over,
});

const prodBlock = b => b.blocks.s3_production;

/* ═══════════════════ A. 正例：给了 production ⇒ 渲染真实数字 ═══════════════════ */

test("A 正例：给了 production ⇒ window_seconds 与各形状数字都渲染出来", () => {
    const b = buildPrompt(opts());
    const seg = prodBlock(b);
    assert.match(seg, /window_seconds: 60/, "窗口秒数必须出现（模型据此把「总量」读成「速率」）");
    assert.match(seg, /produced Cu----Cu: 120/, "产出总量必须出现");
    /* 现有 renderProduction 的口径：`rate` 行渲染的是 **delivered_per_sec**（hub 交付速率，
       那才是关卡判据要的量），不是 produced_per_sec。这里按它的原判据断言，不改它。 */
    assert.match(seg, /rate ----CuCu: 1\.5/, "交付速率必须出现");
    assert.ok(!/unavailable/.test(seg), "有数据时**不许**说 unavailable");
});

test("A2 正例：给了 production 就不该出现在「无数据」的兜底分支里", () => {
    const withProd = prodBlock(buildPrompt(opts()));
    const noProd = prodBlock(buildPrompt(opts({ production: null })));
    assert.notEqual(withProd, noProd, "给与不给必须渲染出**不同**的段落（否则这次修复等于没修）");
    assert.match(noProd, /unavailable/, "不给时仍然明说 unavailable");
});

/* ═══════════════════ B. 反例：没给 ⇒ 仍是 unavailable（不假装有数据） ═══════════════════ */

test("B 反例：完全不传 production ⇒ unavailable，且不编造任何数字", () => {
    const seg = prodBlock(buildPrompt(opts({ production: undefined })));
    assert.match(seg, /unavailable/, "缺数据时必须明说");
    assert.ok(!/\d/.test(seg.split("\n").slice(1).join("\n")),
        `缺数据时段落里不许出现数字（会诱导模型把 0 当成观测值）：${JSON.stringify(seg)}`);
});

test("B2 反例：production 不是对象（字符串/数字）⇒ 也是 unavailable，不崩", () => {
    for (const bad of ["nonsense", 42, true]) {
        const seg = prodBlock(buildPrompt(opts({ production: bad })));
        assert.match(seg, /unavailable/, `production=${JSON.stringify(bad)} 时必须是 unavailable`);
    }
});

test("B3 反例：传了 production 但**没塞进 obs** —— 证明不再读 obs.production", () => {
    /* 这正是 loop 过去的真实形状：obs 里干干净净，production 在别处。
       修复前这一条必红（渲染 unavailable），修复后必绿。 */
    const obsClean = { ...L5 };
    assert.ok(!("production" in obsClean), "夹具前提：obs 里本来就没有 production");
    const seg = prodBlock(buildPrompt(opts({ obs: obsClean })));
    assert.match(seg, /window_seconds: 60/, "production 作为独立参数必须能被渲染");
});

/* ═══════════════════ C. 正例：空对象 ⇒ 如实说「无数据」 ═══════════════════ */

test("C 正例：production 是 {} ⇒ 不崩，且如实说无数据（不是假装有 window_seconds）", () => {
    const seg = prodBlock(buildPrompt(opts({ production: {} })));
    assert.match(seg, /^## PRODUCTION/, "段落头必须在");
    assert.ok(!/window_seconds/.test(seg), "空对象里没有 window_seconds，不许凭空渲染");
    assert.match(seg, /no data|empty|无数据|unavailable/i,
        `空对象必须如实说「没读到东西」，不能只留一个段落头：${JSON.stringify(seg)}`);
});

test("C2 正例：production 只有 window_seconds（真实空产线的形态）⇒ 说 0 产出，不说 unavailable", () => {
    /* 实测的空产线长这样（`.tmpverify/definitive/run/…/production-last.json`）：
       produced_total/{} + delivered_total/{} + stored_delta 全 0。
       这时**读到了数据**（窗口是真的），只是没在产 —— 不能说 unavailable。 */
    const idle = {
        window_seconds: 60, slice_seconds: 10, slices_returned: 6,
        produced_total: {}, produced_per_sec: {},
        delivered_total: {}, delivered_per_sec: {},
        stored_delta: { "CuCuCuCu": 0, "----CuCu": 0 },
        produced_slices: [{}, {}, {}, {}, {}, {}],
        delivered_slices: [{}, {}, {}, {}, {}, {}],
    };
    const seg = prodBlock(buildPrompt(opts({ production: idle })));
    assert.match(seg, /window_seconds: 60/, "窗口秒数是真观测，必须渲染");
    assert.ok(!/unavailable/.test(seg), "读到了窗口就**不是** unavailable —— 空产线 ≠ 没数据");
});

/* ═══════════════════ D. 接线：loop 真的把 production 送进 prompt ═══════════════════ */

test("D 接线（这是这个 bug 的唯一直接回归守卫）：loop 送进 prompt 的 PRODUCTION 段有真实数字", async () => {
    const g = FakeGame.fromFiles(
        path.join(REPO, "test/fixtures/saves/L4-obs.json"), null, { goal: "RuRu----" });
    /* FakeGame 的 production 是 {produced_total:{}, produced_per_sec:{}, window_seconds:60}
       —— 一个**真实存在但很空**的形状，正好能区分「读到了」与「没读到」。 */
    g.production = {
        ...g.production,
        produced_total: { "Ru----Ru": 42 },
        produced_per_sec: { "Ru----Ru": 0.7 },
    };

    const seen = [];
    const llmClient = {
        async propose(bundle) {
            seen.push(bundle);
            return { text: JSON.stringify({ say: "nothing to do", calls: [] }), usage: null, raw: null };
        },
    };

    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "prodwire-"));
    try {
        await runLoop({
            reader: g.reader(),
            goal: "RuRu----",
            llmClient,
            mode: "mock",
            runDir,
            game: g,
            budget: { LLM_CALLS_MAX: 1, ROUNDS_MAX: 1 },
        });
    } finally {
        try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    assert.equal(seen.length, 1, "应当恰好问了一次 LLM");
    const seg = seen[0].blocks.s3_production;
    assert.match(seg, /window_seconds: 60/, `loop 必须把 production 送到 prompt 里，实际：${JSON.stringify(seg)}`);
    assert.match(seg, /produced Ru----Ru: 42/, `产线真实产出必须进 prompt，实际：${JSON.stringify(seg)}`);
    assert.ok(!/unavailable/.test(seg), "有 production 时不许渲染 unavailable");
});
