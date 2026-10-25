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
import { findResource, regionAround, tileResource, resourcesInRegion } from "../world.mjs";

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
/**
 * 机器簇顶行与 hub 底缘之间的**净空行数**（B-1 修复，选法 (a)：簇整体下移，簇内几何不变）。
 * 为什么必须留净空：hub 的 16 个入口是贴 4×4 的**正交邻接圈**（顶/底各 4 格、左/右各 4 格），
 * 任何带子格或**机器**若落在圈上，hub 会被算成"机器邻居"参与 computeBelt → rv 被重算
 * （belt-rules.mjs:8-10 的机器邻居角落漂移）→ P5 的 V3-belt-fixed-point 必红。
 * 只避开底排不够：左列/右列入口是 `hub.x-1` / `hub.x+HUB_SIZE` 两列，竖直废料带会撞上 ⇒ 按**整圈**算。
 * 取 3 的理由（实测 2/3/4 对比）：1 行净空时 cutter 的 trash **机器**恰好落在底排入口格 `(1,4)` 上——
 *   带子不漂（drift=0）但它永久吃掉一个 hub 入口；3 行时 trash 退到 `(1,5)`、废料带 `(1,6..7)` 全在圈外，
 *   圈上只剩**收集带末格**（那是它的职责，必须落在入口格）。4 行再多 1 行纯浪费。
 * 无 hub 时该常量不参与任何计算 → 四张金网格逐字节不变。
 */
export const HUB_CLEAR = 3;
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

/** v1 可作图的 op（cutQuad/paintQuad/paintDouble 的 4 路形态、wire、隧道一律拒）
 *  `balance` 是布线元件（不是算子）：它不产生新形状，只在扇出点上把流量分成两路。 */
export const V1_OPS = Object.freeze([
	"mine", "cut", "rotate", "rotateCCW", "rotate180", "paint", "paintMirrored", "mix", "stack", "trash",
	"balance",
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
/** 车道台账条目的 (轴, 下标) 键（LANE_SCHEMA_VERSION=2）：`row:3` / `col:3` 是两条不同车道。 */
const laneKeyOfLedger = l => `${l.column === null || l.column === undefined ? "row" : "col"}:${l.column === null || l.column === undefined ? l.row : l.column}`;
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
	/* ★ 既有实体不再是"拒绝理由"，而是**占位**（P1-4 增量对接）★
	   旧行为：世界里有任何非 hub 实体就整段拒绝（"v1 只支持全新址"）。
	   真实存档永远已经有东西 —— 实测 level 4 又选中了 level 3 的矿机所在的格子，
	   dry_run 拦下了它（很好），但玩家要的是"在旁边接一条"，不是"永远不能长大"。
	   现在：按实体类型铺占位，state 区分 solid / replaceable，
	   让 place() 的 occupied 真正挡住机器、让通道可以覆盖 replaceable 的带子。 */
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
	/** 被 ≥2 个消费者共享的输出节点（需要插 balancer 级联）。见下方校验段的说明。 */
	const fanoutNeeds = new Set();
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
		// ★ 矿机的**世界资源名**（resource）在这里定一次，是全包唯一真值 ★
		//   形状矿机：资源名 == hash（世界里就叫 `CuCuCuCu`/`RuRuRuRu`/…）
		//   颜料矿机：资源名 == step.color（世界里叫 `red`/`blue`/…）
		//     ⚠️ 它的 hash 是 P8 编进**形状空间**的 token（`-r------`），**不是**世界资源名；
		//        拿 token 去 findResource 永远查不到 —— 那正是颜料目标 `no-resource-in-range` 的根因。
		//   判据只用「op === "mine" 且带 color」：mix 节点也带 color，但那是**混出来**的颜色
		//     （purple 由 red+blue 合成），世界里没有这种矿 ⇒ 绝不能被当成可采资源。
		//   形状矿机显式写 resource = hash（而非留 undefined）：本字段语义统一为「世界资源名」，
		//     下游（pickResourceCells / jointResourceShift / meta.minerResources）读它时不必再猜
		//     `|| n.hash`。对既有形状目标**零可观察差异**（`resource ?? hash` 恒等于 hash）。
		//   非矿机节点**不设** resource（语义上它们不采任何资源；避免让下游误读）。
		if (op === "mine") n.resource = typeof s.color === "string" && s.color ? s.color : hash;
		byHash.set(hash, n);
		nodes.push(n);
	});

	// 资源输入（未在 steps 里出现的 shortKey）→ 合成矿机。
	// 只有**可采矿**的 hash 才映射回资源名：颜料 token 靠 steps 里那条 `op:"mine" + color` 的
	// 上一循环登记；这里处理的是「调用方只给了 token、没给 mine 节点」的兼容路径。
	// 用**同一条判据**（op === "mine" 且带 color）建立映射，mix 的混色 token 不会混进来。
	const pigmentOf = new Map();
	for (const s of steps) {
		if (s && s.op === "mine" && typeof s.hash === "string" && typeof s.color === "string" && s.color) {
			pigmentOf.set(s.hash, s.color);
		}
	}
	const resourceNameOf = h => pigmentOf.get(h) || h;
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
					inputs: [], hash: ih, resource: resourceNameOf(ih), depth: 0, parents: [], consumers: 0,
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
		if (n.consumers > 1 && !opts.noFanoutRewrite) {
			/* ★ 扇出 ⇒ 插入 balancer 级联（以前这里直接拒绝）★
			   旧行为：`consumers > 1` 一律失败，理由是"v1 行式布局无扇出模板"。
			   现在有了 balance（2 进 2 出、内容不变、轮流发两路），扇出就有了标准解法：
			     输出 O 被 k 个消费者用 ⇒ 插一棵 balancer 二叉树，叶子接原来的消费者。
			   balancer 不改 item（item_processor.js:342-362 只做 nextOutputSlot++ % 2），
			   所以形状在整棵树里保持不变，下游拿到的还是原来的 hash。
			   改写在 _rewriteFanout() 里做；这里只标记需要改写，真正的插入在全部节点收齐后。 */
			fanoutNeeds.add(n.id);
		}
		if (n.consumers > 1 && opts.noFanoutRewrite) {
			return makeFailure("dag-not-placeable:crossing-needs-tunnel", { nodeId: n.id, cell: null, check: "V6-crossing" },
				`扇出 ${n.consumers} > 1：同一输出被多条通道共享（本调用显式关闭了 balancer 改写）`);
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

	/* ★ 扇出改写：把共享输出换成 balancer 级联 ★
	   放在**最后**做，因为要等所有边都连好才知道谁是扇出点、谁在哪一侧。
	   改写会新增 balance 节点并改动 edges；节点的 depth 只被设为「父的 depth + 1」，
	   真正的层号在 layerAndOrder 里按 DAG 重算，所以这里不用纠结。 */
	if (fanoutNeeds.size) {
		const rw = rewriteFanout(nodes, byHash);
		if (rw.ok === false) return rw;
	}

	return { ok: true, nodes, terminals, byHash };
}

/**
 * 把扇出点 O（被 k≥2 个消费者共享）改写成 balancer 二叉树。
 *
 *   O.out ──┬── c1          O.out ──► bal1 ──┬── c1
 *           ├── c2      ⇒                     └── bal2 ──┬── c2
 *           └── c3                                       └── c3
 *
 * balancer 是 2 进 2 出且**不改 item**，所以整棵树里形状不变，叶子收到的仍是原 hash。
 * 级联而不是并联：balancer 只有两个输出，k 路必须两两分组，k-1 个 balancer 组成树。
 *
 * ⚠️ 现实约束（不是实现偷懒）：每多一个 consumer 就多一个 balancer，
 *    而 balancer 占 2×1 且两个输出都在北面 —— 密集扇出会显著吃空间。
 *    真实玩家用 514 个 balancer 正是这个原因。
 *
 * @returns {{ok:true}|{ok:false,reason:string,failingNode:object,hint:string}}
 */
function rewriteFanout(nodes, byHash) {
	/* 1. 找出每个节点的消费者列表（按先序，确定性） */
	const consumersOf = new Map();
	for (const n of nodes) for (const p of n.parents) {
		if (!p) continue;
		if (!consumersOf.has(p.id)) consumersOf.set(p.id, []);
		consumersOf.get(p.id).push(n);
	}

	/* 2. 自底向上处理扇出点：叶子先接好，父再分组 */
	const fanouts = nodes.filter(n => (consumersOf.get(n.id) || []).length > 1);
	if (!fanouts.length) return { ok: true };

	/* 3. 逐点改写。用「连接器」概念：给某个上游挂一个**生产该 hash 的通道端点**。
	      balancer 的输出槽 a/b 都能发同一个形状，所以每个 balance 节点就是
	      「一个能发 hash H 的两路分叉器」。 */
	for (const src of fanouts) {
		const kids = consumersOf.get(src.id);
		// 把这个源从所有孩子的 parents 里摘掉，稍后由 balancer 树接回去
		const slotsToFill = kids.map(k => {
			const idx = k.parents.findIndex(p => p === src);
			k.parents[idx] = null;
			return { kid: k, idx };
		});

		/* 4. 建树：k 个叶子需要 k-1 个 balancer。
		      配对顺序按孩子出现的先序 —— 确定性，且让同一父的两个子尽量相邻。 */
		let level = kids.map(() => null);        // 每个叶子的"来源"，稍后填
		let pending = [];                        // 待接的 balancer 列表
		// 从源出发先造一个 balancer（如果 k>=2）
		const makeBalancer = (depth) => {
			// id 必须**确定性**：同输入必须产出同结构，否则两次编译的蓝图不可复现。
			// 用「源 id + 序号」而不是随机串。
			const seq = nodes.filter(n => n.op === "balance" && n.fanoutOf === src.id).length;
			const id = `${src.id}#bal${seq}`;
			const b = {
				id, op: "balance", template: ALL_TEMPLATES.balance, args: {},
				inputs: [], hash: src.hash,          // 承载同一个形状（透传）
				depth: depth === null ? null : depth,
				parents: [null, null],               // 两个输入，逐个填
				consumers: 0, usedOut: new Set(), nextOut: 0, x: 0, y: 0,
				fanoutOf: src.id,
			};
			nodes.push(b);
			byHash.set(id, b);
			return b;
		};

		/* 树形：第 0 层一个 balancer 接 src，两个输出各带一组；
		          组里再要分就再造。这里按 k 直接展开成链 + 末端分叉，够用且简单：
		          bal1: in0 = src, in1 = (占位), out0 = kid0, out1 = bal2
		          bal2: in0 = 占位, in1 = 占位, out0 = kid1, out1 = bal3 ...
		          最后两个 kid 由最后一个 balancer 的两个输出接。 */
		const chain = [];
		for (let i = 0; i < kids.length - 1; i++) chain.push(makeBalancer(src.depth === null ? null : src.depth + 1));

		// 把 src 接到第一个 balancer 的 in0
		chain[0].parents[0] = src;
		src.consumers += 1;

		// 依次：bal_i 的 out0 给 kid_i；out1 给 bal_{i+1}（或最后一个 kid）
		for (let i = 0; i < chain.length; i++) {
			const b = chain[i];
			const kid = kids[i];
			// 记录 kid 从 b 的 out0 取货
			b.outAssign = b.outAssign || [];
			b.outAssign.push({ role: "primary", to: kid });
			slotsToFill[i].kid.parents[slotsToFill[i].idx] = b;
			b.consumers += 1;
			kid.consumers = (kid.consumers || 0) + 0;   // kid 的消费者不变
		}
		// 最后一个 kid 由最后一个 balancer 的 out1 接
		const lastB = chain[chain.length - 1];
		const lastKid = kids[kids.length - 1];
		lastB.outAssign.push({ role: "secondary", to: lastKid });
		slotsToFill[kids.length - 1].kid.parents[slotsToFill[kids.length - 1].idx] = lastB;
		lastB.consumers += 1;

		// 链上相邻两个 balancer：bal_i 的 out1 接 bal_{i+1} 的 in0
		for (let i = 0; i < chain.length - 1; i++) {
			chain[i + 1].parents[0] = chain[i];
			chain[i].consumers += 1;
			chain[i].outAssign.push({ role: "secondary", to: chain[i + 1] });
		}
		// 每个 balancer 的 in1 留空 → 后面由「未用输入槽接 trash」兜底（或干脆不接）
		// 注意：balancer 是 2 进 2 出，只占一个输入也能工作（另一路空着）
		void pending; void level;
	}
	return { ok: true };
}

/* ═══════════════ 2) 拓扑分层 + 层内 barycenter（父子保序）═══════════════ */

