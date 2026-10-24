/**
 * roundtrip.mjs — L1 门：emit → decodeBlueprint 离线回推自检（P6 emitter，plan-compiler.md §1.6 / §5）
 *
 * 运行：`node src/ai/compiler/roundtrip.mjs --test`   （退出码 0 = L1 门全绿）
 *
 * 为什么要「回推」而不是只看发射结果：SZBP1 是扁平数组 + LZString 压缩，人眼看不出错位；
 * 而 P7 实机对拍（exp-paste-*.mjs 的 intent_diff）用的凭据是 beltIntent。所以 L1 门的定义就是：
 *   发射产物 decode 回来，必须与 beltIntent 逐格全等 —— 蓝图与设计之间不许有
 *   「只有上机才看得见」的差。
 *
 * L1 门的检查集（plan §5 的 L1 行 → 本文件的 check id，逐条对应）
 *   L1-1  roundtrip-equality       逐格 (code,dx,dy,rot) === beltIntent（直线样例 / 拐角样例 / P1 金样例各一遍）
 *   L1-2  stride + belt-code       e.length/4 === entities.length；belt 格 code === 1 + rv；拐角入出垂直
 *   L1-3  bbox + anchor + summary  bbox === LayoutReport.bbox；w === 世界 min corner 且 dx/dy 非负可复原（C1）；
 *                                  summarizeBlueprint 不抛且计数/anchor/gv 一致
 *   L1-4  order-lock               拐角挪到直线前 → 拒（契约 + 本包闸），而 orderEntities 能把乱序排回单调
 *   L1-5  non-belt-rv              非 belt rv≠0 / 机器 rot≠0 → 拒，且 reason 透传 P2（out-of-scope:rotated-machine）
 *   L1-6  gate                     validation.pass!==true / ok!==true / drift 非空 / 契约破坏 → blueprint:null + reason
 *   L1-7  lint                     本包源文件不引用那份已删除的错误方向副本（红队 #1(2)）、
 *                                  belt-rules 只引权威副本、零依赖
 *   L1-8  cost / charge / 幂等      blueprintCost 与 shared 同式；chargeMode === "false" 显式；两次发射逐字节相同
 *   L1-9  chain-closure            相邻带子格满足 OPP(exit(u)) === entry(v)（belt-rules 的链闭合判据）
 *
 * fixture 说明（**手工构造**，不 import P3/P4/P5/P8 的实现 —— 写本包时它们是骨架）
 *   按 plan §2.1/§2.3/§2.4 的类型形状自己拼 CompiledPlan：机器 code 走 P2 的 codeFor、
 *   带子 (r,rv) 走 belt-rules 的 solveTurn、契约用 P1 的 assertCompiledPlan 自证
 *   （不过就抛错 —— 那是本文件写错了，不是发射器该拒的输入）。
 *   真产物落地后由 P8 补一条 fixture-vs-真实产物 schema diff 断言（plan §7.2 已点出这条漂移）。
 *   另有一条直接读 P1 的共享金样例 research/ai-plan/fixtures/plan-l1.json（只读）。
 *
 * 零依赖：ESM + node: 内置 + 仓库内已批准的只读模块。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { emitPlan, orderEntities, checkEntityOrder, normalizeAnchor, compareInputBlueprint, normalizeP2Reason, PENDING_BLUEPRINT, EMIT_GATES, P2 } from "./emit.mjs";
import { assertCompiledPlan, assertLayoutReport, assertValidatorReport, entityOrderPhase } from "./types.mjs";
import { decodeBlueprint, encodeBlueprint, summarizeBlueprint, blueprintCost } from "../../shared/blueprint.mjs";
import { beltCode, solveTurn, beltEntry, beltExit, OPP, DIRV } from "../belt-rules.mjs";
/* ⚠️ P2 只能经 emit.mjs 的 `P2` 拿：op-templates.mjs 的自测判据是 argv 含 --test（见 emit.mjs
 *    的 loadP2 注释）。本文件若静态 `import "../op-templates.mjs"`，模块图会在我方 argv 已经带
 *    --test 时求值它 → P2 自测输出（实测 175 行）混进 L1 门的 stdout 并污染 exitCode。 */
const codeFor = P2.codeFor;
const templateForBuildingCode = P2.templateForBuildingCode;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const FIX = path.join(ROOT, "research", "ai-plan", "fixtures");
const GV = "1.5.6";

/* ═══════════════════════════ fixture 构造器（手工，按 plan 类型形状） ═══════════════════════════ */

const MACHINE_KINDS = { miner: "miner", cutter: "cutter", rotater: "rotater", stacker: "stacker", mixer: "mixer", painter: "painter", trash: "trash" };
const FOOTPRINT = { miner: [1, 1], cutter: [2, 1], rotater: [1, 1], stacker: [2, 1], mixer: [2, 1], painter: [2, 1], trash: [1, 1] };
const OP_OF_KIND = { miner: "mine", cutter: "cut", rotater: "rotate", stacker: "stack", mixer: "mix", painter: "paint", trash: "trash" };
const RATES = { belt: 2.0, miner: 0.4, cutter: 0.5, rotater: 2.0, stacker: 0.25, painter: 0.33, mixer: 0.4, trash: 0 };
const CHECK_IDS_FULL = [
    "V1-occupancy", "V2-no-overwrite-existing-belt", "V3-belt-fixed-point", "V4-slot-alignment",
    "V5-degree", "V6-crossing", "V7-throughput", "V8-scope", "V9-unused-outlet",
    "V10-unlock-report", "S1-shape-replay",
];

/** kind → P2 的 default 模板（同 kind 多变体时 default 优先；反查不到 = 本文件写错） */
function templateOfKind(kind) {
    const codes = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    const hits = codes.map(c => templateForBuildingCode(c)).filter(t => t && t.kind === kind);
    const tpl = hits.find(t => t.variant === "default") || hits[0];
    if (!tpl) throw new Error("fixture: OP_TEMPLATES 里没有 kind=" + kind);
    return tpl;
}

/**
 * 由「设计格清单」拼一份完整 CompiledPlan（未发射态：ok:true + validation.pass:true + blueprint:null）。
 * 每个 cell：
 *   {t:"miner",   at:[x,y]}                                  inDir 恒 null、outDir 默认 top
 *   {t:"cutter"|"mixer"|"stacker"|"rotater"|"painter", at, inDir?, outDir?}
 *   {t:"trash",   at:[x,y], inDir?}                          outDir 恒 null
 *   {t:"belt",    at:[x,y], inDir, outDir}                   (rot,rv,code) 一律 solveTurn/beltCode 现算
 * @param {{goal:string, anchor:[number,number], hub?:[number,number]|null, cells:Array<object>,
 *          order?:"plan"|"scramble"}} spec
 * @returns {object} CompiledPlan
 */
