/**
 * P17 —— 宏卡片 `when:` 行对模型选择的 A/B。
 *
 * ## 唯一自变量
 *
 * `budget.include_when`。两臂**同一份 obs / 诊断 / 候选 / 预算**（16000/4600），
 * 唯一差别是每张卡多不多那行 `when:`（正向用途）。
 *
 * 以前做不到这个实验：`when:` 只能由 `prompt_tokens_max >= 4000` 隐式触发，
 * 于是「有 when:」和「预算更大（带子更多、CAPACITY 出现）」永远是同一个变量。
 * 本轮给 `resolveLimits` 加了显式 `include_when`，才能在同一预算下只翻这一行。
 *
 * ## 预注册的假设（写在这里，跑完照着判，不许事后改）
 *
 * H1（主）：有 `when:` 时 `remove_run` 的占比**上升**。
 *     理由：P15 观察到 7 张卡里 6 张只有 whenNotToUse，模型没有理由选它们；
 *     P14 §5 进一步认为模型在「不确定后果时偏好不删」。`when:` 给的是
 *     「这个宏存在的理由」，理论上该削弱这种规避。
 *     判据：两臂 `remove_run` 占比之差，Wilson 区间是否重叠。
 *
 * H0（零假设）：占比无差别 —— 即 `when:` 只是占预算的装饰。
 *
 * 次要指标（探索性，不作为结论）：
 *   · `replace_run` 占比（H1 的镜像：若模型改选 remove，replace 该降）
 *   · 选择熵（分布是否更均匀 —— `when:` 对所有宏一视同仁，理论上该拉平）
 *   · 拒绝/解析失败率
 *
 * 用法：
 *   node .tmpverify/when-ab/ab.mjs [N=24] [CONC=5]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPrompt } from "../../../../src/agent/loop/prompt.mjs";
import { buildHandles } from "../../../../src/agent/loop/handles.mjs";
import { diagnose } from "../../../../src/agent/loop.mjs";

const N = Number(process.argv[2] || 24);
const CONC = Math.max(1, Number(process.argv[3] || 5));
/* 输出默认写进本目录下的 `out/`（已被 .gitignore 排除），
   复现实验不会污染仓库，原始数据仍在本地可查。`AB_OUT` 可覆盖。
   ⚠️ 必须用 `fileURLToPath`（`new URL().pathname` 不解码 `%20`，
   而这个仓库路径里有空格 —— 实测踩过一次）。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.AB_OUT || path.join(HERE, "out", "results.json");
const GAP_MS = Number(process.env.AB_GAP_MS || 800);

fs.mkdirSync(path.dirname(OUT), { recursive: true });

/* ─────────────────────── 场景（两臂共享，同一对象） ─────────────────────── */
/* 夹具路径按本文件位置算，不依赖 cwd —— 从仓库根或从本目录调用都能跑。 */
const REPO = path.resolve(HERE, "../../../..");
const OBS = JSON.parse(fs.readFileSync(path.join(REPO, "test/fixtures/saves/L4-obs.json"), "utf8")).result;
const GOAL = "RuRu----";
const handles = buildHandles(OBS, null);
const diags = diagnose(OBS, null, OBS.production || null, null, GOAL, handles, {});
/* 全部 7 个宏都给：`when:` 的作用是让每张卡都说得出理由，
   只给子集会把它变成「检索是否取到某个宏」的实验，那是另一个自变量。 */
const CAND = ["connect", "replace_run", "remove_run", "insert_machine", "trash_unused", "extend_line", "remove_machine"];

const BASE_BUDGET = {
    rounds_left: 3, llm_calls_left: 8, tx_left: 6, ticks_left: 24000, wall_ms_left: 900000,
    in_chars_max: 16000, prompt_tokens_max: 4600,
};

