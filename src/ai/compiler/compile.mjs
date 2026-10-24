/**
 * compile.mjs — P8 `harness`：goal → 产线的**闭环编排**（顶层入口，永不 throw）。
 *
 * 权威依据：
 *   research/ai-player/plan-compiler.md §1.8（本包）/ §2.1 CompiledPlan / §2.3 LayoutReport /
 *     §2.4 ValidatorReport / §2.5 reason 枚举 / §2.6 WorldState / §4.6 交接协议 / §5 L3 门
 *   上游六包的**实际导出面**（逐文件读头注释与 export 清单核对，见 research/ai-plan/harness/NOTES.md）：
 *     P1 types/grid/errors · P2 op-templates/world · P3 place · P4 route · P5 validate · P6 emit
 *   禁改清单（plan §3）：proto/solver.mjs 零 export → **spawnSync 跑 CLI 消费**（`--json`）；
 *     proto/shape-ops.mjs 只读 import；本包的两个源文件都不引用那份已知错误的方向副本（P1 lint 把关）。
 *
 * 管线（每段一个函数，返回 {ok:true,…} 或 {ok:false,reason,failingNode,hint}）：
 *   inspectGoal → solveGoal(spawn solver) → mapOps(归一化 steps) → placeStage(P3)
 *     → routeStage(P4，lane-column 冲突 → 加宽 rowGap/colGap 重试，上限 ROUTE_RETRY_MAX)
 *     → siteStage(seed → 世界锚点) → validateStage(P5，**intent 永远带上**：plan-only = UNDECIDABLE)
 *     → emitStage(P6) → CompiledPlan
 *
 * 三条不可协商
 *   1. **永不 throw**：连契约级 ContractViolation 也收敛成结构化失败（plan §0）。
 *      唯一例外是 P4/P6 自己声明的「内部不变量破了」，那同样是 fail-closed：本包接住并如实报
 *      `upstream` 归因，**绝不静默修数据**（任务书：管线对上游违约输入要 fail-closed）。
 *   2. **100% 离线**（plan §4 第 2 条）：只有 spawnSync(node, [proto/solver.mjs]) 与 node: 内置。
 *      L3 实机执行是 P7 的活；本包只产 `harness/out/` 交接三件套（§4.6）。
 *   3. **绝不产出会堵死的蓝图**（redteam:158）：validator.pass!==true 或 drift 非空 → ok:false、
 *      blueprint:null，并且**不写 out/**（P7 拿到的必须已验证）。
 *
 * 零依赖：ESM + node: 内置 + 仓库内已批准模块。自测：`node research/ai-plan/harness/test.mjs`。
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeFailure, ContractViolation, validateReason } from "./errors.mjs";
import { SCOPE_V1, entityOrderPhase } from "./types.mjs";
import { ALL_TEMPLATES, RATES, codeFor } from "../op-templates.mjs";
import { tileResource, resourcesInRegion, regionAround, DEFAULT_SEED } from "../world.mjs";
import { place, PLACE_VERSION, ROW_H, COL_GAP } from "./place.mjs";
import { routeAll, ROUTE_SCHEMA_VERSION } from "./route.mjs";
import { validate, auditReport, VALIDATOR_VERSION } from "./validate.mjs";
import { emitPlan } from "./emit.mjs";
import { decodeBlueprint, summarizeBlueprint, blueprintCost } from "../../shared/blueprint.mjs";
// 只读复用（plan §2.4 S1「只 import 不改」）。⚠️ 方向真值一律走 src/ai/belt-rules.mjs（权威）；
// 此处只借形状代数层（parse/hash/cut/paint/stack），与方向无关。
import * as SHAPE_OPS from "../../../research/ai-player/proto/shape-ops.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
/** 求解器（禁改、零 export）：只能用 CLI 消费 */
export const SOLVER_PATH = path.join(REPO_ROOT, "research", "ai-player", "proto", "solver.mjs");
/** 交接区（P8 唯一写区；P7 只读这里、把结果写进 live/results/） */
export const HANDOFF_DIR = path.join(REPO_ROOT, "research", "ai-plan", "harness", "out");

export const HARNESS_VERSION = 1;

/* ═════════════════════════ 常量与门 ═════════════════════════ */

/**
 * **cutQuad 门控**（任务书明写「门控写进你的 code」）。
 * 来源：facts/human-strategies.md §2.2 —— cutter-quad 是 **L16** 建筑；
 *   proto/solver.mjs 默认**开着** cutQuad（:110 附近 `ops.cutQuad = !flag("--no-cutquad")`），
 *   于是 L≤11 的目标会被解成「看起来对但造不出来」的解（solver-README「关键修正」；
 *   plan §6 R4 / C13）。levels.js：level-11 = `CgScScCg`（存档实机 goal.level=11），
 *   quad cutter 要到 L16 才解锁 → **level < 16 一律 --no-cutquad**。
 */
export const CUTQUAD_MIN_LEVEL = 16;

/** 单层 goal → 该配方所需最低关卡（UNLOCK_LEVEL_FALLBACK 的关卡口径；用于门控与 V10 报告）。
 *  ⚠️ 这是**编译器侧的估计**，不是 levels.js 的逐关表：只用来决定 cutQuad 门控与解锁报告，
 *     不做「能不能通关」判定（plan §6 R4：定位 B god-mode 口径，交付数字必须带标注）。 */
export const MIN_LEVEL_FOR_OP = Object.freeze({
	mine: 1, cut: 1, rotate: 4, rotateCCW: 4, rotate180: 4, paint: 6, paintMirrored: 6, mix: 8, stack: 10,
});
export const MIN_LEVEL_FOR_QUAD = CUTQUAD_MIN_LEVEL;

/** route 失败重试上限（任务书：加宽 rowGap/colGap 重试，上限 N 次，仍败 → 结构化 ok:false） */
export const ROUTE_RETRY_MAX = 3;
/** 每次重试的加宽量（P3 NOTES §三：加宽 rowGap/colGap 是 lane-column 的既定自解法） */
export const GAP_STEP = Object.freeze({ rowGap: 2, colGap: 2 });

/** 通道铺格的串行顺序重试档位（P8 NOTES BUG-P3/P4-ORDER-STARVATION 的**缓解**，非上游修复）：
 *   "asis"   = 照 P3 的 DAG 序（默认，最尊重上游）
 *   "long"   = 按通道端点曼哈顿跨距降序（长线先占走廊）
 *   "short"  = 升序
 * 三档是纯函数确定的排序（同输入必同结果），不是随机试探。 */
export const CHANNEL_ORDER_MODES = Object.freeze(["asis", "long", "short"]);

/** goal 语法（逐字照 types.mjs:223 checkShortKeyGrammar / proto/shape-ops.mjs:26 parse）*/
const SUBS = "RCSW";
const COLORS = "rgbypcuw";

/** §2.5 里没有、但本包必须能表达的三类失败 —— 收敛到**最贴切的枚举项** + `class` 精确码
 *  （NOTES.md §2.5 缺口：建议 P1 增加 `solver:undecidable` / `solver:dag-unreconstructable`）。 */
export const UPSTREAM_REASON = Object.freeze({
	/** 上游产物 / 管线自身不一致（含 solver 进程与 --json 解析失败）。§2.5 无「管线内部」项，
	 *  emit:mismatch 是「产出的东西对不上」这一族里最贴切的；精确原因写进 class 字段。 */
	CONTRACT: "emit:mismatch",
	SOLVER_CLI: "emit:mismatch",                    // class=solver:cli-failed / solver:bad-json
	SOLVER_UNDECIDABLE: "unlock:machine-not-available", // class=solver:undecidable / solver:state-cap
	SOLVER_DAG_BAD: "validate:S1",                   // class=solver:dag-unreconstructable（配方重放不出父节点）
});

/* ═════════════════════════ 内部工具 ═════════════════════════ */

const isInt = Number.isInteger;
const cmpNum = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cmpStr = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });
/** 深拷贝（JSON 安全域内 —— 本包所有数据都是 plain JSON；确定性 & 不改入参） */
const clone = o => JSON.parse(JSON.stringify(o));
/** 规范化失败对象 + 兜底 reason（上游给了个不在 §2.5 的串时用） */
function fail(reason, node, hint) {
	try { return makeFailure(reason, node, hint); }
	catch (e) { return makeFailure(UPSTREAM_REASON.CONTRACT, node, `reason "${reason}" 不在 §2.5 枚举：${String((e && e.message) || e)}｜原建议：${hint || ""}`.slice(0, 400)); }
}
/** 把 ContractViolation / 任意异常收敛成结构化失败（永不 throw 的唯一手段）。 */
function absorb(err, stage, node, extraHint) {
	const cv = err instanceof ContractViolation;
	const messages = cv && Array.isArray(err.allMessages) ? err.allMessages.join(" ; ") : String((err && err.message) || err);
	return fail(UPSTREAM_REASON.CONTRACT,
		node ?? { nodeId: "", cell: null, check: "" },
		`${stage} 收到违约输入（${cv ? "契约" : "异常"}）：${messages}`.slice(0, 400) + (extraHint ? `｜${extraHint}` : "") +
		"｜**P8 不修数据**：归因见 research/ai-plan/harness/NOTES.md");
}

/** 从 goal 的 shortKey 反推配方所需 op 集合（只做门控与报告，不做判定）。 */
function opsImpliedByGoal(goal) {
	const set = new Set(["mine"]);
	const layers = String(goal).split(":");
	if (layers.length > 1) set.add("stack");
	for (const layer of layers) {
		for (let q = 0; q < 4; q++) {
			const sub = layer[q * 2], cc = layer[q * 2 + 1];
			if (sub === "-") continue;
			if (cc !== "u") set.add("paint");
		}
	}
	if (layers.length === 1) {
		const filled = [...Array(4).keys()].filter(q => layers[0][q * 2] !== "-");
		if (filled.length && filled.length < 4) set.add("cut");
		if (filled.length === 2 && Math.abs(filled[0] - filled[1]) === 1) set.add("cut");
	}
	return [...set].sort(cmpStr);
}

/**
 * 官方关卡表（facts/human-strategies.md §2.4 的 levels 表，逐项抄录）。
 * ⚠️ 关卡号**不能**从形状反推：`CgScScCg` 只需 mine/cut/paint，按 op 的解锁级算是 L6，
 *   但它是官方 **L11** 目标（还要求前面的 10 级都做完）。所以先查表，查不到才用 op 反推**下界**
 *   （下界只用于 cutQuad 门控与 V10 报告，不用于「能不能通关」的判定 —— plan §6 R4 定位 B）。
 */
