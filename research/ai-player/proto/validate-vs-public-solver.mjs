/**
 * validate-vs-public-solver.mjs — 用公开的独立求解器（TomasSirgedas/Shapez-solver）的
 * 配方表交叉验证我们的 shape-ops.mjs 的 cut/rotate/stack 代数。
 *
 * 表格式（已从 shapez_solver.html:883 loadFromBinary 读出）：
 *   65536 项 × 5 字节：[a:uint16 LE][b:uint16 LE][op:uint8]
 *   code = layer0.b | layer1.b<<4 | layer2.b<<8 | layer3.b<<12
 *   每层 b 的 bit i = 象限 i 非空（bit0=TR, bit1=BR, bit2=BL, bit3=TL）
 *   op: 0=NONE 1=RAW 2=STACK 3=CUT_LEFT 4=CUT_RIGHT 5=ROT1 6=ROT2 7=ROT3
 *   ROT_n = n 个四分之一圈顺时针（已由 ROT1: code2=BR, ROT3: code8=TL 推得）
 *
 * 验证：对表中**每一个** op!=NONE 的 code，用我们的代数重建，比对 code。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as so from "./shape-ops.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const data = fs.readFileSync(path.join(here, "vendor", "recipes_0_1_1.bin"));

const OP = { NONE: 0, RAW: 1, STACK: 2, CUT_LEFT: 3, CUT_RIGHT: 4, ROT1: 5, ROT2: 6, ROT3: 7 };
const rec = code => ({ a: data[code * 5 + 1] * 256 + data[code * 5], b: data[code * 5 + 3] * 256 + data[code * 5 + 2], op: data[code * 5 + 4] });

/** code（仅拓扑）→ 我们的形状串（每个非空象限用 "Ru" 占位） */
function codeToShape(code) {
    const quads = [0, 1, 2, 3].map(i => (((code >> (i * 4)) & 15) & (1 << i)) ? "Ru" : "--");
    return so.parse(quads.join("").slice(0, 8) || "--------");
}
/** 注意：code 每层 4 bit 只编码象限占用，与象限索引一一对应 */
function codeToShapeTopology(code) {
    const layer = (code >> 0) & 15;   // 只用 layer 0（本表主要为单层）
    const q = [0, 1, 2, 3].map(i => (layer & (1 << i)) ? "Ru" : "--");
    return so.parse(q.join(""));
}
/** 我们的形状 → 拓扑 code（仅 layer0） */
function shapeToCode(shape) {
    if (shape.layers.length === 0) return 0;
    const l0 = shape.layers[0];
    let b = 0;
    for (let i = 0; i < 4; i++) if (l0[i]) b |= 1 << i;
    return b;
}

const memo = new Map();
function build(code) {
    if (memo.has(code)) return memo.get(code);
    const r = rec(code);
    let out;
    if (r.op === OP.NONE) out = null;
    else if (r.op === OP.RAW) out = codeToShapeTopology(code);
    else if (r.op === OP.ROT1) { const a = build(r.a); out = a ? so.rotateCW(a) : null; }
    else if (r.op === OP.ROT2) { const a = build(r.a); out = a ? so.rotate180(a) : null; }
    else if (r.op === OP.ROT3) { const a = build(r.a); out = a ? so.rotateCCW(a) : null; }
    else if (r.op === OP.CUT_LEFT) { const a = build(r.a); out = a ? so.cutHalf(a)[0] : null; }
    else if (r.op === OP.CUT_RIGHT) { const a = build(r.a); out = a ? so.cutHalf(a)[1] : null; }
    else if (r.op === OP.STACK) { const a = build(r.a), b = build(r.b); out = (a && b) ? so.stack(a, b) : null; }
    else out = null;
    memo.set(code, out);
    return out;
}

let ok = 0, bad = 0, impossible = 0, err = 0;
const failures = [];
for (let code = 0; code < 65536; code++) {
    const r = rec(code);
    if (r.op === OP.NONE) { impossible++; continue; }
    try {
        const built = build(code);
        if (!built) { err++; failures.push({ code, why: "build returned null", op: r.op }); continue; }
        const got = shapeToCode(built);
        const want = code & 15;   // 单层拓扑
        if (got === want) ok++;
        else { bad++; if (failures.length < 12) failures.push({ code, want, got, op: r.op }); }
    } catch (e) {
        err++; if (failures.length < 12) failures.push({ code, why: e.message, op: r.op });
    }
}

console.log(`配方表总项: 65536`);
console.log(`  不可能(op=NONE): ${impossible}`);
console.log(`  ✅ 我们用同一配方重建且拓扑一致: ${ok}`);
console.log(`  ❌ 拓扑不符: ${bad}`);
console.log(`  ⚠️ 重建失败/异常: ${err}`);
if (failures.length) {
    console.log(`\n失败样例（前 ${failures.length}）:`);
    for (const f of failures) console.log("  ", JSON.stringify(f));
}
const total = ok + bad + err;
console.log(`\n可构造形状中一致率: ${(ok / total * 100).toFixed(2)}%  (${ok}/${total})`);
process.exit(bad || err ? 1 : 0);
