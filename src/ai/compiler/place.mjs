/**
 * place.mjs — P3 placer：配方 DAG → 空间网格作图（布局编译器的"排版师"）。
 *
 * 权威依据（逐条落到代码）：
 *   plan-compiler.md §1.3（本包定义）/ §2.3 LayoutReport（**逐字段实现**）/ §2.5 失败枚举 / §2.6 / §2.7
 *   src/ai/compiler/{types,grid,errors}.mjs（P1，L0 全绿 —— **只 import，绝不改**）
 *   src/ai/op-templates.mjs（几何真值：OP_TEMPLATES/AUX_TEMPLATES/**hubEntriesWorld**）
 *   src/ai/world.mjs（tileResource/findResource/nearestResource/regionAround —— 资源格）
 *   facts/GEOMETRY-TABLE.md 表1（槽位只在 r=0 定义）表2（items/s 口径 G10）表3（布局铁律）
 *   facts/MILESTONE-M4-SUCCESS.md（汇合实证模式：**只让一条分支拐弯** ⇒ 恰 2 拐角）
 *   facts/MILESTONE-GRID-LAYOUT-verified.md（**第一原则：零拐角** —— 下进上出的机器可竖直直串）
 *   facts/MILESTONE-M4-partial-and-pitfalls.md（两矿同列 ⇒ 通道重叠；未用输出口 ⇒ 堵死）
 *   routing-prior-art.md §1+§8（主干 = 分层 → 层内 barycenter **父子保序** → 行间走廊；
 *     车道的 left-edge 分配归 P4，本包只给可行车道行并上报 lane-column 冲突）
 *
 * 职责边界（plan §1.3）：只决定「哪个 op 落在哪一格」+「每个连接对的 (from cell,outDir)→(to cell,inDir)」，
 *   写成 LayoutReport.channels[] 交 **P4 消费**。不产出 belt 格的 (rot,rv,code)（归 P4），
 *   不 import P4/P5/P6/P8（防环）。hub 入口表**只**来自 op-templates.hubEntriesWorld()（裁决 K1）。
 *
 * 已遵守的主线程裁决：
 *   G7  任何角度/旋转进门先过象限断言（assertQuadrantAngle）；脏角度 → 结构化错误，**不量化不截断**
 *   G1  非 belt 建筑只出 rv=0、机器 rot 恒 0（决策 D1）；belt 的 (rot,rv,code) 一律交 P4
 *   G10 吞吐用 GEOMETRY 表2 items/s 口径（本只把 demandPerSec 原样记进 meta，不做 charges/s 换算）
 *
 * 与 P1 fixtures 对齐的三条口径（读 report-layout.json / plan-l1.json 逐格核对得到，见 NOTES.md N-1）：
 *   ① 坐标**不平移**：bbox=[maxX-minX+1, maxY-minY+1]，grid 第 i 行 ↔ y=minY+i，允许负 y；
 *   ② channels[].from/to.cell = **机器槽位的绝对格**，且 slot 与 outDir/inDir 同值（= 槽位朝向）；
 *      带子几何量在内部换算：first=add(fromCell,outDir)、last=add(toCell,inDir)、d2=OPP[inDir]；
 *   ③ hubConnection = {entry: 带子末格, side: hub 边名, dir: 带子流向角}，
 *      hub 槽格 = add(entry, ANGLE_DIR[dir])，其 acceptor 方位 = side。
 *
 * 铁律：零依赖；中文注释；确定性（同输入逐字节同输出，无 RNG、无 Date、排序全带 tie-break）；
 *   未用输出槽**必须**自动接 trash；绝不静默近似（超范围一律 §2.5 结构化拒因，绝不 return 半张图）。
 *
 * L0：`node research/ai-plan/placer/test.mjs`（四张金网格逐字节 + 负例 + 契约断言 + import lint）
 */

import { Grid, cellKey } from "./grid.mjs";
// 方向/角度真值一律走 P1 的 re-export（types.mjs ← src/ai/belt-rules.mjs），本包不抄第二张表
import { assertLayoutReport, SCOPE_V1, ORDER, OPP, DIRV } from "./types.mjs";
import { makeFailure, ContractViolation } from "./errors.mjs";
import { ALL_TEMPLATES, hubEntriesWorld } from "../op-templates.mjs";
import { findResource, nearestResource, regionAround } from "../world.mjs";

export const PLACE_VERSION = "0.5.0";

/* ═════════════════════════ 常量：行式布局的几何参数 ═════════════════════════ */

/**
 * 层间距（plan §1.3：每层一条水平轨道）。8 = 机器占 1 行 + 进料末格 1 行 + 车道 1 行 +
 * 上游竖直腿余量 ≥ 1 + 绕行车道余量（陷阱表 #4/#5：汇合分支的车道必须落在目标进料行**下方**）。
 */
export const ROW_H = 8;
/** 同层机器最小列间距（保证每条竖直通道独占一列 —— M4-SUCCESS 前置条件「两矿必须不同列」）*/
export const COL_GAP = 3;
/** Z 型车道的选取偏好：紧贴目标末格（M4 实机形态 —— 车道行 = 目标带子格外侧 1 格）*/
export const LANE_OFF = 1;
/** hub 占地 4×4（GEOMETRY 表1）*/
export const HUB_SIZE = 4;
/** trash 沿输出口外推的最大步数（超出 → no-site-large-enough）*/
export const TRASH_PUSH_MAX = 6;
/** 单条通道允许的最大带子格数（防御：越界说明列分配崩了，宁拒不猜）*/
export const MAX_CHANNEL_CELLS = 4096;

/**
 * 字符网格符号（plan §2.3；逐字节可 diff）。多格机器的**非锚点格**渲染为 '.'（被占地占据、无槽位，
 * P4 不许往里铺带）。拐角符号按本格实际接触的两侧（臂对 = {inDir,outDir}）命名，与 P1 fixtures 一致：
 *   '7' 臂 {bottom,left}（M4 实机 (147,93) r=0 rv=1 code=2 的形态）
 *   '9' 臂 {top,right}   （M4 实机 (138,93) r=270 rv=2 code=3 的形态）
 *   'L' 臂 {top,left}、'J' 臂 {bottom,right}
 * ⚠️ grid 只供人读 + cornerCount 一致性自检（本包把两者做成同源计算并交叉断言），P4/P5 不解析它。
 */
export const GRID_CHARS = Object.freeze({
	empty: ".",
	miner: "M", cutter: "C", rotater: "R", stacker: "S", mixer: "X",
	painter: "P", painterMirrored: "p", trash: "T", hub: "H",
	belt_top: "^", belt_bottom: "v", belt_right: ">", belt_left: "<",
	corner_bottom_left: "7", corner_top_right: "9", corner_top_left: "L", corner_bottom_right: "J",
});

/** 角度 → 方位名（0=上 90=右 180=下 270=左；= ORDER 索引 × 90，与 belt-rules.dirToAngle 同表）*/
export const ANGLE_DIR = Object.freeze(ORDER.reduce((a, d, i) => { a[i * 90] = d; return a; }, {}));

/** v1 可作图的 op（cutQuad/paintQuad/paintDouble 的 4 路形态、wire、隧道一律拒）*/
export const V1_OPS = Object.freeze([
	"mine", "cut", "rotate", "rotateCCW", "rotate180", "paint", "paintMirrored", "mix", "stack", "trash",
]);

/* ═════════════════ 内部：小工具（P1 没提供的洞在本文件补，不改 grid/types）═════════════════ */