const ARMS = {
    ON: buildPrompt({
        goal: GOAL, obs: OBS, handles, diagnoses: diags, candidates: CAND,
        lastRound: null, budget: { ...BASE_BUDGET, include_when: true },
    }),
    OFF: buildPrompt({
        goal: GOAL, obs: OBS, handles, diagnoses: diags, candidates: CAND,
        lastRound: null, budget: { ...BASE_BUDGET, include_when: false },
    }),
};

/* ─────────────────────── 自检（不通过就不许跑） ─────────────────────── */
const whenLines = s => (s.match(/^when: .*$/gm) || []);
const stripWhen = s => s.replace(/^when: .*\n/gm, "");

const SELF = [
    ["两臂 system 逐字节相同", ARMS.ON.system === ARMS.OFF.system],
    ["ON 有 7 行 when:", whenLines(ARMS.ON.user).length === 7],
    ["OFF 有 0 行 when:", whenLines(ARMS.OFF.user).length === 0],
    ["ON 去掉 when: 后与 OFF 逐字节相同", stripWhen(ARMS.ON.user) === ARMS.OFF.user],
    ["两臂 belts_shown 相同", ARMS.ON.blocks.belts_shown === ARMS.OFF.blocks.belts_shown],
    ["两臂 CAPACITY 是否出现相同", !!ARMS.ON.blocks.s3_capacity === !!ARMS.OFF.blocks.s3_capacity],
    ["两臂诊断条数相同", diags.length === 7],
    ["两臂 when_lines_shown 分别为 true/false", ARMS.ON.blocks.when_lines_shown === true && ARMS.OFF.blocks.when_lines_shown === false],
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
    console.log(`  ${name.padEnd(4)} chars=${String(chars).padStart(5)}`
        + ` when=${p.blocks.when_lines_shown}`
        + ` belts=${p.blocks.belts_shown}/${p.blocks.belts_total}`
        + ` cap=${!!p.blocks.s3_capacity}`
        + ` whenChars=${whenLines(p.user).join("").length}`);
}
console.log(`  差 = ${ARMS.ON.system.length + ARMS.ON.user.length - ARMS.OFF.system.length - ARMS.OFF.user.length} 字符（全是 when: 行）\n`);

/* ─────────────────────── LLM ─────────────────────── */
/* ⚠️ 密钥**绝不硬编码**：本仓是公开的。从环境变量取，缺了就明确报错停。
   用 `AB_BASE_URL` / `AB_MODEL` 可以指向任何兼容 Anthropic Messages 协议的端点。 */
const API = {
    baseUrl: process.env.AB_BASE_URL || "http://ddns2.keniis.top:3000",
    model: process.env.AB_MODEL || "virtual/opus",
    key: process.env.ANTHROPIC_API_KEY || "",
    maxTokens: 64000,
    timeoutMs: 600000,
};
if (!API.key) {
    console.error("✗ 缺少 ANTHROPIC_API_KEY 环境变量 —— 本装置不内置密钥（公开仓库）。");
    console.error("  用法：ANTHROPIC_API_KEY=sk-... node research/ai-plan/ab/when/ab.mjs [N] [CONC]");
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
    return {
        text: blocks.filter(b => b.type === "text").map(b => b.text).join(""),
        stop: j.stop_reason, usage: j.usage,
    };
}

/* ─────────────────────── 判据 ───────────────────────
 * 只判 `calls`，不判 `say` —— 与 ab-real / ab-correction 同一纪律。
 * 选择熵用 calls 里**每个 call 的宏名**统计（一次计划可能有多个 call）。 */
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
    if (!valid.length) return { ok: false, err: "no_valid_macro", macros };

    const why = calls.map(c => String((c && c.why) || "")).join(" ");

    return {
        ok: true,
        calls: calls.length,
        macros: valid,
        /* 计划里**出现过**这个宏（多 call 计划也计一次） */
        hasRemoveRun: valid.includes("remove_run"),
        hasReplaceRun: valid.includes("replace_run"),
        /* 主宏 = 第一个 call —— 用于「首选」口径 */
        primary: valid[0],
        targets: calls.map(c => `${c.macro}(${JSON.stringify(c.args || {}).slice(0, 50)})`),
        saysDestructive: /\b(delet|remov|tear|teardown|clear)\w*/i.test(why),
    };
}

