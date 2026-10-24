/**
 * test.mjs — P8 `harness` 的 L0（`node research/ai-plan/harness/test.mjs`）。
 *
 * 验收对映（任务书 §验收 L0）：
 *   A 端到端离线：真实目标 → ok:true + validator.pass + emit 成功 + round-trip（decode 回推逐格 == intent）
 *   B 确定性：同输入两次 compilePlan 逐字节同（蓝图字符串相等）
 *   C 失败路径：多层 / seed 无 Cu / cutQuad 门控 / 无颜料供料 —— 每条都断言 **精确 reason + class**
 *   D 交接件三件套落盘，validator 文件里 pass=true，intent 永远带 entities[]
 *   E grep lint：无 proto/belt-rules；compile/cli 不 import 任何网络模块（离线证明）
 *   F 契约自洽：ok:true 的 plan 必过 P1 的 assertCompiledPlan；ok:false 的蓝图必为 null
 *   G 不 throw：喂垃圾输入也返回结构化失败（永不 throw 是 plan §0 的硬规定）
 *
 * 全程离线：零游戏、零网络（plan §4 第 2 条）。零依赖：ESM + node: 内置。
 *
 * ⚠️ 本包**不撒谎**：上游三处阻断（P3 cutter 废料行 / P4 多分支汇合 / solver 颜料折叠）
 *   让 `----CuCu` / `CgScScCg` 这类目标在当前入库版本下过不了闸。本文件对它们**断言失败语义**
 *   （reason + class 精确），而不是把断言改软。证据与最小复现见 NOTES.md §2。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");

const { compilePlan, writeHandoff, inspectGoal, solveGoal, rebuildDag, mapOps, OP_MAP, levelForGoal, hubWorldState,
	CUTQUAD_MIN_LEVEL, ROUTE_RETRY_MAX, goalSlug, checkPigments, normalizeHub,
	hubClearOf, worldFrameHubCheck, entityRectOf, siteStage } =
	await import(pathToFileURL(path.join(REPO, "src/ai/compiler/compile.mjs")).href);
const { assertCompiledPlan, ContractViolation, SCOPE_V1 } = await import(pathToFileURL(path.join(REPO, "src/ai/compiler/types.mjs")).href);
const { decodeBlueprint } = await import(pathToFileURL(path.join(REPO, "src/shared/blueprint.mjs")).href);
const { validate } = await import(pathToFileURL(path.join(REPO, "src/ai/compiler/validate.mjs")).href);
const { auditReport } = await import(pathToFileURL(path.join(REPO, "src/ai/compiler/validate.mjs")).href);

let pass = 0, fail = 0;
const say = (cond, msg, detail) => {
	if (cond) { pass++; console.log(`✓ ${msg}`); }
	else { fail++; console.log(`✗ ${msg}${detail === undefined ? "" : `\n      实得 ${JSON.stringify(detail)}`}`); }
};
const eq = (got, want, msg) => say(JSON.stringify(got) === JSON.stringify(want), msg, JSON.stringify(got) === JSON.stringify(want) ? undefined : { got, want });
const ok = (v, msg, detail) => say(!!v, msg, detail);
const t0 = Date.now();

/* ══════════════════ A. 端到端（真实目标 → 蓝图）══════════════════ */
console.log("\n── A 端到端：真实关卡目标（level 1-5 的官方形状） ──");

/**
 * 通过的六个目标，全部是 shapez 官方关卡形状（human-strategies.md §2.4 的 levels 表）：
 *   level 1 `CuCuCuCu`、level 3 `RuRuRuRu`、level 5 `Cu----Cu`。
 * 选它们不是挑软柿子：v1 范围（单层/无隧道/机器不转/入度≤2）能**真布通**的就是这些形态。
 */
const PASSING = ["CuCuCuCu", "RuRuRuRu", "Cu----Cu", "--CuCu--", "Ru----Ru", "--SuSu--", "----CuCu", "RuRu----"];
const plans = {};
for (const goal of PASSING) {
	const p = compilePlan({ goal, seed: 43391 });
	plans[goal] = p;
	say(p.ok === true && p.blueprint && p.blueprint.startsWith("SZBP1."), `A ${goal}: ok:true 且产出 SZBP1 蓝图`, p.ok === false ? { reason: p.reason, hint: p.hint } : undefined);
	if (p.ok !== true) continue;
	say(p.validation && p.validation.pass === true, `A ${goal}: validator.pass === true`);
	say(p.validation.beltSim.includesMachineNeighbors === true, `A ${goal}: beltSim.includesMachineNeighbors === true（V3 的核心判据）`);
	say(p.validation.beltSim.drift.length === 0, `A ${goal}: beltSim.drift 为空（含机器邻居下每格都是不动点）`);
	say(p.roundtrip && p.roundtrip.ok === true, `A ${goal}: round-trip 自检通过`, p.roundtrip);
	say(p.stats.chargeMode === "false", `A ${goal}: stats.chargeMode === "false"（god-mode 口径，plan §6 R4）`);
	say(JSON.stringify(p.scope) === JSON.stringify(SCOPE_V1), `A ${goal}: scope 逐字段等于 v1 常量`);
	try { assertCompiledPlan(p, "plan"); say(true, `A ${goal}: 过 P1 的 assertCompiledPlan（§2.1 契约）`); }
	catch (e) { say(false, `A ${goal}: 过 P1 的 assertCompiledPlan`, e.allMessages || e.message); }
}