export function buildCompiledPlan(spec) {
    const [ax, ay] = spec.anchor;
    const rows = spec.cells.map(c => {
        const dx = c.at[0] - ax, dy = c.at[1] - ay;
        if (c.t === "belt") {
            const s = solveTurn(c.inDir, c.outDir);
            if (!s) throw new Error(`fixture: solveTurn(${c.inDir},${c.outDir}) 无解 @ ${c.at}`);
            return {
                kind: "belt", cell: c.at, dx, dy, rot: s.rotation, rotationVariant: s.rotationVariant,
                code: beltCode(s.rotationVariant), inDir: c.inDir, outDir: c.outDir,
                nodeId: c.nodeId || `belt@${c.at[0]},${c.at[1]}`,
            };
        }
        const kind = MACHINE_KINDS[c.t];
        if (!kind) throw new Error("fixture: 未知格子类型 " + c.t);
        const tpl = templateOfKind(kind);
        return {
            kind, cell: c.at, dx, dy, rot: 0, rotationVariant: 0,
            code: codeFor(tpl.building, tpl.variant, 0, 0),
            inDir: kind === "miner" ? null : (c.inDir === undefined ? "bottom" : c.inDir),
            outDir: kind === "trash" ? null : (c.outDir === undefined ? "top" : c.outDir),
            nodeId: c.nodeId || `${kind}@${c.at[0]},${c.at[1]}`,
            building: tpl.building, variant: tpl.variant, footprint: tpl.footprint,
        };
    });

    const toEntity = r => ({
        code: r.code, dx: r.dx, dy: r.dy, rot: r.rot, nodeId: r.nodeId, instanceIdx: 0,
        kind: r.kind, rotationVariant: r.rotationVariant, inDir: r.inDir, outDir: r.outDir,
    });
    const machines = rows.filter(r => r.kind !== "belt");
    const straights = rows.filter(r => r.kind === "belt" && r.rotationVariant === 0);
    const corners = rows.filter(r => r.kind === "belt" && r.rotationVariant !== 0);
    // §2.1 的执行顺序：机器 → 直线 → 拐角；"scramble" 故意反过来（L1-4 的反例）
    const groups = [machines, straights, corners];
    const ordered = spec.order === "scramble" ? [corners, straights, machines] : groups;
    const entities = ordered.flat().map(toEntity);
    const machineRows = machines;

    const xs = entities.map(e => e.dx), ys = entities.map(e => e.dy);
    const bbox = [Math.max(...xs) - Math.min(...xs) + 1, Math.max(...ys) - Math.min(...ys) + 1];
    const byKind = {};
    for (const e of entities) if (e.kind !== "belt") byKind[e.kind] = (byKind[e.kind] || 0) + 1;

    const layout = {
        grid: renderGrid(rows),
        rows: [],
        placements: machineRows.map(r => ({
            nodeId: r.nodeId, op: OP_OF_KIND[r.kind] || r.kind, kind: r.kind,
            cell: [r.dx, r.dy], rot: 0, footprint: r.footprint,
        })),
        channels: [],
        lanes: [],
        hubConnection: spec.hub ? { entry: [0, 0], side: "bottom", dir: 0 } : null,
        bbox,
        occupancy: [],
        conflicts: [],
        cornerCount: corners.length,
    };

    const bn = bottleneckOf(entities);
    const validation = {
        pass: true,
        checks: CHECK_IDS_FULL.map(id => ({
            id,
            status: id === "V7-throughput" ? "not-applicable" : "pass",
            evidence: {
                cell: null, nodeId: null,
                expected: "P6 fixture 的占位报告（真判据在 P5）",
                actual: "n/a",
                note: "本包不 import P5：写本包时 validate.mjs 是骨架。漂移由 P8 的 fixture-vs-真产物 diff 兜住（plan §7.2）",
            },
        })),
        errors: [],
        beltSim: {
            tilesChecked: straights.length + corners.length,
            fixedPoints: straights.length + corners.length,
            drift: [],
            includesMachineNeighbors: true,
        },
        shapeReplay: [],
        throughput: { demandPerSec: 0, bottleneck: { nodeId: bn.nodeId, ratePerSec: bn.rate }, rowsRequired: 1, rowsPlanned: 1 },
    };

    const plan = {
        ok: true, goal: spec.goal, reason: null, failingNode: null, hint: null,
        site: { anchor: [...spec.anchor], hub: spec.hub ? [...spec.hub] : null },
        blueprint: null,
        entities, layout, validation,
        stats: {
            machines: byKind,
            beltTiles: straights.length + corners.length,
            trash: byKind.trash || 0,
            bbox,
            corners: corners.length,
            estThroughputPerSec: bn.rate,
            bottleneck: `${bn.kind}@${bn.rate}`,
            blueprintCost: blueprintCost(entities.length),
            chargeMode: "false",
        },
        scope: { layers: 1, wires: false, tunnels: false, rotatedMachines: false, maxFanIn: 2 },
    };

    // fixture 自证（不是「被拒的输入」，写错就该炸在本文件里）
    assertLayoutReport(layout, "fixture.layout");
    assertValidatorReport(validation, "fixture.validation");
    assertCompiledPlan({ ...plan, blueprint: PENDING_BLUEPRINT }, "fixture.plan",
        { entityOrder: spec.order === "scramble" ? "off" : "strict" });
    return plan;
}

function bottleneckOf(entities) {
    let best = null;
    for (const e of entities) {
        if (e.kind === "belt" || !(e.kind in RATES)) continue;
        if (!best || RATES[e.kind] < best.rate) best = { kind: e.kind, rate: RATES[e.kind], nodeId: e.nodeId };
    }
    return best || { kind: "miner", rate: RATES.miner, nodeId: "n0" };
}

/**
 * 字符网格（人读；第一行 = min y，y 向下）。机器字母沿用 plan §2.3 的记号，
 * 直线带用流向箭头，拐角用 "+"（P3 的完整拐角记号由 P3 拥有，本包不自立一套）。
 */
function renderGrid(rows) {
    const CH = { miner: "M", cutter: "S", rotater: "R", stacker: "K", mixer: "X", painter: "P", trash: "T" };
    const ARROW = { top: "^", bottom: "v", left: "<", right: ">" };
    const at = new Map();
    for (const r of rows) {
        at.set(`${r.cell[0]},${r.cell[1]}`, r.kind === "belt"
            ? (r.rotationVariant === 0 ? ARROW[r.outDir] : "+")
            : (CH[r.kind] || "?"));
    }
    const xs = [...at.keys()].map(k => +k.split(",")[0]), ys = [...at.keys()].map(k => +k.split(",")[1]);
    const lines = [];
    for (let y = Math.min(...ys); y <= Math.max(...ys); y++) {
        let line = "";
        for (let x = Math.min(...xs); x <= Math.max(...xs); x++) line += at.get(`${x},${y}`) || ".";
        lines.push(line);
    }
    return lines.join("\n");
}

/* ═══════════════════════════════ 三张 fixture ═══════════════════════════════ */

/** ① 全竖直线、零拐角（plan §2.7 / GRID-LAYOUT:41-62 第一原则；与 P1 的 plan-l1 同形） */
export function fixtureStraight(site = [1200, -1396]) {
    const [ax, ay] = site;
    const up = (x, y0, y1) => {
        const n = Math.abs(y1 - y0), step = y1 > y0 ? 1 : -1, out = [];
        for (let i = 0; i <= n; i++) out.push({ t: "belt", at: [x, y0 + step * i], inDir: "bottom", outDir: "top" });
        return out;
    };
    return buildCompiledPlan({
        goal: "----CuCu", anchor: [ax, ay], hub: [ax, ay - 4],
        cells: [
            { t: "miner", at: [ax, ay + 5] },
            { t: "cutter", at: [ax, ay + 4] },
            { t: "trash", at: [ax + 1, ay + 2] },
            ...up(ax, ay + 3, ay),
            { t: "belt", at: [ax + 1, ay + 3], inDir: "bottom", outDir: "top" },
        ],
    });
}

