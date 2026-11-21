#!/usr/bin/env node
/**
 * exp-force-one.mjs —— A/B 实验：强制「一轮只做一个宏」会不会让模型更看重成因诊断。
 *
 * ═════════════════════════ 要检验的假设 ═════════════════════════
 *
 * 真机 `r-20261121072433-521e` 的观察：
 *
 *   诊断列表里 `MACHINE_STARVED`（**成因**：stacker 缺一路料，冻住整条链）
 *   排第 5，模型却选了 `MINER_UNWIRED`（症状，排第 6）和 `HUB_INLET_THIN`（排第 1）。
 *   一轮抛 3 个局部小修，没有一个触及真正的死锁点。
 *
 * 假设 H1：**只能做一个动作时，模型被迫权衡「哪个最值得做」**，
 *          因而更可能选中成因诊断。
 *
 * ═════════════════════════ 对照组设计 ═════════════════════════
 *
 * ⚠️ 这是本实验最要紧的部分。这个仓库的历史教训（`when-line-no-effect`）：
 *    「两次独立实验采用率都不动，缺的不是理由」—— 那是**变量没隔开**导致的。
 *
 * 所以：
 *   · **同一份 obs**（同一时刻的世界快照），两组用完全相同输入
 *   · **同一个模型、同一温度**（默认参数，不调）
 *   · **唯一变量** = `forceOneCall` 开关
 *   · 每组跑 N 次独立采样（LLM 有随机性，单次不可信）
 *
 * ═════════════════════════ 怎么判定 ═════════════════════════
 *
 * 主指标（客观，不靠人读）：
 *   **是否选中了成因诊断对应的动作** —— 即 `calls` 里出现
 *   `connect` 且 `why` 提到 stacker / painter / 缺料 / starved，
 *   或者调用了 `MACHINE_STARVED` 的候选宏。
 *
 * 副指标：
 *   · 每轮宏数量（验证开关真的生效）
 *   · 选中的诊断序号（模型在 `why` 里点名的「诊断 N」）
 *   · 计划是否被 preflight 拒掉（强制单动作的已知风险）
 *
 * ═════════════════════════ 用法 ═════════════════════════
 *
 *   node tools/exp-force-one.mjs --arm off --n 6
 *   node tools/exp-force-one.mjs --arm on  --n 6
 *
 * 结果写入 `research/ai-plan/experiments/force-one/`，每轮一个 json。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const argv = process.argv.slice(2);
const argVal = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

const arm = argVal("--arm") || "off";
const N = Number(argVal("--n") || 6);
const obsFile = argVal("--obs");
const outDir = path.resolve(REPO, argVal("--out") || "research/ai-plan/experiments/force-one");

if (!["on", "off"].includes(arm)) {
    console.error("--arm 必须是 on 或 off");
    process.exit(1);
}

/* Windows 上绝对路径必须转成 file:// URL，否则 ESM loader 报
   ERR_UNSUPPORTED_ESM_URL_SCHEME（`Received protocol 'd:'`）。 */
const imp = (rel) => import(new URL(`file://${path.join(REPO, rel).replace(/\\/g, "/")}`).href);

const { buildPrompt } = await imp("src/agent/loop/prompt.mjs");
const { buildHandles } = await imp("src/agent/loop/handles.mjs");
const { diagnose, candidatesFor } = await imp("src/agent/loop.mjs");
const { AnthropicClient } = await imp("src/agent/loop/llm.mjs");

/* ── 固定输入：同一份世界快照 ── */
const src = obsFile
    ? path.resolve(obsFile)
    : (() => {
        const runs = path.join(REPO, "research/ai-plan/runs");
        const d = fs.readdirSync(runs).filter(x => x.startsWith("r-")).sort().reverse()
            .find(x => fs.existsSync(path.join(runs, x, "obs-last.json")));
        if (!d) throw new Error("找不到任何含 obs-last.json 的 run");
        return path.join(runs, d, "obs-last.json");
    })();

const obs = JSON.parse(fs.readFileSync(src, "utf8"));
const itemsPath = path.join(path.dirname(src), "items-last.json");
const prodPath = path.join(path.dirname(src), "production-last.json");
const items = fs.existsSync(itemsPath) ? JSON.parse(fs.readFileSync(itemsPath, "utf8")) : null;
const production = fs.existsSync(prodPath) ? JSON.parse(fs.readFileSync(prodPath, "utf8")) : null;

const handles = buildHandles(obs, items);
const diagnoses = diagnose(obs, items, production, null, "CbCbCbRb:CwCwCwCw", handles, { recipe: null });
const candidates = candidatesFor(diagnoses);

console.log(`arm=${arm}  n=${N}`);
console.log(`输入: ${path.relative(REPO, src)}`);
console.log(`诊断: ${diagnoses.length} 条 — ${diagnoses.map((d, i) => `${i + 1}.${d.code}`).join(" ")}`);
console.log(`候选: ${candidates.join(",")}`);
console.log("");