/**
 * 把每个节点的 `depth` 校正成**拓扑层号** = max(父层)+1（无父 = 0）。
 *
 * ★ 为什么必须校正（P3 缺陷，先红后绿见 WORKER-C-REPORT）★
 * 行式布局的**唯一方向前提**是：一条通道从上游（低层，画在下方）走向下游（高层，画在上方）。
 * 一旦某节点的 depth **小于它自己的父**，该节点就被画到父的**下方** —— 通道变成"上→下"，
 * 而 `pickLane`/P4 的 hlane 都只解"竖直腿朝向可达"的 Z 型；下→上的腿在目标列上必须穿过
 * 整条父层的机器行。M4 的堆叠汇合之所以能布，是因为父在本层下方、目标在上方。
 *
 * 症状（实测 CpCpCpCp / CgScScCg）：mixer 的 depth 比它的两条颜料矿机小 1 ⇒ mixer 画在矿机
 * **下方**，mixer→painter 的水平车道必须横穿矿机所在的那一行，且列区间恰好覆盖矿机那一格
 * （父列 = 子列，因为 `desiredX` 优先"父列直入"）⇒ 每一行候选都被那台矿机堵死，
 * P4 报 lane-column，整单 abort。这不是排版偏好问题，是**层号与 DAG 边矛盾**。
 *
 * 校正口径：只在**检测到矛盾**时整表重算；重算 = 每层取**最小**拓扑层号（无父=0、其余=max(父)+1）。
 * 显式 depth 只作为**输入提示**，不再作为排版真值 —— 层号是几何约束（"画在第几行"），
 * 不是配方元数据，不能让上游用错的数把它带歪。
 *
 * ⚠️ **重算不是"逐值相同"，它会压缩合法的空隙**（审查 F5a 实测）：若某节点显式 depth=5
 * 而它只有 depth=1 的父（5 是合法的**非最小**层号，用于额外留白），一旦别处出现一处矛盾触发
 * 整表重算，该节点会被压回 2。也就是说：**一处矛盾 ⇒ 全图按最小层号重排**，不是"只动坏边"。
 * 这对当前管线无影响（`assignRows` 只用层号分桶，不依赖绝对间隔；`place.mjs` 也不消费
 * 上层给的 spacing），但任何"用 depth 控制留白"的调用方必须知道这条 —— 不要依赖显式 depth。
 *
 * ⚠️ **自环**：`buildDag` 允许测试用「hash 指向自己」的节点（G7 的脏角度样例）。自环本身不算矛盾
 * （不参与矛盾扫描）；但**一旦别处有矛盾触发重算**，自环节点也会被重新编号（按"无有效父"⇒ 0），
 * 行号随之改变。无矛盾时它保持原样。头注早期版本声称"不改变自环节点的排版行为"，那只在无矛盾时成立。
 *
 * ⚠️ **`null`/`NaN` depth**：`buildDag` 在调用方给了非整数 depth 时会填 `null`。矛盾扫描
 * `!(p.depth < n.depth)` 对 `null<null` 为真 ⇒ 会被当成矛盾并触发重算，重算结果恰好正确。
 * 这是**偶然正确**，不是显式处理（审查 F5b 标 SUSPECTED）；不要在别处依赖它。
 *
 * ⚠️ **本函数就地修改 `nodes[].depth`**（导出的 `layerAndOrder` 契约是"传入你的数组"）：
 * `place()` 传的是 `buildDag` 新建的数组，所以不会污染调用方入参；但直接调用 `layerAndOrder`
 * 的代码会看到自己的对象被改写。
 * @returns {{nodes:object[], remapped:boolean, bad:string[]}}
 */
export function normalizeDepths(nodes) {
	const bad = [];
	for (const n of nodes) {
		for (const p of n.parents) {
			if (!p || p === n) continue;               // 自环：不是"父层 ≥ 子层"意义上的层号矛盾
			// 父子同层 / 父在上（depth 更小）都算矛盾；矿机 depth=0 是恒真下界
			if (!(p.depth < n.depth)) bad.push(`${p.id}@${p.depth}→${n.id}@${n.depth}`);
		}
	}
	if (!bad.length) return { nodes, remapped: false, bad };
	const memo = new Map();
	const visiting = new Set();
	const depthOf = n => {
		if (memo.has(n.id)) return memo.get(n.id);
		if (visiting.has(n.id)) throw new ContractViolation("layerAndOrder.depth", "DAG 必须无环（校正层号时发现回边）", n.id);
		visiting.add(n.id);
		const ps = n.parents.filter(p => p && p !== n);   // 自环不参与层号（见头注）
		const d = ps.length ? Math.max(...ps.map(depthOf)) + 1 : 0;
		visiting.delete(n.id);
		memo.set(n.id, d);
		return d;
	};
	for (const n of nodes) n.depth = depthOf(n);
	return { nodes, remapped: true, bad };
}

/**
 * routing-prior-art.md §1.3/§8 主干第一步：分层 → 层内 barycenter **且父子保序**。
 * 父子保序是"无纵向约束 ⇒ 无交叉"的充分条件（§1 的 27405 例穷举实测），故 barycenter 之后
 * 强制用"原序"做次键、id 做三键（三重 tie-break ⇒ 完全确定）。
 * level 0 = 矿机层，画在**最下**（y 最大）。
 *
 * 入口先过 `normalizeDepths`：显式 depth 与 DAG 边矛盾（父层 ≥ 子层）时以 DAG 为准重算 ——
 * 见该函数头注的几何理由。矛盾输入不会静默通过：`layerOrder.normalized` 带凭据给 `place()` 上报。
 */