/**
 * G7 象限断言：只接受严格等于 0/90/180/270 的角度（含等价负角与 +360k），脏角度 → 结构化抛错。
 * 刻意**不量化**：belt-rules 的 rotateLocal 是截断、angleToDir 是量化，两者语义不同（NOTES G7），
 * 本包宁可拒绝也不能猜。
 */
export function assertQuadrantAngle(angle, path = "angle") {
	if (typeof angle !== "number" || !Number.isFinite(angle)) {
		throw new ContractViolation(path, "有限的数字角度（0|90|180|270）", angle);
	}
	const norm = ((Math.trunc(angle) % 360) + 360) % 360;
	if (norm !== 0 && norm !== 90 && norm !== 180 && norm !== 270) {
		throw new ContractViolation(path, "0|90|180|270（脏角度 → 拒绝，绝不静默量化/截断）", angle);
	}
	return norm;
}

const add = (c, d) => [c[0] + DIRV[d][0], c[1] + DIRV[d][1]];
const addN = (c, d, n) => [c[0] + DIRV[d][0] * n, c[1] + DIRV[d][1] * n];
const sameCell = (a, b) => a[0] === b[0] && a[1] === b[1];
const isVert = d => DIRV[d][0] === 0;
const armKey = (a, b) => [a, b].sort().join("+");
/** 一格的"臂对"是否为拐角（入口面的反面 !== 出口面 ⇒ 走向改变）*/
const isCorner = (inDir, outDir) => OPP[inDir] !== outDir;

/** 沿 dir 从 a 走到 b：同轴且正距离 */
function rayAligned(a, b, dir) {
	const [dx, dy] = DIRV[dir];
	if (dx !== 0) return a[1] === b[1] && (b[0] - a[0]) * dx > 0;
	return a[0] === b[0] && (b[1] - a[1]) * dy > 0;
}
/** 轴对齐直线格序列（含两端；a===b → 单元素）*/
function lineCells(a, b) {
	const out = [[a[0], a[1]]];
	let cur = out[0], guard = 0;
	while (!sameCell(cur, b) && guard++ < MAX_CHANNEL_CELLS) {
		cur = cur[0] !== b[0]
			? [cur[0] + Math.sign(b[0] - cur[0]), cur[1]]
			: [cur[0], cur[1] + Math.sign(b[1] - cur[1])];
		out.push(cur);
	}
	if (!sameCell(cur, b)) throw new ContractViolation("lineCells", "a、b 必须轴对齐（或重合）", [a, b]);
	return out;
}
const cmpNum = (a, b) => {
	if (!Number.isFinite(a) || !Number.isFinite(b)) throw new ContractViolation("cmpNum", "有限数字", [a, b]);
	return a < b ? -1 : a > b ? 1 : 0;
};
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 机器 kind → 锚点格字符 */
function glyphFor(kind, op) {
	if (kind === "painter") return op === "paintMirrored" ? GRID_CHARS.painterMirrored : GRID_CHARS.painter;
	return GRID_CHARS[kind] || GRID_CHARS.trash;
}

/** 带子格符号：臂对 = {inDir,outDir}。对置→直带箭头，垂直→拐角字母。 */
function beltGlyph(inDir, outDir) {
	if (inDir === outDir) throw new ContractViolation("beltGlyph", "inDir !== outDir（belt-rules.mjs:43）", { inDir, outDir });
	const arms = armKey(inDir, outDir);
	if (arms === armKey("top", "bottom")) return inDir === "bottom" ? GRID_CHARS.belt_top : GRID_CHARS.belt_bottom;
	if (arms === armKey("left", "right")) return outDir === "right" ? GRID_CHARS.belt_right : GRID_CHARS.belt_left;
	if (arms === armKey("bottom", "left")) return GRID_CHARS.corner_bottom_left;
	if (arms === armKey("top", "right")) return GRID_CHARS.corner_top_right;
	if (arms === armKey("top", "left")) return GRID_CHARS.corner_top_left;
	if (arms === armKey("bottom", "right")) return GRID_CHARS.corner_bottom_right;
	throw new ContractViolation("beltGlyph", "四方位臂对之一", arms);
}

/* ═════════════ 槽位读取：一切几何只从 op-templates 取（r=0 = 决策 D1）═════════════ */

/** 输入槽（role/dir/局部格）；导出是为让 L0 与 P4/P5 用同一张真值表而不是各抄一份 */
export const inSlotsOf = n => (n.template.inputs || []).map(s => ({ role: s.role, dir: s.dir, cx: s.cell[0], cy: s.cell[1] }));
/** 输出槽 */
export const outSlotsOf = n => (n.template.outputs || []).map(s => ({ role: s.role, dir: s.dir, cx: s.cell[0], cy: s.cell[1] }));
/** 槽位绝对格（布局坐标系；v1 不平移到世界）*/
const slotCell = (node, slot) => [node.x + slot.cx, node.y + slot.cy];
/** 槽位外侧第一格带子（机器喷出的那一格 / 进入机器的前一格）*/
const beltSide = (cell, dir) => add(cell, dir);

/* ═════════════════════ 1) 世界闸 + DAG/scope 闸（§2.5 归因顺序）═════════════════ */

/**
 * 世界闸（§1.3 输入约定 / §2.6 / §6 R2）：v1 **只支持全新址** —— entities 为空或仅 hub。
 * 既有非 hub 实体 = 增量对接，v1 明确不做。既有占用一律报进 LayoutReport.occupancy
 * （P5 的 V1/V2 判据数据源；hub 铺开成 16 条 solid，逐格可查）。
 */
export function validateWorld(world) {
	if (world === null || world === undefined) return { ok: true, occupancy: [], hub: null };
	if (typeof world !== "object" || Array.isArray(world)) {
		return makeFailure("no-resource-in-range", null, "WorldState 必须是对象或 null（§2.6）");
	}
	const ents = Array.isArray(world.entities) ? world.entities : [];
	const others = ents.filter(en => en && en.type !== "hub");
	if (others.length) {
		return makeFailure("out-of-scope:rotated-machine", null,
			`v1 只支持全新址（entities 为空或仅 hub）：既有 ${others.length} 个非 hub 实体 → 增量对接未实现（plan §6 R2）`);
	}
	const occupancy = [];
	for (const en of ents) {
		if (en.type === "hub") {
			for (let dy = 0; dy < HUB_SIZE; dy++) for (let dx = 0; dx < HUB_SIZE; dx++) {
				occupancy.push({ cell: [en.x + dx, en.y + dy], state: "solid", who: "hub", kind: "hub" });
			}
			continue;
		}
		occupancy.push({
			cell: [en.x, en.y],
			state: en.type === "belt" ? "replaceable" : "solid",
			who: String(en.uid), kind: String(en.type),
		});
	}
	const hub = world.hub || ents.find(en => en.type === "hub") || null;
	return { ok: true, occupancy, hub, seed: world.seed };
}

/**
 * 归一化 solver steps → 节点表（含合成矿机）。
 * 输入约定（§1.3）：`{op,args,inputs,hash}`，**op 名映射表在 P8**，本包只认 op-templates 的 op。
 * inputs 元素 = 上游节点 hash；查不到 hash 的视为**资源 shortKey** → 合成一台矿机（同 hash 复用一台）。
 * 闸的顺序 = reason 归因顺序：op 合法 → v1Blocked → fan-in → fan-out → 多层 → 脏角度 → 层号 → 单产出线。
 */
