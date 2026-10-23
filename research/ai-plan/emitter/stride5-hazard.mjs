/**
 * stride5-hazard.mjs — stride=5 改造的**向后兼容危险实测**（P6 NOTES 的凭据；手工跑，非 L1 门）
 *
 * 要回答主线程一个问题：把 originalRotation 塞进 SZBP1，**v1 解码器**（不给它升版本的那份代码）会怎样？
 * 现状的 v1 闸只有两道（src/shared/blueprint.mjs:44-48）：
 *   payload.v === 1   、   payload.e.length % 4 === 0
 * 它不校验「e 的长度是 4 是不是真的等于格数 × 4」，也不解 code ↔ 名字。
 * 于是真正危险的不是报错，而是**报错之外的静默**：v:1 + stride=5 时，只要
 * n*5 恰好是 4 的倍数（n 是 4 的倍数），%4 闸放过去，解码出来的 (code,dx,dy,rot)
 * 逐格**滚动错位**，而 mod 会照样把这些错位实体盖进世界。本脚本实测四种写法。
 *
 * 运行：node research/ai-plan/emitter/stride5-hazard.mjs
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const req = createRequire(import.meta.url);
const LZ = req(path.join(ROOT, "src", "shared", "lz-string.cjs"));
const { decodeBlueprint, encodeBlueprint } = await import(new URL("../../../src/shared/blueprint.mjs", import.meta.url).href);

const N = 8;
const ents = [];
for (let i = 0; i < N; i++) ents.push({ code: 1, dx: i, dy: 0, rot: 0, orig: 90 });

const mk = payload => "SZBP1." + LZ.compressToEncodedURIComponent(JSON.stringify(payload));
const flat4 = ents.map(e => [e.code, e.dx, e.dy, e.rot]).flat();
const flat5 = ents.map(e => [e.code, e.dx, e.dy, e.rot, e.orig]).flat();

console.log(`同一份 8 格带子，四种 payload 写法喂给**现有** decodeBlueprint（v1，不认识 o 键）：\n`);
const cases = [
    ["A  v:1 + stride=5（改了 stride 忘了升 v）", { v: 1, gv: "1.5.6", w: [0, 0], e: flat5 }],
    ["B  v:2 + stride=5（升了 v）", { v: 2, gv: "1.5.6", w: [0, 0], e: flat5 }],
    ["C  v:1 + 平行数组 o（e 仍 stride=4）", { v: 1, gv: "1.5.6", w: [0, 0], e: flat4, o: ents.map(e => e.orig) }],
    ["D  v:2 + 平行数组 o", { v: 2, gv: "1.5.6", w: [0, 0], e: flat4, o: ents.map(e => e.orig) }],
];
for (const [label, payload] of cases) {
    const text = mk(payload);
    try {
        const d = decodeBlueprint(text);
        const shifted = d.entities.length !== N;
        if (shifted) {
            console.log(`⚠⚠ 静默错位  ${label}`);
            console.log(`      v1 返回 ${d.entities.length} 个实体（真相 ${N} 格），前 3 个 = ${JSON.stringify(d.entities.slice(0, 3))}`);
            console.log(`      —— 长度不匹配**不会**被 %4 闸拦住（${N} * 5 = ${N * 5} 是 4 的倍数）。mod 会把这 ${d.entities.length} 个错位实体直接摆进世界。文本 ${text.length} 字符\n`);
        } else {
            console.log(`⚠ 被接受但 o 列被无视  ${label}`);
            console.log(`      v1 返回 ${d.entities.length} 个实体，(code,dx,dy,rot) 与 v1 时代完全一致 → **原样可读**；未知键 o 安静地被丢掉。文本 ${text.length} 字符`);
            console.log(`      这就是「向后兼容」的正解形态：新字段进**平行数组**，不动 stride。\n`);
        }
    } catch (e) {
        console.log(`✓ 显式拒绝  ${label}`);
        console.log(`      ${e.code} ${String(e.message).slice(0, 100)}\n`);
    }
}

/* A 类在哪些规模会静默通过（n*5 % 4 === 0 ⟺ n 是 4 的倍数） */
const silent = [], blocked = [];
for (let n = 1; n <= 16; n++) {
    const e = []; for (let i = 0; i < n; i++) e.push(1, i, 0, 0, 90);
    try { decodeBlueprint(mk({ v: 1, gv: "1.5.6", w: [0, 0], e })); silent.push(n); } catch { blocked.push(n); }
}
console.log(`A 类（stride=5 但 v 忘升）在 n=1..16 的判决：`);
console.log(`  静默错位 ${silent.length}/16 个规模（n = ${silent.join(",")} —— 全是 4 的倍数）`);
console.log(`  显式报错 ${blocked.length}/16 个规模（n = ${blocked.join(",")}）`);
console.log(`  ⇒ 「报错」看起来更安全，但它是**随机落在哪一边**的：同一套代码，8 格的蓝图静默错位、7 格的蓝图才报错。`);
console.log(`    编译器产出的蓝图规模以几百格为主，4 的倍数出现率 25%，不能赌。\n`);

/* 反向兼容：v2 的读取端读 v1 老文本（不带 o） */
const v1text = encodeBlueprint({ gv: "1.5.6", w: [0, 0], entities: ents.map(e => ({ code: e.code, dx: e.dx, dy: e.dy, rot: e.rot })) });
const d1 = decodeBlueprint(v1text);
console.log(`反向（老文本 + 新解码器）：v1 的 ${v1text.length} 字符文本，新解码器按 payload.o ?? 全 null 处理即可`);
console.log(`  → entities=${d1.entities.length}，payload 无 o 键（${!Object.prototype.hasOwnProperty.call(JSON.parse(JSON.stringify(d1)), "o")}），v 仍 1 → 与今天完全同义`);
console.log(`\n给主线程的两条硬要求（详见 NOTES「stride=5 治本方案」）：`);
console.log(`  1. 加列就**必须**同时把 payload.v 升到 2，并把 v1 的 %4 闸改成「按 v 白名单取 stride」；`);
console.log(`  2. 优先选**平行数组**（C/D 形态）而不是改 stride：v1 解码器读它不掉链子，回滚成本接近零。`);