export function layerAndOrder(nodes) {
	const norm = normalizeDepths(nodes);
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
	// 层号校正凭据（非数组属性 ⇒ JSON 序列化时自动丢弃，不污染 rows/levels 的既有形状）
	levels.depthNormalized = norm.remapped ? { remapped: true, contradictions: norm.bad } : null;
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
/**
 * 给**矿机层**求一组 x（世界系），使得每台矿机都压在自己的资源上。
 *
 * 为什么需要它：`assignRows` 默认把同层机器按 `游标 + colGap` 等距排开（间距 4 格）。
 * 矿机的**唯一**硬约束是"压在自己的资源格上" —— 它们之间的相对间距毫无意义，
 * 因为矿机之间不直接相连（各自的出料各走各的通道）。把一个不该固定的量固定住，
 * 就等于要求世界里的矿恰好落在 4 格栅格上：`CpCpCpCp` 需要 Cu/blue/red 三连，
 * ±400 内只有 2 处满足这种相对偏移，且都在边缘（实测）。这不是搜索范围问题。
 *
 * 算法（确定性）：
 *   ① 对区域内每个 y，按布局的**左右次序**求一组资源 x（每台取"比前一台大的最左一个"）；
 *   ② 保留**跨度最小**的那一行（跨度决定通道长度，V4 有 256 格上限）；
 *   ③ 同跨度按"离搜索中心近"再按 y 升序 tie-break（完全确定，无 locale 依赖）。
 *
 * ★ 同色矿机允许**互换次序** ★
 * 两台同色矿机（如 `CgScScCg` 的 `-g------` 与 `---g----`，都是 green）在 DAG 里是
 * **互不相关**的节点（各自喂不同的消费者），交换它们的左右次序不改变任何通道的端点，
 * 因此不产生交叉 —— 而"严格保序"会让 `CgScScCg` 在 ±400 内无解（实测 0 行）。
 * 互换只在**同色**之间做；跨色交换会改变端点相对位置，可能交叉，不做。
 *
 * @param {object[]} miners 矿机节点（按布局 x 升序）
 * @param {{seed:number, region:object, center:number[]}} ctx
 * @returns {Map<string, number[]>|null} nodeId → [x, y]（世界系）；保序无解时返回 null
 */
/* ═══════════════ 5a-pre) 多矿机并联（miner fan-in）═══════════════ */

/** 一条带要几台矿机喂满（攻略规则：矿机 0.4/s、带 2/s ⇒ 5 台）。
 *  这是**默认并联数**。取 4 而不是 5 是因为：hub 只有 16 个入口，
 *  下一条线还要留位置；且 4 台的 1.6/s 已经能填满 0.8 条带，性价比比第 5 台高。 */
export const MINERS_PER_LINE = 4;

/**
 * 把同形状的多个 `mine` 节点合成**一个** `mineGroup`，组内挂 N 台矿机。
 *
 * ★ 为什么需要它 ★
 * 攻略里最硬的一条规则是「5 台矿机喂满 1 条带」：矿机 0.4/s、带 2/s。
 * 但编译器一直是「一个 mine 节点 = 一台矿机」，于是产线只有一根柱，
 * 产能被单机 0.4/s 锁死 —— 这正是我建出来的工厂只有 1 台矿机的原因。
 *
 * ★ 为什么合并是安全的 ★
 * 同形状的矿机产出**完全相同**的 item，所以它们可以无条件汇流（不需要过滤器）。
 * 汇流用 balancer：它 2 进 2 出、内容不变、`preferredSlot` 堵了就退回
 * `getFirstFreeSlot()`（item_processor.js:147-156）⇒ 天然就是 2→1 合并器。
 *
 * ★ 为什么不改变下游 ★
 * 组节点对外**只有一个输出槽**，所以 cut/stack/paint 的布局代码一行都不用改，
 * 它们仍然只看到"一个上游"。合并只发生在矿机层。
 *
 * @param {object[]} nodes DAG 节点（buildDag 的产物）
 * @param {{perLine?:number}} opts `perLine` = 每组最多几台（默认 MINERS_PER_LINE）
 * @returns {{ok:true, nodes:object[], groups:object[]}|{ok:false,reason:string,hint:string}}
 */
export function replicateMiners(nodes, opts = {}) {
	const copies = Number.isInteger(opts.perLine) && opts.perLine >= 1 ? opts.perLine : MINERS_PER_LINE;
	/* copies === 1 表示**不复制**（反向对照用）。不能把它当成"没给参数"而回落到默认值
	   —— 那样 perLine=1 会静默变成 4，测试的反向对照就永远变不红。 */
	if (copies === 1) return { ok: true, nodes: nodes.slice(), groups: [] };

	const groups = [];
	const newNodes = [];
	for (const n of nodes) {
		if (n.op !== "mine" || n.copies) { newNodes.push(n); continue; }
		/* 形状矿机才复制。颜料矿机的 hash 是形状 token、数量由颜料契约决定
		   （每台喂不同的消费者），多复制会破坏 checkPigments 的语义。 */
		const isShapeMiner = !n.color && typeof n.hash === "string" && /^[A-Za-z-]{8}$/.test(n.hash);
		if (!isShapeMiner) { newNodes.push(n); continue; }

		const members = [];
		for (let i = 0; i < copies; i++) {
			members.push({
				id: i === 0 ? n.id : `${n.id}#m${i}`,
				op: "mine", hash: n.hash, resource: n.resource || n.hash,
				template: n.template, inputs: [], parents: [],
				consumers: 0, usedOut: new Set(), nextOut: 0,
				x: 0, y: 0, depth: n.depth, args: {},
				copies: members, copyIdx: i,
			});
		}
		const gid = `mg:${n.hash}`;
		const g = {
			id: gid, op: "mineGroup", hash: n.hash,
			template: {
				footprint: [1, 1], inputs: [],
				/* 对外仍是**一个**输出槽 —— 下游无需知道这是几台 */
				outputs: [{ cell: [0, 0], dir: "top", role: "out" }],
			},
			inputs: [], parents: [], consumers: n.consumers, usedOut: new Set(), nextOut: 0,
			x: 0, y: 0, depth: n.depth,
			resource: n.resource || n.hash, args: {},
			members,
			merged: false,
		};
		for (const m of members) { m.copies = members; m.group = g; }
		// 下游把"原来的那台矿机"换成组
		for (const other of nodes) {
			if (other === n) continue;
			for (let k = 0; k < other.parents.length; k++) {
				if (other.parents[k] === n) other.parents[k] = g;
			}
		}
		groups.push(g);
		newNodes.push(g);
	}
	return { ok: true, nodes: newNodes, groups };
}

export function planMinerColumns(miners, ctx) {
	const { seed, region, center } = ctx;
	if (!miners.length) return null;
	const shapes = miners.map(m => m.resource || m.hash);
	// 同一行里，每种资源可取的那些 x：y → shape → sorted xs
	const byRow = new Map();
	for (const [x, y, s] of resourcesInRegion(seed, region)) {
		if (!byRow.has(y)) byRow.set(y, new Map());
		const m = byRow.get(y);
		if (!m.has(s)) m.set(s, []);
		m.get(s).push(x);
	}
	for (const m of byRow.values()) for (const xs of m.values()) xs.sort(cmpNum);

	const need = new Map();
	for (const s of shapes) need.set(s, (need.get(s) || 0) + 1);

	/** 按给定次序在某一行上贪心取 x；取不到返回 null */
	const greedy = (m, order) => {
		let prev = -Infinity; const xs = [];
		for (const s of order) {
			const x = (m.get(s) || []).find(v => v > prev);
			if (x === undefined) return null;
			xs.push(x); prev = x;
		}
		return xs;
	};
	/** 生成"同色可互换"的次序。
	 *
	 * ⚠️ **只能交换同色**，绝不能让不同颜色之间换位：
	 *    不同色的矿机喂不同的消费者，换了左右次序会改变端点相对位置 → 通道交叉
	 *    （`CpCpCpCp` 若允许 blue/red/Cu 全排列，会选出 `-b(-93) → -r(-120) → n0(-121)`
	 *     这种**反序**解：跨度很小、但红线从右往左走，物理上不成立）。
	 *    真正的自由度只有：**同色集团可以整体挪到别处**（`green,blue,green` → `green,green,blue`）。
	 *
	 * 做法：保持颜色首次出现的**顺序**（= 跨色次序），只把每种颜色的重复出现"聚拢"到
	 * 该颜色可用的若干个位置组合上。颜色 ≤ 5、每种 ≤ 2 ⇒ 组合数很小。
	 */
	const permsOf = a => a.length <= 1 ? [a] : a.flatMap((v, i) => permsOf([...a.slice(0, i), ...a.slice(i + 1)]).map(r => [v, ...r]));
	const colorSeq = [...new Set(shapes)];                 // 跨色次序 = 首次出现序（不可变）
	/* 同色的"位置分配"：把第 k 个重复项放进哪些槽位。这里用最简的一档 ——
	   同色项**相邻**（紧挨着），这对本仓库的目标族是唯一需要的形态，且天然不产生反序。 */
	const orders = [(() => {
		const out = [];
		for (const s of colorSeq) for (let k = 0; k < (need.get(s) || 0); k++) out.push(s);
		return out;
	})()];
	/* 若某色出现 ≥2 次，再补一个"该色分散到原来各自位置"的候选（保原始序），
	   两者都试、按跨度取优 —— 两者都不改变跨色次序。 */
	if ([...need.values()].some(n => n > 1)) orders.push(shapes.slice());
	void permsOf;

	const cands = [];
	for (const [y, m] of byRow) {
		if ([...need].some(([s, n]) => (m.get(s) || []).length < n)) continue;
		for (const order of orders) {
			const xs = greedy(m, order);
			if (!xs) continue;
			cands.push({ y, xs, order, span: xs[xs.length - 1] - xs[0], d: Math.abs(y - center[1]) });
		}
	}
	if (!cands.length) return null;
	cands.sort((a, b) => a.span - b.span || a.d - b.d || a.y - b.y);
	const best = cands[0];
	const out = new Map();
	/* 把按 `best.order` 取到的 x，还原到**每台矿机自己的颜色**上：
	   第 k 个位置属于 order[k] 这种颜色；同色的第 j 台矿机取该颜色第 j 个槽。
	   这样 nodeId → x 的映射对同色互换是稳定的（谁站哪个位由颜色决定，不由 id 决定）。 */
	const slotsByShape = new Map();     // shape → [x...]（按 order 里出现的次序）
	best.order.forEach((s, i) => {
		if (!slotsByShape.has(s)) slotsByShape.set(s, []);
		slotsByShape.get(s).push(best.xs[i]);
	});
	const used = new Map();
	miners.forEach(mt => {
		const s = mt.resource || mt.hash;
		const k = used.get(s) || 0;
		used.set(s, k + 1);
		const arr = slotsByShape.get(s) || [];
		out.set(mt.id, [arr[k], best.y]);
	});
	return out;
}

/**
 * WP2：给「多输入机器」算出它的父该落到哪些行、它自己该落在哪一列。
 *
 * 两个独立约束，都来自 `planChannel` 的 `bottom` 输入硬律（喂它的上游列必须 <= 输入列）：
 *
 * ① **列**：stacker 的两个 bottom 输入在 `st.x` / `st.x+1`。若两台上游分别在 -121、-39 出料，
 *    只看 slot0 会把 stacker 摆到 -121，第二台永远喂不进来。必须取所有约束里**最靠东**的那个。
 * ② **行**：两台上游同在一行时，西侧那台横移到东侧输入的过程必然穿过东侧那台本体 ——
 *    扫遍 (p0.x, p1.x, st.x) 的组合没有一组能两条都通。分到不同行后都成为 1 拐角 elbow。
 *    方向：喂 slot1 的父**往下**（y 更大），因为下游必须在其上方（朝下输入要带子从下往上走）。
 *    幅度取**半个 rowGap**：上游那层离下一层只有一个 rowGap，往下推一整排会压到下层机器。
 *
 * ⚠️ 只对 `stack` 生效。`mix` 的两个输入同位（同一行），靠 WP1 的槽序修正解决；
 *    矿机不参与（y 由资源行钉死）。
 * @param {object[]} nodes DAG 节点（已定 x/y）
 * @param {{rowGap:number}} ctx
 * @returns {{rowY:Map<string,number>, colX:Map<string,number>}} 空 Map = 不改
 */
export function planMultiInputRows(nodes, ctx) {
	const rowY = new Map(), colX = new Map();
	const gap = ctx.rowGap;
	for (const n of nodes) {
		if (n.op !== "stack") continue;
		const slots = inSlotsOf(n);
		const bottoms = slots.map((s, i) => ({ s, i })).filter(e => e.s.dir === "bottom");
		if (bottoms.length < 2) continue;
		const parents = bottoms.map(b => ({ b, p: n.parents[b.i] })).filter(e => e.p);
		if (parents.length < 2) continue;

		// ① 列：本机 x 必须 >= 每个上游的带子列 − 本机该槽的偏移
		let needX = -Infinity;
		for (const { b, p } of parents) {
			if (p.op === "mine") continue;                 // 矿机 x 由资源定，不参与反推
			const feeds = outSlotsOf(p)[0];
			if (!feeds) continue;
			const dirOff = feeds.dir === "right" ? 1 : feeds.dir === "left" ? -1 : 0;
			const want = (p.x + feeds.cx + dirOff) - b.s.cx;
			if (want > needX) needX = want;
		}
		/* ★ 再加一个余量：两条上游的**竖直段**不能贴在一起 ★
		   只保证「>= 最东约束」时，本机会紧贴最东那台上游，两条竖段就挤在相邻两列上 ——
		   第一条通道把它竖段落的列占掉，第二条就无路可走（实测 stacker.x=-40 时
		   slot1 FAIL、-36 时两条都通）。
		   余量取 2：给两条竖段各留一列，再加一格间隔。 */
		if (Number.isFinite(needX)) colX.set(n.id, needX + 2);

		// ② 行：两台上游同行时把喂 slot1 的那台往下让半排
		const lowerP = n.parents[bottoms[0].i];
		const upperP = n.parents[bottoms[1].i];
		if (!lowerP || !upperP || lowerP === upperP) continue;
		if (lowerP.op === "mine" || upperP.op === "mine") continue;
		if (lowerP.y !== upperP.y) continue;
		rowY.set(upperP.id, lowerP.y + Math.max(1, Math.floor(gap / 2)));
	}
	return { rowY, colX };
}

export function assignRows(levels, opts = {}) {
	const rowGap = opts.rowGap === undefined ? ROW_H : opts.rowGap;
	const colGap = opts.colGap === undefined ? COL_GAP : opts.colGap;
	const minerX = opts.minerX || null;   // 矿机层 nodeId → [x,y]（给了 seed 且多矿机时由 planMinerColumns 求）
	const multiX = opts.multiX || null;   // 多输入机器 nodeId → x（WP2：必须 >= 所有上游的带子列）
	const rowY = opts.rowY || null;       // nodeId → y 覆盖（WP2：把喂 slot1 的父往下让半排）
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
	/* WP2 的行覆盖：把 `rowY` 点名的节点挪到指定 y。
	   必须放在三层遍历**之前** —— `clash`/`claim` 都以 `n.row` 为键，
	   放在这里就等于"这批机器的初始行不同"，后续让位/回填逻辑无需改动。 */
	if (rowY) {
		for (const list of levels) for (const n of list) {
			if (rowY.has(n.id)) { n.y = rowY.get(n.id); n.row = rowY.get(n.id); }
		}
	}

	// 第一遍：自下而上，先满足父列，撞占用则单向右移（确定性）
	levels.forEach((list, li) => {
		/* `cursor` 的起点：矿机层从 0 开始（它的 x 由资源给，游标只是兜底）；
		   其他层从**本层第一台机器的父 x** 开始 —— 不能从 0，也不能取整层的 min。
		   矿机层由资源决定后可能整层西移到 -270；此时下游若仍从 0 起排，会全部堆在最右端，
		   与自己的父隔着 200+ 格（实测：CgScScCg 的 paint 在 8、其 painter 输入在 -219）。
		   ⚠️ 但也不能用**整层**的最小父 x：L1 里 mix 的父在 -266、n1 的父在 -124，
		   取整层 min 会把 n1 也从 -266 起排，反而把它推离自己的父。按"第一台的父"起步，
		   后续每台仍由 `desiredX` 定（它按**各自**的父算），游标只在前者撞占时才兜底。 */
		let cursor = 0;
		if (li > 0) {
			const first = list[0];
			const px = first ? first.parents.filter(Boolean).map(p => p.x).filter(Number.isFinite) : [];
			if (px.length) cursor = Math.min(...px);
		}
		for (const n of list) {
			n.w = n.template.footprint[0];
			n.h = n.template.footprint[1];
			let x = cursor;
			/* 矿机层：x 由**资源**决定（见 planMinerColumns）。这里只做坐标系的换算：
			   资源给的是世界系，布局用局部系（世界 = origin + 局部），调用方已经把中心换成
			   世界系并原样返回世界系 x ⇒ 这里减回去由调用方负责（minerX 里存的直接是局部 x）。 */
			if (li === 0 && minerX && minerX.has(n.id)) x = minerX.get(n.id)[0] - (opts.originX || 0);
			else if (multiX && multiX.has(n.id)) x = multiX.get(n.id);
			else if (n.op === "balance") {
				/* ★ balancer 必须**阶梯错开列**，不能和上游共列 ★
				   它的两个输入槽在相邻两列（local (0,0) 和 (1,0)），两个输出同理。
				   若按 `desiredX` 把 balancer 拉到父的出料口正下方，整条汇流链会落在同一列 ——
				   于是 `m0 → bal0` 的竖直通道要**穿过中间所有 balancer**，
				   P4 报 crossing（实测 ch0 与 ch2 在 (4,-18..-20) 同格相交）。
				   规则：每个后继 balancer 向右偏 2 列（比 1 列多一格余量给竖直腿）。
				   `nextOut` 顺序天然给出链上的序号，用它做偏移量即可。 */
				const want = desiredX(n);
				const idx = n.balanceChainIdx === undefined ? 0 : n.balanceChainIdx;
				x = (want === undefined ? cursor : want) + idx * 2;
			}
			else if (li > 0) {
				const want = desiredX(n);
				/* ★ 不能用 `Math.max(cursor, want)` ★
				   cursor 是「上一台机器的右缘 + colGap」，它只为**同层**防重叠服务。
				   拿它给 want 兜底等于规定"同层机器只能从左往右排"，于是多输入机器
				   （stacker/mixer 的两个 bottom 在同一行的相邻两列）的**第二个**输入永远
				   对不上上游喷口：CgScScCg 里 n9 想落在 x=14（带子正对 stacker 的上层输入），
				   却被 cursor 顶到 18，通道只能报 column-conflict。
				   正确判据只有一个：**want 那一格有没有被占**。没被占就放 want ——
				   同层机器允许向左回填，只要不重叠（下面 while 的 clash 逐个方向兜底）。 */
				/* ⚠️ 这里曾写 `want < 0 ? cursor : want` —— 与第二遍同一个错误假设：
				   "布局坐标不能是负的"。矿机 x 由资源决定后，负坐标是完全合法的常态
				   （CgScScCg 的矿机整层在 -266..-42）。照旧判就把**所有**负的 want 换成
				   cursor，下游于是全部贴在最西端、与自己的父错开 130+ 格。 */
				if (want !== undefined) x = want;
			}
			let guard = 0;
			/* 撞占用时让位：矿机层**只向右**扫（它的 x 是资源给定的，不能随便挪开资源）；
			   其他层**优先向左找空位**再向右 —— 消费者只要落在"带子对得上"的位置就行，
			   左右都可以，而向右扫会把整簇机器推离父列（实测：CpCpCpCp 的 mix 被推到 x=2，
			   与矿机隔着 120 格）。向左先试能保住零拐角/短通道。 */
			const scanRight = li === 0;
			if (scanRight) {
				while (clash(occupied, n.row, x, x + n.w - 1, n.h) && guard++ < 4096) x++;
			} else if (clash(occupied, n.row, x, x + n.w - 1, n.h)) {
				let left = x;
				while (left >= 0 && clash(occupied, n.row, left, left + n.w - 1, n.h) && guard++ < 4096) left--;
				if (left >= 0 && !clash(occupied, n.row, left, left + n.w - 1, n.h)) x = left;
				else { guard = 0; while (clash(occupied, n.row, x, x + n.w - 1, n.h) && guard++ < 4096) x++; }
			}
			n.x = x;
			claim(n, x);
			cursor = x + n.w + colGap;
		}
	});
	// 第二遍：把"让位造成的偏移"拉回父列（不撞才动）—— 零拐角优先
	for (let li = levels.length - 1; li >= 0; li--) {
		for (const n of levels[li]) {
			const want = desiredX(n);
			/* ⚠️ 这里曾写 `want < 0 → continue`。那是"布局坐标系不允许负 x"的旧假设 ——
			   它只在矿机被钉在 0 起点时才成立。现在矿机 x 由资源决定（可在任意负坐标），
			   矿机层合法地落在 -220；照旧判就把**所有**下游的父列对齐请求全跳过，
			   于是 mix 停在 0、与矿机隔 120 格。负 x 不是非法值，只是坐标。 */
			if (want === undefined || want === n.x) continue;
			/* `multiX` 点名的节点是**联合求解**的结果（x 必须 >= 所有上游的带子列）。
			   第二遍的 `desiredX` 只看主输入，会把它拉回去 —— 那样第一轮的联合求解就白做了。
			   所以这些节点在这一遍跳过。 */
			if (multiX && multiX.has(n.id)) continue;
			if (clash(occupied, n.row, want, want + n.w - 1, n.h)) continue;
			unclaim(n); n.x = want; claim(n, want);
		}
	}
	/**
	 * 第三遍：**次输入的上游回填**（多输入机器，如 stacker/mixer）。
	 *
	 * 为什么前两遍不够：`desiredX` 只服务"主输入"。stacker 的两个输入在**同一行的相邻两列**
	 * [0,0] / [1,0]，都朝 bottom。主输入的上游对准了，次输入的上游却停在自己的游标位 ——
	 * 于是它的带子列远离下游次输入列，`planChannel` 只能报 column-conflict
	 * （CgScScCg 的 n9→n10：带子在 19，输入要 16）。
	 *
	 * ★ 为什么只能往**左**回填 ★
	 * `planChannel` 的 1 拐角形态（elbow / startTurn）都要求"先沿 d1 走、再沿 d2 走"，
	 * 而 d1 是上游的喷出方向。上游朝 +x 出料时，它只能**向右**伸到下游，再竖向接入。
	 * 也就是说上游的带子列必须 ≤ 下游输入列（严格左即 1 拐角，相等即 startTurn）。
	 * 从右侧绕回来是 4 拐角 —— v1 无隧道，做不到。所以回填方向是单向的：往左找。
	 *
	 * 算法：从"紧贴下游次输入列"的位置开始向左扫，取**第一个不撞**的锚点。
	 * 每台上游只动一次（不迭代、不连锁），遍历顺序确定（层号升序）⇒ 同输入逐字节同输出。
	 * 找不到空位就保持原样，由 `planChannel` 如实上报 column-conflict（不硬凑）。
	 */
	levels.forEach(list => {
		for (const n of list) {
			const slots = inSlotsOf(n);
			const bottoms = slots.map((s, i) => ({ s, i })).filter(x => x.s.dir === "bottom");
			if (bottoms.length < 2) continue;
			for (const b of bottoms.slice(1)) {
				const p = n.parents[b.i];
				if (!p || p.x === undefined) continue;
				const pOut = outSlotsOf(p);
				const feeds = pOut[0] || null;
				if (!feeds) continue;
				const dirOff = feeds.dir === "right" ? 1 : feeds.dir === "left" ? -1 : 0;
				if (feeds.dir !== "right" && feeds.dir !== "left") continue;   // 竖直出料：同列对齐已由前两遍负责
				// 最贴近的位置：带子列正好等于下游次输入列
				const ideal = (n.x + b.s.cx) - feeds.cx - dirOff;
				if (ideal === p.x) continue;
				// 向左扫（d1=right ⇒ 带子列必须 <= 下游输入列；越过理想位向右没意义）
				let placedAt = null;
				for (let cand = Math.min(ideal, p.x); cand >= 0 && cand >= ideal - 32; cand--) {
					if (cand === p.x) { placedAt = cand; break; }             // 原位就够左 ⇒ 不动
					if (clash(occupied, p.row, cand, cand + (p.w || 1) - 1, p.h || 1)) continue;
					placedAt = cand; break;
				}
				if (placedAt === null || placedAt === p.x) continue;
				unclaim(p); p.x = placedAt; claim(p, placedAt);
			}
		}
	});
	return { levels, rows, occupied };
}

/** 本机锚点理想列 = **每个输入槽各自**反推出来的理想列里，取主输入那一支（无父/父未定列 → undefined）*/
export function desiredX(n) {
	const ps = n.parents.filter(Boolean);
	if (!ps.length || ps.every(p => p.x === undefined)) return undefined;
	const slots = inSlotsOf(n);
	if (!slots.length) return undefined;
	/* ★ 必须**按槽**取父，不能按父的下标取槽 ★
	   `n.parents` 是按槽序排的（parents[i] ↔ inSlots[i]），但父未必都定了列。
	   上一版用 `ps[idx]`（idx=第一个 bottom 槽的下标）去配 `slots[idx]`，一旦某个父的槽不是
	   bottom（stacker 的下层/上层都是 bottom、但两个输入在不同列；painter 的 shape 槽是 left），
	   就会拿错槽去反推 → 第二个输入永远对不上（CgScScCg 的 n9→n10 差一格就是这么来的）。
	   这里逐槽配对，再把"该槽对应的父"代进反推式。 */
	// 主槽 = 第一个竖直进料口（下进上出）；纯水平机器（painter）用第 0 槽
	const mainIdx = Math.max(0, slots.findIndex(s => s.dir === "bottom"));
	// 主槽优先；主槽的父没定列时按槽序退回其它可用槽（保持旧行为：不因一个未定的父就不排）
	const order = [mainIdx, ...slots.map((_, i) => i).filter(i => i !== mainIdx)];
	for (const i of order) {
		const p = ps[i];
		const s = slots[i];
		if (!p || p.x === undefined || !s) continue;
		return anchorFromParent(n, p, s);
	}
	return undefined;
}

/**
 * 上游父 `p` 的**出料口外那一格带子**在 x 上的位置，反推出本机锚点 x。
 * 机器原点与出料口可以差一格：painter 的 outputs 在 cell [1,0]、朝 right ⇒ 带子在锚点 +2。
 * 上一版直接返回 `p.x - s.cx`，等于假设"父的出料口就在父原点上、且竖直喷出"，于是
 * painter → stacker 这类「上游偏一格、朝右出料」的组合永远差一格（CpCpCpCp/CgScScCg 都死在这）。
 * 父没有出料槽（trash / 自定义节点）→ 退回"原点竖直"的旧口径，金网格不变。
 */
function anchorFromParent(n, p, s) {
	const pOut = outSlotsOf(p);
	const feeds = pOut.find(o => (p.usedOut ? !p.usedOut.has(o.role) : true)) || pOut[0] || null;
	const beltCol = feeds
		? p.x + feeds.cx + (feeds.dir === "right" ? 1 : feeds.dir === "left" ? -1 : 0)
		: p.x;	if (s.dir === "left") return beltCol + 1 - s.cx;   // 带子在本机进料面外一格 ⇒ 锚点 = 带子列 + 1 - cx
	if (s.dir === "right") return beltCol - 1 - s.cx;
	return beltCol - s.cx;                             // bottom/top：带子列 == 进料槽列
}

function clash(occupied, y, x0, x1, h) {
	for (let dy = 0; dy < h; dy++) {
		const s = occupied.get(String(y + dy));
		if (!s) continue;
		for (let x = x0; x <= x1; x++) if (s.has(String(x))) return true;
	}
	return false;
}

/**
 * 隧道跨度上限（基础 tier）。`globalConfig.undergroundBeltMaxTilesByTier[0] === 5`，
 * 即 sender 与 receiver 之间最多隔 5 格。实机统计（level-11 存档 107 对）里玩家只用 2~3 格，
 * 说明这是"跨过 1~2 格障碍"的工具，不是长距离连接。这里取 4 作保守上限。
 */
export const TUNNEL_MAX_SPAN = 4;

/**
 * 把一条直线段上的**连续阻挡**替换成隧道跨越。
 *
 * 为什么需要它：`planChannel` 只能走空路。当两条通道在同一列/行上必然相交时
 * （例如 `-g------` 要横穿 `-b------` 到 mixer 的那条竖带），换 lane 行也没用 ——
 * 横走段无论落在哪一行，都要跨过那一列。这正是游戏给隧道的用途。
 *
 * 隧道语义（`buildings/underground_belt.js:45-48` + 实机存档验证）：
 *   code 22 = sender（入口，rv=0）、code 23 = receiver（出口，rv=1），都是 1×1，
 *   两者 `rotation` 相同、共线；中间的格子被"穿过"（不放带子）。
 *
 * ★ 隧道格的 (inDir, outDir) ★
 *   带子的 inDir≠outDir 是铁律（`beltGlyph` 会断言），但隧道格**不拐弯**：
 *   sender 的进货面 = 来向的反面、出货面 = 前进方向（正常带子）；
 *   receiver 同理。所以两者仍是 `inDir = OPP[dir] / outDir = dir` —— 与普通直带同形。
 *   "隧道"身份靠 `tunnel` 字段表达，**不靠方向**。渲染/发射都先看 `tunnel`。
 *
 * 返回的 cells 里用 `tunnel: "sender"|"receiver"` 标记。找不到 ≤ TUNNEL_MAX_SPAN 的
 * 可行跨度就返回 null（不改，让上层如实失败）。
 *
 * @param {Array<[number,number]>} path 直线路径（含首尾）
 * @param {string} dir 行进方向
 * @param {(c:[number,number])=>boolean} blocked 该格是否被占
 * @returns {{cells:Array<{cell:[number,number],inDir:string,outDir:string,tunnel?:string}>, span:number}|null}
 */
export function tunnelOverPath(path, dir, blocked) {
	if (path.length < 3) return null;
	// 找最长的连续阻挡段
	let best = null;
	for (let i = 1; i < path.length - 1; i++) {
		if (!blocked(path[i])) continue;
		let j = i;
		while (j + 1 < path.length - 1 && blocked(path[j + 1])) j++;
		const span = j - i + 1;
		if (span <= TUNNEL_MAX_SPAN && (!best || span > best.span)) best = { from: i, to: j, span };
		i = j;
	}
	if (!best) return null;
	// 隧道两端必须落在路径内（sender 在 best.from-1，receiver 在 best.to+1）
	if (best.from < 1 || best.to > path.length - 2) return null;
	const out = [];
	for (let i = 0; i < path.length; i++) {
		const c = path[i];
		if (i >= best.from && i <= best.to) continue;                 // 被穿过的格子：不放东西
		const cell = { cell: c, inDir: OPP[dir], outDir: dir };       // 与普通直带同形，不拐弯
		if (i === best.from - 1) cell.tunnel = "sender";
		if (i === best.to + 1) cell.tunnel = "receiver";
		out.push(cell);
	}
	// 被穿过的格（sender 与 receiver 之间）：调用方要拿去占位，防止别的通道在那儿铺带子
	const crossed = [];
	for (let i = best.from; i <= best.to; i++) crossed.push(path[i]);
	return { cells: out, span: best.span, crossed };
}

/** 从 a 到 b 的单位方向（不相邻 → null）*/
function dirToward(a, b) {
	const dx = b[0] - a[0], dy = b[1] - a[1];
	if (Math.abs(dx) + Math.abs(dy) !== 1) return null;
	return ORDER.find(d => DIRV[d][0] === dx && DIRV[d][1] === dy) || null;
}

/**
 * 按**最终的格序列**重算每格的 (inDir, outDir)。
 *
 * 为什么需要：隧道替换会**删掉**若干格（被穿过的那些），于是原本"相邻"的两格之间
 * 出现了空档、原本不相邻的两格变成了邻居。若沿用替换前的方向，就会出现
 * 「上一格出口朝右、下一格却在正上方」这种自相矛盾的路径（实测 ch8 的 (-36,40)：
 * 隧道跨过 (-38,40) 之后它成了拐点，但 outDir 还停在 right）。
 *
 * 规则：
 *   · 隧道格（sender/receiver）：方向 = 它所在段的**行进方向**（`tunnelDir`），不拐弯；
 *   · 普通格：入向 = 从相邻的上一格来，出向 = 朝相邻的下一格去；
 *     若前/后不相邻（隧道跨越），该侧按相邻那一侧的方向补（直行）。
 */
function recomputeDirs(cells, firstDir, lastDir, tunnelDirOf) {
	if (!cells.length) return cells;
	const out = cells.map(c => ({ ...c }));
	for (let k = 0; k < out.length; k++) {
		const cur = out[k];
		if (cur.tunnel) {
			const d = tunnelDirOf(k);
			cur.inDir = OPP[d];
			cur.outDir = d;
			continue;
		}
		const prev = k > 0 ? out[k - 1] : null;
		const next = k < out.length - 1 ? out[k + 1] : null;
		const dIn = prev ? dirToward(prev.cell, cur.cell) : null;
		const dOut = next ? dirToward(cur.cell, next.cell) : null;
		// 入向：优先看实际相邻；不相邻（隧道跨越）就看下一格方向的反面（直行穿过去）
		const inDir = dIn ? OPP[dIn]
			: prev ? (prev.tunnel ? OPP[tunnelDirOf(k - 1)] : OPP[firstDir])
			: OPP[firstDir];
		// 出向：优先看实际相邻；否则保持与入向相反（直行），隧道后的第一格例外见下
		const outDir = dOut ? dOut
			: next ? (next.tunnel ? tunnelDirOf(k + 1) : (lastDir || dOut))
			: lastDir;
		cur.inDir = inDir;
		cur.outDir = outDir;
	}
	return out;
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
		if (!free(cells)) {
			/* 直线被挡时：若阻挡是**1~4 格连续**，用隧道跨过去（这正是隧道的用途）。
			   仅在显式允许时尝试 —— `ctx.tunnels === true` 由调用方按 scope 打开，
			   默认关闭以保证既有目标逐字节不变。 */
			if (ctx.tunnels === true) {
				const tun = tunnelOverPath(cells, d1, blocked);
				if (tun) return { ok: true, kind: "tunnel-straight", lane: null, cornerCount: 0, cells: tun.cells, tunnels: 1, tunnelSpanCells: tun.crossed };
			}
			return { ok: false, why: "cell-occupied", at: cells.find(blocked) };
		}
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
			const p1 = lineCells(first, el);          // 含 el
			const p2 = lineCells(el, last);
			const path = p1.slice();
			for (const c of p2) if (!sameCell(c, el)) path.push(c);
			const cells = tagPath(path, el, d1, d2);
			if (sameCell(cells[cells.length - 1].cell, last)) {
				if (free(cells)) return { ok: true, kind: "elbow", lane: null, cornerCount: countPathCorners(cells), cells };
				/* 拐角路径被挡：两段各自可被隧道跨过（十字交叉的典型形态）。
				   隧道穿不过机器，所以被机器占的格仍会让该段失败 —— 正确的拒绝。 */
				if (ctx.tunnels === true) {
					let out = cells, used = 0; const crossedAll = [];
					for (const sg of [{ cells: p1, dir: d1 }, { cells: p2, dir: d2 }]) {
						if (!sg.cells.some(blocked)) continue;
						const tun = tunnelOverPath(sg.cells, sg.dir, blocked);
						if (!tun) continue;
						const keep = new Map(tun.cells.map(c => [cellKey(c.cell[0], c.cell[1]), c]));
						const drop = new Set();
						for (const c of sg.cells) if (!keep.has(cellKey(c[0], c[1]))) drop.add(cellKey(c[0], c[1]));
						const next = [];
						for (const x of out) {
							const k = cellKey(x.cell[0], x.cell[1]);
							if (drop.has(k)) continue;
							next.push(keep.has(k) ? { ...x, ...keep.get(k) } : x);
						}
						out = next; used++; if (tun.crossed) crossedAll.push(...tun.crossed);
					}
					if (used > 0 && out.length && sameCell(out[out.length - 1].cell, last)) {
						/* 隧道替换删掉了若干格 ⇒ 相邻关系变了，必须按最终序列**重算方向**，
						   否则会出现「上一格朝右、下一格在上方」的自相矛盾（实测 ch8）。 */
						const tunDir = (idx) => {
							// 隧道格所在段的行进方向：取它前后相邻普通格给出的方向
							for (let j = idx - 1; j >= 0; j--) {
								const s = dirToward(out[j].cell, out[idx].cell);
								if (s) return s;
							}
							for (let j = idx + 1; j < out.length; j++) {
								const s = dirToward(out[idx].cell, out[j].cell);
								if (s) return s;
							}
							return d1;
						};
						const fixedCells = recomputeDirs(out, d1, d2, tunDir);
						return { ok: true, kind: "tunnel-elbow", lane: null,
							cornerCount: fixedCells.filter(x => isCorner(x.inDir, x.outDir)).length, cells: fixedCells, tunnels: used, tunnelSpanCells: crossedAll };
					}
				}
				return { ok: false, why: "cell-occupied", at: cells.find(blocked) };
			}
		}
	}
	// ⑥ Z（M4 形态）：两拐点 + 一条车道
	/* ★ 车道行必须**真的空**，不能只看几何可行 ★
	   `pickLane` 原来的候选排序是「离 last 最近」优先，但它从不看 `occupied` —— 于是会挑中
	   一行横段正好穿过机器的位置（实测：CgScScCg 的 ch1 选了 y=46，而 mixer 就在 (-219,46)，
	   横段从 -265 走到 -218 直接把机器穿了）。这不是隧道能救的：隧道只穿带子，不穿机器。
	   修法：把「这一行的横段有没有被占」作为**可行性的一部分**，不可行就试下一个候选。
	   只在 ctx.strictLane 或显式要求时启用，避免改变既有目标的默认行为 ——
	   不，这里改为**总是**检查：横段穿过机器在任何情况下都是错的，没有例外。 */
	const candsLane = [];
	{
		const vert0 = isVert(d1);
		const axis0 = vert0 ? 1 : 0;
		const f0 = first[axis0], l0 = last[axis0];
		let lo0 = -Infinity, hi0 = Infinity;
		if (DIRV[d1][axis0] > 0) lo0 = Math.max(lo0, f0 + 1); else hi0 = Math.min(hi0, f0 - 1);
		if (DIRV[d2][axis0] > 0) hi0 = Math.min(hi0, l0 - 1); else lo0 = Math.max(lo0, l0 + 1);
		if (!Number.isFinite(lo0)) lo0 = Math.min(f0, l0) - 8;
		if (!Number.isFinite(hi0)) hi0 = Math.max(f0, l0) + 8;
		if (lo0 <= hi0) {
			for (let v = Math.ceil(lo0); v <= Math.floor(hi0); v++) candsLane.push(v);
			candsLane.sort((a, b) => cmpNum(Math.abs(a - l0), Math.abs(b - l0)) || cmpNum(a, b));
		}
	}
	let lane = null;
	const aOf = v => (isVert(d1) ? [first[0], v] : [v, first[1]]);
	const bOf = v => (isVert(d1) ? [last[0], v] : [v, last[1]]);
	for (const v of candsLane) {
		const pooled = ctx.lanePool && ctx.lanePool.has(isVert(d1) ? `row:${v}` : `col:${v}`);
		if (ctx.strictLane && pooled) continue;
		if (blocked) {
			const seg = lineCells(aOf(v), bOf(v));
			if (seg.some(blocked)) continue;            // 这一行的横段压到机器/带子 → 换下一行
		}
		lane = v; break;
	}
	if (lane === null) lane = pickLane(first, d1, last, d2, ctx);   // 兜底：保持旧语义
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
	if (raw.some(blocked)) {
		/* Z 形的三段都可能被挡，且性质不同：
		   · 车道横段（a→b）：被挡 = 与另一条通道的竖直段十字交叉 —— 最典型的隧道场景；
		   · 首/尾竖直段：被挡 = 撞到别的通道的横段 —— 同样是隧道场景（只是方向相反）。
		   所以**三段都试**：对每一段做一次 `tunnelOverPath`，只要该段的连续阻挡 ≤4 格就跨过去。
		   隧道穿不过**机器**，所以 `blocked` 里机器占的格仍会让整段失败 —— 那是正确的拒绝。 */
		if (ctx.tunnels === true) {
			const segs = [
				{ cells: lineCells(first, a), dir: d1 },
				{ cells: lineCells(a, b), dir: dH },
				{ cells: lineCells(b, last), dir: d2 },
			];
			let out = cells;
			let used = 0;
			// 每段隧道跨过的格（= 被删掉的带子所在的格）。Z 形分支自己收集，
			// 不能引用 elbow 分支的 `crossedAll` —— 那是在另一个 block 里声明的。
			const crossedAll = [];
			for (const sg of segs) {
				const bad = sg.cells.some(blocked);
				if (!bad) continue;
				const tun = tunnelOverPath(sg.cells, sg.dir, blocked);
				if (!tun) continue;                      // 这一段救不了，保持原样
				// 用隧道版替换这一段：被穿过的格从 out 里删掉，sender/receiver 打标记
				const keep = new Map(tun.cells.map(c => [cellKey(c.cell[0], c.cell[1]), c]));
				const drop = new Set();
				for (const c of sg.cells) if (!keep.has(cellKey(c[0], c[1]))) drop.add(cellKey(c[0], c[1]));
				const next = [];
				for (const x of out) {
					const k = cellKey(x.cell[0], x.cell[1]);
					if (drop.has(k)) continue;
					next.push(keep.has(k) ? { ...x, ...keep.get(k) } : x);
				}
				out = next; used++;
				if (tun.crossed) crossedAll.push(...tun.crossed);
			}
			if (used > 0 && out.length && sameCell(out[out.length - 1].cell, last)) {
				const cc = out.filter(x => isCorner(x.inDir, x.outDir)).length;
				return { ok: true, kind: "tunnel", lane, cornerCount: cc, cells: out, tunnels: used, tunnelSpanCells: crossedAll };
			}
		}
		return { ok: false, why: "cell-occupied", at: raw.find(blocked) };
	}
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
 *
 * ⚠️ 本函数给的是**每台矿机各自最近的资源格**（相互独立、不保证能同时满足），
 * 只用于 `meta.minerCells` 的**诊断**。真正决定机器簇平移量的是 `jointResourceShift()`
 * （它考虑 DAG 硬定的相对偏移，见其头注）。
 * @returns {{ok:true,table:Map|null}|{ok:false,reason,failingNode,hint}}
 */
