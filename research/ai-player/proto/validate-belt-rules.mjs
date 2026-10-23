/**
 * validate-belt-rules.mjs — 用真实存档 1906 条带子，离线验证 belt.js:161-247 的复刻。
 *
 * 三条待验命题：
 *  A. code == 1 + rotationVariant（belt 只有 3 个 internalId：1/2/3 ↔ rv 0/1/2）
 *  B. 局部几何：rv0 直（入=反向 出=top 局部）；rv1 出=left；rv2 出=right；整体随 rotation 旋转
 *  C. compute 复刻：给定 final rotation + rv，反推 originalRotation（orig = r - variantShift(rv)，
 *     variantShift: rv0→0, rv1→+90, rv2→-90；belt.js:210/216 返回 rotation+90/+270 的逆运算），
 *     再以 orig 为输入跑复刻，应重现 final —— 且用**final 邻居状态**（迭代不动点检验）。
 *
 * 吻合率 < 95% 则打印漂移样本供分析（人类摆放未必都停在不动点，这本身也是信息）。
 */
import { createRequire } from "node:module";
const require = createRequire("file:///" + process.cwd().replace(/\\/g, "/") + "/x.js");
const { decodeSave } = require("./recon/decode_full.cjs");

const SAVE = process.env.APPDATA + "/shapez.io/saves/savegame-5c96706563c0b74c4d2ce4c7f8bf7a244392de89.bin";
const BELT_CODES = new Set([1, 2, 3]);
const DIRV = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };
const OPP = { top: "bottom", bottom: "top", left: "right", right: "left" };
const ORDER = ["top", "right", "bottom", "left"];
const angleToDir = a => ORDER[((Math.round(((a % 360) + 360) % 360) / 90) % 4 + 4) % 4];
const dirToOffset = d => DIRV[d];
const norm = a => ((a % 360) + 360) % 360;

// 局部几何（belt.js:148 + components/belt 的语义：局部 bottom 进、局部 top 出；rv1/2 出局部左/右）
// 全局长度验证用：exit 方向（世界系）= 局部方向按 rotation 旋转
function rotateLocal(local, rotation) {
    return ORDER[(ORDER.indexOf(local) + ORDER.indexOf(angleToDir(rotation))) % 4];
}
const exitLocal = rv => ({ 0: "top", 1: "left", 2: "right" })[rv];
const entryLocal = rv => "bottom";
const exitWorld = (rv, rot) => rotateLocal(exitLocal(rv), rot);
const entryWorld = (rv, rot) => rotateLocal(entryLocal(rv), rot);

// belt.js:161 的复刻（输入 rotation = originalRotation；局部出向恒按 rv 解释，
//  但注意：源码第①分支返回 rotation+270/+90 —— 即"用户拖拽方向"被重定向；
//  第②分支保持 rotation。rv 才是弯向，rotation 是出口方向）。
function computeBelt({ neighbors, rotation }) {
    // neighbors: [{ ejectsInto: dirFromNeighborToWorld, acceptsFrom: dirWorld }]
    const topDirection = angleToDir(rotation);
    const rightDirection = angleToDir(rotation + 90);
    const bottomDirection = angleToDir(rotation + 180);
    const leftDirection = angleToDir(rotation + 270);
    let hasBottomEjector = false, hasRightEjector = false, hasLeftEjector = false;
    let hasTopAcceptor = false, hasLeftAcceptor = false, hasRightAcceptor = false;
    for (const n of neighbors) {
        // 邻居往本格喷：其 exitWorld = 邻居→本格的方位 = 本格→邻居方位的反
        if (n.ejectsInto) {
            const t = n.ejectsInto;                       // 世界系方位
            if (t === topDirection) hasBottomEjector = true;
            else if (t === leftDirection) hasRightEjector = true;
            else if (t === rightDirection) hasLeftEjector = true;
        }
        // 本格往邻居喷且邻居收：邻居的 entryWorld = 邻居→本格方位 = 本格→邻居方位的反
        if (n.acceptsFrom) {
            const f = n.acceptsFrom;
            if (f === bottomDirection) hasTopAcceptor = true;
            else if (f === rightDirection) hasLeftAcceptor = true;
            else if (f === leftDirection) hasRightAcceptor = true;
        }
    }
    if (!hasBottomEjector) {
        if (hasRightEjector && !hasLeftEjector) return { rotation: norm(rotation + 270), rotationVariant: 2 };
        if (hasLeftEjector && !hasRightEjector) return { rotation: norm(rotation + 90), rotationVariant: 1 };
    }
    if (!hasTopAcceptor) {
        if (hasRightAcceptor && !hasLeftAcceptor) return { rotation, rotationVariant: 2 };
        if (hasLeftAcceptor && !hasRightAcceptor) return { rotation, rotationVariant: 1 };
    }
    return { rotation, rotationVariant: 0 };
}