const budget = {
    rounds_left: 3, llm_calls_left: 8, tx_left: 6, ticks_left: 24000, wall_ms_left: 600000,
    in_chars_max: 24000, prompt_tokens_max: 4600,
    ...(arm === "on" ? { forceOneCall: true } : {}),
};

const bundle = buildPrompt({
    goal: "CbCbCbRb:CwCwCwCw", obs, handles, diagnoses, candidates,
    lastRound: null, budget, production,
});

const client = new AnthropicClient({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    model: process.env.AGENT_MODEL || "virtual/opus",
    maxTokens: 16000,
    timeoutMs: 240000,
});

fs.mkdirSync(outDir, { recursive: true });

/* ── 判定：这一轮有没有选中「成因」诊断对应的动作 ──
 *
 * ⚠️ 第一版判定太松，结论虚高了一倍多，教训写在这里。
 *
 * 第一版用 `names-machine = /stacker|painter/` —— 而这台世界上**到处都是 painter**，
 * 模型随便提一句 painter 就算「选中成因」。结果报出 50% vs 88%。
 *
 * 收紧到必须**两条同时满足**：
 *   ① 提到 `stacker`（不是 painter —— painter 只是链条上的一环，不是死锁点）
 *   ② 提到「缺料」这件事（缺一路 / starved / only one / 1/2 / 只来一路）
 *
 * 重判后：基线 0/8、开关组 3/8。
 * **这个数字才可信。** 差异不显著（Fisher 单尾 p≈0.20），必须扩大样本。
 *
 * 判据的历史：这个仓库在 `when-line-no-effect` 里记过一次同类教训 ——
 * 「两次独立实验采用率都不动」，那是判定指标本身有问题。**先怀疑指标。**
 */
function classify(plan) {
    const calls = Array.isArray(plan && plan.calls) ? plan.calls : [];
    const whys = calls.map(c => String(c && c.why || "")).join(" ");
    const macros = calls.map(c => c && c.macro);

    /* ① 必须点名 stacker（死锁点），不能只是泛泛的 painter */
    const namesStacker = /stacker/i.test(whys);
    /* ② 必须说出「缺一路料」这件事，不能只是「修某条带子」 */
    const namesStarvation = /缺料|缺一路|只来一路|只有一路|一半|\bstarved\b|only one (of|input)|not fed|\bhalf\b|\b1\s*\/\s*2\b/i.test(whys);

    /* 严格：两条都要 */
    const causeSelected = namesStacker && namesStarvation;
    /* 宽松版只留作对照，不参与主判定 */
    const loose = namesStacker || /painter/i.test(whys);

    return {
        callCount: calls.length,
        macros,
        namesStacker,
        namesStarvation,
        causeSelected,
        loose,
    };
}

const results = [];
for (let i = 1; i <= N; i++) {
    const t0 = Date.now();
    let text = null, err = null;
    try {
        const out = await client.propose(bundle);
        text = out && out.text;
    } catch (e) {
        err = e && e.message ? e.message : String(e);
    }
    let plan = null, parseErr = null;
    if (text) {
        try {
            const m = String(text).match(/\{[\s\S]*\}/);
            plan = JSON.parse(m ? m[0] : text);
        } catch (e) { parseErr = e.message; }
    }
    const cls = plan ? classify(plan) : null;
    const rec = {
        arm, i, ms: Date.now() - t0, err, parseErr,
        say: plan && plan.say || null,
        calls: plan && plan.calls || null,
        classify: cls,
    };
    results.push(rec);
    const tag = cls ? `${cls.callCount} call(s) ${cls.macros.join("+")}` : `(失败: ${err || parseErr})`;
    const hit = cls && cls.causeSelected ? "  ← 选中成因 [stacker+缺料]" : "";
    console.log(`[${i}/${N}] ${tag}${hit}`);
    if (cls && cls.causeSelected) console.log(`      why: ${String(rec.calls[0] && rec.calls[0].why || "").slice(0, 140)}`);
    fs.writeFileSync(path.join(outDir, `${arm}-${String(i).padStart(2, "0")}.json`), JSON.stringify(rec, null, 1));
}

/* ── 汇总 ── */
const ok = results.filter(r => r.classify);
const cause = ok.filter(r => r.classify.causeSelected).length;
const looseN = ok.filter(r => r.classify.loose).length;
const avgCalls = ok.length ? (ok.reduce((s, r) => s + r.classify.callCount, 0) / ok.length) : 0;
console.log("");
console.log("════════ 汇总 ════════");
console.log(`有效样本: ${ok.length}/${N}`);
console.log(`每轮平均宏数: ${avgCalls.toFixed(2)}`);
console.log(`严格判定（stacker + 缺料）: ${cause}/${ok.length}` + (ok.length ? ` (${Math.round(cause / ok.length * 100)}%)` : ""));
console.log(`宽松判定（只提 stacker 或 painter，仅供对照）: ${looseN}/${ok.length}`);
console.log(`结果目录: ${path.relative(REPO, outDir)}`);