/**
 * ② 一个拐弯的汇合（mixer 双 bottom；2 个拐角 + 一条车道）。
 * 蓝图内坐标（anchor=[0,0] 视角，y 向下，物流向上）—— M4-SUCCESS:18-21 的形态：
 *   dy=0  T . . .        trash (2,0)
 *   dy=1  . . ^ .        直带 (2,1) → trash
 *   dy=2  . . X X        mixer (2,2)+(3,2)
 *   dy=3  F > + ^        拐角(0,3) rv2 / 车道直带(1,3) / 拐角(2,3) rv1 / 分支 A 直带(3,3)
 *   dy=4  ^ . . ^
 *   dy=5  ^ . . ^
 *   dy=6  M . . M
 */
export function fixtureCorners(site = [1200, -1396]) {
    const [ax, ay] = site;
    return buildCompiledPlan({
        goal: "----CuCu", anchor: [ax, ay], hub: null,
        cells: [
            { t: "miner", at: [ax + 3, ay + 6] },
            { t: "miner", at: [ax + 0, ay + 6] },
            { t: "mixer", at: [ax + 2, ay + 2] },
            { t: "trash", at: [ax + 2, ay + 0] },
            // 分支 A：竖直直入 mixer 右格 acceptor（M4 关键 1：只让一条分支拐弯）
            { t: "belt", at: [ax + 3, ay + 5], inDir: "bottom", outDir: "top" },
            { t: "belt", at: [ax + 3, ay + 4], inDir: "bottom", outDir: "top" },
            { t: "belt", at: [ax + 3, ay + 3], inDir: "bottom", outDir: "top" },
            // 分支 B：上行 → 拐角(0,3) 入下出右 → 车道 (1,3) → 拐角(2,3) 入左出上 → mixer 左格
            { t: "belt", at: [ax + 0, ay + 5], inDir: "bottom", outDir: "top" },
            { t: "belt", at: [ax + 0, ay + 4], inDir: "bottom", outDir: "top" },
            { t: "belt", at: [ax + 0, ay + 3], inDir: "bottom", outDir: "right" },
            { t: "belt", at: [ax + 1, ay + 3], inDir: "left", outDir: "right" },
            { t: "belt", at: [ax + 2, ay + 3], inDir: "left", outDir: "top" },
            // mixer 输出 → trash
            { t: "belt", at: [ax + 2, ay + 1], inDir: "bottom", outDir: "top" },
        ],
    });
}

/** ③ 同一几何、故意把拐角排在直线前（L1-4 的反例入参） */
export function fixtureScrambled(site = [1200, -1396]) {
    const [ax, ay] = site;
    const cells = fixtureCorners([ax, ay]).entities.map(e => e.kind === "belt"
        ? { t: "belt", at: [ax + e.dx, ay + e.dy], inDir: e.inDir, outDir: e.outDir, nodeId: e.nodeId }
        : { t: e.kind, at: [ax + e.dx, ay + e.dy], inDir: e.inDir === null ? undefined : e.inDir, outDir: e.outDir === null ? undefined : e.outDir, nodeId: e.nodeId });
    return buildCompiledPlan({ goal: "----CuCu", anchor: [ax, ay], hub: null, cells, order: "scramble" });
}

/* ═══════════════════════════════ 判据函数 ═══════════════════════════════ */

/** 逐格 (code,dx,dy,rot) 与 beltIntent 的差异表（失败信息比绿灯值钱 —— 返回数组不是布尔） */
export function diffCells(decoded, intent) {
    const diff = [];
    if (decoded.length !== intent.length) diff.push({ cell: null, why: `数量不符 decoded=${decoded.length} intent=${intent.length}` });
    const n = Math.min(decoded.length, intent.length);
    for (let i = 0; i < n; i++) {
        const d = decoded[i], w = intent[i];
        if (d.code !== w.code || d.dx !== w.dx || d.dy !== w.dy || d.rot !== w.rotation) {
            diff.push({ i, cell: [w.dx, w.dy], want: { code: w.code, dx: w.dx, dy: w.dy, rot: w.rotation }, got: d });
        }
    }
    return diff;
}

/** 执行顺序单调（机器 0 → 直线 1 → 拐角 2） */
export function isMonotone(list) {
    let prev = -1;
    for (const e of list) { const p = entityOrderPhase(e); if (p < prev) return false; prev = Math.max(prev, p); }
    return true;
}

/** 链闭合：带子 u 的出口格的 entry 必须是 OPP(u.outDir)（belt-rules 的判据，非带子/越界跳过） */
export function chainDiff(intent) {
    const byWorld = new Map(intent.map(b => [`${b.x},${b.y}`, b]));
    const bad = [];
    for (const u of intent) {
        if (u.kind !== "belt") continue;
        const [vx, vy] = DIRV[u.outDir];
        const v = byWorld.get(`${u.x + vx},${u.y + vy}`);
        if (!v || v.kind !== "belt") continue;
        if (beltExit(u.rotationVariant, u.rotation) !== OPP[beltEntry(v.rotationVariant, v.rotation)]) {
            bad.push({ from: [u.x, u.y], to: [v.x, v.y], uExit: beltExit(u.rotationVariant, u.rotation), vEntry: beltEntry(v.rotationVariant, v.rotation) });
        }
    }
    return bad;
}

/**
 * 本包两个源文件的 lint（红队 #1(2) + 零依赖）。
 * ⚠️ 判据字符串**拼出来**而不是写死，否则这个文件本身就成了 grep 的命中项。
 */
export function lintOwnSources() {
    const FORBIDDEN = ["proto", "belt-rules"].join("/");
    const files = ["emit.mjs", "roundtrip.mjs"].map(f => path.join(HERE, f));
    const problems = [];
    for (const f of files) {
        let src = "";
        try { src = fs.readFileSync(f, "utf8"); } catch (e) { problems.push({ file: path.basename(f), kind: "读不到", detail: String(e.message) }); continue; }
        const hits = src.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => l.includes(FORBIDDEN));
        if (hits.length) problems.push({ file: path.basename(f), kind: "禁止引用", detail: hits.map(([n]) => `行 ${n}`).join(",") });
        const specs = [...src.matchAll(/(?:^|\n)[ \t]*import\b[^;]{0,300}?\bfrom[ \t]*["']([^"']+)["']/g)].map(m => m[1]);
        for (const s of specs) {
            const norm = s.replace(/\\/g, "/");
            if (norm.includes("belt-rules") && !/(^|\/)src\/ai\/belt-rules\.mjs$|^\.\.\/belt-rules\.mjs$/.test(norm)) {
                problems.push({ file: path.basename(f), kind: "非权威 belt-rules 路径", detail: s });
            }
            if (!s.startsWith(".") && !s.startsWith("node:") && !s.startsWith("/")) problems.push({ file: path.basename(f), kind: "裸包名 import（零依赖违例）", detail: s });
        }
    }
    return problems;
}

/* ═══════════════════════════════ L1 门：检查集 ═══════════════════════════════ */

/** 跑全部 L1 门检查（可被 import 复用；CLI 也调它）
 * @returns {Array<{check:string, pass:boolean, detail:string}>} */
