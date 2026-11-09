/**
 * P18 —— 「后果可见」的 A/B：把宏算出的后果送进 prompt，会不会让模型更敢删。
 *
 * ## 与 P17 的区别（这是关键）
 *
 * P17 测的是「给宏卡片加**理由**」（`when:` 行）—— 证伪，七项宏选择全部不显著。
 * 本轮测的是完全不同的东西：给模型**上一轮的后果判定**。
 *
 * ```
 * OFF: ## LAST ROUND
 *      round 1: calls [remove_run]
 *      decision: continue
 *
 * ON:  ## LAST ROUND
 *      round 1: calls [remove_run]
 *      consequences of last round's calls:
 *        · remove_run: removal-is-clean — 这 3 格拆除不会让任何下游失去供料，…
 *      decision: continue
 * ```
 *
 * ## 预注册假设
 *
 * H1：ON 臂 `remove_run` 占比**上升**。
 *     机制：P17 的结论是「模型缺的是对后果的确定感」。ON 臂在上一轮
 *     就被告知「你那一刀是安全的」，于是本轮更可能再拆一次。
 *
 * H0：无差别。那么「后果可见」也不是缺的那块，`remove_run` 少的原因还得再找。
 *
 * ## 场景设计（必须让 remove_run 是**合理选择**）
 *
 * P17 用的 `RuRu----` 场景里诊断是 DEAD_END / CHAIN_UNFED —— trash_unused 和 connect
 * 更"保守"，remove_run 天然吃亏。这里改用**明确要求拆除**的场景：
 * 上一轮已经拆了、本轮世界仍有残线。否则测的就不是"敢不敢"，而是"该不该"。
 *
 * 用法：node .tmpverify/consequence-ab/ab.mjs [N=30] [CONC=5]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPrompt } from "../../../../src/agent/loop/prompt.mjs";
import { buildHandles } from "../../../../src/agent/loop/handles.mjs";
import { diagnose } from "../../../../src/agent/loop.mjs";

const N = Number(process.argv[2] || 30);
const CONC = Math.max(1, Number(process.argv[3] || 5));
/* 输出默认写进本目录下的 `out/`（已被 .gitignore 排除）；`AB_OUT` 可覆盖。
   ⚠️ 必须用 `fileURLToPath`（`new URL().pathname` 不解码 `%20`，本仓库路径有空格）。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.AB_OUT || path.join(HERE, "out", "results.json");
const GAP_MS = Number(process.env.AB_GAP_MS || 800);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

/* 夹具路径按本文件位置算，不依赖 cwd。 */
const REPO = path.resolve(HERE, "../../../..");
const OBS = JSON.parse(fs.readFileSync(path.join(REPO, "test/fixtures/saves/L4-obs.json"), "utf8")).result;
const GOAL = "RuRu----";
const handles = buildHandles(OBS, null);
const diags = diagnose(OBS, null, OBS.production || null, null, GOAL, handles, {});
const CAND = ["connect", "replace_run", "remove_run", "insert_machine", "trash_unused", "extend_line", "remove_machine"];

const BUDGET = {
    rounds_left: 2, llm_calls_left: 6, tx_left: 4, ticks_left: 16000, wall_ms_left: 600000,
    in_chars_max: 16000, prompt_tokens_max: 4600,
};

/* 上一轮**成功**拆了一段线。两臂唯一的差别是第二条有没有 consequences 段。 */
const baseLast = { round: 1, calls: ["remove_run"], decision: "continue" };

const CLEAN_WARNING = {
    macro: "remove_run",
    code: "removal-is-clean",
    detail: "这 3 格拆除不会让任何下游失去供料，也不会留下孤立输出："
        + "每个被删格的相邻方要么也在删除集里，要么该方向本来就是空的。",
};

const ARMS = {
    ON: buildPrompt({
        goal: GOAL, obs: OBS, handles, diagnoses: diags, candidates: CAND,
        lastRound: { ...baseLast, macro_warnings: [CLEAN_WARNING] }, budget: BUDGET,
    }),
    OFF: buildPrompt({
        goal: GOAL, obs: OBS, handles, diagnoses: diags, candidates: CAND,
        lastRound: { ...baseLast }, budget: BUDGET,
    }),
};

