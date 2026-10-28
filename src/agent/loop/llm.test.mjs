/**
 * llm.test.mjs — LLM 层的离线自测（不连游戏、不调真实 API）。
 *
 * 纪律（与 gates.test.mjs / verify_runtime.test.mjs 同源）：每条断言都要有一个
 * 「去掉对应检查就会假绿」的夹具。所以这里大量是负例：
 *   · mock 耗尽            → 必须抛 MockExhausted（不是返回空串、不是"完成"）
 *   · usage 在 mock 下      → 必须 null（否则 run_end 会假装有 token 账）
 *   · 无 key               → 必须抛（不是静默空请求）
 *   · 空 calls / 7 calls   → 必须各报自己的码（不是笼统 LLM_PARSE）
 *   · build_line           → 必须 LLM_UNKNOWN_MACRO
 *
 * 用法：node src/agent/loop/llm.test.mjs
 * 退出码：0 全过 / 1 有失败
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
    LLMClient, AnthropicClient, MockLLMClient, ReplayLLMClient, MockExhausted, LLMError,
    makeClient, parseLlmPlan, stripFences, LLM_MACRO_WHITELIST, LLM_PLAN_ERRORS, LLM_ENDPOINT, LLM_SAY_MAX,
    LLM_CALLS_MAX, LLM_OUT_CHARS_MAX,
} from "./llm.mjs";
import { MACRO_NAMES } from "../macros/contract.mjs";

let pass = 0, fail = 0;
const failures = [];

function ok(cond, label, extra) {
    if (cond && typeof cond.then === "function") {
        fail++; failures.push(label + " [Promise 当布尔]");
        console.log("✗ " + label + "  [cond 是 Promise，断言无效；漏了 await 吗？]");
        return;
    }
    if (cond) { pass++; console.log("✓ " + label); }
    else { fail++; failures.push(label); console.log("✗ " + label + (extra !== undefined ? "  " + JSON.stringify(extra) : "")); }
}
const eq = (got, want, label) => ok(got === want, label, { got, want });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, "../../../test/fixtures/llm");

const readJson = f => JSON.parse(fs.readFileSync(f, "utf8"));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "llmtest-"));

async function rejects(fn, label, check) {
    try {
        await fn();
        fail++; failures.push(label);
        console.log(`✗ ${label}  [没有抛出]`);
    } catch (e) {
        const good = check ? check(e) : true;
        if (good) { pass++; console.log(`✓ ${label}  (${e.name}: ${e.code || "-"})`); }
        else { fail++; failures.push(label); console.log(`✗ ${label}  [抛错了东西]  ${e && e.stack}`); }
    }
}

/* ═══════════════════ 0. 接口 ═══════════════════ */

console.log("\n── 0. 接口 ──");
{
    const base = new LLMClient();
    await rejects(() => base.propose({ system: "", user: "" }), "LLMClient.propose 是抽象的", e => /abstract/.test(e.message));
    eq(LLM_MACRO_WHITELIST.length, 6, "白名单恰好 6 个宏");
    ok(LLM_MACRO_WHITELIST.every((n, i) => n === MACRO_NAMES[i]), "白名单逐项等于 MACRO_NAMES（不是抄的第二份）");
    ok(!LLM_MACRO_WHITELIST.includes("build_line"), "build_line 不在白名单");
    ok(Object.isFrozen(LLM_PLAN_ERRORS), "错误码表被冻结");
    eq(new Set(LLM_PLAN_ERRORS).size, LLM_PLAN_ERRORS.length, "错误码无重复");
}

/* ═══════════════════ 1. MockLLMClient ═══════════════════ */

