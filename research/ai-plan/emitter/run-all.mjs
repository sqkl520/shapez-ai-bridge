/**
 * run-all.mjs — P6 emitter 的 L1 门一条命令跑完（照 P2 的 `research/ai-plan/data/run-all.mjs` 的形状）
 *
 *   node research/ai-plan/emitter/run-all.mjs
 *
 * 依次跑：
 *   1. `node src/ai/compiler/roundtrip.mjs --test`  —— ★ L1 门本体（83 条）
 *   2. `node src/ai/compiler/emit.mjs --test`       —— 发射器的烟测（顺序锁判据 + 闸）
 *   3. `node research/ai-plan/emitter/probe.mjs`    —— 永不 throw / 锚点平移不变性 / chargeMode 口径
 *   4. `node research/ai-plan/emitter/probe-p2-argv.mjs` —— 缺陷 G-P2-argv-guard 的凭据（NOTES §二）
 *   5. grep lint：本包两个源文件 + 本目录脚本，不得出现那份已删除的错误方向副本路径
 *   6. 附加实测（不参与红/绿，只打印）：measure-stride5.mjs / stride5-hazard.mjs（NOTES §一的数据源）
 *
 * 任一 1-4 非 0 退出码 → 本脚本非 0。全程离线（零游戏、零网络，plan §4 第 2 条）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const run = (label, args, { counts = true } = {}) => {
    const r = spawnSync(process.execPath, args, { cwd: REPO, encoding: "utf8" });
    const out = (r.stdout || "") + (r.stderr || "");
    const fails = [...out.matchAll(/^✗[^\n]*/gm)].map(m => m[0]);
    const passes = (out.match(/^\s*✓/gm) || []).length;
    const bad = r.status !== 0;
    console.log(`${bad ? "❌" : "✅"} ${label}  (exit ${r.status}${counts ? `, ✓${passes}${fails.length ? ", ✗" + fails.length : ""}` : ""})`);
    if (fails.length) for (const f of fails.slice(0, 6)) console.log("     " + f);
    if (bad && out.length < 6000) console.log(out.split("\n").slice(-14).join("\n"));
    return { bad, out, passes, fails, status: r.status };
};

const results = [];
results.push(run("★ src/ai/compiler/roundtrip.mjs --test（L1 门）", ["src/ai/compiler/roundtrip.mjs", "--test"]));
results.push(run("src/ai/compiler/emit.mjs --test（烟测）", ["src/ai/compiler/emit.mjs", "--test"]));
results.push(run("emitter/probe.mjs（永不 throw / 平移不变性 / chargeMode）", ["research/ai-plan/emitter/probe.mjs"]));
results.push(run("emitter/probe-p2-argv.mjs（缺陷 G-P2-argv-guard 凭据）", ["research/ai-plan/emitter/probe-p2-argv.mjs"]));

/* grep lint：本包的库文件 + 本目录脚本，不得引用那份已知错误的方向副本 */
const FORBIDDEN = ["proto", "belt-rules"].join("/");       // 拼串：免得本行自己成为命中项
const TARGETS = [
    "src/ai/compiler/emit.mjs",
    "src/ai/compiler/roundtrip.mjs",
    ...fs.readdirSync(path.join(REPO, "research/ai-plan/emitter")).filter(f => f.endsWith(".mjs"))
        .map(f => "research/ai-plan/emitter/" + f),
];
const hits = TARGETS.filter(p => fs.existsSync(path.join(REPO, p)) && fs.readFileSync(path.join(REPO, p), "utf8").includes(FORBIDDEN));
console.log(`${hits.length ? "❌" : "✅"} grep lint：${TARGETS.length} 个文件无 "${FORBIDDEN}"（命中：${hits.length ? hits.join(",") : "无"}）`);

/* 回归对照：P1 的 L0（含它对 src/ai/compiler/ 全目录的 import lint）必须仍然绿 */
const p1 = run("research/ai-plan/contract/test.mjs（P1 L0，顺带 lint 本包所在目录）",
    ["research/ai-plan/contract/test.mjs", "--test"]);
/* 金样例仍被 P1 的 types.mjs 读通（本包的 golden 依赖它） */
const t = run("src/ai/compiler/types.mjs --test（三个金样例 round-trip）", ["src/ai/compiler/types.mjs", "--test"]);

/* 附加实测（信息，不判红） */
console.log("\n── NOTES §一 的实测数据（stride=5 改造的容量与兼容性）──");
run("emitter/measure-stride5.mjs", ["research/ai-plan/emitter/measure-stride5.mjs"], { counts: false });
run("emitter/stride5-hazard.mjs", ["research/ai-plan/emitter/stride5-hazard.mjs"], { counts: false });

const totalPass = results.concat([p1, t]).reduce((a, r) => a + r.passes, 0);
const anyBad = results.some(r => r.bad) || p1.bad || t.bad || hits.length > 0;
const gate = results[0];
console.log(`\n${anyBad ? "✗" : "✓"} P6 emitter：L1 门 ${gate.passes - gate.fails.length}/${gate.passes} 通过；全包汇总 ${totalPass} 条断言${anyBad ? " —— 存在失败，P8 不许接" : "，全绿"}`);
process.exitCode = anyBad ? 1 : 0;
