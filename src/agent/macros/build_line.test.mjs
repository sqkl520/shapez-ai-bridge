/**
 * build_line.test.mjs — 宏 `buildLine` 的离线回归（不碰游戏、不写盘、零网络）。
 *
 * 判据来源：research/ai-plan/DIRECTION-FINAL.md §1.1（编译器降为库，`build_line` 是宏）
 * + A8 任务书（空地 9/12 不退步；`site-not-empty` 与 `no-site-large-enough` 必须分开）。
 *
 * 每条断言都带一个「必须红」的对照，否则测不出判据是在真判断还是恒绿：
 *   A 空地能编          —— 同时断言蓝图/实体非空、anchor 与 hub 在场
 *   B 非空地 ⇒ site-not-empty —— 同时断言 reason **不是** no-site-large-enough（旧 bug 的形态）
 *   C 真没空间 ⇒ 仍是 no-site-large-enough（不能把所有失败都改名叫 site-not-empty）
 *   D 失败时 hint 指向正确的替代方案（connect / insert_machine / 空地）
 *   E 契约：precondition 恒在场；失败对象 blueprint/entities 为 null
 *
 * 用法：node src/agent/macros/build_line.test.mjs
 * 退出码：0 全过 / 1 有失败
 */
import { buildLine, PRECONDITION } from "./build_line.mjs";
import { compilePlan } from "../../ai/compiler/compile.mjs";

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg, detail) {
	if (cond) { pass++; console.log(`✓ ${msg}`); }
	else { fail++; failures.push(msg); console.log(`✗ ${msg}${detail === undefined ? "" : `\n      实得 ${JSON.stringify(detail)}`}`); }
}
const eq = (got, want, msg) => ok(JSON.stringify(got) === JSON.stringify(want), msg, { got, want });

/* 固定参数：与 A8 回归命令一致（--seed 55013 --hub -2,-2 --level 5） */
const SEED = 55013;
const HUB = [-2, -2];
const LEVEL = 5;

/* ══════════════════ A. 空地能编 ══════════════════ */
console.log("\n── A 空地上编译 ──");
{
	const r = buildLine("CuCuCuCu", { hub: HUB, seed: SEED, level: LEVEL });
	eq(r.ok, true, "A1 CuCuCuCu 在空地上 ok:true");
	ok(typeof r.blueprint === "string" && r.blueprint.startsWith("SZBP1."), "A1 产出 SZBP1 蓝图", r.blueprint);
	ok(Array.isArray(r.entities) && r.entities.length > 0, "A1 entities 非空", r.entities && r.entities.length);
	eq(r.anchor, [-8, 1], "A1 anchor 与编译器一致（-8,1 = paste 点）");
	eq(r.hub, HUB, "A1 hub 回填为真实 hub 世界坐标");
	eq(r.precondition, "empty-site", "A1 precondition 恒为 empty-site");
	ok(Array.isArray(r.cells) && r.cells.length === r.entities.length, "A1 cells（世界坐标视图）与 entities 等长", r.cells && r.cells.length);
	// 世界坐标口径自证：world = anchor + [dx,dy]
	const e0 = r.entities[0], c0 = r.cells.find(c => c.kind === e0.kind && c.code === e0.code);
	ok(c0 && c0.x === r.anchor[0] + e0.dx && c0.y === r.anchor[1] + e0.dy, "A1 cells 满足 world = anchor + [dx,dy]", { c0, e0, anchor: r.anchor });
	ok(typeof r.hint === "string" && r.hint.includes("paste"), "A1 成功时 hint 说明 paste 点与 dry_run 前提", r.hint);
}
{
	// 与 CLI 同一组参数：宏的蓝图必须与直接调 compilePlan 逐字节相同（降级不改行为）
	const direct = compilePlan({ goal: "CuCuCuCu", seed: SEED, hub: HUB, level: LEVEL });
	const viaMacro = buildLine("CuCuCuCu", { hub: HUB }, { seed: SEED, level: LEVEL });
	eq(viaMacro.blueprint, direct.blueprint, "A2 宏与直接调 compilePlan 的蓝图逐字节相同（降级不改行为）");
}
{
	// 另一条空地目标：证明不是只对 CuCuCuCu 绿
	const r = buildLine("RuRuRuRu", { hub: HUB, seed: SEED, level: LEVEL });
	eq(r.ok, true, "A3 RuRuRuRu 在空地上同样 ok:true（不是只对单目标绿）");
}