export function pickResourceCells(nodes, input) {
	const miners = nodes.filter(n => n.op === "mine");
	if (!miners.length) return { ok: true, table: new Map() };
	const seed = input.seed !== undefined && input.seed !== null ? input.seed : (input.world && input.world.seed);
	if (seed === undefined || seed === null) return { ok: true, table: null };   // 无 seed：矿机当普通节点，不做资源校验
	const center = input.site ? [input.site.x, input.site.y] : (input.hub ? [input.hub.x, input.hub.y] : [0, 0]);
	const region = input.region || regionAround(center, input.range === undefined ? 48 : input.range);
	// 矿机**不能**挖 hub 占着的格（4×4 solid）：那里物理上放不下矿机。世界系里排除掉。
	const hubW = input.hub && Number.isFinite(input.hub.x) ? [input.hub.x, input.hub.y] : null;
	const onHub = c => hubW && c[0] >= hubW[0] && c[0] < hubW[0] + HUB_SIZE && c[1] >= hubW[1] && c[1] < hubW[1] + HUB_SIZE;
	const usedCols = new Set();
	const table = new Map();
	for (const n of miners) {
		const want = n.resource || n.hash;
		const pred = s => s === want;
		const cands = findResource(seed, pred, region)
			.filter(c => !onHub(c) && !usedCols.has(c[0]))
			.sort((a, b) => (Math.hypot(a[0] - center[0], a[1] - center[1]) - Math.hypot(b[0] - center[0], b[1] - center[1]))
				|| cmpStr(a.join(","), b.join(",")));
		let hit = cands[0] || null;
		if (!hit) {
			// 全被 hub 压住/同列占满 → 退回"最近但不在 hub 上"的一格
			const any = findResource(seed, pred, region).filter(c => !onHub(c))
				.sort((a, b) => (Math.hypot(a[0] - center[0], a[1] - center[1]) - Math.hypot(b[0] - center[0], b[1] - center[1]))
					|| cmpStr(a.join(","), b.join(",")))[0];
			if (!any) {
				return makeFailure("no-resource-in-range", { nodeId: n.id, cell: null, check: "V1-occupancy" },
					`seed=${seed}、以 ${center.join(",")} 为心半径 ${region.x1 - center[0]} 内没有资源 ${want}` +
					(hubW ? `（hub ${hubW.join(",")} 占住的格已排除）` : ""));
			}
			hit = any;
		}
		usedCols.add(hit[0]);
		table.set(n.id, [hit[0], hit[1]]);
	}
	return { ok: true, table };
}