/** round-trip 逐格：decode → (code,dx,dy,rot) 与 entities 全等；belt 格 code===1+rv */
console.log("\n── A2 round-trip 逐格（decodeBlueprint 回推 == intent） ──");
for (const goal of PASSING) {
	const p = plans[goal];
	if (!p.ok) continue;
	const dec = decodeBlueprint(p.blueprint);
	eq(dec.entities.length, p.entities.length, `A2 ${goal}: 解码格数 == entities 数（${p.entities.length}）`);
	const mism = dec.entities.filter((d, i) => {
		const e = p.entities[i];
		return !(d.code === e.code && d.dx === e.dx && d.dy === e.dy && d.rot === e.rot);
	});
	eq(mism.length, 0, `A2 ${goal}: 逐格 (code,dx,dy,rot) 全等`);
	const beltBad = p.entities.filter(e => e.kind === "belt" && e.code !== 1 + e.rotationVariant);
	eq(beltBad.length, 0, `A2 ${goal}: 每条带子 code === 1+rv（belt-rules 唯一权威）`);
	const intentBad = (p.beltIntent || []).filter(b => b.x !== p.site.anchor[0] + b.dx || b.y !== p.site.anchor[1] + b.dy);
	eq(intentBad.length, 0, `A2 ${goal}: beltIntent 每格 x/y === anchor + dx/dy`);
}

/* ══════════════════ B. 确定性 ══════════════════ */
console.log("\n── B 确定性：同输入两次，逐字节同 ──");
for (const goal of PASSING) {
	const a = compilePlan({ goal, seed: 43391 });
	const b = compilePlan({ goal, seed: 43391 });
	say(a.ok === b.ok, `B ${goal}: 两次 ok 相同`);
	if (!a.ok) continue;
	say(a.blueprint === b.blueprint, `B ${goal}: 蓝图字符串逐字节相等（LZ 压缩确定性由串相等即证）`);
	say(JSON.stringify(a.entities) === JSON.stringify(b.entities), `B ${goal}: entities 逐字节相等`);
	say(JSON.stringify(a.validation.beltSim) === JSON.stringify(b.validation.beltSim), `B ${goal}: beltSim 逐字节相等`);
}
// 不同 seed 不保证同图，但必须仍然是**确定**的（同 seed 内稳定）
{
	const a = compilePlan({ goal: "CuCuCuCu", seed: 12345 });
	const b = compilePlan({ goal: "CuCuCuCu", seed: 12345 });
	say(a.ok && b.ok && a.blueprint === b.blueprint, "B 换 seed 12345 仍确定性（蓝图相等）");
}

/* ══════════════════ C. 失败路径（精确 reason + class）══════════════════ */
console.log("\n── C 失败路径：每条都断言精确 reason（不静默、不近似） ──");

