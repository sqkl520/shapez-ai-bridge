#!/usr/bin/env node
/**
 * exp-feed-sources.mjs —— A/B：`MACHINE_STARVED` 的 `feed_sources`（推荐从哪接料）
 * 能不能把「真能落地」的比例提上去？
 *
 * ═════════════════════════ 要检验的假设 ═════════════════════════
 *
 * 2026-11-21 的验证链：
 *
 *   `MACHINE_STARVED` 能让模型 **9/10 选中端点**（hint 带句柄那次 A/B，p=0.0027）
 *   但 `tools/replay-plan.mjs` 实测「**真能落地只有 1/10**」。
 *
 * 被预演闸门拒掉的多数**不是路径挑得差，是源头选错** —— 挑了一台 66 格外、
 * 路线横穿 165 段主干道的矿机。同一份世界上到 `C3.color` 的真实成本表：
 *
 *   M13/M15(绿)  27~28 格 / 拆 1 条 / disc=0   ← 能落地
 *   M17(铜)      14 格 / 拆 1 条               ← 更近，但踩形状矿
 *   M14(蓝)      64 格 / 拆 3 条 / disc=3      ← 被闸门拒
 *
 * H1：把「最近的、输出口空闲、产物类型对得上、且不会切断下游的源头」
 *     直接印进诊断，模型选对源头的比例会上升，**落地率跟着上升**。
 *
 * ═════════════════════════ 两臂 ═════════════════════════
 *
 *   A（对照）  删掉 `evidence.feed_sources`，其余一字不改
 *   B（实验）  保留
 *
 * **判据必须跑到 `buildTxPlan` 为止**，不能只看到「选中端点」——
 * 上一轮就是栽在这里：实验报 9/10，真机 1/10 能落地。
 *
 * ═════════════════════════ 等价性 ═════════════════════════
 *
 * 照抄 `exp-chain-hint.mjs` 的三重控制：
 *   ① 同一份 obs / items / production；`diagnose()` 只调一次，两臂共用同一批对象
 *   ② 渲染后的 prompt 必须**逐行相同**，只允许 MACHINE_STARVED 那一行不同
 *   ③ 长度必须配平到**渲染后**的长度（用 U+3000 填充，插在内部）
 *
 * ═════════════════════════ 用法 ═════════════════════════
 *
 *   node tools/exp-feed-sources.mjs --n 10
 *   PROXY=1 node tools/exp-feed-sources.mjs --n 10     # 用本机 gateway
 *   node tools/exp-feed-sources.mjs --dry               # 只渲染不调用
 *
 * 只读：不连游戏、不发 tx/act/step/save，只读 `research/ai-plan/runs/` 的落盘快照。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const imp = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

const argv = process.argv.slice(2);
const argVal = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const N = Number(argVal("--n") || 10);
const DRY = argv.includes("--dry");
const outDir = path.resolve(REPO, argVal("--out") || "research/ai-plan/experiments/feed-sources");

const { buildPrompt } = await imp("src/agent/loop/prompt.mjs");
const { buildHandles } = await imp("src/agent/loop/handles.mjs");
const { diagnose, candidatesFor, buildTxPlan } = await imp("src/agent/loop.mjs");
const { AnthropicClient } = await imp("src/agent/loop/llm.mjs");

/* ══════════════════════════ 1. 固定输入 ══════════════════════════ */

const RUN = argVal("--run") || "r-20261121072433-521e";
const base = path.join(REPO, "research/ai-plan/runs", RUN);
const obs = JSON.parse(fs.readFileSync(path.join(base, "obs-last.json"), "utf8"));
const items = JSON.parse(fs.readFileSync(path.join(base, "items-last.json"), "utf8"));
const production = JSON.parse(fs.readFileSync(path.join(base, "production-last.json"), "utf8"));

const GOAL = (obs && obs.goal && obs.goal.requirement && obs.goal.requirement.shape) || "CbCbCbRb:CwCwCwCw";
const handles = buildHandles(obs, items);
/* `diagnose()` **只调一次** —— 两臂共用同一批诊断对象，只改那一条的 evidence */
const diagnoses = diagnose(obs, items, production, null, GOAL, handles, { recipe: null });