const VARIANT_SHIFT = { 0: 0, 1: 90, 2: 270 };   // 第①分支里 +90(rv1)/+270(rv2) 才得到最终 rotation；②分支/直 为 0
function inferOrig(v) {
    // 若最终来自第①分支：r = orig + shift → orig = r - shift
    const a = norm(v.r - VARIANT_SHIFT[v.rv]);
    return a;
}

async function main() {
    const { obj } = decodeSave(SAVE);
    const grid = new Map();
    for (const e of (obj.dump.entities || [])) {
        const s = e.components?.StaticMapEntity; if (!s) continue;
        grid.set(s.origin.x + "," + s.origin.y, {
            code: s.code, r: norm(s.rotation), orig: norm(s.originalRotation ?? s.rotation),
            belt: BELT_CODES.has(s.code), rv: BELT_CODES.has(s.code) ? s.code - 1 : 0,
        });
    }
    const belts = [...grid.entries()].filter(([, v]) => v.belt);
    console.log(`带子 ${belts.length} 条（直带 ${belts.filter(([, v]) => v.rv === 0).length}，弯 ${belts.length - belts.filter(([, v]) => v.rv === 0).length}）`);

    // A. code == 1+rv
    let violA = 0;
    for (const [, v] of belts) if (v.rv !== v.code - 1) violA++;
    console.log(`\n[A] code==1+rv：${violA === 0 ? "✅ 全部成立" : "❌ 违反 " + violA}`);

    // B. 出边邻居的入边回指（弯带链闭合）——检验局部几何假设
    let okB = 0, badB = 0, exB = [];
    for (const [k, v] of belts) {
        const [x, y] = k.split(",").map(Number);
        const ex = exitWorld(v.rv, v.r);
        const [dx, dy] = dirToOffset(ex);
        const nb = grid.get((x + dx) + "," + (y + dy));
        if (!nb || !nb.belt) continue;
        const nEntry = entryWorld(nb.rv, nb.r);          // 邻居的入边来自哪个方位
        const [ix, iy] = dirToOffset(OPP[ex]);
        const [exx, exy] = dirToOffset(nEntry);
        if ((x + dx + exx) === x + dx - (x - (x + dx)) || nEntry === OPP[ex]) okB++;
        else { badB++; if (exB.length < 5) exB.push({ at: [x, y], exit: ex, v: { r: v.r, rv: v.rv }, nb: { x: x + dx, y: y + dy, r: nb.r, rv: nb.rv, nEntry } }); }
        void ix; void iy;
    }
    console.log(`[B] 链闭合（邻居入边 = 本格出边的反方位）：${okB} 对，${badB} 错`);
    if (exB.length) console.log("   错样本:", JSON.stringify(exB.slice(0, 3)));

    // C. compute 复刻（以 inferOrig 为输入 rotation，final 邻居状态，比对 final r+rv）
    let okC = 0, badC = 0; const exC = [];
    for (const [k, v] of belts) {
        const [x, y] = k.split(",").map(Number);
        const neighbors = [];
        for (const [d, [ox, oy]] of Object.entries(DIRV)) {
            const nb = grid.get((x + ox) + "," + (y + oy));
            if (!nb) continue;
            const o = {};
            if (nb.belt && exitWorld(nb.rv, nb.r) === OPP[d]) o.ejectsInto = OPP[d];
            if (nb.belt && entryWorld(nb.rv, nb.r) === OPP[d]) o.acceptsFrom = OPP[d];
            if (Object.keys(o).length) neighbors.push(o);
        }
        // 以存档里的 originalRotation 为输入（belt.js:160 就是这么读的）
        const orig = v.orig;
        const got = computeBelt({ neighbors, rotation: orig });
        if (got.rotation === v.r && got.rotationVariant === v.rv) okC++;
        else { badC++; if (exC.length < 8) exC.push({ at: [x, y], final: { r: v.r, rv: v.rv, orig: v.orig, inferred: orig }, predicted: got, n: neighbors.length }); }
    }
    console.log(`\n[C] compute 复刻不动点吻合：${okC}/${belts.length} = ${(okC / belts.length * 100).toFixed(1)}%`);
    if (exC.length) { console.log("   漂移样本:"); for (const c of exC) console.log("    ", JSON.stringify(c)); }
}
main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