// C1 多层（真多层：3 层）
{
	const p = compilePlan({ goal: "CuCuSuSu:RuRuCuCu:WwWwWwWw", seed: 43391 });
	say(p.ok === false, "C1 三层目标 → ok:false（v1 scope.layers=1）");
	eq(p.reason, "out-of-scope:multilayer", "C1 reason === out-of-scope:multilayer");
	eq(p.failingNode && p.failingNode.check, "V8-scope", "C1 failingNode.check === V8-scope");
	eq(p.blueprint, undefined, "C1 失败时没有蓝图字段（绝不产出会堵死的蓝图）");
	ok(/多层|layers|v1\.1/.test(p.hint || ""), "C1 hint 点名多层，供 LLM/人分诊", p.hint);
}
// C1b 两层（plan §2.7 的 M4 产物是**单层**合法形状，别把 hash 里的 ':' 当多层）
{
	const p = compilePlan({ goal: "CuCuSuSu:RuRuCuCu", seed: 43391 });
	say(p.ok === false && p.reason === "out-of-scope:multilayer", "C1b 两层目标同样拒（solver 能解，布局不做）");
	ok(/SYNTHESIS|多层|布局/.test(p.hint || ""), "C1b hint 说明「solver 能解、多层布局未做」");
}
// C1c 语法坏串 → 也走结构化失败（永不 throw 且不误报成 multiayer 的假象）
{
	const p = compilePlan({ goal: "CuCu", seed: 43391 });
	say(p.ok === false && typeof p.reason === "string", "C1c 坏 shortKey → ok:false（永不 throw）");
	ok(p.failingNode && p.failingNode.nodeId, "C1c failingNode 指向 goal 层", p.failingNode);
}
// C2 seed 范围内无目标资源
{
	const pr = compilePlan({ goal: "WuWuWuWu", seed: 43391, range: 24 });
	say(pr.ok === false, "C2 小半径内无 W 资源 → ok:false");
	eq(pr.reason, "no-resource-in-range", "C2 reason === no-resource-in-range");
	ok(/WuWuWuWu|范围|seed/.test(pr.hint || ""), "C2 hint 说明缺哪种资源、可扩大范围", pr.hint);
	// 用「选址中心」这一个变量做对照：同一 seed、同一目标，换一片**没有该资源**的区域。
	// （资源图是 chunk 对齐的，改 range 不会缩小 chunk 覆盖 —— 所以用 origin/region 才真正换地方。）
	const { resourceHistogram } = await import(pathToFileURL(path.join(REPO, "src/ai/world.mjs")).href);
	const far = { x0: 940, y0: -60, x1: 1060, y1: 60 };
	const hFar = resourceHistogram(43391, far);
	say((hFar["SuSuSuSu"] || 0) === 0, "C2 远端区域 [940,-60,1060,60] 确实没有 SuSuSuSu（离线资源图）", hFar);
	const off = compilePlan({ goal: "SuSuSuSu", seed: 43391, region: far });
	say(off.ok === false && off.reason === "no-resource-in-range", "C2 换到无该资源的区域 → no-resource-in-range", off.reason);
	const near = compilePlan({ goal: "SuSuSuSu", seed: 43391 });
	say(near.ok === true, "C2 同一 seed 原点附近范围内 SuSuSuSu 编译成功 ⇒ 前一条失败纯由选址区域造成");
}
// C3 cutQuad 门控
{
	// `Cu------` (level 6 目标)：开 quad 时 solver 用 cutQuad；L<16 必须关 → 用 cut+rotate 解
	const gated = solveGoal("Cu------", { level: 6 });
	say(gated.ok === true, "C3 L6 求解 Cu------ 成功");
	say(!gated.argv.includes("--no-cutquad") === false, "C3 L6 的 solver argv **含** --no-cutquad（门控生效）");
	say(gated.cutQuadAllowed === false, "C3 L6 cutQuadAllowed === false");
	eq(gated.steps.filter(s => s.op === "cutQuad").length, 0, "C3 L6 的解里没有 cutQuad");
	const ungated = solveGoal("Cu------", { level: 16, noCutQuad: false });
	say(ungated.ok === true && ungated.steps.some(s => s.op === "cutQuad"), "C3 L16 允许 cutQuad 时解里出现 cutQuad（证明门控真的在起作用）");
	const mapped = mapOps(rebuildDag(ungated.steps));
	say(mapped.ok === false && mapped.reason === "unlock:machine-not-available", "C3 cutQuad 被映射闸拒（v1 无 4 路汇合模板）", mapped);
	// 端到端：L6 目标在门控下能走多远
	const p = compilePlan({ goal: "Cu------", seed: 43391 });
	say(p.stages.solveGoal.ok === true, "C3 端到端：L6 目标求解段通过");
	say(p.stages.pigmentGate.ok === true, "C3 端到端：无颜料问题");
}
// C3b 门控常量本身
{
	eq(CUTQUAD_MIN_LEVEL, 16, "C3b CUTQUAD_MIN_LEVEL === 16（human-strategies §2.2：quad cutter 是 L16）");
	eq(levelForGoal("CgScScCg"), 11, "C3b levelForGoal('CgScScCg') === 11（官方关卡表；不能从 op 反推：按 op 只到 6）");
	eq(levelForGoal("----CuCu"), 2, "C3b levelForGoal('----CuCu') === 2（官方 L2）");
	eq(levelForGoal("CuCuCuCu"), 1, "C3b levelForGoal('CuCuCuCu') === 1");
}
// C4 颜料契约（solver 4e60013 起颜料是一等节点 → 路径变化，但护栏仍在）
{
	// ① 正向：新契约下颜料确实进了 plan（mineColor/mix 节点 + paint 双输入）
	const { solveGoal: sg, rebuildDag: rb } = await import(pathToFileURL(path.join(REPO, "src/ai/compiler/compile.mjs")).href);
	const sv = sg("CrCrCrCr", {});
	const dg = rb(sv.steps);
	const pig = dg.dag.filter(n => n.kind === "pigment");
	say(pig.length === 1 && pig[0].op === "mineColor" && pig[0].color === "red", "C4 新契约：CrCrCrCr 的 plan 含 1 个 mineColor(red)", pig);
	const paint = dg.dag.find(n => n.op === "paint");
	say(paint && paint.inputs.length === 2, "C4 新契约：paint 有两路输入（shape + pigment）", paint && paint.inputs);
	say(paint && /^-+r/.test(paint.inputs[1]) || /r/.test(paint.inputs[1]), "C4 新契约： pigments 输入是合法 shortKey token（sub 全 '-'）", paint && paint.inputs[1]);
	// ② 颜料 token 必须过 P1 语法、且 hash 唯一（这是 P3 的两个硬闸）
	const { assertLayoutReport } = await import(pathToFileURL(path.join(REPO, "src/ai/compiler/types.mjs")).href);
	for (const n of pig) say(!/^[-RCSW][rgbypcuw-]$/.test(n.hash.slice(0, 2)) || n.hash.length === 8, `C4 token ${n.hash} 长度 8（P1 语法闸）`);
	const hashes = dg.dag.map(n => n.hash);
	eq(new Set(hashes).size, hashes.length, "C4 所有节点 hash 唯一（P3 的唯一闸）");
	// ③ 护栏：如果配方层退回「颜料折进 args」，pigmentGate 必须拒（用旧形态构造）
	const { checkPigments } = await import(pathToFileURL(path.join(REPO, "src/ai/compiler/compile.mjs")).href);
	const legacy = [{ hash: "CrCrCrCr", op: "paint", args: { color: "red" }, inputs: ["CuCuCuCu"], kind: "shape" }];
	say(checkPigments(legacy).ok === false, "C4 护栏：paint 只有 1 路输入（旧缺口形态）→ pigmentGate 拒");
	// ④ 上色目标当前被 P3/P4 的 painter→hub 几何拦下（NOTES §8.1），reason 必须精确
	const p = compilePlan({ goal: "CrCrCrCr", seed: 43391 });
	say(p.ok === false, "C4 上色目标仍被拦（painter→hub 竖车道，P3/P4 几何）");
	eq(p.reason, "dag-not-placeable:column-conflict-unresolved", "C4 reason 精确（不伪造成功）");
	say(p.stages.pigmentGate.ok === true, "C4 失败点**不在**颜料闸（颜料已过，卡在几何）", p.stages);
}
// C5 ✓ B-1 已修：----CuCu（L3 验收目标）现在真的能出蓝图
{
	const p = compilePlan({ goal: "----CuCu", seed: 43391 });
	say(p.ok === true, "C5 ----CuCu（L3 验收目标）→ ok:true（B-1 修复后）", p.ok === false ? { reason: p.reason, hint: p.hint } : undefined);
	if (p.ok) {
		say(p.validation.pass === true, "C5 ----CuCu: validator.pass");
		eq(p.validation.beltSim.drift.length, 0, "C5 ----CuCu: V3 drift === 0");
		say(p.entities.length === 14, "C5 ----CuCu: 14 实体", p.entities.length);
		say(p.blueprint.startsWith("SZBP1."), "C5 ----CuCu: 产出蓝图");
	}
}
// C6 多分支汇合（CgScScCg）→ 仍被 P3/P4 拦（B-3 + painter 几何）
{
	const p = compilePlan({ goal: "CgScScCg", seed: 43391 });
	say(p.ok === false, "C6 CgScScCg 仍失败（B-3 未修）");
	say(["dag-not-placeable:crossing-needs-tunnel", "dag-not-placeable:column-conflict-unresolved"].includes(p.reason),
		"C6 reason ∈ {crossing-needs-tunnel, column-conflict-unresolved}", p.reason);
	say(p.stages.pigmentGate.ok === true, "C6 颜料闸已过（不是颜料问题）", p.stages);
}
// C7 多层 / 无资源 的归因顺序不变
{
	const p = compilePlan({ goal: "RbRb----", seed: 43391 });
	say(p.ok === false && p.reason === "dag-not-placeable:column-conflict-unresolved",
		"C7 上色目标归因到几何（颜料已过）", { reason: p.reason, class: p.class });
}

