/**
 * llm.mjs — LLM 层的唯一入口（阶段 2 契约 v2 §7 #6 / PHASE2-CONTRACT §Q3.5）。
 *
 * 三种客户端，一个接口：
 *   · `AnthropicClient` —— 真实 API（手写 fetch，**零 npm 依赖**）
 *   · `MockLLMClient`   —— 按轮读 `test/fixtures/llm/<scenario>/round-NN.json`（离线跑通全链）
 *   · `ReplayLLMClient` —— 读一次录制目录，把线上失败变成离线用例
 *
 * ## 实测/文档确认的事实（不要凭印象改）
 *
 *   1. `POST https://api.anthropic.com/v1/messages`
 *   2. 头：`x-api-key` / `anthropic-version: 2023-06-01` / `content-type: application/json`
 *   3. **不用 assistant prefill**（当前模型族拒绝）；输出格式靠 system 指令约束。
 *      —— 见 `AnthropicClient.propose()` 里的注释：`messages` 里**恒有且只有一条 user**。
 *   4. `AbortSignal.timeout(timeoutMs)` 做超时；超时与网络错误一律映射成 `LLM_TRANSPORT`。
 *   5. 无 key **必须抛**（`LLM_NO_API_KEY`），绝不静默返回空串 ——
 *      空串会让上层走到 `LLM_NOT_JSON`，看起来像"模型答错了"，掩盖"根本没调成"。
 *
 * ## mock 的纪律（契约 §Q3.5 最后一条）
 *
 *   mock **不校验、不修补、不返回任何"已完成"信号**。它只把文件内容原样交出去（`text`），
 *   外加解析后的 `raw`。是否合法、是否成功，全部由 `parseLlmPlan` 与 `verify` 判。
 *   所以：把 `build_line` 塞进夹具，mock 会**照样交出去**，是 parse 层拒绝它 ——
 *   这样才测得到"拒绝链真的存在"，而不是"mock 帮我们挡住了"。
 *
 *   文件耗尽 → `MockExhausted`。**调用方必须转成 HALT: MOCK_EXHAUSTED，不得当成功。**
 *   `usage` 恒为 `null`（mock 没有 token 计数；契约 §Q1.4 明确 `mode:"mock"` 时 usage=null）。
 *
 * ## parseLlmPlan 的边界
 *
 *   这一层只做**结构**判定（是不是 JSON、有没有 calls、数量、宏名白名单、长度、say 长度）。
 *   **不做** V1–V6 的坐标禁令 —— 那是 `coords.mjs` 的 `assertNoHumanCoords`（阶段 2 另一个文件），
 *   且它需要当轮 `handleTable` 才能判 V5。把坐标规则抄到这里就是两份真值，
 *   而这份代码库已经因为「两份真值」出过至少 3 次事故。
 *   本层唯一与坐标沾边的检查是 `LLM_NARRATION`（`say/why` 里出现成对数字，即契约 V4）——
 *   因为它是纯文本、不需要句柄表，且契约把它归在 "llm" 层的拒绝表里。
 */

import fs from "node:fs";
import path from "node:path";
import { MACRO_NAMES } from "../macros/contract.mjs";
import { BUDGET } from "./constants.mjs";

/* ══════════════════════════ 0. 常量与错误 ══════════════════════════ */

export const LLM_ENDPOINT = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
/** 6 个宏的白名单（直接派生自 ABI 契约，不抄第二份）。`build_line` **不在**其中。 */
export const LLM_MACRO_WHITELIST = MACRO_NAMES;
/**
 * **一次计划里**最多的调��数（契约 §Q3.1 的 `calls.length > 6`）。
 * 注意它 **不是** `BUDGET.LLM_CALLS_MAX`（那个是"一次 run 最多问几次模型"= 8）——
 * 两个"最多 6/8"说的是不同的事，合并会得到一条永远不触发的防线。
 */
export const LLM_CALLS_MAX = 6;
/** 输出字符上限（≈700 tok）。超了不截断，直接拒。与 BUDGET 同源。 */
export const LLM_OUT_CHARS_MAX = BUDGET.LLM_OUT_CHARS_MAX;
/** `say` 字符上限（LLM_NARRATION）。 */
export const LLM_SAY_MAX = 280;
/** 与 prompt.mjs 共用同一条坐标形态正则（此处只用它判 say/why，不用它判 args）。 */
const COORD_SRC = String.raw`\(?\s*-?\d{1,4}\s*,\s*-?\d{1,4}\s*\)?`;

