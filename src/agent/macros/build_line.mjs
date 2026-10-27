/**
 * build_line.mjs — 宏：在**一块空地**上合成一整条新产线（矿机 → 工序 → hub），返回蓝图。
 *
 * ═════════════════════════ 这是宏，不是入口 ═════════════════════════
 *
 * 2026-10-28 方向终裁（research/ai-plan/DIRECTION-FINAL.md §1.1）：
 * `src/ai/compiler/*` 从**主线入口**降为**库**；`compilePlan()` 只作为本宏的内部实现被调用；
 * `regionClear` 从"世界必须空"的全局闸，降为本宏的**前置条件** `precondition:"empty-site"`。
 *
 * 为什么降级（不是删）：空地 9/12、真实存档（有既有工厂）0/6 —— 用户场景下为零。
 * 但 op-templates / belt-rules / world 是独立资产，删了等于把地基重埋。
 *
 * 所以本宏**如实承认**自己的能力边界：
 *   · 它只在**白纸**上工作。世界里有任何非 hub 实体 ⇒ 直接 `site-not-empty`，
 *     **不会**"假装能处理有工厂的存档"，也不会把新线摆到旧建筑上。
 *   · 有工厂的存档该走增量宏：`connect(from,to)` / `insert_machine(at,facing,machine)`。
 *   · 典型合法用法：在远处**真正的空地**建线（本宏），再用 `connect` 把线接回 hub。
 *
 * ═════════════════════════ 契约 ═════════════════════════
 *
 *   buildLine(goal, site, opts?) → {
 *     ok: boolean,
 *     blueprint: string|null,      // SZBP1.… 蓝图；失败为 null
 *     entities: Array|null,        // 编译器 §2.1 实体（dx/dy 相对 anchor）
 *     cells: Array|null,           // 同一批实体的**世界坐标**便利视图 [{kind,code,x,y,rot}]
 *     anchor: [number,number]|null,// 世界平移量：world = anchor + [dx,dy]（= paste 点）
 *     hub: [number,number]|null,   // 真实 hub 世界坐标（必须钉死，否则不可交付）
 *     reason?: string,             // 失败原因（宏级语义，见 REASONS）
 *     compilerReason?: string,     // 透传的 §2.5 reason（诊断/回归用）
 *     precondition: "empty-site",  // ★ 恒在场：本宏的前置条件，失败也不藏
 *     hint: string,                // 失败时告诉调用方"下一步该做什么"
 *     evidence?: object,           // 失败凭据（既有实体、编译器 failingNode 等）
 *   }
 *
 * 宏级 reason（**不是** §2.5 枚举 —— 那是编译器的冻结契约，宏用更准确的名字）：
 *   · "site-not-empty"          —— 世界里有既有实体（前置条件不满足；扩 range / 换 seed 无用）
 *   · "no-site-large-enough"    —— 真的是空间/几何不够（透传编译器）
 *   · "no-resource-in-range"    —— 这片区域没有目标矿（透传，可扩 range 或换 seed）
 *   · "hub-unpinned"            —— 没给 hub ⇒ 编译器只会"发明"一个，接不上真实 hub
 *   · 其余                      —— 原样透传编译器的 §2.5 reason（如 dag-not-placeable:*）
 *
 * ⚠️ 本宏**零游戏写操作**：它只返回蓝图与实体表。落盘/粘贴是调用方（P7 / gates）的事。
 * ⚠️ 本宏**不修数据**：编译器报什么就透传什么，只在"世界不干净"这一条上给出更准确的名字。
 *
 * 用法：
 *   import { buildLine } from "./build_line.mjs";
 *   const r = buildLine("CuCuCuCu", { hub: [-2, -2], seed: 55013, level: 5 });
 *   if (!r.ok && r.reason === "site-not-empty") → 改用 connect / insert_machine
 *
 * 离线自测：node src/agent/macros/build_line.test.mjs
 */

import { compilePlan } from "../../ai/compiler/compile.mjs";

