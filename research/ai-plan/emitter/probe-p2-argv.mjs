/**
 * probe-p2-argv.mjs — 回归锁：`op-templates.mjs` 的自测守卫**必须**只在自己被直接运行时触发。
 *
 * 历史（缺陷已修，主线程 2026-10-24，提交见 git log）：
 *   原守卫 `if (argv.includes("--test")) runTests()` 缺"是不是被直接运行的那一个"判据。
 *   后果两条，都被本脚本的旧版本实测过：
 *     1. 任何静态 import op-templates 的包，argv 带 --test 就被夹带 ~175 行 P2 自测输出；
 *     2. runTests() 无条件写 `process.exitCode = failed?1:0` —— 调用方**判红之后**才装载
 *        （延迟 import / 静态边后求值）时，**红灯被洗成绿灯**（实测 exit 0）。
 *   P6 的 loadP2 规避被它自己的探针证明不可移植（静态边绕过守卫）。
 *   修法 = 仓库现成模式（lint-imports.mjs:98）：invokedDirectly 判据 + 把 exitCode 写回收进同一守卫。
 *
 * 本脚本现在的职责是**防止回归**：若有人把守卫改回去、或新模块复制了坏模式，这里有红灯。
 * 运行：node research/ai-plan/emitter/probe-p2-argv.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TMP = path.join(ROOT, "research", "ai-plan", "emitter", ".tmp-p2leak.mjs");
const rel = p => path.relative(ROOT, p).replace(/\\/g, "/");
const run = (file, args) => spawnSync(process.execPath, [rel(file), ...args], { cwd: ROOT, encoding: "utf8" });
const countChecks = out => (out.match(/^\s*✓/gm) || []).length;

let fails = 0, checks = 0;
const say = (cond, msg, extra) => { checks++; if (cond) console.log("✓ " + msg); else { fails++; console.log(`✗ ${msg}${extra ? "  " + extra : ""}`); } };

try {
/* ── 1. 静态 import + 调用方自带 --test → **零夹带**（旧世界是 ~175 行） ── */
fs.writeFileSync(TMP, [
    'import { codeFor } from "../../../src/ai/op-templates.mjs";',
    'console.log("MY-TEST-START");',
    'console.log("✓ codeFor=" + typeof codeFor);',
    'console.log("MY-TEST-END");',
].join("\n"));
const r1 = run(TMP, ["--test"]);
const out1 = (r1.stdout || "") + (r1.stderr || "");
say(countChecks(out1) === 1, `静态 import 不夹带 P2 自测（只应有调用方自己 1 行 ✓，实际 ${countChecks(out1)}）`, out1.split("\n").slice(0, 2).join(" / "));
say(out1.includes("MY-TEST-START") && out1.includes("MY-TEST-END"), "调用方自身输出完整（不是崩溃）");
say(r1.status === 0, "调用方退出码不被改写（0）", `exit=${r1.status}`);

/* ── 2. 红灯保住：调用方判红后延迟装载 P2 → 终态仍红（旧世界：被洗成 exit 0） ── */
fs.writeFileSync(TMP, [
    'process.exitCode = 1;                       // 调用方自己的测试已判红',
    'console.log("MY-RED");',
    'const m = await import("../../../src/ai/op-templates.mjs");   // 延迟装载（P8 懒加载形态）',
    'console.log("LOADED=" + Object.keys(m).length);',
].join("\n"));
const r2 = run(TMP, ["--test"]);
const out2 = (r2.stdout || "") + (r2.stderr || "");
say(r2.status === 1, `红灯不被 P2 洗绿（期望 exit=1，实际 ${r2.status}）——旧缺陷在此处 exit=0`);
// 补强：旧缺陷的另一种复活形态 = P2 自测变红时 exit 也"正确"，但 175 行输出已灌进调用方
say(countChecks(out2) === 0 && out2.includes("MY-RED") && out2.includes("LOADED="),
    `判红路径同样零夹带（caller 2 行完整、无 P2 ✓ 泄入），实得 ✓行=${countChecks(out2)}`, out2.split("\n").slice(0, 2).join(" / "));

/* ── 3. 静态边两种声明顺序都零夹带（loadP2 时代救不了的两个变体） ── */
for (const [label, lines] of [
    ["emit 在前、op-templates 在后", [
        'import { emitPlan } from "../../../src/ai/compiler/emit.mjs";',
        'import { codeFor } from "../../../src/ai/op-templates.mjs";',
        'console.log("MY-END " + typeof codeFor + " " + typeof emitPlan);',
    ]],
    ["op-templates 在前、emit 在后", [
        'import { codeFor } from "../../../src/ai/op-templates.mjs";',
        'import { emitPlan } from "../../../src/ai/compiler/emit.mjs";',
        'console.log("MY-END " + typeof codeFor + " " + typeof emitPlan);',
    ]],
]) {
    fs.writeFileSync(TMP, lines.join("\n"));
    const rv = run(TMP, ["--test"]);
    const leaked = countChecks((rv.stdout || "") + (rv.stderr || ""));
    say(leaked === 0, `静态边零夹带（${label}）：${leaked} 行 ✓`, `exit=${rv.status}`);
}

/* ── 4. 修复没有把自测本身修没：直接跑仍全绿、退出码 0 ── */
const direct = spawnSync(process.execPath, ["src/ai/op-templates.mjs", "--test"], { cwd: ROOT, encoding: "utf8" });
const dOut = (direct.stdout || "") + (direct.stderr || "");
say(direct.status === 0 && /op-templates 自测全部通过/.test(dOut), "P2 直接运行自测仍工作（不是靠禁用自测'修'的）", `exit=${direct.status}`);
const gaps = spawnSync(process.execPath, ["src/ai/op-templates.mjs", "--gaps"], { cwd: ROOT, encoding: "utf8" });
say(gaps.status === 0 && gaps.stdout.length > 0, "--gaps 直接运行仍输出 gap 报告");

/* ── 5. 顺带锁住同类守卫：belt-rules / types / grid / emit 的直接运行判据不能被 argv 劫持 ── */
for (const f of ["src/ai/belt-rules.mjs", "src/ai/compiler/grid.mjs", "src/ai/compiler/types.mjs"]) {
    fs.writeFileSync(TMP, [
        `import * as m from "../../../${f}";`,
        'console.log("OK " + Object.keys(m).length);',
    ].join("\n"));
    const rv = run(TMP, ["--test"]);
    const o = (rv.stdout || "") + (rv.stderr || "");
    say(countChecks(o) === 0 && rv.status === 0, `兄弟模块守卫干净：${f}`, `exit=${rv.status} ✓行=${countChecks(o)}`);
}
} finally {
    fs.rmSync(TMP, { force: true });
}

console.log(fails ? `\nprobe-p2-argv: ${checks - fails}/${checks} —— 有 ${fails} 条不像"已修"的样子：守卫可能被改回去了，查 src/ai/op-templates.mjs 的 invokedDirectly`
    : `\nprobe-p2-argv: 回归锁全绿（${checks}/${checks}）—— 守卫正确、红灯保真、自测未废`);
process.exitCode = fails ? 1 : 0;