/**
 * `parseLlmPlan` 的**闭集**错误码。新增一条必须同时出现在这里与测试里 ——
 * 否则 loop 拿到一个没人处理过的码会静默当成"未知失败"。
 */
export const LLM_PLAN_ERRORS = Object.freeze([
    "LLM_NOT_JSON",        // 剥围栏后仍不是合法 JSON
    "LLM_SCHEMA",          // 顶层不是对象 / calls 不是数组
    "LLM_EMPTY_PLAN",      // calls.length === 0
    "LLM_TOO_MANY_CALLS",  // calls.length > 6
    "LLM_UNKNOWN_MACRO",   // macro 不在 6 个白名单内（build_line 必被拒）
    "LLM_ARGS",            // call 缺 args 对象（结构错；语义校验在 validateMacroCall）
    "LLM_TOO_LONG",        // 输出字符数 > 4000
    "LLM_NARRATION",       // say 过长 / say|why 含坐标形态（V4）
]);

export class MockExhausted extends Error {
    constructor(message, detail) {
        super(message);
        this.name = "MockExhausted";
        this.code = "MOCK_EXHAUSTED";
        this.detail = detail || null;
    }
}

export class LLMError extends Error {
    constructor(code, message, detail) {
        super(message);
        this.name = "LLMError";
        this.code = code;
        this.detail = detail || null;
    }
}

/* ══════════════════════════ 1. 抽象基类 ══════════════════════════ */

/**
 * 整个 loop 只依赖这一个方法"问 LLM"。
 *
 * @param {{system:string, user:string, tokens_estimate?:number, blocks?:object}} promptBundle
 * @returns {Promise<{text:string, usage:{in:number,out:number}|null, raw:any}>}
 */
export class LLMClient {
    async propose(promptBundle) {
        throw new Error("LLMClient.propose is abstract; use AnthropicClient / MockLLMClient / ReplayLLMClient");
    }
}

/* ══════════════════════════ 2. 真实 API ══════════════════════════ */

/** `round-01.json` / `round-07.txt` —— 两位补零，与契约 §Q3.5 的目录约定一致。 */
function roundName(n, ext) {
    return `round-${String(n).padStart(2, "0")}.${ext}`;
}