const starved = diagnoses.find(d => d.code === "MACHINE_STARVED");
if (!starved) {
    console.error("❌ 这份 obs 上没有 MACHINE_STARVED —— 两臂没有可比性，拒绝开跑。");
    console.error(`   实际诊断：${diagnoses.map(d => d.code).join(", ") || "(空)"}`);
    process.exit(2);
}
const feedSrc = (starved.evidence && starved.evidence.feed_sources) || [];
if (!feedSrc.length) {
    console.error("❌ feed_sources 是空的 —— 实验臂和对照组没有区别，拒绝开跑。");
    process.exit(2);
}
console.log(`输入: ${RUN}   goal=${GOAL}`);
console.log(`诊断: ${diagnoses.length} 条 — ${diagnoses.map((d, i) => `${i + 1}.${d.code}`).join(" ")}`);
console.log(`MACHINE_STARVED 在第 ${diagnoses.indexOf(starved) + 1} 位，subject=${starved.subject && starved.subject.handle}`);
console.log(`feed_sources: ${feedSrc.map(s => `${s.handle}(d=${s.d}, disc=${s.disconnect})`).join(", ")}`);

const budget = {
    rounds_left: 3, llm_calls_left: 8, tx_left: 6, ticks_left: 24000, wall_ms_left: 600000,
    in_chars_max: 24000, prompt_tokens_max: 5300,
};

/**
 * 渲染某一臂。**只动 `evidence.feed_sources`**，其余一切原样。
 * @param {"A"|"B"} arm
 */
function bundleFor(arm) {
    const ds = arm === "A"
        ? diagnoses.map(d => {
            if (d !== starved) return d;
            const { feed_sources, ...rest } = (d.evidence || {});
            return { ...d, evidence: rest };
        })
        : diagnoses;
    return buildPrompt({
        goal: GOAL, obs, handles, diagnoses: ds, candidates: candidatesFor(ds),
        lastRound: null, budget, production,
    });
}

/* ══════════════════════════ 2. 等价性自检 ══════════════════════════ */

/**
 * 两臂必须**逐行相同**，只有 MACHINE_STARVED 那一行允许不同；总字符数必须相等。
 *
 * 长度不等会让 `renderBelts` 的截断循环吐出不同的带子数 —— 那就变成
 * 「B 组多看见两条带子」，混杂得无法分辨。第一版 `exp-chain-hint.mjs` 栽过。
 */
function checkEquivalence(users) {
    const problems = [];
    const A = users.A.split("\n"), B = users.B.split("\n");
    if (A.length !== B.length) problems.push(`行数不同：A=${A.length} B=${B.length}`);
    if (users.A.length !== users.B.length) problems.push(`总字符数不同：A=${users.A.length} B=${users.B.length}`);
    const diffs = [];
    for (let i = 0; i < Math.max(A.length, B.length); i++) {
        if (A[i] === B[i]) continue;
        diffs.push(i);
        const bothStarved = typeof A[i] === "string" && A[i].includes("MACHINE_STARVED")
            && typeof B[i] === "string" && B[i].includes("MACHINE_STARVED");
        if (!bothStarved) problems.push(`第 ${i} 行在 MACHINE_STARVED 之外不同：\n  A: ${String(A[i]).slice(0, 90)}\n  B: ${String(B[i]).slice(0, 90)}`);
    }
    if (diffs.length !== 1) problems.push(`应当恰好 1 行不同，实际 ${diffs.length} 行：${diffs.slice(0, 8).join(",")}`);
    return { ok: problems.length === 0, problems, diffs };
}

const bundles = { A: bundleFor("A"), B: bundleFor("B") };
let equiv = checkEquivalence({ A: bundles.A.user, B: bundles.B.user });

/* 长度不齐就补 —— 填充必须插在**内部**（末尾空格会被 trim 掉），用 U+3000。
   注意：补的是**空行之外**的字符数，所以直接在两臂里较短的那一行末尾补。
   这里 A 短（没有 feed_sources），把填充塞进 A 的 MACHINE_STARVED 行里。 */
if (equiv.problems.some(p => p.includes("总字符数不同"))) {
    const diff = bundles.B.user.length - bundles.A.user.length;
    if (diff > 0) {
        /* 在 A 的 MACHINE_STARVED 行的 hint 之后插入 U+3000。
           渲染是「一条诊断一行」，所以插在行末即可（行末不会被 trim，因为
           整行是被 join 进来的，trim 只发生在单个 hint 上）。 */
        const lines = bundles.A.user.split("\n");
        const i = lines.findIndex(l => l.includes("MACHINE_STARVED"));
        if (i >= 0) {
            lines[i] = lines[i].slice(0, 240) + "　".repeat(diff) + lines[i].slice(240);
            bundles.A.user = lines.join("\n");
        }
        equiv = checkEquivalence({ A: bundles.A.user, B: bundles.B.user });
    }
}

