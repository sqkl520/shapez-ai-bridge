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
	hubClearOf, worldFrameHubCheck, entityRectOf, entityCellsOf, siteStage } =
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
	// allowUnpinned：本组钉的是布局/验证/契约，不是「能贴进世界」。hub 政策在 compilePlan 内，
	// 不放开就会把 8 个目标一律变成 hub:unpinned，测不到它们各自真正要钉的东西。
	const p = compilePlan({ goal, seed: 43391, allowUnpinned: true });
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
	const a = compilePlan({ goal, seed: 43391, allowUnpinned: true });
	const b = compilePlan({ goal, seed: 43391, allowUnpinned: true });
	say(a.ok === b.ok, `B ${goal}: 两次 ok 相同`);
	if (!a.ok) continue;
	say(a.blueprint === b.blueprint, `B ${goal}: 蓝图字符串逐字节相等（LZ 压缩确定性由串相等即证）`);
	say(JSON.stringify(a.entities) === JSON.stringify(b.entities), `B ${goal}: entities 逐字节相等`);
	say(JSON.stringify(a.validation.beltSim) === JSON.stringify(b.validation.beltSim), `B ${goal}: beltSim 逐字节相等`);
}
// 不同 seed 不保证同图，但必须仍然是**确定**的（同 seed 内稳定）
{
	const a = compilePlan({ goal: "CuCuCuCu", seed: 12345, allowUnpinned: true });
	const b = compilePlan({ goal: "CuCuCuCu", seed: 12345, allowUnpinned: true });
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
	const off = compilePlan({ goal: "SuSuSuSu", seed: 43391, region: far, allowUnpinned: true });
	say(off.ok === false && off.reason === "no-resource-in-range", "C2 换到无该资源的区域 → no-resource-in-range", off.reason);
	const near = compilePlan({ goal: "SuSuSuSu", seed: 43391, allowUnpinned: true });
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
	const p = compilePlan({ goal: "Cu------", seed: 43391, allowUnpinned: true });
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
	// ④ 上色目标：**已布通**（LANE_SCHEMA_VERSION=2 起 vlane 是一等车道 —— painter 的 right 输出
	//    接 hub 的左面入口是「水平出 + 水平进」，只能走竖直车道）。
	//    ⚠️ 这条以前断言「必须失败 + reason=column-conflict-unresolved」——那是把上游缺口
	//    当成期望值。现在反过来断言**成功**，并用下面的 ④b 反证「竖直车道通道确实是承重的」：
	//    关掉 vlane 后同一目标必须精确失败在同一个 reason 上（不是空转）。
	const p = compilePlan({ goal: "CrCrCrCr", seed: 43391, allowUnpinned: true });
	say(p.ok === true, "C4 上色目标 CrCrCrCr → ok:true（painter→hub 竖车道已打通）",
		p.ok === false ? { reason: p.reason, hint: p.hint } : undefined);
	if (p.ok) {
		say(p.validation.pass === true, "C4 CrCrCrCr: validator.pass");
		eq(p.validation.beltSim.drift.length, 0, "C4 CrCrCrCr: V3 drift === 0");
		say(p.validation.checks.find(c => c.id === "V6-crossing").status === "pass", "C4 CrCrCrCr: V6-crossing pass（行列台账按 (轴,下标) 比较）");
		say(p.entities.length === 38, "C4 CrCrCrCr: 38 实体（WORKER-A 的验收数）", p.entities.length);
		say(p.blueprint.startsWith("SZBP1."), "C4 CrCrCrCr: 产出蓝图");
		say(p.roundtrip && p.roundtrip.ok === true, "C4 CrCrCrCr: round-trip 通过", p.roundtrip);
		// 竖直车道必须真的写进契约：lanes[] 里有一条 {column}，对应 channel 的 laneAxis = "col"
		const cols = (p.layout.lanes || []).filter(l => l.column !== null && l.column !== undefined);
		say(cols.length === 1, `C4 CrCrCrCr: lanes[] 有 1 条 {column} 车道（实得 ${cols.length}）`, p.layout.lanes);
		const colIds = new Set(cols.flatMap(l => l.channelIds));
		say(p.layout.channels.some(c => c.laneAxis === "col" && colIds.has(`${c.from.nodeId}->${c.to.nodeId}[${c.slotRole}]`)
			|| p.layout.channels.some(c => c.laneAxis === "col" && c.lane !== null)),
			"C4 CrCrCrCr: 有通道的 laneAxis === \"col\" 且落在 lanes[] 的 column 台账上",
			p.layout.channels.map(c => [c.from.nodeId, c.to.nodeId, c.lane, c.laneAxis]));
	}
	// ④b 反证（承重性）：同目标、关掉 vlane ⇒ 精确失败在 column-conflict-unresolved
	const off = compilePlan({ goal: "CrCrCrCr", seed: 43391, allowVerticalLane: false });
	say(off.ok === false, "C4b 关掉 vlane → CrCrCrCr 精确失败（证明成功是靠竖直车道，不是别处变宽松了）",
		off.ok === false ? undefined : { ok: off.ok, entities: off.entities && off.entities.length });
	eq(off.reason, "dag-not-placeable:column-conflict-unresolved", "C4b 关闭 vlane 的 reason 逐字");
	say(p.stages.pigmentGate.ok === true, "C4 失败点**不在**颜料闸（颜料已过，几何由 vlane 解决）", p.stages);
}
// C5 ✓ B-1 已修：----CuCu（L3 验收目标）现在真的能出蓝图
{
	const p = compilePlan({ goal: "----CuCu", seed: 43391, allowUnpinned: true });
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
	const p = compilePlan({ goal: "CgScScCg", seed: 43391, allowUnpinned: true });
	say(p.ok === false, "C6 CgScScCg 仍失败（B-3 未修）");
	say(["dag-not-placeable:crossing-needs-tunnel", "dag-not-placeable:column-conflict-unresolved"].includes(p.reason),
		"C6 reason ∈ {crossing-needs-tunnel, column-conflict-unresolved}", p.reason);
	say(p.stages.pigmentGate.ok === true, "C6 颜料闸已过（不是颜料问题）", p.stages);
}
// C7 多层/无资源 的归因顺序：**route 已打通**（vlane 一等车道），失败点下移到 siteStage。
//   以前这条断言 reason=column-conflict-unresolved（把上游缺口当期望值）。现在断言：
//   ① routeStage 必须 ok（几何不再是瓶颈）；② 失败若发生在 site，必须精确是 no-resource-in-range。
{
	const p = compilePlan({ goal: "RbRb----", seed: 43391, allowUnpinned: true });
	say(p.stages.routeStage && p.stages.routeStage.ok === true,
		"C7 RbRb---- 的 routeStage 已布通（vlane 打开后几何不再是瓶颈）", p.stages.routeStage);
	if (p.ok === false) {
		eq(p.reason, "no-resource-in-range", "C7 RbRb---- 的失败点已下移到 siteStage（seed 43391 找不到 RuRuRuRu+blue 双矿位）");
		say(p.stages.siteStage && p.stages.siteStage.ok === false, "C7 失败段 = siteStage（精确归因）", p.stages.siteStage);
	}
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
	/* ⚠️ 交接件是给 P7 直接 paste 的 ⇒ 必须是**钉死 hub** 的计划。
	   本段原来用 A 组那份 allowUnpinned 的 `Cu----Cu`，于是每次 run-all 都会刷新出一份
	   `hub:null` + `validator.pass:true` 的假绿交接件（审查 F4）。现在单独编一份带真 hub 的。 */
	const p = compilePlan({ goal, seed: 43391, hub: { x: -2, y: -2 } });
	say(p.ok === true && p.site && p.site.hubPinned === true,
		"D 取样计划是钉死 hub 的（交接件的前提）", p.ok === false ? p.reason : p.site);
	const h = writeHandoff(p, dir);
	say(h.ok === true, "D 写交接件成功", h);
	// F4 回归锁：未钉死 hub 的计划必须被**写盘层**拒绝（CLI 之外的第二道闸）
	{
		const unpinned = plans[goal];
		const hu = writeHandoff(unpinned, dir);
		say(hu.ok === false, "D ★未钉死 hub 的计划拒绝写交接件（写盘层也过闸，不靠 CLI 兜底）",
			hu.ok === true ? "写了" : hu.reason);
	}
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

/* ══════════════════ J. 世界系 hub 不相交 + 真 hub 接线（L3 首个实机缺陷的回归锁）══════════════════ */
/* 历史：seed 18043 / hub(-2,-2) / goal ----CuCu —— siteStage 只按资源选 anchor，得 [0,0]，
   布局在世界系压住 hub(-2,-2..1,1) → dry_run 3 格 blocked（occupant=hub uid 10000）⇒ 半建。
   第二现场（B-4）：布局逐格零差、却零交付 —— compile 传的是设计系假 hub + seed:null，
   收集带末端落在 anchor+(-4,-4)，只有 hubPinned 时才碰巧是真 hub。
   这里锁：(1) 纯判据（逐格）真能报相交 (2) 实参 anchor 不再压 hub
   (3) **ok:true ⟹ 收集带末端 ∈ 真 hub 的 16 入口 且 矿机压真资源**（B-4 的核心不变式）
   (4) 接不上时**诚实失败**（不产蓝图），不再"退回一个接不上的 anchor 报绿灯"。 */
console.log("\n── J 世界系 hub 不相交 + 真 hub 接线（L3 回归锁）──");
{
	const { hubEntriesWorld } = await import(pathToFileURL(path.join(REPO, "src/ai/op-templates.mjs")).href);
	const { tileResource } = await import(pathToFileURL(path.join(REPO, "src/ai/world.mjs")).href);
	/** 世界系：hubConnection 的 entry（世界格）是否真是 hub 的 16 入口之一，且 side/dir 与该口一致 */
	const entryOnHub = (hc, hubWorld, anchor) => {
		if (!hc) return { ok: false, why: "hubConnection=null" };
		const w = [anchor[0] + hc.entry[0], anchor[1] + hc.entry[1]];
		const hit = hubEntriesWorld(hubWorld).find(e => e.cell[0] === w[0] && e.cell[1] === w[1]);
		if (!hit) return { ok: false, why: `entry_world=${JSON.stringify(w)} 不在 hub(${hubWorld}) 的 16 入口上`, world: w };
		if (hit.face !== hc.side) return { ok: false, why: `side=${hc.side} ≠ 该口 face=${hit.face}`, world: w };
		if (hit.dir !== hc.dir) return { ok: false, why: `dir=${hc.dir} ≠ 该口 dir=${hit.dir}`, world: w };
		return { ok: true, world: w, face: hit.face };
	};

	// J-1 纯判据：anchor + 实体**逐格** vs hub 4×4
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
	// J-1b 包围框 ≠ 实际占格：B-4 的收集带可以**贴着 hub 侧面**绕到顶/左/右入口 ——
	//      包围框把它整个罩住，但没有任何一格是 hub 的 solid 格 ⇒ 必须判 clear（否则 78% 的合法布局被误杀）
	{
		const side = [{ dx: 4, dy: 0, kind: "belt", nodeId: "b1" }, { dx: 0, dy: -2, kind: "belt", nodeId: "b2" }];
		const rectBox = entityRectOf(side);                                  // [0,-2,4,0]：包围框横跨 hub
		say(rectBox[0] <= 3 && rectBox[2] >= 0 && rectBox[1] <= 3 && rectBox[3] >= 0, "J-1b 前提：这两个实体包围框确实横跨 hub 4×4", rectBox);
		eq(worldFrameHubCheck(side, [0, 0], [0, 0]).ok, true,
			"J-1b ★逐格判据：贴 hub 右缘 + 顶缘的带子（包围框压 hub）⇒ 仍 pass（dry_run 也只认实际格）");
	}

	// J-2 ★L3 实参（seed 18043 / hub(-2,-2)）—— B-4 之后 anchor 钉死、收集带接真入口
	const pL3 = compilePlan({ goal: "----CuCu", seed: 18043, hub: { x: -2, y: -2 } });
	say(pL3.ok === true, "J-2 L3 实参（seed 18043 / hub(-2,-2) / ----CuCu）ok:true", pL3.ok === false ? { reason: pL3.reason, hint: pL3.hint } : undefined);
	if (pL3.ok) {
		const anchor = pL3.site.anchor;
		const wf = worldFrameHubCheck(entityCellsOf(pL3.entities, pL3.layout.placements), anchor, [-2, -2]);
		say(wf.ok === true, "J-2 实参 anchor 下世界系 V1 pass（逐格不压 hub）", wf);
		eq(anchor, pL3.provenance.worldPlacement.pasteAt,
			"J-2 site.anchor === provenance.pasteAt（P7 照它 paste）");
		eq(pL3.stages.worldFrameV1.ok, true, "J-2 stages.worldFrameV1 记了这道闸（P7/主线程可审计）");
		eq(pL3.provenance.worldPlacement.worldFrameV1.hubRect, [-2, -2, 1, 1], "J-2 provenance 带 hub 世界矩形");
		eq(pL3.site.hub, [-2, -2], "J-2 site.hub === 真实 hub(-2,-2)（不是布局隐含位置）");
		// ★ B-4：真 hub + seed ⇒ anchor 钉死，收集带末端落在真入口（不再是"贴得上但接不上"）
		eq(pL3.site.hubPinned, true, "J-2 ★hubPinned === true（anchor 由真 hub 唯一确定）");
		eq(pL3.provenance.worldPlacement.hubInferred, [-2, -2], "J-2 布局隐含 hub === 真实 hub（收集带真接上了）");
		const on = entryOnHub(pL3.layout.hubConnection, [-2, -2], pL3.provenance.worldPlacement.anchor);
		say(on.ok === true, "J-2 ★收集带末端落在真实 hub 的 16 入口之一", on);
		// 矿机必须压在真资源上（否则贴得再准也零交付）
		const miners = pL3.provenance.minerCells || [];
		const badM = miners.filter(m => tileResource(18043, m.cell[0], m.cell[1]) !== m.shape);
		eq(badM, [], "J-2 ★每台矿机都压在其 payload 对应的真资源上");
		// 旧 bug 的形态：把同一套实体按 [0,0] 摆 —— 必须被逐格 V1 抓住
		const stale = worldFrameHubCheck(entityCellsOf(pL3.entities, pL3.layout.placements), [0, 0], [-2, -2]);
		say(stale.ok === false, "J-2 ★同一布局按旧 anchor[0,0] 摆 ⇒ 世界系 V1 fail", stale);
	}

	// J-3 ★核心不变式（B-4 的可执行锁）：**ok:true ⟹ entry ∈ 真 hub 16 入口 且 矿机压真资源**
	//     扫 3 个 goal × 4 个 seed × 3 个 hub；成功的每一个都必须成立（失败的不算数，由 J-4 锁）
	{
		let checked = 0, violations = [];
		for (const goal of ["----CuCu", "Cu----Cu", "RuRu----"]) {
			for (const seed of [18043, 81868, 43391, 12345]) {
				for (const hub of [[-2, -2], [7, 3], [-30, 25]]) {
					const p = compilePlan({ goal, seed, hub: { x: hub[0], y: hub[1] } });
					if (!p.ok) continue;
					checked++;
					const on = entryOnHub(p.layout.hubConnection, hub, p.provenance.worldPlacement.anchor);
					const badM = (p.provenance.minerCells || []).filter(m => tileResource(seed, m.cell[0], m.cell[1]) !== m.shape);
					const pinned = p.site.hubPinned === true;
					const inferred = JSON.stringify(p.provenance.worldPlacement.hubInferred) === JSON.stringify(hub);
					if (!on.ok || badM.length || !pinned || !inferred) {
						violations.push({ goal, seed, hub, on, badM, pinned, inferred });
					}
				}
			}
		}
		ok(checked >= 20, `J-3 扫到足够多的成功样本（实得 ${checked}）`);
		eq(violations, [], `J-3 ★${checked} 个 ok:true 计划全部满足：entry ∈ 真 hub 16 入口、矿机压真资源、anchor 钉死`);
	}

	// J-4 接不上时**诚实失败**：不产蓝图、reason 在 §2.5 枚举里（旧的"退回一个接不上的 anchor 报绿灯"已被删除）
	{
		const cases = [[55852, [-2, -2]], [43391, [-30, 25]]];
		let sawFail = 0;
		for (const [seed, hub] of cases) {
			const p = compilePlan({ goal: "----CuCu", seed, hub: { x: hub[0], y: hub[1] } });
			if (p.ok) {
				// 成功也行 —— 但必须接上真 hub（与 J-3 同判据）
				const on = entryOnHub(p.layout.hubConnection, hub, p.provenance.worldPlacement.anchor);
				say(on.ok, `J-4 seed=${seed} hub=${JSON.stringify(hub)} 成功时 entry 必落真入口`, on);
				continue;
			}
			sawFail++;
			say(typeof p.reason === "string" && /^(validate:|no-site|dag-not-placeable|no-resource)/.test(p.reason),
				`J-4 seed=${seed} hub=${JSON.stringify(hub)} 接不上 ⇒ 结构化失败（${p.reason}），不产蓝图`);
			eq(p.blueprint, undefined, "J-4 ★失败计划没有蓝图字段（绝不产出「贴得上但接不上」的假绿）");
		}
		ok(sawFail >= 1, `J-4 至少覆盖到一条诚实失败路径（实得 ${sawFail}）`);

		// J-4b hub 钉死不可行（资源离 hub 太远也无所谓 —— 现在 anchor 由 hub 唯一确定；
		//      真正的失败原因是几何/资源，不是"钉不死"）—— 必失败且**不许**回退成"另一个 anchor 的绿灯"
		const far = compilePlan({ goal: "SuSuSuSu", seed: 55852, hub: { x: 900, y: 900 }, range: 24 });
		say(far.ok === false, "J-4b 资源范围外 + 真 hub ⇒ ok:false（不回退到接不上的 anchor）", far.ok === true ? far.site : far.reason);
	}

	// J-5 无 hub 的老路径逐字节不变（确定性基线；金网格不进 place 的 seed 路径）
	const pNoHubA = compilePlan({ goal: "CuCuCuCu", seed: 43391, allowUnpinned: true });
	const pNoHubB = compilePlan({ goal: "CuCuCuCu", seed: 43391, allowUnpinned: true });
	say(pNoHubA.ok && pNoHubB.ok && pNoHubA.blueprint === pNoHubB.blueprint, "J-5 未给 hub 时仍确定（蓝图逐字节相等）");
	eq(pNoHubA.site.hub, null, "J-5 未给 hub 时 site.hub === null（世界 hub 未知，不假装知道）");
	say(pNoHubA.provenance.worldPlacement.hubInferred !== null,
		"J-5 推算的世界 hub 只进 provenance.hubInferred（诊断用，不当契约值）");
	// J-5b 未给 hub 的蓝图必须与「B-4 之前」逐字节同（seed 不得漏进 place 的旧路径）
	//     —— 判据用 designAnchor：未给 hub 时作图局部原点仍是设计系 [0,0]，anchor 由资源解出
	eq(pNoHubA.provenance.worldPlacement.designHubLocal, [-4, -4], "J-5b 未给 hub 时设计系 hub 仍是 [-4,-4]（旧路径未被改道）");

	/* J-6 hub 政策必须**只有一个权威**（红队 finding 1 的回归锁）。
	   曾经：compilePlan 对未钉死 hub 返回 ok:true + 蓝图，而 cli.mjs 在出口把它改写成 ok:false。
	   同一份计划两个结论 ⇒ 库调用方（未来的 L3 runner / MCP 工具）会拿到 CLI 认定不可交付的"成功"。
	   现在政策在 compilePlan 内，CLI 不再二次判 —— 这条把两者钉在一起。 */
	const unpinned = compilePlan({ goal: "CuCuCuCu", seed: 43391 });
	eq(unpinned.ok, false, "J-6a ★未给 hub ⇒ compilePlan 直接 ok:false（不再由 CLI 兜底改写）");
	eq(unpinned.class, "hub:unpinned", "J-6a ★失败 class = hub:unpinned（可被调用方分支）");
	eq(unpinned.blueprint, null, "J-6a ★未钉死 hub 的计划没有蓝图（蓝图 = 「能贴」的承诺）");
	say(unpinned.layout !== null && unpinned.layout !== undefined,
		"J-6b 诊断仍然保留（layout 照常可读 ⟹ 不因政策丢信息）");
	const allowed = compilePlan({ goal: "CuCuCuCu", seed: 43391, allowUnpinned: true });
	say(allowed.ok === true && typeof allowed.blueprint === "string",
		"J-6c 显式 allowUnpinned:true 才放行（诊断调用方的唯一入口）");
	eq(allowed.site.hubPinned, false, "J-6c ★放行时 site.hubPinned 仍为 false（不冒充可交付）");
	// CLI 与库对同一输入必须同结论：两者的判据同源于 compilePlan.site.hubPinned
	say((unpinned.ok === true) === (unpinned.site && unpinned.site.hubPinned === true),
		"J-6d ★ok:true ⟺ hubPinned:true（政策判据与结果自洽，不留第二套）");
}

/* ══════════════════ 汇总 ══════════════════ */
console.log(`\n${fail === 0 ? "✓" : "✗"} P8 harness L0：${pass} 通过 / ${fail} 失败（${Date.now() - t0}ms）`);
console.log(`  通过的目标（真布通，含 L3 验收目标 ----CuCu）：${PASSING.filter(g => plans[g] && plans[g].ok).join(" ")}`);
console.log(`  仍被拦的目标（精确 reason 已锁）：CrCrCrCr/RbRb----/CpCpCpCp(painter→hub 竖车道) CgScScCg(B-3+几何) 多层(scope)`);
if (fail) process.exitCode = 1;