/* ═══════════════ 5b) 多矿机**联合**对齐（WORKER F：假绿的根因）═══════════════ */

/**
 * 把整簇矿机**同时**压到真资源上：求平移量 `t` 使**每台**矿机都满足
 * `tileResource(seed, miner + t) === miner.resource`。
 *
 * ★ 为什么不能只对齐第一台（旧的假绿根因）★
 * 行式布局把矿机的相对位置**硬定死**了（同级按 barycenter + 原序分列、COL_GAP=3），
 * 例如 `CrCrCrCr` 的颜料矿机恒在 Cu 矿机西侧 4 格、同一行。只按第一台矿机求平移量，
 * 第二台落在哪完全由这个固定偏移决定 —— 那里可能根本没有红矿。旧代码 `break` 掉循环后
 * 直接平移，于是"成功"编译出一座喂空地的工厂：`siteStage` 只在 `--hub` 给出时才逐格对拍
 * 资源图，未给 hub 时这道闸整段跳过（`skipped:"no-world-hub"`），假绿就这么来的。
 *
 * 算法（确定、无随机、无「放宽到能过」）：
 *   ① 枚举**第一台矿机**在区域内的同类资源格 `c`（排序：离 center 近 → 字典序）；
 *   ② 平移量由 `c` 唯一确定（`t = c − miner0`）—— 不存在"第二自由度"；
 *   ③ **逐台**验证其余矿机：任一不符号 ⇒ 该候选作废（不是"放宽"，是硬约束）；
 *   ④ 返回第一个全通过的平移量；一个都没有 ⇒ 结构化失败，hint 带真实扫过的候选数
 *      与每台矿机缺什么（绝不静默跳过某台矿机的资源检查）。
 *
 * 复杂度 O(|cand| × |miners|)：区域 96 时 |cand| 约 130，矿机 ≤ 4 ⇒ 可忽略。
 * 同输入逐字节同输出（三重 tie-break，无 locale 依赖）。
 *
 * @param {{id:string,resource?:string,hash?:string,x:number,y:number}[]} miners 已定好相对位置的矿机
 * @param {{seed:number,region:object,center:number[],hubWorld?:number[]|null}} ctx
 * @returns {{ok:true,shift:[number,number],cells:Map<string,number[]>}
 *          |{ok:false,reason:string,failingNode:object,hint:string}}
 */
export function jointResourceShift(miners, ctx) {
	const { seed, region, center } = ctx;
	if (!miners.length) return { ok: true, shift: [0, 0], cells: new Map() };
	const hubW = Array.isArray(ctx.hubWorld) && ctx.hubWorld.length === 2 ? ctx.hubWorld : null;
	// 矿机不能压在 hub 的 4×4 solid 上（物理上放不下）。与 pickResourceCells 同一条判据。
	const onHub = c => hubW && c[0] >= hubW[0] && c[0] < hubW[0] + HUB_SIZE && c[1] >= hubW[1] && c[1] < hubW[1] + HUB_SIZE;

	const resOf = m => m.resource || m.hash;
	const anchorMiner = miners[0];
	const want0 = resOf(anchorMiner);
	const distTo = c => Math.hypot(c[0] - center[0], c[1] - center[1]);
	/* 既有工厂占住的格（world 系）：矿机不能建在上面。
	   注：这里只有"能不能站"的信息，没有推送平移量的能力 —— 即使避开占位后
	   DAG 相对偏移仍不成立，下面的 ④ 会如实失败，由调用方回落到逐台独立落位。 */
	const occW = ctx.occupiedWorld instanceof Set ? ctx.occupiedWorld : null;
	const freeOfPlant = c => !(occW && occW.has(cellKey(c[0], c[1])));
	// ① 第一台矿机的候选资源格（去 hub 占地；去既有工厂占位；排序确定）
	const cands = findResource(seed, s => s === want0, region)
		.filter(c => !onHub(c) && freeOfPlant(c))
		.sort((a, b) => (distTo(a) - distTo(b)) || cmpStr(a.join(","), b.join(",")));

	if (!cands.length) {
		return makeFailure("no-resource-in-range", { nodeId: anchorMiner.id, cell: null, check: "V1-occupancy" },
			`seed=${seed}、以 ${center.join(",")} 为心半径 ${region.x1 - center[0]} 内没有资源 ${want0}` +
			(hubW ? `（hub ${hubW.join(",")} 占住的格已排除）` : "")
			+ (occW ? `（既有工厂占住的 ${occW.size} 格已排除）` : "") + `（矿机 ${anchorMiner.id} 要它）`);
	}

	// ②+③ 每个候选平移量都要**全部**矿机同时命中；记录最接近的失败作凭据
	let best = null;                                  // 命中矿机数最多的失败候选（诊断用）
	let tried = 0;
	for (const c of cands) {
		tried++;
		const t = [c[0] - anchorMiner.x, c[1] - anchorMiner.y];
		const missing = [];
		for (const m of miners) {
			const cx = m.x + t[0], cy = m.y + t[1];
			const got = tileResource(seed, cx, cy);
			if (got !== resOf(m)) missing.push({ nodeId: m.id, cell: [cx, cy], want: resOf(m), got });
			// 第二台起还要排除「压在 hub 上」—— 第一台已在上面的 filter 里排除了
			if (m !== anchorMiner && onHub([cx, cy])) missing.push({ nodeId: m.id, cell: [cx, cy], want: resOf(m), got: "hub-occupies" });
		}
		if (missing.length) {
			if (!best || missing.length < best.missing.length) best = { t, missing };
			continue;                                  // 硬约束：不放宽、不跳过
		}
		const cells = new Map();
		for (const m of miners) cells.set(m.id, [m.x + t[0], m.y + t[1]]);
		/* ★ 两台矿机落在**同一格**不是解：那意味着 paste 会在一格上放两台机器（第三台会「覆盖」第二台，
		   且两者共用同一份资源）。这里必须显式拒 —— 返回一张自相矛盾的表比返回失败更坏。
		   （当前 assignRows 不会给两台矿机同偏移，所以此路在 place() 里够不着；但本函数是导出的，
		     布局一旦变化就会静默产出非法计划 —— 红队 finding F7 / 审查 F7。） */
		const seen = new Set();
		const dup = [];
		for (const [id, c] of cells) {
			const k = `${c[0]},${c[1]}`;
			if (seen.has(k)) dup.push({ nodeId: id, cell: c });
			else seen.add(k);
		}
		if (dup.length) {
			if (!best || dup.length < best.missing.length) {
				best = { t, missing: dup.map(d => ({ nodeId: d.nodeId, cell: d.cell, want: resOf(miners.find(m => m.id === d.nodeId)), got: "duplicate-cell" })) };
			}
			continue;
		}
		return { ok: true, shift: t, cells };
	}

	// ④ 真的没有联合可行解 —— 诚实失败，带上扫过的参数空间
	const perMiner = miners.map(m => {
		const its = findResource(seed, s => s === resOf(m), region).filter(c => !onHub(c)).length;
		const need = resOf(m);
		return `${m.id}(${need}) 区域内有 ${its} 格`;
	});
	return makeFailure("no-resource-in-range",
		{ nodeId: best && best.missing[0] ? best.missing[0].nodeId : anchorMiner.id,
			cell: best && best.missing[0] ? best.missing[0].cell : null, check: "V1-occupancy" },
		`${miners.length} 台矿机在 seed=${seed}、以 ${center.join(",")} 为心半径 ${region.x1 - center[0]} 内`
		+ `**没有联合可行**的落点：布局把它们的相对位置硬定死（${miners.map(m => `${m.id}@rel(${m.x - anchorMiner.x},${m.y - anchorMiner.y})`).join(" ")}），`
		+ `逐台都各自有矿（${perMiner.join("；")}），但这些相对偏移无法同时命中。`
		+ `扫过 ${tried} 个候选（= ${want0} 的每一格）× ${miners.length} 台矿机的逐格对拍。`
		+ (best ? `最接近的候选 shift=(${best.t.join(",")}) 仍缺：${best.missing.map(x => `${x.nodeId}@${x.cell} 要 ${x.want} 实得 ${x.got}`).join("；")}。` : "")
		+ `｜这是**几何硬约束**，不是搜索范围问题：扩大 --range 只会加入更多同样不匹配的候选。`);
}