console.log("\n── 1. MockLLMClient ──");
{
    const c = new MockLLMClient({ dir: FIXTURES, scenario: "l4-coldstart" });
    eq(c.callCount, 0, "初始 callCount 为 0");
    eq(c.roundCount, 1, "roundCount 统计 round-*.json");

    const r1 = await c.propose({ system: "s", user: "u" });
    eq(c.callCount, 1, "第一次 propose 后 callCount === 1");
    eq(r1.usage, null, "mock 的 usage === null");
    ok(r1.text.includes("replace_run"), "text 是文件原文（原样交出）", { head: r1.text.slice(0, 60) });
    ok(r1.raw && Array.isArray(r1.raw.calls), "raw 是解析后的对象");
    ok(!("done" in r1) && !("success" in r1) && !("finished" in r1), "mock 不返回任何『已完成』信号");
    ok(!("completed" in r1) && !("ok" in r1), "mock 返回值里没有 ok/completed");

    // 耗尽
    await rejects(
        () => c.propose({ system: "s", user: "u" }),
        "第 2 次调用（夹具只有 1 轮）抛 MockExhausted",
        e => e instanceof MockExhausted && e.code === "MOCK_EXHAUSTED" && e.detail.call === 2,
    );
    eq(c.callCount, 2, "耗尽的调用也计入 callCount（可审计）");
}
{
    /* 按序读：造一个两轮的临时场景，断言第 1/2 次读的是 round-01 / round-02 */
    const dir = tmpDir();
    const sc = path.join(dir, "two");
    fs.mkdirSync(sc, { recursive: true });
    fs.writeFileSync(path.join(sc, "round-01.json"), '{"calls":[{"macro":"remove_run","args":{"uids":{"$uids":["B1"]}}}]}');
    fs.writeFileSync(path.join(sc, "round-02.json"), '{"calls":[{"macro":"connect","args":{"from":{"$ref":"B1"},"to":{"$ref":"H1"}}}]}');
    const c = new MockLLMClient({ dir, scenario: "two" });
    const a = await c.propose({ system: "", user: "" });
    const b = await c.propose({ system: "", user: "" });
    ok(a.raw.calls[0].macro === "remove_run", "第 1 次读 round-01.json");
    ok(b.raw.calls[0].macro === "connect", "第 2 次读 round-02.json");
    eq(c.roundCount, 2, "roundCount === 2");
    await rejects(() => c.propose({ system: "", user: "" }), "第 3 次抛 MockExhausted", e => e instanceof MockExhausted);
    fs.rmSync(dir, { recursive: true, force: true });
}
{
    /* 非 strict：耗尽也不能是成功 —— 交空计划出去，parse 必判 LLM_EMPTY_PLAN */
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "empty"), { recursive: true });
    const c = new MockLLMClient({ dir, scenario: "empty", strict: false });
    const r = await c.propose({ system: "", user: "" });
    eq(r.exhausted, true, "非 strict 耗尽：exhausted=true");
    eq(r.usage, null, "非 strict 耗尽：usage 仍为 null");
    const p = parseLlmPlan(r.text);
    eq(p.ok, false, "非 strict 耗尽：交出的是**空计划**");
    eq(p.error.code, "LLM_EMPTY_PLAN", "非 strict 耗尽：parse 判 LLM_EMPTY_PLAN（绝不可能读成成功）");
    fs.rmSync(dir, { recursive: true, force: true });
}
{
    /* 坏 JSON 夹具必须抛，不许 mock 修补 */
    const dir = tmpDir();
    const sc = path.join(dir, "bad");
    fs.mkdirSync(sc, { recursive: true });
    fs.writeFileSync(path.join(sc, "round-01.json"), '{"calls":[{"macro":"remove_run",]');
    const c = new MockLLMClient({ dir, scenario: "bad" });
    await rejects(() => c.propose({ system: "", user: "" }), "坏 JSON 夹具抛 LLM_NOT_JSON（mock 不修补）",
        e => e instanceof LLMError && e.code === "LLM_NOT_JSON");
    fs.rmSync(dir, { recursive: true, force: true });
}
{
    const c = new MockLLMClient({ dir: FIXTURES, scenario: "neg-empty-calls" });
    const r = await c.propose({ system: "", user: "" });
    const p = parseLlmPlan(r.text);
    eq(p.ok, false, "neg-empty-calls 夹具 parse 失败");
    eq(p.error.code, "LLM_EMPTY_PLAN", "neg-empty-calls → LLM_EMPTY_PLAN");
}
{
    const c = new MockLLMClient({ dir: FIXTURES, scenario: "neg-unknown-macro" });
    const r = await c.propose({ system: "", user: "" });
    const p = parseLlmPlan(r.text);
    eq(p.error && p.error.code, "LLM_UNKNOWN_MACRO", "neg-unknown-macro → LLM_UNKNOWN_MACRO（mock 原样交出 build_line）");
    ok(r.text.includes("build_line"), "夹具里的 build_line 确实到达了解析层（不是被夹具层挡住的）");
}
{
    const c = new MockLLMClient({ dir: FIXTURES, scenario: "neg-literal-coord" });
    const r = await c.propose({ system: "", user: "" });
    const p = parseLlmPlan(r.text);
    ok(p.ok, "neg-literal-coord 在**结构**层是合法的（坐标禁令属于 coords.mjs 的 V1）");
    ok(JSON.stringify(p.plan.calls[0].args.at) === "[4,-13]", "字面坐标原样到达 plan（交给下一层判 V1）");
}

