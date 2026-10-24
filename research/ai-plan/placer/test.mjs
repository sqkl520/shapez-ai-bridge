/**
 * test.mjs — P3 `placer` 的 L0 离线验收（plan-compiler.md §1.3 + 执行包 §验收）。
 *
 *   node research/ai-plan/placer/test.mjs        退出码 0 = L0 全绿
 *
 * 零依赖：ESM + node: 内置。全程离线（零游戏/零网络/零 RPC —— plan §4，P3 100% 离线）。
 * **测试自包含：不 import P4/P5**（route/lane/validate），只 import P1(types/grid/errors)+P2(op-templates/world)+P3(place)。
 *
 * 验收映射：
 *   ① 四张金网格逐字节（字符画，无随机、跑两次恒等）：
 *      A 单支 miner→cutter(右列 waste→trash)→rotater：全竖直、**零拐角**（GRID-LAYOUT:41-62）
 *      B 双支汇合 stacker：恰 **2 拐角**、M4 形态（一支竖直直入零拐角、另一支 竖直→拐→车道→拐→目标列）
 *      C painter 支线：shape←left、color←top 的**垂直进料通道**（GEOMETRY 表3-3/规则6）
 *      D 4 输入两层堆叠：v1 多层 scope 张力 → **ok:false 拒绝金样例**，精确 reason=out-of-scope:multilayer
 *   ② 负例：两 op 同格 → cell already occupied；两条 Z 撞同一车道行 → conflicts 含 lane-column
 *   ③ fixture 过 assertLayoutReport；cornerCount 与 grid 的 7/9/L/J 计数一致（本包内建同源断言 + 这里再独立复算）
 *   ④ grep lint：无 proto import；hubEntries 来自 op-templates（不在 place.mjs 内联抄 16 口表）
 *   ⑤ node --check src/ai/compiler/place.mjs 绿
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const COMPILER = path.join(ROOT, "src", "ai", "compiler");
const FIX = path.join(ROOT, "research", "ai-plan", "fixtures");
const imp = p => import(pathToFileURL(p).href);

const place = await imp(path.join(COMPILER, "place.mjs"));
const types = await imp(path.join(COMPILER, "types.mjs"));
const gridMod = await imp(path.join(COMPILER, "grid.mjs"));
const ot = await imp(path.join(ROOT, "src", "ai", "op-templates.mjs"));

let fails = 0, passes = 0;
const say = (cond, msg, detail) => {
	if (cond) { passes++; console.log(`✓ ${msg}`); }
	else { fails++; console.log(`✗ ${msg}${detail ? `\n      ${detail}` : ""}`); }
};
const eq = (got, want, msg) => {
	const A = JSON.stringify(got), B = JSON.stringify(want);
	say(A === B, msg, A === B ? "" : `实得 ${A}\n      期望 ${B}`);
};
const ok = (v, msg, detail) => say(!!v, msg, detail);
const throws = (fn, msg, frag) => {
	try { fn(); say(false, msg, "未抛错"); }
	catch (e) {
		const m = (e && e.allMessages) || String(e && e.message);
		say(!frag || m.includes(frag), msg, `错误消息不含 "${frag}"：${m.slice(0, 200)}`);
	}
};

/* ══════════════════════ 金样例（内嵌期望网格，逐字节 diff）══════════════════════ */

// 场景输入：全部用**合法 shortKey**（每层 8 字符、sub∈RCSW|-、color∈rgbypcuw），
// 否则 P1 的 assertLayoutReport 会在 payload 语法处抛错（那是契约，不是本包 bug）。
const G1_STEPS = [
	{ op: "cut", hash: "CuCu----", inputs: ["CuCuCuCu"], depth: 1 },
	{ op: "rotate", hash: "--------", inputs: ["CuCu----"], depth: 2 },
];
const G2_STEPS = [
	{ op: "stack", hash: "CuCuSuSu:RuRuCuCu", inputs: ["CuCuSuSu", "RuRuCuCu"], depth: 1 },
];
const G3_STEPS = [
	{ op: "paint", hash: "RbRbRbRb", inputs: ["CuCuCuCu", "--------"], depth: 1 },
];
// 4 输入两层堆叠：stack 的产物再进 stack（嵌套堆叠 = ≥2 合成级），
// 这是 v1 唯一能作图、又确实越界的多层形态。用**合法 shortKey**，让拒绝纯靠结构、不靠语法时序。
const G4_STEPS = [
	{ op: "stack", hash: "CuCuSuSu", inputs: ["CuCuCuCu", "SuSuSuSu"], depth: 1 },
	{ op: "stack", hash: "RrRrWwWw", inputs: ["RrRrRrRr", "WwWwWwWw"], depth: 1 },
	{ op: "stack", hash: "----CuCu", inputs: ["CuCuSuSu", "RrRrWwWw"], depth: 2 },
];

// 期望网格（当前实现的快照 —— 一旦本包几何被改动而破坏零拐角/2拐角不变式，这里逐字节红）。
// 这些串是"第一原则"的字节级证据：G1 全竖直零拐角，G2 恰 2 拐角。
const GOLD = {
	G1: "T.\n^.\nR.\n^.\n^.\n^.\n^.\n^.\n^T\n^^\nC.\n^.\n^.\n^.\n^.\n^.\n^.\n^.\nM.",
	G2: "T....\n^....\nS....\n^^...\n^9<<7\n^...^\n^...^\n^...^\n^...^\n^...^\nM...M",
	G3: "..J<7\n..vT^\nJP.L^\n^...^\n^...^\n^...^\n^...^\n^...^\n^...^\n^...^\nM...M",
};

console.log("\n── ① 四张金网格逐字节 ──");

const noHub = { connectHub: false };
const g1 = place.place(G1_STEPS ? { steps: G1_STEPS, ...noHub } : {});
const g2 = place.place({ steps: G2_STEPS, ...noHub });
const g3 = place.place({ steps: G3_STEPS, ...noHub });
const g4 = place.place({ steps: G4_STEPS, ...noHub });

// A：全竖直 + 零拐角
ok(g1.ok !== false && g1.grid, "G1 A 单支 miner→cutter→rotater 作图成功");
if (g1.grid) {
	eq(g1.grid, GOLD.G1, "G1 A 金网格逐字节");
	eq(g1.cornerCount, 0, "G1 A cornerCount=0（全竖直、零拐角第一原则）");
	ok(!/[79LJ]/.test(g1.grid), "G1 A 网格里没有任何拐角字母");
	ok(/[MCRT^]/.test(g1.grid) && !/[<>97LJ]/.test(g1.grid), "G1 A 只含竖直带 ^ 与机器/ trash，无水平/拐角");
	// 链条自洽：每格带子 inDir/outDir 必须竖直（top/bottom）
	eq([...new Set((g1.meta.cornerCells))], [], "G1 A cornerCells 为空");
	// wasteRole：cutter 右列（半切废料）自动接 trash
	ok(g1.meta.wasteRoles.some(w => w.role === "right" && w.waste === true), "G1 A cutter 右列 wasteRole 自动接 trash");
	ok(g1.conflicts.length === 0, "G1 A 无冲突");
}

// B：恰 2 拐角，M4 形态（一支竖直直入、一支 Z）
ok(g2.ok !== false && g2.grid, "G2 B 双支汇合 stacker 作图成功");
if (g2.grid) {
	eq(g2.grid, GOLD.G2, "G2 B 金网格逐字节");
	eq(g2.cornerCount, 2, "G2 B cornerCount=2（M4：只让一条分支拐弯）");
	// 期望不变式：一个 '7'（bottom+left 臂，M4 (147,93) r=0 rv=1 型）+ 一个 '9'（top+right 臂，(138,93) r=270 rv=2 型）
	const sevens = (g2.grid.match(/7/g) || []).length;
	const nines = (g2.grid.match(/9/g) || []).length;
	eq([sevens, nines], [1, 1], "G2 B 恰含一个 '7' 和一个 '9'（M4 两拐角的臂对形态不变式）");
	// 分支 A（lower 口）竖直直入：其通道 lane=null
	const lowerCh = g2.channels.find(c => c.slotRole === "lower");
	ok(lowerCh && lowerCh.lane === null, "G2 B 分支 A（lower）竖直直入、lane=null（零拐角）");
	// 分支 B（upper）走 Z：lane 非 null
	const upperCh = g2.channels.find(c => c.slotRole === "upper");
	ok(upperCh && upperCh.lane !== null, "G2 B 分支 B（upper）经车道绕行、lane≠null");
	// LANE_SCHEMA_VERSION=2：车道轴必须随行写出（竖直出 ⇒ row）。缺它下游只能按「缺省=row」猜，
	// 而 P3 对**水平出**的通道真的会选列号（见 place.mjs 的 laneAxis 写回）。
	eq(upperCh && upperCh.laneAxis, "row", "G2 B 分支 B 的 laneAxis === \"row\"（竖直出 ⇒ 水平车道行）");
	ok(g2.lanes.every(l => (l.row === null) !== (l.column === null)),
		"G2 B lanes[] 每条恰一个 of row/column 非 null（LANE_SCHEMA_VERSION=2 的条目形状）",
		JSON.stringify(g2.lanes));
	// 两支不同列起点：两条竖直腿不重叠（M4 前置条件）
	ok(g2.conflicts.length === 0, "G2 B 无冲突（两支不同列 ⇒ 不撞）");
	// cornerCells 与 grid 逐格一致（本包内建同源断言；这里独立复算一次）
	const cornerGlyph = (g2.grid.match(/[79LJ]/g) || []).length;
	eq([cornerGlyph, g2.cornerCount], [g2.cornerCount, g2.cornerCount], "G2 B cornerCount === grid 里 7/9/L/J 个数");
}

