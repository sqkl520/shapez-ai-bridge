/**
 * cli.mjs — P8 harness 的命令行入口（plan §1.8 / §5 L3 的命令形态）。
 *
 *   node src/ai/compiler/cli.mjs --goal "----CuCu" --seed 43391 [--hub x,y] [--json] [--out DIR]
 *
 * 选项（全部可选，除 --goal）：
 *   --goal <shortKey>       目标形状（必填）。以 `--` 开头的值不会被当 flag（同 solver 的判据）。
 *   --seed <n>              离线资源图真值（默认 43391 = level-11 存档 map.seed）
 *   --hub <x,y|空>          hub 世界坐标；不给 = 由 seed 反推（L3 要求「无人工坐标」）
 *   --site <x,y>            厂区锚点（当前等价于 --hub 的偏移基准，保留给 P7 兼容）
 *   --range <n>             选址搜索半径（默认 96 格）
 *   --demand <n>            需求吞吐 items/s（默认 0 = 只要能跑通；影响 V7）
 *   --level <n>             当前关卡（默认按 goal 反推；只影响 cutQuad 门控与 V10 报告）
 *   --row-gap/--col-gap <n> 作图行距/列距（默认 P3 的 8/3）
 *   --depth/--max-states <n> solver 预算
 *   --allow-cutquad         强制开 cutQuad（默认：level<16 关，见 compile.mjs CUTQUAD_MIN_LEVEL）
 *   --enforce-unlocks       让 V10 从「报告」升级成「阻断」（默认 god-mode 口径，plan §6 R4）
 *   --json                  输出完整 CompiledPlan JSON（默认只给人读摘要）
 *   --out DIR               交接件目录（默认 research/ai-plan/harness/out）
 *   --no-handoff            不写交接件（只编译）
 *   --help                  用法
 *
 * 退出码：0 = ok:true（且交接件写过）/ 1 = ok:false（结构化失败，仍打印 reason）/ 2 = 用法错误
 * 全程离线（spawnSync 只跑仓库内的 proto/solver.mjs）。
 */
import path from "node:path";

import { compilePlan, writeHandoff, HANDOFF_DIR, REPO_ROOT } from "./compile.mjs";

/** 本文件未被使用到的路径常量刻意省略：所有路径都从 compile.mjs 的 REPO_ROOT/HANDOFF_DIR 派生。 */

export const USAGE = `用法：node src/ai/compiler/cli.mjs --goal <shortKey> [--seed 43391] [--hub x,y] [--json] [--out DIR]
      例：node src/ai/compiler/cli.mjs --goal "----CuCu" --seed 43391
          node src/ai/compiler/cli.mjs --goal "CgScScCg" --seed 43391 --demand 0.25 --json
全部选项见文件头注释；--help 复读一次。`;

/** 取 flag 的值（`--key value` 形态）。 */
/** 取 flag 的值。**刻意允许值以 `--` 开头**：`----CuCu` / `--CuCu--` 就是合法 shortKey
 *  （solver.mjs 也用同一条判据）。所以只排除「本身就是已知 flag 名」的值，不排除 `--` 前缀。 */
const KNOWN_FLAGS = new Set(["--seed", "--hub", "--site", "--range", "--demand", "--level", "--row-gap",
	"--col-gap", "--depth", "--max-states", "--out", "--goal", "--json", "--no-handoff",
	"--allow-cutquad", "--enforce-unlocks", "--help", "-h"]);
function val(argv, key, dflt = undefined) {
	const i = argv.indexOf(key);
	if (i < 0 || i + 1 >= argv.length) return dflt;
	const v = argv[i + 1];
	return KNOWN_FLAGS.has(v) ? dflt : v;
}
const num = (s, dflt) => (s === undefined || s === "" || !Number.isFinite(Number(s)) ? dflt : Number(s));
const cell = s => {
	if (typeof s !== "string") return undefined;
	const m = s.trim().match(/^(-?\d+)\s*,\s*(-?\d+)$/);
	return m ? [Number(m[1]), Number(m[2])] : undefined;
};

/** argv → compilePlan 入参。返回 {input} 或 {error:string}。 */
export function parseArgv(argv) {
	// 形参表：哪些 flag 消耗一个值（值本身可以长得像 flag —— `----CuCu` 就是形状）
	const VALUE_FLAGS = new Set(["--seed", "--hub", "--site", "--range", "--demand", "--level",
		"--row-gap", "--col-gap", "--depth", "--max-states", "--out", "--goal"]);
	// shortKey 语法：每象限 = [sub][color]，每层 4 象限（types.mjs:223 / shape-ops.parse）
	const isGoalLike = a => typeof a === "string" && /^([-RCSW][rgbypcuw-]){4}(:([-RCSW][rgbypcuw-]){4})*$/.test(a);
	// ① 显式 --goal 优先（值可以以 -- 开头）
	let goal = val(argv, "--goal");
	// ② 否则取第一个「不像任何 flag 的纯形状」参数（solver.mjs 的判据同源：`----CuCu` 以 -- 开头但是形状）
	if (goal === undefined) {
		goal = argv.find((a, i) => isGoalLike(a) && !(i > 0 && VALUE_FLAGS.has(argv[i - 1])));
	}
	// ③ 再退一步：第一个既不是已知 flag、也不是某个 flag 的值的位置参数
	if (goal === undefined) {
		goal = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && VALUE_FLAGS.has(argv[i - 1])));
	}
	const input = {};
	if (!goal) return { error: "缺 --goal（目标 shortKey，例 \"----CuCu\"）\n" + USAGE };
	input.goal = goal;
	input.seed = num(val(argv, "--seed"), 43391);
	const hub = cell(val(argv, "--hub"));
	if (hub) input.hub = hub;
	// --site：世界选址的搜索中心（默认原点）。与 --hub 不同：hub 是「已经建好的 hub 在哪」，
	// --site 是「在哪片区域找矿」。两者都给时，site 只影响选址搜索中心。
	const site = cell(val(argv, "--site"));
	if (site) input.origin = site;
	input.range = num(val(argv, "--range"), 96);
	input.demandPerSec = num(val(argv, "--demand"), 0);
	const lv = val(argv, "--level"); if (lv !== undefined) input.level = num(lv, undefined);
	const rg = val(argv, "--row-gap"); if (rg !== undefined) input.rowGap = num(rg, undefined);
	const cg = val(argv, "--col-gap"); if (cg !== undefined) input.colGap = num(cg, undefined);
	const dp = val(argv, "--depth"); if (dp !== undefined) input.depth = num(dp, undefined);
	const ms = val(argv, "--max-states"); if (ms !== undefined) input.maxStates = num(ms, undefined);
	if (argv.includes("--allow-cutquad")) input.noCutQuad = false;
	if (argv.includes("--enforce-unlocks")) input.enforceUnlocks = true;
	if (val(argv, "--out") !== undefined) input.out = path.resolve(val(argv, "--out"));
	input.json = argv.includes("--json");
	input.noHandoff = argv.includes("--no-handoff");
	return { input };
}