console.log("\n──── 等价性自检 ────");
if (!equiv.ok) {
    console.log("  ❌ 不等价，拒绝开跑：");
    for (const p of equiv.problems) console.log("   · " + p);
    process.exit(3);
}
console.log(`  ✅ 两臂逐行相同，只有第 ${equiv.diffs[0]} 行（MACHINE_STARVED）不同`);
console.log(`  user 字符数 A=B=${bundles.A.user.length}  tokens≈${bundles.A.tokens_estimate}`);
console.log(`  带子条数 A=${(bundles.A.blocks.s3_belts.match(/^B\d+/gm) || []).length}`
    + ` B=${(bundles.B.blocks.s3_belts.match(/^B\d+/gm) || []).length}`);

if (DRY) {
    fs.mkdirSync(outDir, { recursive: true });
    for (const arm of ["A", "B"]) {
        fs.writeFileSync(path.join(outDir, `prompt-${arm}.txt`),
            bundles[arm].system + "\n\n########\n\n" + bundles[arm].user, "utf8");
    }
    console.log(`\n--dry：prompt 已写到 ${path.relative(REPO, outDir)}/prompt-{A,B}.txt`);
    process.exit(0);
}

/* ══════════════════════════ 3. 判定 ══════════════════════════ */

/** 诊断点名的那个缺料槽（`to` 应该指向它）。 */
const targetHandle = starved.subject && starved.subject.handle;
const targetUid = starved.subject && handles.byHandle.get(targetHandle)
    ? handles.byHandle.get(targetHandle).uid : null;
const missRole = (() => {
    const s0 = (starved.evidence && starved.evidence.starved || [])[0];
    if (!s0) return null;
    /* `missing_cells` 只有坐标；角色要从 feed_sources 的构造里推 —— 这里用
       「第一个缺料槽的 cell 落在哪个 role 上」反查。简化：painter 的 color 槽
       是历史上唯一被讨论的那个，直接用 evidence 里记录的 role（如果有）。 */
    return starved.evidence && starved.evidence.miss_role ? starved.evidence.miss_role : "color";
})();

const feedHandles = new Set(feedSrc.map(s => s.handle));

/**
 * 把一个计划跑到底，返回「选中了什么 / 能不能落地」。
 *
 * ⚠️ **必须跑 `buildTxPlan`** —— 这是本实验与上一轮最大的区别。
 * 上一轮的判据只到「计划的 `to` 是不是那个槽」，于是报出 9/10，
 * 而真机只有 1/10 能落地。
 */
function evaluate(plan) {
    const calls = Array.isArray(plan && plan.calls) ? plan.calls : [];
    const firstConnect = calls.find(c => c && c.macro === "connect");
    const to = firstConnect && firstConnect.args && firstConnect.args.to;
    const from = firstConnect && firstConnect.args && firstConnect.args.from;
    const refOf = (e) => (e && (e.$ref || e.ref)) || null;
    const picked = refOf(from);

    const hitSelect = !!to && refOf(to) === targetHandle;
    const pickedRecommended = !!picked && feedHandles.has(picked);

    /* 落地判定：真跑预演 */
    let hitLand = false, landWhy = null;
    try {
        const r = buildTxPlan({ calls }, obs, items, handles, { partial: true });
        hitLand = !!(r && r.ok === true);
        if (!hitLand) {
            const d = r && r.diagnosis;
            const sk = d && d.evidence && d.evidence.skipped;
            landWhy = sk && sk.length ? sk.map(x => `${x.macro}:${x.code || x.reason}`).join(",")
                : (d && d.observed ? String(d.observed).slice(0, 80) : (r && r.code) || "?");
        }
    } catch (e) {
        landWhy = `throw: ${e && e.message}`;
    }

    return {
        callCount: calls.length,
        macros: calls.map(c => c && c.macro),
        picked,
        hitSelect,
        pickedRecommended,
        hitLand,
        landWhy,
    };
}

function parsePlan(text) {
    if (!text) return { plan: null, parseErr: "empty response" };
    try {
        /* 模型常把 JSON 包在 ```json 里 —— 抓第一个 { 到最后一个 } */
        const m = String(text).match(/\{[\s\S]*\}/);
        return { plan: JSON.parse(m ? m[0] : text), parseErr: null };
    } catch (e) {
        return { plan: null, parseErr: e.message };
    }
}

/* ══════════════════════════ 4. 调用 LLM ══════════════════════════ */