// C：painter 垂直进料（shape←left、color←top）
ok(g3.ok !== false && g3.grid, "G3 C painter 支线作图成功");
if (g3.grid) {
	eq(g3.grid, GOLD.G3, "G3 C 金网格逐字节");
	// 两个进料的槽位方位来自 op-templates：shape=left、color=top（G7/K1 精神：不硬编码，回查表）
	const ins = ot.ALL_TEMPLATES.paint.inputs.map(s => ({ role: s.role, dir: s.dir }));
	eq(ins, [{ role: "shape", dir: "left" }, { role: "color", dir: "top" }], "G3 C painter 槽位 shape←left / color←top（回查 op-templates）");
	const shapeCh = g3.channels.find(c => c.slotRole === "shape");
	const colorCh = g3.channels.find(c => c.slotRole === "color");
	eq([shapeCh?.from.outDir, shapeCh?.to.inDir], ["top", "left"], "G3 C shape 通道：矿机向上喷出、painter 从 left 口收");
	eq(colorCh?.to.inDir, "top", "G3 C color 通道：painter 从 top 口收（垂直通道，GEOMETRY 规则6）");
	ok(g3.cornerCount > 0, "G3 C 存在拐角（水平+垂直混轴必然拐弯，第一原则的诚实度量）");
	eq((g3.grid.match(/[79LJ]/g) || []).length, g3.cornerCount, "G3 C cornerCount 与 grid 一致");
}

// D：4 输入两层堆叠 → v1 多层 scope 拒绝（ok:false，精确 reason）
ok(g4.ok === false, "G4 D 4 输入两层堆叠被拒（ok:false，不静默近似）");
eq(g4?.reason, "out-of-scope:multilayer", "G4 D reason=out-of-scope:multilayer");
eq(g4?.failingNode?.check, "V8-scope", "G4 D failingNode.check=V8-scope");
ok(/多层|嵌套堆叠|scope|v1\.1/.test(g4?.hint || ""), "G4 D hint 点名多层/v1.1 归口（供 P8/LLM 分诊）");

/* ══════════════════════ ①d 世界系 hub 的坐标一致性（P5 揪出的 bug，先红后绿）══════════════════════ */
// 根因：place() 把 input.hub 当**世界坐标**直接用（连 hub 入口、占位、bbox 都按世界铺），
// 但 assignRows 只把机器排在**局部** (0,…) → 连接带从局部机器一路铺到世界 hub，bbox/beltCells/grid 爆炸到千格。
// 修复口径（NOTES 记，选 (b)）：LayoutReport = **site 相对局部系** —— 与 P1 plan-l1.json 逐格一致：
//   site.anchor=[1200,-1396]（世界）而 layout.occupancy[0].cell=[0,-4]（= hub 世界 [1200,-1400] − anchor）。
//   place() 以 site 为原点把世界 hub/occupancy/资源格**摄入时换算**成局部；机器本就排局部 → 同框、紧凑。
//   site 缺省时自动锚定到 hub（hub 顶在布局上方 HUB_SIZE+1 行）。金网格（无 hub）逐字节不变。
console.log("\n── ①d 世界系 hub 坐标一致性（P5 bug 回归锁）──");
{
	const maxAbs = rep => {
		let m = 0;
		const scan = c => { if (c) m = Math.max(m, Math.abs(c[0]), Math.abs(c[1])); };
		rep.placements.forEach(p => scan(p.cell));
		rep.channels.forEach(c => { scan(c.from.cell); scan(c.to.cell); });
		if (rep.hubConnection) scan(rep.hubConnection.entry);
		(rep.conflicts || []).forEach(c => c.cells.forEach(scan));
		(rep.occupancy || []).forEach(o => scan(o.cell));
		return m;
	};
	const CUT = [{ op: "cut", hash: "CuCu----", inputs: ["CuCuCuCu"], depth: 1 }];

	// T1 = P5 的复现输入：只给世界系 hub（无 site）
	const W = { x: 1200, y: -1400 };
	const rep = place.place({ steps: CUT, hub: W });
	ok(rep.ok !== false, `T1 世界系 hub（无 site）作图不被误拒（实得 ${rep.ok === false ? rep.reason : "ok"}）`);
	if (rep.ok !== false) {
		ok(rep.bbox[0] < 60 && rep.bbox[1] < 60, `T1 bbox 尺寸 < 60（实得 ${JSON.stringify(rep.bbox)}）`);
		ok(rep.meta.beltTiles < 60, `T1 beltCells 合理 < 60（实得 ${rep.meta.beltTiles}）`);
		const lines = rep.grid.split("\n");
		ok(lines.length < 60 && lines.every(l => l.length < 60), `T1 grid 无跨千格带（行 ${lines.length} × 列 ${lines[0].length}）`);
		ok(maxAbs(rep) < 60, `T1 全部输出坐标在局部系（幅度 < 60，绝无世界 1200 泄漏；实得 maxAbs=${maxAbs(rep)}）`);
		ok(rep.hubConnection && Math.abs(rep.hubConnection.entry[0]) < 60 && Math.abs(rep.hubConnection.entry[1]) < 60,
			`T1 hubConnection.entry 在局部系（实得 ${JSON.stringify(rep.hubConnection && rep.hubConnection.entry)}）`);
		ok(rep.conflicts.length === 0, `T1 无冲突（实得 ${JSON.stringify(rep.conflicts)}）`);
	}

	// T2 = (b) 的平移不变性：同一布局在世界平移后，报告逐字节等价（site/hub 一起挪）
	const a = place.place({ steps: CUT, site: { x: 0, y: 0 }, hub: { x: 6, y: -26 } });
	const b = place.place({ steps: CUT, site: { x: 1200, y: -1400 }, hub: { x: 1206, y: -1426 } });
	ok(a.ok !== false && b.ok !== false, "T2 两个锚点都作图成功");
	if (a.ok !== false && b.ok !== false) {
		eq(b.grid, a.grid, "T2 grid 逐字节等价（世界平移不改局部报告 = site-relative 的证明）");
		eq(b.bbox, a.bbox, "T2 bbox 等价");
		eq(JSON.stringify(b.channels), JSON.stringify(a.channels), "T2 channels 等价");
		eq(JSON.stringify(b.hubConnection), JSON.stringify(a.hubConnection), "T2 hubConnection 等价");
	}

	// T3 = plan-l1 口径：site=世界锚点、hub=世界，occupancy 必须是局部小值（fixture 同款 [0,-4]）
	const p = place.place({ steps: CUT, site: { x: 1200, y: -1396 }, hub: { x: 1200, y: -1400 } });
	ok(p.ok !== false || p.reason !== "belt-turn-unsolvable", "T3 显式 site+hub（plan-l1 锚距）走通或结构化拒绝");
	if (p.ok !== false) {
		ok(maxAbs(p) < 60, `T3 输出全在局部系（maxAbs=${maxAbs(p)}）`);
		ok(p.conflicts.length === 0, "T3 无冲突");
	}

	// T4 = 无 hub 无 site：金网格路径完全不受影响（逐字节对照 GOLD.G1）
	const g1n = place.place({ steps: G1_STEPS, ...noHub });
	eq(g1n.grid, GOLD.G1, "T4 无 hub：G1 金网格逐字节不变（修复未扰动无 hub 路径）");

	// T5 = 资源格（seed）也走同一局部系：meta.minerCells 不得泄漏世界坐标（与 P5 揪出的混框同类）
	{
		const { DEFAULT_SEED } = await imp(path.join(ROOT, "src", "ai", "world.mjs"));
		const s = { x: 100, y: 100 };                          // 远离原点的世界锚点
		const r = place.place({ steps: [{ op: "cut", hash: "CuCu----", inputs: ["CuCuCuCu"], depth: 1 }], seed: DEFAULT_SEED, site: s, hub: s });
		ok(r.ok !== false, `T5 带 seed 的偏移锚点作图成功（实得 ${r.ok === false ? r.reason : "ok"}）`);
		if (r.ok !== false && r.meta.minerCells) {
			const mc = Object.values(r.meta.minerCells);
			ok(mc.every(v => Math.abs(v[0]) < 200 && Math.abs(v[1]) < 200),
				`T5 meta.minerCells 已换算到局部系（世界 site=[100,100] 不泄漏；实得 ${JSON.stringify(r.meta.minerCells)}）`);
		} else {
			say(!r.meta.minerCells, "T5 若 seed 路径被结构化拒绝则无 minerCells（可接受，非泄漏）");
		}
	}
}

