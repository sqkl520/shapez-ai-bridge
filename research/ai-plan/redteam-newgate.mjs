/**
 * redteam-newgate.mjs — 提案：能抓住 L4 事故的三道闸（原型 + 必红/必绿用例）。
 *
 * 不改 src/agent/gates.mjs。这里只把判据写成可执行代码并跑夹具证明：
 *   · 现有 gateG6b 在同一份事故数据上判绿（漏）
 *   · 新 G2'（贴前）在意图内部不自洽时红
 *   · 新 G7（贴后逐格方向）在事故数据上红、在健康对照上绿
 *   · 新 G8（贴后链划分）在事故数据上红，并能指出「货去了 hub 而不是 cutter」
 *
 * 方向约定（src/ai/belt-rules.mjs:18-38, 45-56）：
 *   DIRV.top=[0,-1]（y 减小）；inDir/outDir 是「从本格指向邻格」的方位面。
 *   beltEntry(rv,rot) / beltExit(rv,rot) 给带子的入/出面。
 *
 * 用法：node research/ai-plan/redteam-newgate.mjs
 */
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve("D:/Projects/rea/Project work/shapez");
const G = await import(pathToFileURL(path.join(ROOT, "src/agent/gates.mjs")).href);
const B = await import(pathToFileURL(path.join(ROOT, "src/ai/belt-rules.mjs")).href);
const { DIRV, OPP, beltEntry, beltExit } = B;
const { decodeBlueprint, encodeBlueprint } = await import(
    pathToFileURL(path.join(ROOT, "src/shared/blueprint.mjs")).href);

const k = c => `${c[0]},${c[1]}`;
const dirOf = (from, to) => {
    const dx = to[0] - from[0], dy = to[1] - from[1];
    if (dx === 0 && dy === -1) return "top";
    if (dx === 0 && dy === 1) return "bottom";
    if (dx === -1 && dy === 0) return "left";
    if (dx === 1 && dy === 0) return "right";
    return null;
};
const step = (c, d) => [c[0] + DIRV[d][0], c[1] + DIRV[d][1]];

/* ═════════ G2'：贴前 · intent ↔ blueprint 同源 + (rot,rv) ↔ in/out 自洽 ═════════
 * 现有五道闸里没有任何一处 decode 过 blueprint（gates.mjs 只把 intent.blueprint 原样
 * 交给 paste，见 :933/:946），也没有任何一处读过 rotationVariant / inDir / outDir
 * （全文 0 次命中）。paste 的载荷是 blueprint，G4 的期望是 intent.entities —— 两条腿
 * 从不相交，所以「编译器自己算错、粘贴忠实」这类事故在结构上无法被发现。
 */
