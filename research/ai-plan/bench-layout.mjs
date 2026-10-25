#!/usr/bin/env node
/**
 * 布局基线夹具（研究 04 的 P0）。
 *
 * 为什么需要它：在此之前，"这个形状编得好不好"只能靠肉眼看 bbox 和
 * 实体数 —— 于是任何算法改动都无法证明有效，也无法证明没退步。
 * 这份脚本把"形状病"变成可回归的数字：每条 goal 的 ok/reason、
 * bbox 宽高、带子数、机器数、转角数。
 *
 * 用法：
 *   node research/ai-plan/bench-layout.mjs            # 跑全部
 *   node research/ai-plan/bench-layout.mjs --json     # 机读输出
 *   node research/ai-plan/bench-layout.mjs CuCuCuCu   # 只跑一个
 *
 * 重要：必须在**同一次运行**里采样。历史上 intent.json 是某一版编译器
 * 的快照，和当前 HEAD 混用会得出错误结论。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const CLI = path.join(REPO, "src", "ai", "compiler", "cli.mjs");

/** 基线集合：覆盖「常规 / 长主干 / 已知失败 / 多矿种」四类。 */
const GOALS = [
    "CuCuCuCu",
    "RuRuRuRu",
    "RuRu----",
    "----CuCu",
    "Cu----Cu",
    "Cu------",
    "Ru----Ru",
    "--SuSu--",
    "CgScScCg",
    "CpCpCpCp",
    "RbRb----",
];

const SEEDS = [43391];

function runOne(goal, seed, hub) {
    const args = ["--goal", goal, "--seed", String(seed), "--json"];
    if (hub) args.push("--hub", hub);
    let raw;
    try {
        raw = execFileSync(process.execPath, [CLI, ...args], {
            cwd: REPO,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
    } catch (e) {
        // cli 在失败时可能走非零退出，但 stdout 仍有 JSON
        raw = (e.stdout || "") + "\n" + (e.stderr || "");
    }
    // 从输出里捞出第一个 JSON 对象（cli 可能打印人类可读的头几行）
    const start = raw.indexOf("{");
    if (start < 0) return { ok: false, reason: "no-json", raw: raw.slice(0, 300) };
    let depth = 0, end = -1;
    for (let i = start; i < raw.length; i++) {
        if (raw[i] === "{") depth++;
        else if (raw[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end < 0) return { ok: false, reason: "truncated-json", raw: raw.slice(0, 300) };
    try {
        return JSON.parse(raw.slice(start, end));
    } catch (e) {
        return { ok: false, reason: "bad-json: " + e.message, raw: raw.slice(start, start + 300) };
    }
}

function summarize(r) {
    const s = r.stats || {};
    // stats.bbox 是 [宽, 高]（不是坐标四点）。历史上有人把它当 bbox 四点读，
    // 会让所有宽度看起来都是负数 —— 这里显式按 [w,h] 解析。
    const bbox = Array.isArray(s.bbox) ? s.bbox : null;
    const machines = s.machines || {};
    const machineCount = Object.values(machines).reduce((a, b) => a + (b || 0), 0);
    return {
        ok: r.ok === true,
        reason: r.ok === true ? null : (r.reason || r.class || "unknown"),
        w: bbox ? bbox[0] : null,
        h: bbox ? bbox[1] : null,
        belts: s.beltTiles ?? null,
        machines: machineCount || null,
        corners: s.corners ?? null,
        throughput: s.estThroughputPerSec ?? null,
        bottleneck: s.bottleneck ?? null,
    };
}

const only = process.argv.slice(2).filter(a => !a.startsWith("--"));
const asJson = process.argv.includes("--json");
const targets = only.length ? only : GOALS;

const rows = [];
for (const goal of targets) {
    for (const seed of SEEDS) {
        const r = runOne(goal, seed, "0,0");
        rows.push({ goal, seed, ...summarize(r) });
    }
}

if (asJson) {
    console.log(JSON.stringify({ rows }, null, 2));
} else {
    const pad = (s, n) => String(s ?? "-").padEnd(n);
    console.log(`${pad("goal", 11)} ${pad("seed", 6)} ${pad("ok", 6)} ${pad("w", 5)} ${pad("h", 5)} ${pad("belts", 6)} ${pad("corners", 8)} reason`);
    console.log("-".repeat(92));
    for (const r of rows) {
        if (!r.ok) {
            console.log(`${pad(r.goal, 11)} ${pad(r.seed, 6)} ${pad("FAIL", 6)} ${pad("-", 5)} ${pad("-", 5)} ${pad("-", 6)} ${pad("-", 8)} ${r.reason}`);
        } else {
            console.log(`${pad(r.goal, 11)} ${pad(r.seed, 6)} ${pad("ok", 6)} ${pad(r.w, 5)} ${pad(r.h, 5)} ${pad(r.belts, 6)} ${pad(r.corners, 8)}`);
        }
    }
    // 每个 goal 的通过率 —— 这是 P4 要盯的那个数
    console.log("\n通过率: goal -> ok/total");
    const byGoal = {};
    for (const r of rows) {
        byGoal[r.goal] = byGoal[r.goal] || { ok: 0, n: 0 };
        byGoal[r.goal].n++;
        if (r.ok) byGoal[r.goal].ok++;
    }
    for (const g of Object.keys(byGoal)) {
        const { ok, n } = byGoal[g];
        console.log(`  ${g.padEnd(11)} ${ok}/${n}${ok < n ? "   <-- 有失败" : ""}`);
    }
}