export function buildDag(steps, opts = {}) {
	if (!Array.isArray(steps) || steps.length === 0) {
		return makeFailure("dag-not-placeable:fanin>2", null, "steps 为空：没有可作图的节点");
	}
	const byHash = new Map();
	const nodes = [];
	steps.forEach((s, i) => {
		if (!s || typeof s !== "object" || Array.isArray(s)) {
			throw new ContractViolation(`steps[${i}]`, "{op,args,inputs,hash}", s);
		}
		const op = typeof s.op === "string" ? s.op : "mine";
		if (!ALL_TEMPLATES[op]) throw new ContractViolation(`steps[${i}].op`, "op-templates 已知 op 名（P8 负责映射到本表）", op);
		const hash = typeof s.hash === "string" ? s.hash : `h${i}`;
		if (byHash.has(hash)) throw new ContractViolation(`steps[${i}].hash`, "唯一 hash（solver 已去重）", hash);
		const n = {
			id: typeof s.id === "string" ? s.id : `n${i}`,
			op, template: ALL_TEMPLATES[op], args: s.args || {},
			inputs: Array.isArray(s.inputs) ? s.inputs : [], hash,
			depth: Number.isInteger(s.depth) && s.depth >= 0 ? s.depth : null,
			parents: [], consumers: 0, usedOut: new Set(), nextOut: 0, x: 0, y: 0,
		};
		byHash.set(hash, n);
		nodes.push(n);
	});

	// 资源输入 → 合成矿机（一个资源 shortKey 一台矿机；M4 前置条件"两矿不同列"由 pickResourceCells 保证）
	const miners = new Map();
	for (const n of nodes) {
		n.parents = n.inputs.map(ih => {
			if (ih === undefined || ih === null || ih === "") return null;
			const p = byHash.get(ih);
			if (p) { p.consumers++; return p; }
			let mn = miners.get(ih);
			if (!mn) {
				mn = {
					id: `m${miners.size}`, op: "mine", template: ALL_TEMPLATES.mine, args: {},
					inputs: [], hash: ih, resource: ih, depth: 0, parents: [], consumers: 0,
					usedOut: new Set(), nextOut: 0, x: 0, y: 0,
				};
				miners.set(ih, mn); byHash.set(ih, mn); nodes.push(mn);
			}
			mn.consumers++;
			return mn;
		});
		// 缺槽补齐（模板槽数 > inputs 数时，多余槽留空 → 后面接 trash 判定用）
		while (n.parents.length < n.template.inputs.length) n.parents.push(null);
	}

	for (const n of nodes) {
		if (!V1_OPS.includes(n.op)) {
			return makeFailure("out-of-scope:wire", { nodeId: n.id, cell: null, check: "V8-scope" },
				`op ${n.op} 不在 v1 作图集合（${V1_OPS.join("/")}）：wire/隧道/4 路变体在 v1 无汇合方案`);
		}
		if (n.template.v1Blocked) {
			return makeFailure("out-of-scope:multilayer", { nodeId: n.id, cell: null, check: "V8-scope" },
				`${n.op} 在 op-templates 被标 v1Blocked（4 路输出需 v1 之外的汇合方案）`);
		}
		const inCount = n.parents.filter(Boolean).length;
		if (inCount > n.template.inputs.length || inCount > SCOPE_V1.maxFanIn) {
			return makeFailure("dag-not-placeable:fanin>2", { nodeId: n.id, cell: null, check: "V5-degree" },
				`入度 ${inCount} 超过可用输入槽 ${n.template.inputs.length}（v1 maxFanIn=${SCOPE_V1.maxFanIn}）：请先在配方层二化成二叉树`);
		}
		if (n.consumers > 1) {
			return makeFailure("dag-not-placeable:crossing-needs-tunnel", { nodeId: n.id, cell: null, check: "V6-crossing" },
				`扇出 ${n.consumers} > 1：同一输出被多条通道共享，v1 行式布局无扇出模板（需隧道 → scope.tunnels:false）`);
		}
		// 多层（scope.layers 的**结构**含义，见 NOTES N-1 / CONTEST）：
		//   stacker 的单次合成（2 个**非堆叠**上游 → 1 个 2 层形状）是 v1 支持且 M4 实机验证过的，
		//   其输出 hash 含 ':'（如 "CuCuSuSu:RuRuCuCu"）是**合法**的（P1 report-layout.json 就这么写）。
		//   真正越界的是**堆叠嵌套堆叠**（stack 的某个输入又是 stack 的产物）= 需要 ≥2 层合成级，
		//   v1 只支持一条产出线上的**一次**合成，嵌套堆叠要的是多条并行产线/立体 → out-of-scope:multilayer。
		//   "4 输入两层堆叠"金样例（④）正是这一型，按此规则拒绝，并在 CONTEST.md 记录与 §1.3 字面的张力。
		if (n.op === "stack" && n.parents.some(p => p && p.op === "stack")) {
			return makeFailure("out-of-scope:multilayer", { nodeId: n.id, cell: null, check: "V8-scope" },
				`节点 ${n.id} 把「堆叠机的产物」再喂给堆叠机（嵌套堆叠 ⇒ ≥2 合成级）：v1 每条产出线只做一次合成（§0 scope.layers=1 的结构含义），4 输入两层堆叠需要多条独立产线 → 归 v1.1 多行复制（plan §7.1-2）`);
		}
		// G7：args 内任何角度/旋转字段必须是干净象限角
		for (const k of ["angle", "rot", "rotation", "rotationVariant"]) {
			if (n.args[k] !== undefined && n.args[k] !== null) {
				try { assertQuadrantAngle(n.args[k], `${n.id}.args.${k}`); }
				catch (e) {
					return makeFailure("out-of-scope:rotated-machine", { nodeId: n.id, cell: null, check: "V8-scope" },
						`args.${k} 是脏角度（G7 象限断言）：${e.message}`.slice(0, 220));
				}
			}
		}
	}

	// 层号：显式 depth 优先，缺失按最长路径现算（顺带挡环）
	const memo = new Map(); const visiting = new Set();
	const depthOf = n => {
		if (memo.has(n.id)) return memo.get(n.id);
		if (visiting.has(n.id)) throw new ContractViolation("buildDag.depth", "DAG 必须无环（发现回边）", n.id);
		visiting.add(n.id);
		const ps = n.parents.filter(Boolean);
		const d = ps.length ? Math.max(...ps.map(depthOf)) + 1 : 0;
		visiting.delete(n.id); memo.set(n.id, d);
		return d;
	};
	let calc = null;
	try { calc = nodes.map(n => (n.depth === null ? depthOf(n) : n.depth)); }
	catch (e) {
		if (e instanceof ContractViolation) return makeFailure("dag-not-placeable:fanin>2", null, e.message.slice(0, 220));
		throw e;
	}
	nodes.forEach((n, i) => { n.depth = calc[i]; });
	if (nodes.some(n => !Number.isInteger(n.depth) || n.depth < 0)) {
		return makeFailure("dag-not-placeable:fanin>2", null, "层号计算异常（存在负值/非整数 depth）");
	}

	const terminals = nodes.filter(n => n.consumers === 0 && n.op !== "trash");
	if (terminals.length > 1 && opts.allowMultiTerminal !== true) {
		return makeFailure("out-of-scope:multilayer", { nodeId: terminals[1].id, cell: null, check: "V8-scope" },
			`产出端 ${terminals.length} 个：v1 只画一条产出线（instanceIdx 恒 0，多行复制归 v1.1，plan §7.1-2）`);
	}
	return { ok: true, nodes, terminals, byHash };
}

/* ═══════════════ 2) 拓扑分层 + 层内 barycenter（父子保序）═══════════════ */

/**
 * routing-prior-art.md §1.3/§8 主干第一步：分层 → 层内 barycenter **且父子保序**。
 * 父子保序是"无纵向约束 ⇒ 无交叉"的充分条件（§1 的 27405 例穷举实测），故 barycenter 之后
 * 强制用"原序"做次键、id 做三键（三重 tie-break ⇒ 完全确定）。
 * level 0 = 矿机层，画在**最下**（y 最大）。
 */