export function gateIntentMatchesBlueprint(intent, decode) {
    const ev = {};
    if (typeof intent.blueprint !== "string" || !intent.blueprint.startsWith("SZBP1.")) {
        return { ok: false, reason: "intent 缺 blueprint 字段 —— paste 会拿到 undefined", evidence: ev };
    }
    let bp;
    try { bp = decode(intent.blueprint); }
    catch (e) { return { ok: false, reason: `blueprint 解码失败：${e.message}`, evidence: ev }; }
    if (!Array.isArray(intent.entities) || !intent.entities.length) {
        return { ok: false, reason: "intent.entities 为空", evidence: ev };
    }
    const a = intent.anchor;
    const bxs = bp.entities.map(e => e.dx), bys = bp.entities.map(e => e.dy);
    const ixs = intent.entities.map(e => a[0] + e.dx), iys = intent.entities.map(e => a[1] + e.dy);
    const bmx = Math.min(...bxs), bmy = Math.min(...bys), imx = Math.min(...ixs), imy = Math.min(...iys);
    const bpMap = new Map(bp.entities.map(e => [k([e.dx - bmx, e.dy - bmy]), e]));
    const inMap = new Map(intent.entities.map((e, i) => [k([ixs[i] - imx, iys[i] - imy]), e]));

    ev.blueprint_count = bpMap.size; ev.intent_count = inMap.size;
    const onlyBp = [...bpMap.keys()].filter(x => !inMap.has(x));
    const onlyIn = [...inMap.keys()].filter(x => !bpMap.has(x));
    const diff = [], dirBad = [];
    for (const [key, b] of bpMap) {
        const e = inMap.get(key);
        if (!e) continue;
        if ((b.rot | 0) !== (e.rot | 0)) { diff.push({ cell: key, field: "rot", blueprint: b.rot, intent: e.rot }); continue; }
        if (b.code !== e.code) { diff.push({ cell: key, field: "code", blueprint: b.code, intent: e.code }); continue; }
        if (e.kind !== "belt") continue;
        const wantCode = 1 + (e.rotationVariant | 0);
        if (b.code !== wantCode) {
            diff.push({ cell: key, field: "code-vs-rv", blueprint: b.code, intentCode: e.code, wantCode, rv: e.rotationVariant });
            continue;
        }
        if (e.inDir && e.outDir) {
            const gi = beltEntry(e.rotationVariant, e.rot), go = beltExit(e.rotationVariant, e.rot);
            if (gi !== e.inDir || go !== e.outDir) {
                dirBad.push({ cell: key, rv: e.rotationVariant, rot: e.rot, declared: { in: e.inDir, out: e.outDir }, from_rv_rot: { in: gi, out: go } });
            }
        }
    }
    Object.assign(ev, {
        only_in_blueprint: onlyBp.slice(0, 5), only_in_intent: onlyIn.slice(0, 5),
        field_diff: diff.slice(0, 5), direction_inconsistent: dirBad.slice(0, 5),
    });

    if (bpMap.size !== inMap.size || onlyBp.length || onlyIn.length) {
        return { ok: false, reason: `intent.entities 与 blueprint 不是同一张图（蓝图 ${bpMap.size} / intent ${inMap.size}）`, evidence: ev };
    }
    if (diff.length) {
        return { ok: false, reason: `${diff.length} 格在 blueprint 与 intent 之间不一致（首处 ${JSON.stringify(diff[0])}）—— paste 用的不是编译器推理的那张图`, evidence: ev };
    }
    if (dirBad.length) {
        return { ok: false, reason: `${dirBad.length} 格的 (rot,rv) 与声明的 inDir/outDir 不自洽（首处 ${JSON.stringify(dirBad[0])}）`, evidence: ev };
    }
    return { ok: true, reason: null, evidence: ev };
}

/* ═════════ G7：贴后 · 从游戏的 path 邻接反推每一格的方向 ═════════
 * 唯一 oracle 是 debug_items 的 entityPath（bridge:876-890）——它由游戏自己按
 * 「谁真正发、谁真正收」连出来，顺序是上游→下游（实机核对：见报告 §G7 验证）。
 * 对每个声明了 in/out 的带子格：
 *   中间格：actualIn = dirOf(cell, prev)，actualOut = dirOf(cell, next|boundAcceptor)
 *   链首格：声明的上游若在 blueprint 内，必须出现在同一 path 的 prev；若是机器，
 *           其 outDir 必须指向本格
 * 任一处不符 → 红。截断 → 无法判定。
 */
