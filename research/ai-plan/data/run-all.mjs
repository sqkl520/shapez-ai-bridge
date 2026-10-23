/**
 * run-all.mjs — P2 data 包的 L0 验收一条命令跑完
 *
 *   node research/ai-plan/data/run-all.mjs
 *
 * 依次跑：两份自测（表自身一致）+ 两份包验收（对着原始凭据重核）+ world --validate 对拍 + lint。
 * 任一非 0 退出码 → 本脚本非 0。全程离线（零游戏、零网络，plan §4）。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const run = (label, args) => {
    const r = spawnSync(process.execPath, args, { cwd: REPO, encoding: "utf8" });
    const out = (r.stdout || "") + (r.stderr || "");
    const fails = [...out.matchAll(/^✗[^\n]*/gm)].map(m => m[0]);
    const passes = (out.match(/^\s*✓/gm) || []).length;
    const bad = r.status !== 0;
    console.log(`${bad ? "❌" : "✅"} ${label}  (exit ${r.status}, ✓${passes}${fails.length ? ", ✗" + fails.length : ""})`);
    if (fails.length) for (const f of fails.slice(0, 6)) console.log("     " + f);
    if (bad && out.length < 4000) console.log(out.split("\n").slice(-12).join("\n"));
    return { bad, out, passes, fails };
};

const results = [];

// 1) 两份自测
results.push(run("src/ai/op-templates.mjs --test", ["src/ai/op-templates.mjs", "--test"]));
results.push(run("src/ai/world.mjs --test", ["src/ai/world.mjs", "--test"]));
// 2) 两份包验收（对着原始凭据文件重核）
results.push(run("data/op-templates.test.mjs --test", ["research/ai-plan/data/op-templates.test.mjs", "--test"]));
results.push(run("data/world.test.mjs --test", ["research/ai-plan/data/world.test.mjs", "--test"]));
// 3) 验收 4：与 gen-resources CLI 逐格对拍（--validate 内部已把差异>0 转成非 0 退出码）
const v = run("src/ai/world.mjs --validate（实机 resources.json 包围盒全量对拍）",
    ["src/ai/world.mjs", "--validate", "--chunks"]);
const diffLine = (v.out.match(/差异:\s*(\d+)/) || [])[1];
console.log(`     ↳ 逐格差异数 = ${diffLine ?? "?"}`);
// 4) lint：两个源文件不得出现 proto/belt-rules
const fs = await import("node:fs");
const TARGETS = ["src/ai/op-templates.mjs", "src/ai/world.mjs"];
const hit = TARGETS.filter(p => /proto\/belt-rules/.test(fs.readFileSync(path.join(REPO, p), "utf8")));
console.log(`${hit.length ? "❌" : "✅"} grep lint：两个文件无 "proto/belt-rules"（命中：${hit.length ? hit.join(",") : "无"}）`);

const totalPass = results.reduce((a, r) => a + r.passes, 0);
const anyBad = results.some(r => r.bad) || hit.length > 0;
console.log(`\n${anyBad ? "✗" : "✓"} P2 data L0 汇总：${totalPass} 条断言通过${anyBad ? "，且存在失败" : "，全绿"}`);
process.exitCode = anyBad ? 1 : 0;