export function layerAndOrder(nodes) {
	const maxDepth = Math.max(...nodes.map(n => n.depth));
	const levels = Array.from({ length: maxDepth + 1 }, () => []);
	for (const n of nodes) levels[n.depth].push(n);
	levels.forEach(l => l.sort((a, b) => cmpStr(a.id, b.id)));

	const rank = new Map();
	const renumber = () => levels.forEach(l => l.forEach((n, i) => rank.set(n.id, i)));
	renumber();
	for (let pass = 0; pass < 4; pass++) {
		const sweep = pass % 2 === 0
			? levels.map((_, i) => i).slice(1)                 // 自下而上
			: levels.map((_, i) => i).slice(0, -1).reverse();   // 自上而下
		for (const li of sweep) {
			const list = levels[li];
			const bary = new Map();
			for (const n of list) {
				const rel = n.parents.filter(Boolean).map(p => rank.get(p.id)).filter(v => v !== undefined);
				bary.set(n.id, rel.length ? rel.reduce((a, b) => a + b, 0) / rel.length : rank.get(n.id));
			}
			list.sort((a, b) =>
				cmpNum(bary.get(a.id), bary.get(b.id)) ||
				cmpNum(rank.get(a.id), rank.get(b.id)) ||
				cmpStr(a.id, b.id));
			list.forEach((n, i) => rank.set(n.id, i));
		}
	}
	return levels;
}

/* ═════════════════════════ 3) 行式坐标分配 ═════════════════════════ */

/**
 * 每层一条水平轨道；层内按序定列；**父子尽量同列 = 零拐角第一原则**的几何落点：
 *   - 竖直进料（dir=bottom）与父同列 ⇒ 一条纯竖直带（下进上出机器可直串，GRID-LAYOUT:41-62）
 *   - 2×1 机器（cutter/stacker/mixer）的第二路落在锚点右格 ⇒ 父列 = 锚点列 + 1
 *   - 水平进料（painter 的 shape←left）⇒ 父列 = 槽格外侧列（本机列 - 1 - cx）
 * @returns {{levels:Array, rows:Array, occupied:Map<string,Set<string>>}}
 */
export function assignRows(levels, opts = {}) {
	const rowGap = opts.rowGap === undefined ? ROW_H : opts.rowGap;
	const colGap = opts.colGap === undefined ? COL_GAP : opts.colGap;
	const occupied = new Map();                       // "y" → Set("x")
	const claim = (n, x0) => {
		for (let dy = 0; dy < n.h; dy++) {
			const s = occupied.get(String(n.row + dy)) || new Set();
			for (let x = x0; x <= x0 + n.w - 1; x++) s.add(String(x));
			occupied.set(String(n.row + dy), s);
		}
	};
	const unclaim = n => {
		for (let dy = 0; dy < n.h; dy++) {
			const s = occupied.get(String(n.row + dy));
			if (!s) continue;
			for (let x = n.x; x < n.x + n.w; x++) s.delete(String(x));
		}
	};
	const rows = [];
	const baseY = (levels.length - 1) * rowGap;
	levels.forEach((list, li) => {
		const y = baseY - li * rowGap;
		list.forEach(n => { n.row = y; n.y = y; });
		rows.push({ level: li, y, nodeIds: list.map(n => n.id) });
	});

	// 第一遍：自下而上，先满足父列，撞占用则单向右移（确定性）
	levels.forEach((list, li) => {
		let cursor = 0;
		for (const n of list) {
			n.w = n.template.footprint[0];
			n.h = n.template.footprint[1];
			let x = cursor;
			if (li > 0) {
				const want = desiredX(n);
				if (want !== undefined) x = Math.max(cursor, want);
			}
			let guard = 0;
			while (clash(occupied, n.row, x, x + n.w - 1, n.h) && guard++ < 4096) x++;
			n.x = x;
			claim(n, x);
			cursor = x + n.w + colGap;
		}
	});
	// 第二遍：把"让位造成的偏移"拉回父列（不撞才动）—— 零拐角优先
	for (let li = levels.length - 1; li >= 0; li--) {
		for (const n of levels[li]) {
			const want = desiredX(n);
			if (want === undefined || want === n.x || want < 0) continue;
			if (clash(occupied, n.row, want, want + n.w - 1, n.h)) continue;
			unclaim(n); n.x = want; claim(n, want);
		}
	}
	return { levels, rows, occupied };
}

/** 本机锚点理想列 = 主输入的父列反推（无父/父未定列 → undefined）*/
export function desiredX(n) {
	const ps = n.parents.filter(Boolean);
	if (!ps.length || ps.every(p => p.x === undefined)) return undefined;
	const slots = inSlotsOf(n);
	if (!slots.length) return undefined;
	// 主输入 = 第一个竖直进料口（下进上出）；纯水平机器（painter）用第 0 槽
	let idx = slots.findIndex(s => s.dir === "bottom");
	if (idx < 0) idx = 0;
	const p = ps[idx] || ps[0];
	if (!p || p.x === undefined) return undefined;
	const s = slots[idx];
	if (s.dir === "left") return p.x + 1 - s.cx;      // 父列的右侧一格是带子格 ⇒ 锚点 = 父列 + 1 - cx
	if (s.dir === "right") return p.x - 1 - s.cx;
	return p.x - s.cx;                                 // bottom/top：同列直入（2×1 的第二路自动 +1）
}

function clash(occupied, y, x0, x1, h) {
	for (let dy = 0; dy < h; dy++) {
		const s = occupied.get(String(y + dy));
		if (!s) continue;
		for (let x = x0; x <= x1; x++) if (s.has(String(x))) return true;
	}
	return false;
}

/* ═════════════════════ 4) 通道规划（几何；绝不产 belt code）═════════════════════ */

/**
 * 一条通道的带子格序列 + 拐角数 + 车道行。签名里的 d1/d2 是**带子行进方位**：
 *   d1 = 上游输出槽朝向（物品喷出方向）；d2 = OPP[下游输入槽朝向]
 *   first = add(fromCell, d1)；last = add(toCell, inDir)
 *
 * 按拐角数升序尝试（第一原则：零拐角优先；每种形态都是纯几何判定，无回退猜测）：
 *   straight   0 拐角  d1===d2 且同轴正向
 *   endTurn    1 拐角  同轴直走到末格才拐弯（painter 的 shape←left 落这一型）
 *   startTurn  1 拐角  首格立即拐弯再直走（color←top 的上方供料落这一型）
 *   degenerate 1 拐角  first===last（机器紧邻，一格带子接两张脸）
 *   elbow      1 拐角  d1 ⟂ d2 且拐点严格在中间
 *   z          2 拐角  竖直→拐角→车道→拐角→目标列（**M4 实证形态**）
 * @param {{occupied?:Set<string>, lanePool?:Set<string>, strictLane?:boolean}} ctx
 * @returns {{ok:true,kind:string,cells:Array,lane:number|null,cornerCount:number}
 *          | {ok:false,why:"cell-occupied"|"column-conflict"|"no-turn",at:Array}}
 */