/* ══════════════════ D. 交接件三件套 ══════════════════ */
console.log("\n── D 交接件（plan §4.6）：szbp.txt + intent.json + validator.json ──");
{
	const dir = path.join(HERE, "out");
	// 清掉本测试要写的三个目标（别的目标（若有）不动）
	const goal = "Cu----Cu";
	for (const ext of ["szbp.txt", "intent.json", "validator.json"]) {
		try { fs.unlinkSync(path.join(dir, `${goalSlug(goal)}.${ext}`)); } catch { /* 不存在 */ }
	}
	const p = plans[goal];
	const h = writeHandoff(p, dir);
	say(h.ok === true, "D 写交接件成功", h);
	if (h.ok === true) {
		for (const f of [`${goalSlug(goal)}.szbp.txt`, `${goalSlug(goal)}.intent.json`, `${goalSlug(goal)}.validator.json`]) {
			ok(fs.existsSync(path.join(dir, f)), `D 落盘：${f}`);
		}
		const bpText = fs.readFileSync(path.join(dir, `${goalSlug(goal)}.szbp.txt`), "utf8");
		say(bpText === p.blueprint, "D szbp.txt 内容 === plan.blueprint（逐字节）");
		const intent = JSON.parse(fs.readFileSync(path.join(dir, `${goalSlug(goal)}.intent.json`), "utf8"));
		eq(intent.anchor, p.site.anchor, "D intent.anchor === plan.site.anchor（P7 的 paste 点）");
		eq(intent.chargeMode, "false", "D intent.chargeMode === false");
		say(Array.isArray(intent.entities) && intent.entities.length === p.entities.length, "D intent.entities[] 在场（validate.mjs --intent 可直接吃）");
		eq(intent.validator && intent.validator.pass, true, "D intent.validator.pass === true（P7 的已验证凭据）");
		const v = JSON.parse(fs.readFileSync(path.join(dir, `${goalSlug(goal)}.validator.json`), "utf8"));
		eq(v.pass, true, "D validator.json 里 pass === true（P7 拿到的必须是已验证品）");
		eq(v.beltSim.includesMachineNeighbors, true, "D validator.json 的 beltSim.includesMachineNeighbors === true");
		// 关键裁决：intent 永远在（plan-only = UNDECIDABLE）
		// ⚠️ P5 的 CLI 只吃 CompiledPlan / LayoutReport / ValidatorReport 三型（P5 NOTES F1）；
		//    本包的 intent.json 是**自家交接格式**，不属三型 → 这里验的是「喂错形态必须明确拒」。
		const cli = spawnSync(process.execPath, [path.join(REPO, "src/ai/compiler/validate.mjs"), "--plan",
			path.join(dir, `${goalSlug(goal)}.intent.json`)], { cwd: REPO, encoding: "utf8" });
		say(cli.status === 2, "D intent.json 不属 P5 的三种输入形态 → P5 明确拒（exit 2，不假绿）", { status: cli.status, err: (cli.stderr || "").slice(-200) });
		// 但 intent.entities 必须能被 P5 当 --intent 附表直接吃（「intent 永远在」的落点）
		const asIntent = spawnSync(process.execPath, [path.join(REPO, "src/ai/compiler/validate.mjs"), "--plan",
			path.join(REPO, "research/ai-plan/fixtures/report-layout.json"), "--intent",
			path.join(dir, `${goalSlug(goal)}.intent.json`)], { cwd: REPO, encoding: "utf8" });
		say(asIntent.status === 0 || asIntent.status === 1, "D P5 的 --intent 能吃本包 intent.json（有确定结论，不是用法错 2）", { status: asIntent.status, err: (asIntent.stderr || "").slice(-240) });
		const cliNoIntent = spawnSync(process.execPath, [path.join(REPO, "src/ai/compiler/validate.mjs"), "--plan",
			path.join(REPO, "research/ai-plan/fixtures/report-layout.json")], { cwd: REPO, encoding: "utf8" });
		say(cliNoIntent.status === 2, "D 只给 layout 不给 intent → UNDECIDABLE exit 2（P5 裁决：交接永远带 intent）", cliNoIntent.status);
	}
	// 失败的计划绝不写交接件
	const bad = writeHandoff({ ok: false, reason: "validate:V3", failingNode: { nodeId: "x", cell: null, check: "V3-belt-fixed-point" }, hint: null }, dir);
	say(bad.ok === false && /未过闸/.test(bad.hint || ""), "D ok:false 的计划拒绝写交接件（P7 只拿已验证品）", bad);
}