export function gateG7flow(intent, items) {
    const ev = {};
    if (items.beltError) return { ok: false, reason: `debug_items 报错：${items.beltError}`, evidence: ev };
    if (!Array.isArray(items.paths)) return { ok: false, reason: "debug_items 没有 paths", evidence: ev };
    const total = typeof items.pathCount === "number" ? items.pathCount : items.paths.length;
    if (total > items.paths.length) return { ok: false, undecidable: true, reason: `paths 截断 ${items.paths.length}/${total}`, evidence: ev };

    const at = new Map();
    items.paths.forEach((p, pi) => (p.cells || []).forEach((c, ci) => at.set(k(c), { pi, ci })));
    ev.cells_indexed = at.size;

    const a = intent.anchor;
    const byCell = new Map();
    for (const e of intent.entities || []) byCell.set(k([a[0] + e.dx, a[1] + e.dy]), e);

    const viol = [];
    let cIn = 0, cOut = 0, uIn = 0, uOut = 0;
    for (const e of intent.entities || []) {
        if (e.kind !== "belt") continue;
        const cell = [a[0] + e.dx, a[1] + e.dy];
        const loc = at.get(k(cell));
        if (!loc) { viol.push({ cell, nodeId: e.nodeId, kind: "not_on_any_path" }); continue; }
        const p = items.paths[loc.pi];

        if (e.inDir) {
            if (loc.ci > 0) {
                const actual = dirOf(cell, p.cells[loc.ci - 1]);
                cIn++;
                if (actual !== e.inDir) viol.push({ cell, nodeId: e.nodeId, field: "in", want: e.inDir, got: actual, path: loc.pi, idx: loc.ci, len: p.cells.length });
            } else {
                const upCell = step(cell, e.inDir);
                const up = byCell.get(k(upCell));
                if (!up) viol.push({ cell, nodeId: e.nodeId, field: "in", want: e.inDir, got: "no-upstream-in-blueprint", upstreamCell: upCell });
                else if (up.kind === "belt") viol.push({ cell, nodeId: e.nodeId, field: "in", want: e.inDir, got: "disconnected-from-belt", upstreamNode: up.nodeId, path: loc.pi });
                else if (up.outDir && up.outDir !== OPP[e.inDir]) viol.push({ cell, nodeId: e.nodeId, field: "in", want: e.inDir, got: `upstream(${up.nodeId}).outDir=${up.outDir}` });
                else cIn++;
                uIn++;
            }
        }
        if (e.outDir) {
            let actual = null, via = null;
            if (loc.ci < p.cells.length - 1) { actual = dirOf(cell, p.cells[loc.ci + 1]); via = "next"; }
            else if (Array.isArray(p.boundAcceptor)) { actual = dirOf(cell, p.boundAcceptor); via = "boundAcceptor"; }
            if (actual === null) uOut++;
            else {
                cOut++;
                if (actual !== e.outDir) viol.push({ cell, nodeId: e.nodeId, field: "out", want: e.outDir, got: actual, via, path: loc.pi, idx: loc.ci, len: p.cells.length });
            }
        }
    }
    Object.assign(ev, { violations: viol.length, checked_in: cIn, checked_out: cOut, unverifiable_in: uIn, unverifiable_out: uOut });
    if (viol.length) {
        return {
            ok: false,
            reason: `${viol.length} 处运行时流向与 intent 声明不符（首处 ${JSON.stringify(viol[0])}）—— 游戏实际把货送去的方向 ≠ 蓝图说的方向`,
            evidence: { ...ev, sample: viol.slice(0, 6) },
            hint: "A2/L4 的形态：intent/blueprint/粘贴三方自洽，但运行时拓扑不是那张图",
        };
    }
    return { ok: true, reason: null, evidence: ev };
}

/* ═════════ G8：贴后 · 链划分必须与蓝图推导出的链划分逐格相等 ═════════
 * 从蓝图自己推出「哪些带子格应当首尾相连」：
 *   succ(cell) = step(cell, outDir)，pred(cell) = step(cell, inDir)
 *   chain = 从没有链内 pred 的格开始，沿 succ 走（succ 落在 blueprint 的带子格里才继续）
 * 再从游戏读实际 path（已经按流向排序），把两者的**格子集合与顺序**逐链比较。
 * 这一条能回答「货流走了错误路径」：事故里蓝图链的终点是 cutter(21,-7)，
 * 而游戏链的终点是 hub。
 */