export function planChannel(first, d1, last, inDir, ctx = {}) {
	const d2 = OPP[inDir];
	const xy = c => (Array.isArray(c) ? c : c.cell);                 // 有的路径传裸 [x,y]，有的传 {cell,...}
	const blocked = c => ctx.occupied && ctx.occupied.has(cellKey(xy(c)[0], xy(c)[1]));
	const free = cells => !cells.some(blocked);

	// ① 直线（0 拐角）
	if (d1 === d2 && rayAligned(first, last, d1)) {
		const cells = lineCells(first, last);
		if (!free(cells)) return { ok: false, why: "cell-occupied", at: cells.find(blocked) };
		return { ok: true, kind: "straight", lane: null, cornerCount: 0,
			cells: cells.map(c => ({ cell: c, inDir: OPP[d1], outDir: d1 })) };
	}
	// ② 同轴直走 + 末格拐弯（1 拐角）
	if (rayAligned(first, last, d1)) {
		const cells = lineCells(first, last).map(c => ({ cell: c, inDir: OPP[d1], outDir: d1 }));
		cells[cells.length - 1].outDir = d2;
		if (isVert(d1) === isVert(d2)) return { ok: false, why: "no-turn", at: last };   // 同轴对置已由 ①/⑥ 处理
		if (!free(cells)) return { ok: false, why: "cell-occupied", at: cells.find(blocked) };
		return { ok: true, kind: "endTurn", lane: null, cornerCount: 1, cells };
	}
	// ③ 首格拐弯 + 直走（1 拐角）：d1 ⟂ d2 且 first/last 沿末段轴对齐（拐点在首格）
	if (d1 !== d2 && OPP[d1] !== d2 && isVert(d1) !== isVert(d2) && rayAligned(first, last, d2)) {
		const cells = lineCells(first, last).map(c => ({ cell: c, inDir: OPP[d1], outDir: d1 }));
		cells[0].outDir = d2;
		for (let i = 1; i < cells.length; i++) { cells[i].inDir = OPP[d2]; cells[i].outDir = d2; }
		if (!free(cells)) return { ok: false, why: "cell-occupied", at: cells.find(blocked) };
		return { ok: true, kind: "startTurn", lane: null, cornerCount: 1, cells };
	}
	// ④ 退化段（一格双脸）
	if (sameCell(first, last)) {
		if (OPP[d1] === d2) return { ok: false, why: "no-turn", at: first };
		if (blocked(first)) return { ok: false, why: "cell-occupied", at: first };
		const cell = { cell: first, inDir: OPP[d1], outDir: d2 };
		return { ok: true, kind: "degenerate", lane: null, cornerCount: isCorner(cell.inDir, cell.outDir) ? 1 : 0, cells: [cell] };
	}
	// ⑤ 单拐点（严格居中）：先沿 d1 走到拐点 el，再沿 d2 走到 last
	if (d1 !== d2 && OPP[d1] !== d2) {
		const el = isVert(d1) ? [first[0], last[1]] : [last[0], first[1]];
		if (!sameCell(el, first) && !sameCell(el, last) && rayAligned(first, el, d1) && rayAligned(el, last, d2)) {
			const path = lineCells(first, el);          // 含 el
			for (const c of lineCells(el, last)) if (!sameCell(c, el)) path.push(c);
			const cells = tagPath(path, el, d1, d2);
			if (sameCell(cells[cells.length - 1].cell, last)) {
				if (!free(cells)) return { ok: false, why: "cell-occupied", at: cells.find(blocked) };
				return { ok: true, kind: "elbow", lane: null, cornerCount: countPathCorners(cells), cells };
			}
		}
	}
	// ⑥ Z（M4 形态）：两拐点 + 一条车道
	const lane = pickLane(first, d1, last, d2, ctx);
	if (lane === null) return { ok: false, why: "column-conflict", at: first };
	const a = isVert(d1) ? [first[0], lane] : [lane, first[1]];
	const b = isVert(d1) ? [last[0], lane] : [lane, last[1]];
	// 同轴反向且同列/同行 ⇒ a===b，"上去再原路回来"需要 4 拐角（v1 无隧道 → 拒，不硬凑）
	if (sameCell(a, b)) return { ok: false, why: "column-conflict", at: first };
	const dH = isVert(d1) ? (a[0] <= b[0] ? "right" : "left") : (a[1] <= b[1] ? "bottom" : "top");
	if (!rayAligned(first, a, d1) || !rayAligned(b, last, d2)) {
		return { ok: false, why: "column-conflict", at: first };
	}
	const cells = [];
	for (const c of lineCells(first, a)) cells.push({ cell: c, inDir: cells.length ? OPP[cells[cells.length - 1].outDir] : OPP[d1], outDir: sameCell(c, a) ? dH : d1 });
	for (const c of lineCells(a, b)) { if (sameCell(c, a)) continue; cells.push({ cell: c, inDir: OPP[dH], outDir: sameCell(c, b) ? d2 : dH }); }
	for (const c of lineCells(b, last)) { if (sameCell(c, b)) continue; cells.push({ cell: c, inDir: OPP[cells[cells.length - 1].outDir], outDir: d2 }); }
	if (!sameCell(cells[cells.length - 1].cell, last)) return { ok: false, why: "no-turn", at: last };
	const raw = cells.map(x => x.cell);
	if (raw.some(blocked)) return { ok: false, why: "cell-occupied", at: raw.find(blocked) };
	const cornerCount = cells.filter(x => isCorner(x.inDir, x.outDir)).length;
	return { ok: true, kind: cornerCount === 2 ? "z" : "z-degraded", lane, cornerCount, cells };
}

/**
 * 折线路径逐格 (inDir,outDir)：拐点 el **之前**沿 d1，el **及之后**沿 d2。
 * 首格 inDir=OPP[d1]（上游喷出面的反面），每格 inDir = 前一格 outDir 的反面 ⇒ 链条自洽（P4 直接吃）。
 */
function tagPath(cells, el, d1, d2) {
	const out = [];
	let reachedEl = false;
	for (let i = 0; i < cells.length; i++) {
		const c = cells[i];
		if (sameCell(c, el)) reachedEl = true;
		const outDir = reachedEl ? d2 : d1;
		out.push({ cell: c, inDir: i === 0 ? OPP[d1] : OPP[out[i - 1].outDir], outDir });
	}
	return out;
}
/** 路径里的拐角格数（inDir/outDir 不对置 = 拐弯）*/
const countPathCorners = cells => cells.filter(c => isCorner(c.inDir, c.outDir)).length;

/**
 * Z 的车道行（竖直通道）/车道列（水平通道）。
 * 可行区间由两段的方向约束解出：
 *   段一 first→a=(first.x,lane) 沿 d1 ⇒ (lane-first[axis])·DIRV[d1][axis] > 0
 *   段三 b=(last.x,lane)→last 沿 d2 ⇒ (last[axis]-lane)·DIRV[d2][axis] > 0
 * 候选按"离末格最近"排序（M4 实机形态：车道紧贴目标机器的进料行），并列取区间内更靠 d1 侧的一支，
 * 保证确定性。strictLane 时跳过已被别占的行车道；全被占 → 交调用方上报 lane-column（解法归 P4）。
 * @returns {number|null}
 */
function pickLane(first, d1, last, d2, ctx) {
	const vert = isVert(d1);
	if (vert !== isVert(d2)) return null;              // 混合轴已由 ②③⑤ 覆盖
	const axis = vert ? 1 : 0;                          // 竖直通道 ⇒ 车道是一条"行"（固定 y）
	const f = first[axis], l = last[axis];
	let lo = -Infinity, hi = Infinity;
	if (DIRV[d1][axis] > 0) lo = Math.max(lo, f + 1); else hi = Math.min(hi, f - 1);
	if (DIRV[d2][axis] > 0) hi = Math.min(hi, l - 1); else lo = Math.max(lo, l + 1);
	if (!Number.isFinite(lo)) lo = Math.min(f, l) - 8;
	if (!Number.isFinite(hi)) hi = Math.max(f, l) + 8;
	if (lo > hi) return null;
	const pool = ctx.lanePool || new Set();
	// 区间内全部整数，按 |v-l| 再按 v 升序（完全确定的排序）
	const cands = [];
	for (let v = Math.ceil(lo); v <= Math.floor(hi); v++) cands.push(v);
	cands.sort((a, b) => cmpNum(Math.abs(a - l), Math.abs(b - l)) || cmpNum(a, b));
	for (const v of cands) {
		const key = vert ? `row:${v}` : `col:${v}`;
		if (ctx.strictLane && pool.has(key)) continue;
		return v;
	}
	return null;
}

