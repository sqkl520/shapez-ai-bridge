/**
 * 上一轮因「多调用 + 有失败」被整单拒时，这一轮必须只让模型提 1 个调用。
 *
 * ## 为什么要单独钉住
 *
 * `NO_REVERSIBLE_CALL` 的 hint 写着「下一次只提交一个调用：两条一起提，
 * 任何一条失败都会让整个计划作废」。而固定的收尾指令写着 `1 to 6 calls` ——
 * **两句话直接打架**，模型当然听最后那句（它就紧挨着输出位置）。
 *
 * 实测（r-20261118171858-d768）：连续三轮都提 `connect,connect`，每轮都被拒，
 * 每轮都收到「只做一个」的 hint，每轮都继续提两个。它不是在忽视 hint ——
 * prompt 里同时存在两条互相矛盾的指令，而显眼的那条是「1 到 6」。
 *
 * ## 这个文件钉住什么
 *
 * 1. 正常情况仍然是 `1 to N calls`（不改常态行为）
 * 2. `NO_REVERSIBLE_CALL` / `PARTIAL_APPLY` 之后变成 `Exactly 1 call`
 * 3. 判定只看**上一轮**的 codes，不受本轮诊断影响
 * 4. 只看当前轮，不记忆更早的 —— 上一轮成功了就该恢复常态
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPrompt } from "./prompt.mjs";
import { buildHandles } from "./handles.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const FIX = path.join(REPO, "test/fixtures/saves");

const OBS = JSON.parse(fs.readFileSync(path.join(FIX, "L4-obs.json"), "utf8")).result;
const handles = buildHandles(OBS, null);

function render(lastRound) {
    const out = buildPrompt({
        goal: "RuRu----",
        obs: OBS,
        handles,
        diagnoses: [],
        candidates: ["connect", "replace_run"],
        budget: { in_chars_max: 16000, prompt_tokens_max: 4600 },
        ...(lastRound ? { lastRound } : {}),
    });
    return out.user || "";
}

/** 取 `## YOUR TURN` 之后的那几行 —— 那才是模型照着写输出的地方。 */
function yourTurn(text) {
    const i = text.indexOf("## YOUR TURN");
    assert.ok(i >= 0, "prompt 里必须有 YOUR TURN 段");
    return text.slice(i);
}

test("常态：仍然是 1..N calls（不因加了这个切换就改动默认行为）", () => {
    const t = yourTurn(render({ round: 1, calls: [{ macro: "connect" }], verify: { checks: [] }, codes: [], failures: [] }));
    assert.match(t, /1 to \d+ calls/, "没有失败史时不该收窄");
    assert.doesNotMatch(t, /Exactly 1 call/i);
});

test("NO_REVERSIBLE_CALL 之后：变成 Exactly 1 call", () => {
    const t = yourTurn(render({
        round: 2, calls: [{ macro: "connect" }, { macro: "connect" }],
        verify: { checks: [] }, codes: ["NO_REVERSIBLE_CALL"], failures: [],
    }));
    assert.match(t, /Exactly 1 call/i, "被整单拒之后必须收窄到 1 个");
    assert.doesNotMatch(t, /1 to \d+ calls/, "收窄时要撤掉「可以提多个」那句，否则两句自相矛盾");
});

/* ★ 这条是实测逼出来的 ★
 *
 * `settleFailure` 在 plan 阶段被拒时把码写在 `verify.codes` 里
 * （loop.mjs:2884 `verify: { checks: [], codes: [...] }`），顶层没有。
 * 收窄的第一版只读顶层 `codes`，于是**从来没触发过** —— 三个 run 的
 * `rejected.code` 都是 NO_REVERSIBLE_CALL，而 prompt 里仍是「1 to 6 calls」。
 * 上面那条测试用的是顶层 codes，所以它没抓到这个 bug。 */
test("码在 verify.codes 里（settleFailure 的真实形态）也必须触发收窄", () => {
    const t = yourTurn(render({
        round: 2, calls: [{ macro: "connect" }, { macro: "connect" }],
        verify: { checks: [], codes: ["NO_REVERSIBLE_CALL"] }, failures: [],
    }));
    assert.match(t, /Exactly 1 call/i,
        "settleFailure 把码写在 verify.codes，只读顶层会漏掉一整类真实情况");
    assert.doesNotMatch(t, /1 to \d+ calls/);
});

test("PARTIAL_APPLY 之后：同样收窄", () => {
    const t = yourTurn(render({
        round: 2, calls: [{ macro: "connect" }, { macro: "insert_machine" }],
        verify: { checks: [] }, codes: ["PARTIAL_APPLY"], failures: [],
    }));
    assert.match(t, /Exactly 1 call/i);
});

test("其它失败码不收窄（比如单纯 MACRO_REFUSED，换个写法就能成）", () => {
    const t = yourTurn(render({
        round: 2, calls: [{ macro: "connect" }],
        verify: { checks: [] }, codes: ["MACRO_REFUSED"], failures: [],
    }));
    assert.match(t, /1 to \d+ calls/, "只有「多调用且撤不回来」才需要收窄");
    assert.doesNotMatch(t, /Exactly 1 call/i);
});

test("上一轮成功（codes 空）⇒ 恢复常态，不记忆更早的收窄", () => {
    const t = yourTurn(render({
        round: 5, calls: [{ macro: "connect" }],
        verify: { checks: [{ name: "L2", ok: true }] }, codes: [], failures: [],
    }));
    assert.match(t, /1 to \d+ calls/);
    assert.doesNotMatch(t, /Exactly 1 call/i);
});

test("第一轮（没有 lastRound）⇒ 常态", () => {
    const t = yourTurn(render(null));
    assert.match(t, /1 to \d+ calls/);
});