/* ─────────────────────── 自检 ─────────────────────── */
const SELF = [
    ["两臂 system 逐字节相同", ARMS.ON.system === ARMS.OFF.system],
    ["ON 有 consequences 段", /consequences of last round's calls:/.test(ARMS.ON.blocks.S5)],
    ["OFF 没有 consequences 段", !/consequences of last round's calls:/.test(ARMS.OFF.blocks.S5)],
    ["ON 的 S5 去掉 consequences 段后与 OFF 相同",
        ARMS.ON.blocks.S5.replace(/consequences of last round's calls:\n(?:  · .*\n)+/, "") === ARMS.OFF.blocks.S5],
    ["两臂 belts_shown 相同", ARMS.ON.blocks.belts_shown === ARMS.OFF.blocks.belts_shown],
    ["两臂 CAPACITY 出现与否相同", !!ARMS.ON.blocks.s3_capacity === !!ARMS.OFF.blocks.s3_capacity],
    ["两臂诊断条数相同", diags.length === 7],
];

console.log("自检：");
let selfFail = 0;
for (const [name, ok] of SELF) {
    console.log(`  ${ok ? "OK  " : "FAIL"} ${name}`);
    if (!ok) selfFail++;
}
if (selfFail) { console.error(`\n✗ 自检 ${selfFail} 项失败，停。`); process.exit(2); }

console.log("\n臂摘要：");
for (const [name, p] of Object.entries(ARMS)) {
    const chars = p.system.length + p.user.length;
    const cons = /consequences of last round's calls:/.test(p.blocks.S5);
    console.log(`  ${name.padEnd(4)} chars=${String(chars).padStart(5)} consequences=${cons}`
        + ` belts=${p.blocks.belts_shown}/${p.blocks.belts_total} cap=${!!p.blocks.s3_capacity}`);
}
console.log(`  差 = ${ARMS.ON.system.length + ARMS.ON.user.length - ARMS.OFF.system.length - ARMS.OFF.user.length} 字符\n`);

/* ─────────────────────── LLM ─────────────────────── */
/* ⚠️ 密钥**绝不硬编码**：本仓是公开的。从环境变量取，缺了就明确报错停。 */
const API = {
    baseUrl: process.env.AB_BASE_URL || "http://ddns2.keniis.top:3000",
    model: process.env.AB_MODEL || "virtual/opus",
    key: process.env.ANTHROPIC_API_KEY || "",
    maxTokens: 64000,
    timeoutMs: 600000,
};
if (!API.key) {
    console.error("✗ 缺少 ANTHROPIC_API_KEY 环境变量 —— 本装置不内置密钥（公开仓库）。");
    console.error("  用法：ANTHROPIC_API_KEY=sk-... node research/ai-plan/ab/consequence/ab.mjs [N] [CONC]");
    process.exit(2);
}

async function proposeRaw(system, user) {
    const res = await fetch(`${API.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": API.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: API.model, max_tokens: API.maxTokens, system, messages: [{ role: "user", content: user }] }),
        signal: AbortSignal.timeout(API.timeoutMs),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(j).slice(0, 240)}`);
    const blocks = Array.isArray(j.content) ? j.content : [];
    return { text: blocks.filter(b => b.type === "text").map(b => b.text).join(""), stop: j.stop_reason, usage: j.usage };
}

function judge(text) {
    if (typeof text !== "string" || !text.trim()) return { ok: false, err: "empty" };
    let j;
    try {
        j = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim());
    } catch { return { ok: false, err: "not_json" }; }
    const calls = Array.isArray(j.calls) ? j.calls : null;
    if (!calls || !calls.length) return { ok: false, err: "no_calls" };
    const macros = calls.map(c => String((c && c.macro) || "?"));
    const valid = macros.filter(m => CAND.includes(m));
    if (!valid.length) return { ok: false, err: "no_valid_macro" };
    const why = calls.map(c => String((c && c.why) || "")).join(" ");
    return {
        ok: true,
        calls: calls.length,
        macros: valid,
        hasRemoveRun: valid.includes("remove_run"),
        hasTrash: valid.includes("trash_unused"),
        hasReplace: valid.includes("replace_run"),
        primary: valid[0],
        /* 是否引用上一轮那个结论 —— ON 臂的直接证据 */
        citesConsequence: /removal-is-clean|不会让任何下游|安全地?拆|clean(ly)? remov|no downstream/i.test(why),
        targets: calls.map(c => `${c.macro}(${JSON.stringify(c.args || {}).slice(0, 50)})`),
    };
}

const rec = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : [];
const done = new Set(rec.filter(r => r.parse_ok).map(r => `${r.arm}#${r.rep}`));
if (done.size) console.log(`续跑：已有 ${done.size} 条成功，跳过。\n`);
const save = () => fs.writeFileSync(OUT, JSON.stringify(rec, null, 1));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callOne(arm, rep) {
    const p = ARMS[arm];
    const row = { arm, rep, ts: new Date().toISOString(), chars: p.system.length + p.user.length, ms: null, usage: null, stop_reason: null, text: null, err: null, attempts: 0 };
    for (let a = 1; a <= 3; a++) {
        row.attempts = a;
        const t0 = Date.now();
        try {
            const r = await proposeRaw(p.system, p.user);
            row.ms = Date.now() - t0;
            row.usage = r.usage ? { in: r.usage.input_tokens ?? 0, out: r.usage.output_tokens ?? 0 } : null;
            row.stop_reason = r.stop;
            row.text = r.text;
            const v = judge(r.text);
            Object.assign(row, { parse_ok: v.ok, parse_err: v.ok ? null : v.err, ...v });
            row.err = null;
            if (!v.ok && (v.err === "empty" || v.err === "not_json") && a < 3) { await sleep(1500); continue; }
            break;
        } catch (e) {
            row.ms = Date.now() - t0;
            row.err = `${(e && e.code) || ""}: ${(e && e.message) || e}`.slice(0, 300);
            row.parse_ok = false;
            if (a < 3) await sleep(2000 * a);
        }
    }
    rec.push(row);
    save();
    const tag = row.err ? `ERR ${row.err.slice(0, 40)}`
        : !row.parse_ok ? `BAD ${row.parse_err}`
            : `${row.macros.join(",")}${row.citesConsequence ? "  [引用后果]" : ""}`;
    console.log(`  ${arm.padEnd(3)} #${String(rep).padStart(2)} ${String(row.ms).padStart(7)}ms ${tag}`);
    return row;
}

const jobs = [];
for (let rep = 1; rep <= N; rep++) for (const arm of ["ON", "OFF"]) if (!done.has(`${arm}#${rep}`)) jobs.push([arm, rep]);
console.log(`待跑 ${jobs.length} 次（2 臂 × ${N}，交替顺序）\n`);

let idx = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
    while (idx < jobs.length) {
        const [arm, rep] = jobs[idx++];
        await callOne(arm, rep);
        if (GAP_MS) await sleep(GAP_MS);
    }
}));

