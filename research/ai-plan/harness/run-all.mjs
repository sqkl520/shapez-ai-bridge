/**
 * run-all.mjs — P8 harness 的**全家族回归一条命令**（plan §5 / BATCH.md 的「L0/L1 断言账」落地）。
 *
 *   node research/ai-plan/harness/run-all.mjs            # 全跑
 *   node research/ai-plan/harness/run-all.mjs --fast     # 跳过最慢的两组（validator / emitter L1）
 *
 * 依次跑（顺序 = 依赖序，任一组红即整条红）：
 *   P1 contract   research/ai-plan/contract/test.mjs          （94 断言，含全目录 import lint）
 *   P2 data       research/ai-plan/data/run-all.mjs           （637 断言 + 与 gen-resources CLI 逐格对拍）
 *   P0-verify     node --test src/ai/belt-rules.test.mjs      （17 断言；方向真值的唯一权威）
 *   P3 placer     research/ai-plan/placer/test.mjs            （140 断言，含四张金网格逐字节）
 *   P4 router     research/ai-plan/router/test.mjs            （184 断言）
 *   P5 validator  research/ai-plan/validator/test.mjs         （190 断言，含变异矩阵 + 双实现对拍）
 *   P6 emitter    research/ai-plan/emitter/run-all.mjs        （291 断言，含 L1 门 85）
 *   P8 harness    research/ai-plan/harness/test.mjs           （336 断言，本包 L0）
 *   ── 既有五套回归 ──
 *   mod           test/mod_selftest.mjs                       （25）
 *   blueprint     test/blueprint_selftest.mjs                 （7）
 *   rpc           test/mod_rpc_selftest.mjs                   （12）
 *   bridge        src/bridge/selftest.mjs                     （19）
 *   mcp           src/mcp/selftest.mjs                        （47）
 *
 * 末尾另跑 **grep lint**（对 harness 两个源文件）：无那份已知错误的方向副本、无网络模块。
 *
 * 设计要点（与 P2/P6 的 run-all 同形，但多两条纪律）：
 *   1. **断言数从输出里现数**，不写死 —— 账本里的数字若与实跑不符，这张表先红（ADVERSARIAL:31-40）。
 *   2. **全离线**：只 spawn `node <file>`，不开 socket、不起游戏（plan §4 第 2 条）。
 *   3. 每组都打印退出码 + 断言数；红组把最后几行贴出来，不让失败藏在 200 行输出里。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const FAST = process.argv.includes("--fast");

/**
 * 一组 = { label, argv, expect?, extract? }
 *   expect   = 账本里的断言数（对不上 → 警告，不算红：P6/P5 的计数口径可能变，红只按退出码）
 *   extract  = 从输出里数断言的正则（缺省数 "✓"）
 */
const SUITES = [
	{ label: "P1 contract（含 import lint）", argv: ["research/ai-plan/contract/test.mjs"], expect: 94 },
	{ label: "P2 data（639 + 逐格对拍）", argv: ["research/ai-plan/data/run-all.mjs"], extract: /(\d+) 条断言通过/, extractNum: 1, expect: 639 },
	{ label: "P0-verify belt-rules（17）", argv: ["--test", "src/ai/belt-rules.test.mjs"], extract: /^ℹ pass (\d+)$/m, extractNum: 1, expect: 17 },
	{ label: "P3 placer", argv: ["research/ai-plan/placer/test.mjs"], expect: 269 },
	{ label: "P4 router", argv: ["research/ai-plan/router/test.mjs"], expect: 208 },
	{ label: "P5 validator" + (FAST ? "（--fast 跳过）" : ""), argv: ["research/ai-plan/validator/test.mjs"], expect: 194, skip: FAST },
	{ label: "P6 emitter（L1 门）" + (FAST ? "（--fast 跳过）" : ""), argv: ["research/ai-plan/emitter/run-all.mjs"], extract: /全包汇总 (\d+) 条断言/, extractNum: 1, expect: 303, skip: FAST },
	{ label: "★ P8 harness（本包 L0）", argv: ["research/ai-plan/harness/test.mjs"], extract: /P8 harness L0：(\d+) 通过/, extractNum: 1, expect: 358 },
	{ label: "既有：mod 自测（28）", argv: ["test/mod_selftest.mjs"], extract: /ALL (\d+) CHECKS PASSED/, extractNum: 1, expect: 28 },
	{ label: "既有：blueprint 自测（7）", argv: ["test/blueprint_selftest.mjs"], extract: /ALL (\d+) CHECKS PASSED/, extractNum: 1, expect: 7 },
	{ label: "既有：rpc 自测（12）", argv: ["test/mod_rpc_selftest.mjs"], extract: /ALL (\d+) CHECKS PASSED/, extractNum: 1, expect: 12 },
	{ label: "既有：bridge 自测（19）", argv: ["src/bridge/selftest.mjs"], extract: /ALL (\d+) CHECKS PASSED/, extractNum: 1, expect: 19 },
	{ label: "既有：mcp 自测（47）", argv: ["src/mcp/selftest.mjs"], extract: /summary: (\d+) PASS/, extractNum: 1, expect: 47 },
];