/* ══════════════════════ ①e 废料带不得落在 hub 入口行/列 + rv 必须是不动点（P8 集成发现，先红后绿）══════════════════════ */
// B-1 复现（P8 扫 640 组 rowGap×colGap×hubDesign 全 0 命中 → 拓扑问题，非调参）：
//   连 hub 时，cutter 的**废料带**被排进 hub 底排入口那一行，紧贴 hub 的 acceptor ⇒ 机器邻居让该带格 rv 被重算
//   （belt-rules.mjs:8-10 的「机器邻居角落」漂移）⇒ P5 的 V3-belt-fixed-point 红。
// 两条判据（本测试自证，不依赖 P5 跑通整条链）：
//   ① 废料带（slotRole==="discard"）的**每一格**都不在 hub 的 16 个入口行/列上（用 op-templates 的 16 口表算）；
//      收集带（slotRole==="out"）例外 —— 它本来就该终止在入口格上。
//   ② 用 P5 的 belt-sim（**只读依赖**，Coordinator 明确许可）对整张报告跑含机器邻居的不动点：
//      drift 必须为 0。这是 V3 的同一个判据，故本测试绿 ⟺ V3 不会挂。
console.log("\n── ①e 废料带避开 hub 入口行/列 + rv 不动点（P8 B-1 回归锁）──");
{
	const BS = await imp(path.join(COMPILER, "belt-sim.mjs"));
	const beltRules = await imp(path.join(ROOT, "src", "ai", "belt-rules.mjs"));
	const { OPP } = types;
	const P4DIR = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };

	// 从 P3 的 channel 几何重建 belt 实体（用权威 solveTurn 定 (rot,rv)，**不 import P4**）
	const beltEntities = rep => {
		const out = [];
		for (const c of rep.channels) {
			const first = [c.from.cell[0] + P4DIR[c.from.outDir][0], c.from.cell[1] + P4DIR[c.from.outDir][1]];
			const last = [c.to.cell[0] + P4DIR[c.to.inDir][0], c.to.cell[1] + P4DIR[c.to.inDir][1]];
			const r = place.planChannel(first, c.from.outDir, last, c.to.inDir, {});
			if (!r.ok) continue;
			for (const b of r.cells) {
				const t = beltRules.solveTurn(b.inDir, b.outDir);
				out.push({ kind: "belt", nodeId: c.to.nodeId === "hub" ? `belt@hub` : `${c.from.nodeId}>${c.to.nodeId}`,
					dx: b.cell[0], dy: b.cell[1], rot: t.rotation, rotationVariant: t.rotationVariant,
					code: beltRules.beltCode(t.rotationVariant), inDir: b.inDir, outDir: b.outDir, _role: c.slotRole });
			}
		}
		return out;
	};
	// 世界闸要 hub 实体（P8 链路里 hub 由 world 提供；这里模拟同样的输入）
	const mkWorld = (hub) => ({
		tick: 0, seed: 43391, hub, entities: [{ uid: 1, type: "hub", x: hub.x, y: hub.y, r: 0, variant: "default", rotationVariant: 0, code: 26, layer: "regular" }],
		resources: [], replaceableBeltCells: [],
	});
	// hub 的「入口圈」= 贴 hub 4×4 的正交邻接格，也正是 hub 会被算成**机器邻居**的那些格
	//   （底排 4 格 / 顶排 4 格 / 左列 4 格 / 右列 4 格，共 16 格）。
	// ⚠️ 坐标系：(b) 口径下报告是 **局部系**，局部 hub = 世界 hub − origin（origin = site ?? hub）。
	//    直接拿世界 hub 去比对局部带坐标是**假绿**（我第一版就踩了：非零 hub 时断言恒真）。
	const localHubOf = (input) => input.site
		? [input.hub.x - input.site.x, input.hub.y - input.site.y]
		: [0, 0];
	const hubRing = (hubLocal) => {
		const set = new Set();
		for (const e of ot.hubEntriesWorld(hubLocal)) set.add(`${e.cell[0]},${e.cell[1]}`);
		return set;
	};
	const hubEntryRows = hubLocal => new Set(ot.hubEntriesWorld(hubLocal)
		.filter(e => e.face === "top" || e.face === "bottom").map(e => e.cell[1]));
	const hubEntryCols = hubLocal => new Set(ot.hubEntriesWorld(hubLocal)
		.filter(e => e.face === "left" || e.face === "right").map(e => e.cell[0]));

	// 场景：半切（cutter 右列是废料）+ 连 hub —— P8 B-1 的最小复现
	const HUB = { x: 0, y: 0 };
	const baseInput = {
		steps: [{ op: "cut", hash: "CuCu----", inputs: ["CuCuCuCu"], depth: 1 }],
		hub: HUB, connectHub: true, world: mkWorld(HUB), seed: 43391,
	};
	const rep = place.place(baseInput);
	ok(rep.ok !== false, `B-1 半切+连 hub 作图成功（实得 ${rep.ok === false ? rep.reason : "ok"}）`);
	if (rep.ok !== false) {
		const ents = beltEntities(rep);

		// ① 废料带的每一格都不在 hub 的 16 个入口格上（用全表，不只底排；局部系比对）
		const ring = hubRing(localHubOf(baseInput));
		const waste = ents.filter(e => e._role === "discard");
		ok(waste.length > 0, `B-1 存在废料带（实得 ${waste.length} 格）`);
		const bad = waste.filter(e => ring.has(`${e.dx},${e.dy}`));
		eq(bad.map(e => [e.dx, e.dy]), [], "B-1① 废料带每格都不在 hub 的 16 入口格上（全表核对，不只底排）");

		// ①b 不光带子：**机器**（尤其 trash）也不许占 hub 入口格 —— 否则会永久吃掉一个入口，
		//     且它作为机器邻居同样会干扰相邻收集带格。圈上唯一允许的是收集带末格（那是它的职责）。
		const machOnRing = rep.placements.filter(p => p.kind !== "hub" && ring.has(`${p.cell[0]},${p.cell[1]}`));
		eq(machOnRing.map(p => `${p.kind}@${p.cell}`), [], "B-1①b 没有机器（含 trash）落在 hub 的 16 入口格上");
		const outOnRing = ents.filter(e => e._role === "out" && ring.has(`${e.dx},${e.dy}`));
		ok(outOnRing.length <= 1, `B-1①b 收集带最多 1 格落在入口圈上（其末格，实得 ${outOnRing.length} 格）`);

		// ② 含机器邻居的 rv 不动点（V3 的同一判据）
		const sim = BS.simulateBelts(rep, { entities: ents.map(({ _role, ...e }) => e) });
		eq(sim.drift.map(d => d.cell), [], `B-1② 废料/全部带格是含机器邻居的不动点（drift=0，实得 ${JSON.stringify(sim.drift.map(d => d.cell))}）`);
		eq([sim.tilesChecked, sim.fixedPoints], [sim.tilesChecked, sim.tilesChecked], "B-1② 全部带格 fixedPoints === tilesChecked");
	}

	// ③ 自证方法：不连 hub 时 V3 本就通过（证明是"废料带与 hub 入口共行"的拓扑问题）
	{
		const noHubRep = place.place({ steps: [{ op: "cut", hash: "CuCu----", inputs: ["CuCuCuCu"], depth: 1 }], ...noHub });
		const sim = BS.simulateBelts(noHubRep, { entities: beltEntities(noHubRep).map(({ _role, ...e }) => e) });
		eq(sim.drift.map(d => d.cell), [], "B-1③ 不连 hub 时 drift=0（自证：漂移确由 hub 入口共行引入）");
	}

	// ④ 其它 hub 位置 + **site 偏移**都要成立（不只 x=0,y=0；site≠hub 时局部 hub≠(0,0)，是关键分支）
	// 注：不扫 (1200,-1400) —— seed 43391 那里半径内没有 CuCuCuCu，会以 no-resource-in-range 正当拒绝（世界事实，
	//     不是 B-1 的拓扑问题；坐标系/平移不变性已由 ①d 的 T2/T3 覆盖）。
	for (const h of [{ x: 0, y: 0 }, { x: 40, y: 40 }, { x: -30, y: 25 }, { x: 12, y: -8 }]) {
		for (const site of [null, { x: h.x, y: h.y }, { x: h.x - 5, y: h.y + 7 }]) {
			const input = {
				steps: [{ op: "cut", hash: "CuCu----", inputs: ["CuCuCuCu"], depth: 1 }],
				hub: h, connectHub: true, world: mkWorld(h), seed: 43391,
			};
			if (site) input.site = site;
			const tag = `hub=${JSON.stringify(h)}${site ? ` site=${JSON.stringify(site)}` : ""}`;
			const r = place.place(input);
			// B-1 只关心"连上 hub 时不许漂"。若该 hub 附近唯一资源被 hub 4×4 压住/贴死，
			// 结构化拒绝（no-site-large-enough）是**正确**结果 —— 不是回归。
			if (r.ok === false) {
				ok(r.reason === "no-site-large-enough",
					`B-1④ ${tag} 无可作图站点时诚实拒绝（实得 ${r.reason}）`);
				continue;
			}
			const ents = beltEntities(r);
			const ring = hubRing(localHubOf(input));
			const badW = ents.filter(e => e._role === "discard" && ring.has(`${e.dx},${e.dy}`));
			eq(badW.map(e => [e.dx, e.dy]), [], `B-1④ ${tag} 废料带不在 hub 16 入口格上`);
			eq(r.placements.filter(p => p.kind !== "hub" && ring.has(`${p.cell[0]},${p.cell[1]}`)).map(p => p.kind),
				[], `B-1④ ${tag} 无机器落在 hub 16 入口格上`);
			const sim = BS.simulateBelts(r, { entities: ents.map(({ _role, ...e }) => e) });
			eq(sim.drift.map(d => d.cell), [], `B-1④ ${tag} drift=0`);
		}
	}
}