export const OFFICIAL_LEVEL = Object.freeze({
	CuCuCuCu: 1, "----CuCu": 2, RuRuRuRu: 3, "RuRu----": 4, "Cu----Cu": 5,
	"Cu------": 6, CrCrCrCr: 7, "RbRb----": 8, CpCpCpCp: 9, ScScScSc: 10, CgScScCg: 11,
});

/** goal 的关卡：官方表优先，否则按配方 op 的解锁等级取**下界**。 */
export function levelForGoal(goal) {
	if (OFFICIAL_LEVEL[goal] !== undefined) return OFFICIAL_LEVEL[goal];
	const layers = String(goal).split(":");
	let lv = 1;
	if (layers.length > 1) lv = Math.max(lv, MIN_LEVEL_FOR_OP.stack);
	for (const op of opsImpliedByGoal(goal)) {
		const need = op.startsWith("cutQuad") ? MIN_LEVEL_FOR_QUAD : (MIN_LEVEL_FOR_OP[op] || 1);
		lv = Math.max(lv, need);
	}
	return lv;
}

/** goal 的象限是否为「非平凡的半/单象限」（可能需要 cutQuad 才能廉价解出来）。 */
function quadrantProfile(goal) {
	const layers = String(goal).split(":");
	return layers.map(layer => {
		const filled = [];
		for (let q = 0; q < 4; q++) if (layer[q * 2] !== "-") filled.push(q);
		return filled;
	});
}

/* ════════════════ Stage 0：goal 归一 / 校验 / 范围分类 ════════════════ */

/**
 * 校验 goal 并判定 v1 范围。**不 import shape-ops.parse 做语法判定**（离线纯字符串，快且确定），
 * 但 parse 用来做「能被代数层接受」的交叉自证（S1 的可解性前提）。
 * @param {string} goal
 * @returns {{ok:true, goal:string, layers:number, level:number, goalLayer:string}
 *          |{ok:false,reason,failingNode,hint}}
 */
export function inspectGoal(goal) {
	if (typeof goal !== "string" || goal === "") {
		return fail("out-of-scope:multilayer", { nodeId: "goal", cell: null, check: "V8-scope" },
			"goal 必须是非空 shortKey 字符串（例：\"----CuCu\" / \"CgScScCg\"）");
	}
	const layers = goal.split(":");
	for (let li = 0; li < layers.length; li++) {
		const text = layers[li];
		if (text.length !== 8) {
			return fail("out-of-scope:multilayer", { nodeId: `goal.layer${li}`, cell: null, check: "V8-scope" },
				`shortKey 每层恰 8 字符（4 象限 × [sub][color]），第 ${li} 层 "${text}" 长度 ${text.length}`);
		}
		for (let q = 0; q < 4; q++) {
			const sub = text[q * 2], cc = text[q * 2 + 1];
			if (sub === "-") continue;
			if (!SUBS.includes(sub)) {
				return fail("out-of-scope:multilayer", { nodeId: `goal.layer${li}`, cell: null, check: "V8-scope" },
					`象限 ${q} 的 sub "${sub}" ∉ R|C|S|W|-`);
			}
			if (!COLORS.includes(cc)) {
				return fail("out-of-scope:multilayer", { nodeId: `goal.layer${li}`, cell: null, check: "V8-scope" },
					`象限 ${q} 的 color "${cc}" ∉ r|g|b|y|p|c|u|w`);
			}
		}
	}
	// 代数层交叉自证（parse 不过 = 这串东西游戏里不存在）
	try { SHAPE_OPS.parse(goal); } catch (e) {
		return fail("out-of-scope:multilayer", { nodeId: "goal", cell: null, check: "V8-scope" },
			`proto/shape-ops.mjs parse 拒绝该 goal：${e && e.message}`);
	}
	if (layers.length > 1) {
		return fail("out-of-scope:multilayer", { nodeId: "goal", cell: null, check: "V8-scope" },
			`goal "${goal}" 有 ${layers.length} 层（':' 分隔）：v1 scope.layers=1（plan §0 范围裁决 / `
			+ `redteam:150 第 8 条）。solver 能解多层（solver-README），但**多层布局未做**（SYNTHESIS §5.2）`
			+ `⇒ 需要多台堆叠机串联 + 立体物流，归 v1.1。不硬凑、不静默近似。`);
	}
	return { ok: true, goal, layers: 1, level: levelForGoal(goal), goalLayer: goal, quadrants: quadrantProfile(goal)[0] };
}

/* ════════════════ Stage 1：solver（spawnSync 消费禁改的 proto/solver.mjs）════════════════ */

/**
 * 跑 `node proto/solver.mjs <goal> [--no-cutquad] --json`。
 * 门控：level < CUTQUAD_MIN_LEVEL ⇒ 必带 --no-cutquad（L≤11 合法解）；level ≥ 16 才允许开。
 * solver 的 `--json` 分支在**未解出**时也会打印 `{"solved":false,...}` 且 `process.exit(2)`
 * （solver.mjs:283 `process.exit(plan ? 0 : 2)`），所以 status!==0 不等于「跑挂了」。
 * @param {string} goal @param {{level?:number, noCutQuad?:boolean, depth?:number, maxStates?:number,
 *        resources?:string, colors?:string, timeoutMs?:number, execPath?:string}} [opts]
 * @returns {{ok:true, steps:object[], ops:Record<string,number>, stats:object, ms:number, argv:string[], solvedLevel:number}
 *          |{ok:false,reason,failingNode,hint}}
 */
export function solveGoal(goal, opts = {}) {
	const level = opts.level === undefined ? levelForGoal(goal) : opts.level;
	const useQuadGate = opts.noCutQuad !== false;   // 默认按 level 门控；显式 false = 强制开 cutQuad
	const argv = [SOLVER_PATH, goal];
	if (useQuadGate && level < CUTQUAD_MIN_LEVEL) argv.push("--no-cutquad");
	if (opts.resources) argv.push("--resources", String(opts.resources));
	if (opts.colors) argv.push("--colors", String(opts.colors));
	if (isInt(opts.depth)) argv.push("--depth", String(opts.depth));
	if (isInt(opts.maxStates)) argv.push("--max-states", String(opts.maxStates));
	argv.push("--json");

	let res;
	try {
		res = spawnSync(opts.execPath || process.execPath, argv, {
			cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
			timeout: opts.timeoutMs === undefined ? 180000 : opts.timeoutMs,
		});
	} catch (e) {
		return fail(UPSTREAM_REASON.SOLVER_CLI, { nodeId: "solver", cell: null, check: "" },
			`solver 进程无法启动：${e && e.message}`);
	}
	if (res.error) {
		const timed = res.error.code === "ETIMEDOUT";
		return fail(UPSTREAM_REASON.SOLVER_CLI, { nodeId: "solver", cell: null, check: "" },
			timed ? `solver 超时（${opts.timeoutMs}ms）：目标 ${goal} 的组合爆炸没在预算内收敛，可加 --depth/--max-states 或换目标`
				: `solver 进程错误：${res.error.message}`);
	}
	const out = (res.stdout || "").trim();
	if (!out) {
		return fail(UPSTREAM_REASON.SOLVER_CLI, { nodeId: "solver", cell: null, check: "" },
			`solver 无 JSON 输出（status=${res.status}）：${(res.stderr || "").slice(0, 300)}`);
	}
	let json;
	try { json = JSON.parse(out); } catch (e) {
		return fail(UPSTREAM_REASON.SOLVER_CLI, { nodeId: "solver", cell: null, check: "" },
			`solver 输出不是合法 JSON（status=${res.status}）：${e.message}｜头 200 字：${out.slice(0, 200)}`);
	}
	if (json.solved !== true || !json.plan || !Array.isArray(json.plan.steps)) {
		const st = json.stats || {};
		return fail(UPSTREAM_REASON.SOLVER_UNDECIDABLE, { nodeId: "solver", cell: null, check: "" },
			`solver 未能构造 ${goal}（深度 ${opts.depth ?? 7}，状态上限 ${opts.maxStates ?? 150000}）：`
			+ `已知形状 ${st.expanded ?? "?"}/生成 ${st.generated ?? "?"}/配对 ${st.stackPairs ?? "?"}`
			+ (st.capped ? " —— **触到状态上限**（可加大 --max-states / --depth 重试）" : " —— 在该预算内不可达")
			+ "｜归因：配方层（solver），不是布局层。");
	}
	if (res.status !== 0 && json.plan.steps.length) {
		return fail(UPSTREAM_REASON.SOLVER_CLI, { nodeId: "solver", cell: null, check: "" },
			`solver 输出自相矛盾：solved:true 却有非零退出码 ${res.status}（proto/solver.mjs:283 的 exit(plan?0:2) 破了）`);
	}
	return {
		ok: true,
		steps: json.plan.steps,
		ops: json.plan.ops || {},
		targetHash: json.plan.targetHash,
		stats: json.stats || {},
		known: json.known,
		ms: json.ms,
		argv,
		solvedLevel: level,
		cutQuadAllowed: !(useQuadGate && level < CUTQUAD_MIN_LEVEL),
	};
}

/* ════════════════ Stage 2：solver op → P3 归一化 steps（映射表在 P8）════════════════ */

/**
 * solver 的 op 名与编译器 op 名的**唯一**映射表（plan §1.8 明写「映射表在 P8 内」）。
 * solver 侧（proto/solver.mjs:100-124 / :163-197）：
 *   mine {}/cut{half:left|right}/cutQuad{quad:0..3}/rotate{dir:cw|ccw|180}
 *   paint{color}/stack{merge:true}（互补合并→**单层**）/stack{layers:true}（多层堆叠）
 * ⚠️ stack 的两个 args 形态语义不同：merge=单层合并（v1 支持，M4 实机验证）、
 *   layers=多层堆叠（scope.layers=1 → 拒）。plan §2.2 的 op 枚举里**没有** mix ——
 *   solver 把颜料混色折进 paint 的 color 参数（solver-README「缺口：应插入 mix 节点」），
 *   故 `mix` 只在映射表登记、正常配方不会出现（出现即上游改了语义 → 走 scope 拒绝，不猜）。
 * rotate 的三形态是**三个建筑码**（11/12/13），不是同一个 op：variant 决定 op 名。
 */
