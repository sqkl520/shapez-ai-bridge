#!/usr/bin/env node
/**
 * tools/probe-live-prompt.mjs —— 用**真机那一轮的完整参数**重建 prompt。
 *
 * 为什么需要它：`exp-chain-hint.mjs` 只传了 `{goal, obs, handles, diagnoses,
 * candidates, lastRound, budget, production}`，而 `loop.mjs:4063` 实际还传了
 * `itemsOnBelts / priority domain / priorAttempts / runLog / stickyGoal /
 * recipe / lastNetEffect / obsoleteLines / lastNetEffect`。
 *
 * 少了这些段，实验 prompt 与真机 prompt **不是同一份文档**，
 * 于是「实验 9/10、真机 0/1」到底是不是结构问题，根本无法判断。
 *
 * 用法：
 *   node tools/probe-live-prompt.mjs --run r-20261121100232-d10f
 *   node tools/probe-live-prompt.mjs --run ... --out .tmp-shape/x.txt --dump
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const imp = (rel) => import(pathToFileURL(path.join(REPO, rel)).href);

const argv = process.argv.slice(2);
const argVal = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

const runId = argVal("--run");
if (!runId) { console.error("需要 --run r-xxxx"); process.exit(2); }
const dir = path.join(REPO, "research/ai-plan/runs", runId);
if (!fs.existsSync(dir)) { console.error("没有这个 run: " + dir); process.exit(2); }

const { buildPrompt } = await imp("src/agent/loop/prompt.mjs");
const { buildHandles } = await imp("src/agent/loop/handles.mjs");
const { diagnose, candidatesFor, readTranscript } = await imp("src/agent/loop.mjs");

const obs = JSON.parse(fs.readFileSync(path.join(dir, "obs-last.json"), "utf8"));
const items = JSON.parse(fs.readFileSync(path.join(dir, "items-last.json"), "utf8"));
const production = JSON.parse(fs.readFileSync(path.join(dir, "production-last.json"), "utf8"));

const records = readTranscript(path.join(dir, "transcript.jsonl"));
const start = records.find(r => r.kind === "run_start");
const GOAL = (start && start.data && start.data.goal) || obs.goal.requirement.shape;
const bud = (start && start.data && start.data.budget) || {};

const handles = buildHandles(obs, items);
const ctx = { recipe: null };
const diagnoses = diagnose(obs, items, production, null, GOAL, handles, ctx);

function itemsOnBeltsOf(it) {
    const paths = it && Array.isArray(it.paths) ? it.paths : [];
    let n = 0;
    for (const p of paths) n += Number(p && p.itemsOnPath) || 0;
    return n;
}

const exactlyLikeLoop = buildPrompt({
    goal: GOAL, obs, handles, diagnoses, candidates: candidatesFor(diagnoses),
    production, itemsOnBelts: itemsOnBeltsOf(items),
    lastRound: null, lastNetEffect: null, priorAttempts: null,
    goalChanged: null, obsoleteLines: null, runLog: null, stickyGoal: null,
    recipe: null,
    budget: {
        rounds_left: 2, llm_calls_left: 8, tx_left: 6, ticks_left: 24000, wall_ms_left: 900000,
        in_chars_max: 24000, prompt_tokens_max: 4600, forceOneCall: false,
    },
});

/* 实验那条路径（只传 8 个参数）—— 用来量化「少传参数」到底差多少 */
const likeExperiment = buildPrompt({
    goal: GOAL, obs, handles, diagnoses, candidates: candidatesFor(diagnoses),
    lastRound: null, budget: {
        rounds_left: 3, llm_calls_left: 8, tx_left: 6, ticks_left: 24000, wall_ms_left: 600000,
        in_chars_max: 24000, prompt_tokens_max: 4600,
    }, production,
});

function sectionMap(user) {
    const lines = user.split("\n");
    let pos = 0; const out = [];
    for (const l of lines) {
        if (/^## /.test(l)) out.push({ at: pos, pct: 100 * pos / user.length, head: l });
        pos += l.length + 1;
    }
    return out;
}

function report(name, b) {
    const user = b.user;
    console.log(`\n════════ ${name} ════════`);
    console.log(`system ${b.system.length} + user ${user.length} = ${b.system.length + user.length}  tokens≈${b.tokens_estimate}`);
    let prev = null;
    for (const s of sectionMap(user)) {
        const size = prev === null ? s.at : s.at - prev.at;
        console.log(`${String(s.at).padStart(6)} ${s.pct.toFixed(1).padStart(5)}%  ${String(size).padStart(5)} chars  ${s.head}`);
        prev = s.at;
    }
    const last = sectionMap(user).slice(-1)[0];
    if (last) console.log(`${String(user.length).padStart(6)} 100.0%  ${String(user.length - last.at).padStart(5)} chars  (尾)`);
    return user;
}

const u1 = report("真机同参数重建", exactlyLikeLoop);
const u2 = report("实验同参数重建", likeExperiment);

console.log("\n════════ 差异 ════════");
console.log(`user 长度差 ${u1.length - u2.length} 字符`);
const d1 = sectionMap(u1), d2 = sectionMap(u2);
const h1 = d1.map(x => x.head), h2 = d2.map(x => x.head);
const onlyLive = h1.filter(h => !h2.includes(h));
const onlyExp = h2.filter(h => !h1.includes(h));
if (onlyLive.length) console.log("只在真机路径出现的段：\n  " + onlyLive.join("\n  "));
if (onlyExp.length) console.log("只在实验路径出现的段：\n  " + onlyExp.join("\n  "));

const dz1 = d1.find(x => x.head.startsWith("## DIAGNOSIS"));
const dz2 = d2.find(x => x.head.startsWith("## DIAGNOSIS"));
console.log(`DIAGNOSIS 位置：真机 ${dz1 ? dz1.at : "?"} (${dz1 ? dz1.pct.toFixed(1) : "?"}%)  实验 ${dz2 ? dz2.at : "?"} (${dz2 ? dz2.pct.toFixed(1) : "?"}%)`);

const outPath = argVal("--out");
if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(REPO, outPath)), { recursive: true });
    fs.writeFileSync(path.resolve(REPO, outPath), exactlyLikeLoop.system + "\n\n########\n\n" + exactlyLikeLoop.user, "utf8");
    console.log(`\n已写出 ${outPath}`);
}
if (argv.includes("--dump")) {
    console.log("\n════════ 真机重建全文 ════════\n" + exactlyLikeLoop.user);
}