/* ═══════════════════ 2. AnthropicClient ═══════════════════ */

console.log("\n── 2. AnthropicClient ──");
{
    /* 关键的一条：无 key 必须在**构造期**抛，不能让空请求出门 */
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
        let thrown = null;
        try { new AnthropicClient(); } catch (e) { thrown = e; }
        ok(!!thrown, "无 key 时构造即抛（不是静默请求）");
        eq(thrown && thrown.code, "LLM_NO_API_KEY", "错误码是 LLM_NO_API_KEY");
        ok(thrown && /ANTHROPIC_API_KEY/.test(thrown.message), "错误信息点名了环境变量", { msg: thrown && thrown.message });
        let thrown2 = null;
        try { new AnthropicClient({ apiKey: "   " }) } catch (e) { thrown2 = e; }
        ok(!!thrown2 && thrown2.code === "LLM_NO_API_KEY", "空白 key 同样被拒");
    } finally {
        if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved;
    }
}
{
    /* 请求形状：URL / 头 / body / 无 prefill。用 fetchImpl 注入，**不出网**。 */
    let seen = null;
    const fakeFetch = async (url, init) => {
        seen = { url, init };
        return {
            ok: true, status: 200, statusText: "OK",
            text: async () => JSON.stringify({
                id: "msg_1", type: "message", role: "assistant", stop_reason: "end_turn",
                content: [{ type: "text", text: '{"calls":[{"macro":"remove_run","args":{"uids":{"$uids":["B1"]}}}]}' }],
                usage: { input_tokens: 2410, output_tokens: 520 },
            }),
        };
    };
    const c = new AnthropicClient({ apiKey: "sk-test-not-real", fetchImpl: fakeFetch });
    const out = await c.propose({ system: "SYS", user: "USR" });

    eq(seen.url, LLM_ENDPOINT, "POST 到 /v1/messages");
    eq(seen.url, "https://api.anthropic.com/v1/messages", "端点字面值");
    eq(seen.init.method, "POST", "method POST");
    eq(seen.init.headers["x-api-key"], "sk-test-not-real", "x-api-key 头");
    eq(seen.init.headers["anthropic-version"], "2023-06-01", "anthropic-version 头");
    eq(seen.init.headers["content-type"], "application/json", "content-type 头");
    ok(!!seen.init.signal, "传了 AbortSignal（超时）");
    const body = JSON.parse(seen.init.body);
    eq(body.system, "SYS", "system 走顶层字段");
    eq(body.messages.length, 1, "messages 只有 1 条（无 assistant prefill）");
    eq(body.messages[0].role, "user", "唯一的 message 是 user");
    eq(body.messages[0].content, "USR", "user 内容原样");
    ok(!body.messages.some(m => m.role === "assistant"), "**没有** assistant prefill（当前模型族拒绝）");
    eq(body.max_tokens, 1200, "max_tokens 默认 1200");

    eq(out.text.startsWith('{"calls"'), true, "抽出 text 块");
    eq(out.usage.in, 2410, "usage.in");
    eq(out.usage.out, 520, "usage.out");
    ok(out.raw && out.raw.id === "msg_1", "raw 是完整响应");
    eq(c.callCount, 1, "callCount 递增");
}
{
    /* 注入的 fetch 抛 TimeoutError → LLM_TRANSPORT（且 detail.timedOut） */
    const boom = async () => { const e = new Error("timed out"); e.name = "TimeoutError"; throw e; };
    const c = new AnthropicClient({ apiKey: "sk-x", fetchImpl: boom, timeoutMs: 1234 });
    await rejects(() => c.propose({ system: "s", user: "u" }), "超时 → LLM_TRANSPORT",
        e => e.code === "LLM_TRANSPORT" && e.detail && e.detail.timedOut === true && /1234/.test(e.message));
}
{
    /* HTTP 400 → LLM_TRANSPORT，且把服务端的 error.message 带出来 */
    const res400 = async () => ({
        ok: false, status: 400, statusText: "Bad Request",
        text: async () => JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prefill not supported" } }),
    });
    const c = new AnthropicClient({ apiKey: "sk-x", fetchImpl: res400 });
    await rejects(() => c.propose({ system: "s", user: "u" }), "HTTP 400 → LLM_TRANSPORT",
        e => e.code === "LLM_TRANSPORT" && e.detail.status === 400 && /prefill not supported/.test(e.message));
}
{
    /* 200 但 body 不是 JSON → LLM_TRANSPORT（不是静默空串） */
    const badBody = async () => ({ ok: true, status: 200, statusText: "OK", text: async () => "<html>oops</html>" });
    const c = new AnthropicClient({ apiKey: "sk-x", fetchImpl: badBody });
    await rejects(() => c.propose({ system: "s", user: "u" }), "200 非 JSON → LLM_TRANSPORT", e => e.code === "LLM_TRANSPORT");
}