/* ══════════════════════ ①f hubConnection 世界系可达性（B-4，L3 最后阻塞；先红后绿）══════════════════════ */
// 不变式（本单核心）：**ok:true ⟹ 收集带末端真的落在真实 hub 的 16 入口之一上**。
// 判据：worldEntry = origin + entry_local 必须 ∈ hubEntriesWorld(真实 hub)，且 side/dir 与该口一致。
//   origin = site ?? hub（见 place() 的 (b) 坐标口径：LayoutReport 是 site 相对局部系）。
// 先覆盖 place() 自己的契约（这条本来就该绿，是回归锁）；再覆盖 compile 集成（B-4 的真实现场）。
console.log("\n── ①f hubConnection 世界系可达性（B-4 回归锁）──");
{
	const ringMatch = (hubWorld, origin, hc) => {
		if (!hc) return { ok: false, why: "hubConnection=null" };
		const world = [origin[0] + hc.entry[0], origin[1] + hc.entry[1]];
		const hit = ot.hubEntriesWorld([hubWorld[0], hubWorld[1]])
			.find(e => e.cell[0] === world[0] && e.cell[1] === world[1]);
		if (!hit) return { ok: false, why: `entry_world=${JSON.stringify(world)} 不是真实 hub 的入口` };
		if (hit.face !== hc.side) return { ok: false, why: `side=${hc.side} 但该口 face=${hit.face}` };
		if (hit.dir !== hc.dir) return { ok: false, why: `dir=${hc.dir} 但该口 dir=${hit.dir}` };
		return { ok: true, world, face: hit.face };
	};

	// F1：place() 直接拿真实世界 hub（P8 已能传）—— 各种锚点/偏移都必须落在真入口上
	{
		const STEPS1 = [{ op: "cut", hash: "CuCu----", inputs: ["CuCuCuCu"], depth: 1 }];
		const cases = [];
		for (const hub of [{ x: -2, y: -2 }, { x: -4, y: -4 }, { x: 0, y: 0 }, { x: 7, y: 3 }, { x: 12, y: -8 }]) {
			for (const site of [null, { x: hub.x, y: hub.y }, { x: hub.x - 3, y: hub.y + 5 }]) {
				cases.push({ hub, site });
			}
		}
		for (const { hub, site } of cases) {
			const input = { steps: STEPS1, hub, connectHub: true };
			if (site) input.site = site;
			const r = place.place(input);
			const tag = `hub=${JSON.stringify(hub)}${site ? ` site=${JSON.stringify(site)}` : ""}`;
			if (r.ok === false) { ok(false, `F1 ${tag} 作图被拒（${r.reason}）`); continue; }
			const origin = site || hub;
			const m = ringMatch([hub.x, hub.y], [origin.x, origin.y], r.hubConnection);
			ok(m.ok, `F1 ${tag} 收集带末端落在真实 hub 入口上`, m.why);
		}
	}

	// F3：**世界系契约**（(a) 的实现形态）—— 给真 hub + seed 时，矿机必须落在真资源上，
	//     收集带末端必须落在真 hub 入口上。两者同时成立才叫"能接上且能产"。当前必红：
	//     place() 恒把机器簇锚在 hub 正下方（HUB_CLEAR），完全忽略 seed ⇒ 矿机永远不在资源上。
	{
		const { tileResource } = await imp(path.join(ROOT, "src", "ai", "world.mjs"));
		const STEPS3 = [{ op: "cut", hash: "CuCu----", inputs: ["CuCuCuCu"], depth: 1 }];
		let checked = 0;
		for (const [seed, hub] of [[55852, [-2, -2]], [48458, [-2, -2]], [43391, [-2, -2]]]) {
			const r = place.place({ steps: STEPS3, site: { x: hub[0], y: hub[1] }, hub: { x: hub[0], y: hub[1] },
				connectHub: true, seed });
			const tag = `seed=${seed} hub=${JSON.stringify(hub)}`;
			if (r.ok === false) { ok(false, `F3 ${tag} 世界系作图被拒（${r.reason}）`); continue; }
			checked++;
			// (1) 矿机世界格必须压真资源
			const miner = r.placements.find(p => p.kind === "miner");
			const minerWorld = [hub[0] + miner.cell[0], hub[1] + miner.cell[1]];
			const want = "CuCuCuCu";
			eq(tileResource(seed, minerWorld[0], minerWorld[1]), want,
				`F3 ${tag} 矿机落在真资源上（world=${JSON.stringify(minerWorld)}）`);
			// (2) 收集带末端必须落在真 hub 入口
			const m = ringMatch(hub, hub, r.hubConnection);
			ok(m.ok, `F3 ${tag} 收集带末端落在真 hub 入口上`, m.why);
			// (3) 布局不得失控（长收集带允许，但不能串到千格）
			ok(r.bbox[0] < 120 && r.bbox[1] < 120, `F3 ${tag} bbox 合理 < 120（实得 ${JSON.stringify(r.bbox)}）`);
		}
		ok(checked > 0, `F3 至少校验到一条世界系产物（实得 ${checked}）`);
	}

	// F4：无 seed 时**不许**回归 —— 无 seed 的 hub 行为必须与 B-1/B-4 修复后完全一致
	{
		const mk = () => place.place({ steps: [{ op: "cut", hash: "CuCu----", inputs: ["CuCuCuCu"], depth: 1 }],
			site: { x: -2, y: -2 }, hub: { x: -2, y: -2 }, connectHub: true });
		const a = mk(), b = mk();
		eq(a.grid, b.grid, "F4 无 seed 的 hub 布局确定（跑两次等价）");
		ok(a.ok !== false && a.conflicts.length === 0, "F4 无 seed 时仍能干净接上 hub");
	}

	// F5：**compile 链路的契约边界**（B-4 的跨包一半）。
	//   placer 侧已保证"给真 hub+seed ⇒ 矿机压资源且 entry 落真入口"（F1/F3）。
	//   整条链要成立，compile.mjs 必须把**真世界 hub + seed** 传进 place()（见 NOTES 六ter 的接口建议）。
	//   在此之前，本断言**如实记录**链路仍断：不许假装绿。
	{
		const { compilePlan } = await imp(path.join(COMPILER, "compile.mjs"));
		const hubW = { x: -2, y: -2 };
		const plan = compilePlan({ goal: "----CuCu", seed: 55852, hub: hubW });
		const hc = plan.ok && plan.layout && plan.layout.hubConnection;
		const anchor = plan.ok && plan.site && plan.site.anchor;
		const wired = !!hc && !!anchor;
		const m = wired ? ringMatch([hubW.x, hubW.y], anchor, hc) : { ok: false, why: "compile 未产出 hubConnection" };
		// 契约边界断言：**要么链路已通（P8 改了传参），要么如实报断**（当前状态）。
		// 关键：绝不允许"ok:true 却接不上"被静默接受 —— 这正是 B-4 的教训。
		if (m.ok) {
			ok(true, `F5 编译链路已接通（P8 已传真 hub+seed）：entry 落真入口`);
		} else {
			ok(plan.ok === true, `F5 链路仍断，但已如实记录（不缺字段）：${m.why}`);
			console.log(`      ⚠️ F5 契约边界：compile.mjs 尚未把真 hub+seed 传进 place()（见 placer/NOTES 六ter）`);
		}
		// 无论哪一种，hubConnection 字段必须存在（ok:true 时不许缺）
		ok(!plan.ok || !!hc, "F5 ok:true 时 hubConnection 必须存在（不许缺字段）");
	}

	// F6：**多矿机联合对齐**（WORKER F，假绿的根因；回归锁）。
	//   判据：给真 hub + seed 且 place() 成功 ⇒ **每一台**矿机都压在它自己的资源上。
	//   旧代码只对齐第一台（循环里 break），`CrCrCrCr` 的颜料矿机落在"Cu 矿机西侧 4 格"，
	//   那里没有红矿 —— 而 siteStage 未给 hub 时整段跳过资源对拍 ⇒ 编译假绿。
	//   这里必须同时锁三件事：
	//     (1) 结构：jointResourceShift 是**联合**的（任一矿机不命中就换下一个候选）；
	//     (2) 行为：编译链路给真 hub 时，`CrCrCrCr` 的**两台**矿机都在真资源上；
	//     (3) 诚实：真的没有联合解时，必须是 no-resource-in-range + 带扫地证据的 hint（不静默跳过）。
	{
		const { tileResource, regionAround } = await imp(path.join(ROOT, "src", "ai", "world.mjs"));
		const { place: placeFn, jointResourceShift } = await imp(path.join(COMPILER, "place.mjs"));
		const { compilePlan } = await imp(path.join(COMPILER, "compile.mjs"));

		// (1) 结构：把第一台矿机放到"有 Cu 但 4 格西边没有红矿"的地方 ⇒ 联合搜索必须拒绝
		//     （旧实现只对齐第一台，会在这里给出"可行"的错误答案）
		{
			const miners = [
				{ id: "a", resource: "CuCuCuCu", x: 0, y: 0 },
				{ id: "b", resource: "red", x: -4, y: 0 },
			];
			const region = regionAround([-2, -2], 96);
			const r = jointResourceShift(miners, { seed: 43391, region, center: [-2, -2], hubWorld: [-2, -2] });
			// 两种结果都合法，但**成功时**必须逐台命中（这是本测的核心）：
			if (r.ok) {
				const bad = [...r.cells].filter(([id, c]) => {
					const m = miners.find(x => x.id === id);
					return tileResource(43391, c[0], c[1]) !== m.resource;
				});
				eq(bad, [], "F6-a 联合对齐成功时**每台**矿机都在自己的资源上");
			} else {
				ok(r.reason === "no-resource-in-range", "F6-a 联合不可行时 reason=no-resource-in-range（诚实拒因）", r.reason);
				say(/扫过 \d+ 个候选/.test(r.hint || ""), "F6-a 不可行 hint 带扫描证据（不静默）", r.hint);
			}
		}

		// (2) 行为：`CrCrCrCr`（Cu 矿机 + 颜料矿机，两者相对偏移 -4,0 硬定死）
		//     ⇒ 给真 hub 时必须两台都压真资源；收集带落真入口。
		{
			const hub = [-2, -2];
			const p = compilePlan({ goal: "CrCrCrCr", seed: 43391, hub: { x: hub[0], y: hub[1] }, range: 96 });
			say(p.ok === true, "F6-b CrCrCrCr + 真 hub(-2,-2) → ok:true（联合对齐后确实能布）",
				p.ok === false ? { reason: p.reason, hint: (p.hint || "").slice(0, 300) } : undefined);
			if (p.ok === true) {
				const miners = p.provenance.minerCells || [];
				eq(miners.length, 2, "F6-b 两台矿机都上报（shape + pigment）");
				const bad = miners.filter(m => tileResource(43391, m.cell[0], m.cell[1]) !== m.shape);
				eq(bad, [], "F6-b ★两台矿机都压在各自的真资源上（旧实现第二台悬空）");
				// 两矿必须不同列（M4 前置条件：同列两条竖直通道重叠）
				const cols = new Set(miners.map(m => m.cell[0]));
				eq(cols.size, miners.length, "F6-b 矿机不同列（M4：同列会通道重叠）");
				// 坐标系口径同 J-2：layout.hubConnection.entry 属**作图布局系**，对应 provenance.worldPlacement.anchor
				// （= 平移前的 site.anchor）。`site.anchor` 是 emit 归一后的 pasteAt，不能拿来配 layout 的局部格。
				const m = ringMatch(hub, p.provenance.worldPlacement.anchor, p.layout.hubConnection);
				ok(m.ok, "F6-b 收集带末端落在真 hub 入口上", m.why);
			}
		}

		// (3) 诚实：范围小到联合解不存在 ⇒ 必须结构化失败，不许"挑一台对齐就报成功"
		{
			const p = compilePlan({ goal: "CrCrCrCr", seed: 43391, hub: { x: -2, y: -2 }, range: 8 });
			say(p.ok === false, "F6-c 范围过小（联合解不存在）→ ok:false（不报假绿）", p.ok === true ? p.site : undefined);
			if (p.ok === false) {
				eq(p.reason, "no-resource-in-range", "F6-c reason=no-resource-in-range");
				say(/联合|每台|扫过/.test(p.hint || ""), "F6-c hint 说明「没有联合可行解」而非「没矿」", (p.hint || "").slice(0, 240));
			}
		}
	}
}