export const OP_MAP = Object.freeze({
	mine: { op: "mine", args: () => ({}) },
	cut: { op: "cut", args: s => ({ half: s.args && s.args.half === "right" ? "right" : "left" }) },
	cutQuad: { op: "cutQuad", args: s => ({ quad: (s.args && s.args.quad) | 0 }), outOfScope: "quad cutter 是 L16 建筑（human-strategies §2.2）且 4 路输出无 v1 汇合模板（ADVERSARIAL:162-164 / plan §6 R5）" },
	rotate: {
		op: "rotate",
		variant: s => ({ cw: "rotate", ccw: "rotateCCW", "180": "rotate180" }[(s.args && s.args.dir) || "cw"] || "rotate"),
		args: () => ({}),
	},
	paint: { op: "paint", args: s => ({ color: s.args && s.args.color }) },
	mix: { op: "mix", args: s => ({ colors: (s.args && s.args.colors) || [] }), outOfScope: "mix 的颜料闭包在 solver 里被折进 paint.color（solver-README 缺口 1），配方层出现独立 mix 节点说明上游语义已变" },
	stack: {
		op: "stack",
		args: s => (s.args && s.args.layers === true ? { layers: true } : { merge: true }),
		reject: s => !!(s.args && s.args.layers === true),
	},
});

/**
 * 重建出的 dag（{hash,op,args,depth,parents}）→ P3 的归一化 steps
 * `{id,op,args,inputs,hash,depth}`。P3 约定（place.mjs buildDag 头注）：**inputs 元素 = 上游节点
 * hash**；查不到 hash 的输入被当成资源 shortKey → 自动合成矿机。本包走**显式 mine 节点**这条路
 * （parents=[] 的 mine），因为 id 可控、且 rebuildDag 已经校验过每个 hash 的代数一致性。
 * ⚠️ stack 的 parents **保序**：lower=parents[0]、upper=parents[1]（GEOMETRY:18 的槽位→层映射是
 *   实机确认的硬事实，顺序错了产物层数就反；plan §7.1-1）。
 * @returns {{ok:true, steps:object[], opNames:string[]} | {ok:false,reason,failingNode,hint}}
 */
export function mapOps(dagResult) {
	if (!dagResult || dagResult.ok !== true || !Array.isArray(dagResult.dag)) {
		return fail(UPSTREAM_REASON.CONTRACT, { nodeId: "mapOps", cell: null, check: "" }, "mapOps 需要先成功的 rebuildDag 结果");
	}
	const out = [];
	const names = new Set();
	for (const [i, s] of dagResult.dag.entries()) {
		// ── 颜料节点：`mineColor` → 矿机（采纯色矿）；`mix` → mixer（两 bottom 进、top 出）──
		//    hash 用 rebuildDag 分配的 shortKey token（P3 只认这个空间；见 rebuildDag 头注）。
		if (s.kind === "pigment") {
			const op = s.op === "mineColor" ? "mine" : s.op;
			if (op !== "mine" && op !== "mix") {
				return fail("out-of-scope:wire", { nodeId: s.hash, cell: null, check: "V8-scope" },
					`未知颜料 op "${s.op}"（只认 mineColor/mix）`);
			}
			const tpl = ALL_TEMPLATES[op];
			if (!tpl) return fail("out-of-scope:wire", { nodeId: s.hash, cell: null, check: "" }, `op "${op}" 不在 op-templates`);
			names.add(op);
			out.push({
				id: s.hash, op, hash: s.hash, depth: isInt(s.depth) ? s.depth : 0,
				args: op === "mix" ? { colors: (s.inputs || []).map(h => (dagResult.dag.find(x => x.hash === h) || {}).color).filter(Boolean) } : {},
				// mine 无输入；mix 的两条颜料输入即它的两个 bottom 槽（顺序 = solver 的 [a,b]，去重后保序）
				inputs: op === "mine" ? [] : (s.inputs || []).slice(),
				kind: "pigment", color: s.color, solverHash: s.solverHash,
				_solverOp: s.op, _solverArgs: clone(s.args || {}),
			});
			continue;
		}

		const spec = OP_MAP[s.op];
		if (!spec) {
			return fail("out-of-scope:wire", { nodeId: `n${i}`, cell: null, check: "V8-scope" },
				`solver 发了未知 op "${s.op}"（映射表只认 ${Object.keys(OP_MAP).join("/")}）：P8 不猜语义，`
				+ `上游（proto/solver.mjs 的 op 集合）若已改动，回来更新本表`);
		}
		if (spec.reject && spec.reject(s)) {
			return fail("out-of-scope:multilayer", { nodeId: `n${i}`, cell: null, check: "V8-scope" },
				`${s.op}(${JSON.stringify(s.args)}) 是**多层堆叠**（args.layers=true）：v1 scope.layers=1。`
				+ `单层互补合并（args.merge=true）才是 M4 实机验证过的形态。`);
		}
		if (spec.outOfScope) {
			return fail("unlock:machine-not-available", { nodeId: `n${i}`, cell: null, check: "V8-scope" },
				`${s.op}：${spec.outOfScope}（level<${CUTQUAD_MIN_LEVEL} 时本包的 --no-cutquad 门本该把它挡在求解层，见 solveGoal）`);
		}
		const op = spec.variant ? spec.variant(s) : spec.op;
		names.add(op);
		if (!ALL_TEMPLATES[op]) {
			return fail("out-of-scope:wire", { nodeId: `n${i}`, cell: null, check: "V8-scope" },
				`映射后的 op "${op}" 不在 op-templates（ALL_TEMPLATES）里`);
		}
		out.push({
			id: `n${i}`, op, hash: s.hash, depth: isInt(s.depth) ? s.depth : null,
			args: spec.args(s),
			// P3 的约定：inputs 元素 = 上游节点 hash。solver 已给（形状或颜料 token），直接采用。
			inputs: s.op === "mine" ? [] : (s.inputs || []).slice(),
			kind: "shape",
			_solverOp: s.op, _solverArgs: clone(s.args || {}),
		});
	}
	return { ok: true, steps: out, opNames: [...names].sort(cmpStr) };
}

/** dag → S1 判据要的形态（P5 的 shapeReplay 吃 {hash,op,args,parents}）。
 * ⚠️ **只保留形状节点**：颜料是 `ColorItem`，不是形状；且颜料 token 的 parse∘hash 会塌成空形状
 *    （solver-README §1.2 理由 2），留在 S1 里必然假红。`paint` 的 parents 也只留形状（applyOp 只用 [0]）。 */
export function dagForS1(dagResult) {
	const pigmentHashes = new Set(
		(dagResult.dag || []).filter(s => s.kind === "pigment").flatMap(s => [s.hash, s.solverHash].filter(Boolean)));
	return (dagResult.dag || [])
		.filter(s => s.kind !== "pigment")
		.map(s => ({
			hash: s.hash,
			op: s.op,
			args: clone(s.args || {}),
			// 只留形状输入（颜料输入不是形状，S1 的 applyOp 也只用 parents[0]）
			parents: (s.inputs || []).filter(h => !pigmentHashes.has(h)),
			nodeId: `n${s.hash}`,
		}));
}

/* ════════════════ Stage 2a：solver steps → 编译期 DAG（采用 inputs + 颜料 token 化）════════════ */

/**
 * ★ 颜料契约（solver 4e60013 起）★
 * solver 的 steps 现在**自带 `inputs`**，且颜料是**一等节点**：
 *   形状节点  hash=<shortKey>      op ∈ mine/cut/cutQuad/rotate(cw|ccw|180)/paint/mix/stack
 *   颜料节点  hash=color:<name>    op ∈ mineColor/mix    kind="pigment"
 *   paint.inputs = [shape, pigment]   mix.inputs = [colorA, colorB]   stack.inputs = [lower, upper]
 *
 * P8 这边要做三件事（都不改 P1/P3）：
 *
 * 1. **采用 solver 的 inputs**，不再猜父节点（旧版靠 shape-ops 搜索重建；现在边信息在上游，
 *    猜是多余的风险）。但仍**用形状代数自证**：每个形状节点重算一遍，hash 对不上 → 结构化拒。
 *
 * 2. **颜料节点 → 合法 shortKey token**。`color:<name>` 进不了 P3：
 *    · `channels[].payload` 被 P1 的 checkShortKeyGrammar 强制为 shortKey（types.mjs:597）；
 *    · P3 的 buildDag 要求 hash 唯一，而颜料可能被多个上色器共享（同一 color:<name> 出现多次）。
 *    解法：把颜色字符塞进**第 k 个象限的空位**，sub 保持 `'-'`：`-c------`、`--c-----`、…
 *    · 语法：每层 8 字符 = 4×[sub][color]，sub='-' 时 color 可任意 ⇒ 合法；
 *    · 代数：`parse('-c------')` 的 sub 是 '-' ⇒ 解析成空形状（`--------`），**不污染形状空间**；
 *    · 唯一性：同色第 k 份副本站第 k 个象限 ⇒ 与同名其它副本 hash 不同 ⇒ 过 P3 的唯一闸。
 *
 * 3. **共享颜料 = 复制矿机，不是扇出**（solver-README §3.4-3 / §3.5 实测：扇出会被 P3 判
 *    `crossing-needs-tunnel`）。每个消费者拿一份独立 token ⇒ 独立矿机 + 独立矿位。
 *
 * @param {object[]} steps solver 的原始 steps（带 inputs）
 * @returns {{ok:true, dag:object[], pigments:object[], tokens:Map<string,string>} | failure}
 */