/* ═══════════════════ 3. ReplayLLMClient ═══════════════════ */

console.log("\n── 3. ReplayLLMClient ──");
{
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "round-01.txt"), '{"calls":[{"macro":"remove_run","args":{"uids":{"$uids":["B1"]}}}]}');
    fs.writeFileSync(path.join(dir, "round-01.meta.json"), JSON.stringify({ usage: { in: 100, out: 20 }, stop_reason: "end_turn" }));
    /* 第 2 轮没有 meta.json 也不许崩：usage 退化为 null */
    fs.writeFileSync(path.join(dir, "round-02.txt"), '{"calls":[{"macro":"remove_run","args":{"uids":{"$uids":["B2"]}}}]}');
    const c = new ReplayLLMClient({ dir });
    const r = await c.propose({ system: "", user: "" });
    eq(r.usage.in, 100, "replay 的 usage 来自录制（不是 null）");
    eq(r.raw.calls[0].macro, "remove_run", "replay 的 text 可解析");
    const r2 = await c.propose({ system: "", user: "" });
    eq(r2.usage, null, "缺 meta.json 时 replay usage 为 null（不猜）");
    await rejects(() => c.propose({ system: "", user: "" }), "replay 耗尽抛 MockExhausted", e => e instanceof MockExhausted);
    fs.rmSync(dir, { recursive: true, force: true });
}

/* ═══════════════════ 4. makeClient ═══════════════════ */