/** 本宏恒有的前置条件。失败对象里也必须带 —— 调用方按它决定"要不要换宏"。 */
export const PRECONDITION = "empty-site";

/** 非 hub 即算占用：hub 永远在实体表里，把它算脏会让任何调用都恒拒。与 compile.mjs 的 regionClear 同口径。 */
const isForeign = e => !!e && typeof e === "object" && e.type !== "hub";

/**
 * 把 site 入参归一。允许三种写法（都只描述**世界**，不描述"我想要哪块地"）：
 *   · [x,y] / {x,y}            → 就是 hub 世界坐标（最常用）
 *   · { hub:[x,y], world:{entities:[…]}, … } → 完整形态
 *   · { hub:[x,y], entities:[…] }             → world 的简写
 * @returns {{hub:[number,number]|null, entities:Array|null, origin:[number,number]|null,
 *            range:number|undefined, seed:number|undefined, level:number|undefined}}
 */
function normalizeSite(site) {
	const s = site && typeof site === "object" && !Array.isArray(site) ? site : { hub: site };
	let hub = null;
	if (Array.isArray(s.hub) && s.hub.length === 2) hub = [Number(s.hub[0]), Number(s.hub[1])];
	else if (s.hub && typeof s.hub === "object" && Number.isFinite(s.hub.x) && Number.isFinite(s.hub.y)) hub = [s.hub.x, s.hub.y];
	else if (Number.isFinite(s.x) && Number.isFinite(s.y) && s.type === undefined && s.hub === undefined) hub = [s.x, s.y];
	// world 的两条入口（与 compile.mjs siteStage 的合流口径一致）：{world:{entities}} 或 {entities}
	let entities = null;
	if (s.world && Array.isArray(s.world.entities)) entities = s.world.entities;
	else if (Array.isArray(s.entities)) entities = s.entities;
	let origin = null;
	if (Array.isArray(s.origin) && s.origin.length === 2) origin = [Number(s.origin[0]), Number(s.origin[1])];
	return {
		hub: hub && hub.every(Number.isFinite) ? hub.map(Math.trunc) : null,
		entities,
		origin,
		range: Number.isFinite(s.range) ? s.range : undefined,
		seed: Number.isFinite(s.seed) ? s.seed : undefined,
		level: Number.isFinite(s.level) ? s.level : undefined,
	};
}

/** 失败对象工厂：保证每个失败都带 precondition + hint（调用方不用做空判断）。 */
function failure(reason, hint, extra = {}) {
	return {
		ok: false,
		blueprint: null,
		entities: null,
		cells: null,
		anchor: null,
		hub: null,
		reason,
		precondition: PRECONDITION,
		hint,
		...extra,
	};
}

/**
 * 在空地上合成一条完整产线。
 *
 * @param {string} goal 目标 shortKey（例 "CuCuCuCu" / "----CuCu"）
 * @param {[number,number]|{hub?, world?, entities?, origin?, range?, seed?, level?}} site
 *        世界坐标（必须给 hub —— 没有真实 hub 的蓝图不可交付，编译器会按 hub 政策拒绝）
 * @param {{seed?:number, level?:number, demandPerSec?:number, range?:number,
 *          rowGap?:number, colGap?:number, tunnels?:boolean, minersPerLine?:number,
 *          allowCutQuad?:boolean, world?:object|Array}} [opts] 编译选项（透传 compilePlan）
 * @returns {{ok:boolean, blueprint:string|null, entities:Array|null, cells:Array|null,
 *            anchor:[number,number]|null, hub:[number,number]|null, precondition:string,
 *            reason?:string, compilerReason?:string, hint:string, evidence?:object}}
 */