export function rebuildDag(steps) {
	if (!Array.isArray(steps) || steps.length === 0) {
		return fail(UPSTREAM_REASON.SOLVER_DAG_BAD, { nodeId: "", cell: null, check: "" }, "solver 的 steps 为空");
	}
	const COLOR_CODE = { red: "r", green: "g", blue: "b", yellow: "y", purple: "p", cyan: "c", white: "w" };
	const MAX_COPIES = 4;                          // 4 个象限 ⇒ 每色最多 4 份独立矿机

	/**
	 * `color:<name>` + 副本号 → 合法 shortKey token。
	 * 形态 = 4 个 `[sub][color]` 对（每对 2 字符）；第 k 个副本把**颜色字符放进第 k 对的 color 位**
	 * （即下标 `2k+1`），其余字符全 `'-'`。例：k=0 → `--g-----`?
	 * ⚠️ 不能把颜色字符放到 sub 位（偶数下标）—— 那会让 `sub='g'` 触发语法闸
	 * （types.mjs:223 的 `sub ∈ R|C|S|W|-`）。颜色位才是唯一合法落点。
	 */
	const tokenFor = (color, k) => {
		const cc = COLOR_CODE[color];
		if (!cc || !isInt(k) || k < 0 || k >= MAX_COPIES) return null;
		const chars = ["-", "-", "-", "-", "-", "-", "-", "-"];
		chars[k * 2 + 1] = cc;                     // 第 k 对的 color 位
		return chars.join("");
	};

	/** solver 侧：hash -> step */
	const bySolverHash = new Map();
	for (const s of steps) bySolverHash.set(s.hash, s);
	const isPigment = s => !!(s && (s.kind === "pigment" || s.op === "mineColor"
		|| (typeof s.hash === "string" && s.hash.startsWith("color:"))));

	/**
	 * ① 统计每个颜料被**几条消费边**引用（`paint` 的 color 槽 / `mix` 的每个输入）。
	 *   为什么按边而不是按节点：P3 的 buildDag 不允许扇出（一个 hash 只能有一条出边），
	 *   而同一颜料天然会被多台上色器共享（CgScScCg 的 green 同时进 mix 与 paint）。
	 *   ⇒ 每条消费边一份独立副本（各自一台矿机 + 独立矿位），这是 v1 唯一可布的形式。
	 */
	const demand = new Map();                      // color -> 需要几份
	const consumers = new Map();                   // color -> [消费者 step.hash]
	for (const s of steps) {
		if (isPigment(s)) continue;
		for (const h of (s.inputs || [])) {
			const up = bySolverHash.get(h);
			if (!isPigment(up)) continue;
			const color = (up.args && up.args.color) || String(h).replace(/^color:/, "");
			demand.set(color, (demand.get(color) || 0) + 1);
			if (!consumers.has(color)) consumers.set(color, []);
			consumers.get(color).push(s.hash);
		}
	}
	// 每色最多 MAX_COPIES 份；超了就是配方异常（同一个颜色喂 >4 台上色器）
	for (const [color, n] of demand) {
		if (n > MAX_COPIES) {
			return fail(UPSTREAM_REASON.CONTRACT, { nodeId: `pigment:${color}`, cell: null, check: "" },
				`颜料 ${color} 被 ${n} 个消费者引用（${consumers.get(color).join(", ")}），`
				+ `超过 token 空间的 ${MAX_COPIES} 份：v1 的「共享颜料 → 复制矿机」放不下，需 P1 给 payload 定契约（NOTES §3）`);
		}
	}

	/**
	 * ② 展开原料链：`color:<name>` 的**第 k 份副本**节点（包括 mix 的两个上游也要复制）。
	 *    返回该副本的 token；同 (color,k) 只建一次（mix 复用上游副本时不重复建节点）。
	 */
	const out = [];
	const pigments = [];
	const alias = new Map();                        // `${solverHash}#${k}` -> token
	const copyCount = new Map();                    // color -> 下一个可用副本号（按消费顺序递增）

	const buildPigmentCopy = (color, k, depth = 0) => {
		const key = `color:${color}#${k}`;
		if (alias.has(key)) return alias.get(key);
		const token = tokenFor(color, k);
		if (!token) return null;
		const up = bySolverHash.get(`color:${color}`);          // solver 侧的颜料节点（mineColor 或 mix）
		if (!up) return null;
		let inputs = [];
		let op = up.op;
		if (op === "mix") {
			// 混色的两个原色：各自也需要**本副本专属**的矿机（不能共享，否则又一次扇出）
			const srcColors = (up.inputs || []).map(h => {
				const n = bySolverHash.get(h);
				return (n && n.args && n.args.color) || String(h).replace(/^color:/, "");
			});
			for (const sc of srcColors) {
				const scK = copyCount.get(sc) || 0;
				copyCount.set(sc, scK + 1);
				const t = buildPigmentCopy(sc, scK, depth + 1);
				if (!t) return null;
				inputs.push(t);
			}
		}
		const node = {
			id: token, hash: token, color, op, args: { color }, inputs,
			depth: isInt(depth) ? depth : 0, kind: "pigment", solverHash: `color:${color}`, copy: k,
		};
		alias.set(key, token);
		pigments.push({ color, token, from: op, inputs: inputs.slice(), copy: k });
		out.push(node);
		return token;
	};

	/** 为一次消费分配该颜色的下一份副本 */
	const allocPigment = (color) => {
		const k = copyCount.get(color) || 0;
		copyCount.set(color, k + 1);
		return buildPigmentCopy(color, k, 0);
	};

	/**
	 * ③ 按 solver 的依赖序走一遍，形状节点直接产出；颜料输入按消费边各取一份新副本。
	 */
	const byHash = new Map();                       // solver hash -> 本包节点（形状）
	const compute = (op, args, parentShapes) => {
		switch (op) {
			case "mine": return SHAPE_OPS.parse(args.__hash);
			case "cut": {
				const h = SHAPE_OPS.cutHalf(parentShapes[0]);
				return args.half === "left" ? h[0] : h[1];
			}
			case "cutQuad": return SHAPE_OPS.cutQuad(parentShapes[0])[args.quad | 0];
			case "rotate": {
				const d = args.dir || "cw";
				return d === "ccw" ? SHAPE_OPS.rotateCCW(parentShapes[0]) : d === "180" ? SHAPE_OPS.rotate180(parentShapes[0]) : SHAPE_OPS.rotateCW(parentShapes[0]);
			}
			case "paint": case "paintMirrored": return SHAPE_OPS.paint(parentShapes[0], args.color);
			case "stack": return SHAPE_OPS.stack(parentShapes[0], parentShapes[1]);
			default: return null;
		}
	};

	for (const [i, s] of steps.entries()) {
		if (isPigment(s)) continue;                  // 颜料节点在第 ② 步按消费边展开，这里跳过

		const inputs = Array.isArray(s.inputs) ? s.inputs.slice()
			: (Array.isArray(s.parents) ? s.parents.slice() : []);
		const resolved = [];
		for (const h of inputs) {
			const up = bySolverHash.get(h);
			if (isPigment(up)) {
				const color = (up.args && up.args.color) || String(h).replace(/^color:/, "");
				const t = allocPigment(color);
				if (!t) {
					return fail(UPSTREAM_REASON.CONTRACT, { nodeId: `${s.hash}`, cell: null, check: "" },
						`为 ${s.hash} 的颜料输入 ${color} 分配副本失败（该色已用满 ${MAX_COPIES} 份）`);
				}
				resolved.push(t);
			} else {
				if (!byHash.has(h)) {
					return failReason(UPSTREAM_REASON.SOLVER_DAG_BAD, `n${i}`,
						`${s.hash} 的形状输入 ${h} 尚未出现（solver 的 steps 不是依赖序）`,
						{ class: "solver-dag-unreconstructable", step: i });
				}
				resolved.push(h);
			}
		}

		const node = {
			id: s.hash, hash: s.hash, op: s.op, args: clone(s.args || {}),
			inputs: resolved, depth: isInt(s.depth) ? s.depth : null,
			kind: "shape", solverHash: s.hash, instanceIdx: 0,
		};
		byHash.set(s.hash, node);

		// 自证：形状部分必须能被形状代数重算（颜料不参与形状运算）
		const shapeParents = resolved
			.map(h => byHash.get(h)).filter(n => n && n.kind === "shape")
			.map(n => SHAPE_OPS.parse(n.hash));
		const args = { ...(s.args || {}), __hash: s.hash };
		let got = null;
		try { got = compute(s.op, args, shapeParents.slice(0, s.op === "stack" ? 2 : 1)); } catch { /* 下面统一报 */ }
		const expectShape = got ? SHAPE_OPS.hash(got) : null;
		if (expectShape !== s.hash) {
			return failReason(UPSTREAM_REASON.SOLVER_DAG_BAD, `n${i}`,
				`solver 的 step ${i}（${s.op} ${JSON.stringify(s.args || {})} → ${s.hash}）用形状代数重算得 ${expectShape ?? "(无法重算)"}`,
				{ class: "solver-dag-unreconstructable", step: i });
		}
		out.push(node);
	}

	return { ok: true, dag: out, pigments, demand: Object.fromEntries(demand) };
}

/* ════════════════ Stage 2½：颜料供料闸（接新契约后：校验〉补数据）════════════════ */

/**
 * solver 4e60013 起颜料是**一等节点**（`mineColor` / `mix`，hash=`color:<name>`），
 * `paint.inputs = [shape, pigment]`。所以本闸的职责从「发现颜料缺失就拒」变成**三件事**：
 *
 *   1. **painter 必须真的拿到颜料**：`paint` 的输入槽数（模板 2 个：shape/color）必须都有上游。
 *      这是旧 B-2 的护栏 —— 如果将来 solver 又退回「颜料折进 args」，这里立刻报，不会悄悄放行。
 *   2. **颜料输入必须指向颜料节点**：`paint.inputs[1]` 对应的节点 `kind === "pigment"`；
 *      指到形状上 = 配方错，拒（不猜）。
 *   3. **mixer 必须有两个颜色输入**（模板 2 个 bottom），且都必须是颜料节点。
 *
 * `mineColor` 不在这里校验 —— 它就是矿机，矿位由 siteStage 按 `color` 与 `tileResource` 对拍。
 *
 * @param {object[]} dag rebuildDag 的 dag（节点已 token 化，含 kind/color）
 * @returns {{ok:true}|failure}
 */
export function checkPigments(dag) {
	const byHash = new Map((dag || []).map(n => [n.hash, n]));
	for (const step of dag || []) {
		if (step.kind === "pigment") {
			// mix 的两个输入必须是「更早出现的颜料节点」
			if (step.op === "mix") {
				const ins = step.inputs || [];
				if (ins.length !== 2) {
					return fail(validateReason("V4-slot-alignment"),
						{ nodeId: step.hash, cell: null, check: "V4-slot-alignment" },
						`mix(${step.color}) 需要 2 个颜色输入（mixer 两个 bottom），实得 ${ins.length}`);
				}
				for (const h of ins) {
					const up = byHash.get(h);
					if (!up || up.kind !== "pigment") {
						return fail(validateReason("V4-slot-alignment"),
							{ nodeId: step.hash, cell: null, check: "V4-slot-alignment" },
							`mix(${step.color}) 的输入 ${h} 不是颜料节点（实得 ${up ? up.kind : "不存在"}）`);
					}
				}
			}
			continue;
		}

		const tpl = ALL_TEMPLATES[step.op];
		if (!tpl) continue;                                  // 未知 op 归 mapOps
		const needs = (tpl.inputs || []).length;
		const has = (step.inputs || []).length;
		if (has < needs) {
			const slots = (tpl.inputs || []).map(x => x.role);
			return fail(validateReason("V4-slot-alignment"),
				{ nodeId: step.hash, cell: null, check: "V4-slot-alignment" },
				`${step.op}(${JSON.stringify(step.args || {})}) → ${step.hash} 有 ${needs} 个输入槽`
				+ `（${slots.join("/")}）但只给了 ${has} 个上游，空槽 ${slots.slice(has).join("/")} 无供料：`
				+ (step.op === "paint"
					? `颜料是**独立物流**（GEOMETRY 表3 规则 6）。solver 现在应当产出 mineColor/mix 节点；`
					+ `若这里报错，说明配方层又退回了「颜料折进 args.color」（solver-README §1 的旧缺口）`
					: `该 op 的第 ${has} 个输入槽缺上游`));
		}
		// painter 的第 2 输入必须是颜料节点
		if (step.op === "paint" && has >= 2) {
			const pig = byHash.get(step.inputs[1]);
			if (!pig || pig.kind !== "pigment") {
				return fail(validateReason("V4-slot-alignment"),
					{ nodeId: step.hash, cell: null, check: "V4-slot-alignment" },
					`paint(${step.hash}) 的 color 槽输入 ${step.inputs[1]} 不是颜料节点（实得 ${pig ? pig.kind : "不存在"}）`);
			}
			if (pig.color !== (step.args && step.args.color)) {
				return fail(validateReason("V4-slot-alignment"),
					{ nodeId: step.hash, cell: null, check: "V4-slot-alignment" },
					`paint(${step.hash}) 要 ${step.args && step.args.color}，但 color 槽接的是 ${pig.color}`);
			}
		}
	}
	return { ok: true };
}