console.log("\n── 4. makeClient ──");
{
    ok(makeClient({ mode: "mock", dir: FIXTURES, scenario: "l4-coldstart" }) instanceof MockLLMClient, "makeClient mock");
    ok(makeClient({ mode: "replay", dir: FIXTURES }) instanceof ReplayLLMClient, "makeClient replay");
    ok(makeClient({ mode: "live", apiKey: "sk-x" }) instanceof AnthropicClient, "makeClient live");
    let thrown = null;
    try { makeClient({ mode: "nope" }); } catch (e) { thrown = e; }
    ok(!!thrown && thrown.code === "LLM_TRANSPORT" && /nope/.test(thrown.message), "makeClient 未知 mode 抛错并点名");
    /* live 无 key 时 makeClient 也要炸，而不是延迟到 propose */
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    let thrown2 = null;
    try { makeClient({ mode: "live" }); } catch (e) { thrown2 = e; }
    ok(!!thrown2 && thrown2.code === "LLM_NO_API_KEY", "makeClient live 无 key 同样立刻抛");
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
}

/* ═══════════════════ 5. parseLlmPlan ═══════════════════ */

console.log("\n── 5. parseLlmPlan ──");
{
    const good = '{"say":"cut it","calls":[{"macro":"replace_run","args":{"region":{"$bbox_of":["B1"]},"building":"belt"},"why":"rv"}]}';
    const p1 = parseLlmPlan(good);
    ok(p1.ok, "合法 JSON → ok");
    eq(p1.plan.calls.length, 1, "合法 JSON：1 个 call");
    eq(p1.plan.calls[0].macro, "replace_run", "合法 JSON：宏名保留");
    eq(p1.plan.say, "cut it", "合法 JSON：say 保留");
    eq(p1.error, null, "合法 JSON：error === null");

    /* 带 ```json 围栏 */
    const fenced = "```json\n" + good + "\n```";
    const p2 = parseLlmPlan(fenced);
    ok(p2.ok, "带 ```json 围栏 → ok（剥掉）");
    eq(p2.plan.calls[0].macro, "replace_run", "围栏剥离后内容正确");
    eq(stripFences("```\n" + good + "\n```"), good, "stripFences 对裸围栏也有效");
    ok(parseLlmPlan("Here you go:\n```json\n" + good + "\n```\nHope that helps").ok, "围栏外的客套话不影响解析");

    /* 空 calls */
    const p3 = parseLlmPlan('{"say":"nothing","calls":[]}');
    eq(p3.ok, false, "空 calls → 失败");
    eq(p3.error.code, "LLM_EMPTY_PLAN", "空 calls → LLM_EMPTY_PLAN");

    /* build_line */
    const p4 = parseLlmPlan('{"calls":[{"macro":"build_line","args":{"target":"RuRu----"}}]}');
    eq(p4.ok, false, "build_line → 失败");
    eq(p4.error.code, "LLM_UNKNOWN_MACRO", "build_line → LLM_UNKNOWN_MACRO");
    ok((p4.error.detail.whitelist || []).join(",") === LLM_MACRO_WHITELIST.join(","), "错误里带上了白名单（模型可据此纠正）");

    /* 7 个 calls */
    const seven = JSON.stringify({
        calls: Array.from({ length: 7 }, () => ({ macro: "remove_run", args: { uids: { $uids: ["B1"] } } })),
    });
    const p5 = parseLlmPlan(seven);
    eq(p5.ok, false, "7 个 calls → 失败");
    eq(p5.error.code, "LLM_TOO_MANY_CALLS", "7 个 calls → LLM_TOO_MANY_CALLS");
    /* 边界：恰好 6 个必须过 */
    const six = JSON.stringify({
        calls: Array.from({ length: 6 }, () => ({ macro: "remove_run", args: { uids: { $uids: ["B1"] } } })),
    });
    ok(parseLlmPlan(six).ok, "恰好 6 个 calls → ok（边界不是差一）");

    /* 非 JSON */
    const p6 = parseLlmPlan("I think we should delete the belt.");
    eq(p6.ok, false, "非 JSON → 失败");
    eq(p6.error.code, "LLM_NOT_JSON", "非 JSON → LLM_NOT_JSON");
    eq(parseLlmPlan("").error.code, "LLM_NOT_JSON", "空串 → LLM_NOT_JSON");
    eq(parseLlmPlan("```json\n```").error.code, "LLM_NOT_JSON", "空围栏 → LLM_NOT_JSON");
}
{
    /* 其余结构错误 */
    eq(parseLlmPlan('{"say":"x"}').error.code, "LLM_SCHEMA", "缺 calls 数组 → LLM_SCHEMA");
    eq(parseLlmPlan('{"calls":"nope"}').error.code, "LLM_SCHEMA", "calls 不是数组 → LLM_SCHEMA");
    eq(parseLlmPlan("[1,2]").error.code, "LLM_SCHEMA", "顶层是数组 → LLM_SCHEMA");
    eq(parseLlmPlan('{"calls":[{"macro":"remove_run"}]}').error.code, "LLM_ARGS", "缺 args → LLM_ARGS");
    eq(parseLlmPlan('{"calls":[{"args":{}}]}').error.code, "LLM_UNKNOWN_MACRO", "缺 macro → LLM_UNKNOWN_MACRO");
    ok(parseLlmPlan('{"calls":[{"macro":"remove_run","args":{}},{"macro":"paste_blueprint","args":{}}]}')
        .error.code === "LLM_UNKNOWN_MACRO", "paste_blueprint 同样被拒（白名单是闭集）");
}
{
    /* 长度：不截断，直接拒 */
    const long = '{"calls":[{"macro":"remove_run","args":{},"why":"' + "x".repeat(4100) + '"}]}';
    const p = parseLlmPlan(long);
    eq(p.ok, false, ">4000 字符 → 失败");
    eq(p.error.code, "LLM_TOO_LONG", ">4000 字符 → LLM_TOO_LONG");
    eq(p.error.detail.chars, long.length, "错误里带实际字符数（可审计）");
    /* 3999 字符左右必须仍可解析（证明不是把边界写成了恒真）。
       用 why 加长而不是 say：say 有自己的 280 字符上限（LLM_NARRATION），
       两个上限混在一个样本里就测不出 LLM_TOO_LONG 的边界。 */
    const pad = '{"say":"ok","calls":[{"macro":"remove_run","args":{"uids":{"$uids":["B1"]}},"why":"' + "y".repeat(3800) + '"}]}';
    ok(pad.length < 4000, "构造的边界样本 < 4000", { len: pad.length });
    ok(parseLlmPlan(pad).ok, "接近上限的合法输出仍通过");
}
{
    /* say / why 夹带坐标（V4）。注意：goal 形状串与计数不能误命中。 */
    eq(parseLlmPlan('{"say":"delete the belt at (4,-13)","calls":[{"macro":"remove_run","args":{}}]}').error.code,
        "LLM_NARRATION", "say 含 (4,-13) → LLM_NARRATION");
    eq(parseLlmPlan('{"say":"x","calls":[{"macro":"remove_run","args":{},"why":"move 4, -13 up"}]}').error.code,
        "LLM_NARRATION", "why 含 4, -13 → LLM_NARRATION");
    ok(parseLlmPlan('{"say":"target is RuRu----, 12 items, 20 seconds","calls":[{"macro":"remove_run","args":{}}]}').ok,
        "形状串/计数/秒数**不**误命中坐标正则");
    ok(parseLlmPlan('{"say":"the belt at x=-13 is stuck","calls":[{"macro":"remove_run","args":{}}]}').ok,
        "单个负数（无逗号）不算坐标 —— 与契约 V4 的口径一致");
    eq(parseLlmPlan('{"say":"' + "z".repeat(LLM_SAY_MAX + 1) + '","calls":[{"macro":"remove_run","args":{}}]}').error.code,
        "LLM_NARRATION", `say > ${LLM_SAY_MAX} 字符 → LLM_NARRATION`);
}