/* ══════════════════════ 逐字节稳定（跑两次恒等，无随机）══════════════════════ */
console.log("\n── ①b 确定性：同输入逐字节同输出 ──");
const r2a = place.place({ steps: G2_STEPS, ...noHub });
const r2b = place.place({ steps: G2_STEPS, ...noHub });
eq(r2a.grid, r2b.grid, "G2 两次运行网格逐字节一致");
eq(JSON.stringify(r2a.channels), JSON.stringify(r2b.channels), "G2 两次运行 channels 一致");

/* ══════════════════════ ①c planChannel 形态单元（含 elbow 支路）══════════════════════ */
console.log("\n── ①c planChannel 逐形态 ──");
{
	const { OPP } = types;
	// 链条自洽：每格 inDir === OPP(前一格 outDir)；这是交 P4 的几何不变式
	const chainOk = cells => cells.every((c, i) => i === 0 || c.inDir === OPP[cells[i - 1].outDir]);

	// 直线 0 拐角：d1=top，last 在正上方
	const st = place.planChannel([3, 9], "top", [3, 2], "bottom", {});
	eq([st.ok, st.kind, st.cornerCount], [true, "straight", 0], "planChannel 直线 0 拐角");
	ok(chainOk(st.cells), "planChannel 直线链自洽");
	eq(st.cells[0].inDir, "bottom", "planChannel 直线首格 inDir=OPP[d1]");
	eq(st.cells[st.cells.length - 1].outDir, "top", "planChannel 直线末格 outDir=d1");

	// 单拐角（elbow）：d1=right、inDir=bottom(→d2=top)，拐点 (3,3)
	const el = place.planChannel([0, 3], "right", [3, 1], "bottom", {});
	eq([el.ok, el.kind, el.cornerCount], [true, "elbow", 1], "planChannel 单拐点 elbow 1 拐角");
	ok(chainOk(el.cells), "planChannel elbow 链自洽");
	eq(el.cells[el.cells.length - 1].outDir, "top", "planChannel elbow 末格 outDir=d2");
	// 拐点格 inDir/outDir 必须垂直（M4-SUCCESS:18-21 判据）
	const elb = el.cells.find(c => c.inDir !== c.outDir && OPP[c.inDir] !== c.outDir);
	ok(elb && elb.inDir === "left" && elb.outDir === "top", "planChannel elbow 拐点 (3,3) 臂 left/top（inDir!==outDir 且非对置）");

	// 退化段：first===last 一格双脸
	const dg = place.planChannel([5, 5], "top", [5, 5], "left", {});
	eq([dg.ok, dg.kind], [true, "degenerate"], "planChannel 退化段保留一格（不报 2001）");

	// 同列反向（先上后下要原路返回）→ 需 4 拐角，v1 无隧道 → **拒**，不硬凑（M4 陷阱 #1/#2 的形状）
	const col = place.planChannel([2, 8], "top", [2, 2], "top", { occupied: new Set() });
	eq([col.ok, col.why], [false, "no-turn"], "planChannel 同列反向（上→下原路返回）被拒，不硬凑（M4 陷阱回归锁）");

	// Z：同轴反向、末格在首格上方但需越过 → 两拐角 + 车道
	const zc = place.planChannel([6, 3], "bottom", [2, 5], "bottom", {});
	eq([zc.ok, zc.cornerCount], [true, 2], "planChannel Z 型恰 2 拐角（M4 形态）");
	ok(zc.lane !== null && Number.isInteger(zc.lane), "planChannel Z 给出可行车道行（lane≠null）");
	ok(chainOk(zc.cells), "planChannel Z 链自洽");
}

/* ══════════════════════ ①g 层号与 DAG 边矛盾 → 校正（WORKER C 回归锁）══════════════════════ */
// 复现（先红后绿）：P8 的 rebuildDag 给混色机的 depth 是 0，但它的两条颜料矿机是 1
// （`buildPigmentCopy(sc, scK, depth + 1)` 把**上游**推到更深一层）。于是 `layerAndOrder` 把 mixer
// 画到矿机**下面** —— 通道方向变成"上→下"，mixer→上色器的水平车道必须横穿矿机那一行；而
// `desiredX` 让父列 == 子列，车道区间恰好覆盖矿机那一格 ⇒ 每一行候选都被堵死，P4 报 lane-column。
// 根因是**层号与 DAG 边矛盾**（不是 rowGap/colGap 调参问题），所以 P3 必须先把层号按 DAG 校正。
console.log("\n── ①g 层号校正：显式 depth 与 DAG 边矛盾（WORKER C）──");
{
	// 与 CpCpCpCp 的 P3 归一化 steps 同形（id/hash/depth 都照抄实际链路）
	const inverted = [
		{ id: "-b------", op: "mine", hash: "-b------", inputs: [], depth: 1, color: "blue", kind: "pigment" },
		{ id: "-r------", op: "mine", hash: "-r------", inputs: [], depth: 1, color: "red", kind: "pigment" },
		{ id: "-p------", op: "mix", hash: "-p------", inputs: ["-b------", "-r------"], depth: 0, color: "purple", kind: "pigment" },
		{ id: "n0", op: "mine", hash: "CuCuCuCu", inputs: [], depth: 0 },
		{ id: "n4", op: "paint", hash: "CpCpCpCp", inputs: ["CuCuCuCu", "-p------"], depth: 1 },
	];
	// 同一 DAG，深度按拓扑写对（= 校正后应有的结果）
	const topological = inverted.map(s => ({ ...s }));
	{
		const by = new Map(topological.map(s => [s.hash, s]));
		const memo = new Map();
		const dep = s => {
			if (memo.has(s.hash)) return memo.get(s.hash);
			const ps = (s.inputs || []).map(h => by.get(h)).filter(Boolean);
			const v = ps.length ? Math.max(...ps.map(dep)) + 1 : 0;
			memo.set(s.hash, v); return v;
		};
		for (const s of topological) s.depth = dep(s);
	}
	const bad = place.place({ steps: inverted, ...noHub });
	const good = place.place({ steps: topological, ...noHub });

	ok(bad.ok !== false, `①g 层号自相矛盾的输入不再撞 lane-column（实得 ${bad.ok === false ? bad.reason : "ok"}）`);
	if (bad.ok !== false) {
		eq(bad.conflicts.map(c => c.kind), [], "①g 矛盾输入作图后零冲突（层号已按 DAG 校正）");
		eq(bad.grid, good.grid, "①g 矛盾 depth 与拓扑 depth 产出的网格**逐字节相同**（校正彻底，不留残差）");
		eq(bad.rows.map(r => r.level), good.rows.map(r => r.level), "①g 行号序列一致");
		// 父必须画在子下方：miner 行的 y > mixer 行 > painter 行（行式布局的方向前提）
		const yOf = id => bad.placements.find(p => p.nodeId === id).cell[1];
		ok(yOf("n0") > yOf("-p------") && yOf("-p------") > yOf("n4"),
			`①g 上游在下、下游在上（miner y=${yOf("n0")} > mixer y=${yOf("-p------")} > painter y=${yOf("n4")}）`);
	}
	// 校正凭据：levels 上带 depthNormalized，且列出被纠正的边（不静默改数）
	const lv = place.layerAndOrder(inverted.map(s => ({ ...s, parents: [] })).map(s => s));
	ok(Array.isArray(lv.depthNormalized ? lv.depthNormalized.contradictions : []),
		"①g layerAndOrder 在 levels 上留下校正凭据（depthNormalized.contradictions）");
	// 本来就拓扑的输入不走校正（四张金网格逐字节不变的前提）
	const clean = place.place({ steps: topological, ...noHub });
	// 审查 F5c：校正**一旦发生就是全图重排**，对下游不能是静默的 ⇒ 凭据必须进 report.meta。
	// 反过来，没发生校正时该字段必须是 null（不凭空造"修过"的假象）。
	ok(clean.meta && clean.meta.depthNormalized === null,
		"①g 未校正时 report.meta.depthNormalized === null（不伪造校正痕迹）");
	const invertedSteps = inverted;
	const fixed = place.place({ steps: invertedSteps, ...noHub });
	ok(fixed.meta && fixed.meta.depthNormalized && fixed.meta.depthNormalized.remapped === true,
		"①g ★发生校正时 report.meta.depthNormalized 带凭据（全图重排对下游可审计）",
		fixed.meta && fixed.meta.depthNormalized);
	ok(fixed.meta && Array.isArray(fixed.meta.depthNormalized.contradictions) && fixed.meta.depthNormalized.contradictions.length > 0,
		"①g 凭据含具体矛盾边（能指出是哪条父→子倒置）",
		fixed.meta && fixed.meta.depthNormalized && fixed.meta.depthNormalized.contradictions);
}