/* ════════════════ Stage 3：place（P3）════════════════ */

/**
 * P3 作图。**单一坐标系 = 设计系**（site=[0,0]，hub 用设计坐标 hubDesign）：
 *   · 80e1444 之后 place() 的 LayoutReport 是 site 相对局部系，一切世界输入在门口按 origin 换算；
 *     所以 hub 与 world 必须给**同一个框**，否则 occupancy 与机器混框 → V4 假 fail
 *     （本包一度报「(0,3) 不是 hub 的输入槽」，就是这个混框的现场，见 NOTES.md C-1）。
 *   · world 必须一起传：place 靠它产出 occupancy（设计系的 hub 16 格 solid），
 *     P5 的 V1/V3/V4 与 P7 的对拍全在这一个框里。
 *   · validateWorld（place.mjs:177）对「entities 里有非 hub 实体」直接返回
 *     out-of-scope:rotated-machine（v1 不增量对接旧厂，plan §6 R2）—— 本包只灌一台 hub。
 * @returns {{ok:true, layout:object, hubDesign:number[]} | failure}
 */
export function placeStage(steps, ctx) {
	const input = {
		steps: clone(steps),
		// 单一坐标系：设计系（site = [0,0]，hub 用设计坐标 hubDesign）。
		// world 必须一起传：place 的 occupancy = world 实体 − origin（= 设计系 16 格 hub），
		// P5 的 V1/V3/V4 与 P7 的对拍全在这一个框里（NOTES.md 坐标口径）。
		site: { x: 0, y: 0 },
		hub: { x: ctx.hubDesign[0], y: ctx.hubDesign[1] },
		world: hubWorldState(ctx.hubDesign, null),
		rowGap: ctx.rowGap, colGap: ctx.colGap,
		demandPerSec: ctx.demandPerSec || 0,
		instanceIdx: 0,
	};
	let rep;
	try { rep = place(input); }
	catch (e) { return absorb(e, "place(P3)", { nodeId: "", cell: null, check: "V1-occupancy" }, "P3 抛了未收敛的契约错"); }
	if (rep.ok === false) return rep;
	return { ok: true, layout: rep, hubDesign: ctx.hubDesign.slice() };
}

/* ════════════════ Stage 4：route（P4）+ 加宽重试 + 通道序重试 ════════════════ */

/** 端点跨距（曼哈顿），用于「长线先占走廊」的确定排序 */
function channelSpan(ch) {
	return Math.abs(ch.to.cell[1] - ch.from.cell[1]) + Math.abs(ch.to.cell[0] - ch.from.cell[0]);
}
/** 按模式重排 channels（纯函数、三重 tie-break ⇒ 确定）。不改入参。 */
export function orderChannels(layout, mode) {
	const chs = (layout.channels || []).slice();
	if (mode === "asis") return chs;
	const tagged = chs.map((c, i) => ({ c, i, span: channelSpan(c), id: `${c.from.nodeId}->${c.to.nodeId}#${c.ordinal === undefined ? i : c.ordinal}` }));
	tagged.sort((a, b) => (mode === "long" ? b.span - a.span : a.span - b.span) || cmpStr(a.id, b.id) || a.i - b.i);
	return tagged.map(t => t.c);
}

/** P3 上报的 lane-column 冲突是否非空（任务书的重试触发条件）。 */
export function laneColumnConflicts(layout) {
	return (layout.conflicts || []).filter(c => c && c.kind === "lane-column");
}

/**
 * 路由 + 「冲突 → 加宽 rowGap/colGap 重试」闭环（plan §1.3/§1.4：加宽行距是 v1 唯一的冲突自解法）。
 * 重试上限 ROUTE_RETRY_MAX；仍失败 → 结构化 ok:false（reason 直接取 P4 的 §2.5 串）。
 * 档位序：(gapTries × orderModes) 的确定性笛卡尔积，**先窄后宽、每档先 asis 后重排**，
 * 取第一个成功档 —— 同一输入永远走同一路径（L0 验收 2 的确定性锁）。
 * @returns {{ok:true, layout:object, route:object, gapTries:number, orderMode:string} | failure}
 */
export function routeStage(placeResult, ctx) {
	if (placeResult.ok === false) return placeResult;
	let rowGap = ctx.rowGap, colGap = ctx.colGap;
	const log = [];
	let last = null;
	const gapTries = ROUTE_RETRY_MAX + 1;                       // 首档 + 加宽 N 次
	for (let g = 0; g < gapTries; g++) {
		let placed = g === 0 ? placeResult : placeStage(ctx.steps, { ...ctx, rowGap, colGap });
		if (placed.ok === false) { last = placed; return placed; }
		for (const mode of CHANNEL_ORDER_MODES) {
			const layout = mode === "asis" ? placed.layout : { ...placed.layout, channels: orderChannels(placed.layout, mode) };
			let ro;
			try { ro = routeAll(layout, { hubOrigin: ctx.hubDesign.slice(), searchRadius: ctx.searchRadius }); }
			catch (e) { return absorb(e, "route(P4)", { nodeId: "", cell: null, check: "V4-slot-alignment" }, "P4 抛了未收敛的契约错"); }
			log.push({ gap: g, rowGap, colGap, order: mode, ok: ro.ok, reason: ro.reason, laneColumn: laneColumnConflicts(layout).length, belt: ro.beltTiles, corners: ro.cornerCount });
			if (ro.ok && ro.closure && ro.closure.ok) {
				// 取 P4 更新后的报告（lanes/conflicts/cornerCount 已记账），但不接受它残留的 lane-column 冲突
				const rep = ro.report;
				return {
					ok: true, layout: rep, route: ro, gapTries: g, orderMode: mode,
					rowGap, colGap, attempts: log,
					laneColumnUnresolved: laneColumnConflicts(rep).length,
				};
			}
			last = ro.ok === false ? ro : { ok: false, ...fail("dag-not-placeable:column-conflict-unresolved",
				{ nodeId: "", cell: null, check: "V6-crossing" }, "routeAll.ok=true 但链闭合失败（P4 内部不变量）") };
		}
		rowGap += GAP_STEP.rowGap; colGap += GAP_STEP.colGap;
	}
	if (last && last.ok === false && typeof last.reason === "string" && last.reason.includes(":")) return last;
	return fail("dag-not-placeable:column-conflict-unresolved",
		{ nodeId: "", cell: null, check: "V6-crossing" },
		`加宽 rowGap/colGap 重试 ${ROUTE_RETRY_MAX} 次（${log.length} 档）仍未布通：最后一因 `
		+ `${last && last.reason ? last.reason : "?"}｜v1 只用「水平错位 + 加宽行距」（plan §1.4），需要隧道/立体绕行即显式拒绝（scope.tunnels:false）。`);
}

/** 世界选址的搜索中心（默认原点；给了 --site 就用它，成功失败都可复现）。 */
function normalizeOrigin(origin) {
	if (Array.isArray(origin) && origin.length === 2 && origin.every(Number.isFinite)) return [Math.trunc(origin[0]), Math.trunc(origin[1])];
	return [0, 0];
}

/* ════════════════ Stage 5：site（seed → 世界锚点 / 矿格校验）════════════════ */

/**
 * 把「以 hub 为原点的局部布局」配到**真实世界**：找一组 anchor，使得每台矿机所在资源格
 * 的资源 shortKey 恰等于该矿机通道的 payload（= 它要采的形状）。
 * 判据与 P2 world.mjs 同源（tileResource 是 gen-resources CLI 逐格对拍过的真值），本包不重算 chunk。
 *
 * ⚠️ 坐标系裁决（§2.1 / P1 fixture plan-l1.json 口径）：layout 与 entities **全程留在设计系**
 *   （布局原点 = [0,0]，hub 在 hubLocal），世界坐标 = `site.anchor + [dx,dy]`。
 *   所以本函数只产 anchor（平移量），**不平移 layout** —— 平移会让 P5 的 hub 槽位、
 *   P6 的锚点归一、P7 的对拍三处各拿一套坐标，那才是真正的错位来源。
 *
 * ⚠️ 为什么必须存在这一层：P3 的 `pickResourceCells` 只在**内部**按资源表把矿机挪到资源格上，
 *   从不返回世界坐标（NOTES.md BUG-P3-RESOURCE-CELLS-DROPPED）；P5 的 V1/V3 又要求矿机压在
 *   它那份资源上。所以世界选址是编译器的活，不是 P3 的。
 * @returns {{ok:true, anchor:number[], hubLocal:number[], miners:Array, region:object} | failure}
 */
