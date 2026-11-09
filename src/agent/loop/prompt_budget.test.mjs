/**
 * 预算：真实大存档上 CAPACITY 段不许被挤掉。
 *
 * ## 为什么单独一个测试文件
 *
 * `PROMPT_RULES.PROMPT_TOKENS_MAX = 2800` ⇒ `targetChars = 9800`。
 * 那是按 **37 条带子的小场景**调出来的值，而真实 L4 存档有 **163 条带子 + 7 条诊断**。
 *
 * 实测（修之前）：
 *   L4-obs.json（181 实体 / 163 带子 / 7 诊断）
 *     默认预算 → 9895 字符，belts_shown **0/163**，CAPACITY **dropped-for-budget**
 *
 * 而 `prompt.mjs:1706` 的分配顺序是「先定带子、余量才给 CAPACITY」——
 * 预算不够时**第一个死的是 CAPACITY**，恰好是信息量最大的一段。
 *
 * ## 这个文件钉住什么
 *
 * 1. `buildPrompt` 本身在真实大存档上**默认就会掉 CAPACITY**（这是事实，不是 bug 判据）
 * 2. `runLoop` 调用 `buildPrompt` 时**必须显式传** `in_chars_max` / `prompt_tokens_max`
 *    —— 否则上面那个事实在真实战场上生效
 * 3. 抬预算后 `system` 段**逐字节不变**（只动 user），且 16000/4600 已饱和
 *
 * 第 2 条是这次修复的**唯一**防线：`loop.mjs` 的 budget 字面量少写两个 key，
 * 测试仍然全绿（因为别的测试都用小场景），但真实存档上 CAPACITY 会静默消失。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { buildPrompt, PROMPT_RULES } from "./prompt.mjs";
import { buildHandles } from "./handles.mjs";
import { diagnose, runLoop } from "../loop.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const FIX = path.join(REPO, "test/fixtures/saves");

const L4 = JSON.parse(fs.readFileSync(path.join(FIX, "L4-obs.json"), "utf8")).result;

function bundleFor(obs, budget, extra = {}) {
    const h = buildHandles(obs, null);
    const d = diagnose(obs, null, obs.production || null, null, "RuRu----", h, {});
    return buildPrompt({
        goal: "RuRu----", obs, handles: h, diagnoses: d,
        candidates: ["connect", "replace_run", "insert_machine"], lastRound: null,
        budget, ...extra,
    });
}

/* ═══════════ 1. 事实：默认预算下真实存档掉 CAPACITY ═══════════
 *
 * 这条**故意断言 bug 的存在**。它不是在保护坏行为，是在钉住「为什么需要那个显式传参」——
 * 如果哪天有人把 `PROMPT_TOKENS_MAX` 调够了，这条会变红，提醒同步更新理由。 */
test("B1 真实 L4 存档（163 带子 / 7 诊断）：默认预算 9800 撑不住", () => {
    const p = bundleFor(L4, {});
    const total = p.system.length + p.user.length;
    const target = Math.min(PROMPT_RULES.PROMPT_TOKENS_MAX * PROMPT_RULES.CHARS_PER_TOKEN,
        PROMPT_RULES.LLM_IN_CHARS_MAX);

    assert.equal(target, 9800, `默认 targetChars 应为 9800，实际 ${target}`);
    assert.ok(total > 9000, `真实存档的 prompt 本身就接近上限（实际 ${total}）`);

    /* 现象本身：带子掉光、CAPACITY 消失。这是修复的动机。 */
    assert.equal(p.blocks.s3_capacity, null, "默认预算下 CAPACITY 会消失（这正是要修的）");
    assert.equal(p.blocks.capacity_unavailable, "dropped-for-budget",
        `消失的原因必须是预算，不是 confidence（实际 ${p.blocks.capacity_unavailable}）`);
    assert.equal(p.blocks.belts_shown, 0, `默认预算下一条带子都显示不出来（实际 ${p.blocks.belts_shown}）`);
});