/* ═════════════════════════ 5) 落子（Grid 占用）════════════════════════ */

/**
 * 节点按 footprint 落进 Grid（**rot 恒 0、rv 恒 0** —— 决策 D1/G1）。
 * 同格二次放置由 grid.occupyRect 抛 `cell already occupied`（C1：整单 abort，绝不静默覆盖）。
 */
export function placeMachines(grid, nodes) {
	const out = [];
	for (const n of nodes) {
		const fp = n.template.footprint;
		const r = grid.occupyRect(n.x, n.y, fp[0], fp[1], n.id, {
			rot: 0, kind: "machine", kindName: n.template.kind || n.op,
		});
		out.push({ nodeId: n.id, cells: r.cells });
	}
	return out;
}

/**
 * 资源格选择（离线 world.mjs）。给 seed 才做；**不同列优先**
 * （M4-SUCCESS 前置条件：两矿同列 ⇒ 两条竖直通道重叠）。找不到 → no-resource-in-range。
 * @returns {{ok:true,table:Map|null}|{ok:false,reason,failingNode,hint}}
 */
export function pickResourceCells(nodes, input) {
	const miners = nodes.filter(n => n.op === "mine");
	if (!miners.length) return { ok: true, table: new Map() };
	const seed = input.seed !== undefined && input.seed !== null ? input.seed : (input.world && input.world.seed);
	if (seed === undefined || seed === null) return { ok: true, table: null };   // 无 seed：矿机当普通节点，不做资源校验
	const center = input.site ? [input.site.x, input.site.y] : (input.hub ? [input.hub.x, input.hub.y] : [0, 0]);
	const region = input.region || regionAround(center, input.range === undefined ? 48 : input.range);
	const usedCols = new Set();
	const table = new Map();
	for (const n of miners) {
		const want = n.resource || n.hash;
		let hit = nearestResource(seed, s => s === want, center, region);
		if (!hit) return makeFailure("no-resource-in-range", { nodeId: n.id, cell: null, check: "V1-occupancy" },
			`seed=${seed}、以 ${center.join(",")} 为心半径 ${region.x1 - center[0]} 内没有资源 ${want}`);
		if (usedCols.has(hit[0])) {
			const alt = findResource(seed, s => s === want, region)
				.filter(c => !usedCols.has(c[0]))
				.sort((a, b) => (Math.hypot(a[0] - center[0], a[1] - center[1]) - Math.hypot(b[0] - center[0], b[1] - center[1])) || cmpStr(a.join(","), b.join(",")))[0];
			if (alt) hit = [alt[0], alt[1]];
		}
		usedCols.add(hit[0]);
		table.set(n.id, [hit[0], hit[1]]);
	}
	return { ok: true, table };
}

/* ═══════════════ 6) 未用输出槽 → trash（陷阱表：忘了接就堵死）═══════════════ */

/**
 * 未接走的输出槽**必须**自动接 trash（mustDiscardUnused / layout-grid.mjs:90-92 的写死做法）。
 * 本函数只按确定性顺序**枚举候选落点**（真正放不放得下由调用方 route 时判定，撞路则换下一候选）。
 * 候选顺序：
 *   ① 直串：输出口外侧第 2 格起外推（acceptor=OPP[out.dir]，中间留 1 格带子）—— 零拐角优先
 *   ② 侧让：直串全撞时，trash 放到带子首格的**垂直侧**（acceptor=OPP[perp]，首格成为 1 拐角带）。
 *      典型：painter 的 right 输出撞上绕行的 color 竖直腿。拐角如实计入 cornerCount（度量诚实，非近似）。
 * @returns {Array<{cell:number[], acceptor:string}>} 有序候选（落点格 + 该 trash 的 acceptor 方位）
 */
export function trashCandidates(n, outIdx) {
	const out = outSlotsOf(n)[outIdx];
	const slot0 = slotCell(n, out);
	const first = beltSide(slot0, out.dir);
	const cands = [];
	for (let k = 2; k <= 2 + TRASH_PUSH_MAX; k++) cands.push({ cell: addN(slot0, out.dir, k), acceptor: OPP[out.dir] });
	for (const perp of (isVert(out.dir) ? ["left", "right"] : ["top", "bottom"])) {
		cands.push({ cell: add(first, perp), acceptor: OPP[perp] });
	}
	return cands;
}

/* ═══════════ 7) hub 入口（表来自 op-templates.hubEntriesWorld，裁决 K1）═══════════ */

/**
 * 把 hubEntriesWorld(origin) 换算成 placer 需要的四元组：
 *   cell = 带子末格（P1 fixtures 的 hubConnection.entry）
 *   face = 贴的 hub 边 = hub 槽位的 acceptor 方位（§对齐口径 ③）
 *   dir  = 带子流向角度（G7 过象限断言，脏值 → 结构化错误）
 *   slotCell = add(cell, 流向方位) = hub 槽位的绝对格
 * @param {[number,number]} hubOrigin
 */
export function hubEntries(hubOrigin) {
	if (!Array.isArray(hubOrigin) || hubOrigin.length !== 2) {
		throw new ContractViolation("hubEntries(hubOrigin)", "[x,y]", hubOrigin);
	}
	return hubEntriesWorld(hubOrigin).map((e, i) => {
		const dir = assertQuadrantAngle(e.dir, `hubEntriesWorld()[${i}].dir`);
		const flow = ANGLE_DIR[dir];
		return {
			i, cell: [e.cell[0], e.cell[1]], face: e.face, dir, flow,
			inDir: e.face,
			slotCell: add(e.cell, flow),
		};
	});
}

/* ═════════════════════════ 8) 主入口 ═════════════════════════ */

/**
 * @param {object} input
 * @param {Array<{op:string,args:object,inputs:string[],hash:string,depth?:number,id?:string}>} input.steps
 * @param {object} [input.world] WorldState（§2.6）；v1 只支持全新址
 * @param {number} [input.seed] 给了则校验资源格（§1.3 验收：no-resource-in-range）
 * @param {{x:number,y:number}} [input.site] 厂区锚点
 * @param {{x:number,y:number}} [input.hub] hub 左上角
 * @param {number} [input.demandPerSec] v1 仅记录进 meta（G10：items/s 口径，本包不做换算）
 * @param {boolean} [input.connectHub] 给了 hub 默认连；否则顶层输出接 trash
 * @param {number} [input.rowGap] @param {number} [input.colGap]
 * @param {number} [input.instanceIdx] v1.1 多行复制预留；v1 恒 0
 * @param {boolean} [input.allowMultiTerminal] 显式放开"多产出线"（仅测试用）
 * @returns {LayoutReport | {ok:false,reason:string,failingNode:object,hint:string}}
 */