const useProxy = argv.includes("--proxy") || process.env.PROXY === "1";
const client = new AnthropicClient(
    useProxy
        ? {
            apiKey: process.env.ANTHROPIC_AUTH_TOKEN || "PROXY_MANAGED",
            baseUrl: process.env.ANTHROPIC_BASE_URL || "http://127.0.0.1:15721/responses",
            model: process.env.AGENT_MODEL || "gpt-5.6-luna",
            maxTokens: 8000,
            timeoutMs: 180000,
        }
        : {
            apiKey: process.env.ANTHROPIC_API_KEY,
            baseUrl: process.env.ANTHROPIC_BASE_URL,
            model: process.env.AGENT_MODEL || "claude-sonnet-5",
            maxTokens: 8000,
            timeoutMs: 240000,
        },
);
console.log(`\nendpoint=${client.endpoint}  protocol=${client.protocol}  model=${client.model}  n=${N}/arm`);

fs.mkdirSync(outDir, { recursive: true });
const results = { A: [], B: [] };

/* 两臂**交替**跑，摊平网关漂移（这个网关 30 秒/次，波动大） */
for (let round = 1; round <= N; round++) {
    for (const arm of ["A", "B"]) {
        const t0 = Date.now();
        let text = null, err = null;
        try {
            const out = await client.propose(bundles[arm]);
            text = out && out.text;
        } catch (e) {
            err = e && e.message ? e.message : String(e);
        }
        const { plan, parseErr } = parsePlan(text);
        const ev = plan ? evaluate(plan) : null;
        const rec = { arm, round, ms: Date.now() - t0, err, parseErr, say: plan && plan.say || null, calls: plan && plan.calls || null, classify: ev, raw: text };
        results[arm].push(rec);
        fs.writeFileSync(path.join(outDir, `${arm}-${String(round).padStart(2, "0")}.json`), JSON.stringify(rec, null, 1));
        console.log(`[${arm} ${round}/${N}] ${ev ? `${ev.callCount} call(s) ${ev.macros.join("+")} from=${ev.picked || "-"} ${ev.hitSelect ? "选中根因" : ""} ${ev.hitLand ? "✅落地" : "❌" + (ev.landWhy || "")}` : `(失败: ${err || parseErr})`}  ${Date.now() - t0}ms`);
    }
}

/* ══════════════════════════ 5. 汇总 ══════════════════════════ */

function tally(list) {
    const ok = list.filter(r => r.classify);
    const n = ok.length;
    const c = k => ok.filter(r => r.classify[k]).length;
    return {
        n,
        select: c("hitSelect"),
        land: c("hitLand"),
        pickedRecommended: c("pickedRecommended"),
        /* 交叉表：选对端点 **且** 落地 */
        both: ok.filter(r => r.classify.hitSelect && r.classify.hitLand).length,
    };
}

const sum = { A: tally(results.A), B: tally(results.B) };
console.log("\n════════ 汇总 ════════");
for (const arm of ["A", "B"]) {
    const s = sum[arm];
    console.log(`${arm} 组（${arm === "A" ? "无 feed_sources" : "有 feed_sources"}）  n=${s.n}`);
    console.log(`   选中根因            ${s.select}/${s.n}`);
    console.log(`   ★ 真能落地（跑预演） ${s.land}/${s.n}`);
    console.log(`   选中根因 且 落地     ${s.both}/${s.n}`);
    console.log(`   from 落在推荐列表   ${s.pickedRecommended}/${s.n}`);
}

/* Fisher 单尾（先验：A 更差） */
function logFact(n) { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; }
function fisherOneTailed(aHit, aN, bHit, bN) {
    const K = aHit + bHit, n = aN + bN;
    if (!n || !aN || !bN) return 1;
    const pHyper = (k) => Math.exp(logFact(K) + logFact(n - K) + logFact(aN) + logFact(bN)
        - logFact(n) - logFact(k) - logFact(K - k) - logFact(aN - k) - logFact(bN - K + k));
    let p = 0;
    for (let k = 0; k <= Math.min(aHit, K); k++) p += pHyper(k);
    return p;
}
console.log("\n──── Fisher 单尾（A 更差） ────");
for (const key of ["select", "land", "both", "pickedRecommended"]) {
    const p = fisherOneTailed(sum.A[key], sum.A.n, sum.B[key], sum.B.n);
    console.log(`  ${key.padEnd(18)} A ${sum.A[key]}/${sum.A.n} vs B ${sum.B[key]}/${sum.B.n}   p=${p.toFixed(3)}`
        + (p < 0.05 ? " *" : p < 0.10 ? " (趋势)" : ""));
}

fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({
    at: new Date().toISOString(), run: RUN, goal: GOAL, n: N,
    feedSources: feedSrc, endpoint: client.endpoint, model: client.model,
    equivalence: equiv, userChars: { A: bundles.A.user.length, B: bundles.B.user.length }, sum,
}, null, 1), "utf8");
console.log(`\n结果目录: ${path.relative(REPO, outDir)}`);