/* ─────────────────────── 主循环（两臂交替，抵消时间漂移） ─────────────────────── */
const rec = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : [];
const done = new Set(rec.filter(r => r.parse_ok).map(r => `${r.arm}#${r.rep}`));
if (done.size) console.log(`续跑：已有 ${done.size} 条成功，跳过。\n`);

const save = () => fs.writeFileSync(OUT, JSON.stringify(rec, null, 1));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callOne(arm, rep) {
    const p = ARMS[arm];
    const row = {
        arm, rep, ts: new Date().toISOString(),
        chars: p.system.length + p.user.length,
        when_lines: whenLines(p.user).length,
        ms: null, usage: null, stop_reason: null, text: null, err: null, attempts: 0,
    };
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
            : `ok $( )`.replace("$( )", "") + `${row.macros.join(",")}`;
    console.log(`  ${arm.padEnd(3)} #${String(rep).padStart(2)} ${String(row.ms).padStart(7)}ms ${tag}`);
    return row;
}

const jobs = [];
for (let rep = 1; rep <= N; rep++) {
    for (const arm of ["ON", "OFF"]) if (!done.has(`${arm}#${rep}`)) jobs.push([arm, rep]);
}
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
function wilson(k, n) {
    if (!n) return [0, 0];
    const z = 1.96, p = k / n;
    const d = 1 + z * z / n;
    const c = p + z * z / (2 * n);
    const m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
    return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

function entropy(counts, total) {
    let h = 0;
    for (const v of Object.values(counts)) {
        if (!v) continue;
        const p = v / total;
        h -= p * Math.log2(p);
    }
    return h;
}

const okRows = rec.filter(r => r.parse_ok);
console.log("\n" + "═".repeat(78));
for (const arm of ["ON", "OFF"]) {
    const g = okRows.filter(r => r.arm === arm);
    if (!g.length) { console.log(`${arm}: 无数据`); continue; }
    const n = g.length;
    const k = c => g.filter(c).length;

    const kRem = k(r => r.hasRemoveRun), kRep = k(r => r.hasReplaceRun);
    const [lo1, hi1] = wilson(kRem, n);
    const primaryCounts = {};
    for (const r of g) primaryCounts[r.primary] = (primaryCounts[r.primary] || 0) + 1;
    const allMacros = {};
    let allN = 0;
    for (const r of g) for (const m of r.macros) { allMacros[m] = (allMacros[m] || 0) + 1; allN++; }

    console.log(`${arm.padEnd(3)} n=${String(n).padStart(2)}`
        + `  remove_run ${String(kRem).padStart(2)}/${n} [${lo1.toFixed(2)},${hi1.toFixed(2)}]`
        + `  replace_run ${String(kRep).padStart(2)}/${n}`
        + `  每次call ${(allN / n).toFixed(2)}`);
    console.log(`     首选分布: ${Object.entries(primaryCounts).sort((a, b) => b[1] - a[1]).map(([m, v]) => `${m}:${v}`).join(" ")}`);
    console.log(`     call 分布: ${Object.entries(allMacros).sort((a, b) => b[1] - a[1]).map(([m, v]) => `${m}:${v}`).join(" ")}`);
    console.log(`     选择熵(首选) ${entropy(primaryCounts, n).toFixed(3)} bits   (call) ${entropy(allMacros, allN).toFixed(3)} bits`);
}

const bad = rec.filter(r => !r.parse_ok);
console.log(`\n总 ${rec.length} 条（成功 ${okRows.length}，失败 ${bad.length}）→ ${OUT}`);
if (bad.length) {
    const byErr = {};
    for (const r of bad) byErr[r.err || r.parse_err || "?"] = (byErr[r.err || r.parse_err || "?"] || 0) + 1;
    console.log("失败原因:", JSON.stringify(byErr));
}