export function gateG8chains(intent, items) {
    const ev = {};
    if (items.beltError) return { ok: false, reason: `debug_items 报错：${items.beltError}`, evidence: ev };
    if (!Array.isArray(items.paths)) return { ok: false, reason: "debug_items 没有 paths", evidence: ev };
    const total = typeof items.pathCount === "number" ? items.pathCount : items.paths.length;
    if (total > items.paths.length) return { ok: false, undecidable: true, reason: `paths 截断 ${items.paths.length}/${total}`, evidence: ev };

    const a = intent.anchor;
    const belts = (intent.entities || []).filter(e => e.kind === "belt");
    const byCell = new Map();
    for (const e of belts) {
        if (!e.inDir || !e.outDir) return { ok: false, reason: `带子 ${e.nodeId} 缺 inDir/outDir —— 无法推导链（不许 fail-open）`, evidence: ev };
        byCell.set(k([a[0] + e.dx, a[1] + e.dy]), e);
    }

    /* 期望链：从链头（链内没有 pred）走到链尾 */
    const hasPredInChain = new Set();
    for (const [key, e] of byCell) {
        const cell = key.split(",").map(Number);
        const predCell = step(cell, e.inDir);
        if (byCell.has(k(predCell))) hasPredInChain.add(key);
    }
    const expectChains = [];
    for (const [key, e] of byCell) {
        if (hasPredInChain.has(key)) continue;
        const chain = [];
        let cur = key, guard = 0;
        while (cur && guard++ < byCell.size + 2) {
            chain.push(cur.split(",").map(Number));
            const ce = byCell.get(cur);
            const next = k(step(chain[chain.length - 1], ce.outDir));
            cur = byCell.has(next) ? next : null;
        }
        // 链尾指向的实体（下一个格上的机器/hub/计划外带子）
        const tail = chain[chain.length - 1];
        const te = byCell.get(k(tail));
        const exitCell = step(tail, te.outDir);
        const exitEnt = (intent.entities || []).find(x => x.kind !== "belt" && x.dx + a[0] === exitCell[0] && x.dy + a[1] === exitCell[1]);
        expectChains.push({ cells: chain, exitCell, exitNode: exitEnt ? exitEnt.nodeId : null });
    }
    ev.expected_chains = expectChains.length;
    ev.expected_cells = [...byCell.keys()].length;

    /* 实际链：只取包含蓝图带子格的 path，按 cells 原序 */
    const actual = [];
    for (const p of items.paths) {
        if ((p.cells || []).some(c => byCell.has(k(c)))) actual.push(p);
    }
    ev.actual_chains = actual.length;

    const norm = ch => ch.map(k).join(">");
    const expectSet = new Map(expectChains.map(ch => [norm(ch.cells), ch]));
    const actualSet = new Map(actual.map(p => [norm(p.cells), p]));

    const missing = [], extra = [];
    for (const [sig, ch] of expectSet) if (!actualSet.has(sig)) missing.push({ sig, exitNode: ch.exitNode, exitCell: ch.exitCell, len: ch.cells.length });
    for (const [sig, p] of actualSet) if (!expectSet.has(sig)) extra.push({ sig: sig.slice(0, 120), len: p.cells.length, acceptor: p.boundAcceptor });

    if (missing.length || extra.length) {
        // 诊断：期望链尾 vs 实际链尾
        const m = missing[0];
        let reason = `${missing.length} 条蓝图链在游戏里不存在、${extra.length} 条游戏链不在蓝图里`;
        if (m) {
            const mCells = new Set(m.sig.split(">"));
            const cand = actual.find(p => (p.cells || []).some(c => mCells.has(k(c))));
            if (cand) {
                const tail = cand.cells[cand.cells.length - 1];
                reason += `；期望链尾 ${m.exitNode || "?"}@${JSON.stringify(m.exitCell)}，游戏却把这条货流接到了 ${JSON.stringify(tail)}` +
                    (Array.isArray(cand.boundAcceptor) ? `（boundAcceptor=${JSON.stringify(cand.boundAcceptor)}）` : "（无接收者）") +
                    `，链长 ${m.len} → ${cand.cells.length}`;
            }
        }
        return { ok: false, reason, evidence: { ...ev, missing: missing.slice(0, 3), extra: extra.slice(0, 3) } };
    }
    return { ok: true, reason: null, evidence: ev };
}

/* ═══════════════════════════ 夹具 ═══════════════════════════ */
const A = [0, 0];
const E = (kind, x, y, rot, rv, code, inDir, outDir, nodeId) =>
    ({ kind, dx: x, dy: y, rot, rotationVariant: rv, code, inDir, outDir, nodeId });

/* 物理自洽的健康线（每一格都用 belt-rules 求解 (rot,rv)）：
 *   miner(18,2) 出口 top → 竖直带 (18,1)..(18,-4) → 拐角 (18,-5) in=bottom out=right
 *   → 直带 (19,-5)(20,-5) → 拐角 (21,-5) in=left out=top → 直带 (21,-6) → cutter(21,-7)
 */