export function siteStage(layout, ctx) {
	const miners = [];
	for (const p of layout.placements || []) {
		if (p.kind !== "miner") continue;
		const ch = (layout.channels || []).find(c => c.from.nodeId === p.nodeId);
		miners.push({ nodeId: p.nodeId, cell: [p.cell[0], p.cell[1]], shape: ch ? ch.payload : null });
	}
	for (const m of miners) {
		if (!m.shape || m.shape === "--------") {
			return fail("no-resource-in-range", { nodeId: m.nodeId, cell: m.cell, check: "V1-occupancy" },
				`矿机 ${m.nodeId} 没有可校验的资源 payload（通道缺失/空形状）—— 布局与配方脱节，P8 不猜`);
		}
	}
	const seed = ctx.seed;
	const region = ctx.region || regionAround(ctx.origin || [0, 0], ctx.range === undefined ? 96 : ctx.range);
	const cells = resourcesInRegion(seed, region);
	// 候选 anchor：把第一台矿机对到它那份资源上，按离原点近到远、再字典序 tie-break（完全确定）
	const first = miners[0];
	const anchors = cells
		.filter(c => c[2] === first.shape)
		.map(c => ({ a: [c[0] - first.cell[0], c[1] - first.cell[1]], d: Math.hypot(c[0], c[1]) }))
		.sort((x, y) => cmpNum(x.d, y.d) || cmpNum(x.a[0], y.a[0]) || cmpNum(x.a[1], y.a[1]));
	if (!anchors.length) {
		return fail("no-resource-in-range",
			{ nodeId: first.nodeId, cell: first.cell, check: "V1-occupancy" },
			`seed=${seed} 的区域 [${region.x0},${region.y0},${region.x1},${region.y1}] 内没有资源 ${first.shape}`
			+ `（矿机 ${first.nodeId} 要它）：扩大 --range / 换 --seed / 换目标`);
	}
	for (const cand of anchors) {
		const okAll = miners.every(m => tileResource(seed, cand.a[0] + m.cell[0], cand.a[1] + m.cell[1]) === m.shape);
		if (!okAll) continue;
		if (!regionClear(ctx)) continue;                 // 增量对接：v1 不支持（与 P3 validateWorld 同口径）
		return {
			ok: true, anchor: cand.a, hubDesign: ctx.hubDesign.slice(),
			hubWorld: [cand.a[0] + ctx.hubDesign[0], cand.a[1] + ctx.hubDesign[1]],
			miners: miners.map(m => ({ nodeId: m.nodeId, cell: [cand.a[0] + m.cell[0], cand.a[1] + m.cell[1]], shape: m.shape })),
			region, seed, candidatesTried: anchors.length,
		};
	}
	return fail("no-resource-in-range",
		{ nodeId: first ? first.nodeId : "", cell: first ? first.cell : null, check: "V1-occupancy" },
		`seed=${seed} 的区域 [${region.x0},${region.y0},${region.x1},${region.y1}] 里找不到能同时满足 `
		+ `${miners.length} 台矿机（${[...new Set(miners.map(m => m.shape))].join("/")}）的资源格组合：`
		+ `试过 ${anchors.length} 个候选锚点（第一台矿机的资源位）⇒ 请扩大 --range / 换 --seed / 换 --hub`);
}

/** 落点区净地检查（既有世界若有实体则算不净 —— v1 不增量对接） */
function regionClear(ctx) {
	const world = ctx.world;
	if (!world || !Array.isArray(world.entities)) return true;
	return world.entities.filter(e => e && e.type !== "hub").length === 0;
}

/**
 * §2.6 WorldState（全新址：一台 hub、无其它实体）。交接件与 V1/V2/V3 都要它。
 * ⚠️ **坐标系 = 设计系（局部）**：layout/entities 全程用「以布局原点为 [0,0]」的设计坐标
 *   （P1 fixture plan-l1.json 同口径：placements.cell=[0,5]、hubConnection.entry=[0,0]、
 *   occupancy = hub 在设计系的 16 格），世界坐标 = `site.anchor + [dx,dy]`（§2.1）。
 *   所以灌进 WorldState 的 hub 必须是 **hubLocal**，不是世界 hub —— 否则 V1 拿世界格比设计格，
 *   hub 4×4 错位 ⇒ 假 fail / 假 pass 都会出现（NOTES.md 坐标口径）。
 * @param {[number,number]} hubLocal @param {number|null} seed
 */
export function hubWorldState(hubLocal, seed) {
	return {
		tick: 0, seed: seed === undefined ? null : seed, hub: { x: hubLocal[0], y: hubLocal[1] },
		goal: null, upgradeLevels: { belt: 1, miner: 1, processors: 1, painting: 1 },
		entities: [{ uid: 10000, type: "hub", x: hubLocal[0], y: hubLocal[1], r: 0, variant: "default", rotationVariant: 0, code: 26, layer: "regular" }],
		resources: [], replaceableBeltCells: [],
	};
}

/* ════════════════ Stage 6：validate（P5）—— intent 永远带上 ════════════════ */

/**
 * P5 判闸。**任务书/P5 裁决：intent 必须永远在** —— `validate --plan` 只给 layout 不给实体表
 * → UNDECIDABLE + 退出码 2（validate.mjs:1387），所以 plan-only 的交接是**没有凭据的交接**。
 * 本包用 `{layout, entities, world, goal, scope, dag, demandPerSec}` 整体喂，V1..V10+S1 全跑。
 * @returns {{ok:true, report:object, audit:object} | failure}
 */
export function validateStage(planish, ctx) {
	let report;
	try {
		report = validate(planish.layout, {
			entities: planish.entities,
			world: planish.world,
			goal: planish.goal,
			scope: planish.scope,
			dag: ctx.dag,
			demandPerSec: planish.demandPerSec || 0,
			currentLevel: ctx.level === undefined ? null : ctx.level,
			enforceUnlocks: ctx.enforceUnlocks === true,
			chargeMode: "false",
			strict: false,
		});
	} catch (e) {
		return absorb(e, "validate(P5)", { nodeId: "", cell: null, check: "V8-scope" }, "P5 normalizeInput 拒绝了输入形态");
	}
	const audit = auditReport(report);
	if (!report.pass || !audit.gate) {
		const first = (report.errors || [])[0] || null;
		const reason = first ? validateReason(first.check) : "validate:V3";
		const f = fail(reason,
			first ? { nodeId: first.nodeId || "", cell: first.cell || null, check: first.check } : { nodeId: "", cell: null, check: "V3-belt-fixed-point" },
			`P5 不过闸（pass=${report.pass}, 自洽问题 ${audit.problems.length} 条, 闸因 ${audit.gateReasons.join("/") || "-"}）：`
			+ (first ? first.message : audit.problems.concat(audit.gateReasons).join("；")).slice(0, 400));
		// 把**完整**报告随失败返回：P8 的分诊表 (§2.5) 与 P7 的读回判据都要 drift/checks 凭据，
		// 只给一行 message 等于把闸的结论藏起来（ADVERSARIAL:31-40 的教训：结论必须可审计）。
		return { ...f, report, audit };
	}
	return { ok: true, report, audit };
}

/* ════════════════ Stage 7：emit（P6）═══════════════ */

/**
 * P6 发射。**逃生口**：P3/P4 的产物是分两次追加的（机器 → 带子），拼成一张扁平表后
 * 未必天然满足 §2.1 的「机器→直线→拐角」子序（任务书给了 `entityOrder:'reorder'`），
 * 所以本包：先试 strict，被拒后用 reorder **并记 warning**（内容不变，只改执行次序）。
 * @returns {{ok:true, emit:object, emitOpts:object} | failure}
 */
export function emitStage(planish) {
	const attempts = [
		{ label: "strict", opts: {} },
		{ label: "reorder", opts: { entityOrder: "reorder" } },
	];
	let last = null;
	for (const a of attempts) {
		let out;
		try { out = emitPlan(planish, a.opts); }
		catch (e) { return absorb(e, "emit(P6)", { nodeId: "", cell: null, check: "" }, "P6 抛了未收敛的异常"); }
		if (out.ok === true) return { ok: true, emit: out, emitOpts: a };
		last = { out, label: a.label };
		if (a.label === "strict") continue;
	}
	const o = last && last.out;
	return fail(o && o.reason ? o.reason : "emit:mismatch",
		(o && o.failingNode) || { nodeId: "", cell: null, check: "" },
		`P6 拒发射（strict/${last && last.label} 都试了）：${o && o.hint ? o.hint : "?"}`
		+ (o && o.got ? `｜got=${JSON.stringify(o.got).slice(0, 220)}` : ""));
}

/* ═════════════════════════ CompiledPlan 装配 ═════════════════════════ */

/** 机器格：kind/code 来自 P2 的模板（**不手填 magic number**，plan §2.2 迁移路径 3/4）。
 *  inDir/outDir 取模板第 0 个槽 —— P5 的 V4 与 P6 的 code 对拍都以模板为真值。 */
function machineEntities(layout) {
	return (layout.placements || []).map(p => {
		const tpl = ALL_TEMPLATES[p.op];
		if (!tpl) throw new ContractViolation(`machineEntities(${p.nodeId}).op`, "op-templates 已知 op", p.op);
		return {
			code: codeFor(tpl.building, tpl.variant, 0, 0),
			dx: p.cell[0], dy: p.cell[1], rot: 0,
			nodeId: p.nodeId, instanceIdx: 0, kind: p.kind, rotationVariant: 0,
			inDir: p.kind === "miner" ? null : (tpl.inputs && tpl.inputs.length ? tpl.inputs[0].dir : null),
			outDir: p.kind === "trash" ? null : (tpl.outputs && tpl.outputs.length ? tpl.outputs[0].dir : null),
		};
	});
}
/** 带子格：(rot,rv,code,inDir,outDir) 全部来自 P4（solveTurn/beltCode 现算，本包不重算方向） */
function beltEntities(route) {
	return (route.beltCells || []).map(b => ({
		code: b.code, dx: b.cell.x, dy: b.cell.y, rot: b.rot,
		nodeId: `belt@${b.cell.x},${b.cell.y}`, instanceIdx: 0, kind: "belt",
		rotationVariant: b.rv, inDir: b.inDir, outDir: b.outDir,
	}));
}
/** §2.1 硬规定的产出分层：机器 → 直线带 → 拐角带（本包**自己**就按这个序拼，
 *  P6 的 reorder 只是兜底逃生口，不是常态路径）。 */
function orderedEntities(machines, belts) {
	const straights = belts.filter(b => b.rotationVariant === 0);
	const corners = belts.filter(b => b.rotationVariant !== 0);
	return [...machines, ...straights, ...corners];
}

/** stats（§2.1 硬规定 4：与 entities / layout 自洽，P1 契约逐条对拍） */
function statsOf(entities, layout, beltCount, opts = {}) {
	const belts = entities.filter(e => e.kind === "belt");
	const corners = belts.filter(e => e.rotationVariant !== 0);
	const trash = entities.filter(e => e.kind === "trash");
	const byKind = {};
	for (const e of entities) if (e.kind !== "belt") byKind[e.kind] = (byKind[e.kind] || 0) + 1;
	const xs = entities.map(e => e.dx), ys = entities.map(e => e.dy);
	// layout.bbox 是 P3 的口径 [maxX-minX+1, maxY-minY+1]，含**机器占地**与 hub 4×4；
	// entities 里 hub **不进**蓝图（它是既有世界），所以 entities 跨度 ≤ layout.bbox。
	// P1 的契约要求 stats.bbox **同时**等于 entities 跨度与 layout.bbox（types.mjs:505-512）
	// —— 二者不等时，唯一自洽的解法是让 layout 的 bbox 与 entities 一致（NOTES BUG-P3-BBOX-HUB）。
	// 本包不伪造：显式记录差异，并按**契约可成立**的那一份给出（见 alignBbox）。
	const bbEnt = [Math.max(...xs) - Math.min(...xs) + 1, Math.max(...ys) - Math.min(...ys) + 1];
	return {
		machines: byKind, beltTiles: belts.length, trash: trash.length, bbox: bbEnt,
		corners: corners.length, estThroughputPerSec: opts.estThroughputPerSec,
		bottleneck: opts.bottleneck, blueprintCost: blueprintCost(entities.length), chargeMode: "false",
		layoutBbox: layout.bbox, cornerCostTiles: opts.cornerCostTiles,
	};
}