export class AnthropicClient extends LLMClient {
    /**
     * @param {object} [o]
     * @param {string} [o.apiKey]  缺省读 `ANTHROPIC_API_KEY`；**缺失即构造期抛错**
     * @param {string} [o.model]
     * @param {number} [o.maxTokens]
     * @param {number} [o.timeoutMs]
     * @param {string} [o.recordDir] 给了就把每轮 prompt/response 落盘，供 ReplayLLMClient 回放
     * @param {Function} [o.fetchImpl] 仅供测试注入（默认 globalThis.fetch），生产不传
     */
    constructor({
        apiKey = process.env.ANTHROPIC_API_KEY,
        model = "claude-sonnet-5",
        maxTokens = 1200,
        timeoutMs = 60000,
        recordDir = null,
        fetchImpl = null,
    } = {}) {
        super();
        if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
            throw new LLMError(
                "LLM_NO_API_KEY",
                "AnthropicClient: no API key. Set ANTHROPIC_API_KEY (or pass {apiKey}) — "
                + "refusing to run without one: an empty request would be reported as LLM_NOT_JSON "
                + "and look like a model error instead of a configuration error.",
                { env: "ANTHROPIC_API_KEY" },
            );
        }
        this.apiKey = apiKey.trim();
        this.model = model;
        this.maxTokens = maxTokens;
        this.timeoutMs = timeoutMs;
        this.recordDir = recordDir;
        this._fetch = fetchImpl || globalThis.fetch;
        if (typeof this._fetch !== "function") {
            throw new LLMError("LLM_TRANSPORT", "AnthropicClient: global fetch is unavailable (Node >= 20 required)");
        }
        this._calls = 0;
    }

    get callCount() { return this._calls; }

    async propose(promptBundle) {
        if (!promptBundle || typeof promptBundle.system !== "string" || typeof promptBundle.user !== "string") {
            throw new LLMError("LLM_TRANSPORT", "AnthropicClient.propose: promptBundle must be {system:string, user:string}");
        }
        const body = {
            model: this.model,
            max_tokens: this.maxTokens,
            system: promptBundle.system,
            /* ★ 不用 assistant prefill ★
               messages 里恒有且只有一条 user。prefill（末尾放一条 assistant 续写）在本模型族被拒，
               实测会得到 400。约束输出格式靠 system 里的「只输出 JSON」+ parse 层校验。 */
            messages: [{ role: "user", content: promptBundle.user }],
        };

        let res;
        try {
            res = await this._fetch(LLM_ENDPOINT, {
                method: "POST",
                headers: {
                    "x-api-key": this.apiKey,
                    "anthropic-version": ANTHROPIC_VERSION,
                    "content-type": "application/json",
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch (e) {
            const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
            throw new LLMError(
                "LLM_TRANSPORT",
                timedOut
                    ? `AnthropicClient: request timed out after ${this.timeoutMs}ms`
                    : `AnthropicClient: network error: ${e && e.message ? e.message : String(e)}`,
                { timedOut, cause: e && e.name },
            );
        }

        const n = ++this._calls;
        let payload = null;
        let textBody = null;
        try {
            textBody = await res.text();
            payload = textBody ? JSON.parse(textBody) : null;
        } catch {
            payload = null;
        }

        if (!res.ok) {
            const msg = (payload && payload.error && payload.error.message) || (textBody || "").slice(0, 400) || res.statusText;
            throw new LLMError("LLM_TRANSPORT", `AnthropicClient: HTTP ${res.status}: ${msg}`, {
                status: res.status, type: payload && payload.error && payload.error.type, body: textBody,
            });
        }
        if (!payload || typeof payload !== "object") {
            throw new LLMError("LLM_TRANSPORT", "AnthropicClient: response body is not JSON", { status: res.status });
        }

        const text = (Array.isArray(payload.content) ? payload.content : [])
            .filter(b => b && b.type === "text" && typeof b.text === "string")
            .map(b => b.text)
            .join("");
        const usage = payload.usage
            ? { in: payload.usage.input_tokens ?? 0, out: payload.usage.output_tokens ?? 0 }
            : null;

        /* stop_reason==="max_tokens" 是真实的失败形态：JSON 被截断，parse 会报 LLM_NOT_JSON，
           而真正的原因在调用参数上。它留在 raw.stop_reason 里（不新增顶层字段）——
           返回形状严格是契约的 {text, usage, raw}，多一个字段就是多一处调用方要猜的东西。 */
        if (this.recordDir) this._record(n, promptBundle, text, usage, payload);

        return { text, usage, raw: payload };
    }

    /** 落盘一轮（`--record`）：`.txt` 给 ReplayLLMClient，`.meta.json` 给人看。 */
    _record(n, bundle, text, usage, payload) {
        try {
            fs.mkdirSync(this.recordDir, { recursive: true });
            fs.writeFileSync(path.join(this.recordDir, roundName(n, "txt")), text ?? "", "utf8");
            fs.writeFileSync(path.join(this.recordDir, roundName(n, "meta.json")), JSON.stringify({
                round: n, model: this.model, max_tokens: this.maxTokens,
                usage, stop_reason: payload && payload.stop_reason,
                prompt_chars: bundle.system.length + bundle.user.length,
                tokens_estimate: bundle.tokens_estimate ?? null,
                system: bundle.system, user: bundle.user,
            }, null, 1), "utf8");
        } catch (e) {
            /* 录制失败不得让一次成功的调用变成失败 —— 但必须可见。 */
            console.error(`[llm] record failed (${this.recordDir}): ${e.message}`);
        }
    }
}

/* ══════════════════════════ 3. 夹具回放 ══════════════════════════ */

/**
 * MockLLMClient —— 第 N 次 `propose` 读 `<dir>/<scenario>/round-NN.json`。
 *
 * 设计上刻意做得"很笨"：
 *   · 不解析、不校验、不修补（原样交 `text`）；
 *   · `usage` 恒 `null`；
 *   · 文件不存在 → `MockExhausted`（strict 模式下**永远**如此；非 strict 模式返回 `calls:[]`
 *     让 parse 报 `LLM_EMPTY_PLAN`，**仍然不可能是成功**）；
 *   · 不返回任何 `done` / `success` / `finished` 字段 —— 成功只能由 verify 判。
 */
export class MockLLMClient extends LLMClient {
    /**
     * @param {object} o
     * @param {string} o.dir       夹具根目录（`test/fixtures/llm`）
     * @param {string} [o.scenario] 场景子目录名；不给则直接用 dir
     * @param {boolean} [o.strict=true] 缺文件是否抛 MockExhausted
     */
    constructor({ dir, scenario = null, strict = true } = {}) {
        super();
        if (!dir || typeof dir !== "string") throw new TypeError("MockLLMClient: dir is required");
        this.dir = scenario ? path.join(dir, scenario) : dir;
        this.scenario = scenario;
        this.strict = strict !== false;
        this._calls = 0;
    }

    get callCount() { return this._calls; }

    /** 场景目录里一共有几轮（测试与 loop 的预检用；不消耗调用次数）。 */
    get roundCount() {
        try {
            return fs.readdirSync(this.dir).filter(f => /^round-\d{2,}\.json$/.test(f)).length;
        } catch { return 0; }
    }

    reset() { this._calls = 0; }

    async propose(_promptBundle) {
        const n = ++this._calls;
        const file = path.join(this.dir, roundName(n, "json"));
        let text;
        try {
            text = fs.readFileSync(file, "utf8");
        } catch (e) {
            if (e && e.code === "ENOENT") {
                if (this.strict) {
                    throw new MockExhausted(
                        `MockLLMClient: no fixture for call #${n} (expected ${file}) — `
                        + "the scenario has no more rounds; the loop must HALT with MOCK_EXHAUSTED, not succeed",
                        { dir: this.dir, call: n, file, available: this.roundCount },
                    );
                }
                /* 非 strict：交一个**空计划**出去。parse 会判 LLM_EMPTY_PLAN，
                   所以"耗尽"在任何路径上都不可能被读成成功。 */
                return { text: '{"calls":[]}', usage: null, raw: { calls: [] }, exhausted: true };
            }
            throw e;
        }
        let raw;
        try {
            raw = JSON.parse(text);
        } catch (e) {
            throw new LLMError(
                "LLM_NOT_JSON",
                `MockLLMClient: fixture ${file} is not valid JSON (${e.message}) — `
                + "fix the fixture; do not let the mock 'repair' it",
                { file, call: n },
            );
        }
        return { text, usage: null, raw, exhausted: false };
    }
}

/**
 * ReplayLLMClient —— 读一次录制目录回放。
 *
 * 目录形态（`AnthropicClient({recordDir})` 写的）：
 *   round-01.txt       模型原始输出（喂给 parseLlmPlan 的就是它）
 *   round-01.meta.json {usage, stop_reason, prompt_chars, system, user}（可选）
 *
 * 与 mock 的区别只在来源：replay 的文本来自**真实调用**，因此 `usage` 非 null；
 * 耗尽语义与 mock 完全相同（`MockExhausted`）。
 */
export class ReplayLLMClient extends LLMClient {
    constructor({ dir, strict = true } = {}) {
        super();
        if (!dir || typeof dir !== "string") throw new TypeError("ReplayLLMClient: dir is required");
        this.dir = dir;
        this.strict = strict !== false;
        this._calls = 0;
    }

    get callCount() { return this._calls; }

    get roundCount() {
        try {
            return fs.readdirSync(this.dir).filter(f => /^round-\d{2,}\.txt$/.test(f)).length;
        } catch { return 0; }
    }

    reset() { this._calls = 0; }

    async propose(_promptBundle) {
        const n = ++this._calls;
        const txtFile = path.join(this.dir, roundName(n, "txt"));
        let text;
        try {
            text = fs.readFileSync(txtFile, "utf8");
        } catch (e) {
            if (e && e.code === "ENOENT") {
                if (this.strict) {
                    throw new MockExhausted(
                        `ReplayLLMClient: no recorded response for call #${n} (expected ${txtFile})`,
                        { dir: this.dir, call: n, file: txtFile, available: this.roundCount },
                    );
                }
                return { text: '{"calls":[]}', usage: null, raw: { calls: [] }, exhausted: true };
            }
            throw e;
        }
        let meta = null;
        try {
            meta = JSON.parse(fs.readFileSync(path.join(this.dir, roundName(n, "meta.json")), "utf8"));
        } catch { meta = null; }
        const usage = meta && meta.usage ? { in: meta.usage.in ?? null, out: meta.usage.out ?? null } : null;
        let raw = null;
        try { raw = JSON.parse(text); } catch { raw = null; }
        return { text, usage, raw, exhausted: false };
    }
}

/* ══════════════════════════ 4. 工厂 ══════════════════════════ */

/**
 * @param {object} o
 * @param {"live"|"mock"|"replay"} o.mode
 * @returns {LLMClient}
 */
export function makeClient({ mode, ...opts } = {}) {
    switch (mode) {
        case "live": return new AnthropicClient(opts);
        case "mock": return new MockLLMClient(opts);
        case "replay": return new ReplayLLMClient(opts);
        default:
            throw new LLMError(
                "LLM_TRANSPORT",
                `makeClient: unknown mode "${mode}" (expected "live" | "mock" | "replay")`,
                { mode },
            );
    }
}

/* ══════════════════════════ 5. 解析 ══════════════════════════ */

const fail = (code, message, detail) => ({ ok: false, plan: null, error: { code, message, detail: detail || null } });

/**
 * 剥 markdown 围栏。模型即使被要求"只输出 JSON"，也时不时套一层 ```json。
 * 剥的是**第一段**围栏；围栏外还有内容不算错（真实模型会加"Here you go:"），
 * 但**不**去拼接多个围栏 —— 多个围栏 = 多个计划，那是必须拒绝的歧义，交给 JSON.parse 报错。
 */
export function stripFences(text) {
    const s = String(text ?? "").trim();
    const m = /```(?:json|JSON)?[ \t]*\r?\n?([\s\S]*?)```/.exec(s);
    if (m) return m[1].trim();
    return s;
}

/**
 * 解析 LLM 输出。
 *
 * @param {string} text 模型原始输出
 * @returns {{ok:true, plan:{say:string, calls:Array<{macro,args,why}>}, error:null}
 *         | {ok:false, plan:null, error:{code, message, detail}}}
 */
export function parseLlmPlan(text) {
    const raw = String(text ?? "");
    if (raw.length > LLM_OUT_CHARS_MAX) {
        return fail("LLM_TOO_LONG", `output is ${raw.length} chars > ${LLM_OUT_CHARS_MAX}`, { chars: raw.length });
    }
    const body = stripFences(raw);
    if (!body) return fail("LLM_NOT_JSON", "output is empty after fence-stripping");

    let obj;
    try {
        obj = JSON.parse(body);
    } catch (e) {
        return fail("LLM_NOT_JSON", `not valid JSON after fence-stripping: ${e.message}`, { snippet: body.slice(0, 200) });
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        return fail("LLM_SCHEMA", "top level must be a JSON object", { got: Array.isArray(obj) ? "array" : typeof obj });
    }

    const say = typeof obj.say === "string" ? obj.say : "";
    const coordRe = new RegExp(COORD_SRC);
    if (say.length > LLM_SAY_MAX) {
        return fail("LLM_NARRATION", `say is ${say.length} chars > ${LLM_SAY_MAX}`, { chars: say.length });
    }
    if (coordRe.test(say)) {
        return fail("LLM_NARRATION", "say contains a coordinate-like number pair (V4)", { say: say.slice(0, 200) });
    }

    if (!Array.isArray(obj.calls)) {
        return fail("LLM_SCHEMA", "top-level `calls` must be an array", { got: typeof obj.calls });
    }
    if (obj.calls.length === 0) {
        return fail("LLM_EMPTY_PLAN", "calls[] is empty — an empty plan is a failed plan, not a success", { calls: 0 });
    }
    if (obj.calls.length > LLM_CALLS_MAX) {
        return fail("LLM_TOO_MANY_CALLS", `${obj.calls.length} calls > ${LLM_CALLS_MAX}`, { calls: obj.calls.length });
    }

    const calls = [];
    for (let i = 0; i < obj.calls.length; i++) {
        const c = obj.calls[i];
        if (!c || typeof c !== "object" || Array.isArray(c)) {
            return fail("LLM_SCHEMA", `calls[${i}] is not an object`, { index: i });
        }
        const macro = c.macro;
        if (typeof macro !== "string" || !LLM_MACRO_WHITELIST.includes(macro)) {
            return fail(
                "LLM_UNKNOWN_MACRO",
                `calls[${i}].macro "${macro}" is not one of ${LLM_MACRO_WHITELIST.join(", ")}`,
                { index: i, macro, whitelist: LLM_MACRO_WHITELIST },
            );
        }
        if (!c.args || typeof c.args !== "object" || Array.isArray(c.args)) {
            return fail("LLM_ARGS", `calls[${i}] (${macro}) has no args object`, { index: i, macro });
        }
        const why = typeof c.why === "string" ? c.why : "";
        if (coordRe.test(why)) {
            return fail("LLM_NARRATION", `calls[${i}].why contains a coordinate-like number pair (V4)`, { index: i });
        }
        calls.push({ macro, args: c.args, why });
    }

    return { ok: true, plan: { say, calls }, error: null };
}