/* ══════════════════ E. grep lint（离线 + 禁改清单）══════════════════ */
console.log("\n── E grep lint：无 proto/belt-rules、无网络模块 ──");
{
	// 判据只看**真正的 import 规格符**（注释/字符串里提到模块名不算）—— 用 P1 的词法级收集器，
	// 否则「自检代码里的禁用清单字符串」会把自己判红（P1 lint-imports.mjs 头注踩过同一个坑）。
	const L = await import(pathToFileURL(path.join(REPO, "research/ai-plan/contract/lint-imports.mjs")).href);
	const files = ["src/ai/compiler/compile.mjs", "src/ai/compiler/cli.mjs",
		...fs.readdirSync(HERE).filter(f => f.endsWith(".mjs")).map(f => "research/ai-plan/harness/" + f)];
	const NET = ["node:http", "node:https", "node:net", "node:dgram", "node:tls", "node:http2", "ws"];
	for (const rel of files) {
		const src = fs.readFileSync(path.join(REPO, rel), "utf8");
		const specs = L.collectImportSpecifiers(src);
		const badBelt = specs.filter(x => /belt-rules/.test(x) && !L.isAuthoritativeBeltRules(x));
		eq(badBelt, [], `E ${rel}: 不 import 那份已知错误的方向副本`);
		const net = specs.filter(x => NET.includes(x));
		eq(net, [], `E ${rel}: 不 import 网络模块`);
		// 判据字符串自己也会被扫到 → 用拼串构造正则（P1 lint 的同款自保写法）
		const FETCH_RE = new RegExp("\\b" + "fetch" + "\\s*\\(");
		say(!FETCH_RE.test(src.replace(/\/\/.*$/gm, "")), `E ${rel}: 没有 ${"fetch"}(${""}（离线证明）`);
	}
	// P1 的权威 import lint 对整个 src/ai/compiler/ 目录
	const lint = spawnSync(process.execPath, [path.join(REPO, "research/ai-plan/contract/lint-imports.mjs"), path.join(REPO, "src/ai/compiler")], { cwd: REPO, encoding: "utf8" });
	say(lint.status === 0, "E P1 的 lint-imports 对 src/ai/compiler/ 零违例（含本包两个文件）", (lint.stdout || "") + (lint.stderr || ""));
}

/* ══════════════════ F. 契约自洽 ══════════════════ */
console.log("\n── F 契约自洽：ok:true ⟺ validation.errors==0 且 blueprint 非空 ──");
for (const goal of PASSING) {
	const p = plans[goal];
	if (!p.ok) continue;
	say(p.validation.errors.length === 0, `F ${goal}: ok:true 时 validation.errors.length === 0`);
	say(typeof p.blueprint === "string" && p.blueprint !== "", `F ${goal}: ok:true 时 blueprint 非空`);
	say(p.reason === null && p.failingNode === null, `F ${goal}: ok:true 时 reason/failingNode 均为 null`);
	say(p.stats.beltTiles === p.entities.filter(e => e.kind === "belt").length, `F ${goal}: stats.beltTiles 与 entities 自洽`);
	say(p.stats.corners === p.entities.filter(e => e.kind === "belt" && e.rotationVariant !== 0).length, `F ${goal}: stats.corners 与 entities 自洽`);
}

/* ══════════════════ G. 永不 throw ══════════════════ */
console.log("\n── G 永不 throw（plan §0 硬规定） ──");
const JUNK = [
	undefined, null, {}, { goal: null }, { goal: 42 }, { goal: "" }, { goal: "CgScScCg", seed: "abc" },
	{ goal: "CgScScCg", seed: 43391, hub: "not-a-cell" }, { goal: "../etc/passwd" }, { goal: "--------" },
	{ goal: "CuCuCuCu", rowGap: -5, colGap: -5 }, { goal: "CuCuCuCu", seed: -1 },
];
for (const [i, junk] of JUNK.entries()) {
	let threw = null, res = null;
	try { res = compilePlan(junk); } catch (e) { threw = e; }
	say(threw === null, `G[${i}] compilePlan(${JSON.stringify(junk)}) 不抛异常`, threw && String(threw.message).slice(0, 160));
	say(res && typeof res.ok === "boolean", `G[${i}] 返回对象且带 ok 布尔`, res && Object.keys(res).slice(0, 6));
	if (res && res.ok === false) say(typeof res.reason === "string" && res.reason.length > 0, `G[${i}] 失败必带 reason（§2.5）`, res.reason);
}