/* ═══════════════════ 6. 真实夹具扫一遍 ═══════════════════ */

console.log("\n── 6. 夹具与 meta 自洽 ──");
{
    const scenarios = fs.readdirSync(FIXTURES).filter(d => fs.statSync(path.join(FIXTURES, d)).isDirectory());
    ok(scenarios.length >= 4, `夹具目录 >= 4 个（实际 ${scenarios.length}）`);
    for (const s of scenarios) {
        const dir = path.join(FIXTURES, s);
        const meta = readJson(path.join(dir, "meta.json"));
        eq(meta.scenario, s, `${s}: meta.scenario 与目录名一致`);
        ok(typeof meta.goal === "string" && meta.goal.length > 0, `${s}: meta.goal 非空`);
        const rounds = fs.readdirSync(dir).filter(f => /^round-\d{2}\.json$/.test(f)).sort();
        ok(rounds.length >= 1, `${s}: 至少 1 轮`);
        /* meta 里的 obs 路径必须真实存在（用错夹具会静默换关，契约 §0 F6） */
        const obsFile = path.resolve(HERE, "../../..", meta.obs);
        ok(fs.existsSync(obsFile), `${s}: meta.obs 指向的文件存在`);
        const obs = readJson(obsFile).result;
        eq(obs.goal.requirement.shape, meta.goal, `${s}: meta.goal 与 obs 的目标形状一致（不许跑错关）`);
        const first = readJson(path.join(dir, rounds[0]));
        const p = parseLlmPlan(JSON.stringify(first));
        if (meta.expect.parse_error) eq(p.error && p.error.code, meta.expect.parse_error, `${s}: parse 报 ${meta.expect.parse_error}`);
        else if (meta.expect.parse_ok) ok(p.ok, `${s}: parse 通过（坐标禁令在下一层）`);
        else if (meta.expect.parse === "ok") ok(p.ok, `${s}: parse 通过`);

        /* meta 声明了坐标守卫就必须真的被验证 —— 否则 meta 是一份没人读的宣传单。
           （第一版确实漏了这条：meta 写了 coord_guard:"V1"，测试却只看了 parse 结果。） */
        if (meta.expect.coord_guard) {
            const { assertNoHumanCoords } = await import("./coords.mjs");
            const { buildHandles } = await import("./handles.mjs");
            const vs = readJson(path.resolve(HERE, "../../..", meta.obs)).result;
            const g = assertNoHumanCoords(p.plan, buildHandles(vs, null));
            eq(g.ok, false, `${s}: assertNoHumanCoords 判红`);
            eq(g.violations[0] && g.violations[0].rule, meta.expect.coord_guard,
                `${s}: 命中的规则 === meta.expect.coord_guard`);
        }
        if (meta.expect.parse_error || meta.expect.parse_ok || meta.expect.parse) {
            ok(fs.existsSync(path.join(dir, rounds[0])), `${s}: round-01 存在`);
        }
    }
}