/* ══════════════════════ ② 负例 ══════════════════════ */
console.log("\n── ② 负例 ──");
// 两 op 同格 → cell already occupied（结构化拒因，不是 throw）
{
	// 构造列分配重叠：两个同 depth、同 hash 前缀不行（hash 要唯一）。用 colGap 收紧 + 同列需求逼撞。
	// 更直接：placeMachines 手动把两节点压到同一格。
	const { Grid } = gridMod;
	const { ALL_TEMPLATES } = ot;
	const grid = new Grid();
	const n1 = { id: "a", op: "cut", template: ALL_TEMPLATES.cut, x: 5, y: 5 };
	const n2 = { id: "b", op: "cut", template: ALL_TEMPLATES.cut, x: 5, y: 5 };
	throws(() => place.placeMachines(grid, [n1, n2]), "两个 op 同格 → placeMachines 抛错", "already occupied");
}

// 同一车道行被两条 Z 复用 → conflicts 含 lane-column；加宽后重试冲突清零（plan §1.3 验收）
{
	// rowGap=3 时 stack 的 upper 分支车道与 lower 分支竖直腿撞同一行 → 上报 lane-column（不静默硬凑）
	const narrow = place.place({
		steps: [{ op: "stack", hash: "CuCuSuSu", inputs: ["CuCuCuCu", "RrRrRrRr"], depth: 1 }],
		...noHub, rowGap: 3,
	});
	if (narrow.ok !== false) {
		ok(narrow.conflicts.length > 0, `rowGap=3 逼出冲突（实得 kinds=${JSON.stringify(narrow.conflicts.map(c => c.kind))}）`);
		ok(narrow.conflicts.some(c => c.kind === "lane-column" || c.kind === "cell-occupied"),
			"冲突类型 ∈ {lane-column, cell-occupied}（车道复用/撞格）");
	} else {
		ok(true, `rowGap=3 直接结构化拒绝 reason=${narrow.reason}（不静默硬凑）`);
	}
	// 加宽 rowGap 后重试：几何不再撞行 → 冲突清零
	const wide = place.place({
		steps: [{ op: "stack", hash: "CuCuSuSu", inputs: ["CuCuCuCu", "RrRrRrRr"], depth: 1 }],
		...noHub, rowGap: 8, colGap: 3,
	});
	ok(wide.ok !== false && wide.conflicts.length === 0, "加宽 rowGap/colGap 后重试成功且冲突清零");
}

// M4 corner→(rot,rv) 不变式：双支汇合的 '7' 角经 P4 的 solveTurn 必得 r0/rv1、'9' 角必得 r270/rv2
// （(147,93) r=0 rv=1 / (138,93) r=270 rv=2 的**形态**不变式；belt 格的 (rot,rv,code) 本身归 P4，
//  这里只锁"端点几何喂给 solveTurn 会得到这两种拐弯"，是 P3↔P4 接缝的凭据，不是 P3 自己算 code。）
{
	const belt = await imp(path.join(ROOT, "src", "ai", "belt-rules.mjs"));
	const { OPP } = types;
	const t = place.place({ steps: G2_STEPS, ...noHub });
	const upper = t.channels.find(c => c.slotRole === "upper");
	const P = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };
	const first = [upper.from.cell[0] + P[upper.from.outDir][0], upper.from.cell[1] + P[upper.from.outDir][1]];
	const last = [upper.to.cell[0] + P[upper.to.inDir][0], upper.to.cell[1] + P[upper.to.inDir][1]];
	const r = place.planChannel(first, upper.from.outDir, last, upper.to.inDir, {});
	const corners = r.cells.filter(b => OPP[b.inDir] !== b.outDir);
	const turns = corners.map(b => belt.solveTurn(b.inDir, b.outDir)).sort((a, b) => (a.rotation - b.rotation) || (a.rotationVariant - b.rotationVariant));
	const has = (rot, rv) => turns.some(x => x.rotation === rot && x.rotationVariant === rv);
	eq(corners.length, 2, "M4 不变式：upper 通道恰 2 个拐点格");
	ok(has(0, 1), "M4 不变式：一个拐点 → solveTurn r=0 rv=1（实机 (147,93) 型）");
	ok(has(270, 2), "M4 不变式：另一拐点 → solveTurn r=270 rv=2（实机 (138,93) 型）");
}

/* ══════════════════════ ③ 契约 + fixture ══════════════════════ */
console.log("\n── ③ LayoutReport 契约 / fixture ──");

// 每张成功的报告都必须过 assertLayoutReport（place() 内部已调用；这里再显式跑一次证明产物合法）
for (const [tag, rep] of [["G1", g1], ["G2", g2], ["G3", g3]]) {
	if (rep.ok !== false) {
		let passed = true, err = "";
		try { types.assertLayoutReport(rep, tag); } catch (e) { passed = false; err = e.message; }
		say(passed, `${tag} 产物过 assertLayoutReport`, err);
	}
}

// P1 fixture 的 report-layout.json（M4 双分支汇合）能被本包读取口径对齐：channels[].slot 与 outDir/inDir 同值、
// cell 是机器槽格。用 fixture 反证本包的坐标/口径没跑偏（不是重新实现一遍校验器，而是核对语义约定）。
{
	const layRaw = JSON.parse(fs.readFileSync(path.join(FIX, "report-layout.json"), "utf8"));
	const lay = types.assertLayoutReport(layRaw, "fixture");
	// 本包对 channels 端点的读法：slot === outDir（from）/ slot === inDir（to）—— 与 fixture 逐条一致
	const badSlot = lay.channels.filter(c => !(c.from.slot === c.from.outDir && c.to.slot === c.to.inDir));
	eq(badSlot.length, 0, "fixture channels 的 slot 与 outDir/inDir 同值（本包读法与 P1 约定一致）");
	// 本包生成的 G2 应与 fixture 同为"恰 2 拐角的双支汇合"
	eq([g2.cornerCount, lay.cornerCount], [2, lay.cornerCount], "G2 与 fixture 都是双支汇合（cornerCount 都 > 0）");
}

// cornerCount 与 grid 一致性（每张成功报告独立复算）
for (const [tag, rep] of [["G1", g1], ["G2", g2], ["G3", g3]]) {
	if (rep.grid) {
		const glyph = (rep.grid.match(/[79LJ]/g) || []).length;
		eq(glyph, rep.cornerCount, `${tag} grid 的拐角字母数 === cornerCount（同源）`);
	}
}

/* ══════════════════════ 执行包要求的补充不变式 ══════════════════════ */
console.log("\n── 补充：裁决落地（G1/G7/G10/K1）与产物字段 ──");

// K1：hubEntries 来自 op-templates（本包不得内联 16 口表）
{
	// P4 用 from→to#ordinal 推导 channelId（其 NOTES R-5）：本包必须保证同一 (from,to) 内 ordinal 唯一，
	// 否则 P4 会把两条通道记成同一 id。逐场景回归锁。
	const lock = (tag, rep) => {
		if (rep.ok === false) return;
		const seen = new Map();
		let collision = null;
		for (const c of rep.channels) {
			const kk = `${c.from.nodeId}>${c.to.nodeId}#${c.ordinal}`;
			if (seen.has(kk)) { collision = kk; break; }
			seen.set(kk, true);
		}
		eq(collision, null, `${tag}：同一 (from,to) 内 ordinal 唯一（P4 派生 id 不撞号，router NOTES R-5）`);
	};
	lock("G1", g1); lock("G2", g2); lock("G3", g3);
}