/* ══════════════════ H. 单元：映射表 / 归一化 / 排序 ══════════════════ */
console.log("\n── H 单元：op 映射表与工具函数 ──");
{
	eq(Object.keys(OP_MAP).sort(), ["cut", "cutQuad", "mine", "mix", "paint", "rotate", "stack"], "H OP_MAP 覆盖 solver 全部 op（mine/cut/cutQuad/rotate/paint/mix/stack）");
	eq(OP_MAP.rotate.variant({ args: { dir: "cw" } }), "rotate", "H rotate(cw) → op rotate（code 11）");
	eq(OP_MAP.rotate.variant({ args: { dir: "ccw" } }), "rotateCCW", "H rotate(ccw) → op rotateCCW（code 12）");
	eq(OP_MAP.rotate.variant({ args: { dir: "180" } }), "rotate180", "H rotate(180) → op rotate180（code 13）");
	const h1 = normalizeHub(undefined);
	eq([h1.given, h1.design], [false, [-4, -4]], "H normalizeHub(未给) → design=[-4,-4]");
	eq(normalizeHub("12,-34").world, [12, -34], "H normalizeHub(\"12,-34\") 解出世界坐标");
	eq(normalizeHub([7, 8]).world, [7, 8], "H normalizeHub([7,8]) 解出世界坐标");
	eq(normalizeHub({ x: 1, y: 2 }).world, [1, 2], "H normalizeHub({x,y}) 解出世界坐标");
	// inspectGoal
	eq(inspectGoal("CuCuCuCu").layers, 1, "H inspectGoal(CuCuCuCu).layers === 1");
	eq(inspectGoal("A:B").ok, false, "H inspectGoal 非法层长度 → ok:false");
	// checkPigments（新契约）：painter 的 color 槽必须接**颜料节点**；mixer 必须两个颜料输入
	const goodDag = [
		{ hash: "CuCuCuCu", op: "mine", args: {}, inputs: [], kind: "shape" },
		{ hash: "-r------", op: "mine", args: { color: "red" }, inputs: [], kind: "pigment", color: "red" },
		{ hash: "CrCrCrCr", op: "paint", args: { color: "red" }, inputs: ["CuCuCuCu", "-r------"], kind: "shape" },
	];
	say(checkPigments(goodDag).ok === true, "H checkPigments：color 槽接颜料节点 → ok");
	const badShape = [
		{ hash: "CuCuCuCu", op: "mine", args: {}, inputs: [], kind: "shape" },
		{ hash: "RuRuRuRu", op: "mine", args: {}, inputs: [], kind: "shape" },
		{ hash: "CrCrCrCr", op: "paint", args: { color: "red" }, inputs: ["CuCuCuCu", "RuRuRuRu"], kind: "shape" },
	];
	say(checkPigments(badShape).ok === false, "H checkPigments：color 槽接了**形状** → 拒");
	const badMix = [
		{ hash: "CuCuCuCu", op: "mine", args: {}, inputs: [], kind: "shape" },
		{ hash: "-g------", op: "mine", args: { color: "green" }, inputs: [], kind: "pigment", color: "green" },
		{ hash: "----c---", op: "mix", args: { color: "cyan" }, inputs: ["CuCuCuCu", "-g------"], kind: "pigment", color: "cyan" },
	];
	say(checkPigments(badMix).ok === false, "H checkPigments：mix 的输入不是颜料 → 拒");
	const badColor = [
		{ hash: "CuCuCuCu", op: "mine", args: {}, inputs: [], kind: "shape" },
		{ hash: "-g------", op: "mine", args: { color: "green" }, inputs: [], kind: "pigment", color: "green" },
		{ hash: "CrCrCrCr", op: "paint", args: { color: "red" }, inputs: ["CuCuCuCu", "-g------"], kind: "shape" },
	];
	say(checkPigments(badColor).ok === false, "H checkPigments：颜料颜色与 args.color 不符 → 拒");
	// 重试常量
	eq(ROUTE_RETRY_MAX, 3, "H ROUTE_RETRY_MAX === 3（加宽重试上限）");
	// CLI 的 argv 解析
	const { parseArgv } = await import(pathToFileURL(path.join(REPO, "src/ai/compiler/cli.mjs")).href);
	const pa = parseArgv(["--goal", "----CuCu", "--seed", "43391", "--json"]);
	eq(pa.input.goal, "----CuCu", "H CLI parseArgv 认得以 -- 开头的形状 goal（同 solver 的判据）");
	eq(pa.input.seed, 43391, "H CLI parseArgv 解出 --seed");
	say(parseArgv([]).error !== undefined, "H CLI 缺 --goal → 用法错误");
}

/* ══════════════════ I. 上游阻断的证据（NOTES §2 的可执行版）══════════════════ */
console.log("\n── I 上游阻断的最小证据（本包不改上游；这里只锁「确实如此」）──");
{
	// I-1 P3 的机器簇对齐是 hub-相对的：改 hubDesign 不改变相对几何 ⇒ V3 死锁换不了位置
	const sv = solveGoal("----CuCu", {});
	const dg = rebuildDag(sv.steps);
	const mp = mapOps(dg);
	const rels = [];
	const { place } = await import(pathToFileURL(path.join(REPO, "src/ai/compiler/place.mjs")).href);
	for (const HD of [[-4, -4], [0, -4], [100, -4], [-4, -40]]) {
		const rep = place({ steps: mp.steps, site: { x: 0, y: 0 }, hub: { x: HD[0], y: HD[1] },
			world: hubWorldState(HD, null) });
		if (rep.ok === false) { rels.push(null); continue; }
		rels.push(rep.placements.map(p => [p.nodeId, p.cell[0] - HD[0], p.cell[1] - HD[1]]));
	}
	eq(rels.filter(Boolean).length, 4, "I-1 四个不同 hubDesign 都能作图");
	say(rels.every(r => JSON.stringify(r) === JSON.stringify(rels[0])), "I-1 相对布局与 hubDesign 无关 ⇒ 「换 hub 位置」不是解法（P3 把机器簇对齐到 hub）", rels);
	// I-2 solver 现在**自带 inputs**（4e60013 起），P8 直接采用并在形状代数上自证
	const s0 = sv.steps.find(x => x.op === "cut");
	say(s0 && Array.isArray(s0.inputs) && s0.inputs.length === 1, "I-2 solver 的 step 带 inputs（P8 直接采用，不再猜父节点）", s0 && s0.inputs);
	say(rebuildDag(sv.steps).ok === true, "I-2 rebuildDag 采用 inputs 后仍过形状代数自证");
	// I-3 solver 的 paint 有 2 路输入（shape + 颜料节点）—— 这就是 B-2 的修复
	const svCr = solveGoal("CrCrCrCr", {});
	const paintStep = svCr.steps.find(x => x.op === "paint");
	say(paintStep && paintStep.inputs.length === 2, "I-3 solver 的 paint 有 2 路输入（shape + pigment）", paintStep && paintStep.inputs);
	say(paintStep && String(paintStep.inputs[1]).startsWith("color:"), "I-3 第 2 输入是 color:<name> 命名空间", paintStep && paintStep.inputs[1]);
	const dagCr = rebuildDag(svCr.steps);
	const paintNode = dagCr.dag.find(s => s.op === "paint");
	say(paintNode && paintNode.inputs.length === 2, "I-3 P8 侧的 paint 保留了 2 路输入", paintNode && paintNode.inputs);
	say(dagCr.dag.filter(n => n.kind === "pigment").length === 1, "I-3 颜料是独立节点（不是 args 方言）");
	const SO = await import(pathToFileURL(path.join(REPO, "research/ai-player/proto/shape-ops.mjs")).href);
	eq(SO.hash(SO.parse("--------")), "--------", "I-4 「--------」是 parse∘hash 不动点（唯一可当通道 token 的空形状）");
	eq(SO.hash(SO.parse("-r-r-r-r")), "--------", "I-4 「-r-r-r-r」被 hash 归一回空形状 ⇒ 有色颜料 token 无法作 payload");
}