const baseEnts = [
    E("miner", 18, 2, 0, 0, 7, null, "top", "m0"),
    E("belt", 18, 1, 0, 0, 1, "bottom", "top", "f0"),
    E("belt", 18, 0, 0, 0, 1, "bottom", "top", "f1"),
    E("belt", 18, -1, 0, 0, 1, "bottom", "top", "f2"),
    E("belt", 18, -2, 0, 0, 1, "bottom", "top", "f3"),
    E("belt", 18, -3, 0, 0, 1, "bottom", "top", "f4"),
    E("belt", 18, -4, 0, 0, 1, "bottom", "top", "f5"),
    E("belt", 18, -5, 0, 2, 3, "bottom", "right", "f6"),     // 拐角
    E("belt", 19, -5, 90, 0, 1, "left", "right", "f7"),
    E("belt", 20, -5, 90, 0, 1, "left", "right", "f8"),
    E("belt", 21, -5, 90, 1, 2, "left", "top", "j0"),        // ← 事故格：拐角
    E("belt", 21, -6, 0, 0, 1, "bottom", "top", "j1"),
    E("cutter", 21, -7, 0, 0, 9, "bottom", "top", "c0"),
];
const intentHealthy = { goal: "RuRu----", anchor: A, entities: baseEnts };
const bpOf = ents => encodeBlueprint({
    gv: "1.5.6", w: [0, 0],
    entities: ents.map(e => ({ code: e.code, dx: e.dx, dy: e.dy, rot: e.rot })),
});
intentHealthy.blueprint = bpOf(baseEnts);

/* 健康运行时：一条链从 (18,1) 走到 (21,-6)，终点是 cutter */
const itemsHealthy = {
    pathCount: 1,
    paths: [{ cells: [[18, 1], [18, 0], [18, -1], [18, -2], [18, -3], [18, -4], [18, -5],
                      [19, -5], [20, -5], [21, -5], [21, -6]],
              itemsOnPath: 6, boundAcceptor: [21, -7] }],
};

/* 事故运行时：j0 被翻成直带（出口 right），货顺着 82 格绕行直接进 hub；
 * j1 成了没有上游的单格 path（它的 acceptor 是 cutter —— 所以 G6b 不会报死路） */
const detour = [];
for (let x = 22; x <= 60; x++) detour.push([x, -5]);
for (let y = -4; y <= 0; y++) detour.push([60, y]);
for (let x = 59; x >= 0; x--) detour.push([x, 0]);
const itemsAccident = {
    pathCount: 2,
    paths: [
        { cells: [[18, 1], [18, 0], [18, -1], [18, -2], [18, -3], [18, -4], [18, -5],
                  [19, -5], [20, -5], [21, -5], ...detour], itemsOnPath: 5, boundAcceptor: [-1, 0] },
        { cells: [[21, -6]], itemsOnPath: 0, boundAcceptor: [21, -7] },
    ],
};
const itemsTruncated = { pathCount: 55, paths: itemsAccident.paths };

const line = s => "─".repeat(4) + " " + s + " " + "─".repeat(62);
const show = (id, r) => {
    console.log(`\n${line(id)}`);
    console.log(`ok=${r.ok}${r.undecidable ? " undecidable" : ""}  reason=${r.reason ?? "(null)"}`);
    if (r.evidence && Object.keys(r.evidence).length) console.log(`evidence=${JSON.stringify(r.evidence).slice(0, 420)}`);
};
let pass = 0, fail = 0;
const expect = (label, cond) => { cond ? (pass++, console.log(`✓ ${label}`)) : (fail++, console.log(`✗ ${label}`)); };

console.log("═".repeat(96));
console.log("新闸原型：与现有 G6b 对照（同一份数据）");
console.log("═".repeat(96));

const g6bHea = G.gateG6b(intentHealthy, itemsHealthy);
const g6bAcc = G.gateG6b(intentHealthy, itemsAccident);
const g7Hea = gateG7flow(intentHealthy, itemsHealthy);
const g7Acc = gateG7flow(intentHealthy, itemsAccident);
const g8Hea = gateG8chains(intentHealthy, itemsHealthy);
const g8Acc = gateG8chains(intentHealthy, itemsAccident);

show("现有 G6b · 健康数据", g6bHea);
show("现有 G6b · 事故数据", g6bAcc);
show("新 G7 · 健康数据", g7Hea);
show("新 G7 · 事故数据", g7Acc);
show("新 G8 · 健康数据", g8Hea);
show("新 G8 · 事故数据", g8Acc);