/* ══════════════════ B. 非空地 ⇒ site-not-empty ══════════════════ */
console.log("\n── B 非空地（前置条件不满足）──");
const DIRTY = {
	entities: [
		{ type: "hub", x: HUB[0], y: HUB[1] },
		{ type: "belt", x: 10, y: 10, r: 0 },
		{ type: "cutter", x: 12, y: 10, r: 0 },
		{ type: "painter", x: 14, y: 10, r: 0 },
	],
};
{
	const r = buildLine("CuCuCuCu", { hub: HUB, seed: SEED, level: LEVEL, world: DIRTY });
	eq(r.ok, false, "B1 有既有实体 ⇒ ok:false");
	eq(r.reason, "site-not-empty", "★B1 reason === site-not-empty（前置条件，而不是空间）");
	ok(r.reason !== "no-site-large-enough", "★B1 reason 不再是 no-site-large-enough（旧 bug 的形态）", r.reason);
	eq(r.blueprint, null, "B1 失败不产蓝图");
	eq(r.entities, null, "B1 失败不给实体表");
	eq(r.precondition, "empty-site", "B1 failure 里仍带 precondition（调用方据此换宏）");
	eq(r.evidence.foreignCount, 3, "B1 evidence 数出 3 个非 hub 实体（hub 不计）", r.evidence);
	ok(r.evidence.foreign.some(e => e.type === "cutter" && e.x === 12 && e.y === 10), "B1 evidence 保留实体样本（类型+坐标）", r.evidence.foreign);
}
{
	// entities 的简写入口也必须走同一条判据（两条入口不能分叉）
	const r = buildLine("CuCuCuCu", { hub: HUB, entities: DIRTY.entities }, { seed: SEED, level: LEVEL });
	eq(r.reason, "site-not-empty", "B2 site.entities 简写口径同判（两条入口合流）");
}
{
	// 只有一个 hub 的世界 = 干净（hub 永远在 entities 里，不能把它算脏）
	const r = buildLine("CuCuCuCu", { hub: HUB, seed: SEED, level: LEVEL, entities: [{ type: "hub", x: HUB[0], y: HUB[1] }] });
	eq(r.ok, true, "B3 世界快照里只有 hub ⇒ 仍算空地（hub 不计入 foreign）", { reason: r.reason, hint: (r.hint || "").slice(0, 80) });
}

/* ══════════════════ C. 真没空间 ⇒ 仍是 no-site-large-enough ══════════════════ */
console.log("\n── C 真的不是空间问题 / 真的是空间问题 ──");
{
	// 空地 + 资源范围极小 ⇒ 真的是"这片区域没有矿"（no-resource-in-range），不能一律改名
	const r = buildLine("CuCuCuCu", { hub: [900, 900], seed: SEED, level: LEVEL, range: 8 });
	eq(r.ok, false, "C1 hub 挪到资源外 + range 8 ⇒ ok:false");
	ok(r.reason !== "site-not-empty", "★C1 干净的世界不会报 site-not-empty（没有把判据做成一刀切）", r.reason);
	eq(r.reason, "no-resource-in-range", "C1 reason === no-resource-in-range（真的是资源问题）", r.reason);
	ok(/range|seed|hub/.test(r.hint), "C1 hint 指向 range/seed/hub（可行动的处置）", r.hint);
}
{
	// RuRu---- 在 seed 55013 下是真实的几何/空间失败（placeStage 的 V9-unused-outlet），
	// 用来锁住"透传"：宏不能把非前置条件的失败也改名叫 site-not-empty。
	const r = buildLine("RuRu----", { hub: HUB, seed: SEED, level: LEVEL });
	eq(r.ok, false, "C2 RuRu----（空地）仍按原样失败");
	ok(r.reason !== "site-not-empty", "★C2 空地目标的失败不被误标为 site-not-empty", r.reason);
	eq(r.reason, "no-site-large-enough", "C2 透传编译器的 no-site-large-enough（真的是空间/几何）", r.reason);
	eq(r.compilerReason, "no-site-large-enough", "C2 compilerReason 保留原始 §2.5 reason");
}