/* ═══════════ 2. 抬预算之后两者都回来 ═══════════ */
test("B2 同样的存档，16000/4600 下 CAPACITY 与带子都回来", () => {
    const big = bundleFor(L4, { in_chars_max: 16000, prompt_tokens_max: 4600 });

    assert.ok(big.blocks.s3_capacity, `抬预算后 CAPACITY 必须出现（实际 unavailable=${big.blocks.capacity_unavailable}）`);
    assert.match(big.blocks.s3_capacity, /^## CAPACITY/m);
    assert.match(big.blocks.s3_capacity, /bottleneck: cutter/);
    assert.equal(big.blocks.belts_shown, PROMPT_RULES.STATE_BELTS_MAX,
        `带子名额应当用满 ${PROMPT_RULES.STATE_BELTS_MAX}（实际 ${big.blocks.belts_shown}）`);
    assert.ok(big.system.length + big.user.length <= 16000, "总字符不许超上限");
});

test("B3 16000/4600 是饱和点：再抬不涨（STATE_BELTS_MAX 是独立上限）", () => {
    const a = bundleFor(L4, { in_chars_max: 16000, prompt_tokens_max: 4600 });
    const b = bundleFor(L4, { in_chars_max: 40000, prompt_tokens_max: 11500 });
    assert.equal(a.user, b.user, "16000 与 40000 渲染出同一个 user（已饱和）");
    assert.equal(a.system, b.system);
});

test("B4 抬预算不改 system（只动 user）", () => {
    const def = bundleFor(L4, {});
    const big = bundleFor(L4, { in_chars_max: 16000, prompt_tokens_max: 4600 });
    assert.equal(def.system, big.system, "system 段必须逐字节相同");
    assert.notEqual(def.user, big.user, "user 应当变长（这是修复的代价）");
});

/* ═══════════ 3. ★ 真正的防线：runLoop 必须显式传这两个上限 ═══════════
 *
 * 这条不走 buildPrompt，走**生产路径**。
 * 如果 `loop.mjs` 的 budget 字面量少了 `in_chars_max` / `prompt_tokens_max`，
 * 这里看到的 prompt 就会掉 CAPACITY —— 而且别的测试全都绿（它们用小场景）。
 */
test("B5 ★ 生产路径：runLoop 在大存档上把 CAPACITY 送到 prompt 里", async () => {
    const { default: FakeGame } = await import("../fake_game.mjs");

    const g = FakeGame.fromFiles(
        path.join(FIX, "L4-obs.json"),
        path.join(FIX, "L5-items.json"),
        { goal: "RuRu----" },
    );

    const seen = [];
    const llmClient = {
        async propose(bundle) {
            seen.push(bundle);
            return { text: JSON.stringify({ say: "nothing to do", calls: [] }), usage: null, raw: null };
        },
    };

    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "budgetwire-"));
    try {
        await runLoop({
            reader: g.reader(), goal: "RuRu----", llmClient, mode: "mock", runDir, game: g,
            budget: { LLM_CALLS_MAX: 1, ROUNDS_MAX: 1 },
        });
    } finally {
        try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }

    assert.equal(seen.length, 1, "应当恰好问了一次 LLM");
    const b = seen[0];

    assert.ok(b.blocks.s3_capacity,
        `★ loop 必须把预算上限传给 buildPrompt，否则真实存档上 CAPACITY 消失`
        + `（unavailable=${b.blocks.capacity_unavailable}，belts=${b.blocks.belts_shown}/${b.blocks.belts_total}）。`
        + ` 修法见 loop.mjs 的 budget 字面量。`);

    assert.match(b.blocks.s3_capacity, /bottleneck: cutter/);
    assert.equal(b.blocks.belts_shown, PROMPT_RULES.STATE_BELTS_MAX,
        `带子名额也要用满（实际 ${b.blocks.belts_shown}/${b.blocks.belts_total}）`);
});

/* ═══════════ 4. 小场景：抬预算只能变多，不许变少 ═══════════ */

/**
 * 这条测试原来断言「小场景两档预算渲染**完全相同**」。
 *
 * ## 那个断言在 2026-11-04 不再成立 —— 而且它本来就在测错的命题
 *
 * `L4-live-miner1-obs.json` 叫「小场景」，但它有 **5 个候选宏**，
 * 仅 `## CANDIDATE MACROS` 一段就 3040 字符。加上 MACHINES 824 + BELTS 774
 * + 诊断 + 预算段，默认档（targetChars=9800）**本来就装不下资源行**。
 *
 * 改前两档「相同」的原因是：**两档都把资源行撤掉了** —— 那是巧合，
 * 不是「小场景在预算内」。一给卡片加上 `when:` 行（+40 字符/卡），
 * 大档就能装下资源行而默认档不能，两档立刻分叉。
 *
 * 分叉本身是**正确行为**：预算大的本来就该看到更多。
 * 所以这里改成断言真正该成立的三件事：
 *   ① system 逐字节相同（抬预算绝不该动它）；
 *   ② 大档的内容是默认档的**超集**（抬预算只会加信息，不会换掉或删掉）；
 *   ③ 带子名额不减少。
 *
 * 这与 B1–B5 共同守住「加预算不许让已有信息变少」这条纪律。
 */
test("B6 小场景（37 带子）：抬预算只增不减，system 逐字节相同", () => {
    const small = JSON.parse(fs.readFileSync(
        path.join(FIX, "L4-live-miner1-obs.json"), "utf8"));
    const def = bundleFor(small, {});
    const big = bundleFor(small, { in_chars_max: 16000, prompt_tokens_max: 4600 });

    assert.equal(def.system, big.system, "抬预算不该动 system（它是模块常量）");
    assert.ok(big.user.length >= def.user.length,
        `大档不该比默认档更短（默认 ${def.user.length} / 大 ${big.user.length}）`);
    assert.ok(big.blocks.belts_shown >= def.blocks.belts_shown,
        `带子名额不该减少（默认 ${def.blocks.belts_shown} / 大 ${big.blocks.belts_shown}）`);
    /* 资源行：默认档可能因为预算被撤，大档不该被撤 */
    if (def.blocks.resource_dropped_for_capacity) {
        assert.ok(!big.blocks.resource_dropped_for_capacity,
            "默认档都装不下资源行时，大档更不该也装不下");
    }
});