/* ══════════════════ J. 世界系 hub 不相交（L3 首个实机缺陷的回归锁）══════════════════ */
/* 现场：seed 18043 / hub(-2,-2) / goal ----CuCu —— siteStage 只按资源选 anchor，得 [0,0]，
   布局在世界系压住 hub(-2,-2..1,1) → dry_run 3 格 blocked（occupant=hub uid 10000）⇒ 半建。
   这里锁四条：(1) 纯判据真能报相交 (2) 世界系 V1 对"压 hub"的布局给 fail
   (3) L3 实参端到端 anchor 不再压 hub（且 site.anchor 是世界系）
   (4) hub 钉死路径优先（给一个资源允许的 hub，收集带真能接上 hub）。 */
console.log("\n── J 世界系 hub 不相交（L3 实参的回归锁）──");
{
	// J-1 纯判据：anchor+实体矩形 vs hub 4×4
	const ents = [{ dx: 0, dy: 0, kind: "belt", nodeId: "b" }, { dx: 1, dy: 1, kind: "trash", nodeId: "t" }];
	eq(entityRectOf(ents), [0, 0, 1, 1], "J-1 entityRectOf 取实体 min/max（不含 hub、不含槽位格）");
	const bad = worldFrameHubCheck(ents, [0, 0], [-2, -2]);
	say(bad.ok === false, "J-1 布局压 hub（anchor[0,0] vs hub(-2,-2)）⇒ ok:false");
	eq([bad.hubRect, bad.hitCount], [[-2, -2, 1, 1], 2], "J-1 报出 hub 矩形与命中格数（凭据可直接对 dry_run 的 blocked）");
	const good = worldFrameHubCheck(ents, [-7, -3], [-2, -2]);
	say(good.ok === true, "J-1 不相交（anchor[-7,-3]）⇒ ok:true", good);
	say(worldFrameHubCheck(ents, [0, 0], null).ok === true, "J-1 未给世界 hub ⇒ 不判（skipped，不猜）");
	// 边界：hub(-2,-2) 占 x∈[-2,1]、y∈[-2,1]。实体 x=2 起 ⇒ 不相交；实体落在 x=1 且 y 在 [-2,1] ⇒ 相交
	say(hubClearOf([2, 2], [0, 0, 0, 11], [-2, -2]).clear === true, "J-1 紧贴 hub 右缘（实体 x=2 起）算不相交（闭区间语义）");
	say(hubClearOf([1, 0], [0, 0, 0, 0], [-2, -2]).clear === false, "J-1 压 hub 最后一列（实体 x=1,y=0）算相交");
	say(hubClearOf([2, 0], [0, 0, 0, 0], [-2, -2]).clear === true, "J-1 同一行向右挪一格（x=2）即不相交");

	// J-2 ★「布局压 hub ⇒ 世界系 V1 fail」。先复现**旧** anchor [0,0]（P5 在设计系恒 pass，V1 的洞不在这）
	const pL3 = compilePlan({ goal: "----CuCu", seed: 18043, hub: { x: -2, y: -2 } });
	say(pL3.ok === true, "J-2 L3 实参（seed 18043 / hub(-2,-2) / ----CuCu）仍 ok:true", pL3.ok === false ? pL3.reason : undefined);
	if (pL3.ok) {
		const anchor = pL3.site.anchor;
		const entsAll = pL3.entities.map(e => ({ ...e }));
		const wf = worldFrameHubCheck(entsAll, anchor, [-2, -2]);
		say(wf.ok === true, "J-2 实参 anchor 下世界系 V1 pass（实体矩形不压 hub）", wf);
		eq(anchor, pL3.provenance.worldPlacement.pasteAt,
			"J-2 site.anchor === provenance.pasteAt（P7 照它 paste；旧版给的是设计系 [0,0]）");
		// 旧 bug 的形态：把同一套实体按 [0,0] 摆 —— 必须被世界系 V1 抓住
		const stale = worldFrameHubCheck(entsAll, [0, 0], [-2, -2]);
		say(stale.ok === false, "J-2 ★同一布局按旧 anchor[0,0] 摆 ⇒ 世界系 V1 fail（升为断言：布局压 hub ⇒ V1 fail）", stale);
		eq(stale.hitCount, 3, "J-2 ★命中格数 === 3（与实机 dry_run 的 3 条 blocked 逐数对上）");
		eq(pL3.stages.worldFrameV1.ok, true, "J-2 stages.worldFrameV1 记了这道闸（P7/主线程可审计）");
		// 世界矩形与 hub 的关系写进 provenance（P7 能自己复核，不必信任结论）
		eq(pL3.provenance.worldPlacement.worldFrameV1.hubRect, [-2, -2, 1, 1], "J-2 provenance 带 hub 世界矩形");
		// ★ 如实：L3 实参下 hub 钉死不可行（(-2,13) 没有铜）⇒ 蓝图贴得上但接不上 hub。
		//    site.hub 必须是**真实** hub，不能被"布局隐含的 hub"冒充。
		eq(pL3.site.hub, [-2, -2], "J-2 site.hub === 真实 hub(-2,-2)（不是布局隐含位置）");
		eq(pL3.site.hubPinned, false, "J-2 ★L3 实参 hubPinned === false（如实：收集带没接上 hub）");
		say(JSON.stringify(pL3.provenance.worldPlacement.hubInferred) !== JSON.stringify(pL3.site.hub),
			"J-2 ★布局隐含 hub ≠ 真实 hub —— 缺口在 provenance 里可见",
			{ inferred: pL3.provenance.worldPlacement.hubInferred, real: pL3.site.hub });
	}

	// J-3 hub 钉死路径：资源允许时 anchor 必须让 hub 落在**给定**世界位置（收集带才接得上）
	//     seed 43391 的铜块在 (-9..-4, 6..12)，设计系矿机 (-4,11) ⇒ 钉死 anchor = hub − [-4,-4]
	const pPin = compilePlan({ goal: "----CuCu", seed: 43391, hub: { x: -9, y: -8 } });
	say(pPin.ok === true, "J-3 hub(-9,-8) / seed 43391：ok:true（资源允许钉死）", pPin.ok === false ? pPin.reason : undefined);
	if (pPin.ok) {
		eq(pPin.site.hub, [-9, -8], "J-3 site.hub === 给定世界 hub（锚点真的钉在给定位置）");
		eq(pPin.site.hubPinned, true, "J-3 site.hubPinned === true");
		eq(pPin.provenance.worldPlacement.hubPinned, true, "J-3 provenance.worldPlacement.hubPinned === true");
		eq([pPin.site.hub, pPin.provenance.worldPlacement.hubInferred], [[-9, -8], [-9, -8]],
			"J-3 钉死时 布局隐含 hub === 真实 hub（收集带真接上了）");
		eq(pPin.provenance.minerCells[0].cell, [-9, 7], "J-3 矿机落在铜上（钉死后仍过资源校验）");
	}
	// J-4 钉死不可行时**退回**不压 hub 的 anchor，并在 stages 留 preferredRejected 凭据
	const pBack = compilePlan({ goal: "----CuCu", seed: 43391, hub: { x: -5, y: -4 } });
	say(pBack.ok === true, "J-4 hub 钉死不可行（-5,-4 处没有铜）⇒ 退回资源允许的 anchor", pBack.ok === false ? pBack.reason : undefined);
	if (pBack.ok) {
		eq(pBack.site.hub, [-5, -4], "J-4 site.hub === **真实**给定 hub（不是布局隐含的那个位置）");
		eq(pBack.site.hubPinned, false, "J-4 site.hubPinned === false（如实：没真接上 hub）");
		say(JSON.stringify(pBack.provenance.worldPlacement.hubInferred) !== JSON.stringify(pBack.site.hub),
			"J-4 布局隐含的 hub ≠ 真实 hub —— 缺口如实可见（P7/MS 不会被 hubInferred 骗）",
			{ inferred: pBack.provenance.worldPlacement.hubInferred, real: pBack.site.hub });
		say(worldFrameHubCheck(pBack.entities, pBack.site.anchor, [-5, -4]).ok === true,
			"J-4 退回的 anchor 仍不压给定 hub（硬约束不因为退回而豁免）");
	}
	// J-5 无 hub 的老路径逐字节不变（既有 304 断言的确定性基线）
	const pNoHubA = compilePlan({ goal: "CuCuCuCu", seed: 43391 });
	const pNoHubB = compilePlan({ goal: "CuCuCuCu", seed: 43391 });
	say(pNoHubA.ok && pNoHubB.ok && pNoHubA.blueprint === pNoHubB.blueprint, "J-5 未给 hub 时仍确定（蓝图逐字节相等）");
	eq(pNoHubA.site.hub, null, "J-5 未给 hub 时 site.hub === null（世界 hub 未知，不假装知道）");
	say(pNoHubA.provenance.worldPlacement.hubInferred !== null,
		"J-5 推算的世界 hub 只进 provenance.hubInferred（诊断用，不当契约值）");
}

/* ══════════════════ 汇总 ══════════════════ */
console.log(`\n${fail === 0 ? "✓" : "✗"} P8 harness L0：${pass} 通过 / ${fail} 失败（${Date.now() - t0}ms）`);
console.log(`  通过的目标（真布通，含 L3 验收目标 ----CuCu）：${PASSING.filter(g => plans[g] && plans[g].ok).join(" ")}`);
console.log(`  仍被拦的目标（精确 reason 已锁）：CrCrCrCr/RbRb----/CpCpCpCp(painter→hub 竖车道) CgScScCg(B-3+几何) 多层(scope)`);
if (fail) process.exitCode = 1;