/** 吞吐估计：min(节点速率)，拐角按 0.78 **有效格**折算（plan §6 R5 / P4 NOTES：弧长≠容量系数）。 */
function throughputOf(layout, route) {
	let slow = null;
	for (const p of layout.placements || []) {
		const tpl = ALL_TEMPLATES[p.op];
		const rate = tpl ? tpl.ratePerSec : null;
		if (rate === null || rate === 0) continue;
		if (!slow || rate < slow.ratePerSec) slow = { kind: p.kind, op: p.op, ratePerSec: rate, nodeId: p.nodeId };
	}
	if (!slow) slow = { kind: "miner", op: "mine", ratePerSec: RATES.miner, nodeId: null };
	return {
		estThroughputPerSec: slow.ratePerSec,
		bottleneck: `${slow.kind}@${slow.ratePerSec}`,
		bottleneckNodeId: slow.nodeId,
		cornerCostTiles: route ? route.cornerCostTiles : 0,
	};
}

/**
 * 装配一个 CompiledPlan 的**骨架**（未发射态：blueprint:null / validation 待填）。
 * P6 的契约要求 ok:true 必须有蓝图，所以未发射的中间态只在本包内部存在。
 */
function assemblePlan(parts) {
	const { goal, layout, route, entities, anchor, hub, world, demandPerSec, level, solver, orderMode, gapTries } = parts;
	const tp = throughputOf(layout, route);
	const stats = statsOf(entities, layout, route.beltTiles, tp);
	return {
		ok: true, goal, reason: null, failingNode: null, hint: null,
		site: { anchor: [anchor[0], anchor[1]], hub: [hub[0], hub[1]] },
		blueprint: null, entities,
		layout, validation: null, stats,
		scope: { ...SCOPE_V1 },
		_meta: {
			harnessVersion: HARNESS_VERSION, placeVersion: PLACE_VERSION, routeSchemaVersion: ROUTE_SCHEMA_VERSION,
			validatorVersion: VALIDATOR_VERSION, solver: { argv: solver.argv, ops: solver.ops, stats: solver.stats, ms: solver.ms, known: solver.known },
			level, demandPerSec, seed: parts.seed, cutQuadAllowed: solver.cutQuadAllowed,
			channelOrder: orderMode, gapTries, gap: { rowGap: parts.rowGap, colGap: parts.colGap },
			minerCells: (parts.site && parts.site.miners) || null,
			world: { entities: world.entities.length, replaceableBeltCells: world.replaceableBeltCells.length },
		},
	};
}

/* ═════════════════════════ 顶层入口 ═════════════════════════ */

/**
 * goal → CompiledPlan。**永不 throw**（plan §0）。
 * @param {{goal:string, seed?:number|string, hub?:string|[number,number]|{x:number,y:number},
 *          world?:object, demandPerSec?:number, range?:number, depth?:number, maxStates?:number,
 *          rowGap?:number, colGap?:number, level?:number, noCutQuad?:boolean, enforceUnlocks?:boolean,
 *          searchRadius?:number}} input
 * @returns {object} CompiledPlan（成功）或 {ok:false,reason,failingNode,hint,...}（失败）
 */
export function compilePlan(input = {}) {
	try { return compileInner(input || {}); }
	catch (e) {
		// 最后一道：任何未预期的抛出也收敛成结构化失败（契约要求永不 throw）
		const f = absorb(e, "compilePlan", { nodeId: "", cell: null, check: "" }, "顶层未预期异常");
		return { ...f, goal: input && input.goal, stages: { top: "absorbed" } };
	}
}


function trace(stages, name, info) { stages[name] = { ok: info.ok !== false, ...(info.ok === false ? { reason: info.reason } : {}) }; return info; }

function compileInner(input) {
	const stages = {};
	const base = { goal: input.goal === undefined ? null : input.goal, stages };
	const bail = f => ({ ...base, ...f });

	/* 0. goal */
	const g = trace(stages, "inspectGoal", inspectGoal(input.goal));
	if (g.ok === false) return bail(g);

	const seed = input.seed === undefined || input.seed === null ? DEFAULT_SEED
		: (typeof input.seed === "number" ? input.seed : Number(input.seed));
	if (!Number.isFinite(seed)) return bail(fail("no-resource-in-range", { nodeId: "seed", cell: null, check: "V1-occupancy" }, `seed 必须是数字，实得 ${JSON.stringify(input.seed)}`));

	const hubWorldIn = normalizeHub(input.hub);
	const rowGap = isInt(input.rowGap) ? input.rowGap : ROW_H;
	const colGap = isInt(input.colGap) ? input.colGap : COL_GAP;

	/* 1. solver */
	const sv = trace(stages, "solveGoal", solveGoal(g.goal, {
		level: isInt(input.level) ? input.level : g.level,
		noCutQuad: input.noCutQuad, depth: input.depth, maxStates: input.maxStates,
	}));
	if (sv.ok === false) return bail(sv);

	/* 2a. solver steps → 编译期 DAG（采用 inputs + 颜料 token 化 + 形状代数自证） */
	const dg = trace(stages, "rebuildDag", rebuildDag(sv.steps));
	if (dg.ok === false) return bail(dg);

	/* 2b. op 映射 → P3 归一化 steps（`mineColor`→`mine`、颜料 token 作 hash） */
	const mp = trace(stages, "mapOps", mapOps(dg));
	if (mp.ok === false) return bail(mp);

	/* 2½. 颜料契约闸：painter 的 color 槽必须接颜料节点、mixer 必须两色输入（见 checkPigments）。
	   solver 4e60013 起颜料是一等节点；本闸是**护栏**（退回旧缺口会立刻红），不是补数据。 */
	const pig = trace(stages, "pigmentGate", checkPigments(dg.dag));
	if (pig.ok === false) return bail(pig);

	/* 3+4. 作图 + 路由（**设计系**：site=[0,0]，hub=[0,HUB_DESIGN_DY]；重试闭环在 routeStage 里） */
	const ctx = {
		steps: mp.steps, hubDesign: hubWorldIn.design, rowGap, colGap,
		demandPerSec: input.demandPerSec || 0, searchRadius: input.searchRadius,
	};
	const pl = trace(stages, "placeStage", placeStage(mp.steps, ctx));
	if (pl.ok === false) return bail({ ...pl, layout: null, entities: null });
	const rt = trace(stages, "routeStage", routeStage(pl, ctx));
	if (rt.ok === false) return bail({ ...rt, layout: pl.layout, entities: null });
	const layoutLocal = rt.layout;

	/* entities（设计系，§2.1 的执行序：机器 → 直线带 → 拐角带）*/
	const entsLocal = orderedEntities(machineEntities(layoutLocal), beltEntities(rt.route));
	trace(stages, "entities", { ok: true, n: entsLocal.length });

	/* 5. 世界选址：只解 anchor（布局原点的世界坐标 = 平移量）；layout/entities **留在设计系**（§2.1） */
	const site = siteStage(layoutLocal, {
		seed, world: input.world || null, range: input.range, origin: normalizeOrigin(input.origin), region: input.region,
		hubDesign: hubWorldIn.design,
	});
	if (site.ok === false) { trace(stages, "siteStage", site); return bail(site); }
	trace(stages, "siteStage", { ok: true, anchor: site.anchor });

	const layout = alignBbox(layoutLocal, entsLocal);

	/* 6. 判闸（intent 永远带上）—— 在**设计系**跑：place 产出的 occupancy 与 P5 的世界视图同框，
	   平移不改变任何相对几何（V1/V3/V4/V6 全是相对判据），所以闸的结论与框无关。 */
	const vd = trace(stages, "validateStage", validateStage({
		goal: g.goal, layout, entities: entsLocal,
		world: hubWorldState(hubWorldIn.design, seed), scope: { ...SCOPE_V1 },
		demandPerSec: input.demandPerSec || 0,
	}, {
		dag: dagForS1(dg), level: isInt(input.level) ? input.level : g.level,
		enforceUnlocks: input.enforceUnlocks,
	}));
	if (vd.ok === false) return bail({ ...vd, layout, entities: entsLocal, validation: vd.report || null });
	/* 7. 发射（入参 site.anchor=[0,0] ⇒ emit 的 anchor = 设计系 min corner，再叠上世界平移量） */
	const pre = assemblePlan({
		goal: g.goal, layout, route: rt.route, entities: entsLocal,
		anchor: [0, 0], hub: hubWorldIn.design, world: hubWorldState(hubWorldIn.design, seed),
		demandPerSec: input.demandPerSec || 0, level: g.level, solver: sv, orderMode: rt.orderMode,
		gapTries: rt.gapTries, seed, rowGap: rt.rowGap, colGap: rt.colGap, site,
	});
	pre.validation = vd.report;
	const em = trace(stages, "emitStage", emitStage(pre));
	if (em.ok === false) return bail({ ...em, validation: vd.report, layout, entities: entsLocal, stats: pre.stats });

	/* 8. 组装最终 CompiledPlan（P6 的出参已是过契约的完整 plan；anchor 归一后 = 设计系 min corner） */
	const final = {
		...em.emit.plan,
		blueprint: em.emit.blueprint,
		entities: em.emit.entities,
		validation: vd.report,
		stages,
	};
	delete final._meta;
	final.provenance = {
		harnessVersion: HARNESS_VERSION, placeVersion: PLACE_VERSION, routeSchemaVersion: ROUTE_SCHEMA_VERSION,
		validatorVersion: VALIDATOR_VERSION, emittedVia: em.emitOpts.label,
		solver: { argv: sv.argv, ops: sv.ops, stats: sv.stats, ms: sv.ms, known: sv.known },
		seed, level: g.level, cutQuadAllowed: sv.cutQuadAllowed, channelOrder: rt.orderMode,
		gapTries: rt.gapTries, gap: { rowGap: rt.rowGap, colGap: rt.colGap },
		minerCells: site.miners, demandPerSec: input.demandPerSec || 0,
		cornerCostTiles: rt.route.cornerCostTiles, routeAttempts: rt.attempts,
		laneColumnUnresolved: rt.laneColumnUnresolved,
		// 世界落点：paste 点 = 设计系 anchor + emit 归一后的 min corner
		worldPlacement: {
			anchor: site.anchor, hub: site.hubWorld, pasteAt: [site.anchor[0] + em.emit.anchor[0], site.anchor[1] + em.emit.anchor[1]],
			designAnchor: em.emit.anchor, designHubLocal: hubWorldIn.design,
			// 交接件里的 hub 用**世界坐标**（P7 的世界是唯一真相）
			hub: site.hubWorld,
		},
	};
	final.roundtrip = roundtripCheck(em.emit);
	trace(stages, "done", { ok: true });
	return final;
}