export function place(input = {}) {
	const w = validateWorld(input.world);
	if (w.ok === false) return w;

	let dag;
	try { dag = buildDag(input.steps, { allowMultiTerminal: input.allowMultiTerminal === true }); }
	catch (e) {
		if (e instanceof ContractViolation) return makeFailure("out-of-scope:multilayer", null, `steps 归一化失败：${e.message}`.slice(0, 220));
		throw e;
	}
	if (dag.ok === false) return dag;
	const nodes = dag.nodes;
	const terminals = dag.terminals;

	/* 分层 → 层内 barycenter（父子保序）→ 行式坐标 */
	const levels = layerAndOrder(nodes);
	const { rows } = assignRows(levels, { rowGap: input.rowGap, colGap: input.colGap });

	/* 落子（同格 → cell already occupied → 结构化拒因）*/
	const grid = new Grid({ name: "place" });
	try { placeMachines(grid, nodes); }
	catch (e) {
		if (/already occupied/i.test(String(e && e.message))) {
			return makeFailure("no-site-large-enough", null, `cell already occupied：${String(e.message).slice(0, 200)}`);
		}
		throw e;
	}

	/* 占用集（机器占地 + hub 占地 + 已铺带子格）*/
	const occupied = new Set();
	for (const n of nodes) {
		const fp = n.template.footprint;
		for (let dy = 0; dy < fp[1]; dy++) for (let dx = 0; dx < fp[0]; dx++) occupied.add(cellKey(n.x + dx, n.y + dy));
	}
	if (input.hub) {
		for (let dy = 0; dy < HUB_SIZE; dy++) for (let dx = 0; dx < HUB_SIZE; dx++) {
			occupied.add(cellKey(input.hub.x + dx, input.hub.y + dy));
		}
	}

	const channels = [], lanes = [], conflicts = [], beltCells = [];
	const lanePool = new Set();
	let seq = 0;

	/** 一条通道：端点对 + 几何 + 冲突上报（撞格/无解**不静默**）*/
	const route = (parent, outSlot, child, inSlot, ordinal, payload, o = {}) => {
		const fromCell = slotCell(parent, outSlot);
		const toCell = Array.isArray(o.toCell) ? o.toCell : slotCell(child, inSlot);
		const first = beltSide(fromCell, outSlot.dir);
		const last = beltSide(toCell, inSlot.dir);
		const id = o.id || `ch${seq}`;
		const r = planChannel(first, outSlot.dir, last, inSlot.dir, { occupied, lanePool, strictLane: o.strictLane === true });
		const report = {
			from: { nodeId: parent.id, cell: fromCell, slot: outSlot.dir, outDir: outSlot.dir },
			to: { nodeId: child.id, cell: toCell, slot: inSlot.dir, inDir: inSlot.dir },
			lane: null, payload,
			slotRole: o.slotRole || inSlot.role, ordinal,
		};
		seq++;
		if (r.ok === false) {
			conflicts.push({
				kind: r.why === "column-conflict" ? "lane-column" : r.why === "cell-occupied" ? "cell-occupied" : "no-turn",
				cells: [[first[0], first[1]], [last[0], last[1]]],
				nodeIds: [parent.id, child.id], resolvedBy: null,
			});
			channels.push(report);
			return { report, ok: false, why: r.why };
		}
		report.lane = r.lane;
		if (r.lane !== null) {
			const key = isVert(outSlot.dir) ? `row:${r.lane}` : `col:${r.lane}`;
			// 不同分支必须不同行（陷阱表 #5 / plan §1.3）：同一 lane 被第二条通道复用 → 上报 lane-column，
			// 但仍保留几何（车道 left-edge 的最终解法归 P4，本包只标记 + 给出凭据）。
			if (lanePool.has(key)) {
				conflicts.push({
					kind: "lane-column",
					cells: r.cells.map(b => [b.cell[0], b.cell[1]]),
					nodeIds: [parent.id, child.id], resolvedBy: null,
				});
			} else {
				lanePool.add(key);
			}
			const ex = lanes.find(l => l.row === r.lane);
			if (ex) { if (!ex.channelIds.includes(id)) ex.channelIds.push(id); }
			else lanes.push({ row: r.lane, channelIds: [id] });
		}
		for (const b of r.cells) { occupied.add(cellKey(b.cell[0], b.cell[1])); beltCells.push({ ...b, id }); }
		channels.push(report);
		return { report, ok: true, kind: r.kind, cornerCount: r.cornerCount };
	};

	/* 8.1 上游 → 本节点（按槽序；slotRole/ordinal 是给 P4 的定位凭据）*/
	for (const n of nodes) {
		const ins = inSlotsOf(n);
		n.parents.forEach((p, idx) => {
			if (!p) return;
			const outs = outSlotsOf(p);
			const outSlot = outs[Math.min(p.nextOut, outs.length - 1)];
			if (!outSlot) return;
			p.nextOut++;
			p.usedOut.add(outSlot.role);
			route(p, outSlot, n, ins[idx] || ins[0], idx, p.resource || p.hash || "");
		});
	}

	/* 8.2 hub 连接（**先于 trash**：顶层产出优先喂 hub，喂了就不再被 trash 抢走；
	 *      顺序颠倒会让同一输出口被 route 两次 —— 一次进 hub 一次进 trash，重复消费。
	 *      不连 hub（无 hub / connectHub:false）时，顶层输出口留给 8.3 的 trash 兜底。）*/
	let hubConnection = null;
	if (terminals.length && input.connectHub !== false && input.hub && input.hub.x !== undefined) {
		const term = terminals[0];
		const outs = outSlotsOf(term);
		const out = outs.find(o => !term.usedOut.has(o.role)) || null;
		if (out) {
			const entries = hubEntries([input.hub.x, input.hub.y]);
			const first = beltSide(slotCell(term, out), out.dir);
			const ranked = entries
				.map(e => ({ e, d: Math.abs(e.slotCell[0] - first[0]) + Math.abs(e.slotCell[1] - first[1]) }))
				.sort((a, b) => a.d - b.d || a.e.i - b.e.i);
			let hit = null;
			for (const { e } of ranked) {
				const snap = { occ: new Set(occupied), ch: channels.length, bl: beltCells.length, ln: lanes.length, cf: conflicts.length, lp: new Set(lanePool) };
				const r = route(term, out, { id: "hub" }, { role: "primary", dir: e.inDir, cx: 0, cy: 0 }, null,
					term.hash || "", { id: "chHub", toCell: e.slotCell, slotRole: "out", strictLane: true });
				if (r.ok) { hit = { e, r }; break; }
				// 试下一个入口：整段回滚（确定性 —— 快照/回滚只动本包的集合，不碰 grid 的机器占地）
				occupied.clear(); for (const k of snap.occ) occupied.add(k);
				channels.length = snap.ch; beltCells.length = snap.bl; lanes.length = snap.ln; conflicts.length = snap.cf;
				lanePool.clear(); for (const k of snap.lp) lanePool.add(k);
			}
			if (hit) {
				term.usedOut.add(out.role);                 // 标记消费：8.3 的 trash 不会再抢这个输出口
				hubConnection = { entry: hit.e.cell, side: hit.e.face, dir: hit.e.dir };
			} else {
				// hub 16 口全接不上 → 结构化拒因（除非显式 connectHub:false，否则不静默退回 trash）
				return makeFailure("dag-not-placeable:column-conflict-unresolved",
					{ nodeId: term.id, cell: slotCell(term, out), check: "V6-crossing" },
					`hub 的 16 个入口都接不上：竖直收集带被占或需隧道绕行（scope.tunnels:false）`);
			}
		}
	}

	/* 8.3 未用输出槽 → trash（含 cutter 右列这类 wasteRole；已被 hub 消费的输出口自动跳过）
	 *   候选位置按确定性顺序尝试，每个候选都要"落子 + 铺通道"都成立才算数（撞路则换下一候选，
	 *   快照/回滚只动本包集合，绝不留下半成品 —— 陷阱表 C1 的整单 abort 精神）。*/
	const waste = [];
	const snapshot = () => ({ occ: new Set(occupied), ch: channels.length, bl: beltCells.length, ln: lanes.length, cf: conflicts.length, lp: new Set(lanePool) });
	const restore = s => {
		occupied.clear(); for (const k of s.occ) occupied.add(k);
		channels.length = s.ch; beltCells.length = s.bl; lanes.length = s.ln; conflicts.length = s.cf;
		lanePool.clear(); for (const k of s.lp) lanePool.add(k);
	};
	for (const n of [...nodes]) {
		const outs = outSlotsOf(n);
		for (const [oi, out] of outs.entries()) {
			if (n.usedOut.has(out.role)) continue;
			if (!n.template.mustDiscardUnused) continue;
			n.usedOut.add(out.role);                        // 先标记，避免同槽二次消费
			const cands = trashCandidates(n, oi);
			let done = false, lastWhy = "no-free-cell";
			for (const cd of cands) {
				if (occupied.has(cellKey(cd.cell[0], cd.cell[1]))) { lastWhy = "cell-occupied"; continue; }
				const snap = snapshot();
				const t = {
					id: `${n.id}d${oi}`, op: "trash", template: ALL_TEMPLATES.trash, args: {}, inputs: [],
					hash: "", depth: n.depth + 1, parents: [], consumers: 0, usedOut: new Set(), nextOut: 0,
					w: 1, h: 1, x: cd.cell[0], y: cd.cell[1], row: cd.cell[1], acceptor: cd.acceptor,
					trashFor: { nodeId: n.id, outIdx: oi, role: out.role, dir: out.dir },
				};
				nodes.push(t);
				occupied.add(cellKey(t.x, t.y));
				const r = route(n, out, t, { role: "discard", dir: cd.acceptor, cx: 0, cy: 0 }, oi, n.hash || "", { slotRole: "discard" });
				if (r.ok) {
					grid.occupyRect(t.x, t.y, 1, 1, t.id, { rot: 0, kind: "machine", kindName: "trash" });
					waste.push({ nodeId: n.id, outIdx: oi, role: out.role, waste: (n.template.wasteRoles || []).includes(out.role) });
					done = true; break;
				}
				lastWhy = r.why;
				nodes.pop(); restore(snap);                 // 试下一候选：回滚 trash 节点与通道
			}
			if (!done) {
				return makeFailure("no-site-large-enough", { nodeId: n.id, cell: [n.x, n.y], check: "V9-unused-outlet" },
					`${n.id} 的输出槽 ${oi}(${out.role}) 接不上 trash（直串+侧让 ${cands.length} 个候选全失败，末因 ${lastWhy}）`);
			}
		}
	}

	/* 8.4 资源格（给 seed 才校验；结果记进 meta.minerCells，供 P8/人读选址）*/
	let resourceTable = null;
	if (input.seed !== undefined && input.seed !== null) {
		const rr = pickResourceCells(nodes, input);
		if (rr.ok === false) return rr;
		resourceTable = rr.table;
	}

	const rep = buildReport({ nodes, rows, channels, lanes, conflicts, beltCells, hubConnection,
		occupancy: w.occupancy, input, waste, resourceTable });
	assertLayoutReport(rep, "layout");
	return rep;
}