/* ─────────────────────── 汇总 ─────────────────────── */
function fisher2x2(a, b, c, d) {
    const LF = (() => { const t = [0]; for (let i = 1; i <= 4000; i++) t[i] = t[i - 1] + Math.log(i); return t; })();
    const n = a + b + c + d, r1 = a + b, c1 = a + c;
    const hp = i => Math.exp(LF[r1] + LF[n - r1] + LF[c1] + LF[n - c1] - LF[n] - LF[i] - LF[r1 - i] - LF[c1 - i] - LF[n - r1 - c1 + i]);
    const pObs = hp(a);
    let p = 0;
    for (let i = Math.max(0, r1 + c1 - n); i <= Math.min(r1, c1); i++) { const pi = hp(i); if (pi <= pObs * (1 + 1e-9)) p += pi; }
    return Math.min(1, p);
}
function wilson(k, n) {
    if (!n) return [0, 0];
    const z = 1.96, p = k / n, den = 1 + z * z / n, c = p + z * z / (2 * n);
    const m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return [Math.max(0, (c - m) / den), Math.min(1, (c + m) / den)];
}

const okRows = rec.filter(r => r.parse_ok);
console.log("\n" + "═".repeat(78));
for (const arm of ["ON", "OFF"]) {
    const g = okRows.filter(r => r.arm === arm);
    if (!g.length) { console.log(`${arm}: 无数据`); continue; }
    const n = g.length, k = c => g.filter(c).length;
    const kr = k(r => r.hasRemoveRun);
    console.log(`${arm.padEnd(3)} n=${String(n).padStart(2)}`
        + `  remove_run ${String(kr).padStart(2)}/${n} [${wilson(kr, n).map(v => v.toFixed(2)).join(",")}]`
        + `  trash ${k(r => r.hasTrash)}/${n}`
        + `  replace ${k(r => r.hasReplace)}/${n}`
        + `  引用后果 ${k(r => r.citesConsequence)}/${n}`);
    const pc = {};
    for (const r of g) pc[r.primary] = (pc[r.primary] || 0) + 1;
    console.log(`    首选: ${Object.entries(pc).sort((a, b) => b[1] - a[1]).map(([m, v]) => `${m}:${v}`).join(" ")}`);
}
{
    const A = okRows.filter(r => r.arm === "ON"), B = okRows.filter(r => r.arm === "OFF");
    const ka = A.filter(r => r.hasRemoveRun).length, kb = B.filter(r => r.hasRemoveRun).length;
    console.log(`\n主指标 H1（remove_run）: ON ${ka}/${A.length} vs OFF ${kb}/${B.length}`
        + `  Fisher p = ${fisher2x2(ka, A.length - ka, kb, B.length - kb).toFixed(4)}`);
    const ca = A.filter(r => r.citesConsequence).length;
    console.log(`ON 臂引用后果: ${ca}/${A.length} [${wilson(ca, A.length).map(v => v.toFixed(2)).join(",")}]`);
}
const bad = rec.filter(r => !r.parse_ok);
console.log(`\n总 ${rec.length} 条（成功 ${okRows.length}，失败 ${bad.length}）→ ${OUT}`);
if (bad.length) {
    const e = {};
    for (const r of bad) e[r.err || r.parse_err || "?"] = (e[r.err || r.parse_err || "?"] || 0) + 1;
    console.log("失败原因:", JSON.stringify(e));
}