/* ═══════════════ 5c) 多矿机**逐台独立**落位（P1-3 回落路径）═══════════════ */

/**
 * 每台矿机各自选最近的矿，**不再要求刚性相对偏移**。
 *
 * ★ 为什么需要它 ★
 * `jointResourceShift` 只返回**一个平移量**，于是整簇矿机的相对偏移被 DAG 布局锁死。
 * `CgScScCg` 要求五台矿机恰好落在一条 5 格等距直线上且各自压对矿 —— 真实矿图里
 * 这个关系在四个种子上无一成立（43391/60908/77844/15935 全部 no-resource-in-range）。
 * 而矿机的**唯一**硬约束是"压在自己的资源上"（systems/miner.js:48-56 读 origin 下层内容）；
 * 相对间距完全自由，通道本来就该处理任意端点。
 *
 * ★ 为什么是**回落**而不是替换 ★
 * 逐台独立会让通道变长、更容易交叉。刚性方案在 `CrCrCrCr`/`RbRb----`/`CpCpCpCp` 的
 * 某些种子上恰好能成，直接换掉会有回归风险。所以只在刚性失败时才用它：
 * 能跑的种子输出**逐字节不变**，跑不了的种子才有机会。
 *
 * 约束（与 `pickResourceCells` 同一套纪律）：
 *   · 不压 hub 的 4×4 solid（物理上放不下）
 *   · 不同矿机不共用**同一列**（M4-SUCCESS 前置：两矿同列 ⇒ 两条竖直通道重叠）
 *   · 不重复用同一格
 * 排序：离 center 近 → 字典序（确定性，无 locale 依赖）。
 *
 * @param {{id:string,resource?:string,hash?:string}[]} miners
 * @param {{seed:number,region:object,center:number[],hubWorld?:number[]|null}} ctx
 * @returns {{ok:true,cells:Map<string,number[]>}
 *          |{ok:false,reason:string,failingNode:object,hint:string}}
 */