export function runChecks() {
    const results = [];
    const say = (pass, check, detail) => { results.push({ check, pass: !!pass, detail }); return !!pass; };
    const clone = o => JSON.parse(JSON.stringify(o));

    /* ── L1-1 / L1-2 / L1-3 / L1-9：两张离线 fixture 的回推全等 ── */
    for (const [name, plan] of [["straight", fixtureStraight()], ["corners", fixtureCorners()]]) {
        const out = emitPlan(plan);
        if (!say(out.ok === true, `L1-1.emit.${name}`, out.ok ? `n=${out.count} 发射成功` : `reason=${out.reason} gate=${out.gate} got=${JSON.stringify(out.got)}`)) continue;

        const decoded = decodeBlueprint(out.blueprint);

        // ① 逐格 (code,dx,dy,rot) === beltIntent
        const diff = diffCells(decoded.entities, out.beltIntent);
        say(diff.length === 0, `L1-1.roundtrip-equality.${name}`,
            diff.length ? `差异 ${diff.length} 格：${JSON.stringify(diff.slice(0, 3))}` : `${decoded.entities.length} 格逐格全等`);

        // ② stride：e 是 4 的倍数且 /4 === entities.length
        const flatLen = (decoded.entities.length * 4);
        say(flatLen / 4 === out.entities.length && out.stride === 4 && out.count === plan.entities.length,
            `L1-2.stride.${name}`, `e.length/4=${flatLen / 4} === entities=${out.entities.length}（stride=${out.stride}）`);

        // ③ belt 格 code === 1 + rv
        const belts = out.beltIntent.filter(b => b.kind === "belt");
        const badBelt = belts.filter(b => b.code !== 1 + b.rotationVariant);
        say(badBelt.length === 0, `L1-2.belt-code.${name}`, badBelt.length ? JSON.stringify(badBelt.slice(0, 3)) : `${belts.length} 带子格 code===1+rv（beltCode 现算）`);

        // 拐角入出垂直（M4-SUCCESS:18-21 的期望值形态）
        const cs = out.beltIntent.filter(b => b.isCorner);
        const perp = cs.every(b => b.outDir !== b.inDir && b.outDir !== OPP[b.inDir]);
        say(perp, `L1-2.corner-perpendicular.${name}`, `${cs.length} 个拐角 ${JSON.stringify(cs.map(c => `(${c.dx},${c.dy}) r=${c.rotation} rv=${c.rotationVariant} code=${c.code} ${c.inDir}->${c.outDir}`))}`);

        // ④ bbox 与 LayoutReport.bbox 一致（平移不改跨度）
        say(out.bbox[0] === plan.layout.bbox[0] && out.bbox[1] === plan.layout.bbox[1] &&
            out.plan.stats.bbox[0] === out.bbox[0] && out.plan.stats.bbox[1] === out.bbox[1],
            `L1-3.bbox.${name}`, `emit=${JSON.stringify(out.bbox)} layout=${JSON.stringify(plan.layout.bbox)} stats=${JSON.stringify(out.plan.stats.bbox)}`);

        // ⑤ 锚点 = 区域 min corner、dx/dy 非负、世界坐标可复原（C1）
        const na = normalizeAnchor(plan);
        const nonNeg = out.beltIntent.every(b => b.dx >= 0 && b.dy >= 0);
        const reproducible = out.beltIntent.every(b => b.x === out.anchor[0] + b.dx && b.y === out.anchor[1] + b.dy);
        const minCorner = out.beltIntent.every(b => b.x >= out.anchor[0] && b.y >= out.anchor[1]) &&
            out.beltIntent.some(b => b.x === out.anchor[0]) && out.beltIntent.some(b => b.y === out.anchor[1]);
        say(minCorner && nonNeg && reproducible && out.anchor[0] === na.anchor[0] && out.anchor[1] === na.anchor[1],
            `L1-3.anchor.${name}`, `w=${JSON.stringify(out.anchor)}（期望 min corner ${JSON.stringify(na.anchor)}）dx/dy 非负=${nonNeg} 可复原=${reproducible}`);

        // ⑥ summarizeBlueprint 不抛且一致
        let sm = null, smErr = "";
        try { sm = summarizeBlueprint(out.blueprint); } catch (e) { smErr = String(e.message); }
        say(sm && sm.count === out.count && sm.anchor[0] === out.anchor[0] && sm.anchor[1] === out.anchor[1] &&
            sm.exported_from === GV && (sm.format_version === 1 || sm.format_version === 2) &&
            Object.values(sm.by_code).reduce((a, b) => a + b, 0) === out.count,
            `L1-3.summarize.${name}`, sm ? JSON.stringify({ count: sm.count, anchor: sm.anchor, gv: sm.exported_from, fmt: sm.format_version, bounds: sm.bounds, by_code: sm.by_code }) : `抛错 ${smErr}`);

        // ⑦ 出参再过一次 §2.1 契约（strict 顺序 + 全量自洽）
        let reOk = true, reMsg = "";
        try { assertCompiledPlan(out.plan, "emitted.plan", { entityOrder: "strict" }); } catch (e) { reOk = false; reMsg = (e.allMessages || e.message).split("\n")[0]; }
        say(reOk, `L1-1.contract-of-output.${name}`, reOk ? "产出 plan 过 assertCompiledPlan(strict)" : reMsg.slice(0, 220));

        // ⑧ 链闭合
        const cd = chainDiff(out.beltIntent);
        say(cd.length === 0, `L1-9.chain-closure.${name}`, cd.length ? JSON.stringify(cd.slice(0, 3)) : "相邻带子格 OPP(exit)===entry 全通过");
    }

    /* ── L1-3b 锚点平移不变性：换 site.anchor 只挪 w，e 数组逐元素不变（P7 paste 的口径） ── */
    {
        const a = emitPlan(fixtureCorners([1200, -1396]));
        const b = emitPlan(fixtureCorners([7, 2000]));
        const sameFlat = a.ok && b.ok &&
            a.beltIntent.length === b.beltIntent.length &&
            a.beltIntent.every((it, i) => it.dx === b.beltIntent[i].dx && it.dy === b.beltIntent[i].dy &&
                it.code === b.beltIntent[i].code && it.rotation === b.beltIntent[i].rotation);
        say(sameFlat, "L1-3.anchor-translation-invariant",
            sameFlat ? `w=${JSON.stringify(a.anchor)} → ${JSON.stringify(b.anchor)}，e 数组不变（dx/dy 相对锚点）` : "换锚点改变了 e 数组（归一逻辑破了）");
        const worldShifts = a.ok && b.ok && a.beltIntent.every((it, i) =>
            b.beltIntent[i].x === it.x + (7 - 1200) && b.beltIntent[i].y === it.y + (2000 - -1396));
        say(worldShifts, "L1-3.intent-world-coords-follow-anchor", "beltIntent 的世界坐标 x/y 随锚点同步平移");
    }

    /* ── L1-3c 共享金样例 report-layout.json（P1 的双分支汇合 LayoutReport，只读） ──
     * plan §2.7：三个 fixture 必须同时被 P1 的 assert*() 与 P6 的 roundtrip 读通 ——
     * 这里锁「契约可解码」这一半（发射需要的是 entities，带子由 P4 产出，本包不重算路由）。 */
    {
        let lay = null, err = "";
        try { lay = JSON.parse(fs.readFileSync(path.join(FIX, "report-layout.json"), "utf8")); } catch (e) { err = String(e.message); }
        if (say(lay !== null, "L1-3.golden-layout-present", err || "research/ai-plan/fixtures/report-layout.json 读到")) {
            let rep = null, repErr = "";
            try { rep = assertLayoutReport(lay, "golden.layout"); } catch (e) { repErr = (e.allMessages || e.message).split("\n")[0]; }
            say(rep !== null, "L1-3.golden-layout-decodable", repErr || `cornerCount=${rep.cornerCount} channels=${rep.channels.length} lanes=${JSON.stringify(rep.lanes.map(l => l.row))}`);
            // 从它的 placements 造机器 entities，发射一遍（只有机器的蓝图也是合法蓝图；bbox 用 P3 的真值）
            if (rep) {
                const anchor = [100, -100];
                const cells = rep.placements.map(p => ({ t: p.kind, at: [anchor[0] + p.cell[0], anchor[1] + p.cell[1]], nodeId: p.nodeId }));
                let ok = false, why = "";
                try {
                    const p2 = buildCompiledPlan({ goal: "CuCuSuSu:RuRuCuCu", anchor, hub: null, cells });
                    const out = emitPlan(p2);
                    ok = out.ok === true && out.count === cells.length;
                    why = ok ? `${out.count} 格（P3 的 placements 直接过发射）reason=${out.reason}` : `reason=${out.reason} gate=${out.gate} got=${JSON.stringify(out.got)}`;
                } catch (e) { why = String(e.message).split("\n")[0]; }
                say(ok, "L1-3.golden-placements-emit", why);
            }
        }
    }

    /* ── L1-1 golden：P1 的共享金样例 plan-l1.json（只读） ── */
    {
        let raw = null, readErr = "";
        try { raw = JSON.parse(fs.readFileSync(path.join(FIX, "plan-l1.json"), "utf8")); } catch (e) { readErr = String(e.message); }
        if (say(raw !== null, "L1-1.golden-fixture-present", readErr || "research/ai-plan/fixtures/plan-l1.json 读到")) {
            const golden = clone(raw);
            const out = emitPlan(golden);
            if (say(out.ok === true, "L1-1.golden-emit", out.ok ? `n=${out.count}` : `reason=${out.reason} gate=${out.gate} got=${JSON.stringify(out.got)}`)) {
                const decoded = decodeBlueprint(out.blueprint);
                const diff = diffCells(decoded.entities, out.beltIntent);
                say(diff.length === 0, "L1-1.golden-roundtrip-equality", diff.length ? JSON.stringify(diff.slice(0, 3)) : `${decoded.entities.length} 格逐格全等`);

                // 与金样例自带的蓝图对拍 e 数组（跨度相同 ⇒ 归一只挪 w，不动 e；w 口径差异见 NOTES）
                const gd = decodeBlueprint(golden.blueprint);
                const sameFlat = gd.entities.length === decoded.entities.length &&
                    gd.entities.every((g, i) => g.code === decoded.entities[i].code && g.dx === decoded.entities[i].dx &&
                        g.dy === decoded.entities[i].dy && g.rot === decoded.entities[i].rot);
                say(sameFlat, "L1-1.golden-flat-equal-to-fixture",
                    `emit w=${JSON.stringify(out.anchor)} vs fixture w=${JSON.stringify(gd.w)}；e 数组${sameFlat ? "逐格相同" : "不同 = 回归"}`);

                say(out.corners === 0 && out.beltIntent.filter(b => b.isCorner).length === 0,
                    "L1-1.golden-zero-corner", `拐角数=${out.corners}（§2.7 要求全竖直线零拐角）`);
                say(out.cost === blueprintCost(out.count) && out.count === golden.entities.length,
                    "L1-8.golden-cost", `n=${out.count} cost=${out.cost}（shared/blueprint.mjs:98 同式）`);
                say(out.chargeMode === "false" && out.plan.stats.chargeMode === "false",
                    "L1-8.golden-charge-mode", `chargeMode=${JSON.stringify(out.chargeMode)}`);
                say(isMonotone(out.entities), "L1-4.golden-order", `相位 ${out.entities.map(entityOrderPhase).join(",")}`);
                say(chainDiff(out.beltIntent).length === 0, "L1-9.golden-chain-closure", "金样例的带子链闭合");
                const beltCodes = out.beltIntent.filter(b => b.kind === "belt").every(b => b.code === beltCode(b.rotationVariant));
                say(beltCodes, "L1-2.golden-belt-code", "belt 格 code = beltCode(rv)（金样例）");
            }
        }
    }

    /* ── L1-1 golden #3：P1 的 `contract/merge-belt-intent.json` × `fixtures/report-layout.json`
     *    这是唯一一张**带拐角、且拐角 (r,rv,code) 来自实机期望值**（M4-SUCCESS:18-21）的真表：
     *    28 格（2 miner + stacker + trash + 24 带子，含 rv1/rv2 各一），24 格带子的 inDir/outDir
     *    全部由 P1 用权威 belt-rules 现算。本检查把它**原样**（不重算几何）发射一遍，
     *    再回推与实机期望值对拍 —— 这一条过了，「蓝图字符串里带着实机验证过的拐角」才算锁住。 */
    {
        const MI = path.join(ROOT, "research", "ai-plan", "contract", "merge-belt-intent.json");
        let mi = null, err = "";
        try { mi = JSON.parse(fs.readFileSync(MI, "utf8")); } catch (e) { err = String(e.message); }
        if (say(mi !== null, "L1-1.golden-merge-present", err || "research/ai-plan/contract/merge-belt-intent.json 读到")) {
            const ents = clone(mi.entities);
            let lay = null, layErr = "";
            try { lay = assertLayoutReport(JSON.parse(fs.readFileSync(path.join(FIX, "report-layout.json"), "utf8")), "golden.merge-layout"); }
            catch (e) { layErr = (e.allMessages || e.message).split("\n")[0]; }
            say(lay !== null, "L1-3.golden-merge-layout-decodable", layErr || `bbox=${JSON.stringify(lay.bbox)} cornerCount=${lay.cornerCount} placements=${lay.placements.length}`);
            const anchor = [137, 90];                         // mi.coordinate：dx = x-137、dy = y-90
            if (lay) {
            const xs = ents.map(e => e.dx), ys = ents.map(e => e.dy);
            const bbox = [Math.max(...xs) - Math.min(...xs) + 1, Math.max(...ys) - Math.min(...ys) + 1];
            const byKind = {};
            for (const e of ents) if (e.kind !== "belt") byKind[e.kind] = (byKind[e.kind] || 0) + 1;
            const corners = ents.filter(e => e.kind === "belt" && e.rotationVariant !== 0).length;
            const mergePlan = {
                ok: true, goal: "CuCuSuSu:RuRuCuCu", reason: null, failingNode: null, hint: null,
                site: { anchor, hub: null }, blueprint: null, entities: ents,
                layout: lay,                                  // ← P3 的真 LayoutReport（bbox 11×11）
                validation: {
                    pass: true,
                    checks: CHECK_IDS_FULL.map(id => ({ id, status: id === "V7-throughput" ? "not-applicable" : "pass",
                        evidence: { cell: null, nodeId: null, expected: "占位（真判据在 P5）", actual: "n/a", note: "P6 不 import P5" } })),
                    errors: [],
                    beltSim: { tilesChecked: ents.filter(e => e.kind === "belt").length, fixedPoints: ents.filter(e => e.kind === "belt").length, drift: [], includesMachineNeighbors: true },
                    shapeReplay: [],
                    throughput: { demandPerSec: 0, bottleneck: { nodeId: "st", ratePerSec: 0.25 }, rowsRequired: 1, rowsPlanned: 1 },
                },
                stats: {
                    machines: byKind, beltTiles: ents.filter(e => e.kind === "belt").length,
                    trash: byKind.trash || 0, bbox, corners,
                    estThroughputPerSec: 0.25, bottleneck: "stacker@0.25",
                    blueprintCost: blueprintCost(ents.length), chargeMode: "false",
                },
                scope: { layers: 1, wires: false, tunnels: false, rotatedMachines: false, maxFanIn: 2 },
            };
            const out = emitPlan(mergePlan);
            if (say(out.ok === true, "L1-1.golden-merge-emit", out.ok ? `n=${out.count}（28 格含 2 实机拐角）` : `reason=${out.reason} gate=${out.gate} got=${JSON.stringify(out.got).slice(0, 200)}`)) {
                const decoded = decodeBlueprint(out.blueprint);
                say(diffCells(decoded.entities, out.beltIntent).length === 0,
                    "L1-1.golden-merge-roundtrip-equality", `${decoded.entities.length} 格逐格全等 (code,dx,dy,rot)`);

                // 实机期望值（M4-SUCCESS:18-21）：按 **世界坐标** 查 beltIntent —— 一条断言同时验
                // (a) 归一后的 dx/dy 与 site.anchor 复合能复原世界格，(b) 拐角的 (r,rv,code) 未被发射改写
                const expBad = mi.live_expectations.filter(w => {
                    const got = out.beltIntent.find(b => b.x === w.world[0] && b.y === w.world[1]);
                    return !got || got.rotation !== w.rot || got.rotationVariant !== w.rotationVariant || got.code !== w.code;
                });
                say(expBad.length === 0, "L1-1.golden-merge-live-expectations",
                    expBad.length ? `不符 ${JSON.stringify(expBad)}`
                        : mi.live_expectations.map(w => `world(${w.world}) 复原成功 且 r=${w.rot} rv=${w.rotationVariant} code=${w.code} ← ${w.source}`).join(" | "));
                // 蓝图内坐标 = 原 dx/dy 折到 min corner（dy 起点是 -1，必须被归一到 0）
                const minDx = Math.min(...ents.map(e => e.dx)), minDy = Math.min(...ents.map(e => e.dy));
                const coordBad = out.beltIntent.filter((b, i) => b.dx !== ents[i].dx - minDx || b.dy !== ents[i].dy - minDy);
                say(coordBad.length === 0 && minDy === -1, "L1-1.golden-merge-anchor-normalize",
                    coordBad.length ? JSON.stringify(coordBad.slice(0, 2)) : `原 dy 起点 ${minDy}（负）→ 发射后 min=0；w=${JSON.stringify(out.anchor)}`);
                // P3 的真 bbox 与本包发射的 bbox 一致（L1 门的 bbox 条款用**真 LayoutReport** 验一次）
                say(out.bbox[0] === lay.bbox[0] && out.bbox[1] === lay.bbox[1],
                    "L1-3.golden-merge-bbox-vs-layout-report", `emit=${JSON.stringify(out.bbox)} === LayoutReport.bbox=${JSON.stringify(lay.bbox)}`);
                say(out.corners === lay.cornerCount, "L1-3.golden-merge-corner-count", `${out.corners} === layout.cornerCount=${lay.cornerCount}`);
                say(isMonotone(out.entities) && chainDiff(out.beltIntent).length === 0,
                    "L1-4.golden-merge-order-and-chain", `相位 ${out.entities.map(entityOrderPhase).join("")}（机器→直线→拐角）+ 链闭合 0 差异`);
                say(out.cost === blueprintCost(ents.length) && out.count === ents.length,
                    "L1-8.golden-merge-cost", `n=${ents.length} cost=${out.cost}`);
            }
            }
        }
    }

    /* ── L1-10 hub 的归属（CONTEST C-5：§2.1 的 kind 枚举含 hub，但 P1 契约把非 belt code 限死 7..20） ──
     * 本检查**记录现状**而不是主张对错：kind:"hub" 的 entity 在 P6 这里由契约拒绝（emit:mismatch，
     * 归因 gate=contract-violation）。主线程若裁决「hub 允许进蓝图」（改 types.mjs 的 code 域），
     * 这条会红 —— 那就是该重新审视 P6 的时刻，不是回归。 */
    {
        const p = fixtureStraight();
        p.entities.push({ code: 26, dx: 0, dy: -4, rot: 0, nodeId: "hub", instanceIdx: 0, kind: "hub", rotationVariant: 0, inDir: null, outDir: null });
        const bb = (() => { const xs = p.entities.map(e => e.dx), ys = p.entities.map(e => e.dy); return [Math.max(...xs) - Math.min(...xs) + 1, Math.max(...ys) - Math.min(...ys) + 1]; })();
        p.stats.bbox = bb; p.layout.bbox = bb; p.stats.blueprintCost = blueprintCost(p.entities.length);
        const out = emitPlan(p);
        const rejectedByContract = out.ok === false && out.gate === EMIT_GATES.CONTRACT && /code/.test(String(out.path));
        say(rejectedByContract, "L1-10.hub-entity-status-quo",
            rejectedByContract ? `契约拒（path=${out.path}）：${String(out.got).split("\n")[0].slice(0, 120)}` : `ok=${out.ok} reason=${out.reason}`);
        // 反证：P2 侧本身是认 hub 的（code=26 可解码、isV1Emittable=true）⇒ 卡点只在 P1 的 code 域
        const hubTpl = templateForBuildingCode(26);
        say(hubTpl && hubTpl.kind === "hub" && codeFor("hub", "default", 0, 0) === 26 && P2.isV1Emittable("hub", "default") === true,
            "L1-10.p2-knows-hub", `P2: kind=${hubTpl && hubTpl.kind} code=${codeFor("hub", "default", 0, 0)} isV1Emittable=${P2.isV1Emittable("hub", "default")}（⇒ 三态不一致见 CONTEST C-5）`);
    }

    /* ── L1-4 顺序锁 ── */
    {
        const scrambled = fixtureScrambled();
        const phasesIn = scrambled.entities.map(entityOrderPhase);
        say(!isMonotone(scrambled.entities), "L1-4.precondition", `入参确实乱序：相位 ${phasesIn.join(",")}（拐角在前）`);

        // (a) 乱序入参 → 拒绝，不产蓝图
        const outA = emitPlan(scrambled);
        say(outA.ok === false && outA.blueprint === null && outA.beltIntent.length === 0,
            "L1-4.order-lock.rejects-scrambled-input", outA.ok ? "竟然产出了蓝图（顺序锁失效）" : `reason=${outA.reason} gate=${outA.gate} path=${outA.path}`);

        // (b) P1 契约对同一输入也是拒绝（顺序锁不是本包自说自话）
        let contractThrew = false, msg = "";
        try { assertCompiledPlan({ ...scrambled, blueprint: PENDING_BLUEPRINT }, "scrambled", { entityOrder: "strict" }); }
        catch (e) { contractThrew = true; msg = (e.allMessages || e.message).split("\n")[0]; }
        say(contractThrew, "L1-4.order-lock.contract-agrees", msg.slice(0, 200));

        // (c) 排序函数把乱序排回单调，且不增删格子
        const ordered = orderEntities(scrambled.entities);
        say(isMonotone(ordered) && checkEntityOrder(ordered).ok, "L1-4.order-lock.reorders-internally",
            `相位 ${phasesIn.join(",")} → ${ordered.map(entityOrderPhase).join(",")}`);
        say(ordered.length === scrambled.entities.length &&
            ordered.slice().sort((a, b) => a.nodeId.localeCompare(b.nodeId)).map(e => e.nodeId).join("|") ===
            scrambled.entities.slice().sort((a, b) => a.nodeId.localeCompare(b.nodeId)).map(e => e.nodeId).join("|"),
            "L1-4.order-lock.stable-set", "重排不增删格子（计数守恒、集合相同）");

        // (d) 排好序后再发射：蓝图内顺序也单调（发射器内部排序真的生效）
        const outD = emitPlan({ ...scrambled, entities: ordered });
        say(outD.ok === true && isMonotone(decodeBlueprint(outD.blueprint).entities.length === outD.beltIntent.length
            ? outD.beltIntent : []), "L1-4.order-lock.emits-ordered-blueprint",
            outD.ok ? `出参相位 ${outD.beltIntent.map(b => b.phase).join(",")}` : `reason=${outD.reason} gate=${outD.gate}`);

        // (e) opts.entityOrder:"reorder" 的逃生口：同一乱序入参重排后发射，
        //     蓝图内容与「先排好再 strict 发射」**逐字节相同**（重排只动次序、不动内容）
        const viaOpt = emitPlan(scrambled, { entityOrder: "reorder" });
        say(viaOpt.ok === true && viaOpt.blueprint === outD.blueprint && viaOpt.warnings.length === 1,
            "L1-4.order-lock.reorder-escape-hatch",
            viaOpt.ok ? `蓝图与 strict 路径一致=${viaOpt.blueprint === outD.blueprint}；warning=${JSON.stringify(viaOpt.warnings)}` : `reason=${viaOpt.reason}`);
        // (f) 反证：默认（不传 opts）绝不提供这个口子 —— 顺序锁是默认行为，不是可选项
        say(emitPlan(scrambled).ok === false, "L1-4.order-lock.strict-by-default", "缺省 opts.entityOrder → 拒（不是默默帮你排好）");
    }

    /* ── L1-5 非 belt rv≠0 / 机器 rot≠0 → 拒（透传 P2 断言） ── */
    {
        const cases = [
            { label: "machine-rv1", mutate: p => { const m = p.entities.find(e => e.kind === "mixer" || e.kind === "cutter" || e.kind === "miner"); m.rotationVariant = 1; }, want: "out-of-scope:rotated-machine" },
            { label: "machine-rot90", mutate: p => { const m = p.entities.find(e => e.kind !== "belt"); m.rot = 90; }, want: "out-of-scope:rotated-machine" },
            { label: "belt-rv3", mutate: p => { p.entities.find(e => e.kind === "belt").rotationVariant = 3; }, want: "emit:mismatch" },
            { label: "belt-handcoded-code", mutate: p => { p.entities.find(e => e.kind === "belt").code = 99; }, want: "emit:mismatch" },
            { label: "machine-handcoded-code", mutate: p => { const m = p.entities.find(e => e.kind === "trash"); m.code = 12; }, want: "emit:mismatch" },
        ];
        for (const c of cases) {
            const plan = fixtureCorners();
            c.mutate(plan);
            const out = emitPlan(plan);
            const rejected = out.ok === false && out.blueprint === null && out.beltIntent.length === 0;
            say(rejected && out.reason === c.want, `L1-5.reject.${c.label}`,
                rejected ? `reason=${out.reason} gate=${out.gate}（期望 ${c.want}）` : `未拒绝：${JSON.stringify({ ok: out.ok, blueprint: (out.blueprint || "").slice(0, 12) })}`);
            say(out.reason !== "validate:V8-scope" && out.reason !== null, `L1-5.reason-in-2-5.${c.label}`, `reason=${out.reason}`);
        }
        // 反向确认判据源确实是 P2（本包不另立 rv 真值）
        let p2 = "";
        try { codeFor("mixer", "default", 0, 1); } catch (e) { p2 = `${e.name} reason=${e.reason}`; }
        say(/SpecError/.test(p2) && /out-of-scope:rotated-machine/.test(p2), "L1-5.p2-is-the-authority", p2 || "P2 没拦（判据漂移 → NOTES G1）");

        // P2 的长号 reason 必须被折成 P1 的规范短号再出口（P8 分诊表做等值比较；见 NOTES「P2 reason 与 §2.5」）
        {
            let longErr = null;
            try { P2.opByName("nope-such-op"); } catch (e) { longErr = e; }
            const long = longErr && longErr.reason;
            const norm = normalizeP2Reason(longErr);
            say(long === "validate:V8-scope" && norm === "validate:V8",
                "L1-5.reason-normalized-to-short-form", `P2 实发 ${long} → 出口 ${norm}（P1 建议的规范形式 = 短号）`);
            const h2 = (() => { try { codeFor("mixer", "default", 0, 1); } catch (e) { return e; } })();
            say(normalizeP2Reason(h2) === "out-of-scope:rotated-machine",
                "L1-5.reason-passthrough-for-others", `H2 的串不被改写：${normalizeP2Reason(h2)}`);
        }
    }

    /* ── L1-6 闸：validation 不过 / ok!==true → blueprint:null + reason ── */
    {
        let valRaw = null;
        try { valRaw = JSON.parse(fs.readFileSync(path.join(FIX, "report-validator.json"), "utf8")); } catch { valRaw = null; }
        const base = fixtureStraight();

        // (a) P5 的真失败报告（fixtures/report-validator.json：pass:false，第一条 fatal 是 V2）
        const planA = { ...base, validation: valRaw };
        const outA = emitPlan(planA);
        say(outA.ok === false && outA.blueprint === null && outA.reason === "validate:V2",
            "L1-6.validation-fail", `reason=${outA.reason} gate=${outA.gate} check=${outA.failingNode.check}`);

        // (b) ok:false（上游已判死）→ 透传它自己的 reason
        const planB = { ...base, ok: false, blueprint: null, reason: "throughput:stacker-bottleneck", hint: "加行", failingNode: { nodeId: "st", cell: [0, 1], check: "V7-throughput" } };
        const outB = emitPlan(planB);
        say(outB.ok === false && outB.blueprint === null && outB.reason === "throughput:stacker-bottleneck",
            "L1-6.plan-not-ok", `reason=${outB.reason} gate=${outB.gate}`);

        // (c) pass:true 但 drift 非空（自相矛盾的报告，plan §2.4 也不放过）→ validate:V3
        const planC = { ...base, validation: { ...base.validation, beltSim: { ...base.validation.beltSim, drift: [{ cell: [6, 0], wantRv: 2, gotRv: 0 }] } } };
        const outC = emitPlan(planC);
        say(outC.ok === false && outC.reason === "validate:V3" && outC.blueprint === null,
            "L1-6.belt-sim-drift", `reason=${outC.reason} gate=${outC.gate} cell=${JSON.stringify(outC.failingNode.cell)}`);

        // (d) 契约破坏（scope 被改成 rotatedMachines:true）→ emit:mismatch + gate=contract
        const outD = emitPlan({ ...base, scope: { ...base.scope, rotatedMachines: true } });
        say(outD.ok === false && outD.blueprint === null && outD.reason === "emit:mismatch" && outD.gate === EMIT_GATES.CONTRACT,
            "L1-6.contract-violation", `reason=${outD.reason} gate=${outD.gate} path=${outD.path}`);

        // (e) 蓝图字段谎报（ok:true 却塞进别的实体表）→ 契约层拒，不产蓝图
        const lie = clone(base); lie.entities = lie.entities.filter(e => e.kind !== "trash");
        const outE = emitPlan({ ...lie, blueprint: PENDING_BLUEPRINT });
        say(outE.ok === false && outE.blueprint === null,
            "L1-6.stats-entities-mismatch", `reason=${outE.reason} gate=${outE.gate}`);

        // (f) 所有拒绝的返回形状一致
        const allRejections = [outA, outB, outC, outD, outE];
        const shapeOk = allRejections.every(f => f && f.ok === false && f.blueprint === null &&
            Array.isArray(f.beltIntent) && f.beltIntent.length === 0 && typeof f.reason === "string" &&
            f.failingNode && "nodeId" in f.failingNode && "cell" in f.failingNode && "check" in f.failingNode);
        say(shapeOk, "L1-6.failure-shape", `${allRejections.length} 条拒绝都是 {ok:false, reason∈§2.5, failingNode{nodeId,cell,check}, blueprint:null, beltIntent:[]}`);

        // (g) 入参蓝图是占位哨兵时，出参绝不残留哨兵
        const outG = emitPlan(base);
        say(outG.ok === true && !outG.blueprint.startsWith(PENDING_BLUEPRINT),
            "L1-6.no-sentinel-leak", `出参前 24 字符=${JSON.stringify(outG.blueprint.slice(0, 24))}`);

        // (h) 入参自带**陈旧/谎报**蓝图 → 拒（绝不静默覆盖一张对不上 entities 的蓝图，redteam:158）
        {
            const withBp = clone(base);
            const dec = decodeBlueprint(outG.blueprint);
            dec.entities[3] = { ...dec.entities[3], rot: (dec.entities[3].rot + 90) % 360 };   // 一格转 90°
            withBp.blueprint = encodeBlueprint({ gv: GV, w: dec.w, entities: dec.entities });
            const outH = emitPlan(withBp);
            say(outH.ok === false && outH.blueprint === null && outH.reason === "emit:mismatch",
                "L1-6.stale-input-blueprint-rejected", `gate=${outH.gate} got=${JSON.stringify(outH.got).slice(0, 140)}`);
            // 显式逃生口：按 entities 重发射，产物与未篡改的一致
            const outI = emitPlan(withBp, { ignoreInputBlueprint: true });
            say(outI.ok === true && outI.blueprint === outG.blueprint,
                "L1-6.ignoreInputBlueprint-escape-hatch", outI.ok ? "重发射的结果与基准逐字节相同" : `reason=${outI.reason}`);
            // 正反对照：真蓝图当入参应当被接受（金样例就是这个路径）
            const outJ = emitPlan({ ...base, blueprint: outG.blueprint });
            say(outJ.ok === true && outJ.blueprint === outG.blueprint, "L1-6.input-blueprint-verified-ok", "入参蓝图与 entities 相符 → 放行");
            // compareInputBlueprint 的判据本身也要有反证（不能是个恒真的守卫）
            {
                const good = compareInputBlueprint(outG.blueprint, base.entities, base.site.anchor);
                const dec = decodeBlueprint(outG.blueprint);
                const dropOne = encodeBlueprint({ gv: GV, w: dec.w, entities: dec.entities.slice(0, -1) });
                const badLen = compareInputBlueprint(dropOne, base.entities, base.site.anchor);
                const garbage = compareInputBlueprint("SZBP1.not-really-lz", base.entities, base.site.anchor);
                say(good.ok === true && badLen.ok === false && garbage.ok === false,
                    "L1-6.compare-input-blueprint-judges",
                    `相符→pass / 少一格→${badLen.ok ? "!!也 pass" : "拒（" + String(badLen.detail).slice(0, 40) + "）"} / 乱码→${garbage.ok ? "!!也 pass" : "拒"}`);
            }
        }
    }

    /* ── L1-7 lint ── */
    {
        const problems = lintOwnSources();
        say(problems.length === 0, "L1-7.lint-own-sources",
            problems.length ? JSON.stringify(problems.slice(0, 4)) : "emit.mjs / roundtrip.mjs：无禁用路径、belt-rules 只引权威副本、无裸包名 import");
    }

    /* ── L1-8 成本 / 口径 / 幂等 / intent 字段 ── */
    {
        const plan = fixtureCorners();
        const a = emitPlan(plan), b = emitPlan(plan);
        say(a.ok === true && b.ok === true && a.blueprint === b.blueprint, "L1-8.deterministic", "同输入两次发射逐字节相同（无随机、无时钟）");
        say(a.ok && a.cost === blueprintCost(a.count) && a.chargeMode === "false",
            "L1-8.cost-and-charge", `n=${a.count} cost=${a.cost} chargeMode=${a.chargeMode}`);
        say(a.ok && a.gv === GV && decodeBlueprint(a.blueprint).gv === GV,
            "L1-8.game-version", `gv=${a.gv}（与游戏版本不符 mod 报 2006）`);
        const need = ["x", "y", "dx", "dy", "rotation", "rotationVariant", "code", "inDir", "outDir", "kind", "nodeId", "instanceIdx", "isCorner", "index", "phase"];
        const have = a.ok ? Object.keys(a.beltIntent[0]) : [];
        say(a.ok && need.every(k => have.includes(k)), "L1-8.intent-fields",
            `缺 ${need.filter(k => !have.includes(k)).join(",") || "无"}；多 ${have.filter(k => !need.includes(k)).join(",") || "无"}`);
        // 每条 intent 的世界坐标 = anchor + dx/dy（P7 直接拿去 paste 的对拍口径）
        say(a.ok && a.beltIntent.every(it => it.x === a.anchor[0] + it.dx && it.y === a.anchor[1] + it.dy),
            "L1-8.intent-world-coords", "beltIntent 每格 x/y === anchor + dx/dy");
    }

    return results;
}

/* ═══════════════════════════════ CLI ═══════════════════════════════ */

export function main() {
    const t0 = Date.now();
    const results = runChecks();
    let fails = 0;
    for (const r of results) {
        if (!r.pass) fails++;
        console.log(`${r.pass ? "✓" : "✗"} ${r.check}${r.detail ? "  —— " + r.detail : ""}`);
    }
    console.log(`\nL1 门（P6 emitter）：${results.length - fails}/${results.length} 条通过，用时 ${Date.now() - t0}ms`);
    if (fails) { console.log(`roundtrip.mjs: ${fails} 条失败 —— P6 未过闸，P8 不许接`); process.exitCode = 1; }
    return results;
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("compiler/roundtrip.mjs");
if (invokedDirectly && process.argv.includes("--test")) main();