/**
 * hub 输入的归一 —— 设计系 hub 恒 DEF_DESIGN，世界 hub 只用于反推 anchor（见 compileInner 的坐标口径）。
 *   · 未给 hub → design=[-4,-4]（P1 plan-l1 的 hubConnection.entry=[0,-1] + side=bottom 反推的 anchor），
 *     世界位置由 siteStage 解出（L3 要求「无人工坐标」）。
 *   · 给了 hub（[x,y] / "x,y" / {x,y}）→ 当**世界坐标**用：siteStage 把布局原点摆到能让 hub 落在该处，
 *     设计系内仍是 DEF_DESIGN —— 因为 P3 会把机器簇对齐到「hub 正下方」，改设计系 hub 会改几何，
 *     改世界 hub 只改整体平移量。
 * @returns {{given:boolean, world:number[]|null, design:number[], bad?:unknown}}
 */
export function normalizeHub(hub) {
	const DEF_DESIGN = [-4, -4];
	if (hub === undefined || hub === null || hub === "") return { given: false, world: null, design: DEF_DESIGN };
	let abs;
	if (Array.isArray(hub) && hub.length === 2) abs = [Math.trunc(Number(hub[0])), Math.trunc(Number(hub[1]))];
	else if (typeof hub === "string" && /^[^,]+,[^,]+$/.test(hub)) abs = hub.split(",").map(s => Math.trunc(Number(s)));
	else if (typeof hub === "object" && Number.isFinite(hub.x) && Number.isFinite(hub.y)) abs = [Math.trunc(hub.x), Math.trunc(hub.y)];
	else return { given: false, world: null, design: DEF_DESIGN, bad: hub };
	if (!abs.every(Number.isFinite)) return { given: false, world: null, design: DEF_DESIGN, bad: hub };
	return { given: true, world: abs, design: DEF_DESIGN };
}

/**
 * bbox 口径归一（**本包唯一的布局改写，且只改一个派生字段**）。
 * 冲突现场：P3 的 `LayoutReport.bbox` 把 hub 4×4 与机器槽位格都算进去（place.mjs buildReport 的
 *   touch(hubConnection/hub)），而 P1 的 `assertCompiledPlan`（types.mjs:505-512）要求
 *   `stats.bbox === entities 的 dx/dy 跨度` **且** `stats.bbox === layout.bbox`。
 *   hub 不在蓝图实体里（它是既有世界）⇒ 两个等式不可能同时成立 ⇒ **任何 P3 产物都过不了 §2.1 契约**。
 * 处置：bbox 是纯派生描述量（不指任何格子内容），按 **P1 fixture plan-l1.json 的口径**（它的
 *   layout.bbox=[2,6] == entities 跨度，hub 的 occupancy 在 bbox 之外）重算为 entities 跨度，
 *   并把 P3 原值留在 `layout.bboxP3` 里如实可见。登记 NOTES BUG-P3-BBOX-CONVENTION。
 * ⚠️ 这不是「静默修数据」：内容零改动、原值保留、契约侧有断言兜底，且 L0 有专项测试锁住这条归一。
 */
function alignBbox(layout, entities) {
	const xs = entities.map(e => e.dx), ys = entities.map(e => e.dy);
	const span = [Math.max(...xs) - Math.min(...xs) + 1, Math.max(...ys) - Math.min(...ys) + 1];
	const out = { ...layout, bbox: span, bboxP3: [layout.bbox[0], layout.bbox[1]] };
	return out;
}

/* ═════════════════════════ 回读自检（L1 门口径，本包自带一遍）═════════════════════ */

/**
 * `emit → decodeBlueprint` 逐格对拍 + summarizeBlueprint 可读性（plan §5 L1 门）。
 * 与 P6 的 roundtrip.mjs 判据一致，但这里是**每次编译都跑**的自证：
 *   entities[i] ↔ decoded[i]：(code,dx,dy,rot) 全等；belt 格 code===1+rv；intent 每格 x/y===anchor+dx/dy。
 * @param {object} em emitPlan 的成功出参
 */
export function roundtripCheck(em) {
	const decoded = decodeBlueprint(em.blueprint);
	const diff = [];
	const n = Math.min(decoded.entities.length, em.beltIntent.length);
	if (decoded.entities.length !== em.beltIntent.length) {
		diff.push({ cell: null, why: `数量不符 decoded=${decoded.entities.length} intent=${em.beltIntent.length}` });
	}
	for (let i = 0; i < n; i++) {
		const d = decoded.entities[i], w = em.beltIntent[i];
		if (d.code !== w.code || d.dx !== w.dx || d.dy !== w.dy || d.rot !== w.rotation) {
			diff.push({ i, cell: [w.dx, w.dy], want: { code: w.code, dx: w.dx, dy: w.dy, rot: w.rotation }, got: d });
		}
	}
	const beltBad = em.beltIntent.filter(b => b.kind === "belt" && b.code !== 1 + b.rotationVariant);
	const orderBad = [];
	let prev = -1;
	em.entities.forEach((e, i) => { const p = entityOrderPhase(e); if (p < prev) orderBad.push({ i, phase: p, prev }); prev = Math.max(prev, p); });
	let summary = null, summaryErr = null;
	try { summary = summarizeBlueprint(em.blueprint); } catch (e) { summaryErr = String(e && e.message || e); }
	return {
		ok: diff.length === 0 && beltBad.length === 0 && orderBad.length === 0 && summary !== null,
		stride: decoded.stride || 4, decodedCount: decoded.entities.length, intentCount: em.beltIntent.length,
		eLength: decoded.e ? decoded.e.length : (decoded.raw ? String(decoded.raw).length : null),
		diff, beltCodeBad: beltBad.map(b => [b.x, b.y, b.code, b.rotationVariant]),
		orderBad, summary, summaryErr,
	};
}

/* ═════════════════════════ 交接件（§4.6，P8 → P7）═════════════════════ */

/** 文件名 slug：goal 里的 ':'/'-' 保留可读性，其它非 [A-Za-z0-9_.:-] 换 '_'。 */
export function goalSlug(goal) {
	return String(goal).replace(/[^A-Za-z0-9_.:+-]/g, "_");
}

/**
 * 写交接三件套（§4.6）：
 *   out/<goal>.szbp.txt      蓝图字符（P7 直接塞 paste_blueprint.text）
 *   out/<goal>.intent.json   beltIntent + anchor + hub + chargeMode + validation 摘要 + validator.pass
 *   out/<goal>.validator.json ValidatorReport（**必须 pass 才有 out 文件**）
 * ⚠️ P5 裁决：intent 必须永远在 —— 只给 plan 不给实体表 = UNDECIDABLE（退出码 2）。
 *   所以 intent.json 里的 entities[] 就是 validate.mjs `--intent` 能直接吃的形态。
 * @param {object} plan CompiledPlan
 * @param {string} [dir]
 * @returns {{ok:true, dir:string, files:string[]} | {ok:false,reason,failingNode,hint}}
 */
export function writeHandoff(plan, dir = HANDOFF_DIR) {
	if (!plan || plan.ok !== true) {
		return fail(plan && plan.reason ? plan.reason : "emit:mismatch",
			(plan && plan.failingNode) || null,
			"未过闸的计划不写交接件（P7 拿到的必须是已验证品，plan §4.6）");
	}
	const rep = plan.validation;
	const vAudit = auditReport(rep);
	if (!rep || rep.pass !== true || !vAudit.gate) {
		return fail("validate:V3", { nodeId: "", cell: null, check: "V3-belt-fixed-point" },
			`validator 未过闸（pass=${rep && rep.pass}, 自洽问题 ${vAudit.problems.length}）→ 拒绝写交接件`);
	}
	fs.mkdirSync(dir, { recursive: true });
	const slug = goalSlug(plan.goal);
	const files = [];
	const w = (name, content) => { const p = path.join(dir, name); fs.writeFileSync(p, content, "utf8"); files.push(p); };

	w(`${slug}.szbp.txt`, plan.blueprint);

	const intent = {
		goal: plan.goal,
		schema: "shapez-ai/handoff-intent@1",
		blueprint: plan.blueprint,
		anchor: plan.site.anchor,                       // = paste_blueprint{x,y}
		hub: plan.site.hub,
		chargeMode: plan.stats.chargeMode,
		gv: plan.gv || null,
		count: plan.entities.length,
		stride: plan.stride || 4,
		entityOrder: plan.entities.map(e => e.nodeId),
		entities: plan.entities,                        // ← validate.mjs --intent 直接吃这份
		beltIntent: plan.beltIntent || null,
		stats: plan.stats,
		scope: plan.scope,
		validation: {
			pass: rep.pass, errors: rep.errors.length,
			failIds: rep.checks.filter(c => c.status === "fail").map(c => c.id),
			beltSim: rep.beltSim, shapeReplay: rep.shapeReplay, throughput: rep.throughput,
		},
		validator: { pass: rep.pass },                  // P7 的「已验证品」凭据（plan §4.6 明写）
		roundtrip: plan.roundtrip || null,
		provenance: plan.provenance || null,
	};
	w(`${slug}.intent.json`, JSON.stringify(intent, null, 1));
	w(`${slug}.validator.json`, JSON.stringify({ goal: plan.goal, ...rep, gate: vAudit }, null, 1));
	return { ok: true, dir, files, slug };
}

/** 只读汇总 P7 回写的实机结果（`live/results/<goal>.<level>.json`）。本包**不写** live/。 */
export function readLiveResults(dir = path.join(REPO_ROOT, "research", "ai-plan", "live", "results")) {
	if (!fs.existsSync(dir)) return { ok: true, results: [], missing: dir };
	const out = [];
	for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".json")).sort(cmpStr)) {
		try { out.push({ file: f, data: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) }); }
		catch (e) { out.push({ file: f, error: String(e && e.message) }); }
	}
	return { ok: true, results: out };
}

/* ═════════════════════════ 自测薄壳 ═════════════════════════ */
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("compiler/compile.mjs")) {
	console.log("compile.mjs: L0 请跑 `node research/ai-plan/harness/test.mjs`（端到端 + 确定性 + 失败路径 + 交接件 + lint）。");
}