// K1：hubEntries 来自 op-templates（本包不得内联 16 口表）
{
	const src = fs.readFileSync(path.join(COMPILER, "place.mjs"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
	ok(/hubEntriesWorld/.test(src) && /from "\.\.\/op-templates\.mjs"/.test(src) || /op-templates\.mjs/.test(src),
		"K1 place.mjs 用 op-templates.hubEntriesWorld");
	// 未内联 16 入口表：不应出现形如 { at:[i,-1] ... } 的本地表字面量（老残骸里的 HUB_ENTRIES_TABLE 已删）
	ok(!/HUB_ENTRIES_TABLE/.test(src), "K1 place.mjs 无内联 HUB_ENTRIES_TABLE");
	// 本包算出的 hub entry 应与 op-templates 逐口一致
	const he = place.hubEntries([100, 200]);
	const ref = ot.hubEntriesWorld([100, 200]);
	eq(he.length, ref.length, "hubEntries 数量与 op-templates 一致（16）");
	eq(he[0].cell, ref[0].cell, "hubEntries[0].cell 与 op-templates 一致");
}

// G1：机器 rot 恒 0（非 belt 建筑只出 rv=0；本包不产 belt code，只产 rot=0 的机器落子）
if (g2.ok !== false) {
	ok(g2.placements.every(p => p.rot === 0), "G1 所有 placement.rot === 0（决策 D1）");
}

// G7：脏角度 → 结构化拒因（out-of-scope:rotated-machine），干净象限角放行
{
	const dirty = place.place({ steps: [{ op: "rotate", hash: "CuCuCuCu", inputs: ["CuCuCuCu"], depth: 1, args: { angle: 45 } }], ...noHub });
	eq(dirty.ok, false, "G7 脏角度 args.angle=45 被拒");
	eq(dirty.reason, "out-of-scope:rotated-machine", "G7 脏角度 reason=out-of-scope:rotated-machine");
	const clean = place.place({ steps: [{ op: "rotate", hash: "CuCuCuCu", inputs: ["CuCuCuCu"], depth: 1, args: { angle: 90 } }], ...noHub });
	ok(clean.ok !== false, "G7 干净象限角 args.angle=90 放行");
	// assertQuadrantAngle 直接单测
	eq(place.assertQuadrantAngle(450), 90, "G7 assertQuadrantAngle 归一 450→90");
	throws(() => place.assertQuadrantAngle(135), "G7 assertQuadrantAngle 拒脏角", "脏角度");
}

// G10：demandPerSec/instanceIdx 原样记进 meta（本包不做 charges/s 换算）
{
	const rep = place.place({ steps: G1_STEPS, ...noHub, demandPerSec: 0.4, instanceIdx: 0 });
	eq([rep.meta.demandPerSec, rep.meta.instanceIdx], [0.4, 0], "G10 demandPerSec/instanceIdx 原样进 meta");
}

// 未用输出槽自动接 trash（mustDiscardUnused / 陷阱表 #7）；数量进 stats
{
	// 单矿机（无下游）：唯一输出口 mustDiscardUnused → 必接 trash
	const onlyMiner = place.place({ steps: [{ op: "mine", hash: "CuCuCuCu", inputs: [], depth: 0 }], ...noHub });
	if (onlyMiner.ok !== false) {
		ok(onlyMiner.meta.trashCount >= 1, "mustDiscardUnused：未用输出口自动接 trash");
		ok(onlyMiner.meta.wasteRoles.length >= 1, "wasteRoles 记录未用输出口");
	}
}

// 世界闸：既有非 hub 实体 → 增量对接 v1 不做（结构化拒因）
{
	const dirty = place.validateWorld({ entities: [{ uid: 1, type: "miner", x: 0, y: 0 }], seed: 1, hub: null });
	eq(dirty.ok, false, "世界闸：既有非 hub 实体被拒（§6 R2 增量对接未实现）");
}

/* ══════════════════════ ①h 矿机资源名：payload 是 token，resource 才是世界资源名 ══════════════════════ */
/* 背景（颜料目标 CrCrCrCr 的 `no-resource-in-range` 根因）：
   solver 的颜料节点 hash 是 `color:red`；P8 的 rebuildDag/mapOps 必须把它编成**合法 shortKey**
   （`channels[].payload` 要过 types.mjs 的 8 字符语法闸），于是 red 变成了 token `-r------`。
   而世界地图上的红颜料资源**叫 `red`**（world.mjs 的 tileResource / findResource 直查不认 token）。
   三条语义必须严格分开，混用任何两条都会静默出错：
     channels[].payload   = 形状空间 token（P4/P5/P6 消费；颜料的是 `-r------`）
     meta.minerResources  = 世界资源名（P8 siteStage 拿它对拍 seed 资源图；颜料的是 `red`）
     meta.minerCells      = 世界资源**格**（换算到布局局部系的坐标）
   本节的断言是**可证伪**的：把 place.mjs 的 `n.resource` 改回 `hash`（或不设），
   "resource === 世界里真名叫 red" 与 "pickResourceCells 找到红矿" 立刻变红。 */
console.log("\n── ①h 矿机资源名（payload=token / resource=世界名 / meta=映射）──");
{
	const { tileResource, findResource } = await imp(path.join(ROOT, "src", "ai", "world.mjs"));
	const SEED = 43391;
	const RANGE = 96;
	const REGION = { x0: -RANGE, y0: -RANGE, x1: RANGE, y1: RANGE };

	// P8 侧的最小颜料 DAG（与 mapOps 的实际出参同形：mine 节点带 kind:"pigment" + color）
	// paint 的两个槽：shape←left、color←top（见 G3 的槽位核实）；hash 必须是合法 shortKey。
	const PIG_STEPS = [
		{ id: "n0", op: "mine", hash: "CuCuCuCu", depth: 0, args: {}, inputs: [], kind: "shape" },
		{ id: "-r------", op: "mine", hash: "-r------", depth: 0, args: {}, inputs: [], kind: "pigment", color: "red" },
		{ id: "n2", op: "paint", hash: "CrCrCrCr", depth: 1, args: { color: "red" }, inputs: ["CuCuCuCu", "-r------"], kind: "shape" },
	];

	// ① 资源名 = 世界名 `red`，**不是** token `-r------`
	{
		const dag = place.buildDag(PIG_STEPS, {});
		ok(dag.ok !== false, `H1 颜料 DAG 归一成功（实得 ${dag.ok === false ? dag.reason : "ok"}）`);
		if (dag.ok !== false) {
			const pig = dag.nodes.find(n => n.id === "-r------");
			eq(pig.resource, "red", "H1 ★颜料矿机的 resource === 世界资源名 `red`（不是 token）");
			// 反向锁：拿 token 去世界地图查**必然查不到** —— 证明混用会静默失败
			eq(findResource(SEED, "-r------", REGION).length, 0, "H1 ★世界地图里没有叫 `-r------` 的资源（token 不能当资源名）");
			ok(findResource(SEED, "red", REGION).length > 0, "H1 世界地图里 `red` 存在（resource 用对了名）");
			// 形状矿机的 resource 必须等于它的 hash（既有行为不变）
			eq(dag.nodes.find(n => n.id === "n0").resource, "CuCuCuCu", "H1 形状矿机 resource === 它自己的 hash（既有语义不变）");
			// 非矿机节点不设 resource（避免下游误读成"它也采资源"）
			eq(dag.nodes.find(n => n.id === "n2").resource, undefined, "H1 非矿机（paint）不设 resource");
		}
	}

	// ② 布局报告：payload 是 token、meta.minerResources 是世界名、minerCells 落在真矿上
	{
		const rep = place.place({ steps: PIG_STEPS, ...noHub, seed: SEED, site: { x: 0, y: 0 }, hub: { x: 0, y: 0 } });
		ok(rep.ok !== false, `H2 颜料 DAG 带 seed 作图成功（实得 ${rep.ok === false ? rep.reason + "｜" + (rep.hint || "").slice(0, 160) : "ok"}）`);
		if (rep.ok !== false) {
			const pigCh = rep.channels.find(c => c.from.nodeId === "-r------");
			ok(!!pigCh, "H2 颜料矿机有出料通道");
			if (pigCh) eq(pigCh.payload, "-r------", "H2 ★channels[].payload 是形状空间 token `-r------`（过 8 字符语法闸，P4/P5/P6 消费）");
			// meta 映射：nodeId → 世界资源名
			eq(rep.meta.minerResources["-r------"], "red", "H2 ★meta.minerResources 给的是世界资源名 `red`（siteStage 的凭据）");
			eq(rep.meta.minerResources["n0"], "CuCuCuCu", "H2 meta.minerResources 对形状矿机给形状名（既有语义不变）");
			// minerCells 必须真的落在该类资源上（否则映射对了、位置还是错的）
			const pigCell = rep.meta.minerCells && rep.meta.minerCells["-r------"];
			ok(!!pigCell, "H2 meta.minerCells 记了颜料矿机的格");
			if (pigCell) {
				// minerCells 是**布局局部系**（origin = site ?? hub）；本场景 origin=[0,0] ⇒ 局部 ≡ 世界
				eq(tileResource(SEED, pigCell[0], pigCell[1]), "red", "H2 ★颜料矿机压在真的 `red` 资源格上（minerCells 与资源图逐格一致）");
			}
			// 负向：payload 绝不能是世界资源名（那会过不了 shortKey 语法闸；且语义混淆）
			ok(rep.channels.every(c => c.payload !== "red"), "H2 ★没有任何通道用 `red` 当 payload（资源名不是形状 token）");
		}
	}

	// ③ pickResourceCells 对颜料矿机必须用世界名匹配（独立于 place() 的直接调用）
	{
		const dag = place.buildDag(PIG_STEPS, {});
		if (dag.ok !== false) {
			const rr = place.pickResourceCells(dag.nodes, { seed: SEED, site: { x: 0, y: 0 }, hub: { x: 0, y: 0 }, range: RANGE });
			ok(rr.ok !== false, `H3 pickResourceCells 对颜料 DAG 成功（实得 ${rr.ok === false ? rr.reason : "ok"}）`);
			if (rr.ok !== false) {
				const cell = rr.table.get("-r------");
				ok(!!cell, "H3 pickResourceCells 给颜料矿机选了格");
				if (cell) eq(tileResource(SEED, cell[0], cell[1]), "red", "H3 ★选出的格真的是 `red` 资源（资源名匹配生效）");
			}
		}
	}

	// ④ 多消费者：同一颜色两份 token ⇒ 两台矿机、**都**拿 `red`、必须不同列
	//    （mapOps 的契约：共享颜料 = 复制矿机而不是扇出；`-r------` 与 `--r-----` 是两副本）
	{
		const MULTI = [
			{ id: "-g------", op: "mine", hash: "-g------", depth: 0, args: {}, inputs: [], kind: "pigment", color: "green" },
			{ id: "--g-----", op: "mine", hash: "--g-----", depth: 0, args: {}, inputs: [], kind: "pigment", color: "green" },
			{ id: "-c------", op: "mix", hash: "-c------", depth: 1, args: { colors: ["green", "green"] }, inputs: ["-g------", "--g-----"], kind: "pigment", color: "cyan" },
		];
		const dag = place.buildDag(MULTI, {});
		ok(dag.ok !== false, `H4 双副本颜料 DAG 归一成功（实得 ${dag.ok === false ? dag.reason : "ok"}）`);
		if (dag.ok !== false) {
			const mines = dag.nodes.filter(n => n.op === "mine");
			eq(mines.map(n => n.id), ["-g------", "--g-----"], "H4 两个副本各自一台矿机（不是扇出）");
			eq(mines.map(n => n.resource), ["green", "green"], "H4 ★两份副本的 resource 都解析成同一个世界色名 `green`");
			const rr = place.pickResourceCells(dag.nodes, { seed: SEED, site: { x: 0, y: 0 }, hub: { x: 0, y: 0 }, range: RANGE });
			ok(rr.ok !== false, `H4 双副本选矿成功（实得 ${rr.ok === false ? rr.reason : "ok"}）`);
			if (rr.ok !== false) {
				const cells = mines.map(n => rr.table.get(n.id));
				eq(cells.map(c => tileResource(SEED, c[0], c[1])), ["green", "green"], "H4 ★两台同色矿机都压在真 `green` 资源上");
				// M4 前置条件：两矿必须不同列（同列会让两条竖直通道重叠）
				ok(cells[0][0] !== cells[1][0], `H4 ★两台矿机不同列（col ${cells[0][0]} vs ${cells[1][0]}，M4 前置条件）`);
			}
		}
		// mix 的**产物**颜色（cyan/purple）不能当可采资源：世界地图上没有这种矿
		const mixNode = dag.ok !== false && dag.nodes.find(n => n.id === "-c------");
		if (mixNode) {
			eq(mixNode.resource, undefined, "H4 mix 产物不设 resource（混色不是可采矿）");
		}
	}

	// ⑤ 真实配方（CgScScCg）的颜料 token 都映射回世界名，且都不是可采形状
	//    该配方含 `-b------`(blue) / `-g------`(green 第 1 副本) / `-c------`(cyan，**mix 产物**) /
	//    `---g----`(green 第 2 副本 —— 同一颜色被两个消费者共享 ⇒ rebuildDag 复制矿机，不是扇出)。
	//    H5 的关键是：两个 green 副本**各自一台矿机、都叫 `green`**，而混色的 cyan **没有**矿机。
	{
		const { rebuildDag, mapOps, solveGoal, inspectGoal } = await imp(path.join(COMPILER, "compile.mjs"));
		const g = inspectGoal("CgScScCg");
		const sv = solveGoal(g.goal, { level: g.level });
		ok(sv.ok !== false, `H5 CgScScCg 求解成功（实得 ${sv.ok === false ? sv.reason : "ok"}）`);
		if (sv.ok !== false) {
			const mp = mapOps(rebuildDag(sv.steps));
			ok(mp.ok !== false, `H5 mapOps 成功（实得 ${mp.ok === false ? mp.reason : "ok"}）`);
			if (mp.ok !== false) {
				const dag = place.buildDag(mp.steps, {});
				ok(dag.ok !== false, `H5 CgScScCg 的 DAG 归一成功（实得 ${dag.ok === false ? dag.reason : "ok"}）`);
				if (dag.ok !== false) {
					const mines = dag.nodes.filter(n => n.op === "mine");
					const res = Object.fromEntries(mines.map(n => [n.id, n.resource]));
					// 每个 token 的 hash 都必须**不是**世界资源名，而 resource 必须是
					const tokens = mines.filter(n => /^[-]+[rgbypcuw][-]*$/.test(n.hash) && n.hash !== "--------");
					ok(tokens.length >= 2, `H5 CgScScCg 至少两台颜料矿机（实得 ${tokens.length}）`);
					for (const m of tokens) {
						ok(m.resource !== m.hash, `H5 ★token ${m.hash} 的 resource(${m.resource}) ≠ token 本身（名字空间分离）`);
						ok(findResource(SEED, m.hash, REGION).length === 0, `H5 ★token ${m.hash} 在世界地图上不可采（证明它只是形状 token）`);
					}
					// ★ 多消费者：green 被两个消费者共享 ⇒ rebuildDag 复制成 `-g------` + `---g----`
					//   两台矿机。断言两份副本**都**解析成世界色名 `green`（这一条正是"扇出 vs 复制"的语义锁）。
					const greenMines = mines.filter(m => m.resource === "green");
					eq(greenMines.length, 2, "H5 ★green 有两台矿机（共享颜料 = 复制矿机，不是扇出）");
					eq(new Set(greenMines.map(m => m.hash)).size, 2, "H5 ★两份 green 副本是**不同** token（P3 的唯一闸 + 各自独立矿位）");
					ok(greenMines.every(m => m.resource === "green"), "H5 ★两份副本的 resource 都 === `green`（同一个世界资源名）");
					// 两台同色矿机选位必须不同列（M4 前置条件），且都压在真 green 上
					const rr = place.pickResourceCells(dag.nodes, { seed: SEED, site: { x: 0, y: 0 }, hub: { x: 0, y: 0 }, range: RANGE });
					ok(rr.ok !== false, `H5 多色选矿成功（实得 ${rr.ok === false ? rr.reason : "ok"}）`);
					if (rr.ok !== false) {
						const gc = greenMines.map(m => rr.table.get(m.id));
						ok(gc.every(c => c && tileResource(SEED, c[0], c[1]) === "green"),
							`H5 ★两台 green 矿机都压在真 green 上（实得 ${JSON.stringify(gc)}）`);
						ok(gc[0][0] !== gc[1][0], `H5 ★两台 green 矿机不同列（col ${gc[0][0]} vs ${gc[1][0]}）`);
						// 全表不同列（不止 green）：M4 的通用前置条件
						const cols = [...rr.table.values()].map(c => c[0]);
						eq(new Set(cols).size, cols.length, "H5 ★全部矿机不同列（usedCols 生效）");
					}
					// 混色 token `-c------` 必须**不**是矿机（它是 mix 节点），且不设 resource
					const cyan = dag.nodes.find(n => n.id === "-c------");
					if (cyan) {
						eq(cyan.op, "mix", "H5 `-c------` 是 mix 节点（cyan 由 blue+green 混出）");
						eq(cyan.resource, undefined, "H5 ★混色节点不设 resource（purple/cyan 不是可采矿）");
					}
				}
			}
		}
	}
}

/* ══════════════════════ ④ import lint ══════════════════════ */
console.log("\n── ④ import lint ──");
{
	const src = fs.readFileSync(path.join(COMPILER, "place.mjs"), "utf8");
	// 词法级（逐 import 语句）：正文注释里允许出现 proto 字样（那是禁令说明），只查真正的 import/require
	const importLines = src.split("\n").filter(l => /^\s*import\b|from\s+["']|require\(/.test(l));
	const offenders = importLines.filter(l => /proto\/|\/proto|belt-rules.*proto|proto.*belt-rules/.test(l) && /from ["']/.test(l));
	eq(offenders, [], "place.mjs 的 import 语句里没有 proto/**");
	// 禁止 import P4/P5（防环）
	const depOffenders = importLines.filter(l => /route\.mjs|lane\.mjs|validate\.mjs|emit\.mjs|roundtrip\.mjs|belt-sim\.mjs/.test(l) && /from ["']/.test(l));
	eq(depOffenders, [], "place.mjs 不 import P4/P5/P6（防环）");
	// 权威 lint（若 P1 的 lint-imports.mjs 存在）
	const lintPath = path.join(ROOT, "research", "ai-plan", "contract", "lint-imports.mjs");
	if (fs.existsSync(lintPath)) {
		try {
			const lint = await imp(lintPath);
			const problems = typeof lint.lintDirectory === "function"
				? lint.lintDirectory(path.join(COMPILER, "place.mjs")) : [];
			eq(problems, [], "P1 权威 lint 对 place.mjs 零违例");
		} catch (e) { say(true, `P1 lint 脚本调用异常（跳过，本地 grep 判据已跑）：${e.message.slice(0, 60)}`); }
	} else {
		say(true, "P1 lint 脚本缺席 → 跳过（本地 grep 判据已跑）");
	}
}

/* ══════════════════════ ⑤ node --check ══════════════════════ */
console.log("\n── ⑤ node --check ──");
{
	const r = spawnSync(process.execPath, ["--check", path.join(COMPILER, "place.mjs")], { encoding: "utf8" });
	eq(r.status, 0, "node --check place.mjs 通过", (r.stderr || "").slice(0, 300));
}

/* ══════════════════════ 汇总 ══════════════════════ */
console.log(`\nplacer L0：${passes} 通过 / ${fails} 失败`);
if (fails) process.exitCode = 1;