/* ═════════════════════════ 9) 报告与字符网格 ═════════════════════════ */

/**
 * LayoutReport（§2.3 逐字段）。坐标不平移；cornerCount 与渲染**同源**（同一批 beltCells 的臂对判定），
 * 并交叉断言"grid 里 7/9/L/J 的个数 === cornerCount"（不一致 = 本包 bug，抛契约错，不许静默）。
 */
function buildReport({ nodes, rows, channels, lanes, conflicts, beltCells, hubConnection, occupancy, input, waste, resourceTable }) {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	const touch = c => {
		if (!c) return;
		if (c[0] < minX) minX = c[0];
		if (c[0] > maxX) maxX = c[0];
		if (c[1] < minY) minY = c[1];
		if (c[1] > maxY) maxY = c[1];
	};
	for (const n of nodes) {
		const fp = n.template.footprint;
		touch([n.x, n.y]); touch([n.x + fp[0] - 1, n.y + fp[1] - 1]);
	}
	for (const b of beltCells) touch(b.cell);
	for (const ch of channels) { touch(ch.from.cell); touch(ch.to.cell); }
	if (hubConnection) {
		touch(hubConnection.entry);
		if (input.hub) { touch([input.hub.x, input.hub.y]); touch([input.hub.x + HUB_SIZE - 1, input.hub.y + HUB_SIZE - 1]); }
	}
	if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = -1; maxY = -1; }
	const w = Math.max(0, maxX - minX + 1), h = Math.max(0, maxY - minY + 1);

	const paint = Array.from({ length: h }, () => new Array(w).fill(GRID_CHARS.empty));
	const put = (c, g) => {
		const x = c[0] - minX, y = c[1] - minY;
		if (x >= 0 && x < w && y >= 0 && y < h) paint[y][x] = g;
	};
	for (const b of beltCells) put(b.cell, beltGlyph(b.inDir, b.outDir));
	for (const n of nodes) {
		const fp = n.template.footprint;
		for (let dy = 0; dy < fp[1]; dy++) for (let dx = 0; dx < fp[0]; dx++) put([n.x + dx, n.y + dy], GRID_CHARS.empty);
		put([n.x, n.y], glyphFor(n.template.kind || n.op, n.op));
	}
	if (hubConnection && input.hub) {
		for (let dy = 0; dy < HUB_SIZE; dy++) for (let dx = 0; dx < HUB_SIZE; dx++) put([input.hub.x + dx, input.hub.y + dy], GRID_CHARS.hub);
	}
	const grid = paint.map(r => r.join("")).join("\n");

	const cornerCells = beltCells.filter(b => isCorner(b.inDir, b.outDir));
	const cornerCount = cornerCells.length;
	const glyphCorners = (grid.match(/[79LJ]/g) || []).length;
	if (glyphCorners !== cornerCount) {
		throw new ContractViolation("layout.cornerCount",
			`拐角带子格数必须与 grid 里 7/9/L/J 的个数一致（第一原则度量与渲染同源）`, { glyphCorners, cornerCount });
	}

	const placements = nodes.map(n => ({
		nodeId: n.id, op: n.op, kind: n.template.kind || n.op,
		cell: [n.x, n.y], rot: 0,
		footprint: [n.template.footprint[0], n.template.footprint[1]],
	}));
	// meta：§2.3 之外的本包自证信息（demandPerSec 按 G10 原样记录，不做 charges/s 换算）
	const meta = {
		placeVersion: PLACE_VERSION,
		demandPerSec: input.demandPerSec === undefined ? null : input.demandPerSec,
		instanceIdx: input.instanceIdx === undefined ? 0 : input.instanceIdx,
		scope: { ...SCOPE_V1 },
		wasteRoles: waste.map(x => ({ ...x })),
		trashCount: nodes.filter(n => n.op === "trash").length,
		beltTiles: beltCells.length,
		minerCells: resourceTable ? Object.fromEntries([...resourceTable].map(([k, v]) => [k, [v[0], v[1]]])) : null,
		cornerCells: cornerCells.map(b => [b.cell[0], b.cell[1]]),
	};
	return {
		grid, rows, placements, channels, lanes, hubConnection,
		bbox: [w, h], occupancy, conflicts, cornerCount, meta,
	};
}

/* ═════════════════════════ 自测薄壳（守卫：绝不为别人的 --test 夹带输出）═════════════════════ */
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("compiler/place.mjs")) {
	console.log("place.mjs: L0 请跑 `node research/ai-plan/placer/test.mjs`（四张金网格逐字节 + 负例 + 契约 + lint）。");
}
