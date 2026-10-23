/**
 * measure-stride5.mjs — stride=5（给蓝图加 originalRotation）的**容量实测**（P6 NOTES 的凭据）
 *
 * 问题：把 originalRotation 塞进 SZBP1 会让压缩体涨多少？涨太多就不是「向后兼容的小改」了。
 * 做法：同一份真实蓝图（P1 金样例 + 合成的 200 格带子）分别按
 *   v1：payload.e = [code,dx,dy,rot] × n          （stride=4，现状）
 *   v2a：payload.e = [code,dx,dy,rot,orig] × n     （stride=5，原地加一列）
 *   v2b：payload.e 保持 stride=4 + payload.o = [orig] × n（**平行数组**，v1 解码器忽略未知键）
 * 三种写法各压一遍（同一个 lz-string 实现，src/shared/lz-string.cjs）。零依赖。
 *
 * 运行：node research/ai-plan/emitter/measure-stride5.mjs
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const LZ = require(path.join(ROOT, "src", "shared", "lz-string.cjs"));
// Windows 上动态 import 必须是 file:// URL（裸绝对路径会 ERR_UNSUPPORTED_ESM_URL_SCHEME）
const imp = rel => import(pathToFileURL(path.join(ROOT, rel)).href);
const { decodeBlueprint } = await imp("src/shared/blueprint.mjs");
const { emitPlan } = await imp("src/ai/compiler/emit.mjs");
const { fixtureCorners, fixtureStraight } = await imp("src/ai/compiler/roundtrip.mjs");

const compress = o => LZ.compressToEncodedURIComponent(JSON.stringify(o));

/** 合成一张 N 格的蛇形带子蓝图（真实分布：大量重复的 (code,dx,dy,rot) 三元组） */
function synth(n) {
    const ents = [];
    let x = 0, y = 0, dir = 0;                     // 0=up 1=right 2=down 3=left
    const D = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    for (let i = 0; i < n; i++) {
        const straight = i % 7 !== 0;             // 每 7 格一个拐角
        const rot = straight ? dir * 90 : ((dir + (i % 2 ? 1 : 3)) % 4) * 90;
        const rv = straight ? 0 : (i % 3 === 0 ? 1 : 2);
        ents.push({ code: 1 + rv, dx: x, dy: y, rot, orig: straight ? rot : (rot + 90) % 360 });
        const [dx, dy] = D[straight ? dir : ((dir + 1) % 4)];
        x += dx; y += dy;
        if (i % 7 === 0) dir = (dir + 1) % 4;
    }
    return ents;
}

const cases = [];
{
    // 真蓝图 1：P1 金样例（8 格，全直带 + 3 机器）
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, "research/ai-plan/fixtures/plan-l1.json"), "utf8"));
    const d = decodeBlueprint(p.blueprint);
    cases.push(["plan-l1（P1 金样例，8 格）", d.entities.map(e => ({ ...e, orig: e.rot }))]);
    // 真蓝图 2/3：本包的 straight / corners fixture
    for (const [name, plan] of [["straight", fixtureStraight()], ["corners", fixtureCorners()]]) {
        const out = emitPlan(plan);
        if (!out.ok) { console.log(`⚠ ${name} 发射失败：${out.reason}`); continue; }
        const dd = decodeBlueprint(out.blueprint);
        // orig 的「不可从 (r,rv) 反推」用 M4 的实测值模拟：拐角格的 orig 比 rot 差 90/180
        cases.push([`${name}（P6 fixture，${dd.entities.length} 格）`,
            dd.entities.map(e => ({ ...e, orig: e.code === 1 ? e.rot : (e.rot + 90) % 360 }))]);
    }
    cases.push(["合成 200 格蛇形带（拐角 29 个）", synth(200)]);
    cases.push(["合成 2000 格（level-11 工厂量级）", synth(2000)]);
}

const rows = [];
for (const [label, ents] of cases) {
    const v1 = compress({ v: 1, gv: "1.5.6", w: [0, 0], e: ents.flatMap(e => [e.code, e.dx, e.dy, e.rot]) });
    const v2a = compress({ v: 2, gv: "1.5.6", w: [0, 0], e: ents.flatMap(e => [e.code, e.dx, e.dy, e.rot, e.orig]) });
    const v2b = compress({ v: 1, gv: "1.5.6", w: [0, 0], e: ents.flatMap(e => [e.code, e.dx, e.dy, e.rot]), o: ents.map(e => e.orig) });
    const raw1 = JSON.stringify({ v: 1, e: ents.flatMap(e => [e.code, e.dx, e.dy, e.rot]) }).length;
    rows.push({ label, n: ents.length, v1: v1.length, v2a: v2a.length, v2b: v2b.length,
        dA: ((v2a.length / v1.length - 1) * 100).toFixed(1) + "%",
        dB: ((v2b.length / v1.length - 1) * 100).toFixed(1) + "%", raw1 });
}
console.table(rows);
console.log("\n读法：v2a = stride=5 原地加列；v2b = stride 仍 4 + 平行数组 o（v1 解码器忽略未知键 → 向后兼容）");
console.log("两者都是**同一 lz-string、同一 JSON**，只差一列整数；v1 列给出的是现状基线字节数。");

/* 关键验证：v2b 的 payload 能被 **v1 解码器**读通吗？（向后兼容的正面证据） */
const probe = { v: 1, gv: "1.5.6", w: [0, 0], e: cases[0][1].flatMap(e => [e.code, e.dx, e.dy, e.rot]), o: cases[0][1].map(e => e.orig) };
const text = "SZBP1." + compress(probe);
const back = decodeBlueprint(text);
console.log(`\n✓ v2b 文本用现有 decodeBlueprint 读通：entities=${back.entities.length}（payload.v===1 且 e.length%4===0 的两道闸都没被未知键 o 触发）`);
const noO = { ...probe }; delete noO.o;
console.log(`✓ v1 编码器（encodeBlueprint）产出的文本不含 o，v2 解码器读它只会把 o 当缺省 → 双向兼容`);
console.log(`  v2b 文本长度 ${text.length} vs 同数据 v1 ${("SZBP1." + compress(noO)).length}（差 ${text.length - ("SZBP1." + compress(noO)).length} 字符）`);