/* ═══════════════════ 7. 与 BUDGET 同源（契约 §Q6.1） ═══════════════════ */

console.log("\n── 7. 上限的唯一真值 ──");
{
    /* 这一条放在 llm.test.mjs 而不是 prompt.test.mjs：后者必须能单独跑（不 import 别人的文件）。
       本文件已经 import 了 llm.mjs，再 import 两个模��是为了对拍 —— 对拍就是本段的目的。 */
    const { BUDGET } = await import("./constants.mjs");
    const { PROMPT_RULES } = await import("./prompt.mjs");

    ok(Object.isFrozen(BUDGET), "BUDGET 被冻结");
    eq(LLM_OUT_CHARS_MAX, BUDGET.LLM_OUT_CHARS_MAX, "llm.mjs 的输出上限 == BUDGET.LLM_OUT_CHARS_MAX");
    eq(PROMPT_RULES.LLM_OUT_CHARS_MAX, BUDGET.LLM_OUT_CHARS_MAX, "prompt.mjs 的输出上限 == BUDGET.LLM_OUT_CHARS_MAX");
    eq(PROMPT_RULES.LLM_IN_CHARS_MAX, BUDGET.LLM_IN_CHARS_MAX, "prompt.mjs 的输入上限 == BUDGET.LLM_IN_CHARS_MAX");
    eq(PROMPT_RULES.STATE_BELTS_MAX, BUDGET.PROMPT_STATE_BELTS_MAX, "带子上限 == BUDGET.PROMPT_STATE_BELTS_MAX");

    /* ★ 最容易被"顺手合并"的一处 ★
       `LLM_CALLS_MAX`(本文件) = 一次**计划**里最多几个 call（契约 §Q3.1，6）
       `BUDGET.LLM_CALLS_MAX`   = 一次 **run** 最多问几次模型（§Q6.1，8）
       两者混成一个数字，就会有一条防线永远不触发（要么计划永远不超，要么 run 预算永远不耗）。 */
    eq(LLM_CALLS_MAX, 6, "计划内 calls 上限 6");
    eq(BUDGET.LLM_CALLS_MAX, 8, "run 内 LLM 调用上限 8");
    ok(LLM_CALLS_MAX !== BUDGET.LLM_CALLS_MAX, "两个『上限』没有被混成一个");
    eq(`{"calls":[${Array.from({ length: 7 }, () => '{"macro":"remove_run","args":{}}').join(",")}]}`.length > 0
        && parseLlmPlan(`{"calls":[${Array.from({ length: 7 }, () => '{"macro":"remove_run","args":{}}').join(",")}]}`).error.code,
        "LLM_TOO_MANY_CALLS", "7 个 calls 在计划层就被拒（尽管 7 < 8 的 run 预算）");
}