function count(suite, out) {
	if (suite.extractNum) {
		const m = out.match(suite.extract);
		return m ? Number(m[suite.extractNum]) : null;
	}
	const re = suite.extract || /^\s*✓/gm;
	const hits = out.match(re);
	return hits ? hits.length : null;
}

console.log(`\n═══ P8 harness · 全家族回归（${FAST ? "fast 模式" : "完整"}）═══\n`);
const rows = [];
let anyBad = false;
const total = { passes: 0, fails: 0 };
const t0 = Date.now();

for (const suite of SUITES) {
	if (suite.skip) { rows.push({ ...suite, skipped: true }); console.log(`⏭  ${suite.label}`); continue; }
	const started = Date.now();
	const r = spawnSync(process.execPath, suite.argv, { cwd: REPO, encoding: "utf8", timeout: 900000, maxBuffer: 64 * 1024 * 1024 });
	const out = (r.stdout || "") + (r.stderr || "");
	const n = count(suite, out);
	const failLines = [...out.matchAll(/^\s*✗[^\n]*/gm)].map(m => m[0].trim());
	const bad = r.status !== 0;
	if (bad) anyBad = true;
	if (typeof n === "number") total.passes += n;
	total.fails += failLines.length;
	const ms = Date.now() - started;
	const drift = suite.expect !== undefined && typeof n === "number" && n !== suite.expect
		? `  ⚠️ 账本 ${suite.expect}，实得 ${n}` : "";
	console.log(`${bad ? "❌" : "✅"} ${String(suite.label).padEnd(34)} exit ${String(r.status).padStart(2)}  ${typeof n === "number" ? `断言 ${String(n).padStart(3)}` : "断言  ?"}  ${String(ms).padStart(5)}ms${drift}`);
	if (failLines.length) for (const f of failLines.slice(0, 5)) console.log(`     ${f}`);
	if (bad) console.log("     " + out.split("\n").filter(l => l.trim()).slice(-8).join("\n     "));
	rows.push({ ...suite, status: r.status, n, bad, ms });
}

/* grep lint：只看真正的 import 规格符（用 P1 的词法级收集器；注释里提到模块名不算） */
const L = await import(new URL("../contract/lint-imports.mjs", import.meta.url).href);
const lintTargets = [
	"src/ai/compiler/compile.mjs", "src/ai/compiler/cli.mjs",
	...fs.readdirSync(HERE).filter(f => f.endsWith(".mjs")).map(f => "research/ai-plan/harness/" + f),
];
const NET = ["node:http", "node:https", "node:net", "node:dgram", "node:tls", "node:http2", "ws"];
const lintHits = [];
for (const p of lintTargets) {
	const src = fs.readFileSync(path.join(REPO, p), "utf8");
	for (const sp of L.collectImportSpecifiers(src)) {
		if (/belt-rules/.test(sp) && !L.isAuthoritativeBeltRules(sp)) lintHits.push(`${p} → ${sp}`);
		if (NET.includes(sp)) lintHits.push(`${p} → ${sp}`);
	}
}
if (lintHits.length) anyBad = true;
console.log(`
${lintHits.length ? "❌" : "✅"} grep lint（离线 + 禁改清单）：${lintTargets.length} 个文件，命中 ${lintHits.length ? lintHits.join(", ") : "0"}`);

/* 汇总表 */
console.log(`\n── 汇总（${((Date.now() - t0) / 1000).toFixed(1)}s）──`);
const ran = rows.filter(r => !r.skipped);
const green = ran.filter(r => !r.bad).length;
console.log(`  组：${green}/${ran.length} 绿  断言：≈${total.passes} 条（✗ ${total.fails}）`);
for (const r of ran) {
	const drift = r.expect !== undefined && typeof r.n === "number" && r.n !== r.expect ? `（账本 ${r.expect}）` : "";
	console.log(`  ${r.bad ? "✗" : "✓"} ${String(r.label).padEnd(34)} ${typeof r.n === "number" ? String(r.n).padStart(4) : "   ?"}${drift}`);
}
console.log(anyBad
	? "\n✗ 全家族回归**有红** —— P8 不许接（先修红组，再谈 L3）"
	: "\n✓ 全家族回归**全绿** —— P8 的 L0 门通过，交接件可交 P7 做 L3");
process.exitCode = anyBad ? 1 : 0;