export function independentMinerCells(miners, ctx) {
	const { seed, region, center } = ctx;
	if (!miners.length) return { ok: true, cells: new Map() };
	const hubW = Array.isArray(ctx.hubWorld) && ctx.hubWorld.length === 2 ? ctx.hubWorld : null;
	const onHub = c => hubW && c[0] >= hubW[0] && c[0] < hubW[0] + HUB_SIZE && c[1] >= hubW[1] && c[1] < hubW[1] + HUB_SIZE;
	const resOf = m => m.resource || m.hash;
	/* 既有工厂占住的格：矿机**不能**建在上面（机器是 solid，压不掉）。
	   坐标是 world 系 —— 与 findResource 返回的资源格同一系，直接比对即可。 */
	const taken = ctx.occupiedWorld instanceof Set ? ctx.occupiedWorld : null;
	const free = c => !(taken && taken.has(cellKey(c[0], c[1])));

	const cells = new Map();
	const usedCols = new Set();
	const usedCells = new Set();
	const missing = [];

	for (const m of miners) {
		const want = resOf(m);
		const cands = findResource(seed, s => s === want, region)
			.filter(c => !onHub(c) && free(c) && !usedCells.has(cellKey(c[0], c[1])) && !usedCols.has(c[0]))
			.sort((a, b) => (Math.hypot(a[0] - center[0], a[1] - center[1]) - Math.hypot(b[0] - center[0], b[1] - center[1]))
				|| cmpStr(a.join(","), b.join(",")));
		const hit = cands[0];
		if (!hit) {
			// 该列被占满 / hub 压住：退一步，允许同列但不同格（总比没有好，并如实记账）
			const relaxed = findResource(seed, s => s === want, region)
				.filter(c => !onHub(c) && free(c) && !usedCells.has(cellKey(c[0], c[1])))
				.sort((a, b) => (Math.hypot(a[0] - center[0], a[1] - center[1]) - Math.hypot(b[0] - center[0], b[1] - center[1]))
					|| cmpStr(a.join(","), b.join(",")))[0];
			if (!relaxed) { missing.push({ nodeId: m.id, want }); continue; }
			cells.set(m.id, [relaxed[0], relaxed[1]]);
			usedCells.add(cellKey(relaxed[0], relaxed[1]));
			continue;
		}
		cells.set(m.id, [hit[0], hit[1]]);
		usedCells.add(cellKey(hit[0], hit[1]));
		usedCols.add(hit[0]);
	}

	if (missing.length) {
		return makeFailure("no-resource-in-range",
			{ nodeId: missing[0].nodeId, cell: null, check: "V1-occupancy" },
			`逐台独立落位仍缺资源：${missing.map(x => `${x.nodeId} 要 ${x.want}`).join("；")}` +
			`（seed=${seed}、以 ${center.join(",")} 为心半径 ${region.x1 - center[0]} 内）`);
	}
	return { ok: true, cells };
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
	/* (b) 坐标系口径：LayoutReport = **site 相对局部系**（与 P1 plan-l1.json 逐格一致：
	   site.anchor 是世界、layout.occupancy[].cell = 世界 − anchor = 局部小值）。
	   ⇒ 一切进报告的坐标都必须在**同一个局部系**里。机器本就排局部；bug 是 hub/occupancy 被当世界系裸用，
	   与机器混框 → 收集带从局部机器铺到世界 hub。修法：世界 hub / occupancy 在摄入时按 origin 换算成局部，
	   并把机器簇整体对齐到 hub 正下方（收集带只跨一次"机器顶到 hub 底"的间距，绝不跨千格）。 */
	const w = validateWorld(input.world);
	if (w.ok === false) return w;

	// 局部原点：site 优先；只给世界 hub（无 site）时以 hub 为原点（⇒ 局部 hub≈(0,0)，机器排在其下方）
	const isPt = p => p && Number.isInteger(p.x) && Number.isInteger(p.y);
	const origin = isPt(input.site) ? input.site : (isPt(input.hub) ? input.hub : { x: 0, y: 0 });
	// 世界 → 局部：hub 与既有占用一律换算（world 实体在 v1 只可能是 hub，occupancy 为空/仅 hub 铺格）
	const hubLocal = isPt(input.hub) ? [input.hub.x - origin.x, input.hub.y - origin.y] : null;
	const occupancyLocal = (w.occupancy || []).map(o => ({ ...o, cell: [o.cell[0] - origin.x, o.cell[1] - origin.y] }));

	let dag;
	try { dag = buildDag(input.steps, { allowMultiTerminal: input.allowMultiTerminal === true }); }
	catch (e) {
		if (e instanceof ContractViolation) return makeFailure("out-of-scope:multilayer", null, `steps 归一化失败：${e.message}`.slice(0, 220));
		throw e;
	}
	if (dag.ok === false) return dag;
	const nodes = dag.nodes;
	const terminals = dag.terminals;

	/* ★ 多矿机并联：同形状的 mine 节点合成一个 mineGroup ★
	   攻略里最硬的一条是「5 台矿机喂满 1 条带」。在此之前编译器一个 mine = 一台矿机，
	   产线只有一根柱、产能被 0.4/s 锁死 —— 我建出来的工厂只有 1 台矿机就是这个原因。
	   合并只发生在矿机层：组对下游只有一个输出槽，所以后面的布局/路由一行都不用改。
	   `input.mergeMiners === false` 可关闭（回归对照用）。 */
	/* ★ 只在**显式开启**时复制矿机 ★
	   为什么不做默认行为：复制会把单矿机目标变成 4 矿机 + 3 balancer，
	   布局宽度翻倍、通道必然交叉，`CrCrCrCr` 这类目标立刻布不出来。
	   "5 台矿机喂满一条带"是**产能优化**，不是布局正确性的前提 ——
	   它该由调用方（agent 的规则层）按需开启，不该是编译器的默认。
	   `input.minersPerLine >= 2` 才启用。 */
	let minerGroups = [];
	if (input.mergeMiners !== false && Number.isInteger(input.minersPerLine) && input.minersPerLine >= 2) {
		const mg = replicateMiners(nodes, { perLine: input.minersPerLine });
		if (mg.ok === false) return mg;
		if (mg.groups.length === 0) {
			/* 没复制（perLine=1 或没有可复制的形状矿机）：什么都不做。
			   ⚠️ 不能用 `mg.nodes` 替换 —— 那是 `nodes.slice()` 的副本，
			   后面的代码持有 `nodes` 的原引用（如 nodes.length = 0; nodes.push(...)），
			   换数组会让两边的修改互相看不见。原地不动最安全。 */
		} else {
			/* ★ 把组**展开**成真实节点：N 台矿机 + (N-1) 个 balancer ★
			   为什么在 layout 之前展开而不是 layout 之后：展开后的节点就是普通节点，
			   后面 assignRows / planChannel / 发射全部原样工作，不需要任何特判。
			   组的对外输出由**最后一个 balancer** 提供，所以下游拿到的仍是一个上游。

			   拓扑（N=3 为例，全部朝北）：
			     m0 m1 m2            三台矿机并排
			      │  │  │
			      └──┴──┘            各自一格带进 balancer
			        bal1             （2 进 2 出，堵了会改道）
			         │ bal2
			         输出 → 下游 */
			const expanded = [];
			/* ⚠️ 要遍历 `mg.nodes`（replicateMiners 的产物，里面是 mineGroup），
			   不是 `nodes`（原数组，里面还是那台 mine）。
			   第一版写成了 `for (const n of nodes)`，于是永远匹配不到 mineGroup，
			   展开循环空转、`expanded` 全是原节点 —— 日志显示 "expanded nodes= mine,cut"。 */
			for (const n of mg.nodes) {
				if (n.op !== "mineGroup") { expanded.push(n); continue; }
				const N = n.members.length;
				/* 成员矿机：保留原 id（下游可能引用），其余派生 */
				const bals = [];
				for (let i = 0; i < N - 1; i++) {
					bals.push({
						id: `${n.id}#bal${i}`, op: "balance", hash: n.hash,
						template: ALL_TEMPLATES.balance, inputs: [], parents: [null, null],
						consumers: 0, usedOut: new Set(), nextOut: 0,
						x: 0, y: 0, depth: n.depth, args: {},
						groupOf: n.id,
						/* 链内序号：布局时用它错开列（见 assignRows 的 balance 分支）。
						   第 0 个 balancer 直接接第一台矿机，不需要偏移；后面的逐个右移。 */
						balanceChainIdx: i,
					});
				}
				/* 串成链：bal_i 的 in0 收 m_i，in1 收 bal_{i+1}（或 m_{N-1}）。
				   最后一个 bal 的 out 给下游。 */
				for (let i = 0; i < N - 1; i++) {
					bals[i].parents[0] = n.members[i];
					n.members[i].consumers = 1;
				}
				for (let i = 0; i < N - 2; i++) {
					bals[i].parents[1] = bals[i + 1];
					bals[i + 1].consumers = 1;
				}
				if (N >= 2) {
					bals[N - 2].parents[1] = n.members[N - 1];
					n.members[N - 1].consumers = 1;
				}
				/* 下游的父：从组换成最后一个 balancer */
				const tail = bals.length ? bals[bals.length - 1] : n.members[0];
				tail.consumers = n.consumers;
				for (const other of mg.nodes) {
					if (other.op === "mineGroup") continue;
					for (let k = 0; k < other.parents.length; k++) {
						if (other.parents[k] === n) other.parents[k] = tail;
					}
				}
				expanded.push(...n.members, ...bals);
			}
			nodes.length = 0;
			nodes.push(...expanded);
			minerGroups = mg.groups;
			/* ★ terminals 必须跟着重算 ★
			   `terminals` 是 `dag.terminals` 的**引用**，里面存的是展开前的旧节点。
			   展开后旧 mine 被替换成 balancer 链尾，但 terminals 还指着旧对象 ——
			   于是 hub 连接从"一台已经不存在的矿机"出发（实测 `chHub n0→hub [0,0]`，
			   矿机坐标 (0,0) 根本不是它的输出槽，P5 报 V4）。
			   重算口径与 buildDag 一致：没有消费者、且不是 trash 的节点。 */
			terminals.length = 0;
			terminals.push(...nodes.filter(n => n.consumers === 0 && n.op !== "trash"));
		}
	}

	/* 分层 → 层内 barycenter（父子保序）→ 行式坐标
	   ⚠️ layerAndOrder 会先做**层号校正**（normalizeDepths）：显式 depth 与 DAG 边矛盾时以 DAG 为准。
	   这是**排版几何**的校正（层号 = 画在第几行），不是配方数据改写 —— nodes[].depth 只服务本文件的行分配；
	   校正凭据挂在返回的 levels 数组上（非数组属性），不进 LayoutReport（§2.3 无此字段，不擅自扩契约）。 */
	const levels = layerAndOrder(nodes);
	/* ★ 矿机层的 x 由**资源**决定，不是由列游标决定 ★
	   行式布局默认把同层机器按 `游标 + colGap` 等距排开（间距 4）。对单矿机目标无所谓，
	   但多矿机目标（上色 = 形状矿 + 1~4 台颜料矿）的矿位在世界里是**散落**的：要求它们
	   恰好落在「相对偏移 4 格」上几乎不可能（CpCpCpCp 需要的 Cu/blue/red 三连在 ±400 内
	   只有 2 处，且都不在 4 格间距上）。这不是搜索范围问题 —— 是布局把一个不该固定的量
	   固定了。矿机的**唯一**硬约束是"压在自己的资源上"，相对间距完全自由。
	   所以给了 seed 时，先用资源图求一组**保序**的矿机 x（保序 = 不换左右次序，通道不交叉），
	   再让消费者按 desiredX 跟随。没给 seed / 无资源约束时完全跳过 → 金网格逐字节不变。 */
	const seedEarly = input.seed !== undefined && input.seed !== null ? input.seed
		: (input.world && input.world.seed !== undefined ? input.world.seed : null);
	let minerX = null;
	if (seedEarly !== null) {
		const minerLevel = levels[0] || [];
		const minersInOrder = minerLevel.filter(n => n.op === "mine");
		if (minersInOrder.length > 1) {
			const centerW = [origin.x, origin.y];
			const region = input.region || regionAround(centerW, input.range === undefined ? 96 : input.range);
			minerX = planMinerColumns(minersInOrder, { seed: seedEarly, region, center: centerW });
		}
	}
	/* WP2：两轮布局。`planMultiInputRows` 要读上游已定的 x/y，而那些只有 `assignRows`
	   跑完第一轮之后才存在 —— 所以先排一次 → 算约束 → 带上约束重排。
	   只给 seed 时启用：无 seed 的金网格路径必须逐字节不变（G1/G2/G3）。 */
	let layoutOpts = { rowGap: input.rowGap, colGap: input.colGap, minerX };
	let pass = assignRows(levels, layoutOpts);
	if (seedEarly !== null) {
		const rr = planMultiInputRows(nodes, { rowGap: input.rowGap === undefined ? ROW_H : input.rowGap });
		if (rr.rowY.size || rr.colX.size) {
			layoutOpts = { ...layoutOpts, rowY: rr.rowY, multiX: rr.colX };
			pass = assignRows(levels, layoutOpts);
		}
	}
	const { rows } = pass;

	/* (b) 有 hub：把机器簇对齐到 hub 正下方（局部系），消除混框导致的千格收集带。
	   顶行 → hub 底缘下方 HUB_CLEAR 行；minX → hub 左列（hub 底部 4 个 entry 覆盖 hubLocal.x..x+3）。
	   无 hub：完全跳过 → 金网格（site/hub 皆缺省）逐字节不变。

	   **(a) 有 seed 时优先"矿机压真资源"**（B-4）：矿机是**唯一**必须落在特定世界格上的实体，
	   其余机器的相对位置由 DAG 决定。所以给了 seed 就先按资源反推机器簇的平移量，
	   再让收集带从"矿机真所在处"走向 hub —— 而不是硬把簇摆到 hub 下方导致矿机悬空。
	   （不这样做的话，编译链的 anchor 会被 siteStage 解成「hub 钉死」，矿机必然离资源 → 无产出。）*/
	let resourceTable = null;
	const seedIn = input.seed !== undefined && input.seed !== null ? input.seed
		: (input.world && input.world.seed !== undefined ? input.world.seed : null);

	if (hubLocal && seedIn !== null) {
		/* ★ 多矿机**联合**对齐（WORKER F）：必须让**每一台**矿机都压到它自己的资源上。
		   旧代码只对齐第一台矿机（循环里 `break`），其余矿机落在「DAG 硬定的相对偏移」所指的格上
		   —— 那里可能没有对应资源。`CrCrCrCr` 的颜料矿机恒在 Cu 矿机西侧 4 格同行，只对齐 Cu
		   就把红矿机丢在没有红矿的地上；而 siteStage 在**未给 hub** 时整段跳过资源对拍，
		   于是编译"成功"却喂空地（假绿）。详见 jointResourceShift 头注。 */
		const minerNodes = nodes.filter(n => n.op === "mine");
		const centerW = [origin.x, origin.y];                     // 世界系搜索中心 = 作图原点（给了 hub 时就是真 hub）
		const region = input.region || regionAround(centerW, input.range === undefined ? 48 : input.range);
		/* 既有工厂占住的格（world 系）—— 刚性/独立两条路都必须避开。
		   直接从 occupancyLocal（世界 − origin）加回 origin 还原成世界系，
		   才能与 findResource 返回的资源格比对。 */
		const occupiedWorld = new Set();
		for (const o of occupancyLocal) {
			if (o.state !== "solid") continue;          // 带子可覆盖，不挡矿机
			occupiedWorld.add(cellKey(o.cell[0] + origin.x, o.cell[1] + origin.y));
		}
		// 矿机按**世界系**喂进去：这样返回的 shift 是纯世界系平移量，加到局部坐标上同样成立
		// （世界 = origin + 局部，平移量两边相同）—— 避免"世界格 − 局部格"的混框。
		const js0 = jointResourceShift(
			minerNodes.map(n => ({ id: n.id, resource: n.resource, hash: n.hash, x: n.x + origin.x, y: n.y + origin.y })),
			{ seed: seedIn, region, center: centerW, hubWorld: hubLocal ? [origin.x, origin.y] : null, occupiedWorld });
		/* ★ P1-3 回落：刚性方案失败时，改成逐台独立落位 ★
		   刚性方案把矿机的相对偏移锁死在 DAG 布局上，真实矿图几乎不可能满足
		   （CgScScCg 四个种子全部 0/4）。独立方案让每台矿机各自找矿，通道再用
		   planChannel 去连 —— 那本来就是它的职责。
		   顺序**故意**是"先刚性、后独立"：刚性成功时输出与修复前逐字节相同，
		   所以所有今天能编译的目标零回归，只有今天失败的目标才走新路径。 */
		let js = js0;
		if (js.ok === false && minerNodes.length > 1) {
			const ind = independentMinerCells(
				minerNodes.map(n => ({ id: n.id, resource: n.resource, hash: n.hash })),
				{ seed: seedIn, region, center: centerW, hubWorld: hubLocal ? [origin.x, origin.y] : null, occupiedWorld });
			if (ind.ok !== false) {
				/* 逐节点落位：每台矿机直接搬到它自己的矿上（世界系 → 局部系）。
				   非矿机节点不在这里动 —— 它们等到下面 (b)「对齐 hub」再整体摆位。 */
				for (const n of minerNodes) {
					const c = ind.cells.get(n.id);
					if (!c) continue;
					n.x = c[0] - origin.x;
					n.y = c[1] - origin.y;
					n.row = n.y;
				}
				resourceTable = new Map();
				for (const [id, c] of ind.cells) resourceTable.set(id, [c[0] - origin.x, c[1] - origin.y]);
				js = { ok: true, independent: true, cells: ind.cells };
			} else {
				/* 两条路都失败 ⇒ 报**刚性的**那条失败。
				   它是更精确的诊断（"相对偏移无法同时命中" vs "某台没矿"），
				   而且刚性先跑、独立只在前者失败时试，所以这个分支只在真的无解时到达。 */
				return js0;
			}
		}
		if (js.ok === false) return js;
		if (js.independent === true) {
			// 已经逐节点落好；不走统一平移分支
		} else {
		const [dx, dy] = js.shift;
		if (dx !== 0 || dy !== 0) {
			for (const n of nodes) { n.x += dx; n.y += dy; n.row += dy; }
			for (const r of rows) r.y += dy;
		}
		// meta.minerCells 记**局部系**（世界 = origin + 局部），与既有口径一致
		resourceTable = new Map();
		for (const [id, c] of js.cells) resourceTable.set(id, [c[0] - origin.x, c[1] - origin.y]);
		}
	} else if (hubLocal) {
		let minX = Infinity, minY = Infinity;
		for (const n of nodes) { if (n.x < minX) minX = n.x; if (n.y < minY) minY = n.y; }
		const dx = hubLocal[0] - minX;
		const dy = (hubLocal[1] + HUB_SIZE + HUB_CLEAR) - minY;   // 机器簇顶行落在 hub 底缘下方 HUB_CLEAR 行
		if (dx !== 0 || dy !== 0) {
			for (const n of nodes) { n.x += dx; n.y += dy; n.row += dy; }
			for (const r of rows) r.y += dy;
		}
	}

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
	if (hubLocal) {
		for (let dy = 0; dy < HUB_SIZE; dy++) for (let dx = 0; dx < HUB_SIZE; dx++) {
			occupied.add(cellKey(hubLocal[0] + dx, hubLocal[1] + dy));
		}
	}
	/* ★ 既有工厂的占位必须真的挡住新机器（P1-4）★
	   以前 occupancyLocal 只被抄进报告，**从不参与落位判断** —— 于是编译器选中了 level 3
	   矿机所在的那一格，靠 paste 的 dry_run 才拦下来。占位数据一直是有的，只是没接线。
	   state 区分两档，语义与 paste 的 dry_run 一致：
	     · solid（机器 / hub）→ 挡机器、**也挡通道**（带子穿不过机器）
	     · replaceable（带子）→ 挡机器（不能把矿机建在带子上），但**通道可以覆盖**
	       （paste 会销毁旧带铺新带，这正是 dry_run 报告 destroys 的那一类，合法）。
	   ⚠️ 旧带若被通道覆盖是**有意为之**，但会让旧产线断掉 —— 这是增量对接的真实取舍，
	   调用方拿到 destroys 清单后自行判断。 */
	for (const o of occupancyLocal) {
		const k = cellKey(o.cell[0], o.cell[1]);
		/* 带子（replaceable）当前一律算占位 —— 覆盖旧带会让既有产线断掉，
		   在没有"产出不中断"验证之前，保守地绕开才是诚实的。
		   想放开时把这个分支改成只挡 solid 即可（语义已写好，见上注）。 */
		occupied.add(k);
	}

	const channels = [], lanes = [], conflicts = [], beltCells = [];
	let tunnelCount = 0;                                   // 本布局用了几段隧道（meta 里报）
	const lanePool = new Set();
	let seq = 0;

	/** 一条通道：端点对 + 几何 + 冲突上报（撞格/无解**不静默**）*/
	const route = (parent, outSlot, child, inSlot, ordinal, payload, o = {}) => {
		const fromCell = slotCell(parent, outSlot);
		const toCell = Array.isArray(o.toCell) ? o.toCell : slotCell(child, inSlot);
		const first = beltSide(fromCell, outSlot.dir);
		const last = beltSide(toCell, inSlot.dir);
		const id = o.id || `ch${seq}`;
		const r = planChannel(first, outSlot.dir, last, inSlot.dir,
			{ occupied, lanePool, strictLane: o.strictLane === true, tunnels: input.tunnels === true });
		const report = {
			/* ★ 显式 id：与 P4 的 `channelIdOf` 对齐 ★
			   P3 内部用 `ch<n>`（序号）标识通道，而 P4 在没有显式 id 时会自己推
			   `from->to#ordinal` —— 两套名字互不相认，`report.beltCells` 里的 channelId
			   就匹配不上 P4 的 geoms（隧道/预铺路径的采纳因此失效）。
			   在 channels[] 上写死 `id` 后，P4 的 `channelIdOf` 第一分支直接取它，
			   两侧从此用同一个名字。 */
			id,
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
			const vert = isVert(outSlot.dir);
			// LANE_SCHEMA_VERSION=2：车道轴随行写出（row = 水平车道行 / col = 竖直车道列）。
			// 不写它 ⇒ 下游只能按「缺省 = row」猜，P3 若给水平出向的通道选了列号就会被当成行号
			// （P4 会重算，但这份报告在 P4 之前已经自相矛盾 —— 见 types.mjs 的 LayoutChannel 注释）。
			report.laneAxis = vert ? "row" : "col";
			const key = vert ? `row:${r.lane}` : `col:${r.lane}`;
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
			// 台账按 (轴, 下标) 记账：row:3 与 col:3 是两条不同车道，不得并进同一条目。
			// 条目形状按 LANE_SCHEMA_VERSION=2 写全（{row, column} 恰一个非 null），
			// 不留"缺字段"的写法 —— P1 的 assertLayoutReport 两种都收，但产出侧不应依赖缺省。
			const ex = lanes.find(l => laneKeyOfLedger(l) === key);
			if (ex) { if (!ex.channelIds.includes(id)) ex.channelIds.push(id); }
			else lanes.push(vert ? { row: r.lane, column: null, channelIds: [id] } : { row: null, column: r.lane, channelIds: [id] });
		}
		for (const b of r.cells) {
			/* 隧道格（sender/receiver）占格；被"穿过"的格**不**占 —— 那是隧道的语义
			   （别的东西可以从它上方/下方经过）。 */
			occupied.add(cellKey(b.cell[0], b.cell[1]));
			beltCells.push({ ...b, id });
		}
		/* ★ 但"被穿过的格"必须记进一份**独立的隧道占用表** ★
		   它们对普通带子是空闲的（这正是隧道存在的理由），可对**另一条隧道**必须可见 ——
		   否则两条隧道会选同一段格互相穿。更关键的是：后续通道若在那格铺了普通带子，
		   `walkChannel` 走到 sender 时会在"空档"里撞见它，把合法隧道判成不成立
		   （实测 (-38,40)：ch8 的隧道穿过它，而 ch7 后铺时又在那儿放了一条竖带）。
		   P3 的规则：**先到先得** —— 隧道跨过的格对后续通道算"已占"，
		   后续通道绕开即可（这正是"隧道优先占道"的工程选择）。 */
		if (r.kind && r.kind.startsWith("tunnel")) {
			const spanCells = new Set();
			for (const b of r.cells) spanCells.add(cellKey(b.cell[0], b.cell[1]));
			if (r.tunnelSpanCells) for (const c of r.tunnelSpanCells) occupied.add(cellKey(c[0], c[1]));
		}
		if (r.kind && r.kind.startsWith("tunnel")) tunnelCount++;
		channels.push(report);
		return { report, ok: true, kind: r.kind, cornerCount: r.cornerCount, id, tunnels: r.tunnels || 0 };
	};

	/* ★ WP1：可交换多输入机器（只有 mix）的槽序必须与**西→东**一致 ★
	   `planChannel` 对 bottom 输入的硬律是：喂它的上游列必须 <= 该输入列（直入或 Z），
	   绝不能更靠东 —— 从东侧绕回来是 4 拐角，v1 无隧道，做不到。
	   mix 的 slot0 在 mix.x、slot1 在 mix.x+1，所以**两个父必须西→东排列**。
	   而 `layerAndOrder` 的 barycenter 序是按 DAG 邻接给的，与槽序无关：实测
	   CgScScCg 的矿机序是 `---g----, -b------, -g------, n0, n6`，
	   而 mix 的槽序是 `[-b------(blue), -g------(green)]` —— blue 在 -221、green 在 -267，
	   即 slot0 的父比 slot1 的父更靠**东**。这一条就足以让第二条颜料通道必撞机器。
	   ⚠️ **只对 mix 做**：`stack` 的 slot0/slot1 是**下层/上层**（item_processor.js 的
	     process_STACKER 按 items.get(0)/get(1) 取），换序会产出 ScScCgCg 而不是 CgScScCg ——
	     一份**能通过校验但语义错**的蓝图。mix 则是对称的（colors.js 的
	     bitfieldToColor[i|j] 可交换），换序语义等价。 */
	for (const n of nodes) {
		if (n.op !== "mix") continue;
		const idx = n.parents.map((p, i) => ({ p, i })).filter(e => e.p);
		if (idx.length < 2) continue;
		const sorted = idx.slice().sort((a, b) => (a.p.x - b.p.x) || (a.i - b.i));
		if (sorted.every((e, k) => e.i === idx[k].i)) continue;     // 已符合西→东，不动
		n.parents = sorted.map(e => e.p);
		while (n.parents.length < n.template.inputs.length) n.parents.push(null);
	}

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
			// payload 必须过 shortKey 语法闸（types.mjs 的 checkShortKeyGrammar）⇒ 一律用 hash，**不用** resource：
			// 矿机的 resource 是**世界资源名**（颜料是 `red`/`blue`/…，形状是 `CuCuCuCu`）。
			// 颜料资源名 `red` 只有 3 字符、会被语法闸拒（shortKey 每层必须 8 字符）；
			// hash 才是那个形状空间 token（`-r------`）。两条语义**绝不能混用**：
			//   channels[].payload = 形状空间 token（P4/P5/P6 按形状处理）
			//   meta.minerResources = 世界资源名（siteStage 按资源图对拍）
			route(p, outSlot, n, ins[idx] || ins[0], idx, p.hash || "");
		});
	}

	/* 8.2 hub 连接（**先于 trash**：顶层产出优先喂 hub，喂了就不再被 trash 抢走；
	 *      顺序颠倒会让同一输出口被 route 两次 —— 一次进 hub 一次进 trash，重复消费。
	 *      不连 hub（无 hub / connectHub:false）时，顶层输出口留给 8.3 的 trash 兜底。）*/
	let hubConnection = null;
	if (terminals.length && input.connectHub !== false && hubLocal) {
		const term = terminals[0];
		const outs = outSlotsOf(term);
		/* 判据：节点若带 `args.half`（= 切割的哪一半），优先选 role 与它相同的槽；
		   没有这个信息（单输出机器）时退回"第一个未用槽"。
		   ⚠️ 字段是 `args`，不是 `_solverArgs` —— buildDag 只把 solver 的 args 存成 n.args，
		   `_solverArgs` 留在 mapOps 的 step 上、不进节点。第一版读错了字段，于是这条修复
		   静默失效：没有报错，只是继续走旧分支，hub 依旧拿到副产物。 */
		const wantHalf = term.args && term.args.half;
		const byHalf = wantHalf ? outs.filter(o => o.role === wantHalf) : [];
		const out = (byHalf.length ? byHalf.find(o => !term.usedOut.has(o.role)) : null)
			|| outs.find(o => !term.usedOut.has(o.role)) || null;
		if (out) {
			const entries = hubEntries(hubLocal);          // (b) 局部系的 hub 原点 → 入口/占位全在同一框
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
					// B-1 同类（但更窄）：trash 是**机器**，它紧贴**别的通道的拐角带格**时，那一格会因
					// 机器邻居被 reshuffle（rv 漂移，belt-rules.mjs:8-10）。**只有拐角格**会漂 ——
					// 直带格相邻是常态（G1 的 trash 一直贴着主链直带，140 断言全绿证明了它没事）。
					const nb = new Set([[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => cellKey(t.x + dx, t.y + dy)));
					const touchesForeignCorner = beltCells.some(b =>
						b.id !== r.id && isCorner(b.inDir, b.outDir) && nb.has(cellKey(b.cell[0], b.cell[1])));
					if (!touchesForeignCorner) {
						grid.occupyRect(t.x, t.y, 1, 1, t.id, { rot: 0, kind: "machine", kindName: "trash" });
						waste.push({ nodeId: n.id, outIdx: oi, role: out.role, waste: (n.template.wasteRoles || []).includes(out.role) });
						done = true; break;
					}
					lastWhy = "trash-touches-foreign-corner";
				} else {
					lastWhy = r.why;
				}
				nodes.pop(); restore(snap);                 // 试下一候选：回滚 trash 节点与通道
			}
			if (!done) {
				return makeFailure("no-site-large-enough", { nodeId: n.id, cell: [n.x, n.y], check: "V9-unused-outlet" },
					`${n.id} 的输出槽 ${oi}(${out.role}) 接不上 trash（直串+侧让 ${cands.length} 个候选全失败，末因 ${lastWhy}）`);
			}
		}
	}

	/* 8.4 资源格已在前面（机器簇定位前）算好；这里只在"无 hub 但有 seed"时补算（仅供 meta 记录）。
	   ⚠️ 资源搜索是世界系的（world.mjs 按真实地图 seed 找矿），但 (b) 口径下报告整体是局部系 ——
	   meta.minerCells 一律减去 origin 换算成局部，绝不在局部报告里泄漏世界坐标。*/
	if (resourceTable === null && seedIn !== null) {
		const rr = pickResourceCells(nodes, { ...input, seed: seedIn });
		if (rr.ok === false) return rr;
		if (rr.table) {
			const local = new Map();
			for (const [k, v] of rr.table) local.set(k, [v[0] - origin.x, v[1] - origin.y]);
			resourceTable = local;
		}
	}

	const rep = buildReport({ nodes, rows, channels, lanes, conflicts, beltCells, hubConnection,
		occupancy: occupancyLocal, hubLocal, input, waste, resourceTable,
		depthNormalized: levels.depthNormalized || null, tunnelCount });
	assertLayoutReport(rep, "layout");
	return rep;
}