/* ══════════════════ D. hint 指向正确的替代方案 ══════════════════ */
console.log("\n── D 失败 hint 必须可行动 ──");
{
	const r = buildLine("CuCuCuCu", { hub: HUB, seed: SEED, level: LEVEL, world: DIRTY });
	ok(r.hint.includes("connect"), "D1 site-not-empty 的 hint 提到 connect", r.hint);
	ok(r.hint.includes("insert_machine"), "D1 site-not-empty 的 hint 提到 insert_machine", r.hint);
	ok(/空地/.test(r.hint), "D1 site-not-empty 的 hint 给出「换空地建线」这条出路", r.hint);
	ok(!/扩大\s*range|--range/.test(r.hint.split("不要靠")[0] || ""), "D1 site-not-empty 不把扩 range 当解决办法（那是空间问题的答案）", r.hint);
}
{
	const r = buildLine("CuCuCuCu", { seed: SEED, level: LEVEL });
	eq(r.reason, "hub-unpinned", "D2 不给 hub ⇒ hub-unpinned（不靠编译器兜底才说清楚）", r.reason);
	ok(r.hint.includes("hub"), "D2 hint 指向「给真实 hub 坐标」", r.hint);
	eq(r.ok, false, "D2 不给 hub 不产蓝图（蓝图 = 能贴的承诺）");
}

/* ══════════════════ E. 契约自洽 ══════════════════ */
console.log("\n── E 返回契约 ──");
{
	const results = [
		buildLine("CuCuCuCu", { hub: HUB, seed: SEED, level: LEVEL }),
		buildLine("CuCuCuCu", { hub: HUB, seed: SEED, level: LEVEL, world: DIRTY }),
		buildLine("CuCuCuCu", { seed: SEED, level: LEVEL }),
		buildLine("CuCuCuCu", { hub: [900, 900], seed: SEED, level: LEVEL, range: 8 }),
		buildLine("RuRu----", { hub: HUB, seed: SEED, level: LEVEL }),
	];
	for (const [i, r] of results.entries()) {
		eq(r.precondition, PRECONDITION, `E1 #${i} precondition === "${PRECONDITION}"（成功失败都在场）`);
		ok(typeof r.hint === "string" && r.hint.length > 0, `E1 #${i} hint 恒为非空串`);
		if (r.ok === true) {
			ok(typeof r.blueprint === "string" && Array.isArray(r.entities), `E1 #${i} 成功：blueprint + entities 都在`);
		} else {
			ok(r.blueprint === null && r.entities === null && r.cells === null && r.anchor === null,
				`E1 #${i} 失败：blueprint/entities/cells/anchor 全 null（不交半成品）`, { b: r.blueprint, e: r.entities });
			ok(typeof r.reason === "string" && r.reason.length > 0, `E1 #${i} 失败：reason 恒为非空串`);
		}
	}
}

/* ══════════════════ F. 永不 throw ══════════════════ */
console.log("\n── F 永不 throw（宏的契约）──");
{
	const cases = [
		["完全空参", () => buildLine()],
		["坏 goal", () => buildLine("nonsense", { hub: HUB, seed: SEED })],
		["site 是 null", () => buildLine("CuCuCuCu", null, { seed: SEED })],
		["site 是乱码对象", () => buildLine("CuCuCuCu", { hub: "不是坐标" }, { seed: SEED })],
		["world 是 null", () => buildLine("CuCuCuCu", { hub: HUB, seed: SEED, world: null })],
	];
	for (const [name, fn] of cases) {
		let r, threw = null;
		try { r = fn(); } catch (e) { threw = e; }
		ok(threw === null && r && typeof r.ok === "boolean", `F ${name} ⇒ 结构化返回，不 throw`, threw && threw.message);
	}
}

/* ══════════════════ 汇总 ══════════════════ */
console.log(`\n${fail === 0 ? "✓" : "✗"} build_line：${pass} 通过 / ${fail} 失败`);
if (fail) { console.log(`  失败项：${failures.join("；")}`); process.exitCode = 1; }