export function buildLine(goal, site = {}, opts = {}) {
	const s = normalizeSite(site);
	const o = opts && typeof opts === "object" ? opts : {};

	/* ① 前置条件：世界必须是白纸。
	   这一判**先于** compilePlan，理由有两条：
	     a) 语义确定 —— 脏世界不该因为"恰好某条几何先挂了"而报出另一个原因；
	     b) 名实相符 —— 编译器在钉死 hub 的路径上会报 site-not-empty，但未钉死/其它路径
	        历史上会落到 no-resource-in-range（"没矿"），那会把"世界脏"伪装成"这片区域没资源"。
	   没有快照（entities === null）⇒ 我们**不知道**世界是否干净：不假装知道，交给编译器按旧契约走。 */
	const entities = s.entities || (o.world && Array.isArray(o.world.entities) ? o.world.entities : null)
		|| (Array.isArray(o.world) ? o.world : null);
	if (Array.isArray(entities)) {
		const foreign = entities.filter(isForeign);
		if (foreign.length) {
			const hubInSnapshot = entities.find(e => e && e.type === "hub") || null;
			return failure("site-not-empty",
				`世界快照里有 ${foreign.length} 个非 hub 实体 ⇒ 这不是空地，本宏（编译器 v1）不做增量对接。`
				+ `处置：就地改造请用 connect(from,to) / insert_machine(at,facing,machine)；`
				+ `或在**真正的空地**上用 buildLine 建线，再用 connect 接回 hub。`
				+ `不要靠扩大 range 或换 seed 解决 —— 这不是"地方不够大"。`,
				{
					evidence: {
						foreignCount: foreign.length,
						foreign: foreign.slice(0, 8).map(e => ({ type: String(e.type), x: e.x, y: e.y })),
						hubInSnapshot: hubInSnapshot ? { x: hubInSnapshot.x, y: hubInSnapshot.y } : null,
					},
				});
		}
	}

	/* ② 没有 hub ⇒ 编译器的 hub 政策会拒（class=hub:unpinned）。
	   提早拦下来，把"为什么"说清楚：蓝图 = "能贴"的承诺，而收集带会通向一个发明出来的坐标。 */
	if (!s.hub) {
		return failure("hub-unpinned",
			`没给真实 hub 坐标 ⇒ 编译器只能"发明"一个，收集带会通向假想位置（ok:true 只证明排出了一座工厂）。`
			+ `处置：把实机观测到的 hub 左上角传进来，如 buildLine("${goal || "?"}", { hub: [-2,-2], seed: 55013 })。`,
			{ compilerReason: "no-site-large-enough" });
	}

	/* ③ 交给编译器（唯一权威）。allowUnpinned 永不开 —— 那会产出接不上 hub 的假绿。 */
	const input = {
		goal,
		hub: s.hub,
		...(s.seed !== undefined ? { seed: s.seed } : {}),
		...(o.seed !== undefined ? { seed: o.seed } : {}),
		...(s.level !== undefined ? { level: s.level } : {}),
		...(o.level !== undefined ? { level: o.level } : {}),
		...(s.range !== undefined ? { range: s.range } : {}),
		...(o.range !== undefined ? { range: o.range } : {}),
		...(s.origin ? { origin: s.origin } : {}),
		...(o.demandPerSec !== undefined ? { demandPerSec: o.demandPerSec } : {}),
		...(o.rowGap !== undefined ? { rowGap: o.rowGap } : {}),
		...(o.colGap !== undefined ? { colGap: o.colGap } : {}),
		...(o.tunnels === true ? { tunnels: true } : {}),
		...(Number.isInteger(o.minersPerLine) ? { minersPerLine: o.minersPerLine } : {}),
		...(o.allowCutQuad === true ? { noCutQuad: false } : {}),
		// 世界快照：两条入口合成一条（空数组按"无快照"处理，与 entitiesToWorld 同口径）
		...(Array.isArray(entities) && entities.length ? { world: { entities } } : {}),
	};
	let plan;
	try {
		plan = compilePlan(input);
	} catch (e) {
		// compilePlan 契约是永不 throw；真抛了说明落到了我们没预料的分支 —— 仍然收敛成结构化失败。
		return failure("compiler-threw",
			`编译器抛了异常（契约是永不 throw）：${String((e && e.message) || e)}。请把它当 bug 上报，不要重试。`,
			{ evidence: { stack: String((e && e.stack) || "").split("\n").slice(0, 4) } });
	}

	/* ④ 成功：把编译器产物翻译成宏的返回形状。 */
	if (plan && plan.ok === true) {
		const anchor = Array.isArray(plan.site && plan.site.anchor) ? plan.site.anchor.slice() : null;
		const ents = Array.isArray(plan.entities) ? plan.entities : [];
		return {
			ok: true,
			blueprint: plan.blueprint,
			entities: ents,
			// 世界坐标视图：§2.1 的 world = anchor + [dx,dy]。给调用方一个不用再算的形状。
			cells: anchor ? ents.map(e => ({ kind: e.kind, code: e.code, x: anchor[0] + e.dx, y: anchor[1] + e.dy, rot: e.rot })) : null,
			anchor,
			hub: Array.isArray(plan.site && plan.site.hub) ? plan.site.hub.slice() : s.hub,
			precondition: PRECONDITION,
			hint: `蓝图 ${plan.blueprint.length} 字符 / ${ents.length} 实体；paste 点 = anchor=[${anchor}]。`
				+ `本宏只在空地成立：落盘/粘贴前请 dry_run，并确认目标区域仍是空的。`,
		};
	}

	/* ⑤ 失败：先看是不是"前置条件"这一类（编译器也可能独立报出来），再按原因给处置。 */
	const cReason = plan && plan.reason ? plan.reason : "emit:mismatch";
	const evidence = {
		failingNode: plan ? plan.failingNode || null : null,
		stages: plan ? plan.stages || null : null,
		...(plan && plan.code ? { code: plan.code } : {}),
		...(plan && plan.precondition ? { compilerPrecondition: plan.precondition } : {}),
	};

	if (cReason === "no-site-large-enough" && plan && (plan.code === "site-not-empty" || plan.class === "hub:unpinned")) {
		if (plan.class === "hub:unpinned") {
			return failure("hub-unpinned", plan.hint || `hub 未钉死：给真实的 hub 世界坐标。`, { compilerReason: cReason, evidence });
		}
		const ev = plan.evidence || {};
		return failure("site-not-empty",
			`世界快照里有 ${ev.foreignCount !== undefined ? ev.foreignCount : "若干"} 个非 hub 实体 ⇒ 本宏不做增量对接。`
			+ `处置：用 connect(from,to) / insert_machine(at,facing,machine) 就地改造，`
			+ `或换一块真正的空地建线再接回 hub。`,
			{ compilerReason: cReason, evidence: { ...evidence, ...ev } });
	}

	/* 其余原因原样透传：宏不替编译器编故事，只把 hint 补成"宏用户该做的下一步"。 */
	const HINTS = {
		"no-resource-in-range": "这片区域没有目标矿（真的是资源问题）：扩大 range / 换 seed / 换 hub。",
		"no-site-large-enough": "空间或几何不够（真的是面积问题）：换一块更开阔的空地，或扩大 range。",
		"dag-not-placeable:column-conflict-unresolved": "布局撞车：换 hub/range 重试，或改用 connect 就地改造（不要手改坐标）。",
		"dag-not-placeable:crossing-needs-tunnel": "布线要跨线：可试 opts.tunnels = true；否则换 hub/range。",
		"dag-not-placeable:fanin>2": "配方需要 >2 路汇合，v1 无 4 路模板：换目标或分批建线。",
		"unlock:machine-not-available": "需要的机器/等级未解锁：等解锁，或换目标。",
		"out-of-scope:multilayer": "多层目标在 v1 范围外。",
	};
	const hint = HINTS[cReason] || (plan && plan.hint) || `编译器拒绝（${cReason}）：按编译器 hint 处置，别手改坐标。`;
	return failure(cReason, hint, { compilerReason: cReason, evidence });
}

export default buildLine;