/* ═══════════════════ 8. 与 coords.mjs 的分工（两层各司其职） ═══════════════════ */

console.log("\n── 8. 夹具的分层责任 ──");
{
    /* 这一段的目的是**钉住分层**，不是重测 coords.mjs：
       把「合法结构」与「合法坐标来源」混在一层，是整个阶段 2 最贵的那类设计错误
       （同一形状在 $bbox_of 里合法、裸写在 at 里非法）。 */
    const { assertNoHumanCoords } = await import("./coords.mjs");
    const { buildHandles } = await import("./handles.mjs");
    const vs = JSON.parse(fs.readFileSync(path.resolve(HERE, "../../../test/fixtures/saves/L4-obs.json"), "utf8")).result;
    const table = buildHandles(vs, null);

    const run = async sc => {
        const r = await new MockLLMClient({ dir: FIXTURES, scenario: sc }).propose({});
        return parseLlmPlan(r.text);
    };

    const good = await run("l4-coldstart");
    ok(good.ok, "l4-coldstart: parse 通过");
    const g = assertNoHumanCoords(good.plan, table);
    ok(g.ok, "l4-coldstart: assertNoHumanCoords 也绿（两层都过才是真的可用）");

    const lit = await run("neg-literal-coord");
    ok(lit.ok, "neg-literal-coord: parse **通过**（结构合法）");
    const v = assertNoHumanCoords(lit.plan, table);
    eq(v.ok, false, "neg-literal-coord: assertNoHumanCoords 判红");
    eq(v.violations[0] && v.violations[0].rule, "V1", "neg-literal-coord: 命中 V1（字面坐标）");
    ok((v.violations[0] && v.violations[0].path || "").includes("calls[0].args.at"), "违规路径精确到 calls[0].args.at");
}

/* ═══════════════════ 汇总 ═══════════════════ */

console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) {
    console.log("\n失败项：");
    for (const f of failures) console.log("  · " + f);
    process.exitCode = 1;
}