expect("【必绿·对照】现有 G6b 在健康数据上绿", g6bHea.ok === true);
expect("【对照】现有 G6b 在事故数据上**也**绿（证明它会漏）", g6bAcc.ok === true);
expect("【必绿 1】G7 健康绿", g7Hea.ok === true);
expect("【必红 1】G7 事故红", g7Acc.ok === false);
expect("【必绿 2】G8 健康绿", g8Hea.ok === true);
expect("【必红 2】G8 事故红，且诊断指出货流接到了哪里", g8Acc.ok === false && /boundAcceptor|链长/.test(g8Acc.reason));

/* 必红 3：声明也被自洽地写成直带（intent 与 blueprint 都写 straight，游戏也是 straight）
 * —— G2'/G4 全绿，但货仍然到不了 cutter。只有 G8（链划分 vs 逻辑链）能看出来。 */
const altEnts = baseEnts.map(e => e.nodeId === "j0"
    ? { ...e, rot: 90, rotationVariant: 0, code: 1, inDir: "left", outDir: "right" } : e);
const intentAlt = { ...intentHealthy, entities: altEnts, blueprint: bpOf(altEnts) };
const itemsAlt = {
    pathCount: 1,
    paths: [{ cells: [[18, 1], [18, 0], [18, -1], [18, -2], [18, -3], [18, -4], [18, -5],
                      [19, -5], [20, -5], [21, -5], ...detour], itemsOnPath: 5, boundAcceptor: [-1, 0] }],
};
show("G2' · 声明也写成直带（自洽）", gateIntentMatchesBlueprint(intentAlt, decodeBlueprint));
show("G8 · 声明也写成直带（自洽）+ 事故运行时", gateG8chains(intentAlt, itemsAlt));
expect("【必红 3】自洽地写错时 G2' 绿（说明它只能验内部一致性）", gateIntentMatchesBlueprint(intentAlt, decodeBlueprint).ok === false ? false : true);
expect("【必红 3】自洽地写错时 G8 仍红（链尾是 hub 不是 cutter）", gateG8chains(intentAlt, itemsAlt).ok === false);

/* 必红 4：矿机出口带子反向 */
const revEnts = baseEnts.map(e => e.nodeId === "f0"
    ? { ...e, rot: 180, rotationVariant: 0, code: 1, inDir: "top", outDir: "bottom" } : e);
const intentRev = { ...intentHealthy, entities: revEnts, blueprint: bpOf(revEnts) };
show("G7 · 矿机出口带子反向", gateG7flow(intentRev, itemsHealthy));
expect("【必红 4】矿机出口带子反向 → G7 红", gateG7flow(intentRev, itemsHealthy).ok === false);

/* 必红 5：截断 */
expect("【必红 5】paths 截断 → undecidable", gateG7flow(intentHealthy, itemsTruncated).undecidable === true && gateG8chains(intentHealthy, itemsTruncated).undecidable === true);

/* G2'：真实 L4 intent 绿；把 rv 与 code 解耦 → 红；把声明方向翻转 → 红 */
const real = JSON.parse(fs.readFileSync(path.join(ROOT, "research/ai-plan/tmp/live/l4/RuRu----.intent.json"), "utf8"));
const g2real = gateIntentMatchesBlueprint(real, decodeBlueprint);
show("G2' · 真实 L4 intent", g2real);
expect("【必绿 3】真实 L4 intent 的 blueprint 与 entities 同源", g2real.ok === true);

const t1 = JSON.parse(JSON.stringify(real));
const v1 = t1.entities.find(e => e.kind === "belt" && e.rotationVariant !== 0);
v1.rotationVariant = 0;                                  // 只改推理侧
const g2a = gateIntentMatchesBlueprint(t1, decodeBlueprint);
show(`G2' · 把 ${v1.nodeId} 的 rv 改成 0（blueprint 仍是拐角）`, g2a);
expect("【必红 6】intent 的 rv 与 blueprint 的 code 解耦 → 红", g2a.ok === false);

const t2 = JSON.parse(JSON.stringify(real));
const v2 = t2.entities.find(e => e.kind === "belt" && e.rotationVariant !== 0);
v2.inDir = OPP[v2.inDir];                                // 只改声明
const g2b = gateIntentMatchesBlueprint(t2, decodeBlueprint);
show(`G2' · 把 ${v2.nodeId} 的 inDir 翻转（rot/rv/code 全不动）`, g2b);
expect("【必红 7】声明方向与 (rot,rv) 不自洽 → 红", g2b.ok === false);

console.log(`\n合计：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