/* ═════════════════════════ 9) 报告与字符网格 ═════════════════════════ */

/**
 * LayoutReport（§2.3 逐字段）。坐标不平移；cornerCount 与渲染**同源**（同一批 beltCells 的臂对判定），
 * 并交叉断言"grid 里 7/9/L/J 的个数 === cornerCount"（不一致 = 本包 bug，抛契约错，不许静默）。
 */
/**
 * LayoutReport（§2.3 逐字段）。**(b) site 相对局部系**：坐标原点 = place() 定下的 origin（site ?? hub ?? 0），
 * 机器 / hub（已换算成 hubLocal）/ 既有占用（已减 origin）都在同一框内，bbox 因此紧凑、不会跨千格。
 * 世界坐标 = origin + 局部（P6 发射时用 site.anchor 复原 —— 与 P1 plan-l1.json 的
 * `site.anchor=[1200,-1396]` 而 `layout.occupancy[0].cell=[0,-4]` 完全同一口径）。
 * cornerCount 与渲染**同源**（同一批 beltCells 的臂对判定），并交叉断言
 * "grid 里 7/9/L/J 的个数 === cornerCount"（不一致 = 本包 bug，抛契约错，不许静默）。
 */
function buildReport({ nodes, rows, channels, lanes, conflicts, beltCells, hubConnection, occupancy, input, waste, resourceTable, hubLocal, depthNormalized = null, tunnelCount = 0 }) {
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
		if (hubLocal) { touch(hubLocal); touch([hubLocal[0] + HUB_SIZE - 1, hubLocal[1] + HUB_SIZE - 1]); }
	}
	if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = -1; maxY = -1; }
	const w = Math.max(0, maxX - minX + 1), h = Math.max(0, maxY - minY + 1);

	const paint = Array.from({ length: h }, () => new Array(w).fill(GRID_CHARS.empty));
	const put = (c, g) => {
		const x = c[0] - minX, y = c[1] - minY;
		if (x >= 0 && x < w && y >= 0 && y < h) paint[y][x] = g;
	};
	for (const b of beltCells) {
		// 隧道格的 inDir===outDir（是一条"穿过"而非转弯），没有带子字符可画：
		// sender 画 'o'、receiver 画 'O'，一眼能与带子区分开。
		if (b.tunnel === "sender") { put(b.cell, "o"); continue; }
		if (b.tunnel === "receiver") { put(b.cell, "O"); continue; }
		put(b.cell, beltGlyph(b.inDir, b.outDir));
	}
	for (const n of nodes) {
		const fp = n.template.footprint;
		for (let dy = 0; dy < fp[1]; dy++) for (let dx = 0; dx < fp[0]; dx++) put([n.x + dx, n.y + dy], GRID_CHARS.empty);
		put([n.x, n.y], glyphFor(n.template.kind || n.op, n.op));
	}
	if (hubConnection && hubLocal) {
		for (let dy = 0; dy < HUB_SIZE; dy++) for (let dx = 0; dx < HUB_SIZE; dx++) put([hubLocal[0] + dx, hubLocal[1] + dy], GRID_CHARS.hub);
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
		tunnelCount,
		beltTiles: beltCells.length,
		minerCells: resourceTable ? Object.fromEntries([...resourceTable].map(([k, v]) => [k, [v[0], v[1]]])) : null,
		// 矿机 → **世界资源名**的显式映射（P8 的 siteStage 拿它对拍 seed 的资源图）。
		// 为什么必须显式给、不能从 channels[].payload 反推：颜料矿机的 payload 是形状空间 token
		// （`-r------`），而世界地图上没有叫 `-r------` 的资源，只有 `red`。两者**语义不同**：
		//   payload        = 形状空间 token，P4/P5/P6 按形状消费（必须过 8 字符语法）
		//   minerResources = 世界资源名，P8 siteStage 按资源图逐格对拍（`red` 不是 shortKey）
		// 每台矿机都在 buildDag 里定好了 resource（= 形状 hash 或颜料原色名），这里只做投影。
		// meta 是 §2.3 的**开放扩展袋**：assertLayoutReport 只 requireKeys 顶层十项，不校验 meta
		//（types.mjs 的 assertLayoutReport 不读 meta）⇒ 加键不破坏任何契约，也不改变既有字段。
		minerResources: Object.fromEntries(nodes.filter(n => n.op === "mine").map(n => [n.id, n.resource])),
		cornerCells: cornerCells.map(b => [b.cell[0], b.cell[1]]),
		// 层号校正凭据（审查 F5c）：不设它，一次矛盾触发的**全图重排**对下游是完全静默的。
		// null = 输入层号与 DAG 边一致（未重排）；否则带出矛盾的边，供 P5/P7 审计。
		depthNormalized,
	};
	return {
		grid, rows, placements, channels, lanes, hubConnection,
		bbox: [w, h], occupancy, conflicts, cornerCount, meta,
		/* ★ P3 的逐格路由结果（含隧道）★
		   P4 传统上**丢弃** P3 的逐格路径、按 channels 的端点 + lane 重算 —— 那样隧道信息
		   就丢了（P3 用隧道跨过的格，P4 重算时会当成"这里应该有一条带子"，随即失败）。
		   本字段把 P3 真正铺出来的格子（带 `tunnel` 标记）交给 P4，让它优先采纳。
		   §2.3 的 LayoutReport 契约不要求这个字段（`assertLayoutReport` 只校验**必需**键），
		   加它不破坏既有消费者；P4 不认识它时行为不变。 */
		beltCells: beltCells.map(b => ({ cell: [b.cell[0], b.cell[1]], inDir: b.inDir, outDir: b.outDir, channelId: b.id, tunnel: b.tunnel || null })),
	};
}

/* ═════════════════════════ 自测薄壳（守卫：绝不为别人的 --test 夹带输出）═════════════════════ */
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("compiler/place.mjs")) {
	console.log("place.mjs: L0 请跑 `node research/ai-plan/placer/test.mjs`（四张金网格逐字节 + 负例 + 契约 + lint）。");
}