/** 人读摘要（成功/失败两种）。 */
export function render(plan, handoff) {
	const lines = [];
	if (plan.ok === true) {
		lines.push(`✓ ${plan.goal} → 蓝图 ${plan.blueprint.length} 字符 / ${plan.entities.length} 实体`);
		lines.push(`  site.anchor=[${plan.site.anchor}]  hub=[${plan.site.hub}]  chargeMode=${plan.stats.chargeMode}（god-mode 口径，plan §6 R4）`);
		lines.push(`  machines=${JSON.stringify(plan.stats.machines)} beltTiles=${plan.stats.beltTiles} trash=${plan.stats.trash} corners=${plan.stats.corners} bbox=${JSON.stringify(plan.stats.bbox)}`);
		lines.push(`  throughput=${plan.stats.estThroughputPerSec}/s bottleneck=${plan.stats.bottleneck} 蓝图成本=${plan.stats.blueprintCost}`);
		lines.push(`  validator pass=${plan.validation.pass} beltSim=${plan.validation.beltSim.tilesChecked}格/不动点${plan.validation.beltSim.fixedPoints} drift=${plan.validation.beltSim.drift.length} includesMachineNeighbors=${plan.validation.beltSim.includesMachineNeighbors}`);
		lines.push(`  roundtrip=${plan.roundtrip && plan.roundtrip.ok ? "PASS" : "FAIL"}（decode 回来逐格对拍 ${plan.roundtrip ? plan.roundtrip.decodedCount : 0} 格）`);
		if (plan.provenance) {
			const p = plan.provenance;
			lines.push(`  provenance: solver=${p.solver.ops && Object.entries(p.solver.ops).map(([k, v]) => `${k}×${v}`).join(" ")} 门控 cutQuad=${p.cutQuadAllowed} level=${p.level} channelOrder=${p.channelOrder} gapTries=${p.gapTries} 矿格=${(p.minerCells || []).map(m => `${m.shape}@${m.cell.join(",")}`).join(" ")}`);
		}
		if (handoff && handoff.ok === true) lines.push(`  交接件 → ${handoff.files.map(f => path.relative(REPO_ROOT, f)).join(", ")}`);
		if (handoff && handoff.ok === false) lines.push(`  ⚠️ 交接件未写：${handoff.reason} ${handoff.hint || ""}`);
	} else {
		lines.push(`✗ ${plan.goal || "?"} → ok:false`);
		lines.push(`  reason=${plan.reason}`);
		if (plan.failingNode) lines.push(`  failingNode=${JSON.stringify(plan.failingNode)}`);
		if (plan.class) lines.push(`  class=${plan.class}`);
		lines.push(`  hint=${plan.hint || "-"}`);
		if (plan.stages) {
			const bad = Object.entries(plan.stages).filter(([, v]) => v && v.ok === false);
			lines.push(`  卡在第几段：${bad.map(([k, v]) => `${k}(${v.reason})`).join(" ← ") || "（无）"}`);
			lines.push(`  全部段：${Object.entries(plan.stages).map(([k, v]) => `${k}:${v && v.ok === false ? "✗" : "✓"}`).join(" ")}`);
		}
	}
	return lines.join("\n");
}

export function main(argv = process.argv.slice(2)) {
	if (argv.includes("--help") || argv.includes("-h")) { console.log(USAGE); return 0; }
	const parsed = parseArgv(argv);
	if (parsed.error) { console.error(parsed.error); return 2; }
	const input = parsed.input;
	const outDir = input.out || HANDOFF_DIR;
	delete input.out; delete input.json; delete input.noHandoff; delete input.site;
	const plan = compilePlan(input);
	const handoff = input.noHandoff ? null : writeHandoff(plan, outDir);
	if (argv.includes("--json")) {
		console.log(JSON.stringify({ ...plan, handoff }, (k, v) => (k === "layout" && v && v.grid ? { ...v, grid: v.grid.split("\n").length + " rows" } : v), 1));
	} else {
		console.log(render(plan, handoff));
		if (plan.ok === true) console.log(`  蓝图：${plan.blueprint.slice(0, 72)}${plan.blueprint.length > 72 ? "…" : ""}`);
	}
	return plan.ok === true ? 0 : 1;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("compiler/cli.mjs")) {
	process.exitCode = main();
}
